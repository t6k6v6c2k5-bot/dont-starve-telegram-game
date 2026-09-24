// ==================== TELEGRAM INIT ====================
console.log('[game.js] loaded, build: atmosphere-v1');
let tgUser = null;
try {
  if (window.Telegram && window.Telegram.WebApp) {
    const tg = window.Telegram.WebApp;
    tg.expand();
    tg.ready();
    // Stop the "swipe down to close" gesture from eating our vertical drags
    // (movement, camera) and closing the Mini App by accident.
    if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
    if (typeof tg.enableClosingConfirmation === 'function') tg.enableClosingConfirmation();
    if (tg.setHeaderColor) { try { tg.setHeaderColor('#0d0d11'); } catch (e) {} }
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

// Extra safety net for regular mobile browsers / older Telegram clients where
// disableVerticalSwipes isn't available: block pull-to-refresh / overscroll
// rubber-banding, which is what the OS reads as "swipe to dismiss".
document.addEventListener('touchmove', (e) => {
  if (e.touches.length === 1) e.preventDefault();
}, { passive: false });

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
let animals = {};    // animalId -> {id, type, x, y, hp, maxHp, facingRight, fleeing}
let campfires = {};  // campfireId -> {id, x, y, fuel, radius, lit}
let dayTime = 0.2;   // 0..1 fraction of the day/night cycle (server-authoritative)
let inventory = { wood: 0, stone: 0, meat: 0 };
let health = 100, hunger = 100;
const particles = []; // short-lived hit/chop effect particles

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
  animals = data.animals || {};
  campfires = data.campfires || {};
  dayTime = typeof data.dayTime === 'number' ? data.dayTime : dayTime;
  Object.values(players).forEach(initRenderPos);
  Object.values(animals).forEach(initRenderPos);
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

  if (data.animals) {
    for (const id in data.animals) {
      const incoming = data.animals[id];
      if (animals[id]) {
        Object.assign(animals[id], incoming);
      } else {
        animals[id] = incoming;
        initRenderPos(animals[id]);
      }
    }
    for (const id in animals) {
      if (!data.animals[id]) delete animals[id];
    }
  }

  if (data.campfires) {
    for (const id in data.campfires) {
      if (campfires[id]) Object.assign(campfires[id], data.campfires[id]);
      else campfires[id] = data.campfires[id];
    }
    for (const id in campfires) {
      if (!data.campfires[id]) delete campfires[id];
    }
  }

  if (typeof data.dayTime === 'number') dayTime = data.dayTime;

  updatePlayersListUI();
});

socket.on('campfire_added', (c) => { campfires[c.id] = c; playIgniteSound(); });

socket.on('resource_removed', (id) => {
  const r = resources[id];
  if (r) spawnHitParticles(r.x, r.y, '#c9a227', 10);
  delete resources[id];
});
socket.on('resource_added', (r) => { resources[r.id] = r; });
socket.on('resource_damaged', (data) => {
  if (resources[data.id]) {
    resources[data.id].hp = data.hp;
    spawnHitParticles(resources[data.id].x, resources[data.id].y, '#c9a227', 4);
  }
});
socket.on('animal_removed', (id) => {
  const a = animals[id];
  if (a) spawnHitParticles(a.x, a.y, '#8b2c2c', 10);
  delete animals[id];
});
socket.on('animal_added', (a) => { animals[a.id] = a; initRenderPos(a); });
socket.on('animal_damaged', (data) => {
  if (animals[data.id]) {
    animals[data.id].hp = data.hp;
    spawnHitParticles(animals[data.id].x, animals[data.id].y, '#8b2c2c', 4);
  }
});
socket.on('player_inventory', (data) => {
  if (data.id === selfId) {
    inventory = data.inventory;
    updateResourceUI();
  }
});

// ==================== HIT EFFECT PARTICLES ====================
function spawnHitParticles(x, y, color, count) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 40 + Math.random() * 90;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 30,
      life: 0.35 + Math.random() * 0.25,
      maxLife: 0.35 + Math.random() * 0.25,
      color,
      size: 2 + Math.random() * 2
    });
  }
}

function updateParticles(dtSec) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dtSec;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dtSec;
    p.y += p.vy * dtSec;
    p.vy += 220 * dtSec; // gravity
  }
}

