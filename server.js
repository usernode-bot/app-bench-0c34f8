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
  req.userToken = typeof token === 'string' ? token : null;
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

// ── Club Votes data ───────────────────────────────────────────────────────
// Idempotent schema, applied at boot. `decisions` and `votes` and `comments`
// are the app's public tables; `reports` is private (its rows name who
// reported whom, which is not for the club to read), so it carries no
// foreign keys from the public tables and is copied to staging schema-only.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decisions (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      author_id text NOT NULL,
      author_username text NOT NULL,
      question text NOT NULL,
      details text,
      created_at timestamptz NOT NULL,
      closed_at timestamptz,
      demo boolean NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS votes (
      decision_id bigint NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      choice text NOT NULL CHECK (choice IN ('yes', 'no')),
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (decision_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      decision_id bigint NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      author_id text NOT NULL,
      author_username text NOT NULL,
      body text NOT NULL,
      created_at timestamptz NOT NULL,
      demo boolean NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS reports (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      target_type text NOT NULL CHECK (target_type IN ('decision', 'comment')),
      target_id bigint NOT NULL,
      reporter_id text NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE (target_type, target_id, reporter_id)
    );
    COMMENT ON TABLE reports IS 'staging:private';
  `);
}

// The demo the first version opens with (`?demo=1` on a staging preview):
// the viewer's first demo request writes made-up club rows, theirs included,
// with fixed ids so a reload changes nothing and what the viewer did stays.
// Marked demo = true, and every answer without ?demo=1 leaves demo rows out.
function isDemo(req) {
  return IS_STAGING && req.query.demo === '1';
}

const DEMO_PEOPLE = [
  ['demo-mina', 'Mina'],
  ['demo-tomas', 'Tomas'],
  ['demo-priya', 'Priya'],
  ['demo-dev', 'Dev'],
  ['demo-ana', 'Ana'],
];
const DEMO_VOTERS = ['demo-mina', 'demo-tomas', 'demo-priya', 'demo-dev', 'demo-ana',
  'demo-v1', 'demo-v2', 'demo-v3', 'demo-v4', 'demo-v5', 'demo-v6',
  'demo-v7', 'demo-v8', 'demo-v9', 'demo-v10', 'demo-v11', 'demo-v12'];
const VIEWER = 'viewer';

// id, author ('viewer' or a demo person's key), question, details,
// created hours ago, closed hours ago (open when null), closedBy,
// yes votes, no votes (user keys; 'v3' short for a filler demo voter)
const DEMO_DECISIONS = [
  { id: 900001, a: 'demo-mina', q: 'Move Thursday meetings to the library?', d: 'Quieter room, and the projector is free after 7.', h: 48, c: null, cb: null, y: [VIEWER, 'demo-mina', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6'], n: ['v7', 'v8'] },
  { id: 900002, a: VIEWER, q: 'Run a spring tree planting in April?', d: 'The parks office has 40 saplings for groups. We would need about 8 people on a Saturday morning.', h: 24, c: null, cb: null, y: ['demo-mina', 'demo-tomas', 'demo-priya', 'demo-dev', 'v1'], n: [] },
  { id: 900003, a: 'demo-tomas', q: 'Raise dues to $5 a month for supplies?', d: 'We spent most of the supply budget last term.', h: 4, c: null, cb: null, y: ['demo-priya'], n: ['demo-ana', VIEWER] },
  { id: 900004, a: 'demo-ana', q: 'Swap the June outing to the botanical garden?', d: 'Entry is $4 for groups of ten or more.', h: 72, c: null, cb: null, y: ['demo-mina', 'demo-tomas', 'v2', 'v3'], n: ['v4'] },
  { id: 900005, a: 'demo-mina', q: 'Start the meeting half an hour earlier, at 6:30?', d: null, h: 120, c: null, cb: null, y: ['demo-priya', 'demo-dev', 'v5'], n: ['demo-mina', 'demo-tomas', 'v6'] },
  { id: 900006, a: 'demo-dev', q: 'Buy a whiteboard for the back room?', d: 'About $25 at the shop on the corner.', h: 20, c: null, cb: null, y: ['demo-tomas', VIEWER], n: [] },
  { id: 900007, a: 'demo-priya', q: 'Split the supply budget evenly between crafts and games?', d: null, h: 144, c: null, cb: null, y: ['v7', 'v8'], n: ['demo-priya', VIEWER] },
  { id: 900008, a: 'demo-ana', q: 'Try the community hall for the August social?', d: 'It holds 40 and has a kitchen.', h: 192, c: null, cb: null, y: ['demo-mina', 'demo-tomas', 'demo-priya', 'v1', 'v2', VIEWER], n: ['v3'] },
  { id: 900009, a: 'demo-priya', q: 'Order pizza for the end-of-term party?', d: null, h: 216, c: 72, cb: 'demo-priya', y: ['demo-mina', 'demo-tomas', 'demo-priya', 'demo-dev', 'demo-ana', 'v1', 'v2', 'v3', 'v4'], n: ['v5', 'v6'] },
  { id: 900010, a: VIEWER, q: 'Buy a second folding table?', d: 'The hall is fine for 30 but the side room has nowhere to put drinks.', h: 288, c: 120, cb: VIEWER, y: ['demo-tomas', 'demo-priya', 'v1', 'v2'], n: ['demo-mina', 'demo-dev', 'v3', 'v4', 'v5', 'v6'] },
  { id: 900011, a: VIEWER, q: 'Change the weekly meeting to Tuesdays?', d: null, h: 360, c: 168, cb: VIEWER, y: ['demo-mina', 'demo-priya', 'demo-dev', 'demo-ana', 'v1', 'v2', 'v3'], n: ['demo-tomas', 'v4', 'v5'] },
  { id: 900012, a: 'demo-mina', q: 'Add a $2 travel fund to the dues?', d: null, h: 336, c: 192, cb: 'demo-mina', y: ['demo-mina', 'demo-tomas', 'v1', 'v2'], n: ['demo-priya', 'demo-dev', 'v3', 'v4'] },
];

// decision id, author key (VIEWER = the viewing account), body, hours ago
const DEMO_COMMENTS = [
  [900001, 'demo-tomas', 'Works for me, the community centre is always too loud.', 44],
  [900001, 'demo-priya', 'Can we still bring drinks in?', 40],
  [900001, 'demo-mina', 'Yes, with lids on.', 30],
  [900001, 'demo-ana', 'The car park there is free after 6, unlike here.', 26],
  [900001, VIEWER, 'Good with me either way.', 12],
  [900001, 'demo-dev', 'Thursdays I finish at 6:30, so 7 works either way.', 20],
  [900001, 'demo-dev', 'Checked the booking page: the room is open from 6.', 3],
  [900002, 'demo-mina', 'I can bring gloves and two spades.', 22],
  [900002, 'demo-dev', 'Saturday the 12th works for me, the 19th does not.', 20],
  [900002, 'demo-ana', 'Is there parking near the site?', 3],
  [900003, 'demo-priya', 'Dues have been $3 since 2023, so $5 is not a big jump.', 2],
  [900004, 'demo-tomas', 'The garden has a cafe, we could stay for lunch.', 60],
  [900004, 'demo-mina', 'June 14 is the garden festival, might be busy.', 40],
  [900005, 'demo-mina', '6:30 would let people bus home earlier.', 100],
  [900005, 'demo-tomas', 'I finish work at 6, it would be tight.', 90],
  [900005, 'demo-priya', 'Could we try it for a month and see?', 60],
  [900005, 'demo-dev', 'Fine by me either way.', 30],
  [900006, 'demo-tomas', 'I can pick it up on Saturday.', 10],
  [900007, 'demo-priya', 'Crafts used more last term, for what it is worth.', 130],
  [900007, 'demo-mina', 'Games need new cards, the old ones are missing two.', 120],
  [900007, 'demo-dev', 'Even split is fairer, we can adjust next term.', 90],
  [900007, 'demo-ana', 'Games, definitely, we never touch the crafts.', 50],
  [900007, 'demo-tomas', 'Crafts first, we have a project in April.', 10],
  [900008, 'demo-mina', 'The hall has parking, unlike the pub.', 150],
  [900008, 'demo-priya', 'August 9 is free in my calendar, we could book now.', 100],
  [900009, 'demo-dev', 'Pepperoni and a veggie one?', 120],
  [900009, 'demo-mina', 'Garlic bread as well.', 110],
  [900009, 'demo-ana', 'Last time four slices went to waste, order two fewer.', 100],
  [900010, 'demo-tomas', 'We only needed it twice last year.', 150],
  [900010, 'demo-priya', 'Renting one is cheaper anyway.', 130],
  [900011, 'demo-ana', 'Tuesdays clash with the film club.', 200],
  [900012, 'demo-tomas', 'The fund could just be part of the outing money.', 250],
  [900012, 'demo-dev', 'Keep it separate so we can see what it pays for.', 240],
];

// Seeded once per viewer: the made-up members' rows are shared, but the
// rows the viewer posted are theirs, so each account seeds its own on its
// first ?demo=1 request.
const demoSeedPromises = new Map(); // user id -> promise
function seedDemo(req) {
  if (!req.user) return Promise.resolve();
  const key = String(req.user.id);
  if (!demoSeedPromises.has(key)) {
    demoSeedPromises.set(key, runDemoSeed(req).catch(err => {
      console.error('demo seed failed: ' + err.message);
      demoSeedPromises.delete(key); // allow the next request to try again
    }));
  }
  return demoSeedPromises.get(key);
}

async function runDemoSeed(req) {
  const now = req.now.getTime();
  const uid = String(req.user.id);
  const uname = req.user.username || 'You';
  const ago = h => new Date(now - h * 3600 * 1000);

  const cli = await pool.connect();
  try {
    await cli.query('BEGIN');
    for (const d of DEMO_DECISIONS) {
      const authorId = d.a === VIEWER ? uid : d.a;
      const authorName = d.a === VIEWER ? uname : DEMO_PEOPLE.find(p => p[0] === d.a)[1];
      await cli.query(
        `INSERT INTO decisions (id, author_id, author_username, question, details, created_at, closed_at, demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         ON CONFLICT (id) DO NOTHING`,
        [d.id, authorId, authorName, d.q, d.d, ago(d.h), d.c == null ? null : ago(d.c)]);
    }
    const voteRows = [];
    for (const d of DEMO_DECISIONS) {
      for (const who of d.y.concat(d.n)) {
        const key = who === VIEWER ? uid : (who.startsWith('v') && who.length <= 3 ? 'demo-' + who : who);
        voteRows.push([d.id, key, d.y.includes(who) ? 'yes' : 'no', ago(Math.max(1, d.h - 1))]);
      }
    }
    if (voteRows.length) {
      const vals = voteRows.map((r, i) => {
        const b = i * 4;
        return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
      }).join(', ');
      const flat = voteRows.flat();
      await cli.query(
        `INSERT INTO votes (decision_id, user_id, choice, updated_at)
         VALUES ${vals} ON CONFLICT (decision_id, user_id) DO NOTHING`,
        flat);
    }
    let cid = 910001;
    for (const c of DEMO_COMMENTS) {
      const authorId = c[1] === VIEWER ? uid : c[1];
      const authorName = c[1] === VIEWER ? uname : DEMO_PEOPLE.find(p => p[0] === c[1])[1];
      await cli.query(
        `INSERT INTO comments (id, decision_id, author_id, author_username, body, created_at, demo)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (id) DO NOTHING`,
        [cid++, c[0], authorId, authorName, c[2], ago(c[3])]);
    }
    await cli.query('COMMIT');
  } catch (err) {
    await cli.query('ROLLBACK');
    throw err;
  } finally {
    cli.release();
  }
}

// The project's member list, for "9 of 12 voted". Never fails the page: a
// 403 (the check runner, an admin looking in) or any error gives null and
// the page shows just "9 voted". Cached 60 s per user (rate limit is shared).
const PLATFORM_API_BASE = process.env.USERNODE_PLATFORM_API_V1_URL
  || process.env.USERNODE_PLATFORM_API_URL;
const memberCache = new Map(); // user id -> { at, count }
async function memberCount(req) {
  if (!req.user) return null;
  const cached = memberCache.get(String(req.user.id));
  if (cached && Date.now() - cached.at < 60000) return cached.count;
  let count = null;
  if (PLATFORM_API_BASE) {
    try {
      const headers = { 'x-usernode-user-token': req.userToken };
      if (process.env.USERNODE_LLM_PROXY_TOKEN) {
        headers['x-usernode-app-token'] = process.env.USERNODE_LLM_PROXY_TOKEN;
      }
      const resp = await fetch(PLATFORM_API_BASE.replace(/\/+$/, '') + '/members?limit=200', { headers });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data.members)) count = data.members.length;
      }
    } catch {}
  }
  memberCache.set(String(req.user.id), { at: Date.now(), count });
  return count;
}

function shapeDecision(row, uid) {
  return {
    id: Number(row.id),
    author_id: row.author_id,
    author_username: row.author_username,
    question: row.question,
    details: row.details,
    created_at: row.created_at,
    closed_at: row.closed_at,
    is_mine: uid != null && row.author_id === uid,
    yes: Number(row.yes),
    no: Number(row.no),
    my_vote: row.my_vote,
    comment_count: Number(row.comment_count),
    latest_commenter: row.latest_commenter,
  };
}

const DECISION_FIELDS = `
  d.id, d.author_id, d.author_username, d.question, d.details,
  d.created_at, d.closed_at,
  (SELECT count(*) FROM votes v WHERE v.decision_id = d.id AND v.choice = 'yes') AS yes,
  (SELECT count(*) FROM votes v WHERE v.decision_id = d.id AND v.choice = 'no') AS no,
  (SELECT v.choice FROM votes v WHERE v.decision_id = d.id AND v.user_id = $1) AS my_vote,
  (SELECT count(*) FROM comments c WHERE c.decision_id = d.id) AS comment_count,
  (SELECT c.author_username FROM comments c WHERE c.decision_id = d.id
     ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS latest_commenter
`;

app.get('/api/decisions', async (req, res) => {
  const demoMode = isDemo(req);
  if (demoMode) await seedDemo(req);
  const uid = req.user ? String(req.user.id) : null;
  const tab = ['open', 'closed', 'mine'].includes(req.query.tab) ? req.query.tab : 'open';
  const demoFilter = demoMode ? '' : ' AND d.demo = false';
  const params = [uid];
  let where;
  if (tab === 'open') where = 'd.closed_at IS NULL' + demoFilter;
  else if (tab === 'closed') where = 'd.closed_at IS NOT NULL' + demoFilter;
  else { where = 'd.author_id = $2' + demoFilter; params.push(uid); }

  const rows = await pool.query(
    `SELECT ${DECISION_FIELDS} FROM decisions d WHERE ${where}
     ORDER BY ${tab === 'closed' ? 'd.closed_at DESC, d.id DESC' : 'd.created_at DESC, d.id DESC'}`,
    params);

  let recentClosed = [];
  if (tab === 'open') {
    const rc = await pool.query(
      `SELECT ${DECISION_FIELDS} FROM decisions d
       WHERE d.closed_at IS NOT NULL${demoFilter}
       ORDER BY d.closed_at DESC, d.id DESC LIMIT 3`, [uid]);
    recentClosed = rc.rows.map(r => shapeDecision(r, uid));
  }

  const counts = await pool.query(
    `SELECT count(*) FILTER (WHERE d.closed_at IS NULL) AS open_count,
            count(*) FILTER (WHERE d.closed_at IS NULL AND NOT EXISTS
              (SELECT 1 FROM votes v WHERE v.decision_id = d.id AND v.user_id = $1)
            ) AS waiting_count
       FROM decisions d WHERE ${demoMode ? 'true' : 'd.demo = false'}`, [uid]);

  const member_count = demoMode ? 12 : await memberCount(req);
  res.json({
    demo: demoMode,
    member_count,
    open_count: Number(counts.rows[0].open_count),
    waiting_count: Number(counts.rows[0].waiting_count),
    decisions: rows.rows.map(r => shapeDecision(r, uid)),
    recent_closed: recentClosed,
  });
});

app.post('/api/decisions', async (req, res) => {
  const body = req.body || {};
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  const details = typeof body.details === 'string' ? body.details.trim() : '';
  if (!question) return res.status(400).json({ error: 'Question is required.' });
  if (question.length > 200) return res.status(400).json({ error: 'Question must be 200 characters or fewer.' });
  if (details.length > 2000) return res.status(400).json({ error: 'Details must be 2000 characters or fewer.' });
  const uid = String(req.user.id);
  const inserted = await pool.query(
    `INSERT INTO decisions (author_id, author_username, question, details, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [uid, req.user.username || 'You', question, details || null, req.now]);
  const row = await pool.query(
    `SELECT ${DECISION_FIELDS} FROM decisions d WHERE d.id = $2`,
    [uid, inserted.rows[0].id]);
  res.status(201).json({ decision: shapeDecision(row.rows[0], uid) });
});

app.get('/api/decisions/:id', async (req, res) => {
  const demoMode = isDemo(req);
  if (demoMode) await seedDemo(req);
  const uid = req.user ? String(req.user.id) : null;
  const demoFilter = demoMode ? '' : ' AND d.demo = false';
  const d = await pool.query(
    `SELECT ${DECISION_FIELDS} FROM decisions d WHERE d.id = $2${demoFilter}`,
    [uid, req.params.id]).catch(() => ({ rows: [] }));
  if (!d.rows.length) return res.status(404).json({ error: 'Decision not found.' });
  const comments = await pool.query(
    `SELECT c.id, c.author_id, c.author_username, c.body, c.created_at,
            (SELECT v.choice FROM votes v WHERE v.decision_id = c.decision_id
               AND v.user_id = c.author_id) AS vote,
            (c.author_id = $2) AS is_mine
       FROM comments c
       WHERE c.decision_id = $1${demoMode ? '' : ' AND c.demo = false'}
       ORDER BY c.created_at ASC, c.id ASC`,
    [req.params.id, uid]);
  res.json({
    demo: demoMode,
    member_count: demoMode ? 12 : await memberCount(req),
    decision: shapeDecision(d.rows[0], uid),
    comments: comments.rows.map(r => ({
      id: Number(r.id),
      author_id: r.author_id,
      author_username: r.author_username,
      body: r.body,
      created_at: r.created_at,
      vote: r.vote,
      is_mine: uid != null && r.author_id === uid,
    })),
  });
});

app.put('/api/decisions/:id/vote', async (req, res) => {
  const choice = req.body ? req.body.choice : undefined;
  if (choice !== 'yes' && choice !== 'no' && choice !== null) {
    return res.status(400).json({ error: 'Choice must be yes, no or null.' });
  }
  const uid = String(req.user.id);
  const d = await pool.query('SELECT id, closed_at, demo FROM decisions WHERE id = $1', [req.params.id]);
  if (!d.rows.length) return res.status(404).json({ error: 'Decision not found.' });
  if (d.rows[0].closed_at) return res.status(409).json({ error: 'This decision is closed.' });
  if (choice === null) {
    await pool.query('DELETE FROM votes WHERE decision_id = $1 AND user_id = $2', [req.params.id, uid]);
  } else {
    await pool.query(
      `INSERT INTO votes (decision_id, user_id, choice, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (decision_id, user_id)
       DO UPDATE SET choice = $3, updated_at = $4`,
      [req.params.id, uid, choice, req.now]);
  }
  const counts = await pool.query(
    `SELECT count(*) FILTER (WHERE choice = 'yes') AS yes,
            count(*) FILTER (WHERE choice = 'no') AS no
       FROM votes WHERE decision_id = $1`, [req.params.id]);
  res.json({ yes: Number(counts.rows[0].yes), no: Number(counts.rows[0].no), my_vote: choice });
});

app.post('/api/decisions/:id/close', async (req, res) => {
  const uid = String(req.user.id);
  const d = await pool.query('SELECT id, author_id, closed_at FROM decisions WHERE id = $1', [req.params.id]);
  if (!d.rows.length) return res.status(404).json({ error: 'Decision not found.' });
  if (d.rows[0].author_id !== uid) return res.status(403).json({ error: 'Only the person who posted it can close a decision.' });
  if (!d.rows[0].closed_at) {
    await pool.query('UPDATE decisions SET closed_at = $2 WHERE id = $1', [req.params.id, req.now]);
  }
  const row = await pool.query(
    `SELECT ${DECISION_FIELDS} FROM decisions d WHERE d.id = $2`,
    [uid, req.params.id]);
  res.json({ decision: shapeDecision(row.rows[0], uid) });
});

app.delete('/api/decisions/:id', async (req, res) => {
  const uid = String(req.user.id);
  const d = await pool.query('SELECT id, author_id FROM decisions WHERE id = $1', [req.params.id]);
  if (!d.rows.length) return res.status(404).json({ error: 'Decision not found.' });
  if (d.rows[0].author_id !== uid) return res.status(403).json({ error: 'Only the person who posted it can delete a decision.' });
  await pool.query('DELETE FROM decisions WHERE id = $1', [req.params.id]);
  res.json({ deleted: true });
});

app.post('/api/decisions/:id/comments', async (req, res) => {
  const body = req.body || {};
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) return res.status(400).json({ error: 'Comment cannot be empty.' });
  if (text.length > 2000) return res.status(400).json({ error: 'Comment must be 2000 characters or fewer.' });
  const uid = String(req.user.id);
  const d = await pool.query('SELECT id, demo FROM decisions WHERE id = $1', [req.params.id]);
  if (!d.rows.length) return res.status(404).json({ error: 'Decision not found.' });
  const inserted = await pool.query(
    `INSERT INTO comments (decision_id, author_id, author_username, body, created_at, demo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [req.params.id, uid, req.user.username || 'You', text, req.now, d.rows[0].demo]);
  const row = await pool.query(
    `SELECT c.id, c.author_id, c.author_username, c.body, c.created_at,
            (SELECT v.choice FROM votes v WHERE v.decision_id = c.decision_id
               AND v.user_id = c.author_id) AS vote
       FROM comments c WHERE c.id = $1`, [inserted.rows[0].id]);
  const c = row.rows[0];
  res.status(201).json({ comment: {
    id: Number(c.id), author_id: c.author_id, author_username: c.author_username,
    body: c.body, created_at: c.created_at, vote: c.vote, is_mine: true } });
});

app.delete('/api/comments/:id', async (req, res) => {
  const uid = String(req.user.id);
  const c = await pool.query('SELECT id, author_id FROM comments WHERE id = $1', [req.params.id]);
  if (!c.rows.length) return res.status(404).json({ error: 'Comment not found.' });
  if (c.rows[0].author_id !== uid) return res.status(403).json({ error: 'You can only delete your own comments.' });
  await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
  res.json({ deleted: true });
});

app.post('/api/reports', async (req, res) => {
  const body = req.body || {};
  const type = body.target_type;
  const targetId = Number(body.target_id);
  if ((type !== 'decision' && type !== 'comment') || !Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'What is being reported is missing.' });
  }
  const table = type === 'decision' ? 'decisions' : 'comments';
  const exists = await pool.query(`SELECT id FROM ${table} WHERE id = $1`, [targetId]);
  if (!exists.rows.length) return res.status(404).json({ error: 'Not found.' });
  await pool.query(
    `INSERT INTO reports (target_type, target_id, reporter_id, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (target_type, target_id, reporter_id) DO NOTHING`,
    [type, targetId, String(req.user.id), req.now]);
  res.status(201).json({ reported: true });
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

// Graceful shutdown: stop accepting connections, drain for about 3 s
// (Envoy retires idle upstream connections at 60 s), close the pool, exit.
const server = app.listen(port, () => console.log(`Listening on :${port}`));
server.keepAliveTimeout = 75_000;
let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}, shutting down`);
  server.close();
  if (server.closeAllConnections) server.closeAllConnections();
  setTimeout(async () => {
    try { await pool.end(); } catch (err) { console.warn('pool.end failed: ' + err.message); }
    process.exit(0);
  }, 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  try {
    await ensureSchema();
  } catch (err) {
    console.error('Schema setup failed: ' + err.message);
    process.exit(1);
  }
})().catch(err => { console.error(err); process.exit(1); });
