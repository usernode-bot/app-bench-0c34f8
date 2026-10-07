const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const feedParse = require('./feed-parse');

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

// Set while the shutdown handler is draining; /health answers 503 so
// readiness polls see the container leaving rotation.
let shuttingDown = false;
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
  if (shuttingDown) return res.status(503).json({ status: 'shutting-down' });
  res.json({ status: 'ok' });
});

// ── The reader: feeds and posts ──────────────────────────────────────────
//
// Each person's feeds are personal, so both tables are marked
// 'staging:private': a stranger opening a staging preview sees the schema
// but never the rows. Both are private, so the foreign key between them is
// allowed. Applied idempotently on boot.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id          bigserial PRIMARY KEY,
      user_id     text NOT NULL,
      url         text NOT NULL,
      title       text NOT NULL,
      site_url    text,
      last_error  text,
      fetched_at  timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url_idx ON feeds (user_id, url);
    CREATE TABLE IF NOT EXISTS posts (
      id            bigserial PRIMARY KEY,
      feed_id       bigint NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid          text NOT NULL,
      title         text NOT NULL,
      url           text,
      content_html  text NOT NULL DEFAULT '',
      published_at  timestamptz,
      read_at       timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      UNIQUE (feed_id, guid)
    );
    COMMENT ON TABLE feeds IS 'staging:private';
    COMMENT ON TABLE posts IS 'staging:private';
  `);
}

// Store a parsed feed's items, skipping ones already stored. `guid` falls
// back to the item's link, then a hash of its title, so re-fetching the
// same feed does not duplicate rows.
const MAX_ITEMS_PER_FETCH = 100;

async function insertPosts(feedId, items) {
  for (const item of items.slice(0, MAX_ITEMS_PER_FETCH)) {
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, url, content_html, published_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedId, item.guid, item.title, item.url, item.contentHtml, item.publishedAt]);
  }
}

async function refreshFeed(feedRow, now) {
  // A feed that fails must not break the pass: its error is recorded and
  // its already-stored posts keep showing.
  try {
    const parsed = await feedParse.fetchFeed(feedRow.url);
    await insertPosts(feedRow.id, parsed.items);
    await pool.query(
      'UPDATE feeds SET title = $2, site_url = $3, last_error = NULL, fetched_at = $4 WHERE id = $1',
      [feedRow.id, parsed.title, parsed.siteUrl, now]);
  } catch (err) {
    await pool.query(
      'UPDATE feeds SET last_error = $2, fetched_at = $3 WHERE id = $1',
      [feedRow.id, err.message, now]);
  }
}

// Who is signed in, asked plainly: a guest gets { guest: true } rather than
// a 401, so the page can skip its write calls instead of popping the
// make-an-account sheet on load.
app.get('/api/me', (req, res) => {
  if (req.user) return res.json({ user: { id: req.user.id, username: req.user.username || null } });
  res.json({ guest: true });
});

// ── Staging demo data (request-time, behind ?demo=1) ─────────────────────
//
// The feeds and posts tables are private, so a fresh staging preview starts
// empty and the viewer would only ever see the empty state. Instead of
// boot-time seeding, the read routes answer an in-memory payload when
// IS_STAGING and the page asks for demo=1: nothing is written to the
// database, and the page never calls a write route in demo mode.
const DEMO_FEEDS = [
  { key: 'sky', title: 'Staging demo feed: Sky Watch', url: 'https://demo.example/sky-watch/feed.xml', siteUrl: 'https://demo.example/sky-watch' },
  { key: 'kitchen', title: 'Staging demo feed: Tiny Kitchen', url: 'https://demo.example/tiny-kitchen/feed.xml', siteUrl: 'https://demo.example/tiny-kitchen' },
  { key: 'trail', title: 'Staging demo feed: Trail Notes', url: 'https://demo.example/trail-notes/feed.xml', siteUrl: 'https://demo.example/trail-notes' },
];

const DEMO_POSTS = [
  { feed: 'sky', hoursAgo: 2, title: 'Staging demo: A slow morning at the harbour market',
    html: '<p>The stalls opened early today. Fog sat on the water until mid morning, and by the time it lifted the fish counters were already half cleared.</p><p>We stayed for coffee, watched the boats come in, and bought more apples than we meant to.</p>' },
  { feed: 'kitchen', hoursAgo: 5, title: 'Staging demo: Bread, and what kneading taught me',
    html: '<p>Week six of Saturday loaves. The dough still sticks to everything I own, but the crumb has finally started to look like the picture.</p><p>Today’s lesson: patience beats muscle. A longer rest did what an hour of kneading could not.</p>' },
  { feed: 'trail', hoursAgo: 8, title: 'Staging demo: Crossing the ridge before noon',
    html: '<p>Left the car park at seven to beat the heat. The ridge path was quiet all the way to the saddle, with only a pair of ravens for company.</p><p>Down by the reservoir the shade was a relief. Notes for next time: more water, earlier start.</p>' },
  { feed: 'sky', hoursAgo: 26, title: 'Staging demo: What the rain gauge said this week',
    html: '<p>Eighteen millimetres since Monday, most of it in one squally hour on Wednesday evening. The garden has not needed the hose once.</p><p>The week ahead looks drier, so the barrels get a rest and the beds get a mulch.</p>' },
  { feed: 'kitchen', hoursAgo: 30, title: 'Staging demo: A short list of autumn apples',
    html: '<p>The market had six varieties this week. Cox for eating, Bramley for the pie, and a bag of something unlabelled that turned out to be the best of the lot.</p><p>Apple notes, as usual, written on the train home with juice on the page.</p>' },
  { feed: 'trail', hoursAgo: 50, title: 'Staging demo: Reading a map when the fog comes down',
    html: '<p>The forecast said clear; the summit disagreed. Fog rolled in halfway up and the last two hundred metres were navigated by fence posts and luck.</p><p>A good reminder to keep the compass in a pocket, not in the pack.</p>' },
];

function demoPayload(now) {
  const feedIds = {};
  const feeds = DEMO_FEEDS.map((feed, i) => {
    const id = 900001 + i;
    feedIds[feed.key] = id;
    return {
      id, url: feed.url, title: feed.title, site_url: feed.siteUrl,
      last_error: null, fetched_at: new Date(now.getTime() - 10 * 60_000),
    };
  });
  const posts = DEMO_POSTS
    .map((post, i) => {
      const feed = DEMO_FEEDS.find((f) => f.key === post.feed);
      return {
        id: 910001 + i,
        feed_id: feedIds[post.feed],
        feed_title: feed.title,
        guid: 'staging-demo-' + i,
        title: post.title,
        url: feed.siteUrl + '/posts/' + (i + 1),
        content_html: post.html,
        published_at: new Date(now.getTime() - post.hoursAgo * 3_600_000),
        read_at: null,
      };
    })
    .sort((a, b) => b.published_at - a.published_at);
  return { feeds, posts };
}

// ── API routes ───────────────────────────────────────────────────────────
//
// Reads answer guests with an empty list (they have no user id); every
// write needs an account, which the middleware above already enforces.

app.get('/api/feeds', async (req, res) => {
  if (IS_STAGING && req.query.demo === '1') {
    return res.json({ feeds: demoPayload(req.now).feeds });
  }
  if (!req.user) return res.json({ feeds: [] });
  try {
    const { rows } = await pool.query(
      `SELECT id, url, title, site_url, last_error, fetched_at
       FROM feeds WHERE user_id = $1 ORDER BY created_at, id`,
      [req.user.id]);
    res.json({ feeds: rows });
  } catch (err) {
    console.error('GET /api/feeds failed:', err.message);
    res.status(500).json({ message: "Couldn't load your feeds." });
  }
});

app.post('/api/feeds', async (req, res) => {
  try {
    const url = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
    if (!url) return res.status(400).json({ message: 'Enter a feed address.' });
    let parsed;
    try {
      parsed = await feedParse.fetchFeed(url);
    } catch (err) {
      // Unreachable, not a feed, too large, too slow: say so, store nothing.
      return res.status(400).json({ message: err.message });
    }
    const inserted = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, fetched_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, url) DO NOTHING
       RETURNING id, url, title, site_url, last_error, fetched_at`,
      [req.user.id, url, parsed.title, parsed.siteUrl, req.now]);
    if (!inserted.rows.length) {
      return res.status(409).json({ message: "You're already following that feed." });
    }
    await insertPosts(inserted.rows[0].id, parsed.items);
    res.json({ feed: inserted.rows[0] });
  } catch (err) {
    console.error('POST /api/feeds failed:', err.message);
    res.status(500).json({ message: "Couldn't add that feed." });
  }
});

