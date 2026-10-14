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
  // Kept raw: the members API below wants the token to ask the platform
  // "who is in this project", as the same signed-in person.
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

// ── Schema (idempotent, on boot) ─────────────────────────────────────────
// Tables are public by default. `reports` is marked staging:private: it
// holds who reported what, personal information another member should not
// see in a staging preview. It carries no foreign keys, so no public table
// points at a private one.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decisions (
      id bigserial PRIMARY KEY,
      author_id text NOT NULL,
      author_username text NOT NULL,
      question text NOT NULL,
      details text,
      created_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz,
      demo boolean NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS votes (
      decision_id bigint NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      choice text NOT NULL CHECK (choice IN ('yes','no')),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (decision_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS comments (
      id bigserial PRIMARY KEY,
      decision_id bigint NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      author_id text NOT NULL,
      author_username text NOT NULL,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      demo boolean NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS reports (
      id bigserial PRIMARY KEY,
      target_type text NOT NULL CHECK (target_type IN ('decision','comment')),
      target_id bigint NOT NULL,
      reporter_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (target_type, target_id, reporter_id)
    );
    COMMENT ON TABLE reports IS 'staging:private';
  `);
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Members: how many people can vote ────────────────────────────────────
// "9 of 12 voted" counts against the project's real member list, from the
// platform's members API with this request's user token. Cached 60 s (the
// endpoint shares its rate limit with /users/*). A 403 (the caller is not
// a member) or any failure answers null and never fails the page.
let membersCache = { at: 0, count: null };
async function memberCount(req) {
  if (!req.user || !process.env.USERNODE_PLATFORM_API_V1_URL) return null;
  if (Date.now() - membersCache.at < 60_000) return membersCache.count;
  try {
    const headers = { 'x-usernode-user-token': req.userToken };
    if (process.env.USERNODE_LLM_PROXY_TOKEN) {
      headers['x-usernode-app-token'] = process.env.USERNODE_LLM_PROXY_TOKEN;
    }
    const resp = await fetch(process.env.USERNODE_PLATFORM_API_V1_URL + '/members?limit=200', { headers });
    const data = await resp.json().catch(() => ({}));
    membersCache = {
      at: Date.now(),
      count: resp.ok && Array.isArray(data.members)
        ? data.members.length + (data.has_more ? 1 : 0)
        : null,
    };
  } catch {
    membersCache = { at: Date.now(), count: null };
  }
  return membersCache.count;
}

// ── Query helpers ────────────────────────────────────────────────────────
// Every read takes the demo flag: answers without demo=1 leave out every
// demo row, decision, comment and vote.
function demoFilter(req) {
  return IS_STAGING && req.query.demo === '1';
}

const DECISION_COLS = `
  d.id, d.author_id, d.author_username, d.question, d.details,
  d.created_at, d.closed_at,
  (SELECT count(*) FROM votes v WHERE v.decision_id = d.id AND v.choice = 'yes') AS yes_count,
  (SELECT count(*) FROM votes v WHERE v.decision_id = d.id AND v.choice = 'no') AS no_count,
  (SELECT v.choice FROM votes v WHERE v.decision_id = d.id AND v.user_id = $1) AS my_vote,
  (SELECT count(*) FROM comments c WHERE c.decision_id = d.id) AS comment_count,
  (SELECT c.author_id FROM comments c WHERE c.decision_id = d.id
     ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS latest_commenter_id,
  (SELECT c.author_username FROM comments c WHERE c.decision_id = d.id
     ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS latest_commenter,
  (d.author_id = $1) AS is_mine
`;

app.get('/api/decisions', async (req, res) => {
  const demo = demoFilter(req);
  await seedDemo(req);
  const uid = req.user ? String(req.user.id) : '';
  const tab = ['open', 'closed', 'mine'].includes(req.query.tab) ? req.query.tab : 'open';
  try {
    const params = [uid];
    let where = demo ? '' : 'WHERE d.demo = false';
    if (tab === 'mine') {
      where += (where ? ' AND' : 'WHERE') + ' d.author_id = $1';
    } else if (tab === 'closed') {
      where += (where ? ' AND' : 'WHERE') + ' d.closed_at IS NOT NULL';
    } else {
      where += (where ? ' AND' : 'WHERE') + ' d.closed_at IS NULL';
    }
    const order = tab === 'closed' ? 'd.closed_at DESC' : 'd.created_at DESC';
    const { rows } = await pool.query(
      `SELECT ${DECISION_COLS} FROM decisions d ${where} ORDER BY ${order} LIMIT 200`,
      params
    );
    const out = rows.map((r) => ({
      id: Number(r.id),
      question: r.question,
      details: r.details || '',
      author_username: r.author_username,
      is_mine: r.author_id === uid,
      created_at: r.created_at,
      closed_at: r.closed_at,
      yes_count: Number(r.yes_count),
      no_count: Number(r.no_count),
      my_vote: r.my_vote,
      comment_count: Number(r.comment_count),
      latest_commenter: r.latest_commenter,
      latest_is_mine: r.latest_commenter_id === uid,
    }));

    // The header counts, whatever tab is showing: how many are open and how
    // many still need this person's vote.
    const headParams = [uid];
    const headWhere = demo ? '' : 'WHERE demo = false';
    const counts = await pool.query(`
      SELECT
        (SELECT count(*) FROM decisions d ${headWhere ? headWhere + ' AND' : 'WHERE'} d.closed_at IS NULL) AS open_count,
        (SELECT count(*) FROM decisions d ${headWhere ? headWhere + ' AND' : 'WHERE'} d.closed_at IS NULL
           AND $1 <> ''
           AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.decision_id = d.id AND v.user_id = $1)) AS waiting_count
    `, headParams);

    // Open tab also carries up to 3 recently closed decisions.
    let recent_closed = [];
    if (tab === 'open') {
      const closed = await pool.query(
        `SELECT ${DECISION_COLS} FROM decisions d
           ${demo ? 'WHERE' : 'WHERE d.demo = false AND'} d.closed_at IS NOT NULL
           ORDER BY d.closed_at DESC LIMIT 3`,
        params
      );
      recent_closed = closed.rows.map((r) => ({
        id: Number(r.id),
        question: r.question,
        author_username: r.author_username,
        is_mine: r.author_id === uid,
        closed_at: r.closed_at,
        yes_count: Number(r.yes_count),
        no_count: Number(r.no_count),
      }));
    }

    res.json({
      demo,
      member_count: demo ? 12 : await memberCount(req),
      open_count: Number(counts.rows[0].open_count),
      waiting_count: Number(counts.rows[0].waiting_count),
      decisions: out,
      recent_closed,
    });
  } catch (err) {
    console.error('GET /api/decisions failed: ' + err.message);
    res.status(500).json({ error: 'could_not_load' });
  }
});

app.get('/api/decisions/:id', async (req, res) => {
  const demo = demoFilter(req);
  await seedDemo(req);
  const uid = req.user ? String(req.user.id) : '';
  try {
    const { rows } = await pool.query(
      `SELECT ${DECISION_COLS} FROM decisions d
         WHERE d.id = $2 ${demo ? '' : 'AND d.demo = false'}`,
      [uid, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const r = rows[0];
    const comments = await pool.query(
      `SELECT c.id, c.author_id, c.author_username, c.body, c.created_at,
              v.choice AS author_vote
         FROM comments c
         LEFT JOIN votes v ON v.decision_id = c.decision_id AND v.user_id = c.author_id
        WHERE c.decision_id = $1
        ORDER BY c.created_at ASC, c.id ASC`,
      [r.id]
    );
    res.json({
      demo,
      member_count: demo ? 12 : await memberCount(req),
      decision: {
        id: Number(r.id),
        question: r.question,
        details: r.details || '',
        author_username: r.author_username,
        is_mine: r.author_id === uid,
        created_at: r.created_at,
        closed_at: r.closed_at,
        yes_count: Number(r.yes_count),
        no_count: Number(r.no_count),
        my_vote: r.my_vote,
      },
      comments: comments.rows.map((c) => ({
        id: Number(c.id),
        author_username: c.author_username,
        is_mine: c.author_id === uid,
        body: c.body,
        created_at: c.created_at,
        author_vote: c.author_vote,
      })),
    });
  } catch (err) {
    console.error('GET /api/decisions/:id failed: ' + err.message);
    res.status(500).json({ error: 'could_not_load' });
  }
});

app.post('/api/decisions', async (req, res) => {
  const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
  const details = typeof req.body.details === 'string' ? req.body.details.trim() : '';
  if (!question || question.length > 200) {
    return res.status(400).json({ error: 'The question needs 1 to 200 characters.' });
  }
  if (details.length > 2000) {
    return res.status(400).json({ error: 'Details can be up to 2000 characters.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO decisions (author_id, author_username, question, details, created_at)
       VALUES ($1, $2, $3, NULLIF($4, ''), $5) RETURNING id`,
      [String(req.user.id), req.user.username, question, details, req.now]
    );
    res.status(201).json({ id: Number(rows[0].id) });
  } catch (err) {
    console.error('POST /api/decisions failed: ' + err.message);
    res.status(500).json({ error: 'could_not_save' });
  }
});

