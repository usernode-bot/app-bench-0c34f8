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

// ── Club Votes ─────────────────────────────────────────────────────────────
// The kit resource owns decisions, their votes and their comments, and the
// routes that read and write them (public/kit/README.md). Everything this
// app adds sits beside it: closing a decision, reporting, and the staging
// demo rows beyond what the kit seeds itself.
const GONE = 'This was removed, or the link is wrong.';
const DEMO_FIRST_ID = 900001; // demo ids from the kit: 900001 up, no real row collides
const DAY = 24 * 60 * 60 * 1000;

// Made-up staging demo (?demo=1, staging only), as public/kit/demo.js seeds
// it from these lines; every decision names its own options. Ids 900003 and
// 900007 are the two the demo closes under "Decided".
const DEMO_TITLES = [
  { title: 'Where should the club meet next month?', body: 'We outgrew the corner table at the café. Where suits most people from November?', options: ['Community hall', 'Library back room', 'The café'] },
  { title: 'Spring outing: hike, museum or picnic?', body: 'Something we keep putting off. Pick one and we will sort the details after.', options: ['Hike', 'Museum', 'Picnic'] },
  { title: 'What should our next fundraiser be?', body: 'The hall booking needs paying by the end of the month, so let us pick a fundraiser and get moving.', options: ['Bake sale', 'Raffle', 'Car wash', 'Quiz night'] },
  { title: 'Which book should we read next month?', options: ['The Overstory', 'Project Hail Mary', 'Pachinko'] },
  { title: 'Move the meeting night to Thursday?', options: ['Yes', 'No', 'Keep it flexible'] },
  { title: 'Snacks for the next meeting?', options: ['Biscuits', 'Fruit', 'Crisps', 'Nothing'] },
  { title: 'What colour should the club t-shirt be?', options: ['Blue', 'Green', 'Maroon'] },
  { title: 'Should we start a club notice board?', options: ['Yes', 'No'] },
  { title: 'Where should the summer picnic be?', options: ['The park', 'The beach', 'Riverside meadow'] },
  { title: 'Which film for the club film night?', options: ['Documentary', 'Comedy', 'Classic'] },
  { title: 'What time should meetings start?', options: ['6 pm', '7 pm', '8 pm'] },
  { title: 'New club badge or keep the old one?', options: ['New badge', 'Keep the old one'] },
];
const DEMO_BODIES = [
  'No deadline on this one, but sooner is better than never.',
  'Raised at the last meeting. Comments stay open until we decide.',
];
const DEMO_COMMENTS = [
  'The library room has the projector, which helps for the planning night.',
  'Hall is bigger if more people come back after the summer.',
  'Works for me either way, pick what suits most people.',
  'Can we settle this at the next meeting?',
  'I would rather keep it simple this year.',
  'Thursdays are hard for me before seven.',
  'I will ask around and report back.',
  'Good idea, we keep putting this off.',
];

// A decision's closure: who closed it and which option was decided. A row
// here means the decision is closed; the vote guard below reads it.
async function migrateApp() {
  await pool.query(`CREATE TABLE IF NOT EXISTS decision_closures (
    decision_id INTEGER PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
    choice INTEGER NOT NULL, closed_by_id INTEGER NOT NULL, closed_by_name TEXT NOT NULL,
    closed_at TIMESTAMPTZ NOT NULL)`);
  // Reports about user-posted content, for the club's admins. Private: they
  // are moderation material, not something the app shows.
  await pool.query(`CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY, kind TEXT NOT NULL, target_id INTEGER NOT NULL,
    reporter_id INTEGER NOT NULL, reporter_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (kind, target_id, reporter_id))`);
  await pool.query(`COMMENT ON TABLE reports IS 'staging:private'`);
}

