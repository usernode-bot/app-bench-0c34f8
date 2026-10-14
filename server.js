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
  req.token = typeof token === 'string' && token ? token : null;
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
    } catch { /* fall through to the guest check below */ }
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch { /* a bad token just means unauthenticated */ }
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

// ── Club Votes ────────────────────────────────────────────────────────────
// One list of the club's decisions. Anyone can post a question with
// choices, members vote with one tap and change it until the poster
// closes the vote, and each decision has its own comments.

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decisions (
      id bigserial PRIMARY KEY,
      author_id text NOT NULL,
      author_name text NOT NULL,
      question text NOT NULL,
      created_at timestamptz NOT NULL,
      closed_at timestamptz,
      demo_owner_id text
    );
    CREATE TABLE IF NOT EXISTS choices (
      id bigserial PRIMARY KEY,
      decision_id bigint NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      label text NOT NULL,
      position int NOT NULL
    );
    -- Who voted for what: counts are shown, never who. Private so staging
    -- copies the schema without the rows.
    CREATE TABLE IF NOT EXISTS votes (
      decision_id bigint NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      choice_id bigint NOT NULL REFERENCES choices(id) ON DELETE CASCADE,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (decision_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id bigserial PRIMARY KEY,
      decision_id bigint NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      author_id text NOT NULL,
      author_name text NOT NULL,
      body text NOT NULL,
      created_at timestamptz NOT NULL,
      demo_owner_id text
    );
    -- Moderation reports, private like the votes they sit next to.
    CREATE TABLE IF NOT EXISTS reports (
      id bigserial PRIMARY KEY,
      kind text NOT NULL,
      target_id bigint NOT NULL,
      reporter_id text NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE (kind, target_id, reporter_id)
    );
  `);
  await pool.query(`COMMENT ON TABLE votes IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE reports IS 'staging:private'`);
}

// The club is the project's member list: the tally counts against it.
// Cached 60 s (the members endpoint shares a rate limit), and a 403 or a
// failure gives null — the card then says "10 voted" with no total, the
// page never fails on it.
const memberCache = new Map(); // user id -> { count, at }
const MEMBER_TTL_MS = 60_000;
async function memberCount(userId, token) {
  const base = process.env.USERNODE_PLATFORM_API_V1_URL;
  if (!base || !userId) return null;
  const key = String(userId);
  const hit = memberCache.get(key);
  if (hit && Date.now() - hit.at < MEMBER_TTL_MS) return hit.count;
  let count = null;
  try {
    const headers = { 'x-usernode-user-token': token };
    if (process.env.USERNODE_LLM_PROXY_TOKEN) {
      headers['x-usernode-app-token'] = process.env.USERNODE_LLM_PROXY_TOKEN;
    }
    const resp = await fetch(base + '/members?limit=200', { headers });
    if (resp.ok) {
      const data = await resp.json();
      count = Array.isArray(data.members) ? data.members.length : null;
    }
  } catch { count = null; }
  memberCache.set(key, { count, at: Date.now() });
  return count;
}

const isDemo = (req) => IS_STAGING && req.query.demo === '1';

// A demo row belongs to the viewer it was seeded for (demo_owner_id): that
// viewer uses it like any other row, everyone else never sees it.
const canUse = (row, user) =>
  !row.demo_owner_id || (user && String(row.demo_owner_id) === String(user.id));

// Values come back as one flat payload per decision: counts per choice,
// my_choice_id, the number of voters and the comment count. No other
// person's user id ever leaves the server: choices carry counts only.
function shapeDecision(row, choices, userId) {
  return {
    id: Number(row.id),
    question: row.question,
    author_name: row.author_name,
    mine: userId != null && String(row.author_id) === String(userId),
    created_at: row.created_at,
    closed_at: row.closed_at,
    voters: Number(row.voters),
    comments_count: Number(row.comments_count),
    my_choice_id: row.my_choice_id == null ? null : Number(row.my_choice_id),
    choices: choices.map((c) => ({
      id: Number(c.id),
      label: c.label,
      position: c.position,
      votes: Number(c.votes),
    })),
  };
}

// Open decisions newest first, then decided ones by closed_at. In demo
// mode the viewer's demo rows join the real ones; without demo=1 every
// demo row (demo_owner_id set) is filtered out.
async function fetchDecisions(userId, demo, id) {
  const params = [userId == null ? '' : String(userId)];
  let where = 'd.demo_owner_id IS NULL';
  if (demo && userId) {
    params.push(String(userId));
    where = `(d.demo_owner_id IS NULL OR d.demo_owner_id = $${params.length})`;
  }
  if (id != null) {
    params.push(id);
    where += ` AND d.id = $${params.length}`;
  }
  const rows = await pool.query(
    `SELECT d.id, d.question, d.author_id, d.author_name, d.created_at, d.closed_at,
      (SELECT count(*) FROM votes v WHERE v.decision_id = d.id) AS voters,
      (SELECT count(*) FROM comments c WHERE c.decision_id = d.id) AS comments_count,
      mv.choice_id AS my_choice_id
     FROM decisions d
     LEFT JOIN LATERAL (
       SELECT v.choice_id FROM votes v WHERE v.decision_id = d.id AND v.user_id = $1
     ) mv ON TRUE
     WHERE ${where}
     ORDER BY (d.closed_at IS NULL) DESC,
       CASE WHEN d.closed_at IS NULL THEN d.created_at ELSE d.closed_at END DESC`,
    params
  );
  const ids = rows.rows.map((r) => r.id);
  let choiceRows = { rows: [] };
  if (ids.length) {
    choiceRows = await pool.query(
      `SELECT c.decision_id, c.id, c.label, c.position, count(v.user_id)::int AS votes
       FROM choices c LEFT JOIN votes v ON v.choice_id = c.id
       WHERE c.decision_id = ANY($1::bigint[])
       GROUP BY c.decision_id, c.id, c.label, c.position
       ORDER BY c.decision_id, c.position, c.id`,
      [ids]
    );
  }
  const byDecision = new Map();
  for (const c of choiceRows.rows) {
    if (!byDecision.has(c.decision_id)) byDecision.set(c.decision_id, []);
    byDecision.get(c.decision_id).push(c);
  }
  return rows.rows.map((r) =>
    shapeDecision(r, byDecision.get(r.id) || [], userId)
  );
}

// ── Staging demo (first version's populated demo) ─────────────────────────
// Only behind IS_STAGING and ?demo=1, only on the viewer's first such
// request, fixed ids, ON CONFLICT DO NOTHING, every row owned by the
// viewer through demo_owner_id so plain requests never see it. Real users
// (the viewer's own rows) sit next to fake "demo-*" people.
const DEMO_NAMES = [
  'demo-priya', 'demo-marcus', 'demo-dana', 'demo-sam', 'demo-ana',
  'demo-leo', 'demo-nina', 'demo-tom', 'demo-ruth', 'demo-omar',
  'demo-evie', 'demo-jun', 'demo-kate', 'demo-ben',
];
const DEMO_FIRST = {
  'demo-priya': 'Priya', 'demo-marcus': 'Marcus', 'demo-dana': 'Dana',
  'demo-sam': 'Sam', 'demo-ana': 'Ana', 'demo-leo': 'Leo',
  'demo-nina': 'Nina', 'demo-tom': 'Tom', 'demo-ruth': 'Ruth',
  'demo-omar': 'Omar', 'demo-evie': 'Evie', 'demo-jun': 'Jun',
  'demo-kate': 'Kate', 'demo-ben': 'Ben',
};

async function ensureDemo(user, now) {
  const existing = await pool.query(
    'SELECT 1 FROM decisions WHERE demo_owner_id = $1 LIMIT 1',
    [String(user.id)]
  );
  if (existing.rowCount) return;
  const t = now.getTime();
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  const at = (ms) => new Date(t - ms);
  const viewerId = String(user.id);
  const viewerName = user.username || 'You';

  const decisions = [
    // [id, author_id, author_name, question, created, closed]
    [900001, 'demo-priya', 'Priya', 'Where do we meet on Saturday?', at(3 * HOUR), null],
    [900002, viewerId, viewerName, 'What should we build next term?', at(26 * HOUR), null],
    [900003, 'demo-marcus', 'Marcus', 'Move meetings to Thursday evenings?', at(2 * DAY), null],
    [900004, 'demo-dana', 'Dana', 'Club t-shirt colour', at(6 * DAY), at(3 * DAY)],
    [900005, 'demo-dana', 'Dana', 'Snack for the spring social', at(9 * DAY), at(7 * DAY)],
  ];
  // [id, decision_id, label, position]
  const choices = [
    [900001, 900001, 'Library courtyard', 1],
    [900002, 900001, 'Fenwick Park', 2],
    [900003, 900001, 'Cafe on Mill Street', 3],
    [900004, 900002, 'Community garden bench', 1],
    [900005, 900002, 'Zine and print table', 2],
    [900006, 900002, 'Bike repair day', 3],
    [900007, 900003, 'Yes', 1],
    [900008, 900003, 'No, keep Tuesdays', 2],
    [900009, 900004, 'Forest green', 1],
    [900010, 900004, 'Navy', 2],
    [900011, 900005, 'Fruit', 1],
    [900012, 900005, 'Pretzels', 2],
    [900013, 900005, 'Cookies', 3],
  ];
  // [choice_id, [voter ids]] — the viewer voted courtyard and No, and on
  // nothing else (they voted on two decisions).
  const votePlan = [
    [900001, [viewerId, 'demo-priya', 'demo-marcus', 'demo-nina', 'demo-ruth']],
    [900002, ['demo-dana', 'demo-ana', 'demo-leo']],
    [900003, ['demo-sam', 'demo-omar']],
    [900004, ['demo-priya', 'demo-kate', 'demo-tom']],
    [900005, ['demo-sam', 'demo-evie']],
    [900006, ['demo-jun']],
    [900007, ['demo-marcus', 'demo-dana', 'demo-priya', 'demo-leo', 'demo-tom', 'demo-jun', 'demo-ben', 'demo-evie']],
    [900008, [viewerId, 'demo-nina', 'demo-ana']],
    [900009, ['demo-priya', 'demo-dana', 'demo-sam', 'demo-nina', 'demo-leo', 'demo-marcus', 'demo-ruth', 'demo-omar', 'demo-kate']],
    [900010, ['demo-ana', 'demo-tom', 'demo-jun', 'demo-ben']],
    [900011, ['demo-kate', 'demo-omar', 'demo-priya', 'demo-marcus', 'demo-ben']],
    [900012, ['demo-tom', 'demo-evie', 'demo-ana', 'demo-jun', 'demo-ruth']],
    [900013, ['demo-sam', 'demo-leo', 'demo-nina']],
  ];
  // The decision a choice belongs to, straight from the choices above.
  const decisionOf = new Map(choices.map(([id, decisionId]) => [id, decisionId]));
  const votes = [];
  votePlan.forEach(([choiceId, voters], i) => {
    const decisionId = decisionOf.get(choiceId);
    voters.forEach((voter, j) =>
      votes.push([decisionId, voter, choiceId, at(((i * 7 + j * 3) % 40) * MIN + 5 * MIN)])
    );
  });
  // [id, decision_id, author_id, body, created]
  const commentRows = [
    [900001, 900001, 'demo-marcus', 'Courtyard has shade and the benches, works if it rains too since the porch is covered.', at(2 * HOUR)],
    [900002, 900001, 'demo-dana', 'Fenwick Park is closer for the folks coming by bus.', at(110 * MIN)],
    [900003, 900001, viewerId, "I can bring the folding table either way.", at(40 * MIN)],
    [900004, 900001, 'demo-sam', 'Cafe is nice but it gets loud after 11.', at(10 * MIN)],
    [900005, 900001, 'demo-nina', "Courtyard for me, the cafe never has enough seats for all of us.", at(3 * HOUR + 10 * MIN)],
    [900006, 900001, 'demo-leo', "Can we pick somewhere with parking? I cycle but Ana brings the gear.", at(150 * MIN)],
    [900007, 900001, 'demo-priya', 'Voting courtyard, we can move inside the library if it pours.', at(1 * HOUR)],
    [900008, 900001, 'demo-ruth', "Either park or courtyard, I just can't do the morning.", at(25 * MIN)],
    [900009, 900002, 'demo-priya', "The garden bench would get used every week, I'd vote for that.", at(20 * HOUR)],
    [900010, 900002, 'demo-sam', 'Zine table sounds fun, we could print a club recap each month.', at(18 * HOUR)],
    [900011, 900002, 'demo-kate', 'Bike repair day helped three of us last time it came up.', at(5 * HOUR)],
    [900012, 900003, 'demo-dana', 'Thursdays work better for me, Tuesdays clash with my class.', at(45 * HOUR)],
    [900013, 900003, 'demo-priya', "Same, I'm on until six on Thursdays so evenings suit me.", at(44 * HOUR)],
    [900014, 900003, 'demo-marcus', 'I put this up because half the club skips Tuesdays now.', at(43 * HOUR)],
    [900015, 900003, 'demo-omar', 'Thursday is fine but please not past eight.', at(41 * HOUR)],
    [900016, 900003, 'demo-nina', "Can we keep Tuesdays? Thursdays are my gym night.", at(40 * HOUR)],
    [900017, 900003, 'demo-sam', "Either is fine for me, I'll follow the vote.", at(38 * HOUR)],
    [900018, 900003, 'demo-leo', 'Thursdays, and we could push the start to half seven.', at(36 * HOUR)],
    [900019, 900003, 'demo-evie', 'I coach the juniors on Thursdays until seven, so a later start works.', at(34 * HOUR)],
    [900020, 900003, 'demo-jun', 'Happy either way, whichever gets more of us in the room.', at(30 * HOUR)],
    [900021, 900003, 'demo-tom', "Thursdays for me, Tuesdays I'm still at the workshop.", at(28 * HOUR)],
    [900022, 900003, 'demo-ruth', 'The library closes at nine on Thursdays, just saying.', at(26 * HOUR)],
    [900023, 900003, 'demo-ana', "Voted no, but I'll come whichever day wins.", at(24 * HOUR)],
    [900024, 900004, 'demo-priya', 'Forest green hides the mud from park meets, strong case.', at(5 * DAY)],
    [900025, 900004, 'demo-marcus', 'Navy goes with everything though.', at(5 * DAY - 2 * HOUR)],
    [900026, 900004, 'demo-dana', 'Green it is for me, the sample swatch sold me.', at(4 * DAY)],
    [900027, 900004, 'demo-sam', 'Anyone voting navy, green looked better in person.', at(4 * DAY - 3 * HOUR)],
    [900028, 900004, 'demo-nina', 'Ordered the green one already, no regrets.', at(3 * DAY + 5 * HOUR)],
    [900029, 900004, 'demo-leo', 'Green, and can we get it with the club name on the back?', at(3 * DAY + 2 * HOUR)],
    [900030, 900005, 'demo-kate', 'Fruit disappears in ten minutes every time, pretzels keep.', at(8 * DAY)],
    [900031, 900005, 'demo-tom', "Pretzels are cheaper in bulk if we're buying.", at(8 * DAY - 2 * HOUR)],
    [900032, 900005, 'demo-omar', 'Fruit for the win, especially the grapes.', at(7 * DAY + 6 * HOUR)],
    [900033, 900005, 'demo-evie', 'Pretzels, but someone always brings cookies anyway.', at(7 * DAY + 3 * HOUR)],
  ];

  // Simplest to insert one row at a time: five decisions and thirteen
  // choices, all fixed ids, all no-op on conflict.
  for (const [id, authorId, authorName, question, created, closed] of decisions) {
    await pool.query(
      `INSERT INTO decisions (id, author_id, author_name, question, created_at, closed_at, demo_owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [id, authorId, authorName, question, created, closed, viewerId]
    );
  }
  for (const [id, decisionId, label, position] of choices) {
    await pool.query(
      `INSERT INTO choices (id, decision_id, label, position)
       VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
      [id, decisionId, label, position]
    );
  }
  for (const [decisionId, voter, choiceId, updated] of votes) {
    await pool.query(
      `INSERT INTO votes (decision_id, user_id, choice_id, updated_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT (decision_id, user_id) DO NOTHING`,
      [decisionId, voter, choiceId, updated]
    );
  }
  for (const [id, decisionId, authorId, body, created] of commentRows) {
    await pool.query(
      `INSERT INTO comments (id, decision_id, author_id, author_name, body, created_at, demo_owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [id, decisionId, authorId, DEMO_FIRST[authorId] || 'Club member', body, created, viewerId]
    );
  }
}

// ── API ───────────────────────────────────────────────────────────────────
// Guests may read (the auth middleware above lets GET through); every
// write below is answered 401 account_required for them by that same
// middleware before it reaches these handlers, so each write handler can
// assume req.user.

function shapeComment(row, userId) {
  return {
    id: Number(row.id),
    author_name: row.author_name,
    body: row.body,
    created_at: row.created_at,
    mine: userId != null && String(row.author_id) === String(userId),
  };
}

async function loadDecision(id) {
  const rows = await pool.query('SELECT * FROM decisions WHERE id = $1', [id]);
  return rows.rows[0] || null;
}

async function listComments(decisionId, userId) {
  const rows = await pool.query(
    `SELECT id, author_id, author_name, body, created_at
     FROM comments WHERE decision_id = $1 ORDER BY created_at, id`,
    [decisionId]
  );
  return rows.rows.map((r) => shapeComment(r, userId));
}

// member_count rides along on every decisions response: null when the
// member list is unavailable, 14 in demo mode.
async function memberCountFor(req) {
  if (isDemo(req)) return DEMO_NAMES.length;
  if (!req.user) return null; // a guest: no member list of their own to count
  return memberCount(req.user.id, req.token);
}

app.get('/api/decisions', async (req, res, next) => {
  try {
    if (isDemo(req) && req.user) await ensureDemo(req.user, req.now);
    const decisions = await fetchDecisions(
      req.user ? req.user.id : null, isDemo(req), null
    );
    res.json({
      decisions,
      member_count: await memberCountFor(req),
      viewer: req.user ? { id: String(req.user.id), name: req.user.username || 'You' } : null,
    });
  } catch (err) { next(err); }
});

app.get('/api/decisions/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
    // A deep link straight to a demo decision (no list visit first) still
    // seeds the demo rows before it looks one up.
    if (isDemo(req) && req.user) await ensureDemo(req.user, req.now);
    const row = await loadDecision(id);
    if (!row || !canUse(row, req.user)) return res.status(404).json({ error: 'not_found' });
    const [shaped] = await fetchDecisions(req.user ? req.user.id : null, isDemo(req), id);
    res.json({
      decision: shaped,
      comments: await listComments(id, req.user ? req.user.id : null),
      member_count: await memberCountFor(req),
      viewer: req.user ? { id: String(req.user.id), name: req.user.username || 'You' } : null,
    });
  } catch (err) { next(err); }
});