function drawParticles() {
  for (const p of particles) {
    const alpha = Math.max(0, p.life / p.maxLife);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x - camera.x, p.y - camera.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ==================== AUDIO (procedural — no external sound files) ====================
let audioCtx = null;
let soundEnabled = true;
let ambientGain, ambientOsc, ambientLfo, ambientLfoGain;
let fireGain, fireSource;

function createNoiseBuffer(seconds) {
  const bufferSize = Math.floor(audioCtx.sampleRate * seconds);
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function ensureAudio() {
  if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) { return; }

  // Low wind/night drone with a slow "breathing" LFO — sets the mood without
  // needing any external audio asset files.
  ambientOsc = audioCtx.createOscillator();
  ambientOsc.type = 'sine';
  ambientOsc.frequency.value = 68;
  ambientGain = audioCtx.createGain();
  ambientGain.gain.value = 0.025;
  ambientLfo = audioCtx.createOscillator();
  ambientLfo.frequency.value = 0.06;
  ambientLfoGain = audioCtx.createGain();
  ambientLfoGain.gain.value = 0.015;
  ambientLfo.connect(ambientLfoGain);
  ambientLfoGain.connect(ambientGain.gain);
  ambientOsc.connect(ambientGain);
  ambientGain.connect(audioCtx.destination);
  ambientOsc.start();
  ambientLfo.start();

  // Campfire crackle — filtered looping noise, volume driven by proximity.
  const noiseBuffer = createNoiseBuffer(2);
  fireSource = audioCtx.createBufferSource();
  fireSource.buffer = noiseBuffer;
  fireSource.loop = true;
  const fireFilter = audioCtx.createBiquadFilter();
  fireFilter.type = 'bandpass';
  fireFilter.frequency.value = 1200;
  fireFilter.Q.value = 0.6;
  fireGain = audioCtx.createGain();
  fireGain.gain.value = 0;
  fireSource.connect(fireFilter);
  fireFilter.connect(fireGain);
  fireGain.connect(audioCtx.destination);
  fireSource.start();
}

function updateAudio(dtSec) {
  if (!audioCtx || !soundEnabled) return;
  const night = dayTime >= 0.65 || dayTime < 0.05;
  const targetAmbient = 0.022 + (night ? 0.05 : 0);
  ambientGain.gain.setTargetAtTime(targetAmbient, audioCtx.currentTime, 0.6);

  const self = players[selfId];
  let fireVol = 0;
  if (self) {
    const px = predicted.x !== undefined ? predicted.x : self.x;
    const py = predicted.y !== undefined ? predicted.y : self.y;
    for (const id in campfires) {
      const c = campfires[id];
      if (!c.lit) continue;
      const d = Math.hypot(px - c.x, py - c.y);
      const falloff = Math.max(0, 1 - d / (c.radius || 220));
      fireVol = Math.max(fireVol, falloff);
    }
  }
  fireGain.gain.setTargetAtTime(fireVol * 0.16, audioCtx.currentTime, 0.4);
}

function playBlip(freqStart, freqEnd, durationSec, type) {
  if (!audioCtx || !soundEnabled) return;
  const osc = audioCtx.createOscillator();
  osc.type = type || 'square';
  const g = audioCtx.createGain();
  const now = audioCtx.currentTime;
  osc.frequency.setValueAtTime(freqStart, now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), now + durationSec);
  g.gain.setValueAtTime(0.08, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + durationSec);
  osc.connect(g);
  g.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + durationSec);
}

function playHitSound() { playBlip(220, 90, 0.12, 'square'); }

function playIgniteSound() {
  if (!audioCtx || !soundEnabled) return;
  const noise = audioCtx.createBufferSource();
  noise.buffer = createNoiseBuffer(0.4);
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(300, audioCtx.currentTime);
  filter.frequency.exponentialRampToValueAtTime(2500, audioCtx.currentTime + 0.35);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.16, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
  noise.connect(filter);
  filter.connect(g);
  g.connect(audioCtx.destination);
  noise.start();
}

// Browsers require a user gesture before audio can start.
window.addEventListener('pointerdown', ensureAudio, { once: true });
window.addEventListener('keydown', ensureAudio, { once: true });

const soundBtnEl = document.getElementById('sound-btn');
soundBtnEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  ensureAudio();
  soundEnabled = !soundEnabled;
  soundBtnEl.textContent = soundEnabled ? '🔊' : '🔇';
  if (audioCtx && !soundEnabled) {
    ambientGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.2);
    fireGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.2);
  }
});

// ==================== UI HELPERS ====================
const healthFillEl = document.getElementById('health-fill');
const hungerFillEl = document.getElementById('hunger-fill');
const woodCountEl = document.getElementById('wood-count');
const stoneCountEl = document.getElementById('stone-count');
const meatCountEl = document.getElementById('meat-count');
const playersListBodyEl = document.getElementById('players-list-body');
const actionHintEl = document.getElementById('action-hint');

