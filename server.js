const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { safeFetch, parseFeed, discover, looksLikeHtml } = require('./feeds');
const { DEMO_FEEDS, demoPostsFor } = require('./demo-feeds');

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

// ── RSS Reader ──────────────────────────────────────────────────────────────
// Feeds and read posts are private per person, so both tables are
// staging:private: their schema is copied to staging, their rows never are.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      color smallint NOT NULL DEFAULT 1,
      demo boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url_key ON feeds (user_id, url);
    CREATE TABLE IF NOT EXISTS read_posts (
      user_id text NOT NULL,
      post_key text NOT NULL,
      read_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, post_key)
    );
    CREATE TABLE IF NOT EXISTS demo_seeded (
      user_id text PRIMARY KEY,
      seeded_at timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE feeds IS 'staging:private';
    COMMENT ON TABLE read_posts IS 'staging:private';
    COMMENT ON TABLE demo_seeded IS 'staging:private';
  `);
}

const FEED_COLUMNS = 'id, url, title, color, demo';

// A post's stable identity: the feed it came from plus the feed's own id for
// the post. Read marks survive the list being reloaded.
function postKey(feedId, guid, link) {
  return crypto.createHash('sha1').update(feedId + '|' + (guid || link)).digest('hex');
}

// The staging demo (?demo=1, staging only): five made-up feeds written once
// per account, recorded in demo_seeded so feeds the viewer removed stay
// removed. Their posts are never fetched; they come from demo-feeds.js.
async function ensureDemoFeeds(userId) {
  const seeded = await pool.query(
    'INSERT INTO demo_seeded (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING user_id',
    [userId]);
  if (!seeded.rows.length) return;
  for (const [i, demo] of DEMO_FEEDS.entries()) {
    await pool.query(
      'INSERT INTO feeds (user_id, url, title, color, demo) VALUES ($1, $2, $3, $4, true) ON CONFLICT (user_id, url) DO NOTHING',
      [userId, demo.url, demo.title, i + 1]);
  }
}

function wantDemo(req) {
  return IS_STAGING && req.query.demo === '1';
}

// A person's feeds. Demo feeds only answer with ?demo=1, so the plain
// routes stay production-shaped even on staging.
async function listFeeds(userId, withDemo) {
  const sql = withDemo
    ? `SELECT ${FEED_COLUMNS} FROM feeds WHERE user_id = $1 ORDER BY created_at, id`
    : `SELECT ${FEED_COLUMNS} FROM feeds WHERE user_id = $1 AND demo = false ORDER BY created_at, id`;
  return (await pool.query(sql, [userId])).rows;
}

function parseErrorMessage(err) {
  return err && err.safe ? err.message : 'That did not work. Try again in a moment.';
}

// Fetch one address, and if it is a website rather than a feed, look for the
// site's feed link and fetch that instead.
async function fetchAndParse(urlString) {
  const fetched = await safeFetch(urlString);
  const feedUrl = fetched.finalUrl;
  try {
    return { feedUrl, parsed: parseFeed(fetched.body) };
  } catch (err) {
    if (!looksLikeHtml(fetched.body)) throw err;
    const found = discover(fetched.body, feedUrl);
    if (!found) throw fetchNotFoundError();
    const second = await safeFetch(found);
    return { feedUrl: second.finalUrl, parsed: parseFeed(second.body) };
  }
}

function fetchNotFoundError() {
  return Object.assign(new Error('No feed found at that address. Paste the feed or the site’s address and try again.'), { safe: true });
}

app.get('/api/feeds', async (req, res) => {
  if (!req.user) return res.json({ feeds: [] });
  const withDemo = wantDemo(req);
  if (withDemo) await ensureDemoFeeds(req.user.id);
  res.json({ feeds: await listFeeds(req.user.id, withDemo) });
});

app.post('/api/feeds', async (req, res) => {
  // Writes need an account; the auth middleware has already answered guests.
  const raw = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!raw) return res.status(400).json({ error: 'Enter the address of a feed or a website.' });
  const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
  let result;
  try {
    result = await fetchAndParse(target);
  } catch (err) {
    return res.status(400).json({ error: parseErrorMessage(err) });
  }
  const title = result.parsed.title || new URL(result.feedUrl).hostname;
  const inserted = await pool.query(
    `INSERT INTO feeds (user_id, url, title, color)
     VALUES ($1, $2, $3, (SELECT (COALESCE(MAX(color), 0) % 6) + 1 FROM feeds WHERE user_id = $1))
     ON CONFLICT (user_id, url) DO NOTHING
     RETURNING ${FEED_COLUMNS}`,
    [req.user.id, result.feedUrl, title]);
  if (!inserted.rows.length) {
    return res.status(409).json({ error: 'You already follow this feed.' });
  }
  res.status(201).json({ feed: inserted.rows[0] });
});

app.delete('/api/feeds/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'That feed does not exist.' });
  const deleted = await pool.query('DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.user.id]);
  if (!deleted.rows.length) return res.status(404).json({ error: 'That feed is not yours to remove.' });
  res.json({ ok: true });
});

// Every feed is fetched when the list is read (no background refresh); one
// feed failing leaves the others standing, named in `failed`.
app.get('/api/posts', async (req, res) => {
  const withDemo = wantDemo(req);
  if (!req.user) return res.json({ posts: [], feeds: [], failed: [], demo: false });
  const userId = req.user.id;
  if (withDemo) await ensureDemoFeeds(userId);
  const feeds = await listFeeds(userId, withDemo);

  const results = await Promise.allSettled(feeds.map(async (feed) => {
    if (feed.demo) return demoPostsFor(feed, req.now);
    const fetched = await safeFetch(feed.url);
    const parsed = parseFeed(fetched.body);
    return { posts: parsed.items };
  }));

  const failed = [];
  const posts = [];
  results.forEach((result, i) => {
    const feed = feeds[i];
    if (result.status !== 'fulfilled') {
      failed.push({ id: feed.id, title: feed.title });
      return;
    }
    for (const item of result.value.posts) {
      posts.push({
        key: postKey(feed.id, item.guid, item.link),
        feedId: feed.id,
        feedTitle: feed.title,
        color: feed.color,
        title: item.title,
        link: item.link,
        publishedAt: item.publishedAt,
        summary: item.summary,
      });
    }
  });

  const readKeys = new Set((await pool.query(
    'SELECT post_key FROM read_posts WHERE user_id = $1', [userId]
  )).rows.map((row) => row.post_key));
  const unread = posts.filter((post) => !readKeys.has(post.key));
  const dated = unread.filter((post) => post.publishedAt)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const undated = unread.filter((post) => !post.publishedAt);
  res.json({
    posts: dated.concat(undated),
    feeds: feeds.map((feed) => ({ id: feed.id, title: feed.title, url: feed.url, color: feed.color, demo: feed.demo })),
    failed,
    demo: withDemo,
  });
});

app.post('/api/posts/read', async (req, res) => {
  const key = req.body && typeof req.body.key === 'string' ? req.body.key : '';
  if (!key) return res.status(400).json({ error: 'That post does not exist.' });
  await pool.query(
    'INSERT INTO read_posts (user_id, post_key) VALUES ($1, $2) ON CONFLICT (user_id, post_key) DO NOTHING',
    [req.user.id, key]);
  res.json({ ok: true });
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

async function start() {
  await migrate();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // Stop accepting, let open requests finish (at most about 3 s), close the
  // pool, exit.
  let closing = false;
  function stop() {
    if (closing) return;
    closing = true;
    server.close(() => { pool.end().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

start().catch(err => { console.error(err); process.exit(1); });
