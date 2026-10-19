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

// ── Block World's world model ────────────────────────────────────────────
// Eight block types, always this order: the hotbar and the compact rows the
// client receives both index into it.
const BLOCK_TYPES = ['grass', 'dirt', 'stone', 'oak', 'leaves', 'water', 'sand', 'brick'];
// The world has edges 64 blocks out from the island's centre each way and
// 48 up or down, so nobody gets lost in empty sky.
const BOUND_XZ = 64;
const BOUND_Y = 48;
const MAX_CHANGES = 2000;

function inBounds(x, y, z) {
  return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) &&
    Math.abs(x) <= BOUND_XZ && Math.abs(z) <= BOUND_XZ && Math.abs(y) <= BOUND_Y;
}
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

// ── The starter island ───────────────────────────────────────────────────
// Deterministic: a 16-ish wide grass top, a sandy edge, a small pond, dirt
// sides and a stone underside that tapers to a point, with one oak tree.
// Generated in code so every fresh world starts the same.
function islandBlocks() {
  const out = [];
  const add = (x, y, z, type) => out.push([x, y, z, type]);
  for (let x = -9; x <= 9; x++) {
    for (let z = -9; z <= 9; z++) {
      const d2 = x * x + z * z;
      const inPond = (x - 3) * (x - 3) + (z + 2) * (z + 2) <= 7;
      if (d2 <= 64) add(x, 0, z, inPond ? 'water' : 'grass');
      else if (d2 <= 81) add(x, 0, z, 'sand');
      if (d2 <= 64) add(x, -1, z, 'dirt');
      if (d2 <= 81) add(x, -2, z, 'dirt');
      if (d2 <= 81) add(x, -3, z, 'stone');
      if (d2 <= 64) add(x, -4, z, 'stone');
      if (d2 <= 42) add(x, -5, z, 'stone');
      if (d2 <= 20) add(x, -6, z, 'stone');
      if (d2 <= 6) add(x, -7, z, 'stone');
    }
  }
  // One tree on the north-west side.
  const tx = -4;
  const tz = 4;
  for (let y = 1; y <= 3; y++) add(tx, y, tz, 'oak');
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (Math.abs(dx) === 1 && Math.abs(dz) === 1) continue;
      add(tx + dx, 4, tz + dz, 'leaves');
    }
  }
  add(tx, 5, tz, 'leaves');
  return out;
}

// Staging's demo builds: an oak hut with a brick chimney, a stone tower, a
// sand path to the pond and a second tree, made by five made-up builders.
// Laid out as [x, y, z, type, builder].
function demoBlocks() {
  const out = [];
  const put = (x, y, z, type, by) => out.push([x, y, z, type, by]);
  // Oak hut: a 3 by 3 room with walls, a doorway on the west side, a leaf roof.
  for (let y = 1; y <= 2; y++) {
    for (let x = 4; x <= 6; x++) {
      for (let z = 3; z <= 5; z++) {
        const edge = x === 4 || x === 6 || z === 3 || z === 5;
        if (!edge) continue;
        if (x === 4 && z === 4) continue; // doorway
        put(x, y, z, 'oak', 'Maya');
      }
    }
  }
  for (let x = 3; x <= 7; x++) {
    for (let z = 2; z <= 6; z++) put(x, 3, z, 'oak', 'Maya');
  }
  // Chimney up the hut's north-east corner.
  put(6, 4, 3, 'brick', 'Kofi');
  put(6, 5, 3, 'brick', 'Kofi');
  put(6, 6, 3, 'brick', 'Kofi');
  // Stone tower on the west side.
  for (let y = 1; y <= 5; y++) {
    for (let x = -7; x <= -6; x++) {
      for (let z = -5; z <= -4; z++) put(x, y, z, 'stone', 'Theo');
    }
  }
  // A sand path from the island's centre to the pond's edge.
  for (let z = 1; z <= 1; z++) {
    for (let x = 1; x <= 3; x++) put(x, 0, z, 'sand', 'Ines');
  }
  put(2, 0, 2, 'sand', 'Ines');
  put(3, 0, 2, 'sand', 'Ines');
  // A second tree on the east side.
  for (let y = 1; y <= 3; y++) put(6, y, -6, 'oak', 'Sam');
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (Math.abs(dx) === 1 && Math.abs(dz) === 1) continue;
      put(6 + dx, 4, -6 + dz, 'leaves', 'Sam');
    }
  }
  put(6, 5, -6, 'leaves', 'Sam');
  return out;
}

