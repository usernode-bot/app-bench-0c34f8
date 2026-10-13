const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { safeFetch, readBodyCapped, parseFeed, discoverFeedUrl } = require('./lib/feed');
const { seedDemoFor } = require('./lib/demo');

const REFRESH_AFTER_MS = 15 * 60 * 1000; // a feed is re-checked after this long

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

  // Local development (`node server.js`, in-loop browsing): the platform's
  // JWT keys are not configured there, so a `dev:<name>` token stands in
  // for a person. Staging and production always have the keys, so this
  // branch never runs there.
  if (!req.user && !JWT_PUBLIC_KEY && !APP_AUDIENCE
      && typeof token === 'string' && /^dev:\d+$/.test(token)) {
    req.user = { id: token.slice(4), pur: 'iframe' };
  }
  // A plain local browser or an in-loop check carries no token at all; the
  // same dev-only stand-in gives it one shared local person.
  if (!req.user && !JWT_PUBLIC_KEY && !APP_AUDIENCE) {
    req.user = { id: '1', pur: 'iframe' };
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

// ── Schema ───────────────────────────────────────────────────────────────────
// Both tables hold one person's reading list, so they are private: the
// comment marks them for staging's data tooling, and every query below is
// filtered by user_id.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rss_feeds (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      site_url TEXT,
      color SMALLINT NOT NULL,
      demo BOOLEAN NOT NULL DEFAULT false,
      last_checked_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, url)
    );
    CREATE TABLE IF NOT EXISTS rss_posts (
      id SERIAL PRIMARY KEY,
      feed_id INTEGER NOT NULL REFERENCES rss_feeds (id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      guid TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT,
      excerpt TEXT NOT NULL DEFAULT '',
      published_at TIMESTAMPTZ NOT NULL,
      read_at TIMESTAMPTZ,
      UNIQUE (feed_id, guid)
    );
    CREATE INDEX IF NOT EXISTS rss_posts_user_idx ON rss_posts (user_id, read_at, published_at DESC);
    CREATE TABLE IF NOT EXISTS rss_demo_viewers (
      user_id INTEGER PRIMARY KEY
    );
    COMMENT ON TABLE rss_feeds IS 'staging:private';
    COMMENT ON TABLE rss_posts IS 'staging:private';
    COMMENT ON TABLE rss_demo_viewers IS 'staging:private';
  `);
}

// ── Feed helpers ─────────────────────────────────────────────────────────────

/** The smallest of 1..6 not used by the viewer's feeds yet, else round-robin. */
async function nextColor(client, userId) {
  const { rows } = await client.query('SELECT color FROM rss_feeds WHERE user_id = $1', [userId]);
  const used = new Set(rows.map((r) => r.color));
  for (let c = 1; c <= 6; c += 1) if (!used.has(c)) return c;
  return (rows.length % 6) + 1;
}

/** Insert a parsed feed's posts, skipping ones already stored. */
async function insertPosts(client, feedId, userId, posts) {
  const seen = new Set(); // duplicate guids within one fetch: the first wins
  let inserted = 0;
  for (const post of posts) {
    if (seen.has(post.guid)) continue;
    seen.add(post.guid);
    const r = await client.query(
      `INSERT INTO rss_posts (feed_id, user_id, guid, title, link, excerpt, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedId, userId, post.guid, post.title, post.link, post.excerpt || '', post.publishedAt],
    );
    inserted += r.rowCount;
  }
  return inserted;
}

/**
 * Check one feed now. Returns null on success, else the plain-words error
 * stored on the feed ("the site did not answer", "the site answered with
 * error 404", "it is no longer a readable feed").
 */
async function refreshFeed(feed) {
  const checkedAt = new Date();
  try {
    const res = await safeFetch(feed.url);
    if (res.status >= 400) {
      throw Object.assign(new Error('status'), { code: 'status', status: res.status });
    }
    const text = await readBodyCapped(res);
    const parsed = parseFeed(text, feed.url, checkedAt);
    const title = parsed.title || new URL(feed.url).hostname;
    await insertPosts(pool, feed.id, feed.user_id, parsed.posts);
    await pool.query(
      'UPDATE rss_feeds SET last_checked_at = $1, last_error = NULL, title = $2, site_url = $3 WHERE id = $4',
      [checkedAt, title.slice(0, 200), parsed.link, feed.id],
    );
    return null;
  } catch (err) {
    const message = err && err.code === 'status' ? `the site answered with error ${err.status}`
      : err && err.code === 'parse' ? 'it is no longer a readable feed'
        : 'the site did not answer';
    await pool.query(
      'UPDATE rss_feeds SET last_checked_at = $1, last_error = $2 WHERE id = $3',
      [checkedAt, message, feed.id],
    ).catch(() => {});
    return message;
  }
}

