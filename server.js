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
// `account_required`, which the bridge turns into "Make an an account to
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

// ── Schema ───────────────────────────────────────────────────────────────
// Applied idempotently on boot. `reports` is `staging:private` (it exists
// only so the club can look at reports later; no public table points into
// it). Demo rows carry `demo_for` = the viewer they were written for, and
// every query filters them out unless the request asks for them by
// `?demo=1` in staging.

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decisions (
      id serial PRIMARY KEY,
      author_id text NOT NULL,
      author_name text NOT NULL,
      question text NOT NULL CHECK (char_length(btrim(question)) BETWEEN 1 AND 200),
      details text CHECK (details IS NULL OR char_length(btrim(details)) <= 2000),
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      result text CHECK (result IN ('passed','not_passed','tied')),
      yes_count int NOT NULL DEFAULT 0,
      no_count int NOT NULL DEFAULT 0,
      abstain_count int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz,
      demo_for text
    );
    CREATE INDEX IF NOT EXISTS decisions_demo_for_idx ON decisions (demo_for);
    CREATE TABLE IF NOT EXISTS votes (
      decision_id int NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      voter_id text NOT NULL,
      voter_name text NOT NULL,
      choice text NOT NULL CHECK (choice IN ('yes','no','abstain')),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (decision_id, voter_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id serial PRIMARY KEY,
      decision_id int NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      author_id text NOT NULL,
      author_name text NOT NULL,
      body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS comments_decision_idx ON comments (decision_id);
    CREATE TABLE IF NOT EXISTS reports (
      id serial PRIMARY KEY,
      target_kind text NOT NULL CHECK (target_kind IN ('decision','comment')),
      target_id int NOT NULL,
      reporter_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (target_kind, target_id, reporter_id)
    );
    COMMENT ON TABLE reports IS 'staging:private';
  `);
}

// ── Demo rows ────────────────────────────────────────────────────────────
// A first version's populated demo, per the platform's "Staging mock
// data": written once per viewer on the first `?demo=1` request, labelled
// once on the page, with the viewer's own decision, votes and comment in
// the set. Fixed keys via an existence check + ON CONFLICT DO NOTHING on
// the keyed tables, so a reload changes nothing and what the viewer did
// (their votes, their comment) stays.

const DEMO_PEOPLE = {
  priya: 'Priya', marcus: 'Marcus', elena: 'Elena', tomas: 'Tomás', wen: 'Wen',
};

async function seedDemo(viewerId, viewerName) {
  const existing = await pool.query(
    'SELECT 1 FROM decisions WHERE demo_for = $1 LIMIT 1', [viewerId]);
  if (existing.rowCount) return;

  // [key, author, question, details, ageDays, votes: [choice, count], comments: [author, ageDays, body]]
  const open = [
    ['move-thursday', 'priya', 'Move Thursday meetings to the library annex?',
      'The hall is booked more often this term, and the annex has room for our boards and quieter corners for long games.',
      2, [['yes', 9], ['no', 5], ['abstain', 2]], [
        ['marcus', 1, 'The annex lighting was fine last time I was there, and the parking is easier.'],
        ['elena', 1, 'It costs the club nothing extra, which settles it for me.'],
        ['wen', 0, 'Can we check the heating before we commit? Winter nights get cold in there.'],
      ]],
    ['clocks', 'viewer', 'Buy two tournament clocks for the spring ladder?',
      'Our old clocks keep resetting mid-game. Two new ones would cost about 64 dollars from club funds.',
      1, [['yes', 7], ['no', 1], ['abstain', 2]], [
        ['marcus', 1, 'The ones with the delay setting, please. Blitz night needs it.'],
        ['elena', 0, 'Abstaining, I\'m the treasurer. Funds can cover it either way.'],
      ]],
    ['pizza-tacos', 'marcus', 'Pizza or tacos for the end of season night?',
      null, 3, [['yes', 4], ['no', 5], ['abstain', 1]], [
        ['priya', 2, 'A vote with real consequences. My kind of decision.'],
        ['wen', 2, 'Tacos, and I will die on this hill.'],
      ]],
    ['beginners-hour', 'elena', 'Start a beginners\' hour at 6pm?',
      'An hour before the main meeting for people learning the ropes: open boards, no clocks, experienced members on hand.',
      0, [], []],
    ['wednesday-june', 'tomas', 'Swap the meeting night to Wednesdays in June?',
      null, 4, [['yes', 3], ['no', 2], ['abstain', 4]], [
        ['priya', 3, 'Wednesdays work better for me in June only, so a one-month trial suits me.'],
      ]],
    ['city-rapid', 'wen', 'Enter a four-player team in the city rapid?',
      'Entry is 40 dollars a team. We would need to pick four players by the end of the month.',
      0, [['yes', 5], ['no', 1], ['abstain', 0]], [
        ['marcus', 0, 'I\'m in, and I can drive four of us there.'],
      ]],
  ];

  // [key, author, question, ageDays, closedAgeDays, result, votes, comments]
  const closed = [
    ['dues', 'elena', 'Raise annual dues to 20 dollars?', 21, 9, 'not_passed', [['yes', 3], ['no', 9], ['abstain', 1]], [
      ['elena', 12, 'For the record, at 15 dollars we cover the room and the clocks, at 20 we would have a cushion.'],
    ]],
    ['demo-board', 'priya', 'Buy a demonstration board for the wall?', 18, 6, 'passed', [['yes', 8], ['no', 2], ['abstain', 0]], [
      ['wen', 10, 'Teaching two hundred people from a pocket set was never the plan. Yes from me.'],
    ]],
    ['saturday-final', 'marcus', 'Hold the spring tournament on a Saturday?', 15, 4, 'tied', [['yes', 5], ['no', 5], ['abstain', 2]], []],
    ['coach', 'tomas', 'Pay for a coach for two months?', 14, 3, 'not_passed', [['yes', 2], ['no', 7], ['abstain', 3]], [
      ['elena', 8, 'The numbers were never there. Happy to look again in the autumn.'],
    ]],
    ['swiss-rules', 'wen', 'Adopt the new swiss pairing rules?', 12, 2, 'passed', [['yes', 6], ['no', 3], ['abstain', 1]], [
      ['priya', 6, 'They avoid the same two people meeting round after round. Long overdue.'],
    ]],
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One seed per viewer, even if two ?demo=1 requests arrive together.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('club-votes-demo:' || $1))`, [viewerId]);
    const viewer = { id: viewerId, name: viewerName };

    async function addDecision(key, author, question, details, ageDays, votes, comments, extra) {
      const isViewer = author === 'viewer';
      const person = isViewer ? viewer : { id: 'demo-' + author, name: DEMO_PEOPLE[author] };
      const res = await client.query(
        `INSERT INTO decisions (author_id, author_name, question, details, created_at, demo_for)
         VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval, $6)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [person.id, person.name, question, details, String(ageDays), viewerId]
      );
      // The existence check above already returned, so a concurrent write by
      // the same viewer is the only realistic no-row case: nothing to seed.
      if (!res.rowCount) return null;
      const id = res.rows[0].id;
      const voters = [];
      for (const [choice, count] of votes) {
        for (let i = 0; i < count; i++) voters.push(choice);
      }
      let i = 0;
      for (const choice of voters) {
        const voter = { id: 'demo-voter-' + key + '-' + i, name: 'Member ' + (i + 1) };
        i++;
        await client.query(
          `INSERT INTO votes (decision_id, voter_id, voter_name, choice, updated_at)
           VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval)
           ON CONFLICT (decision_id, voter_id) DO NOTHING`,
          [id, voter.id, voter.name, choice, String(Math.max(ageDays - 1, 0))]
        );
      }
      for (const [authorKey, ageDaysC, body] of comments) {
        const cPerson = authorKey === 'viewer' ? viewer : { id: 'demo-' + authorKey, name: DEMO_PEOPLE[authorKey] };
        await client.query(
          `INSERT INTO comments (decision_id, author_id, author_name, body, created_at)
           VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval)`,
          [id, cPerson.id, cPerson.name, body, String(ageDaysC)]
        );
      }
      if (extra && extra.viewerComment) {
        await client.query(
          `INSERT INTO comments (decision_id, author_id, author_name, body, created_at)
           VALUES ($1, $2, $3, $4, now() - ($5 || ' days')::interval)`,
          [id, viewer.id, viewer.name, extra.viewerComment, String(extra.viewerCommentAge)]
        );
      }
      return id;
    }

    for (const [key, author, question, details, ageDays, votes, comments] of open) {
      await addDecision(key, author, question, details, ageDays, votes, comments,
        key === 'clocks'
          ? { viewerComment: 'Good call Marcus, I\'ll look for ones with a delay mode.', viewerCommentAge: 0 }
          : null);
    }
    for (const [key, author, question, ageDays, closedAgeDays, result, votes, comments] of closed) {
      const id = await addDecision(key, author, question, null, ageDays, votes, comments, null);
      if (id == null) continue;
      const counts = { yes: 0, no: 0, abstain: 0 };
      for (const [choice, count] of votes) counts[choice] = count;
      const r = result === 'passed' ? 'passed' : result === 'tied' ? 'tied' : 'not_passed';
      await client.query(
        `UPDATE decisions SET status = 'closed', result = $2,
           yes_count = $3, no_count = $4, abstain_count = $5, closed_at = now() - ($6 || ' days')::interval
         WHERE id = $1`,
        [id, r, counts.yes, counts.no, counts.abstain, String(closedAgeDays)]
      );
    }

    // The viewer voted on three demo decisions, as the drawn screens show:
    // Yes on their own clocks question, Yes on move-thursday, No on
    // pizza-tacos.
    const keyed = await client.query(
      `SELECT id, question FROM decisions WHERE demo_for = $1`, [viewerId]);
    for (const row of keyed.rows) {
      const choice = Object.entries({
        'Pizza or tacos': 'no',
        'Move Thursday meetings': 'yes',
        'Buy two tournament clocks': 'yes',
      }).find(([prefix]) => row.question.startsWith(prefix));
      if (choice) {
        await client.query(
          `INSERT INTO votes (decision_id, voter_id, voter_name, choice, updated_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (decision_id, voter_id) DO NOTHING`,
          [row.id, viewer.id, viewer.name, choice[1]]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

// The demo filter for every query: plain requests see only real rows; a
// staging request with ?demo=1 sees that viewer's demo rows instead.
function demoFilter(req, params) {
  if (IS_STAGING && req.query.demo === '1' && req.user) {
    params.push(req.user.id);
    return `demo_for = $${params.length}`;
  }
  return 'demo_for IS NULL';
}

function requireUser(req, res) {
  if (!req.user) {
    res.status(401).json({ error: req.guest ? 'account_required' : 'Not authenticated' });
    return false;
  }
  return true;
}

function tallyFor(decision, votesRow) {
  // Closed decisions show the counts frozen at close; open ones are live.
  if (decision.status === 'closed') {
    return { yes: decision.yes_count, no: decision.no_count, abstain: decision.abstain_count };
  }
  return votesRow || { yes: 0, no: 0, abstain: 0 };
}

const DECISION_SELECT = `
  SELECT d.id, d.author_id, d.author_name, d.question, d.details, d.status, d.result,
         d.created_at, d.closed_at,
         d.yes_count, d.no_count, d.abstain_count,
         (SELECT count(*) FILTER (WHERE choice = 'yes') FROM votes v WHERE v.decision_id = d.id) AS live_yes,
         (SELECT count(*) FILTER (WHERE choice = 'no') FROM votes v WHERE v.decision_id = d.id) AS live_no,
         (SELECT count(*) FILTER (WHERE choice = 'abstain') FROM votes v WHERE v.decision_id = d.id) AS live_abstain,
         mv.choice AS my_vote,
         (SELECT count(*) FROM comments c WHERE c.decision_id = d.id) AS comment_count
  FROM decisions d
  LEFT JOIN votes mv ON mv.decision_id = d.id AND mv.voter_id = $VIEWER`;

function shapeDecision(row, viewerId) {
  const votes = tallyFor(row, { yes: Number(row.live_yes), no: Number(row.live_no), abstain: Number(row.live_abstain) });
  return {
    id: row.id,
    question: row.question,
    details: row.details,
    status: row.status,
    result: row.result,
    yes: votes.yes,
    no: votes.no,
    abstain: votes.abstain,
    my_vote: row.my_vote,
    comment_count: Number(row.comment_count),
    is_mine: viewerId != null && String(row.author_id) === String(viewerId),
    author_name: row.author_name,
    created_at: row.created_at,
    closed_at: row.closed_at,
  };
}

// ── API routes ───────────────────────────────────────────────────────────
// Reads use the viewer id or null (guests may read); every write needs an
// account.

app.get('/api/decisions', async (req, res) => {
  const viewerId = req.user ? req.user.id : null;
  const status = req.query.status === 'closed' ? 'closed' : 'open';
  const params = [];
  try {
    if (IS_STAGING && req.query.demo === '1' && req.user) {
      await seedDemo(req.user.id, req.user.username || 'Member');
    }
  } catch (err) {
    console.error('demo seed failed: ' + err.message);
    return res.status(500).json({ error: 'decisions_unavailable' });
  }
  const filter = demoFilter(req, params);
  try {
    const counts = await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'open') AS open,
              count(*) FILTER (WHERE status = 'closed') AS closed
       FROM decisions WHERE ${filter}`, params);
    // The per-decision query reuses the filter's placeholders, then adds the
    // viewer (for my_vote) and the status after them.
    const viewerAt = params.length + 1;
    params.push(viewerId, status);
    const rows = await pool.query(
      DECISION_SELECT.replace(/\$VIEWER/g, `$${viewerAt}`) +
      ` WHERE ${filter} AND d.status = $${params.length}
       ORDER BY d.created_at DESC, d.id DESC`,
      params);
    res.json({
      open_count: Number(counts.rows[0].open),
      closed_count: Number(counts.rows[0].closed),
      decisions: rows.rows.map((r) => shapeDecision(r, viewerId)),
    });
  } catch (err) {
    console.error('GET /api/decisions failed: ' + err.message);
    res.status(500).json({ error: 'decisions_unavailable' });
  }
});

