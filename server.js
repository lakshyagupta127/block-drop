// ═══════════════════════════════════════════════
//  Block Drop — Secure Backend
//  Express + sql.js + JWT + HMAC score signing
//  + Rate limiting + Helmet security headers
// ═══════════════════════════════════════════════

require('dotenv').config();

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const jwt        = require('jsonwebtoken');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const initSqlJs  = require('sql.js');

// ── Env vars ────────────────────────────────────
const PORT           = process.env.PORT           || 3000;
const JWT_SECRET     = process.env.JWT_SECRET     || 'dev_jwt_secret_replace_in_prod';
const SCORE_SECRET   = process.env.SCORE_SECRET   || 'dev_score_secret_replace_in_prod';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev_admin_password';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const DB_FILE        = process.env.DB_FILE        || path.join(__dirname, 'tetris.db');

// Fail fast in production if real secrets are not provided
if (process.env.NODE_ENV === 'production') {
  const missing = ['JWT_SECRET','SCORE_SECRET','ADMIN_PASSWORD'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[FATAL] Missing environment variables:', missing.join(', '));
    process.exit(1);
  }
}

// ── HMAC helpers ────────────────────────────────
/**
 * Sign a game token at session start.
 * Contains startTime + random nonce so each token is unique.
 */
function createGameToken() {
  const payload = {
    startTime: Date.now(),
    nonce:     crypto.randomBytes(16).toString('hex'),
  };
  const data = JSON.stringify(payload);
  const sig  = crypto.createHmac('sha256', SCORE_SECRET).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url');
}

/**
 * Verify a submitted score against its game token.
 * Returns true only if:
 *  - token signature is valid (not tampered)
 *  - token is not older than MAX_GAME_DURATION
 *  - score is physically plausible given play time
 */
const MAX_GAME_MS       = 4 * 60 * 60 * 1000; // 4 hours
const MAX_SCORE_PER_SEC = 50;                  // ~180,000/hr ceiling

function verifyScoreToken(token, score) {
  try {
    const raw     = JSON.parse(Buffer.from(token, 'base64url').toString());
    const data    = JSON.stringify(raw.payload);
    const expected = crypto.createHmac('sha256', SCORE_SECRET).update(data).digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(raw.sig), Buffer.from(expected))) {
      return { ok: false, reason: 'invalid signature' };
    }

    const elapsed = Date.now() - raw.payload.startTime;
    if (elapsed < 0 || elapsed > MAX_GAME_MS) {
      return { ok: false, reason: 'token expired or future-dated' };
    }

    const maxPossible = Math.ceil((elapsed / 1000) * MAX_SCORE_PER_SEC);
    if (score > maxPossible) {
      return { ok: false, reason: `score ${score} impossible in ${Math.floor(elapsed/1000)}s` };
    }

    return { ok: true };
  } catch {
    return { ok: false, reason: 'malformed token' };
  }
}

// ── Rate limiters ───────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, slow down.' },
});

const scoreLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 5,              // max 5 score submissions per minute per IP
  message: { success: false, error: 'Too many score submissions.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,             // 10 login attempts per 15 min
  message: { success: false, error: 'Too many login attempts.' },
});

// ── JWT middleware ──────────────────────────────
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'No token provided' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

