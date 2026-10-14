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

// ── Club Votes' own rules and data ──────────────────────────────────────────
// The kit resource below owns the decisions, their votes and their comments
// (tables `decisions`, `decisions_votes`, `decisions_comments`). The rules
// the kit does not know — a decision must list 2 to 6 options, a closed
// decision takes no votes, who voted is shown by name, a poster can close —
// live here, as routes registered BEFORE the kit's own, so the guards run
// first.

const line = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const bad = (res, status, error) => res.status(status).json({ error });
const viewer = (req) => (req.user ? Number(req.user.id) : null);
const idOf = (req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };

// A decision is a choice between the options its poster lists: never a bare
// agree/disagree. 2 to 6, each different.
app.post('/api/decisions', (req, res, next) => {
  const b = req.body || {};
  const names = (Array.isArray(b.options) ? b.options : []).map((o) => line(o, 80)).filter(Boolean);
  const seen = new Set(names.map((o) => o.toLowerCase()));
  if (names.length < 2 || names.length > 6 || seen.size !== names.length) {
    return bad(res, 400, 'Give 2 to 6 options, each a different choice.');
  }
  return next();
});

// A closed decision stops taking votes, even from its own poster's tap.
app.post('/api/decisions/:id/vote', async (req, res, next) => {
  if (!req.user) return next(); // the kit's route answers a guest with "make an account"
  const id = idOf(req);
  if (!id) return next();
  try {
    const closed = await pool.query('SELECT 1 FROM decision_state WHERE decision_id = $1', [id]);
    if (closed.rows.length) return bad(res, 409, 'This decision is closed.');
    // Votes show by name: remember the name the vote was cast under.
    await pool.query(
      'INSERT INTO voter_names (user_id, username) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username',
      [viewer(req), String(req.user.username || 'Someone')]);
    return next();
  } catch (err) {
    console.error(err);
    return bad(res, 500, 'Something went wrong on our side. Try again in a moment.');
  }
});

// Who voted what, by name, and which decisions are closed. Guests see the
// names but never a "me" flag.
app.get('/api/decision-meta/:id?', async (req, res) => {
  const one = idOf(req);
  const scope = one
    ? 'SELECT id FROM decisions WHERE id = $1'
    : 'SELECT id FROM decisions ORDER BY created_at DESC, id DESC LIMIT 200';
  const args = one ? [one] : [];
  try {
    const [voteRows, stateRows] = await Promise.all([
      pool.query(`SELECT v.item_id, v.choice, v.user_id, COALESCE(n.username, 'Someone') AS name
        FROM decisions_votes v
        JOIN (${scope}) s ON s.id = v.item_id
        LEFT JOIN voter_names n ON n.user_id = v.user_id
        ORDER BY v.created_at, v.user_id`, args),
      pool.query(`SELECT ds.decision_id, ds.closed_at, ds.chosen
        FROM decision_state ds
        JOIN (${scope}) s ON s.id = ds.decision_id`, args),
    ]);
    const voters = {};
    for (const r of voteRows.rows) {
      const per = (voters[r.item_id] = voters[r.item_id] || {});
      (per[r.choice] = per[r.choice] || []).push({ name: r.name, me: viewer(req) != null && r.user_id === viewer(req) });
    }
    const states = {};
    for (const r of stateRows.rows) states[r.decision_id] = { closedAt: r.closed_at, chosen: r.chosen };
    return res.json({ states, voters });
  } catch (err) {
    console.error(err);
    return bad(res, 500, 'Something went wrong on our side. Try again in a moment.');
  }
});

// Close a decision: its poster only. Voting stops and the leading options
// are recorded, so "Chosen: …" reads the same even if votes could change.
app.post('/api/decisions/:id/close', async (req, res) => {
  if (!req.user) return bad(res, 401, 'account_required');
  const id = idOf(req);
  if (!id) return bad(res, 404, 'This was removed, or the link is wrong.');
  try {
    const item = await pool.query('SELECT options, author_id FROM decisions WHERE id = $1', [id]);
    if (!item.rows.length) return bad(res, 404, 'This was removed, or the link is wrong.');
    if (item.rows[0].author_id !== viewer(req)) {
      return bad(res, 403, 'Only the person who posted this can close it.');
    }
    const chosen = await chosenFor(id);
    await pool.query(
      `INSERT INTO decision_state (decision_id, closed_at, closed_by, chosen)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (decision_id) DO NOTHING`,
      [id, req.now, viewer(req), JSON.stringify(chosen)]);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return bad(res, 500, 'Something went wrong on our side. Try again in a moment.');
  }
});