// Staging with ?demo=1, once per viewer (kit_demo_viewers, resource
// 'decisions:own'): one decision authored by the viewer, with votes from the
// kit's made-up people, two of their comments, the viewer's own vote and one
// viewer comment — so Close decision, Delete, "You voted" and own-comment
// Delete all have something real to act on.
const DEMO_OWN_ID = 900021;
async function seedOwnDemo(req) {
  if (!(IS_STAGING && req.query.demo === '1' && req.user)) return false;
  const first = await pool.query(
    'INSERT INTO kit_demo_viewers (resource, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING user_id',
    ['decisions:own', req.user.id]);
  if (!first.rows.length) return true;
  const at = (ms) => new Date(req.now.getTime() - ms).toISOString();
  await pool.query(`INSERT INTO decisions (id, title, body, options, author_id, author_name, created_at)
    VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) ON CONFLICT (id) DO NOTHING`, [
    DEMO_OWN_ID, 'Where should we meet in November?',
    'The café is closing for renovations. Pick the place that works for most of us, I will book it once we decide.',
    JSON.stringify(['Library back room', 'Community hall', "Someone's garden"]),
    req.user.id, String(req.user.username || 'Someone'), at(2 * DAY)]);
  // Six for the library room, three for the hall, two for the garden, then
  // the viewer's own vote for the library room.
  const picks = [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [1, 0], [1, 0], [1, 0], [2, 0], [2, 0]];
  await pool.query(`INSERT INTO decisions_votes (item_id, user_id, choice, created_at) VALUES ($1, $2, $3, $4)
    ON CONFLICT (item_id, user_id) DO NOTHING`, [DEMO_OWN_ID, req.user.id, 0, at(5 * 60 * 60 * 1000)]);
  for (const [k, [choice, offset]] of picks.entries()) {
    await pool.query(`INSERT INTO decisions_votes (item_id, user_id, choice, created_at)
      VALUES ($1, $2, $3, $4) ON CONFLICT (item_id, user_id) DO NOTHING`, [
      DEMO_OWN_ID, -(k + 1), choice, at((2 * DAY) - ((k + 1) * 47 * 60 * 60 * 1000))]);
  }
  await pool.query(`INSERT INTO decisions_comments (item_id, author_id, author_name, body, created_at)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [DEMO_OWN_ID, -1, 'Ana',
    'The library room has the projector, which helps for the planning night.', at(1 * DAY)]);
  await pool.query(`INSERT INTO decisions_comments (item_id, author_id, author_name, body, created_at)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [DEMO_OWN_ID, -2, 'Ben',
    'Hall is bigger if more people come back after the summer.', at(1 * DAY - 3 * 60 * 60 * 1000)]);
  await pool.query(`INSERT INTO decisions_comments (item_id, author_id, author_name, body, created_at)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [DEMO_OWN_ID, req.user.id,
    String(req.user.username || 'Someone'), 'I can ask the library about Tuesday slots too.', at(5 * 60 * 60 * 1000)]);
  return true;
}

// Closes the two demo decisions under "Decided": the leading option of the
// votes actually seeded, closed by each decision's own author. Only where
// the kit's demo rows exist; nothing outside these demo responses reads them.
async function seedDemoClosures(req) {
  for (const id of [900003, 900007]) {
    const { rows } = await pool.query(
      'SELECT id, author_id, author_name FROM decisions WHERE id = $1 AND id >= $2', [id, DEMO_FIRST_ID]);
    if (!rows.length) continue;
    const lead = await pool.query(
      `SELECT choice FROM decisions_votes WHERE item_id = $1 GROUP BY choice ORDER BY COUNT(*) DESC, choice LIMIT 1`, [id]);
    if (!lead.rows.length) continue;
    await pool.query(`INSERT INTO decision_closures (decision_id, choice, closed_by_id, closed_by_name, closed_at)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [
      id, lead.rows[0].choice, rows[0].author_id, rows[0].author_name,
      new Date(req.now.getTime() - 2 * DAY)]);
  }
}

// Demo rows live only in the ?demo=1 answers: without the flag a read never
// sees them (ids from DEMO_FIRST_ID), so a route checked without ?demo=1
// shows the club's real (or empty) state, not the staging demo.
app.use('/api/decisions', (req, res, next) => {
  const demo = req.query.demo === '1';
  const idMatch = /^\/(\d+)(?:\/|$)/.exec(req.path);
  if (!demo && idMatch && Number(idMatch[1]) >= DEMO_FIRST_ID) {
    return res.status(404).json({ error: GONE });
  }
  if (!demo && req.method === 'GET' && (req.path === '/' || req.path === '')) {
    const json = res.json.bind(res);
    res.json = (body) => json(body && Array.isArray(body.items)
      ? { ...body, items: body.items.filter((it) => it.id < DEMO_FIRST_ID) } : body);
  }
  if (demo && req.method === 'GET' && req.user) {
    seedOwnDemo(req).then(() => next(), (err) => { console.error(err); next(); });
  } else {
    next();
  }
});