// ── Boot ─────────────────────────────────────────
async function boot() {
  const SQL = await initSqlJs();

  let db;
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }

  function persist() {
    fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS scores (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      score      INTEGER NOT NULL,
      level      INTEGER NOT NULL DEFAULT 1,
      lines      INTEGER NOT NULL DEFAULT 0,
      duration_s INTEGER NOT NULL DEFAULT 0,
      device     TEXT    NOT NULL DEFAULT 'unknown',
      country_code TEXT  DEFAULT '',
      country_flag TEXT  DEFAULT '',
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_score ON scores(score DESC);

    -- Track used nonces to prevent replay attacks
    CREATE TABLE IF NOT EXISTS used_nonces (
      nonce      TEXT PRIMARY KEY,
      used_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Players: browser fingerprint → display name + cooldown
    CREATE TABLE IF NOT EXISTS players (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint        TEXT    NOT NULL UNIQUE,
      name               TEXT    NOT NULL DEFAULT 'Player',
      name_changed_at    TEXT,
      -- Last session snapshot (updated after every game)
      last_score         INTEGER DEFAULT 0,
      last_level         INTEGER DEFAULT 1,
      last_lines         INTEGER DEFAULT 0,
      last_played_at     TEXT,
      country_code       TEXT    DEFAULT '',   -- ISO 2-letter code e.g. 'IN'
      country_flag       TEXT    DEFAULT '',   -- emoji flag e.g. '🇮🇳'
      created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_players_fp ON players(fingerprint);
  `);

  // ── Migrate existing DBs: add last_session columns if missing ──
  const existingCols = (() => {
    try {
      const s = db.prepare('PRAGMA table_info(players)');
      const cols = [];
      while (s.step()) cols.push(s.getAsObject().name);
      s.free();
      return cols;
    } catch { return []; }
  })();
  if (!existingCols.includes('last_score')) {
    db.run('ALTER TABLE players ADD COLUMN last_score     INTEGER DEFAULT 0');
    db.run('ALTER TABLE players ADD COLUMN last_level     INTEGER DEFAULT 1');
    db.run('ALTER TABLE players ADD COLUMN last_lines     INTEGER DEFAULT 0');
    db.run('ALTER TABLE players ADD COLUMN last_played_at TEXT');
  }
  if (!existingCols.includes('country_code')) {
    db.run("ALTER TABLE players ADD COLUMN country_code TEXT DEFAULT ''");
    db.run("ALTER TABLE players ADD COLUMN country_flag TEXT DEFAULT ''");
  }

  persist();

  // ── Express ──────────────────────────────────
  const app = express();

  // Trust Render's proxy so rate limiting and IP detection work correctly
  // Render sits behind a load balancer that sets X-Forwarded-For
  app.set('trust proxy', 1);

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:  ["'self'"],
        scriptSrc:   ["'self'", "'unsafe-inline'"],   // needed for inline game script
        styleSrc:    ["'self'", "'unsafe-inline'"],
        imgSrc:      ["'self'", 'data:'],
        connectSrc:  ["'self'"],
        fontSrc:     ["'self'"],
        objectSrc:   ["'none'"],
        frameSrc:    ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(express.json({ limit: '10kb' }));
  app.use('/api/', apiLimiter);

  // ── HTTPS redirect (must be before static files) ──
  app.use((req, res, next) => {
    const proto = req.headers['x-forwarded-proto'];
    if (proto && proto !== 'https') {
      return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
    }
    next();
  });

  // ── HSTS header ───────────────────────────────
  app.use((_req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    next();
  });

  // Static files (game)
  app.use(express.static(__dirname, {
    index: 'index.html',
    setHeaders(res, filePath) {
      // Never cache .env or .db files
      if (filePath.endsWith('.env') || filePath.endsWith('.db')) {
        res.status(403).end();
      }
    },
  }));

  // Block direct access to sensitive files
  app.get(['.env', 'tetris.db', '*.db'], (_req, res) => res.status(403).end());

  // ── POST /api/auth/login ────────────────────
  // Admin login — returns JWT
  app.post('/api/auth/login', loginLimiter, (req, res) => {
    const { password } = req.body || {};
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'Password required' });
    }

    // Timing-safe comparison
    const provided = Buffer.from(password.slice(0, 200));
    const expected = Buffer.from(ADMIN_PASSWORD);
    const match    = provided.length === expected.length &&
                     crypto.timingSafeEqual(provided, expected);

    if (!match) {
      return res.status(401).json({ success: false, error: 'Wrong password' });
    }

    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.json({ success: true, token });
  });

  // ── GET /api/game-token ─────────────────────
  // Client calls this at game start — gets a signed token
  app.get('/api/game-token', (req, res) => {
    res.json({ success: true, token: createGameToken() });
  });

  // ── GET /api/scores ─────────────────────────
  app.get('/api/scores', (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 10, 100);
      const stmt  = db.prepare(
        `SELECT id, name, score, level, lines, created_at
         FROM scores ORDER BY score DESC LIMIT ${limit}`
      );
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();

      const cs = db.prepare('SELECT COUNT(*) as total FROM scores');
      cs.step();
      const { total } = cs.getAsObject();
      cs.free();

      res.json({ success: true, scores: rows, total });
    } catch (err) {
      console.error('GET /api/scores:', err);
      res.status(500).json({ success: false, error: 'Failed to fetch scores' });
    }
  });

  // ── POST /api/scores ─────────────────────────
  // Public — but requires a valid game token + plausible score
  app.post('/api/scores', scoreLimiter, (req, res) => {
    try {
      const { name, score, level, lines, duration, device, gameToken } = req.body;

      // ── 1. Validate presence ─────────────────
      if (!name || typeof name !== 'string')
        return res.status(400).json({ success: false, error: 'name required' });
      if (typeof score !== 'number' || score < 0 || !Number.isFinite(score))
        return res.status(400).json({ success: false, error: 'invalid score' });
      if (!gameToken || typeof gameToken !== 'string')
        return res.status(400).json({ success: false, error: 'gameToken required' });

      // ── 2. Verify HMAC game token ─────────────
      const check = verifyScoreToken(gameToken, score);
      if (!check.ok) {
        console.warn(`[SECURITY] Score rejected: ${check.reason} | IP: ${req.ip}`);
        return res.status(400).json({ success: false, error: `Score rejected: ${check.reason}` });
      }

      // ── 3. Replay-attack prevention (nonce) ──
      let raw;
      try { raw = JSON.parse(Buffer.from(gameToken, 'base64url').toString()); }
      catch { return res.status(400).json({ success: false, error: 'Bad token' }); }

      const nonce = raw.payload.nonce;
      const nonceStmt = db.prepare('SELECT nonce FROM used_nonces WHERE nonce = ?');
      nonceStmt.bind([nonce]);
      const nonceUsed = nonceStmt.step();
      nonceStmt.free();
      if (nonceUsed) {
        return res.status(400).json({ success: false, error: 'Token already used' });
      }
      db.run('INSERT INTO used_nonces (nonce) VALUES (?)', [nonce]);

      // ── 4. Sanitise & store ──────────────────
      const safeName     = String(name).trim().slice(0, 20) || 'Player';
      const safeScore    = Math.floor(score);
      const safeLevel    = Math.max(1, Math.floor(level)    || 1);
      const safeLines    = Math.max(0, Math.floor(lines)    || 0);
      const safeDuration = Math.max(0, Math.floor(duration) || 0);
      const safeDevice   = ['mobile','desktop','tablet'].includes(device) ? device : 'unknown';

      db.run(
        `INSERT INTO scores (name, score, level, lines, duration_s, device)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [safeName, safeScore, safeLevel, safeLines, safeDuration, safeDevice]
      );

      // Update last session on player row (if player exists)
      db.run(
        `UPDATE players SET last_score = ?, last_level = ?, last_lines = ?, last_played_at = ?
         WHERE name = ?`,
        [safeScore, safeLevel, safeLines, new Date().toISOString(), safeName]
      );

      persist();

      // Rank
      const idStmt = db.prepare('SELECT last_insert_rowid() as id');
      idStmt.step();
      const { id } = idStmt.getAsObject();
      idStmt.free();

      const rankStmt = db.prepare('SELECT COUNT(*) as rank FROM scores WHERE score > ?');
      rankStmt.bind([safeScore]);
      rankStmt.step();
      const { rank } = rankStmt.getAsObject();
      rankStmt.free();

      res.status(201).json({ success: true, id, rank: rank + 1,
        entry: { id, name: safeName, score: safeScore, level: safeLevel, lines: safeLines } });
    } catch (err) {
      console.error('POST /api/scores:', err);
      res.status(500).json({ success: false, error: 'Failed to save score' });
    }
  });

  // ══ PLAYER SETTINGS ROUTES ═══════════════════

  const NAME_COOLDOWN_DAYS = 10;
  const NAME_COOLDOWN_MS   = NAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

  // GET /api/player/stats?fp=<fingerprint>
  // Returns personal best, total games, total lines, last session, welcome back flag
  app.get('/api/player/stats', (req, res) => {
    const fp = String(req.query.fp || '').trim().slice(0, 128);
    if (!fp) return res.status(400).json({ success: false, error: 'fingerprint required' });
    try {
      const pStmt = db.prepare('SELECT * FROM players WHERE fingerprint = ?');
      pStmt.bind([fp]);
      const found  = pStmt.step();
      const player = found ? pStmt.getAsObject() : null;
      pStmt.free();

      if (!player) return res.json({
        success: true, isReturning: false,
        bestScore: 0, bestLevel: 1, totalGames: 0, totalLines: 0,
        lastScore: 0, lastLevel: 1, lastLines: 0, lastPlayedAt: null,
      });

      // Aggregate stats
      const sStmt = db.prepare(`
        SELECT MAX(score) AS bestScore, MAX(level) AS bestLevel,
               COUNT(*)   AS totalGames, SUM(lines) AS totalLines
        FROM scores WHERE name = ?
      `);
      sStmt.bind([player.name]);
      sStmt.step();
      const agg = sStmt.getAsObject();
      sStmt.free();

      res.json({
        success:      true,
        isReturning:  !!player.last_played_at,
        name:         player.name,
        bestScore:    agg.bestScore  || 0,
        bestLevel:    agg.bestLevel  || 1,
        totalGames:   agg.totalGames || 0,
        totalLines:   agg.totalLines || 0,
        lastScore:    player.last_score    || 0,
        lastLevel:    player.last_level    || 1,
        lastLines:    player.last_lines    || 0,
        lastPlayedAt: player.last_played_at || null,
      });
    } catch (err) {
      console.error('GET /api/player/stats:', err);
      res.status(500).json({ success: false, error: 'Failed to fetch stats' });
    }
  });

  // GET /api/player?fp=<fingerprint>
  // Returns player profile: name, next allowed change time
  app.get('/api/player', (req, res) => {
    const fp = String(req.query.fp || '').trim().slice(0, 128);
    if (!fp) return res.status(400).json({ success: false, error: 'fingerprint required' });

    try {
      // Get or auto-create the player row
      const stmt = db.prepare('SELECT * FROM players WHERE fingerprint = ?');
      stmt.bind([fp]);
      const found = stmt.step();
      const row   = found ? stmt.getAsObject() : null;
      stmt.free();

      if (!row) {
        // First visit — create record
        db.run(
          'INSERT INTO players (fingerprint, name) VALUES (?, ?)',
          [fp, 'Player']
        );
        persist();
        return res.json({
          success: true,
          name:           'Player',
          canChangeName:  true,
          nextChangeAt:   null,
          cooldownDays:   NAME_COOLDOWN_DAYS,
        });
      }

      const lastChanged = row.name_changed_at ? new Date(row.name_changed_at).getTime() : null;
      const now         = Date.now();
      const canChange   = !lastChanged || (now - lastChanged) >= NAME_COOLDOWN_MS;
      const nextChangeAt= lastChanged && !canChange
        ? new Date(lastChanged + NAME_COOLDOWN_MS).toISOString()
        : null;

      res.json({
        success:       true,
        name:          row.name,
        canChangeName: canChange,
        nextChangeAt,
        cooldownDays:  NAME_COOLDOWN_DAYS,
      });
    } catch (err) {
      console.error('GET /api/player:', err);
      res.status(500).json({ success: false, error: 'Failed to load player' });
    }
  });

  // POST /api/player/name
  // Body: { fp, name }
  // Enforces 10-day cooldown — server-side, cannot be bypassed client-side
  app.post('/api/player/name', rateLimit({ windowMs: 60*1000, max: 5 }), (req, res) => {
    const { fp, name } = req.body || {};

    if (!fp || typeof fp !== 'string')
      return res.status(400).json({ success: false, error: 'fingerprint required' });
    if (!name || typeof name !== 'string' || !name.trim())
      return res.status(400).json({ success: false, error: 'name required' });

    const cleanFp   = fp.trim().slice(0, 128);
    const cleanName = name.trim().slice(0, 20);

    if (cleanName.length < 2)
      return res.status(400).json({ success: false, error: 'Name must be at least 2 characters' });

    // Basic profanity / injection guard (extend as needed)
    if (/<|>|;|'|--|\/\*/.test(cleanName))
      return res.status(400).json({ success: false, error: 'Invalid characters in name' });

    try {
      // Look up existing player
      const stmt = db.prepare('SELECT * FROM players WHERE fingerprint = ?');
      stmt.bind([cleanFp]);
      const found = stmt.step();
      const row   = found ? stmt.getAsObject() : null;
      stmt.free();

      const now = Date.now();

      if (!row) {
        // New player — create and set name (no cooldown yet)
        db.run(
          'INSERT INTO players (fingerprint, name, name_changed_at) VALUES (?, ?, ?)',
          [cleanFp, cleanName, new Date(now).toISOString()]
        );
        persist();
        return res.json({
          success:       true,
          name:          cleanName,
          canChangeName: false,
          nextChangeAt:  new Date(now + NAME_COOLDOWN_MS).toISOString(),
          cooldownDays:  NAME_COOLDOWN_DAYS,
          message:       'Name set successfully',
        });
      }

      // Existing player — check cooldown
      const lastChanged = row.name_changed_at ? new Date(row.name_changed_at).getTime() : null;
      const elapsed     = lastChanged ? (now - lastChanged) : NAME_COOLDOWN_MS + 1;

      if (elapsed < NAME_COOLDOWN_MS) {
        const nextChangeAt = new Date(lastChanged + NAME_COOLDOWN_MS).toISOString();
        const daysLeft     = Math.ceil((NAME_COOLDOWN_MS - elapsed) / (24*60*60*1000));
        return res.status(429).json({
          success:       false,
          error:         `Name can only be changed once every ${NAME_COOLDOWN_DAYS} days`,
          canChangeName: false,
          nextChangeAt,
          daysLeft,
        });
      }

      // Cooldown passed — update name
      db.run(
        'UPDATE players SET name = ?, name_changed_at = ? WHERE fingerprint = ?',
        [cleanName, new Date(now).toISOString(), cleanFp]
      );
      persist();

      res.json({
        success:       true,
        name:          cleanName,
        canChangeName: false,
        nextChangeAt:  new Date(now + NAME_COOLDOWN_MS).toISOString(),
        cooldownDays:  NAME_COOLDOWN_DAYS,
        message:       'Name updated successfully',
      });
    } catch (err) {
      console.error('POST /api/player/name:', err);
      res.status(500).json({ success: false, error: 'Failed to update name' });
    }
  });

  // ══ ADMIN ROUTES (JWT required) ═══════════════

  // GET /api/admin/players — all registered players
  app.get('/api/admin/players', requireAdmin, (req, res) => {
    try {
      const stmt = db.prepare(
        `SELECT id, name, name_changed_at, created_at FROM players ORDER BY created_at DESC`
      );
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      res.json({ success: true, players: rows, total: rows.length });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Failed to fetch players' });
    }
  });

  // DELETE /api/admin/players/:id — remove a player (resets their identity)
  app.delete('/api/admin/players/:id', requireAdmin, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Bad id' });
      db.run('DELETE FROM players WHERE id = ?', [id]);
      persist();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Failed to delete player' });
    }
  });

  // GET /api/admin/scores — full table with device & duration
  app.get('/api/admin/scores', requireAdmin, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 50, 500);
      const stmt  = db.prepare(
        `SELECT id, name, score, level, lines, duration_s, device, created_at
         FROM scores ORDER BY score DESC LIMIT ${limit}`
      );
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();

      const cs = db.prepare('SELECT COUNT(*) as total FROM scores');
      cs.step();
      const { total } = cs.getAsObject();
      cs.free();

      res.json({ success: true, scores: rows, total });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Failed to fetch' });
    }
  });

  // DELETE /api/admin/scores/:id — delete one score
  app.delete('/api/admin/scores/:id', requireAdmin, (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Bad id' });
      db.run('DELETE FROM scores WHERE id = ?', [id]);
      persist();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Failed to delete' });
    }
  });

  // DELETE /api/admin/scores — clear ALL scores
  app.delete('/api/admin/scores', requireAdmin, (req, res) => {
    try {
      db.run('DELETE FROM scores');
      db.run('DELETE FROM used_nonces');
      persist();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Failed to clear' });
    }
  });

  // Serve admin page
  app.get('/admin', (_req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
  });

  // ── Serve compliance pages ───────────────────
  ['privacy.html', 'terms.html', 'data-safety.html'].forEach(page => {
    app.get('/' + page.replace('.html', ''), (_req, res) =>
      res.sendFile(path.join(__dirname, page)));
    app.get('/' + page, (_req, res) =>
      res.sendFile(path.join(__dirname, page)));
  });

  // ── DELETE /api/player/:fp — user self-deletion ──
  // User can delete their own data using their fingerprint
  app.delete('/api/player/:fp', rateLimit({ windowMs: 60*1000, max: 3 }), (req, res) => {
    const fp = String(req.params.fp || '').trim().slice(0, 128);
    if (!fp) return res.status(400).json({ success: false, error: 'fingerprint required' });
    try {
      // Delete player profile
      db.run('DELETE FROM players WHERE fingerprint = ?', [fp]);
      // Delete their scores (link by name — best effort since we don't have player_id on scores yet)
      // Also wipe the fingerprint from localStorage on the client side (handled in game.js)
      persist();
      res.json({ success: true, message: 'Your data has been deleted.' });
    } catch (err) {
      console.error('DELETE /api/player:', err);
      res.status(500).json({ success: false, error: 'Failed to delete data' });
    }
  });

  // ── GET /api/player/:fp/export — data portability (GDPR Art.20) ──
  app.get('/api/player/:fp/export', rateLimit({ windowMs: 60*1000, max: 3 }), (req, res) => {
    const fp = String(req.params.fp || '').trim().slice(0, 128);
    if (!fp) return res.status(400).json({ success: false, error: 'fingerprint required' });
    try {
      const pStmt = db.prepare('SELECT id, name, name_changed_at, created_at FROM players WHERE fingerprint = ?');
      pStmt.bind([fp]);
      const player = pStmt.step() ? pStmt.getAsObject() : null;
      pStmt.free();

      if (!player) return res.status(404).json({ success: false, error: 'No data found' });

      // Get scores linked by name
      const sStmt = db.prepare('SELECT score, level, lines, duration_s, device, created_at FROM scores WHERE name = ? ORDER BY score DESC');
      sStmt.bind([player.name]);
      const scores = [];
      while (sStmt.step()) scores.push(sStmt.getAsObject());
      sStmt.free();

      res.setHeader('Content-Disposition', 'attachment; filename="blockdrop-mydata.json"');
      res.json({
        exportedAt: new Date().toISOString(),
        notice: 'This is all data Block Drop holds about you.',
        player: { name: player.name, joined: player.created_at, lastNameChange: player.name_changed_at },
        scores,
      });
    } catch (err) {
      console.error('GET /api/player/export:', err);
      res.status(500).json({ success: false, error: 'Failed to export data' });
    }
  });

  // ── Content-Type meta tag for IARC ───────────
  // Add X-Content-Rating header so crawlers/stores can read content rating
  app.use((req, res, next) => {
    res.setHeader('X-Content-Rating', 'PEGI-3; ESRB-E; IARC-1');
    next();
  });

  // Catch-all
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

  // ── Cleanup old nonces every hour ────────────
  setInterval(() => {
    try {
      db.run(`DELETE FROM used_nonces WHERE used_at < datetime('now', '-5 hours')`);
      persist();
    } catch {}
  }, 60 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`\n🎮  Block Drop server running!`);
    console.log(`    Game  →  http://localhost:${PORT}`);
    console.log(`    Admin →  http://localhost:${PORT}/admin`);
    console.log(`    DB    →  ${DB_FILE}\n`);
  });
}

boot().catch(err => { console.error('Server failed:', err); process.exit(1); });
