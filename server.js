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

    ALTER TABLE scores ADD COLUMN IF NOT EXISTS player_id INTEGER;
    ALTER TABLE scores ADD COLUMN IF NOT EXISTS player_fp TEXT;
    CREATE INDEX IF NOT EXISTS idx_scores_player_fp ON scores(player_fp);
    CREATE INDEX IF NOT EXISTS idx_scores_player_id ON scores(player_id);

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
    ALTER TABLE players ADD COLUMN IF NOT EXISTS best_score INTEGER DEFAULT 0;

    -- Backfill older unlinked scores to matching players by name
    UPDATE scores s
    SET player_id = p.id, player_fp = p.fingerprint
    FROM players p
    WHERE s.player_fp IS NULL AND LOWER(s.name) = LOWER(p.name);
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
const MAX_SCORE_PER_SEC = 2500;

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
    const maxPossible = 1000 + Math.ceil((elapsed / 1000) * MAX_SCORE_PER_SEC);
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

// ── PWA / TWA files ──────────────────────────────
app.get('/manifest.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.get('/.well-known/assetlinks.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(path.join(__dirname, '.well-known', 'assetlinks.json'));
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
      `SELECT * FROM (
         SELECT DISTINCT ON (COALESCE(s.player_fp, LOWER(s.name)))
           s.id,
           COALESCE(p.name, s.name) AS name,
           s.score,
           s.level,
           s.lines,
           COALESCE(NULLIF(s.country_code, ''), p.country_code, '') AS country_code,
           COALESCE(NULLIF(s.country_flag, ''), p.country_flag, '') AS country_flag,
           s.created_at
         FROM scores s
         LEFT JOIN players p ON s.player_fp = p.fingerprint
         ORDER BY COALESCE(s.player_fp, LOWER(s.name)), s.score DESC
       ) best_scores
       ORDER BY score DESC LIMIT $1`,
      [limit]
    );
    const total = (await query('SELECT COUNT(DISTINCT COALESCE(player_fp, LOWER(name))) AS total FROM scores')).rows[0].total;
    res.json({ success: true, scores: rows, total: parseInt(total) });
  } catch (err) {
    console.error('GET /api/scores:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch scores' });
  }
});

