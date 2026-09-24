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
const BROADCAST_RATE = 20;    // state broadcasts / sec
const PLAYER_SPEED = 4;
const CHOP_RANGE = 90;
const RESOURCE_RESPAWN_MS = 20000;

const players = {};   // socketId -> player object
const resources = {}; // resourceId -> resource object

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
}
generateWorld();

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
      health: 100,
      hunger: 100,
      inventory: { wood: 0, stone: 0 },
      input: { up: false, down: false, left: false, right: false }
    };

    socket.emit('init', {
      selfId: socket.id,
      players,
      resources,
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
    // Simple: eating consumes 1 wood as placeholder "berries" mechanic hook.
    const p = players[socket.id];
    if (!p) return;
    if (p.inventory.wood > 0) {
      p.inventory.wood -= 1;
      p.hunger = Math.min(100, p.hunger + 25);
      socket.emit('player_inventory', { id: socket.id, inventory: p.inventory });
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('player_left', socket.id);
    console.log('[disconnect]', socket.id);
  });
});

// ==================== GAME LOOP ====================
function tick() {
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
    p.x = Math.max(20, Math.min(WORLD_WIDTH - 20, p.x + dx * PLAYER_SPEED));
    p.y = Math.max(20, Math.min(WORLD_HEIGHT - 20, p.y + dy * PLAYER_SPEED));

    if (dx > 0) p.facingRight = true;
    if (dx < 0) p.facingRight = false;

    p.hunger = Math.max(0, p.hunger - 0.015);
    if (p.hunger <= 0) {
      p.health = Math.max(0, p.health - 0.03);
    }
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
      health: p.health,
      hunger: p.hunger
    };
  }
  io.emit('state', { players: snapshot, t: Date.now() });
}
setInterval(broadcastState, 1000 / BROADCAST_RATE);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
