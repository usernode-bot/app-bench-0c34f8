const express = require('express');
const path = require('path');
const crypto = require('crypto');
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
// Per-boot secret for the staging-only check sign-in cookie (see the auth
// middleware below). A boot is one capture run, so this is enough.
const CHECK_COOKIE_SECRET = crypto.randomBytes(32);
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

  // Staging only: the declared local checks sign in as a documented fake
  // account (dapp.json's inLoopCheckAuth) and carry this cookie. HMAC'd with
  // a per-boot secret, so it is a session, not a credential anyone can keep.
  if (!req.user && IS_STAGING) {
    const raw = String(req.headers.cookie || '')
      .split(/;\s*/)
      .find((c) => c.startsWith('cv_check='));
    if (raw) {
      const [body, mac] = raw.slice('cv_check='.length).split('.');
      const want = body && crypto.createHmac('sha256', CHECK_COOKIE_SECRET).update(body).digest('base64url');
      if (body && mac && want && want.length === mac.length &&
          crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) {
        try {
          const who = JSON.parse(Buffer.from(body, 'base64url').toString());
          if (who && /^\d{1,9}$/.test(String(who.id))) {
            req.user = { id: String(who.id), username: String(who.username || 'Someone'), pur: 'iframe' };
          }
        } catch {}
      }
    }
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

// The declared checks' sign-in, staging only (dapp.json's inLoopCheckAuth
// names it): a documented fake account, no password — the cookie it sets
// only exists for this boot and never leaves staging. In production the
// route is unknown and the cookie unread.
if (IS_STAGING) {
  PUBLIC_API_PATHS.add('/api/staging-login');
  app.post('/api/staging-login', (req, res) => {
    const body = req.body || {};
    const id = String(body.id == null ? '' : body.id);
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 40) : 'Someone';
    if (!/^\d{1,9}$/.test(id)) return res.status(400).json({ error: 'id must be numeric' });
    const payload = Buffer.from(JSON.stringify({ id, username: name })).toString('base64url');
    const mac = crypto.createHmac('sha256', CHECK_COOKIE_SECRET).update(payload).digest('base64url');
    res.set('Cache-Control', 'no-store');
    res.cookie('cv_check', `${payload}.${mac}`, { httpOnly: true, sameSite: 'lax', path: '/' });
    res.json({ ok: true, id, username: name });
  });
}

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Reports: what people flag gets hidden ────────────────────────────────
// Anyone with an account can report a question or a comment they did not
// write. A reported post is hidden for the reporter straight away; once
// three DIFFERENT people have reported the same post, it is hidden for
// everyone. The `reports` table is marked 'staging:private' (one row per
// reporter per post) — never show who reported what.
const HIDE_AFTER_REPORTS = 3;
const GONE = 'This was removed, or the link is wrong.';

function migrateReports() {
  return pool.query(`CREATE TABLE IF NOT EXISTS reports (
    kind TEXT NOT NULL CHECK (kind IN ('question','comment')),
    target_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (kind, target_id, user_id)
  )`).then(() => pool.query(`COMMENT ON TABLE reports IS 'staging:private'`));
}

