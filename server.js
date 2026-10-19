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
      // authenticate a person here. The id is normalised to a string so it
      // matches the text columns it is stored in.
      if (claims && claims.pur === 'iframe') {
        req.user = Object.assign({}, claims, { id: String(claims.id) });
      }
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

// ── Tier List data ─────────────────────────────────────────────────────────
//
// One board per list. A vote is one person's placement of one item in one
// tier (S..F); the crowd average is worked out in the page from the votes.

const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];

async function bootSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id serial PRIMARY KEY,
      name text NOT NULL,
      noun text NOT NULL DEFAULT 'item',
      created_by_id text,
      created_by_name text,
      is_demo boolean NOT NULL DEFAULT false,
      demo_owner_id text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS items (
      id serial PRIMARY KEY,
      list_id integer NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      name text NOT NULL,
      added_by_id text NOT NULL,
      added_by_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS votes (
      item_id integer NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      username text NOT NULL,
      tier text NOT NULL CHECK (tier IN ('S','A','B','C','D','F')),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (item_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id serial PRIMARY KEY,
      item_id integer REFERENCES items(id) ON DELETE CASCADE,
      list_id integer REFERENCES lists(id) ON DELETE CASCADE,
      reporter_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS demo_seeded (
      user_id text PRIMARY KEY,
      seeded_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  // First list: created once, owned by nobody, so nobody can remove it.
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM lists WHERE NOT is_demo');
  if (rows[0].n === 0) {
    await pool.query("INSERT INTO lists (name, noun) VALUES ('Bay Area restaurants', 'restaurant')");
  }
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length >= 1 && t.length <= max ? t : null;
}

function fail(res, status, message) {
  return res.status(status).json({ error: message });
}

// Who is signed in — the page asks this rather than reading the URL, since
// at the app's own address there is no ?token= to read.
app.get('/api/me', (req, res) => {
  res.json(req.user ? { id: req.user.id, username: req.user.username } : null);
});

app.get('/api/lists', async (req, res) => {
  try {
    const wantDemo = IS_STAGING && req.query.demo === '1';
    if (wantDemo && req.user) await seedDemo(req.user);
    // Demo lists exist only for their owner, and only under ?demo=1 on staging.
    const viewerId = wantDemo && req.user ? req.user.id : null;
    const { rows } = await pool.query(
      `SELECT id, name, noun, created_by_id, created_by_name, is_demo
         FROM lists
        WHERE NOT is_demo OR ($1::text IS NOT NULL AND demo_owner_id = $1::text)
        ORDER BY is_demo DESC, created_at, id`,
      [viewerId]
    );
    res.json({ lists: rows });
  } catch (err) {
    console.error('GET /api/lists failed: ' + err.message);
    fail(res, 500, 'Could not load the lists');
  }
});

app.post('/api/lists', async (req, res) => {
  const name = cleanText(req.body && req.body.name, 80);
  if (!name) return fail(res, 400, 'Give the list a name of 1 to 80 characters');
  const noun = cleanText(req.body && req.body.noun, 40) || 'item';
  try {
    const { rows } = await pool.query(
      `INSERT INTO lists (name, noun, created_by_id, created_by_name)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, noun, req.user.id, req.user.username]
    );
    res.status(201).json({ list: rows[0] });
  } catch (err) {
    console.error('POST /api/lists failed: ' + err.message);
    fail(res, 500, 'Could not start the list');
  }
});

app.delete('/api/lists/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM lists WHERE id = $1', [req.params.id]);
    if (!rows[0]) return fail(res, 404, 'That list is gone');
    if (rows[0].created_by_id !== req.user.id) {
      return fail(res, 403, 'Only whoever started this list can remove it');
    }
    await pool.query('DELETE FROM lists WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/lists/:id failed: ' + err.message);
    fail(res, 500, 'Could not remove the list');
  }
});

// One list with everything on it: items, every vote, and the viewer's own
// tier per item. Guests (req.user null) get the same read-only view.
app.get('/api/lists/:id', async (req, res) => {
  try {
    const { rows: lists } = await pool.query('SELECT * FROM lists WHERE id = $1', [req.params.id]);
    if (!lists[0]) return fail(res, 404, 'That list is gone');
    const list = lists[0];
    if (list.is_demo && !(IS_STAGING && req.query.demo === '1' && req.user && req.user.id === list.demo_owner_id)) {
      return fail(res, 404, 'That list is gone');
    }
    const { rows: items } = await pool.query(
      'SELECT * FROM items WHERE list_id = $1 ORDER BY created_at, id',
      [list.id]
    );
    const { rows: votes } = await pool.query(
      'SELECT item_id, user_id, username, tier FROM votes WHERE item_id = ANY($1) ORDER BY updated_at',
      [items.map(i => i.id)]
    );
    const byItem = new Map(items.map(i => [i.id, []]));
    votes.forEach(v => {
      const bucket = byItem.get(v.item_id);
      if (bucket) bucket.push({ user_id: v.user_id, username: v.username, tier: v.tier });
    });
    res.json({
      list: {
        id: list.id, name: list.name, noun: list.noun,
        created_by_id: list.created_by_id, created_by_name: list.created_by_name,
        is_demo: list.is_demo,
      },
      items: items.map(i => ({
        id: i.id, name: i.name, added_by_id: i.added_by_id, added_by_name: i.added_by_name,
        votes: byItem.get(i.id),
      })),
    });
  } catch (err) {
    console.error('GET /api/lists/:id failed: ' + err.message);
    fail(res, 500, 'Could not load the board');
  }
});

app.post('/api/lists/:id/items', async (req, res) => {
  const name = cleanText(req.body && req.body.name, 80);
  if (!name) return fail(res, 400, 'Give it a name of 1 to 80 characters');
  try {
    const { rows: lists } = await pool.query('SELECT id FROM lists WHERE id = $1', [req.params.id]);
    if (!lists[0]) return fail(res, 404, 'That list is gone');
    const { rows: dup } = await pool.query(
      'SELECT id FROM items WHERE list_id = $1 AND lower(name) = lower($2)',
      [req.params.id, name]
    );
    if (dup[0]) return fail(res, 409, 'That one is already on this list');
    const { rows } = await pool.query(
      `INSERT INTO items (list_id, name, added_by_id, added_by_name)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, name, req.user.id, req.user.username]
    );
    res.status(201).json({ item: { ...rows[0], votes: [] } });
  } catch (err) {
    console.error('POST /api/lists/:id/items failed: ' + err.message);
    fail(res, 500, 'Could not add it');
  }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM items WHERE id = $1', [req.params.id]);
    if (!rows[0]) return fail(res, 404, 'That one is gone');
    if (rows[0].added_by_id !== req.user.id) {
      return fail(res, 403, 'Only whoever added it can remove it');
    }
    await pool.query('DELETE FROM items WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/items/:id failed: ' + err.message);
    fail(res, 500, 'Could not remove it');
  }
});

app.put('/api/items/:id/vote', async (req, res) => {
  const tier = req.body && typeof req.body.tier === 'string' ? req.body.tier.toUpperCase() : '';
  if (!TIERS.includes(tier)) return fail(res, 400, 'Pick a tier from S to F');
  try {
    const { rows } = await pool.query('SELECT id FROM items WHERE id = $1', [req.params.id]);
    if (!rows[0]) return fail(res, 404, 'That one is gone');
    await pool.query(
      `INSERT INTO votes (item_id, user_id, username, tier)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (item_id, user_id)
       DO UPDATE SET tier = EXCLUDED.tier, username = EXCLUDED.username, updated_at = now()`,
      [req.params.id, req.user.id, req.user.username, tier]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/items/:id/vote failed: ' + err.message);
    fail(res, 500, 'Could not save your vote');
  }
});

app.delete('/api/items/:id/vote', async (req, res) => {
  try {
    await pool.query('DELETE FROM votes WHERE item_id = $1 AND user_id = $2',
      [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/items/:id/vote failed: ' + err.message);
    fail(res, 500, 'Could not clear your vote');
  }
});

// Reports are recorded only; nothing is hidden by this app.
app.post('/api/reports', async (req, res) => {
  const itemId = req.body && req.body.itemId;
  const listId = req.body && req.body.listId;
  if (!itemId && !listId) return fail(res, 400, 'Say what you are reporting');
  try {
    if (itemId) {
      const { rows } = await pool.query('SELECT id FROM items WHERE id = $1', [itemId]);
      if (!rows[0]) return fail(res, 404, 'That one is gone');
      await pool.query('INSERT INTO reports (item_id, reporter_id) VALUES ($1, $2)',
        [itemId, req.user.id]);
    } else {
      const { rows } = await pool.query('SELECT id FROM lists WHERE id = $1', [listId]);
      if (!rows[0]) return fail(res, 404, 'That list is gone');
      await pool.query('INSERT INTO reports (list_id, reporter_id) VALUES ($1, $2)',
        [listId, req.user.id]);
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('POST /api/reports failed: ' + err.message);
    fail(res, 500, 'Could not send the report');
  }
});

// ── Staging demo ───────────────────────────────────────────────────────────
//
// Only on staging, only under ?demo=1, once per viewer: a populated demo
// list of Bay Area restaurants with three made-up friends' votes and the
// viewer's own nine votes already in. Never re-seeded, so what the viewer
// changes stays.

const DEMO_PEOPLE = [
  { id: 'staging-demo-maya', username: 'Maya' },
  { id: 'staging-demo-dev', username: 'Dev' },
  { id: 'staging-demo-jon', username: 'Jon' },
];

// adder: 'you' (the viewer), or a demo person's username. votes: one entry
// per voter; the viewer's nine votes come from the 'you' entries.
const DEMO_ITEMS = [
  { name: 'Tartine Bakery', addedBy: 'you', votes: { you: 'S', Maya: 'S', Dev: 'S', Jon: 'B' } },
  { name: 'Nopalito', addedBy: 'Dev', votes: { you: 'S', Jon: 'S' } },
  { name: 'Swan Oyster Depot', addedBy: 'Dev', votes: { you: 'A', Dev: 'A', Maya: 'S', Jon: 'B' } },
  { name: 'Zuni Café', addedBy: 'Maya', votes: { you: 'A', Dev: 'A', Maya: 'B' } },
  { name: 'La Taqueria', addedBy: 'you', votes: { you: 'A', Maya: 'A', Dev: 'S', Jon: 'A' } },
  { name: 'Burma Superstar', addedBy: 'Jon', votes: { you: 'B', Jon: 'B', Maya: 'A' } },
  { name: 'Mission Chinese', addedBy: 'Dev', votes: { you: 'B', Dev: 'C', Jon: 'B' } },
  { name: 'Lers Ros', addedBy: 'Maya', votes: { you: 'C', Dev: 'C', Maya: 'B' } },
  { name: 'Pier crab stand', addedBy: 'Jon', votes: { you: 'D', Jon: 'C', Maya: 'D' } },
  { name: 'Rich Table', addedBy: 'Jon', votes: {} },
  { name: "Sam's Chowder House", addedBy: 'Maya', votes: {} },
];

async function seedDemo(user) {
  // Claim first: whoever holds the demo_seeded row owns the seeding, so a
  // slow first load never writes the demo twice.
  const claim = await pool.query(
    'INSERT INTO demo_seeded (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING user_id',
    [user.id]
  );
  if (claim.rowCount === 0) return;
  const people = new Map(DEMO_PEOPLE.map(p => [p.username, p]));
  const { rows: lists } = await pool.query(
    `INSERT INTO lists (name, noun, created_by_id, created_by_name, is_demo, demo_owner_id)
     VALUES ('Bay Area restaurants', 'restaurant', $1, $2, true, $1) RETURNING id`,
    [user.id, user.username]
  );
  const listId = lists[0].id;
  for (const def of DEMO_ITEMS) {
    const adder = def.addedBy === 'you'
      ? { id: user.id, username: user.username }
      : people.get(def.addedBy);
    const { rows: items } = await pool.query(
      `INSERT INTO items (list_id, name, added_by_id, added_by_name)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [listId, def.name, adder.id, adder.username]
    );
    for (const [who, tier] of Object.entries(def.votes)) {
      const voter = who === 'you' ? { id: user.id, username: user.username } : people.get(who);
      await pool.query(
        'INSERT INTO votes (item_id, user_id, username, tier) VALUES ($1, $2, $3, $4)',
        [items[0].id, voter.id, voter.username, tier]
      );
    }
  }
}

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

// ── Boot and shutdown ──────────────────────────────────────────────────────

let server;

async function start() {
  await bootSchema();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

function shutdown() {
  if (!server) process.exit(0);
  console.log('Shutting down: stopping the listener and draining');
  server.close(() => process.exit(0));
  // Drain in-flight requests for about 3 s, then close the pool and exit.
  setTimeout(() => pool.end().then(() => process.exit(0)), 3000).unref();
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(err => { console.error(err); process.exit(1); });