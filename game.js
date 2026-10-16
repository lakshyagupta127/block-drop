// ═══════════════════════════════════════════════
//  BLOCK DROP — Game Logic
//  Sounds · Haptics · Touch · Secure API · i18n
//  Onboarding · Tutorial · Hints
// ═══════════════════════════════════════════════

// ── Constants ──────────────────────────────────
const COLS  = 10;
const ROWS  = 20;
const BLOCK = 30;

const COLORS = {
  I:'#00e5ff', O:'#ffe600', T:'#b800ff',
  S:'#39ff14', Z:'#ff1744', J:'#2979ff', L:'#ff9100',
};

const SHAPES = {
  I:[[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
  O:[[1,1],[1,1]],
  T:[[0,1,0],[1,1,1],[0,0,0]],
  S:[[0,1,1],[1,1,0],[0,0,0]],
  Z:[[1,1,0],[0,1,1],[0,0,0]],
  J:[[1,0,0],[1,1,1],[0,0,0]],
  L:[[0,0,1],[1,1,1],[0,0,0]],
};

const PIECE_KEYS  = Object.keys(SHAPES);
const LINE_SCORES = [0, 100, 300, 500, 800];

// ── DOM ────────────────────────────────────────
const canvas     = document.getElementById('gameCanvas');
const ctx        = canvas.getContext('2d');
const nextCanvas = document.getElementById('nextCanvas');
const nextCtx    = nextCanvas ? nextCanvas.getContext('2d') : null;
const overlay    = document.getElementById('overlay');

const scoreEls = ['scoreDisplay','scoreDisplay2'].map(id=>document.getElementById(id)).filter(Boolean);
const levelEls = ['levelDisplay','levelDisplay2'].map(id=>document.getElementById(id)).filter(Boolean);
const linesEls = ['linesDisplay','linesDisplay2'].map(id=>document.getElementById(id)).filter(Boolean);

// Apply High-DPI scaling (capped at 2 to ensure 60-120fps on mobile without GPU fill-rate lag)
function applyHighDPI() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  document.querySelectorAll('canvas').forEach(cvs => {
    const w = parseInt(cvs.getAttribute('width'));
    const h = parseInt(cvs.getAttribute('height'));
    if(!w || !h) return;
    cvs.width = w * dpr;
    cvs.height = h * dpr;
    cvs.getContext('2d').scale(dpr, dpr);
  });
}
applyHighDPI();

// Lock orientation to portrait where supported and auto-pause on landscape
function lockPortrait() {
  try {
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('portrait').catch(() => {});
    }
  } catch (_) {}
}
lockPortrait();
document.addEventListener('touchstart', lockPortrait, { once: true, passive: true });
window.addEventListener('resize', () => {
  if (window.innerWidth > window.innerHeight && window.innerHeight <= 550) {
    if (typeof gameRunning !== 'undefined' && gameRunning && !paused) togglePause();
  }
});

// ── Audio ──────────────────────────────────────
let audioCtx = null;
function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playTone(freq, duration, type='square', gainVal=0.18, startOffset=0) {
  try {
    const ac=getAudio(), osc=ac.createOscillator(), env=ac.createGain();
    osc.connect(env); env.connect(ac.destination);
    osc.type=type;
    osc.frequency.setValueAtTime(freq, ac.currentTime+startOffset);
    env.gain.setValueAtTime(0, ac.currentTime+startOffset);
    env.gain.linearRampToValueAtTime(gainVal, ac.currentTime+startOffset+0.01);
    env.gain.exponentialRampToValueAtTime(0.001, ac.currentTime+startOffset+duration);
    osc.start(ac.currentTime+startOffset);
    osc.stop(ac.currentTime+startOffset+duration+0.05);
  } catch(_){}
}

const SFX = {
  move()    { playTone(220,0.04,'square',0.10); },
  rotate()  { playTone(440,0.06,'triangle',0.14); },
  land()    { playTone(110,0.08,'square',0.18); },
  drop()    { playTone(80,0.12,'sawtooth',0.22); },
  click()   { playTone(600,0.03,'square',0.12); },
  clear(n)  { [523,659,784,1047].slice(0,n).forEach((f,i)=>playTone(f,0.12,'triangle',0.20,i*0.08)); },
  blockDrop(){ [523,659,784,1047,784,1047,1319].forEach((f,i)=>playTone(f,0.14,'triangle',0.22,i*0.10)); },
  gameOver(){ [400,320,240,160].forEach((f,i)=>playTone(f,0.18,'sawtooth',0.20,i*0.18)); },
  revive()  { [261.63, 329.63, 392.00, 523.25, 659.25, 783.99, 1046.50].forEach((f,i)=>playTone(f,0.10,'triangle',0.22,i*0.045)); },
};

// ── Haptics ────────────────────────────────────
function vibrate(p){ try{ navigator.vibrate&&navigator.vibrate(p); }catch(_){} }
const HAP = {
  move()    { vibrate(8);  },
  rotate()  { vibrate(12); },
  land()    { vibrate(20); },
  drop()    { vibrate(30); },
  clear()   { vibrate([40,20,40]); },
  blockDrop(){ vibrate([60,30,60,30,100]); },
  gameOver(){ vibrate([80,40,80,40,200]); },
  revive()  { vibrate([50,40,70]); },
};

// ── Device detection ────────────────────────────
function detectDevice() {
  const ua = navigator.userAgent;
  if (/tablet|ipad/i.test(ua)) return 'tablet';
  if (/mobile|android|iphone/i.test(ua)) return 'mobile';
  return 'desktop';
}

function isMobileDevice() {
  return window.innerWidth <= 600 || /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);
}

// ── Player Identity & Fingerprint ─────────────
const PLAYER_FP_KEY = 'bd_player_fp';

async function getFingerprint() {
  let cached = localStorage.getItem(PLAYER_FP_KEY);
  if (cached) return cached;
  const randomPart = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'usr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
  cached = randomPart;
  localStorage.setItem(PLAYER_FP_KEY, cached);
  return cached;
}

// ── Server & Offline-Resilient API Helper ──────
const SERVER_URL = 'https://block-drop.onrender.com';

function getApiUrl(path) {
  const isCapacitorNative = typeof window.Capacitor !== 'undefined' && 
    (window.Capacitor.isNativePlatform?.() || 
     window.location.protocol === 'capacitor:' || 
     window.location.protocol === 'ionic:' || 
     window.location.hostname === 'localhost' || 
     window.location.hostname === '127.0.0.1');

  const base = isCapacitorNative ? SERVER_URL : '';
  const cleanPath = path.startsWith('/') ? path : '/' + path;
  return `${base}${cleanPath}`;
}

async function apiFetch(endpoint, options = {}, timeoutMs = 5000) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('Device is offline');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = getApiUrl(endpoint);
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ── Player profile state ───────────────────────
const PLAYER_NAME_KEY = 'bd_player_name';
let _playerFp          = null;
let _playerIdFormatted = null;
let _playerName        = localStorage.getItem(PLAYER_NAME_KEY) || 'Player';
let _canChangeName     = true;
let _nextChangeAt      = null;
let _personalBest      = parseInt(localStorage.getItem('bd_best_score') || '0', 10);
let _totalGames        = 0;
let _totalLines        = 0;
let _bestLevel         = 1;
let _lastScore         = 0;
let _lastLevel         = 1;
let _lastLines         = 0;
let _lastPlayedAt      = null;
let _isReturning       = false;

async function loadPlayerProfile() {
  // 1. Immediately apply local cached data so UI is instantly ready offline
  try {
    _playerName = localStorage.getItem(PLAYER_NAME_KEY) || _playerName || 'Player';
    const savedBest = parseInt(localStorage.getItem('bd_best_score') || '0', 10);
    if (savedBest > _personalBest) _personalBest = savedBest;
    updatePlayerUI();
  } catch (_) {}

  // 2. If offline, don't attempt network fetch
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return;
  }

  // 3. Sync with backend in background
  try {
    _playerFp = await getFingerprint();
    const [profileRes, statsRes] = await Promise.all([
      apiFetch(`/api/player?fp=${encodeURIComponent(_playerFp)}`),
      apiFetch(`/api/player/stats?fp=${encodeURIComponent(_playerFp)}`),
    ]);
    const profileData = await profileRes.json();
    const statsData   = await statsRes.json();
    if (profileData.success) {
      if (profileData.name && profileData.name !== 'Player') {
        _playerName = profileData.name;
        localStorage.setItem(PLAYER_NAME_KEY, _playerName);
      }
      _canChangeName = profileData.canChangeName;
      _nextChangeAt  = profileData.nextChangeAt;
      if (profileData.playerId) {
        _playerIdFormatted = profileData.playerId;
      } else if (_playerFp) {
        _playerIdFormatted = 'BD-' + _playerFp.slice(0, 6).toUpperCase();
      }
    }
    if (statsData.success) {
      _personalBest = Math.max(_personalBest, statsData.bestScore || 0);
      localStorage.setItem('bd_best_score', _personalBest);
      _totalGames   = statsData.totalGames   || 0;
      _totalLines   = statsData.totalLines   || 0;
      _bestLevel    = statsData.bestLevel    || 1;
      _lastScore    = statsData.lastScore    || 0;
      _lastLevel    = statsData.lastLevel    || 1;
      _lastLines    = statsData.lastLines    || 0;
      _lastPlayedAt = statsData.lastPlayedAt || null;
      _isReturning  = statsData.isReturning  || false;
    }
    updatePlayerUI();
  } catch(err) {
    console.warn('Profile sync skipped (offline or server sleeping):', err?.message || err);
  }
}

function timeAgo(isoDate) {
  if (!isoDate) return '';
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins=Math.floor(diff/60000), hours=Math.floor(diff/3600000), days=Math.floor(diff/86400000);
  if (mins<1) return 'just now';
  if (mins<60) return `${mins}m ago`;
  if (hours<24) return `${hours}h ago`;
  if (days<7) return `${days}d ago`;
  return new Date(isoDate).toLocaleDateString();
}

function updatePlayerUI() {
  const nameEl = document.getElementById('playerNameDisplay');
  if (nameEl) nameEl.textContent = _playerName;

  const idEl = document.getElementById('settingsPlayerId');
  if (idEl) {
    idEl.textContent = _playerIdFormatted || (_playerFp ? 'BD-' + _playerFp.slice(0, 6).toUpperCase() : 'BD-00001');
  }

  const tagEl = document.getElementById('overlayNameTag');
  if (tagEl) {
    if (_isReturning && _playerName && _playerName !== 'Player') {
      tagEl.innerHTML = `
        <div class="player-badge-inner">
          <div class="player-badge-avatar">👤</div>
          <div class="player-badge-text">
            <span class="player-badge-sub">Welcome back,</span>
            <strong class="player-badge-name">${_playerName}!</strong>
            <span class="player-badge-id">PLAYER ID: ${_playerIdFormatted || (_playerFp ? _playerFp.slice(0, 10).toUpperCase() : 'BD_77')} | LEVEL ${_bestLevel || 1}</span>
          </div>
        </div>`;
      tagEl.className   = 'overlay-name-tag welcome-back';
    } else if (_playerName && _playerName !== 'Player') {
      tagEl.innerHTML = `
        <div class="player-badge-inner">
          <div class="player-badge-avatar">👤</div>
          <div class="player-badge-text">
            <span class="player-badge-sub">Arcade Pilot</span>
            <strong class="player-badge-name">${_playerName}</strong>
            <span class="player-badge-id">LEVEL ${_bestLevel || 1}</span>
          </div>
        </div>`;
      tagEl.className   = 'overlay-name-tag';
    } else {
      tagEl.innerHTML = `
        <div class="player-badge-inner guest-badge">
          <div class="player-badge-avatar">🎮</div>
          <div class="player-badge-text">
            <span class="player-badge-sub">Cyber Circuit</span>
            <strong class="player-badge-name">PILOT READY</strong>
            <span class="player-badge-id">LEVEL 1</span>
          </div>
        </div>`;
      tagEl.className   = 'overlay-name-tag';
    }
  }

  const pbEl = document.getElementById('overlayPersonalBest');
  if (pbEl) {
    if (_personalBest > 0) {
      let html = `
        <div class="pb-card-header">
          <span class="pb-label">HIGH SCORE:</span>
          <span class="pb-score-val">${_personalBest.toLocaleString()}</span>
        </div>
        <div class="pb-stats-grid">
          <div class="pb-stat-cell"><span class="pb-stat-lbl">GAMES PLAYED:</span><span class="pb-stat-num">${_totalGames}</span></div>
          <div class="pb-stat-cell"><span class="pb-stat-lbl">TOTAL BLOCKS:</span><span class="pb-stat-num">${_totalLines}</span></div>
          <div class="pb-stat-cell"><span class="pb-stat-lbl">BEST LEVEL:</span><span class="pb-stat-num">${_bestLevel}</span></div>
        </div>`;
      if (_lastScore > 0 && _isReturning)
        html += `<div class="pb-last">Last: ${_lastScore.toLocaleString()} — Lv.${_lastLevel} <span class="pb-ago">${timeAgo(_lastPlayedAt)}</span></div>`;
      pbEl.innerHTML = html;
      pbEl.style.display = 'block';
    } else {
      pbEl.innerHTML = `
        <div class="pb-card-header">
          <span class="pb-label">CIRCUIT STATUS:</span>
          <span class="pb-score-val init-ready">ONLINE</span>
        </div>
        <div class="pb-stats-grid">
          <div class="pb-stat-cell"><span class="pb-stat-lbl">PILOT MODE:</span><span class="pb-stat-num">CLASSIC</span></div>
          <div class="pb-stat-cell"><span class="pb-stat-lbl">SPEED CURVE:</span><span class="pb-stat-num">DYNAMIC</span></div>
          <div class="pb-stat-cell"><span class="pb-stat-lbl">SYSTEM LINK:</span><span class="pb-stat-num">READY</span></div>
        </div>`;
      pbEl.style.display = 'block';
    }
  }

  const statsEl = document.getElementById('playerStatsDisplay');
  if (statsEl) {
    if (_personalBest > 0) {
      let html =
        `<div class="stat-row"><span>🏅 Best</span><strong>${_personalBest.toLocaleString()}</strong></div>`+
        `<div class="stat-row"><span>🎮 Games</span><strong>${_totalGames}</strong></div>`+
        `<div class="stat-row"><span>📊 Lines</span><strong>${_totalLines}</strong></div>`;
      if (_lastScore > 0)
        html += `<div class="stat-row last-session"><span>🕐 Last</span><strong>${_lastScore.toLocaleString()}</strong></div>`;
      statsEl.innerHTML = html;
      statsEl.style.display = 'block';
    } else {
      statsEl.style.display = 'none';
    }
  }
}

// ── Settings Modal & Name Change ───────────────
let _isNameChangeUnlocked = false;

function unlockNameChangeField() {
  _isNameChangeUnlocked = true;
  const adWrap  = document.getElementById('nameAdWrap');
  const inpWrap = document.getElementById('nameInputWrap');
  const msgEl   = document.getElementById('settingsMsg');
  const inp     = document.getElementById('settingsNameInput');

  if (adWrap) adWrap.style.display = 'none';
  if (inpWrap) inpWrap.style.display = 'flex';
  if (msgEl) {
    msgEl.textContent = '✨ Name change unlocked! Enter your new name below.';
    msgEl.className = 'settings-msg success';
  }
  resetWatchNameAdBtn();
  if (inp) {
    inp.value = '';
    setTimeout(() => inp.focus(), 150);
  }
  AdMobManager.showNotice('✨ UNLOCKED', 'ENTER YOUR NEW DISPLAY NAME');
  if (typeof SFX !== 'undefined' && SFX.click) SFX.click();
}

function lockNameChangeField() {
  _isNameChangeUnlocked = false;
  const adWrap  = document.getElementById('nameAdWrap');
  const inpWrap = document.getElementById('nameInputWrap');
  const msgEl   = document.getElementById('settingsMsg');
  const inp     = document.getElementById('settingsNameInput');

  if (adWrap) adWrap.style.display = 'flex';
  if (inpWrap) inpWrap.style.display = 'none';
  if (inp) inp.value = '';
  if (msgEl) { msgEl.textContent = ''; msgEl.className = 'settings-msg'; }
  resetWatchNameAdBtn();
}

function resetWatchNameAdBtn() {
  const btn = document.getElementById('watchNameAdBtn');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<span class="ad-badge">AD</span> 📺 <span>Watch Ad to Change Name</span>';
  }
}

function openSettings() {
  try { SFX.click(); } catch(_) {}
  AdMobManager.showMenuBanner();
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  const curEl = document.getElementById('settingsCurrentName');
  const idEl  = document.getElementById('settingsPlayerId');
  const lock  = document.getElementById('nameCooldownNotice');
  const msgEl = document.getElementById('settingsMsg');
  if (curEl) curEl.textContent = _playerName || 'Player';
  if (idEl)  idEl.textContent  = _playerIdFormatted || (_playerFp ? 'BD-' + _playerFp.slice(0, 6).toUpperCase() : 'BD-00001');
  if (msgEl) { msgEl.textContent=''; msgEl.className='settings-msg'; }
  if (lock) lock.style.display='none';

  if (!_isNameChangeUnlocked) {
    lockNameChangeField();
  } else {
    const adWrap  = document.getElementById('nameAdWrap');
    const inpWrap = document.getElementById('nameInputWrap');
    if (adWrap) adWrap.style.display = 'none';
    if (inpWrap) inpWrap.style.display = 'flex';
  }

  modal.style.display='flex';
  modal.style.zIndex='100000';
  if (_isNameChangeUnlocked) {
    const inp = document.getElementById('settingsNameInput');
    if (inp) setTimeout(()=>inp.focus(),100);
  }
}

function closeSettings() {
  try { SFX.click(); } catch(_) {}
  const modal = document.getElementById('settingsModal');
  if (modal) modal.style.display='none';
  lockNameChangeField();
}

async function saveSettingsName() {
  const inp   = document.getElementById('settingsNameInput');
  const msgEl = document.getElementById('settingsMsg');
  const newName = (inp?.value || '').trim();
  if (!newName || newName.length < 2) {
    if (msgEl) { msgEl.textContent='Name must be at least 2 characters.'; msgEl.className='settings-msg error'; }
    inp?.focus();
    return;
  }
  if (newName.length > 20) {
    if (msgEl) { msgEl.textContent='Name cannot exceed 20 characters.'; msgEl.className='settings-msg error'; }
    inp?.focus();
    return;
  }
  if (/<|>|;|--|\/\*/.test(newName)) {
    if (msgEl) { msgEl.textContent='Invalid characters in name.'; msgEl.className='settings-msg error'; }
    inp?.focus();
    return;
  }
  if (newName === _playerName) {
    if (msgEl) { msgEl.textContent='This is already your current name.'; msgEl.className='settings-msg error'; }
    return;
  }
  if (!_playerFp) {
    if (msgEl) { msgEl.textContent='Could not identify player. Refresh and try again.'; msgEl.className='settings-msg error'; }
    return;
  }
  if (msgEl) { msgEl.textContent=''; msgEl.className='settings-msg'; }

  await commitSettingsName(newName);
}

async function commitSettingsName(newName) {
  const msgEl = document.getElementById('settingsMsg');
  const btn   = document.getElementById('saveNameBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }
  try {
    const res  = await apiFetch('/api/player/name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fp: _playerFp, name: newName })
    }, 8000);
    const data = await res.json();
    if (data.success) {
      _playerName = data.name;
      _canChangeName = true;
      if (data.playerId) _playerIdFormatted = data.playerId;
      localStorage.setItem(PLAYER_NAME_KEY, _playerName);
      updatePlayerUI();
      if (typeof SFX !== 'undefined' && SFX.clear) SFX.clear(1);
      const curEl = document.getElementById('settingsCurrentName');
      if (curEl) curEl.textContent = _playerName;
      const idEl = document.getElementById('settingsPlayerId');
      if (idEl) idEl.textContent = _playerIdFormatted || ('BD-' + _playerFp.slice(0, 6).toUpperCase());
      
      // Reset unlocked state and return to ad trigger wrap
      _isNameChangeUnlocked = false;
      const adWrap  = document.getElementById('nameAdWrap');
      const inpWrap = document.getElementById('nameInputWrap');
      if (adWrap) adWrap.style.display = 'flex';
      if (inpWrap) inpWrap.style.display = 'none';

      if (msgEl) { msgEl.textContent = '✔ Name & leaderboard scores updated!'; msgEl.className = 'settings-msg success'; }
      AdMobManager.showNotice('✔ NAME UPDATED', `Scores adapted for ${_playerName}`);
      const inp = document.getElementById('settingsNameInput');
      if (inp) inp.value = '';
    } else {
      if (msgEl) { msgEl.textContent = data.error || 'Failed to save.'; msgEl.className = 'settings-msg error'; }
    }
  } catch (err) {
    if (msgEl) { msgEl.textContent = 'Network or server error. Try again.'; msgEl.className = 'settings-msg error'; }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '✔ <span>Save New Name</span>';
    }
  }
}

