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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Tier list API ─────────────────────────────────────────────────────────
// A list is a ranked collection (say, Bay Area restaurants), an item is a
// thing being ranked, and a placement is one person's tier for one item.
// Placements are append-only: a move INSERTs a row, and the latest row per
// item and person is that person's tier. Nothing is ever updated or deleted.
const TIERS = ['S', 'A', 'B', 'C', 'D'];

// The crowd tier for an item: count the latest placements per tier, the
// highest count wins, a tie breaks to the topmost tier.
function crowdTierFrom(counts) {
  let best = null;
  for (const tier of TIERS) {
    if (counts[tier] && (best === null || counts[tier] > counts[best])) best = tier;
  }
  return best;
}

function tallyPlacements(rows) {
  const counts = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  for (const row of rows) counts[row.tier] += 1;
  return counts;
}

// Every person's latest placement for the given items, one row per
// (item_id, user_id). The append-only table is collapsed here, never
// rewritten; the id breaks a same-timestamp tie deterministically.
async function latestPlacements(itemIds) {
  if (!itemIds.length) return [];
  const { rows } = await pool.query(`
    SELECT DISTINCT ON (item_id, user_id) item_id, user_id, username, tier, created_at
    FROM placements
    WHERE item_id = ANY($1)
    ORDER BY item_id, user_id, created_at DESC, id DESC
  `, [itemIds]);
  return rows;
}

