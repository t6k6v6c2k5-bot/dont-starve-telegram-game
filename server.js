const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

// Never let clients cache stale HTML/JS — this project is under active
// development and stale caches have repeatedly caused "I updated the code
// but nothing changed" confusion.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, maxAge: 0 }));

function rid(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 10); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min) + min); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

// ==================== WORLD ====================
const WORLD_WIDTH = 3400;
const WORLD_HEIGHT = 3400;
const CENTER_X = WORLD_WIDTH / 2;
const CENTER_Y = WORLD_HEIGHT / 2;
const TICK_RATE = 30;
const BROADCAST_RATE = 30;
const DT = 1 / TICK_RATE;
const PLAYER_SPEED = 4; // px/tick -> 120 px/sec, must match client prediction

// ==================== DAY / NIGHT / WAVES ====================
const DAY_LENGTH_MS = 2 * 60 * 1000;   // 2 min to gather & build
const NIGHT_LENGTH_MS = 1.5 * 60 * 1000; // 1.5 min of monster assault
const CYCLE_LENGTH_MS = DAY_LENGTH_MS + NIGHT_LENGTH_MS;
const serverStartTime = Date.now();

function getCyclePos() { return (Date.now() - serverStartTime) % CYCLE_LENGTH_MS; }
function isNightNow() { return getCyclePos() >= DAY_LENGTH_MS; }
function getWaveNumber() { return Math.floor((Date.now() - serverStartTime) / CYCLE_LENGTH_MS) + 1; }
function getPhaseInfo() {
  const pos = getCyclePos();
  if (pos < DAY_LENGTH_MS) {
    return { phase: 'day', frac: pos / DAY_LENGTH_MS, msLeft: DAY_LENGTH_MS - pos };
  }
  return { phase: 'night', frac: (pos - DAY_LENGTH_MS) / NIGHT_LENGTH_MS, msLeft: CYCLE_LENGTH_MS - pos };
}

// ==================== ALTAR (base core) ====================
const ALTAR = { x: CENTER_X, y: CENTER_Y, hp: 500, maxHp: 500, baseRadius: 260 };

// ==================== SHARED TEAM STASH ====================
const team = { iron: 0, crystals: 0, shadowCores: 0 };

// ==================== ENTITIES ====================
const players = {};
const resourceNodes = {}; // iron / crystal
const walls = {};
const turrets = {};
const beacons = {};
const monsters = {};
const particlesLog = []; // not used server-side; placeholder to keep parity with client naming

function isInSafeZone(x, y) {
  if (Math.hypot(x - ALTAR.x, y - ALTAR.y) <= ALTAR.baseRadius) return true;
  for (const id in beacons) {
    const b = beacons[id];
    if (Math.hypot(x - b.x, y - b.y) <= b.radius) return true;
  }
  return false;
}

// ==================== RESOURCE NODE GENERATION ====================
function makeIronVein(x, y) {
  return { id: rid('iron'), type: 'iron', x, y, hp: 4, maxHp: 4, size: 30 + Math.random() * 14 };
}
function makeCrystalNode(x, y) {
  return { id: rid('crystal'), type: 'crystal', x, y, hp: 5, maxHp: 5, size: 22 + Math.random() * 10 };
}
function randomWildPoint(minDistFromAltar) {
  let x, y;
  do {
    x = 40 + Math.random() * (WORLD_WIDTH - 80);
    y = 40 + Math.random() * (WORLD_HEIGHT - 80);
  } while (Math.hypot(x - ALTAR.x, y - ALTAR.y) < minDistFromAltar);
  return { x, y };
}
function generateWorld() {
  for (let i = 0; i < 90; i++) {
    const p = randomWildPoint(320);
    const n = makeIronVein(p.x, p.y);
    resourceNodes[n.id] = n;
  }
  for (let i = 0; i < 45; i++) {
    const p = randomWildPoint(380);
    const n = makeCrystalNode(p.x, p.y);
    resourceNodes[n.id] = n;
  }
}
generateWorld();

