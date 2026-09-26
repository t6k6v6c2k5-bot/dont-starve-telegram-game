// ==================== VISIBLE ERROR REPORTING ====================
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
console.log('[game.js] loaded, build: altar-td-v1');
let tgUser = null;
try {
  if (window.Telegram && window.Telegram.WebApp) {
    const tg = window.Telegram.WebApp;
    tg.expand();
    tg.ready();
    if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes();
    if (typeof tg.enableClosingConfirmation === 'function') tg.enableClosingConfirmation();
    if (tg.setHeaderColor) { try { tg.setHeaderColor('#07070b'); } catch (e) {} }
    const u = tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (u) {
      tgUser = { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || null };
    }
    document.body.style.background = tg.themeParams.bg_color || '#07070b';
  }
} catch (e) { console.warn('Telegram WebApp not available:', e); }

document.addEventListener('touchmove', (e) => { if (e.touches.length === 1) e.preventDefault(); }, { passive: false });

function randomGuestName() {
  const adj = ['Тёмный', 'Тихий', 'Стойкий', 'Дикий', 'Забытый', 'Ночной'];
  const noun = ['Страж', 'Хранитель', 'Кузнец', 'Часовой', 'Инженер'];
  return adj[Math.floor(Math.random() * adj.length)] + ' ' + noun[Math.floor(Math.random() * noun.length)];
}
const myUserId = (tgUser && tgUser.id) || ('guest_' + Math.random().toString(36).slice(2, 9));
const myName = (tgUser && tgUser.name) || randomGuestName();

// ==================== CANVAS SETUP ====================
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const nightCanvas = document.createElement('canvas');
const nightCtx = nightCanvas.getContext('2d');
function resizeNightCanvas() { nightCanvas.width = canvas.width; nightCanvas.height = canvas.height; }

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  resizeNightCanvas();
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ==================== NETWORK STATE ====================
const socket = io();

let selfId = null;
let world = { width: 3400, height: 3400 };
let players = {};
let resourceNodes = {};
let walls = {};
let turrets = {};
let beacons = {};
let monsters = {};
let team = { iron: 0, crystals: 0, shadowCores: 0 };
let altar = { x: 1700, y: 1700, hp: 500, maxHp: 500, baseRadius: 260 };
let wave = 0;
let phase = { phase: 'day', frac: 0, msLeft: 120000 };
let hasJoined = false;
const particles = [];
const projectiles = [];