app.post('/api/feeds/refresh', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, url FROM feeds WHERE user_id = $1', [req.user.id]);
    // One failing feed records its own error and never fails the pass.
    await Promise.allSettled(rows.map((row) => refreshFeed(row, req.now)));
    res.json({ refreshed: rows.length });
  } catch (err) {
    console.error('POST /api/feeds/refresh failed:', err.message);
    res.status(500).json({ message: "Couldn't refresh your feeds." });
  }
});

app.delete('/api/feeds/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Unknown feed.' });
    const deleted = await pool.query(
      'DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, req.user.id]);
    if (!deleted.rows.length) return res.status(404).json({ message: 'Feed not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/feeds/:id failed:', err.message);
    res.status(500).json({ message: "Couldn't remove that feed." });
  }
});

app.get('/api/posts/unread', async (req, res) => {
  if (IS_STAGING && req.query.demo === '1') {
    return res.json({ posts: demoPayload(req.now).posts });
  }
  if (!req.user) return res.json({ posts: [] });
  try {
    const { rows } = await pool.query(
      `SELECT p.id, p.feed_id, f.title AS feed_title, p.title, p.url,
              p.content_html, p.published_at, p.read_at
       FROM posts p JOIN feeds f ON f.id = p.feed_id
       WHERE f.user_id = $1 AND p.read_at IS NULL
       ORDER BY p.published_at DESC NULLS LAST
       LIMIT 500`,
      [req.user.id]);
    res.json({ posts: rows });
  } catch (err) {
    console.error('GET /api/posts/unread failed:', err.message);
    res.status(500).json({ message: "Couldn't load your unread posts." });
  }
});

app.post('/api/posts/:id/read', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ message: 'Unknown post.' });
    const updated = await pool.query(
      `UPDATE posts p SET read_at = $2
       FROM feeds f
       WHERE p.feed_id = f.id AND p.id = $1 AND f.user_id = $3
       RETURNING p.id`,
      [id, req.now, req.user.id]);
    if (!updated.rows.length) return res.status(404).json({ message: 'Post not found.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/posts/:id/read failed:', err.message);
    res.status(500).json({ message: "Couldn't mark that post read." });
  }
});

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

  // Graceful shutdown: stop accepting connections, let in-flight requests
  // finish under a hard deadline, close the pool, exit.
  const DRAIN_MS = 3000;
  async function shutdown(signal) {
    if (shuttingDown) return; // SIGTERM then SIGINT must not double-run
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining`);
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
    try {
      await pool.end();
    } catch (err) {
      console.error('[shutdown] pool.end failed', err.message);
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