// ==================== BUILDING ====================
const BUILD_COSTS = {
  wall: { iron: 5 },
  turret: { iron: 12, crystals: 4 },
  beacon: { crystals: 6 }
};
const BUILD_STATS = {
  wall: { hp: 100 },
  turret: { hp: 60, range: 230, fireRateMs: 850, damage: 2 },
  beacon: { hp: 40, radius: 190 }
};
const BUILD_MAX_DIST_FROM_ALTAR = 1100; // keeps the base clustered in early game
const BUILD_MIN_SPACING = 44;

function anyBuildingNear(x, y, spacing) {
  for (const id in walls) if (dist(walls[id], { x, y }) < spacing) return true;
  for (const id in turrets) if (dist(turrets[id], { x, y }) < spacing) return true;
  for (const id in beacons) if (dist(beacons[id], { x, y }) < spacing) return true;
  return false;
}

// ==================== MONSTERS ====================
const MONSTER_TYPES = {
  hound: { hp: 3, speed: 105, damage: 5, aggroPlayers: true, coreValue: 1 },
  rammer: { hp: 11, speed: 52, damage: 14, aggroPlayers: false, coreValue: 2 }
};
const OBSTACLE_AGGRO_RANGE = 160;
const PLAYER_AGGRO_RANGE = 130;
const MONSTER_ATTACK_RANGE = 34;

function makeMonster(type, x, y, waveBonus) {
  const t = MONSTER_TYPES[type];
  const hp = t.hp + waveBonus;
  return { id: rid('mon'), type, x, y, hp, maxHp: hp, vx: 0, vy: 0, facingRight: true, attacking: false };
}
function spawnMonsterAtEdge(type) {
  const angle = Math.random() * Math.PI * 2;
  const distFromAltar = 1300 + Math.random() * 500;
  const x = Math.max(20, Math.min(WORLD_WIDTH - 20, ALTAR.x + Math.cos(angle) * distFromAltar));
  const y = Math.max(20, Math.min(WORLD_HEIGHT - 20, ALTAR.y + Math.sin(angle) * distFromAltar));
  const waveBonus = Math.floor(getWaveNumber() / 2);
  const m = makeMonster(type, x, y, waveBonus);
  monsters[m.id] = m;
  io.emit('monster_added', m);
}

let currentWave = 0;
function startWave() {
  currentWave = getWaveNumber();
  const count = Math.min(4 + currentWave * 2, 40);
  const rammerChance = Math.min(0.5, 0.08 + currentWave * 0.03);
  for (let i = 0; i < count; i++) {
    spawnMonsterAtEdge(Math.random() < rammerChance ? 'rammer' : 'hound');
  }
  io.emit('wave_start', { wave: currentWave, count });
}
function endWave() {
  for (const id in monsters) delete monsters[id];
  io.emit('wave_end', { wave: currentWave });
}

function killMonster(m, creditShadowCore) {
  delete monsters[m.id];
  if (creditShadowCore) {
    team.shadowCores += MONSTER_TYPES[m.type].coreValue;
    io.emit('team_resources', team);
  }
  io.emit('monster_removed', m.id);
}

function respawnPlayer(p, socket) {
  p.health = p.maxHealth;
  p.x = ALTAR.x + randInt(-120, 120);
  p.y = ALTAR.y + randInt(-120, 120);
  if (socket) socket.emit('player_died', {});
}

function triggerAltarFall() {
  ALTAR.hp = ALTAR.maxHp;
  for (const id in monsters) delete monsters[id];
  for (const id in walls) delete walls[id];
  for (const id in turrets) delete turrets[id];
  for (const id in beacons) delete beacons[id];
  team.iron = 0; team.crystals = 0; team.shadowCores = 0;
  for (const id in players) {
    const p = players[id];
    p.health = p.maxHealth;
    p.x = ALTAR.x + randInt(-120, 120);
    p.y = ALTAR.y + randInt(-120, 120);
  }
  io.emit('altar_destroyed', {});
  io.emit('team_resources', team);
}

