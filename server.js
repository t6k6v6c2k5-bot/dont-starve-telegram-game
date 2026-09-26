const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;

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

// ==================== WORLD / TIMING CONSTANTS ====================
const WORLD_WIDTH = 3400;
const WORLD_HEIGHT = 3400;
const CENTER_X = WORLD_WIDTH / 2;
const CENTER_Y = WORLD_HEIGHT / 2;
const TICK_RATE = 30;
const BROADCAST_RATE = 30;
const DT = 1 / TICK_RATE;
const PLAYER_SPEED = 4; // px/tick -> 120 px/sec, must match client prediction

const DAY_LENGTH_MS = 2 * 60 * 1000;
const NIGHT_LENGTH_MS = 1.5 * 60 * 1000;
const CYCLE_LENGTH_MS = DAY_LENGTH_MS + NIGHT_LENGTH_MS;

const BUILD_COSTS = { wall: { iron: 5 }, turret: { iron: 12, crystals: 4 }, beacon: { crystals: 6 } };
const BUILD_STATS = {
  wall: { hp: 100 },
  turret: { hp: 60, range: 230, fireRateMs: 850, damage: 2 },
  beacon: { hp: 40, radius: 190 }
};
const BUILD_MAX_DIST_FROM_ALTAR = 1100;
const BUILD_MIN_SPACING = 44;

const MONSTER_TYPES = {
  hound: { hp: 3, speed: 105, damage: 5, aggroPlayers: true, coreValue: 1 },
  rammer: { hp: 11, speed: 52, damage: 14, aggroPlayers: false, coreValue: 2 }
};
const OBSTACLE_AGGRO_RANGE = 160;
const PLAYER_AGGRO_RANGE = 130;
const MONSTER_ATTACK_RANGE = 34;

const ROOM_EMPTY_TTL_MS = 3 * 60 * 1000; // delete an empty room after 3 min

// ==================== ROOM MANAGEMENT ====================
const rooms = {}; // code -> room
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I/L

function createRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_CHARS[randInt(0, ROOM_CODE_CHARS.length)]).join('');
  } while (rooms[code]);
  return code;
}

function randomWildPoint(room, minDistFromAltar) {
  let x, y;
  do {
    x = 40 + Math.random() * (WORLD_WIDTH - 80);
    y = 40 + Math.random() * (WORLD_HEIGHT - 80);
  } while (Math.hypot(x - room.altar.x, y - room.altar.y) < minDistFromAltar);
  return { x, y };
}
function makeIronVein(x, y) { return { id: rid('iron'), type: 'iron', x, y, hp: 4, maxHp: 4, size: 30 + Math.random() * 14 }; }
function makeCrystalNode(x, y) { return { id: rid('crystal'), type: 'crystal', x, y, hp: 5, maxHp: 5, size: 22 + Math.random() * 10 }; }

function generateWorldFor(room) {
  for (let i = 0; i < 90; i++) { const p = randomWildPoint(room, 320); const n = makeIronVein(p.x, p.y); room.resourceNodes[n.id] = n; }
  for (let i = 0; i < 45; i++) { const p = randomWildPoint(room, 380); const n = makeCrystalNode(p.x, p.y); room.resourceNodes[n.id] = n; }
}

function createRoom(code) {
  const room = {
    code,
    players: {},
    resourceNodes: {},
    walls: {},
    turrets: {},
    beacons: {},
    monsters: {},
    team: { iron: 0, crystals: 0, shadowCores: 0 },
    altar: { x: CENTER_X, y: CENTER_Y, hp: 500, maxHp: 500, baseRadius: 260 },
    startTime: Date.now(), // room's own clock — every room starts fresh at DAY
    currentWave: 0,
    wasNight: false,
    emptySince: null
  };
  generateWorldFor(room);
  rooms[code] = room;
  return room;
}

function scheduleRoomCleanupCheck() {
  setInterval(() => {
    const now = Date.now();
    for (const code in rooms) {
      const room = rooms[code];
      if (Object.keys(room.players).length === 0) {
        if (room.emptySince === null) room.emptySince = now;
        else if (now - room.emptySince > ROOM_EMPTY_TTL_MS) delete rooms[code];
      } else {
        room.emptySince = null;
      }
    }
  }, 15000);
}
scheduleRoomCleanupCheck();

