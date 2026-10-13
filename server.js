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

// ── RSS Reader API ────────────────────────────────────────────────────────
// Feeds and posts are per person and marked private (staging never copies
// them between viewers). Guests reach only the GET below; every write they
// try is answered 401 by the auth middleware above.
const { FeedError, normaliseUrl, safeFetch, parseFeed, findFeedLink } = require('./lib/feeds');
const { FEEDS } = require('./lib/demo-feeds');

const MAX_POSTS = 300;
const KEEP_NEW_ITEMS = 50;
const OLD_IS_READ_DAYS = 14;

function feedRow(row, unread) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    siteUrl: row.site_url || null,
    isDemo: !!row.is_demo,
    unread,
    lastCheckedAt: row.last_checked_at ? row.last_checked_at.toISOString() : null,
    lastError: row.last_error || null,
  };
}

function postRow(row) {
  return {
    id: row.id,
    feedId: row.feed_id,
    feedTitle: row.feed_title,
    title: row.title,
    link: row.link || null,
    summary: row.summary || '',
    author: row.author || null,
    publishedAt: row.published_at.toISOString(),
  };
}

// The demo overlay shows only behind ?demo=1. The plain routes always
// answer with the viewer's real feeds alone, so made-up rows an earlier
// demo visit seeded never reach the production-shaped screen. (Outside
// staging no demo rows exist, so the exclusion is a no-op there.)
async function viewerData(userId, demo) {
  const notDemo = demo ? '' : ' AND is_demo = false';
  const feedRows = (await pool.query(
    `SELECT id, url, title, site_url, is_demo, last_checked_at, last_error
       FROM feeds WHERE user_id = $1${notDemo}
      ORDER BY created_at, id`,
    [userId],
  )).rows;
  const counts = new Map((await pool.query(
    'SELECT feed_id, count(*)::int AS unread FROM posts WHERE user_id = $1 AND read_at IS NULL GROUP BY feed_id',
    [userId],
  )).rows.map((r) => [r.feed_id, r.unread]));
  const postRows = (await pool.query(
    `SELECT p.id, p.feed_id, f.title AS feed_title, p.title, p.link, p.summary, p.author, p.published_at
       FROM posts p JOIN feeds f ON f.id = p.feed_id
      WHERE p.user_id = $1${demo ? '' : ' AND f.is_demo = false'} AND p.read_at IS NULL
      ORDER BY p.published_at DESC LIMIT ${MAX_POSTS}`,
    [userId],
  )).rows;
  return {
    feeds: feedRows.map((row) => feedRow(row, counts.get(row.id) || 0)),
    posts: postRows.map(postRow),
    demo,
    guest: false,
  };
}

// Staging only: seed the ?demo=1 preview once per viewer. A removed demo
// feed stays removed, because the seed happens only when demo_seeds gains a
// row for this viewer.
async function seedDemo(userId, now) {
  const fresh = (await pool.query(
    'INSERT INTO demo_seeds (user_id, seeded_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id',
    [userId, now],
  )).rows;
  if (!fresh.length) return;
  for (const feed of FEEDS) {
    const feedId = (await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, is_demo, last_checked_at)
       VALUES ($1, $2, $3, $4, true, $5)
       ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
      [userId, feed.url, feed.title, feed.siteUrl, now],
    )).rows[0];
    if (!feedId) continue;
    for (const post of feed.posts) {
      await pool.query(
        `INSERT INTO posts (feed_id, user_id, guid, title, link, summary, author, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (feed_id, guid) DO NOTHING`,
        [feedId.id, userId, post.guid, post.title, 'https://example.com/', post.summary,
          post.author, new Date(now.getTime() - post.age * 60_000)],
      );
    }
  }
}

