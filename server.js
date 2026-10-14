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

// ── Club Votes ───────────────────────────────────────────────────────────
// One list of the club's decisions: post a question with choices, members
// vote with one tap, the discussion lives under each decision, and the
// person who posted closes the vote when the club has decided.

// Schema, applied idempotently on every boot. `votes` and `reports` are
// staging:private (they hold per-person voting and reporting activity);
// the rest are public rows that only ever carry a display name.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id BIGSERIAL PRIMARY KEY,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  question TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  demo_owner_id TEXT
);
CREATE TABLE IF NOT EXISTS choices (
  id BIGSERIAL PRIMARY KEY,
  decision_id BIGINT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  position INT NOT NULL
);
CREATE TABLE IF NOT EXISTS votes (
  decision_id BIGINT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  choice_id BIGINT NOT NULL REFERENCES choices(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (decision_id, user_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id BIGSERIAL PRIMARY KEY,
  decision_id BIGINT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  demo_owner_id TEXT
);
CREATE TABLE IF NOT EXISTS reports (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  target_id BIGINT NOT NULL,
  reporter_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_kind_target_reporter_idx
  ON reports (kind, target_id, reporter_id);
`;

async function migrate() {
  await pool.query(SCHEMA);
  await pool.query("COMMENT ON TABLE votes IS 'staging:private'");
  await pool.query("COMMENT ON TABLE reports IS 'staging:private'");
}

// How many members the club has, from the platform's directory, cached for
// 60 s. A 403 (the caller isn't a member) or any error answers null and the
// page carries on without the total — it never fails the request.
const MEMBER_TTL_MS = 60_000;
let memberCache = { at: 0, value: null };
async function memberCount(userToken) {
  if (Date.now() - memberCache.at < MEMBER_TTL_MS) return memberCache.value;
  const base = process.env.USERNODE_PLATFORM_API_V1_URL;
  if (!base) return (memberCache = { at: Date.now(), value: null }).value;
  try {
    const headers = { 'x-usernode-user-token': userToken || '' };
    if (process.env.USERNODE_LLM_PROXY_TOKEN) {
      headers['x-usernode-app-token'] = process.env.USERNODE_LLM_PROXY_TOKEN;
    }
    const resp = await fetch(base.replace(/\/+$/, '') + '/members', { headers });
    if (!resp.ok) throw new Error('members answered ' + resp.status);
    const data = await resp.json();
    memberCache = {
      at: Date.now(),
      value: Array.isArray(data.members) ? data.members.length : null,
    };
  } catch (err) {
    console.warn('member count unavailable: ' + err.message);
    memberCache = { at: Date.now(), value: null };
  }
  return memberCache.value;
}

// The staging demo (`?demo=1`, first version only). The viewer gets their
// own copy of the demo, under fixed ids, written once with ON CONFLICT DO
// NOTHING so a reload changes nothing and what they did to it stays. If a
// different viewer left demo rows behind, they are replaced — demo rows are
// staging-only and belong to one viewer at a time.
const DEMO_BAND = [900001, 900005];
const DEMO_MEMBERS = 14;

function wantsDemo(req) {
  return IS_STAGING && req.query.demo === '1';
}

async function ensureDemoRows(viewer, now) {
  const have = await pool.query(
    'SELECT 1 FROM decisions WHERE id BETWEEN $1 AND $2 AND demo_owner_id = $3 LIMIT 1',
    [DEMO_BAND[0], DEMO_BAND[1], viewer.id]
  );
  if (have.rowCount > 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM decisions WHERE id BETWEEN $1 AND $2 AND (demo_owner_id IS NULL OR demo_owner_id <> $3)',
      [DEMO_BAND[0], DEMO_BAND[1], viewer.id]
    );
    const t = now.toISOString();
    const v = viewer.id;
    const uname = viewer.username || 'you';
    await client.query(
      `INSERT INTO decisions (id, author_id, author_name, question, created_at, closed_at, demo_owner_id) VALUES
        (900001, 'demo-priya', 'Priya', 'Where do we meet on Saturday?', $1::timestamptz - interval '3 hours', NULL, $2),
        (900002, $2, $3, 'What should we build next term?', $1::timestamptz - interval '26 hours', NULL, $2),
        (900003, 'demo-marcus', 'Marcus', 'Move meetings to Thursday evenings?', $1::timestamptz - interval '2 days', NULL, $2),
        (900004, 'demo-dana', 'Dana', 'Club t-shirt colour', $1::timestamptz - interval '9 days', $1::timestamptz - interval '6 days', $2),
        (900005, 'demo-dana', 'Dana', 'Snack for the spring social', $1::timestamptz - interval '8 days', $1::timestamptz - interval '5 days', $2)
       ON CONFLICT (id) DO NOTHING`,
      [t, v, uname]
    );
    await client.query(
      `INSERT INTO choices (id, decision_id, label, position) VALUES
        (910001, 900001, 'Library courtyard', 0),
        (910002, 900001, 'Fenwick Park', 1),
        (910003, 900001, 'Cafe on Mill Street', 2),
        (910004, 900002, 'Community garden bench', 0),
        (910005, 900002, 'Zine and print table', 1),
        (910006, 900002, 'Bike repair day', 2),
        (910007, 900003, 'Yes', 0),
        (910008, 900003, 'No, keep Tuesdays', 1),
        (910009, 900004, 'Forest green', 0),
        (910010, 900004, 'Navy', 1),
        (910011, 900005, 'Fruit', 0),
        (910012, 900005, 'Pretzels', 1),
        (910013, 900005, 'Chips', 2)
       ON CONFLICT (id) DO NOTHING`
    );
    // One row per (decision, user). The viewer's two votes carry their real
    // id, so they can change them; the rest are made-up members.
    await client.query(
      `INSERT INTO votes (decision_id, user_id, choice_id, updated_at) VALUES
        (900001, $2, 910001, $1),
        (900001, 'demo-marcus', 910001, $1),
        (900001, 'demo-dana', 910001, $1),
        (900001, 'demo-sam', 910001, $1),
        (900001, 'demo-alex', 910001, $1),
        (900001, 'demo-jordan', 910002, $1),
        (900001, 'demo-casey', 910002, $1),
        (900001, 'demo-riley', 910002, $1),
        (900001, 'demo-morgan', 910003, $1),
        (900001, 'demo-jamie', 910003, $1),
        (900002, 'demo-priya', 910004, $1),
        (900002, 'demo-marcus', 910004, $1),
        (900002, 'demo-casey', 910004, $1),
        (900002, 'demo-dana', 910005, $1),
        (900002, 'demo-riley', 910005, $1),
        (900002, 'demo-sam', 910006, $1),
        (900003, $2, 910008, $1),
        (900003, 'demo-priya', 910007, $1),
        (900003, 'demo-dana', 910007, $1),
        (900003, 'demo-sam', 910007, $1),
        (900003, 'demo-alex', 910007, $1),
        (900003, 'demo-jordan', 910007, $1),
        (900003, 'demo-casey', 910007, $1),
        (900003, 'demo-riley', 910007, $1),
        (900003, 'demo-morgan', 910007, $1),
        (900003, 'demo-jamie', 910008, $1),
        (900003, 'demo-taylor', 910008, $1),
        (900004, $2, 910009, $1),
        (900004, 'demo-priya', 910009, $1),
        (900004, 'demo-marcus', 910009, $1),
        (900004, 'demo-dana', 910009, $1),
        (900004, 'demo-sam', 910009, $1),
        (900004, 'demo-alex', 910009, $1),
        (900004, 'demo-jordan', 910009, $1),
        (900004, 'demo-casey', 910009, $1),
        (900004, 'demo-riley', 910009, $1),
        (900004, 'demo-morgan', 910010, $1),
        (900004, 'demo-jamie', 910010, $1),
        (900004, 'demo-taylor', 910010, $1),
        (900004, 'demo-devon', 910010, $1),
        (900005, $2, 910011, $1),
        (900005, 'demo-priya', 910011, $1),
        (900005, 'demo-marcus', 910011, $1),
        (900005, 'demo-dana', 910011, $1),
        (900005, 'demo-alex', 910011, $1),
        (900005, 'demo-sam', 910012, $1),
        (900005, 'demo-jordan', 910012, $1),
        (900005, 'demo-casey', 910012, $1),
        (900005, 'demo-riley', 910012, $1),
        (900005, 'demo-morgan', 910012, $1),
        (900005, 'demo-jamie', 910013, $1),
        (900005, 'demo-taylor', 910013, $1),
        (900005, 'demo-devon', 910013, $1)
       ON CONFLICT (decision_id, user_id) DO NOTHING`,
      [t, v]
    );
    await client.query(
      `INSERT INTO comments (id, decision_id, author_id, author_name, body, created_at, demo_owner_id) VALUES
        (950001, 900001, 'demo-marcus', 'Marcus', 'Courtyard has shade and the benches, works if it rains too since the porch is covered.', $1::timestamptz - interval '2 hours', $2),
        (950002, 900001, 'demo-dana', 'Dana', 'Fenwick Park is closer for the folks coming by bus.', $1::timestamptz - interval '100 minutes', $2),
        (950003, 900001, $2, $3, 'I can bring the folding table either way.', $1::timestamptz - interval '40 minutes', $2),
        (950004, 900001, 'demo-sam', 'Sam', 'Cafe is nice but it gets loud after 11.', $1::timestamptz - interval '10 minutes', $2),
        (950005, 900001, 'demo-alex', 'Alex', 'Courtyard for me, the parking is easier.', $1::timestamptz - interval '90 minutes', $2),
        (950006, 900001, 'demo-jordan', 'Jordan', 'Is the courtyard booked for anything else that afternoon?', $1::timestamptz - interval '55 minutes', $2),
        (950007, 900001, 'demo-casey', 'Casey', 'Fenwick has the big lawn, so there is room to spread out.', $1::timestamptz - interval '30 minutes', $2),
        (950008, 900001, 'demo-riley', 'Riley', 'Any of the three works for me, I will just be glad to see everyone.', $1::timestamptz - interval '5 minutes', $2),
        (950010, 900002, 'demo-priya', 'Priya', 'The bench would get used every week, not just once.', $1::timestamptz - interval '20 hours', $2),
        (950011, 900002, 'demo-dana', 'Dana', 'A zine table would be fun to put together.', $1::timestamptz - interval '18 hours', $2),
        (950012, 900002, 'demo-marcus', 'Marcus', 'Bike repair day saved my commute last year, worth repeating.', $1::timestamptz - interval '6 hours', $2),
        (950020, 900003, 'demo-dana', 'Dana', 'Thursdays work better around my shifts.', $1::timestamptz - interval '40 hours', $2),
        (950021, 900003, 'demo-sam', 'Sam', 'Tuesdays are fine for me but I can flex.', $1::timestamptz - interval '36 hours', $2),
        (950022, 900003, 'demo-alex', 'Alex', 'Evenings are easier to get to by bus either way.', $1::timestamptz - interval '30 hours', $2),
        (950023, 900003, 'demo-jordan', 'Jordan', 'Thursday it is for me, keep Tuesdays as a backup.', $1::timestamptz - interval '26 hours', $2),
        (950024, 900003, 'demo-morgan', 'Morgan', 'Can we still book the same room on Thursdays?', $1::timestamptz - interval '20 hours', $2),
        (950025, 900003, 'demo-riley', 'Riley', 'Whichever wins, I will show up.', $1::timestamptz - interval '8 hours', $2),
        (950030, 900004, 'demo-priya', 'Priya', 'Forest green hides the grass stains.', $1::timestamptz - interval '8 days', $2),
        (950031, 900004, 'demo-marcus', 'Marcus', 'Navy goes with everything though.', $1::timestamptz - interval '7 days', $2),
        (950032, 900004, 'demo-dana', 'Dana', 'Green felt right when we voted.', $1::timestamptz - interval '6 days', $2),
        (950033, 900004, 'demo-casey', 'Casey', 'Green it is, no complaints here.', $1::timestamptz - interval '6 days', $2),
        (950040, 900005, 'demo-jordan', 'Jordan', 'Fruit cups travel well.', $1::timestamptz - interval '7 days', $2),
        (950041, 900005, 'demo-taylor', 'Taylor', 'Pretzels keep longer if the social runs long.', $1::timestamptz - interval '6 days', $2),
        (950042, 900005, 'demo-morgan', 'Morgan', 'It ended a tie, so maybe both next time.', $1::timestamptz - interval '5 days', $2),
        (950043, 900005, 'demo-devon', 'Devon', 'Chips were an upset, honestly.', $1::timestamptz - interval '5 days', $2)
       ON CONFLICT (id) DO NOTHING`,
      [t, v, uname]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// One decision as the page sees it: counts per choice, the viewer's own
// choice, how many voted, and (when closed) which choices lead. Never
// anybody else's user ids on votes.
async function decisionPayloads(viewerId, includeDemo, decisionIds) {
  const params = [];
  let where = 'demo_owner_id IS NULL';
  if (includeDemo && viewerId) {
    where = '(demo_owner_id IS NULL OR demo_owner_id = $1)';
    params.push(viewerId);
  }
  const rows = (await pool.query(
    `SELECT id, author_id, author_name, question, created_at, closed_at
     FROM decisions WHERE ${where}`
  , params)).rows;

  const wanted = decisionIds
    ? rows.filter((r) => decisionIds.includes(Number(r.id)))
    : rows;
  const ids = wanted.map((r) => Number(r.id));

  const counts = {}; // choiceId -> vote count
  const voters = {}; // decisionId -> voter count
  const commentCount = {};
  const mine = {}; // decisionId -> viewer's choice id

  if (ids.length) {
    const voteParams = [ids];
    let mineClause = '';
    if (viewerId) {
      mineClause = ' AND user_id = $2';
      voteParams.push(viewerId);
    }
    const choiceRows = (await pool.query(
      `SELECT c.id, c.decision_id, c.label, count(v.user_id)::int AS votes
       FROM choices c LEFT JOIN votes v ON v.choice_id = c.id
       WHERE c.decision_id = ANY($1::bigint[])
       GROUP BY c.id, c.decision_id, c.label, c.position
       ORDER BY c.decision_id, c.position`,
      [ids]
    )).rows;
    const byDecision = {};
    for (const c of choiceRows) {
      const did = Number(c.decision_id);
      (byDecision[did] = byDecision[did] || []).push({
        id: Number(c.id), label: c.label, count: Number(c.votes),
      });
    }
    const voterRows = (await pool.query(
      `SELECT decision_id, count(*)::int AS n FROM votes
       WHERE decision_id = ANY($1::bigint[]) GROUP BY decision_id`,
      [ids]
    )).rows;
    for (const r of voterRows) voters[Number(r.decision_id)] = Number(r.n);
    const myRows = viewerId ? (await pool.query(
      `SELECT decision_id, choice_id FROM votes
       WHERE decision_id = ANY($1::bigint[])${mineClause}`,
      voteParams
    )).rows : [];
    for (const r of myRows) mine[Number(r.decision_id)] = Number(r.choice_id);
    let cmtParams = [ids];
    let cmtWhere = 'demo_owner_id IS NULL';
    if (includeDemo && viewerId) {
      cmtWhere = '(demo_owner_id IS NULL OR demo_owner_id = $2)';
      cmtParams.push(viewerId);
    }
    const cmtRows = (await pool.query(
      `SELECT decision_id, count(*)::int AS n FROM comments
       WHERE decision_id = ANY($1::bigint[]) AND ${cmtWhere} GROUP BY decision_id`,
      cmtParams
    )).rows;
    for (const r of cmtRows) commentCount[Number(r.decision_id)] = Number(r.n);

    return wanted.map((r) => {
      const did = Number(r.id);
      const choices = byDecision[did] || [];
      const closed = !!r.closed_at;
      let winnerIds = [];
      if (closed) {
        const top = Math.max(0, ...choices.map((c) => c.count));
        if (top > 0) {
          winnerIds = choices.filter((c) => c.count === top).map((c) => c.id);
        }
      }
      return {
        id: did,
        question: r.question,
        author_id: r.author_id,
        author_name: r.author_name,
        created_at: r.created_at,
        closed_at: r.closed_at,
        demo: r.demo_owner_id != null,
        choices,
        my_choice_id: mine[did] || null,
        voter_count: voters[did] || 0,
        comment_count: commentCount[did] || 0,
        winner_ids: winnerIds,
      };
    });
  }
  return [];
}

function sortDecisions(list) {
  // Open ones first, newest at the top; then closed, most recently closed first.
  return list.sort((a, b) => {
    if (!a.closed_at !== !b.closed_at) return a.closed_at ? 1 : -1;
    const key = (d) => new Date(d.closed_at || d.created_at).getTime();
    return key(b) - key(a);
  });
}

function viewerJSON(req) {
  return req.user ? { id: req.user.id, username: req.user.username } : null;
}

app.get('/api/decisions', async (req, res) => {
  try {
    const demo = wantsDemo(req);
    if (demo && req.user) await ensureDemoRows(req.user, req.now);
    const list = sortDecisions(await decisionPayloads(req.user ? req.user.id : null, demo));
    res.json({
      viewer: viewerJSON(req),
      member_count: demo ? DEMO_MEMBERS : await memberCount(req.userToken),
      decisions: list,
    });
  } catch (err) {
    console.error('GET /api/decisions failed: ' + (err.stack || err));
    res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/decisions/:id', async (req, res) => {
  try {
    const demo = wantsDemo(req);
    if (demo && req.user) await ensureDemoRows(req.user, req.now);
    const viewerId = req.user ? req.user.id : null;
    const [one] = await decisionPayloads(viewerId, demo, [Number(req.params.id)]);
    if (!one) return res.status(404).json({ error: 'not_found' });
    const cmtParams = [one.id];
    let cmtWhere = 'demo_owner_id IS NULL';
    if (demo && viewerId) {
      cmtWhere = '(demo_owner_id IS NULL OR demo_owner_id = $2)';
      cmtParams.push(viewerId);
    }
    const comments = (await pool.query(
      `SELECT id, author_id, author_name, body, created_at
       FROM comments WHERE decision_id = $1 AND ${cmtWhere}
       ORDER BY created_at, id`,
      cmtParams
    )).rows.map((r) => ({
      id: Number(r.id), author_id: r.author_id, author_name: r.author_name,
      body: r.body, created_at: r.created_at,
    }));
    res.json({
      viewer: viewerJSON(req),
      member_count: demo ? DEMO_MEMBERS : await memberCount(req.userToken),
      decision: one,
      comments,
    });
  } catch (err) {
    console.error('GET /api/decisions/:id failed: ' + (err.stack || err));
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/decisions', async (req, res) => {
  try {
    const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
    let choices = Array.isArray(req.body.choices) ? req.body.choices : [];
    choices = [...new Set(choices.map((c) => (typeof c === 'string' ? c.trim() : '')).filter(Boolean))];
    if (!question || choices.length < 2) {
      return res.status(400).json({ error: 'A question and at least two different choices are needed.' });
    }
    const d = (await pool.query(
      `INSERT INTO decisions (author_id, author_name, question, created_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [req.user.id, req.user.username || 'Member', question, req.now]
    )).rows[0];
    for (let i = 0; i < choices.length; i++) {
      await pool.query(
        'INSERT INTO choices (decision_id, label, position) VALUES ($1, $2, $3)',
        [d.id, choices[i], i]
      );
    }
    res.status(201).json({ id: Number(d.id) });
  } catch (err) {
    console.error('POST /api/decisions failed: ' + (err.stack || err));
    res.status(500).json({ error: 'server_error' });
  }
});