app.post('/api/reports', async (req, res, next) => {
  try {
    const kind = req.body && req.body.kind;
    const id = Number(req.body && req.body.id);
    if ((kind !== 'question' && kind !== 'comment') || !Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Pick something to report.' });
    }
    const table = kind === 'question' ? 'questions' : 'questions_comments';
    const { rows } = await pool.query(`SELECT author_id FROM ${table} WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: GONE });
    if (rows[0].author_id === Number(req.user.id)) {
      return res.status(400).json({ error: "You can't report your own post." });
    }
    await pool.query(
      'INSERT INTO reports (kind, target_id, user_id, created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [kind, id, req.user.id, req.now]);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

// Wraps the two GETs the kit is about to register, so the list and the
// detail answer with the reported posts already gone for THIS viewer. Only
// 2xx bodies are touched; anything else passes as the kit answered it.
async function reportedHidden(viewerId) {
  const { rows } = await pool.query(
    `SELECT kind, target_id FROM reports WHERE kind IN ('question','comment')
       GROUP BY kind, target_id HAVING COUNT(DISTINCT user_id) >= $2
     UNION
     SELECT kind, target_id FROM reports WHERE kind IN ('question','comment') AND user_id = $1`,
    [viewerId == null ? -1 : viewerId, HIDE_AFTER_REPORTS]);
  const questions = new Set(rows.filter((r) => r.kind === 'question').map((r) => r.target_id));
  const commentIds = rows.filter((r) => r.kind === 'comment').map((r) => r.target_id);
  const hiddenComments = new Set();
  const commentCounts = {}; // question id -> how many of its comments are hidden
  if (commentIds.length) {
    const { rows: cs } = await pool.query(
      'SELECT id, item_id FROM questions_comments WHERE id = ANY($1::int[])', [commentIds]);
    for (const c of cs) {
      hiddenComments.add(c.id);
      commentCounts[c.item_id] = (commentCounts[c.item_id] || 0) + 1;
    }
  }
  return { questions, hiddenComments, commentCounts };
}

app.get(['/api/questions', '/api/questions/:id'], (req, res, next) => {
  reportedHidden(req.user ? Number(req.user.id) : null).then((hidden) => {
    const raw = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300 && body && typeof body === 'object') {
        if (Array.isArray(body.items)) {
          body.items = body.items.filter((it) => !hidden.questions.has(it.id));
          for (const it of body.items) {
            const n = hidden.commentCounts[it.id];
            if (n) it.commentCount = Math.max(0, it.commentCount - n);
          }
        } else if (body.item) {
          if (hidden.questions.has(body.item.id)) {
            res.status(404);
            return raw({ error: GONE });
          }
          if (Array.isArray(body.comments)) {
            body.comments = body.comments.filter((c) => !hidden.hiddenComments.has(c.id));
          }
        }
      }
      return raw(body);
    };
    next();
  }, next);
});

// ── Questions, votes, comments ───────────────────────────────────────────
// The kit's `questions` resource owns those tables and their API. Mounted
// after the auth middleware (it assumes req.user) and before the static
// files, so its /api/questions routes are not shadowed. The demo below
// seeds the eight questions the spec lists, in id order 900001…900008
// (the kit adds them newest first), with its vote shapes in the same
// order (few, lead, close, none, spread, tie, lead, close) and a dozen
// club-voice comments. Staging only, on ?demo=1.
const questions = require('./kit/server').resource(app, pool, {
  name: 'questions',
  options: ['Yes', 'No'],
  max: { title: 120, option: 60, options: 6 },
  demo: {
    titles: [
      { title: 'Where should we hold the autumn meetup?',
        body: 'We need a room for about 15 people on a weekday evening. Somewhere with tables, and easy to reach by bus.',
        options: ['Riverside café', 'Library meeting room B', 'Maple Park pavilion'] },
      { title: 'Which evening works for regular meetings?',
        body: 'We would pick one evening a month and stick to it, so people can plan around it.',
        options: ['Thursday', 'Tuesday', 'Saturday morning'] },
      { title: 'Keep the snack rota at meetings?',
        body: 'Someone brings snacks each time and everyone chips in for the cost. It has worked, but it is one more thing to remember.',
        options: ['Keep it', 'Drop it'] },
      { title: 'Name for the club newsletter',
        body: 'It would go out once a month with what we decided and what is coming up.',
        options: ['The Minutes', 'Club Notes', 'The Noticeboard'] },
      { title: 'Where should the spring day trip go?',
        body: 'One day out, easy to reach by train, and somewhere people who do not walk far can still enjoy.',
        options: ['Coastal walk', 'Botanical garden', 'Science museum'] },
      { title: 'Pick the next group activity',
        body: 'Something we can all do together on a regular meeting night.',
        options: ['Board game night', 'Canal clean-up', 'Pottery workshop'] },
      { title: 'Bring a guest to the December social?',
        body: 'Members could invite one person each. It would make the room fuller, but it changes the feel of it.',
        options: ['Yes', 'No'] },
      { title: 'Start a book swap shelf at meetings?',
        body: 'A shelf at the back where people leave a book and take one. Someone would need to keep an eye on it.',
        options: ['Yes', 'No'] },
    ],
    comments: [
      'The café has a back room we can book for free if we buy drinks.',
      'Library is quieter, but it closes at 8.',
      'Pavilion has no heating in November, so I would skip it.',
      'Thursdays work best for me, I finish work at 6.',
      'Saturday morning is hard if you have kids.',
      'Can we rotate who brings snacks so it is not always the same two?',
      'The Noticeboard sounds like us.',
      'Club Notes is shorter and easier to say out loud.',
      'The botanical garden has a café right inside, good fallback if it rains.',
      'Board games would get my partner to come along.',
      'Guests welcome, as long as they know it is a club night.',
      'I have a few books to swap already, count me in.',
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
  await questions.migrate();
  await migrateReports();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // The platform stops this container with SIGTERM when it redeploys or
  // scales down. Stop taking new requests, give what is running about
  // three seconds to finish, close the database pool, then exit.
  let closing = false;
  function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`${signal}: finishing what is running, then closing`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => pool.end().then(() => process.exit(0)), 3_000);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