function updateBarsUI() {
  healthFillEl.style.width = Math.max(0, Math.min(100, health)) + '%';
  hungerFillEl.style.width = Math.max(0, Math.min(100, hunger)) + '%';
}

function updateResourceUI() {
  woodCountEl.textContent = inventory.wood || 0;
  stoneCountEl.textContent = inventory.stone || 0;
  if (meatCountEl) meatCountEl.textContent = inventory.meat || 0;
  if (invWoodEl) invWoodEl.textContent = inventory.wood || 0;
  if (invStoneEl) invStoneEl.textContent = inventory.stone || 0;
  if (invMeatEl) invMeatEl.textContent = inventory.meat || 0;
  if (craftCampfireBtn) craftCampfireBtn.disabled = (inventory.wood || 0) < 3;
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

// ==================== INVENTORY PANEL ====================
const inventoryOverlayEl = document.getElementById('inventory-overlay');
const invWoodEl = document.getElementById('inv-wood');
const invStoneEl = document.getElementById('inv-stone');
const invMeatEl = document.getElementById('inv-meat');
const craftCampfireBtn = document.getElementById('craft-campfire-btn');

function openInventory() { inventoryOverlayEl.classList.add('visible'); updateResourceUI(); }
function closeInventory() { inventoryOverlayEl.classList.remove('visible'); }
function toggleInventory() {
  inventoryOverlayEl.classList.contains('visible') ? closeInventory() : openInventory();
}

document.getElementById('resources').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  toggleInventory();
});
document.getElementById('inventory-close').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  closeInventory();
});
inventoryOverlayEl.addEventListener('pointerdown', (e) => {
  if (e.target === inventoryOverlayEl) closeInventory();
});
craftCampfireBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if ((inventory.wood || 0) < 3) return;
  socket.emit('place_campfire');
  closeInventory();
});

// ==================== CAMPFIRE CONTEXTUAL PANEL (sit / feed) ====================
const firePanelEl = document.getElementById('fire-panel');
const sitBtnEl = document.getElementById('sit-btn');
const feedBtnEl = document.getElementById('feed-btn');
const CAMPFIRE_INTERACT_RANGE = 110;
let nearestCampfireId = null;

function findNearestCampfire() {
  const self = players[selfId];
  if (!self) return null;
  const px = predicted.x !== undefined ? predicted.x : self.x;
  const py = predicted.y !== undefined ? predicted.y : self.y;
  let best = null, bestDist = Infinity;
  for (const id in campfires) {
    const c = campfires[id];
    const d = Math.hypot(px - c.x, py - c.y);
    if (d < CAMPFIRE_INTERACT_RANGE && d < bestDist) { best = c; bestDist = d; }
  }
  return best;
}

function updateFirePanel() {
  const c = findNearestCampfire();
  nearestCampfireId = c ? c.id : null;
  if (!c) {
    firePanelEl.classList.remove('visible');
    return;
  }
  firePanelEl.classList.add('visible');
  const self = players[selfId];
  sitBtnEl.textContent = (self && self.isSitting) ? 'Встать' : 'Сесть';
  feedBtnEl.disabled = (inventory.wood || 0) < 1;
}

sitBtnEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  socket.emit('toggle_sit');
});
feedBtnEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!nearestCampfireId) return;
  if ((inventory.wood || 0) < 1) return;
  socket.emit('feed_campfire', nearestCampfireId);
});