// ==================== ROOM CLOCK ====================
function getDayTime(room) { return ((Date.now() - room.startTime) % CYCLE_LENGTH_MS) / 1; }
function getCyclePos(room) { return (Date.now() - room.startTime) % CYCLE_LENGTH_MS; }
function isNightNow(room) { return getCyclePos(room) >= DAY_LENGTH_MS; }
function getWaveNumber(room) { return Math.floor((Date.now() - room.startTime) / CYCLE_LENGTH_MS) + 1; }
function getPhaseInfo(room) {
  const pos = getCyclePos(room);
  if (pos < DAY_LENGTH_MS) return { phase: 'day', frac: pos / DAY_LENGTH_MS, msLeft: DAY_LENGTH_MS - pos };
  return { phase: 'night', frac: (pos - DAY_LENGTH_MS) / NIGHT_LENGTH_MS, msLeft: CYCLE_LENGTH_MS - pos };
}

function isInSafeZone(room, x, y) {
  if (Math.hypot(x - room.altar.x, y - room.altar.y) <= room.altar.baseRadius) return true;
  for (const id in room.beacons) {
    const b = room.beacons[id];
    if (Math.hypot(x - b.x, y - b.y) <= b.radius) return true;
  }
  return false;
}

function anyBuildingNear(room, x, y, spacing) {
  for (const id in room.walls) if (dist(room.walls[id], { x, y }) < spacing) return true;
  for (const id in room.turrets) if (dist(room.turrets[id], { x, y }) < spacing) return true;
  for (const id in room.beacons) if (dist(room.beacons[id], { x, y }) < spacing) return true;
  return false;
}

// ==================== MONSTERS ====================
function makeMonster(type, x, y, waveBonus) {
  const t = MONSTER_TYPES[type];
  const hp = t.hp + waveBonus;
  return { id: rid('mon'), type, x, y, hp, maxHp: hp, vx: 0, vy: 0, facingRight: true, attacking: false };
}
function spawnMonsterAtEdge(room, type) {
  const angle = Math.random() * Math.PI * 2;
  const distFromAltar = 1300 + Math.random() * 500;
  const x = Math.max(20, Math.min(WORLD_WIDTH - 20, room.altar.x + Math.cos(angle) * distFromAltar));
  const y = Math.max(20, Math.min(WORLD_HEIGHT - 20, room.altar.y + Math.sin(angle) * distFromAltar));
  const waveBonus = Math.floor(getWaveNumber(room) / 2);
  const m = makeMonster(type, x, y, waveBonus);
  room.monsters[m.id] = m;
  io.to(room.code).emit('monster_added', m);
}

function startWave(room) {
  room.currentWave = getWaveNumber(room);
  const count = Math.min(4 + room.currentWave * 2, 40);
  const rammerChance = Math.min(0.5, 0.08 + room.currentWave * 0.03);
  for (let i = 0; i < count; i++) spawnMonsterAtEdge(room, Math.random() < rammerChance ? 'rammer' : 'hound');
  io.to(room.code).emit('wave_start', { wave: room.currentWave, count });
}
function endWave(room) {
  for (const id in room.monsters) delete room.monsters[id];
  io.to(room.code).emit('wave_end', { wave: room.currentWave });
}
function killMonster(room, m, creditShadowCore) {
  delete room.monsters[m.id];
  if (creditShadowCore) {
    room.team.shadowCores += MONSTER_TYPES[m.type].coreValue;
    io.to(room.code).emit('team_resources', room.team);
  }
  io.to(room.code).emit('monster_removed', m.id);
}

function respawnPlayer(room, p, socket) {
  p.health = p.maxHealth;
  p.x = room.altar.x + randInt(-120, 120);
  p.y = room.altar.y + randInt(-120, 120);
  if (socket) socket.emit('player_died', {});
}

function triggerAltarFall(room) {
  room.altar.hp = room.altar.maxHp;
  for (const id in room.monsters) delete room.monsters[id];
  for (const id in room.walls) delete room.walls[id];
  for (const id in room.turrets) delete room.turrets[id];
  for (const id in room.beacons) delete room.beacons[id];
  room.team.iron = 0; room.team.crystals = 0; room.team.shadowCores = 0;
  for (const id in room.players) {
    const p = room.players[id];
    p.health = p.maxHealth;
    p.x = room.altar.x + randInt(-120, 120);
    p.y = room.altar.y + randInt(-120, 120);
  }
  io.to(room.code).emit('altar_destroyed', {});
  io.to(room.code).emit('team_resources', room.team);
}