function fetchFeedOnce(feed, now) {
  return safeFetch(feed.url)
    .then(({ body, type }) => {
      let parsed;
      try {
        parsed = parseFeed(body, feed.url, now);
      } catch (err) {
        if (err instanceof FeedError && /html/i.test(type)) {
          const link = findFeedLink(body, feed.url);
          if (link && link !== feed.url) {
            return safeFetch(link).then(({ body: body2 }) => parseFeed(body2, link, now));
          }
        }
        throw err;
      }
      return parsed;
    });
}

async function refreshFeed(feed, now) {
  try {
    const parsed = await fetchFeedOnce(feed, now);
    const newest = parsed.items.slice(0, KEEP_NEW_ITEMS);
    for (const item of newest) {
      await pool.query(
        `INSERT INTO posts (feed_id, user_id, guid, title, link, summary, author, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (feed_id, guid) DO NOTHING`,
        [feed.id, feed.user_id, item.guid, item.title, item.link, item.summary, item.author, item.publishedAt],
      );
    }
    await pool.query(
      'UPDATE feeds SET title = $2, site_url = COALESCE($3, site_url), last_checked_at = $4, last_error = NULL WHERE id = $1',
      [feed.id, parsed.title, parsed.siteUrl, now],
    );
    return null;
  } catch (err) {
    const reason = err instanceof FeedError ? err.message : 'The feed could not be read just now';
    await pool.query(
      'UPDATE feeds SET last_checked_at = $2, last_error = $3 WHERE id = $1',
      [feed.id, now, reason],
    );
    return reason;
  }
}

async function refreshAll(userId, now) {
  const feeds = (await pool.query(
    'SELECT id, user_id, url FROM feeds WHERE user_id = $1 AND is_demo = false ORDER BY id',
    [userId],
  )).rows;
  const failures = [];
  const queue = [...feeds];
  const worker = async () => {
    for (;;) {
      const feed = queue.shift();
      if (!feed) return;
      const reason = await refreshFeed(feed, now);
      if (reason) failures.push({ id: feed.id, reason });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, feeds.length) }, worker));
  return failures;
}

app.get('/api/posts', async (req, res) => {
  try {
    if (!req.user) return res.json({ feeds: [], posts: [], demo: false, guest: true });
    const demo = IS_STAGING && req.query.demo === '1';
    if (demo) await seedDemo(String(req.user.id), req.now);
    res.json(await viewerData(String(req.user.id), demo));
  } catch (err) {
    console.warn('GET /api/posts failed:', err.message);
    res.status(500).json({ error: 'Your posts could not be loaded just now' });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const userId = String(req.user.id);
    // Refresh answers in the shape of the screen it was called from: the
    // demo page passes ?demo=1 on, so its refresh keeps the overlay.
    const demo = IS_STAGING && req.query.demo === '1';
    if (demo) await seedDemo(String(userId), req.now);
    const failures = await refreshAll(userId, req.now);
    res.json({ ...await viewerData(userId, demo), checkedAt: req.now.toISOString(), failures });
  } catch (err) {
    console.warn('POST /api/refresh failed:', err.message);
    res.status(500).json({ error: 'Your feeds could not be checked just now' });
  }
});