// Delete one of your own comments.
app.delete('/api/decisions/:id/comments/:cid', async (req, res) => {
  if (!req.user) return bad(res, 401, 'account_required');
  const cid = Number(req.params.cid);
  if (!Number.isInteger(cid) || cid <= 0) return bad(res, 404, 'This was removed, or the link is wrong.');
  try {
    const { rows } = await pool.query(
      'DELETE FROM decisions_comments WHERE id = $1 AND author_id = $2 RETURNING id', [cid, viewer(req)]);
    if (!rows.length) return bad(res, 403, 'Only the person who wrote this can delete it.');
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return bad(res, 500, 'Something went wrong on our side. Try again in a moment.');
  }
});

// Reports go to the group's moderators, not to the person reported on.
app.post('/api/reports', async (req, res) => {
  if (!req.user) return bad(res, 401, 'account_required');
  const b = req.body || {};
  const kind = b.kind === 'comment' ? 'comment' : 'decision';
  const target = Number(b.id);
  if (!Number.isInteger(target) || target <= 0) return bad(res, 400, 'Say what you are reporting.');
  try {
    await pool.query(
      'INSERT INTO reports (kind, target_id, reporter_id, reporter_name, created_at) VALUES ($1, $2, $3, $4, $5)',
      [kind, target, viewer(req), String(req.user.username || 'Someone'), req.now]);
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    return bad(res, 500, 'Something went wrong on our side. Try again in a moment.');
  }
});

// The kit's resource: the decisions, their votes and their comments, with
// the staging demo behind `?demo=1`. Its routes come after the guards above
// so the club's rules run first.
const DEMO_TITLES = [
  {
    title: 'Where should we meet next month?', body: 'The usual room is being repainted all month.',
    options: ['Library back room', 'Corner café upstairs', 'Community hall'],
  },
  { title: 'What should our spring project be?', options: ['Park clean-up day', 'Book swap stall', 'Board game night series'] },
  { title: 'Which evening works best for meetings?', body: 'Pick the one you can actually make.', options: ['Tuesday', 'Thursday', 'Saturday'] },
  { title: 'Do we add a fifth officer role?', body: 'A social media officer would take the newsletter off the secretary.', options: ['Yes, add it', 'No, keep four'] },
  { title: 'Snack budget per meeting?', body: 'The current 15 euros runs out early.', options: ['Keep it at 15', 'Raise it to 25', 'Raise it to 40'] },
  { title: 'T-shirts or hoodies for the club?', body: 'Same print, different budget.', options: ['T-shirts', 'Hoodies', 'Neither this year'] },
  { title: 'Which charity for the winter drive?', body: 'One collection box at the door all December.', options: ['Food bank', 'Animal shelter', 'Books for schools', 'Winter coats'] },
  { title: 'Move the meetings online for January?', options: ['Keep them in person', 'Go online', 'Hybrid'] },
  { title: 'Guest speaker for the anniversary?', options: ['The city archivist', 'A start-up founder', 'Our own founding member'] },
  { title: 'Fundraiser for new equipment?', options: ['Bake sale', 'Quiz night', 'Sponsored walk'] },
  { title: 'Rename the newsletter?', body: '"Club Notes" has run for nine years.', options: ['Keep Club Notes', "Members' Post", 'The Ballot'] },
  { title: 'How long should questions stay open for voting?', options: ['Three days', 'One week', 'Two weeks'] },
];
const DEMO_BODIES = [
  'Bring your own cup. We ran out of paper ones twice last month.',
  'Budget numbers are pinned in the chat if you want the details.',
  'Last time we did this it took an hour, so plan the evening around it.',
];
const DEMO_COMMENTS = [
  'Happy to help set up either way.',
  'Can we keep the cost under 30 euros total?',
  'I can only make Tuesdays, just so you know.',
  'Count me in for whatever wins.',
  'Did we already agree on this last spring?',
];

// Seed ahead of the kit's GET handlers, so the first response is complete.
app.get('/api/decisions', seedAndContinue);
app.get('/api/decisions/:id', seedAndContinue);

const decisions = require('./kit/server').resource(app, pool, {
  name: 'decisions',
  max: { option: 80 },
  demo: { titles: DEMO_TITLES, bodies: DEMO_BODIES, comments: DEMO_COMMENTS },
});

