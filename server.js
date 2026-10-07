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

const DRAIN_MS = 3000;
let shuttingDown = false;

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'draining' });
  res.json({ status: 'ok' });
});

// ── Tier board: schema, seed and API ──────────────────────────────────────
//
// Two tables carry the whole app: `items` (the shared list of things) and
// `placements` (append-only, one row per user per move — nothing is ever
// updated or deleted, so a person's current tier for a thing is simply
// their newest row for it). Both are public by default: they carry only
// names people chose and public Homeroom usernames.

const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id bigserial PRIMARY KEY,
      name text NOT NULL,
      created_by text,
      created_by_name text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  // Case-insensitive unique name: backs the duplicate refusal on POST.
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS items_name_lower_key ON items (lower(name))');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS placements (
      id bigserial PRIMARY KEY,
      item_id bigint NOT NULL REFERENCES items(id),
      user_id text NOT NULL,
      username text NOT NULL,
      tier text NOT NULL CHECK (tier IN ('S', 'A', 'B', 'C', 'D', 'F')),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS placements_item_user_idx
    ON placements (item_id, user_id, created_at DESC)`);
}

// Every person's current tier per thing, in one pass: the newest row wins.
const CURRENT_PLACEMENTS_SQL = `
  SELECT DISTINCT ON (item_id, user_id)
         item_id, user_id, username, tier, created_at, id
  FROM placements
  ORDER BY item_id, user_id, created_at DESC, id DESC`;

// The crowd's lead for a thing: most votes wins, and because TIERS runs
// S down to F, a tie keeps the tier met first — the higher one.
function leadTier(counts) {
  let lead = null;
  let best = 0;
  for (const tier of TIERS) {
    const n = counts[tier] || 0;
    if (n > best) { lead = tier; best = n; }
  }
  return lead;
}

async function crowdCounts() {
  const { rows } = await pool.query(CURRENT_PLACEMENTS_SQL);
  const byItem = new Map();
  for (const row of rows) {
    let counts = byItem.get(row.item_id);
    if (!counts) { counts = {}; byItem.set(row.item_id, counts); }
    counts[row.tier] = (counts[row.tier] || 0) + 1;
  }
  return byItem;
}

function itemWithCounts(row, counts) {
  return {
    ...row,
    counts,
    votes: Object.values(counts).reduce((a, b) => a + b, 0),
    lead: leadTier(counts),
  };
}

// Anyone (a signed-in person or a guest) can read the shared list.
app.get('/api/items', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, created_by, created_by_name, created_at FROM items ORDER BY created_at DESC, id DESC');
    const countsByItem = await crowdCounts();
    res.json({
      viewer: { signedIn: Boolean(_req.user) },
      items: rows.map((row) => itemWithCounts(row, countsByItem.get(row.id) || {})),
    });
  } catch (err) {
    console.error('GET /api/items failed: ' + err.message);
    res.status(500).json({ error: 'Could not load the list of things.' });
  }
});

app.post('/api/items', async (req, res) => {
  const name = typeof (req.body && req.body.name) === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Type a name first.' });
  if (name.length > 60) return res.status(400).json({ error: 'Keep the name under 60 characters.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO items (name, created_by, created_by_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (lower(name)) DO NOTHING
       RETURNING id, name, created_by, created_by_name, created_at`,
      [name, req.user.id, req.user.username]);
    if (!rows.length) return res.status(409).json({ error: 'That thing is already on the list.' });
    res.status(201).json({ item: itemWithCounts(rows[0], {}) });
  } catch (err) {
    console.error('POST /api/items failed: ' + err.message);
    res.status(500).json({ error: 'Could not add that thing. Try again.' });
  }
});

// The viewer's current tier per thing. Guests have no board; reads must not
// assume req.user, so they get an empty one rather than an error.
app.get('/api/board', async (req, res) => {
  if (!req.user) return res.json({ board: {} });
  try {
    const { rows } = await pool.query(
      `SELECT item_id, tier, created_at FROM (${CURRENT_PLACEMENTS_SQL}) current
       WHERE user_id = $1`,
      [req.user.id]);
    const board = {};
    for (const row of rows) board[row.item_id] = { tier: row.tier, placed_at: row.created_at };
    res.json({ board });
  } catch (err) {
    console.error('GET /api/board failed: ' + err.message);
    res.status(500).json({ error: 'Could not load your board.' });
  }
});

app.get('/api/crowd', async (_req, res) => {
  try {
    const countsByItem = await crowdCounts();
    const crowd = {};
    for (const [itemId, counts] of countsByItem) {
      crowd[itemId] = { counts, lead: leadTier(counts) };
    }
    res.json({ crowd });
  } catch (err) {
    console.error('GET /api/crowd failed: ' + err.message);
    res.status(500).json({ error: 'Could not load the crowd view.' });
  }
});

