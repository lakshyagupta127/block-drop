// ═══════════════════════════════════════════════
//  Block Drop — Secure Backend
//  Express + PostgreSQL (pg) + JWT + HMAC scoring
//  + Rate limiting + Helmet security headers
// ═══════════════════════════════════════════════

require('dotenv').config();

const express   = require('express');
const path      = require('path');
const crypto    = require('crypto');
const jwt       = require('jsonwebtoken');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool }  = require('pg');

// ── Env vars ────────────────────────────────────
const PORT           = process.env.PORT           || 3000;
const JWT_SECRET     = process.env.JWT_SECRET     || 'dev_jwt_secret_replace_in_prod';
const SCORE_SECRET   = process.env.SCORE_SECRET   || 'dev_score_secret_replace_in_prod';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'dev_admin_password';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';
const DATABASE_URL   = process.env.DATABASE_URL;

// Fail fast in production if real secrets not provided
if (process.env.NODE_ENV === 'production') {
  const missing = ['JWT_SECRET','SCORE_SECRET','ADMIN_PASSWORD','DATABASE_URL']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[FATAL] Missing environment variables:', missing.join(', '));
    process.exit(1);
  }
}

// ── PostgreSQL connection pool ──────────────────
const pool = new Pool({
  connectionString: DATABASE_URL || 'postgresql://localhost/blockdrop',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// Convenience query helper
async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

// ── Database initialisation ─────────────────────
async function initDB() {
  await query(`
    CREATE TABLE IF NOT EXISTS scores (
      id           SERIAL PRIMARY KEY,
      name         TEXT    NOT NULL,
      score        INTEGER NOT NULL,
      level        INTEGER NOT NULL DEFAULT 1,
      lines        INTEGER NOT NULL DEFAULT 0,
      duration_s   INTEGER NOT NULL DEFAULT 0,
      device       TEXT    NOT NULL DEFAULT 'unknown',
      country_code TEXT             DEFAULT '',
      country_flag TEXT             DEFAULT '',
      created_at   TIMESTAMPTZ      DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_scores_score ON scores(score DESC);

    CREATE TABLE IF NOT EXISTS used_nonces (
      nonce      TEXT PRIMARY KEY,
      used_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS players (
      id               SERIAL PRIMARY KEY,
      fingerprint      TEXT    NOT NULL UNIQUE,
      name             TEXT    NOT NULL DEFAULT 'Player',
      name_changed_at  TIMESTAMPTZ,
      last_score       INTEGER          DEFAULT 0,
      last_level       INTEGER          DEFAULT 1,
      last_lines       INTEGER          DEFAULT 0,
      last_played_at   TIMESTAMPTZ,
      country_code     TEXT             DEFAULT '',
      country_flag     TEXT             DEFAULT '',
      created_at       TIMESTAMPTZ      DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_players_fp ON players(fingerprint);
  `);
  console.log('[DB] Tables ready.');
}

// ── HMAC helpers ────────────────────────────────
function createGameToken() {
  const payload = { startTime: Date.now(), nonce: crypto.randomBytes(16).toString('hex') };
  const data    = JSON.stringify(payload);
  const sig     = crypto.createHmac('sha256', SCORE_SECRET).update(data).digest('hex');
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64url');
}

const MAX_GAME_MS       = 4 * 60 * 60 * 1000;
const MAX_SCORE_PER_SEC = 50;

function verifyScoreToken(token, score) {
  try {
    const raw      = JSON.parse(Buffer.from(token, 'base64url').toString());
    const data     = JSON.stringify(raw.payload);
    const expected = crypto.createHmac('sha256', SCORE_SECRET).update(data).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(raw.sig), Buffer.from(expected)))
      return { ok: false, reason: 'invalid signature' };
    const elapsed = Date.now() - raw.payload.startTime;
    if (elapsed < 0 || elapsed > MAX_GAME_MS)
      return { ok: false, reason: 'token expired or future-dated' };
    const maxPossible = Math.ceil((elapsed / 1000) * MAX_SCORE_PER_SEC);
    if (score > maxPossible)
      return { ok: false, reason: `score ${score} impossible in ${Math.floor(elapsed/1000)}s` };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'malformed token' };
  }
}

// ── Rate limiters ───────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, error: 'Too many requests.' },
});
const scoreLimiter = rateLimit({
  windowMs: 60 * 1000, max: 5,
  message: { success: false, error: 'Too many score submissions.' },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { success: false, error: 'Too many login attempts.' },
});

// ── JWT middleware ──────────────────────────────
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'No token' });
  try { req.admin = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ success: false, error: 'Invalid or expired token' }); }
}

// ── Express app ─────────────────────────────────
const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'"],
      objectSrc:  ["'none'"],
      frameSrc:   ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '10kb' }));
app.use('/api/', apiLimiter);

