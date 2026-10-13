const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { FeedError, loadFeed } = require('./feeds');
const { seedDemoFor } = require('./demo-feeds');

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

// ── The app's API ─────────────────────────────────────────────────────────
// Everything is scoped to the signed-in user: every query filters by
// feeds.user_id, so no route ever touches another account's rows. Guests may
// GET (they get empty lists); every write is already answered 401 above.

// Staging demo data (?demo=1, staging only): on the viewing account's first
// such request, write the made-up feeds and posts ONCE so the screen shows a
// lived-in list, and let every control work on them for real. Never seeded
// outside staging, and nothing here reads or writes without ?demo=1.
const demoSeeded = new Set();
app.use('/api', async (req, res, next) => {
  if (IS_STAGING && req.query.demo === '1' && req.user && !demoSeeded.has(String(req.user.id))) {
    demoSeeded.add(String(req.user.id));
    try {
      // Awaited: the request that seeds must not answer before the rows exist.
      await seedDemoFor(pool, String(req.user.id), req.now);
    } catch (err) {
      console.warn('demo seed failed: ' + err.message);
    }
  }
  next();
});

const demoFlag = (req) => IS_STAGING && req.query.demo === '1' && !!req.user;

// A route wrapper: anything thrown that is not a deliberate reply becomes a
// 500 with plain words, never a stack trace.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(() => {
  if (!res.headersSent) res.status(500).json({ error: 'That did not work. Try again in a moment.' });
});

const COLOR_COUNT = 6;
const MAX_FEEDS = 100;

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      site_url text,
      color smallint NOT NULL DEFAULT 1 CHECK (color BETWEEN 1 AND 6),
      is_demo boolean NOT NULL DEFAULT false,
      last_checked_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, url)
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS feeds_user_id_idx ON feeds (user_id)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id serial PRIMARY KEY,
      feed_id int NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
      guid text NOT NULL,
      title text NOT NULL,
      link text,
      author text,
      summary text NOT NULL DEFAULT '',
      published_at timestamptz NOT NULL,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (feed_id, guid)
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS posts_feed_published_idx ON posts (feed_id, published_at DESC) WHERE read_at IS NULL');
  await pool.query("COMMENT ON TABLE feeds IS 'staging:private'");
  await pool.query("COMMENT ON TABLE posts IS 'staging:private'");
}

app.get('/api/posts', wrap(async (req, res) => {
  if (!req.user) return res.json({ posts: [], feedCount: 0, failedCount: 0, checkedAt: null, demo: false });
  const userId = String(req.user.id);
  // Demo feeds exist only for the demo view: without ?demo=1 they are
  // invisible, so the plain screen stays whatever the account really has.
  const demoVisible = demoFlag(req) ? '' : ' AND is_demo = false';
  const [posts, feeds] = await Promise.all([
    pool.query(
      `SELECT p.id, p.feed_id, p.title, p.link, p.author, p.summary, p.published_at,
              f.title AS feed_title, f.color
       FROM posts p JOIN feeds f ON f.id = p.feed_id
       WHERE f.user_id = $1 AND p.read_at IS NULL${demoFlag(req) ? '' : ' AND f.is_demo = false'}
       ORDER BY p.published_at DESC
       LIMIT 500`,
      [userId]),
    pool.query(
      `SELECT count(*)::int AS feed_count,
              count(*) FILTER (WHERE last_error IS NOT NULL)::int AS failed_count,
              max(last_checked_at) AS checked_at
       FROM feeds WHERE user_id = $1${demoVisible}`,
      [userId]),
  ]);
  const counts = feeds.rows[0];
  return res.json({
    posts: posts.rows.map((r) => ({
      id: r.id,
      feedId: r.feed_id,
      feedTitle: r.feed_title,
      color: r.color,
      title: r.title,
      link: r.link,
      author: r.author,
      summary: r.summary,
      publishedAt: r.published_at,
    })),
    feedCount: counts.feed_count,
    failedCount: counts.failed_count,
    checkedAt: counts.checked_at,
    demo: demoFlag(req),
  });
}));

app.get('/api/feeds', wrap(async (req, res) => {
  if (!req.user) return res.json({ feeds: [], demo: false });
  const rows = await pool.query(
    `SELECT f.id, f.title, f.url, f.site_url, f.color, f.last_checked_at, f.last_error,
            (SELECT count(*)::int FROM posts p WHERE p.feed_id = f.id AND p.read_at IS NULL) AS unread
     FROM feeds f WHERE f.user_id = $1${demoFlag(req) ? '' : ' AND f.is_demo = false'}
     ORDER BY f.created_at, f.id`,
    [String(req.user.id)]);
  return res.json({
    feeds: rows.rows.map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      siteUrl: r.site_url,
      color: r.color,
      unread: r.unread,
      lastCheckedAt: r.last_checked_at,
      lastError: r.last_error,
    })),
    demo: demoFlag(req),
  });
}));