// ── Secure API helpers ─────────────────────────
let _gameToken   = null;
let _gameStartTs = null;

async function fetchGameToken() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    _gameToken = null;
    return;
  }
  try {
    const res = await apiFetch('/api/game-token', {}, 4000);
    const data = await res.json();
    if (data.success) { _gameToken = data.token; _gameStartTs = Date.now(); }
  } catch(err) {
    _gameToken = null;
  }
}

async function apiFetchScores(limit=500) {
  try {
    const res = await apiFetch(`/api/scores?limit=${limit}`, {}, 6000);
    const data = await res.json();
    return data.success ? data.scores : [];
  } catch { return []; }
}

async function apiSaveScore(name, score, level, lines) {
  // Always update personal best locally first so offline play never loses score
  _personalBest = Math.max(_personalBest, score);
  try { localStorage.setItem('bd_best_score', _personalBest); } catch(_) {}

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { success: true, bestScore: _personalBest };
  }
  if (!_gameToken) await fetchGameToken();
  if (!_gameToken) return { success: false, bestScore: _personalBest, error: 'Offline score recorded' };
  try {
    const duration = _gameStartTs ? Math.floor((Date.now()-_gameStartTs)/1000) : 0;
    const res = await apiFetch('/api/scores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fp:           _playerFp,
        name, score, level, lines, duration,
        device:       detectDevice(),
        gameToken:    _gameToken,
        country_code: _playerCountry.code || '',
        country_flag: _playerCountry.flag || '',
      }),
    }, 6000);
    const data = await res.json();
    _gameToken = null;
    return data;
  } catch(err) {
    _gameToken = null;
    return { success: false, bestScore: _personalBest, error: err.message };
  }
}

async function apiClearScores() {
  try {
    const res = await apiFetch('/api/scores', { method: 'DELETE' }, 5000);
    return (await res.json()).success;
  } catch { return false; }
}

// ── Game state ─────────────────────────────────
let board, currentPiece, nextPiece;
let score, level, lines;
let gameRunning, paused, animFrame, lastDrop;

// ── Board helpers ──────────────────────────────
function createBoard() { return Array.from({length:ROWS},()=>Array(COLS).fill(0)); }

function randomPiece() {
  const key=PIECE_KEYS[Math.floor(Math.random()*PIECE_KEYS.length)];
  const shape=SHAPES[key].map(r=>[...r]);
  return {type:key,shape,color:COLORS[key],x:Math.floor(COLS/2)-Math.floor(shape[0].length/2),y:0};
}

function rotate(shape) {
  const rows=shape.length,cols=shape[0].length;
  const out=Array.from({length:cols},()=>Array(rows).fill(0));
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) out[c][rows-1-r]=shape[r][c];
  return out;
}

function isValid(shape,ox,oy) {
  for(let r=0;r<shape.length;r++)
    for(let c=0;c<shape[r].length;c++){
      if(!shape[r][c]) continue;
      const nx=ox+c,ny=oy+r;
      if(nx<0||nx>=COLS||ny>=ROWS) return false;
      if(ny>=0&&board[ny][nx]) return false;
    }
  return true;
}

function placePiece() {
  const{shape,color,x,y}=currentPiece;
  for(let r=0;r<shape.length;r++) {
    for(let c=0;c<shape[r].length;c++) {
      if(shape[r][c]&&y+r>=0) {
        board[y+r][x+c]=color;
        // Cyber particle placement burst
        if (typeof spawnCyberParticle === 'function') {
          for (let k = 0; k < 2; k++) {
            spawnCyberParticle(
              (x + c + 0.15 + Math.random() * 0.7) * BLOCK,
              (y + r) * BLOCK,
              color,
              -1.0 - Math.random() * 1.4,
              1.4 + Math.random() * 1.8,
              40 + Math.random() * 25
            );
          }
        }
      }
    }
  }
}

function clearLines() {
  let cleared=0;
  // Record which rows are being cleared for the flash effect
  const clearedRows = [];
  for(let r=ROWS-1;r>=0;r--){
    if(board[r].every(cell=>cell!==0)){
      clearedRows.push(r);
      board.splice(r,1); board.unshift(Array(COLS).fill(0));
      cleared++; r++;
    }
  }
  if(cleared>0){
    score+=(LINE_SCORES[cleared]||800)*level;
    lines+=cleared; level=Math.floor(lines/10)+1;
    updateUI();
    if(cleared===4){SFX.blockDrop();HAP.blockDrop();}
    else{SFX.clear(cleared);HAP.clear();}
    // Trigger visual effects
    fxLineClear(clearedRows, cleared);
  }
}

// ── Line Clear FX ──────────────────────────────
const fxCanvas = document.getElementById('fxCanvas');
const fxCtx    = fxCanvas ? fxCanvas.getContext('2d') : null;
let _fxParticles = [];
let _fxRaf       = null;

function fxLineClear(rows, count) {
  if (!fxCtx) return;

  // 1. Spawn particles for each cleared row
  rows.forEach(row => {
    const y = row * BLOCK + BLOCK / 2;
    for (let i = 0; i < 18; i++) {
      const x  = Math.random() * 300;
      const hue= Math.floor(Math.random() * 360);
      _fxParticles.push({
        x, y,
        vx: (Math.random() - 0.5) * 8,
        vy: (Math.random() - 1.5) * 6,
        size: 3 + Math.random() * 5,
        color: `hsl(${hue},100%,65%)`,
        alpha: 1,
        life: 1,
        decay: 0.025 + Math.random() * 0.02,
      });
    }
  });

  // 2. Flash: draw white/cyan strips over cleared rows
  fxCtx.clearRect(0, 0, 300, 600);
  rows.forEach(row => {
    const y = row * BLOCK;
    fxCtx.fillStyle = count === 4 ? 'rgba(255,220,0,0.85)' : 'rgba(0,240,240,0.75)';
    fxCtx.fillRect(0, y, 300, BLOCK);
  });

  // Flash fades in 120ms
  setTimeout(() => {
    fxCtx.clearRect(0, 0, 300, 600);
  }, 120);

  // 3. Show score popup
  fxScorePopup(count);

  // 4. BLOCK DROP celebration label
  if (count === 4) fxBlockDropLabel();

  // 5. Start particle loop if not already running
  if (!_fxRaf) _fxRaf = requestAnimationFrame(fxLoop);
}

function fxLoop() {
  if (!fxCtx) return;
  fxCtx.clearRect(0, 0, 300, 600);

  _fxParticles = _fxParticles.filter(p => p.life > 0);

  fxCtx.save();
  fxCtx.globalCompositeOperation = 'lighter';

  _fxParticles.forEach(p => {
    p.x     += p.vx;
    p.y     += p.vy;
    p.vy    += 0.18;  // gravity
    p.vx    *= 0.97;  // air friction
    p.life  -= p.decay;
    p.alpha  = Math.max(0, p.life);

    const r = p.size * p.life;
    // Outer soft glow halo
    fxCtx.globalAlpha = p.alpha * 0.4;
    fxCtx.fillStyle   = p.color;
    fxCtx.beginPath();
    fxCtx.arc(p.x, p.y, r * 1.8, 0, Math.PI * 2);
    fxCtx.fill();

    // Inner bright spark
    fxCtx.globalAlpha = p.alpha;
    fxCtx.beginPath();
    fxCtx.arc(p.x, p.y, r, 0, Math.PI * 2);
    fxCtx.fill();
  });

  fxCtx.restore();

  if (_fxParticles.length > 0) {
    _fxRaf = requestAnimationFrame(fxLoop);
  } else {
    _fxRaf = null;
    fxCtx.clearRect(0, 0, 300, 600);
  }
}

function fxScorePopup(count) {
  const wrap = canvas.parentElement;
  if (!wrap) return;

  const pts    = [0, 100, 300, 500, 800][Math.min(count, 4)] * level;
  const labels = ['','Single!','Double!','Triple!','BLOCK DROP!!!'];
  const colors = ['','#00f0f0','#00ff88','#ffcc00','#ff8800'];

  const el = document.createElement('div');
  el.className   = 'score-popup';
  el.textContent = `${labels[count]}  +${pts.toLocaleString()}`;
  el.style.color = colors[count] || '#00f0f0';
  el.style.top   = '35%';
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

function fxBlockDropLabel() {
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'blockdrop-label';
  el.textContent = 'BLOCK DROP!';
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

// ── UI ─────────────────────────────────────────
function updateUI() {
  scoreEls.forEach(el=>el.textContent=score.toLocaleString());
  levelEls.forEach(el=>el.textContent=level);
  linesEls.forEach(el=>el.textContent=lines);
  const ms=dropSpeed(), pct=Math.min(100,Math.round(((1000-ms)/(1000-80))*100));
  const hue=Math.round(120-(pct/100)*120);
  const speedEl=document.getElementById('speedDisplay');
  const speedBar=document.getElementById('speedBar');
  const speedMobEl=document.getElementById('speedDisplayMob');
  if(speedEl) speedEl.textContent=pct+'%';
  if(speedMobEl){speedMobEl.textContent='X'+Math.min(10,Math.max(1,level));}
  if(speedBar){speedBar.style.width=pct+'%';speedBar.style.background=`hsl(${hue},90%,55%)`;}
}

function showOverlay(html) { overlay.innerHTML=html; overlay.style.display='flex'; }

// ── Drawing ────────────────────────────────────
function drawCyberBlock(context,bx,by,color,alpha,bSize){
  context.save();
  const pad=1.5;
  const size=bSize-pad*2;
  const x=bx+pad, y=by+pad;

  // Dark glassy core (straight square corners)
  context.globalAlpha = alpha;
  context.fillStyle='rgba(8, 12, 22, 0.78)';
  context.fillRect(x,y,size,size);

  // Neon translucent tint (straight square corners)
  context.fillStyle=color;
  context.globalAlpha=alpha*0.38;
  context.fillRect(x,y,size,size);

  // Glowing perimeter neon stroke (zero-blur, high-speed dual pass)
  context.strokeStyle=color;
  context.lineWidth=3.5;
  context.globalAlpha=alpha*0.28;
  context.strokeRect(x,y,size,size);

  context.lineWidth=1.5;
  context.globalAlpha=alpha;
  context.strokeRect(x,y,size,size);

  // Specular reflection highlight streak
  context.fillStyle='rgba(255, 255, 255, 0.28)';
  context.fillRect(x+2,y+2,size-4,3);

  context.restore();
}

function drawBlock(context,x,y,color,alpha){
  alpha=alpha!==undefined?alpha:1;
  drawCyberBlock(context,x*BLOCK,y*BLOCK,color,alpha,BLOCK);
}

function ghostY() {
  let gy=currentPiece.y;
  while(isValid(currentPiece.shape,currentPiece.x,gy+1)) gy++;
  return gy;
}

// ── Cyber Stardust & Energy Beam System (Nano Banana Cyber VFX - High Performance) ──
const cyberParticles = [];
const MAX_CYBER_PARTICLES = 45;

const _rgbCache = {
  '#00e5ff': { r: 0, g: 229, b: 255 },
  '#ffe600': { r: 255, g: 230, b: 0 },
  '#b800ff': { r: 184, g: 0, b: 255 },
  '#39ff14': { r: 57, g: 255, b: 20 },
  '#ff1744': { r: 255, g: 23, b: 68 },
  '#2979ff': { r: 41, g: 121, b: 255 },
  '#ff9100': { r: 255, g: 145, b: 0 }
};

function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return { r: 255, g: 230, b: 0 };
  if (_rgbCache[hex]) return _rgbCache[hex];
  const h = hex.trim();
  if (h.startsWith('#')) {
    const r = parseInt(h.length === 4 ? h[1] + h[1] : h.slice(1, 3), 16) || 255;
    const g = parseInt(h.length === 4 ? h[2] + h[2] : h.slice(3, 5), 16) || 230;
    const b = parseInt(h.length === 4 ? h[3] + h[3] : h.slice(5, 7), 16) || 0;
    return (_rgbCache[hex] = { r, g, b });
  }
  return { r: 255, g: 230, b: 0 };
}

function spawnCyberParticle(x, y, color, vy, size, maxLife) {
  if (cyberParticles.length >= MAX_CYBER_PARTICLES) {
    cyberParticles.shift();
  }
  const rgb = hexToRgb(color);
  cyberParticles.push({
    x,
    y,
    vx: (Math.random() - 0.5) * 0.35,
    vy: vy !== undefined ? vy : (-0.65 - Math.random() * 0.85),
    size: size || (1.1 + Math.random() * 1.9),
    color,
    rgb,
    maxLife: maxLife || (36 + Math.random() * 30),
    life: maxLife || (36 + Math.random() * 30),
    swayAmp: 0.18 + Math.random() * 0.28,
    swayFreq: 0.05 + Math.random() * 0.07,
    swayPhase: Math.random() * 6.28,
    twinklePhase: Math.random() * 6.28,
    twinkleSpeed: 0.12 + Math.random() * 0.16
  });
}

// ── Smooth Column Change State ──
let _smoothBeamX = null;
let _smoothBeamY = null;
let _lastObservedPieceX = null;
let _lastObservedPieceId = null;
const _colAfterglow = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const _colAfterglowColor = Array(10).fill('#ffe600');
const _colAfterglowTop = Array(10).fill(20);

function drawCyberEnergyBeams(context) {
  context.save();
  context.beginPath();
  context.rect(0, 0, 300, 600);
  context.clip();

  // 1. Settled board columns energy beams
  for (let c = 0; c < COLS; c++) {
    let topR = -1;
    for (let r = 0; r < ROWS; r++) {
      if (board[r][c]) {
        topR = r;
        break;
      }
    }
    if (topR > 0) {
      const blockColor = board[topR][c];
      const rgb = hexToRgb(blockColor);
      const yStart = topR * BLOCK;
      // Fade out over 4-6 blocks upward
      const yEnd = Math.max(0, (topR - 5) * BLOCK);
      const height = yStart - yEnd;

      if (height > 0) {
        // Base column glow
        const grad = context.createLinearGradient(0, yStart, 0, yEnd);
        grad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.16)`);
        grad.addColorStop(0.4, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.07)`);
        grad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);

        context.fillStyle = grad;
        context.fillRect(c * BLOCK + 1, yEnd, BLOCK - 2, height);

        // Soft diffuse inner core
        const coreGrad = context.createLinearGradient(0, yStart, 0, yEnd);
        coreGrad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`);
        coreGrad.addColorStop(0.5, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.04)`);
        coreGrad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
        context.fillStyle = coreGrad;
        context.fillRect(c * BLOCK + 6, yEnd, BLOCK - 12, height);
      }
    }
  }

  // 2. Active falling piece energy trail & Column Change Smoothing
  if (currentPiece && currentPiece.shape) {
    if (_smoothBeamX === null || _lastObservedPieceId !== currentPiece) {
      _smoothBeamX = currentPiece.x;
      _smoothBeamY = currentPiece.y;
      _lastObservedPieceX = currentPiece.x;
      _lastObservedPieceId = currentPiece;
    } else {
      // Detect column change (Left / Right / Kick / Swipe)
      if (_lastObservedPieceX !== currentPiece.x) {
        const shift = currentPiece.x - _lastObservedPieceX;
        _lastObservedPieceX = currentPiece.x;

        // Impart lateral momentum impulse to nearby cyber particles
        const pieceCenterY = currentPiece.y * BLOCK;
        for (let i = 0; i < cyberParticles.length; i++) {
          const p = cyberParticles[i];
          if (Math.abs(p.y - pieceCenterY) < 180) {
            p.vx += shift * 0.35;
          }
        }

        // Spawn lateral transition trail sparkles
        for (let k = 0; k < 4; k++) {
          spawnCyberParticle(
            (_smoothBeamX + Math.random() * currentPiece.shape[0].length) * BLOCK,
            (currentPiece.y + Math.random() * currentPiece.shape.length) * BLOCK,
            currentPiece.color,
            -0.5 - Math.random() * 0.9,
            1.2 + Math.random() * 1.8,
            35
          );
        }
      }

      // Smooth continuous glide interpolation (32% lerp per frame = ~110ms silky glide)
      const dx = currentPiece.x - _smoothBeamX;
      const dy = currentPiece.y - _smoothBeamY;
      _smoothBeamX += dx * 0.32;
      _smoothBeamY += dy * 0.32;
      if (Math.abs(dx) < 0.003) _smoothBeamX = currentPiece.x;
      if (Math.abs(dy) < 0.003) _smoothBeamY = currentPiece.y;
    }

    // Identify occupied columns and local top row per local column
    const localTopByCol = {};
    for (let r = 0; r < currentPiece.shape.length; r++) {
      for (let c = 0; c < currentPiece.shape[r].length; c++) {
        if (currentPiece.shape[r][c]) {
          if (localTopByCol[c] === undefined || r < localTopByCol[c]) {
            localTopByCol[c] = r;
          }
          const boardCol = Math.round(currentPiece.x + c);
          if (boardCol >= 0 && boardCol < COLS) {
            _colAfterglow[boardCol] = 1.0;
            _colAfterglowColor[boardCol] = currentPiece.color;
            _colAfterglowTop[boardCol] = currentPiece.y + r;
          }
        }
      }
    }

    // 2a. Draw fading afterglow ribbon on recently vacated columns
    for (let c = 0; c < COLS; c++) {
      let isCurrent = false;
      for (const locC in localTopByCol) {
        if (Math.round(_smoothBeamX + parseInt(locC, 10)) === c) {
          isCurrent = true;
          break;
        }
      }
      if (!isCurrent) {
        _colAfterglow[c] = Math.max(0, _colAfterglow[c] - 0.075);
      }
      if (_colAfterglow[c] > 0.02) {
        const glowRgb = hexToRgb(_colAfterglowColor[c]);
        const gYStart = _colAfterglowTop[c] * BLOCK;
        const gYEnd = Math.max(0, gYStart - 6 * BLOCK);
        const gHeight = gYStart - gYEnd;
        if (gHeight > 0) {
          const gGrad = context.createLinearGradient(0, gYStart, 0, gYEnd);
          const a = _colAfterglow[c] * 0.12;
          gGrad.addColorStop(0, `rgba(${glowRgb.r}, ${glowRgb.g}, ${glowRgb.b}, ${a})`);
          gGrad.addColorStop(0.4, `rgba(${glowRgb.r}, ${glowRgb.g}, ${glowRgb.b}, ${a * 0.45})`);
          gGrad.addColorStop(1, `rgba(${glowRgb.r}, ${glowRgb.g}, ${glowRgb.b}, 0)`);
          context.fillStyle = gGrad;
          context.fillRect(c * BLOCK + 1, gYEnd, BLOCK - 2, gHeight);
        }
      }
    }

    // 2b. Draw smooth gliding active energy beams
    const rgb = hexToRgb(currentPiece.color);
    for (const locCStr in localTopByCol) {
      const locC = parseInt(locCStr, 10);
      const locR = localTopByCol[locC];
      const beamX = (_smoothBeamX + locC) * BLOCK + 1;
      const yStart = (_smoothBeamY + locR) * BLOCK;
      // Shaft extends 7 blocks upwards or to canvas top
      const yEnd = Math.max(0, yStart - 7 * BLOCK);
      const height = yStart - yEnd;

      if (height > 0) {
        // Base column glow
        const grad = context.createLinearGradient(0, yStart, 0, yEnd);
        grad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.22)`);
        grad.addColorStop(0.35, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.11)`);
        grad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);

        context.fillStyle = grad;
        context.fillRect(beamX, yEnd, BLOCK - 2, height);

        // Soft diffuse inner core
        const coreGrad = context.createLinearGradient(0, yStart, 0, yEnd);
        coreGrad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.18)`);
        coreGrad.addColorStop(0.4, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.08)`);
        coreGrad.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
        context.fillStyle = coreGrad;
        context.fillRect(beamX + 4, yEnd, BLOCK - 10, height);
      }
    }
  }

  context.restore();
}