// Write the starter island exactly once, even after everything is broken.
async function seedIsland(client) {
  const flag = await client.query(`SELECT value FROM world_meta WHERE key = 'island_seeded'`);
  if (flag.rowCount) return;
  const rows = islandBlocks();
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    values.push(`($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, NULL, $${rows.length * 4 + 1})`);
    params.push(r[0], r[1], r[2], r[3]);
  });
  params.push(new Date());
  await client.query(
    `INSERT INTO blocks (x, y, z, type, placed_by, placed_at) VALUES ${values.join(',')}
     ON CONFLICT (x, y, z) DO NOTHING`,
    params
  );
  await client.query(
    `INSERT INTO world_meta (key, value) VALUES ('island_seeded', '1') ON CONFLICT (key) DO NOTHING`
  );
}

// Staging only: the demo builds, written once with made-up builders.
async function seedDemo(client) {
  const flag = await client.query(`SELECT value FROM world_meta WHERE key = 'demo_seeded'`);
  if (flag.rowCount) return;
  const rows = demoBlocks();
  const now = new Date();
  // The builds were made earlier in the day, so the demo's "building now"
  // line is the two people the demo route says are active.
  const builtAt = new Date(now.getTime() - 20 * 60 * 1000);
  for (const [x, y, z, type, by] of rows) {
    // The path replaces the grass it lies on; the rest leaves the island be.
    const upsert = type === 'sand';
    await client.query(
      `INSERT INTO blocks (x, y, z, type, placed_by, placed_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (x, y, z) DO ${upsert ? 'UPDATE SET type = EXCLUDED.type, placed_by = EXCLUDED.placed_by' : 'NOTHING'}`,
      [x, y, z, type, by, now]
    );
    await client.query(
      `INSERT INTO block_changes (x, y, z, type, username, at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [x, y, z, type, by, builtAt]
    );
  }
  await client.query(
    `INSERT INTO world_meta (key, value) VALUES ('demo_seeded', '1') ON CONFLICT (key) DO NOTHING`
  );
}

// Counts shared by the world and changes routes.
async function worldCounts(req, demo) {
  const counts = await pool.query(
    `SELECT
       (SELECT count(DISTINCT username) FROM block_changes)::int AS builders,
       (SELECT count(*) FROM blocks WHERE placed_by = $1)::int AS placed`,
    [req.user ? req.user.username : null]
  );
  const active = await pool.query(
    `SELECT DISTINCT username FROM block_changes
      WHERE at >= $1 AND ($2::text IS NULL OR username <> $2)
      ORDER BY username`,
    [new Date(req.now.getTime() - 5 * 60 * 1000), req.user ? req.user.username : null]
  );
  const names = active.rows.map(r => r.username).filter(Boolean);
  let builders = counts.rows[0].builders;
  let placed = req.user ? counts.rows[0].placed : 0;
  if (demo) {
    for (const n of ['Maya', 'Theo']) if (!names.includes(n)) names.push(n);
    builders = Math.max(builders, 6);
    placed += 24;
  }
  return { builders, active: names, placed, demo: !!demo };
}

function isDemo(req) {
  return IS_STAGING && req.query.demo === '1';
}

// GET /api/world: every block, compact, plus the latest sequence number.
app.get('/api/world', async (req, res) => {
  try {
    const demo = isDemo(req);
    const blocks = await pool.query(`SELECT x, y, z, type FROM blocks ORDER BY y, x, z`);
    const seq = await pool.query(`SELECT coalesce(max(seq), 0)::bigint AS seq FROM block_changes`);
    const counts = await worldCounts(req, demo);
    res.json({
      blocks: blocks.rows.map(b => [b.x, b.y, b.z, BLOCK_TYPES.indexOf(b.type)]),
      seq: Number(seq.rows[0].seq),
      ...counts,
      me: { placed: counts.placed },
    });
  } catch (err) {
    console.error('world load failed: ' + err.message);
    res.status(500).json({ error: 'world_unavailable' });
  }
});

// GET /api/changes?since=seq: what changed after `seq`.
app.get('/api/changes', async (req, res) => {
  try {
    const since = Number.parseInt(req.query.since, 10);
    if (!Number.isFinite(since) || since < 0) return res.status(400).json({ error: 'bad_since' });
    const demo = isDemo(req);
    const changes = await pool.query(
      `SELECT seq, x, y, z, type, username FROM block_changes
        WHERE seq > $1 ORDER BY seq LIMIT $2`,
      [since, MAX_CHANGES + 1]
    );
    const more = changes.rowCount > MAX_CHANGES;
    const rows = changes.rows.slice(0, MAX_CHANGES);
    const counts = await worldCounts(req, demo);
    res.json({
      changes: rows.map(c => [c.x, c.y, c.z, c.type === null ? -1 : BLOCK_TYPES.indexOf(c.type)]),
      seq: rows.length ? Number(rows[rows.length - 1].seq) : since,
      more,
      ...counts,
      me: { placed: counts.placed },
    });
  } catch (err) {
    console.error('changes load failed: ' + err.message);
    res.status(500).json({ error: 'changes_unavailable' });
  }
});

// Writes: a block placed or broken is stored and logged in one transaction.
async function logChange(client, x, y, z, type, username) {
  const row = await client.query(
    `INSERT INTO block_changes (x, y, z, type, username, at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING seq`,
    [x, y, z, type, username, new Date()]
  );
  return Number(row.rows[0].seq);
}

app.put('/api/blocks', async (req, res) => {
  const { x, y, z, type } = req.body || {};
  if (!inBounds(x, y, z) || !BLOCK_TYPES.includes(type)) {
    return res.status(400).json({ error: 'bad_block' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO blocks (x, y, z, type, placed_by, placed_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (x, y, z) DO UPDATE SET type = EXCLUDED.type, placed_by = EXCLUDED.placed_by, placed_at = EXCLUDED.placed_at`,
      [x, y, z, type, req.user.username, new Date()]
    );
    const seq = await logChange(client, x, y, z, type, req.user.username);
    await client.query('COMMIT');
    res.json({ seq });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('place failed: ' + err.message);
    res.status(500).json({ error: 'not_saved' });
  } finally {
    client.release();
  }
});