// Voting on a closed decision stops: the guard answers before the kit's
// vote route runs, so a race with a close is refused, not stored.
app.post('/api/decisions/:id/vote', (req, res, next) => {
  pool.query('SELECT 1 FROM decision_closures WHERE decision_id = $1', [Number(req.params.id) || 0])
    .then(({ rows }) => (rows.length
      ? res.status(409).json({ error: 'This decision is closed.' })
      : next()), next);
});

// Items with options to vote on and a comment thread (public/kit/README.md).
const decisions = require('./kit/server').resource(app, pool, {
  name: 'decisions',
  demo: { titles: DEMO_TITLES, bodies: DEMO_BODIES, comments: DEMO_COMMENTS },
});

// Which decisions are closed, as the feed and the detail screen read them.
// Staging with ?demo=1: also seeds this viewer's own demo decision and the
// two closed demo decisions, idempotently.
app.get('/api/closures', async (req, res) => {
  try {
    let demo = false;
    if (IS_STAGING && req.query.demo === '1') {
      demo = true;
      await seedOwnDemo(req);
      await seedDemoClosures(req);
    }
    const { rows } = await pool.query(`SELECT decision_id AS "decisionId", choice,
      closed_by_name AS "closedBy", closed_at AS "closedAt" FROM decision_closures
      ORDER BY closed_at DESC, decision_id DESC`);
    res.json({ closures: rows, demo });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
  }
});

// The person who posted a decision closes it and picks the result.
app.post('/api/decisions/:id/close', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  try {
    const id = Number(req.params.id);
    if (!(Number.isInteger(id) && id > 0)) return res.status(404).json({ error: GONE });
    const { rows } = await pool.query('SELECT author_id, options FROM decisions WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: GONE });
    if (rows[0].author_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the person who posted this can close it.' });
    }
    const labels = Array.isArray(rows[0].options) ? rows[0].options : [];
    const choice = Number((req.body || {}).choice);
    if (!Number.isInteger(choice) || choice < 0 || choice >= labels.length) {
      return res.status(400).json({ error: 'Pick one of the options.' });
    }
    const already = await pool.query('SELECT 1 FROM decision_closures WHERE decision_id = $1', [id]);
    if (already.rows.length) return res.status(409).json({ error: 'This decision is already closed.' });
    const { rows: closed } = await pool.query(`INSERT INTO decision_closures
      (decision_id, choice, closed_by_id, closed_by_name, closed_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, choice, req.user.id, String(req.user.username || 'Someone'), req.now]);
    const c = closed[0];
    return res.status(201).json({ closure: { decisionId: c.decision_id, choice: c.choice, closedBy: c.closed_by_name, closedAt: c.closed_at } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
  }
});

// Only your own comment can be deleted by you.
app.delete('/api/decisions/:id/comments/:commentId', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  try {
    const { rows } = await pool.query(
      'DELETE FROM decisions_comments WHERE id = $1 AND item_id = $2 AND author_id = $3 RETURNING id',
      [Number(req.params.commentId) || 0, Number(req.params.id) || 0, req.user.id]);
    if (!rows.length) return res.status(403).json({ error: 'Only your own comments can be deleted by you.' });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
  }
});

// A report about a decision or a comment, for the club's admins. Reporting
// again changes nothing; nothing is hidden automatically.
app.post('/api/reports', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  try {
    const kind = (req.body || {}).kind;
    const id = Number((req.body || {}).id);
    if (!['decision', 'comment'].includes(kind) || !(Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ error: 'Say what is being reported.' });
    }
    const table = kind === 'decision' ? 'decisions' : 'decisions_comments';
    const { rows: target } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    if (!target.length) return res.status(404).json({ error: GONE });
    await pool.query(`INSERT INTO reports (kind, target_id, reporter_id, reporter_name, created_at)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (kind, target_id, reporter_id) DO NOTHING`,
      [kind, id, req.user.id, String(req.user.username || 'Someone'), req.now]);
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
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

async function start() {
  await decisions.migrate();
  await migrateApp();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // Stop accepting, let the requests in flight drain for about 3 s, close
  // the pool and exit.
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => { pool.end().catch(() => {}).finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

start().catch(err => { console.error(err); process.exit(1); });
