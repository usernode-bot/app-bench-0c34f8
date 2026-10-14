const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { resource } = require('./kit/server');

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

// ── Club Votes ──────────────────────────────────────────────────────────────
// One resource, the kit's: decisions with options to vote on and comments.
// Closures, reports and the per-viewer demo decision are this app's own and
// live below, mounted before the kit so a closed decision refuses votes.
const GONE = 'This was removed, or the link is wrong.';

// Demo content (staging, ?demo=1 only). The kit seeds the made-up decisions
// and the viewer's votes on two of them; the two entries below are closed and
// one is the viewer's own copy, seeded here. Kit rows use ids from 900001;
// this file's extra rows start at 900101 to stay clear of them.
const DEMO = {
  titles: [
    'Order club badges for the new members?',
    { title: 'Club t-shirt colour', options: ['Forest green', 'Navy', 'Charcoal'] },
    { title: 'Where should we meet in November?', options: ['Library room B', 'Cafe Ostra', 'Online'] },
    { title: 'Pick the next book for December', options: ['The Overstory', 'Piranesi', 'Project Hail Mary'] },
    'Move meetings to Thursdays?',
    { title: 'Film night: documentary or comedy?', options: ['Documentary', 'Comedy'] },
    { title: 'Which day for the summer barbecue?', options: ['Saturday 11 July', 'Sunday 12 July'] },
    { title: 'Where should the raffle money go?', options: ['New equipment', 'Trip fund'] },
    'Try a monthly guest speaker?',
    { title: 'Best time for the photo walk?', options: ['Saturday morning', 'Sunday afternoon'] },
  ],
  bodies: [
    'Adding it here so we can settle it this week.',
    'Please vote for what works for you; we will go with the majority.',
    'Comment if none of the options suit you and we can add one.',
  ],
  comments: [
    'Sounds good to me.',
    'Happy with either, whatever most people pick.',
    'Can we not do a weekday evening? I finish late.',
    'I can help organise this.',
    'Last time we tried this it went well, so yes from me.',
  ],
};

// Closures must exist before the kit answers its list route in the same
// request, so the demo rows the kit would seed are written here first, with
// exactly the kit's arguments (kit/server.js seedDemo: seed 7, ids from
// 900001). Keep this in step with that code if either changes.
// A closed decision takes no votes: this guard runs before the kit's own
// vote route (registered below), so the 409 answers instead of the vote
// being recorded.
app.post('/api/decisions/:id/vote', (req, res, next) => {
  const id = Number(req.params.id);
  if (!(Number.isInteger(id) && id > 0)) return next();
  pool.query('SELECT 1 FROM decision_closures WHERE decision_id = $1', [id])
    .then(({ rows }) => {
      if (rows.length) return res.status(409).json({ error: 'This decision is closed.' });
      next();
    })
    .catch((err) => {
      console.error(err);
      res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
    });
});

// Staging demo (?demo=1, staging only): seed before the kit's routes, so a
// list or detail answer already carries the closures and the viewer's own
// decision. seedDemoExtras also writes the kit's own rows (same call, same
// ids), because the closures must hang off rows that exist; the kit then
// finds them there and only adds its per-viewer votes.
app.get(['/api/decisions', '/api/decisions/:id', '/api/decision-closures'], (req, res, next) => {
  if (!(IS_STAGING && req.query.demo === '1' && req.user)) return next();
  seedDemoExtras(req).catch((err) => console.error('demo seed failed', err)).finally(() => next());
});

const decisions = resource(app, pool, {
  name: 'decisions',
  options: ['Yes', 'No'],
  demo: DEMO,
});
const KIT_DEMO_ID = 900001;
const DEMO_CLOSED = [KIT_DEMO_ID + 1, KIT_DEMO_ID + 6]; // t-shirt colour, barbecue day
const DEMO_VIEWER_ID = 900101; // the viewer's own "Spring trip" decision
const DEMO_VIEWER_COMMENT_ID = 900201;

