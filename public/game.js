// ==================== TELEGRAM INIT ====================
let tgUser = null;
try {
  if (window.Telegram && window.Telegram.WebApp) {
    const tg = window.Telegram.WebApp;
    tg.expand();
    tg.ready();
    const u = tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (u) {
      tgUser = {
        id: u.id,
        name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || null
      };
    }
    document.body.style.background = tg.themeParams.bg_color || '#0d0d11';
  }
} catch (e) {
  console.warn('Telegram WebApp not available:', e);
}

function randomGuestName() {
  const adj = ['Тёмный', 'Тихий', 'Мрачный', 'Дикий', 'Забытый', 'Ночной'];
  const noun = ['Странник', 'Скиталец', 'Охотник', 'Тень', 'Отшельник'];
  return adj[Math.floor(Math.random() * adj.length)] + ' ' + noun[Math.floor(Math.random() * noun.length)];
}

const myUserId = (tgUser && tgUser.id) || ('guest_' + Math.random().toString(36).slice(2, 9));
const myName = (tgUser && tgUser.name) || randomGuestName();

// ==================== CANVAS SETUP ====================
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ==================== NETWORK STATE ====================
const socket = io();

let selfId = null;
let world = { width: 3000, height: 3000 };
let players = {};    // authoritative snapshot from server
let resources = {};  // resourceId -> {id, type, x, y, size, hp, maxHp}
let inventory = { wood: 0, stone: 0 };
let health = 100, hunger = 100;

socket.on('connect', () => {
  socket.emit('join', { userId: myUserId, name: myName });
});

function initRenderPos(p) {
  // renderX/renderY are the smoothed on-screen position; x/y stay server-authoritative.
  p.renderX = p.x;
  p.renderY = p.y;
}

socket.on('init', (data) => {
  selfId = data.selfId;
  world = data.world;
  players = data.players;
  resources = data.resources;
  Object.values(players).forEach(initRenderPos);
  const self = players[selfId];
  if (self) {
    inventory = self.inventory;
    health = self.health;
    hunger = self.hunger;
  }
  updatePlayersListUI();
});

socket.on('player_joined', (p) => {
  initRenderPos(p);
  players[p.id] = p;
  updatePlayersListUI();
});

socket.on('player_left', (id) => {
  delete players[id];
  updatePlayersListUI();
});

socket.on('state', (data) => {
  // Merge authoritative position/health/hunger fields, keep local-only fields (inventory) intact
  for (const id in data.players) {
    const incoming = data.players[id];
    if (players[id]) {
      Object.assign(players[id], incoming);
    } else {
      players[id] = incoming;
      initRenderPos(players[id]);
    }
  }
  // Remove any player not present anymore in snapshot
  for (const id in players) {
    if (!data.players[id]) delete players[id];
  }
  if (players[selfId]) {
    health = players[selfId].health;
    hunger = players[selfId].hunger;
  }
  updatePlayersListUI();
});

socket.on('resource_removed', (id) => { delete resources[id]; });
socket.on('resource_added', (r) => { resources[r.id] = r; });
socket.on('resource_damaged', (data) => {
  if (resources[data.id]) resources[data.id].hp = data.hp;
});
socket.on('player_inventory', (data) => {
  if (data.id === selfId) {
    inventory = data.inventory;
    updateResourceUI();
  }
});

// ==================== UI HELPERS ====================
const healthFillEl = document.getElementById('health-fill');
const hungerFillEl = document.getElementById('hunger-fill');
const woodCountEl = document.getElementById('wood-count');
const stoneCountEl = document.getElementById('stone-count');
const playersListBodyEl = document.getElementById('players-list-body');
const actionHintEl = document.getElementById('action-hint');

function updateBarsUI() {
  healthFillEl.style.width = Math.max(0, Math.min(100, health)) + '%';
  hungerFillEl.style.width = Math.max(0, Math.min(100, hunger)) + '%';
}

function updateResourceUI() {
  woodCountEl.textContent = inventory.wood || 0;
  stoneCountEl.textContent = inventory.stone || 0;
}

