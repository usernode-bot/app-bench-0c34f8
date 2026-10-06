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

// ── Tier List ─────────────────────────────────────────────────────────────
// One shared board. `items` are the things being ranked; `placements` are
// append-only votes: one row per save, and the row with the highest `id`
// per (item, person) is that person's tier. Nothing is updated or deleted,
// so a change of mind is just a newer row.
const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];
const MAX_NAME = 120;

// Add a thing to rank, for everyone. Names are trimmed, capped, and unique
// case-insensitively: two "Gott's Rd." entries would only confuse the board.
app.post('/api/items', async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Give the item a name first.' });
    if (name.length > MAX_NAME) {
      return res.status(400).json({ error: 'Item names are capped at 120 characters.' });
    }
    const dup = await pool.query(
      'SELECT 1 FROM items WHERE lower(name) = lower($1)',
      [name]
    );
    if (dup.rowCount > 0) return res.status(409).json({ error: 'duplicate' });
    const { rows } = await pool.query(
      `INSERT INTO items (name, created_by, created_by_name)
       VALUES ($1, $2, $3)
       RETURNING id, name, created_by_name`,
      [name, req.user.id, req.user.username]
    );
    res.status(201).json({ item: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Place an item in a tier, for you. Saving inserts a new row; your latest
// row is the one that counts.
app.post('/api/placements', async (req, res) => {
  try {
    const itemId = Number.parseInt(req.body?.item_id, 10);
    const tier = req.body?.tier;
    if (!TIERS.includes(tier)) return res.status(400).json({ error: 'Unknown tier.' });
    if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'Unknown item.' });
    const item = await pool.query('SELECT 1 FROM items WHERE id = $1', [itemId]);
    if (item.rowCount === 0) return res.status(400).json({ error: 'Unknown item.' });
    await pool.query(
      `INSERT INTO placements (item_id, user_id, username, tier)
       VALUES ($1, $2, $3, $4)`,
      [itemId, req.user.id, req.user.username, tier]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The whole board in one read: every item, your placement on it, everyone's
// latest placement, and the crowd tier. Open to guests, who read only.
app.get('/api/board', async (req, res) => {
  try {
    const userId = req.user ? req.user.id : null;
    const { rows: itemRows } = await pool.query(
      'SELECT id, name, created_by_name FROM items ORDER BY id'
    );
    // Latest row per (item, person). Ordering by `id`, never `created_at`:
    // the row sequence decides what shows, so the time source cannot.
    const { rows: latest } = await pool.query(`
      WITH latest AS (
        SELECT DISTINCT ON (item_id, user_id) item_id, user_id, username, tier, id
        FROM placements
        ORDER BY item_id, user_id, id DESC
      )
      SELECT item_id, user_id, username, tier FROM latest
      ORDER BY item_id, id
    `);
    const byItem = new Map();
    for (const row of latest) {
      if (!byItem.has(row.item_id)) byItem.set(row.item_id, []);
      byItem.get(row.item_id).push(row);
    }
    const items = itemRows.map((item) => {
      const votes = byItem.get(item.id) || [];
      const tally = {};
      for (const t of TIERS) tally[t] = 0;
      for (const v of votes) tally[v.tier] += 1;
      // Walking TIERS top down and requiring a strictly greater count means
      // a tie keeps the higher tier (S beats A beats B, and so on).
      let crowd = null;
      for (const t of TIERS) {
        if (tally[t] > 0 && (!crowd || tally[t] > tally[crowd])) crowd = t;
      }
      const mine = userId == null ? null : votes.find((v) => v.user_id === userId);
      return {
        id: item.id,
        name: item.name,
        created_by_name: item.created_by_name,
        your_tier: mine ? mine.tier : null,
        crowd: crowd ? { tier: crowd, votes: tally[crowd] } : { tier: null, votes: 0 },
        votes: tally,
        people: votes.map((v) => ({ username: v.username, tier: v.tier })),
      };
    });
    res.json({ can_rank: !!req.user, you: req.user ? req.user.username : null, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      created_by INTEGER,
      created_by_name VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS placements (
      id SERIAL PRIMARY KEY,
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      username VARCHAR(255) NOT NULL,
      tier VARCHAR(1) NOT NULL CHECK (tier IN ('S', 'A', 'B', 'C', 'D', 'F')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS placements_item_user_id_idx
    ON placements (item_id, user_id, id)
  `);

  // Staging seed: obviously fake restaurants and fake diners (user ids
  // 9001-9005, no real user), so a fresh staging database shows a populated
  // board. Idempotent — each check runs before its insert. Mission Wrap Lab
  // carries the deliberate C/D tie, which the higher-tier rule settles to C;
  // Fog Harbor Diner has no votes, so the crowd tray and the No-votes-yet
  // paths can be seen too.
  if (IS_STAGING) {
    const seedItems = [
      'Birch & Vine',
      'Cafe Terra',
      'The Rolling Scone',
      'Golden Gate Grill',
      'Mission Wrap Lab',
      'Fog Harbor Diner',
    ];
    for (const name of seedItems) {
      await pool.query(
        `INSERT INTO items (name, created_by, created_by_name)
         SELECT $1::varchar(120), NULL, 'Demo diner'
         WHERE NOT EXISTS (SELECT 1 FROM items WHERE lower(name) = lower($1::text))`,
        [name]
      );
    }
    const seedPlacements = [
      ['Birch & Vine', 9001, 'Demo diner', 'S'],
      ['Birch & Vine', 9002, 'Demo taster', 'S'],
      ['Cafe Terra', 9003, 'Demo critic', 'A'],
      ['Cafe Terra', 9004, 'Demo chef', 'A'],
      ['The Rolling Scone', 9002, 'Demo taster', 'A'],
      ['The Rolling Scone', 9003, 'Demo critic', 'B'],
      ['The Rolling Scone', 9001, 'Demo diner', 'A'],
      ['Golden Gate Grill', 9004, 'Demo chef', 'B'],
      ['Golden Gate Grill', 9005, 'Demo guest', 'B'],
      ['Golden Gate Grill', 9002, 'Demo taster', 'A'],
      ['Mission Wrap Lab', 9001, 'Demo diner', 'C'],
      ['Mission Wrap Lab', 9003, 'Demo critic', 'D'],
    ];
    for (const [itemName, userId, username, tier] of seedPlacements) {
      await pool.query(
        `INSERT INTO placements (item_id, user_id, username, tier)
         SELECT i.id, $2, $3, $4
         FROM items i
         WHERE lower(i.name) = lower($1)
           AND NOT EXISTS (
             SELECT 1 FROM placements p WHERE p.item_id = i.id AND p.user_id = $2
           )`,
        [itemName, userId, username, tier]
      );
    }
  }

  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // The platform stops the container with SIGTERM (Ctrl-C sends SIGINT):
  // stop accepting connections, let in-flight ones drain for a few seconds,
  // close the pool and exit.
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      try { await pool.end(); } catch {}
      process.exit(0);
    });
    // Don't hang past the platform's stop window if a connection stalls.
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