async function visibleDecision(req, id, forWrite) {
  // A write on a demo decision is allowed only for its demo owner.
  const demo = wantsDemo(req);
  const params = [id];
  let where = 'demo_owner_id IS NULL';
  if (demo && req.user) {
    where = '(demo_owner_id IS NULL OR (demo_owner_id = $2 AND $3))';
    params.push(req.user.id, !!forWrite);
  }
  const r = (await pool.query(
    `SELECT id, author_id, closed_at, demo_owner_id FROM decisions WHERE id = $1 AND ${where}`,
    params
  )).rows[0];
  return r || null;
}

app.post('/api/decisions/:id/vote', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const choiceId = Number(req.body && req.body.choice_id);
    if (!choiceId) return res.status(400).json({ error: 'Pick a choice first.' });
    const d = await visibleDecision(req, id, true);
    if (!d) return res.status(404).json({ error: 'not_found' });
    if (d.closed_at) return res.status(409).json({ error: 'This vote is closed.' });
    const choice = (await pool.query(
      'SELECT 1 FROM choices WHERE id = $1 AND decision_id = $2',
      [choiceId, id]
    )).rows[0];
    if (!choice) return res.status(400).json({ error: 'That choice is not on this decision.' });
    await pool.query(
      `INSERT INTO votes (decision_id, user_id, choice_id, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (decision_id, user_id)
       DO UPDATE SET choice_id = EXCLUDED.choice_id, updated_at = EXCLUDED.updated_at`,
      [id, req.user.id, choiceId, req.now]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST vote failed: ' + (err.stack || err));
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/decisions/:id/close', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = await visibleDecision(req, id, true);
    if (!d) return res.status(404).json({ error: 'not_found' });
    if (String(d.author_id) !== String(req.user.id)) return res.status(403).json({ error: 'Only the person who posted can close the vote.' });
    // Idempotent: closing twice keeps the first close time.
    const r = await pool.query(
      'UPDATE decisions SET closed_at = $2 WHERE id = $1 AND closed_at IS NULL RETURNING closed_at',
      [id, req.now]
    );
    res.json({ ok: true, closed_at: r.rows[0] ? r.rows[0].closed_at : d.closed_at });
  } catch (err) {
    console.error('POST close failed: ' + (err.stack || err));
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/decisions/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const d = await visibleDecision(req, id, true);
    if (!d) return res.status(404).json({ error: 'not_found' });
    if (String(d.author_id) !== String(req.user.id)) return res.status(403).json({ error: 'Only the person who posted can delete it.' });
    await pool.query('DELETE FROM decisions WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE decision failed: ' + (err.stack || err));
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/decisions/:id/comments', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
    if (!body) return res.status(400).json({ error: 'Write a comment first.' });
    const d = await visibleDecision(req, id, true);
    if (!d) return res.status(404).json({ error: 'not_found' });
    const c = (await pool.query(
      `INSERT INTO comments (decision_id, author_id, author_name, body, created_at, demo_owner_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [id, req.user.id, req.user.username || 'Member', body, req.now, d.demo_owner_id]
    )).rows[0];
    res.status(201).json({
      comment: { id: Number(c.id), author_id: req.user.id, author_name: req.user.username || 'Member', body, created_at: c.created_at },
    });
  } catch (err) {
    console.error('POST comment failed: ' + (err.stack || err));
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/comments/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const params = [id];
    let where = 'demo_owner_id IS NULL';
    if (wantsDemo(req) && req.user) {
      where = '(demo_owner_id IS NULL OR demo_owner_id = $2)';
      params.push(req.user.id);
    }
    const c = (await pool.query(
      `SELECT id, author_id FROM comments WHERE id = $1 AND ${where}`,
      params
    )).rows[0];
    if (!c) return res.status(404).json({ error: 'not_found' });
    if (String(c.author_id) !== String(req.user.id)) return res.status(403).json({ error: 'Only your own comments can be deleted.' });
    await pool.query('DELETE FROM comments WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE comment failed: ' + (err.stack || err));
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/reports', async (req, res) => {
  try {
    const kind = req.body && req.body.kind;
    const targetId = Number(req.body && req.body.id);
    if ((kind !== 'decision' && kind !== 'comment') || !targetId) {
      return res.status(400).json({ error: 'nothing_to_report' });
    }
    // The target must be one the reporter can see; a duplicate report is a
    // quiet no-op. Reported things stay visible ("no hiding").
    const table = kind === 'decision' ? 'decisions' : 'comments';
    const params = [targetId];
    let where = 'demo_owner_id IS NULL';
    if (wantsDemo(req) && req.user) {
      where = '(demo_owner_id IS NULL OR demo_owner_id = $2)';
      params.push(req.user.id);
    }
    const target = (await pool.query(
      `SELECT id FROM ${table} WHERE id = $1 AND ${where}`,
      params
    )).rows[0];
    if (!target) return res.status(404).json({ error: 'not_found' });
    await pool.query(
      `INSERT INTO reports (kind, target_id, reporter_id, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (kind, target_id, reporter_id) DO NOTHING`,
      [kind, targetId, req.user.id, req.now]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST report failed: ' + (err.stack || err));
    res.status(500).json({ error: 'server_error' });
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

let server;

async function start() {
  await migrate();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

// Stop accepting connections, let in-flight requests finish (~3 s), close
// the pool and exit.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: shutting down`);
  if (!server) process.exit(0);
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
  setTimeout(() => {
    pool.end().finally(() => process.exit(0));
  }, 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
