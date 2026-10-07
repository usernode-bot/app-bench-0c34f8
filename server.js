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

// ── Data model ─────────────────────────────────────────────────────────────
// All tables are public (usernames are already public on the platform and
// votes are shown by name), so nothing is marked 'staging:private' and no
// public-to-private foreign key arises. Applied idempotently on boot.
const TIERS = ['S', 'A', 'B', 'C', 'D'];

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id serial PRIMARY KEY,
      title text NOT NULL,
      created_by text NOT NULL,
      created_by_name text NOT NULL,
      is_demo boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id serial PRIMARY KEY,
      list_id int NOT NULL REFERENCES lists ON DELETE CASCADE,
      name text NOT NULL,
      added_by text NOT NULL,
      added_by_name text NOT NULL,
      created_at timestamptz NOT NULL
    )`);
  // Duplicate names differing only in case or spacing are refused, not stored.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS items_list_name_key
      ON items (list_id, lower(name))`);
  // One vote per person per item; unranked means no row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS placements (
      item_id int NOT NULL REFERENCES items ON DELETE CASCADE,
      user_id text NOT NULL,
      username text NOT NULL,
      tier char(1) NOT NULL CHECK (tier IN ('S','A','B','C','D')),
      placed_at timestamptz NOT NULL,
      PRIMARY KEY (item_id, user_id)
    )`);
  // Marks that a viewer's staging demo votes were written once.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_viewers (
      user_id text PRIMARY KEY,
      seeded_at timestamptz
    )`);
}

// An item name: trimmed, inner whitespace collapsed, 1 to 60 characters.
function cleanItemName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= 60 ? name : null;
}

// ── Staging demo data ──────────────────────────────────────────────────────
// Written only in staging, only behind IS_STAGING. Fake identities only
// ("staging-demo-*"); the viewing account gets its own votes on its first
// ?demo=1 request, once, below. Fixed ids far above the serial sequence, so
// real rows never collide and setval needs no touching.
const DEMO_RESTAURANTS = [
  'Tartine Bakery', 'La Taqueria', 'Burma Superstar', 'Swan Oyster', 'Kin Khao',
  'Zuni Café', 'Souvla', "Mitchell's Ice Cream", 'Super Duper', 'House of Prime Rib',
  "Mister Jiu's", 'Nopa', 'Delfina', 'Arizmendi', 'Good Mong Kok',
  'Ramen Nagi', 'Hog Island Oyster', 'Kitchen Story',
];
const DEMO_MOVIES = [
  'Spirited Away', 'Paddington 2', 'The Princess Bride', 'Ratatouille',
  'Up', 'Inside Out', 'Mamma Mia!', 'The Grand Budapest Hotel',
];
// Shorthand for the six made-up voters.
const DEMO_VOTERS = {
  M: 'staging-demo-maya',
  D: 'staging-demo-devon',
  P: 'staging-demo-priya',
  K: 'staging-demo-kai',
  L: 'staging-demo-lena',
  O: 'staging-demo-omar',
};
// Who voted where, per item. Crowd tiers spread over S to D, and Zuni Café
// is fixed by the request: priya S; maya, devon, omar A; kai B; lena C.
const DEMO_VOTES = {
  restaurants: [
    'S:MDP B:O', // Tartine Bakery
    'A:MDK B:LO', // La Taqueria
    'A:MDO B:PK C:L', // Burma Superstar
    'S:MDP B:L A:O', // Swan Oyster
    'B:MDK A:P C:LO', // Kin Khao
    'A:MDO S:P B:K C:L', // Zuni Café — 7 votes, crowd A
    'B:MDK A:PL C:O', // Souvla
    'A:MDPL B:K C:O', // Mitchell's Ice Cream
    'C:MDK B:PL D:O', // Super Duper
    'B:MDP A:K D:LO', // House of Prime Rib
    'A:MDP B:K C:LO', // Mister Jiu's
    'B:MDK A:PL D:O', // Nopa
    'A:MDO B:P S:K C:L', // Delfina
    'C:MDP B:KL D:O', // Arizmendi
    'C:MDK B:P D:LO', // Good Mong Kok
    'B:MDP C:KL A:O', // Ramen Nagi
    'S:MDK A:PL B:O', // Hog Island Oyster
    'D:MPL C:KO B:D', // Kitchen Story
  ],
  movies: [
    'S:MDP A:KL B:O', // Spirited Away
    'A:MDK B:PL C:O', // Paddington 2
    'S:MDO A:PKL', // The Princess Bride
    'A:MDP B:K C:LO', // Ratatouille
    'B:MDK A:PL C:O', // Up
    'A:MDO B:PK C:L', // Inside Out
    'C:MLO B:KD D:P', // Mamma Mia!
    'B:MDP A:K C:LO', // The Grand Budapest Hotel
  ],
};

