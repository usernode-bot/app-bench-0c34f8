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

// ── Club Votes data ────────────────────────────────────────────────────────
// The questions themselves (rows, votes, comments) come from the platform
// kit: kit/server.js creates the questions, questions_votes and
// questions_comments tables and the routes under /api/questions. Public
// tables, public usernames.
//
// Registered BEFORE that mount, so it runs ahead of the kit's vote route:
// every account vote leaves the person's username beside their id in
// voter_names, which is what the voters route joins on to show names. The
// votes table stores only the id — there is no users table to join.
app.post('/api/questions/:id/vote', (req, res, next) => {
  if (!req.user) return next();
  pool.query(
    `INSERT INTO voter_names (user_id, username, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username, updated_at = EXCLUDED.updated_at`,
    [req.user.id, String(req.user.username || 'Someone'), req.now],
  ).then(() => next(), (err) => { console.error('voter_names upsert failed:', err.message); next(); });
});

const questions = require('./kit/server').resource(app, pool, {
  name: 'questions',
  // The form asks for up to 140 characters of title; the kit's own default
  // is 120, so let the kit keep what the form promised.
  max: { title: 140 },
  // A question posted with no choices becomes a plain Yes or No vote.
  options: ['Yes', 'No'],
  demo: {
    titles: [
      { title: 'Where should we meet in November?', options: ['Library back room', 'Cafe on Elm Street', 'Online call'],
        body: 'The community hall is booked for repairs all month. Which of these works for most of us?' },
      { title: 'Pick our spring outing', options: ['Botanic garden walk', 'Kite day', 'Coastal train trip'],
        body: 'The spring fund covers one big day out. Vote for the one you would actually come to.' },
      { title: 'Should we move meetings to Thursday evenings?',
        body: 'Some of us cannot make Tuesdays any more. Would Thursdays suit you better?' },
      { title: 'What snack should we bring to the open day?', options: ['Lemon drizzle cake', 'Oat cookies', 'Fruit platter', 'Sausage rolls'],
        body: 'The open day table needs something homemade. Pick what you would like to see on it.' },
      { title: 'Which colour for the club T-shirt?', options: ['Deep indigo', 'Forest green', 'Marigold yellow'],
        body: 'The printer needs a decision by the end of the month. One colour per shirt.' },
      { title: 'Should we enter the city fair again this year?',
        body: 'Last year we won second place for the plot display. The entry fee comes out of the same fund as the picnic.' },
      { title: 'What time should weekday meetings start?', options: ['6 pm', '7 pm', '8 pm'],
        body: 'The room is ours from 5 pm, and the caretaker locks up at 9.' },
      { title: 'Where should we keep the shared equipment?', options: ['The scout hut', "A member's garage", 'The school store'],
        body: 'The old shed is coming down. We need somewhere dry that two people can get into on a Sunday.' },
      { title: 'Should we run a beginner workshop in spring?',
        body: 'The waiting list has fifteen names on it. It would be two evenings, run by whoever volunteers.' },
      { title: 'Pick a date for the annual picnic', options: ['First Saturday of June', 'Second Saturday of June', 'Last Sunday of May'],
        body: 'Same field as always. The earlier we pick, the better the chance of the sunny slot.' },
      { title: 'What should we spend the raffle money on?', options: ['A new notice board', 'Seeds for the plot', 'A summer outing'],
        body: 'Forty-one pounds in the tin. It should be one thing we can all see or share.' },
      { title: 'Should the newsletter go out weekly or monthly?', options: ['Weekly', 'Monthly'],
        body: 'Whoever writes it has asked for a rhythm, not a third option.' },
      { title: 'What film should the winter social show?', options: ['The Great Race', 'Sing Along Tonight', 'Storm on the Marsh'],
        body: 'Projector is booked, the hall is free, and we vote on the film itself.' },
    ],
    bodies: ['Bring your thoughts; the club decides together.', 'We vote at the next meeting, but say what you think now.'],
    comments: [
      'Works for me, the earlier the better.',
      'Can we check the cost before we decide?',
      'I can help set up either way.',
      'Happy to go with whatever most people want.',
      'Could we do both, just on different days?',
    ],
  },
});