// ==================== SOCKET.IO ====================
const ADJ = ['Тёмный', 'Тихий', 'Мрачный', 'Дикий', 'Забытый', 'Ночной', 'Стойкий'];
const NOUN = ['Страж', 'Хранитель', 'Скиталец', 'Кузнец', 'Часовой', 'Инженер'];
function randomName() { return ADJ[randInt(0, ADJ.length)] + ' ' + NOUN[randInt(0, NOUN.length)]; }

io.on('connection', (socket) => {
  socket.on('join', (data) => {
    const name = (data && data.name && String(data.name).trim().slice(0, 24)) || randomName();
    const userId = (data && data.userId) || socket.id;

    players[socket.id] = {
      id: socket.id,
      userId,
      name,
      x: ALTAR.x + randInt(-120, 120),
      y: ALTAR.y + randInt(-120, 120),
      facingRight: true,
      isMoving: false,
      health: 100,
      maxHealth: 100,
      input: { up: false, down: false, left: false, right: false }
    };

    socket.emit('init', {
      selfId: socket.id,
      players,
      resourceNodes,
      walls,
      turrets,
      beacons,
      monsters,
      team,
      altar: ALTAR,
      wave: currentWave,
      phase: getPhaseInfo(),
      world: { width: WORLD_WIDTH, height: WORLD_HEIGHT }
    });

    socket.broadcast.emit('player_joined', players[socket.id]);
  });

  socket.on('input', (input) => {
    const p = players[socket.id];
    if (!p || !input) return;
    p.input = { up: !!input.up, down: !!input.down, left: !!input.left, right: !!input.right };
  });

  socket.on('mine', (nodeId) => {
    const p = players[socket.id];
    const n = resourceNodes[nodeId];
    if (!p || !n) return;
    if (dist(p, n) > 90) return;

    n.hp -= 1;
    if (n.hp <= 0) {
      if (n.type === 'iron') team.iron += 2 + randInt(0, 3);
      else team.crystals += 1 + randInt(0, 2);
      delete resourceNodes[nodeId];
      io.emit('node_removed', nodeId);
      io.emit('team_resources', team);

      const type = n.type, x0 = n.x, y0 = n.y;
      setTimeout(() => {
        const p2 = randomWildPoint(320);
        const nn = type === 'iron' ? makeIronVein(p2.x, p2.y) : makeCrystalNode(p2.x, p2.y);
        resourceNodes[nn.id] = nn;
        io.emit('node_added', nn);
      }, 22000);
    } else {
      io.emit('node_damaged', { id: nodeId, hp: n.hp });
    }
  });

  socket.on('build', (data) => {
    const p = players[socket.id];
    if (!p || !data) return;
    const type = data.type;
    const x = Number(data.x), y = Number(data.y);
    if (!BUILD_COSTS[type] || !isFinite(x) || !isFinite(y)) return;
    if (Math.hypot(x - ALTAR.x, y - ALTAR.y) > BUILD_MAX_DIST_FROM_ALTAR) return;
    if (dist(p, { x, y }) > 140) return; // must build near yourself
    if (anyBuildingNear(x, y, BUILD_MIN_SPACING)) return;

    const cost = BUILD_COSTS[type];
    for (const k in cost) if ((team[k] || 0) < cost[k]) return;
    for (const k in cost) team[k] -= cost[k];

    let obj;
    if (type === 'wall') {
      obj = { id: rid('wall'), x, y, hp: BUILD_STATS.wall.hp, maxHp: BUILD_STATS.wall.hp };
      walls[obj.id] = obj;
      io.emit('wall_added', obj);
    } else if (type === 'turret') {
      obj = {
        id: rid('turret'), x, y,
        hp: BUILD_STATS.turret.hp, maxHp: BUILD_STATS.turret.hp,
        range: BUILD_STATS.turret.range, damage: BUILD_STATS.turret.damage,
        fireRateMs: BUILD_STATS.turret.fireRateMs, lastFireAt: 0, angle: 0
      };
      turrets[obj.id] = obj;
      io.emit('turret_added', obj);
    } else if (type === 'beacon') {
      obj = { id: rid('beacon'), x, y, hp: BUILD_STATS.beacon.hp, maxHp: BUILD_STATS.beacon.hp, radius: BUILD_STATS.beacon.radius };
      beacons[obj.id] = obj;
      io.emit('beacon_added', obj);
    }
    io.emit('team_resources', team);
  });

  socket.on('repair', (data) => {
    const p = players[socket.id];
    if (!p || !data) return;
    const map = data.kind === 'wall' ? walls : data.kind === 'turret' ? turrets : data.kind === 'beacon' ? beacons : null;
    if (!map) return;
    const obj = map[data.id];
    if (!obj) return;
    if (dist(p, obj) > 100) return;
    if (obj.hp >= obj.maxHp) return;
    if ((team.iron || 0) < 2) return;
    team.iron -= 2;
    obj.hp = Math.min(obj.maxHp, obj.hp + 20);
    io.emit('team_resources', team);
    io.emit(data.kind + '_updated', { id: obj.id, hp: obj.hp });
  });

  socket.on('attack_monster', (monsterId) => {
    const p = players[socket.id];
    const m = monsters[monsterId];
    if (!p || !m) return;
    if (dist(p, m) > 90) return;
    m.hp -= 2;
    if (m.hp <= 0) killMonster(m, true);
    else io.emit('monster_damaged', { id: monsterId, hp: m.hp });
  });

  socket.on('chat', (text) => {
    const p = players[socket.id];
    if (!p || typeof text !== 'string') return;
    const clean = text.trim().slice(0, 140);
    if (!clean) return;
    const now = Date.now();
    if (p._lastChatAt && now - p._lastChatAt < 600) return;
    p._lastChatAt = now;
    io.emit('chat', { id: socket.id, name: p.name, text: clean, t: now });
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('player_left', socket.id);
  });
});

