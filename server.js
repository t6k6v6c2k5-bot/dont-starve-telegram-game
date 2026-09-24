const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ==================== WORLD STATE ====================
const WORLD_WIDTH = 3000;
const WORLD_HEIGHT = 3000;
const TICK_RATE = 30;         // server simulation ticks / sec
const BROADCAST_RATE = 30;    // state broadcasts / sec (matches tick rate for less jitter)
const PLAYER_SPEED = 4;       // px per tick (=> 120 px/sec)
const CHOP_RANGE = 90;
const HUNT_RANGE = 100;
const RESOURCE_RESPAWN_MS = 20000;
const ANIMAL_COUNT = 35;
const ANIMAL_WANDER_SPEED = 35;  // px/sec
const ANIMAL_FLEE_SPEED = 150;   // px/sec
const ANIMAL_FLEE_RADIUS = 160;
const ANIMAL_HP = 2;
const ANIMAL_RESPAWN_MS = 25000;
const DT = 1 / TICK_RATE;

// Day/night cycle
const DAY_LENGTH_MS = 6 * 60 * 1000; // full day+night cycle
const NIGHT_START = 0.65;            // fraction of the cycle when night begins
const serverStartTime = Date.now();

// Campfires
const CAMPFIRE_COST_WOOD = 3;
const CAMPFIRE_FEED_WOOD = 1;
const CAMPFIRE_FEED_FUEL = 35;   // seconds of burn added per wood fed
const CAMPFIRE_FUEL_MAX = 180;
const CAMPFIRE_LIGHT_RADIUS = 220;
const CAMPFIRE_INTERACT_RANGE = 110;
const NIGHT_EXPOSURE_DAMAGE = 0.05; // extra health/sec lost if out in the dark, unlit
const CAMPFIRE_HEAL_RATE = 0.6;     // health/sec regen while sitting at a lit fire

const players = {};   // socketId -> player object
const resources = {}; // resourceId -> resource object
const animals = {};   // animalId -> animal object
const campfires = {}; // campfireId -> campfire object

function getDayTime() {
  return ((Date.now() - serverStartTime) % DAY_LENGTH_MS) / DAY_LENGTH_MS;
}
function getDayNumber() {
  return Math.floor((Date.now() - serverStartTime) / DAY_LENGTH_MS) + 1;
}
function isNightNow() {
  return getDayTime() >= NIGHT_START;
}

function isNearLitCampfire(x, y, radius) {
  for (const id in campfires) {
    const c = campfires[id];
    if (c.lit && Math.hypot(c.x - x, c.y - y) <= (radius !== undefined ? radius : c.radius)) return true;
  }
  return false;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min) + min);
}

function makeTree(x, y) {
  return {
    id: 'res_' + Math.random().toString(36).slice(2, 10),
    type: 'tree',
    x, y,
    size: 35 + Math.random() * 20,
    hp: 3,
    maxHp: 3
  };
}

function makeRock(x, y) {
  return {
    id: 'res_' + Math.random().toString(36).slice(2, 10),
    type: 'rock',
    x, y,
    size: 25 + Math.random() * 15,
    hp: 4,
    maxHp: 4
  };
}

function generateWorld() {
  for (let i = 0; i < 150; i++) {
    const t = makeTree(Math.random() * WORLD_WIDTH, Math.random() * WORLD_HEIGHT);
    resources[t.id] = t;
  }
  for (let i = 0; i < 80; i++) {
    const r = makeRock(Math.random() * WORLD_WIDTH, Math.random() * WORLD_HEIGHT);
    resources[r.id] = r;
  }
  for (let i = 0; i < ANIMAL_COUNT; i++) {
    const a = makeAnimal(Math.random() * WORLD_WIDTH, Math.random() * WORLD_HEIGHT);
    animals[a.id] = a;
  }
}
generateWorld();

function makeAnimal(x, y) {
  return {
    id: 'ani_' + Math.random().toString(36).slice(2, 10),
    type: 'rabbit',
    x, y,
    hp: ANIMAL_HP,
    maxHp: ANIMAL_HP,
    vx: 0,
    vy: 0,
    facingRight: true,
    fleeing: false,
    nextWanderAt: 0
  };
}