// The demo's made-up people (public/kit/demo.js) vote under fake ids; their
// names live here so votes show "Ana", not "Someone". Fake identities only.
const DEMO_NAMES = ['Ana', 'Ben', 'Chioma', 'Dev', 'Elif', 'Farah', 'Gus', 'Hana', 'Ivo', 'Jules', 'Kemal', 'Lucia'];
const DEMO_ID = 900001;

// Staging + ?demo=1 only: the extra demo state the kit does not know about —
// the names the demo votes show under, and two closed decisions (one clear
// winner, one tie). The demo rows themselves are written here first, exactly
// the way kit/server.js writes them (same ids), so its own seedDemo then
// finds them and only adds the viewer's two votes. Everything ON CONFLICT DO
// NOTHING: seeding never fabricates an answer the app's logic reads.
async function seedDemoExtras(req) {
  if (!(IS_STAGING && req.query.demo === '1')) return;
  try {
    await pool.query(
      `INSERT INTO voter_names (user_id, username)
       VALUES ${DEMO_NAMES.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')}
       ON CONFLICT (user_id) DO NOTHING`,
      DEMO_NAMES.flatMap((name, i) => [-(i + 1), name]));

    const { rows: have } = await pool.query('SELECT 1 FROM decisions WHERE id = $1', [DEMO_ID]);
    if (!have.length) {
      const { demoItems } = await import(pathToFileURL(path.join(__dirname, 'public', 'kit', 'demo.js')).href);
      const demoRows = demoItems({
        seed: 7, options: ['Yes', 'No'], titles: DEMO_TITLES,
        bodies: DEMO_BODIES, comments: DEMO_COMMENTS, now: req.now, firstId: DEMO_ID,
      });
      const put = (table, cols, list) => pool.query(
        `INSERT INTO ${table} (${cols.replace(/ \w+(,|$)/g, '$1')})
         SELECT * FROM json_to_recordset($1::json) AS x(${cols}) ON CONFLICT DO NOTHING`,
        [JSON.stringify(list)]);
      await put('decisions', 'id int, title text, body text, category text, options jsonb, author_id int, author_name text, created_at timestamptz',
        demoRows.map((r) => ({ id: r.id, title: r.title, body: r.body, category: r.category, options: r.options.map((o) => o.label), author_id: r.authorId, author_name: r.author, created_at: r.createdAt })));
      await put('decisions_votes', 'item_id int, user_id int, choice int, created_at timestamptz',
        demoRows.flatMap((r) => r.votes.map((v) => ({ item_id: r.id, user_id: v.userId, choice: v.optionId, created_at: v.createdAt }))));
      await put('decisions_comments', 'id int, item_id int, author_id int, author_name text, body text, created_at timestamptz',
        demoRows.flatMap((r) => r.comments.map((c) => ({ id: c.id, item_id: r.id, author_id: c.authorId, author_name: c.author, body: c.body, created_at: c.createdAt }))));
    }

    // Close one with a clear winner and one tied, whatever the shapes came
    // out as; closed_by is the decision's own poster. Runs whether the rows
    // above or the kit's seedDemo wrote them, and ON CONFLICT DO NOTHING, so
    // it is safe to run again.
    const { rows: counted } = await pool.query(
      `SELECT item_id, choice, COUNT(*)::int AS n FROM decisions_votes
       WHERE item_id >= $1 AND item_id < $1 + $2 GROUP BY item_id, choice`, [DEMO_ID, DEMO_TITLES.length]);
    const perItem = new Map();
    for (const r of counted) {
      if (!perItem.has(r.item_id)) perItem.set(r.item_id, []);
      perItem.get(r.item_id).push(r.n);
    }
    let clear = null;
    let tie = null;
    for (const [id, ns] of perItem) {
      const total = ns.reduce((a, b) => a + b, 0);
      if (!total) continue;
      const top = Math.max(...ns);
      if (ns.filter((n) => n === top).length > 1) tie = tie || id;
      else clear = clear || id;
    }
    const closeIds = [...new Set([tie, clear].filter(Boolean))];
    if (closeIds.length < 2 && counted.length >= 2) {
      closeIds.push(...counted.map((r) => r.item_id).filter((id) => !closeIds.includes(id)).slice(0, 2 - closeIds.length));
    }
    for (const id of closeIds.slice(0, 2)) {
      await pool.query(
        `INSERT INTO decision_state (decision_id, closed_at, closed_by, chosen)
         SELECT id, $2, author_id, $3::jsonb FROM decisions WHERE id = $1
         ON CONFLICT (decision_id) DO NOTHING`,
        [id, req.now, JSON.stringify(await chosenFor(id))]);
    }
  } catch (err) {
    console.warn('demo extras did not seed: ' + err.message);
  }
}

