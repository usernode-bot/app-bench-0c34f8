const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { fetchFeed } = require('./feed');

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

// ── This app's data ────────────────────────────────────────────────────────
// Two tables, both per person and both 'staging:private' (staging's shared
// database must not seed or copy them; see "Staging: private data" in the
// platform conventions).

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS feeds (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    site_url TEXT,
    is_demo BOOLEAN NOT NULL DEFAULT false,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, url))`);
  await pool.query("COMMENT ON TABLE feeds IS 'staging:private'");
  await pool.query(`CREATE TABLE IF NOT EXISTS posts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    feed_id BIGINT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid TEXT NOT NULL,
    title TEXT NOT NULL,
    link TEXT,
    summary TEXT NOT NULL DEFAULT '',
    author TEXT,
    published_at TIMESTAMPTZ,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at TIMESTAMPTZ,
    UNIQUE (feed_id, guid))`);
  await pool.query('CREATE INDEX IF NOT EXISTS posts_feed_read ON posts (feed_id, read_at)');
  await pool.query("COMMENT ON TABLE posts IS 'staging:private'");
}

// Refresh one feed: fetch it through the guard, add posts not stored yet,
// record how it went. A failed feed keeps everything saved so far, and its
// last_error becomes the failure line above the list.
async function refreshFeed(feed, now) {
  try {
    const parsed = await fetchFeed(feed.url);
    for (const item of parsed.items) {
      if (!item.guid) continue;
      await pool.query(
        `INSERT INTO posts (feed_id, guid, title, link, summary, author, published_at, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (feed_id, guid) DO NOTHING`,
        [feed.id, item.guid, item.title || '(untitled)', item.link, item.summary,
          item.author, item.publishedAt, now]);
    }
    await pool.query('UPDATE feeds SET title = $2, site_url = $3, last_error = NULL WHERE id = $1',
      [feed.id, parsed.title || feed.title, parsed.siteUrl]);
  } catch (err) {
    await pool.query('UPDATE feeds SET last_error = $2 WHERE id = $1', [feed.id, err.message]);
  }
}

// ── API ────────────────────────────────────────────────────────────────────

// The unread list. Refreshes every feed of this viewer first (in parallel),
// then returns their unread posts, newest first.
app.get('/api/posts', async (req, res, next) => {
  try {
    const demo = IS_STAGING && req.query.demo === '1';
    if (demo) await writeDemoData(req.user.id, req.now);
    const feeds = (await pool.query(
      `SELECT id, url, title, is_demo FROM feeds WHERE user_id = $1 ${demo ? '' : 'AND NOT is_demo'} ORDER BY id`,
      [req.user.id])).rows;
    // Demo feeds stand in for real ones and are never fetched.
    await Promise.all(feeds.filter((f) => !f.is_demo).map((f) => refreshFeed(f, req.now)));
    const failed = (await pool.query(
      `SELECT title FROM feeds WHERE user_id = $1 AND NOT is_demo AND last_error IS NOT NULL ORDER BY id`,
      [req.user.id])).rows.map((r) => r.title);
    const posts = (await pool.query(
      `SELECT p.id, p.title, p.link, p.summary, p.author, p.published_at, p.fetched_at, f.title AS feed_title
       FROM posts p JOIN feeds f ON f.id = p.feed_id
       WHERE f.user_id = $1 ${demo ? '' : 'AND NOT f.is_demo'} AND p.read_at IS NULL
       ORDER BY COALESCE(p.published_at, p.fetched_at) DESC, p.id DESC LIMIT 300`,
      [req.user.id])).rows;
    res.json({ posts, feedCount: feeds.length, failedFeeds: failed, demo });
  } catch (err) { next(err); }
});

// Add a feed. The address is fetched and parsed through the guard before
// anything is saved: 400 with a plain reason when it is not a reachable
// feed, 409 when the viewer already has it.
app.post('/api/feeds', async (req, res, next) => {
  try {
    const raw = typeof req.body === 'object' && req.body && typeof req.body.url === 'string'
      ? req.body.url.trim() : '';
    if (!raw) return res.status(400).json({ error: 'Give the feed address.' });
    // "example.com/feed.xml" means https://example.com/feed.xml.
    const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'https://' + raw;

    const dupe = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [req.user.id, url]);
    if (dupe.rowCount) return res.status(409).json({ error: 'You already have this feed.' });

    let parsed;
    try {
      parsed = await fetchFeed(url);
    } catch (err) {
      return res.status(400).json({ error: err.message || 'We could not read a feed from that address.' });
    }
    if (!parsed.items.length) {
      return res.status(400).json({ error: 'That address is not an RSS or Atom feed.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const feed = (await client.query(
        'INSERT INTO feeds (user_id, url, title, site_url) VALUES ($1, $2, $3, $4) RETURNING id, title',
        [req.user.id, url, parsed.title || 'Untitled feed', parsed.siteUrl])).rows[0];
      for (const item of parsed.items) {
        if (!item.guid) continue;
        await client.query(
          `INSERT INTO posts (feed_id, guid, title, link, summary, author, published_at, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (feed_id, guid) DO NOTHING`,
          [feed.id, item.guid, item.title || '(untitled)', item.link, item.summary,
            item.author, item.publishedAt, req.now]);
      }
      await client.query('COMMIT');
      return res.status(201).json({ feed: { id: feed.id, title: feed.title } });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'You already have this feed.' });
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// Mark one post read. Only the post's own viewer can; idempotent.
app.post('/api/posts/:id/read', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: 'No such post.' });
    const own = await pool.query(
      `SELECT p.id FROM posts p JOIN feeds f ON f.id = p.feed_id WHERE p.id = $1 AND f.user_id = $2`,
      [id, req.user.id]);
    if (!own.rowCount) return res.status(404).json({ error: 'No such post.' });
    await pool.query('UPDATE posts SET read_at = $2 WHERE id = $1 AND read_at IS NULL', [id, req.now]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Staging demo ───────────────────────────────────────────────────────────
// ?demo=1 (staging only) stands in four feeds with 23 made-up posts so the
// populated screen can be seen. Demo feeds are never fetched; their posts
// carry no link, so there is nothing real to open. Idempotent, so it can be
// written on every ?demo=1 load. The times are relative to req.now.

const DEMO_FEEDS = [
  {
    url: 'https://demo.invalid/garden-weekly.xml', title: 'Pretend Garden Weekly',
    posts: [
      { title: 'Ten tomatoes that only grow in sample data', author: 'Demo Gardener', mins: 12,
        summary: 'This is made-up demo text. Our imaginary allotment tried every variety we could invent this summer, from the Placeholder Plum to the Lorem Cherry.' },
      { title: 'How to water a garden that is only in a test database', author: 'Demo Gardener', mins: 26 * 60,
        summary: 'Less often than you think. This post is staging sample content, and so is the watering can.' },
      { title: 'A made-up guide to pruning invisible roses', author: 'Sample Gardener', mins: 2 * 24 * 60,
        summary: 'Prune the pretend stems in early spring and the fictional blooms keep coming. Nothing here grew anywhere.' },
      { title: 'The invented compost heap, week one', author: 'Demo Gardener', mins: 3 * 24 * 60,
        summary: 'Placeholder scraps in, fictional soil out. A demo post about a heap that exists only in this paragraph.' },
      { title: 'Slug fences that exist only on paper', author: 'Sample Gardener', mins: 4 * 24 * 60,
        summary: 'A demo comparison of four made-up barriers, none of which stopped a real slug, because none was real.' },
      { title: 'Seedlings of the imaginary allotment, sorted', author: 'Demo Gardener', mins: 5 * 24 * 60,
        summary: 'Staging sample content: twelve pretend varieties lined up in an order we invented for this preview.' },
    ],
  },
  {
    url: 'https://demo.invalid/example-kitchen.xml', title: 'The Example Kitchen',
    posts: [
      { title: 'A soup recipe nobody has cooked, step by step', author: 'Demo Cook', mins: 60,
        summary: 'Placeholder steps for a placeholder soup: chop the pretend leeks, simmer for a fictional twenty minutes, taste for sample salt.' },
      { title: 'Five breakfasts from an imaginary pantry', author: 'Demo Cook', mins: 2 * 24 * 60,
        summary: 'Toast, more toast, and three ideas we invented for this preview. Nothing here was eaten.' },
      { title: 'How to bake bread from placeholder flour', author: 'Sample Cook', mins: 24 * 60,
        summary: 'Sample steps for a sample loaf: knead the fictional dough, wait a made-up hour, bake until demo-crusty.' },
      { title: 'The pretend spice rack, inventoried', author: 'Demo Cook', mins: 3 * 24 * 60,
        summary: 'Demo content listing twelve sample spices, each with a made-up use and a fictional best-before date.' },
      { title: 'A stew that simmers only in this staging demo', author: 'Sample Cook', mins: 4 * 24 * 60,
        summary: 'The fictional onions browned on cue and the pretend stock never once boiled over. Sample content throughout.' },
      { title: 'Sample pantry swaps for invented ingredients', author: 'Demo Cook', mins: 6 * 24 * 60,
        summary: 'What to reach for when the placeholder butter runs out. A staging demo post with no calories at all.' },
    ],
  },
  {
    url: 'https://demo.invalid/sample-cycling-club.xml', title: 'Sample Cycling Club',
    posts: [
      { title: 'Route of the week: the loop around Lorem Lake', author: 'Demo Rider', mins: 3 * 60,
        summary: 'Forty invented kilometres, two fake hills and a café that exists only in this demo.' },
      { title: 'Forty invented kilometres before breakfast', author: 'Demo Rider', mins: 24 * 60,
        summary: 'A made-up ride report from a staging morning: two fake hills, one fictional headwind, sample coffee at the turn.' },
      { title: 'How to fix a puncture nobody got', author: 'Sample Rider', mins: 2 * 24 * 60,
        summary: 'Demo steps for a pretend flat. Keep the sample lever on the sample tyre and the invented wheel turns again.' },
      { title: "The club's fictional time trial, results", author: 'Demo Rider', mins: 3 * 24 * 60,
        summary: 'Staging sample content: nobody raced, everybody finished, and the made-up podium was very tidy.' },
      { title: 'Upgrading a bicycle that does not exist', author: 'Sample Rider', mins: 5 * 24 * 60,
        summary: 'Made-up advice about imaginary gear ratios for the demo drivetrain. Bring sample money.' },
      { title: 'A made-up café stop worth the detour', author: 'Demo Rider', mins: 7 * 24 * 60,
        summary: 'The demo route turns here for a fictional toast. Sample content, sample crumbs.' },
    ],
  },
  {
    url: 'https://demo.invalid/mock-space-notes.xml', title: 'Mock Space Notes',
    posts: [
      { title: 'What the made-up telescope saw on Tuesday night', author: 'Demo Astronomer', mins: 24 * 60,
        summary: 'A demo post about a demo comet. Nothing here was observed by anyone.' },
      { title: 'A demo comet with a fictional tail', author: 'Demo Astronomer', mins: 2 * 24 * 60,
        summary: 'Staging sample content about a comet that exists only in this paragraph and shines only in this list.' },
      { title: 'Counting the imaginary moons of a sample planet', author: 'Sample Astronomer', mins: 3 * 24 * 60,
        summary: 'Made-up telescope time, fictional data, invented totals. The demo moon count stands at eleven.' },
      { title: 'The pretend launch window opens in staging', author: 'Demo Astronomer', mins: 5 * 24 * 60,
        summary: 'Demo notes on a fictional rocket that lifts off nowhere, watched by nobody, in sample weather.' },
      { title: 'Made-up constellations for cloudy nights', author: 'Sample Astronomer', mins: 6 * 24 * 60,
        summary: 'Sample content: three fictional star patterns drawn for this demo and named after placeholder things.' },
    ],
  },
];

async function writeDemoData(userId, now) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const source of DEMO_FEEDS) {
      const inserted = await client.query(
        `INSERT INTO feeds (user_id, url, title, site_url, is_demo)
         VALUES ($1, $2, $3, NULL, true) ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
        [userId, source.url, source.title]);
      const feedId = inserted.rows.length
        ? inserted.rows[0].id
        : (await client.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2',
          [userId, source.url])).rows[0].id;
      for (const post of source.posts) {
        await client.query(
          `INSERT INTO posts (feed_id, guid, title, link, summary, author, published_at, fetched_at)
           VALUES ($1, $2, $3, NULL, $4, $5, $6, $7) ON CONFLICT (feed_id, guid) DO NOTHING`,
          [feedId, `demo-${feedId}-${source.posts.indexOf(post) + 1}`, post.title, post.summary,
            post.author, new Date(now.getTime() - post.mins * 60_000), now]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

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

  // Shutdown: stop taking new connections, give in-flight requests about
  // three seconds to finish, close the pool, exit.
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: shutting down`);
    server.close();
    setTimeout(() => {
      pool.end().finally(() => process.exit(0));
    }, 3000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