function joinGame(name) {
  if (hasJoined) return;
  hasJoined = true;
  setStartStatus('Подключение...');
  socket.emit('join', { userId: myUserId, name: name || myName });
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

function initRenderPos(o) { o.renderX = o.x; o.renderY = o.y; }

socket.on('init', (data) => {
  clearTimeout(joinTimeoutHandle);
  selfId = data.selfId;
  world = data.world;
  players = data.players;
  resourceNodes = data.resourceNodes || {};
  walls = data.walls || {};
  turrets = data.turrets || {};
  beacons = data.beacons || {};
  monsters = data.monsters || {};
  team = data.team || team;
  altar = data.altar || altar;
  wave = data.wave || 0;
  phase = data.phase || phase;
  phaseSyncedAt = performance.now();
  Object.values(players).forEach(initRenderPos);
  Object.values(monsters).forEach(initRenderPos);
  setStartStatus('');
  startOverlayEl.classList.add('hidden');
  updatePlayersListUI();
  updateResourcesUI();
});

socket.on('player_joined', (p) => { initRenderPos(p); players[p.id] = p; updatePlayersListUI(); });
socket.on('player_left', (id) => { delete players[id]; updatePlayersListUI(); });

socket.on('state', (data) => {
  for (const id in data.players) {
    const incoming = data.players[id];
    if (players[id]) Object.assign(players[id], incoming);
    else { players[id] = incoming; initRenderPos(players[id]); }
  }
  for (const id in players) if (!data.players[id]) delete players[id];

  if (data.monsters) {
    for (const id in data.monsters) {
      const incoming = data.monsters[id];
      if (monsters[id]) Object.assign(monsters[id], incoming);
      else { monsters[id] = incoming; initRenderPos(monsters[id]); }
    }
    for (const id in monsters) if (!data.monsters[id]) delete monsters[id];
  }

  if (data.turretAngles) {
    for (const id in data.turretAngles) if (turrets[id]) turrets[id].angle = data.turretAngles[id];
  }
  if (typeof data.altarHp === 'number') altar.hp = data.altarHp;
  if (typeof data.wave === 'number') wave = data.wave;
  if (data.phase) { phase = data.phase; phaseSyncedAt = performance.now(); }

  updatePlayersListUI();
});

socket.on('node_added', (n) => { resourceNodes[n.id] = n; });
socket.on('node_removed', (id) => {
  const n = resourceNodes[id];
  if (n) spawnHitParticles(n.x, n.y, n.type === 'iron' ? '#c9a227' : '#8bd8ff', 10);
  delete resourceNodes[id];
});
socket.on('node_damaged', (data) => {
  if (resourceNodes[data.id]) {
    resourceNodes[data.id].hp = data.hp;
    spawnHitParticles(resourceNodes[data.id].x, resourceNodes[data.id].y, resourceNodes[data.id].type === 'iron' ? '#c9a227' : '#8bd8ff', 4);
  }
});

socket.on('wall_added', (w) => { walls[w.id] = w; playBuildSound(); });
socket.on('wall_updated', (d) => { if (walls[d.id]) walls[d.id].hp = d.hp; });
socket.on('wall_removed', (id) => {
  const w = walls[id];
  if (w) spawnHitParticles(w.x, w.y, '#5a4a36', 10);
  delete walls[id];
});

socket.on('turret_added', (t) => { turrets[t.id] = t; playBuildSound(); });
socket.on('turret_updated', (d) => { if (turrets[d.id]) turrets[d.id].hp = d.hp; });
socket.on('turret_removed', (id) => {
  const t = turrets[id];
  if (t) spawnHitParticles(t.x, t.y, '#5a4a36', 12);
  delete turrets[id];
});
socket.on('turret_fired', (data) => {
  const t = turrets[data.id];
  if (!t) return;
  projectiles.push({ x1: t.x, y1: t.y - 12, x2: data.targetX, y2: data.targetY, start: performance.now(), duration: 140 });
  playPewSound();
});

socket.on('beacon_added', (b) => { beacons[b.id] = b; playBuildSound(); });
socket.on('beacon_updated', (d) => { if (beacons[d.id]) beacons[d.id].hp = d.hp; });
socket.on('beacon_removed', (id) => { delete beacons[id]; });

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

socket.on('team_resources', (t) => { team = t; updateResourcesUI(); });

socket.on('wave_start', (d) => showWaveBanner(`🌙 Волна ${d.wave} — враги идут к алтарю! (${d.count})`, '#8b2c2c'));
socket.on('wave_end', (d) => showWaveBanner(`☀️ Волна ${d.wave} отражена`, '#7c8b2c'));

socket.on('altar_destroyed', () => showFallenOverlay());
socket.on('player_died', () => { playDeathSound(); });

socket.on('chat', (msg) => {
  appendChatMessage(msg);
  if (players[msg.id]) players[msg.id]._chatBubble = { text: msg.text, until: performance.now() + 4500 };
});

// ==================== UI: TOP HUD ====================
const altarHpFillEl = document.getElementById('altar-hp-fill');
const phaseIconEl = document.getElementById('phase-icon');
const phaseTextEl = document.getElementById('phase-text');
const phaseTimerEl = document.getElementById('phase-timer');
const selfHpFillEl = document.getElementById('self-hp-fill');
const zoneBadgeEl = document.getElementById('zone-badge');
const ironCountEl = document.getElementById('iron-count');
const crystalCountEl = document.getElementById('crystal-count');
const coreCountEl = document.getElementById('core-count');
const menuPlayersBodyEl = document.getElementById('menu-players-body');

function updateResourcesUI() {
  ironCountEl.textContent = team.iron || 0;
  crystalCountEl.textContent = team.crystals || 0;
  coreCountEl.textContent = team.shadowCores || 0;
}

function updatePlayersListUI() {
  if (!menuPlayersBodyEl) return;
  const names = Object.values(players).map(p => p.name || '???');
  menuPlayersBodyEl.innerHTML = names.map(n => `<div>• ${escapeHtml(n)}</div>`).join('') || '<div>—</div>';
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatMs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

function updateHudTop() {
  altarHpFillEl.style.width = Math.max(0, Math.min(100, (altar.hp / altar.maxHp) * 100)) + '%';
  altarHpFillEl.style.background = (altar.hp / altar.maxHp) < 0.3 ? 'linear-gradient(90deg,#8b2c2c,#c9453e)' : 'linear-gradient(90deg,#d4af37,#f0d878)';

  if (phase.phase === 'night') { phaseIconEl.textContent = '🌙'; phaseTextEl.textContent = `Волна ${wave}`; }
  else { phaseIconEl.textContent = '☀️'; phaseTextEl.textContent = 'День'; }
  phaseTimerEl.textContent = formatMs(phase.msLeft - (performance.now() - phaseSyncedAt));

  const self = players[selfId];
  if (self) {
    selfHpFillEl.style.width = Math.max(0, Math.min(100, (self.health / self.maxHealth) * 100)) + '%';
    const px = predicted.x !== undefined ? predicted.x : self.x;
    const py = predicted.y !== undefined ? predicted.y : self.y;
    zoneBadgeEl.style.display = isInSafeZoneClient(px, py) ? 'block' : 'none';
  }
}
let phaseSyncedAt = performance.now();

function isInSafeZoneClient(x, y) {
  if (Math.hypot(x - altar.x, y - altar.y) <= altar.baseRadius) return true;
  for (const id in beacons) {
    const b = beacons[id];
    if (Math.hypot(x - b.x, y - b.y) <= b.radius) return true;
  }
  return false;
}

// ==================== HIT PARTICLES ====================
function spawnHitParticles(x, y, color, count) {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 40 + Math.random() * 90;
    particles.push({
      x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 30,
      life: 0.35 + Math.random() * 0.25, maxLife: 0.35 + Math.random() * 0.25,
      color, size: 2 + Math.random() * 2
    });
  }
}
function updateParticles(dtSec) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dtSec;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    p.x += p.vx * dtSec; p.y += p.vy * dtSec; p.vy += 220 * dtSec;
  }
}
function drawParticles() {
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x - camera.x, p.y - camera.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
function drawProjectiles() {
  const now = performance.now();
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const pr = projectiles[i];
    const t = (now - pr.start) / pr.duration;
    if (t >= 1) { projectiles.splice(i, 1); continue; }
    const x1 = pr.x1 - camera.x, y1 = pr.y1 - camera.y;
    const x2 = pr.x1 + (pr.x2 - pr.x1) * t - camera.x;
    const y2 = pr.y1 + (pr.y2 - pr.y1) * t - camera.y;
    ctx.strokeStyle = 'rgba(180,220,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
}

// ==================== AUDIO ====================
let audioCtx = null;
let soundEnabled = true;
let ambientGain, ambientOsc, ambientLfo, ambientLfoGain;

function createNoiseBuffer(seconds) {
  const bufferSize = Math.floor(audioCtx.sampleRate * seconds);
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
function ensureAudio() {
  if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  ambientOsc = audioCtx.createOscillator();
  ambientOsc.type = 'sine';
  ambientOsc.frequency.value = 66;
  ambientGain = audioCtx.createGain();
  ambientGain.gain.value = 0.022;
  ambientLfo = audioCtx.createOscillator();
  ambientLfo.frequency.value = 0.06;
  ambientLfoGain = audioCtx.createGain();
  ambientLfoGain.gain.value = 0.014;
  ambientLfo.connect(ambientLfoGain);
  ambientLfoGain.connect(ambientGain.gain);
  ambientOsc.connect(ambientGain);
  ambientGain.connect(audioCtx.destination);
  ambientOsc.start();
  ambientLfo.start();
}
function updateAudio() {
  if (!audioCtx || !soundEnabled) return;
  const target = 0.02 + (phase.phase === 'night' ? 0.05 : 0);
  ambientGain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.6);
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
  osc.connect(g); g.connect(audioCtx.destination);
  osc.start(now); osc.stop(now + durationSec);
}
function playHitSound() { playBlip(220, 90, 0.12, 'square'); }
function playPewSound() { playBlip(700, 300, 0.08, 'triangle'); }
function playDeathSound() { playBlip(160, 40, 0.5, 'sawtooth'); }
function playBuildSound() {
  if (!audioCtx || !soundEnabled) return;
  const noise = audioCtx.createBufferSource();
  noise.buffer = createNoiseBuffer(0.3);
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(400, audioCtx.currentTime);
  filter.frequency.exponentialRampToValueAtTime(1800, audioCtx.currentTime + 0.25);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.15, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
  noise.connect(filter); filter.connect(g); g.connect(audioCtx.destination);
  noise.start();
}
window.addEventListener('pointerdown', ensureAudio, { once: true });
window.addEventListener('keydown', ensureAudio, { once: true });

function toggleSound() {
  ensureAudio();
  soundEnabled = !soundEnabled;
  const label = soundEnabled ? '🔊' : '🔇';
  const menuBtn = document.getElementById('menu-sound-btn');
  if (menuBtn) menuBtn.textContent = `${label} Звук: ${soundEnabled ? 'вкл' : 'выкл'}`;
  if (audioCtx && !soundEnabled) ambientGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.2);
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
if (tgUser && tgUser.name) { startNameInput.value = tgUser.name; startNameInput.disabled = true; }
else { startNameInput.value = myName; }

function startGame() {
  ensureAudio();
  startPlayBtn.disabled = true;
  const chosenName = startNameInput.value.trim().slice(0, 24) || myName;
  joinGame(chosenName);
}
startPlayBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); startGame(); });
startNameInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.code === 'Enter') startGame(); });

