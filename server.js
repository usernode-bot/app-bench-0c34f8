const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'closing' });
  res.json({ status: 'ok' });
});

// ── The tier board ────────────────────────────────────────────────────────
// Two public tables: items are the things being ranked, placements are one
// person's tier choice per item (the primary key enforces one each). Reads
// work for guests, so neither route assumes req.user; the auth middleware
// above already answers a guest's writes with 401 account_required.

const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];

// The crowd's average treats the tiers as even steps, S = 0 through F = 5,
// and rounds half up to the later letter (a 1.5 lands on B, not A).
function crowdTier(avg) {
  if (avg === null || avg === undefined) return null;
  return TIERS[Math.min(Math.round(avg), TIERS.length - 1)];
}

const TIER_SCORE_SQL =
  "AVG(CASE tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 " +
  "WHEN 'C' THEN 3 WHEN 'D' THEN 4 WHEN 'F' THEN 5 END)";

function rowToItem(row) {
  return {
    // pg hands bigints back as text; the board's ids are plain numbers.
    id: Number(row.id),
    name: row.name,
    added_by: row.added_by,
    created_at: row.created_at,
    mine: row.mine || null,
    crowd: crowdTier(row.crowd_score),
    votes: row.votes || 0,
  };
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id bigserial PRIMARY KEY,
      name text NOT NULL,
      added_by text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS placements (
      item_id bigint NOT NULL REFERENCES items(id),
      user_id text NOT NULL,
      username text NOT NULL,
      tier text NOT NULL CHECK (tier IN ('S', 'A', 'B', 'C', 'D', 'F')),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (item_id, user_id)
    );
  `);
}

app.get('/api/items', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.id, i.name, i.added_by, i.created_at,
              m.tier AS mine,
              c.crowd_score,
              c.votes
         FROM items i
         LEFT JOIN placements m
           ON m.item_id = i.id AND m.user_id = $1
         LEFT JOIN (
           SELECT item_id, ${TIER_SCORE_SQL} AS crowd_score, COUNT(*)::int AS votes
             FROM placements
            GROUP BY item_id
         ) c ON c.item_id = i.id
        ORDER BY i.created_at, i.id`,
      [req.user ? req.user.id : null]
    );
    res.json(rows.map(rowToItem));
  } catch (err) {
    console.error('GET /api/items failed: ' + err.message);
    res.status(500).json({ error: 'Could not load the board.' });
  }
});

