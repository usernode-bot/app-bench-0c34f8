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

// ── Tier board data ────────────────────────────────────────────────────────
// Three public tables: one list per topic board, the things to rank on it,
// and one placement row per member per thing — the newest placement is an
// upsert on (item_id, user_id), never an append. Everything here is meant to
// be seen by the whole group (usernames on votes are the point), so the
// tables stay public.
const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];

// Wraps an async route so a thrown error answers 500 JSON instead of
// crashing the process or hanging the request.
const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch(err => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });
};

// A name the group types (list or thing): trimmed text, at most 80
// characters. Returns the cleaned name, or null when it should be rejected.
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > 80) return null;
  return name;
}

app.get('/api/me', (req, res) => {
  res.json({
    user: req.user ? { id: req.user.id, username: req.user.username } : null,
    guest: !!req.guest,
  });
});

app.get('/api/lists', wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT l.id, l.name, l.created_by, l.created_by_name, l.created_at,
           COUNT(i.id) AS item_count
    FROM lists l LEFT JOIN items i ON i.list_id = l.id
    GROUP BY l.id
    ORDER BY l.created_at ASC, l.id ASC`);
  res.json(rows.map(r => ({ ...r, item_count: Number(r.item_count) })));
}));

app.post('/api/lists', wrap(async (req, res) => {
  const name = cleanName(req.body && req.body.name);
  if (!name) {
    return res.status(400).json({ error: 'Give the list a name of at most 80 characters.' });
  }
  const { rows } = await pool.query(
    'INSERT INTO lists (name, created_by, created_by_name, created_at) VALUES ($1, $2, $3, $4) RETURNING *',
    [name, req.user.id, req.user.username, req.now]);
  res.status(201).json(rows[0]);
}));

// One payload for the whole board: the list, each thing with every
// placement on it, the caller's own tier, and the crowd tally per tier.
app.get('/api/lists/:id', wrap(async (req, res) => {
  const listId = Number(req.params.id);
  if (!Number.isInteger(listId)) return res.status(404).json({ error: 'List not found.' });
  const lists = await pool.query('SELECT * FROM lists WHERE id = $1', [listId]);
  if (!lists.rows.length) return res.status(404).json({ error: 'List not found.' });
  const items = await pool.query(
    'SELECT * FROM items WHERE list_id = $1 ORDER BY lower(name), id', [listId]);
  const itemIds = items.rows.map(r => r.id);
  const placements = itemIds.length
    ? await pool.query(
        'SELECT item_id, user_id, username, tier, updated_at FROM placements WHERE item_id = ANY($1)',
        [itemIds])
    : { rows: [] };
  const byItem = new Map();
  for (const p of placements.rows) {
    let arr = byItem.get(p.item_id);
    if (!arr) byItem.set(p.item_id, (arr = []));
    arr.push(p);
  }
  res.json({
    list: lists.rows[0],
    items: items.rows.map(it => {
      const ps = byItem.get(it.id) || [];
      const tally = { S: 0, A: 0, B: 0, C: 0, D: 0, F: 0 };
      for (const p of ps) if (tally[p.tier] !== undefined) tally[p.tier] += 1;
      const mine = req.user ? ps.find(p => p.user_id === req.user.id) : null;
      return {
        id: it.id,
        name: it.name,
        added_by: it.added_by,
        added_by_name: it.added_by_name,
        created_at: it.created_at,
        placements: ps.map(p => ({
          user_id: p.user_id, username: p.username, tier: p.tier, updated_at: p.updated_at,
        })),
        my_tier: mine ? mine.tier : null,
        tally,
      };
    }),
  });
}));

app.post('/api/lists/:id/items', wrap(async (req, res) => {
  const listId = Number(req.params.id);
  if (!Number.isInteger(listId)) return res.status(404).json({ error: 'List not found.' });
  const lists = await pool.query('SELECT id FROM lists WHERE id = $1', [listId]);
  if (!lists.rows.length) return res.status(404).json({ error: 'List not found.' });
  const name = cleanName(req.body && req.body.name);
  if (!name) {
    return res.status(400).json({ error: 'Give the thing a name of at most 80 characters.' });
  }
  // Duplicates are allowed: two people can rank the same place under
  // slightly different spellings.
  const { rows } = await pool.query(
    'INSERT INTO items (list_id, name, added_by, added_by_name, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [listId, name, req.user.id, req.user.username, req.now]);
  res.status(201).json(rows[0]);
}));

app.put('/api/items/:id/placement', wrap(async (req, res) => {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId)) return res.status(404).json({ error: 'Thing not found.' });
  const tier = req.body && req.body.tier;
  if (!TIERS.includes(tier)) {
    return res.status(400).json({ error: 'Tier must be one of S, A, B, C, D, F.' });
  }
  const items = await pool.query('SELECT id FROM items WHERE id = $1', [itemId]);
  if (!items.rows.length) return res.status(404).json({ error: 'Thing not found.' });
  // Upsert: the newest placement wins. `updated_at` comes from req.now, not
  // SQL NOW(), so a staging preview shown as of a chosen moment keeps its
  // time.
  const { rows } = await pool.query(`
    INSERT INTO placements (item_id, user_id, username, tier, updated_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (item_id, user_id)
    DO UPDATE SET tier = EXCLUDED.tier, username = EXCLUDED.username, updated_at = EXCLUDED.updated_at
    RETURNING *`,
    [itemId, req.user.id, req.user.username, tier, req.now]);
  res.json(rows[0]);
}));

// ── Boot-time schema and seed data ─────────────────────────────────────────
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name text NOT NULL,
      created_by text,
      created_by_name text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS items (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      list_id integer NOT NULL REFERENCES lists(id),
      name text NOT NULL,
      added_by text,
      added_by_name text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS placements (
      item_id integer NOT NULL REFERENCES items(id),
      user_id text NOT NULL,
      username text NOT NULL,
      tier text NOT NULL CHECK (tier IN ('S', 'A', 'B', 'C', 'D', 'F')),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (item_id, user_id)
    );`);
}

