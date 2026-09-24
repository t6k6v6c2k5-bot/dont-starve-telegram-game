// ==================== VISIBLE ERROR REPORTING ====================
// If anything throws during setup, show it directly on screen — on a phone
// there's usually no easy way to open devtools, so a silent crash otherwise
// just looks like "I press Play and nothing happens" with no way to diagnose it.
window.addEventListener('error', (e) => {
  console.error('[game.js] uncaught error:', e.error || e.message);
  showFatalError((e.error && e.error.message) || e.message || 'Неизвестная ошибка');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[game.js] unhandled rejection:', e.reason);
  showFatalError((e.reason && e.reason.message) || String(e.reason) || 'Неизвестная ошибка');
});
function showFatalError(msg) {
  let el = document.getElementById('fatal-error-box');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatal-error-box';
    el.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:9999;' +
      'background:rgba(120,20,20,0.95);color:#fff;font:11px monospace;' +
      'padding:10px;border-radius:6px;max-height:35vh;overflow:auto;white-space:pre-wrap;';
    document.body.appendChild(el);
  }
  el.textContent = 'Ошибка скрипта: ' + msg;
}

// ==================== TELEGRAM INIT ====================
console.log('[game.js] loaded, build: nocache-diag-v1');
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
  if (typeof resizeNightCanvas === 'function') resizeNightCanvas();
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
let monsters = {};   // monsterId -> {id, x, y, hp, maxHp, facingRight, attacking}
let dayTime = 0.2;   // 0..1 fraction of the day/night cycle (server-authoritative)
let dayNumber = 1;
let inventory = { wood: 0, stone: 0, meat: 0 };
let health = 100, hunger = 100;
let hasJoined = false;
let hasSpear = false;
const particles = []; // short-lived hit/chop effect particles

// Joining happens when the player presses "Играть" on the start menu (see
// START MENU section below), not automatically on connect — this also gives
// us the required user gesture to unlock audio.
function joinGame(name) {
  if (hasJoined) return;
  hasJoined = true;
  setStartStatus('Подключение...');
  socket.emit('join', { userId: myUserId, name: name || myName });
  // If the server never answers (dead/misconfigured deploy, cold-start delay,
  // dropped connection), tell the player instead of leaving them stuck on a
  // screen that looks alive but silently does nothing.
  clearTimeout(joinTimeoutHandle);
  joinTimeoutHandle = setTimeout(() => {
    if (selfId === null) {
      setStartStatus('Не удалось подключиться к серверу. Проверьте соединение и нажмите ещё раз.', true);
      hasJoined = false;
      startOverlayEl.classList.remove('hidden');
      startPlayBtn.disabled = false;
    }
  }, 7000);
}
let joinTimeoutHandle = null;

socket.on('connect', () => setStartStatus(''));
socket.on('connect_error', () => setStartStatus('Ошибка подключения к серверу...', true));
socket.on('disconnect', () => setStartStatus('Соединение потеряно. Переподключение...', true));

function initRenderPos(p) {
  // renderX/renderY are the smoothed on-screen position; x/y stay server-authoritative.
  p.renderX = p.x;
  p.renderY = p.y;
}

socket.on('init', (data) => {
  clearTimeout(joinTimeoutHandle);
  selfId = data.selfId;
  world = data.world;
  players = data.players;
  resources = data.resources;
  animals = data.animals || {};
  campfires = data.campfires || {};
  monsters = data.monsters || {};
  dayTime = typeof data.dayTime === 'number' ? data.dayTime : dayTime;
  dayNumber = typeof data.dayNumber === 'number' ? data.dayNumber : dayNumber;
  Object.values(players).forEach(initRenderPos);
  Object.values(animals).forEach(initRenderPos);
  Object.values(monsters).forEach(initRenderPos);
  const self = players[selfId];
  if (self) {
    inventory = self.inventory;
    health = self.health;
    hunger = self.hunger;
    hasSpear = !!self.hasSpear;
  }
  setStartStatus('');
  startOverlayEl.classList.add('hidden');
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

  if (data.monsters) {
    for (const id in data.monsters) {
      const incoming = data.monsters[id];
      if (monsters[id]) {
        Object.assign(monsters[id], incoming);
      } else {
        monsters[id] = incoming;
        initRenderPos(monsters[id]);
      }
    }
    for (const id in monsters) {
      if (!data.monsters[id]) delete monsters[id];
    }
  }

  if (typeof data.dayTime === 'number') dayTime = data.dayTime;
  if (typeof data.dayNumber === 'number') dayNumber = data.dayNumber;

  updatePlayersListUI();
});