app.post('/api/items', async (req, res) => {
  const name = typeof (req.body && req.body.name) === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) {
    return res.status(400).json({ error: 'Name must be 1 to 80 characters.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO items (name, added_by, created_at)
       VALUES ($1, $2, $3)
       RETURNING id, name, added_by, created_at`,
      [name, req.user.id, req.now]
    );
    res.status(201).json(rowToItem({ ...rows[0], mine: null, crowd_score: null, votes: 0 }));
  } catch (err) {
    console.error('POST /api/items failed: ' + err.message);
    res.status(500).json({ error: 'Could not add the item.' });
  }
});

app.put('/api/items/:id/placement', async (req, res) => {
  const tier = req.body && req.body.tier;
  if (!TIERS.includes(tier)) {
    return res.status(400).json({ error: 'Tier must be one of S, A, B, C, D, F.' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: 'Item not found.' });
  }
  try {
    const found = await pool.query('SELECT id FROM items WHERE id = $1', [id]);
    if (!found.rows.length) return res.status(404).json({ error: 'Item not found.' });
    // One placement per person per item: the primary key upserts, so a new
    // drag replaces the earlier tier.
    await pool.query(
      `INSERT INTO placements (item_id, user_id, username, tier, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (item_id, user_id)
       DO UPDATE SET tier = EXCLUDED.tier, username = EXCLUDED.username,
                     updated_at = EXCLUDED.updated_at`,
      [id, req.user.id, req.user.username || '', tier, req.now]
    );
    res.json({ item_id: id, mine: tier });
  } catch (err) {
    console.error('PUT /api/items/:id/placement failed: ' + err.message);
    res.status(500).json({ error: 'Could not save the placement.' });
  }
});

app.get('/api/items/:id/placements', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: 'Item not found.' });
  }
  try {
    const found = await pool.query('SELECT id FROM items WHERE id = $1', [id]);
    if (!found.rows.length) return res.status(404).json({ error: 'Item not found.' });
    const { rows } = await pool.query(
      `SELECT user_id, username, tier, updated_at
         FROM placements
        WHERE item_id = $1
        ORDER BY updated_at, user_id`,
      [id]
    );
    const avg = rows.length
      ? rows.reduce((sum, r) => sum + TIERS.indexOf(r.tier), 0) / rows.length
      : null;
    res.json({ placements: rows, crowd: crowdTier(avg) });
  } catch (err) {
    console.error('GET /api/items/:id/placements failed: ' + err.message);
    res.status(500).json({ error: 'Could not load the votes.' });
  }
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/tier-list/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/tier-list/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Staging seed ──────────────────────────────────────────────────────────
// A fresh staging database would show an empty board, so seed eight obviously
// fake bay area restaurants and a few placements attributed to fixed demo
// users — never a real user, and never whoever opens the preview: their own
// My tiers view starts empty, which is what production looks like.
// Idempotent: explicit ids with ON CONFLICT DO NOTHING, so every boot is a
// no-op once the rows exist.
const SEED_ITEMS = [
  'Fog City Burrito',
  'Golden Gate Bagels',
  'Sourdough Shack',
  'Cable Car Coffee',
  'Bay Bridge Bistro',
  'Presidio Poke',
  'Mission Melt',
  'Berkeley Boba',
];

const SEED_PLACEMENTS = [
  ['staging-demo-ada', { 1: 'S', 2: 'A', 3: 'B', 4: 'B', 7: 'C' }],
  ['staging-demo-bruno', { 1: 'A', 2: 'A', 3: 'B', 4: 'A', 6: 'D', 7: 'C' }],
  ['staging-demo-cleo', { 1: 'S', 2: 'B', 4: 'S', 5: 'C', 7: 'D' }],
];

async function seedStaging() {
  const seededAt = new Date();
  await pool.query('BEGIN');
  try {
    for (let i = 0; i < SEED_ITEMS.length; i++) {
      await pool.query(
        `INSERT INTO items (id, name, added_by, created_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [i + 1, 'Staging demo: ' + SEED_ITEMS[i], 'staging-demo-requester', seededAt]
      );
    }
    for (const [userId, tiers] of SEED_PLACEMENTS) {
      for (const [itemId, tier] of Object.entries(tiers)) {
        await pool.query(
          `INSERT INTO placements (item_id, user_id, username, tier, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (item_id, user_id) DO NOTHING`,
          [Number(itemId), userId, userId, tier, seededAt]
        );
      }
    }
    // The seed inserts explicit ids; push the sequence past them so the next
    // real item does not collide.
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('items', 'id'),
                     (SELECT COALESCE(MAX(id), 1) FROM items))`
    );
    await pool.query('COMMIT');
  } catch (err) {
    await pool.query('ROLLBACK');
    throw err;
  }
}

async function start() {
  await ensureSchema();
  if (IS_STAGING) await seedStaging();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  return server;
}

// ── Graceful shutdown ─────────────────────────────────────────────────────
// Containers are stopped and replaced on every deploy: stop accepting
// connections, let in-flight requests finish under a hard deadline, close
// the pool, exit. A repeat signal during the drain is a no-op.
const DRAIN_MS = 3000;
let shuttingDown = false;
let currentServer = null;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (currentServer) {
    currentServer.close(() => {});
    currentServer.closeIdleConnections?.();
    const t = setTimeout(() => currentServer.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
  }
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed: ' + e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start()
  .then(server => { currentServer = server; })
  .catch(err => { console.error(err); process.exit(1); });