// What a decision's votes say, as the close route records it: the leading
// options, or a tie when two or more share the lead (or nobody voted).
async function chosenFor(id) {
  const { rows } = await pool.query(
    'SELECT options FROM decisions WHERE id = $1', [id]);
  const counts = await pool.query(
    'SELECT choice, COUNT(*)::int AS n FROM decisions_votes WHERE item_id = $1 GROUP BY choice', [id]);
  const labels = rows.length && Array.isArray(rows[0].options) ? rows[0].options : [];
  const top = Math.max(0, ...counts.rows.map((r) => r.n));
  const winners = counts.rows.filter((r) => r.n === top).sort((a, b) => a.choice - b.choice);
  const total = counts.rows.reduce((sum, r) => sum + r.n, 0);
  const tied = top === 0 || winners.length > 1;
  // A tie keeps its leading labels so the screen can say what tied; with no
  // votes at all there is nothing to name.
  return { tied, labels: winners.map((r) => labels[r.choice] || 'An option'), count: top, total };
}

// One open decision by the viewer themself, once per viewer, so Close and
// Delete can be tried without touching anyone else's.
async function seedViewerDemo(req) {
  if (!(IS_STAGING && req.query.demo === '1' && req.user)) return;
  try {
    const first = await pool.query(
      `INSERT INTO kit_demo_viewers (resource, user_id) VALUES ('decisions_own', $1)
       ON CONFLICT DO NOTHING RETURNING user_id`, [viewer(req)]);
    if (!first.rows.length) return;
    const { rows } = await pool.query(
      `INSERT INTO decisions (title, body, options, author_id, author_name, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id`,
      ['Should the club buy a second table tennis set?',
       'The one we have gets queue envy on Thursdays. A second set would live in the store cupboard.',
       JSON.stringify(['Yes, worth it', 'Not this term']), viewer(req),
       String(req.user.username || 'Someone'), req.now]);
    const id = rows[0].id;
    for (const [who, choice] of [[-1, 0], [-4, 0], [-8, 1]]) {
      await pool.query(`INSERT INTO decisions_votes (item_id, user_id, choice, created_at)
        VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [id, who, choice, req.now]);
    }
    await pool.query(`INSERT INTO decisions_comments (item_id, author_id, author_name, body, created_at)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [id, -2, 'Ben', 'The paddles are half gone anyway. Yes from me.', req.now]);
  } catch (err) {
    console.warn('demo viewer decision did not seed: ' + err.message);
  }
}

// Seed ahead of the kit's GET handlers, so the first response is complete.
// Registered above the kit's routes: the kit's own GET answers the request,
// and anything mounted after it never runs.
function seedAndContinue(req, _res, next) {
  seedDemoExtras(req).then(() => seedViewerDemo(req)).then(next, next);
}

async function migrate() {
  await decisions.migrate();
  await pool.query(`CREATE TABLE IF NOT EXISTS decision_state (
    decision_id INTEGER PRIMARY KEY REFERENCES decisions(id) ON DELETE CASCADE,
    closed_at TIMESTAMPTZ NOT NULL,
    closed_by INTEGER NOT NULL,
    chosen JSONB NOT NULL DEFAULT '{}'::jsonb)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS voter_names (
    user_id INTEGER PRIMARY KEY,
    username TEXT NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    reporter_id INTEGER NOT NULL,
    reporter_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL)`);
  // Who reported what is between the reporter and the moderators.
  await pool.query(`COMMENT ON TABLE reports IS 'staging:private'`);
  await pool.query('CREATE INDEX IF NOT EXISTS reports_target_idx ON reports (kind, target_id)');
}

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
  await migrate();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // The platform stops this process with SIGTERM (Ctrl+C sends SIGINT):
  // stop accepting new connections, let the ones running finish (at most
  // ~3 s), then close the database pool and leave.
  const stop = () => {
    server.close(() => { pool.end().then(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

start().catch(err => { console.error(err); process.exit(1); });
