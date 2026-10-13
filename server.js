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

// ── Club Votes API ─────────────────────────────────────────────────────────
// The questions themselves (with votes and comments) are the kit's resource,
// mounted further down. The routes here sit BESIDE it, before it, so they
// run first: hiding and reporting, closing voting, and the staging demo's
// extras. Made-up staging-demo rows (public/kit/demo.js) start at id 900001.

const GONE = 'This question was removed, or the link is wrong.';
const CLOSED = 'Voting on this question has closed.';
const HIDE_AT = 3; // distinct reporters needed before content hides for everyone
const viewerId = (req) => (req.user ? Number(req.user.id) : null);

// The staging demo, passed to the kit's resource below. Each entry's options
// win over the kit's Yes/No default. Newest first: the last two are the
// oldest questions, which the demo closes (see finalizeDemo).
const DEMO = {
  bodies: [
    'Shout in the comments if your favourite is missing.',
    'We need to settle this soon so the booking can go in.',
    'One vote each while it is open — change it any time.',
    'Raise it at the next meeting if nothing gets picked.',
  ],
  comments: [
    'Happy to help set up.',
    'Can we decide before Friday?',
    'Either works for me.',
    'I can bring the folding chairs.',
    'Last time ran late, so earlier would be better.',
    'Count me in.',
    'Does the hall have parking?',
    'The library room is free on Thursdays.',
    'Good idea, it has come up a few times now.',
    'Ask at the desk — they were helpful last time.',
    'I will ask around and report back.',
    'Fine by me as long as we keep it short.',
  ],
  titles: [
    { title: 'Where should the spring picnic be?', options: ['Riverside park', 'Library lawn', 'Community garden'] },
    { title: 'Move meetings to Thursday evenings?' },
    { title: 'Next book for the reading night', options: ['The Lighthouse Diaries', 'The Orchard Letters', 'Northwind', 'The Long Field'] },
    { title: 'Should we start a monthly litter pick?' },
    { title: 'Date for the Christmas party', options: ['Early December', 'Mid December', 'January'] },
    { title: 'Slogan for the club banner', options: ['Stitch it together', 'All threads welcome'] },
    { title: 'Trip to the coastal nature reserve', options: ['Saturday morning', 'Sunday morning', 'A weekday evening'] },
    { title: 'Bake sale or quiz night for the fundraiser?', options: ['Bake sale', 'Quiz night'] },
    { title: 'Where to meet through the winter', options: ['The scout hut', 'The library room', 'The café back room'] },
    { title: 'Day for the summer quiz night', options: ['Friday', 'Saturday'] },
    { title: 'Name for the club newsletter', options: ['The Weekly Bulletin', 'Club Notes', 'The Noticeboard'] },
  ],
};

// Wraps res.json on the questions API so every answer leaves through one
// place: hidden or reported-by-the-viewer content never shows, closed
// questions carry closedAt, and comment counts stay honest.
app.use('/api/questions', (req, res, next) => {
  const json = res.json.bind(res);
  res.json = async (data) => {
    try {
      if (data && data.demo) await finalizeDemo();
      if (data && Array.isArray(data.items)) return json(await enrichList(data, req));
      if (data && data.item && Array.isArray(data.comments)) return json(await enrichOne(data, req, res));
      return json(data);
    } catch (err) {
      console.error('enrich failed:', err);
      return json(data);
    }
  };
  next();
});