function updateAndDrawCyberParticles(context) {
  // 1. Emit from active piece using smooth position (throttled for high FPS)
  if (currentPiece && currentPiece.shape && !paused && gameRunning && _smoothBeamX !== null) {
    if (Math.random() < 0.52) {
      const localTopByCol = {};
      for (let r = 0; r < currentPiece.shape.length; r++) {
        for (let c = 0; c < currentPiece.shape[r].length; c++) {
          if (currentPiece.shape[r][c]) {
            if (localTopByCol[c] === undefined || r < localTopByCol[c]) {
              localTopByCol[c] = r;
            }
          }
        }
      }
      const cols = Object.keys(localTopByCol);
      if (cols.length > 0) {
        const locC = parseInt(cols[Math.floor(Math.random() * cols.length)], 10);
        const locR = localTopByCol[locC];
        spawnCyberParticle(
          (_smoothBeamX + locC - 0.08 + Math.random() * 1.16) * BLOCK,
          (_smoothBeamY + locR) * BLOCK - Math.random() * 6,
          currentPiece.color,
          -0.7 - Math.random() * 0.95,
          1.1 + Math.random() * 2.0,
          38 + Math.random() * 26
        );
      }
    }
  }

  // 2. Ambient emission from top settled blocks on board
  if (!paused && gameRunning && Math.random() < 0.22) {
    const settledCols = [];
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        if (board[r][c]) {
          settledCols.push({ c, topR: r, color: board[r][c] });
          break;
        }
      }
    }
    if (settledCols.length > 0) {
      const pick = settledCols[Math.floor(Math.random() * settledCols.length)];
      spawnCyberParticle(
        (pick.c - 0.08 + Math.random() * 1.16) * BLOCK,
        pick.topR * BLOCK - Math.random() * 6,
        pick.color,
        -0.4 - Math.random() * 0.7,
        1.0 + Math.random() * 1.8,
        34 + Math.random() * 24
      );
    }
  }

  // 3. Update & Render (Zero shadowBlur - 100% GPU accelerated lighter composite)
  context.save();
  context.globalCompositeOperation = 'lighter';

  for (let i = cyberParticles.length - 1; i >= 0; i--) {
    const p = cyberParticles[i];
    if (!paused) {
      p.life--;
      if (p.life <= 0 || p.y < -10) {
        cyberParticles.splice(i, 1);
        continue;
      }
      p.swayPhase += p.swayFreq;
      p.twinklePhase += p.twinkleSpeed;
      p.x += p.vx + Math.sin(p.swayPhase) * p.swayAmp;
      p.y += p.vy;
      p.vx *= 0.94; // Air friction on lateral momentum
    }

    const progress = p.life / p.maxLife; // 1 -> 0
    const twinkle = 0.75 + 0.25 * Math.sin(p.twinklePhase);
    const alpha = Math.max(0, Math.min(1, progress * twinkle));

    // Outer soft glow halo (GPU accelerated lighter composite)
    context.fillStyle = `rgba(${p.rgb.r}, ${p.rgb.g}, ${p.rgb.b}, ${alpha * 0.32})`;
    context.beginPath();
    context.arc(p.x, p.y, p.size * 2.0, 0, 6.283);
    context.fill();

    // Core bright particle
    context.fillStyle = `rgba(${p.rgb.r}, ${p.rgb.g}, ${p.rgb.b}, ${alpha * 0.85})`;
    context.beginPath();
    context.arc(p.x, p.y, p.size, 0, 6.283);
    context.fill();

    // White glistening star core
    if (p.size >= 1.4) {
      context.fillStyle = `rgba(255, 255, 255, ${alpha * 0.95})`;
      context.beginPath();
      context.arc(p.x, p.y, p.size * 0.42, 0, 6.283);
      context.fill();
    }
  }

  context.restore();
}

function drawBoard() {
  ctx.fillStyle='#06080e';
  ctx.fillRect(0,0,300,600);

  // Single batched grid path (replaces 200 separate strokeRect calls)
  ctx.strokeStyle='rgba(0, 180, 255, 0.12)';
  ctx.lineWidth=0.75;
  ctx.beginPath();
  for(let c=1; c<COLS; c++) {
    const x = c * BLOCK;
    ctx.moveTo(x, 0); ctx.lineTo(x, 600);
  }
  for(let r=1; r<ROWS; r++) {
    const y = r * BLOCK;
    ctx.moveTo(0, y); ctx.lineTo(300, y);
  }
  ctx.stroke();

  // Cyber vertical energy beams (settled blocks + active piece)
  drawCyberEnergyBeams(ctx);

  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(board[r][c]) drawBlock(ctx,c,r,board[r][c]);
  const gy=ghostY();
  if(gy!==currentPiece.y)
    for(let r=0;r<currentPiece.shape.length;r++)
      for(let c=0;c<currentPiece.shape[r].length;c++)
        if(currentPiece.shape[r][c]) drawBlock(ctx,currentPiece.x+c,gy+r,currentPiece.color,0.25);
  for(let r=0;r<currentPiece.shape.length;r++)
    for(let c=0;c<currentPiece.shape[r].length;c++)
      if(currentPiece.shape[r][c]) drawBlock(ctx,currentPiece.x+c,currentPiece.y+r,currentPiece.color);

  // Cyber stardust & sparkle particles
  updateAndDrawCyberParticles(ctx);
}

function drawNext() {
  if (!nextCtx) return;
  const bSize=20;
  nextCtx.clearRect(0,0,100,100);
  nextCtx.fillStyle='#0b0f19'; nextCtx.fillRect(0,0,100,100);
  const s=nextPiece.shape;
  const offX=Math.floor((5-s[0].length)/2),offY=Math.floor((5-s.length)/2);
  for(let r=0;r<s.length;r++) for(let c=0;c<s[r].length;c++) if(s[r][c]){
    drawCyberBlock(nextCtx,(offX+c)*bSize,(offY+r)*bSize,nextPiece.color,1,bSize);
  }
}

// ── Piece actions ──────────────────────────────
function moveDown() {
  if(isValid(currentPiece.shape,currentPiece.x,currentPiece.y+1)){
    currentPiece.y++;
  } else {
    SFX.land(); HAP.land();
    placePiece(); clearLines(); spawnPiece();
  }
}

function hardDrop() {
  const origY = currentPiece.y;
  const targetY = ghostY();
  score+=(targetY-origY)*2; currentPiece.y=targetY;

  // Trail of sparks along hard drop descent
  if (typeof spawnCyberParticle === 'function') {
    for (let dy = origY; dy <= targetY; dy += 2) {
      for (let r = 0; r < currentPiece.shape.length; r++) {
        for (let c = 0; c < currentPiece.shape[r].length; c++) {
          if (currentPiece.shape[r][c] && Math.random() < 0.35) {
            spawnCyberParticle(
              (currentPiece.x + c + 0.15 + Math.random() * 0.7) * BLOCK,
              (dy + r + 0.5) * BLOCK,
              currentPiece.color,
              -0.8 - Math.random() * 1.2,
              1.2 + Math.random() * 1.8,
              35 + Math.random() * 25
            );
          }
        }
      }
    }
  }

  updateUI(); SFX.drop(); HAP.drop();
  placePiece(); clearLines(); spawnPiece();
  lastDrop=performance.now();
}

function tryRotate() {
  const rotated=rotate(currentPiece.shape);
  for(const kick of [0,1,-1,2,-2]){
    if(isValid(rotated,currentPiece.x+kick,currentPiece.y)){
      currentPiece.shape=rotated; currentPiece.x+=kick;
      // Rotation sparkle ring burst
      if (typeof spawnCyberParticle === 'function') {
        const cx = (currentPiece.x + rotated[0].length / 2) * BLOCK;
        const cy = (currentPiece.y + rotated.length / 2) * BLOCK;
        for (let k = 0; k < 6; k++) {
          const ang = (k / 6) * Math.PI * 2;
          spawnCyberParticle(
            cx + Math.cos(ang) * 14,
            cy + Math.sin(ang) * 14,
            currentPiece.color,
            Math.sin(ang) * 0.9 - 0.5,
            1.2 + Math.random() * 1.6,
            30
          );
        }
      }
      SFX.rotate(); HAP.rotate(); return;
    }
  }
}

function spawnPiece() {
  currentPiece=nextPiece||randomPiece();
  nextPiece=randomPiece();
  _smoothBeamX = null;
  _smoothBeamY = null;
  _lastObservedPieceId = null;
  drawNext();
  if(!isValid(currentPiece.shape,currentPiece.x,currentPiece.y)) endGame();
}

// ── Game loop ──────────────────────────────────
/**
 * Drop speed in ms per row — driven by level.
 *
 * Level  1 →  900ms  (comfortable start)
 * Level  2 →  720ms
 * Level  3 →  560ms
 * Level  4 →  420ms
 * Level  5 →  300ms
 * Level  6 →  200ms
 * Level  7 →  120ms
 * Level  8 →   65ms  ← near max
 * Level  9+ →  35ms  ← true max — very fast but still playable
 *
 * Formula: exponential decay — each level multiplies by 0.78
 * so the curve feels natural rather than linear.
 */
function dropSpeed() {
  return Math.max(35, Math.round(900 * Math.pow(0.78, level - 1)));
}

function gameLoop(ts) {
  if(!gameRunning) return;
  if(!paused){
    if(ts-lastDrop>dropSpeed()){ moveDown(); lastDrop=ts; }
    drawBoard();
  }
  animFrame=requestAnimationFrame(gameLoop);
}

// ── Revive System (10-second window on Game Over) ───────────────────
let _hasRevivedThisGame = false;
let _reviveSecondsLeft = 0;
let _reviveInterval = null;

function resetReviveState() {
  if (_reviveInterval) {
    clearInterval(_reviveInterval);
    _reviveInterval = null;
  }
  _reviveSecondsLeft = 0;
  _hasRevivedThisGame = false;
  updateReviveButtonUI('idle');
}

function startReviveCountdown() {
  if (_hasRevivedThisGame) {
    updateReviveButtonUI('used');
    return;
  }

  _reviveSecondsLeft = 10;
  updateReviveButtonUI('active');

  if (_reviveInterval) clearInterval(_reviveInterval);
  _reviveInterval = setInterval(() => {
    _reviveSecondsLeft--;
    if (_reviveSecondsLeft > 0) {
      updateReviveButtonUI('active');
      const timerSpan = document.getElementById('overlayReviveTimer');
      if (timerSpan) timerSpan.textContent = _reviveSecondsLeft;
    } else {
      expireRevive();
    }
  }, 1000);
}

function expireRevive() {
  if (_reviveInterval) {
    clearInterval(_reviveInterval);
    _reviveInterval = null;
  }
  _reviveSecondsLeft = 0;
  updateReviveButtonUI('expired');

  const overlayBtn = document.getElementById('overlayReviveBtn');
  if (overlayBtn) {
    overlayBtn.classList.add('is-expired');
    overlayBtn.disabled = true;
    overlayBtn.innerHTML = '⚡ REVIVE EXPIRED';
    setTimeout(() => {
      overlayBtn.style.transition = 'opacity 0.4s, max-height 0.4s';
      overlayBtn.style.opacity = '0';
      overlayBtn.style.maxHeight = '0';
      overlayBtn.style.padding = '0';
      overlayBtn.style.margin = '0';
      setTimeout(() => overlayBtn.remove(), 400);
    }, 1200);
  }
}

function resumeReviveCountdown() {
  if (_hasRevivedThisGame || _reviveSecondsLeft <= 0) return;
  updateReviveButtonUI('active');
  const timerSpan = document.getElementById('overlayReviveTimer');
  if (timerSpan) timerSpan.textContent = _reviveSecondsLeft;
  if (_reviveInterval) clearInterval(_reviveInterval);
  _reviveInterval = setInterval(() => {
    _reviveSecondsLeft--;
    if (_reviveSecondsLeft > 0) {
      updateReviveButtonUI('active');
      const ts = document.getElementById('overlayReviveTimer');
      if (ts) ts.textContent = _reviveSecondsLeft;
    } else {
      expireRevive();
    }
  }, 1000);
}

function updateReviveButtonUI(state) {
  const btn = document.getElementById('reviveBtn');
  const lbl = document.getElementById('reviveLabel');
  if (!btn) return;

  if (state === 'active') {
    btn.disabled = false;
    btn.classList.add('can-revive');
    btn.classList.remove('is-used', 'is-expired', 'has-free-revive');
    if (lbl) lbl.textContent = `REVIVE ${_reviveSecondsLeft}s`;
    btn.title = `Tap to revive! (${_reviveSecondsLeft}s remaining)`;
  } else if (state === 'used') {
    btn.disabled = true;
    btn.classList.remove('can-revive', 'has-free-revive');
    btn.classList.add('is-used');
    if (lbl) lbl.textContent = 'USED';
    btn.title = 'Revive already used this game';
  } else if (state === 'expired') {
    btn.disabled = true;
    btn.classList.remove('can-revive', 'has-free-revive');
    btn.classList.add('is-expired');
    if (lbl) lbl.textContent = 'EXPIRED';
    btn.title = 'Revive window expired';
  } else {
    btn.disabled = true;
    btn.classList.remove('can-revive', 'has-free-revive', 'is-used', 'is-expired');
    if (lbl) lbl.textContent = 'REVIVE';
    btn.title = 'Revive (Available for 10s on Game Over)';
  }
}

function handleReviveClick() {
  if (_hasRevivedThisGame || _reviveSecondsLeft <= 0) return;
  AdMobManager.requestReviveWithAd();
}

function showLeaderboardCongrats(rank, finalScore) {
  const modal = document.getElementById('lbCongratsModal');
  if (!modal) return;

  // Pause countdown while player views congrats window
  if (_reviveInterval) {
    clearInterval(_reviveInterval);
    _reviveInterval = null;
  }

  const rankNumEl = document.getElementById('congratsRankNum');
  const rankSubEl = document.getElementById('congratsRankSub');

  if (rankNumEl) rankNumEl.textContent = `#${rank}`;
  if (rankSubEl) {
    if (rank === 1) rankSubEl.textContent = '👑 #1 WORLD CHAMPION!';
    else if (rank <= 10) rankSubEl.textContent = '🥇 TOP 10 WORLDWIDE!';
    else if (rank <= 50) rankSubEl.textContent = '⭐ TOP 50 WORLDWIDE!';
    else if (rank <= 100) rankSubEl.textContent = '🔥 TOP 100 WORLDWIDE!';
    else rankSubEl.textContent = 'TOP 500 WORLDWIDE!';
  }

  modal.style.display = 'flex';
  modal.style.zIndex = '100002';

  try {
    if (typeof SFX !== 'undefined' && SFX.blockDrop) SFX.blockDrop();
    if (typeof HAP !== 'undefined' && HAP.blockDrop) HAP.blockDrop();
  } catch(_) {}
}

function closeCongratsModal(resumeTimer = true) {
  const modal = document.getElementById('lbCongratsModal');
  if (modal) modal.style.display = 'none';
  if (resumeTimer && !_hasRevivedThisGame && _reviveSecondsLeft > 0) {
    resumeReviveCountdown();
  }
}

// ── Interstitial & Ad Persistence Keys ──────────────
const INTERSTITIAL_COUNT_KEY = 'bd_games_since_interstitial';
const PENDING_INTERSTITIAL_KEY = 'bd_pending_interstitial';

