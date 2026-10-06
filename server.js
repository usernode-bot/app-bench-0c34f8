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

// Set true by the shutdown handler below; /health answers 503 from then on
// so anything polling readiness sees the container leaving rotation.
let shuttingDown = false;

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'draining' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Tier List ────────────────────────────────────────────────────────────────
// Two public tables. `votes` is append-only: placing again inserts a new
// row, and the latest row per (user_id, item_id) is the placement that
// counts. `reports` is staging:private — schema only in staging, no seed
// rows — and one report hides a thing from the board.

const TIERS = ['S', 'A', 'B', 'C', 'D'];

// The crowd's tier for a tally: the tier most people picked, ties resolved
// to the higher tier (S over A over B over C over D), null with no votes.
// Walking TIERS in order and only replacing on a strictly larger count does
// the tie-break for free.
function crowdTier(tally) {
  let best = null;
  let bestCount = 0;
  for (const tier of TIERS) {
    if (tally[tier] > bestCount) {
      best = tier;
      bestCount = tally[tier];
    }
  }
  return best;
}

// Shape one item for the client: the per-tier tally from each person's
// latest vote, the crowd's tier and the voters' rows (username denormalised
// onto the vote, so no join). `votes` arrives newest first.
function shapeItem(item, votes) {
  const tally = { S: 0, A: 0, B: 0, C: 0, D: 0 };
  for (const v of votes) tally[v.tier] += 1;
  const crowd = crowdTier(tally);
  return {
    id: item.id,
    name: item.name,
    username: item.username,
    created_at: item.created_at,
    tally,
    votes: votes.length,
    crowdTier: crowd,
    crowdCount: crowd ? tally[crowd] : 0,
    voters: votes.map((v) => ({ username: v.username, tier: v.tier })),
  };
}

// Every person's latest vote on one thing, most recent first.
async function latestVotesForItem(itemId) {
  const { rows } = await pool.query(`
    SELECT user_id, username, tier, created_at, id FROM (
      SELECT DISTINCT ON (user_id) user_id, username, tier, created_at, id
      FROM votes
      WHERE item_id = $1
      ORDER BY user_id, created_at DESC, id DESC
    ) latest
    ORDER BY created_at DESC, id DESC
  `, [itemId]);
  return rows;
}