app.post('/api/decisions', async (req, res) => {
  if (!requireUser(req, res)) return;
  const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
  const details = typeof req.body.details === 'string' ? req.body.details.trim() : '';
  if (!question || question.length > 200) {
    return res.status(400).json({ error: 'A question is needed, up to 200 characters.' });
  }
  if (details.length > 2000) {
    return res.status(400).json({ error: 'Details can be up to 2000 characters.' });
  }
  const demo = IS_STAGING && req.query.demo === '1' ? req.user.id : null;
  try {
    const row = await pool.query(
      `INSERT INTO decisions (author_id, author_name, question, details, demo_for)
       VALUES ($1, $2, $3, NULLIF($4, ''), $5) RETURNING id, created_at`,
      [req.user.id, req.user.username || 'Member', question, details || null, demo]);
    res.status(201).json({ id: row.rows[0].id });
  } catch (err) {
    console.error('POST /api/decisions failed: ' + err.message);
    res.status(500).json({ error: 'not_posted' });
  }
});

app.get('/api/decisions/:id', async (req, res) => {
  const viewerId = req.user ? req.user.id : null;
  const params = [];
  const filter = demoFilter(req, params);
  params.push(viewerId, req.params.id);
  try {
    const row = await pool.query(
      DECISION_SELECT.replace(/\$VIEWER/g, `$${params.length - 1}`) +
      ` WHERE ${filter} AND d.id = $${params.length}`,
      params);
    if (!row.rows.length) return res.status(404).json({ error: 'not_found' });
    const comments = await pool.query(
      `SELECT id, author_id, author_name, body, created_at
       FROM comments WHERE decision_id = $1 ORDER BY created_at ASC, id ASC`,
      [req.params.id]);
    res.json({
      decision: shapeDecision(row.rows[0], viewerId),
      comments: comments.rows.map((c) => ({
        id: c.id,
        author_name: c.author_name,
        body: c.body,
        created_at: c.created_at,
        is_mine: viewerId != null && String(c.author_id) === String(viewerId),
      })),
    });
  } catch (err) {
    console.error('GET /api/decisions/:id failed: ' + err.message);
    res.status(500).json({ error: 'decision_unavailable' });
  }
});