socket.on('campfire_added', (c) => { campfires[c.id] = c; playIgniteSound(); });

socket.on('monster_added', (m) => { monsters[m.id] = m; initRenderPos(m); });
socket.on('monster_removed', (id) => {
  const m = monsters[id];
  if (m) spawnHitParticles(m.x, m.y, '#6b2fb3', 10);
  delete monsters[id];
});
socket.on('monster_damaged', (data) => {
  if (monsters[data.id]) {
    monsters[data.id].hp = data.hp;
    spawnHitParticles(monsters[data.id].x, monsters[data.id].y, '#6b2fb3', 4);
  }
});

socket.on('night_wave_start', (data) => showWaveBanner(`🌙 Ночь ${data.day} — волна теней! (${data.count})`, '#8b2c2c'));
socket.on('wave_end', () => showWaveBanner('☀️ Ночь пережита', '#7c8b2c'));

socket.on('spear_crafted', () => { hasSpear = true; });

socket.on('player_died', () => {
  showDeathOverlay();
});

socket.on('chat', (msg) => {
  appendChatMessage(msg);
  if (players[msg.id]) {
    players[msg.id]._chatBubble = { text: msg.text, until: performance.now() + 4500 };
  }
});

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
function playDeathSound() { playBlip(160, 40, 0.5, 'sawtooth'); }

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
function toggleSound() {
  ensureAudio();
  soundEnabled = !soundEnabled;
  const label = soundEnabled ? '🔊' : '🔇';
  soundBtnEl.textContent = label;
  const menuBtn = document.getElementById('menu-sound-btn');
  if (menuBtn) menuBtn.textContent = `${label} Звук: ${soundEnabled ? 'вкл' : 'выкл'}`;
  if (audioCtx && !soundEnabled) {
    ambientGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.2);
    fireGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.2);
  }
}
soundBtnEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  toggleSound();
});

// ==================== UI HELPERS ====================
const healthFillEl = document.getElementById('health-fill');
const hungerFillEl = document.getElementById('hunger-fill');
const woodCountEl = document.getElementById('wood-count');
const stoneCountEl = document.getElementById('stone-count');
const meatCountEl = document.getElementById('meat-count');
const menuPlayersBodyEl = document.getElementById('menu-players-body');
const actionHintEl = document.getElementById('action-hint');
const dayNumberEl = document.getElementById('day-number');
const hiddenBadgeEl = document.getElementById('hidden-badge');
const HIDE_RADIUS = 45; // must match server — standing this close to a tree hides you from monsters

function isNearTree(x, y) {
  for (const id in resources) {
    const r = resources[id];
    if (r.type === 'tree' && Math.hypot(r.x - x, r.y - y) < HIDE_RADIUS) return true;
  }
  return false;
}

function updateBarsUI() {
  healthFillEl.style.width = Math.max(0, Math.min(100, health)) + '%';
  hungerFillEl.style.width = Math.max(0, Math.min(100, hunger)) + '%';

  if (hiddenBadgeEl) {
    const self = players[selfId];
    const night = dayTime >= 0.65 || dayTime < 0.05;
    const px = predicted.x !== undefined ? predicted.x : (self ? self.x : null);
    const py = predicted.y !== undefined ? predicted.y : (self ? self.y : null);
    const hidden = night && self && px !== null && isNearTree(px, py);
    hiddenBadgeEl.style.display = hidden ? 'block' : 'none';
  }
}