async function questionInfo(ids) {
  const { rows } = await pool.query(
    'SELECT id, closed_at, hidden_at FROM questions WHERE id = ANY($1)', [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

// What THIS viewer has reported: that content hides for them straight away.
async function reportedBy(kind, ids, req) {
  const uid = viewerId(req);
  if (!uid || !ids.length) return new Set();
  const { rows } = await pool.query(
    'SELECT target_id FROM question_reports WHERE kind = $1 AND user_id = $2 AND target_id = ANY($3)',
    [kind, uid, ids]);
  return new Set(rows.map((r) => r.target_id));
}

async function enrichList(data, req) {
  const ids = data.items.map((i) => i.id);
  if (!ids.length) return data;
  const info = await questionInfo(ids);
  const reported = await reportedBy('question', ids, req);
  // Comments hidden from everyone, or reported by this viewer, come off the count too.
  const uid = viewerId(req);
  const { rows } = await pool.query(
    `SELECT c.item_id, COUNT(*)::int AS n FROM questions_comments c
     WHERE c.item_id = ANY($1) AND (c.hidden_at IS NOT NULL OR EXISTS (
       SELECT 1 FROM question_reports r WHERE r.kind = 'comment' AND r.target_id = c.id AND r.user_id = $2))
     GROUP BY c.item_id`, [ids, uid]);
  const gone = new Map(rows.map((r) => [r.item_id, r.n]));
  data.items = data.items.filter((item) => {
    const q = info.get(item.id);
    if (!q || q.hidden_at || reported.has(item.id)) return false;
    item.closedAt = q.closed_at ? q.closed_at.toISOString() : null;
    item.commentCount = Math.max(0, item.commentCount - (gone.get(item.id) || 0));
    return true;
  });
  if (data.demo) await refreshDemoCounts(data.items);
  return data;
}

async function enrichOne(data, req, res) {
  const info = await questionInfo([data.item.id]);
  const q = info.get(data.item.id);
  const reported = await reportedBy('question', [data.item.id], req);
  if (!q || q.hidden_at || reported.has(data.item.id)) {
    res.status(404);
    return { error: GONE };
  }
  data.item.closedAt = q.closed_at ? q.closed_at.toISOString() : null;
  const ids = data.comments.map((c) => c.id);
  const hiddenSet = new Set((await pool.query(
    'SELECT id FROM questions_comments WHERE id = ANY($1) AND hidden_at IS NOT NULL', [ids])).rows.map((r) => r.id));
  const reportedSet = await reportedBy('comment', ids, req);
  data.comments = data.comments.filter((c) => !hiddenSet.has(c.id) && !reportedSet.has(c.id));
  data.item.commentCount = data.comments.length;
  return data;
}

// Staging demo only, once the kit has written its rows: the two oldest demo
// questions are already decided. Closing them here means the first demo load
// already shows them under "Decided": enrichList re-reads closed_at and
// refreshDemoCounts re-reads the tallies.
async function finalizeDemo() {
  // Once per database: claiming the marker row settles concurrent demo
  // requests, so the two decided questions stay exactly two.
  const claimed = await pool.query(
    `INSERT INTO club_demo_state (key) VALUES ('decided') ON CONFLICT DO NOTHING RETURNING key`);
  if (!claimed.rows.length) return;
  const { rows } = await pool.query(
    `SELECT id FROM questions WHERE id BETWEEN 900001 AND 900099 AND closed_at IS NULL
     ORDER BY created_at ASC, id ASC LIMIT 2`);
  for (const q of rows) {
    await pool.query(
      `UPDATE questions SET closed_at = created_at + interval '2 days' WHERE id = $1 AND closed_at IS NULL`, [q.id]);
    // A decisive result: seven votes for the first option, two for the second,
    // from made-up staging ids no real account holds. Idempotent via the PK.
    const users = [];
    const choices = [];
    for (let k = 0; k < 7; k += 1) { users.push(-(q.id * 20 + k)); choices.push(0); }
    for (let k = 0; k < 2; k += 1) { users.push(-(q.id * 20 + 10 + k)); choices.push(1); }
    await pool.query(
      `INSERT INTO questions_votes (item_id, user_id, choice, created_at)
       SELECT $1, u, c, (SELECT created_at + interval '1 hour' FROM questions WHERE id = $1)
       FROM unnest($2::int[], $3::int[]) AS t(u, c)
       ON CONFLICT DO NOTHING`, [q.id, users, choices]);
  }
}

// A demo response's tallies were counted before finalizeDemo's votes went in,
// so on staging demo reads, re-read the counts from the table.
async function refreshDemoCounts(items) {
  const ids = items.map((i) => i.id);
  if (!ids.length) return;
  const { rows } = await pool.query(
    'SELECT item_id, choice, COUNT(*)::int AS n FROM questions_votes WHERE item_id = ANY($1) GROUP BY item_id, choice', [ids]);
  const counts = new Map();
  for (const r of rows) {
    let m = counts.get(r.item_id);
    if (!m) counts.set(r.item_id, (m = new Map()));
    m.set(r.choice, r.n);
  }
  for (const item of items) {
    const m = counts.get(item.id);
    if (m) for (const o of item.votes.options) o.count = m.get(o.id) || 0;
  }
}

// Staging demo, signed-in viewers, once each: their own question to look
// after, three days old, with three votes already on it.
app.get(['/api/questions', '/api/questions/:id'], async (req, res, next) => {
  try {
    if (IS_STAGING && req.query.demo === '1' && req.user) {
      const first = await pool.query(
        'INSERT INTO club_demo_viewers (user_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING user_id',
        [viewerId(req)]);
      if (first.rows.length) {
        const at = new Date(req.now.getTime() - 3 * 24 * 60 * 60 * 1000);
        const { rows } = await pool.query(
          `INSERT INTO questions (title, body, options, author_id, author_name, created_at)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id`,
          ['Colour for the new club t-shirts',
            'Pick the colour for the sample batch. One vote each, and you can change it until voting closes.',
            JSON.stringify(['Forest green', 'Navy', 'Sunny yellow']),
            viewerId(req), String(req.user.username || 'You'), at]);
        await pool.query(
          `INSERT INTO questions_votes (item_id, user_id, choice, created_at)
           SELECT $1, u, c, $2 FROM unnest($3::int[], $4::int[]) AS t(u, c)
           ON CONFLICT DO NOTHING`, [rows[0].id, at, [-3, -7, -9], [0, 0, 1]]);
      }
    }
    next();
  } catch (err) { next(err); }
});

// No vote on a removed question, and none after voting closed.
app.post('/api/questions/:id/vote', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = Number.isInteger(id) && id > 0
      ? await pool.query('SELECT closed_at, hidden_at FROM questions WHERE id = $1', [id])
      : { rows: [] };
    if (!rows.length || rows[0].hidden_at) return res.status(404).json({ error: GONE });
    if (rows[0].closed_at) return res.status(409).json({ error: CLOSED });
    return next();
  } catch (err) { next(err); }
});

// No comment on a removed question either.
app.post('/api/questions/:id/comments', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows } = Number.isInteger(id) && id > 0
      ? await pool.query('SELECT hidden_at FROM questions WHERE id = $1', [id])
      : { rows: [] };
    if (!rows.length || rows[0].hidden_at) return res.status(404).json({ error: GONE });
    return next();
  } catch (err) { next(err); }
});