// ==================== GAME LOOP ====================
let wasNight = false;
function tick() {
  const night = isNightNow();
  if (night && !wasNight) startWave();
  if (!night && wasNight) endWave();
  wasNight = night;

  for (const id in players) {
    const p = players[id];
    let dx = 0, dy = 0;
    if (p.input.up) dy -= 1;
    if (p.input.down) dy += 1;
    if (p.input.left) dx -= 1;
    if (p.input.right) dx += 1;
    if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }

    p.isMoving = (dx !== 0 || dy !== 0);
    p.x = Math.max(20, Math.min(WORLD_WIDTH - 20, p.x + dx * PLAYER_SPEED));
    p.y = Math.max(20, Math.min(WORLD_HEIGHT - 20, p.y + dy * PLAYER_SPEED));
    if (dx > 0) p.facingRight = true;
    if (dx < 0) p.facingRight = false;

    const inSafe = isInSafeZone(p.x, p.y);
    if (inSafe) {
      p.health = Math.min(p.maxHealth, p.health + 0.3 * DT);
    } else if (night) {
      p.health = Math.max(0, p.health - 1.2 * DT);
    }
    if (p.health <= 0) respawnPlayer(p, io.sockets.sockets.get(id));
  }

  monsterTick();
  turretTick();

  if (ALTAR.hp <= 0) triggerAltarFall();
}
setInterval(tick, 1000 / TICK_RATE);