// Who voted for what: votes joined to voter_names, so every choice can show
// its names. The kit's demo rows are voted by made-up people with negative
// ids, whose names live in public/kit/demo.js.
let demoPeople = null;
async function demoPeopleNames() {
  if (!demoPeople) {
    const mod = await import(pathToFileURL(path.join(__dirname, 'public', 'kit', 'demo.js')).href);
    demoPeople = mod.DEMO_PEOPLE;
  }
  return demoPeople;
}

app.get('/api/questions/:id/voters', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ error: 'This was removed, or the link is wrong.' });
  }
  try {
    const found = await pool.query('SELECT 1 FROM questions WHERE id = $1', [id]);
    if (!found.rows.length) return res.status(404).json({ error: 'This was removed, or the link is wrong.' });
    const { rows } = await pool.query(
      'SELECT user_id, choice FROM questions_votes WHERE item_id = $1 ORDER BY created_at, user_id', [id],
    );
    const real = [...new Set(rows.map((r) => Number(r.user_id)).filter((n) => n > 0))];
    const names = new Map();
    if (real.length) {
      const { rows: un } = await pool.query(
        'SELECT user_id, username FROM voter_names WHERE user_id = ANY($1::int[])', [real],
      );
      for (const u of un) names.set(Number(u.user_id), u.username);
    }
    const byDemoId = new Map((await demoPeopleNames()).map((p) => [p.id, p.name]));
    const viewer = req.user ? Number(req.user.id) : null;
    const voters = rows.map((r) => ({
      optionId: r.choice,
      name: Number(r.user_id) > 0
        ? (names.get(Number(r.user_id)) || 'Someone')
        : (byDemoId.get(Number(r.user_id)) || 'Someone'),
      isMe: viewer !== null && Number(r.user_id) === viewer,
    }));
    return res.json({ voters });
  } catch (err) {
    console.error('voters route failed:', err.message);
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
  }
});

// Reports: a question or comment flagged for the app's keepers. Recorded
// only — nothing is hidden or removed by one. The table is private: who
// reported what is nobody else's business, and there are no routes to read
// it back yet.
app.post('/api/reports', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const kind = req.body && req.body.kind;
  const targetId = Number(req.body && req.body.targetId);
  if (!['question', 'comment'].includes(kind) || !Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Pick what you are reporting.' });
  }
  try {
    const table = kind === 'question' ? 'questions' : 'questions_comments';
    const found = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [targetId]);
    if (!found.rows.length) return res.status(404).json({ error: 'This was removed, or the link is wrong.' });
    const reason = typeof (req.body && req.body.reason) === 'string'
      ? req.body.reason.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    await pool.query(
      `INSERT INTO reports (kind, target_id, reporter_id, reporter_name, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [kind, targetId, req.user.id, String(req.user.username || 'Someone'), reason, req.now],
    );
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('reports route failed:', err.message);
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
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

async function migrate() {
  await questions.migrate();
  // Who to show beside each vote (see the voters route above).
  await pool.query(`CREATE TABLE IF NOT EXISTS voter_names (
    user_id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('question', 'comment')),
    target_id INTEGER NOT NULL,
    reporter_id INTEGER NOT NULL,
    reporter_name TEXT NOT NULL,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL
  )`);
  // Only the keepers may see who reported what.
  await pool.query(`COMMENT ON TABLE reports IS 'staging:private'`);
}

// A stop from the platform stops taking new connections, lets the running
// ones finish (about 3 s), closes the database pool, then exits.
let server = null;
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  console.log('Shutting down: finishing what is in flight');
  if (server) server.close(() => console.log('Connections drained'));
  setTimeout(() => {
    pool.end().then(() => process.exit(0), () => process.exit(0));
  }, 3000);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

async function start() {
  await migrate();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
