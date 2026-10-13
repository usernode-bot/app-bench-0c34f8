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

// ── Reports ────────────────────────────────────────────────────────────────
// A question, or another person's comment, can be reported. One report hides
// it for the reporter; three distinct reporters hide it for everyone. Rows
// live in a private table with no foreign key from the public ones, and the
// middleware below keeps hidden items out of the kit's answers.
app.post('/api/reports', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const kind = req.body && req.body.kind;
  const id = Number(req.body && req.body.id);
  if ((kind !== 'question' && kind !== 'comment') || !Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'That report does not name a question or a comment.' });
  }
  try {
    const owner = kind === 'question'
      ? await pool.query('SELECT author_id AS owner_id, id AS question_id FROM questions WHERE id = $1', [id])
      : await pool.query('SELECT author_id AS owner_id, item_id AS question_id FROM questions_comments WHERE id = $1', [id]);
    if (!owner.rows.length) return res.status(404).json({ error: 'That is no longer here.' });
    if (owner.rows[0].owner_id === req.user.id) {
      return res.status(400).json({ error: 'You cannot report your own post.' });
    }
    await pool.query(
      `INSERT INTO reports (kind, target_id, question_id, reporter_id, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [kind, id, owner.rows[0].question_id, req.user.id, req.now]);
    return res.json({ ok: true });
  } catch (err) {
    console.warn('report failed: ' + err.message);
    return res.status(500).json({ error: 'That report did not save. Try again.' });
  }
});

// What this viewer must not see: targets they reported themselves, and
// targets at least three distinct people have reported.
async function hiddenFor(req) {
  const viewer = req.user ? req.user.id : -1;
  const { rows } = await pool.query(
    `SELECT kind, target_id, question_id FROM reports
     WHERE reporter_id = $1
        OR (kind, target_id) IN (
          SELECT kind, target_id FROM reports
          GROUP BY kind, target_id HAVING COUNT(DISTINCT reporter_id) >= 3)`,
    [viewer]);
  const questions = new Set();
  const comments = new Map(); // comment id -> its question's id
  const byQuestion = new Map(); // question id -> how many of its comments are hidden
  for (const r of rows) {
    if (r.kind === 'question') questions.add(r.target_id);
    else if (!comments.has(r.target_id)) {
      comments.set(r.target_id, r.question_id);
      byQuestion.set(r.question_id, (byQuestion.get(r.question_id) || 0) + 1);
    }
  }
  return { questions, comments, byQuestion };
}

// Registered BEFORE the kit's routes so it wraps res.json first. Guests get
// the three-report hiding (their own reporter set is empty).
app.use(/^\/api\/questions(?:\/\d+)?$/, async (req, res, next) => {
  if (req.method !== 'GET') return next();
  let hidden;
  try {
    hidden = await hiddenFor(req);
  } catch (err) {
    console.warn('report filter failed: ' + err.message);
    return next();
  }
  const m = req.path.match(/^\/api\/questions\/(\d+)$/);
  if (m && hidden.questions.has(Number(m[1]))) {
    return res.status(404).json({ error: 'That question is no longer here.' });
  }
  const json = res.json.bind(res);
  res.json = (data) => {
    try {
      if (data && Array.isArray(data.items)) {
        data.items = data.items.filter((q) => !hidden.questions.has(q.id));
        for (const q of data.items) {
          const n = hidden.byQuestion.get(q.id) || 0;
          if (n) q.commentCount = Math.max(0, q.commentCount - n);
        }
      } else if (data && data.item && hidden.comments.size) {
        const n = hidden.byQuestion.get(data.item.id) || 0;
        if (n) data.item.commentCount = Math.max(0, data.item.commentCount - n);
        data.comments = (data.comments || []).filter((c) => !hidden.comments.has(c.id));
      }
    } catch (err) {
      console.warn('report filter failed: ' + err.message);
    }
    return json(data);
  };
  return next();
});

// The questions resource — its tables, routes and demo rows — from the kit.
const questions = require('./kit/server').resource(app, pool, {
  name: 'questions',
  options: ['Yes', 'No'],
  demo: {
    titles: [
      { title: 'Should we move the spring meetup to the community hall?', body: 'The café room is getting tight, and the hall has space for everyone plus decent parking.' },
      { title: 'Should we switch our meetings to Thursday evenings?', body: 'Tuesdays keep clashing with the school run for a few of us. Thursday at 7 would free that up, but the hall costs a little more that night.' },
      { title: 'Should the club start a shared reading list?', body: 'A page where anyone can add a book worth reading, and we pick one each season.' },
      'Should we raise yearly dues to cover the hall booking?',
      { title: 'Should we keep a shared club calendar?', body: 'One place for meetups, quizzes and fairs, so we stop double booking.' },
      { title: 'Should we plan a picnic at Riverside Park in June?', body: 'Covered tables if it rains, and the minigolf next door took the last one well.' },
      'Should we buy a projector for film nights?',
      { title: 'Should we start a car-share list for out-of-town members?', body: 'A simple sheet of who is driving when, so nobody travels alone.' },
      'Should the club enter the regional quiz?',
      { title: 'Should we try a morning walking group before meetings?', body: 'Half an hour around the park, then the meeting as usual.' },
      'Should we switch the newsletter to a monthly email?',
      { title: 'Should we host a swap stall at the autumn fair?', body: 'Books, plants and tools — anything a member no longer needs.' },
      'Should we invite a guest speaker each season?',
      'Should we keep meetings to one hour?',
    ],
    comments: [
      'Thursday works much better for me, I can actually make it on time.',
      'The hall has good parking, which helps more people get there.',
      'Happy to chip in for the extra cost, it is still less than renting a room.',
      'I can add the first few books this week if we go ahead.',
      'Dues have not moved in five years, so this seems fair.',
      'A shared calendar would stop the double bookings for good.',
      'June weekends fill up fast, so an early date is a good idea.',
      'I would come to a walking group, mornings suit me.',
      'I have choir on Thursdays, so I would miss every meeting. Could we try alternate weeks?',
      'Monthly is plenty for news like ours, and easier to write.',
      'I have a projector we can try before we buy one.',
      'One hour keeps people coming back, short and friendly.',
    ],
  },
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

async function start() {
  // Tables first: the kit's questions, votes and comments, then reports.
  await questions.migrate();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id serial PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('question', 'comment')),
      target_id integer NOT NULL,
      question_id integer NOT NULL,
      reporter_id integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      UNIQUE (kind, target_id, reporter_id)
    )`);
  await pool.query(`COMMENT ON TABLE reports IS 'staging:private'`);
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // On a stop signal: stop accepting, let what is in flight finish (3s),
  // then close the pool and exit.
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => { pool.end().then(() => process.exit(0)); });
    setTimeout(() => { pool.end().finally(() => process.exit(0)); }, 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
