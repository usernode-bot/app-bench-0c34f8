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

app.use(express.static(path.join(__dirname, 'public')));

// three.js is an npm dependency, served as-is to the page's ES module.
// three.module.js imports ./three.core.js, so the browser asks for that
// one right after; both are served.
app.get(/^\/vendor\/three\.(module|core)\.js$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'three', 'build', path.basename(req.path)));
});

// ── The shared world ─────────────────────────────────────────────────────
// One world for the whole project: a 64 by 64 grass plain you can build on
// up to 32 blocks high. y 0 is the plain itself; blocks live at y 1..32.
const SIX_TYPES = new Set(['grass', 'stone', 'wood', 'glass', 'brick', 'sand']);
const inBounds = (x, y, z) =>
  Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) &&
  x >= -32 && x <= 31 && z >= -32 && z <= 31 && y >= 1 && y <= 32;

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocks (
      x int NOT NULL,
      y int NOT NULL,
      z int NOT NULL,
      type text NOT NULL,
      placed_by text,
      placed_at timestamptz,
      is_demo boolean NOT NULL DEFAULT false,
      PRIMARY KEY (x, y, z)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_seeded (
      key text PRIMARY KEY
    )`);
}

// ── Staging demo ─────────────────────────────────────────────────────────
// Only on staging, only asked for by ?demo=1: a plain that already holds
// about 300 blocks of builds by made-up builders, plus the viewer's own
// half-finished brick wall. Idempotent, one transaction, marked is_demo so
// every answer without ?demo=1 leaves them out.
const DEMO_BUILDERS = ['Maya', 'Dev', 'Sam', 'Priya'];

function demoWorldCells() {
  const cells = [];
  let bi = 0;
  const next = () => DEMO_BUILDERS[bi++ % DEMO_BUILDERS.length];
  const add = (x, y, z, type, by) => cells.push({ x, y, z, type, by: by || next() });

  // Cottage: wood walls, glass windows, a wood roof and a brick chimney.
  for (let y = 1; y <= 3; y++) {
    for (let x = -12; x <= -7; x++) {
      for (let z = -6; z <= -1; z++) {
        const edge = x === -12 || x === -7 || z === -6 || z === -1;
        if (!edge) continue;
        if (z === -1 && x === -10 && y <= 2) continue; // the door
        if (y === 2 && ((x === -12 && (z === -4 || z === -3)) || (x === -7 && (z === -4 || z === -3)))) {
          add(x, y, z, 'glass');
          continue;
        }
        add(x, y, z, 'wood');
      }
    }
  }
  for (let x = -12; x <= -7; x++) {
    for (let z = -6; z <= -1; z++) {
      if (x === -8 && z === -2) continue; // the chimney's foot
      add(x, 4, z, 'wood', 'Maya');
    }
  }
  for (let x = -11; x <= -8; x++) for (let z = -5; z <= -2; z++) add(x, 5, z, 'wood', 'Dev');
  add(-8, 4, -2, 'brick', 'Dev'); add(-8, 5, -2, 'brick', 'Dev');
  add(-8, 6, -2, 'brick', 'Maya'); add(-8, 7, -2, 'brick', 'Maya');

  // Stone tower with a doorway.
  for (let y = 1; y <= 8; y++) {
    for (let x = 10; x <= 13; x++) {
      for (let z = -14; z <= -11; z++) {
        const edge = x === 10 || x === 13 || z === -14 || z === -11;
        if (!edge) continue;
        if (z === -11 && (x === 11 || x === 12) && y <= 2) continue;
        add(x, y, z, 'stone', 'Sam');
      }
    }
  }

  // Sand path from where you start, with a leg towards the cottage.
  for (let z = 8; z <= 21; z++) { add(1, 1, z, 'sand', 'Priya'); add(2, 1, z, 'sand', 'Priya'); }
  for (let x = -6; x <= 1; x++) { add(x, 1, 1, 'sand', 'Priya'); add(x, 1, 2, 'sand', 'Priya'); }

  // A stone hill with a grass top, and a wood tree on it.
  for (let x = -21; x <= -15; x++) {
    for (let z = 6; z <= 12; z++) {
      const d = Math.max(Math.abs(x + 18), Math.abs(z - 9));
      const h = d <= 1 ? 3 : d <= 2 ? 2 : d <= 3 ? 1 : 0;
      for (let y = 1; y <= h; y++) add(x, y, z, y === h ? 'grass' : 'stone', 'Maya');
    }
  }
  add(-18, 4, 9, 'wood', 'Maya'); add(-18, 5, 9, 'wood', 'Maya');
  for (let x = -19; x <= -17; x++) for (let z = 8; z <= 10; z++) add(x, 6, z, 'grass', 'Maya');
  add(-18, 7, 9, 'grass', 'Maya');

  return cells;
}

function viewerWallCells(name) {
  // The viewer's own small build, near where you start: half-finished.
  const cells = [];
  for (let x = 4; x <= 8; x++) cells.push({ x, y: 1, z: 20, type: 'brick', by: name });
  for (let x = 4; x <= 6; x++) cells.push({ x, y: 2, z: 20, type: 'brick', by: name });
  return cells;
}

const insertBlock = `
  INSERT INTO blocks (x, y, z, type, placed_by, placed_at, is_demo)
  VALUES ($1, $2, $3, $4, $5, now(), true)
  ON CONFLICT DO NOTHING`;

async function seedDemo(viewerName) {
  if (!IS_STAGING) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const world = await client.query("SELECT 1 FROM demo_seeded WHERE key = 'world' FOR UPDATE");
    if (world.rowCount === 0) {
      for (const c of demoWorldCells()) {
        await client.query(insertBlock, [c.x, c.y, c.z, c.type, c.by]);
      }
      await client.query("INSERT INTO demo_seeded (key) VALUES ('world') ON CONFLICT DO NOTHING");
    }
    if (viewerName) {
      const vk = 'viewer:' + viewerName;
      const wall = await client.query('SELECT 1 FROM demo_seeded WHERE key = $1 FOR UPDATE', [vk]);
      if (wall.rowCount === 0) {
        for (const c of viewerWallCells(viewerName)) {
          await client.query(insertBlock, [c.x, c.y, c.z, c.type, c.by]);
        }
        await client.query('INSERT INTO demo_seeded (key) VALUES ($1) ON CONFLICT DO NOTHING', [vk]);
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

// ── Live hub (Server-Sent Events) ────────────────────────────────────────
const streamClients = new Set(); // { res, name, demo }

function hereNames(demo) {
  const names = [];
  if (demo) names.push(...DEMO_BUILDERS); // the fake builders are "here" in the demo
  for (const c of streamClients) if (c.name && !names.includes(c.name)) names.push(c.name);
  return names;
}

function sendPresence() {
  for (const c of streamClients) {
    try { c.res.write(`data: ${JSON.stringify({ kind: 'presence', here: hereNames(c.demo) })}\n\n`); } catch {}
  }
}

function broadcast(obj) {
  for (const c of streamClients) {
    try { c.res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
  }
}

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const client = {
    res,
    name: req.user ? req.user.username : null,
    demo: req.query.demo === '1',
  };
  streamClients.add(client);
  sendPresence();
  // A heartbeat comment keeps the stream under the platform's 60s idle timeout.
  const hb = setInterval(() => { try { res.write(':hb\n\n'); } catch {} }, 25_000);
  req.on('close', () => {
    clearInterval(hb);
    streamClients.delete(client);
    sendPresence();
  });
});

// ── Routes ───────────────────────────────────────────────────────────────
// Guests may read the world; only writes need an account (the middleware
// above answers 401 account_required before these handlers run).

app.get('/api/world', async (req, res) => {
  try {
    const showDemo = IS_STAGING && req.query.demo === '1';
    if (showDemo) await seedDemo(req.user ? req.user.username : null);
    const { rows } = await pool.query(
      'SELECT x, y, z, type FROM blocks' + (showDemo ? '' : ' WHERE NOT is_demo')
    );
    res.json({
      blocks: rows.map((r) => [r.x, r.y, r.z, r.type]),
      here: hereNames(showDemo),
      you: req.user ? req.user.username : null,
    });
  } catch (err) {
    console.error('world failed: ' + err.message);
    res.status(500).json({ error: 'world_failed' });
  }
});

app.put('/api/blocks', async (req, res) => {
  const { x, y, z, type } = req.body || {};
  if (!SIX_TYPES.has(type)) return res.status(400).json({ error: 'bad_block' });
  if (!inBounds(x, y, z)) return res.status(400).json({ error: 'out_of_bounds' });
  try {
    // An upsert: a cell that holds a hidden demo block can still be built on.
    await pool.query(`
      INSERT INTO blocks (x, y, z, type, placed_by, placed_at, is_demo)
      VALUES ($1, $2, $3, $4, $5, now(), false)
      ON CONFLICT (x, y, z) DO UPDATE
        SET type = EXCLUDED.type, placed_by = EXCLUDED.placed_by,
            placed_at = now(), is_demo = false`,
      [x, y, z, type, req.user.username]);
    broadcast({ kind: 'set', cell: [x, y, z, type], by: req.user.username });
    res.json({ ok: true });
  } catch (err) {
    console.error('place failed: ' + err.message);
    res.status(500).json({ error: 'save_failed' });
  }
});

app.delete('/api/blocks', async (req, res) => {
  const x = Number(req.query.x), y = Number(req.query.y), z = Number(req.query.z);
  if (!inBounds(x, y, z)) return res.status(400).json({ error: 'out_of_bounds' });
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM blocks WHERE x = $1 AND y = $2 AND z = $3', [x, y, z]);
    if (rowCount === 0) return res.status(404).json({ error: 'empty_cell' });
    broadcast({ kind: 'clear', cell: [x, y, z], by: req.user.username });
    res.json({ ok: true });
  } catch (err) {
    console.error('break failed: ' + err.message);
    res.status(500).json({ error: 'break_failed' });
  }
});

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

// ── Boot and shutdown ────────────────────────────────────────────────────
let server;

async function start() {
  await migrate();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

function shutdown() {
  for (const c of streamClients) { try { c.res.end(); } catch {} }
  streamClients.clear();
  if (server) server.close(() => process.exit(0));
  // Never hang the container: exit on our own after the drain window.
  setTimeout(() => process.exit(0), 3000).unref();
  pool.end().catch(() => {});
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(err => { console.error(err); process.exit(1); });