// ── Google AdMob Controller ──
const AdMobManager = {
  appId: 'ca-app-pub-8122097857797560~6769216530',
  rewardedAdId: 'ca-app-pub-8122097857797560/7568127036',
  // Official Google Rewarded Video Test Ad Unit ID for Android
  testRewardedAdId: 'ca-app-pub-3940256099942544/5224354917',

  // Adaptive Banner Ad Unit IDs
  bannerAdId: 'ca-app-pub-8122097857797560/YOUR_BANNER_ID',
  testBannerAdId: 'ca-app-pub-3940256099942544/6300978111',
  isBannerShowing: false,

  // Full-Screen Interstitial Ad Unit IDs
  interstitialAdId: 'ca-app-pub-8122097857797560/YOUR_INTERSTITIAL_ID',
  testInterstitialAdId: 'ca-app-pub-3940256099942544/1033173712',
  isInterstitialPrepared: false,
  _onInterstitialClosed: null,
  _isShowingPendingAd: false,
  _networkInterval: null,
  _isLoadingInterstitial: false,
  _isLoadingRewarded: false,

  isInitialized: false,
  isPrepared: false,
  activeAdUnitId: null,
  adPlugin: null,
  rewardGranted: false,
  pendingAction: null,
  pendingName: null,

  hasPendingInterstitial() {
    return localStorage.getItem(PENDING_INTERSTITIAL_KEY) === 'true';
  },

  _handleInterstitialDismissed() {
    console.log('[AdMob] Interstitial dismissed. User completed ad session.');
    localStorage.removeItem(PENDING_INTERSTITIAL_KEY);
    this.isInterstitialPrepared = false;
    this._isShowingPendingAd = false;
    this.preloadInterstitial();
    if (typeof this._onInterstitialClosed === 'function') {
      const cb = this._onInterstitialClosed;
      this._onInterstitialClosed = null;
      cb();
    }
  },

  checkPendingAdOnline() {
    const isOnline = (typeof navigator === 'undefined' || navigator.onLine !== false);
    if (!isOnline) return;

    // Ensure ad units are preloaded in background once online safely without duplicate calls
    if (this.adPlugin && this.isInitialized) {
      if (!this.isInterstitialPrepared && !this._isLoadingInterstitial) {
        this.preloadInterstitial();
      }
      if (!this.isPrepared && !this._isLoadingRewarded) {
        this.preloadRewarded();
      }
      if (!this.isBannerShowing && (typeof gameRunning === 'undefined' || !gameRunning || paused)) {
        this.showMenuBanner();
      }
    }

    if (!this.hasPendingInterstitial()) return;
    if (this._isShowingPendingAd) return;

    // If game has started / is active and internet turned on:
    // Only present the ad once it has fully downloaded in background AND app is visible in foreground!
    // NEVER freeze or pause active gameplay while an ad is downloading!
    if (typeof gameRunning !== 'undefined' && gameRunning) {
      if (!this.isInterstitialPrepared) {
        // Still downloading in background; let the player keep dropping blocks smoothly!
        if (!this._isLoadingInterstitial) this.preloadInterstitial();
        return;
      }

      // Interstitial is ready in memory. Ensure app is visible before presenting.
      if (document.visibilityState !== 'visible') {
        return;
      }

      this._isShowingPendingAd = true;
      console.log('[AdMob] Game is active and ad is loaded. Presenting ad with smooth pause...');

      const wasPlaying = (typeof paused !== 'undefined' && !paused);
      if (wasPlaying) {
        paused = true;
        if (typeof stopMusic === 'function') stopMusic();
        if (typeof syncPauseBtn === 'function') syncPauseBtn();
      }

      this.showNotice('🎬 AD IN PROGRESS', 'PLEASE COMPLETE AD TO PLAY');

      // Safety timeout: if ad fails to show or hangs, automatically resume after 5s
      const safetyResumeTimer = setTimeout(() => {
        if (this._isShowingPendingAd) {
          console.warn('[AdMob] Ad display safety timeout reached; resuming game');
          this._isShowingPendingAd = false;
          if (wasPlaying && typeof gameRunning !== 'undefined' && gameRunning) {
            paused = false;
            if (typeof lastDrop !== 'undefined') lastDrop = performance.now();
            if (typeof startMusic === 'function' && typeof _musicOn !== 'undefined' && _musicOn && !_muted) {
              startMusic();
            }
            if (typeof syncPauseBtn === 'function') syncPauseBtn();
            if (typeof animFrame !== 'undefined') cancelAnimationFrame(animFrame);
            animFrame = requestAnimationFrame(gameLoop);
          }
        }
      }, 5000);

      this.showInterstitialAd(() => {
        clearTimeout(safetyResumeTimer);
        this._isShowingPendingAd = false;
        if (wasPlaying && typeof gameRunning !== 'undefined' && gameRunning) {
          paused = false;
          if (typeof lastDrop !== 'undefined') lastDrop = performance.now();
          if (typeof startMusic === 'function' && typeof _musicOn !== 'undefined' && _musicOn && !_muted) {
            startMusic();
          }
          if (typeof syncPauseBtn === 'function') syncPauseBtn();
          if (typeof animFrame !== 'undefined') cancelAnimationFrame(animFrame);
          animFrame = requestAnimationFrame(gameLoop);
        }
      });
    }
  },

  async init() {
    try {
      // Auto-heal any stuck pending flag from prior versions if user hasn't completed 4 games
      const currentGCount = parseInt(localStorage.getItem(INTERSTITIAL_COUNT_KEY) || '0', 10);
      if (currentGCount < 4) {
        localStorage.removeItem(PENDING_INTERSTITIAL_KEY);
      }
      localStorage.removeItem('bd_free_revives');
      this._isShowingPendingAd = false;

      // Allow Capacitor bridge up to 1.5 seconds to populate plugins on native launch
      for (let i = 0; i < 6; i++) {
        if (typeof window.Capacitor !== 'undefined' && window.Capacitor.Plugins && window.Capacitor.Plugins.AdMob) {
          this.adPlugin = window.Capacitor.Plugins.AdMob;
          break;
        }
        await new Promise(r => setTimeout(r, 250));
      }

      if (this.adPlugin) {
        console.log('[AdMob] Found native AdMob plugin, initializing...');
        await this.adPlugin.initialize({
          requestTrackingAuthorization: true,
          initializeForTesting: false
        });
        this.isInitialized = true;
        this.setupListeners();
        this.preloadRewarded();
        this.preloadInterstitial();

        // Show bottom adaptive banner on menu if game is not currently running
        if (typeof gameRunning === 'undefined' || !gameRunning) {
          this.showMenuBanner();
        }
        console.log('[AdMob] AdMob initialized successfully');
      } else {
        console.log('[AdMob] Running in web browser mode (direct fallback for browser testing)');
      }
    } catch (e) {
      console.warn('[AdMob] Init error:', e);
    }
  },

  showNotice(title, subtitle) {
    const wrap = canvas?.parentElement || document.body;
    const existing = document.querySelector('.ad-notice-toast');
    if (existing) existing.remove();
    const el = document.createElement('div');
    el.className = 'revive-toast ad-notice-toast';
    el.innerHTML = `<strong>${title}</strong><small>${subtitle}</small>`;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  },

  setupListeners() {
    if (!this.adPlugin) return;
    try {
      // Rewarded Video Listeners
      this.adPlugin.addListener('onRewardedVideoAdReward', () => {
        console.log('[AdMob] Rewarded completed! Action:', this.pendingAction);
        this.rewardGranted = true;
        if (this.pendingAction === 'revive') {
          triggerRevive(true);
        } else if (this.pendingAction === 'nameChangeUnlock') {
          unlockNameChangeField();
        }
      });
      this.adPlugin.addListener('onRewardedVideoAdDismissed', () => {
        console.log('[AdMob] Rewarded dismissed. Reward granted:', this.rewardGranted);
        if (!this.rewardGranted) {
          // Player dismissed without completing ad
          if (this.pendingAction === 'nameChangeUnlock') {
            this.showNotice('⚠️ AD NOT COMPLETED', 'WATCH FULL AD TO CHANGE NAME');
            const msgEl = document.getElementById('settingsMsg');
            if (msgEl) { msgEl.textContent = '⚠️ Watch full ad to unlock name change.'; msgEl.className = 'settings-msg error'; }
            resetWatchNameAdBtn();
          } else {
            this.showNotice('⚠️ AD NOT COMPLETED', 'WATCH FULL AD TO REVIVE');
            resumeReviveCountdown();
          }
        }
        this.rewardGranted = false;
        this.pendingAction = null;
        this.isPrepared = false;
        // Preload next ad in background
        this.preloadRewarded();
      });
      this.adPlugin.addListener('onRewardedVideoAdFailedToLoad', (err) => {
        console.warn('[AdMob] Rewarded failed to load event:', err);
        this.isPrepared = false;
        if (this.pendingAction === 'nameChangeUnlock') {
          this.showNotice('⚠️ AD FAILED TO LOAD', 'PLEASE CHECK NETWORK & TRY AGAIN');
          const msgEl = document.getElementById('settingsMsg');
          if (msgEl) { msgEl.textContent = '⚠️ Ad failed to load. Please try again.'; msgEl.className = 'settings-msg error'; }
          resetWatchNameAdBtn();
        }
      });

      // Interstitial Listeners (binding both standard and on-prefixed event names)
      const handleInterstitialLoaded = () => {
        console.log('[AdMob] Interstitial loaded & ready');
        this.isInterstitialPrepared = true;
      };
      this.adPlugin.addListener('interstitialAdLoaded', handleInterstitialLoaded);
      this.adPlugin.addListener('onInterstitialAdLoaded', handleInterstitialLoaded);

      const handleInterstitialShowed = () => {
        console.log('[AdMob] Interstitial showed on screen');
        // Player has entered an interstitial session; if they close the app now, flag persists
        localStorage.setItem(PENDING_INTERSTITIAL_KEY, 'true');
      };
      this.adPlugin.addListener('interstitialAdShowed', handleInterstitialShowed);
      this.adPlugin.addListener('onInterstitialAdShowed', handleInterstitialShowed);

      const handleInterstitialDismissed = () => {
        this._handleInterstitialDismissed();
      };
      this.adPlugin.addListener('interstitialAdDismissed', handleInterstitialDismissed);
      this.adPlugin.addListener('onInterstitialAdDismissed', handleInterstitialDismissed);

      const handleInterstitialFailedToLoad = (err) => {
        console.warn('[AdMob] Interstitial failed to load event:', err);
        this.isInterstitialPrepared = false;
      };
      this.adPlugin.addListener('interstitialAdFailedToLoad', handleInterstitialFailedToLoad);
      this.adPlugin.addListener('onInterstitialAdFailedToLoad', handleInterstitialFailedToLoad);

      const handleInterstitialFailedToShow = (err) => {
        console.warn('[AdMob] Interstitial failed to show event:', err);
        this.isInterstitialPrepared = false;
        this._isShowingPendingAd = false;
        localStorage.removeItem(PENDING_INTERSTITIAL_KEY);
        if (typeof this._onInterstitialClosed === 'function') {
          const cb = this._onInterstitialClosed;
          this._onInterstitialClosed = null;
          cb();
        }
      };
      this.adPlugin.addListener('interstitialAdFailedToShow', handleInterstitialFailedToShow);
      this.adPlugin.addListener('onInterstitialAdFailedToShow', handleInterstitialFailedToShow);

      // Banner Listeners (binding both standard and on-prefixed event names)
      const handleBannerLoaded = () => {
        console.log('[AdMob] Banner loaded successfully');
        this.isBannerShowing = true;
        document.body.classList.add('has-banner-ad');
        document.documentElement.style.setProperty('--banner-height', '52px');
      };
      this.adPlugin.addListener('bannerAdLoaded', handleBannerLoaded);
      this.adPlugin.addListener('onBannerAdLoaded', handleBannerLoaded);

      const handleBannerFailed = (err) => {
        console.warn('[AdMob] Banner failed to load:', err);
        this.isBannerShowing = false;
        document.body.classList.remove('has-banner-ad');
        document.documentElement.style.setProperty('--banner-height', '0px');
      };
      this.adPlugin.addListener('bannerAdFailedToLoad', handleBannerFailed);
      this.adPlugin.addListener('onBannerAdFailedToLoad', handleBannerFailed);

      // Auto-trigger pending interstitial when internet is restored
      window.addEventListener('online', () => {
        console.log('[AdMob] Network restored (online event)');
        this.checkPendingAdOnline();
      });

      // Periodic check every 1.5 seconds to reliably detect reconnection on mobile
      if (!this._networkInterval) {
        this._networkInterval = setInterval(() => {
          this.checkPendingAdOnline();
        }, 1500);
      }
    } catch (_) {}
  },

  async preloadRewarded() {
    if (!this.adPlugin || !this.isInitialized) return;
    if (this.isPrepared || this._isLoadingRewarded) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    this._isLoadingRewarded = true;
    try {
      // 1. Try production ad unit ID first
      try {
        console.log('[AdMob] Preloading production ad unit:', this.rewardedAdId);
        await this.adPlugin.prepareRewardVideoAd({
          adId: this.rewardedAdId,
          isTesting: false
        });
        this.isPrepared = true;
        this.activeAdUnitId = this.rewardedAdId;
        console.log('[AdMob] Production rewarded ad loaded & ready');
        return;
      } catch (err) {
        console.warn('[AdMob] Production ad prepare failed, trying test ad unit fallback:', err?.message || err);
      }

      // 2. Fall back to official test ad unit
      try {
        console.log('[AdMob] Preloading test ad unit:', this.testRewardedAdId);
        await this.adPlugin.prepareRewardVideoAd({
          adId: this.testRewardedAdId,
          isTesting: true
        });
        this.isPrepared = true;
        this.activeAdUnitId = this.testRewardedAdId;
        console.log('[AdMob] Test rewarded ad loaded & ready');
      } catch (err2) {
        console.warn('[AdMob] Test ad prepare also failed:', err2?.message || err2);
        this.isPrepared = false;
      }
    } finally {
      this._isLoadingRewarded = false;
    }
  },

  async preloadInterstitial() {
    if (!this.adPlugin || !this.isInitialized) return;
    if (this.isInterstitialPrepared || this._isLoadingInterstitial) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    this._isLoadingInterstitial = true;
    try {
      // 1. Try production interstitial ID if set
      if (this.interstitialAdId && !this.interstitialAdId.includes('YOUR_')) {
        try {
          console.log('[AdMob] Preloading production interstitial:', this.interstitialAdId);
          await this.adPlugin.prepareInterstitial({
            adId: this.interstitialAdId,
            isTesting: false
          });
          this.isInterstitialPrepared = true;
          console.log('[AdMob] Production interstitial ready');
          return;
        } catch (err) {
          console.warn('[AdMob] Production interstitial prepare failed, trying test fallback:', err?.message || err);
        }
      }

      // 2. Test interstitial fallback
      try {
        console.log('[AdMob] Preloading test interstitial:', this.testInterstitialAdId);
        await this.adPlugin.prepareInterstitial({
          adId: this.testInterstitialAdId,
          isTesting: true
        });
        this.isInterstitialPrepared = true;
        console.log('[AdMob] Test interstitial loaded & ready');
      } catch (err2) {
        console.warn('[AdMob] Test interstitial prepare also failed:', err2?.message || err2);
        this.isInterstitialPrepared = false;
      }
    } finally {
      this._isLoadingInterstitial = false;
    }
  },

  async showPreparedOrLoad() {
    if (!this.adPlugin) throw new Error('No AdMob plugin');

    if (!this.isPrepared) {
      console.log('[AdMob] Ad not ready yet, loading on-demand...');
      await this.preloadRewarded();
    }

    if (!this.isPrepared) {
      throw new Error('Ad could not be loaded');
    }

    await this.adPlugin.showRewardVideoAd();
  },

  async showInterstitialAd(onClosed) {
    if (!this.adPlugin || !this.isInitialized) {
      console.log('[AdMob] In web browser testing: simulated interstitial completed');
      localStorage.removeItem(PENDING_INTERSTITIAL_KEY);
      this._isShowingPendingAd = false;
      if (onClosed) onClosed();
      return;
    }

    const isOnline = (typeof navigator === 'undefined' || navigator.onLine !== false);
    if (!isOnline) {
      // Offline: do NOT show alert '⚠️ NO INTERNET: CONNECT TO INTERNET TO PLAY'
      // Keep pending flag stored so it automatically shows when internet connects
      this._isShowingPendingAd = false;
      if (onClosed) onClosed();
      return;
    }

    this._onInterstitialClosed = onClosed;
    localStorage.setItem(PENDING_INTERSTITIAL_KEY, 'true');

    if (!this.isInterstitialPrepared) {
      console.log('[AdMob] Interstitial not ready yet, quick preload attempt...');
      await this.preloadInterstitial();
      if (!this.isInterstitialPrepared) {
        await new Promise(r => setTimeout(r, 600));
      }
    }

    if (!this.isInterstitialPrepared) {
      console.warn('[AdMob] Interstitial ad not ready; continuing without blocking player');
      localStorage.removeItem(PENDING_INTERSTITIAL_KEY);
      this._isShowingPendingAd = false;
      if (typeof this._onInterstitialClosed === 'function') {
        const cb = this._onInterstitialClosed;
        this._onInterstitialClosed = null;
        cb();
      }
      return;
    }

    // Safety fallback: When the user dismisses the full-screen ad Activity and returns to the WebView,
    // ensure dismissal cleanup executes even if native plugin event is dropped or delayed
    const focusCleanup = () => {
      setTimeout(() => {
        if (this._onInterstitialClosed) {
          console.log('[AdMob] Window focus regained after ad Activity closed; ensuring dismissal cleanup');
          this._handleInterstitialDismissed();
        }
      }, 700);
      window.removeEventListener('focus', focusCleanup);
      document.removeEventListener('visibilitychange', visCleanup);
    };
    const visCleanup = () => {
      if (document.visibilityState === 'visible') {
        focusCleanup();
      }
    };
    setTimeout(() => {
      window.addEventListener('focus', focusCleanup, { once: true });
      document.addEventListener('visibilitychange', visCleanup, { once: true });
    }, 1200);

    try {
      await this.adPlugin.showInterstitial();
    } catch (err) {
      console.warn('[AdMob] Interstitial show failed:', err);
      this.isInterstitialPrepared = false;
      this._isShowingPendingAd = false;
      localStorage.removeItem(PENDING_INTERSTITIAL_KEY);
      window.removeEventListener('focus', focusCleanup);
      document.removeEventListener('visibilitychange', visCleanup);
      if (typeof this._onInterstitialClosed === 'function') {
        const cb = this._onInterstitialClosed;
        this._onInterstitialClosed = null;
        cb();
      }
    }
  },

  async showMenuBanner() {
    if (!this.adPlugin || !this.isInitialized) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (typeof gameRunning !== 'undefined' && gameRunning) return;
    if (this.isBannerShowing) return;

    // Immediately allocate space so menu bar sits cleanly above the banner
    document.body.classList.add('has-banner-ad');
    document.documentElement.style.setProperty('--banner-height', '52px');

    // 1. Try production banner ID if provided
    const prodBanner = (this.bannerAdId && !this.bannerAdId.includes('YOUR_')) ? this.bannerAdId : null;
    if (prodBanner) {
      try {
        console.log('[AdMob] Showing production adaptive banner:', prodBanner);
        await this.adPlugin.showBanner({
          adId: prodBanner,
          adSize: 'ADAPTIVE_BANNER',
          position: 'BOTTOM_CENTER',
          margin: 0,
          isTesting: false
        });
        this.isBannerShowing = true;
        return;
      } catch (err) {
        console.warn('[AdMob] Prod banner show failed, trying test banner:', err?.message || err);
      }
    }

    // 2. Test banner fallback
    try {
      console.log('[AdMob] Showing test adaptive banner:', this.testBannerAdId);
      await this.adPlugin.showBanner({
        adId: this.testBannerAdId,
        adSize: 'ADAPTIVE_BANNER',
        position: 'BOTTOM_CENTER',
        margin: 0,
        isTesting: true
      });
      this.isBannerShowing = true;
    } catch (err2) {
      console.warn('[AdMob] Test banner show failed:', err2?.message || err2);
      this.isBannerShowing = false;
      document.body.classList.remove('has-banner-ad');
      document.documentElement.style.setProperty('--banner-height', '0px');
    }
  },

  async hideBannerForGame() {
    this.isBannerShowing = false;
    document.body.classList.remove('has-banner-ad');
    document.documentElement.style.setProperty('--banner-height', '0px');
    if (!this.adPlugin) return;
    try {
      await this.adPlugin.hideBanner();
      console.log('[AdMob] Banner hidden for active gameplay');
    } catch (_) {}
  },

  async requestReviveWithAd() {
    if (_hasRevivedThisGame || _reviveSecondsLeft <= 0) return;

    // 1. Strict check: Internet connection
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.showNotice('⚠️ NO INTERNET', 'CONNECT TO INTERNET TO REVIVE');
      if (typeof SFX !== 'undefined' && SFX.collision) SFX.collision();
      return; // STRICT: DO NOT REVIVE
    }

    if (this.adPlugin && this.isInitialized) {
      this.rewardGranted = false;
      this.pendingAction = 'revive';
      this.pendingName = null;

      // Pause countdown while ad is displayed
      if (_reviveInterval) {
        clearInterval(_reviveInterval);
        _reviveInterval = null;
      }

      try {
        await this.showPreparedOrLoad();
      } catch (err) {
        console.warn('[AdMob] Ad show failed:', err);
        this.showNotice('⚠️ AD FAILED TO LOAD', 'PLEASE CHECK NETWORK & TRY AGAIN');
        if (typeof SFX !== 'undefined' && SFX.collision) SFX.collision();
        this.pendingAction = null;
        resumeReviveCountdown();
        return; // STRICT: DO NOT REVIVE
      }
    } else {
      // In web browser: if offline, already blocked above. If online, allow direct revive
      triggerRevive();
    }
  },

  async requestNameChangeUnlockWithAd() {
    // 1. Strict check: Internet connection
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.showNotice('⚠️ NO INTERNET', 'CONNECT TO INTERNET TO CHANGE NAME');
      if (typeof SFX !== 'undefined' && SFX.collision) SFX.collision();
      const msgEl = document.getElementById('settingsMsg');
      if (msgEl) { msgEl.textContent = '⚠️ Connect to internet to change name.'; msgEl.className = 'settings-msg error'; }
      return; // STRICT: DO NOT UNLOCK
    }

    const watchBtn = document.getElementById('watchNameAdBtn');
    if (watchBtn) {
      watchBtn.disabled = true;
      watchBtn.textContent = '⏳ Loading Ad…';
    }

    if (this.adPlugin && this.isInitialized) {
      this.rewardGranted = false;
      this.pendingAction = 'nameChangeUnlock';
      this.pendingName = null;

      try {
        await this.showPreparedOrLoad();
      } catch (err) {
        console.warn('[AdMob] Name change ad show failed:', err);
        this.showNotice('⚠️ AD FAILED TO LOAD', 'PLEASE CHECK NETWORK & TRY AGAIN');
        if (typeof SFX !== 'undefined' && SFX.collision) SFX.collision();
        const msgEl = document.getElementById('settingsMsg');
        if (msgEl) { msgEl.textContent = '⚠️ Ad failed to load. Please try again.'; msgEl.className = 'settings-msg error'; }
        this.pendingAction = null;
        resetWatchNameAdBtn();
        return; // STRICT: DO NOT UNLOCK
      }
    } else {
      // In web browser (non-Capacitor): unlock input directly if online
      unlockNameChangeField();
    }
  }
};

function triggerRevive(force = false) {
  if (!force && (_reviveSecondsLeft <= 0 || _hasRevivedThisGame)) return;
  if (_hasRevivedThisGame) return;

  // 1. Mark used & stop timer
  _hasRevivedThisGame = true;
  if (_reviveInterval) {
    clearInterval(_reviveInterval);
    _reviveInterval = null;
  }
  _reviveSecondsLeft = 0;
  updateReviveButtonUI('used');

  // 2. Audio & Haptics
  if (typeof SFX !== 'undefined' && SFX.revive) SFX.revive();
  if (typeof HAP !== 'undefined' && HAP.revive) HAP.revive();

  // 3. Remove all blocks in the top 40% area
  // ROWS = 20. 40% = 8 rows (rows 0 through 7)
  const top40Rows = Math.floor(ROWS * 0.4);
  for (let r = 0; r < top40Rows; r++) {
    board[r] = Array(COLS).fill(0);
  }

  // 4. Trigger visual revive sweep effect on fxCanvas
  fxReviveClear(top40Rows);

  // 5. Dismiss Game Over overlay and fallback name modal
  if (overlay) overlay.style.display = 'none';
  const nameModal = document.getElementById('nameModal');
  if (nameModal) nameModal.style.display = 'none';

  // 6. Spawn fresh piece in the cleared top area
  currentPiece = nextPiece || randomPiece();
  nextPiece = randomPiece();
  currentPiece.x = Math.floor((COLS - currentPiece.shape[0].length) / 2);
  currentPiece.y = 0;
  drawNext();

  // 7. Resume game loop
  gameRunning = true;
  paused = false;
  lastDrop = performance.now();
  cancelAnimationFrame(animFrame);
  animFrame = requestAnimationFrame(gameLoop);
  syncControlButtons();

  if (typeof _musicOn !== 'undefined' && _musicOn && !_muted && typeof startMusic === 'function') {
    startMusic();
  }

  // 8. Re-draw board
  drawBoard();

  // Request new game token for the continued run
  if (typeof fetchGameToken === 'function') {
    fetchGameToken().catch(() => {});
  }
}

