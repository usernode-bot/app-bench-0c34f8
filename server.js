const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { fetchFeed } = require('./lib/feeds');

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

// ── Schema ─────────────────────────────────────────────────────────────────
// Feeds and posts are each person's own: per-user, per-feed reading, no
// sharing. Both tables are `staging:private`, so staging starts from their
// schema without production's rows.

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      site_url text,
      last_fetched_at timestamptz,
      last_error text,
      is_demo boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url ON feeds (user_id, url);
    COMMENT ON TABLE feeds IS 'staging:private';

    CREATE TABLE IF NOT EXISTS posts (
      id serial PRIMARY KEY,
      feed_id integer NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
      user_id text NOT NULL,
      guid text NOT NULL,
      title text NOT NULL,
      link text,
      summary text,
      published_at timestamptz,
      read_at timestamptz,
      is_demo boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS posts_feed_guid ON posts (feed_id, guid);
    CREATE INDEX IF NOT EXISTS posts_user_unread
      ON posts (user_id, read_at, published_at DESC);
    COMMENT ON TABLE posts IS 'staging:private';
  `);
}

// Upserting a post never touches read_at: adding a feed or refreshing it
// must not mark anything read that the person has not opened.
async function upsertPosts(feedId, userId, isDemo, items) {
  for (const it of items) {
    await pool.query(`
      INSERT INTO posts (feed_id, user_id, guid, title, link, summary, published_at, is_demo)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (feed_id, guid) DO NOTHING
    `, [feedId, userId, it.guid, it.title, it.link, it.summary, it.publishedAt, isDemo]);
  }
}

// ── The staging demo (?demo=1) ─────────────────────────────────────────────
// A first version's populated demo: on staging only, ?demo=1 shows three
// made-up feeds with 14 unread posts, the same guids every time. Seeded once
// per viewer, idempotently. Demo feeds are never fetched and their rows are
// excluded from every response without ?demo=1, so a plain-route check never
// sees them.
const DEMO_FEEDS = [
  {
    url: 'https://garden.example.com/feed.xml',
    title: 'Pretend Garden Weekly',
    siteUrl: 'https://garden.example.com',
    error: 'The feed didn’t respond the last time we tried. Its saved posts are still here.',
    posts: [
      ['demo-garden-01', 'Ten imaginary tomatoes we grew on a balcony that does not exist',
        'A made-up season of watering, staking and waiting, with notes on which of the invented varieties did best in the pretend shade.',
        12 * 60000],
      ['demo-garden-02', 'How to compost leaves from a sample tree',
        'Layering, turning and patience, explained with a pile of entirely fictional leaves.',
        26 * 3600000],
      ['demo-garden-03', 'The pretend greenhouse in the first week of March',
        'Seedlings on a made-up windowsill, a sample cold snap and one tray of invented basil that did not make it.',
        2 * 24 * 3600000 + 5 * 3600000],
      ['demo-garden-04', 'Planting a hedge that only exists in this demo',
        'Spacing, sample soil and the pretend 4-year wait, with a chart of nothing in particular.',
        3 * 24 * 3600000 + 9 * 3600000],
      ['demo-garden-05', 'A beginner’s guide to watering an example fern',
        'Every other day, or when the fictional soil looks dry. Ferns sampled here are forgiving.',
        4 * 24 * 3600000 + 2 * 3600000],
    ],
  },
  {
    url: 'https://tech.example.com/digest.xml',
    title: 'Sample Tech Digest',
    siteUrl: 'https://tech.example.com',
    error: null,
    posts: [
      ['demo-tech-01', 'Example Corp ships version 0.0.1 of its sample widget',
        'The release notes for a product nobody makes: faster pretend loading, a fictional dark mode and fixes for bugs that never happened.',
        1 * 3600000 + 8 * 60000],
      ['demo-tech-02', 'A beginner’s tour of an example keyboard',
        'Every key on a keyboard drawn for this demo, and the one we could not find a use for.',
        22 * 3600000],
      ['demo-tech-03', 'Why the placeholder internet needs sample routing tables',
        'A short explainer of the made-up plumbing behind an imaginary network, with fictional packet counts.',
        2 * 24 * 3600000 + 3 * 3600000],
      ['demo-tech-04', 'The sample laptop that never shipped, reviewed',
        'Hands-on with a hardware mock-up: pretend battery life, imaginary ports and a keyboard tested for exactly one paragraph.',
        3 * 24 * 3600000 + 20 * 3600000],
      ['demo-tech-05', 'Setting up a home server made entirely of hypotheticals',
        'Backups, sample docker containers and a fictional power bill, all in one weekend project that does not exist.',
        4 * 24 * 3600000 + 11 * 3600000],
    ],
  },
  {
    url: 'https://bikes.example.com/rides.xml',
    title: 'Make-believe Bike Blog',
    siteUrl: 'https://bikes.example.com',
    error: null,
    posts: [
      ['demo-bike-01', 'Riding the placeholder coast road in one long afternoon',
        'Forty fictional kilometres, two invented cafes and a headwind we made up for the story.',
        3 * 3600000],
      ['demo-bike-02', 'Pumping a sample tyre to the right pressure',
        'Bar, psi and the made-up sweet spot between them, on a wheel that exists only in a diagram.',
        21 * 3600000],
      ['demo-bike-03', 'Choosing a sample saddle: a fictional trial of six',
        'Six pretend saddles, one imaginary backside, and the made-up winner after a week of not riding.',
        2 * 24 * 3600000 + 18 * 3600000],
      ['demo-bike-04', 'A rainy commute on an invented cycle lane',
        'The fictional lane floods; the sample fenders help; the pretend thermos is the real hero of this story.',
        3 * 24 * 3600000 + 14 * 3600000],
    ],
  },
];

async function ensureDemo(userId, now) {
  for (const feed of DEMO_FEEDS) {
    const res = await pool.query(`
      INSERT INTO feeds (user_id, url, title, site_url, last_error, is_demo)
      VALUES ($1, $2, $3, $4, $5, true)
      ON CONFLICT (user_id, url) DO NOTHING
      RETURNING id
    `, [userId, feed.url, feed.title, feed.siteUrl, feed.error]);
    const feedId = res.rows.length ? res.rows[0].id : (await pool.query(
      'SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [userId, feed.url])).rows[0].id;
    const minutesAgo = (ms) => new Date(now.getTime() - ms).toISOString();
    for (const [guid, title, summary, ago] of feed.posts) {
      await pool.query(`
        INSERT INTO posts (feed_id, user_id, guid, title, link, summary, published_at, is_demo)
        VALUES ($1, $2, $3, $4, $5, $6, $7, true)
        ON CONFLICT (feed_id, guid) DO NOTHING
      `, [feedId, userId, guid, title, `${feed.siteUrl}/posts/${guid}`, summary, minutesAgo(ago)]);
    }
  }
}

// ── The API ────────────────────────────────────────────────────────────────

// Refresh every non-demo feed of this viewer, in parallel, each with the
// fetcher's own timeout, then record per-feed success or failure. A slow or
// dead feed never holds up the unread list: its saved posts stay.
async function refreshFeeds(feeds) {
  await Promise.allSettled(feeds.rows.map(async (feed) => {
    try {
      const parsed = await fetchFeed(feed.url);
      await upsertPosts(feed.id, feed.user_id, false, parsed.items.slice(0, 100));
      await pool.query(
        'UPDATE feeds SET title = $2, site_url = $3, last_fetched_at = now(), last_error = NULL WHERE id = $1',
        [feed.id, parsed.title, parsed.siteUrl]);
    } catch (err) {
      await pool.query(
        'UPDATE feeds SET last_fetched_at = now(), last_error = $2 WHERE id = $1',
        [feed.id, err.message]);
    }
  }));
}

// The unread list: every unread post, newest first, all feeds mixed, each
// with its feed's title. Demo rows only when ?demo=1 asks for them.
app.get('/api/posts', async (req, res) => {
  const userId = req.user ? req.user.id : null;
  const demo = IS_STAGING && req.query.demo === '1';
  if (!userId) return res.json({ posts: [], feeds: [], demo });
  if (demo) await ensureDemo(userId, req.now);

  const feeds = await pool.query(
    'SELECT id, user_id, url FROM feeds WHERE user_id = $1 AND is_demo = false', [userId]);
  if (feeds.rows.length) await refreshFeeds(feeds);

  const feedRows = await pool.query(
    `SELECT id, title, url, last_error FROM feeds
     WHERE user_id = $1 AND ($2::boolean OR is_demo = false)
     ORDER BY created_at`, [userId, demo]);
  const posts = await pool.query(
    `SELECT p.id, p.title, p.link, p.summary, p.published_at, f.title AS feed_title
     FROM posts p JOIN feeds f ON f.id = p.feed_id
     WHERE p.user_id = $1 AND p.read_at IS NULL AND ($2::boolean OR p.is_demo = false)
     ORDER BY p.published_at DESC NULLS LAST
     LIMIT 500`, [userId, demo]);
  res.json({
    posts: posts.rows,
    feeds: feedRows.rows.map((f) => ({ id: f.id, title: f.title, url: f.url, error: f.last_error })),
    demo,
  });
});

// Add a feed by link. The link is fetched and parsed BEFORE anything is
// saved, so "Add feed" never accepts a page that is not a feed.
app.post('/api/feeds', async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  if (!url) return res.status(400).json({ error: 'Paste a feed link first.' });
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Feed links start with http:// or https://.' });
  }
  const existing = await pool.query(
    'SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [req.user.id, url]);
  if (existing.rows.length) {
    return res.status(409).json({ error: 'You already added this feed.' });
  }
  let parsed;
  try {
    parsed = await fetchFeed(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const feed = await pool.query(`
    INSERT INTO feeds (user_id, url, title, site_url, last_fetched_at, is_demo)
    VALUES ($1, $2, $3, $4, now(), false)
    ON CONFLICT (user_id, url) DO NOTHING
    RETURNING id, title, url, site_url
  `, [req.user.id, url, parsed.title, parsed.siteUrl]);
  if (!feed.rows.length) {
    return res.status(409).json({ error: 'You already added this feed.' });
  }
  await upsertPosts(feed.rows[0].id, req.user.id, false, parsed.items.slice(0, 100));
  res.status(201).json({ feed: feed.rows[0] });
});

// Remove a feed; its posts go with it (ON DELETE CASCADE).
app.delete('/api/feeds/:id', async (req, res) => {
  const del = await pool.query(
    'DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]);
  if (!del.rows.length) return res.status(404).json({ error: 'That feed is not yours to remove.' });
  res.json({ removed: true });
});

// A post counts read as soon as it is tapped. Setting read_at again is fine;
// changing it back is not something the app ever does.
app.post('/api/posts/:id/read', async (req, res) => {
  const upd = await pool.query(`
    UPDATE posts SET read_at = COALESCE(read_at, $3)
    WHERE id = $1 AND user_id = $2
    RETURNING id
  `, [req.params.id, req.user.id, req.now]);
  if (!upd.rows.length) return res.status(404).json({ error: 'That post is not yours.' });
  res.json({ read: true });
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

// ── Boot and shutdown ──────────────────────────────────────────────────────

async function start() {
  await ensureSchema();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // The platform stops the container with SIGTERM (and a local Ctrl-C is
  // SIGINT): stop listening, let in-flight requests finish, close the pool.
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    server.close(() => {
      clearInterval(timer);
      pool.end().then(() => process.exit(0));
    });
    const timer = setTimeout(() => {
      pool.end().then(() => process.exit(0));
    }, 3000);
    timer.unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
