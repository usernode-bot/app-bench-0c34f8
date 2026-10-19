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

app.get('/api/me', (req, res) => {
  // A guest reads without an account; their writes are refused downstream.
  res.json({ id: req.user ? req.user.id : null, username: req.user ? req.user.username : null });
});

// ── Tier List data ────────────────────────────────────────────────────────
const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];

// Public tables except `reports`, which records abuse reports for the
// group's admins: schema-only on staging (`staging:private`), and no public
// table points into it.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id serial PRIMARY KEY,
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      demo_for text
    );
    -- A viewer's demo lists: one row per (viewer, name), so a viewer can
    -- hold two demo lists and a racing seed still loses the index. NULLs
    -- (real lists) are distinct in a unique index, so real lists are
    -- untouched.
    ALTER TABLE lists DROP CONSTRAINT IF EXISTS lists_demo_for_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS lists_demo_for_key ON lists (demo_for, name);
    CREATE TABLE IF NOT EXISTS items (
      id serial PRIMARY KEY,
      list_id integer NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
      added_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS votes (
      item_id integer NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      username text NOT NULL,
      tier text NOT NULL CHECK (tier IN ('S', 'A', 'B', 'C', 'D', 'F')),
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

// The first version's populated demo: the viewer's two lists, seeded once
// per viewer behind IS_STAGING && ?demo=1. Real lists stay out of staging's
// way; a reload changes nothing and edits the viewer makes stick.
const DEMO_LISTS = [
  {
    name: 'Movies to rewatch',
    items: [
      { name: 'The Princess Bride', added_by: 'Maya', me: null, votes: { Maya: 'S', Jo: 'A' } },
      { name: 'Ratatouille', added_by: 'Dev', me: null, votes: { Maya: 'S', Sam: 'A' } },
      { name: 'Paddington', added_by: 'Jo', me: null, votes: { Dev: 'A', Sam: 'S' } },
      { name: 'Spirited Away', added_by: 'Sam', me: null, votes: { Maya: 'A', Dev: 'S' } },
      { name: 'Toy Story', added_by: 'Maya', me: null, votes: { Dev: 'B', Jo: 'A' } },
      { name: 'The Sound of Music', added_by: 'Dev', me: null, votes: { Jo: 'B' } },
    ],
  },
  {
    name: 'Bay Area restaurants',
    items: [
      { name: 'Zuni Cafe', added_by: 'Maya', me: 'S', votes: { Maya: 'S', Dev: 'S', Jo: 'A', Sam: 'S' } },
      { name: 'Tartine Bakery', added_by: 'Dev', me: 'A', votes: { Maya: 'A', Dev: 'S', Jo: 'B', Sam: 'A' } },
      { name: 'Swan Oyster Depot', mine: true, me: 'A', votes: { Maya: 'S', Dev: 'A', Jo: 'A', Sam: 'B' } },
      { name: 'La Taqueria', added_by: 'Maya', me: 'A', votes: { Maya: 'S', Dev: 'A', Jo: 'S', Sam: 'S' } },
      { name: 'Nopa', added_by: 'Jo', me: 'A', votes: { Maya: 'A', Dev: 'A', Jo: 'B', Sam: 'A' } },
      { name: 'Burma Superstar', added_by: 'Dev', me: 'A', votes: { Maya: 'B', Dev: 'B', Jo: 'A', Sam: 'C' } },
      { name: 'Pizzeria Delfina', added_by: 'Sam', me: 'B', votes: { Maya: 'B', Dev: 'A', Jo: 'B', Sam: 'C' } },
      { name: 'Yank Sing', added_by: 'Jo', me: 'B', votes: { Maya: 'A', Dev: 'S', Jo: 'A', Sam: 'A' } },
      { name: "Gott's Roadside", added_by: 'Maya', me: 'B', votes: { Maya: 'C', Dev: 'B', Jo: 'C', Sam: 'D' } },
      { name: 'Mission Chinese', added_by: 'Dev', me: 'C', votes: { Maya: 'B', Dev: 'B', Jo: 'B', Sam: 'B' } },
      { name: 'Anchor Oyster Bar', added_by: 'Sam', me: 'C', votes: { Maya: 'C', Dev: 'C', Jo: 'B', Sam: 'C' } },
      { name: "Fisherman's Wharf crab", added_by: 'Jo', me: 'D', votes: { Maya: 'D', Dev: 'C', Jo: 'D', Sam: 'D' } },
      { name: 'Sushi Ran', added_by: 'Maya', me: null, votes: { Maya: 'S' } },
      { name: 'Cheese Board Pizza', added_by: 'Dev', me: null, votes: { Dev: 'A' } },
      { name: "Brenda's French Soul Food", added_by: 'Jo', me: null, votes: { Jo: 'C' } },
    ],
  },
];

async function seedDemo(user) {
  const seen = await pool.query('SELECT id FROM lists WHERE demo_for = $1 LIMIT 1', [user.id]);
  if (seen.rowCount) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const demo of DEMO_LISTS) {
      const list = await client.query(
        'INSERT INTO lists (name, created_by, demo_for) VALUES ($1, $2, $3) RETURNING id',
        [demo.name, user.username, user.id]
      );
      const listId = list.rows[0].id;
      for (const item of demo.items) {
        const row = await client.query(
          'INSERT INTO items (list_id, name, added_by) VALUES ($1, $2, $3) RETURNING id',
          [listId, item.name, item.mine ? user.username : item.added_by]
        );
        const itemId = row.rows[0].id;
        const voteRows = Object.entries(item.votes || {})
          .map(([who, tier]) => ['demo-' + who.toLowerCase(), who, tier]);
        if (item.me) voteRows.unshift([user.id, user.username, item.me]);
        for (const [userId, username, tier] of voteRows) {
          await client.query(
            `INSERT INTO votes (item_id, user_id, username, tier)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [itemId, userId, username, tier]
          );
        }
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // Two viewers racing the same first ?demo=1 request: the winner's rows
    // stand (unique demo_for), the loser reloads into them.
    if (err.code !== '23505') throw err;
  } finally {
    client.release();
  }
}

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: 'request_failed' });
});

app.get('/api/lists', wrap(async (req, res) => {
  const demo = IS_STAGING && req.query.demo === '1';
  if (demo && req.user) await seedDemo(req.user);
  // Rows seeded for a viewer stay behind ?demo=1: the plain route stays
  // production-shaped even after the demo has run for this account.
  const { rows } = await pool.query(
    `SELECT l.id, l.name, l.created_by, l.demo_for IS NOT NULL AS demo,
            (SELECT count(*) FROM items WHERE list_id = l.id)::int AS item_count,
            (SELECT count(DISTINCT v.user_id) FROM votes v
               JOIN items i ON i.id = v.item_id WHERE i.list_id = l.id)::int AS voter_count
     FROM lists l
     WHERE $1::boolean OR l.demo_for IS NULL
     ORDER BY l.created_at DESC, l.id DESC`,
    [demo && !!req.user]
  );
  res.json({ lists: rows });
}));

app.post('/api/lists', wrap(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 60) return res.status(400).json({ error: 'invalid_name' });
  const { rows } = await pool.query(
    `INSERT INTO lists (name, created_by) VALUES ($1, $2)
     RETURNING id, name, created_by, false AS demo`,
    [name, req.user.username]
  );
  res.status(201).json({ list: Object.assign(rows[0], { item_count: 0, voter_count: 0 }) });
}));

app.delete('/api/lists/:id', wrap(async (req, res) => {
  const found = await pool.query('SELECT created_by FROM lists WHERE id = $1', [req.params.id]);
  if (!found.rowCount) return res.status(404).json({ error: 'not_found' });
  if (found.rows[0].created_by !== req.user.username) {
    return res.status(403).json({ error: 'not_yours' });
  }
  await pool.query('DELETE FROM lists WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/lists/:id', wrap(async (req, res) => {
  const lists = await pool.query(
    'SELECT id, name, created_by, demo_for IS NOT NULL AS demo FROM lists WHERE id = $1',
    [req.params.id]
  );
  if (!lists.rowCount) return res.status(404).json({ error: 'not_found' });
  const viewerId = req.user ? req.user.id : null;
  const { rows } = await pool.query(
    `SELECT i.id, i.name, i.added_by, v.tier AS my_tier,
            COALESCE(
              json_agg(json_build_object('username', v2.username, 'tier', v2.tier)
                       ORDER BY v2.updated_at, v2.user_id)
                FILTER (WHERE v2.user_id IS NOT NULL),
              '[]') AS votes
     FROM items i
     LEFT JOIN votes v ON v.item_id = i.id AND v.user_id = $2
     LEFT JOIN votes v2 ON v2.item_id = i.id
     WHERE i.list_id = $1
     GROUP BY i.id, i.name, i.added_by, v.tier, i.created_at
     ORDER BY i.created_at, i.id`,
    [req.params.id, viewerId]
  );
  res.json({ list: lists.rows[0], items: rows });
}));

app.post('/api/lists/:id/items', wrap(async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name || name.length > 80) return res.status(400).json({ error: 'invalid_name' });
  const lists = await pool.query('SELECT id FROM lists WHERE id = $1', [req.params.id]);
  if (!lists.rowCount) return res.status(404).json({ error: 'not_found' });
  const { rows } = await pool.query(
    `INSERT INTO items (list_id, name, added_by) VALUES ($1, $2, $3)
     RETURNING id, name, added_by, NULL::text AS my_tier, '[]'::json AS votes`,
    [req.params.id, name, req.user.username]
  );
  res.status(201).json({ item: rows[0] });
}));

async function itemOwner(req, res) {
  const found = await pool.query('SELECT added_by FROM items WHERE id = $1', [req.params.id]);
  if (!found.rowCount) { res.status(404).json({ error: 'not_found' }); return null; }
  if (found.rows[0].added_by !== req.user.username) {
    res.status(403).json({ error: 'not_yours' });
    return null;
  }
  return found.rows[0];
}

app.delete('/api/items/:id', wrap(async (req, res) => {
  if (!(await itemOwner(req, res))) return;
  await pool.query('DELETE FROM items WHERE id = $1', [req.params.id]); // its votes go with it
  res.json({ ok: true });
}));

app.put('/api/items/:id/vote', wrap(async (req, res) => {
  const tier = req.body.tier;
  if (!TIERS.includes(tier)) return res.status(400).json({ error: 'invalid_tier' });
  const items = await pool.query('SELECT id FROM items WHERE id = $1', [req.params.id]);
  if (!items.rowCount) return res.status(404).json({ error: 'not_found' });
  const { rows } = await pool.query(
    `INSERT INTO votes (item_id, user_id, username, tier) VALUES ($1, $2, $3, $4)
     ON CONFLICT (item_id, user_id)
     DO UPDATE SET tier = EXCLUDED.tier, updated_at = now()
     RETURNING tier`,
    [req.params.id, req.user.id, req.user.username, tier]
  );
  res.json({ tier: rows[0].tier });
}));

app.delete('/api/items/:id/vote', wrap(async (req, res) => {
  await pool.query('DELETE FROM votes WHERE item_id = $1 AND user_id = $2',
    [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

app.post('/api/items/:id/report', wrap(async (req, res) => {
  const items = await pool.query('SELECT id FROM items WHERE id = $1', [req.params.id]);
  if (!items.rowCount) return res.status(404).json({ error: 'not_found' });
  await pool.query('INSERT INTO reports (item_id, reporter) VALUES ($1, $2)',
    [req.params.id, req.user.username]);
  res.json({ ok: true }); // recorded for the admins; hides nothing by itself
}));

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

let server;

async function start() {
  await migrate();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

// Stop listening, drain in-flight requests for about 3 s, close the pool,
// exit.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down');
  if (server) server.close();
  setTimeout(() => {
    pool.end().finally(() => process.exit(0));
  }, 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(err => { console.error(err); process.exit(1); });