function parseDemoVotes(spec) {
  const votes = [];
  spec.split(' ').forEach((group) => {
    if (!group) return;
    const m = /^([SABCD]):(.+)$/.exec(group);
    if (!m) return;
    m[2].split('').forEach((k) => {
      const username = DEMO_VOTERS[k];
      if (username) votes.push({ username, tier: m[1] });
    });
  });
  return votes;
}

async function seedStagingDemo() {
  const base = new Date('2026-10-01T12:00:00.000Z');

  await pool.query(
    `INSERT INTO lists (id, title, created_by, created_by_name, is_demo, created_at)
     VALUES (900001, 'Staging demo: Bay Area restaurants', 'staging-demo-maya', 'staging-demo-maya', true, $1),
            (900002, 'Staging demo: Movies for movie night', 'staging-demo-maya', 'staging-demo-maya', true, $2)
     ON CONFLICT (id) DO NOTHING`,
    [base, new Date(base.getTime() + 3600_000)]
  );

  const seedItems = async (listId, startId, names) => {
    for (let i = 0; i < names.length; i++) {
      await pool.query(
        `INSERT INTO items (id, list_id, name, added_by, added_by_name, created_at)
         VALUES ($1, $2, $3, 'staging-demo-maya', 'staging-demo-maya', $4)
         ON CONFLICT (id) DO NOTHING`,
        [startId + i, listId, names[i], new Date(base.getTime() + (i + 2) * 600_000)]
      );
    }
  };
  await seedItems(900001, 900101, DEMO_RESTAURANTS);
  await seedItems(900002, 900201, DEMO_MOVIES);

  const seedVotes = async (startId, specs) => {
    for (let i = 0; i < specs.length; i++) {
      const votes = parseDemoVotes(specs[i]);
      for (let v = 0; v < votes.length; v++) {
        await pool.query(
          `INSERT INTO placements (item_id, user_id, username, tier, placed_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (item_id, user_id) DO NOTHING`,
          [startId + i, votes[v].username, votes[v].username, votes[v].tier,
            new Date(base.getTime() + (i * 6 + v + 20) * 600_000)]
        );
      }
    }
  };
  await seedVotes(900101, DEMO_VOTES.restaurants);
  await seedVotes(900201, DEMO_VOTES.movies);
}

// The viewing account's own demo votes: written once per account, on its
// first ?demo=1 request in staging. 11 of the 18 restaurants, spread over
// all five tiers, so the viewer's ladder is full and differs from the
// crowd's in places. A reload changes nothing, and what the viewer did
// afterwards stays.
const VIEWER_DEMO_PLACEMENTS = [
  // S
  { name: 'Tartine Bakery', tier: 'S' },
  { name: 'La Taqueria', tier: 'S' },
  // A
  { name: 'Burma Superstar', tier: 'A' },
  { name: 'Swan Oyster', tier: 'A' },
  { name: 'Kin Khao', tier: 'A' },
  // B
  { name: 'Zuni Café', tier: 'B' },
  { name: 'Souvla', tier: 'B' },
  { name: "Mitchell's Ice Cream", tier: 'B' },
  // C
  { name: 'Super Duper', tier: 'C' },
  { name: 'Kitchen Story', tier: 'C' },
  // D
  { name: 'House of Prime Rib', tier: 'D' },
];