app.put('/api/decisions/:id/vote', async (req, res) => {
  const choice = req.body.choice;
  if (choice !== 'yes' && choice !== 'no' && choice !== null) {
    return res.status(400).json({ error: 'choice must be yes, no or null' });
  }
  try {
    const demo = demoFilter(req);
    const { rows } = await pool.query(
      `SELECT id, author_id, closed_at FROM decisions d
        WHERE d.id = $1 ${demo ? '' : 'AND d.demo = false'}`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].closed_at) return res.status(409).json({ error: 'closed' });
    if (choice === null) {
      await pool.query('DELETE FROM votes WHERE decision_id = $1 AND user_id = $2',
        [req.params.id, String(req.user.id)]);
    } else {
      await pool.query(
        `INSERT INTO votes (decision_id, user_id, choice, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (decision_id, user_id)
         DO UPDATE SET choice = EXCLUDED.choice, updated_at = EXCLUDED.updated_at`,
        [req.params.id, String(req.user.id), choice, req.now]
      );
    }
    const counts = await pool.query(
      `SELECT
         (SELECT count(*) FROM votes WHERE decision_id = $1 AND choice = 'yes') AS yes_count,
         (SELECT count(*) FROM votes WHERE decision_id = $1 AND choice = 'no') AS no_count,
         (SELECT choice FROM votes WHERE decision_id = $1 AND user_id = $2) AS my_vote`,
      [req.params.id, String(req.user.id)]
    );
    res.json({
      yes_count: Number(counts.rows[0].yes_count),
      no_count: Number(counts.rows[0].no_count),
      my_vote: counts.rows[0].my_vote,
    });
  } catch (err) {
    console.error('PUT /api/decisions/:id/vote failed: ' + err.message);
    res.status(500).json({ error: 'could_not_save' });
  }
});