async function migrate() {
  await decisions.migrate();
  // The mark that a decision is closed: voting stops, the winner is read
  // from the votes as they stood. Closed by the decision's author only.
  await pool.query(`CREATE TABLE IF NOT EXISTS decision_closures (
    decision_id INTEGER PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
    closed_by INTEGER NOT NULL, closed_at TIMESTAMPTZ NOT NULL)`);
  // Which staging viewers have had their own demo decision written, so it is
  // written once per viewer, never twice.
  await pool.query(`CREATE TABLE IF NOT EXISTS decisions_demo_viewers (
    user_id INTEGER PRIMARY KEY)`);
  // Reports of other people's decisions and comments, for a person to review
  // later. `staging:private` (see "Public vs private tables" in the platform
  // conventions): copied to staging as schema only, so made-up demo reports
  // are never read as real ones. No foreign keys on purpose: a report keeps
  // its target's id even after the target is deleted, and the same table
  // holds reports of two different kinds of thing.
  await pool.query(`CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY, kind TEXT NOT NULL, target_id INTEGER NOT NULL,
    reporter_id INTEGER NOT NULL, reporter_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL, UNIQUE (kind, target_id, reporter_id))`);
  await pool.query("COMMENT ON TABLE reports IS 'staging:private'");
}

// Which decisions are closed, for the page to mark rows and stop voting.
app.get('/api/decision-closures', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT decision_id AS id, closed_at AS "closedAt" FROM decision_closures LIMIT 500');
    return res.json({ closures: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
  }
});

// Close as decided: the author only, once (asking twice changes nothing).
app.post('/api/decisions/:id/close', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  try {
    const id = Number(req.params.id);
    if (!(Number.isInteger(id) && id > 0)) return res.status(404).json({ error: GONE });
    const { rows } = await pool.query('SELECT author_id FROM decisions WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: GONE });
    if (rows[0].author_id !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Only the person who posted this can close it.' });
    }
    const put = await pool.query(
      `INSERT INTO decision_closures (decision_id, closed_by, closed_at) VALUES ($1, $2, $3)
       ON CONFLICT (decision_id) DO NOTHING RETURNING closed_at`, [id, Number(req.user.id), req.now]);
    const closedAt = put.rows.length ? put.rows[0].closed_at
      : (await pool.query('SELECT closed_at FROM decision_closures WHERE decision_id = $1', [id])).rows[0].closed_at;
    return res.json({ closedAt });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
  }
});

// Delete one of your own comments. (Deleting a decision is the kit's route.)
app.delete('/api/decisions/:id/comments/:commentId', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  try {
    const commentId = Number(req.params.commentId);
    const id = Number(req.params.id);
    if (!(Number.isInteger(commentId) && commentId > 0)) return res.status(404).json({ error: GONE });
    const gone = await pool.query(
      'DELETE FROM decisions_comments WHERE id = $1 AND item_id = $2 AND author_id = $3 RETURNING id',
      [commentId, id, Number(req.user.id)]);
    if (gone.rows.length) return res.json({ ok: true });
    const still = await pool.query('SELECT 1 FROM decisions_comments WHERE id = $1 AND item_id = $2', [commentId, id]);
    if (!still.rows.length) return res.status(404).json({ error: GONE });
    return res.status(403).json({ error: 'Only the person who wrote this can delete it.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
  }
});

// Report someone else's decision or comment. Reporting twice is the same as
// reporting once. Reports are listed nowhere yet; they wait in the table.
app.post('/api/reports', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  try {
    const kind = (req.body || {}).kind;
    const id = Number((req.body || {}).id);
    if ((kind !== 'decision' && kind !== 'comment') || !(Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ error: 'Say what you are reporting.' });
    }
    await pool.query(
      `INSERT INTO reports (kind, target_id, reporter_id, reporter_name, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (kind, target_id, reporter_id) DO NOTHING`,
      [kind, id, Number(req.user.id), String(req.user.username || 'Someone'), req.now]);
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
  }
});

// Staging demo extras (?demo=1, staging only): the two closed decisions and
// the viewer's own copy of the spring trip, so Close and Delete can be tried
// on something that is theirs.
const loadDemo = () => import(new URL('./public/kit/demo.js', `file://${__dirname}/`).href);