// ==================== SOCKET.IO ====================
const ADJ = ['Тёмный', 'Тихий', 'Мрачный', 'Дикий', 'Забытый', 'Ночной', 'Стойкий'];
const NOUN = ['Страж', 'Хранитель', 'Скиталец', 'Кузнец', 'Часовой', 'Инженер'];
function randomName() { return ADJ[randInt(0, ADJ.length)] + ' ' + NOUN[randInt(0, NOUN.length)]; }

function addPlayerToRoom(socket, room, data) {
  const name = (data && data.name && String(data.name).trim().slice(0, 24)) || randomName();
  const userId = (data && data.userId) || socket.id;

  socket.join(room.code);
  socket.roomCode = room.code;

  room.players[socket.id] = {
    id: socket.id, userId, name,
    x: room.altar.x + randInt(-120, 120),
    y: room.altar.y + randInt(-120, 120),
    facingRight: true, isMoving: false,
    health: 100, maxHealth: 100,
    input: { up: false, down: false, left: false, right: false }
  };

  socket.emit('init', {
    selfId: socket.id,
    roomCode: room.code,
    players: room.players,
    resourceNodes: room.resourceNodes,
    walls: room.walls,
    turrets: room.turrets,
    beacons: room.beacons,
    monsters: room.monsters,
    team: room.team,
    altar: room.altar,
    wave: room.currentWave,
    phase: getPhaseInfo(room),
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT }
  });

  socket.to(room.code).emit('player_joined', room.players[socket.id]);
}

function getRoomOf(socket) {
  return socket.roomCode ? rooms[socket.roomCode] : null;
}