function fxReviveClear(topRows) {
  if (!fxCtx) return;

  const h = topRows * BLOCK; // 8 * 30 = 240px
  fxCtx.clearRect(0, 0, 300, 600);

  // Electric laser wipe across the top 40%
  const grad = fxCtx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(255, 0, 127, 0.85)');
  grad.addColorStop(0.5, 'rgba(0, 229, 255, 0.85)');
  grad.addColorStop(1, 'rgba(118, 255, 3, 0.2)');
  fxCtx.fillStyle = grad;
  fxCtx.fillRect(0, 0, 300, h);

  // Electric particles
  for (let i = 0; i < 40; i++) {
    _fxParticles.push({
      x: Math.random() * 300,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 10,
      vy: (Math.random() - 0.5) * 8,
      size: 3 + Math.random() * 5,
      color: i % 2 === 0 ? '#ff007f' : '#00e5ff',
      alpha: 1,
      life: 1,
      decay: 0.02 + Math.random() * 0.02,
    });
  }

  if (!_fxRaf) _fxRaf = requestAnimationFrame(fxLoop);

  setTimeout(() => {
    if (fxCtx) fxCtx.clearRect(0, 0, 300, 600);
  }, 240);

  // Show floating toast on canvas
  const wrap = canvas.parentElement;
  if (wrap) {
    const el = document.createElement('div');
    el.className = 'revive-toast';
    el.innerHTML = '<span class="revive-toast-icon">⚡</span> <strong>REVIVED!</strong>';
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }
}

// ── Interstitial Triggers & Frequency Capping ────────────────────────
function shouldTriggerGameOverInterstitial() {
  const gCount = parseInt(localStorage.getItem(INTERSTITIAL_COUNT_KEY) || '0', 10);
  return gCount >= 4; // Triggers automatically every 4th or 5th game
}

function handlePlayAgainClick() {
  const isOnline = (typeof navigator === 'undefined' || navigator.onLine !== false);

  if (AdMobManager.hasPendingInterstitial()) {
    if (isOnline) {
      AdMobManager.showNotice('🎬 AD IN PROGRESS', 'PLEASE COMPLETE AD TO PLAY');
      AdMobManager.showInterstitialAd(() => {
        startGame();
      });
      return;
    } else {
      // Offline: do not show alert '⚠️ NO INTERNET: CONNECT TO INTERNET TO PLAY'
      // Allow playing locally; pending flag remains stored and will trigger when online
      console.log('[AdMob] Offline: bypassing pending block for local play, ad will trigger when online');
      startGame();
      return;
    }
  }

  // Interstitial triggers every 4th/5th game — not skipped even if player used a revive
  if (shouldTriggerGameOverInterstitial()) {
    localStorage.setItem(INTERSTITIAL_COUNT_KEY, '0');
    if (isOnline) {
      AdMobManager.showNotice('🎬 AD IN PROGRESS', 'PLEASE COMPLETE AD TO PLAY');
      AdMobManager.showInterstitialAd(() => {
        startGame();
      });
    } else {
      // Offline: store pending flag for when internet connects, and start local game immediately
      localStorage.setItem(PENDING_INTERSTITIAL_KEY, 'true');
      startGame();
    }
  } else {
    startGame();
  }
}

function handleGoMenuClick() {
  const isOnline = (typeof navigator === 'undefined' || navigator.onLine !== false);

  // Interstitial triggers every 4th/5th game — not skipped even if player used a revive
  if (shouldTriggerGameOverInterstitial()) {
    localStorage.setItem(INTERSTITIAL_COUNT_KEY, '0');
    if (isOnline) {
      AdMobManager.showNotice('🎬 AD IN PROGRESS', 'PLEASE COMPLETE AD TO PLAY');
      AdMobManager.showInterstitialAd(() => {
        returnToMenu();
      });
    } else {
      // Offline: store pending flag for when internet connects
      localStorage.setItem(PENDING_INTERSTITIAL_KEY, 'true');
      returnToMenu();
    }
  } else {
    returnToMenu();
  }
}

// ── Game flow ──────────────────────────────────
async function startGame() {
  const isOnline = (typeof navigator === 'undefined' || navigator.onLine !== false);

  // Check if player has a pending interstitial from previously closing the app
  if (AdMobManager.hasPendingInterstitial()) {
    if (isOnline) {
      AdMobManager.showNotice('🎬 AD IN PROGRESS', 'PLEASE COMPLETE AD TO PLAY');
      AdMobManager.showInterstitialAd(() => {
        startGame();
      });
      return;
    } else {
      // Offline: do not show alerts '⚠️ NO INTERNET: CONNECT TO INTERNET TO PLAY'
      // Allow local gameplay, keep pending flag active so ad shows when internet is on
      console.log('[AdMob] Offline: starting local game with pending interstitial flag active');
    }
  }

  // Hide banner during active gameplay
  AdMobManager.hideBannerForGame();

  document.body.classList.remove('in-menu');
  try{ if(audioCtx&&audioCtx.state==='suspended') audioCtx.resume(); }catch(_){}
  resetReviveState();
  board=createBoard(); score=0; level=1; lines=0;
  cyberParticles.length = 0;
  paused=false; gameRunning=true;
  updateUI();
  nextPiece=randomPiece(); spawnPiece();
  overlay.style.display='none';
  lastDrop=performance.now();
  cancelAnimationFrame(animFrame);
  animFrame=requestAnimationFrame(gameLoop);
  syncControlButtons();
  await fetchGameToken();
}

function endGame() {
  gameRunning=false; cancelAnimationFrame(animFrame);
  SFX.gameOver(); HAP.gameOver();
  stopHints();
  startReviveCountdown();
  syncControlButtons();

  // Increment games count for interstitial frequency cap (every 4th/5th game)
  const gCount = parseInt(localStorage.getItem(INTERSTITIAL_COUNT_KEY) || '0', 10) + 1;
  localStorage.setItem(INTERSTITIAL_COUNT_KEY, gCount);
  console.log(`[AdMob] Games played since last interstitial: ${gCount}`);

  // Score is auto-saved with the player's saved name — no name prompt needed
  autoSaveScore();
}

function togglePause() {
  if(!gameRunning) return;
  paused=!paused; SFX.click();
  if(paused){
    showOverlay(`
      <h2>PAUSED</h2>
      <button class="retro-btn" id="resumeBtn">▶ Resume</button>
      <button class="retro-btn secondary" id="returnMenuBtn">🏠 Return to Menu</button>
    `);
    document.getElementById('resumeBtn')?.addEventListener('click', togglePause);
    document.getElementById('returnMenuBtn')?.addEventListener('click', returnToMenu);
  } else {
    overlay.style.display='none';
    lastDrop=performance.now();
  }
  syncPauseBtn();
}

function returnToMenu() {
  SFX.click();
  resetReviveState();
  document.body.classList.add('in-menu');
  gameRunning = false;
  paused = false;
  _gameToken = null;
  cancelAnimationFrame(animFrame);
  stopHints();
  syncControlButtons();
  ctx.fillStyle = '#0a0a18';
  ctx.fillRect(0, 0, 300, 600);
  showOverlay(`
    <div class="overlay-name-tag" id="overlayNameTag"></div>
    <div class="menu-title-badge">
      <div class="menu-circuit-decor left"></div>
      <h2><span class="logo-block">BLOCK</span> <span class="logo-drop">DROP</span></h2>
      <div class="menu-circuit-decor right"></div>
    </div>
    <div class="overlay-personal-best" id="overlayPersonalBest" style="display:none"></div>
    <p class="menu-sub-hint" data-i18n="tap_to_start">Tap or press Space to start</p>
    <button class="retro-btn start-game-btn" id="startBtn" data-i18n="start_game">START GAME ▶</button>
  `);
  document.getElementById('startBtn')?.addEventListener('click', startGame);
  if (typeof applyLanguage === 'function' && typeof getSavedLang === 'function') {
    const lang = getSavedLang();
    if (lang) applyLanguage(lang);
  }
  updatePlayerUI();
  AdMobManager.showMenuBanner();
}

function syncPauseBtn() {
  const topBtn=document.getElementById('pauseBtn');
  if(!topBtn) return;
  if(paused){
    topBtn.classList.add('is-paused');
    topBtn.innerHTML='<span class="action-icon">▶</span><span class="action-label">RESUME</span>';
  } else {
    topBtn.classList.remove('is-paused');
    topBtn.innerHTML='<span class="action-icon">⏸</span><span class="action-label">PAUSE</span>';
  }
}

function syncControlButtons() {
  syncPauseBtn();
  if (gameRunning) {
    updateReviveButtonUI(_hasRevivedThisGame ? 'used' : 'idle');
  }
}

// ── Leaderboard ────────────────────────────────
async function openLB() {
  try { SFX.click(); } catch(_) {}
  AdMobManager.showMenuBanner();
  const modal=document.getElementById('lbModal');
  if (!modal) return;
  const tbody=document.getElementById('lbBody');
  if (tbody) tbody.innerHTML=`<tr><td colspan="5" style="text-align:center;color:#888;padding:16px">Loading Top 500…</td></tr>`;
  modal.style.display='flex';
  modal.style.zIndex='100000';
  try {
    const scores=await apiFetchScores(500);
    renderLBRows(scores);
  } catch(err) {
    console.error('LB fetch error:', err);
    if(tbody) tbody.innerHTML=`<tr><td colspan="5" class="no-scores">Unable to load scores right now.</td></tr>`;
  }
}

