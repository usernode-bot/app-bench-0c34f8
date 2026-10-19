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

// ── Data ────────────────────────────────────────────────────────────────
// All tables are public: a list, its things and everyone's votes are open to
// everyone in the app, as the spec asks. Reports are only recorded.

const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];

async function createSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      noun TEXT NOT NULL DEFAULT 'item',
      created_by_id TEXT,
      created_by_name TEXT,
      is_demo BOOLEAN NOT NULL DEFAULT FALSE,
      demo_owner_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      added_by_id TEXT,
      added_by_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS votes (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      tier TEXT NOT NULL CHECK (tier IN ('S', 'A', 'B', 'C', 'D', 'F')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (item_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
      list_id INTEGER REFERENCES lists(id) ON DELETE CASCADE,
      reporter_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS demo_seeded (
      user_id TEXT PRIMARY KEY
    );
    CREATE INDEX IF NOT EXISTS items_list_id_idx ON items(list_id);
    CREATE UNIQUE INDEX IF NOT EXISTS lists_one_demo_per_owner
      ON lists(demo_owner_id) WHERE is_demo;
  `);
}

// The first list everyone sees. It starts empty: the populated board is the
// staging demo below, on ?demo=1 only.
async function seedFirstList() {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM lists WHERE is_demo = FALSE LIMIT 1'
  );
  if (rowCount) return;
  await pool.query(
    `INSERT INTO lists (name, noun) VALUES ('Bay Area restaurants', 'restaurant')`
  );
}

// ── The staging demo ─────────────────────────────────────────────────────
// Only on staging with ?demo=1. Written once per viewer, so what they change
// afterwards stays. The friends are obviously fake accounts.

const DEMO_FRIENDS = {
  maya: { id: 'staging-demo-maya', username: 'staging-demo-maya' },
  dev: { id: 'staging-demo-dev', username: 'staging-demo-dev' },
  jon: { id: 'staging-demo-jon', username: 'staging-demo-jon' },
};

const DEMO_RESTAURANTS = [
  { name: 'Tartine Bakery', by: 'maya', votes: { owner: 'S', maya: 'S', dev: 'S' } },
  { name: 'Nopalito', by: 'dev', votes: { owner: 'S', jon: 'S' } },
  { name: 'Swan Oyster Depot', by: 'dev', votes: { owner: 'A', dev: 'A', maya: 'S', jon: 'B' } },
  { name: 'Zuni Café', by: 'owner', votes: { owner: 'A' } },
  { name: 'La Taqueria', by: 'maya', votes: { owner: 'A', maya: 'A' } },
  { name: 'Burma Superstar', by: 'jon', votes: { owner: 'B', jon: 'B' } },
  { name: 'Mission Chinese', by: 'owner', votes: { owner: 'B' } },
  { name: 'Lers Ros', by: 'dev', votes: { owner: 'C', dev: 'C' } },
  { name: 'Pier crab stand', by: 'owner', votes: { owner: 'D' } },
  { name: 'Rich Table', by: 'jon', votes: {} },
  { name: "Sam's Chowder House", by: 'maya', votes: {} },
];

function demoOwner(user) {
  return { id: String(user.id), username: user.username || 'You' };
}

async function ensureDemoList(user) {
  const uid = String(user.id);
  const seeded = await pool.query('SELECT 1 FROM demo_seeded WHERE user_id = $1', [uid]);
  if (seeded.rowCount) return;

  const existing = await pool.query(
    'SELECT 1 FROM lists WHERE is_demo = TRUE AND demo_owner_id = $1 LIMIT 1',
    [uid]
  );
  if (existing.rowCount) {
    await pool.query(
      'INSERT INTO demo_seeded (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [uid]
    );
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const list = await client.query(
      `INSERT INTO lists (name, noun, created_by_id, created_by_name, is_demo, demo_owner_id)
       VALUES ('Bay Area restaurants', 'restaurant', $1, $2, TRUE, $1)
       RETURNING id`,
      [uid, user.username || null]
    );
    const listId = list.rows[0].id;
    const people = { owner: demoOwner(user), ...DEMO_FRIENDS };

    for (const restaurant of DEMO_RESTAURANTS) {
      const addedBy = people[restaurant.by];
      const item = await client.query(
        `INSERT INTO items (list_id, name, added_by_id, added_by_name)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [listId, restaurant.name, addedBy.id, addedBy.username]
      );
      for (const [who, tier] of Object.entries(restaurant.votes)) {
        const voter = people[who];
        await client.query(
          `INSERT INTO votes (item_id, user_id, username, tier)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (item_id, user_id) DO UPDATE SET tier = EXCLUDED.tier`,
          [item.rows[0].id, voter.id, voter.username, tier]
        );
      }
    }

    await client.query(
      'INSERT INTO demo_seeded (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [uid]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // Two loads at once: the other one won the unique index. That is fine.
    if (err.code !== '23505') throw err;
  } finally {
    client.release();
  }
}