// ── HTTPS redirect (production proxy) ──────────
app.use((req, res, next) => {
  const proto = req.headers['x-forwarded-proto'];
  if (proto && proto !== 'https')
    return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  next();
});

// ── HSTS ───────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  next();
});

// ── Static files ────────────────────────────────
app.use(express.static(__dirname, { index: 'index.html' }));
app.get(['.env'], (_req, res) => res.status(403).end());

// ── Compliance pages ────────────────────────────
['privacy','terms','data-safety'].forEach(page => {
  app.get(`/${page}`,      (_req, res) => res.sendFile(path.join(__dirname, `${page}.html`)));
  app.get(`/${page}.html`, (_req, res) => res.sendFile(path.join(__dirname, `${page}.html`)));
});

// ══════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (!password || typeof password !== 'string')
    return res.status(400).json({ success: false, error: 'Password required' });
  const provided = Buffer.from(password.slice(0, 200));
  const expected = Buffer.from(ADMIN_PASSWORD);
  const match    = provided.length === expected.length &&
                   crypto.timingSafeEqual(provided, expected);
  if (!match) return res.status(401).json({ success: false, error: 'Wrong password' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  res.json({ success: true, token });
});

// ── Game token ──────────────────────────────────
app.get('/api/game-token', (_req, res) => {
  res.json({ success: true, token: createGameToken() });
});

// ══════════════════════════════════════════════════
//  SCORES
// ══════════════════════════════════════════════════

app.get('/api/scores', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 100);
    const { rows } = await query(
      `SELECT id, name, score, level, lines, country_code, country_flag, created_at
       FROM scores ORDER BY score DESC LIMIT $1`,
      [limit]
    );
    const total = (await query('SELECT COUNT(*) AS total FROM scores')).rows[0].total;
    res.json({ success: true, scores: rows, total: parseInt(total) });
  } catch (err) {
    console.error('GET /api/scores:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch scores' });
  }
});