function renderLBRows(scores) {
  const tbody=document.getElementById('lbBody');
  const banner=document.getElementById('lbPlayerRankBanner');
  if (!tbody) return;

  if (!scores || !scores.length) {
    tbody.innerHTML=`<tr><td colspan="5" class="no-scores">No scores yet — play to get on the board!</td></tr>`;
    if (banner) banner.style.display = 'none';
    return;
  }

  const medals=['🥇','🥈','🥉'];
  let playerFoundRank = null;
  const currentFp = _playerFp;
  const currentName = (_playerName || '').trim().toLowerCase();

  const rowsHtml = scores.map((e, i) => {
    const rankNum = i + 1;
    const isMe = (currentFp && e.player_fp && e.player_fp === currentFp) ||
                 (e.name && e.name.trim().toLowerCase() === currentName && currentName !== 'player');

    if (isMe && playerFoundRank === null) {
      playerFoundRank = rankNum;
    }

    const rowClass = isMe ? ' class="my-score-row"' : '';
    const youTag = isMe ? ' <span class="lb-you-tag">YOU</span>' : '';

    return `
      <tr${rowClass}>
        <td>${medals[i] || rankNum}</td>
        <td>
          <div class="lb-name-cell">
            ${e.country_flag ? `<span class="lb-flag">${escHtml(e.country_flag)}</span>` : ''}
            <span>${escHtml(e.name)}</span>${youTag}
          </div>
        </td>
        <td><strong>${Number(e.score).toLocaleString()}</strong></td>
        <td>${e.level}</td>
        <td>${e.lines}</td>
      </tr>
    `;
  }).join('');

  tbody.innerHTML = rowsHtml;

  if (banner) {
    if (playerFoundRank !== null) {
      const lpbName = document.getElementById('lpbName');
      const lpbRank = document.getElementById('lpbRank');
      const lpbReward = document.getElementById('lpbRewardBadge');
      if (lpbName) lpbName.textContent = _playerName || 'Pilot';
      if (lpbRank) lpbRank.textContent = `#${playerFoundRank}`;
      if (lpbReward) lpbReward.textContent = '⭐ TOP 500';
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function closeLB() {
  try { SFX.click(); } catch(_) {}
  const modal = document.getElementById('lbModal');
  if (modal) modal.style.display='none';
}

// ── Auto score save (no name prompt — name already set in onboarding) ──
async function autoSaveScore() {
  // Use the player's saved name — fall back to 'Player' only if truly unset
  const name = (_playerName && _playerName !== 'Player') ? _playerName : null;

  // If somehow player has no name (skipped onboarding), ask once
  if (!name) {
    showNameEntry();
    return;
  }

  // Save silently in background — show game over screen immediately
  const result = await apiSaveScore(name, score, level, lines);
  if (!result.success) console.warn('Score save failed:', result.error);
  if (result.bestScore) _personalBest = Math.max(_personalBest, result.bestScore);
  else _personalBest = Math.max(_personalBest, score);
  showGameOverOverlay(result.rank || null, result.bestScore || _personalBest);

  // If internet is connected and score places on Top 500 Leaderboard, congratulate!
  if (result.success && result.rank && result.rank <= 500) {
    showLeaderboardCongrats(result.rank, score);
  }
}

// ── Name entry (fallback only — for players with no saved name) ────────
function showNameEntry() {
  const modal = document.getElementById('nameModal');
  document.getElementById('finalScoreText').textContent =
    `Score: ${score.toLocaleString()}  ·  Level ${level}  ·  ${lines} lines`;
  const inp = document.getElementById('nameInput');
  if (inp) inp.value = '';
  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('nameInput')?.focus(), 100);
}

async function saveScore() {
  const name = document.getElementById('nameInput').value.trim() || 'Player';
  if (name !== 'Player') {
    _playerName = name;
    localStorage.setItem(PLAYER_NAME_KEY, _playerName);
  }
  const btn  = document.getElementById('saveScoreBtn');
  btn.disabled = true; btn.textContent = '💾 Saving…';
  const result = await apiSaveScore(name, score, level, lines);
  document.getElementById('nameModal').style.display = 'none';
  SFX.click(); btn.disabled = false; btn.textContent = '💾 Save';
  if (!result.success) console.warn('Score save failed:', result.error);
  if (result.bestScore) _personalBest = Math.max(_personalBest, result.bestScore);
  else _personalBest = Math.max(_personalBest, score);
  showGameOverOverlay(result.rank || null, result.bestScore || _personalBest);

  if (result.success && result.rank && result.rank <= 500) {
    showLeaderboardCongrats(result.rank, score);
  }
}

function skipScore() {
  _gameToken = null;
  document.getElementById('nameModal').style.display = 'none';
  SFX.click(); showGameOverOverlay(null, _personalBest);
}

function showGameOverOverlay(rank, bestScore) {
  const best = Math.max(bestScore || 0, _personalBest || 0, score);
  const bestMsg = best > score
    ? `<p style="color:#ffd700;font-size:13px;margin:2px 0">🏅 Personal Best: <strong>${best.toLocaleString()}</strong></p>`
    : (score > 0 ? `<p style="color:#00ff88;font-size:13px;margin:2px 0">🎉 <strong>New Personal Best!</strong></p>` : '');
  const rankMsg=rank?`<p>You ranked <strong>#${rank}</strong> on the leaderboard!</p>`:'';

  const reviveBtnHtml = (!_hasRevivedThisGame && _reviveSecondsLeft > 0)
    ? `<button class="retro-btn revive-overlay-btn" id="overlayReviveBtn">⚡ REVIVE (<span id="overlayReviveTimer">${_reviveSecondsLeft}</span>s)</button>`
    : '';

  showOverlay(`
    <h2>GAME OVER</h2>
    <p class="final-score">Score: ${score.toLocaleString()}</p>
    ${bestMsg}
    <p>Level ${level} &nbsp;·&nbsp; ${lines} lines</p>
    ${rankMsg}
    ${reviveBtnHtml}
    <button class="retro-btn" id="restartBtn">▶ Play Again</button>
    <button class="retro-btn secondary" id="goLbBtn">🏆 Leaderboard</button>
    <button class="retro-btn secondary" id="goMenuBtn">🏠 Return to Menu</button>
  `);
  AdMobManager.showMenuBanner();
  document.getElementById('overlayReviveBtn')?.addEventListener('click', handleReviveClick);
  document.getElementById('restartBtn').addEventListener('click', handlePlayAgainClick);
  document.getElementById('goLbBtn').addEventListener('click', openLB);
  document.getElementById('goMenuBtn').addEventListener('click', handleGoMenuClick);
  // Refresh stats
  if(_playerFp){
    apiFetch(`/api/player/stats?fp=${encodeURIComponent(_playerFp)}`)
      .then(r=>r.json()).then(data=>{
        if(data.success){
          _personalBest=Math.max(_personalBest, data.bestScore||0);
          try{ localStorage.setItem('bd_best_score', _personalBest); }catch(_){}
          _totalGames=data.totalGames||0;
          _totalLines=data.totalLines||0;  _bestLevel=data.bestLevel||1;
          _lastScore=data.lastScore||0;    _lastLevel=data.lastLevel||1;
          _lastLines=data.lastLines||0;    _lastPlayedAt=data.lastPlayedAt||null;
          _isReturning=true;
          updatePlayerUI();
        }
      }).catch(()=>{});
  }
}

// ── Keyboard ───────────────────────────────────
document.addEventListener('keydown', e => {
  if(!gameRunning){
    if(e.code==='Space'||e.code==='Enter') startGame();
    return;
  }
  switch(e.code){
    case 'ArrowLeft':
      e.preventDefault();
      if(!paused&&isValid(currentPiece.shape,currentPiece.x-1,currentPiece.y)){
        currentPiece.x--; SFX.move(); HAP.move();
      } break;
    case 'ArrowRight':
      e.preventDefault();
      if(!paused&&isValid(currentPiece.shape,currentPiece.x+1,currentPiece.y)){
        currentPiece.x++; SFX.move(); HAP.move();
      } break;
    case 'ArrowDown':
      e.preventDefault();
      if(!paused){ moveDown(); score++; updateUI(); lastDrop=performance.now(); } break;
    case 'ArrowUp':
      e.preventDefault();
      if(!paused) tryRotate(); break;
    case 'Space':
      e.preventDefault();
      if(!paused) hardDrop(); break;
    case 'KeyP': togglePause(); break;
  }
});

// ── Touch buttons ──────────────────────────────
function bindTouchBtn(id,action){
  const el=document.getElementById(id); if(!el) return;
  function fire(e){
    e.preventDefault();
    if(!gameRunning||paused) return;
    el.classList.add('pressed');
    setTimeout(()=>el.classList.remove('pressed'),120);
    action();
  }
  el.addEventListener('touchstart',fire,{passive:false});
  el.addEventListener('mousedown',fire);
}
bindTouchBtn('btnLeft',  ()=>{ if(isValid(currentPiece.shape,currentPiece.x-1,currentPiece.y)){currentPiece.x--;SFX.move();HAP.move();} });
bindTouchBtn('btnRight', ()=>{ if(isValid(currentPiece.shape,currentPiece.x+1,currentPiece.y)){currentPiece.x++;SFX.move();HAP.move();} });
bindTouchBtn('btnRotate',()=>tryRotate());
bindTouchBtn('btnRotate2',()=>tryRotate());
bindTouchBtn('btnDown',  ()=>{ moveDown(); score++; updateUI(); lastDrop=performance.now(); });
bindTouchBtn('btnDrop',  ()=>hardDrop());

// ── Swipe gestures ─────────────────────────────
(function setupSwipe(){
  let tx0,ty0,t0; const THRESH=30;
  canvas.addEventListener('touchstart',e=>{const t=e.touches[0];tx0=t.clientX;ty0=t.clientY;t0=Date.now();},{passive:true});
  canvas.addEventListener('touchend',e=>{
    if(!gameRunning||paused) return;
    const t=e.changedTouches[0],dx=t.clientX-tx0,dy=t.clientY-ty0,dt=Date.now()-t0;
    if(Math.abs(dx)<10&&Math.abs(dy)<10&&dt<250){tryRotate();return;}
    if(Math.abs(dx)>Math.abs(dy)){
      if(Math.abs(dx)<THRESH) return;
      if(dx<0&&isValid(currentPiece.shape,currentPiece.x-1,currentPiece.y)){currentPiece.x--;SFX.move();HAP.move();}
      else if(dx>0&&isValid(currentPiece.shape,currentPiece.x+1,currentPiece.y)){currentPiece.x++;SFX.move();HAP.move();}
    } else {
      if(Math.abs(dy)<THRESH) return;
      if(dy>0) hardDrop(); else tryRotate();
    }
  },{passive:true});
})();

// ── Button wiring ──────────────────────────────
['leaderboardBtn','leaderboardBtn2','overlayLbBtn','menuNavLb'].forEach(id=>document.getElementById(id)?.addEventListener('click',openLB));
document.getElementById('closeLbBtn')?.addEventListener('click',closeLB);
document.getElementById('clearLbBtn')?.addEventListener('click',()=>alert('Score management is only available in the admin panel.'));
document.getElementById('saveScoreBtn')?.addEventListener('click',saveScore);
document.getElementById('skipScoreBtn')?.addEventListener('click',skipScore);
document.getElementById('nameInput')?.addEventListener('keydown',e=>{if(e.key==='Enter')saveScore();});
['startBtn','menuNavPlay'].forEach(id=>document.getElementById(id)?.addEventListener('click',startGame));

// Touch pause/start
function bindTouchBtnPause(id,action){
  const el=document.getElementById(id); if(!el) return;
  function fire(e){ e.preventDefault(); el.classList.add('pressed'); setTimeout(()=>el.classList.remove('pressed'),120); action(); }
  el.addEventListener('touchstart',fire,{passive:false});
  el.addEventListener('mousedown',fire);
}
document.getElementById('pauseBtn')?.addEventListener('click',()=>{ SFX.click(); if(!gameRunning) return; togglePause(); });
document.getElementById('restartTopBtn')?.addEventListener('click',()=>{ SFX.click(); startGame(); });

// ── Volume & Music Controller ──────────────────
const VOLUME_KEY  = 'bd_sfx_vol';
const MUSIC_KEY   = 'bd_music_vol';
const MUTE_KEY    = 'bd_muted';
const MUSIC_ON_KEY= 'bd_music_on';

let _sfxVolume    = parseFloat(localStorage.getItem(VOLUME_KEY)  ?? '0.8');
let _musicVolume  = parseFloat(localStorage.getItem(MUSIC_KEY)   ?? '0.5');
let _muted        = localStorage.getItem(MUTE_KEY)    === 'true';
let _musicOn      = localStorage.getItem(MUSIC_ON_KEY) !== 'false';
let _musicNode    = null;
let _musicGain    = null;

function playToneScaled(freq,duration,type='square',gainVal=0.18,startOffset=0){
  const scaled=gainVal*(_muted?0:_sfxVolume);
  if(scaled<=0) return;
  try{
    const ac=getAudio(),osc=ac.createOscillator(),env=ac.createGain();
    osc.connect(env); env.connect(ac.destination);
    osc.type=type;
    osc.frequency.setValueAtTime(freq,ac.currentTime+startOffset);
    env.gain.setValueAtTime(0,ac.currentTime+startOffset);
    env.gain.linearRampToValueAtTime(scaled,ac.currentTime+startOffset+0.01);
    env.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+startOffset+duration);
    osc.start(ac.currentTime+startOffset);
    osc.stop(ac.currentTime+startOffset+duration+0.05);
  }catch(_){}
}

SFX.move    = ()  => playToneScaled(220,0.04,'square',0.10);
SFX.rotate  = ()  => playToneScaled(440,0.06,'triangle',0.14);
SFX.land    = ()  => playToneScaled(110,0.08,'square',0.18);
SFX.drop    = ()  => playToneScaled(80,0.12,'sawtooth',0.22);
SFX.click   = ()  => playToneScaled(600,0.03,'square',0.12);
SFX.blockDrop = ()  => [523,659,784,1047,784,1047,1319].forEach((f,i)=>playToneScaled(f,0.14,'triangle',0.22,i*0.10));
SFX.gameOver  = ()  => [400,320,240,160].forEach((f,i)=>playToneScaled(f,0.18,'sawtooth',0.20,i*0.18));

function startMusic(){
  if(!_musicOn||_muted) return;
  stopMusic();
  try{
    const ac=getAudio();
    if(ac.state==='suspended') ac.resume();
    _musicGain=ac.createGain();
    _musicGain.gain.value=_musicVolume*0.3;
    _musicGain.connect(ac.destination);
    const notes=[65.41,82.41,98.00,123.47];
    notes.forEach((freq,i)=>{
      const osc=ac.createOscillator(),env=ac.createGain();
      osc.connect(env); env.connect(_musicGain);
      osc.type='triangle'; osc.frequency.value=freq;
      const interval=0.5, start=ac.currentTime+i*0.125;
      for(let t=0;t<3600;t++){
        const time=start+t*interval*notes.length;
        env.gain.setValueAtTime(0,time);
        env.gain.linearRampToValueAtTime(0.6,time+0.02);
        env.gain.exponentialRampToValueAtTime(0.001,time+interval*0.8);
      }
      osc.start(start); osc.stop(start+3600*interval*notes.length);
      if(!_musicNode) _musicNode=[];
      _musicNode.push(osc);
    });
  }catch(_){}
}

function stopMusic(){
  if(_musicNode){ _musicNode.forEach(n=>{try{n.stop();}catch(_){}});_musicNode=null; }
  if(_musicGain){ try{_musicGain.disconnect();}catch(_){} _musicGain=null; }
}

function updateMusicVolume(){
  if(_musicGain) _musicGain.gain.value=(_muted||!_musicOn)?0:_musicVolume*0.3;
}

function setSliderFill(slider,pct){ if(slider) slider.style.setProperty('--val',pct+'%'); }

let _volumeUIBound = false;
function initVolumeUI(){
  const sfxSlider=document.getElementById('sfxSlider');
  const musicSlider=document.getElementById('musicSlider');
  const sfxPct=document.getElementById('sfxPct');
  const musicPct=document.getElementById('musicPct');
  const musicBtn=document.getElementById('musicToggleBtn');

  _muted = false;

  if(sfxSlider) {
    sfxSlider.value=Math.round(_sfxVolume*100);
    setSliderFill(sfxSlider,Math.round(_sfxVolume*100));
  }
  if(musicSlider) {
    musicSlider.value=Math.round(_musicVolume*100);
    setSliderFill(musicSlider,Math.round(_musicVolume*100));
  }
  if(sfxPct) sfxPct.textContent=Math.round(_sfxVolume*100)+'%';
  if(musicPct) musicPct.textContent=Math.round(_musicVolume*100)+'%';
  if(musicBtn){
    musicBtn.classList.toggle('active',_musicOn);
    musicBtn.textContent=_musicOn?'🎵 Music On':'🎵 Music Off';
  }

  if(_volumeUIBound) return;
  _volumeUIBound = true;

  sfxSlider?.addEventListener('input',()=>{
    _sfxVolume=sfxSlider.value/100; localStorage.setItem(VOLUME_KEY,_sfxVolume);
    if(sfxPct) sfxPct.textContent=sfxSlider.value+'%';
    setSliderFill(sfxSlider,sfxSlider.value);
    SFX.click();
  });
  musicSlider?.addEventListener('input',()=>{
    _musicVolume=musicSlider.value/100; localStorage.setItem(MUSIC_KEY,_musicVolume);
    if(musicPct) musicPct.textContent=musicSlider.value+'%';
    setSliderFill(musicSlider,musicSlider.value);
    updateMusicVolume();
  });
  musicBtn?.addEventListener('click',()=>{
    _musicOn=!_musicOn; localStorage.setItem(MUSIC_ON_KEY,_musicOn);
    musicBtn.classList.toggle('active',_musicOn);
    musicBtn.textContent=_musicOn?'🎵 Music On':'🎵 Music Off';
    if(_musicOn) startMusic(); else stopMusic();
  });
}

function openSettingsAndInit(){
  try { initVolumeUI(); } catch(e){ console.warn('initVolumeUI error:', e); }
  openSettings();
}

['settingsBtnMob','settingsBtn2','overlaySettingsBtn','menuNavSettings'].forEach(id=>document.getElementById(id)?.addEventListener('click',openSettingsAndInit));
document.getElementById('closeSettingsBtn')?.addEventListener('click',closeSettings);
document.getElementById('watchNameAdBtn')?.addEventListener('click',() => AdMobManager.requestNameChangeUnlockWithAd());
document.getElementById('cancelNameChangeBtn')?.addEventListener('click',lockNameChangeField);
document.getElementById('saveNameBtn')?.addEventListener('click',saveSettingsName);
document.getElementById('settingsNameInput')?.addEventListener('keydown',e=>{ if(e.key==='Enter') saveSettingsName(); });

// Global event delegation guaranteeing all modal open/close actions fire
document.addEventListener('click', (e) => {
  const restartClick = e.target.closest('#restartBtn');
  if (restartClick) {
    e.preventDefault();
    handlePlayAgainClick();
    return;
  }
  const goMenuClick = e.target.closest('#goMenuBtn');
  if (goMenuClick) {
    e.preventDefault();
    handleGoMenuClick();
    return;
  }
  const reviveClick = e.target.closest('#overlayReviveBtn, #reviveBtn');
  if (reviveClick) {
    e.preventDefault();
    handleReviveClick();
    return;
  }
  const congratsClaim = e.target.closest('#congratsClaimBtn');
  if (congratsClaim) {
    e.preventDefault();
    closeCongratsModal(true);
    return;
  }
  const congratsViewLb = e.target.closest('#congratsViewLbBtn');
  if (congratsViewLb) {
    e.preventDefault();
    closeCongratsModal(false);
    openLB();
    return;
  }
  const lbBtn = e.target.closest('#overlayLbBtn, #menuNavLb, #leaderboardBtn, #leaderboardBtn2, #goLbBtn');
  if (lbBtn) {
    e.preventDefault();
    openLB();
    return;
  }
  const settingsBtn = e.target.closest('#overlaySettingsBtn, #menuNavSettings, #settingsBtnMob, #settingsBtn2');
  if (settingsBtn) {
    e.preventDefault();
    openSettingsAndInit();
    return;
  }
  const guideBtn = e.target.closest('#menuNavGuide, #helpBtn');
  if (guideBtn) {
    e.preventDefault();
    openHowToPlay();
    return;
  }
  const closeLb = e.target.closest('#closeLbBtn');
  if (closeLb) {
    e.preventDefault();
    closeLB();
    return;
  }
  const closeSet = e.target.closest('#closeSettingsBtn');
  if (closeSet) {
    e.preventDefault();
    closeSettings();
    return;
  }
  const watchAdBtn = e.target.closest('#watchNameAdBtn');
  if (watchAdBtn) {
    e.preventDefault();
    AdMobManager.requestNameChangeUnlockWithAd();
    return;
  }
  const cancelBtn = e.target.closest('#cancelNameChangeBtn');
  if (cancelBtn) {
    e.preventDefault();
    lockNameChangeField();
    return;
  }
  const saveName = e.target.closest('#saveNameBtn');
  if (saveName) {
    e.preventDefault();
    saveSettingsName();
    return;
  }
  if (e.target.id === 'lbCongratsModal') {
    closeCongratsModal(true);
    return;
  }
  if (e.target.id === 'lbModal') {
    closeLB();
    return;
  }
  if (e.target.id === 'settingsModal') {
    closeSettings();
    return;
  }
});

// Escape key to dismiss modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const cg = document.getElementById('lbCongratsModal');
    if (cg && cg.style.display !== 'none') { closeCongratsModal(true); return; }
    const lb = document.getElementById('lbModal');
    if (lb && lb.style.display !== 'none') { closeLB(); return; }
    const st = document.getElementById('settingsModal');
    if (st && st.style.display !== 'none') { closeSettings(); return; }
    const htp = document.getElementById('howToPlayModal');
    if (htp && htp.style.display !== 'none') { closeHowToPlay(); return; }
  }
});
document.getElementById('changeLangBtn')?.addEventListener('click',()=>{
  SFX.click();
  document.getElementById('settingsModal').style.display='none';
  openLangPicker();
  const origConfirm=document.getElementById('langConfirmBtn');
  if(origConfirm){
    origConfirm.addEventListener('click',()=>{
      setTimeout(()=>{ document.getElementById('settingsModal').style.display='flex'; },100);
    },{once:true});
  }
});

// ── Theme (Nano Banana Theme) ──
document.body.classList.add('theme-nano-banana');
try { localStorage.removeItem('bd_ui_theme'); } catch(e){}

// ── How To Play ────────────────────────────────
const HTP_KEY='bd_htp_seen';
function openHowToPlay(){
  try { SFX.click(); } catch(_) {}
  const settingsModal=document.getElementById('settingsModal');
  if(settingsModal) settingsModal.style.display='none';
  const modal=document.getElementById('howToPlayModal');
  if(modal) {
    modal.style.display='flex';
    modal.style.zIndex='100000';
  }
  if(gameRunning&&!paused) togglePause();
}
function closeHowToPlay(){
  try { SFX.click(); } catch(_) {}
  const modal=document.getElementById('howToPlayModal');
  if(modal) modal.style.display='none';
  localStorage.setItem(HTP_KEY,'true');
  if(gameRunning&&paused) togglePause();
}
['helpBtn','menuNavGuide'].forEach(id=>document.getElementById(id)?.addEventListener('click',openHowToPlay));
document.getElementById('closeHowToPlayBtn')?.addEventListener('click',closeHowToPlay);
document.getElementById('howToPlayModal')?.addEventListener('click',e=>{
  if(e.target===document.getElementById('howToPlayModal')) closeHowToPlay();
});

// ── Privacy / Data ─────────────────────────────
const AGE_CONSENT_KEY='bd_age_consent';
const GDPR_BANNER_KEY='bd_gdpr_banner';

function hasAgeConsent(){ return localStorage.getItem(AGE_CONSENT_KEY)==='true'; }

function showAgeGate(){
  const modal=document.getElementById('ageGateModal');
  const acceptBtn=document.getElementById('ageGateAcceptBtn');
  const checks=['ageConfirmCheck','consentCheck','termsCheck'];
  if(!modal) return;
  modal.style.display='flex';
  function updateBtn(){
    const allChecked=checks.every(id=>document.getElementById(id)?.checked);
    if(acceptBtn) acceptBtn.disabled=!allChecked;
  }
  checks.forEach(id=>document.getElementById(id)?.addEventListener('change',updateBtn));
  acceptBtn?.addEventListener('click',()=>{
    localStorage.setItem(AGE_CONSENT_KEY,'true');
    modal.style.display='none';
    const startBtn=document.getElementById('startBtn');
    if(startBtn) startBtn.disabled=false;
    showConsentBannerIfNeeded();
  },{once:true});
}

function showConsentBannerIfNeeded(){
  if(localStorage.getItem(GDPR_BANNER_KEY)==='dismissed') return;
  const banner=document.getElementById('consentBanner');
  if(banner) banner.style.display='flex';
  document.getElementById('consentBannerOk')?.addEventListener('click',()=>{
    localStorage.setItem(GDPR_BANNER_KEY,'dismissed');
    if(banner) banner.style.display='none';
  },{once:true});
}

function openDeleteConfirm(){ SFX.click(); document.getElementById('deleteConfirmModal').style.display='flex'; }
function closeDeleteConfirm(){ document.getElementById('deleteConfirmModal').style.display='none'; }

async function deleteAllMyData(){
  const msgEl=document.getElementById('deleteMsg');
  const btn=document.getElementById('confirmDeleteBtn');
  if(btn){ btn.disabled=true; btn.textContent='⏳ Deleting…'; }
  try{
    if(_playerFp){
      const res=await apiFetch(`/api/player/${encodeURIComponent(_playerFp)}`,{method:'DELETE'}, 6000);
      const data=await res.json();
      if(!data.success) throw new Error(data.error);
    }
    [PLAYER_FP_KEY,AGE_CONSENT_KEY,GDPR_BANNER_KEY,VOLUME_KEY,MUSIC_KEY,MUTE_KEY,MUSIC_ON_KEY,
     'bd_language','bd_demo_seen','bd_hints_seen','bd_htp_seen','bd_onboarding_done', 'bd_best_score']
     .forEach(k=>localStorage.removeItem(k));
    _playerFp=null; _playerName='Player'; _canChangeName=true; _nextChangeAt=null;
    updatePlayerUI();
    closeDeleteConfirm();
    document.getElementById('settingsModal').style.display='none';
    alert('✔ All your data has been deleted. The page will reload.');
    location.reload();
  } catch(err){
    if(msgEl){ msgEl.textContent='Delete failed: '+err.message; msgEl.className='settings-msg error'; }
    if(btn){ btn.disabled=false; btn.textContent='Yes, Delete Everything'; }
  }
}

async function exportMyData(){
  if(!_playerFp){ alert('No player data found to export.'); return; }
  try{
    const res=await apiFetch(`/api/player/${encodeURIComponent(_playerFp)}/export`, {}, 8000);
    if(!res.ok) throw new Error('Export failed');
    const blob=await res.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download='blockdrop-mydata.json'; a.click();
    URL.revokeObjectURL(url);
  } catch(err){ alert('Export failed: '+err.message); }
}

document.getElementById('deleteMyDataBtn')?.addEventListener('click',openDeleteConfirm);
document.getElementById('deleteMyDataLink')?.addEventListener('click',e=>{e.preventDefault();openDeleteConfirm();});
document.getElementById('confirmDeleteBtn')?.addEventListener('click',deleteAllMyData);
document.getElementById('cancelDeleteBtn')?.addEventListener('click',closeDeleteConfirm);
document.getElementById('exportMyDataBtn')?.addEventListener('click',exportMyData);

// ── Language Picker ────────────────────────────
let _pendingLang=null;

function buildLangGrid(){
  const grid=document.getElementById('langGrid');
  if(!grid) return;
  grid.innerHTML='';
  LANGUAGES.forEach(lang=>{
    const card=document.createElement('div');
    card.className='lang-card'; card.dataset.code=lang.code;
    card.innerHTML=`<span class="lang-flag">${lang.flag}</span><span class="lang-card-native">${lang.native}</span><span class="lang-card-en">${lang.name}</span>`;
    card.addEventListener('click',()=>{
      grid.querySelectorAll('.lang-card').forEach(c=>c.classList.remove('selected'));
      card.classList.add('selected'); _pendingLang=lang.code;
      const confirmBtn=document.getElementById('langConfirmBtn');
      if(confirmBtn){ const tObj=T[lang.code]||T.en; confirmBtn.textContent=tObj.confirm_lang||'Continue'; confirmBtn.disabled=false; }
      const sub=document.getElementById('langSubtitle');
      if(sub) sub.textContent=(T[lang.code]||T.en).choose_sub||'';
    });
    grid.appendChild(card);
  });
}

function openLangPicker(){
  buildLangGrid();
  const current=getSavedLang()||detectBrowserLang();
  const card=document.querySelector(`.lang-card[data-code="${current}"]`);
  if(card){
    card.classList.add('selected'); _pendingLang=current;
    const confirmBtn=document.getElementById('langConfirmBtn');
    if(confirmBtn){ const tObj=T[current]||T.en; confirmBtn.textContent=tObj.confirm_lang||'Continue'; confirmBtn.disabled=false; }
  }
  document.getElementById('langPickerModal').style.display='flex';
}

function confirmLang(){
  const code=_pendingLang||'en';
  applyLanguage(code);
  const langEl=document.getElementById('currentLangDisplay');
  if(langEl){ const lang=LANGUAGES.find(l=>l.code===code); if(lang) langEl.textContent=`${lang.flag} ${lang.native}`; }
  document.getElementById('langPickerModal').style.display='none';
}

document.getElementById('langConfirmBtn')?.addEventListener('click',confirmLang);

// ── Music start on game ────────────────────────
const _origStartForMusic = startGame;
window.startGame = async function startGame(){
  await _origStartForMusic.call(this);
  if(_musicOn&&!_muted) startMusic();
};
const _origEndForMusic = endGame;
window.endGame = function endGame(){
  stopMusic();
  _origEndForMusic.call(this);
};

// ── Init on page load ─────────────────────────
(function init(){
  loadSavedCountry();
  loadPlayerProfile(); // non-blocking background sync with offline cache
  document.getElementById('reviveBtn')?.addEventListener('click', handleReviveClick);
  AdMobManager.init();
})();

// ── Pause button keyboard shortcut ─────────────
document.addEventListener('keydown',e=>{ if(e.code==='KeyS'&&!gameRunning) openSettingsAndInit(); });

// ── App Lifecycle: Resume & Frame Loop Watchdog ─────────────────────────
// Guarantees game loop and audio never freeze when switching apps, toggling networks, or returning
function handleAppResume() {
  if (typeof gameRunning !== 'undefined' && gameRunning && !paused) {
    lastDrop = performance.now();
    if (typeof animFrame !== 'undefined') cancelAnimationFrame(animFrame);
    animFrame = requestAnimationFrame(gameLoop);
    try {
      if (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
    } catch (_) {}
    if (typeof _musicOn !== 'undefined' && _musicOn && !_muted && typeof startMusic === 'function') {
      startMusic();
    }
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    handleAppResume();
  }
});
window.addEventListener('focus', handleAppResume);
window.addEventListener('pageshow', handleAppResume);

