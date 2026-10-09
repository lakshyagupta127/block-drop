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
  I:'#00f0f0', O:'#f0f000', T:'#a000f0',
  S:'#00f000', Z:'#f00000', J:'#0000f0', L:'#f0a000',
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

// Apply High-DPI scaling to fix blurry rendering on mobile
function applyHighDPI() {
  const dpr = window.devicePixelRatio || 1;
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
  tetris()  { [523,659,784,1047,784,1047,1319].forEach((f,i)=>playTone(f,0.14,'triangle',0.22,i*0.10)); },
  gameOver(){ [400,320,240,160].forEach((f,i)=>playTone(f,0.18,'sawtooth',0.20,i*0.18)); },
};

// ── Haptics ────────────────────────────────────
function vibrate(p){ try{ navigator.vibrate&&navigator.vibrate(p); }catch(_){} }
const HAP = {
  move()    { vibrate(8);  },
  rotate()  { vibrate(12); },
  land()    { vibrate(20); },
  drop()    { vibrate(30); },
  clear()   { vibrate([40,20,40]); },
  tetris()  { vibrate([60,30,60,30,100]); },
  gameOver(){ vibrate([80,40,80,40,200]); },
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
  const cached = localStorage.getItem(PLAYER_FP_KEY);
  if (cached) return cached;
  const signals = [
    navigator.userAgent, navigator.language,
    screen.width+'x'+screen.height, screen.colorDepth,
    new Date().getTimezoneOffset(),
    navigator.hardwareConcurrency||0, navigator.platform||'',
  ].join('|');
  const msgBuffer  = new TextEncoder().encode(signals);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const fp = Array.from(new Uint8Array(hashBuffer)).map(b=>b.toString(16).padStart(2,'0')).join('');
  localStorage.setItem(PLAYER_FP_KEY, fp);
  return fp;
}

// ── Player profile state ───────────────────────
let _playerFp       = null;
let _playerName     = 'Player';
let _canChangeName  = true;
let _nextChangeAt   = null;
let _personalBest   = 0;
let _totalGames     = 0;
let _totalLines     = 0;
let _bestLevel      = 1;
let _lastScore      = 0;
let _lastLevel      = 1;
let _lastLines      = 0;
let _lastPlayedAt   = null;
let _isReturning    = false;