async function seedDemoViewer(req) {
  const inserted = await pool.query(
    `INSERT INTO demo_viewers (user_id, seeded_at)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id`,
    [req.user.id, req.now]
  );
  if (inserted.rowCount === 0) return; // already seeded: leave later edits alone
  for (let i = 0; i < VIEWER_DEMO_PLACEMENTS.length; i++) {
    const p = VIEWER_DEMO_PLACEMENTS[i];
    await pool.query(
      `INSERT INTO placements (item_id, user_id, username, tier, placed_at)
       SELECT id, $1, $2, $3, $4 FROM items WHERE id >= 900101 AND id < 900119 AND name = $5
       ON CONFLICT (item_id, user_id) DO NOTHING`,
      [req.user.id, req.user.username, p.tier, new Date(req.now.getTime() + i * 60_000), p.name]
    );
  }
}

// The demo gate: demo rows exist only in staging, and are touched (read or
// written) only when the request itself carries ?demo=1.
function demoAllowed(req) {
  return IS_STAGING && req.query.demo === '1';
}

// ── API ────────────────────────────────────────────────────────────────────
// Reads work for a signed-in member or a guest; writes need an account
// (the auth middleware above answers guests 401 account_required). Reads
// use `req.user ? req.user.id : null`; GET routes must not assume req.user.