app.get('/api/items/:id/votes', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'Thing not found.' });
  try {
    const { rows: items } = await pool.query('SELECT id, name FROM items WHERE id = $1', [id]);
    if (!items.length) return res.status(404).json({ error: 'Thing not found.' });
    const { rows } = await pool.query(
      `SELECT username, tier FROM (${CURRENT_PLACEMENTS_SQL}) current
       WHERE item_id = $1
       ORDER BY created_at DESC, id DESC`,
      [id]);
    // One group per tier someone picked, S down to F, newest voter first.
    const groups = TIERS
      .map((tier) => ({ tier, voters: rows.filter((r) => r.tier === tier).map((r) => r.username) }))
      .filter((g) => g.voters.length);
    res.json({ item: items[0], groups });
  } catch (err) {
    console.error('GET /api/items/:id/votes failed: ' + err.message);
    res.status(500).json({ error: 'Could not load the votes.' });
  }
});

// A move appends one row; there is no update or delete route.
app.put('/api/placements', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const itemId = Number(req.body && req.body.item_id);
  const tier = req.body && req.body.tier;
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: 'Which thing to rank is missing.' });
  }
  if (!TIERS.includes(tier)) return res.status(400).json({ error: 'Pick a tier from S to F.' });
  try {
    const { rows: items } = await pool.query('SELECT id FROM items WHERE id = $1', [itemId]);
    if (!items.length) return res.status(404).json({ error: 'Thing not found.' });
    const { rows } = await pool.query(
      `INSERT INTO placements (item_id, user_id, username, tier)
       VALUES ($1, $2, $3, $4)
       RETURNING item_id, tier, created_at`,
      [itemId, req.user.id, req.user.username, tier]);
    res.status(201).json({ placement: rows[0] });
  } catch (err) {
    console.error('PUT /api/placements failed: ' + err.message);
    res.status(500).json({ error: 'Could not save that move. Try again.' });
  }
});

// ── Staging seed ──────────────────────────────────────────────────────────
// Obviously fake bay area restaurants and votes from fake people, so the
// crowd view and the vote dialog have content on a fresh staging database.
// Idempotent, fixed ids, never attributed to whoever opens the preview.
const SEED_ITEMS = [
  [1, 'Staging demo: Burma Superstar', 'staging-demo-ana'],
  [2, 'Staging demo: La Taqueria', 'staging-demo-rai'],
  [3, 'Staging demo: House of Prime Rib', 'staging-demo-ana'],
  [4, "Staging demo: Ike's Place", 'staging-demo-rai'],
  [5, 'Staging demo: Tartine Bakery', 'staging-demo-ana'],
  [6, 'Staging demo: The Slanted Door', 'staging-demo-rai'],
  [7, 'Staging demo: Philz Coffee', 'staging-demo-ana'],
];
const SEED_PLACEMENTS = [
  [1, 1, 'staging-demo-mika', 'S'],
  [2, 1, 'staging-demo-rai', 'S'],
  [3, 1, 'staging-demo-ana', 'A'],
  [4, 2, 'staging-demo-ana', 'S'],
  [5, 2, 'staging-demo-mika', 'S'],
  [6, 3, 'staging-demo-ana', 'A'],
  [7, 3, 'staging-demo-rai', 'A'],
  [8, 4, 'staging-demo-mika', 'B'],
  [9, 5, 'staging-demo-ana', 'C'],
  [10, 5, 'staging-demo-mika', 'C'],
  [11, 6, 'staging-demo-rai', 'D'],
  [12, 6, 'staging-demo-mika', 'D'],
];

async function seedStaging() {
  for (const [id, name, creator] of SEED_ITEMS) {
    await pool.query(
      `INSERT INTO items (id, name, created_by, created_by_name)
       VALUES ($1, $2, $3, $3) ON CONFLICT (id) DO NOTHING`,
      [id, name, creator]);
  }
  for (const [id, itemId, user, tier] of SEED_PLACEMENTS) {
    await pool.query(
      `INSERT INTO placements (id, item_id, user_id, username, tier)
       VALUES ($1, $2, $3, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [id, itemId, user, tier]);
  }
  // Fixed-id seeds must not wind the sequences backwards: new rows start
  // above the highest seeded id, or the first real insert collides.
  await pool.query(`SELECT setval(pg_get_serial_sequence('items', 'id'),
    GREATEST((SELECT COALESCE(MAX(id), 0) FROM items), 1))`);
  await pool.query(`SELECT setval(pg_get_serial_sequence('placements', 'id'),
    GREATEST((SELECT COALESCE(MAX(id), 0) FROM placements), 1))`);
}

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

let server = null;

async function start() {
  await ensureSchema();
  if (IS_STAGING) await seedStaging();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

async function shutdown(signal) {
  if (shuttingDown) return; // a repeat signal during the drain must be a no-op
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  server.close(() => {});
  server.closeIdleConnections?.();
  const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
  t.unref?.();
  try {
    await pool.end();
  } catch (err) {
    console.error('[shutdown] pool.end failed: ' + err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
