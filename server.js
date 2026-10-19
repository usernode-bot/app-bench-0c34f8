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

// ── Block World ────────────────────────────────────────────────────────────
// One shared voxel world: a blocks table is the truth, a block_changes log
// lets every client follow along, and world_meta holds one-time seed flags.

const TYPES = ['grass', 'dirt', 'stone', 'oak', 'leaves', 'water', 'sand', 'brick'];
// World edges: 64 blocks out from the island's centre each way, 48 up or
// down, so nobody gets lost in empty sky.
const BOUNDS = { xy: 64, yLow: -48, yHigh: 48 };
const ACTIVE_WINDOW_MS = 5 * 60 * 1000; // "building now": a change in the last 5 minutes

function inBounds(x, y, z) {
  return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z)
    && Math.abs(x) <= BOUNDS.xy && Math.abs(z) <= BOUNDS.xy
    && y >= BOUNDS.yLow && y <= BOUNDS.yHigh;
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocks (
      x int NOT NULL,
      y int NOT NULL,
      z int NOT NULL,
      type text NOT NULL,
      placed_by text,
      placed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (x, y, z)
    );
    CREATE TABLE IF NOT EXISTS block_changes (
      seq bigserial PRIMARY KEY,
      x int NOT NULL,
      y int NOT NULL,
      z int NOT NULL,
      type text,
      username text,
      at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS block_changes_at_idx ON block_changes (at);
    CREATE TABLE IF NOT EXISTS world_meta (
      key text PRIMARY KEY,
      value text NOT NULL
    );
  `);
}

// The starter island, generated deterministically in code: a grass top about
// 16 by 16, a sandy edge, dirt sides, a stone underside that tapers away, a
// small pond and one tree.
function starterIsland() {
  const blocks = [];
  const seen = new Set();
  const put = (x, y, z, type) => {
    const k = `${x},${y},${z}`;
    if (seen.has(k)) return;
    seen.add(k);
    blocks.push({ x, y, z, type });
  };
  const R = 8.5;
  const inPond = (x, z) => x >= -3 && x <= -1 && z >= -2 && z <= 1;
  const pondEdge = (x, z) => !inPond(x, z) && x >= -4 && x <= 0 && z >= -3 && z <= 2;
  for (let x = -8; x <= 8; x++) {
    for (let z = -8; z <= 8; z++) {
      const d = Math.hypot(x, z);
      if (d > R) continue;
      const top = inPond(x, z) && d <= 6.5 ? 'water'
        : (pondEdge(x, z) || d > 7.2) ? 'sand' : 'grass';
      put(x, 0, z, top);
      const dirtDepth = d < 5 ? 2 : 1;
      for (let i = 1; i <= dirtDepth; i++) put(x, -i, z, top === 'sand' ? 'sand' : 'dirt');
      const stoneDepth = Math.max(0, Math.round((R - d) * 1.2) - dirtDepth);
      for (let i = 0; i < stoneDepth; i++) put(x, -dirtDepth - i - 1, z, 'stone');
    }
  }
  // One tree: an oak trunk with a blob of leaves.
  for (let y = 1; y <= 3; y++) put(4, y, -3, 'oak');
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = 0; dy <= 2; dy++) {
        if (dy === 0 && dx === 0 && dz === 0) continue; // the trunk top
        if (Math.abs(dx) + Math.abs(dz) + dy > 2.5) continue;
        put(4 + dx, 3 + dy, -3 + dz, 'leaves');
      }
    }
  }
  return blocks;
}

async function seedWorld() {
  const flag = await pool.query("SELECT value FROM world_meta WHERE key = 'island_seeded'");
  if (flag.rowCount) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const b of starterIsland()) {
      await client.query(
        'INSERT INTO blocks (x, y, z, type, placed_by, placed_at) VALUES ($1, $2, $3, $4, NULL, now()) ON CONFLICT DO NOTHING',
        [b.x, b.y, b.z, b.type],
      );
    }
    await client.query("INSERT INTO world_meta (key, value) VALUES ('island_seeded', 'yes') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Staging only: a small oak hut with a brick chimney, a stone tower, a sand
// path to the pond and a second tree, built by made-up builders so the
// populated world can be seen. Fixed coordinates, ON CONFLICT DO NOTHING,
// after the island.
function demoBuilds() {
  const out = [];
  const add = (x, y, z, type, username) => out.push({ x, y, z, type, username });
  // Maya: an oak hut with a doorway, walls at y 1-2, roof over it at y 3.
  for (let x = 2; x <= 6; x++) {
    for (let z = 4; z <= 7; z++) {
      const wall = x === 2 || x === 6 || z === 4 || z === 7;
      if (wall && !(x === 4 && z === 4)) { // the doorway
        add(x, 1, z, 'oak', 'Maya');
        add(x, 2, z, 'oak', 'Maya');
      }
      add(x, 3, z, 'oak', 'Maya'); // roof
    }
  }
  // Theo: a brick chimney on the hut's roof.
  add(6, 4, 7, 'brick', 'Theo');
  add(6, 5, 7, 'brick', 'Theo');
  // Ines: a stone tower on the island's edge.
  for (let y = 1; y <= 5; y++) {
    add(5, y, -7, 'stone', 'Ines');
    add(6, y, -7, 'stone', 'Ines');
    add(5, y, -6, 'stone', 'Ines');
    add(6, y, -6, 'stone', 'Ines');
  }
  // Kofi: a sand path from the pond's edge towards the hut door.
  add(0, 1, 2, 'sand', 'Kofi');
  add(1, 1, 3, 'sand', 'Kofi');
  add(2, 1, 3, 'sand', 'Kofi');
  add(3, 1, 4, 'sand', 'Kofi');
  // Sam: a second tree.
  for (let y = 1; y <= 3; y++) add(-6, y, 5, 'oak', 'Sam');
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = 0; dy <= 2; dy++) {
        if (dy === 0 && dx === 0 && dz === 0) continue;
        if (Math.abs(dx) + Math.abs(dz) + dy > 2.5) continue;
        add(-6 + dx, 3 + dy, 5 + dz, 'leaves', 'Sam');
      }
    }
  }
  return out;
}

async function seedDemo() {
  const flag = await pool.query("SELECT value FROM world_meta WHERE key = 'demo_seeded'");
  if (flag.rowCount) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const b of demoBuilds()) {
      await client.query(
        `INSERT INTO blocks (x, y, z, type, placed_by, placed_at)
         VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT DO NOTHING`,
        [b.x, b.y, b.z, b.type, b.username],
      );
      await client.query(
        'INSERT INTO block_changes (x, y, z, type, username, at) VALUES ($1, $2, $3, $4, $5, now())',
        [b.x, b.y, b.z, b.type, b.username],
      );
    }
    await client.query("INSERT INTO world_meta (key, value) VALUES ('demo_seeded', 'yes') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Shared bits of the two read routes: who is building now (others' changes in
// the last 5 minutes), how many people have built, and how many blocks the
// viewer has placed. With IS_STAGING && demo=1 the demo adds Maya and Theo to
// the active list and 24 to the viewer's count; nothing is stored.
async function worldCounts(req, demo) {
  const username = req.user ? req.user.username : null;
  const cutoff = new Date(req.now.getTime() - ACTIVE_WINDOW_MS);
  const [seqRes, buildersRes, activeRes, placedRes] = await Promise.all([
    pool.query('SELECT COALESCE(MAX(seq), 0)::bigint AS seq FROM block_changes'),
    pool.query('SELECT COUNT(DISTINCT username)::int AS n FROM block_changes WHERE username IS NOT NULL'),
    pool.query(
      'SELECT DISTINCT username FROM block_changes WHERE username IS NOT NULL AND at > $1 AND ($2::text IS NULL OR username <> $2)',
      [cutoff, username],
    ),
    username
      ? pool.query('SELECT COUNT(*)::int AS n FROM blocks WHERE placed_by = $1', [username])
      : Promise.resolve({ rows: [{ n: 0 }] }),
  ]);
  const active = activeRes.rows.map(r => r.username);
  let placed = placedRes.rows[0].n;
  if (demo) {
    // The demo line reads "Maya and Theo are building now", so they lead.
    const rest = active.filter(n => n !== 'Maya' && n !== 'Theo');
    active.length = 0;
    active.push('Maya', 'Theo', ...rest);
    placed += 24;
  }
  return {
    seq: Number(seqRes.rows[0].seq),
    builders: buildersRes.rows[0].n + (demo ? 1 : 0),
    active,
    me: { placed },
    demo,
  };
}

app.get('/api/world', async (req, res) => {
  try {
    const demo = IS_STAGING && req.query.demo === '1';
    const [blocksRes, counts] = await Promise.all([
      pool.query('SELECT x, y, z, type FROM blocks'),
      worldCounts(req, demo),
    ]);
    const blocks = blocksRes.rows.map(b => [b.x, b.y, b.z, TYPES.indexOf(b.type)]);
    res.json({ blocks, ...counts });
  } catch (err) {
    console.error('GET /api/world failed: ' + err.message);
    res.status(500).json({ error: 'world_failed' });
  }
});

app.get('/api/changes', async (req, res) => {
  try {
    const demo = IS_STAGING && req.query.demo === '1';
    const since = Number.parseInt(req.query.since, 10) || 0;
    const changesRes = await pool.query(
      'SELECT seq, x, y, z, type, username FROM block_changes WHERE seq > $1 ORDER BY seq LIMIT 2000',
      [since],
    );
    const counts = await worldCounts(req, demo);
    res.json({
      changes: changesRes.rows.map(c => ({
        seq: Number(c.seq), x: c.x, y: c.y, z: c.z,
        type: c.type === null ? null : TYPES.indexOf(c.type),
        username: c.username,
      })),
      full: changesRes.rowCount >= 2000, // the client reloads the world
      ...counts,
    });
  } catch (err) {
    console.error('GET /api/changes failed: ' + err.message);
    res.status(500).json({ error: 'changes_failed' });
  }
});

app.put('/api/blocks', async (req, res) => {
  const { x, y, z, type } = req.body || {};
  if (!inBounds(x, y, z) || !TYPES.includes(type)) {
    return res.status(400).json({ error: 'invalid_block' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO blocks (x, y, z, type, placed_by, placed_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (x, y, z) DO UPDATE
       SET type = EXCLUDED.type, placed_by = EXCLUDED.placed_by, placed_at = EXCLUDED.placed_at`,
      [x, y, z, type, req.user.username, req.now],
    );
    const seqRes = await client.query(
      'INSERT INTO block_changes (x, y, z, type, username, at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING seq',
      [x, y, z, type, req.user.username, req.now],
    );
    await client.query('COMMIT');
    res.json({ seq: Number(seqRes.rows[0].seq) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/blocks failed: ' + err.message);
    res.status(500).json({ error: 'save_failed' });
  } finally {
    client.release();
  }
});