function updateResourceUI() {
  woodCountEl.textContent = inventory.wood || 0;
  stoneCountEl.textContent = inventory.stone || 0;
  if (meatCountEl) meatCountEl.textContent = inventory.meat || 0;
  if (invWoodEl) invWoodEl.textContent = inventory.wood || 0;
  if (invStoneEl) invStoneEl.textContent = inventory.stone || 0;
  if (invMeatEl) invMeatEl.textContent = inventory.meat || 0;
  if (craftCampfireBtn) craftCampfireBtn.disabled = (inventory.wood || 0) < 3;
  if (craftSpearBtn) {
    if (hasSpear) {
      craftSpearBtn.textContent = '🗡️ Копьё изготовлено';
      craftSpearBtn.disabled = true;
    } else {
      craftSpearBtn.textContent = '🗡️ Копьё (2 дерева, 1 камень)';
      craftSpearBtn.disabled = (inventory.wood || 0) < 2 || (inventory.stone || 0) < 1;
    }
  }
}

function updatePlayersListUI() {
  if (!menuPlayersBodyEl) return;
  const names = Object.values(players).map(p => {
    const deaths = p.deaths ? ` (погибал: ${p.deaths})` : '';
    return (p.name || '???') + deaths;
  });
  menuPlayersBodyEl.innerHTML = names.map(n => `<div>• ${escapeHtml(n)}</div>`).join('') || '<div>—</div>';
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
const craftSpearBtn = document.getElementById('craft-spear-btn');

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
craftSpearBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (hasSpear) return;
  if ((inventory.wood || 0) < 2 || (inventory.stone || 0) < 1) return;
  socket.emit('craft_spear');
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
let lastClockLabel = '';
function updateClockUI() {
  let icon, text;
  if (dayTime < 0.08) { icon = '🌅'; text = 'Рассвет'; }
  else if (dayTime < 0.55) { icon = '☀️'; text = 'День'; }
  else if (dayTime < 0.65) { icon = '🌇'; text = 'Закат'; }
  else { icon = '🌙'; text = 'Ночь'; }
  if (text !== lastClockLabel) {
    clockIconEl.textContent = icon;
    clockTextEl.textContent = text;
    lastClockLabel = text;
  }
  if (dayNumberEl) dayNumberEl.textContent = `· День ${dayNumber}`;
}

// ==================== START MENU ====================
const startOverlayEl = document.getElementById('start-overlay');
const startNameInput = document.getElementById('start-name-input');
const startPlayBtn = document.getElementById('start-play-btn');
const startStatusEl = document.getElementById('start-status');

function setStartStatus(text, isError) {
  if (!startStatusEl) return;
  startStatusEl.textContent = text || '';
  startStatusEl.style.color = isError ? '#e07a5f' : '#8c8275';
}

if (tgUser && tgUser.name) {
  startNameInput.value = tgUser.name;
  startNameInput.disabled = true; // Telegram identity is already known
} else {
  startNameInput.value = myName;
}

function startGame() {
  ensureAudio();
  startPlayBtn.disabled = true;
  const chosenName = startNameInput.value.trim().slice(0, 24) || myName;
  joinGame(chosenName);
  // The overlay is hidden once 'init' actually arrives (see socket.on('init', ...)
  // below) — hiding it immediately here would leave the player staring at an
  // empty world with no feedback if the connection silently failed.
}

startPlayBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  startGame();
});
startNameInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.code === 'Enter') startGame();
});

// ==================== DEATH OVERLAY ====================
const deathOverlayEl = document.getElementById('death-overlay');
let deathHideTimer = null;
function showDeathOverlay() {
  deathOverlayEl.classList.add('visible');
  playDeathSound();
  clearTimeout(deathHideTimer);
  deathHideTimer = setTimeout(() => deathOverlayEl.classList.remove('visible'), 2200);
}

// ==================== WAVE BANNER ====================
const waveBannerEl = document.getElementById('wave-banner');
let waveBannerHideTimer = null;
function showWaveBanner(text, color) {
  waveBannerEl.textContent = text;
  waveBannerEl.style.color = color || '#e0d7c6';
  waveBannerEl.classList.add('visible');
  clearTimeout(waveBannerHideTimer);
  waveBannerHideTimer = setTimeout(() => waveBannerEl.classList.remove('visible'), 4200);
}