function updatePlayersListUI() {
  const names = Object.values(players).map(p => p.name || '???');
  playersListBodyEl.innerHTML = names.map(n => `<div>• ${escapeHtml(n)}</div>`).join('') || '<div>—</div>';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ==================== INPUT: KEYBOARD ====================
const keyState = { up: false, down: false, left: false, right: false };
let interactPressed = false;

window.addEventListener('keydown', (e) => {
  if (['KeyW', 'ArrowUp'].includes(e.code)) keyState.up = true;
  if (['KeyS', 'ArrowDown'].includes(e.code)) keyState.down = true;
  if (['KeyA', 'ArrowLeft'].includes(e.code)) keyState.left = true;
  if (['KeyD', 'ArrowRight'].includes(e.code)) keyState.right = true;
  if (e.code === 'KeyE') interactPressed = true;
});
window.addEventListener('keyup', (e) => {
  if (['KeyW', 'ArrowUp'].includes(e.code)) keyState.up = false;
  if (['KeyS', 'ArrowDown'].includes(e.code)) keyState.down = false;
  if (['KeyA', 'ArrowLeft'].includes(e.code)) keyState.left = false;
  if (['KeyD', 'ArrowRight'].includes(e.code)) keyState.right = false;
});

// ==================== INPUT: VIRTUAL JOYSTICK ====================
const joystickZone = document.getElementById('joystick-zone');
const joystickStick = document.getElementById('joystick-stick');
const joyState = { active: false, dx: 0, dy: 0 };
let joyTouchId = null;

function joystickVectorToKeys(dx, dy) {
  const dead = 0.3;
  keyState.left = dx < -dead;
  keyState.right = dx > dead;
  keyState.up = dy < -dead;
  keyState.down = dy > dead;
}

function handleJoyStart(clientX, clientY, id) {
  joyState.active = true;
  joyTouchId = id;
  updateJoyStick(clientX, clientY);
}
function handleJoyMove(clientX, clientY) {
  if (!joyState.active) return;
  updateJoyStick(clientX, clientY);
}
function handleJoyEnd() {
  joyState.active = false;
  joyTouchId = null;
  joyState.dx = 0; joyState.dy = 0;
  joystickStick.style.transform = 'translate(0px, 0px)';
  joystickVectorToKeys(0, 0);
}
function updateJoyStick(clientX, clientY) {
  const rect = joystickZone.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let dx = (clientX - cx) / (rect.width / 2);
  let dy = (clientY - cy) / (rect.height / 2);
  const mag = Math.hypot(dx, dy);
  if (mag > 1) { dx /= mag; dy /= mag; }
  joyState.dx = dx; joyState.dy = dy;
  joystickStick.style.transform = `translate(${dx * 35}px, ${dy * 35}px)`;
  joystickVectorToKeys(dx, dy);
}

// Pointer Events unify mouse + touch + pen into one stream, so we never get
// duplicate/conflicting touchstart+mousedown pairs on the same tap (this was
// the main source of jittery, "double" joystick input on touch devices).
joystickZone.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  joystickZone.setPointerCapture(e.pointerId);
  handleJoyStart(e.clientX, e.clientY, e.pointerId);
});
joystickZone.addEventListener('pointermove', (e) => {
  if (e.pointerId !== joyTouchId) return;
  e.preventDefault();
  handleJoyMove(e.clientX, e.clientY);
});
function endJoyPointer(e) {
  if (e.pointerId !== joyTouchId) return;
  handleJoyEnd();
}
joystickZone.addEventListener('pointerup', endJoyPointer);
joystickZone.addEventListener('pointercancel', endJoyPointer);

// Eat button
document.getElementById('eat-btn').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  socket.emit('eat');
});

// Action hint (chop) tap — single pointerdown handler only, to avoid the
// double-fire (touchstart + synthetic click) that was hitting resources twice per tap.
actionHintEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  interactPressed = true;
});

// ==================== SEND INPUT TO SERVER ====================
let lastSentInput = '';
setInterval(() => {
  const payload = JSON.stringify(keyState);
  if (payload !== lastSentInput) {
    socket.emit('input', keyState);
    lastSentInput = payload;
  }
}, 50);

// ==================== INTERACTION (CHOP) ====================
const CHOP_RANGE = 90;