function monsterTick() {
  if (!isNightNow()) return;

  for (const id in monsters) {
    const m = monsters[id];
    const stats = MONSTER_TYPES[m.type];
    let target = null, targetKind = null, bestDist = Infinity;

    for (const wid in walls) {
      const w = walls[wid];
      const d = dist(m, w);
      if (d < OBSTACLE_AGGRO_RANGE && d < bestDist) { bestDist = d; target = w; targetKind = 'wall'; }
    }
    for (const tid in turrets) {
      const t = turrets[tid];
      const d = dist(m, t);
      if (d < OBSTACLE_AGGRO_RANGE && d < bestDist) { bestDist = d; target = t; targetKind = 'turret'; }
    }
    if (!target && stats.aggroPlayers) {
      for (const pid in players) {
        const p = players[pid];
        const d = dist(m, p);
        if (d < PLAYER_AGGRO_RANGE && d < bestDist) { bestDist = d; target = p; targetKind = 'player'; }
      }
    }
    if (!target) { target = ALTAR; targetKind = 'altar'; }

    const dx = target.x - m.x, dy = target.y - m.y;
    const mag = Math.hypot(dx, dy) || 1;
    const reach = targetKind === 'altar' ? ALTAR.baseRadius * 0.55 : MONSTER_ATTACK_RANGE;

    if (mag > reach) {
      m.vx = (dx / mag) * stats.speed;
      m.vy = (dy / mag) * stats.speed;
      m.x += m.vx * DT;
      m.y += m.vy * DT;
      m.attacking = false;
    } else {
      m.vx = 0; m.vy = 0;
      m.attacking = true;
      if (targetKind === 'wall' || targetKind === 'turret') {
        target.hp = Math.max(0, target.hp - stats.damage * DT * 2);
        if (target.hp <= 0) {
          const map = targetKind === 'wall' ? walls : turrets;
          delete map[target.id];
          io.emit((targetKind === 'wall' ? 'wall' : 'turret') + '_removed', target.id);
        } else {
          io.emit((targetKind === 'wall' ? 'wall' : 'turret') + '_updated', { id: target.id, hp: target.hp });
        }
      } else if (targetKind === 'player') {
        target.health = Math.max(0, target.health - stats.damage * DT);
        if (target.health <= 0) respawnPlayer(target, io.sockets.sockets.get(target.id));
      } else if (targetKind === 'altar') {
        ALTAR.hp = Math.max(0, ALTAR.hp - stats.damage * DT);
      }
    }

    if (m.vx > 0.5) m.facingRight = true;
    else if (m.vx < -0.5) m.facingRight = false;

    m.x = Math.max(20, Math.min(WORLD_WIDTH - 20, m.x));
    m.y = Math.max(20, Math.min(WORLD_HEIGHT - 20, m.y));
  }
}

function turretTick() {
  const now = Date.now();
  for (const id in turrets) {
    const t = turrets[id];
    let target = null, bestDist = Infinity;
    for (const mid in monsters) {
      const m = monsters[mid];
      const d = dist(t, m);
      if (d < t.range && d < bestDist) { bestDist = d; target = m; }
    }
    if (target) t.angle = Math.atan2(target.y - t.y, target.x - t.x);
    if (target && now - t.lastFireAt >= t.fireRateMs) {
      t.lastFireAt = now;
      target.hp -= t.damage;
      io.emit('turret_fired', { id: t.id, targetX: target.x, targetY: target.y });
      if (target.hp <= 0) killMonster(target, true);
      else io.emit('monster_damaged', { id: target.id, hp: target.hp });
    }
  }
}

function broadcastState() {
  const snapshot = {};
  for (const id in players) {
    const p = players[id];
    snapshot[id] = { id: p.id, name: p.name, x: p.x, y: p.y, facingRight: p.facingRight, isMoving: p.isMoving, health: p.health, maxHealth: p.maxHealth };
  }
  const monsterSnapshot = {};
  for (const id in monsters) {
    const m = monsters[id];
    monsterSnapshot[id] = { id: m.id, type: m.type, x: m.x, y: m.y, facingRight: m.facingRight, attacking: m.attacking, hp: m.hp, maxHp: m.maxHp };
  }
  const turretAngles = {};
  for (const id in turrets) turretAngles[id] = turrets[id].angle;

  io.emit('state', {
    players: snapshot,
    monsters: monsterSnapshot,
    turretAngles,
    altarHp: ALTAR.hp,
    wave: currentWave,
    phase: getPhaseInfo(),
    t: Date.now()
  });
}
setInterval(broadcastState, 1000 / BROADCAST_RATE);

server.listen(PORT, () => {
  console.log(`Altar TD server running on port ${PORT}`);
});