// ==================== FALLEN OVERLAY ====================
const fallenOverlayEl = document.getElementById('fallen-overlay');
function showFallenOverlay() {
  fallenOverlayEl.classList.add('visible');
  playDeathSound();
  setTimeout(() => fallenOverlayEl.classList.remove('visible'), 3200);
}

// ==================== WAVE BANNER ====================
const waveBannerEl = document.getElementById('wave-banner');
let waveBannerHideTimer = null;
function showWaveBanner(text, color) {
  waveBannerEl.textContent = text;
  waveBannerEl.style.color = color || '#e6e0d4';
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
const menuChatBtnEl = document.getElementById('menu-chat-btn');

menuBtnEl.addEventListener('pointerdown', (e) => { e.preventDefault(); menuOverlayEl.classList.add('visible'); updatePlayersListUI(); });
menuCloseEl.addEventListener('pointerdown', (e) => { e.preventDefault(); menuOverlayEl.classList.remove('visible'); });
menuOverlayEl.addEventListener('pointerdown', (e) => { if (e.target === menuOverlayEl) menuOverlayEl.classList.remove('visible'); });
menuSoundBtnEl.addEventListener('pointerdown', (e) => { e.preventDefault(); toggleSound(); });
menuChatBtnEl.addEventListener('pointerdown', (e) => { e.preventDefault(); menuOverlayEl.classList.remove('visible'); openChat(); });

let locateBeacon = null;
menuLocateBtnEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const self = players[selfId];
  if (!self) return;
  let nearest = null, nearestDist = Infinity;
  for (const id in players) {
    if (id === selfId) continue;
    const d = Math.hypot(players[id].x - self.x, players[id].y - self.y);
    if (d < nearestDist) { nearestDist = d; nearest = players[id]; }
  }
  if (!nearest) menuLocateBtnEl.textContent = '🧭 Больше никого нет рядом';
  else {
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
const chatCloseBtnEl = document.getElementById('chat-close-btn');

function openChat() { chatPanelEl.classList.add('visible'); chatInputEl.focus(); }
function closeChat() { chatPanelEl.classList.remove('visible'); }
chatCloseBtnEl.addEventListener('pointerdown', (e) => { e.preventDefault(); closeChat(); });

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
chatSendBtnEl.addEventListener('pointerdown', (e) => { e.preventDefault(); sendChat(); });
chatInputEl.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') { e.preventDefault(); sendChat(); }
  e.stopPropagation();
});