function findNearestResource() {
  const self = players[selfId];
  if (!self) return null;
  let nearest = null;
  let nearestDist = Infinity;
  for (const id in resources) {
    const r = resources[id];
    const d = Math.hypot(self.x - r.x, self.y - r.y);
    if (d < CHOP_RANGE && d < nearestDist) {
      nearest = r;
      nearestDist = d;
    }
  }
  return nearest;
}

function processInteraction() {
  const target = findNearestResource();
  if (target) {
    actionHintEl.classList.add('visible');
    actionHintEl.textContent = target.type === 'tree' ? 'Рубить' : 'Добывать камень';
    if (interactPressed) {
      socket.emit('chop', target.id);
    }
  } else {
    actionHintEl.classList.remove('visible');
  }
  interactPressed = false;
}

// ==================== CAMERA ====================
const camera = { x: 0, y: 0 };

// Smooths every player's visible position toward the latest server-authoritative
// x/y. Without this, positions visibly snap every ~50ms (server broadcast rate)
// instead of moving fluidly, which reads as stutter/glitching.
function updateRenderPositions() {
  for (const id in players) {
    const p = players[id];
    if (p.renderX === undefined) { p.renderX = p.x; p.renderY = p.y; }
    p.renderX += (p.x - p.renderX) * 0.3;
    p.renderY += (p.y - p.renderY) * 0.3;
  }
}

function updateCamera() {
  const self = players[selfId];
  if (!self) return;
  const targetX = self.renderX - canvas.width / 2;
  const targetY = self.renderY - canvas.height / 2;
  camera.x += (targetX - camera.x) * 0.2;
  camera.y += (targetY - camera.y) * 0.2;
}

// ==================== RENDERING HELPERS ====================
function drawBackground() {
  ctx.fillStyle = '#1c1713';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = '#2b221b';
  ctx.lineWidth = 1;

  const startX = Math.floor(camera.x / 60) * 60;
  const startY = Math.floor(camera.y / 60) * 60;

  for (let i = startX; i < camera.x + canvas.width + 60; i += 60) {
    for (let j = startY; j < camera.y + canvas.height + 60; j += 60) {
      const sx = i - camera.x;
      const sy = j - camera.y;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 4, sy - 8);
      ctx.moveTo(sx + 3, sy);
      ctx.lineTo(sx + 8, sy - 6);
      ctx.stroke();
    }
  }
}