app.post('/api/scores', scoreLimiter, async (req, res) => {
  try {
    const { name, score, level, lines, duration, device, gameToken,
            country_code, country_flag, fp } = req.body;

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
    const cleanFp      = String(fp || '').trim().slice(0, 128);
    let safeName       = String(name).trim().slice(0, 20) || 'Player';
    const safeScore    = Math.floor(score);
    const safeLevel    = Math.max(1, Math.floor(level)    || 1);
    const safeLines    = Math.max(0, Math.floor(lines)    || 0);
    const safeDuration = Math.max(0, Math.floor(duration) || 0);
    const safeDevice   = ['mobile','desktop','tablet'].includes(device) ? device : 'unknown';
    const safeCC       = String(country_code || '').slice(0, 5);
    const safeCF       = String(country_flag || '').slice(0, 10);

    // Look up or establish player by persistent unique fingerprint
    let playerId = null;
    if (cleanFp) {
      let pRes = await query('SELECT * FROM players WHERE fingerprint = $1', [cleanFp]);
      if (pRes.rows.length === 0) {
        pRes = await query(
          'INSERT INTO players (fingerprint, name, country_code, country_flag) VALUES ($1, $2, $3, $4) RETURNING *',
          [cleanFp, safeName, safeCC, safeCF]
        );
      }
      const player = pRes.rows[0];
      playerId = player.id;
      if (player.name && player.name !== 'Player') {
        safeName = player.name;
      }
    }

    // Check existing best score for this player in scores table
    let existingRes;
    if (cleanFp) {
      existingRes = await query(
        `SELECT id, score, name FROM scores
         WHERE player_fp = $1 OR player_id = $2 OR (player_fp IS NULL AND LOWER(name) = LOWER($3))
         ORDER BY score DESC`,
        [cleanFp, playerId, safeName]
      );
    } else {
      existingRes = await query(
        `SELECT id, score, name FROM scores WHERE LOWER(name) = LOWER($1) ORDER BY score DESC`,
        [safeName]
      );
    }

    let id;
    let bestPlayerScore = safeScore;

    if (existingRes.rows.length === 0) {
      const { rows } = await query(
        `INSERT INTO scores (player_id, player_fp, name, score, level, lines, duration_s, device, country_code, country_flag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [playerId, cleanFp || null, safeName, safeScore, safeLevel, safeLines, safeDuration, safeDevice, safeCC, safeCF]
      );
      id = rows[0].id;
    } else {
      id = existingRes.rows[0].id;
      const prevBest = parseInt(existingRes.rows[0].score) || 0;
      bestPlayerScore = Math.max(prevBest, safeScore);

      if (safeScore > prevBest) {
        await query(
          `UPDATE scores
           SET name=$1, score=$2, level=$3, lines=$4, duration_s=$5, device=$6,
               country_code= CASE WHEN $7 <> '' THEN $7 ELSE country_code END,
               country_flag= CASE WHEN $8 <> '' THEN $8 ELSE country_flag END,
               player_id=COALESCE($9, player_id),
               player_fp=COALESCE($10, player_fp),
               created_at=NOW()
           WHERE id=$11`,
          [safeName, safeScore, safeLevel, safeLines, safeDuration, safeDevice, safeCC, safeCF, playerId, cleanFp || null, id]
        );
      } else {
        // Keep name and player link up-to-date even if score was not beaten
        await query(
          `UPDATE scores
           SET name=$1,
               country_code= CASE WHEN country_code = '' AND $2 <> '' THEN $2 ELSE country_code END,
               country_flag= CASE WHEN country_flag = '' AND $3 <> '' THEN $3 ELSE country_flag END,
               player_id=COALESCE($4, player_id),
               player_fp=COALESCE($5, player_fp)
           WHERE id=$6`,
          [safeName, safeCC, safeCF, playerId, cleanFp || null, id]
        );
      }

      // Remove any older duplicate rows for this player so only single best score remains
      if (existingRes.rows.length > 1) {
        if (cleanFp) {
          await query(
            `DELETE FROM scores
             WHERE (player_fp = $1 OR player_id = $2 OR (player_fp IS NULL AND LOWER(name) = LOWER($3)))
               AND id <> $4`,
            [cleanFp, playerId, safeName, id]
          );
        } else {
          await query(
            `DELETE FROM scores WHERE LOWER(name) = LOWER($1) AND id <> $2`,
            [safeName, id]
          );
        }
      }
    }

    // Update last session and best_score on player row
    if (cleanFp) {
      await query(
        `UPDATE players
         SET best_score=GREATEST(COALESCE(best_score, 0), $1),
             last_score=$1, last_level=$2, last_lines=$3, last_played_at=NOW(),
             country_code=CASE WHEN $4 <> '' THEN $4 ELSE country_code END,
             country_flag=CASE WHEN $5 <> '' THEN $5 ELSE country_flag END
         WHERE fingerprint=$6`,
        [safeScore, safeLevel, safeLines, safeCC, safeCF, cleanFp]
      );
    } else {
      await query(
        `UPDATE players
         SET best_score=GREATEST(COALESCE(best_score, 0), $1),
             last_score=$1, last_level=$2, last_lines=$3, last_played_at=NOW()
         WHERE LOWER(name)=LOWER($4)`,
        [safeScore, safeLevel, safeLines, safeName]
      );
    }

    const rankRes = await query(
      `SELECT COUNT(DISTINCT COALESCE(player_fp, LOWER(name))) AS rank FROM scores WHERE score > $1`,
      [bestPlayerScore]
    );
    const rank = parseInt(rankRes.rows[0].rank) + 1;

    res.status(201).json({
      success: true, id, rank, bestScore: bestPlayerScore, isNewBest: safeScore >= bestPlayerScore,
      entry: { id, name: safeName, score: bestPlayerScore, level: safeLevel, lines: safeLines },
    });
  } catch (err) {
    console.error('POST /api/scores:', err.message);
    res.status(500).json({ success: false, error: 'Failed to save score' });
  }
});

// ══════════════════════════════════════════════════
//  PLAYER SETTINGS
// ══════════════════════════════════════════════════

const NAME_COOLDOWN_DAYS = 0;
const NAME_COOLDOWN_MS   = 0;

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
       FROM scores WHERE player_fp = $1 OR LOWER(name) = LOWER($2)`,
      [fp, player.name]
    )).rows[0];

    res.json({
      success:      true,
      isReturning:  !!player.last_played_at,
      name:         player.name,
      bestScore:    parseInt(agg?.bestScore)  || player.best_score || 0,
      bestLevel:    parseInt(agg?.bestLevel)  || player.last_level || 1,
      totalGames:   parseInt(agg?.totalGames) || 0,
      totalLines:   parseInt(agg?.totalLines) || 0,
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
      pRes = await query('SELECT * FROM players WHERE fingerprint = $1', [fp]);
    }
    const player = pRes.rows[0];
    const playerId = 'BD-' + String(player.id).padStart(5, '0');
    res.json({
      success: true,
      id: player.id,
      playerId,
      name: player.name,
      canChangeName: true,
      nextChangeAt: null,
      cooldownDays: 0
    });
  } catch (err) {
    console.error('GET /api/player:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load player' });
  }
});