// All things with their tallies. Guests may read this too, so nothing here
// assumes req.user. Reported things are hidden from the board (their report
// rows are kept for review later).
app.get('/api/items', async (_req, res) => {
  try {
    const items = await pool.query(`
      SELECT id, name, username, created_at
      FROM items
      WHERE NOT EXISTS (SELECT 1 FROM reports WHERE reports.item_id = items.id)
      ORDER BY created_at ASC, id ASC
    `);
    const votes = await pool.query(`
      SELECT DISTINCT ON (item_id, user_id) item_id, user_id, username, tier, created_at, id
      FROM votes
      ORDER BY item_id, user_id, created_at DESC, id DESC
    `);
    const byItem = new Map();
    for (const v of votes.rows) {
      if (!byItem.has(v.item_id)) byItem.set(v.item_id, []);
      byItem.get(v.item_id).push(v);
    }
    res.json({ items: items.rows.map((i) => shapeItem(i, byItem.get(i.id) || [])) });
  } catch (err) {
    console.error('GET /api/items failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// The viewer's latest placement per thing. Guests get an empty list.
app.get('/api/votes', async (req, res) => {
  if (!req.user) return res.json({ votes: [] });
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT ON (item_id) item_id, tier
      FROM votes
      WHERE user_id = $1
      ORDER BY item_id, created_at DESC, id DESC
    `, [req.user.id]);
    res.json({ votes: rows.map((r) => ({ item_id: r.item_id, tier: r.tier })) });
  } catch (err) {
    console.error('GET /api/votes failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Add a thing: it appears for the whole group, unplaced.
app.post('/api/items', async (req, res) => {
  const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (name.length < 1 || name.length > 120) {
    return res.status(400).json({ error: 'A thing needs a name of 1 to 120 characters.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO items (name, user_id, username) VALUES ($1, $2, $3)
       RETURNING id, name, username, created_at`,
      [name, req.user.id, req.user.username]
    );
    res.status(201).json({ item: shapeItem(rows[0], []) });
  } catch (err) {
    console.error('POST /api/items failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Place a thing in a tier: your vote. Placing again replaces it — a new row
// is appended and the latest one wins.
app.post('/api/votes', async (req, res) => {
  const itemId = Number(req.body && req.body.item);
  const tier = req.body && req.body.tier;
  if (!TIERS.includes(tier)) {
    return res.status(400).json({ error: 'Pick a tier from S to D.' });
  }
  if (!Number.isInteger(itemId)) {
    return res.status(404).json({ error: 'No such thing.' });
  }
  try {
    const found = await pool.query(`
      SELECT id, name, username, created_at FROM items
      WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM reports WHERE reports.item_id = items.id)
    `, [itemId]);
    if (found.rowCount === 0) return res.status(404).json({ error: 'No such thing.' });
    await pool.query(
      `INSERT INTO votes (item_id, user_id, username, tier) VALUES ($1, $2, $3, $4)`,
      [itemId, req.user.id, req.user.username, tier]
    );
    res.json({ item: shapeItem(found.rows[0], await latestVotesForItem(itemId)) });
  } catch (err) {
    console.error('POST /api/votes failed:', err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// Report a thing: it leaves the board for everyone; the report row is kept
// so it can be reviewed later (no moderation surface in this version).
app.post('/api/items/:id/report', async (req, res) => {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId)) return res.status(404).json({ error: 'No such thing.' });
  try {
    const found = await pool.query(`SELECT id FROM items WHERE id = $1`, [itemId]);
    if (found.rowCount === 0) return res.status(404).json({ error: 'No such thing.' });
    await pool.query(
      `INSERT INTO reports (item_id, user_id, username) VALUES ($1, $2, $3)`,
      [itemId, req.user.id, req.user.username]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/items/:id/report failed:', err.message);
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

async function start() {
  // Schema, applied idempotently on boot. `items` and `votes` are public;
  // `reports` is marked staging:private so staging copies its schema only,
  // never its rows.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS votes (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id),
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      tier VARCHAR(1) NOT NULL CHECK (tier IN ('S','A','B','C','D')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // The latest-vote-per-person queries scan by thing and person.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS votes_item_user_recent_idx
    ON votes (item_id, user_id, created_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id),
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`COMMENT ON TABLE reports IS 'staging:private'`);

  // Staging seed: obviously fake Bay Area restaurants and three fake
  // voters whose placements disagree, so the crowd view differs from any
  // one person's view and every tier holds a chip. Idempotent on the
  // "Staging demo %" name prefix; never references a real user; no reports.
  if (IS_STAGING) {
    try {
      const seeded = await pool.query(
        `SELECT 1 FROM items WHERE name LIKE 'Staging demo %' LIMIT 1`
      );
      if (seeded.rowCount === 0) {
        const people = {
          ana: { id: 990001, username: 'staging-demo-ana' },
          bru: { id: 990002, username: 'staging-demo-bru' },
          che: { id: 990003, username: 'staging-demo-che' },
        };
        const names = [
          'Staging demo Taqueria', 'Staging demo Ramen Shop',
          'Staging demo Bagel Stand', 'Staging demo Pizza Truck',
          'Staging demo Pho Kitchen', 'Staging demo Diner',
          'Staging demo Gelato Cart', 'Staging demo Falafel Window',
        ];
        const adders = ['ana', 'bru', 'ana', 'che', 'bru', 'ana', 'che', 'bru'];
        const ids = {};
        for (let i = 0; i < names.length; i++) {
          const who = people[adders[i]];
          const row = await pool.query(
            `INSERT INTO items (name, user_id, username, created_at)
             VALUES ($1, $2, $3, NOW() - ($4::text || ' minutes')::interval)
             RETURNING id`,
            [names[i], who.id, who.username, String(names.length - i)]
          );
          ids[names[i]] = row.rows[0].id;
        }
        // [thing, person, tier, minutes ago]. An earlier row for the same
        // person is a placement they later changed; the latest one wins.
        const votes = [
          ['Staging demo Taqueria', 'bru', 'B', 260],
          ['Staging demo Taqueria', 'ana', 'S', 250],
          ['Staging demo Taqueria', 'che', 'A', 240],
          ['Staging demo Taqueria', 'bru', 'S', 230],
          ['Staging demo Ramen Shop', 'che', 'C', 220],
          ['Staging demo Ramen Shop', 'ana', 'A', 210],
          ['Staging demo Ramen Shop', 'bru', 'A', 200],
          ['Staging demo Ramen Shop', 'che', 'S', 190],
          ['Staging demo Bagel Stand', 'ana', 'C', 180],
          ['Staging demo Bagel Stand', 'bru', 'B', 170],
          ['Staging demo Bagel Stand', 'che', 'B', 160],
          ['Staging demo Bagel Stand', 'ana', 'A', 150],
          ['Staging demo Pizza Truck', 'bru', 'S', 140],
          ['Staging demo Pizza Truck', 'ana', 'B', 130],
          ['Staging demo Pizza Truck', 'che', 'B', 120],
          ['Staging demo Pho Kitchen', 'bru', 'C', 110],
          ['Staging demo Pho Kitchen', 'ana', 'B', 100],
          ['Staging demo Pho Kitchen', 'che', 'C', 90],
          ['Staging demo Diner', 'che', 'C', 80],
          ['Staging demo Diner', 'ana', 'D', 70],
          ['Staging demo Diner', 'bru', 'D', 60],
        ];
        for (const [name, who, tier, minsAgo] of votes) {
          const v = people[who];
          await pool.query(
            `INSERT INTO votes (item_id, user_id, username, tier, created_at)
             VALUES ($1, $2, $3, $4, NOW() - ($5::text || ' minutes')::interval)`,
            [ids[name], v.id, v.username, tier, String(minsAgo)]
          );
        }
      }
    } catch (err) {
      console.error('staging seed failed:', err.message);
    }
  }

  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // The platform stops each container with SIGTERM and a bounded grace
  // period. Stop accepting connections, drain in-flight requests under a
  // hard deadline, close the pool, exit. Idempotent: a repeat signal during
  // the drain must not run a second teardown.
  const DRAIN_MS = 3000;
  let shutdown = async (signal) => {
    shuttingDown = true;
    shutdown = () => {};
    console.log(`[shutdown] ${signal} received, draining`);
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
    try {
      await pool.end();
    } catch (e) {
      console.error('[shutdown] pool.end failed:', e.message);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