// ==================== PAUSE / MENU PANEL ====================
const menuOverlayEl = document.getElementById('menu-overlay');
const menuBtnEl = document.getElementById('menu-btn');
const menuCloseEl = document.getElementById('menu-close');
const menuSoundBtnEl = document.getElementById('menu-sound-btn');
const menuLocateBtnEl = document.getElementById('menu-locate-btn');

menuBtnEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  menuOverlayEl.classList.add('visible');
  updatePlayersListUI();
});
menuCloseEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  menuOverlayEl.classList.remove('visible');
});
menuOverlayEl.addEventListener('pointerdown', (e) => {
  if (e.target === menuOverlayEl) menuOverlayEl.classList.remove('visible');
});
menuSoundBtnEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  toggleSound();
});

// Locate & briefly highlight the nearest other player, both as a toast and a
// pulsing dot on the minimap — this is the "find each other" tool.
let locateBeacon = null; // { id, until }
menuLocateBtnEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const self = players[selfId];
  if (!self) return;
  let nearest = null, nearestDist = Infinity;
  for (const id in players) {
    if (id === selfId) continue;
    const p = players[id];
    const d = Math.hypot(p.x - self.x, p.y - self.y);
    if (d < nearestDist) { nearestDist = d; nearest = p; }
  }
  if (!nearest) {
    menuLocateBtnEl.textContent = '🧭 Больше никого нет рядом';
  } else {
    menuLocateBtnEl.textContent = `🧭 ${nearest.name}, ~${Math.round(nearestDist)}м`;
    locateBeacon = { id: nearest.id, until: performance.now() + 4000 };
  }
  setTimeout(() => { menuLocateBtnEl.textContent = '🧭 Найти ближайшего игрока'; }, 3000);
});

// ==================== CHAT ====================
const chatPanelEl = document.getElementById('chat-panel');
const chatLogEl = document.getElementById('chat-log');
const chatInputEl = document.getElementById('chat-input');
const chatSendBtnEl = document.getElementById('chat-send-btn');
const chatToggleBtnEl = document.getElementById('chat-toggle-btn');

function toggleChat() {
  chatPanelEl.classList.toggle('visible');
  if (chatPanelEl.classList.contains('visible')) chatInputEl.focus();
}
chatToggleBtnEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  toggleChat();
});

function appendChatMessage(msg) {
  const row = document.createElement('div');
  row.className = 'msg';
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = (msg.id === selfId ? 'Вы' : msg.name) + ': ';
  row.appendChild(who);
  row.appendChild(document.createTextNode(msg.text));
  chatLogEl.appendChild(row);
  while (chatLogEl.children.length > 60) chatLogEl.removeChild(chatLogEl.firstChild);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function sendChat() {
  const text = chatInputEl.value.trim();
  if (!text) return;
  socket.emit('chat', text);
  chatInputEl.value = '';
}
chatSendBtnEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  sendChat();
});
chatInputEl.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') { e.preventDefault(); sendChat(); }
  e.stopPropagation(); // don't let WASD-style keys leak into movement while typing
});