io.on('connection', (socket) => {
  socket.on('create_room', (data) => {
    const code = createRoomCode();
    const room = createRoom(code);
    addPlayerToRoom(socket, room, data);
  });

  socket.on('join_room', (data) => {
    const code = ((data && data.code) || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) { socket.emit('join_error', { message: 'Комната не найдена. Проверьте код.' }); return; }
    addPlayerToRoom(socket, room, data);
  });

  socket.on('input', (input) => {
    const room = getRoomOf(socket);
    const p = room && room.players[socket.id];
    if (!p || !input) return;
    p.input = { up: !!input.up, down: !!input.down, left: !!input.left, right: !!input.right };
  });

  socket.on('mine', (nodeId) => {
    const room = getRoomOf(socket);
    if (!room) return;
    const p = room.players[socket.id];
    const n = room.resourceNodes[nodeId];
    if (!p || !n) return;
    if (dist(p, n) > 90) return;

    n.hp -= 1;
    if (n.hp <= 0) {
      if (n.type === 'iron') room.team.iron += 2 + randInt(0, 3);
      else room.team.crystals += 1 + randInt(0, 2);
      delete room.resourceNodes[nodeId];
      io.to(room.code).emit('node_removed', nodeId);
      io.to(room.code).emit('team_resources', room.team);

      const type = n.type;
      setTimeout(() => {
        if (!rooms[room.code]) return;
        const p2 = randomWildPoint(room, 320);
        const nn = type === 'iron' ? makeIronVein(p2.x, p2.y) : makeCrystalNode(p2.x, p2.y);
        room.resourceNodes[nn.id] = nn;
        io.to(room.code).emit('node_added', nn);
      }, 22000);
    } else {
      io.to(room.code).emit('node_damaged', { id: nodeId, hp: n.hp });
    }
  });

  socket.on('build', (data) => {
    const room = getRoomOf(socket);
    if (!room) return;
    const p = room.players[socket.id];
    if (!p || !data) return;
    const type = data.type;
    const x = Number(data.x), y = Number(data.y);
    if (!BUILD_COSTS[type] || !isFinite(x) || !isFinite(y)) return;
    if (Math.hypot(x - room.altar.x, y - room.altar.y) > BUILD_MAX_DIST_FROM_ALTAR) return;
    if (dist(p, { x, y }) > 140) return;
    if (anyBuildingNear(room, x, y, BUILD_MIN_SPACING)) return;

    const cost = BUILD_COSTS[type];
    for (const k in cost) if ((room.team[k] || 0) < cost[k]) return;
    for (const k in cost) room.team[k] -= cost[k];

    let obj;
    if (type === 'wall') {
      obj = { id: rid('wall'), x, y, hp: BUILD_STATS.wall.hp, maxHp: BUILD_STATS.wall.hp };
      room.walls[obj.id] = obj;
      io.to(room.code).emit('wall_added', obj);
    } else if (type === 'turret') {
      obj = {
        id: rid('turret'), x, y,
        hp: BUILD_STATS.turret.hp, maxHp: BUILD_STATS.turret.hp,
        range: BUILD_STATS.turret.range, damage: BUILD_STATS.turret.damage,
        fireRateMs: BUILD_STATS.turret.fireRateMs, lastFireAt: 0, angle: 0
      };
      room.turrets[obj.id] = obj;
      io.to(room.code).emit('turret_added', obj);
    } else if (type === 'beacon') {
      obj = { id: rid('beacon'), x, y, hp: BUILD_STATS.beacon.hp, maxHp: BUILD_STATS.beacon.hp, radius: BUILD_STATS.beacon.radius };
      room.beacons[obj.id] = obj;
      io.to(room.code).emit('beacon_added', obj);
    }
    io.to(room.code).emit('team_resources', room.team);
  });

  socket.on('repair', (data) => {
    const room = getRoomOf(socket);
    if (!room) return;
    const p = room.players[socket.id];
    if (!p || !data) return;
    const map = data.kind === 'wall' ? room.walls : data.kind === 'turret' ? room.turrets : data.kind === 'beacon' ? room.beacons : null;
    if (!map) return;
    const obj = map[data.id];
    if (!obj) return;
    if (dist(p, obj) > 100) return;
    if (obj.hp >= obj.maxHp) return;
    if ((room.team.iron || 0) < 2) return;
    room.team.iron -= 2;
    obj.hp = Math.min(obj.maxHp, obj.hp + 20);
    io.to(room.code).emit('team_resources', room.team);
    io.to(room.code).emit(data.kind + '_updated', { id: obj.id, hp: obj.hp });
  });

  socket.on('attack_monster', (monsterId) => {
    const room = getRoomOf(socket);
    if (!room) return;
    const p = room.players[socket.id];
    const m = room.monsters[monsterId];
    if (!p || !m) return;
    if (dist(p, m) > 90) return;
    m.hp -= 2;
    if (m.hp <= 0) killMonster(room, m, true);
    else io.to(room.code).emit('monster_damaged', { id: monsterId, hp: m.hp });
  });

  socket.on('chat', (text) => {
    const room = getRoomOf(socket);
    if (!room) return;
    const p = room.players[socket.id];
    if (!p || typeof text !== 'string') return;
    const clean = text.trim().slice(0, 140);
    if (!clean) return;
    const now = Date.now();
    if (p._lastChatAt && now - p._lastChatAt < 600) return;
    p._lastChatAt = now;
    io.to(room.code).emit('chat', { id: socket.id, name: p.name, text: clean, t: now });
  });

  socket.on('disconnect', () => {
    const room = getRoomOf(socket);
    if (!room) return;
    delete room.players[socket.id];
    io.to(room.code).emit('player_left', socket.id);
  });
});

// ==================== PER-ROOM GAME LOOP ====================
function tickRoom(room) {
  const night = isNightNow(room);
  if (night && !room.wasNight) startWave(room);
  if (!night && room.wasNight) endWave(room);
  room.wasNight = night;

  for (const id in room.players) {
    const p = room.players[id];
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

    const inSafe = isInSafeZone(room, p.x, p.y);
    if (inSafe) p.health = Math.min(p.maxHealth, p.health + 0.3 * DT);
    else if (night) p.health = Math.max(0, p.health - 1.2 * DT);
    if (p.health <= 0) respawnPlayer(room, p, io.sockets.sockets.get(id));
  }

  monsterTickRoom(room);
  turretTickRoom(room);

  if (room.altar.hp <= 0) triggerAltarFall(room);
}

function monsterTickRoom(room) {
  if (!isNightNow(room)) return;

  for (const id in room.monsters) {
    const m = room.monsters[id];
    const stats = MONSTER_TYPES[m.type];
    let target = null, targetKind = null, bestDist = Infinity;

    for (const wid in room.walls) {
      const w = room.walls[wid];
      const d = dist(m, w);
      if (d < OBSTACLE_AGGRO_RANGE && d < bestDist) { bestDist = d; target = w; targetKind = 'wall'; }
    }
    for (const tid in room.turrets) {
      const t = room.turrets[tid];
      const d = dist(m, t);
      if (d < OBSTACLE_AGGRO_RANGE && d < bestDist) { bestDist = d; target = t; targetKind = 'turret'; }
    }
    if (!target && stats.aggroPlayers) {
      for (const pid in room.players) {
        const p = room.players[pid];
        const d = dist(m, p);
        if (d < PLAYER_AGGRO_RANGE && d < bestDist) { bestDist = d; target = p; targetKind = 'player'; }
      }
    }
    if (!target) { target = room.altar; targetKind = 'altar'; }

    const dx = target.x - m.x, dy = target.y - m.y;
    const mag = Math.hypot(dx, dy) || 1;
    const reach = targetKind === 'altar' ? room.altar.baseRadius * 0.55 : MONSTER_ATTACK_RANGE;

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
          const map = targetKind === 'wall' ? room.walls : room.turrets;
          delete map[target.id];
          io.to(room.code).emit((targetKind === 'wall' ? 'wall' : 'turret') + '_removed', target.id);
        } else {
          io.to(room.code).emit((targetKind === 'wall' ? 'wall' : 'turret') + '_updated', { id: target.id, hp: target.hp });
        }
      } else if (targetKind === 'player') {
        target.health = Math.max(0, target.health - stats.damage * DT);
        if (target.health <= 0) respawnPlayer(room, target, io.sockets.sockets.get(target.id));
      } else if (targetKind === 'altar') {
        room.altar.hp = Math.max(0, room.altar.hp - stats.damage * DT);
      }
    }

    if (m.vx > 0.5) m.facingRight = true;
    else if (m.vx < -0.5) m.facingRight = false;

    m.x = Math.max(20, Math.min(WORLD_WIDTH - 20, m.x));
    m.y = Math.max(20, Math.min(WORLD_HEIGHT - 20, m.y));
  }
}

function turretTickRoom(room) {
  const now = Date.now();
  for (const id in room.turrets) {
    const t = room.turrets[id];
    let target = null, bestDist = Infinity;
    for (const mid in room.monsters) {
      const m = room.monsters[mid];
      const d = dist(t, m);
      if (d < t.range && d < bestDist) { bestDist = d; target = m; }
    }
    if (target) t.angle = Math.atan2(target.y - t.y, target.x - t.x);
    if (target && now - t.lastFireAt >= t.fireRateMs) {
      t.lastFireAt = now;
      target.hp -= t.damage;
      io.to(room.code).emit('turret_fired', { id: t.id, targetX: target.x, targetY: target.y });
      if (target.hp <= 0) killMonster(room, target, true);
      else io.to(room.code).emit('monster_damaged', { id: target.id, hp: target.hp });
    }
  }
}

function broadcastRoomState(room) {
  const snapshot = {};
  for (const id in room.players) {
    const p = room.players[id];
    snapshot[id] = { id: p.id, name: p.name, x: p.x, y: p.y, facingRight: p.facingRight, isMoving: p.isMoving, health: p.health, maxHealth: p.maxHealth };
  }
  const monsterSnapshot = {};
  for (const id in room.monsters) {
    const m = room.monsters[id];
    monsterSnapshot[id] = { id: m.id, type: m.type, x: m.x, y: m.y, facingRight: m.facingRight, attacking: m.attacking, hp: m.hp, maxHp: m.maxHp };
  }
  const turretAngles = {};
  for (const id in room.turrets) turretAngles[id] = room.turrets[id].angle;

  io.to(room.code).emit('state', {
    players: snapshot,
    monsters: monsterSnapshot,
    turretAngles,
    altarHp: room.altar.hp,
    wave: room.currentWave,
    phase: getPhaseInfo(room),
    t: Date.now()
  });
}

setInterval(() => { for (const code in rooms) tickRoom(rooms[code]); }, 1000 / TICK_RATE);
setInterval(() => { for (const code in rooms) broadcastRoomState(rooms[code]); }, 1000 / BROADCAST_RATE);

server.listen(PORT, () => {
  console.log(`Altar TD server (rooms) running on port ${PORT}`);
});