/** A feed row as the API returns it, with its unread count. */
function feedOut(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    siteUrl: row.site_url,
    color: row.color,
    unread: Number(row.unread || 0),
    error: row.last_error || null,
    demo: row.demo,
  };
}

function postOut(row) {
  return {
    id: row.id,
    feedId: row.feed_id,
    title: row.title,
    link: row.link,
    excerpt: row.excerpt,
    publishedAt: row.published_at,
  };
}

// Demo feeds and their posts appear only in the demo view ($3), so the
// staging demo never mixes into a viewer's real list.
async function unreadPosts(userId, feedId, demo = true) {
  const where = feedId ? 'AND feed_id = $3' : '';
  const args = feedId ? [userId, demo, feedId] : [userId, demo];
  const { rows } = await pool.query(
    `SELECT id, feed_id, title, link, excerpt, published_at FROM rss_posts
     WHERE user_id = $1 AND read_at IS NULL
       AND feed_id IN (SELECT id FROM rss_feeds WHERE demo = $2::boolean OR demo = false)
       ${where}
     ORDER BY published_at DESC LIMIT 300`,
    args,
  );
  return rows.map(postOut);
}

// ── API ──────────────────────────────────────────────────────────────────────

// Express 4 does not catch async throws; wrap every async route so a failed
// query answers 500 instead of taking the process down.
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The unread list. Guests (and any signed-out viewer) get an empty answer:
// feeds and read state are per person.
app.get('/api/posts', route(async (req, res) => {
  if (!req.user) return res.json({ guest: true, feeds: [], posts: [] });

  // Staging demo: written once for this account, on the demo route only.
  // The demo flag also picks the view: demo feeds and their posts show up
  // under ?demo=1 and never in the viewer's normal list.
  const demo = IS_STAGING && req.query.demo === '1';
  if (demo) {
    try {
      await seedDemoFor(pool, req.user.id, req.now);
    } catch (err) {
      console.warn('demo seed failed: ' + err.message);
    }
  }

  // Refresh every real feed not checked in the last 15 minutes, in parallel.
  const stale = await pool.query(
    `SELECT id, user_id, url FROM rss_feeds
     WHERE user_id = $1 AND demo = false
       AND (last_checked_at IS NULL OR last_checked_at < $2)`,
    [req.user.id, new Date(req.now.getTime() - REFRESH_AFTER_MS)],
  );
  await Promise.allSettled(stale.rows.map((feed) => refreshFeed(feed)));

  const feeds = await pool.query(
    `SELECT f.id, f.title, f.url, f.site_url, f.color, f.demo, f.last_error,
            (SELECT count(*) FROM rss_posts p WHERE p.feed_id = f.id AND p.read_at IS NULL) AS unread
     FROM rss_feeds f
     WHERE f.user_id = $1 AND (f.demo = $2 OR f.demo = false)
     ORDER BY f.created_at, f.id`,
    [req.user.id, demo],
  );
  const posts = await unreadPosts(req.user.id, null, demo);
  res.json({
    demo,
    feeds: feeds.rows.map(feedOut),
    posts,
  });
}));