const ADJ = ['Тёмный', 'Тихий', 'Мрачный', 'Дикий', 'Забытый', 'Ночной', 'Одинокий', 'Голодный'];
const NOUN = ['Странник', 'Скиталец', 'Охотник', 'Тень', 'Отшельник', 'Бродяга', 'Изгой'];
function randomName() {
  return ADJ[randInt(0, ADJ.length)] + ' ' + NOUN[randInt(0, NOUN.length)];
}

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
  console.log('[connect]', socket.id);

  socket.on('join', (data) => {
    const name = (data && data.name && String(data.name).trim().slice(0, 24)) || randomName();
    const userId = (data && data.userId) || socket.id;

    players[socket.id] = {
      id: socket.id,
      userId,
      name,
      x: WORLD_WIDTH / 2 + randInt(-150, 150),
      y: WORLD_HEIGHT / 2 + randInt(-150, 150),
      facingRight: true,
      isMoving: false,
      isSitting: false,
      health: 100,
      hunger: 100,
      deaths: 0,
      inventory: { wood: 0, stone: 0, meat: 0 },
      input: { up: false, down: false, left: false, right: false }
    };

    socket.emit('init', {
      selfId: socket.id,
      players,
      resources,
      animals,
      campfires,
      dayTime: getDayTime(),
      dayNumber: getDayNumber(),
      world: { width: WORLD_WIDTH, height: WORLD_HEIGHT }
    });

    socket.broadcast.emit('player_joined', players[socket.id]);
  });

  socket.on('input', (input) => {
    const p = players[socket.id];
    if (!p || !input) return;
    p.input = {
      up: !!input.up,
      down: !!input.down,
      left: !!input.left,
      right: !!input.right
    };
  });

  socket.on('chop', (resourceId) => {
    const p = players[socket.id];
    const r = resources[resourceId];
    if (!p || !r) return;

    const dist = Math.hypot(p.x - r.x, p.y - r.y);
    if (dist > CHOP_RANGE) return;

    r.hp -= 1;

    if (r.hp <= 0) {
      const yieldType = r.type === 'tree' ? 'wood' : 'stone';
      const yieldAmount = 1 + randInt(0, 2);
      p.inventory[yieldType] = (p.inventory[yieldType] || 0) + yieldAmount;

      delete resources[resourceId];
      io.emit('resource_removed', resourceId);
      io.emit('player_inventory', { id: socket.id, inventory: p.inventory });

      const type = r.type;
      setTimeout(() => {
        const nr = type === 'tree'
          ? makeTree(Math.random() * WORLD_WIDTH, Math.random() * WORLD_HEIGHT)
          : makeRock(Math.random() * WORLD_WIDTH, Math.random() * WORLD_HEIGHT);
        resources[nr.id] = nr;
        io.emit('resource_added', nr);
      }, RESOURCE_RESPAWN_MS);
    } else {
      io.emit('resource_damaged', { id: resourceId, hp: r.hp });
    }
  });

  socket.on('eat', () => {
    const p = players[socket.id];
    if (!p) return;
    if (p.inventory.meat > 0) {
      p.inventory.meat -= 1;
      p.hunger = Math.min(100, p.hunger + 40);
      socket.emit('player_inventory', { id: socket.id, inventory: p.inventory });
    } else if (p.inventory.wood > 0) {
      p.inventory.wood -= 1;
      p.hunger = Math.min(100, p.hunger + 15);
      socket.emit('player_inventory', { id: socket.id, inventory: p.inventory });
    }
  });

  socket.on('hunt', (animalId) => {
    const p = players[socket.id];
    const a = animals[animalId];
    if (!p || !a) return;

    const dist = Math.hypot(p.x - a.x, p.y - a.y);
    if (dist > HUNT_RANGE) return;

    a.hp -= 1;

    if (a.hp <= 0) {
      const yieldAmount = 1 + randInt(0, 2);
      p.inventory.meat = (p.inventory.meat || 0) + yieldAmount;

      delete animals[animalId];
      io.emit('animal_removed', animalId);
      io.emit('player_inventory', { id: socket.id, inventory: p.inventory });

      setTimeout(() => {
        const na = makeAnimal(Math.random() * WORLD_WIDTH, Math.random() * WORLD_HEIGHT);
        animals[na.id] = na;
        io.emit('animal_added', na);
      }, ANIMAL_RESPAWN_MS);
    } else {
      io.emit('animal_damaged', { id: animalId, hp: a.hp });
    }
  });

  socket.on('place_campfire', () => {
    const p = players[socket.id];
    if (!p) return;
    if ((p.inventory.wood || 0) < CAMPFIRE_COST_WOOD) return;

    // Don't allow stacking campfires right on top of each other.
    for (const id in campfires) {
      if (Math.hypot(campfires[id].x - p.x, campfires[id].y - p.y) < 70) return;
    }

    p.inventory.wood -= CAMPFIRE_COST_WOOD;
    const c = {
      id: 'fire_' + Math.random().toString(36).slice(2, 10),
      x: p.x,
      y: p.y,
      fuel: CAMPFIRE_FUEL_MAX * 0.5,
      radius: CAMPFIRE_LIGHT_RADIUS,
      lit: true
    };
    campfires[c.id] = c;
    io.emit('campfire_added', c);
    socket.emit('player_inventory', { id: socket.id, inventory: p.inventory });
  });

  socket.on('feed_campfire', (campfireId) => {
    const p = players[socket.id];
    const c = campfires[campfireId];
    if (!p || !c) return;
    if ((p.inventory.wood || 0) < CAMPFIRE_FEED_WOOD) return;
    if (Math.hypot(p.x - c.x, p.y - c.y) > CAMPFIRE_INTERACT_RANGE) return;

    p.inventory.wood -= CAMPFIRE_FEED_WOOD;
    c.fuel = Math.min(CAMPFIRE_FUEL_MAX, c.fuel + CAMPFIRE_FEED_FUEL);
    c.lit = true;
    socket.emit('player_inventory', { id: socket.id, inventory: p.inventory });
  });

  socket.on('toggle_sit', () => {
    const p = players[socket.id];
    if (!p) return;
    p.isSitting = !p.isSitting;
  });

  socket.on('chat', (text) => {
    const p = players[socket.id];
    if (!p || typeof text !== 'string') return;
    const clean = text.trim().slice(0, 140);
    if (!clean) return;

    // Basic per-player rate limit so chat can't be used to flood the room.
    const now = Date.now();
    if (p._lastChatAt && now - p._lastChatAt < 600) return;
    p._lastChatAt = now;

    io.emit('chat', { id: socket.id, name: p.name, text: clean, t: now });
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('player_left', socket.id);
    console.log('[disconnect]', socket.id);
  });
});