// All lists, newest first, with how many items each holds.
app.get('/api/lists', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT l.id, l.title, l.username, l.created_at, COUNT(i.id)::int AS item_count
      FROM lists l LEFT JOIN items i ON i.list_id = l.id
      GROUP BY l.id
      ORDER BY l.created_at DESC, l.id DESC
    `);
    res.json({ lists: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a list. A list's only setting is its name.
app.post('/api/lists', async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
  if (title.length < 1 || title.length > 80) {
    return res.status(400).json({ error: 'A list needs a name of 1 to 80 characters.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO lists (title, created_by, username) VALUES ($1, $2, $3)
       RETURNING id, title, username, created_at`,
      [title, req.user.id, req.user.username]
    );
    res.status(201).json({ list: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One list with its items. Each item carries the viewer's own tier (null
// while unplaced), the crowd tier and the per-tier counts. Guests read this
// too, so nothing here may assume req.user.
app.get('/api/lists/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, username, created_at FROM lists WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'No such list' });
    const list = rows[0];
    const items = (await pool.query(
      `SELECT id, name, username, created_at FROM items WHERE list_id = $1 ORDER BY created_at, id`,
      [list.id]
    )).rows;
    const latest = await latestPlacements(items.map(item => item.id));
    const byItem = new Map();
    for (const row of latest) {
      if (!byItem.has(row.item_id)) byItem.set(row.item_id, []);
      byItem.get(row.item_id).push(row);
    }
    res.json({
      list,
      items: items.map(item => {
        const placements = byItem.get(item.id) || [];
        const counts = tallyPlacements(placements);
        const mine = req.user && placements.find(p => p.user_id === req.user.id);
        return {
          ...item,
          myTier: (mine && mine.tier) || null,
          crowdTier: crowdTierFrom(counts),
          counts,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add an item for everyone to rank. Names may repeat; each is its own item.
app.post('/api/lists/:id/items', async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (name.length < 1 || name.length > 80) {
    return res.status(400).json({ error: 'An item needs a name of 1 to 80 characters.' });
  }
  try {
    const found = await pool.query(`SELECT id FROM lists WHERE id = $1`, [req.params.id]);
    if (!found.rows.length) return res.status(404).json({ error: 'No such list' });
    const { rows } = await pool.query(
      `INSERT INTO items (list_id, name, created_by, username) VALUES ($1, $2, $3, $4)
       RETURNING id, name, username, created_at`,
      [found.rows[0].id, name, req.user.id, req.user.username]
    );
    res.status(201).json({ item: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One item's detail: the counts per tier and each person's latest
// placement, so anyone can check who put it where.
app.get('/api/items/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.id, i.name, i.username, i.created_at, i.list_id, l.title AS list_title
      FROM items i JOIN lists l ON l.id = i.list_id
      WHERE i.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'No such item' });
    const item = rows[0];
    const latest = await latestPlacements([item.id]);
    latest.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    res.json({
      item: { id: item.id, name: item.name, username: item.username, created_at: item.created_at },
      list: { id: item.list_id, title: item.list_title },
      counts: tallyPlacements(latest),
      placements: latest.map(p => ({
        user_id: p.user_id,
        username: p.username,
        tier: p.tier,
        mine: Boolean(req.user && p.user_id === req.user.id),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Place an item: appends a placement row. The latest row per person wins;
// history stays.
app.post('/api/items/:id/placement', async (req, res) => {
  const tier = typeof req.body.tier === 'string' ? req.body.tier.trim().toUpperCase() : '';
  if (!TIERS.includes(tier)) {
    return res.status(400).json({ error: 'Tier must be one of S, A, B, C, D.' });
  }
  try {
    const found = await pool.query(`SELECT id FROM items WHERE id = $1`, [req.params.id]);
    if (!found.rows.length) return res.status(404).json({ error: 'No such item' });
    await pool.query(
      `INSERT INTO placements (item_id, user_id, username, tier) VALUES ($1, $2, $3, $4)`,
      [found.rows[0].id, req.user.id, req.user.username, tier]
    );
    res.json({ ok: true, tier });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// Staging demo data (see "Staging mock data" in the platform conventions):
// one obviously fake list, six fake items and placements from five fake
// identities, so the Crowd view and an item's detail have something to
// show. Idempotent: a boot that finds the seed list already there does
// nothing, and no seeded row is ever owned by a real account.
const SEED_LIST_TITLE = 'Staging demo: Bay Area restaurants';
const SEED_USERS = [
  [900001, 'Staging Demo Ada'],
  [900002, 'Staging Demo Ben'],
  [900003, 'Staging Demo Cleo'],
  [900004, 'Staging Demo Dee'],
  [900005, 'Staging Demo Eli'],
];
const SEED_ITEMS = [
  'Fresh Fake Falafel',
  'Pretend Pane e Vino',
  'Demo Dumpling House',
  'Sample Sourdough Co.',
  'Mock Garden Creamery',
  'Mock Mission Burrito',
];
// Who put what where, by seed item index. The first item stays unplaced so
// the Unranked row has a resident; the others spread over the tiers so the
// Crowd view has counts to show.
const SEED_PLACEMENTS = [
  [],
  ['S', 'S', 'A', 'S', 'S'],
  ['S', 'A', 'A', 'B', 'C'],
  ['B', 'A', 'A', 'C', 'D'],
  ['A', 'C', 'B', 'B', 'C'],
  ['C', 'D', 'D', 'C', 'C'],
];

async function seedStaging() {
  const existing = await pool.query(`SELECT id FROM lists WHERE title = $1`, [SEED_LIST_TITLE]);
  if (existing.rows.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const list = await client.query(
      `INSERT INTO lists (title, created_by, username) VALUES ($1, 900000, 'Staging Demo') RETURNING id`,
      [SEED_LIST_TITLE]
    );
    for (let i = 0; i < SEED_ITEMS.length; i++) {
      const item = await client.query(
        `INSERT INTO items (list_id, name, created_by, username) VALUES ($1, $2, 900000, 'Staging Demo') RETURNING id`,
        [list.rows[0].id, SEED_ITEMS[i]]
      );
      const tiers = SEED_PLACEMENTS[i];
      for (let p = 0; p < tiers.length; p++) {
        const [userId, username] = SEED_USERS[p];
        await client.query(
          `INSERT INTO placements (item_id, user_id, username, tier) VALUES ($1, $2, $3, $4)`,
          [item.rows[0].id, userId, username, tiers[p]]
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id SERIAL PRIMARY KEY,
      title VARCHAR(80) NOT NULL,
      created_by INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id),
      name VARCHAR(80) NOT NULL,
      created_by INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS placements (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id),
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      tier VARCHAR(1) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // The starter's `presses` table is left in the database, unused, rather
  // than dropped: no data is deleted.
  if (IS_STAGING) await seedStaging();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