app.delete('/api/decisions/:id', async (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const row = await pool.query(
      'DELETE FROM decisions WHERE id = $1 AND author_id = $2 RETURNING id',
      [req.params.id, req.user.id]);
    if (!row.rows.length) return res.status(404).json({ error: 'not_found_or_not_yours' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/decisions/:id failed: ' + err.message);
    res.status(500).json({ error: 'not_deleted' });
  }
});

app.post('/api/decisions/:id/close', async (req, res) => {
  if (!requireUser(req, res)) return;
  const params = [req.params.id];
  const filter = demoFilter(req, params);
  try {
    const found = await pool.query(
      `SELECT id, author_id, status FROM decisions WHERE id = $1 AND ${filter}`,
      params);
    if (!found.rows.length) return res.status(404).json({ error: 'not_found' });
    const decision = found.rows[0];
    if (String(decision.author_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'only_the_author_can_close' });
    }
    if (decision.status !== 'open') return res.status(409).json({ error: 'already_closed' });
    const votes = await pool.query(
      `SELECT count(*) FILTER (WHERE choice = 'yes') AS yes,
              count(*) FILTER (WHERE choice = 'no') AS no,
              count(*) FILTER (WHERE choice = 'abstain') AS abstain
       FROM votes WHERE decision_id = $1`, [req.params.id]);
    const yes = Number(votes.rows[0].yes);
    const no = Number(votes.rows[0].no);
    const abstain = Number(votes.rows[0].abstain);
    // Simple majority of votes cast decides; abstentions count as taking
    // part, not as votes, and a tie does not pass.
    const result = yes > no ? 'passed' : no > yes ? 'not_passed' : 'tied';
    const updated = await pool.query(
      `UPDATE decisions SET status = 'closed', result = $2,
         yes_count = $3, no_count = $4, abstain_count = $5, closed_at = now()
       WHERE id = $1 AND status = 'open' RETURNING created_at, closed_at`,
      [req.params.id, result, yes, no, abstain]);
    res.json({
      decision: {
        status: 'closed', result, yes, no, abstain,
        created_at: updated.rows[0].created_at,
        closed_at: updated.rows[0].closed_at,
      },
    });
  } catch (err) {
    console.error('POST /api/decisions/:id/close failed: ' + err.message);
    res.status(500).json({ error: 'not_closed' });
  }
});