app.post('/api/decisions', async (req, res, next) => {
  try {
    const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
    const raw = Array.isArray(req.body.choices) ? req.body.choices : [];
    const seen = new Set();
    const labels = [];
    for (const c of raw) {
      if (typeof c !== 'string') continue;
      const label = c.trim();
      if (!label) continue;
      const key = label.toLowerCase();
      if (seen.has(key)) continue; // distinct choices only
      seen.add(key);
      labels.push(label);
      if (labels.length >= 8) break;
    }
    if (!question) return res.status(400).json({ error: 'question_required' });
    if (labels.length < 2) return res.status(400).json({ error: 'choices_required' });
    const out = await pool.query(
      `INSERT INTO decisions (author_id, author_name, question, created_at)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [String(req.user.id), req.user.username || 'You', question, req.now]
    );
    const decisionId = out.rows[0].id;
    for (let i = 0; i < labels.length; i++) {
      await pool.query(
        'INSERT INTO choices (decision_id, label, position) VALUES ($1,$2,$3)',
        [decisionId, labels[i], i + 1]
      );
    }
    const [decision] = await fetchDecisions(req.user.id, false, Number(decisionId));
    res.status(201).json({ decision });
  } catch (err) { next(err); }
});

app.post('/api/decisions/:id/vote', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const choiceId = Number(req.body.choice_id);
    if (!Number.isInteger(id) || !Number.isInteger(choiceId)) {
      return res.status(400).json({ error: 'bad_request' });
    }
    const decision = await loadDecision(id);
    if (!decision || !canUse(decision, req.user)) return res.status(404).json({ error: 'not_found' });
    if (decision.closed_at) return res.status(409).json({ error: 'closed' });
    const choice = await pool.query(
      'SELECT 1 FROM choices WHERE id = $1 AND decision_id = $2',
      [choiceId, id]
    );
    if (!choice.rowCount) return res.status(400).json({ error: 'bad_choice' });
    // Upsert: one vote per member, changed as often as they like until
    // the poster closes it.
    await pool.query(
      `INSERT INTO votes (decision_id, user_id, choice_id, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (decision_id, user_id)
       DO UPDATE SET choice_id = EXCLUDED.choice_id, updated_at = EXCLUDED.updated_at`,
      [id, String(req.user.id), choiceId, req.now]
    );
    const [decision_] = await fetchDecisions(req.user.id, isDemo(req), id);
    res.json({ decision: decision_ });
  } catch (err) { next(err); }
});

app.post('/api/decisions/:id/close', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
    const decision = await loadDecision(id);
    if (!decision || !canUse(decision, req.user)) return res.status(404).json({ error: 'not_found' });
    if (String(decision.author_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'not_author' });
    }
    // Idempotent: closing twice keeps the first close time.
    await pool.query(
      'UPDATE decisions SET closed_at = $2 WHERE id = $1 AND closed_at IS NULL',
      [id, req.now]
    );
    const [shaped] = await fetchDecisions(req.user.id, isDemo(req), id);
    res.json({ decision: shaped });
  } catch (err) { next(err); }
});

app.delete('/api/decisions/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
    const decision = await loadDecision(id);
    if (!decision || !canUse(decision, req.user)) return res.status(404).json({ error: 'not_found' });
    if (String(decision.author_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'not_author' });
    }
    await pool.query('DELETE FROM decisions WHERE id = $1', [id]); // cascades
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

app.delete('/api/comments/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const rows = await pool.query('SELECT * FROM comments WHERE id = $1', [id]);
    const comment = rows.rows[0];
    if (!comment || !canUse(comment, req.user)) return res.status(404).json({ error: 'not_found' });
    if (String(comment.author_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'not_author' });
    }
    await pool.query('DELETE FROM comments WHERE id = $1', [id]);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

app.post('/api/decisions/:id/comments', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
    if (!body) return res.status(400).json({ error: 'body_required' });
    const decision = await loadDecision(id);
    if (!decision || !canUse(decision, req.user)) return res.status(404).json({ error: 'not_found' });
    const out = await pool.query(
      `INSERT INTO comments (decision_id, author_id, author_name, body, created_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [id, String(req.user.id), req.user.username || 'You', body.slice(0, 2000), req.now]
    );
    res.status(201).json({
      comment: shapeComment(
        { id: out.rows[0].id, author_id: req.user.id, author_name: req.user.username || 'You', body: body.slice(0, 2000), created_at: req.now },
        req.user.id
      ),
    });
  } catch (err) { next(err); }
});

// A report is recorded and acknowledged, nothing more: it never hides the
// thing reported, and reporting the same thing twice is a no-op.
app.post('/api/reports', async (req, res, next) => {
  try {
    const kind = req.body.kind === 'decision' || req.body.kind === 'comment' ? req.body.kind : null;
    const targetId = Number(req.body.id);
    if (!kind || !Number.isInteger(targetId)) {
      return res.status(400).json({ error: 'bad_request' });
    }
    await pool.query(
      `INSERT INTO reports (kind, target_id, reporter_id, created_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [kind, targetId, String(req.user.id), req.now]
    );
    res.json({ reported: true });
  } catch (err) { next(err); }
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

async function start() {
  await ensureSchema();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // The platform stops the container with SIGTERM (Ctrl+C sends SIGINT):
  // stop accepting, give in-flight requests about 3 s to drain, close the
  // pool, exit.
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: shutting down`);
    server.close(() => {
      pool.end().then(() => process.exit(0));
    });
    server.closeIdleConnections && server.closeIdleConnections();
    setTimeout(() => {
      pool.end().finally(() => process.exit(0));
    }, 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