async function loadPlayerProfile() {
  try {
    _playerFp = await getFingerprint();
    const [profileRes, statsRes] = await Promise.all([
      fetch(`/api/player?fp=${encodeURIComponent(_playerFp)}`),
      fetch(`/api/player/stats?fp=${encodeURIComponent(_playerFp)}`),
    ]);
    const profileData = await profileRes.json();
    const statsData   = await statsRes.json();
    if (profileData.success) {
      _playerName    = profileData.name;
      _canChangeName = profileData.canChangeName;
      _nextChangeAt  = profileData.nextChangeAt;
    }
    if (statsData.success) {
      _personalBest = statsData.bestScore    || 0;
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
    console.warn('Could not load player profile:', err);
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

  const tagEl = document.getElementById('overlayNameTag');
  if (tagEl) {
    if (_isReturning && _playerName && _playerName !== 'Player') {
      tagEl.textContent = `👋 Welcome back, ${_playerName}!`;
      tagEl.className   = 'overlay-name-tag welcome-back';
    } else if (_playerName && _playerName !== 'Player') {
      tagEl.textContent = `👤 ${_playerName}`;
      tagEl.className   = 'overlay-name-tag';
    } else {
      tagEl.textContent = '';
    }
  }

  const pbEl = document.getElementById('overlayPersonalBest');
  if (pbEl) {
    if (_personalBest > 0) {
      let html = `<div class="pb-row">🏅 <strong>Best: ${_personalBest.toLocaleString()}</strong> &nbsp;·&nbsp; Lv.${_bestLevel} &nbsp;·&nbsp; ${_totalGames} game${_totalGames!==1?'s':''}</div>`;
      if (_lastScore > 0 && _isReturning)
        html += `<div class="pb-last">🕐 Last: ${_lastScore.toLocaleString()} — Lv.${_lastLevel}, ${_lastLines} lines <span class="pb-ago">${timeAgo(_lastPlayedAt)}</span></div>`;
      pbEl.innerHTML = html;
      pbEl.style.display = 'block';
    } else {
      pbEl.style.display = 'none';
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

// ── Settings Modal ─────────────────────────────
function openSettings() {
  SFX.click();
  const modal = document.getElementById('settingsModal');
  const curEl = document.getElementById('settingsCurrentName');
  const form  = document.getElementById('nameChangeForm');
  const lock  = document.getElementById('nameCooldownNotice');
  const msgEl = document.getElementById('settingsMsg');
  if (curEl) curEl.textContent = _playerName;
  if (msgEl) { msgEl.textContent=''; msgEl.className='settings-msg'; }
  const inp = document.getElementById('settingsNameInput');
  if (inp) inp.value = (_playerName !== 'Player') ? _playerName : '';
  if (_canChangeName) {
    if (form) form.style.display='flex';
    if (lock) lock.style.display='none';
  } else {
    if (form) form.style.display='none';
    if (lock) { lock.style.display='block'; renderCooldown(); }
  }
  modal.style.display='flex';
  if (inp && _canChangeName) setTimeout(()=>inp.focus(),100);
}

function renderCooldown() {
  if (!_nextChangeAt) return;
  const now=Date.now(), next=new Date(_nextChangeAt).getTime();
  const total=10*24*60*60*1000, remaining=Math.max(0,next-now);
  const daysLeft=Math.ceil(remaining/(24*60*60*1000));
  const progress=Math.min(100,Math.round(((total-remaining)/total)*100));
  const daysEl=document.getElementById('cooldownDaysLeft');
  const dateEl=document.getElementById('cooldownNextDate');
  const barEl =document.getElementById('cooldownBarFill');
  if (daysEl) daysEl.textContent=daysLeft;
  if (dateEl) dateEl.textContent=new Date(_nextChangeAt).toLocaleDateString(undefined,{year:'numeric',month:'long',day:'numeric'});
  if (barEl)  barEl.style.width=progress+'%';
}

function closeSettings() {
  SFX.click();
  document.getElementById('settingsModal').style.display='none';
}

async function saveSettingsName() {
  const inp   = document.getElementById('settingsNameInput');
  const msgEl = document.getElementById('settingsMsg');
  const btn   = document.getElementById('saveNameBtn');
  const newName = (inp?.value||'').trim();
  if (!newName || newName.length < 2) {
    if (msgEl) { msgEl.textContent='Name must be at least 2 characters.'; msgEl.className='settings-msg error'; }
    return;
  }
  if (!_playerFp) {
    if (msgEl) { msgEl.textContent='Could not identify player. Refresh and try again.'; msgEl.className='settings-msg error'; }
    return;
  }
  btn.disabled=true; btn.textContent='⏳ Saving…';
  if (msgEl) { msgEl.textContent=''; msgEl.className='settings-msg'; }
  try {
    const res  = await fetch('/api/player/name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fp:_playerFp,name:newName})});
    const data = await res.json();
    if (data.success) {
      _playerName=data.name; _canChangeName=data.canChangeName; _nextChangeAt=data.nextChangeAt;
      updatePlayerUI(); SFX.clear(1);
      const curEl=document.getElementById('settingsCurrentName');
      if (curEl) curEl.textContent=_playerName;
      if (msgEl) { msgEl.textContent='✔ Name saved!'; msgEl.className='settings-msg success'; }
      setTimeout(()=>{
        document.getElementById('nameChangeForm').style.display='none';
        const lock=document.getElementById('nameCooldownNotice');
        if (lock) { lock.style.display='block'; renderCooldown(); }
      },1200);
    } else {
      if (msgEl) { msgEl.textContent=data.error||'Failed to save.'; msgEl.className='settings-msg error'; }
      if (data.nextChangeAt) { _canChangeName=false; _nextChangeAt=data.nextChangeAt; }
    }
  } catch {
    if (msgEl) { msgEl.textContent='Server error. Try again.'; msgEl.className='settings-msg error'; }
  } finally {
    btn.disabled=false; btn.textContent='✔ Save Name';
  }
}

// ── Secure API helpers ─────────────────────────
const API = '/api';
let _gameToken   = null;
let _gameStartTs = null;

async function fetchGameToken() {
  try {
    const res=await fetch(`${API}/game-token`);
    const data=await res.json();
    if (data.success) { _gameToken=data.token; _gameStartTs=Date.now(); }
  } catch(err) {
    console.warn('Could not fetch game token:', err);
    _gameToken=null;
  }
}

async function apiFetchScores(limit=10) {
  try {
    const res=await fetch(`${API}/scores?limit=${limit}`);
    const data=await res.json();
    return data.success ? data.scores : [];
  } catch { return []; }
}

async function apiSaveScore(name, score, level, lines) {
  if (!_gameToken) return { success:false, error:'No game token' };
  try {
    const duration = _gameStartTs ? Math.floor((Date.now()-_gameStartTs)/1000) : 0;
    const res = await fetch(`${API}/scores`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        name, score, level, lines, duration,
        device:       detectDevice(),
        gameToken:    _gameToken,
        country_code: _playerCountry.code || '',
        country_flag: _playerCountry.flag || '',
      }),
    });
    const data=await res.json();
    _gameToken=null;
    return data;
  } catch(err) { _gameToken=null; return {success:false,error:err.message}; }
}

async function apiClearScores() {
  try {
    const res=await fetch(`${API}/scores`,{method:'DELETE'});
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
  for(let r=0;r<shape.length;r++)
    for(let c=0;c<shape[r].length;c++)
      if(shape[r][c]&&y+r>=0) board[y+r][x+c]=color;
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
    if(cleared===4){SFX.tetris();HAP.tetris();}
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

  // 4. TETRIS label
  if (count === 4) fxTetrisLabel();

  // 5. Start particle loop if not already running
  if (!_fxRaf) _fxRaf = requestAnimationFrame(fxLoop);
}

function fxLoop() {
  if (!fxCtx) return;
  fxCtx.clearRect(0, 0, 300, 600);

  _fxParticles = _fxParticles.filter(p => p.life > 0);

  _fxParticles.forEach(p => {
    p.x     += p.vx;
    p.y     += p.vy;
    p.vy    += 0.18;  // gravity
    p.vx    *= 0.97;  // air friction
    p.life  -= p.decay;
    p.alpha  = Math.max(0, p.life);

    fxCtx.globalAlpha = p.alpha;
    fxCtx.fillStyle   = p.color;
    fxCtx.shadowColor = p.color;
    fxCtx.shadowBlur  = 6;
    fxCtx.beginPath();
    fxCtx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    fxCtx.fill();
  });

  fxCtx.globalAlpha = 1;
  fxCtx.shadowBlur  = 0;

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
  const labels = ['','Single!','Double!','Triple!','TETRIS!!!'];
  const colors = ['','#00f0f0','#00ff88','#ffcc00','#ff8800'];

  const el = document.createElement('div');
  el.className   = 'score-popup';
  el.textContent = `${labels[count]}  +${pts.toLocaleString()}`;
  el.style.color = colors[count] || '#00f0f0';
  el.style.top   = '35%';
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 1200);
}

function fxTetrisLabel() {
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'tetris-label';
  el.textContent = 'TETRIS!';
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
  if(speedMobEl){speedMobEl.textContent=pct+'%';speedMobEl.style.color=`hsl(${hue},90%,60%)`;}
  if(speedBar){speedBar.style.width=pct+'%';speedBar.style.background=`hsl(${hue},90%,55%)`;}
}

function showOverlay(html) { overlay.innerHTML=html; overlay.style.display='flex'; }

// ── Drawing ────────────────────────────────────
function drawBlock(context,x,y,color,alpha){
  alpha=alpha!==undefined?alpha:1;
  context.globalAlpha=alpha;
  context.fillStyle=color;
  context.fillRect(x*BLOCK+1,y*BLOCK+1,BLOCK-2,BLOCK-2);
  context.fillStyle='rgba(255,255,255,0.18)';
  context.fillRect(x*BLOCK+2,y*BLOCK+2,BLOCK-4,6);
  context.globalAlpha=1;
}

function ghostY() {
  let gy=currentPiece.y;
  while(isValid(currentPiece.shape,currentPiece.x,gy+1)) gy++;
  return gy;
}

function drawBoard() {
  ctx.fillStyle='#0a0a18';
  ctx.fillRect(0,0,300,600);
  ctx.strokeStyle='rgba(255,255,255,0.04)'; ctx.lineWidth=0.5;
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) ctx.strokeRect(c*BLOCK,r*BLOCK,BLOCK,BLOCK);
  for(let r=0;r<ROWS;r++) for(let c=0;c<COLS;c++) if(board[r][c]) drawBlock(ctx,c,r,board[r][c]);
  const gy=ghostY();
  if(gy!==currentPiece.y)
    for(let r=0;r<currentPiece.shape.length;r++)
      for(let c=0;c<currentPiece.shape[r].length;c++)
        if(currentPiece.shape[r][c]) drawBlock(ctx,currentPiece.x+c,gy+r,currentPiece.color,0.2);
  for(let r=0;r<currentPiece.shape.length;r++)
    for(let c=0;c<currentPiece.shape[r].length;c++)
      if(currentPiece.shape[r][c]) drawBlock(ctx,currentPiece.x+c,currentPiece.y+r,currentPiece.color);
}

function drawNext() {
  if (!nextCtx) return;
  const bSize=20;
  nextCtx.fillStyle='#1a1a2e'; nextCtx.fillRect(0,0,100,100);
  const s=nextPiece.shape;
  const offX=Math.floor((5-s[0].length)/2),offY=Math.floor((5-s.length)/2);
  for(let r=0;r<s.length;r++) for(let c=0;c<s[r].length;c++) if(s[r][c]){
    nextCtx.fillStyle=nextPiece.color;
    nextCtx.fillRect((offX+c)*bSize+1,(offY+r)*bSize+1,bSize-2,bSize-2);
    nextCtx.fillStyle='rgba(255,255,255,0.18)';
    nextCtx.fillRect((offX+c)*bSize+2,(offY+r)*bSize+2,bSize-4,5);
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
  score+=(ghostY()-currentPiece.y)*2; currentPiece.y=ghostY();
  updateUI(); SFX.drop(); HAP.drop();
  placePiece(); clearLines(); spawnPiece();
  lastDrop=performance.now();
}

function tryRotate() {
  const rotated=rotate(currentPiece.shape);
  for(const kick of [0,1,-1,2,-2]){
    if(isValid(rotated,currentPiece.x+kick,currentPiece.y)){
      currentPiece.shape=rotated; currentPiece.x+=kick;
      SFX.rotate(); HAP.rotate(); return;
    }
  }
}

function spawnPiece() {
  currentPiece=nextPiece||randomPiece();
  nextPiece=randomPiece();
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

// ── Game flow ──────────────────────────────────
async function startGame() {
  try{ if(audioCtx&&audioCtx.state==='suspended') audioCtx.resume(); }catch(_){}
  board=createBoard(); score=0; level=1; lines=0;
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
  syncControlButtons();
  // Score is auto-saved with the player's saved name — no name prompt needed
  autoSaveScore();
}

function togglePause() {
  if(!gameRunning) return;
  paused=!paused; SFX.click();
  if(paused){
    ctx.fillStyle='rgba(0,0,0,0.6)'; ctx.fillRect(0,0,300,600);
    ctx.fillStyle='#fff'; ctx.font='bold 28px Courier New';
    ctx.textAlign='center'; ctx.fillText('PAUSED',300/2,600/2);
    ctx.font='13px Courier New'; ctx.fillStyle='#aaa';
    ctx.fillText('Tap Play at the top or P to resume',300/2,600/2+32);
  }
  syncPauseBtn();
}

function syncPauseBtn() {
  const topBtn=document.getElementById('pauseBtn');
  if(paused){
    if(topBtn) topBtn.textContent='▶';
  } else {
    if(topBtn) topBtn.textContent='⏸';
  }
}

function syncControlButtons() {
}

// ── Leaderboard ────────────────────────────────
async function openLB() {
  SFX.click();
  const modal=document.getElementById('lbModal');
  const tbody=document.getElementById('lbBody');
  tbody.innerHTML=`<tr><td colspan="5" style="text-align:center;color:#888;padding:16px">Loading…</td></tr>`;
  modal.style.display='flex';
  const scores=await apiFetchScores(10);
  renderLBRows(scores);
}

function renderLBRows(scores) {
  const tbody=document.getElementById('lbBody');
  if(!scores.length){
    tbody.innerHTML=`<tr><td colspan="5" class="no-scores">No scores yet — play to get on the board!</td></tr>`;
    return;
  }
  const medals=['🥇','🥈','🥉'];
  tbody.innerHTML=scores.map((e,i)=>`
    <tr>
      <td>${medals[i]||i+1}</td>
      <td>
        <div class="lb-name-cell">
          ${e.country_flag ? `<span class="lb-flag">${escHtml(e.country_flag)}</span>` : ''}
          <span>${escHtml(e.name)}</span>
        </div>
      </td>
      <td><strong>${Number(e.score).toLocaleString()}</strong></td>
      <td>${e.level}</td>
      <td>${e.lines}</td>
    </tr>
  `).join('');
}

function escHtml(str) {
  return String(str).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function closeLB() { SFX.click(); document.getElementById('lbModal').style.display='none'; }

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
  showGameOverOverlay(result.rank || null);
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
  const btn  = document.getElementById('saveScoreBtn');
  btn.disabled = true; btn.textContent = '💾 Saving…';
  const result = await apiSaveScore(name, score, level, lines);
  document.getElementById('nameModal').style.display = 'none';
  SFX.click(); btn.disabled = false; btn.textContent = '💾 Save';
  if (!result.success) console.warn('Score save failed:', result.error);
  showGameOverOverlay(result.rank || null);
}

function skipScore() {
  _gameToken = null;
  document.getElementById('nameModal').style.display = 'none';
  SFX.click(); showGameOverOverlay(null);
}

function showGameOverOverlay(rank) {
  const rankMsg=rank?`<p>You ranked <strong>#${rank}</strong> on the leaderboard!</p>`:'';
  showOverlay(`
    <h2>GAME OVER</h2>
    <p class="final-score">Score: ${score.toLocaleString()}</p>
    <p>Level ${level} &nbsp;·&nbsp; ${lines} lines</p>
    ${rankMsg}
    <button class="retro-btn" id="restartBtn">▶ Play Again</button>
    <button class="retro-btn secondary" id="goLbBtn">🏆 Leaderboard</button>
  `);
  document.getElementById('restartBtn').addEventListener('click', startGame);
  document.getElementById('goLbBtn').addEventListener('click', openLB);
  // Refresh stats
  if(_playerFp){
    fetch(`/api/player/stats?fp=${encodeURIComponent(_playerFp)}`)
      .then(r=>r.json()).then(data=>{
        if(data.success){
          _personalBest=data.bestScore||0; _totalGames=data.totalGames||0;
          _totalLines=data.totalLines||0;  _bestLevel=data.bestLevel||1;
          _lastScore=data.lastScore||0;    _lastLevel=data.lastLevel||1;
          _lastLines=data.lastLines||0;    _lastPlayedAt=data.lastPlayedAt||null;
          _isReturning=true;
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
['leaderboardBtn','leaderboardBtn2','overlayLbBtn'].forEach(id=>document.getElementById(id)?.addEventListener('click',openLB));
document.getElementById('closeLbBtn')?.addEventListener('click',closeLB);
document.getElementById('clearLbBtn')?.addEventListener('click',()=>alert('Score management is only available in the admin panel.'));
document.getElementById('saveScoreBtn')?.addEventListener('click',saveScore);
document.getElementById('skipScoreBtn')?.addEventListener('click',skipScore);
document.getElementById('nameInput')?.addEventListener('keydown',e=>{if(e.key==='Enter')saveScore();});
document.getElementById('startBtn')?.addEventListener('click',startGame);

// Touch pause/start
function bindTouchBtnPause(id,action){
  const el=document.getElementById(id); if(!el) return;
  function fire(e){ e.preventDefault(); el.classList.add('pressed'); setTimeout(()=>el.classList.remove('pressed'),120); action(); }
  el.addEventListener('touchstart',fire,{passive:false});
  el.addEventListener('mousedown',fire);
}
document.getElementById('pauseBtn')?.addEventListener('click',()=>{ SFX.click(); if(!gameRunning) return; togglePause(); });

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
SFX.clear   = n   => [523,659,784,1047].slice(0,n).forEach((f,i)=>playToneScaled(f,0.12,'triangle',0.20,i*0.08));
SFX.tetris  = ()  => [523,659,784,1047,784,1047,1319].forEach((f,i)=>playToneScaled(f,0.14,'triangle',0.22,i*0.10));
SFX.gameOver= ()  => [400,320,240,160].forEach((f,i)=>playToneScaled(f,0.18,'sawtooth',0.20,i*0.18));

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

function setSliderFill(slider,pct){ slider.style.setProperty('--val',pct+'%'); }

function initVolumeUI(){
  const sfxSlider=document.getElementById('sfxSlider');
  const musicSlider=document.getElementById('musicSlider');
  const sfxPct=document.getElementById('sfxPct');
  const musicPct=document.getElementById('musicPct');
  const muteBtn=document.getElementById('muteAllBtn');
  const musicBtn=document.getElementById('musicToggleBtn');
  if(!sfxSlider) return;
  sfxSlider.value=Math.round(_sfxVolume*100);
  musicSlider.value=Math.round(_musicVolume*100);
  if(sfxPct) sfxPct.textContent=Math.round(_sfxVolume*100)+'%';
  if(musicPct) musicPct.textContent=Math.round(_musicVolume*100)+'%';
  setSliderFill(sfxSlider,Math.round(_sfxVolume*100));
  setSliderFill(musicSlider,Math.round(_musicVolume*100));
  if(muteBtn) muteBtn.classList.toggle('active',_muted);
  if(musicBtn){ musicBtn.classList.toggle('active',_musicOn&&!_muted); musicBtn.textContent=_musicOn?'🎵 Music On':'🎵 Music Off'; }
  sfxSlider.addEventListener('input',()=>{
    _sfxVolume=sfxSlider.value/100; localStorage.setItem(VOLUME_KEY,_sfxVolume);
    if(sfxPct) sfxPct.textContent=sfxSlider.value+'%';
    setSliderFill(sfxSlider,sfxSlider.value);
    if(!_muted) SFX.click();
  });
  musicSlider.addEventListener('input',()=>{
    _musicVolume=musicSlider.value/100; localStorage.setItem(MUSIC_KEY,_musicVolume);
    if(musicPct) musicPct.textContent=musicSlider.value+'%';
    setSliderFill(musicSlider,musicSlider.value);
    updateMusicVolume();
  });
  muteBtn?.addEventListener('click',()=>{
    _muted=!_muted; localStorage.setItem(MUTE_KEY,_muted);
    muteBtn.classList.toggle('active',_muted);
    muteBtn.textContent=_muted?'🔇 Unmute':'🔇 Mute All';
    if(musicBtn) musicBtn.classList.toggle('active',_musicOn&&!_muted);
    updateMusicVolume();
    if(!_muted) SFX.click();
  });
  musicBtn?.addEventListener('click',()=>{
    _musicOn=!_musicOn; localStorage.setItem(MUSIC_ON_KEY,_musicOn);
    musicBtn.classList.toggle('active',_musicOn&&!_muted);
    musicBtn.textContent=_musicOn?'🎵 Music On':'🎵 Music Off';
    if(_musicOn&&!_muted) startMusic(); else stopMusic();
  });
}

function openSettingsAndInit(){ initVolumeUI(); openSettings(); }

['settingsBtnMob','settingsBtn2','overlaySettingsBtn'].forEach(id=>document.getElementById(id)?.addEventListener('click',openSettingsAndInit));
document.getElementById('closeSettingsBtn')?.addEventListener('click',closeSettings);
document.getElementById('saveNameBtn')?.addEventListener('click',saveSettingsName);
document.getElementById('settingsNameInput')?.addEventListener('keydown',e=>{ if(e.key==='Enter') saveSettingsName(); });
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

// ── How To Play ────────────────────────────────
const HTP_KEY='bd_htp_seen';
function openHowToPlay(){
  SFX.click();
  const modal=document.getElementById('howToPlayModal');
  if(modal) modal.style.display='flex';
  if(gameRunning&&!paused) togglePause();
}
function closeHowToPlay(){
  SFX.click();
  const modal=document.getElementById('howToPlayModal');
  if(modal) modal.style.display='none';
  localStorage.setItem(HTP_KEY,'true');
  if(gameRunning&&paused) togglePause();
}
document.getElementById('helpBtn')?.addEventListener('click',openHowToPlay);
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
      const res=await fetch(`/api/player/${encodeURIComponent(_playerFp)}`,{method:'DELETE'});
      const data=await res.json();
      if(!data.success) throw new Error(data.error);
    }
    [PLAYER_FP_KEY,AGE_CONSENT_KEY,GDPR_BANNER_KEY,VOLUME_KEY,MUSIC_KEY,MUTE_KEY,MUSIC_ON_KEY,
     'bd_language','bd_demo_seen','bd_hints_seen','bd_htp_seen','bd_onboarding_done']
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
    const res=await fetch(`/api/player/${encodeURIComponent(_playerFp)}/export`);
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
(async function init(){
  loadSavedCountry();
  await loadPlayerProfile();
})();

// ── Pause button keyboard shortcut ─────────────
document.addEventListener('keydown',e=>{ if(e.code==='KeyS'&&!gameRunning) openSettingsAndInit(); });

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
// Mini Tetris scene with animated bot + gesture hand

const OD_COLS=6, OD_ROWS=10, OD_B=16; // logical block size — canvas is css-scaled

const OD_STEPS=[
  {key:'← →',   text:'Move left & right', action:'move',     gestureFn:'gestureSwipeH', btnId:'demoBtnLeft'},
  {key:'↑ / ↻', text:'Rotate the block',  action:'rotate',   gestureFn:'gestureTap',    btnId:'demoBtnRotate'},
  {key:'▼ Soft', text:'Soft drop',        action:'softdrop', gestureFn:'gestureDown',   btnId:'demoBtnSoft'},
  {key:'⬇ Drop', text:'Hard drop!',       action:'harddrop', gestureFn:'gestureSwipeD', btnId:'demoBtnDrop'},
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
      const res  = await fetch('/api/player/name',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fp:_playerFp,name})});
      const data = await res.json();
      if(data.success){
        _playerName=data.name; _canChangeName=data.canChangeName; _nextChangeAt=data.nextChangeAt;
        updatePlayerUI();
      } else if(msgEl){
        msgEl.textContent=data.error||'Could not save name.'; msgEl.className='onboard-name-msg error';
        btn.disabled=false; btn.textContent='Save Name & Continue →'; return;
      }
    } catch(err){
      // Network error — save name locally and continue
      _playerName = name; updatePlayerUI();
    }
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
  {id:'hard',   icon:'💥', title:'Hard Drop', desc:'Space / Drop button — instant'},
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
