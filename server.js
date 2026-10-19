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

// ── Tier List data ─────────────────────────────────────────────────────────
// Lists are shared by the whole group; anyone may add items and vote on them.
// `reports` is marked private so the schema reaches staging without its rows.
const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];

async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id serial PRIMARY KEY,
      name text NOT NULL,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      demo_for text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS lists_demo_for_name_key
      ON lists (demo_for, name) WHERE demo_for IS NOT NULL;
    CREATE TABLE IF NOT EXISTS items (
      id serial PRIMARY KEY,
      list_id integer NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      name text NOT NULL,
      added_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS items_list_id_idx ON items (list_id);
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
      item_id integer NOT NULL,
      reporter text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE reports IS 'staging:private';
  `);
}

function canUseDemo(req) {
  return IS_STAGING && req.query.demo === '1' && !!req.user;
}

async function loadListRow(id, req) {
  if (!/^\d+$/.test(String(id))) return null;
  const { rows } = await pool.query('SELECT * FROM lists WHERE id = $1', [id]);
  const list = rows[0];
  if (!list) return null;
  if (list.demo_for && !(canUseDemo(req) && String(list.demo_for) === String(req.user.id))) return null;
  return list;
}

async function loadItemRow(id, req) {
  if (!/^\d+$/.test(String(id))) return null;
  const { rows } = await pool.query(
    `SELECT i.* FROM items i JOIN lists l ON l.id = i.list_id WHERE i.id = $1`, [id]
  );
  const item = rows[0];
  if (!item) return null;
  if (item.list_id) {
    const list = await pool.query('SELECT demo_for FROM lists WHERE id = $1', [item.list_id]);
    const row = list.rows[0];
    if (!row) return null;
    if (row.demo_for && !(canUseDemo(req) && String(row.demo_for) === String(req.user.id))) return null;
  }
  return item;
}

function cleanName(value, max) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > max) return null;
  return name;
}

// The staging preview's populated demo, written once per viewer for ?demo=1.
const DEMO_FRIENDS = [
  { id: 'demo-maya', username: 'Maya' },
  { id: 'demo-dev', username: 'Dev' },
  { id: 'demo-jo', username: 'Jo' },
  { id: 'demo-sam', username: 'Sam' },
];

// tier per friend, plus the viewer's own tier (null = still in the tray)
const DEMO_RESTAURANTS = [
  { name: 'Zuni Cafe', by: 'Maya', you: 'S', f: ['S', 'S', 'A', 'A'] },
  { name: 'Tartine Bakery', by: 'Dev', you: 'A', f: ['S', 'A', 'A', 'B'] },
  { name: 'Swan Oyster Depot', by: null, you: 'A', f: ['S', 'A', 'A', 'B'] },
  { name: 'La Taqueria', by: 'Jo', you: 'A', f: ['S', 'S', 'S', 'A'] },
  { name: 'Nopa', by: 'Sam', you: 'A', f: ['A', 'B', 'A', 'A'] },
  { name: 'Burma Superstar', by: 'Maya', you: 'B', f: ['A', 'B', 'B', 'A'] },
  { name: 'Pizzeria Delfina', by: 'Dev', you: 'B', f: ['B', 'C', 'B', 'A'] },
  { name: 'Yank Sing', by: 'Jo', you: 'B', f: ['A', 'A', 'A', 'B'] },
  { name: "Gott's Roadside", by: 'Maya', you: 'B', f: ['C', 'C', 'C', 'B'] },
  { name: 'Mission Chinese', by: 'Sam', you: 'C', f: ['B', 'B', 'B', 'A'] },
  { name: 'Anchor Oyster Bar', by: 'Dev', you: 'C', f: ['C', 'C', 'D', 'B'] },
  { name: "Fisherman's Wharf crab", by: 'Jo', you: 'D', f: ['D', 'C', 'D', 'D'] },
  { name: 'Sushi Ran', by: 'Maya', you: null, f: ['S', 'A', 'B', 'A'] },
  { name: 'Cheese Board Pizza', by: 'Dev', you: null, f: ['A', 'A', 'A', 'B'] },
  { name: "Brenda's French Soul Food", by: 'Jo', you: null, f: ['B', 'A', 'B', 'B'] },
];

const DEMO_MOVIES = [
  { name: 'The Princess Bride', by: null, you: 'S', f: ['S', 'S', 'A', 'A'] },
  { name: 'Paddington 2', by: 'Maya', you: 'S', f: ['S', 'A', 'S', 'A'] },
  { name: 'Spirited Away', by: 'Dev', you: 'A', f: ['A', 'A', 'B', 'A'] },
  { name: 'Toy Story', by: 'Jo', you: 'A', f: ['A', 'B', 'A', 'B'] },
  { name: 'Matilda', by: 'Sam', you: 'B', f: ['B', 'B', 'A', 'B'] },
  { name: 'The Muppet Movie', by: 'Maya', you: 'B', f: ['B', 'C', 'B', 'B'] },
];

async function seedDemo(userId, username) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['tier-demo:' + userId]);
    const has = await client.query('SELECT 1 FROM lists WHERE demo_for = $1 LIMIT 1', [userId]);
    if (has.rowCount) {
      await client.query('ROLLBACK');
      return;
    }
    const makeList = async (name, rows) => {
      const l = await client.query(
        'INSERT INTO lists (name, created_by, demo_for) VALUES ($1, $2, $3) RETURNING id',
        [name, username, userId]
      );
      const listId = l.rows[0].id;
      const you = userId;
      const friends = DEMO_FRIENDS.map((f) => ({ id: f.id, username: f.username }));
      let order = 0;
      for (const row of rows) {
        const addedBy = row.by || username;
        const ins = await client.query(
          `INSERT INTO items (list_id, name, added_by, created_at)
           VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval) RETURNING id`,
          [listId, row.name, addedBy, order++]
        );
        const itemId = ins.rows[0].id;
        if (row.you) {
          await client.query(
            `INSERT INTO votes (item_id, user_id, username, tier) VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [itemId, you, username, row.you]
          );
        }
        for (let i = 0; i < friends.length; i++) {
          const f = friends[i];
          const tier = row.f[i];
          if (!tier) continue;
          await client.query(
            `INSERT INTO votes (item_id, user_id, username, tier) VALUES ($1, $2, $3, $4)
             ON CONFLICT DO NOTHING`,
            [itemId, f.id, f.username, tier]
          );
        }
      }
      return listId;
    };
    await makeList('Bay Area restaurants', DEMO_RESTAURANTS);
    await makeList('Movies to rewatch', DEMO_MOVIES);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