async function seedDemoExtras(req) {
  const uid = Number(req.user.id);
  // The kit's demo rows, if they are not in yet (same call, same ids).
  const there = await pool.query('SELECT 1 FROM decisions WHERE id = $1', [KIT_DEMO_ID]);
  if (!there.rows.length) {
    const { demoItems } = await loadDemo();
    const rows = demoItems({ seed: 7, options: ['Yes', 'No'], ...DEMO, now: req.now, firstId: KIT_DEMO_ID });
    const put = (table, cols, list) => pool.query(`INSERT INTO ${table} (${cols.replace(/ \w+(,|$)/g, '$1')})
      SELECT * FROM json_to_recordset($1::json) AS x(${cols}) ON CONFLICT DO NOTHING`, [JSON.stringify(list)]);
    await put('decisions', 'id int, title text, body text, category text, options jsonb, author_id int, author_name text, created_at timestamptz',
      rows.map((r) => ({ id: r.id, title: r.title, body: r.body, category: r.category, options: r.options.map((o) => o.label), author_id: r.authorId, author_name: r.author, created_at: r.createdAt })));
    await put('decisions_votes', 'item_id int, user_id int, choice int, created_at timestamptz',
      rows.flatMap((r) => r.votes.map((v) => ({ item_id: r.id, user_id: v.userId, choice: v.optionId, created_at: v.createdAt }))));
    await put('decisions_comments', 'id int, item_id int, author_id int, author_name text, body text, created_at timestamptz',
      rows.flatMap((r) => r.comments.map((c) => ({ id: c.id, item_id: r.id, author_id: c.authorId, author_name: c.author, body: c.body, created_at: c.createdAt }))));
  }
  // Close the two decided demo rows, closed by their own author a few hours
  // after they were posted (never after right now).
  await pool.query(
    `INSERT INTO decision_closures (decision_id, closed_by, closed_at)
     SELECT id, author_id, LEAST(created_at + INTERVAL '4 hours', $2) FROM decisions WHERE id = ANY($1)
     ON CONFLICT DO NOTHING`, [DEMO_CLOSED, req.now]);
  // The viewer's own spring trip, once per viewer, with a tie in the votes
  // (no vote of the viewer's own: they can try voting, changing it, and
  // taking it back) and a few made-up comments.
  const first = await pool.query(
    'INSERT INTO decisions_demo_viewers (user_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING user_id', [uid]);
  if (first.rows.length) {
    await pool.query(
      `INSERT INTO decisions (id, title, body, options, author_id, author_name, created_at)
       VALUES ($1, 'Spring trip: coast or hills?', $2, $3::jsonb, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [DEMO_VIEWER_ID,
       'One Saturday in April. The coast means the 8:10 train, the hills mean sharing cars. Vote for the one you would come to.',
       JSON.stringify(['Coast', 'Hills']), uid, String(req.user.username || 'Someone'),
       new Date(req.now.getTime() - 26 * 3600 * 1000)]);
    await pool.query(
      `INSERT INTO decisions_votes (item_id, user_id, choice, created_at)
       SELECT $1, u, c, $2 FROM (VALUES (-1, 0), (-2, 0), (-3, 0), (-4, 0), (-5, 1), (-6, 1), (-7, 1), (-8, 1)) AS t(u, c)
       ON CONFLICT DO NOTHING`, [DEMO_VIEWER_ID, req.now]);
    await pool.query(
      `INSERT INTO decisions_comments (id, item_id, author_id, author_name, body, created_at)
       VALUES ($1, $2, -3, 'Chioma', 'Coast for me, if we can get the early train.', $3::timestamptz),
              ($1 + 1, $2, -6, 'Farah', 'Hills are cheaper if four of us drive. Happy either way.', $3::timestamptz + INTERVAL '5 hours'),
              ($1 + 2, $2, -9, 'Ivo', 'Let''s close this on Friday so we can book.', $3::timestamptz + INTERVAL '20 hours')
       ON CONFLICT DO NOTHING`, [DEMO_VIEWER_COMMENT_ID, DEMO_VIEWER_ID,
        new Date(req.now.getTime() - 21 * 3600 * 1000)]);
  }
}

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting down' });
  return res.json({ status: 'ok' });
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

// ── Shutdown ────────────────────────────────────────────────────────────────
// SIGTERM (the platform scaling or redeploying) and SIGINT (Ctrl+C) stop
// new requests, give live ones about three seconds to finish, close the
// database pool and leave. /health answers 503 while this is happening so
// the platform stops sending traffic before the process is gone.
let server = null;
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: shutting down`);
  const leave = () => process.exit(0);
  const drained = new Promise((resolve) => {
    if (!server) return resolve();
    server.close(resolve);
    server.closeIdleConnections?.();
    // Anything still open after three seconds goes too; the timer is
    // unref'd so it never keeps the process alive on its own.
    setTimeout(() => server.closeAllConnections?.(), 3000).unref?.();
    setTimeout(resolve, 3100).unref?.();
  });
  Promise.all([drained, pool.end().catch(() => {})]) .then(leave, leave);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
  await migrate();
  // keepAliveTimeout assignment: capture the listening server so shutdown
  // can stop it.
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