app.post('/api/feeds', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const userId = String(req.user.id);
  const raw = typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!raw) return res.status(400).json({ error: 'Give the address of a feed or a site.' });
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw;

  const existing = await pool.query('SELECT count(*)::int AS n FROM feeds WHERE user_id = $1', [userId]);
  const feedCount = existing.rows[0].n;
  if (feedCount >= MAX_FEEDS) return res.status(400).json({ error: 'You can follow up to 100 feeds.' });

  let feed;
  try {
    feed = await loadFeed(candidate, { now: req.now });
  } catch (err) {
    if (err instanceof FeedError) return res.status(422).json({ error: err.message });
    throw err;
  }

  const duplicate = await pool.query(
    'SELECT id FROM feeds WHERE user_id = $1 AND url = $2',
    [userId, feed.url]);
  if (duplicate.rows.length) return res.status(409).json({ error: 'You already follow this feed' });

  const color = (feedCount % COLOR_COUNT) + 1;
  const inserted = await pool.query(
    `INSERT INTO feeds (user_id, url, title, site_url, color, last_checked_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, url, site_url, color`,
    [userId, feed.url, feed.title, feed.siteUrl, color, req.now]);
  const row = inserted.rows[0];

  let added = 0;
  for (const item of feed.items) {
    const r = await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, author, summary, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [row.id, item.guid, item.title, item.link, item.author, item.summary, item.publishedAt]);
    added += r.rowCount;
  }
  const unread = await pool.query(
    'SELECT count(*)::int AS n FROM posts WHERE feed_id = $1 AND read_at IS NULL',
    [row.id]);
  return res.status(201).json({
    feed: {
      id: row.id,
      title: row.title,
      url: row.url,
      siteUrl: row.site_url,
      color: row.color,
      unread: unread.rows[0].n,
      lastCheckedAt: req.now,
      lastError: null,
    },
    added,
  });
}));

app.delete('/api/feeds/:id', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number.parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(404).json({ error: 'Feed not found' });
  const deleted = await pool.query(
    'DELETE FROM feeds WHERE id = $1 AND user_id = $2',
    [id, String(req.user.id)]);
  if (!deleted.rowCount) return res.status(404).json({ error: 'Feed not found' });
  return res.json({ ok: true });
}));

app.post('/api/refresh', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const userId = String(req.user.id);
  const feeds = (await pool.query(
    `SELECT id, url, title, is_demo, last_checked_at FROM feeds WHERE user_id = $1`,
    [userId])).rows;
  const now = req.now;
  const due = feeds.filter((f) => !f.is_demo && (!f.last_checked_at || now - f.last_checked_at > 60_000));

  let added = 0;
  const failed = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < due.length) {
      const feed = due[cursor++];
      try {
        const result = await loadFeed(feed.url, { now });
        for (const item of result.items) {
          const r = await pool.query(
            `INSERT INTO posts (feed_id, guid, title, link, author, summary, published_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (feed_id, guid) DO NOTHING`,
            [feed.id, item.guid, item.title, item.link, item.author, item.summary, item.publishedAt]);
          added += r.rowCount;
        }
        await pool.query('UPDATE feeds SET last_checked_at = $2, last_error = NULL WHERE id = $1', [feed.id, now]);
      } catch (err) {
        const message = err instanceof FeedError ? err.message : 'The site did not answer';
        failed.push({ feedId: feed.id, title: feed.title, error: message });
        await pool.query('UPDATE feeds SET last_checked_at = $2, last_error = $3 WHERE id = $1', [feed.id, now, message]);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, due.length) }, worker));

  // Demo feeds never go to the network; a refresh only freshens their time.
  for (const feed of feeds.filter((f) => f.is_demo)) {
    await pool.query('UPDATE feeds SET last_checked_at = $2 WHERE id = $1 AND is_demo', [feed.id, now]);
  }

  // Read posts older than a month are gone: the unread list is the product.
  await pool.query(
    `DELETE FROM posts
     WHERE read_at IS NOT NULL AND read_at < $1 - interval '30 days'
       AND feed_id IN (SELECT id FROM feeds WHERE user_id = $2)`,
    [now, userId]);

  const checkedAt = (await pool.query(
    'SELECT max(last_checked_at) AS at FROM feeds WHERE user_id = $1',
    [userId])).rows[0].at;
  return res.json({ added, checkedAt, failed, demo: demoFlag(req) });
}));

app.post('/api/posts/:id/read', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number.parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(404).json({ error: 'Post not found' });
  const read = req.body && req.body.read !== false;
  const updated = await pool.query(
    `UPDATE posts p SET read_at = $3
     FROM feeds f
     WHERE p.feed_id = f.id AND p.id = $1 AND f.user_id = $2`,
    [id, String(req.user.id), read ? req.now : null]);
  if (!updated.rowCount) return res.status(404).json({ error: 'Post not found' });
  return res.json({ ok: true });
}));

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
      return res.redirect(302, PLATFORM_ORIGIN + '/app/rss-reader/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/rss-reader/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
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
  // Shut down politely: stop taking connections, let the ones in flight
  // finish (three seconds is enough), then close the database pool.
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    setTimeout(() => pool.end().then(() => process.exit(0)), 3000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