// ==================== CLOCK BADGE ====================
const clockIconEl = document.getElementById('clock-icon');
const clockTextEl = document.getElementById('clock-text');
function updateClockUI() {
  const night = dayTime >= 0.65 || dayTime < 0.02;
  if (dayTime < 0.08) { clockIconEl.textContent = '🌅'; clockTextEl.textContent = 'Рассвет'; }
  else if (dayTime < 0.55) { clockIconEl.textContent = '☀️'; clockTextEl.textContent = 'День'; }
  else if (dayTime < 0.65) { clockIconEl.textContent = '🌇'; clockTextEl.textContent = 'Закат'; }
  else { clockIconEl.textContent = '🌙'; clockTextEl.textContent = 'Ночь'; }
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
  if (e.code === 'KeyI') toggleInventory();
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

// ==================== INTERACTION (CHOP / HUNT) ====================
const CHOP_RANGE = 90;
const HUNT_RANGE = 100;

function findNearestInteractable() {
  const self = players[selfId];
  if (!self) return null;
  const px = predicted.x !== undefined ? predicted.x : self.x;
  const py = predicted.y !== undefined ? predicted.y : self.y;

  let best = null;
  let bestDist = Infinity;

  for (const id in resources) {
    const r = resources[id];
    const d = Math.hypot(px - r.x, py - r.y);
    if (d < CHOP_RANGE && d < bestDist) {
      best = { kind: 'resource', id: r.id, type: r.type, x: r.x, y: r.y };
      bestDist = d;
    }
  }
  for (const id in animals) {
    const a = animals[id];
    const d = Math.hypot(px - a.x, py - a.y);
    if (d < HUNT_RANGE && d < bestDist) {
      best = { kind: 'animal', id: a.id, type: a.type, x: a.x, y: a.y };
      bestDist = d;
    }
  }
  return best;
}

const HINT_TEXT = { tree: 'Рубить', rock: 'Добывать камень', rabbit: 'Охотиться' };

function processInteraction() {
  const target = findNearestInteractable();
  if (target) {
    actionHintEl.classList.add('visible');
    actionHintEl.textContent = HINT_TEXT[target.type] || 'Взаимодействовать';
    if (interactPressed) {
      socket.emit(target.kind === 'animal' ? 'hunt' : 'chop', target.id);
      triggerSwing(target.x, target.y);
    }
  } else {
    actionHintEl.classList.remove('visible');
  }
  interactPressed = false;
}

// Local-only visual swing: purely cosmetic, doesn't affect server outcome (server
// validates the actual hit independently), but gives immediate feedback on tap.
function triggerSwing(targetX, targetY) {
  const self = players[selfId];
  if (!self) return;
  self._swingUntil = performance.now() + 260;
  const px = predicted.x !== undefined ? predicted.x : self.x;
  self.facingRight = targetX >= px;
}

// ==================== CLIENT-SIDE PREDICTION (self only) ====================
// Server is still authoritative (it validates/clamps everything), but waiting for a
// full round-trip (input -> server tick -> broadcast) before moving the LOCAL
// character is what causes the "stutter/teleport, feels like 1 FPS" symptom on a
// real mobile network (Telegram WebView included) — every step of movement was
// gated behind network latency. Predicting locally makes our own movement feel
// instant; we softly reconcile toward the server's authoritative x/y to avoid drift.
const PLAYER_SPEED_PX_PER_SEC = 120; // must match server: PLAYER_SPEED(4) * TICK_RATE(30)
const predicted = { x: undefined, y: undefined };

function updateSelfPrediction(dtSec) {
  const self = players[selfId];
  if (!self) return;
  if (predicted.x === undefined) {
    predicted.x = self.x;
    predicted.y = self.y;
  }

  let dx = 0, dy = 0;
  if (keyState.up) dy -= 1;
  if (keyState.down) dy += 1;
  if (keyState.left) dx -= 1;
  if (keyState.right) dx += 1;
  if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }

  predicted.x += dx * PLAYER_SPEED_PX_PER_SEC * dtSec;
  predicted.y += dy * PLAYER_SPEED_PX_PER_SEC * dtSec;
  predicted.x = Math.max(20, Math.min(world.width - 20, predicted.x));
  predicted.y = Math.max(20, Math.min(world.height - 20, predicted.y));

  // Soft correction toward the server's authoritative position (fixes drift from
  // packet loss / clock differences without causing a visible snap).
  const pull = 1 - Math.exp(-4 * dtSec);
  predicted.x += (self.x - predicted.x) * pull;
  predicted.y += (self.y - predicted.y) * pull;
}

// ==================== CAMERA ====================
const camera = { x: 0, y: 0 };

// Smooths OTHER players' visible position toward their latest server-authoritative
// x/y (we have no input to predict them from). Frame-rate independent: the
// convergence speed is based on real elapsed time (dtSec), not on how many
// rendered frames happened — a fixed per-frame factor would look wrong on a
// device/WebView that isn't rendering at a steady 60fps.
function updateRenderPositions(dtSec) {
  for (const id in players) {
    const p = players[id];
    if (id === selfId) {
      p.renderX = predicted.x;
      p.renderY = predicted.y;
      continue;
    }
    if (p.renderX === undefined) { p.renderX = p.x; p.renderY = p.y; }
    const factor = 1 - Math.exp(-12 * dtSec);
    p.renderX += (p.x - p.renderX) * factor;
    p.renderY += (p.y - p.renderY) * factor;
  }
  for (const id in animals) {
    const a = animals[id];
    if (a.renderX === undefined) { a.renderX = a.x; a.renderY = a.y; }
    const factor = 1 - Math.exp(-12 * dtSec);
    a.renderX += (a.x - a.renderX) * factor;
    a.renderY += (a.y - a.renderY) * factor;
  }
}