app.post('/api/feeds', async (req, res) => {
  const raw = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!raw) return res.status(400).json({ error: 'Paste a feed address, starting with https://' });
  if (!/^https:\/\//i.test(raw)) {
    return res.status(400).json({ error: raw.startsWith('http://') || /^\w+:\/\//i.test(raw) && !raw.startsWith('https://')
      ? 'Use the https address of the feed'
      : 'Paste a feed address, starting with https://' });
  }
  const userId = String(req.user.id);
  try {
    let { url, body, type } = await safeFetch(raw);
    let parsed;
    try {
      parsed = parseFeed(body, url, req.now);
    } catch (err) {
      if (!(err instanceof FeedError)) throw err;
      // A website's home page often names its own feed: try that address once.
      const link = /html/i.test(type) ? findFeedLink(body, url) : null;
      if (!link) throw err;
      const again = await safeFetch(link);
      url = again.url;
      parsed = parseFeed(again.body, again.url, req.now);
    }
    const feedUrl = normaliseUrl(url).href;
    const existing = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [userId, feedUrl]);
    if (existing.rows.length) return res.status(400).json({ error: 'That feed is already in your list' });
    const cutoff = req.now.getTime() - OLD_IS_READ_DAYS * 24 * 60 * 60 * 1000;
    const inserted = (await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, last_checked_at) VALUES ($1, $2, $3, $4, $5) RETURNING id, url, title, site_url, is_demo, last_checked_at, last_error`,
      [userId, feedUrl, parsed.title, parsed.siteUrl, req.now],
    )).rows[0];
    for (const item of parsed.items.slice(0, KEEP_NEW_ITEMS)) {
      await pool.query(
        `INSERT INTO posts (feed_id, user_id, guid, title, link, summary, author, published_at, read_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (feed_id, guid) DO NOTHING`,
        [inserted.id, userId, item.guid, item.title, item.link, item.summary, item.author, item.publishedAt,
          item.publishedAt.getTime() < cutoff ? req.now : null],
      );
    }
    res.status(201).json({ feed: feedRow(inserted, 0) });
  } catch (err) {
    const message = err instanceof FeedError
      ? err.message
      : 'That site didn\'t answer. Check the address and try again.';
    res.status(err instanceof FeedError ? 400 : 502).json({ error: message });
  }
});

app.delete('/api/feeds/:id', async (req, res) => {
  try {
    const gone = await pool.query(
      'DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id',
      [Number(req.params.id) || 0, String(req.user.id)],
    );
    if (!gone.rows.length) return res.status(404).json({ error: 'That feed is not in your list' });
    res.json({ ok: true });
  } catch (err) {
    console.warn('DELETE /api/feeds/:id failed:', err.message);
    res.status(500).json({ error: 'The feed could not be removed just now' });
  }
});

app.post('/api/posts/:id/read', async (req, res) => {
  try {
    const read = await pool.query(
      'UPDATE posts SET read_at = $3 WHERE id = $1 AND user_id = $2 AND read_at IS NULL RETURNING id',
      [Number(req.params.id) || 0, String(req.user.id), req.now],
    );
    if (!read.rows.length) return res.status(404).json({ error: 'That post is not in your list' });
    res.json({ ok: true });
  } catch (err) {
    console.warn('POST /api/posts/:id/read failed:', err.message);
    res.status(500).json({ error: 'The post could not be marked read just now' });
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

// The tables: feeds and posts are per person and private (staging keeps its
// demo data to the viewer it was seeded for). demo_seeds makes the ?demo=1
// seed happen once per viewer.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      site_url text,
      is_demo boolean DEFAULT false,
      last_checked_at timestamptz,
      last_error text,
      created_at timestamptz DEFAULT now()
    );
    COMMENT ON TABLE feeds IS 'staging:private';
    CREATE TABLE IF NOT EXISTS posts (
      id serial PRIMARY KEY,
      feed_id int NOT NULL REFERENCES feeds ON DELETE CASCADE,
      user_id text NOT NULL,
      guid text NOT NULL,
      title text NOT NULL,
      link text,
      summary text,
      author text,
      published_at timestamptz NOT NULL,
      read_at timestamptz
    );
    COMMENT ON TABLE posts IS 'staging:private';
    CREATE TABLE IF NOT EXISTS demo_seeds (
      user_id text PRIMARY KEY,
      seeded_at timestamptz DEFAULT now()
    );
    COMMENT ON TABLE demo_seeds IS 'staging:private';
    CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url_key ON feeds (user_id, url);
    CREATE UNIQUE INDEX IF NOT EXISTS posts_feed_guid_key ON posts (feed_id, guid);
    CREATE INDEX IF NOT EXISTS posts_user_unread_idx ON posts (user_id, read_at, published_at DESC);
  `);
}

async function start() {
  await migrate();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // Stop accepting, drain what is in flight, then close the database pool.
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: draining`);
    server.close(() => {
      pool.end().then(() => process.exit(0), () => process.exit(0));
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
