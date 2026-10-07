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

// Set once the shutdown handler starts draining; /health answers 503 from
// then on so readiness polling sees the container leaving rotation.
let shuttingDown = false;

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

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Tier List API ─────────────────────────────────────────────────────────
// One shared board. items are the things to rank, votes are one per person
// per thing (upserted), item_reports hide a thing once 3 different people
// have reported it. Hidden rows are never returned anywhere.

const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];
const TIER_RANK = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5 };

// The tier most people picked; a tie goes to the higher tier (S beats A).
function crowdTierOf(votes) {
  const counts = new Map();
  for (const v of votes) counts.set(v.tier, (counts.get(v.tier) || 0) + 1);
  let best = null;
  for (const t of TIERS) {
    if (counts.has(t) && (best === null || counts.get(t) > counts.get(best))) best = t;
  }
  return best;
}

function positiveInt(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Sort: best tier first, then username.
function byTierThenName(a, b) {
  return (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || a.username.localeCompare(b.username);
}

app.get('/api/board', async (req, res) => {
  const viewerId = req.user ? req.user.id : null;
  try {
    // Guests may read; `viewerId` stays null for them, so they get no
    // myTier and nothing they "reported" (they can't) is filtered.
    const params = viewerId !== null ? [viewerId] : [];
    const notReportedByViewer = viewerId !== null
      ? 'AND NOT EXISTS (SELECT 1 FROM item_reports r WHERE r.item_id = i.id AND r.user_id = $1)'
      : '';
    const items = await pool.query(
      `SELECT id, name, created_by_username FROM items i
       WHERE i.hidden_at IS NULL ${notReportedByViewer}
       ORDER BY i.created_at, i.id`,
      params
    );
    const ids = items.rows.map(r => r.id);
    const votesByItem = new Map();
    if (ids.length) {
      const votes = await pool.query(
        'SELECT item_id, user_id, username, tier FROM votes WHERE item_id = ANY($1::int[])',
        [ids]
      );
      for (const v of votes.rows) {
        if (!votesByItem.has(v.item_id)) votesByItem.set(v.item_id, []);
        votesByItem.get(v.item_id).push(v);
      }
    }
    res.json({
      me: req.user ? { id: req.user.id, username: req.user.username } : null,
      items: items.rows.map(r => {
        const votes = (votesByItem.get(r.id) || []).sort(byTierThenName);
        const mine = viewerId !== null ? votes.find(v => v.user_id === viewerId) : null;
        return {
          id: r.id,
          name: r.name,
          createdBy: r.created_by_username,
          myTier: mine ? mine.tier : null,
          crowdTier: crowdTierOf(votes),
          voteCount: votes.length,
          votes: votes.map(v => ({
            username: v.username,
            tier: v.tier,
            isMe: viewerId !== null && v.user_id === viewerId,
          })),
        };
      }),
    });
  } catch (err) {
    console.error('GET /api/board failed: ' + err.message);
    res.status(500).json({ error: 'board_failed' });
  }
});

app.post('/api/items', async (req, res) => {
  const raw = req.body && typeof req.body.name === 'string' ? req.body.name : '';
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name) return res.status(400).json({ error: 'name_required' });
  if (name.length > 60) return res.status(400).json({ error: 'name_too_long' });
  try {
    const result = await pool.query(
      `INSERT INTO items (name, created_by_id, created_by_username)
       VALUES ($1, $2, $3)
       RETURNING id, name, created_by_username`,
      [name, req.user.id, req.user.username]
    );
    const r = result.rows[0];
    res.status(201).json({
      id: r.id,
      name: r.name,
      createdBy: r.created_by_username,
      myTier: null,
      crowdTier: null,
      voteCount: 0,
      votes: [],
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'duplicate' });
    console.error('POST /api/items failed: ' + err.message);
    res.status(500).json({ error: 'item_failed' });
  }
});

app.put('/api/items/:id/vote', async (req, res) => {
  const id = positiveInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad_id' });
  const tier = req.body ? req.body.tier : undefined;
  if (!TIERS.includes(tier)) return res.status(400).json({ error: 'bad_tier' });
  try {
    const found = await pool.query(
      'SELECT id FROM items WHERE id = $1 AND hidden_at IS NULL',
      [id]
    );
    if (!found.rowCount) return res.status(404).json({ error: 'not_found' });
    // One vote per person per thing; ranking again replaces it (and the
    // stored username, so a rename shows up on their next vote).
    await pool.query(
      `INSERT INTO votes (item_id, user_id, username, tier)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (item_id, user_id)
       DO UPDATE SET tier = EXCLUDED.tier, username = EXCLUDED.username, updated_at = now()`,
      [id, req.user.id, req.user.username, tier]
    );
    res.status(204).end();
  } catch (err) {
    console.error('PUT /api/items/:id/vote failed: ' + err.message);
    res.status(500).json({ error: 'vote_failed' });
  }
});

app.delete('/api/items/:id/vote', async (req, res) => {
  const id = positiveInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad_id' });
  try {
    await pool.query('DELETE FROM votes WHERE item_id = $1 AND user_id = $2', [id, req.user.id]);
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/items/:id/vote failed: ' + err.message);
    res.status(500).json({ error: 'vote_failed' });
  }
});

app.post('/api/items/:id/report', async (req, res) => {
  const id = positiveInt(req.params.id);
  if (id === null) return res.status(400).json({ error: 'bad_id' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      'SELECT id FROM items WHERE id = $1 AND hidden_at IS NULL FOR UPDATE',
      [id]
    );
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not_found' });
    }
    await client.query(
      'INSERT INTO item_reports (item_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, req.user.id]
    );
    const count = await client.query(
      'SELECT count(*)::int AS n FROM item_reports WHERE item_id = $1',
      [id]
    );
    if (count.rows[0].n >= 3) {
      await client.query('UPDATE items SET hidden_at = now() WHERE id = $1', [id]);
    }
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/items/:id/report failed: ' + err.message);
    res.status(500).json({ error: 'report_failed' });
  } finally {
    client.release();
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
      return res.redirect(302, PLATFORM_ORIGIN + '/app/tier-list/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/tier-list/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Schema, applied idempotently on boot ──────────────────────────────────
// `items` and `votes` are public (board content every viewer already sees).
// `item_reports` is staging:private — who reported what is one person's
// moderation action, not board content. Private tables may reference public
// ones, never the reverse.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id serial PRIMARY KEY,
      name text NOT NULL,
      created_by_id text NOT NULL,
      created_by_username text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      hidden_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS items_live_name_key
      ON items (lower(name)) WHERE hidden_at IS NULL;
    CREATE TABLE IF NOT EXISTS votes (
      item_id int REFERENCES items ON DELETE CASCADE,
      user_id text,
      username text NOT NULL,
      tier char(1) NOT NULL CHECK (tier IN ('S','A','B','C','D','F')),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (item_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS item_reports (
      item_id int REFERENCES items ON DELETE CASCADE,
      user_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (item_id, user_id)
    );
    COMMENT ON TABLE item_reports IS 'staging:private';
  `);
}

// Staging previews start from an empty database; seed seven obviously fake
// Bay Area spots and votes from three made-up people so the populated board
// can be seen. Production gets no seed. Ids sit far above the serial
// sequence so real inserts never collide.
async function seedStaging() {
  if (!IS_STAGING) return;
  const items = [
    [900001, 'Staging demo taco truck'],
    [900002, 'Staging demo ramen bar'],
    [900003, 'Staging demo dim sum spot'],
    [900004, 'Staging demo burrito place'],
    [900005, 'Staging demo pizza slice shop'],
    [900006, 'Staging demo boba stand'],
    [900007, 'Staging demo bakery'],
  ];
  for (const [id, name] of items) {
    await pool.query(
      `INSERT INTO items (id, name, created_by_id, created_by_username)
       VALUES ($1, $2, 'staging-demo-1', 'staging-demo-ana')
       ON CONFLICT DO NOTHING`,
      [id, name]
    );
  }
  // Crowd should read: taco truck S, ramen bar A, dim sum B, boba stand B,
  // burrito C, pizza slice F, bakery unvoted.
  const votes = [
    [900001, 'staging-demo-1', 'staging-demo-ana', 'S'],
    [900001, 'staging-demo-2', 'staging-demo-ben', 'S'],
    [900001, 'staging-demo-3', 'staging-demo-cy', 'A'],
    [900002, 'staging-demo-1', 'staging-demo-ana', 'A'],
    [900002, 'staging-demo-2', 'staging-demo-ben', 'A'],
    [900002, 'staging-demo-3', 'staging-demo-cy', 'B'],
    [900003, 'staging-demo-1', 'staging-demo-ana', 'B'],
    [900003, 'staging-demo-2', 'staging-demo-ben', 'B'],
    [900004, 'staging-demo-1', 'staging-demo-ana', 'C'],
    [900004, 'staging-demo-2', 'staging-demo-ben', 'C'],
    [900005, 'staging-demo-1', 'staging-demo-ana', 'F'],
    [900005, 'staging-demo-2', 'staging-demo-ben', 'F'],
    [900006, 'staging-demo-1', 'staging-demo-ana', 'B'],
    [900006, 'staging-demo-2', 'staging-demo-ben', 'B'],
  ];
  for (const [itemId, userId, username, tier] of votes) {
    await pool.query(
      `INSERT INTO votes (item_id, user_id, username, tier) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [itemId, userId, username, tier]
    );
  }
}

// ── Boot and graceful shutdown ────────────────────────────────────────────
// Schema and seed finish before the app accepts traffic.

let server = null;

ensureSchema()
  .then(seedStaging)
  .then(() => new Promise((resolve) => {
    server = app.listen(port, () => {
      console.log(`Listening on :${port}`);
      resolve();
    });
    // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
    server.keepAliveTimeout = 75_000;
  }))
  .catch(err => { console.error(err); process.exit(1); });

const DRAIN_MS = 3000;

async function shutdown(signal) {
  if (shuttingDown) return; // idempotent: SIGTERM then SIGINT must not double-run
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (server) {
    server.close(() => {});
    if (server.closeIdleConnections) server.closeIdleConnections();
    const t = setTimeout(() => {
      if (server.closeAllConnections) server.closeAllConnections();
    }, DRAIN_MS);
    t.unref();
  }
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