app.post('/api/decisions/:id/close', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, author_id, closed_at FROM decisions WHERE id = $1',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].author_id !== String(req.user.id)) {
      return res.status(403).json({ error: 'not_yours' });
    }
    if (rows[0].closed_at) return res.status(409).json({ error: 'already_closed' });
    await pool.query('UPDATE decisions SET closed_at = $2 WHERE id = $1',
      [req.params.id, req.now]);
    res.json({ closed: true });
  } catch (err) {
    console.error('POST /api/decisions/:id/close failed: ' + err.message);
    res.status(500).json({ error: 'could_not_save' });
  }
});

app.delete('/api/decisions/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, author_id FROM decisions WHERE id = $1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].author_id !== String(req.user.id)) {
      return res.status(403).json({ error: 'not_yours' });
    }
    await pool.query('DELETE FROM decisions WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /api/decisions/:id failed: ' + err.message);
    res.status(500).json({ error: 'could_not_save' });
  }
});

app.post('/api/decisions/:id/comments', async (req, res) => {
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (!body || body.length > 2000) {
    return res.status(400).json({ error: 'A comment needs 1 to 2000 characters.' });
  }
  try {
    const demo = demoFilter(req);
    const { rows } = await pool.query(
      `SELECT id, demo FROM decisions d
        WHERE d.id = $1 ${demo ? '' : 'AND d.demo = false'}`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const { rows: inserted } = await pool.query(
      `INSERT INTO comments (decision_id, author_id, author_username, body, created_at, demo)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [req.params.id, String(req.user.id), req.user.username, body, req.now, rows[0].demo]
    );
    res.status(201).json({ id: Number(inserted[0].id) });
  } catch (err) {
    console.error('POST comments failed: ' + err.message);
    res.status(500).json({ error: 'could_not_save' });
  }
});

app.delete('/api/comments/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, author_id FROM comments WHERE id = $1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    if (rows[0].author_id !== String(req.user.id)) {
      return res.status(403).json({ error: 'not_yours' });
    }
    await pool.query('DELETE FROM comments WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /api/comments/:id failed: ' + err.message);
    res.status(500).json({ error: 'could_not_save' });
  }
});

app.post('/api/reports', async (req, res) => {
  const type = req.body.target_type;
  const id = Number(req.body.target_id);
  if ((type !== 'decision' && type !== 'comment') || !Number.isInteger(id)) {
    return res.status(400).json({ error: 'bad_target' });
  }
  try {
    // One report per person per target; recording it changes nothing on
    // screen beyond "Reported, thanks".
    await pool.query(
      `INSERT INTO reports (target_type, target_id, reporter_id, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [type, id, String(req.user.id), req.now]
    );
    res.json({ reported: true });
  } catch (err) {
    console.error('POST /api/reports failed: ' + err.message);
    res.status(500).json({ error: 'could_not_save' });
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

// ── Staging demo (first version's populated demo) ────────────────────────
// Only on staging and only on a request that carries ?demo=1: the first
// such request from a viewer writes demo rows with fixed ids, so reloads
// change nothing (ON CONFLICT DO NOTHING) and what the viewer did to the
// rows afterwards stays. Everything is marked demo = true and left out of
// every answer without demo=1. Made-up members only; the viewer's own rows
// (one open and two closed decisions, votes on several) belong to the
// account that opened the preview.
const DEMO_MEMBERS = [
  ['staging-demo-mina', 'Mina'],
  ['staging-demo-tomas', 'Tomas'],
  ['staging-demo-priya', 'Priya'],
  ['staging-demo-dev', 'Dev'],
  ['staging-demo-ana', 'Ana'],
];

function demoSeedData(now, uid, uname) {
  const mins = 60_000;
  const A = (id, who, q, det, agoMins, closedAgoMins, demoFlag = true) => ({
    id, author: who, question: q, details: det || '',
    created_at: new Date(now - agoMins * mins),
    closed_at: closedAgoMins == null ? null : new Date(now - closedAgoMins * mins),
    demo: demoFlag,
  });
  const u = { id: uid, name: uname };
  const you = (id, q, det, agoMins, closedAgoMins) => A(id, 'you', q, det, agoMins, closedAgoMins);

  // Open decisions. author: 'mina' | 'tomas' | ... | 'you'
  const decisions = [
    A(9001, 'mina', 'Move Thursday meetings to the library?', '', 2 * 24 * 60),
    you(9002, 'Run a spring tree planting in April?',
      'The parks office has 40 saplings for groups. We would need about 8 people on a Saturday morning.', 24 * 60),
    A(9003, 'tomas', 'Raise dues to $5 a month for supplies?', '', 4 * 60),
    A(9004, 'priya', 'Swap the June outing to the botanical garden?', '', 24 * 60),
    A(9005, 'dev', 'Buy a projector for film nights?', '', 3 * 24 * 60),
    A(9006, 'ana', 'Start meetings 30 minutes later?', '', 6 * 60),
    A(9007, 'mina', 'Chip in $12 each for a shared tool box?', '', 2 * 24 * 60),
    A(9008, 'tomas', 'Enter the neighbourhood parade in September?', '', 5 * 60),
    // Closed decisions: 9 yes 2 no, 4 yes 6 no, 4 yes 4 no, 3 yes 6 no.
    A(9021, 'priya', 'Order pizza for the end-of-term party?', '', 5 * 24 * 60, 24 * 60),
    you(9022, 'Buy a second folding table?', 'We are always short of table space at the spring fair.', 6 * 24 * 60, 2 * 24 * 60),
    you(9023, 'Adopt a second weekly meetup on Tuesdays?', '', 7 * 24 * 60, 3 * 24 * 60),
    A(9024, 'tomas', 'Repaint the clubhouse notice board?', '', 8 * 24 * 60, 4 * 24 * 60),
  ];

  // Votes: [decision, voterName|'you', 'yes'|'no'].
  const votes = [
    // 9001: 7 yes, 2 no (9 of 12 voted), viewer yes.
    [9001, 'you', 'yes'], [9001, 'mina', 'yes'], [9001, 'dev', 'yes'], [9001, 'priya', 'yes'],
    [9001, 'ana', 'yes'], [9001, 'v1', 'yes'], [9001, 'v2', 'yes'], [9001, 'v3', 'no'], [9001, 'v4', 'no'],
    // 9002: 5 yes, 0 no, viewer has not voted.
    [9002, 'mina', 'yes'], [9002, 'dev', 'yes'], [9002, 'ana', 'yes'], [9002, 'v5', 'yes'], [9002, 'v6', 'yes'],
    // 9003: 1 yes, 2 no, viewer no.
    [9003, 'you', 'no'], [9003, 'tomas', 'yes'], [9003, 'v7', 'no'],
    // 9004: 4 yes, 1 no, viewer yes.
    [9004, 'you', 'yes'], [9004, 'priya', 'yes'], [9004, 'ana', 'yes'], [9004, 'v9', 'yes'], [9004, 'v10', 'no'],
    // 9005: 3 yes, 3 no.
    [9005, 'dev', 'yes'], [9005, 'mina', 'yes'], [9005, 'v11', 'yes'],
    [9005, 'tomas', 'no'], [9005, 'priya', 'no'], [9005, 'v12', 'no'],
    // 9006: 2 yes, 4 no.
    [9006, 'ana', 'yes'], [9006, 'v13', 'yes'],
    [9006, 'mina', 'no'], [9006, 'dev', 'no'], [9006, 'v14', 'no'], [9006, 'v15', 'no'],
    // 9007: 5 yes, 1 no.
    [9007, 'mina', 'yes'], [9007, 'priya', 'yes'], [9007, 'ana', 'yes'], [9007, 'v16', 'yes'], [9007, 'v17', 'yes'],
    [9007, 'tomas', 'no'],
    // 9008: 6 yes, 0 no, viewer yes.
    [9008, 'you', 'yes'], [9008, 'tomas', 'yes'], [9008, 'mina', 'yes'], [9008, 'dev', 'yes'],
    [9008, 'priya', 'yes'], [9008, 'v18', 'yes'],
    // Closed: 9021 9 yes 2 no; 9022 4 yes 6 no; 9023 4 yes 4 no; 9024 3 yes 6 no.
    [9021, 'priya', 'yes'], [9021, 'mina', 'yes'], [9021, 'dev', 'yes'], [9021, 'ana', 'yes'], [9021, 'you', 'yes'],
    [9021, 'v19', 'yes'], [9021, 'v20', 'yes'], [9021, 'v21', 'yes'], [9021, 'v22', 'yes'], [9021, 'v23', 'no'], [9021, 'v24', 'no'],
    [9022, 'you', 'no'], [9022, 'tomas', 'yes'], [9022, 'v25', 'yes'], [9022, 'v26', 'yes'], [9022, 'v27', 'yes'],
    [9022, 'v28', 'no'], [9022, 'v29', 'no'], [9022, 'v30', 'no'], [9022, 'v31', 'no'], [9022, 'v32', 'no'],
    [9023, 'you', 'yes'], [9023, 'mina', 'yes'], [9023, 'ana', 'yes'], [9023, 'v33', 'yes'],
    [9023, 'tomas', 'no'], [9023, 'dev', 'no'], [9023, 'v34', 'no'], [9023, 'v35', 'no'],
    [9024, 'tomas', 'yes'], [9024, 'v36', 'yes'], [9024, 'v37', 'yes'],
    [9024, 'mina', 'no'], [9024, 'dev', 'no'], [9024, 'priya', 'no'], [9024, 'ana', 'no'], [9024, 'v38', 'no'], [9024, 'v39', 'no'],
  ];

  // Comments: [decision, authorName|'you', body, minutesAgo]. A few dozen,
  // spread over the decisions; a commenter's vote matches how they voted.
  const comments = [
    [9001, 'dev', 'Good idea, the library room is quieter.', 2 * 24 * 60 - 30],
    [9001, 'mina', 'It has a whiteboard too.', 2 * 24 * 60 - 25],
    [9001, 'ana', 'Does it cost anything to book?', 2 * 24 * 60 - 20],
    [9001, 'mina', 'Free for community groups, I checked.', 2 * 24 * 60 - 15],
    [9001, 'priya', 'Works for me either way.', 24 * 60],
    [9001, 'you', 'Let us try it for a month and see.', 20 * 60],
    [9001, 'dev', 'Last comment before we vote then.', 3 * 60],
    [9002, 'mina', 'I can bring gloves and two spades.', 20 * 60],
    [9002, 'dev', 'Saturday the 12th works for me, the 19th does not.', 18 * 60],
    [9002, 'ana', 'Is there parking near the site?', 3 * 60],
    [9003, 'priya', 'We spent almost nothing last term, why raise it?', 3 * 60],
    [9004, 'priya', 'The rose garden alone is worth it.', 20 * 60],
    [9004, 'dev', 'June 8th or 15th?', 16 * 60],
    [9004, 'ana', 'Either, I will come to both.', 2 * 60],
    [9005, 'dev', 'A used one is about $60 second hand.', 3 * 24 * 60 - 60],
    [9005, 'tomas', 'We could borrow the school\'s.', 3 * 24 * 60 - 50],
    [9005, 'mina', 'They said no, I asked.', 2 * 24 * 60],
    [9005, 'priya', '$60 split twelve ways is nothing.', 24 * 60],
    [9006, 'ana', 'The later slot suits people who work.', 5 * 60],
    [9006, 'tomas', 'Then we run past 9, fine by me.', 4 * 60],
    [9007, 'mina', 'List of what we would buy first?', 2 * 24 * 60 - 100],
    [9007, 'priya', 'A cordless drill, I would say.', 24 * 60],
    [9008, 'tomas', 'We could wear the club shirts.', 4 * 60],
    [9021, 'dev', 'Pepperoni and veggie, two of each.', 2 * 24 * 60],
    [9021, 'ana', 'One gluten free please.', 2 * 24 * 60 - 30],
    [9021, 'priya', 'Ordered, it comes at 8.', 24 * 60],
    [9022, 'tomas', 'We managed last year with one.', 5 * 24 * 60],
    [9022, 'dev', 'Last year we ate on our knees.', 4 * 24 * 60],
    [9023, 'mina', 'Two nights a week is a lot for some of us.', 6 * 24 * 60],
    [9023, 'ana', 'I liked the idea but I am out most Tuesdays.', 5 * 24 * 60],
    [9023, 'dev', 'Dead even then, maybe revisit in autumn.', 4 * 24 * 60],
    [9024, 'tomas', 'The paint is donated, we only need brushes.', 7 * 24 * 60],
  ];

  return { decisions, votes, comments, members: DEMO_MEMBERS };
}

let demoSeeded = false;
async function seedDemo(req) {
  if (!IS_STAGING || req.query.demo !== '1' || demoSeeded || !req.user) return;
  const uid = String(req.user.id);
  const now = req.now.getTime();
  const data = demoSeedData(now, uid, req.user.username);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One writer at a time; a second viewer's seed is a no-op.
    await client.query('SELECT pg_advisory_xact_lock(720011)');
    const done = await client.query('SELECT 1 FROM decisions WHERE id = 9001');
    if (!done.rowCount) {
      const who = {};
      data.members.forEach(([id, name]) => { who[id.replace('staging-demo-', '')] = name; });
      for (const d of data.decisions) {
        const isYou = d.author === 'you';
        await client.query(
          `INSERT INTO decisions (id, author_id, author_username, question, details, created_at, closed_at, demo)
           VALUES ($1,$2,$3,$4,NULLIF($5,''),$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
          [d.id, isYou ? uid : 'staging-demo-' + d.author,
            isYou ? req.user.username : who[d.author],
            d.question, d.details, d.created_at, d.closed_at, d.demo]
        );
      }
      for (const [dec, voter, choice] of data.votes) {
        await client.query(
          `INSERT INTO votes (decision_id, user_id, choice, updated_at)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [dec, voter === 'you' ? uid : 'staging-demo-' + voter, choice, new Date(now)]
        );
      }
      let n = 90001;
      for (const [dec, author, body, ago] of data.comments) {
        await client.query(
          `INSERT INTO comments (id, decision_id, author_id, author_username, body, created_at, demo)
           VALUES ($1,$2,$3,$4,$5,$6,true) ON CONFLICT (id) DO NOTHING`,
          [n++, dec, author === 'you' ? uid : 'staging-demo-' + author,
            author === 'you' ? req.user.username : who[author], body,
            new Date(now - ago * 60_000)]
        );
      }
    }
    await client.query('COMMIT');
    demoSeeded = true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('demo seed failed: ' + err.message);
  } finally {
    client.release();
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────
let server = null;
let shuttingDown = false;

async function start() {
  await ensureSchema();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

// Stop accepting, drain about 3 s, close the pool, exit.
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('Shutting down');
  if (server) server.close(() => console.log('Connections closed'));
  await new Promise((r) => setTimeout(r, 3000));
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(err => { console.error(err); process.exit(1); });
