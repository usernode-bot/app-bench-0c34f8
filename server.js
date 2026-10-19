const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
// The same catalogue the browser loads; it validates kinds and item ids.
const { CATALOGUE } = require('./public/catalogue.js');

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

// ── Ear Trainer's progress store ─────────────────────────────────────────
// One row per (user, lesson type, item): right answers in a row, whether the
// item is mastered (three in a row), last answer. Demo rows (?demo=1 on
// staging) live behind the same key with demo = true, so plain routes never
// see them.

const usernameOf = (user) => (user && (user.username || user.id)) || 'user';
const useDemoFlag = (req) => IS_STAGING && req.query.demo === '1';

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS progress (
      username text NOT NULL,
      demo boolean NOT NULL DEFAULT false,
      kind text NOT NULL,
      item_id text NOT NULL,
      streak int NOT NULL DEFAULT 0,
      mastered boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (username, demo, kind, item_id)
    )`);
  // Progress is per-person, not for the group to browse.
  await pool.query(`COMMENT ON TABLE progress IS 'staging:private'`);
}

// The first version's populated demo (?demo=1 on staging): one fixed set of
// made-up rows for the signed-in viewer, written once, clearly fake.
const DEMO_ROWS = [
  // [kind, item_id, streak, mastered, hours ago] — progressions get the
  // latest times, so the screen opens there. Amazing Grace is mastered but
  // currently on 2 in a row, as the drawn screen shows.
  ['notes', 'octave', 3, true, 220], ['notes', 'perfect-fifth', 3, true, 219],
  ['notes', 'major-third', 3, true, 190], ['notes', 'perfect-fourth', 3, true, 189],
  ['notes', 'minor-third', 1, false, 150],
  ['chords', 'major', 3, true, 160], ['chords', 'minor', 3, true, 159],
  ['chords', 'diminished', 2, false, 140],
  ['progressions', 'amen', 3, true, 6], ['progressions', 'hit-the-road-jack', 3, true, 5],
  ['progressions', 'let-it-be', 3, true, 4], ['progressions', 'zombie', 1, false, 3],
  ['progressions', 'amazing-grace', 2, true, 2],
];

async function seedDemoRows(req) {
  // "Once": if the viewer already has demo rows (a reset made some of them
  // disappear included), leave what is there alone.
  const existing = await pool.query(
    'SELECT 1 FROM progress WHERE username = $1 AND demo = true LIMIT 1',
    [usernameOf(req.user)]);
  if (existing.rowCount > 0) return;
  const now = req.now;
  for (const [kind, itemId, streak, mastered, hoursAgo] of DEMO_ROWS) {
    if (!CATALOGUE[kind] || !CATALOGUE[kind].items.some((it) => it.id === itemId)) continue;
    await pool.query(
      `INSERT INTO progress (username, demo, kind, item_id, streak, mastered, updated_at)
       VALUES ($1, true, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [usernameOf(req.user), kind, itemId, streak, mastered,
       new Date(now.getTime() - hoursAgo * 3600 * 1000)]);
  }
}

app.get('/api/progress', async (req, res) => {
  try {
    if (!req.user) return res.json({ guest: true, rows: [] });
    const demo = useDemoFlag(req);
    if (demo) await seedDemoRows(req);
    const { rows } = await pool.query(
      `SELECT kind, item_id, streak, mastered, updated_at
       FROM progress WHERE username = $1 AND demo = $2`,
      [usernameOf(req.user), demo]);
    res.json({ guest: false, rows });
  } catch (err) {
    console.error('GET /api/progress failed: ' + err.message);
    res.status(500).json({ error: 'storage_failed' });
  }
});

app.post('/api/answers', async (req, res) => {
  try {
    const { kind, itemId, correct } = req.body || {};
    const kindCat = CATALOGUE[kind];
    if (!kindCat || !kindCat.items.some((it) => it.id === itemId) ||
        typeof correct !== 'boolean') {
      return res.status(400).json({ error: 'bad_request' });
    }
    const demo = useDemoFlag(req);
    // Right adds 1 to the streak and masters at 3; wrong starts the streak
    // again but never unmasters.
    const { rows } = await pool.query(
      `INSERT INTO progress (username, demo, kind, item_id, streak, mastered, updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN 1 ELSE 0 END, false, now())
       ON CONFLICT (username, demo, kind, item_id) DO UPDATE SET
         streak = CASE WHEN $5::boolean THEN progress.streak + 1 ELSE 0 END,
         mastered = progress.mastered OR (CASE WHEN $5::boolean THEN progress.streak + 1 ELSE 0 END) >= 3,
         updated_at = now()
       RETURNING kind, item_id, streak, mastered, updated_at`,
      [usernameOf(req.user), demo, kind, itemId, correct]);
    res.json(rows[0]);
  } catch (err) {
    console.error('POST /api/answers failed: ' + err.message);
    res.status(500).json({ error: 'storage_failed' });
  }
});

app.post('/api/progress/reset', async (req, res) => {
  try {
    const { kind } = req.body || {};
    if (!CATALOGUE[kind]) return res.status(400).json({ error: 'bad_request' });
    await pool.query(
      'DELETE FROM progress WHERE username = $1 AND demo = $2 AND kind = $3',
      [usernameOf(req.user), useDemoFlag(req), kind]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/progress/reset failed: ' + err.message);
    res.status(500).json({ error: 'storage_failed' });
  }
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
      return res.redirect(302, PLATFORM_ORIGIN + '/app/ear-trainer/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/ear-trainer/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

let server;

async function start() {
  try {
    await initSchema();
  } catch (err) {
    console.error('schema init failed: ' + err.message);
  }
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

// Stop accepting connections, drain for about 3 s, close the pool, exit.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const force = setTimeout(() => process.exit(0), 3000);
  try {
    if (server) await new Promise((resolve) => server.close(resolve));
    await pool.end();
  } catch (err) {
    console.error('shutdown error: ' + err.message);
  }
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(err => { console.error(err); process.exit(1); });