function updateCamera(dtSec) {
  const self = players[selfId];
  if (!self) return;
  const targetX = self.renderX - canvas.width / 2;
  const targetY = self.renderY - canvas.height / 2;
  const factor = 1 - Math.exp(-10 * dtSec);
  camera.x += (targetX - camera.x) * factor;
  camera.y += (targetY - camera.y) * factor;
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

function drawRabbit(a) {
  const sx = a.renderX - camera.x;
  const sy = a.renderY - camera.y;
  ctx.save();
  ctx.translate(sx, sy);
  if (!a.facingRight) ctx.scale(-1, 1);

  const t = (a._hopFrame || 0);
  const moving = a._prevX !== undefined && Math.abs(a.renderX - a._prevX) > 0.05;
  const hop = moving ? Math.abs(Math.sin(t * 0.35)) * 6 : 0;
  a._prevX = a.renderX;
  a._hopFrame = moving ? t + 1 : 0;

  // shadow
  ctx.beginPath();
  ctx.ellipse(0, 2, 9, 3.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fill();

  ctx.strokeStyle = '#0f0c0a';
  ctx.lineWidth = 1.6;
  ctx.fillStyle = '#3a332a';

  // body
  ctx.beginPath();
  ctx.ellipse(0, -6 - hop, 9, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // head
  ctx.beginPath();
  ctx.ellipse(7, -9 - hop, 5, 4.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // ears
  ctx.beginPath();
  ctx.moveTo(6, -12 - hop);
  ctx.quadraticCurveTo(5, -22 - hop, 8, -23 - hop);
  ctx.quadraticCurveTo(10, -14 - hop, 9, -12 - hop);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(9, -12 - hop);
  ctx.quadraticCurveTo(9, -21 - hop, 12, -21 - hop);
  ctx.quadraticCurveTo(12, -13 - hop, 11, -11 - hop);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // tail
  ctx.beginPath();
  ctx.arc(-8, -6 - hop, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = '#c9c1b2';
  ctx.fill();
  ctx.stroke();

  // eye
  ctx.fillStyle = '#0f0c0a';
  ctx.beginPath();
  ctx.arc(9, -10 - hop, 1, 0, Math.PI * 2);
  ctx.fill();

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

  // Tool/arm swing — brief cosmetic feedback on chop/hunt tap.
  const swingActive = p._swingUntil && performance.now() < p._swingUntil;
  if (swingActive) {
    const remaining = (p._swingUntil - performance.now()) / 260; // 1 -> 0
    const swingAngle = Math.sin((1 - remaining) * Math.PI) * 1.3; // 0 -> up -> 0
    ctx.save();
    ctx.translate(9, -22 + bounce);
    ctx.rotate(-0.6 + swingAngle);
    ctx.strokeStyle = '#5a4a36';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -20);
    ctx.stroke();
    ctx.restore();
  }

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

function gameLoop(timestamp) {
  if (lastFrameTime === undefined) lastFrameTime = timestamp;
  let dtSec = (timestamp - lastFrameTime) / 1000;
  lastFrameTime = timestamp;
  // Guard against huge gaps (tab was backgrounded/throttled, device hiccup) so a
  // single stale frame doesn't cause a giant predicted-movement jump.
  dtSec = Math.max(0, Math.min(dtSec, 0.1));

  processInteraction();
  updateSelfPrediction(dtSec);
  updateRenderPositions(dtSec);
  updateCamera(dtSec);
  updateParticles(dtSec);
  drawBackground();

  const renderList = [];
  for (const id in resources) {
    const r = resources[id];
    if (isOnScreen(r.x, r.y, 120)) renderList.push({ type: r.type, y: r.y, data: r });
  }
  for (const id in animals) {
    const a = animals[id];
    if (isOnScreen(a.renderX, a.renderY, 80)) renderList.push({ type: 'animal', y: a.renderY, data: a });
  }
  for (const id in players) {
    const p = players[id];
    if (isOnScreen(p.renderX, p.renderY, 150)) renderList.push({ type: 'player', y: p.renderY, data: p, isSelf: id === selfId });
  }
  renderList.sort((a, b) => a.y - b.y);

  for (const obj of renderList) {
    if (obj.type === 'tree') drawTree(obj.data);
    else if (obj.type === 'rock') drawRock(obj.data);
    else if (obj.type === 'animal') drawRabbit(obj.data);
    else if (obj.type === 'player') drawCharacter(obj.data, obj.isSelf);
  }

  drawParticles();

  updateBarsUI();
  updateResourceUI();

  requestAnimationFrame(gameLoop);
}

let lastFrameTime;
requestAnimationFrame(gameLoop);