app.get('/api/lists', async (req, res) => {
  try {
    const withDemo = demoAllowed(req);
    // The viewer's demo votes are written once, here, behind the same gate.
    if (withDemo && req.user) await seedDemoViewer(req);

    const { rows } = await pool.query(
      `SELECT l.id, l.title, l.created_by, l.created_by_name, l.is_demo, l.created_at,
              (SELECT count(*) FROM items i WHERE i.list_id = l.id)::int AS item_count,
              (SELECT count(DISTINCT p.username) FROM placements p
                 JOIN items i2 ON i2.id = p.item_id WHERE i2.list_id = l.id)::int AS voter_count,
              GREATEST(l.created_at,
                       (SELECT max(i.created_at) FROM items i WHERE i.list_id = l.id),
                       (SELECT max(p.placed_at) FROM placements p
                          JOIN items i3 ON i3.id = p.item_id WHERE i3.list_id = l.id))
                AS last_activity
       FROM lists l
       ${withDemo ? '' : 'WHERE NOT l.is_demo'}
       ORDER BY l.id DESC`
    );
    const lists = rows.filter((l) => !l.is_demo || withDemo);
    // Demo lists first during a demo view, then by last activity.
    lists.sort((a, b) => {
      if (withDemo && a.is_demo !== b.is_demo) return a.is_demo ? -1 : 1;
      return new Date(b.last_activity) - new Date(a.last_activity);
    });
    res.json({ lists });
  } catch (err) {
    console.warn('GET /api/lists failed: ' + err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/lists', async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.replace(/\s+/g, ' ').trim() : '';
  if (title.length < 1 || title.length > 60) {
    return res.status(400).json({ error: 'bad_title' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO lists (title, created_by, created_by_name, is_demo, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, title, is_demo, created_at`,
      [title, req.user.id, req.user.username, demoAllowed(req), req.now]
    );
    res.status(201).json({ list: rows[0] });
  } catch (err) {
    console.warn('POST /api/lists failed: ' + err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Look up one list, applying the demo gate; 404 when missing or gated.
async function loadList(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  const { rows } = await pool.query(
    `SELECT id, title, created_by, created_by_name, is_demo, created_at
     FROM lists WHERE id = $1`, [id]
  );
  const list = rows[0];
  if (!list || (list.is_demo && !demoAllowed(req))) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return list;
}

// Look up one item, applying the demo gate through its list.
async function loadItem(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  const { rows } = await pool.query(
    `SELECT i.id, i.list_id, i.name, i.added_by, i.added_by_name, i.created_at,
            l.is_demo
     FROM items i JOIN lists l ON l.id = i.list_id WHERE i.id = $1`, [id]
  );
  const item = rows[0];
  if (!item || (item.is_demo && !demoAllowed(req))) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return item;
}

app.get('/api/lists/:id', async (req, res) => {
  try {
    const list = await loadList(req, res);
    if (!list) return;
    const { rows } = await pool.query(
      `SELECT i.id, i.name, i.added_by, i.added_by_name, i.created_at,
              p.user_id, p.username, p.tier, p.placed_at
       FROM items i
       LEFT JOIN placements p ON p.item_id = i.id
       WHERE i.list_id = $1
       ORDER BY i.created_at ASC, i.id ASC`, [list.id]
    );
    const items = [];
    const byId = new Map();
    for (const r of rows) {
      let item = byId.get(r.id);
      if (!item) {
        item = { id: r.id, name: r.name, added_by: r.added_by, added_by_name: r.added_by_name,
          created_at: r.created_at, votes: [] };
        byId.set(r.id, item);
        items.push(item);
      }
      if (r.user_id !== null) {
        item.votes.push({ user_id: r.user_id, username: r.username, tier: r.tier, placed_at: r.placed_at });
      }
    }
    res.json({
      list,
      viewerId: req.user ? req.user.id : null,
      items,
    });
  } catch (err) {
    console.warn('GET /api/lists/:id failed: ' + err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/lists/:id/items', async (req, res) => {
  const name = cleanItemName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'bad_name' });
  try {
    const list = await loadList(req, res);
    if (!list) return;
    const dup = await pool.query(
      `SELECT id FROM items WHERE list_id = $1 AND lower(name) = lower($2)`, [list.id, name]
    );
    if (dup.rowCount > 0) return res.status(409).json({ error: 'duplicate' });
    const { rows } = await pool.query(
      `INSERT INTO items (list_id, name, added_by, added_by_name, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, added_by, added_by_name, created_at`,
      [list.id, name, req.user.id, req.user.username, req.now]
    );
    res.status(201).json({ item: { ...rows[0], votes: [] } });
  } catch (err) {
    console.warn('POST /api/lists/:id/items failed: ' + err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    const item = await loadItem(req, res);
    if (!item) return;
    if (item.added_by !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    await pool.query(`DELETE FROM items WHERE id = $1`, [item.id]); // votes go with it (cascade)
    res.json({ ok: true });
  } catch (err) {
    console.warn('DELETE /api/items/:id failed: ' + err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.put('/api/items/:id/placement', async (req, res) => {
  const tier = req.body && req.body.tier;
  if (!TIERS.includes(tier)) return res.status(400).json({ error: 'bad_tier' });
  try {
    const item = await loadItem(req, res);
    if (!item) return;
    await pool.query(
      `INSERT INTO placements (item_id, user_id, username, tier, placed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (item_id, user_id)
       DO UPDATE SET tier = EXCLUDED.tier, username = EXCLUDED.username, placed_at = EXCLUDED.placed_at`,
      [item.id, req.user.id, req.user.username, tier, req.now]
    );
    res.json({ ok: true, tier });
  } catch (err) {
    console.warn('PUT /api/items/:id/placement failed: ' + err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/items/:id/placement', async (req, res) => {
  try {
    const item = await loadItem(req, res);
    if (!item) return;
    await pool.query(`DELETE FROM placements WHERE item_id = $1 AND user_id = $2`,
      [item.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.warn('DELETE /api/items/:id/placement failed: ' + err.message);
    res.status(500).json({ error: 'server_error' });
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

async function start() {
  // Schema first, then the staging seed: nothing may listen before the
  // tables exist and the demo data is in place.
  await ensureSchema();
  if (IS_STAGING) await seedStagingDemo();

  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // Stop accepting, let in-flight requests finish (3 s at most), close the
  // pool and exit — so a redeploy never cuts a request mid-write.
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => {
      pool.end().then(() => process.exit(0), () => process.exit(0));
    });
    setTimeout(() => {
      console.warn('shutdown drain timed out, exiting');
      pool.end().finally(() => process.exit(0));
    }, 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
