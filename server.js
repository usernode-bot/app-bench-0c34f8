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

// ── Block world ──────────────────────────────────────────────────────────
// One shared world for the whole project: a 64 by 64 grass plain (y = 0,
// always there, never stored) that people build on up to 32 blocks high.
const BLOCK_TYPES = new Set(['grass', 'stone', 'wood', 'glass', 'brick', 'sand']);
const MIN_XZ = -32;
const MAX_XZ = 31;
const MIN_Y = 1;
const MAX_Y = 32;

const DEMO_NAMES = ['Maya', 'Dev', 'Sam', 'Priya'];

function userName(req) {
  return req.user && typeof req.user.username === 'string' && req.user.username
    ? req.user.username
    : null;
}

function isDemoRequest(req) {
  return IS_STAGING && req.query.demo === '1';
}

// ── Live connections ─────────────────────────────────────────────────────
// One Server-Sent Events stream per open world. Each carries its own name
// (null for a guest, who may look but not build) and whether it was opened
// as the staging demo, so demo streams see the made-up builders too.
const streams = new Set();

function sendTo(stream, event, data) {
  try {
    stream.res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  } catch {}
}

function presenceNames(demo) {
  // A demo stream is watching the made-up builders' world: show those four,
  // as the spec's "Maya, Dev and 2 more" has it.
  if (demo) return DEMO_NAMES.slice();
  const names = [];
  for (const stream of streams) {
    if (stream.name && !names.includes(stream.name)) names.push(stream.name);
  }
  return names;
}

function broadcastPresence() {
  for (const stream of streams) {
    sendTo(stream, 'presence', { names: presenceNames(stream.demo) });
  }
}

function broadcast(event, data) {
  for (const stream of streams) sendTo(stream, event, data);
}

// ── Schema ───────────────────────────────────────────────────────────────
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocks (
      x int NOT NULL,
      y int NOT NULL,
      z int NOT NULL,
      type text NOT NULL,
      placed_by text,
      placed_at timestamptz NOT NULL DEFAULT now(),
      is_demo boolean NOT NULL DEFAULT false,
      PRIMARY KEY (x, y, z)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_seeded (
      key text PRIMARY KEY,
      seeded_at timestamptz NOT NULL DEFAULT now()
    )`);
}

// ── Staging demo ─────────────────────────────────────────────────────────
// Built on the first `?demo=1` read on staging only, once per key. The
// builds are fixed, obviously made up, and stored as is_demo rows so a
// plain (non-demo) read never sees them.
function demoLayout() {
  const cells = new Map(); // "x,y,z" -> { type, by }
  const put = (x, y, z, type, by) => cells.set(x + ',' + y + ',' + z, { x, y, z, type, by });
  const fill = (x0, x1, y0, y1, z0, z1, type, by) => {
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) put(x, y, z, type, by);
      }
    }
  };
  const ring = (cx, cz, radius, y0, y1, type, by) => {
    for (let x = cx - radius; x <= cx + radius; x++) {
      for (let z = cz - radius; z <= cz + radius; z++) {
        const d = Math.hypot(x - cx, z - cz);
        if (d <= radius + 0.35 && d >= radius - 0.65) {
          for (let y = y0; y <= y1; y++) put(x, y, z, type, by);
        }
      }
    }
  };

  // Maya's wood and glass cottage, with a brick chimney.
  for (let x = 4; x <= 9; x++) {
    for (let z = 0; z <= 4; z++) {
      if (x === 4 || x === 9 || z === 0 || z === 4) {
        for (let y = 1; y <= 3; y++) put(x, y, z, 'wood', 'Maya');
      }
    }
  }
  fill(4, 9, 4, 4, 0, 4, 'wood', 'Maya');
  fill(5, 8, 5, 5, 1, 3, 'wood', 'Maya');
  for (const [x, z] of [[6, 4], [8, 4], [4, 2], [9, 2]]) put(x, 2, z, 'glass', 'Maya');
  put(7, 1, 4, 'glass', 'Maya');
  put(7, 2, 4, 'glass', 'Maya');
  fill(8, 9, 5, 7, 0, 1, 'brick', 'Maya');

  // Dev's stone tower.
  ring(-13, -7, 2, 1, 7, 'stone', 'Dev');
  ring(-13, -7, 2, 8, 8, 'stone', 'Dev');

  // Sam's sand path from the start toward the cottage door.
  fill(6, 7, 1, 1, 5, 21, 'sand', 'Sam');

  // Sam's grass hill with Priya's wood tree on top.
  for (let x = 10; x <= 18; x++) {
    for (let z = -16; z <= -8; z++) {
      const d = Math.hypot(x - 14, z + 12);
      const height = Math.round(4 - d);
      for (let y = 1; y <= height; y++) put(x, y, z, 'grass', 'Sam');
    }
  }
  fill(14, 14, 5, 8, -12, -12, 'wood', 'Priya');
  for (let x = 12; x <= 16; x++) {
    for (let z = -14; z <= -10; z++) {
      for (let y = 8; y <= 10; y++) {
        const d = Math.hypot(x - 14, z + 12, (y - 9) * 1.2);
        if (d <= 2.4) put(x, y, z, 'grass', 'Priya');
      }
    }
  }
  return [...cells.values()];
}

// The viewer's own half-finished brick wall, close to where they start.
function viewerLayout(username) {
  const cells = [];
  const add = (x, y, z) => cells.push({ x, y, z, type: 'brick', by: username });
  for (let x = -10; x <= -5; x++) add(x, 1, 12);
  for (let x = -10; x <= -7; x++) add(x, 2, 12);
  add(-10, 3, 12);
  return cells;
}

async function seedDemo(username) {
  await seedKey('world', demoLayout);
  if (username) await seedKey('viewer:' + username, () => viewerLayout(username));
}

async function seedKey(key, make) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      'INSERT INTO demo_seeded (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key',
      [key]
    );
    if (claimed.rowCount) {
      const cells = make();
      // Chunked multi-row insert: one statement per 100 cells.
      for (let i = 0; i < cells.length; i += 100) {
        const chunk = cells.slice(i, i + 100);
        const values = [];
        const params = [];
        chunk.forEach((c, n) => {
          const base = n * 5;
          values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, true)`);
          params.push(c.x, c.y, c.z, c.type, c.by);
        });
        await client.query(
          'INSERT INTO blocks (x, y, z, type, placed_by, is_demo) VALUES ' +
            values.join(', ') +
            ' ON CONFLICT (x, y, z) DO NOTHING',
          params
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// three.js is vendored with the app (npm dependency) and served from the
// module the page imports. It is a static asset, like the stylesheet.
// three.module.js imports three.core.js beside it, so both are served.
const THREE_BUILD = path.join(__dirname, 'node_modules', 'three', 'build');
app.get('/vendor/three.module.js', (_req, res) => {
  res.type('text/javascript');
  res.sendFile(path.join(THREE_BUILD, 'three.module.js'));
});
app.get('/vendor/three.core.js', (_req, res) => {
  res.type('text/javascript');
  res.sendFile(path.join(THREE_BUILD, 'three.core.js'));
});

app.get('/api/world', async (req, res) => {
  try {
    const demo = isDemoRequest(req);
    if (demo) await seedDemo(userName(req));
    const result = await pool.query(
      'SELECT x, y, z, type FROM blocks' +
        (demo ? '' : ' WHERE is_demo = false') +
        ' ORDER BY y, x, z'
    );
    res.json({
      blocks: result.rows.map((r) => [r.x, r.y, r.z, r.type]),
      names: presenceNames(demo),
      demo,
      you: { name: userName(req), canBuild: Boolean(req.user) },
    });
  } catch (err) {
    console.error('world read failed: ' + err.message);
    res.status(500).json({ error: 'world_unavailable' });
  }
});

app.put('/api/blocks', async (req, res) => {
  const body = req.body || {};
  const x = Number(body.x);
  const y = Number(body.y);
  const z = Number(body.z);
  const type = body.type;
  if (
    !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) ||
    x < MIN_XZ || x > MAX_XZ || z < MIN_XZ || z > MAX_XZ ||
    y < MIN_Y || y > MAX_Y ||
    !BLOCK_TYPES.has(type)
  ) {
    return res.status(400).json({ error: 'invalid_block' });
  }
  const name = userName(req);
  try {
    await pool.query(
      `INSERT INTO blocks (x, y, z, type, placed_by, is_demo)
       VALUES ($1, $2, $3, $4, $5, false)
       ON CONFLICT (x, y, z) DO UPDATE
         SET type = EXCLUDED.type, placed_by = EXCLUDED.placed_by,
             placed_at = now(), is_demo = false`,
      [x, y, z, type, name]
    );
    broadcast('set', { x, y, z, type, by: name });
    res.json({ ok: true });
  } catch (err) {
    console.error('place failed: ' + err.message);
    res.status(500).json({ error: 'not_saved' });
  }
});