// ==================== MINIMAP ====================
const minimapEl = document.getElementById('minimap');
const minimapCtx = minimapEl.getContext('2d');
function drawMinimap() {
  const w = minimapEl.width, h = minimapEl.height;
  minimapCtx.clearRect(0, 0, w, h);
  minimapCtx.fillStyle = 'rgba(20,17,13,0.9)';
  minimapCtx.fillRect(0, 0, w, h);

  const sx = w / world.width, sy = h / world.height;

  // campfires as small orange dots
  for (const id in campfires) {
    const c = campfires[id];
    minimapCtx.fillStyle = c.lit ? '#ff8a3d' : '#4a4640';
    minimapCtx.beginPath();
    minimapCtx.arc(c.x * sx, c.y * sy, 2, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  // monsters as small pulsing purple/red dots so players can see a wave coming
  const nowMs = performance.now();
  for (const id in monsters) {
    const m = monsters[id];
    minimapCtx.fillStyle = m.attacking ? '#ff3b3b' : '#8b5fc9';
    minimapCtx.beginPath();
    minimapCtx.arc(m.x * sx, m.y * sy, 1.8 + Math.sin(nowMs * 0.01) * 0.6, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  const now = performance.now();
  for (const id in players) {
    const p = players[id];
    const isSelf = id === selfId;
    const isBeacon = locateBeacon && locateBeacon.id === id && now < locateBeacon.until;
    const mx = p.x * sx, my = p.y * sy;

    if (isBeacon) {
      const pulse = 4 + Math.sin(now * 0.02) * 2;
      minimapCtx.strokeStyle = '#ff4d4d';
      minimapCtx.lineWidth = 1.5;
      minimapCtx.beginPath();
      minimapCtx.arc(mx, my, 6 + pulse, 0, Math.PI * 2);
      minimapCtx.stroke();
    }

    minimapCtx.fillStyle = isSelf ? '#d4af37' : '#e0d7c6';
    minimapCtx.beginPath();
    minimapCtx.arc(mx, my, isSelf ? 3 : 2.2, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  // viewport rectangle
  minimapCtx.strokeStyle = 'rgba(212,175,55,0.5)';
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(camera.x * sx, camera.y * sy, canvas.width * sx, canvas.height * sy);
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

// ==================== INTERACTION (CHOP / HUNT / ATTACK) ====================
const CHOP_RANGE = 90;
const HUNT_RANGE = 100;
const MONSTER_ATTACK_UI_RANGE = 90;

function findNearestInteractable() {
  const self = players[selfId];
  if (!self) return null;
  const px = predicted.x !== undefined ? predicted.x : self.x;
  const py = predicted.y !== undefined ? predicted.y : self.y;

  let best = null;
  let bestDist = Infinity;

  // Monsters take priority when in range — you want to fight, not accidentally chop a tree.
  for (const id in monsters) {
    const m = monsters[id];
    const d = Math.hypot(px - m.x, py - m.y);
    if (d < MONSTER_ATTACK_UI_RANGE && d < bestDist) {
      best = { kind: 'monster', id: m.id, type: 'monster', x: m.x, y: m.y };
      bestDist = d;
    }
  }
  if (best) return best;

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

const HINT_TEXT = { tree: 'Рубить', rock: 'Добывать камень', rabbit: 'Охотиться', monster: 'Атаковать' };
const INTERACT_EVENT = { animal: 'hunt', monster: 'attack_monster' };

function processInteraction() {
  const target = findNearestInteractable();
  if (target) {
    actionHintEl.classList.add('visible');
    actionHintEl.textContent = HINT_TEXT[target.type] || 'Взаимодействовать';
    if (interactPressed) {
      socket.emit(INTERACT_EVENT[target.kind] || 'chop', target.id);
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
  playHitSound();
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
  for (const id in monsters) {
    const m = monsters[id];
    if (m.renderX === undefined) { m.renderX = m.x; m.renderY = m.y; }
    const factor = 1 - Math.exp(-12 * dtSec);
    m.renderX += (m.x - m.renderX) * factor;
    m.renderY += (m.y - m.renderY) * factor;
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
function hashXY(x, y) {
  const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

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
      const h = hashXY(i, j);

      if (h < 0.06) {
        // tiny flower cluster
        const petalColor = h < 0.02 ? '#8a7a3a' : (h < 0.04 ? '#7a3a3a' : '#5a5a7a');
        ctx.fillStyle = petalColor;
        for (let k = 0; k < 3; k++) {
          const ang = (k / 3) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(sx + Math.cos(ang) * 3, sy + Math.sin(ang) * 3, 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = '#3a2a1a';
        ctx.beginPath();
        ctx.arc(sx, sy, 1.2, 0, Math.PI * 2);
        ctx.fill();
      } else if (h < 0.13) {
        // small pebble
        ctx.fillStyle = '#332b22';
        ctx.beginPath();
        ctx.ellipse(sx, sy, 3, 2, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // default grass hatching
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + 4, sy - 8);
        ctx.moveTo(sx + 3, sy);
        ctx.lineTo(sx + 8, sy - 6);
        ctx.stroke();
      }
    }
  }
}

// ==================== FIREFLIES (night-only atmosphere) ====================
const fireflies = [];
for (let i = 0; i < 40; i++) {
  fireflies.push({
    ox: (Math.random() - 0.5) * 2600,
    oy: (Math.random() - 0.5) * 2600,
    phase: Math.random() * Math.PI * 2,
    speed: 0.3 + Math.random() * 0.5,
    radius: 20 + Math.random() * 40
  });
}

function drawFireflies(nightAlpha) {
  if (nightAlpha < 0.15) return;
  const self = players[selfId];
  const centerX = self ? self.renderX : camera.x + canvas.width / 2;
  const centerY = self ? self.renderY : camera.y + canvas.height / 2;
  const now = performance.now() * 0.001;

  ctx.save();
  for (const f of fireflies) {
    const wx = centerX + f.ox + Math.cos(now * f.speed + f.phase) * f.radius;
    const wy = centerY + f.oy + Math.sin(now * f.speed * 0.8 + f.phase) * f.radius;
    const sx = wx - camera.x, sy = wy - camera.y;
    if (sx < -20 || sx > canvas.width + 20 || sy < -20 || sy > canvas.height + 20) continue;

    const twinkle = 0.4 + 0.6 * Math.abs(Math.sin(now * 2 + f.phase * 3));
    const alpha = Math.min(1, (nightAlpha - 0.1) / 0.7) * twinkle;
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, 8);
    grad.addColorStop(0, `rgba(200,255,140,${alpha})`);
    grad.addColorStop(1, 'rgba(200,255,140,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sx, sy, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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

function drawCampfire(c) {
  const sx = c.x - camera.x;
  const sy = c.y - camera.y;
  ctx.save();
  ctx.translate(sx, sy);

  if (c.lit) {
    const glowR = 75;
    const grad = ctx.createRadialGradient(0, -6, 4, 0, -6, glowR);
    grad.addColorStop(0, 'rgba(255,170,60,0.35)');
    grad.addColorStop(1, 'rgba(255,170,60,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, -6, glowR, 0, Math.PI * 2);
    ctx.fill();
  }

  // shadow
  ctx.beginPath();
  ctx.ellipse(0, 4, 20, 7, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fill();

  // crossed logs
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#3a2a1a';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(-15, 6);
  ctx.lineTo(11, -7);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(15, 6);
  ctx.lineTo(-11, -7);
  ctx.stroke();
  ctx.strokeStyle = '#1c140d';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-15, 6);
  ctx.lineTo(11, -7);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(15, 6);
  ctx.lineTo(-11, -7);
  ctx.stroke();

  if (c.lit) {
    const now = performance.now();
    const flicker = Math.sin(now * 0.02) * 2 + Math.sin(now * 0.037) * 1.5;
    ctx.fillStyle = '#ffcf5c';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.quadraticCurveTo(9 + flicker, -18, 0, -34 + flicker);
    ctx.quadraticCurveTo(-9 - flicker, -18, 0, -6);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#ff8a3d';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.quadraticCurveTo(5 + flicker * 0.6, -14, 0, -24 + flicker * 0.6);
    ctx.quadraticCurveTo(-5 - flicker * 0.6, -14, 0, -6);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = '#4a4640';
    ctx.beginPath();
    ctx.ellipse(0, -3, 10, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  // low-fuel warning ring so players know to feed it before it dies out
  if (c.lit && c.fuel < 25) {
    ctx.save();
    ctx.globalAlpha = 0.5 + Math.sin(performance.now() * 0.01) * 0.3;
    ctx.strokeStyle = '#ff6b4a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy - 6, 26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// ==================== DAY/NIGHT OVERLAY ====================
const nightCanvas = document.createElement('canvas');
const nightCtx = nightCanvas.getContext('2d');
function resizeNightCanvas() {
  nightCanvas.width = canvas.width;
  nightCanvas.height = canvas.height;
}
resizeNightCanvas();

const stars = [];
for (let i = 0; i < 80; i++) {
  stars.push({ x: Math.random(), y: Math.random(), phase: Math.random() * Math.PI * 2, speed: 0.4 + Math.random() * 1.4 });
}

function computeNightAlpha(t) {
  const MAX_ALPHA = 0.8;
  if (t < 0.08) return MAX_ALPHA * (1 - t / 0.08);         // dawn: fading out
  if (t < 0.55) return 0;                                   // day
  if (t < 0.65) return MAX_ALPHA * ((t - 0.55) / 0.10);     // dusk: fading in
  return MAX_ALPHA;                                          // night
}

function drawNightOverlay(nightAlpha) {
  if (nightAlpha <= 0.01) return;

  nightCtx.clearRect(0, 0, nightCanvas.width, nightCanvas.height);
  nightCtx.fillStyle = `rgba(6,8,20,${nightAlpha})`;
  nightCtx.fillRect(0, 0, nightCanvas.width, nightCanvas.height);

  nightCtx.globalCompositeOperation = 'destination-out';

  // Faint personal glow so you're never fully blind, even without a fire —
  // our own small twist on Don't Starve's harsher "the dark WILL get you".
  const self = players[selfId];
  if (self) {
    const sx = self.renderX - camera.x;
    const sy = self.renderY - camera.y;
    const grad = nightCtx.createRadialGradient(sx, sy, 0, sx, sy, 70);
    grad.addColorStop(0, 'rgba(0,0,0,0.5)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    nightCtx.fillStyle = grad;
    nightCtx.beginPath();
    nightCtx.arc(sx, sy, 70, 0, Math.PI * 2);
    nightCtx.fill();
  }

  for (const id in campfires) {
    const c = campfires[id];
    if (!c.lit) continue;
    const sx = c.x - camera.x;
    const sy = c.y - camera.y;
    const r = c.radius || 220;
    const grad = nightCtx.createRadialGradient(sx, sy - 10, 0, sx, sy - 10, r);
    grad.addColorStop(0, 'rgba(0,0,0,1)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.7)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    nightCtx.fillStyle = grad;
    nightCtx.beginPath();
    nightCtx.arc(sx, sy - 10, r, 0, Math.PI * 2);
    nightCtx.fill();
  }

  nightCtx.globalCompositeOperation = 'source-over';
  ctx.drawImage(nightCanvas, 0, 0);

  // Stars + moon rendered on top of the darkness for visibility.
  ctx.save();
  const skyAlpha = Math.min(1, nightAlpha / 0.8);
  const moonX = canvas.width * 0.85, moonY = canvas.height * 0.15;
  ctx.globalAlpha = skyAlpha;
  ctx.fillStyle = '#e8e2cf';
  ctx.beginPath();
  ctx.arc(moonX, moonY, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(13,13,17,1)';
  ctx.beginPath();
  ctx.arc(moonX + 9, moonY - 5, 20, 0, Math.PI * 2);
  ctx.fill();

  const now = performance.now() * 0.001;
  ctx.fillStyle = '#fff';
  for (const s of stars) {
    const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(now * s.speed + s.phase));
    ctx.globalAlpha = skyAlpha * twinkle;
    ctx.beginPath();
    ctx.arc(s.x * canvas.width, s.y * canvas.height, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawMonster(m) {
  const sx = m.renderX - camera.x;
  const sy = m.renderY - camera.y;
  ctx.save();
  ctx.translate(sx, sy);

  const now = performance.now();
  const bob = Math.sin(now * 0.006) * 2;
  const jitter = m.attacking ? Math.sin(now * 0.05) * 2 : 0;

  // shadow
  ctx.beginPath();
  ctx.ellipse(0, 3, 13, 5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fill();

  // wispy dark body — a Don't-Starve-ish shadow creature
  ctx.fillStyle = 'rgba(20,10,30,0.92)';
  ctx.strokeStyle = 'rgba(107,47,179,0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-11 + jitter, 2 + bob);
  ctx.quadraticCurveTo(-14, -14 + bob, -5, -26 + bob);
  ctx.quadraticCurveTo(0, -32 + bob, 5, -26 + bob);
  ctx.quadraticCurveTo(14, -14 + bob, 11 - jitter, 2 + bob);
  ctx.quadraticCurveTo(4, -4 + bob, 0, 2 + bob);
  ctx.quadraticCurveTo(-4, -4 + bob, -11 + jitter, 2 + bob);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // glowing eyes
  const eyeColor = m.attacking ? '#ff3b3b' : '#c98bff';
  ctx.fillStyle = eyeColor;
  ctx.shadowColor = eyeColor;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  ctx.arc(-4, -20 + bob, 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(4, -20 + bob, 1.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.restore();

  // HP bar (only while damaged, so full-health monsters don't clutter the screen)
  if (m.hp < m.maxHp) {
    const w = 26;
    const frac = Math.max(0, m.hp / m.maxHp);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(sx - w / 2, sy - 40, w, 4);
    ctx.fillStyle = '#8b2c2c';
    ctx.fillRect(sx - w / 2, sy - 40, w * frac, 4);
  }
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
  const sitOffset = p.isSitting ? 9 : 0; // squats the body down when sitting at a fire

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
  ctx.moveTo(-8, -25 + bounce + sitOffset);
  ctx.lineTo(8, -25 + bounce + sitOffset);
  ctx.lineTo(10, -10 + bounce + sitOffset);
  ctx.lineTo(-10, -10 + bounce + sitOffset);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const headY = -42 + bounce + sitOffset;
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

  // Chat bubble (fades out on its own)
  if (p._chatBubble && performance.now() < p._chatBubble.until) {
    const remaining = p._chatBubble.until - performance.now();
    const alpha = Math.min(1, remaining / 600);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '11px "Courier New", monospace';
    const text = p._chatBubble.text;
    const textW = ctx.measureText(text).width;
    const padX = 8, padY = 5;
    const boxW = textW + padX * 2, boxH = 18;
    const bx = sx - boxW / 2, by = sy - 92;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeStyle = 'rgba(212,175,55,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(bx, by, boxW, boxH, 4) : ctx.rect(bx, by, boxW, boxH);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e0d7c6';
    ctx.textAlign = 'center';
    ctx.fillText(text, sx, by + boxH - padY);
    ctx.restore();
  }

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
  updateFirePanel();
  updateClockUI();
  updateAudio(dtSec);
  drawBackground();

  const renderList = [];
  for (const id in resources) {
    const r = resources[id];
    if (isOnScreen(r.x, r.y, 120)) renderList.push({ type: r.type, y: r.y, data: r });
  }
  for (const id in campfires) {
    const c = campfires[id];
    if (isOnScreen(c.x, c.y, 100)) renderList.push({ type: 'campfire', y: c.y, data: c });
  }
  for (const id in animals) {
    const a = animals[id];
    if (isOnScreen(a.renderX, a.renderY, 80)) renderList.push({ type: 'animal', y: a.renderY, data: a });
  }
  for (const id in monsters) {
    const m = monsters[id];
    if (isOnScreen(m.renderX, m.renderY, 80)) renderList.push({ type: 'monster', y: m.renderY, data: m });
  }
  for (const id in players) {
    const p = players[id];
    if (isOnScreen(p.renderX, p.renderY, 150)) renderList.push({ type: 'player', y: p.renderY, data: p, isSelf: id === selfId });
  }
  renderList.sort((a, b) => a.y - b.y);

  for (const obj of renderList) {
    if (obj.type === 'tree') drawTree(obj.data);
    else if (obj.type === 'rock') drawRock(obj.data);
    else if (obj.type === 'campfire') drawCampfire(obj.data);
    else if (obj.type === 'animal') drawRabbit(obj.data);
    else if (obj.type === 'monster') drawMonster(obj.data);
    else if (obj.type === 'player') drawCharacter(obj.data, obj.isSelf);
  }

  drawParticles();
  drawNightOverlay(computeNightAlpha(dayTime));
  drawFireflies(computeNightAlpha(dayTime));
  drawMinimap();

  updateBarsUI();
  updateResourceUI();

  requestAnimationFrame(gameLoop);
}

let lastFrameTime;
requestAnimationFrame(gameLoop);