// ==================== MINIMAP ====================
const minimapEl = document.getElementById('minimap');
const minimapCtx = minimapEl.getContext('2d');
function drawMinimap() {
  const w = minimapEl.width, h = minimapEl.height;
  minimapCtx.clearRect(0, 0, w, h);
  minimapCtx.fillStyle = 'rgba(14,12,10,0.9)';
  minimapCtx.fillRect(0, 0, w, h);
  const sx = w / world.width, sy = h / world.height;

  minimapCtx.fillStyle = 'rgba(212,175,55,0.25)';
  minimapCtx.beginPath();
  minimapCtx.arc(altar.x * sx, altar.y * sy, Math.max(3, altar.baseRadius * sx), 0, Math.PI * 2);
  minimapCtx.fill();
  minimapCtx.fillStyle = '#d4af37';
  minimapCtx.beginPath();
  minimapCtx.arc(altar.x * sx, altar.y * sy, 3, 0, Math.PI * 2);
  minimapCtx.fill();

  for (const id in walls) { minimapCtx.fillStyle = '#5a4a36'; minimapCtx.fillRect(walls[id].x * sx - 1, walls[id].y * sy - 1, 2, 2); }
  for (const id in turrets) { minimapCtx.fillStyle = '#9bb8d4'; minimapCtx.fillRect(turrets[id].x * sx - 1.5, turrets[id].y * sy - 1.5, 3, 3); }
  for (const id in beacons) { minimapCtx.fillStyle = '#ffcf5c'; minimapCtx.fillRect(beacons[id].x * sx - 1.5, beacons[id].y * sy - 1.5, 3, 3); }

  const nowMs = performance.now();
  for (const id in monsters) {
    const m = monsters[id];
    minimapCtx.fillStyle = m.attacking ? '#ff3b3b' : '#8b5fc9';
    minimapCtx.beginPath();
    minimapCtx.arc(m.x * sx, m.y * sy, 1.8 + Math.sin(nowMs * 0.01) * 0.5, 0, Math.PI * 2);
    minimapCtx.fill();
  }

  for (const id in players) {
    const p = players[id];
    const isSelf = id === selfId;
    const isBeacon2 = locateBeacon && locateBeacon.id === id && nowMs < locateBeacon.until;
    const mx = p.x * sx, my = p.y * sy;
    if (isBeacon2) {
      minimapCtx.strokeStyle = '#ff4d4d';
      minimapCtx.lineWidth = 1.5;
      minimapCtx.beginPath();
      minimapCtx.arc(mx, my, 6 + Math.sin(nowMs * 0.02) * 2, 0, Math.PI * 2);
      minimapCtx.stroke();
    }
    minimapCtx.fillStyle = isSelf ? '#d4af37' : '#e6e0d4';
    minimapCtx.beginPath();
    minimapCtx.arc(mx, my, isSelf ? 3 : 2.2, 0, Math.PI * 2);
    minimapCtx.fill();
  }

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
  keyState.left = dx < -dead; keyState.right = dx > dead;
  keyState.up = dy < -dead; keyState.down = dy > dead;
}
function handleJoyStart(clientX, clientY, id) { joyState.active = true; joyTouchId = id; updateJoyStick(clientX, clientY); }
function handleJoyMove(clientX, clientY) { if (joyState.active) updateJoyStick(clientX, clientY); }
function handleJoyEnd() {
  joyState.active = false; joyTouchId = null; joyState.dx = 0; joyState.dy = 0;
  joystickStick.style.transform = 'translate(0px, 0px)';
  joystickVectorToKeys(0, 0);
}
function updateJoyStick(clientX, clientY) {
  const rect = joystickZone.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  let dx = (clientX - cx) / (rect.width / 2), dy = (clientY - cy) / (rect.height / 2);
  const mag = Math.hypot(dx, dy);
  if (mag > 1) { dx /= mag; dy /= mag; }
  joyState.dx = dx; joyState.dy = dy;
  joystickStick.style.transform = `translate(${dx * 35}px, ${dy * 35}px)`;
  joystickVectorToKeys(dx, dy);
}
joystickZone.addEventListener('pointerdown', (e) => { e.preventDefault(); joystickZone.setPointerCapture(e.pointerId); handleJoyStart(e.clientX, e.clientY, e.pointerId); });
joystickZone.addEventListener('pointermove', (e) => { if (e.pointerId !== joyTouchId) return; e.preventDefault(); handleJoyMove(e.clientX, e.clientY); });
function endJoyPointer(e) { if (e.pointerId !== joyTouchId) return; handleJoyEnd(); }
joystickZone.addEventListener('pointerup', endJoyPointer);
joystickZone.addEventListener('pointercancel', endJoyPointer);

// ==================== SEND INPUT TO SERVER ====================
let lastSentInput = '';
setInterval(() => {
  const payload = JSON.stringify(keyState);
  if (payload !== lastSentInput) { socket.emit('input', keyState); lastSentInput = payload; }
}, 50);

// ==================== CLIENT-SIDE PREDICTION (self only) ====================
const PLAYER_SPEED_PX_PER_SEC = 120;
const predicted = { x: undefined, y: undefined };

function updateSelfPrediction(dtSec) {
  const self = players[selfId];
  if (!self) return;
  if (predicted.x === undefined) { predicted.x = self.x; predicted.y = self.y; }

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

  const pull = 1 - Math.exp(-4 * dtSec);
  predicted.x += (self.x - predicted.x) * pull;
  predicted.y += (self.y - predicted.y) * pull;
}

// ==================== CAMERA ====================
const camera = { x: 0, y: 0 };
function updateRenderPositions(dtSec) {
  for (const id in players) {
    const p = players[id];
    if (id === selfId) { p.renderX = predicted.x; p.renderY = predicted.y; continue; }
    if (p.renderX === undefined) { p.renderX = p.x; p.renderY = p.y; }
    const factor = 1 - Math.exp(-12 * dtSec);
    p.renderX += (p.x - p.renderX) * factor;
    p.renderY += (p.y - p.renderY) * factor;
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

// ==================== BUILD SYSTEM ====================
const actionHintEl = document.getElementById('action-hint');
const RES_ICON = { iron: '🔩', crystals: '💎' };
const BUILD_INFO = {
  wall: { label: 'Стена', cost: { iron: 5 } },
  turret: { label: 'Турель', cost: { iron: 12, crystals: 4 } },
  beacon: { label: 'Маяк', cost: { crystals: 6 } }
};
let buildMode = null;

['build-wall', 'build-turret', 'build-beacon'].forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const type = el.dataset.type;
    buildMode = (buildMode === type) ? null : type;
    document.querySelectorAll('.build-icon').forEach((b) => b.classList.remove('selected'));
    if (buildMode) el.classList.add('selected');
  });
});

function getBuildPreviewPos() {
  const self = players[selfId];
  const px = predicted.x !== undefined ? predicted.x : (self ? self.x : altar.x);
  const py = predicted.y !== undefined ? predicted.y : (self ? self.y : altar.y);
  const dir = (self && self.facingRight) ? 1 : -1;
  return { x: px + dir * 70, y: py };
}

// ==================== INTERACTION (mine / attack / repair / build) ====================
const MINE_RANGE = 90, ATTACK_RANGE_UI = 90, REPAIR_RANGE = 100;