app.delete('/api/blocks', async (req, res) => {
  const x = Number(req.query.x);
  const y = Number(req.query.y);
  const z = Number(req.query.z);
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
    return res.status(400).json({ error: 'invalid_block' });
  }
  const name = userName(req);
  try {
    const result = await pool.query(
      'DELETE FROM blocks WHERE x = $1 AND y = $2 AND z = $3 RETURNING type',
      [x, y, z]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'empty' });
    broadcast('clear', { x, y, z, type: result.rows[0].type, by: name });
    res.json({ ok: true });
  } catch (err) {
    console.error('break failed: ' + err.message);
    res.status(500).json({ error: 'not_saved' });
  }
});

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  const stream = {
    res,
    name: userName(req),
    demo: isDemoRequest(req),
    hb: null,
  };
  // A comment every 25 s keeps the connection under the 60 s idle timeout.
  stream.hb = setInterval(() => {
    try { res.write(': keep-alive\n\n'); } catch {}
  }, 25_000);
  if (stream.hb.unref) stream.hb.unref();

  streams.add(stream);
  sendTo(stream, 'presence', { names: presenceNames(stream.demo) });
  broadcastPresence();

  const drop = () => {
    clearInterval(stream.hb);
    if (streams.delete(stream)) broadcastPresence();
  };
  req.on('close', drop);
  req.on('aborted', drop);
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

let server = null;
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  // Close the live streams first: they are long-lived and would otherwise
  // hold the server open until their clients gave up.
  for (const stream of streams) {
    clearInterval(stream.hb);
    try { stream.res.end(); } catch {}
  }
  streams.clear();
  const finish = () => pool.end().then(() => process.exit(0)).catch(() => process.exit(0));
  // Drain for about three seconds, then finish regardless.
  setTimeout(finish, 3000).unref();
  if (server) {
    server.close(() => finish());
    if (server.closeIdleConnections) server.closeIdleConnections();
  } else {
    finish();
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
  await migrate();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
