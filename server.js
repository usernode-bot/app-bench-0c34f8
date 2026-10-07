const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { parseFeed } = require('./server/feedxml');

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

let shuttingDown = false;

app.get('/health', (_req, res) =>
  res.status(shuttingDown ? 503 : 200).json({ status: shuttingDown ? 'shutting-down' : 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Schema ────────────────────────────────────────────────────────────────
// Two tables, created idempotently on boot. Both are marked staging:private
// (COMMENT ON TABLE): a person's feeds and reading state are their own, and
// staging copies must carry the schema without carrying anyone's rows.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      url text NOT NULL,
      title text,
      created_at timestamptz,
      UNIQUE (user_id, url)
    )`);
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id serial PRIMARY KEY,
      feed_id integer NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid text NOT NULL,
      title text,
      link text,
      excerpt text,
      published_at timestamptz,
      read_at timestamptz,
      fetched_at timestamptz,
      UNIQUE (feed_id, guid)
    )`);
  await pool.query(`COMMENT ON TABLE posts IS 'staging:private'`);
}

// ── Feed fetching ─────────────────────────────────────────────────────────
// Built-in fetch only, one AbortController timeout per feed. parseFeed (in
// server/feedxml.js) is a string reader that never evaluates what it reads.
const FEED_FETCH_TIMEOUT_MS = 8000;
const FEED_MAX_BYTES = 5_000_000;

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEED_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (text.length > FEED_MAX_BYTES) throw new Error('Feed too large');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function initialOf(title) {
  return (title || '').trim().charAt(0).toUpperCase() || '?';
}