function findNearestInteractable() {
  const self = players[selfId];
  if (!self) return null;
  const px = predicted.x !== undefined ? predicted.x : self.x;
  const py = predicted.y !== undefined ? predicted.y : self.y;
  let best = null, bestDist = Infinity;

  for (const id in monsters) {
    const m = monsters[id];
    const d = Math.hypot(px - m.x, py - m.y);
    if (d < ATTACK_RANGE_UI && d < bestDist) { bestDist = d; best = { x: m.x, y: m.y, label: 'Атаковать', event: 'attack_monster', payload: m.id }; }
  }
  if (best) return best;

  for (const id in walls) {
    const w = walls[id];
    if (w.hp >= w.maxHp) continue;
    const d = Math.hypot(px - w.x, py - w.y);
    if (d < REPAIR_RANGE && d < bestDist) { bestDist = d; best = { x: w.x, y: w.y, label: 'Починить стену (2🔩)', event: 'repair', payload: { kind: 'wall', id: w.id } }; }
  }
  for (const id in turrets) {
    const t = turrets[id];
    if (t.hp >= t.maxHp) continue;
    const d = Math.hypot(px - t.x, py - t.y);
    if (d < REPAIR_RANGE && d < bestDist) { bestDist = d; best = { x: t.x, y: t.y, label: 'Починить турель (2🔩)', event: 'repair', payload: { kind: 'turret', id: t.id } }; }
  }
  for (const id in beacons) {
    const b = beacons[id];
    if (b.hp >= b.maxHp) continue;
    const d = Math.hypot(px - b.x, py - b.y);
    if (d < REPAIR_RANGE && d < bestDist) { bestDist = d; best = { x: b.x, y: b.y, label: 'Починить маяк (2🔩)', event: 'repair', payload: { kind: 'beacon', id: b.id } }; }
  }
  if (best) return best;

  for (const id in resourceNodes) {
    const n = resourceNodes[id];
    const d = Math.hypot(px - n.x, py - n.y);
    if (d < MINE_RANGE && d < bestDist) {
      bestDist = d;
      best = { x: n.x, y: n.y, label: n.type === 'iron' ? 'Добывать железо' : 'Добывать кристалл', event: 'mine', payload: n.id };
    }
  }
  return best;
}

function processInteraction() {
  if (buildMode) {
    const info = BUILD_INFO[buildMode];
    const pos = getBuildPreviewPos();
    const afford = Object.keys(info.cost).every((k) => (team[k] || 0) >= info.cost[k]);
    const costStr = Object.entries(info.cost).map(([k, v]) => `${v}${RES_ICON[k]}`).join(' ');
    actionHintEl.classList.add('visible');
    actionHintEl.classList.toggle('disabled', !afford);
    actionHintEl.textContent = `Построить: ${info.label} (${costStr})`;
    if (interactPressed) {
      if (afford) { socket.emit('build', { type: buildMode, x: pos.x, y: pos.y }); triggerSwing(pos.x, pos.y); }
      interactPressed = false;
    }
    return;
  }

  const target = findNearestInteractable();
  if (target) {
    actionHintEl.classList.remove('disabled');
    actionHintEl.classList.add('visible');
    actionHintEl.textContent = target.label;
    if (interactPressed) {
      socket.emit(target.event, target.payload);
      triggerSwing(target.x, target.y);
    }
  } else {
    actionHintEl.classList.remove('visible');
  }
  interactPressed = false;
}
actionHintEl.addEventListener('pointerdown', (e) => { e.preventDefault(); interactPressed = true; });

function triggerSwing(targetX, targetY) {
  const self = players[selfId];
  if (!self) return;
  self._swingUntil = performance.now() + 260;
  const px = predicted.x !== undefined ? predicted.x : self.x;
  self.facingRight = targetX >= px;
  playHitSound();
}

// ==================== RENDERING: WORLD & GROUND ====================
function hashXY(x, y) {
  const h = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return h - Math.floor(h);
}
function isOnScreen(x, y, margin) {
  return x > camera.x - margin && x < camera.x + canvas.width + margin &&
         y > camera.y - margin && y < camera.y + canvas.height + margin;
}