app.get('/api/lists', async (req, res) => {
  try {
    const demo = canUseDemo(req);
    if (demo) await seedDemo(req.user.id, req.user.username);
    const { rows } = await pool.query(
      `SELECT l.id, l.name, l.created_by, l.created_at, (l.demo_for IS NOT NULL) AS demo,
        (SELECT count(*)::int FROM items i WHERE i.list_id = l.id) AS item_count,
        (SELECT count(DISTINCT v.user_id)::int FROM votes v
           JOIN items i ON i.id = v.item_id WHERE i.list_id = l.id) AS voter_count
       FROM lists l
       WHERE l.demo_for IS NULL OR ($1::boolean AND l.demo_for = $2)
       ORDER BY l.created_at DESC, l.id DESC`,
      [demo, req.user ? req.user.id : null]
    );
    res.json({ lists: rows, viewer: req.user ? { id: req.user.id, username: req.user.username } : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load lists' });
  }
});

app.post('/api/lists', async (req, res) => {
  const name = cleanName(req.body && req.body.name, 60);
  if (!name) return res.status(400).json({ error: 'A list needs a name of 1 to 60 characters' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO lists (name, created_by) VALUES ($1, $2) RETURNING id, name, created_by, created_at, false AS demo',
      [name, req.user.username]
    );
    res.status(201).json({ list: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not create the list' });
  }
});

app.delete('/api/lists/:id', async (req, res) => {
  try {
    const list = await loadListRow(req.params.id, req);
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (list.created_by !== req.user.username) {
      return res.status(403).json({ error: 'Only whoever started this list can delete it' });
    }
    await pool.query('DELETE FROM lists WHERE id = $1', [list.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not delete the list' });
  }
});

app.get('/api/lists/:id', async (req, res) => {
  try {
    const list = await loadListRow(req.params.id, req);
    if (!list) return res.status(404).json({ error: 'List not found' });
    const uid = req.user ? req.user.id : null;
    const items = await pool.query(
      `SELECT i.id, i.name, i.added_by, i.created_at, v.tier AS your_tier
       FROM items i LEFT JOIN votes v ON v.item_id = i.id AND v.user_id = $2
       WHERE i.list_id = $1 ORDER BY i.created_at, i.id`,
      [list.id, uid]
    );
    const votes = await pool.query(
      `SELECT v.item_id, v.username, v.tier FROM votes v
       JOIN items i ON i.id = v.item_id WHERE i.list_id = $1 ORDER BY v.username`,
      [list.id]
    );
    const byItem = new Map();
    for (const v of votes.rows) {
      if (!byItem.has(v.item_id)) byItem.set(v.item_id, []);
      byItem.get(v.item_id).push({ username: v.username, tier: v.tier });
    }
    res.json({
      list: {
        id: list.id,
        name: list.name,
        created_by: list.created_by,
        demo: !!list.demo_for,
        items: items.rows.map((i) => ({
          id: i.id,
          name: i.name,
          added_by: i.added_by,
          your_tier: i.your_tier || null,
          votes: byItem.get(i.id) || [],
        })),
      },
      viewer: req.user ? { id: req.user.id, username: req.user.username } : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load the list' });
  }
});

app.post('/api/lists/:id/items', async (req, res) => {
  const name = cleanName(req.body && req.body.name, 80);
  if (!name) return res.status(400).json({ error: 'An item needs a name of 1 to 80 characters' });
  try {
    const list = await loadListRow(req.params.id, req);
    if (!list) return res.status(404).json({ error: 'List not found' });
    const { rows } = await pool.query(
      `INSERT INTO items (list_id, name, added_by) VALUES ($1, $2, $3)
       RETURNING id, name, added_by, created_at`,
      [list.id, name, req.user.username]
    );
    res.status(201).json({ item: { ...rows[0], your_tier: null, votes: [] } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not add the item' });
  }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    const item = await loadItemRow(req.params.id, req);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.added_by !== req.user.username) {
      return res.status(403).json({ error: 'Only whoever added this item can remove it' });
    }
    await pool.query('DELETE FROM items WHERE id = $1', [item.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not remove the item' });
  }
});

app.put('/api/items/:id/vote', async (req, res) => {
  const tier = req.body && req.body.tier;
  if (!TIERS.includes(tier)) return res.status(400).json({ error: 'Pick a tier from S to F' });
  try {
    const item = await loadItemRow(req.params.id, req);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    await pool.query(
      `INSERT INTO votes (item_id, user_id, username, tier, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (item_id, user_id)
       DO UPDATE SET tier = EXCLUDED.tier, username = EXCLUDED.username, updated_at = now()`,
      [item.id, req.user.id, req.user.username, tier]
    );
    res.json({ ok: true, tier });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not save the vote' });
  }
});

app.delete('/api/items/:id/vote', async (req, res) => {
  try {
    const item = await loadItemRow(req.params.id, req);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    await pool.query('DELETE FROM votes WHERE item_id = $1 AND user_id = $2', [item.id, req.user.id]);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not take the vote away' });
  }
});

app.post('/api/items/:id/report', async (req, res) => {
  try {
    const item = await loadItemRow(req.params.id, req);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    await pool.query('INSERT INTO reports (item_id, reporter) VALUES ($1, $2)', [item.id, req.user.username]);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not record the report' });
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

let startedServer = null;

async function start() {
  await createSchema();
  startedServer = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  startedServer.keepAliveTimeout = 75_000;
}

// Stop accepting connections, give in-flight requests about 3 s, then close
// the pool and exit.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  if (startedServer) startedServer.close();
  const timer = setTimeout(async () => {
    try { await pool.end(); } catch {}
    process.exit(0);
  }, 3000);
  timer.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