// Product intent, not staging mock data: the app opens on a sample list so
// the board can be tried right away. Idempotent — it only ever fires when
// the lists table is completely empty — and attributed to the app itself,
// never to a user.
const SAMPLE_LIST_NAME = 'Bay Area restaurants';
const SAMPLE_ITEMS = [
  'Zuni Café', 'Tartine Bakery', 'La Taqueria', 'State Bird Provisions',
  'Swan Oyster Depot', 'Chez Panisse', "Ike's Love & Sandwiches", 'In-N-Out Burger',
];
const APP_NAME = 'Tier List';

async function seedSampleList() {
  const { rowCount } = await pool.query('SELECT 1 FROM lists LIMIT 1');
  if (rowCount) return;
  const list = await pool.query(
    'INSERT INTO lists (name, created_by_name) VALUES ($1, $2) RETURNING id',
    [SAMPLE_LIST_NAME, APP_NAME]);
  const listId = list.rows[0].id;
  for (const name of SAMPLE_ITEMS) {
    await pool.query(
      'INSERT INTO items (list_id, name, added_by_name) VALUES ($1, $2, $3)',
      [listId, name, APP_NAME]);
  }
}

// Staging only: placements by clearly fake demo members so the crowd view
// and the votes sheet can be seen in the preview. Fixed identities, never
// whoever opens the preview, and nothing reads their existence.
const STAGING_DEMO_VOTERS = ['staging-demo-maya', 'staging-demo-luis', 'staging-demo-priya'];
const STAGING_DEMO_VOTES = [
  { item: 'Zuni Café', tiers: ['S', 'S', 'A'] },
  { item: 'Tartine Bakery', tiers: ['A', 'A', 'S'] },
  { item: 'La Taqueria', tiers: ['C', 'C', 'S'] },
  { item: 'In-N-Out Burger', tiers: ['S', 'A', 'C'] },
];

async function seedStagingDemo() {
  const list = await pool.query('SELECT id FROM lists WHERE name = $1', [SAMPLE_LIST_NAME]);
  if (!list.rows.length) return;
  for (const vote of STAGING_DEMO_VOTES) {
    const item = await pool.query(
      'SELECT id FROM items WHERE list_id = $1 AND name = $2', [list.rows[0].id, vote.item]);
    if (!item.rows.length) continue;
    for (let i = 0; i < vote.tiers.length; i++) {
      await pool.query(`
        INSERT INTO placements (item_id, user_id, username, tier)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (item_id, user_id) DO NOTHING`,
        [item.rows[0].id, STAGING_DEMO_VOTERS[i], STAGING_DEMO_VOTERS[i], vote.tiers[i]]);
    }
  }
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

async function start() {
  await migrate();
  await seedSampleList();
  if (IS_STAGING) await seedStagingDemo();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