app.put('/api/decisions/:id/vote', async (req, res) => {
  if (!requireUser(req, res)) return;
  const choice = req.body && req.body.choice;
  if (choice !== null && choice !== 'yes' && choice !== 'no' && choice !== 'abstain') {
    return res.status(400).json({ error: 'bad_choice' });
  }
  const params = [req.params.id];
  const filter = demoFilter(req, params);
  try {
    const found = await pool.query(
      `SELECT id, status FROM decisions WHERE id = $1 AND ${filter}`,
      params);
    if (!found.rows.length) return res.status(404).json({ error: 'not_found' });
    if (found.rows[0].status !== 'open') return res.status(409).json({ error: 'closed' });
    if (choice === null) {
      await pool.query('DELETE FROM votes WHERE decision_id = $1 AND voter_id = $2',
        [req.params.id, req.user.id]);
    } else {
      await pool.query(
        `INSERT INTO votes (decision_id, voter_id, voter_name, choice, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (decision_id, voter_id)
         DO UPDATE SET choice = EXCLUDED.choice, updated_at = now()`,
        [req.params.id, req.user.id, req.user.username || 'Member', choice]);
    }
    const tally = await pool.query(
      `SELECT count(*) FILTER (WHERE choice = 'yes') AS yes,
              count(*) FILTER (WHERE choice = 'no') AS no,
              count(*) FILTER (WHERE choice = 'abstain') AS abstain
       FROM votes WHERE decision_id = $1`, [req.params.id]);
    res.json({
      yes: Number(tally.rows[0].yes),
      no: Number(tally.rows[0].no),
      abstain: Number(tally.rows[0].abstain),
      my_vote: choice,
    });
  } catch (err) {
    console.error('PUT /api/decisions/:id/vote failed: ' + err.message);
    res.status(500).json({ error: 'vote_not_saved' });
  }
});