// Initial button state
syncControlButtons();

// ═══════════════════════════════════════════════
//  ONBOARDING FLOW (new players only)
//  Step 1: Mobile demo  → Step 2: Name entry
//  Step 3: Legal countries → Start screen
// ═══════════════════════════════════════════════

const ONBOARDING_KEY = 'bd_onboarding_done';

function hasCompletedOnboarding(){ return !!localStorage.getItem(ONBOARDING_KEY); }

// ── STEP 1 — Mobile Demo Canvas ───────────────
// Mini Block Drop scene with animated bot + gesture hand

const OD_COLS=6, OD_ROWS=10, OD_B=16; // logical block size — canvas is css-scaled

const OD_STEPS=[
  {key:'← →',   text:'Move left & right', action:'move',     gestureFn:'gestureSwipeH', btnId:'demoBtnLeft'},
  {key:'↑ / ↻', text:'Rotate the block',  action:'rotate',   gestureFn:'gestureTap',    btnId:'demoBtnRotate'},
  {key:'▼ Soft', text:'Soft drop',        action:'softdrop', gestureFn:'gestureDown',   btnId:'demoBtnSoft'},
  {key:'⬇ Drop', text:'DROP!',            action:'harddrop', gestureFn:'gestureSwipeD', btnId:'demoBtnDrop'},
  {key:'Row = 💥','text':'Fill row → Clear!', action:'clear', gestureFn:'gestureTap',   btnId:null},
];

let _odCtx=null, _odBoard=[], _odPiece=null, _odRaf=null;
let _odStepIdx=0, _odTick=0, _odFrameCount=0;
let _odGestureTimer=null;

const OD_SHAPES=[
  [[1,1,1,1]],
  [[1,1],[1,1]],
  [[0,1,0],[1,1,1]],
  [[1,1,0],[0,1,1]],
];
const OD_COLORS=['#00f0f0','#f0f000','#a000f0','#00f000','#f00000','#0000f0','#f0a000'];

function odCreateBoard(){ return Array.from({length:OD_ROWS},()=>Array(OD_COLS).fill(0)); }

function odSpawn(){
  const shape=OD_SHAPES[Math.floor(Math.random()*OD_SHAPES.length)];
  const color=OD_COLORS[Math.floor(Math.random()*OD_COLORS.length)];
  return {shape:shape.map(r=>[...r]),color,x:Math.floor(OD_COLS/2)-Math.floor(shape[0].length/2),y:0};
}

function odIsValid(shape,ox,oy){
  for(let r=0;r<shape.length;r++) for(let c=0;c<shape[r].length;c++){
    if(!shape[r][c]) continue;
    const nx=ox+c,ny=oy+r;
    if(nx<0||nx>=OD_COLS||ny>=OD_ROWS) return false;
    if(ny>=0&&_odBoard[ny][nx]) return false;
  }
  return true;
}

function odRotateShape(shape){
  const rows=shape.length,cols=shape[0].length;
  const out=Array.from({length:cols},()=>Array(rows).fill(0));
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) out[c][rows-1-r]=shape[r][c];
  return out;
}

function odDraw(){
  if(!_odCtx||!_odPiece) return;
  const ctx=_odCtx;
  const W=OD_COLS*OD_B, H=OD_ROWS*OD_B;
  ctx.fillStyle='#0a0a18'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='rgba(255,255,255,0.05)'; ctx.lineWidth=0.5;
  for(let r=0;r<OD_ROWS;r++) for(let c=0;c<OD_COLS;c++) ctx.strokeRect(c*OD_B,r*OD_B,OD_B,OD_B);
  for(let r=0;r<OD_ROWS;r++) for(let c=0;c<OD_COLS;c++) if(_odBoard[r][c]){
    ctx.fillStyle=_odBoard[r][c];
    ctx.fillRect(c*OD_B+1,r*OD_B+1,OD_B-2,OD_B-2);
    ctx.fillStyle='rgba(255,255,255,0.18)';
    ctx.fillRect(c*OD_B+2,r*OD_B+2,OD_B-4,4);
  }
  // Ghost
  let gy=_odPiece.y;
  while(odIsValid(_odPiece.shape,_odPiece.x,gy+1)) gy++;
  for(let r=0;r<_odPiece.shape.length;r++) for(let c=0;c<_odPiece.shape[r].length;c++) if(_odPiece.shape[r][c]){
    ctx.globalAlpha=0.18; ctx.fillStyle=_odPiece.color;
    ctx.fillRect((_odPiece.x+c)*OD_B+1,(gy+r)*OD_B+1,OD_B-2,OD_B-2);
    ctx.globalAlpha=1;
  }
  // Piece
  for(let r=0;r<_odPiece.shape.length;r++) for(let c=0;c<_odPiece.shape[r].length;c++) if(_odPiece.shape[r][c]){
    ctx.fillStyle=_odPiece.color;
    ctx.fillRect((_odPiece.x+c)*OD_B+1,(_odPiece.y+r)*OD_B+1,OD_B-2,OD_B-2);
    ctx.fillStyle='rgba(255,255,255,0.2)';
    ctx.fillRect((_odPiece.x+c)*OD_B+2,(_odPiece.y+r)*OD_B+2,OD_B-4,4);
  }
}

function odHighlightBtn(btnId){
  // Flash the visual phone button
  OD_STEPS.forEach(s=>{ const el=document.getElementById(s.btnId||''); if(el) el.classList.remove('active-btn'); });
  if(btnId){ const el=document.getElementById(btnId); if(el){ el.classList.add('active-btn'); setTimeout(()=>el.classList.remove('active-btn'),400); } }
}

function odSetLabel(key,text){
  const k=document.getElementById('phoneLabelKey');
  const t=document.getElementById('phoneLabelText');
  if(k) k.textContent=key;
  if(t) t.textContent=text;
}

function odRunStep(){
  const step=OD_STEPS[_odStepIdx%OD_STEPS.length];
  const phase=_odTick%32;
  odHighlightBtn(step.btnId);
  odSetLabel(step.key,step.text);

  switch(step.action){
    case 'move':
      if(phase===5&&odIsValid(_odPiece.shape,_odPiece.x-1,_odPiece.y)) _odPiece.x--;
      if(phase===10&&odIsValid(_odPiece.shape,_odPiece.x-1,_odPiece.y)) _odPiece.x--;
      if(phase===16&&odIsValid(_odPiece.shape,_odPiece.x+1,_odPiece.y)) _odPiece.x++;
      if(phase===21&&odIsValid(_odPiece.shape,_odPiece.x+1,_odPiece.y)) _odPiece.x++;
      break;
    case 'rotate':
      if(phase===8||phase===20){ const rot=odRotateShape(_odPiece.shape); if(odIsValid(rot,_odPiece.x,_odPiece.y)) _odPiece.shape=rot; }
      break;
    case 'softdrop':
      if(phase%4===0&&odIsValid(_odPiece.shape,_odPiece.x,_odPiece.y+1)) _odPiece.y++;
      break;
    case 'harddrop':
      if(phase===6){ while(odIsValid(_odPiece.shape,_odPiece.x,_odPiece.y+1)) _odPiece.y++; }
      break;
    case 'clear':
      if(phase===2){ for(let c=0;c<OD_COLS;c++) if(c!==_odPiece.x) _odBoard[OD_ROWS-1][c]='#334455'; }
      if(phase%4===0&&odIsValid(_odPiece.shape,_odPiece.x,_odPiece.y+1)) _odPiece.y++;
      break;
  }

  // Auto-land
  if(!odIsValid(_odPiece.shape,_odPiece.x,_odPiece.y+1)){
    for(let r=0;r<_odPiece.shape.length;r++) for(let c=0;c<_odPiece.shape[r].length;c++)
      if(_odPiece.shape[r][c]&&_odPiece.y+r>=0) _odBoard[_odPiece.y+r][_odPiece.x+c]=_odPiece.color;
    // Clear full rows
    for(let r=OD_ROWS-1;r>=0;r--){ if(_odBoard[r].every(c=>c!==0)){ _odBoard.splice(r,1); _odBoard.unshift(Array(OD_COLS).fill(0)); r++; } }
    _odPiece=odSpawn(); _odTick=0;
    _odStepIdx++;
    if(_odStepIdx%OD_STEPS.length===0) _odBoard=odCreateBoard(); // reset every cycle
    return;
  }
  _odTick++;
}

function odLoop(){
  _odFrameCount++;
  // Bot runs at ~8 fps; player input is handled separately in real-time
  if(!_odPlayerMode && _odFrameCount%7===0) odRunStep();
  // Auto-drop for player mode (slow gravity)
  if(_odPlayerMode){
    _odPlayerDropTick++;
    if(_odPlayerDropTick >= _odPlayerDropInterval){
      _odPlayerDropTick = 0;
      if(odIsValid(_odPiece.shape,_odPiece.x,_odPiece.y+1)){
        _odPiece.y++;
      } else {
        odLandPiece();
      }
    }
  }
  odDraw();
  _odRaf=requestAnimationFrame(odLoop);
}

// ── Player mode state ──────────────────────────
let _odPlayerMode      = false;   // false = bot, true = player
let _odPlayerScore     = 0;
let _odPlayerLines     = 0;
let _odPlayerDropTick  = 0;
const _odPlayerDropInterval = 45; // frames between auto-drops (~0.75s at 60fps)

function odLandPiece(){
  // Place piece on board
  for(let r=0;r<_odPiece.shape.length;r++)
    for(let c=0;c<_odPiece.shape[r].length;c++)
      if(_odPiece.shape[r][c]&&_odPiece.y+r>=0)
        _odBoard[_odPiece.y+r][_odPiece.x+c]=_odPiece.color;

  // Clear lines + score
  let cleared=0;
  for(let r=OD_ROWS-1;r>=0;r--){
    if(_odBoard[r].every(c=>c!==0)){
      _odBoard.splice(r,1); _odBoard.unshift(Array(OD_COLS).fill(0));
      cleared++; r++;
    }
  }
  if(cleared>0){
    _odPlayerLines += cleared;
    _odPlayerScore += [0,100,300,500,800][Math.min(cleared,4)];
    odUpdateScoreUI();
    odFlashLines();
    SFX.clear(cleared);
  }

  _odPiece = odSpawn();
  _odPlayerDropTick = 0;

  // If new piece immediately invalid — board full, reset
  if(!odIsValid(_odPiece.shape,_odPiece.x,_odPiece.y)){
    _odBoard = odCreateBoard();
    _odPlayerScore = 0; _odPlayerLines = 0;
    odUpdateScoreUI();
  }
}

function odUpdateScoreUI(){
  const sEl = document.getElementById('demoScore');
  const lEl = document.getElementById('demoLines');
  if(sEl){
    sEl.textContent = _odPlayerScore.toLocaleString();
    sEl.classList.add('bump');
    setTimeout(()=>sEl.classList.remove('bump'),200);
  }
  if(lEl) lEl.textContent = _odPlayerLines;
}

function odFlashLines(){
  // Show a white flash over the canvas
  const screen = document.getElementById('demoPhoneScreen');
  if(!screen) return;
  const fl = document.createElement('div');
  fl.className='line-clear-flash';
  fl.style.top='0'; fl.style.height='100%';
  screen.appendChild(fl);
  setTimeout(()=>fl.remove(), 380);
}

// ── Switch demo to PLAYER mode ─────────────────
function odActivatePlayerMode(){
  if(_odPlayerMode) return;
  _odPlayerMode = true;
  _odPlayerScore = 0; _odPlayerLines = 0;
  _odPlayerDropTick = 0;
  _odBoard = odCreateBoard();
  _odPiece = odSpawn();
  odUpdateScoreUI();

  // Update badge and label
  const badge = document.getElementById('demoModeBadge');
  if(badge){ badge.textContent='🎮 Your turn!'; badge.classList.add('player-mode'); }
  const screen = document.getElementById('demoPhoneScreen');
  if(screen) screen.classList.add('player-active');
  odSetLabel('← ↻ →','You are playing!');
  odSetLabel('← ↻ →','You are playing!');
}

function startOnboardDemo(){
  const canvas=document.getElementById('onboardDemoCanvas');
  if(!canvas) return;
  _odCtx=canvas.getContext('2d');
  _odBoard=odCreateBoard();
  _odPiece=odSpawn();
  _odStepIdx=0; _odTick=0; _odFrameCount=0;
  _odPlayerMode=false; _odPlayerScore=0; _odPlayerLines=0; _odPlayerDropTick=0;
  odSetLabel(OD_STEPS[0].key,OD_STEPS[0].text);

  // Reset badge
  const badge=document.getElementById('demoModeBadge');
  if(badge){ badge.textContent='🤖 Bot playing…'; badge.classList.remove('player-mode'); }
  const screen=document.getElementById('demoPhoneScreen');
  if(screen) screen.classList.remove('player-active');

  if(_odRaf) cancelAnimationFrame(_odRaf);
  _odRaf=requestAnimationFrame(odLoop);

  // After 6 seconds bot demo → hand over to player
  setTimeout(()=>{
    if(_odRaf) odActivatePlayerMode();
  }, 6000);
}

function stopOnboardDemo(){
  if(_odRaf){ cancelAnimationFrame(_odRaf); _odRaf=null; }
}

// ── Wire interactive demo buttons ──────────────
function odBindDemoBtn(id, action){
  const el = document.getElementById(id);
  if(!el) return;
  function fire(e){
    e.preventDefault();
    if(!_odPlayerMode){ odActivatePlayerMode(); } // first touch activates player mode
    SFX.click();
    el.classList.add('active-btn');
    setTimeout(()=>el.classList.remove('active-btn'),150);
    action();
  }
  el.addEventListener('touchstart', fire, {passive:false});
  el.addEventListener('mousedown',  fire);
}

odBindDemoBtn('demoBtnLeft', ()=>{
  if(odIsValid(_odPiece.shape,_odPiece.x-1,_odPiece.y)){ _odPiece.x--; }
});
odBindDemoBtn('demoBtnRight',()=>{
  if(odIsValid(_odPiece.shape,_odPiece.x+1,_odPiece.y)){ _odPiece.x++; }
});
odBindDemoBtn('demoBtnRotate',()=>{
  const rot=odRotateShape(_odPiece.shape);
  for(const kick of [0,1,-1]){
    if(odIsValid(rot,_odPiece.x+kick,_odPiece.y)){
      _odPiece.shape=rot; _odPiece.x+=kick; break;
    }
  }
});
odBindDemoBtn('demoBtnSoft', ()=>{
  if(odIsValid(_odPiece.shape,_odPiece.x,_odPiece.y+1)) _odPiece.y++;
  else odLandPiece();
});
odBindDemoBtn('demoBtnDrop', ()=>{
  while(odIsValid(_odPiece.shape,_odPiece.x,_odPiece.y+1)) _odPiece.y++;
  odLandPiece();
});

// Keyboard controls also work in demo (for desktop users)
document.addEventListener('keydown', e => {
  if(document.getElementById('onboardDemoModal')?.style.display==='none') return;
  if(!_odPlayerMode && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space'].includes(e.code)){
    odActivatePlayerMode();
  }
  if(!_odPlayerMode) return;
  switch(e.code){
    case 'ArrowLeft':  e.preventDefault(); if(odIsValid(_odPiece.shape,_odPiece.x-1,_odPiece.y)) _odPiece.x--; break;
    case 'ArrowRight': e.preventDefault(); if(odIsValid(_odPiece.shape,_odPiece.x+1,_odPiece.y)) _odPiece.x++; break;
    case 'ArrowUp':    e.preventDefault(); const rot=odRotateShape(_odPiece.shape); if(odIsValid(rot,_odPiece.x,_odPiece.y)) _odPiece.shape=rot; break;
    case 'ArrowDown':  e.preventDefault(); if(odIsValid(_odPiece.shape,_odPiece.x,_odPiece.y+1)) _odPiece.y++; else odLandPiece(); break;
    case 'Space':      e.preventDefault(); while(odIsValid(_odPiece.shape,_odPiece.x,_odPiece.y+1)) _odPiece.y++; odLandPiece(); break;
  }
});

// ── STEP 2 — Mandatory name entry ─────────────
// Button stays disabled until valid name is typed

(function initNameInput(){
  const inp    = document.getElementById('onboardNameInput');
  const btn    = document.getElementById('onboardNameNextBtn');
  const msgEl  = document.getElementById('onboardNameMsg');
  const counter= document.getElementById('nameCharCounter');
  const note   = document.getElementById('name-required-note') ||
                 document.querySelector('.name-required-note');
  if(!inp || !btn) return;

  function validate(){
    const val = inp.value.trim();
    const len = val.length;

    // Character counter
    if(counter){
      counter.textContent = `${inp.value.length} / 20`;
      counter.className   = 'name-char-counter' +
        (inp.value.length >= 18 ? ' at-limit' : inp.value.length >= 15 ? ' near-limit' : '');
    }

    const valid = len >= 2 && len <= 20 && /^[a-zA-Z0-9\u0080-\uFFFF ]+$/.test(val);
    btn.disabled = !valid;

    if(note){
      if(valid){ note.textContent='✔ Name set — ready to continue!'; note.className='name-required-note valid'; }
      else      { note.textContent='⚠️ A name is required to start playing'; note.className='name-required-note'; }
    }

    if(len > 0 && len < 2 && msgEl){
      msgEl.textContent='Name must be at least 2 characters.'; msgEl.className='onboard-name-msg error';
    } else if(len > 0 && !/^[a-zA-Z0-9\u0080-\uFFFF ]+$/.test(val) && msgEl){
      msgEl.textContent='Only letters, numbers and spaces allowed.'; msgEl.className='onboard-name-msg error';
    } else if(msgEl){
      msgEl.textContent=''; msgEl.className='onboard-name-msg';
    }
  }

  inp.addEventListener('input',  validate);
  inp.addEventListener('paste',  ()=>setTimeout(validate,0));
  // Trigger once on show (in case browser autofills)
  inp.addEventListener('focus',  validate);
})();