// POST /api/player/name
app.post('/api/player/name', rateLimit({ windowMs: 60*1000, max: 10 }), async (req, res) => {
  const { fp, name } = req.body || {};
  if (!fp || typeof fp !== 'string')
    return res.status(400).json({ success: false, error: 'fingerprint required' });
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ success: false, error: 'name required' });

  const cleanFp   = fp.trim().slice(0, 128);
  const cleanName = name.trim().slice(0, 20);

  if (cleanName.length < 2)
    return res.status(400).json({ success: false, error: 'Name must be at least 2 characters' });
  if (cleanName.length > 20)
    return res.status(400).json({ success: false, error: 'Name cannot exceed 20 characters' });
  if (/<|>|;|--|\/\*/.test(cleanName))
    return res.status(400).json({ success: false, error: 'Invalid characters in name' });

  try {
    const pRes = await query('SELECT * FROM players WHERE fingerprint = $1', [cleanFp]);
    let playerId;
    let oldName = null;

    if (pRes.rows.length === 0) {
      const insRes = await query(
        'INSERT INTO players (fingerprint, name, name_changed_at) VALUES ($1, $2, NOW()) RETURNING id',
        [cleanFp, cleanName]
      );
      playerId = insRes.rows[0].id;
    } else {
      playerId = pRes.rows[0].id;
      oldName  = pRes.rows[0].name;
      await query(
        'UPDATE players SET name=$1, name_changed_at=NOW() WHERE fingerprint=$2',
        [cleanName, cleanFp]
      );
    }

    // ── ADAPT LEADERBOARD & PAST SCORES TO NEW NAME ─────────────
    // Any existing score recorded by this player ID or previously under their old name
    // is immediately updated so the leaderboard adapts to the new name.
    if (oldName) {
      await query(
        `UPDATE scores
         SET name=$1, player_fp=$2, player_id=$3
         WHERE player_fp=$2
            OR player_id=$3
            OR (player_fp IS NULL AND LOWER(name)=LOWER($4))`,
        [cleanName, cleanFp, playerId, oldName]
      );
    } else {
      await query(
        `UPDATE scores
         SET name=$1, player_fp=$2, player_id=$3
         WHERE player_fp=$2 OR player_id=$3`,
        [cleanName, cleanFp, playerId]
      );
    }

    const formattedId = 'BD-' + String(playerId).padStart(5, '0');

    res.json({
      success: true,
      id: playerId,
      playerId: formattedId,
      name: cleanName,
      canChangeName: true,
      nextChangeAt: null,
      cooldownDays: 0,
      message: 'Name and leaderboard updated successfully',
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
    const pRes = await query('SELECT name FROM players WHERE fingerprint = $1', [fp]);
    const playerName = pRes.rows[0]?.name;
    await query('DELETE FROM players WHERE fingerprint = $1', [fp]);
    if (playerName) {
      await query('DELETE FROM scores WHERE player_fp = $1 OR LOWER(name) = LOWER($2)', [fp, playerName]);
    } else {
      await query('DELETE FROM scores WHERE player_fp = $1', [fp]);
    }
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