app.post('/api/decisions/:id/comments', async (req, res) => {
  if (!requireUser(req, res)) return;
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (!body || body.length > 1000) {
    return res.status(400).json({ error: 'A comment is needed, up to 1000 characters.' });
  }
  const params = [req.params.id];
  const filter = demoFilter(req, params);
  try {
    const found = await pool.query(
      `SELECT id FROM decisions WHERE id = $1 AND ${filter}`,
      params);
    if (!found.rows.length) return res.status(404).json({ error: 'not_found' });
    const row = await pool.query(
      `INSERT INTO comments (decision_id, author_id, author_name, body)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [req.params.id, req.user.id, req.user.username || 'Member', body]);
    res.status(201).json({ id: row.rows[0].id });
  } catch (err) {
    console.error('POST /api/decisions/:id/comments failed: ' + err.message);
    res.status(500).json({ error: 'comment_not_posted' });
  }
});

app.delete('/api/comments/:id', async (req, res) => {
  if (!requireUser(req, res)) return;
  try {
    const row = await pool.query(
      'DELETE FROM comments WHERE id = $1 AND author_id = $2 RETURNING id',
      [req.params.id, req.user.id]);
    if (!row.rows.length) return res.status(404).json({ error: 'not_found_or_not_yours' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/comments/:id failed: ' + err.message);
    res.status(500).json({ error: 'not_deleted' });
  }
});

app.post('/api/reports', async (req, res) => {
  if (!requireUser(req, res)) return;
  const kind = req.body.kind;
  const id = Number(req.body.id);
  if ((kind !== 'decision' && kind !== 'comment') || !Number.isInteger(id)) {
    return res.status(400).json({ error: 'bad_report' });
  }
  try {
    // Not on your own posts. The report is recorded and nothing else changes.
    const owner = await pool.query(
      kind === 'decision'
        ? 'SELECT author_id FROM decisions WHERE id = $1'
        : 'SELECT author_id FROM comments WHERE id = $1',
      [id]);
    if (!owner.rows.length) return res.status(404).json({ error: 'not_found' });
    if (String(owner.rows[0].author_id) === String(req.user.id)) {
      return res.status(400).json({ error: 'not_on_your_own' });
    }
    await pool.query(
      `INSERT INTO reports (target_kind, target_id, reporter_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [kind, id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/reports failed: ' + err.message);
    res.status(500).json({ error: 'not_reported' });
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

// ── Boot ─────────────────────────────────────────────────────────────────

async function start() {
  await migrate();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // Stop accepting, drain what is in flight, close the pool, exit.
  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    server.close();
    setTimeout(() => process.exit(0), 3000).unref();
    try { await pool.end(); } catch {}
    process.exit(0);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