async function submitOnboardName(){
  const inp   = document.getElementById('onboardNameInput');
  const btn   = document.getElementById('onboardNameNextBtn');
  const msgEl = document.getElementById('onboardNameMsg');
  const name  = (inp?.value||'').trim();

  if(name.length < 2){
    if(msgEl){ msgEl.textContent='Please enter at least 2 characters.'; msgEl.className='onboard-name-msg error'; }
    inp?.focus(); return;
  }

  btn.disabled=true; btn.textContent='⏳ Saving…';

  if(_playerFp){
    try{
      const res  = await apiFetch('/api/player/name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fp:_playerFp,name})}, 6000);
      const data = await res.json();
      if(data.success){
        _playerName=data.name; _canChangeName=data.canChangeName; _nextChangeAt=data.nextChangeAt;
        localStorage.setItem(PLAYER_NAME_KEY, _playerName);
        updatePlayerUI();
      } else if(msgEl){
        msgEl.textContent=data.error||'Could not save name.'; msgEl.className='onboard-name-msg error';
        btn.disabled=false; btn.textContent='Save Name & Continue →'; return;
      }
    } catch(err){
      // Network error — save name locally and continue
      _playerName = name;
      localStorage.setItem(PLAYER_NAME_KEY, _playerName);
      updatePlayerUI();
    }
  } else {
    _playerName = name;
    localStorage.setItem(PLAYER_NAME_KEY, _playerName);
    updatePlayerUI();
  }

  btn.textContent='Save Name & Continue →';
  showOnboardCountries();
}

// ── STEP 3 — Country Picker ────────────────────

const COUNTRY_KEY = 'bd_country';

const COUNTRIES = [
  {code:'US',flag:'🇺🇸',name:'USA',group:'Americas'},
  {code:'BR',flag:'🇧🇷',name:'Brazil',group:'Americas'},
  {code:'CA',flag:'🇨🇦',name:'Canada',group:'Americas'},
  {code:'MX',flag:'🇲🇽',name:'Mexico',group:'Americas'},
  {code:'AR',flag:'🇦🇷',name:'Argentina',group:'Americas'},
  {code:'CO',flag:'🇨🇴',name:'Colombia',group:'Americas'},
  {code:'CL',flag:'🇨🇱',name:'Chile',group:'Americas'},
  {code:'PE',flag:'🇵🇪',name:'Peru',group:'Americas'},
  {code:'VE',flag:'🇻🇪',name:'Venezuela',group:'Americas'},
  {code:'EC',flag:'🇪🇨',name:'Ecuador',group:'Americas'},
  {code:'BO',flag:'🇧🇴',name:'Bolivia',group:'Americas'},
  {code:'PY',flag:'🇵🇾',name:'Paraguay',group:'Americas'},
  {code:'UY',flag:'🇺🇾',name:'Uruguay',group:'Americas'},
  {code:'GT',flag:'🇬🇹',name:'Guatemala',group:'Americas'},
  {code:'CR',flag:'🇨🇷',name:'Costa Rica',group:'Americas'},
  {code:'PA',flag:'🇵🇦',name:'Panama',group:'Americas'},
  {code:'DO',flag:'🇩🇴',name:'Dominican Rep.',group:'Americas'},
  {code:'JM',flag:'🇯🇲',name:'Jamaica',group:'Americas'},
  {code:'TT',flag:'🇹🇹',name:'Trinidad',group:'Americas'},
  {code:'GB',flag:'🇬🇧',name:'United Kingdom',group:'Europe'},
  {code:'DE',flag:'🇩🇪',name:'Germany',group:'Europe'},
  {code:'FR',flag:'🇫🇷',name:'France',group:'Europe'},
  {code:'IT',flag:'🇮🇹',name:'Italy',group:'Europe'},
  {code:'ES',flag:'🇪🇸',name:'Spain',group:'Europe'},
  {code:'NL',flag:'🇳🇱',name:'Netherlands',group:'Europe'},
  {code:'PL',flag:'🇵🇱',name:'Poland',group:'Europe'},
  {code:'PT',flag:'🇵🇹',name:'Portugal',group:'Europe'},
  {code:'SE',flag:'🇸🇪',name:'Sweden',group:'Europe'},
  {code:'NO',flag:'🇳🇴',name:'Norway',group:'Europe'},
  {code:'DK',flag:'🇩🇰',name:'Denmark',group:'Europe'},
  {code:'FI',flag:'🇫🇮',name:'Finland',group:'Europe'},
  {code:'BE',flag:'🇧🇪',name:'Belgium',group:'Europe'},
  {code:'CH',flag:'🇨🇭',name:'Switzerland',group:'Europe'},
  {code:'AT',flag:'🇦🇹',name:'Austria',group:'Europe'},
  {code:'CZ',flag:'🇨🇿',name:'Czech Republic',group:'Europe'},
  {code:'HU',flag:'🇭🇺',name:'Hungary',group:'Europe'},
  {code:'RO',flag:'🇷🇴',name:'Romania',group:'Europe'},
  {code:'GR',flag:'🇬🇷',name:'Greece',group:'Europe'},
  {code:'BG',flag:'🇧🇬',name:'Bulgaria',group:'Europe'},
  {code:'HR',flag:'🇭🇷',name:'Croatia',group:'Europe'},
  {code:'SK',flag:'🇸🇰',name:'Slovakia',group:'Europe'},
  {code:'SI',flag:'🇸🇮',name:'Slovenia',group:'Europe'},
  {code:'LT',flag:'🇱🇹',name:'Lithuania',group:'Europe'},
  {code:'LV',flag:'🇱🇻',name:'Latvia',group:'Europe'},
  {code:'EE',flag:'🇪🇪',name:'Estonia',group:'Europe'},
  {code:'IE',flag:'🇮🇪',name:'Ireland',group:'Europe'},
  {code:'IS',flag:'🇮🇸',name:'Iceland',group:'Europe'},
  {code:'MT',flag:'🇲🇹',name:'Malta',group:'Europe'},
  {code:'CY',flag:'🇨🇾',name:'Cyprus',group:'Europe'},
  {code:'LU',flag:'🇱🇺',name:'Luxembourg',group:'Europe'},
  {code:'AL',flag:'🇦🇱',name:'Albania',group:'Europe'},
  {code:'RS',flag:'🇷🇸',name:'Serbia',group:'Europe'},
  {code:'MK',flag:'🇲🇰',name:'N. Macedonia',group:'Europe'},
  {code:'BA',flag:'🇧🇦',name:'Bosnia',group:'Europe'},
  {code:'ME',flag:'🇲🇪',name:'Montenegro',group:'Europe'},
  {code:'IN',flag:'🇮🇳',name:'India',group:'Asia-Pacific'},
  {code:'JP',flag:'🇯🇵',name:'Japan',group:'Asia-Pacific'},
  {code:'KR',flag:'🇰🇷',name:'South Korea',group:'Asia-Pacific'},
  {code:'AU',flag:'🇦🇺',name:'Australia',group:'Asia-Pacific'},
  {code:'NZ',flag:'🇳🇿',name:'New Zealand',group:'Asia-Pacific'},
  {code:'SG',flag:'🇸🇬',name:'Singapore',group:'Asia-Pacific'},
  {code:'ID',flag:'🇮🇩',name:'Indonesia',group:'Asia-Pacific'},
  {code:'PH',flag:'🇵🇭',name:'Philippines',group:'Asia-Pacific'},
  {code:'TH',flag:'🇹🇭',name:'Thailand',group:'Asia-Pacific'},
  {code:'MY',flag:'🇲🇾',name:'Malaysia',group:'Asia-Pacific'},
  {code:'VN',flag:'🇻🇳',name:'Vietnam',group:'Asia-Pacific'},
  {code:'BD',flag:'🇧🇩',name:'Bangladesh',group:'Asia-Pacific'},
  {code:'PK',flag:'🇵🇰',name:'Pakistan',group:'Asia-Pacific'},
  {code:'LK',flag:'🇱🇰',name:'Sri Lanka',group:'Asia-Pacific'},
  {code:'NP',flag:'🇳🇵',name:'Nepal',group:'Asia-Pacific'},
  {code:'KH',flag:'🇰🇭',name:'Cambodia',group:'Asia-Pacific'},
  {code:'MM',flag:'🇲🇲',name:'Myanmar',group:'Asia-Pacific'},
  {code:'TW',flag:'🇹🇼',name:'Taiwan',group:'Asia-Pacific'},
  {code:'HK',flag:'🇭🇰',name:'Hong Kong',group:'Asia-Pacific'},
  {code:'PG',flag:'🇵🇬',name:'Papua New Guinea',group:'Asia-Pacific'},
  {code:'FJ',flag:'🇫🇯',name:'Fiji',group:'Asia-Pacific'},
  {code:'SA',flag:'🇸🇦',name:'Saudi Arabia',group:'Middle East'},
  {code:'AE',flag:'🇦🇪',name:'UAE',group:'Middle East'},
  {code:'TR',flag:'🇹🇷',name:'Turkey',group:'Middle East'},
  {code:'IL',flag:'🇮🇱',name:'Israel',group:'Middle East'},
  {code:'JO',flag:'🇯🇴',name:'Jordan',group:'Middle East'},
  {code:'LB',flag:'🇱🇧',name:'Lebanon',group:'Middle East'},
  {code:'QA',flag:'🇶🇦',name:'Qatar',group:'Middle East'},
  {code:'KW',flag:'🇰🇼',name:'Kuwait',group:'Middle East'},
  {code:'BH',flag:'🇧🇭',name:'Bahrain',group:'Middle East'},
  {code:'OM',flag:'🇴🇲',name:'Oman',group:'Middle East'},
  {code:'IQ',flag:'🇮🇶',name:'Iraq',group:'Middle East'},
  {code:'EG',flag:'🇪🇬',name:'Egypt',group:'Middle East'},
  {code:'AZ',flag:'🇦🇿',name:'Azerbaijan',group:'Middle East'},
  {code:'GE',flag:'🇬🇪',name:'Georgia',group:'Middle East'},
  {code:'AM',flag:'🇦🇲',name:'Armenia',group:'Middle East'},
  {code:'KZ',flag:'🇰🇿',name:'Kazakhstan',group:'Middle East'},
  {code:'UZ',flag:'🇺🇿',name:'Uzbekistan',group:'Middle East'},
  {code:'NG',flag:'🇳🇬',name:'Nigeria',group:'Africa'},
  {code:'ZA',flag:'🇿🇦',name:'South Africa',group:'Africa'},
  {code:'KE',flag:'🇰🇪',name:'Kenya',group:'Africa'},
  {code:'GH',flag:'🇬🇭',name:'Ghana',group:'Africa'},
  {code:'TZ',flag:'🇹🇿',name:'Tanzania',group:'Africa'},
  {code:'UG',flag:'🇺🇬',name:'Uganda',group:'Africa'},
  {code:'ZM',flag:'🇿🇲',name:'Zambia',group:'Africa'},
  {code:'ZW',flag:'🇿🇼',name:'Zimbabwe',group:'Africa'},
  {code:'CM',flag:'🇨🇲',name:'Cameroon',group:'Africa'},
  {code:'SN',flag:'🇸🇳',name:'Senegal',group:'Africa'},
  {code:'CI',flag:'🇨🇮',name:"Cote d'Ivoire",group:'Africa'},
  {code:'ET',flag:'🇪🇹',name:'Ethiopia',group:'Africa'},
  {code:'RW',flag:'🇷🇼',name:'Rwanda',group:'Africa'},
  {code:'MZ',flag:'🇲🇿',name:'Mozambique',group:'Africa'},
  {code:'MA',flag:'🇲🇦',name:'Morocco',group:'Africa'},
  {code:'TN',flag:'🇹🇳',name:'Tunisia',group:'Africa'},
  {code:'DZ',flag:'🇩🇿',name:'Algeria',group:'Africa'},
  {code:'AO',flag:'🇦🇴',name:'Angola',group:'Africa'},
];

let _playerCountry = { code:'', flag:'' };

function loadSavedCountry(){
  try{ const s=JSON.parse(localStorage.getItem(COUNTRY_KEY)||'null'); if(s&&s.code) _playerCountry=s; }catch(_){}
}

function saveCountryToLocal(code,flag){
  _playerCountry={code,flag};
  localStorage.setItem(COUNTRY_KEY,JSON.stringify({code,flag}));
}

function buildCountryPicker(filter){
  const scroll=document.getElementById('countryPickerScroll');
  if(!scroll) return;
  const q=(filter||'').toLowerCase().trim();
  const filtered=q ? COUNTRIES.filter(c=>c.name.toLowerCase().includes(q)||c.code.toLowerCase().includes(q)) : COUNTRIES;
  if(!filtered.length){ scroll.innerHTML=`<div class="cp-empty">No results for "${escHtml(q)}"</div>`; return; }
  let html='', lastGroup='';
  filtered.forEach(c=>{
    if(!q&&c.group!==lastGroup){ html+=`<div class="cp-group">${escHtml(c.group)}</div>`; lastGroup=c.group; }
    const sel=_playerCountry.code===c.code;
    html+=`<div class="cp-row${sel?' selected':''}" data-code="${escHtml(c.code)}" data-flag="${escHtml(c.flag)}" data-name="${escHtml(c.name)}">
      <span class="cp-flag">${c.flag}</span>
      <span class="cp-name">${escHtml(c.name)}</span>
      ${sel?'<span class="cp-tick">✓</span>':''}
    </div>`;
  });
  scroll.innerHTML=html;
  scroll.querySelectorAll('.cp-row').forEach(row=>{
    row.addEventListener('click',()=>{
      saveCountryToLocal(row.dataset.code,row.dataset.flag);
      SFX.click();
      buildCountryPicker(document.getElementById('countrySearch')?.value||'');
      showCountrySelected(row.dataset.flag,row.dataset.name);
    });
  });
}

function showCountrySelected(flag,name){
  const wrap=document.getElementById('countrySelectedWrap');
  const chip=document.getElementById('countrySelectedChip');
  if(wrap) wrap.style.display='flex';
  if(chip) chip.textContent=`${flag}  ${name}`;
  const sw=document.querySelector('.country-search-wrap');
  if(sw) sw.style.display='none';
  const scroll=document.getElementById('countryPickerScroll');
  if(scroll) scroll.style.display='none';
}

function showOnboardCountries(){
  document.getElementById('onboardNameModal').style.display='none';
  document.getElementById('onboardCountriesModal').style.display='flex';
  if(_playerCountry.code){
    const c=COUNTRIES.find(x=>x.code===_playerCountry.code);
    if(c){ showCountrySelected(c.flag,c.name); return; }
  }
  buildCountryPicker('');
}

function finishOnboarding(){
  document.getElementById('onboardCountriesModal').style.display='none';
  localStorage.setItem(ONBOARDING_KEY,'true');
  showConsentBannerIfNeeded();
  if(overlay) overlay.style.display='flex';
}

// Wire country picker
document.getElementById('countrySearch')?.addEventListener('input',e=>buildCountryPicker(e.target.value));

document.getElementById('countryChangeBtn')?.addEventListener('click',()=>{
  const wrap=document.getElementById('countrySelectedWrap');
  if(wrap) wrap.style.display='none';
  const sw=document.querySelector('.country-search-wrap');
  if(sw) sw.style.display='block';
  const scroll=document.getElementById('countryPickerScroll');
  if(scroll) scroll.style.display='block';
  buildCountryPicker('');
  document.getElementById('countrySearch')?.focus();
});

document.getElementById('countrySkipLink')?.addEventListener('click',e=>{e.preventDefault();SFX.click();finishOnboarding();});
document.getElementById('onboardCountriesNextBtn')?.addEventListener('click',()=>{SFX.click();finishOnboarding();});

// ── Wire demo + name onboarding buttons ────────
document.getElementById('onboardDemoNextBtn')?.addEventListener('click',()=>{
  SFX.click(); stopOnboardDemo();
  document.getElementById('onboardDemoModal').style.display='none';
  document.getElementById('onboardNameModal').style.display='flex';
  setTimeout(()=>document.getElementById('onboardNameInput')?.focus(),200);
});

document.getElementById('onboardNameNextBtn')?.addEventListener('click',()=>{ SFX.click(); submitOnboardName(); });
document.getElementById('onboardNameInput')?.addEventListener('keydown',e=>{ if(e.key==='Enter'){ SFX.click(); submitOnboardName(); } });

// ── Main onboarding entry point ─────────────────
function startOnboarding(){
  // Hide the main overlay until onboarding completes
  if(overlay) overlay.style.display='none';
  document.getElementById('onboardDemoModal').style.display='flex';
  startOnboardDemo();
}

// ═══════════════════════════════════════════════
//  INIT — boot the correct flow based on state
// ═══════════════════════════════════════════════
(function bootApp(){
  const savedLang = getSavedLang();

  if(!savedLang){
    // Very first launch — show language picker
    // After lang confirmed → age gate → onboarding OR start screen
    buildLangGrid();
    const detected=detectBrowserLang();
    _pendingLang=detected;
    openLangPicker();

    document.getElementById('langConfirmBtn')?.addEventListener('click',()=>{
      setTimeout(()=>{
        if(!hasAgeConsent()){
          showAgeGate();
          // After age gate accepted → onboarding or start screen
          const ageAcceptBtn=document.getElementById('ageGateAcceptBtn');
          ageAcceptBtn?.addEventListener('click',()=>{
            setTimeout(()=>{
              if(!hasCompletedOnboarding()) startOnboarding();
              else { showConsentBannerIfNeeded(); if(overlay) overlay.style.display='flex'; }
            },200);
          },{once:true});
        } else {
          if(!hasCompletedOnboarding()) startOnboarding();
          else { showConsentBannerIfNeeded(); if(overlay) overlay.style.display='flex'; }
        }
      },150);
    },{once:true});

  } else {
    // Language already chosen
    applyLanguage(savedLang);
    const langEl=document.getElementById('currentLangDisplay');
    if(langEl){ const lang=LANGUAGES.find(l=>l.code===savedLang); if(lang) langEl.textContent=`${lang.flag} ${lang.native}`; }

    if(!hasAgeConsent()){
      showAgeGate();
      document.getElementById('ageGateAcceptBtn')?.addEventListener('click',()=>{
        setTimeout(()=>{
          if(!hasCompletedOnboarding()) startOnboarding();
          else { showConsentBannerIfNeeded(); if(overlay) overlay.style.display='flex'; }
        },200);
      },{once:true});
    } else if(!hasCompletedOnboarding()){
      startOnboarding();
    } else {
      showConsentBannerIfNeeded();
      if(overlay) overlay.style.display='flex';
    }
  }
})();

// ── In-game step hints ─────────────────────────
const HINTS_KEY='bd_hints_seen';
const HINT_STEPS=[
  {id:'move',   icon:'↔️', title:'Move',      desc:'← → to move the block'},
  {id:'rotate', icon:'🔄', title:'Rotate',    desc:'↑ or ↻ button to rotate'},
  {id:'soft',   icon:'⬇️', title:'Soft Drop', desc:'↓ to drop slowly'},
  {id:'hard',   icon:'💥', title:'DROP',      desc:'Space / Drop button — instant'},
  {id:'clear',  icon:'✨', title:'Clear!',    desc:'Fill a row to score points'},
];
let _hintStep=0, _hintsActive=false, _hintDone={}, _hintTimeout=null;

function startHints(){
  if(localStorage.getItem(HINTS_KEY)) return;
  _hintsActive=true; _hintStep=0; _hintDone={};
  showHint(0);
}
function showHint(index){
  if(!_hintsActive||index>=HINT_STEPS.length){ finishHints(); return; }
  const s=HINT_STEPS[index];
  const bubble=document.getElementById('hintBubble');
  if(!bubble) return;
  document.getElementById('hintIcon').textContent=s.icon;
  document.getElementById('hintTitle').textContent=s.title;
  document.getElementById('hintDesc').textContent=s.desc;
  document.querySelectorAll('.hint-dot').forEach((dot,i)=>{
    dot.classList.remove('active','done');
    if(i<index) dot.classList.add('done');
    if(i===index) dot.classList.add('active');
  });
  bubble.className='hint-bubble';
  bubble.style.display='flex';
  if(_hintTimeout) clearTimeout(_hintTimeout);
  _hintTimeout=setTimeout(()=>advanceHint(index),8000);
}
function advanceHint(fromIndex){
  if(fromIndex!==_hintStep) return;
  _hintStep++;
  if(_hintStep>=HINT_STEPS.length){ finishHints(); return; }
  showHint(_hintStep);
}
function completeHintAction(actionId){
  if(!_hintsActive) return;
  if(_hintDone[actionId]) return;
  const current=HINT_STEPS[_hintStep];
  if(!current||current.id!==actionId) return;
  _hintDone[actionId]=true;
  const bubble=document.getElementById('hintBubble');
  if(bubble){
    bubble.classList.add('hint-complete');
    document.getElementById('hintIcon').textContent='✅';
    setTimeout(()=>{
      bubble.classList.remove('hint-complete');
      if(_hintTimeout) clearTimeout(_hintTimeout);
      _hintStep++;
      if(_hintStep>=HINT_STEPS.length) finishHints();
      else showHint(_hintStep);
    },700);
  }
}
function finishHints(){
  _hintsActive=false;
  if(_hintTimeout) clearTimeout(_hintTimeout);
  const bubble=document.getElementById('hintBubble');
  if(bubble) bubble.style.display='none';
  localStorage.setItem(HINTS_KEY,'true');
}
function stopHints(){
  _hintsActive=false;
  if(_hintTimeout) clearTimeout(_hintTimeout);
  const bubble=document.getElementById('hintBubble');
  if(bubble) bubble.style.display='none';
}

// Patch SFX for hint triggers
const _origSFXMove   = SFX.move.bind(SFX);
const _origSFXRotate = SFX.rotate.bind(SFX);
const _origSFXLand   = SFX.land.bind(SFX);
const _origSFXDrop   = SFX.drop.bind(SFX);
const _origSFXClear  = SFX.clear.bind(SFX);
SFX.move   = function()  { _origSFXMove();   completeHintAction('move');   };
SFX.rotate = function()  { _origSFXRotate(); completeHintAction('rotate'); };
SFX.land   = function()  { _origSFXLand();   completeHintAction('soft');   };
SFX.drop   = function()  { _origSFXDrop();   completeHintAction('hard');   };
SFX.clear  = function(n) { _origSFXClear(n); completeHintAction('clear');  };

// Wrap startGame to launch hints
const _hintOrigStart = window.startGame || startGame;
window.startGame = async function startGame(){
  await _hintOrigStart.call(this);
  if(!localStorage.getItem(HINTS_KEY)) setTimeout(startHints,800);
};
const _hintOrigEnd = window.endGame || endGame;
window.endGame = function endGame(){
  stopHints();
  _hintOrigEnd.call(this);
};