function drawBackground() {
  ctx.fillStyle = '#141019';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#241d2c';
  ctx.lineWidth = 1;

  const startX = Math.floor(camera.x / 60) * 60;
  const startY = Math.floor(camera.y / 60) * 60;
  for (let i = startX; i < camera.x + canvas.width + 60; i += 60) {
    for (let j = startY; j < camera.y + canvas.height + 60; j += 60) {
      const sx = i - camera.x, sy = j - camera.y;
      const h = hashXY(i, j);
      if (h < 0.05) {
        ctx.fillStyle = '#3a3450';
        ctx.beginPath(); ctx.ellipse(sx, sy, 3, 2, 0, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(sx, sy); ctx.lineTo(sx + 4, sy - 8);
        ctx.moveTo(sx + 3, sy); ctx.lineTo(sx + 8, sy - 6);
        ctx.stroke();
      }
    }
  }
}

function drawAltar() {
  const sx = altar.x - camera.x, sy = altar.y - camera.y;
  const now = performance.now();
  const pulse = 0.75 + Math.sin(now * 0.0015) * 0.25;

  ctx.save();
  ctx.translate(sx, sy);

  const glowR = 130 * pulse;
  const grad = ctx.createRadialGradient(0, 0, 10, 0, 0, glowR);
  grad.addColorStop(0, 'rgba(255,220,140,0.55)');
  grad.addColorStop(1, 'rgba(255,220,140,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(0, 0, glowR, 0, Math.PI * 2); ctx.fill();

  ctx.beginPath(); ctx.ellipse(0, 30, 60, 16, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fill();

  ctx.fillStyle = '#3a3040';
  ctx.strokeStyle = '#17111f';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-45, 30); ctx.lineTo(-30, -10); ctx.lineTo(30, -10); ctx.lineTo(45, 30);
  ctx.closePath(); ctx.fill(); ctx.stroke();

  ctx.fillStyle = '#4a3f56';
  ctx.beginPath(); ctx.moveTo(-25, -10); ctx.lineTo(-15, -45); ctx.lineTo(15, -45); ctx.lineTo(25, -10); ctx.closePath();
  ctx.fill(); ctx.stroke();

  ctx.fillStyle = `rgba(255,215,120,${0.7 * pulse + 0.3})`;
  ctx.beginPath(); ctx.arc(0, -50, 9, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,235,180,0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, -50, 13 * pulse, 0, Math.PI * 2); ctx.stroke();

  ctx.restore();
}

function drawIronVein(n) {
  const sx = n.x - camera.x, sy = n.y - camera.y;
  ctx.save(); ctx.translate(sx, sy);
  ctx.beginPath(); ctx.ellipse(0, n.size * 0.3, n.size * 0.5, n.size * 0.18, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fill();

  ctx.fillStyle = '#3a3a3e'; ctx.strokeStyle = '#151517'; ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(-n.size * 0.5, n.size * 0.25); ctx.lineTo(-n.size * 0.3, -n.size * 0.35);
  ctx.lineTo(n.size * 0.1, -n.size * 0.5); ctx.lineTo(n.size * 0.45, -n.size * 0.05); ctx.lineTo(n.size * 0.4, n.size * 0.3);
  ctx.closePath(); ctx.fill(); ctx.stroke();

  const glintAlpha = n.hp / n.maxHp;
  ctx.fillStyle = `rgba(212,175,55,${0.5 + glintAlpha * 0.5})`;
  ctx.beginPath(); ctx.arc(-n.size * 0.1, -n.size * 0.1, 3, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(n.size * 0.15, n.size * 0.05, 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawCrystalNode(n) {
  const sx = n.x - camera.x, sy = n.y - camera.y;
  const now = performance.now();
  const pulse = 0.7 + Math.sin(now * 0.003 + n.x) * 0.3;
  ctx.save(); ctx.translate(sx, sy);

  const grad = ctx.createRadialGradient(0, 0, 2, 0, 0, n.size * 1.4);
  grad.addColorStop(0, `rgba(140,180,255,${0.35 * pulse})`);
  grad.addColorStop(1, 'rgba(140,180,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(0, 0, n.size * 1.4, 0, Math.PI * 2); ctx.fill();

  ctx.beginPath(); ctx.ellipse(0, n.size * 0.25, n.size * 0.4, n.size * 0.14, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();

  ctx.fillStyle = 'rgba(150,190,255,0.85)'; ctx.strokeStyle = 'rgba(220,235,255,0.9)'; ctx.lineWidth = 1.4;
  const shards = [[-0.35, 0.2], [0, -0.4], [0.35, 0.2], [0.05, 0.35]];
  for (const [dx, dy] of shards) {
    const cx = dx * n.size, cy = dy * n.size;
    ctx.beginPath();
    ctx.moveTo(cx, cy - n.size * 0.35);
    ctx.lineTo(cx + n.size * 0.13, cy);
    ctx.lineTo(cx, cy + n.size * 0.3);
    ctx.lineTo(cx - n.size * 0.13, cy);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function drawWall(w) {
  const sx = w.x - camera.x, sy = w.y - camera.y;
  const dmg = 1 - w.hp / w.maxHp;
  ctx.save(); ctx.translate(sx, sy);
  ctx.beginPath(); ctx.ellipse(0, 10, 22, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill();

  const baseColor = dmg > 0.6 ? '#241a12' : dmg > 0.3 ? '#3a2a1a' : '#4a3524';
  ctx.fillStyle = baseColor; ctx.strokeStyle = '#15100a'; ctx.lineWidth = 2;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 13 - 5, 10); ctx.lineTo(i * 13 - 4, -26); ctx.lineTo(i * 13 + 4, -26); ctx.lineTo(i * 13 + 5, 10);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  if (dmg > 0.5) {
    ctx.strokeStyle = `rgba(255,80,60,${0.4 + Math.sin(performance.now() * 0.01) * 0.2})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.rect(-20, -30, 40, 44); ctx.stroke();
  }
  ctx.restore();
}

function drawTurret(t) {
  const sx = t.x - camera.x, sy = t.y - camera.y;
  ctx.save(); ctx.translate(sx, sy);
  ctx.beginPath(); ctx.ellipse(0, 8, 20, 7, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fill();

  ctx.fillStyle = '#3a3540'; ctx.strokeStyle = '#15131a'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  ctx.save();
  ctx.rotate(t.angle || 0);
  ctx.fillStyle = '#5a4a36'; ctx.strokeStyle = '#15100a'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-4, -3); ctx.lineTo(22, 0); ctx.lineTo(-4, 3); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();

  const pulse = 0.6 + Math.sin(performance.now() * 0.004) * 0.4;
  ctx.fillStyle = `rgba(140,190,255,${0.6 + pulse * 0.4})`;
  ctx.beginPath(); ctx.arc(0, -4, 4, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawBeacon(b) {
  const sx = b.x - camera.x, sy = b.y - camera.y;
  const now = performance.now();
  const flicker = Math.sin(now * 0.02) * 2 + Math.sin(now * 0.037) * 1.5;
  ctx.save(); ctx.translate(sx, sy);

  const grad = ctx.createRadialGradient(0, -20, 3, 0, -20, 55);
  grad.addColorStop(0, 'rgba(255,190,90,0.4)');
  grad.addColorStop(1, 'rgba(255,190,90,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(0, -20, 55, 0, Math.PI * 2); ctx.fill();

  ctx.beginPath(); ctx.ellipse(0, 6, 8, 3, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fill();

  ctx.strokeStyle = '#3a2a1a'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(0, 6); ctx.lineTo(0, -30); ctx.stroke();

  ctx.fillStyle = '#ffcf5c';
  ctx.beginPath();
  ctx.moveTo(0, -30); ctx.quadraticCurveTo(7 + flicker, -40, 0, -52 + flicker); ctx.quadraticCurveTo(-7 - flicker, -40, 0, -30);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawMonster(m) {
  const sx = m.renderX - camera.x, sy = m.renderY - camera.y;
  const isRammer = m.type === 'rammer';
  const scale = isRammer ? 1.5 : 1;
  ctx.save(); ctx.translate(sx, sy); ctx.scale(scale, scale);

  const now = performance.now();
  const bob = Math.sin(now * (isRammer ? 0.004 : 0.008)) * 2;
  const jitter = m.attacking ? Math.sin(now * 0.05) * 2 : 0;

  ctx.beginPath(); ctx.ellipse(0, 3, 13, 5, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill();

  ctx.fillStyle = isRammer ? 'rgba(35,15,15,0.94)' : 'rgba(20,10,30,0.92)';
  ctx.strokeStyle = isRammer ? 'rgba(200,80,50,0.7)' : 'rgba(107,47,179,0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-11 + jitter, 2 + bob);
  ctx.quadraticCurveTo(-14, -14 + bob, -5, -26 + bob);
  ctx.quadraticCurveTo(0, -32 + bob, 5, -26 + bob);
  ctx.quadraticCurveTo(14, -14 + bob, 11 - jitter, 2 + bob);
  ctx.quadraticCurveTo(4, -4 + bob, 0, 2 + bob);
  ctx.quadraticCurveTo(-4, -4 + bob, -11 + jitter, 2 + bob);
  ctx.closePath(); ctx.fill(); ctx.stroke();

  if (isRammer) {
    ctx.strokeStyle = 'rgba(200,80,50,0.8)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-6, -24 + bob); ctx.lineTo(-10, -34 + bob); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(6, -24 + bob); ctx.lineTo(10, -34 + bob); ctx.stroke();
  }

  const eyeColor = m.attacking ? '#ff3b3b' : (isRammer ? '#ff9b3b' : '#c98bff');
  ctx.fillStyle = eyeColor; ctx.shadowColor = eyeColor; ctx.shadowBlur = 6;
  ctx.beginPath(); ctx.arc(-4, -20 + bob, 1.8, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(4, -20 + bob, 1.8, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();

  if (m.hp < m.maxHp) {
    const w = 26 * scale, frac = Math.max(0, m.hp / m.maxHp);
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(sx - w / 2, sy - 40 * scale, w, 4);
    ctx.fillStyle = '#8b2c2c'; ctx.fillRect(sx - w / 2, sy - 40 * scale, w * frac, 4);
  }
}

function drawCharacter(p, isSelf) {
  const sx = p.renderX - camera.x, sy = p.renderY - camera.y;
  ctx.save(); ctx.translate(sx, sy);
  if (!p.facingRight) ctx.scale(-1, 1);

  const t = (p._walkFrame || 0);
  const bounce = p.isMoving ? Math.sin(t * 0.2) * 3 : 0;
  const legAngle = p.isMoving ? Math.sin(t * 0.2) * 0.3 : 0;

  ctx.beginPath(); ctx.ellipse(0, 2, 16, 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill();

  ctx.strokeStyle = '#0f0c0a'; ctx.lineWidth = 2.5;
  ctx.save(); ctx.rotate(legAngle); ctx.beginPath(); ctx.moveTo(-4, -10); ctx.lineTo(-6, 2); ctx.stroke(); ctx.restore();
  ctx.save(); ctx.rotate(-legAngle); ctx.beginPath(); ctx.moveTo(4, -10); ctx.lineTo(6, 2); ctx.stroke(); ctx.restore();

  const swingActive = p._swingUntil && performance.now() < p._swingUntil;
  if (swingActive) {
    const remaining = (p._swingUntil - performance.now()) / 260;
    const swingAngle = Math.sin((1 - remaining) * Math.PI) * 1.3;
    ctx.save(); ctx.translate(9, -22 + bounce); ctx.rotate(-0.6 + swingAngle);
    ctx.strokeStyle = '#8a95a6'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -20); ctx.stroke();
    ctx.restore();
  }

  ctx.fillStyle = isSelf ? '#33291f' : '#2b2320';
  ctx.beginPath();
  ctx.moveTo(-8, -25 + bounce); ctx.lineTo(8, -25 + bounce); ctx.lineTo(10, -10 + bounce); ctx.lineTo(-10, -10 + bounce);
  ctx.closePath(); ctx.fill(); ctx.stroke();

  const headY = -42 + bounce;
  ctx.fillStyle = '#e8dcc8';
  ctx.beginPath(); ctx.ellipse(0, headY, 15, 17, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  ctx.fillStyle = '#14100e';
  ctx.beginPath();
  ctx.moveTo(-16, headY - 5);
  ctx.quadraticCurveTo(-18, headY - 22, -8, headY - 24);
  ctx.quadraticCurveTo(0, headY - 28, 8, headY - 24);
  ctx.quadraticCurveTo(18, headY - 22, 16, headY - 5);
  ctx.quadraticCurveTo(8, headY - 12, 0, headY - 14);
  ctx.quadraticCurveTo(-8, headY - 12, -16, headY - 5);
  ctx.closePath(); ctx.fill(); ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(4, headY + 1, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#0f0c0a'; ctx.beginPath(); ctx.arc(5, headY + 1, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(-5, headY + 1, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#0f0c0a'; ctx.beginPath(); ctx.arc(-4, headY + 1, 2, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(-2, headY + 10); ctx.lineTo(3, headY + 9); ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.font = '11px "Courier New", monospace'; ctx.textAlign = 'center';
  ctx.fillStyle = isSelf ? '#d4af37' : '#b8ac95';
  ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
  const label = p.name || '???';
  ctx.strokeText(label, sx, sy - 68); ctx.fillText(label, sx, sy - 68);
  ctx.restore();

  if (p._chatBubble && performance.now() < p._chatBubble.until) {
    const remaining = p._chatBubble.until - performance.now();
    const alpha = Math.min(1, remaining / 600);
    ctx.save(); ctx.globalAlpha = alpha; ctx.font = '11px "Courier New", monospace';
    const text = p._chatBubble.text;
    const textW = ctx.measureText(text).width;
    const padX = 8, boxW = textW + padX * 2, boxH = 18;
    const bx = sx - boxW / 2, by = sy - 92;
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.strokeStyle = 'rgba(212,175,55,0.6)'; ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, boxW, boxH, 4); else ctx.rect(bx, by, boxW, boxH);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#e6e0d4'; ctx.textAlign = 'center';
    ctx.fillText(text, sx, by + boxH - 5);
    ctx.restore();
  }

  p._walkFrame = p.isMoving ? t + 1 : 0;
}

function drawBuildGhost() {
  if (!buildMode) return;
  const pos = getBuildPreviewPos();
  const sx = pos.x - camera.x, sy = pos.y - camera.y;
  const info = BUILD_INFO[buildMode];
  const afford = Object.keys(info.cost).every((k) => (team[k] || 0) >= info.cost[k]);
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = afford ? '#7ca87c' : '#c9453e';
  ctx.fillStyle = afford ? 'rgba(124,168,124,0.25)' : 'rgba(201,69,62,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(sx, sy, 24, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
}

// ==================== SAFE-ZONE DOME OVERLAY ====================
const stars = [];
for (let i = 0; i < 80; i++) stars.push({ x: Math.random(), y: Math.random(), phase: Math.random() * Math.PI * 2, speed: 0.4 + Math.random() * 1.4 });

function drawDomeOverlay() {
  const wildAlpha = phase.phase === 'night' ? 0.8 : 0.46;

  nightCtx.clearRect(0, 0, nightCanvas.width, nightCanvas.height);
  nightCtx.fillStyle = `rgba(10,8,22,${wildAlpha})`;
  nightCtx.fillRect(0, 0, nightCanvas.width, nightCanvas.height);
  nightCtx.globalCompositeOperation = 'destination-out';

  const asx = altar.x - camera.x, asy = altar.y - camera.y;
  let grad = nightCtx.createRadialGradient(asx, asy, 0, asx, asy, altar.baseRadius + 40);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.7, 'rgba(0,0,0,0.75)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  nightCtx.fillStyle = grad;
  nightCtx.beginPath(); nightCtx.arc(asx, asy, altar.baseRadius + 40, 0, Math.PI * 2); nightCtx.fill();

  for (const id in beacons) {
    const b = beacons[id];
    const sx = b.x - camera.x, sy = b.y - camera.y;
    const g2 = nightCtx.createRadialGradient(sx, sy, 0, sx, sy, b.radius + 20);
    g2.addColorStop(0, 'rgba(0,0,0,1)');
    g2.addColorStop(0.7, 'rgba(0,0,0,0.7)');
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    nightCtx.fillStyle = g2;
    nightCtx.beginPath(); nightCtx.arc(sx, sy, b.radius + 20, 0, Math.PI * 2); nightCtx.fill();
  }

  const self = players[selfId];
  if (self) {
    const sx = self.renderX - camera.x, sy = self.renderY - camera.y;
    const g3 = nightCtx.createRadialGradient(sx, sy, 0, sx, sy, 70);
    g3.addColorStop(0, 'rgba(0,0,0,0.45)');
    g3.addColorStop(1, 'rgba(0,0,0,0)');
    nightCtx.fillStyle = g3;
    nightCtx.beginPath(); nightCtx.arc(sx, sy, 70, 0, Math.PI * 2); nightCtx.fill();
  }

  nightCtx.globalCompositeOperation = 'source-over';
  ctx.drawImage(nightCanvas, 0, 0);

  ctx.save();
  ctx.strokeStyle = 'rgba(212,175,55,0.35)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(asx, asy, altar.baseRadius, 0, Math.PI * 2); ctx.stroke();
  for (const id in beacons) {
    const b = beacons[id];
    ctx.beginPath(); ctx.arc(b.x - camera.x, b.y - camera.y, b.radius, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();

  if (phase.phase === 'night') {
    ctx.save();
    const now = performance.now() * 0.001;
    ctx.fillStyle = '#fff';
    for (const s of stars) {
      const twinkle = 0.35 + 0.65 * Math.abs(Math.sin(now * s.speed + s.phase));
      ctx.globalAlpha = twinkle * 0.7;
      ctx.beginPath(); ctx.arc(s.x * canvas.width, s.y * canvas.height, 1.3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
}

// ==================== FIREFLIES ====================
const fireflies = [];
for (let i = 0; i < 35; i++) {
  fireflies.push({ ox: (Math.random() - 0.5) * 2600, oy: (Math.random() - 0.5) * 2600, phase: Math.random() * Math.PI * 2, speed: 0.3 + Math.random() * 0.5, radius: 20 + Math.random() * 40 });
}
function drawFireflies() {
  if (phase.phase !== 'night') return;
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
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, 8);
    grad.addColorStop(0, `rgba(170,200,255,${twinkle * 0.7})`);
    grad.addColorStop(1, 'rgba(170,200,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ==================== MAIN LOOP ====================
let lastFrameTime;
function gameLoop(timestamp) {
  if (lastFrameTime === undefined) lastFrameTime = timestamp;
  let dtSec = (timestamp - lastFrameTime) / 1000;
  lastFrameTime = timestamp;
  dtSec = Math.max(0, Math.min(dtSec, 0.1));

  processInteraction();
  updateSelfPrediction(dtSec);
  updateRenderPositions(dtSec);
  updateCamera(dtSec);
  updateParticles(dtSec);
  updateHudTop();
  updateAudio();
  drawBackground();

  const renderList = [];
  renderList.push({ type: 'altar', y: altar.y });
  for (const id in resourceNodes) { const n = resourceNodes[id]; if (isOnScreen(n.x, n.y, 100)) renderList.push({ type: n.type === 'iron' ? 'iron' : 'crystal', y: n.y, data: n }); }
  for (const id in walls) { const w = walls[id]; if (isOnScreen(w.x, w.y, 60)) renderList.push({ type: 'wall', y: w.y, data: w }); }
  for (const id in turrets) { const t = turrets[id]; if (isOnScreen(t.x, t.y, 60)) renderList.push({ type: 'turret', y: t.y, data: t }); }
  for (const id in beacons) { const b = beacons[id]; if (isOnScreen(b.x, b.y, 80)) renderList.push({ type: 'beacon', y: b.y, data: b }); }
  for (const id in monsters) { const m = monsters[id]; if (isOnScreen(m.renderX, m.renderY, 80)) renderList.push({ type: 'monster', y: m.renderY, data: m }); }
  for (const id in players) { const p = players[id]; if (isOnScreen(p.renderX, p.renderY, 150)) renderList.push({ type: 'player', y: p.renderY, data: p, isSelf: id === selfId }); }
  renderList.sort((a, b) => a.y - b.y);

  for (const obj of renderList) {
    if (obj.type === 'altar') drawAltar();
    else if (obj.type === 'iron') drawIronVein(obj.data);
    else if (obj.type === 'crystal') drawCrystalNode(obj.data);
    else if (obj.type === 'wall') drawWall(obj.data);
    else if (obj.type === 'turret') drawTurret(obj.data);
    else if (obj.type === 'beacon') drawBeacon(obj.data);
    else if (obj.type === 'monster') drawMonster(obj.data);
    else if (obj.type === 'player') drawCharacter(obj.data, obj.isSelf);
  }

  drawBuildGhost();
  drawParticles();
  drawProjectiles();
  drawDomeOverlay();
  drawFireflies();
  drawMinimap();
  updateResourcesUI();

  requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);