// ==================== GAME LOOP ====================
function tick() {
  const night = isNightNow();

  for (const id in players) {
    const p = players[id];
    let dx = 0, dy = 0;

    if (p.input.up) dy -= 1;
    if (p.input.down) dy += 1;
    if (p.input.left) dx -= 1;
    if (p.input.right) dx += 1;

    if (dx !== 0 && dy !== 0) {
      dx *= 0.7071;
      dy *= 0.7071;
    }

    p.isMoving = (dx !== 0 || dy !== 0);
    if (p.isMoving) p.isSitting = false; // moving stands you up

    p.x = Math.max(20, Math.min(WORLD_WIDTH - 20, p.x + dx * PLAYER_SPEED));
    p.y = Math.max(20, Math.min(WORLD_HEIGHT - 20, p.y + dy * PLAYER_SPEED));

    if (dx > 0) p.facingRight = true;
    if (dx < 0) p.facingRight = false;

    const nearFire = isNearLitCampfire(p.x, p.y, CAMPFIRE_LIGHT_RADIUS);
    const hungerDrain = (p.isSitting && nearFire) ? 0.005 : 0.015;
    p.hunger = Math.max(0, p.hunger - hungerDrain);

    if (p.hunger <= 0) {
      p.health = Math.max(0, p.health - 0.03);
    }
    if (night && !nearFire) {
      // Don't Starve's own twist: the dark itself hurts you if you're not near light.
      p.health = Math.max(0, p.health - NIGHT_EXPOSURE_DAMAGE * DT);
    } else if (p.isSitting && nearFire) {
      p.health = Math.min(100, p.health + CAMPFIRE_HEAL_RATE * DT);
    }

    if (p.health <= 0) {
      respawnPlayer(p, io.sockets.sockets.get(id));
    }
  }

  animalTick();
  campfireTick();
}