function wantsDemo(req) {
  return IS_STAGING && String(req.query.demo) === '1';
}

function isDemoVisible(list, req) {
  if (!list.is_demo) return true;
  return Boolean(
    req.user && wantsDemo(req) && String(list.demo_owner_id) === String(req.user.id)
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function cleanName(value, max) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > max) return null;
  return name;
}

function idParam(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function loadList(id) {
  const result = await pool.query(
    `SELECT id, name, noun, created_by_id, created_by_name, is_demo, demo_owner_id
     FROM lists WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

function serializeList(list, itemCount) {
  return {
    id: list.id,
    name: list.name,
    noun: list.noun,
    createdById: list.created_by_id,
    createdByName: list.created_by_name,
    isDemo: list.is_demo,
    itemCount: itemCount === undefined ? undefined : itemCount,
  };
}

// Writes are only allowed on a list the viewer can see: a demo list belongs
// to the viewer it was made for.
function canWriteList(list, req) {
  return Boolean(req.user) && isDemoVisible(list, req);
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Routes ──────────────────────────────────────────────────────────────

app.get('/api/lists', wrap(async (req, res) => {
  if (wantsDemo(req) && req.user) await ensureDemoList(req.user);

  const demo = wantsDemo(req) && req.user;
  const result = demo
    ? await pool.query(
        `SELECT l.*, (SELECT count(*) FROM items i WHERE i.list_id = l.id)::int AS item_count
         FROM lists l
         WHERE l.is_demo = FALSE OR (l.is_demo = TRUE AND l.demo_owner_id = $1)
         ORDER BY l.created_at, l.id`,
        [String(req.user.id)]
      )
    : await pool.query(
        `SELECT l.*, (SELECT count(*) FROM items i WHERE i.list_id = l.id)::int AS item_count
         FROM lists l
         WHERE l.is_demo = FALSE
         ORDER BY l.created_at, l.id`
      );

  res.json({ lists: result.rows.map((l) => serializeList(l, l.item_count)) });
}));

app.post('/api/lists', wrap(async (req, res) => {
  const body = req.body || {};
  const name = cleanName(body.name, 80);
  const noun = cleanName(body.noun, 40) || 'item';
  if (!name) return res.status(400).json({ error: 'name_required' });

  const result = await pool.query(
    `INSERT INTO lists (name, noun, created_by_id, created_by_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, noun, created_by_id, created_by_name, is_demo, demo_owner_id`,
    [name, noun, String(req.user.id), req.user.username || null]
  );
  res.status(201).json({ list: serializeList(result.rows[0], 0) });
}));

app.delete('/api/lists/:id', wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const list = id && await loadList(id);
  if (!list) return res.status(404).json({ error: 'not_found' });
  if (!canWriteList(list, req)) return res.status(404).json({ error: 'not_found' });
  if (String(list.created_by_id) !== String(req.user.id)) {
    return res.status(403).json({ error: 'creator_only' });
  }
  await pool.query('DELETE FROM lists WHERE id = $1', [id]);
  res.status(204).end();
}));

app.get('/api/lists/:id', wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const list = id && await loadList(id);
  if (!list || !isDemoVisible(list, req)) {
    return res.status(404).json({ error: 'not_found' });
  }

  const result = await pool.query(
    `SELECT i.id, i.name, i.added_by_id, i.added_by_name,
            v.user_id AS voter_id, v.username AS voter_name, v.tier
     FROM items i
     LEFT JOIN votes v ON v.item_id = i.id
     WHERE i.list_id = $1
     ORDER BY i.created_at, i.id`,
    [id]
  );

  const itemsById = new Map();
  for (const row of result.rows) {
    let item = itemsById.get(row.id);
    if (!item) {
      item = {
        id: row.id,
        name: row.name,
        addedById: row.added_by_id,
        addedByName: row.added_by_name,
        votes: [],
        myTier: null,
      };
      itemsById.set(row.id, item);
    }
    if (row.voter_id) {
      item.votes.push({ userId: row.voter_id, username: row.voter_name, tier: row.tier });
    }
  }

  const viewerId = req.user ? String(req.user.id) : null;
  const items = [...itemsById.values()].map((item) => {
    const mine = viewerId && item.votes.find((v) => String(v.userId) === viewerId);
    return {
      ...item,
      myTier: mine ? mine.tier : null,
      canRemove: Boolean(viewerId && String(item.addedById) === viewerId),
    };
  });

  res.json({
    list: serializeList(list, items.length),
    items,
    viewerId,
    viewerName: req.user ? req.user.username || null : null,
  });
}));

app.post('/api/lists/:id/items', wrap(async (req, res) => {
  const id = idParam(req.params.id);
  const list = id && await loadList(id);
  if (!list || !canWriteList(list, req)) return res.status(404).json({ error: 'not_found' });

  const name = cleanName((req.body || {}).name, 80);
  if (!name) return res.status(400).json({ error: 'name_required' });

  const duplicate = await pool.query(
    'SELECT 1 FROM items WHERE list_id = $1 AND lower(name) = lower($2) LIMIT 1',
    [id, name]
  );
  if (duplicate.rowCount) return res.status(409).json({ error: 'duplicate_name' });

  const result = await pool.query(
    `INSERT INTO items (list_id, name, added_by_id, added_by_name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, added_by_id, added_by_name`,
    [id, name, String(req.user.id), req.user.username || null]
  );
  res.status(201).json({
    item: {
      id: result.rows[0].id,
      name: result.rows[0].name,
      addedById: result.rows[0].added_by_id,
      addedByName: result.rows[0].added_by_name,
      votes: [],
      myTier: null,
      canRemove: true,
    },
  });
}));

async function loadItemForWrite(req, res) {
  const id = idParam(req.params.id);
  if (!id) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  const result = await pool.query(
    `SELECT i.id, i.added_by_id, i.list_id, l.is_demo, l.demo_owner_id
     FROM items i JOIN lists l ON l.id = i.list_id
     WHERE i.id = $1`,
    [id]
  );
  const item = result.rows[0];
  if (!item || !isDemoVisible({ is_demo: item.is_demo, demo_owner_id: item.demo_owner_id }, req)) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return item;
}

app.delete('/api/items/:id', wrap(async (req, res) => {
  const item = await loadItemForWrite(req, res);
  if (!item) return;
  if (String(item.added_by_id) !== String(req.user.id)) {
    return res.status(403).json({ error: 'adder_only' });
  }
  await pool.query('DELETE FROM items WHERE id = $1', [item.id]);
  res.status(204).end();
}));

app.put('/api/items/:id/vote', wrap(async (req, res) => {
  const item = await loadItemForWrite(req, res);
  if (!item) return;
  const tier = (req.body || {}).tier;
  if (!TIERS.includes(tier)) return res.status(400).json({ error: 'bad_tier' });

  await pool.query(
    `INSERT INTO votes (item_id, user_id, username, tier, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (item_id, user_id)
     DO UPDATE SET tier = EXCLUDED.tier, username = EXCLUDED.username, updated_at = now()`,
    [item.id, String(req.user.id), req.user.username || null, tier]
  );
  res.json({ ok: true, tier });
}));

app.delete('/api/items/:id/vote', wrap(async (req, res) => {
  const item = await loadItemForWrite(req, res);
  if (!item) return;
  await pool.query('DELETE FROM votes WHERE item_id = $1 AND user_id = $2', [
    item.id,
    String(req.user.id),
  ]);
  res.status(204).end();
}));

app.post('/api/reports', wrap(async (req, res) => {
  const body = req.body || {};
  const itemId = body.itemId === undefined ? null : idParam(body.itemId);
  const listId = body.listId === undefined ? null : idParam(body.listId);
  if (!itemId && !listId) return res.status(400).json({ error: 'target_required' });

  if (itemId) {
    const found = await pool.query('SELECT 1 FROM items WHERE id = $1', [itemId]);
    if (!found.rowCount) return res.status(404).json({ error: 'not_found' });
  }
  if (listId) {
    const list = await loadList(listId);
    if (!list || !isDemoVisible(list, req)) return res.status(404).json({ error: 'not_found' });
  }

  await pool.query(
    'INSERT INTO reports (item_id, list_id, reporter_id) VALUES ($1, $2, $3)',
    [itemId, listId, String(req.user.id)]
  );
  res.status(201).json({ ok: true });
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' });
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

async function start() {
  try {
    await createSchema();
    await seedFirstList();
  } catch (err) {
    // A database hiccup at boot must not take the whole app down: the board
    // shows its error state, /health still answers, and Retry recovers.
    console.error('schema setup failed:', err.message);
  }

  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received: draining`);
    const finish = () => pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
    // Stop accepting connections, give in-flight requests about 3 seconds,
    // then close the pool and exit.
    server.close(finish);
    setTimeout(finish, 3000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