// Add a feed: fetch it (or the page that names it), parse it, store the 20
// newest posts as unread.
app.post('/api/feeds', route(async (req, res) => {
  const raw = typeof req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!raw) return res.status(400).json({ error: 'Type a feed address first.' });
  let candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
  let start;
  try {
    start = new URL(candidate);
  } catch {
    return res.status(400).json({ error: 'That address does not look like a web address.' });
  }
  if (start.protocol !== 'http:' && start.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only http and https addresses work.' });
  }
  const url = start.toString();
  const dup = await pool.query('SELECT id FROM rss_feeds WHERE user_id = $1 AND url = $2', [req.user.id, url]);
  if (dup.rowCount) return res.status(409).json({ error: 'You already follow this feed.' });

  try {
    // Fetch; if it is a web page, follow the feed link it names.
    let response = await safeFetch(url);
    if (response.status >= 400) {
      throw Object.assign(new Error(`That page answered with error ${response.status}.`), { code: 'parse' });
    }
    let text = await readBodyCapped(response);
    let finalUrl = response.url || url;
    if (/^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(text)) {
      const feedUrl = discoverFeedUrl(text, finalUrl);
      if (!feedUrl) throw Object.assign(new Error('That page is not an RSS or Atom feed.'), { code: 'parse' });
      response = await safeFetch(feedUrl);
      if (response.status >= 400) {
        throw Object.assign(new Error(`That page answered with error ${response.status}.`), { code: 'parse' });
      }
      text = await readBodyCapped(response);
      finalUrl = response.url || feedUrl;
    }
    const parsed = parseFeed(text, finalUrl, req.now);

    const color = await nextColor(pool, req.user.id);
    const title = parsed.title || new URL(finalUrl).hostname;
    const inserted = await pool.query(
      `INSERT INTO rss_feeds (user_id, url, title, site_url, color, last_checked_at, last_error)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)
       RETURNING id, title, url, site_url, color`,
      [req.user.id, url, title.slice(0, 200), parsed.link, color, req.now],
    );
    const feed = inserted.rows[0];
    // Only the 20 newest posts come in as unread, so an old blog does not flood the list.
    const newest = [...parsed.posts]
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, 20);
    await insertPosts(pool, feed.id, req.user.id, newest);
    const posts = await unreadPosts(req.user.id, feed.id);
    res.status(201).json({
      feed: {
        id: feed.id,
        title: feed.title,
        url: feed.url,
        siteUrl: feed.site_url,
        color: feed.color,
        unread: posts.length,
        error: null,
        demo: false,
      },
      posts,
    });
  } catch (err) {
    const message = err && err.status === 403 ? 'That address cannot be reached.'
      : err && err.status === 502 && /did not answer|redirected/.test(err.message) ? 'That address did not answer.'
        : err && err.code === 'parse' ? 'That page is not an RSS or Atom feed.'
          : 'That feed could not be added. Check the address and try again.';
    res.status(err && err.status === 403 ? 403 : 400).json({ error: message });
  }
}));

// Retry one feed now. Demo feeds keep their stored state; nothing fetches example.com.
app.post('/api/feeds/:id/refresh', route(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await pool.query(
    'SELECT id, user_id, url, demo FROM rss_feeds WHERE id = $1 AND user_id = $2',
    [id, req.user.id],
  );
  if (!rows.length) return res.status(404).json({ error: 'That feed is not on your list.' });
  const feed = rows[0];
  let error = null;
  if (!feed.demo) error = await refreshFeed(feed);
  const feeds = await pool.query(
    `SELECT f.id, f.title, f.url, f.site_url, f.color, f.demo, f.last_error,
            (SELECT count(*) FROM rss_posts p WHERE p.feed_id = f.id AND p.read_at IS NULL) AS unread
     FROM rss_feeds f WHERE f.id = $1`,
    [feed.id],
  );
  // On a failed refresh the feed row (with its error) still goes back, so
  // the notice keeps its title; posts are only merged on success.
  if (error) return res.json({ feed: feedOut(feeds.rows[0]), posts: [] });
  res.json({ feed: feedOut(feeds.rows[0]), posts: await unreadPosts(req.user.id, feed.id) });
}));

// Remove a feed; its posts cascade.
app.delete('/api/feeds/:id', route(async (req, res) => {
  const id = Number(req.params.id);
  const gone = await pool.query(
    'DELETE FROM rss_feeds WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, req.user.id],
  );
  if (!gone.rowCount) return res.status(404).json({ error: 'That feed is not on your list.' });
  res.json({ ok: true });
}));

// Mark a post read. Idempotent; scoped to the viewer.
app.post('/api/posts/:id/read', route(async (req, res) => {
  const id = Number(req.params.id);
  const marked = await pool.query(
    'UPDATE rss_posts SET read_at = $2 WHERE id = $1 AND user_id = $3 AND read_at IS NULL',
    [id, req.now, req.user.id],
  );
  res.json({ ok: true, changed: marked.rowCount });
}));

// Answers anything the API routes above threw that they did not handle:
// a failed query is a 500 in plain words, not a hung request.
app.use('/api', (err, _req, res, _next) => {
  console.warn('api error: ' + (err && err.stack ? err.stack : err));
  if (res.headersSent) return;
  res.status(err && err.status ? err.status : 500)
    .json({ error: err && err.status ? err.message : 'That did not work on our side. Try again in a moment.' });
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

  // Stop listening, give in-flight requests about 3 s to finish, close the
  // pool and exit.
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    server.close(() => {});
    setTimeout(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