// The person who asked can close voting; everyone then sees the result.
app.post('/api/questions/:id/close', async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = Number.isInteger(id) && id > 0
    ? await pool.query('SELECT id, author_id, closed_at, hidden_at FROM questions WHERE id = $1', [id])
    : { rows: [] };
  const q = rows[0];
  if (!q || q.hidden_at) return res.status(404).json({ error: GONE });
  if (q.author_id !== viewerId(req)) {
    return res.status(403).json({ error: 'Only the person who asked can close voting.' });
  }
  if (!q.closed_at) await pool.query('UPDATE questions SET closed_at = $1 WHERE id = $2', [req.now, id]);
  return res.json({ ok: true });
});

// Report a question or a comment. It disappears for the reporter at once,
// and for everyone once HIDE_AT distinct people have reported it.
app.post('/api/reports', async (req, res) => {
  const body = req.body || {};
  const kind = body.kind;
  const targetId = Number(body.targetId != null ? body.targetId : body.target_id);
  if (!['question', 'comment'].includes(kind) || !Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Say what you are reporting.' });
  }
  const table = kind === 'question' ? 'questions' : 'questions_comments';
  const { rows } = await pool.query(
    `SELECT id, author_id, hidden_at FROM ${table} WHERE id = $1`, [targetId]);
  const target = rows[0];
  if (!target || target.hidden_at) return res.status(404).json({ error: GONE });
  if (target.author_id === viewerId(req)) {
    return res.status(400).json({ error: 'You cannot report your own post.' });
  }
  await pool.query(
    'INSERT INTO question_reports (kind, target_id, user_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
    [kind, targetId, viewerId(req), req.now]);
  const { rows: counted } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM question_reports WHERE kind = $1 AND target_id = $2', [kind, targetId]);
  if (counted[0].n >= HIDE_AT) {
    await pool.query(`UPDATE ${table} SET hidden_at = $1 WHERE id = $2 AND hidden_at IS NULL`, [req.now, targetId]);
  }
  return res.status(201).json({ ok: true });
});

// The kit's resource: the questions, their votes and their comments, with
// routes /api/questions and the staging demo rows. Mounted AFTER the routes
// above, so the guards and the demo extras run first.
const questions = require('./kit/server').resource(app, pool, {
  name: 'questions',
  options: ['Yes', 'No'],
  demo: DEMO,
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

// Forward-only, idempotent schema: the kit's tables first, then this app's
// columns and tables.
async function migrate() {
  await questions.migrate();
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE questions ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE questions_comments ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ');
  await pool.query(`CREATE TABLE IF NOT EXISTS question_reports (
    kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (kind, target_id, user_id))`);
  await pool.query("COMMENT ON TABLE question_reports IS 'staging:private'");
  await pool.query('CREATE TABLE IF NOT EXISTS club_demo_viewers (user_id INTEGER PRIMARY KEY)');
  // Marks the staging demo's two decided questions as closed, once per
  // database (finalizeDemo).
  await pool.query('CREATE TABLE IF NOT EXISTS club_demo_state (key TEXT PRIMARY KEY)');
}

async function start() {
  await migrate();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const timer = setTimeout(() => process.exit(0), 3000);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });