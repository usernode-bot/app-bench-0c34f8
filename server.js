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

// ── Decisions ──────────────────────────────────────────────────────────────
// The kit's items-with-votes-and-comments resource (kit/server.js, see
// public/kit/README.md): GET/POST /api/decisions, GET /api/decisions/:id,
// POST /api/decisions/:id/vote, POST /api/decisions/:id/comments and
// DELETE /api/decisions/:id. Every decision votes For/Against/Abstain, so the
// middleware below strips any `options` a client tries to send and the
// resource is mounted with the club's three fixed options.
// Staging demo rows (?demo=1 on staging): eight made-up decisions, newest
// first, and a pool of made-up comment lines, so the populated screen can be
// seen without anyone typing first. Fake on purpose — see "Staging mock data"
// in the platform conventions.
const DEMO_DECISIONS = [
  { title: 'Move club nights from Tuesday to Thursday', body: 'The hall now charges extra on Tuesdays, and three of us clash with evening classes. Thursdays are free at the same time, 7 to 9.' },
  { title: 'Switch the newsletter from print to email', body: 'Printing and posting 120 copies costs 40 a month. An email would reach everyone faster and spend the money on events instead.' },
  { title: 'Hold the spring picnic at Willow Bend Park', body: 'Willow Bend has shaded tables, a playground and parking. The riverside meadow we used last year floods when it rains.' },
  { title: 'Buy a second set of folding tables for events', body: 'We keep borrowing tables from the scout hut. A second set of six would let the jigsaw and the cake stalls run at the same time.' },
  { title: 'Raise the yearly dues by 5 to cover hall rent', body: 'The hall rent went up in April. An extra 5 a year keeps the account in the black without cutting anything.' },
  { title: 'Start a monthly book swap table', body: 'A table at club nights where people leave a book and take one. Nothing to buy, nothing to track.' },
  { title: 'Repaint the clubhouse sign in the old colours', body: 'The sign has faded to almost nothing. Repainting it in the original green and cream would keep it looking like ours.' },
  { title: 'Invite the choir from Elm Street to the summer fair', body: 'They asked if they could sing a set at the fair. It would fill the quiet hour before the raffle.' },
];
const DEMO_COMMENTS = [
  'Could we try it for a month first?',
  'Thursday works for me.',
  'The quiz league is on the first Thursday of the month, just saying.',
  'Can we cover this out of the normal pot?',
  'I can help set up on the day.',
  'Willow Bend has covered tables if it rains.',
  'Print costs keep going up, this makes sense.',
  'My neighbour swaps books all the time, she would love this.',
  'The old colours are part of the hall, keep them.',
  'They sang at the fete last year, everyone loved it.',
];

app.post('/api/decisions', (req, _res, next) => { if (req.body) delete req.body.options; next(); });
const decisions = require('./kit/server').resource(app, pool, {
  name: 'decisions',
  options: ['For', 'Against', 'Abstain'],
  demo: { titles: DEMO_DECISIONS, comments: DEMO_COMMENTS },
});

// ── Reports ───────────────────────────────────────────────────────────────
// A member flags a decision or a comment; the report goes into a table only
// this app's maintainers see. The table is marked staging:private (see
// "Public and private tables" in the platform conventions): the staging demo
// generator fills nothing into it and a wipe clears it.
async function migrateReports() {
  await pool.query(`CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'comment')),
    target_id INTEGER NOT NULL,
    reporter_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (kind, target_id, reporter_id)
  )`);
  await pool.query("COMMENT ON TABLE reports IS 'staging:private'");
}

app.post('/api/reports', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  try {
    const kind = req.body && req.body.kind;
    const id = Number(req.body && req.body.id);
    if ((kind !== 'decision' && kind !== 'comment') || !Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Pick something to report.' });
    }
    const table = kind === 'decision' ? 'decisions' : 'decisions_comments';
    const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'This was removed, or the link is wrong.' });
    await pool.query(
      'INSERT INTO reports (kind, target_id, reporter_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [kind, id, req.user.id, req.now]);
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
      return res.redirect(302, PLATFORM_ORIGIN + '/app/club-votes/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/club-votes/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  // Boot migrations are idempotent (CREATE TABLE IF NOT EXISTS), so they are
  // safe to run on every start, including the staging wipe.
  await decisions.migrate();
  await migrateReports();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // On SIGTERM/SIGINT: stop taking requests, give open ones ~3 s to finish,
  // then close the pool and exit.
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    console.log('Shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => pool.end().then(() => process.exit(0)), 3000);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

start().catch(err => { console.error(err); process.exit(1); });