app.delete('/api/blocks', async (req, res) => {
  const { x, y, z } = req.body || {};
  if (!inBounds(x, y, z)) return res.status(400).json({ error: 'bad_block' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const removed = await client.query(`DELETE FROM blocks WHERE x = $1 AND y = $2 AND z = $3`, [x, y, z]);
    // Breaking an empty cell is a no-op that still answers 200.
    const seq = removed.rowCount
      ? await logChange(client, x, y, z, null, req.user.username)
      : null;
    await client.query('COMMIT');
    res.json({ seq: seq === null ? null : Number(seq) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('break failed: ' + err.message);
    res.status(500).json({ error: 'not_saved' });
  } finally {
    client.release();
  }
});

// Three.js, served from the installed package so the page needs no CDN.
// `three.module.js` imports `./three.core.js`, so the whole build directory
// is reachable under /lib/.
app.get('/lib/:file', (req, res, next) => {
  if (!/^[a-z0-9.]+\.js$/.test(req.params.file)) return next();
  res.sendFile(path.join(__dirname, 'node_modules', 'three', 'build', req.params.file));
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

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocks (
      x integer NOT NULL,
      y integer NOT NULL,
      z integer NOT NULL,
      type text NOT NULL,
      placed_by text,
      placed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (x, y, z)
    );
    CREATE TABLE IF NOT EXISTS block_changes (
      seq bigserial PRIMARY KEY,
      x integer NOT NULL,
      y integer NOT NULL,
      z integer NOT NULL,
      type text,
      username text NOT NULL,
      at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS block_changes_at_idx ON block_changes (at);
    CREATE TABLE IF NOT EXISTS world_meta (
      key text PRIMARY KEY,
      value text NOT NULL
    );
  `);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedIsland(client);
    if (IS_STAGING) await seedDemo(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function start() {
  await migrate();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    server.close();
    await new Promise(resolve => setTimeout(resolve, 3000));
    await pool.end().catch(() => {});
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