app.post('/api/scores', scoreLimiter, async (req, res) => {
  try {
    const { name, score, level, lines, duration, device, gameToken,
            country_code, country_flag } = req.body;

    if (!name || typeof name !== 'string')
      return res.status(400).json({ success: false, error: 'name required' });
    if (typeof score !== 'number' || score < 0 || !Number.isFinite(score))
      return res.status(400).json({ success: false, error: 'invalid score' });
    if (!gameToken || typeof gameToken !== 'string')
      return res.status(400).json({ success: false, error: 'gameToken required' });

    const check = verifyScoreToken(gameToken, score);
    if (!check.ok) {
      console.warn(`[SECURITY] Score rejected: ${check.reason} | IP: ${req.ip}`);
      return res.status(400).json({ success: false, error: `Score rejected: ${check.reason}` });
    }

    // Replay prevention
    let raw;
    try { raw = JSON.parse(Buffer.from(gameToken, 'base64url').toString()); }
    catch { return res.status(400).json({ success: false, error: 'Bad token' }); }

    const nonce = raw.payload.nonce;
    const nonceCheck = await query('SELECT nonce FROM used_nonces WHERE nonce = $1', [nonce]);
    if (nonceCheck.rows.length > 0)
      return res.status(400).json({ success: false, error: 'Token already used' });
    await query('INSERT INTO used_nonces (nonce) VALUES ($1)', [nonce]);

    // Sanitise
    const safeName     = String(name).trim().slice(0, 20) || 'Player';
    const safeScore    = Math.floor(score);
    const safeLevel    = Math.max(1, Math.floor(level)    || 1);
    const safeLines    = Math.max(0, Math.floor(lines)    || 0);
    const safeDuration = Math.max(0, Math.floor(duration) || 0);
    const safeDevice   = ['mobile','desktop','tablet'].includes(device) ? device : 'unknown';
    const safeCC       = String(country_code || '').slice(0, 5);
    const safeCF       = String(country_flag || '').slice(0, 10);

    const { rows } = await query(
      `INSERT INTO scores (name, score, level, lines, duration_s, device, country_code, country_flag)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [safeName, safeScore, safeLevel, safeLines, safeDuration, safeDevice, safeCC, safeCF]
    );
    const id = rows[0].id;

    // Also update last session on player row
    await query(
      `UPDATE players SET last_score=$1, last_level=$2, last_lines=$3, last_played_at=NOW()
       WHERE name=$4`,
      [safeScore, safeLevel, safeLines, safeName]
    );

    const rankRes = await query('SELECT COUNT(*) AS rank FROM scores WHERE score > $1', [safeScore]);
    const rank    = parseInt(rankRes.rows[0].rank) + 1;

    res.status(201).json({
      success: true, id, rank,
      entry: { id, name: safeName, score: safeScore, level: safeLevel, lines: safeLines },
    });
  } catch (err) {
    console.error('POST /api/scores:', err.message);
    res.status(500).json({ success: false, error: 'Failed to save score' });
  }
});

// ══════════════════════════════════════════════════
//  PLAYER SETTINGS
// ══════════════════════════════════════════════════

const NAME_COOLDOWN_DAYS = 10;
const NAME_COOLDOWN_MS   = NAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

// GET /api/player/stats
app.get('/api/player/stats', async (req, res) => {
  const fp = String(req.query.fp || '').trim().slice(0, 128);
  if (!fp) return res.status(400).json({ success: false, error: 'fingerprint required' });
  try {
    const pRes = await query('SELECT * FROM players WHERE fingerprint = $1', [fp]);
    const player = pRes.rows[0] || null;

    if (!player) return res.json({
      success: true, isReturning: false,
      bestScore: 0, bestLevel: 1, totalGames: 0, totalLines: 0,
      lastScore: 0, lastLevel: 1, lastLines: 0, lastPlayedAt: null,
    });

    const agg = (await query(
      `SELECT MAX(score) AS "bestScore", MAX(level) AS "bestLevel",
              COUNT(*)   AS "totalGames", SUM(lines) AS "totalLines"
       FROM scores WHERE name = $1`,
      [player.name]
    )).rows[0];

    res.json({
      success:      true,
      isReturning:  !!player.last_played_at,
      name:         player.name,
      bestScore:    parseInt(agg.bestScore)  || 0,
      bestLevel:    parseInt(agg.bestLevel)  || 1,
      totalGames:   parseInt(agg.totalGames) || 0,
      totalLines:   parseInt(agg.totalLines) || 0,
      lastScore:    player.last_score    || 0,
      lastLevel:    player.last_level    || 1,
      lastLines:    player.last_lines    || 0,
      lastPlayedAt: player.last_played_at || null,
    });
  } catch (err) {
    console.error('GET /api/player/stats:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// GET /api/player
app.get('/api/player', async (req, res) => {
  const fp = String(req.query.fp || '').trim().slice(0, 128);
  if (!fp) return res.status(400).json({ success: false, error: 'fingerprint required' });
  try {
    let pRes = await query('SELECT * FROM players WHERE fingerprint = $1', [fp]);
    if (pRes.rows.length === 0) {
      await query('INSERT INTO players (fingerprint, name) VALUES ($1, $2)', [fp, 'Player']);
      return res.json({ success: true, name: 'Player', canChangeName: true, nextChangeAt: null, cooldownDays: NAME_COOLDOWN_DAYS });
    }
    const player      = pRes.rows[0];
    const lastChanged = player.name_changed_at ? new Date(player.name_changed_at).getTime() : null;
    const now         = Date.now();
    const canChange   = !lastChanged || (now - lastChanged) >= NAME_COOLDOWN_MS;
    const nextChangeAt= lastChanged && !canChange
      ? new Date(lastChanged + NAME_COOLDOWN_MS).toISOString() : null;
    res.json({ success: true, name: player.name, canChangeName: canChange, nextChangeAt, cooldownDays: NAME_COOLDOWN_DAYS });
  } catch (err) {
    console.error('GET /api/player:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load player' });
  }
});

// POST /api/player/name
app.post('/api/player/name', rateLimit({ windowMs: 60*1000, max: 5 }), async (req, res) => {
  const { fp, name } = req.body || {};
  if (!fp || typeof fp !== 'string')
    return res.status(400).json({ success: false, error: 'fingerprint required' });
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ success: false, error: 'name required' });

  const cleanFp   = fp.trim().slice(0, 128);
  const cleanName = name.trim().slice(0, 20);

  if (cleanName.length < 2)
    return res.status(400).json({ success: false, error: 'Name must be at least 2 characters' });
  if (/<|>|;|--|\/\*/.test(cleanName))
    return res.status(400).json({ success: false, error: 'Invalid characters in name' });

  try {
    const pRes  = await query('SELECT * FROM players WHERE fingerprint = $1', [cleanFp]);
    const now   = Date.now();

    if (pRes.rows.length === 0) {
      await query(
        'INSERT INTO players (fingerprint, name, name_changed_at) VALUES ($1, $2, NOW())',
        [cleanFp, cleanName]
      );
      return res.json({
        success: true, name: cleanName, canChangeName: false,
        nextChangeAt: new Date(now + NAME_COOLDOWN_MS).toISOString(),
        cooldownDays: NAME_COOLDOWN_DAYS, message: 'Name set successfully',
      });
    }

    const player      = pRes.rows[0];
    const lastChanged = player.name_changed_at ? new Date(player.name_changed_at).getTime() : null;
    const elapsed     = lastChanged ? (now - lastChanged) : NAME_COOLDOWN_MS + 1;

    if (elapsed < NAME_COOLDOWN_MS) {
      const nextChangeAt = new Date(lastChanged + NAME_COOLDOWN_MS).toISOString();
      const daysLeft     = Math.ceil((NAME_COOLDOWN_MS - elapsed) / (24*60*60*1000));
      return res.status(429).json({
        success: false, canChangeName: false, nextChangeAt, daysLeft,
        error: `Name can only be changed once every ${NAME_COOLDOWN_DAYS} days`,
      });
    }

    await query(
      'UPDATE players SET name=$1, name_changed_at=NOW() WHERE fingerprint=$2',
      [cleanName, cleanFp]
    );
    res.json({
      success: true, name: cleanName, canChangeName: false,
      nextChangeAt: new Date(now + NAME_COOLDOWN_MS).toISOString(),
      cooldownDays: NAME_COOLDOWN_DAYS, message: 'Name updated successfully',
    });
  } catch (err) {
    console.error('POST /api/player/name:', err.message);
    res.status(500).json({ success: false, error: 'Failed to update name' });
  }
});

// DELETE /api/player/:fp  — user self-deletion
app.delete('/api/player/:fp', rateLimit({ windowMs: 60*1000, max: 3 }), async (req, res) => {
  const fp = String(req.params.fp || '').trim().slice(0, 128);
  if (!fp) return res.status(400).json({ success: false, error: 'fingerprint required' });
  try {
    await query('DELETE FROM players WHERE fingerprint = $1', [fp]);
    res.json({ success: true, message: 'Your data has been deleted.' });
  } catch (err) {
    console.error('DELETE /api/player:', err.message);
    res.status(500).json({ success: false, error: 'Failed to delete data' });
  }
});

// GET /api/player/:fp/export
app.get('/api/player/:fp/export', rateLimit({ windowMs: 60*1000, max: 3 }), async (req, res) => {
  const fp = String(req.params.fp || '').trim().slice(0, 128);
  if (!fp) return res.status(400).json({ success: false, error: 'fingerprint required' });
  try {
    const pRes = await query('SELECT id, name, name_changed_at, created_at FROM players WHERE fingerprint=$1', [fp]);
    if (!pRes.rows.length) return res.status(404).json({ success: false, error: 'No data found' });
    const player = pRes.rows[0];
    const sRes   = await query(
      'SELECT score, level, lines, duration_s, device, created_at FROM scores WHERE name=$1 ORDER BY score DESC',
      [player.name]
    );
    res.setHeader('Content-Disposition', 'attachment; filename="blockdrop-mydata.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      notice: 'This is all data Block Drop holds about you.',
      player: { name: player.name, joined: player.created_at, lastNameChange: player.name_changed_at },
      scores: sRes.rows,
    });
  } catch (err) {
    console.error('GET /api/player/export:', err.message);
    res.status(500).json({ success: false, error: 'Failed to export data' });
  }
});

// ══════════════════════════════════════════════════
//  ADMIN ROUTES (JWT required)
// ══════════════════════════════════════════════════

app.get('/api/admin/scores', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const { rows } = await query(
      `SELECT id, name, score, level, lines, duration_s, device,
              country_code, country_flag, created_at
       FROM scores ORDER BY score DESC LIMIT $1`,
      [limit]
    );
    const total = (await query('SELECT COUNT(*) AS total FROM scores')).rows[0].total;
    res.json({ success: true, scores: rows, total: parseInt(total) });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch' });
  }
});

app.delete('/api/admin/scores/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Bad id' });
    await query('DELETE FROM scores WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete' });
  }
});

app.delete('/api/admin/scores', requireAdmin, async (req, res) => {
  try {
    await query('DELETE FROM scores');
    await query('DELETE FROM used_nonces');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to clear' });
  }
});

app.get('/api/admin/players', requireAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, name, country_flag, name_changed_at, created_at FROM players ORDER BY created_at DESC'
    );
    res.json({ success: true, players: rows, total: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to fetch players' });
  }
});

app.delete('/api/admin/players/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Bad id' });
    await query('DELETE FROM players WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete player' });
  }
});

app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ── Catch-all ────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Cleanup old nonces every hour ────────────────
setInterval(async () => {
  try { await query("DELETE FROM used_nonces WHERE used_at < NOW() - INTERVAL '5 hours'"); }
  catch(e) { console.error('[DB] Nonce cleanup error:', e.message); }
}, 60 * 60 * 1000);

// ── Boot ─────────────────────────────────────────
async function boot() {
  await initDB();
  app.listen(PORT, () => {
    console.log(`\n🎮  Block Drop server running!`);
    console.log(`    Game  →  http://localhost:${PORT}`);
    console.log(`    Admin →  http://localhost:${PORT}/admin`);
    console.log(`    DB    →  PostgreSQL\n`);
  });
}

boot().catch(err => { console.error('[FATAL] Server failed to start:', err.message); process.exit(1); });
