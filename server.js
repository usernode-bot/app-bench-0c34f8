const express = require('express');
const path = require('path');
const { pathToFileURL } = require('url');
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

// ── This app's own data ───────────────────────────────────────────────────
//
// The kit resource owns questions / questions_votes / questions_comments.
// Two app tables sit beside it:
//
// voter_names — the username each voter had when they last voted here, so
// the detail screen can show the names under each tally (a show of hands).
// Public on purpose: usernames are public on the platform, and votes are
// shown by name. Nothing else about a user is stored.
//
// reports — private (see the COMMENT below): what members flagged. The
// public tables carry no trace of a report, so nothing on screen reveals
// one; there is deliberately no foreign key from a public table to it.

async function migrateApp() {
  await pool.query(`CREATE TABLE IF NOT EXISTS voter_names (
    user_id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('question', 'comment')),
    target_id INTEGER NOT NULL,
    reporter_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (kind, target_id, reporter_id))`);
  await pool.query(`COMMENT ON TABLE reports IS 'staging:private'`);
}

// Before the kit's vote route: remember the voter's current username, so
// /voters can show names for votes cast now and before. A failure here must
// never block the vote itself.
app.post('/api/questions/:id/vote', (req, res, next) => {
  if (!req.user) return next();
  pool.query(
    `INSERT INTO voter_names (user_id, username, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, updated_at = EXCLUDED.updated_at`,
    [req.user.id, String(req.user.username || 'Someone'), req.now],
  )
    .catch((err) => console.warn('voter_names upsert failed: ' + err.message))
    .then(() => next());
});

// The questions resource: list, post, vote, comment. Agree/Disagree is the
// default shape when a question is posted with no answers of its own.
const questions = require('./kit/server').resource(app, pool, {
  name: 'questions',
  options: ['Agree', 'Disagree'],
  demo: {
    titles: [
      { title: 'Where should we meet in November?', body: 'The café is closing for renovation. Pick the place that works for most of us and we will book it this week.', options: ['Library room', 'Community hall', "Someone's garden"] },
      'Should we start a monthly book swap?',
      { title: 'What should the spring outing be?', body: 'One day out, travel by train, back before dark.', options: ['Botanic garden', 'Coastal walk', 'Museum day', 'Picnic in the park'] },
      'Move meetings to Thursday evenings?',
      { title: 'Which day suits for the December quiz night?', options: ['Friday 5th', 'Saturday 6th', 'Friday 12th'] },
      'Should the club buy its own projector?',
      { title: 'What should we call the club newsletter?', options: ['The Notice Board', 'Club Notes', 'The Monthly Minute'] },
      'Do we need a snacks rota for meetings?',
      { title: 'Which good cause should the winter raffle support?', options: ['Food bank', 'Animal shelter', 'Youth club'] },
      'Should we try an online meeting once a month?',
      { title: 'New club badge: which sketch do you like?', body: 'Three sketches from the design evening. The badge goes on the noticeboard and the newsletter.', options: ['Roundel with a ballot box', 'Plain wordmark', 'Leaf and quill'] },
      'Keep the current meeting time of 7 pm?',
      { title: 'Where should the summer barbecue be?', options: ['The quay', 'Riverside meadow', 'The hall garden'] },
      'Should we add a small annual membership fee?',
    ],
    bodies: [
      'Thoughts welcome before the next meeting.',
      'Say why if you can, it helps the rest of us.',
      'We will go with whatever most people pick.',
    ],
    comments: [
      'Happy with whatever most people pick.',
      'Can we make sure the room has step-free access?',
      'I can help set up if we need a hand.',
      'Works for me, though the later slot is easier by bus.',
      'Last time the room was a bit cold, worth asking about.',
    ],
  },
});

// Who voted, by name: { voters: { [optionId]: [name, …] } }, the viewer
// first as "You". Demo voters (negative ids) come from the kit's demo
// people; anyone whose username was not captured shows as "A member".
app.get('/api/questions/:id/voters', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad question id.' });
    const { rows } = await pool.query(
      'SELECT user_id, choice FROM questions_votes WHERE item_id = $1 ORDER BY created_at, user_id',
      [id],
    );
    const ids = [...new Set(rows.map((r) => r.user_id))];
    const known = new Map();
    const real = ids.filter((x) => x >= 0);
    if (real.length) {
      const { rows: people } = await pool.query(
        'SELECT user_id, username FROM voter_names WHERE user_id = ANY($1::int[])',
        [real],
      );
      for (const p of people) known.set(p.user_id, p.username);
    }
    if (ids.some((x) => x < 0)) {
      const { DEMO_PEOPLE } = await import(pathToFileURL(path.join(__dirname, 'public', 'kit', 'demo.js')).href);
      for (const p of DEMO_PEOPLE) known.set(p.id, p.name);
    }
    const viewer = req.user ? Number(req.user.id) : null;
    const voters = {};
    for (const r of rows) {
      const key = String(r.choice);
      voters[key] = voters[key] || [];
      if (r.user_id === viewer) voters[key].unshift('You');
      else voters[key].push(known.get(r.user_id) || 'A member');
    }
    return res.json({ voters });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side.' });
  }
});

// Report a question or a comment. One row per (kind, target, reporter); a
// repeat report changes nothing and still answers 201, so the screen can
// always thank the member.
app.post('/api/reports', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  try {
    const kind = (req.body || {}).kind;
    const id = Number((req.body || {}).id);
    if (!['question', 'comment'].includes(kind) || !Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Say what is being reported.' });
    }
    const table = kind === 'question' ? 'questions' : 'questions_comments';
    const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'That was removed, or the link is wrong.' });
    await pool.query(
      `INSERT INTO reports (kind, target_id, reporter_id, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (kind, target_id, reporter_id) DO NOTHING`,
      [kind, id, req.user.id, req.now],
    );
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side.' });
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

let server;

async function start() {
  await migrateApp();
  await questions.migrate();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

// Shut down cleanly when the platform stops the container: stop accepting
// new connections, give requests already in flight about three seconds,
// then close the database pool and exit.
let stopping = false;
function stop(signal) {
  if (stopping || !server) return;
  stopping = true;
  console.log(`${signal}: finishing open requests`);
  server.close(() => console.log('Stopped accepting connections'));
  setTimeout(async () => {
    try { await pool.end(); } catch (_) {}
    process.exit(0);
  }, 3000).unref();
}
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
