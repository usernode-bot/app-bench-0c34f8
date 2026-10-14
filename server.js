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
      if (claims && claims.pur === 'iframe') {
        // The token's id is a number, but the id columns are text and Postgres
        // hands selected values back as strings. Keep one string form so JS
        // comparisons between req.user.id and a selected author_id match.
        req.user = Object.assign({}, claims, { id: String(claims.id) });
      }
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

// ── Schema ─────────────────────────────────────────────────────────────────
// Applied idempotently on boot. Reports is staging:private: it is recorded
// for the club to look at, carries no content, and staging copies its schema
// without its rows. Public tables must never carry a foreign key to it.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decisions (
      id serial PRIMARY KEY,
      author_id text NOT NULL,
      author_name text NOT NULL,
      question text NOT NULL,
      details text,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      result text CHECK (result IN ('passed','not_passed','tied')),
      yes_count int NOT NULL DEFAULT 0,
      no_count int NOT NULL DEFAULT 0,
      abstain_count int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL,
      closed_at timestamptz,
      demo_for text
    );
    CREATE TABLE IF NOT EXISTS votes (
      decision_id int NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      voter_id text NOT NULL,
      voter_name text NOT NULL,
      choice text NOT NULL CHECK (choice IN ('yes','no','abstain')),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (decision_id, voter_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id serial PRIMARY KEY,
      decision_id int NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      author_id text NOT NULL,
      author_name text NOT NULL,
      body text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id serial PRIMARY KEY,
      target_kind text NOT NULL CHECK (target_kind IN ('decision','comment')),
      target_id int NOT NULL,
      reporter_id text NOT NULL,
      created_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS reports_target_reporter
      ON reports (target_kind, target_id, reporter_id);
    COMMENT ON TABLE reports IS 'staging:private';
  `);
}

// ── Demo filter ────────────────────────────────────────────────────────────
// A first version's populated demo (staging, `?demo=1`): rows written for the
// viewer carry demo_for = their id. Plain requests never see them, so the
// plain route's empty state stays honest; a demo request sees only their own.
function demoViewer(req) {
  return IS_STAGING && req.query.demo === '1' && req.user ? req.user.id : null;
}
// $1 is the viewer id in the demo rows (null for a plain request). The
// explicit ::text casts are needed: Postgres cannot settle a parameter's
// type from an IS NOT NULL test, so an uncast $1 fails to parse (42P08).
const DEMO_WHERE = '(d.demo_for IS NULL OR ($1::text IS NOT NULL AND d.demo_for = $1::text))';

const CARD_COLUMNS = `
  d.id, d.author_id, d.author_name, d.question, d.details, d.status, d.result,
  d.created_at, d.closed_at,
  CASE WHEN d.status = 'open'
    THEN (SELECT count(*)::int FROM votes v WHERE v.decision_id = d.id AND v.choice = 'yes')
    ELSE d.yes_count END AS yes,
  CASE WHEN d.status = 'open'
    THEN (SELECT count(*)::int FROM votes v WHERE v.decision_id = d.id AND v.choice = 'no')
    ELSE d.no_count END AS no,
  CASE WHEN d.status = 'open'
    THEN (SELECT count(*)::int FROM votes v WHERE v.decision_id = d.id AND v.choice = 'abstain')
    ELSE d.abstain_count END AS abstain,
  (SELECT count(*)::int FROM comments c WHERE c.decision_id = d.id) AS comment_count,
  (SELECT v2.choice FROM votes v2 WHERE v2.decision_id = d.id AND v2.voter_id = $2) AS my_vote,
  ($2::text IS NOT NULL AND d.author_id = $2::text) AS is_mine`;

// ── Decisions ──────────────────────────────────────────────────────────────
// Express 4 does not catch a thrown error from an async handler: it would
// surface as an unhandled rejection and take the whole app down. wrap()
// hands it to the error middleware at the bottom of the file instead, so
// the page gets a 500 and can show its error state.
const wrap = (fn) => (req, res, next) => { fn(req, res, next).catch(next); };
app.get('/api/decisions', wrap(async (req, res) => {
  const params = [await maybeDemo(req), req.user ? req.user.id : null];
  let where = DEMO_WHERE;
  if (req.query.status === 'open' || req.query.status === 'closed') {
    params.push(req.query.status);
    where += ` AND d.status = $${params.length}`;
  }
  const [rows, counts] = await Promise.all([
    pool.query(
      `SELECT ${CARD_COLUMNS} FROM decisions d WHERE ${where}
       ORDER BY d.created_at DESC, d.id DESC`,
      params
    ),
    pool.query(
      `SELECT count(*) FILTER (WHERE d.status = 'open') AS open_count,
              count(*) FILTER (WHERE d.status = 'closed') AS closed_count
       FROM decisions d WHERE ${DEMO_WHERE}`,
      [params[0]]
    ),
  ]);
  res.json({
    open_count: Number(counts.rows[0].open_count),
    closed_count: Number(counts.rows[0].closed_count),
    decisions: rows.rows,
  });
}));

app.post('/api/decisions', wrap(async (req, res) => {
  const question = String((req.body && req.body.question) || '').trim();
  const details = String((req.body && req.body.details) || '').trim() || null;
  if (!question || question.length > 200) {
    return res.status(400).json({ error: 'Question must be between 1 and 200 characters.' });
  }
  if (details && details.length > 2000) {
    return res.status(400).json({ error: 'Details must be at most 2000 characters.' });
  }
  const out = await pool.query(
    `INSERT INTO decisions (author_id, author_name, question, details, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [req.user.id, req.user.username, question, details, req.now]
  );
  res.json({ id: out.rows[0].id });
}));