function respawnPlayer(p, socket) {
  const lostWood = Math.ceil((p.inventory.wood || 0) / 2);
  const lostStone = Math.ceil((p.inventory.stone || 0) / 2);
  const lostMeat = Math.ceil((p.inventory.meat || 0) / 2);
  p.inventory.wood -= lostWood;
  p.inventory.stone -= lostStone;
  p.inventory.meat -= lostMeat;

  p.health = 100;
  p.hunger = 60;
  p.isSitting = false;
  p.deaths = (p.deaths || 0) + 1;
  p.x = WORLD_WIDTH / 2 + randInt(-200, 200);
  p.y = WORLD_HEIGHT / 2 + randInt(-200, 200);

  if (socket) {
    socket.emit('player_died', { deaths: p.deaths });
    socket.emit('player_inventory', { id: p.id, inventory: p.inventory });
  }
}

function campfireTick() {
  for (const id in campfires) {
    const c = campfires[id];
    if (c.lit) {
      c.fuel = Math.max(0, c.fuel - DT);
      if (c.fuel <= 0) c.lit = false;
    }
  }
}

function nearestPlayerDist(a) {
  let nearest = null;
  let nearestDist = Infinity;
  for (const id in players) {
    const p = players[id];
    const d = Math.hypot(p.x - a.x, p.y - a.y);
    if (d < nearestDist) { nearestDist = d; nearest = p; }
  }
  return { player: nearest, dist: nearestDist };
}

function animalTick() {
  const now = Date.now();
  for (const id in animals) {
    const a = animals[id];
    const { player: nearestP, dist } = nearestPlayerDist(a);

    if (nearestP && dist < ANIMAL_FLEE_RADIUS) {
      // Flee directly away from the nearest player.
      const dx = a.x - nearestP.x;
      const dy = a.y - nearestP.y;
      const mag = Math.hypot(dx, dy) || 1;
      a.vx = (dx / mag) * ANIMAL_FLEE_SPEED;
      a.vy = (dy / mag) * ANIMAL_FLEE_SPEED;
      a.fleeing = true;
      a.nextWanderAt = now + 600; // resume wandering shortly after the scare
    } else {
      a.fleeing = false;
      if (now > a.nextWanderAt) {
        if (Math.random() < 0.4) {
          // pause
          a.vx = 0; a.vy = 0;
        } else {
          const angle = Math.random() * Math.PI * 2;
          a.vx = Math.cos(angle) * ANIMAL_WANDER_SPEED;
          a.vy = Math.sin(angle) * ANIMAL_WANDER_SPEED;
        }
        a.nextWanderAt = now + 1500 + Math.random() * 2500;
      }
    }

    a.x += a.vx * DT;
    a.y += a.vy * DT;

    if (a.x < 20 || a.x > WORLD_WIDTH - 20) { a.vx *= -1; a.x = Math.max(20, Math.min(WORLD_WIDTH - 20, a.x)); }
    if (a.y < 20 || a.y > WORLD_HEIGHT - 20) { a.vy *= -1; a.y = Math.max(20, Math.min(WORLD_HEIGHT - 20, a.y)); }

    if (a.vx > 0.5) a.facingRight = true;
    else if (a.vx < -0.5) a.facingRight = false;
  }
}
setInterval(tick, 1000 / TICK_RATE);

function broadcastState() {
  const snapshot = {};
  for (const id in players) {
    const p = players[id];
    snapshot[id] = {
      id: p.id,
      name: p.name,
      x: p.x,
      y: p.y,
      facingRight: p.facingRight,
      isMoving: p.isMoving,
      isSitting: p.isSitting,
      health: p.health,
      hunger: p.hunger,
      deaths: p.deaths || 0
    };
  }
  const animalSnapshot = {};
  for (const id in animals) {
    const a = animals[id];
    animalSnapshot[id] = { id: a.id, x: a.x, y: a.y, facingRight: a.facingRight, fleeing: a.fleeing };
  }
  const campfireSnapshot = {};
  for (const id in campfires) {
    const c = campfires[id];
    campfireSnapshot[id] = { id: c.id, x: c.x, y: c.y, fuel: c.fuel, lit: c.lit };
  }
  io.emit('state', {
    players: snapshot,
    animals: animalSnapshot,
    campfires: campfireSnapshot,
    dayTime: getDayTime(),
    dayNumber: getDayNumber(),
    t: Date.now()
  });
}
setInterval(broadcastState, 1000 / BROADCAST_RATE);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