// Upsert one feed's current items, matched on guid so a refresh updates
// rather than duplicates, then trim the feed to its 100 most recent posts.
async function storePosts(feedId, items, now) {
  for (const it of items) {
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, excerpt, published_at, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (feed_id, guid) DO UPDATE SET
         title = EXCLUDED.title,
         link = EXCLUDED.link,
         excerpt = EXCLUDED.excerpt,
         published_at = COALESCE(posts.published_at, EXCLUDED.published_at),
         fetched_at = EXCLUDED.fetched_at`,
      [feedId, it.guid, it.title || null, it.link || null, it.excerpt || null, it.publishedAt, now]
    );
  }
  await pool.query(
    `DELETE FROM posts WHERE feed_id = $1 AND id NOT IN (
       SELECT id FROM posts WHERE feed_id = $1
       ORDER BY published_at DESC NULLS LAST, id DESC
       LIMIT 100)`,
    [feedId]
  );
}

// Refresh one feed: fetch, parse, upsert. Throws on any failure so the
// caller can name this feed in the per-feed failure list.
async function refreshFeed(feed, now) {
  const xml = await fetchText(feed.url);
  const parsed = parseFeed(xml);
  if (!parsed) throw new Error('Not an RSS or Atom feed');
  const items = parsed.posts
    .slice()
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
    .slice(0, 100);
  await storePosts(feed.id, items, now);
  if (!feed.title && parsed.title) {
    await pool.query('UPDATE feeds SET title = $2 WHERE id = $1 AND title IS NULL', [
      feed.id,
      parsed.title,
    ]);
    feed.title = parsed.title;
  }
}

// ── Demo mode ─────────────────────────────────────────────────────────────
// Staging previews run in a sandbox that cannot reach feed hosts, so the
// populated screen would be invisible to checks. `GET /api/posts?demo=1`
// (staging only) answers with obviously fake posts and never touches the
// database; the page keeps demo read state in memory only. Real staging
// databases start empty, and production ignores the parameter entirely.
function demoPosts(now) {
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();
  const H = 3600 * 1000;
  const D = 24 * H;
  return [
    {
      id: 1,
      feed_title: 'Morning Ledger',
      feed_initial: 'M',
      title: 'Staging demo: A fresh post about printing press history',
      published_at: ago(2 * H),
      read_at: null,
      link: 'https://example.com/staging-demo/post-1',
      excerpt:
        'Staging demo excerpt: a short look at how a hand press works, from setting the type to pulling a proof on damp paper.',
    },
    {
      id: 2,
      feed_title: 'Press Room Notes',
      feed_initial: 'P',
      title: 'Staging demo: Typesetting notes, week 40',
      published_at: ago(1 * D),
      read_at: null,
      link: 'https://example.com/staging-demo/post-2',
      excerpt:
        'Staging demo excerpt: this week’s typesetting choices, from word spacing to how the last line of a column is set.',
    },
    {
      id: 3,
      feed_title: 'Morning Ledger',
      feed_initial: 'M',
      title: 'Staging demo: Ink, paper and the daily habit',
      published_at: ago(2 * D),
      read_at: ago(26 * H),
      link: 'https://example.com/staging-demo/post-3',
      excerpt:
        'Staging demo excerpt: why a daily reading habit sticks, and what morning papers learned about rhythm and routine.',
    },
    {
      id: 4,
      feed_title: 'Press Room Notes',
      feed_initial: 'P',
      title: 'Staging demo: Letterpress glossary, A to F',
      published_at: ago(3 * D),
      read_at: null,
      link: 'https://example.com/staging-demo/post-4',
      excerpt:
        'Staging demo excerpt: the first half of a small glossary of letterpress words, from ascender to forme.',
    },
    {
      id: 5,
      feed_title: 'Morning Ledger',
      feed_initial: 'M',
      title: 'Staging demo: Why we still print a proof',
      published_at: ago(4 * D),
      read_at: null,
      link: 'https://example.com/staging-demo/post-5',
      excerpt:
        'Staging demo excerpt: a note on proofing before printing, and the errors a quick proof pull catches every time.',
    },
  ];
}

// ── API ───────────────────────────────────────────────────────────────────
// Every query filters by the verified user id. Guests (req.guest, no
// req.user) read an empty list: they have no feeds until they make an
// account, and the middleware already answers their writes 401
// account_required.

// The one primary action: paste a feed link and follow it. The URL is
// fetched once to prove it parses as RSS or Atom; the title comes from the
// feed itself.
app.post('/api/feeds', async (req, res, next) => {
  try {
    const raw = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
    let url;
    try {
      url = new URL(raw);
    } catch {
      return res.status(400).json({
        error: 'bad_feed',
        message: 'That link did not work as an RSS feed. Check the address and try again.',
      });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return res.status(400).json({
        error: 'bad_feed',
        message: 'That link did not work as an RSS feed. Check the address and try again.',
      });
    }
    const dup = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [
      req.user.id,
      url.href,
    ]);
    if (dup.rows.length) {
      return res
        .status(409)
        .json({ error: 'duplicate', message: 'You already follow this feed.' });
    }
    let xml;
    try {
      xml = await fetchText(url.href);
    } catch (err) {
      console.warn('feed add failed for ' + url.href + ': ' + err.message);
      return res.status(400).json({
        error: 'bad_feed',
        message: 'That link did not work as an RSS feed. Check the address and try again.',
      });
    }
    const parsed = parseFeed(xml);
    if (!parsed) {
      return res.status(400).json({
        error: 'bad_feed',
        message: 'That link did not work as an RSS feed. Check the address and try again.',
      });
    }
    const feed = await pool.query(
      'INSERT INTO feeds (user_id, url, title, created_at) VALUES ($1, $2, $3, $4) RETURNING id, url, title',
      [req.user.id, url.href, parsed.title || null, req.now]
    );
    await storePosts(
      feed.rows[0].id,
      parsed.posts
        .slice()
        .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
        .slice(0, 100),
      req.now
    );
    res.status(201).json({
      feed: {
        id: feed.rows[0].id,
        url: feed.rows[0].url,
        title: feed.rows[0].title,
      },
    });
  } catch (err) {
    next(err);
  }
});

// The list: refresh every feed (in parallel, each with its own timeout),
// then return the merged posts, newest first. Per-feed failures are named
// in `failed` so the page can say which feeds could not be reached while
// still showing the posts already stored.
app.get('/api/posts', async (req, res, next) => {
  try {
    if (IS_STAGING && req.query.demo === '1') {
      return res.json({ demo: true, feedCount: 2, failed: [], posts: demoPosts(req.now) });
    }
    const userId = req.user ? req.user.id : null;
    const feeds = userId
      ? (await pool.query('SELECT id, url, title FROM feeds WHERE user_id = $1 ORDER BY id', [
          userId,
        ])).rows
      : [];
    const settled = await Promise.allSettled(feeds.map((f) => refreshFeed(f, req.now)));
    const failed = [];
    settled.forEach((r, i) => {
      if (r.status === 'rejected') {
        failed.push(feeds[i].title || feeds[i].url);
        console.warn('feed refresh failed for ' + feeds[i].url + ': ' + (r.reason && r.reason.message));
      }
    });
    const rows = userId
      ? (await pool.query(
          `SELECT p.id, p.title, p.link, p.excerpt, p.published_at, p.read_at,
                  f.title AS feed_title
             FROM posts p JOIN feeds f ON f.id = p.feed_id
            WHERE f.user_id = $1
            ORDER BY p.published_at DESC NULLS LAST, p.id DESC
            LIMIT 200`,
          [userId]
        )).rows
      : [];
    res.json({
      feedCount: feeds.length,
      failed,
      posts: rows.map((r) => ({
        id: r.id,
        title: r.title,
        link: r.link,
        excerpt: r.excerpt,
        published_at: r.published_at,
        read_at: r.read_at,
        feed_title: r.feed_title,
        feed_initial: initialOf(r.feed_title),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Mark one post read. Idempotent: read_at is only set while it is empty,
// and the join on feeds keeps a user from touching someone else's post.
app.post('/api/posts/:id/read', async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'not_found' });
    await pool.query(
      `UPDATE posts SET read_at = $2
        WHERE id = $1 AND read_at IS NULL
          AND feed_id IN (SELECT id FROM feeds WHERE user_id = $3)`,
      [id, req.now, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Mark every unread post read, across all of this user's feeds.
app.post('/api/posts/read-all', async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE posts SET read_at = $1
        WHERE read_at IS NULL
          AND feed_id IN (SELECT id FROM feeds WHERE user_id = $2)`,
      [req.now, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
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

// Last resort for anything the routes threw: log it, answer JSON, never
// leak a stack to the client.
app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'server_error', message: 'Something went wrong on the server.' });
});

async function start() {
  await ensureSchema();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  return server;
}

// The platform stops containers with SIGTERM (and people with Ctrl-C /
// SIGINT): stop accepting connections, let in-flight requests drain for a
// fixed moment, then close the database pool. /health answers 503 while
// draining. Idempotent: a second signal changes nothing.
const SHUTDOWN_DRAIN_MS = 3000;
let serverRef = null;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down: draining for ${SHUTDOWN_DRAIN_MS} ms`);
  if (serverRef) serverRef.close(() => {});
  setTimeout(() => {
    pool
      .end()
      .catch(() => {})
      .finally(() => process.exit(0));
  }, SHUTDOWN_DRAIN_MS);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start()
  .then(server => { serverRef = server; })
  .catch(err => { console.error(err); process.exit(1); });