app.delete('/api/blocks', async (req, res) => {
  const { x, y, z } = req.body || {};
  if (!inBounds(x, y, z)) return res.status(400).json({ error: 'invalid_block' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const delRes = await client.query(
      'DELETE FROM blocks WHERE x = $1 AND y = $2 AND z = $3',
      [x, y, z],
    );
    let seq;
    if (delRes.rowCount) {
      const seqRes = await client.query(
        'INSERT INTO block_changes (x, y, z, type, username, at) VALUES ($1, $2, $3, NULL, $4, $5) RETURNING seq',
        [x, y, z, req.user.username, req.now],
      );
      seq = Number(seqRes.rows[0].seq);
    } else {
      // Breaking an empty cell is a no-op.
      const seqRes = await client.query('SELECT COALESCE(MAX(seq), 0)::bigint AS seq FROM block_changes');
      seq = Number(seqRes.rows[0].seq);
    }
    await client.query('COMMIT');
    res.json({ seq });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /api/blocks failed: ' + err.message);
    res.status(500).json({ error: 'save_failed' });
  } finally {
    client.release();
  }
});

// three.js is a dependency, not app code: serve its module build from
// node_modules so public/world.js can import it by relative path.
const THREE_BUILD = path.join(__dirname, 'node_modules', 'three', 'build');
app.get('/lib/:name', (req, res) => {
  const name = req.params.name;
  if (!/^[\w.-]+\.js$/.test(name)) return res.sendStatus(404);
  res.sendFile(path.join(THREE_BUILD, name), (err) => {
    if (err && !res.headersSent) res.sendStatus(err.statusCode === 404 ? 404 : 500);
  });
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
      return res.redirect(302, PLATFORM_ORIGIN + '/app/block-world/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/block-world/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await ensureSchema();
  await seedWorld();
  if (IS_STAGING) await seedDemo();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // Stop accepting connections, drain what is in flight, close the pool.
  let draining = false;
  const shutdown = () => {
    if (draining) return;
    draining = true;
    server.close(() => {
      pool.end().then(() => process.exit(0)).catch(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