function drawTree(r) {
  const sx = r.x - camera.x;
  const sy = r.y - camera.y;
  ctx.save();
  ctx.translate(sx, sy);

  ctx.beginPath();
  ctx.ellipse(0, 5, r.size * 0.4, r.size * 0.15, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fill();

  ctx.lineWidth = 3;
  ctx.strokeStyle = '#120d0a';
  ctx.fillStyle = '#2b1e16';

  ctx.beginPath();
  ctx.moveTo(-6, 0);
  ctx.lineTo(-4, -r.size * 0.6);
  ctx.lineTo(4, -r.size * 0.6);
  ctx.lineTo(6, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const damaged = r.hp < r.maxHp;
  ctx.fillStyle = damaged ? '#26361f' : '#1c2b1e';
  for (let i = 0; i < 3; i++) {
    const yOffset = -r.size * (0.5 + i * 0.35);
    const width = r.size * (0.8 - i * 0.15);
    const h = r.size * 0.5;
    ctx.beginPath();
    ctx.moveTo(0, yOffset - h);
    ctx.lineTo(width / 2, yOffset);
    ctx.lineTo(0, yOffset - h * 0.2);
    ctx.lineTo(-width / 2, yOffset);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawRock(r) {
  const sx = r.x - camera.x;
  const sy = r.y - camera.y;
  ctx.save();
  ctx.translate(sx, sy);

  ctx.beginPath();
  ctx.ellipse(0, r.size * 0.3, r.size * 0.5, r.size * 0.18, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fill();

  ctx.fillStyle = '#4a4640';
  ctx.strokeStyle = '#15130f';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(-r.size * 0.5, r.size * 0.25);
  ctx.lineTo(-r.size * 0.3, -r.size * 0.35);
  ctx.lineTo(r.size * 0.1, -r.size * 0.5);
  ctx.lineTo(r.size * 0.45, -r.size * 0.05);
  ctx.lineTo(r.size * 0.4, r.size * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

function drawCharacter(p, isSelf) {
  const sx = p.renderX - camera.x;
  const sy = p.renderY - camera.y;

  ctx.save();
  ctx.translate(sx, sy);
  if (!p.facingRight) ctx.scale(-1, 1);

  const t = (p._walkFrame || 0);
  const bounce = p.isMoving ? Math.sin(t * 0.2) * 3 : 0;
  const legAngle = p.isMoving ? Math.sin(t * 0.2) * 0.3 : 0;

  ctx.beginPath();
  ctx.ellipse(0, 2, 16, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fill();

  ctx.strokeStyle = '#0f0c0a';
  ctx.lineWidth = 2.5;

  ctx.save();
  ctx.rotate(legAngle);
  ctx.beginPath();
  ctx.moveTo(-4, -10);
  ctx.lineTo(-6, 2);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.rotate(-legAngle);
  ctx.beginPath();
  ctx.moveTo(4, -10);
  ctx.lineTo(6, 2);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = isSelf ? '#33291f' : '#2b2320';
  ctx.beginPath();
  ctx.moveTo(-8, -25 + bounce);
  ctx.lineTo(8, -25 + bounce);
  ctx.lineTo(10, -10 + bounce);
  ctx.lineTo(-10, -10 + bounce);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const headY = -42 + bounce;
  ctx.fillStyle = '#e8dcc8';
  ctx.beginPath();
  ctx.ellipse(0, headY, 15, 17, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#14100e';
  ctx.beginPath();
  ctx.moveTo(-16, headY - 5);
  ctx.quadraticCurveTo(-18, headY - 22, -8, headY - 24);
  ctx.quadraticCurveTo(0, headY - 28, 8, headY - 24);
  ctx.quadraticCurveTo(18, headY - 22, 16, headY - 5);
  ctx.quadraticCurveTo(8, headY - 12, 0, headY - 14);
  ctx.quadraticCurveTo(-8, headY - 12, -16, headY - 5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(4, headY + 1, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#0f0c0a';
  ctx.beginPath();
  ctx.arc(5, headY + 1, 2.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(-5, headY + 1, 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#0f0c0a';
  ctx.beginPath();
  ctx.arc(-4, headY + 1, 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(-2, headY + 10);
  ctx.lineTo(3, headY + 9);
  ctx.stroke();

  ctx.restore();

  // Nickname (not mirrored)
  ctx.save();
  ctx.font = '11px "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = isSelf ? '#d4af37' : '#b8ac95';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;
  const label = p.name || '???';
  ctx.strokeText(label, sx, sy - 68);
  ctx.fillText(label, sx, sy - 68);
  ctx.restore();

  // advance local walk animation frame
  p._walkFrame = p.isMoving ? t + 1 : 0;
}

// ==================== MAIN LOOP ====================
function isOnScreen(x, y, margin) {
  return x > camera.x - margin && x < camera.x + canvas.width + margin &&
         y > camera.y - margin && y < camera.y + canvas.height + margin;
}

function gameLoop() {
  processInteraction();
  updateRenderPositions();
  updateCamera();
  drawBackground();

  const renderList = [];
  for (const id in resources) {
    const r = resources[id];
    if (isOnScreen(r.x, r.y, 120)) renderList.push({ type: r.type, y: r.y, data: r });
  }
  for (const id in players) {
    const p = players[id];
    if (isOnScreen(p.renderX, p.renderY, 150)) renderList.push({ type: 'player', y: p.renderY, data: p, isSelf: id === selfId });
  }
  renderList.sort((a, b) => a.y - b.y);

  for (const obj of renderList) {
    if (obj.type === 'tree') drawTree(obj.data);
    else if (obj.type === 'rock') drawRock(obj.data);
    else if (obj.type === 'player') drawCharacter(obj.data, obj.isSelf);
  }

  updateBarsUI();
  updateResourceUI();

  requestAnimationFrame(gameLoop);
}

gameLoop();