function loadDecision(id, demo, voterId) {
  return pool.query(
    `SELECT ${CARD_COLUMNS} FROM decisions d WHERE d.id = $3 AND ${DEMO_WHERE}`,
    [demo, voterId, id]
  );
}

app.get('/api/decisions/:id', wrap(async (req, res) => {
  const demo = await maybeDemo(req);
  const d = await loadDecision(req.params.id, demo, req.user ? req.user.id : null);
  if (!d.rows.length) return res.status(404).json({ error: 'Not found' });
  const comments = await pool.query(
    `SELECT c.id, c.author_id, c.author_name, c.body, c.created_at,
            ($1::text IS NOT NULL AND c.author_id = $1::text) AS is_mine
     FROM comments c WHERE c.decision_id = $2 ORDER BY c.created_at ASC, c.id ASC`,
    [req.user ? req.user.id : null, req.params.id]
  );
  res.json({ decision: d.rows[0], comments: comments.rows });
}));

app.delete('/api/decisions/:id', wrap(async (req, res) => {
  const d = await loadDecision(req.params.id, await maybeDemo(req), req.user.id);
  if (!d.rows.length) return res.status(404).json({ error: 'Not found' });
  if (d.rows[0].author_id !== req.user.id) return res.status(403).json({ error: 'Only the person who posted it can delete it.' });
  await pool.query('DELETE FROM decisions WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/decisions/:id/close', wrap(async (req, res) => {
  const d = await loadDecision(req.params.id, await maybeDemo(req), req.user.id);
  if (!d.rows.length) return res.status(404).json({ error: 'Not found' });
  if (d.rows[0].author_id !== req.user.id) return res.status(403).json({ error: 'Only the person who posted it can close it.' });
  if (d.rows[0].status !== 'open') return res.status(409).json({ error: 'This vote is already closed.' });
  const t = await pool.query(
    `SELECT count(*) FILTER (WHERE choice = 'yes') AS yes,
            count(*) FILTER (WHERE choice = 'no') AS no,
            count(*) FILTER (WHERE choice = 'abstain') AS abstain
     FROM votes WHERE decision_id = $1`,
    [req.params.id]
  );
  const yes = Number(t.rows[0].yes), no = Number(t.rows[0].no);
  const result = yes > no ? 'passed' : no > yes ? 'not_passed' : 'tied';
  const out = await pool.query(
    `UPDATE decisions SET status = 'closed', result = $2,
       yes_count = $3, no_count = $4, abstain_count = $5, closed_at = $6
     WHERE id = $1 RETURNING id`,
    [req.params.id, result, yes, no, Number(t.rows[0].abstain), req.now]
  );
  res.json({ id: out.rows[0].id, result, yes, no, abstain: Number(t.rows[0].abstain) });
}));

// ── Votes ──────────────────────────────────────────────────────────────────
app.put('/api/decisions/:id/vote', wrap(async (req, res) => {
  const choice = req.body ? req.body.choice : undefined;
  if (choice !== 'yes' && choice !== 'no' && choice !== 'abstain' && choice !== null) {
    return res.status(400).json({ error: 'Choice must be yes, no, abstain or null.' });
  }
  const d = await loadDecision(req.params.id, await maybeDemo(req), req.user.id);
  if (!d.rows.length) return res.status(404).json({ error: 'Not found' });
  if (d.rows[0].status !== 'open') return res.status(409).json({ error: 'This vote is closed.' });
  if (choice === null) {
    await pool.query('DELETE FROM votes WHERE decision_id = $1 AND voter_id = $2',
      [req.params.id, req.user.id]);
  } else {
    await pool.query(
      `INSERT INTO votes (decision_id, voter_id, voter_name, choice, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (decision_id, voter_id)
       DO UPDATE SET choice = EXCLUDED.choice, voter_name = EXCLUDED.voter_name,
                     updated_at = EXCLUDED.updated_at`,
      [req.params.id, req.user.id, req.user.username, choice, req.now]
    );
  }
  const t = await pool.query(
    `SELECT count(*) FILTER (WHERE choice = 'yes') AS yes,
            count(*) FILTER (WHERE choice = 'no') AS no,
            count(*) FILTER (WHERE choice = 'abstain') AS abstain
     FROM votes WHERE decision_id = $1`,
    [req.params.id]
  );
  const tally = {
    yes: Number(t.rows[0].yes),
    no: Number(t.rows[0].no),
    abstain: Number(t.rows[0].abstain),
  };
  res.json({ my_vote: choice, ...tally });
}));

// ── Comments ───────────────────────────────────────────────────────────────
app.post('/api/decisions/:id/comments', wrap(async (req, res) => {
  const body = String((req.body && req.body.body) || '').trim();
  if (!body || body.length > 1000) {
    return res.status(400).json({ error: 'A comment must be between 1 and 1000 characters.' });
  }
  const d = await loadDecision(req.params.id, await maybeDemo(req), req.user.id);
  if (!d.rows.length) return res.status(404).json({ error: 'Not found' });
  const out = await pool.query(
    `INSERT INTO comments (decision_id, author_id, author_name, body, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [req.params.id, req.user.id, req.user.username, body, req.now]
  );
  res.json({ id: out.rows[0].id });
}));

app.delete('/api/comments/:id', wrap(async (req, res) => {
  const demo = await maybeDemo(req);
  const c = await pool.query(
    `SELECT c.id, c.author_id, c.decision_id
     FROM comments c
     JOIN decisions d ON d.id = c.decision_id
     WHERE c.id = $2 AND ${DEMO_WHERE}`,
    [demo, req.params.id]
  );
  if (!c.rows.length) return res.status(404).json({ error: 'Not found' });
  if (c.rows[0].author_id !== req.user.id) return res.status(403).json({ error: 'Only the person who wrote it can delete it.' });
  await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ── Reports ────────────────────────────────────────────────────────────────
// A report is recorded for the club to look at and changes nothing on screen.
// Idempotent: one report per person per thing.
app.post('/api/reports', wrap(async (req, res) => {
  const kind = req.body ? req.body.kind : null;
  if (kind !== 'decision' && kind !== 'comment') {
    return res.status(400).json({ error: 'Kind must be decision or comment.' });
  }
  const id = Number(req.body.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id.' });
  const target = await pool.query(
    kind === 'decision'
      ? 'SELECT id, author_id FROM decisions WHERE id = $1'
      : 'SELECT id, author_id FROM comments WHERE id = $1',
    [id]
  );
  if (!target.rows.length) return res.status(404).json({ error: 'Not found' });
  if (target.rows[0].author_id === req.user.id) {
    return res.status(400).json({ error: 'You cannot report your own post.' });
  }
  await pool.query(
    `INSERT INTO reports (target_kind, target_id, reporter_id, created_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT (target_kind, target_id, reporter_id) DO NOTHING`,
    [kind, id, req.user.id, req.now]
  );
  res.json({ ok: true });
}));

// After every route: turn a thrown error into a 500 JSON response instead of
// an unhandled rejection (see wrap above). Other paths get a plain 500.
app.use((err, req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'Something went wrong on our side.' });
  }
  res.status(500).end();
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

// ── Demo set (staging, `?demo=1`) ──────────────────────────────────────────
// A first version's populated demo: a made-up chess club, written once per
// viewer (demo_for = their id), so a reload changes nothing and what the
// viewer did to their own rows stays. Plain routes never see these rows
// (demo_for IS NULL), so the plain route's empty state stays honest. One
// open decision belongs to the viewer, three carry their votes and one
// carries their comment, so every button works on them. Written with serial
// ids inside one transaction guarded by an advisory lock and an
// existing-rows check, so two first requests write it once, and each
// viewer's set is their own.

const DEMO_PEOPLE = [
  ['demo-priya', 'Priya'], ['demo-marcus', 'Marcus'],
  ['demo-elena', 'Elena'], ['demo-tomas', 'Tomás'], ['demo-wen', 'Wen'],
];

// y/n/a are the tallies the drawn cards show; mv is the viewer's own vote
// (already counted in the tally). Closed decisions carry frozen counts and
// no vote rows at all.
const DEMO_DECISIONS = [
  { k: 1, a: 0, ago: 2880, q: 'Move Thursday meetings to the library annex?',
    d: "It holds 40 people and it's quiet enough for blitz games.",
    y: 9, n: 5, ab: 2, mv: 'yes' },
  { k: 2, a: 1, ago: 1500, q: 'Buy two tournament clocks for the spring ladder?',
    d: 'Our old clocks keep resetting mid-game. Two new ones would cost about 64 dollars from club funds.',
    y: 7, n: 1, ab: 2, mv: 'yes' },
  { k: 3, a: 2, ago: 4320, q: 'Pizza or tacos for the end of season night?',
    d: 'Pizza has won the last two polls, but Tomás knows a taco place that delivers.',
    y: 4, n: 5, ab: 1, mv: 'no' },
  { k: 4, a: 3, ago: 90, q: "Start a beginners' hour at 6pm?", d: '',
    y: 2, n: 0, ab: 1, mv: null },
  { k: 5, a: 4, ago: 7200, q: 'Switch the club newsletter to email only?', d: '',
    y: 3, n: 3, ab: 2, mv: null },
  { k: 6, a: 2, ago: 240, q: 'Enter two teams in the regional rapidplay?',
    d: "Entry is 12 dollars a player and we'd need four for each team.",
    y: 6, n: 2, ab: 1, mv: null },
  { k: 21, a: 0, ago: 20160, q: 'Adopt the new Monday practice format?',
    d: 'Forty minutes of tactics drills, then a rated game.',
    y: 11, n: 2, ab: 1, mv: null, result: 'passed' },
  { k: 22, a: 4, ago: 43200, q: 'Move the club trophy cabinet to the café?', d: '',
    y: 3, n: 8, ab: 0, mv: null, result: 'not_passed' },
  { k: 23, a: 1, ago: 72000, q: 'Split the autumn tournament into two sections?',
    d: 'An open section and a graded one, so newer players get games they can win.',
    y: 7, n: 4, ab: 2, mv: null, result: 'passed' },
  { k: 24, a: 3, ago: 115000, q: "Hold this year's rapidplay on a Saturday?", d: '',
    y: 5, n: 5, ab: 3, mv: null, result: 'tied' },
  { k: 25, a: 0, ago: 144000, q: 'Buy a second demo board for the juniors?', d: '',
    y: 9, n: 1, ab: 1, mv: null, result: 'passed' },
];

// [decision key, author index into DEMO_PEOPLE, body, minutes ago]
const DEMO_COMMENTS = [
  [1, 1, 'The annex closes at nine, remember. Games would be shorter.', 2600],
  [1, 3, "Abstaining, I'm there every other Thursday.", 2500],
  [2, 1, 'The ones with the delay setting, please. Blitz night needs it.', 1400],
  [2, 3, "Abstaining, I'm the treasurer. Funds can cover it either way.", 1350],
  [3, 4, 'Tacos. It is not even a question.', 4200],
  [3, 0, 'Pizza, but only if it is the place on the corner.', 4100],
  [21, 4, 'The drills helped. I got my first win against Wen.', 20000],
  [25, 2, 'The juniors will get a lot out of this.', 144000],
];

async function ensureDemo(viewerId, viewerName) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One writer at a time, per viewer: two first demo requests must not
    // both see "no rows yet" and write the set twice.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('club-votes-demo-' || $1))", [viewerId]);
    const has = await client.query(
      'SELECT id FROM decisions WHERE demo_for = $1 LIMIT 1', [viewerId]);
    if (has.rows.length) {
      await client.query('ROLLBACK');
      return;
    }
    const minutesAgo = (m) => new Date(Date.now() - m * 60_000);
    const me = [viewerId, viewerName || 'you'];
    const ids = {};
    for (const c of DEMO_DECISIONS) {
      const row = await client.query(
        `INSERT INTO decisions (author_id, author_name, question, details, status, result,
           yes_count, no_count, abstain_count, created_at, closed_at, demo_for)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [DEMO_PEOPLE[c.a][0], DEMO_PEOPLE[c.a][1], c.q, c.d || null,
         c.result ? 'closed' : 'open', c.result || null,
         c.y, c.n, c.ab, minutesAgo(c.ago), c.result ? minutesAgo(c.ago - 1440) : null, viewerId]
      );
      ids[c.k] = row.rows[0].id;
      if (c.result) continue; // closed: the frozen counts are the tally
      // Spread the tally over fake voters, the viewer's own vote included.
      const choices = [];
      for (let i = 0; i < c.y - (c.mv === 'yes' ? 1 : 0); i++) choices.push('yes');
      for (let i = 0; i < c.n - (c.mv === 'no' ? 1 : 0); i++) choices.push('no');
      for (let i = 0; i < c.ab - (c.mv === 'abstain' ? 1 : 0); i++) choices.push('abstain');
      for (let i = 0; i < choices.length; i++) {
        const [pid, pname] = DEMO_PEOPLE[i % DEMO_PEOPLE.length];
        await client.query(
          `INSERT INTO votes (decision_id, voter_id, voter_name, choice, updated_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (decision_id, voter_id) DO NOTHING`,
          [ids[c.k], pid + ':' + i, pname, choices[i], minutesAgo(10 + i * 7)]
        );
      }
      if (c.mv) {
        await client.query(
          `INSERT INTO votes (decision_id, voter_id, voter_name, choice, updated_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (decision_id, voter_id) DO NOTHING`,
          [ids[c.k], me[0], me[1], c.mv, minutesAgo(15)]
        );
      }
    }
    for (const [k, ai, body, ago] of DEMO_COMMENTS) {
      if (!ids[k]) continue;
      await client.query(
        `INSERT INTO comments (decision_id, author_id, author_name, body, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [ids[k], DEMO_PEOPLE[ai][0], DEMO_PEOPLE[ai][1], body, minutesAgo(ago)]
      );
    }
    // The viewer's own comment, on the drawn thread (theirs, so deletable).
    if (ids[2]) await client.query(
      `INSERT INTO comments (decision_id, author_id, author_name, body, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [ids[2], me[0], me[1], "Good call Marcus, I'll look for ones with a delay mode.", minutesAgo(1200)]
    );
    // The viewer's own open decision.
    await client.query(
      `INSERT INTO decisions (author_id, author_name, question, details, status,
         created_at, demo_for)
       VALUES ($1, $2, $3, $4, 'open', $5, $1)`,
      [me[0], me[1],
       'Put the club Noticeboard photo on the website?',
       'It needs someone to take one at the next meeting.', minutesAgo(30)]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Called from a demo route before it reads: writes the viewer's demo set the
// first time only. Returns the viewer id, or null when not in demo mode.
const demoSeeded = new Set();
async function maybeDemo(req) {
  const viewer = demoViewer(req);
  if (!viewer) return null;
  if (!demoSeeded.has(viewer)) {
    await ensureDemo(viewer, req.user.username);
    demoSeeded.add(viewer);
  }
  return viewer;
}

let serverRef = null;
async function start() {
  await ensureSchema();
  serverRef = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  serverRef.keepAliveTimeout = 75_000;
}

// Stop accepting connections, drain, close the pool, exit.
async function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await new Promise((resolve, reject) => {
      if (!serverRef) return resolve();
      serverRef.close(err => err ? reject(err) : resolve());
    });
  } catch {}
  try { await pool.end(); } catch {}
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
