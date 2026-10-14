const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { fetchFeed, normalizeFeedUrl } = require('./lib/feeds');

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

// ── The reader ────────────────────────────────────────────────────────────
// Schema boot: idempotent, runs once at startup. feeds and posts are per
// user, which is exactly the kind of data that must not be copied into
// staging, so both are marked private (demo_seeded records the same).
async function bootSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      site_url TEXT NOT NULL DEFAULT '',
      demo BOOLEAN NOT NULL DEFAULT false,
      last_error TEXT,
      last_fetched_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, url)
    );
    CREATE TABLE IF NOT EXISTS posts (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      feed_id BIGINT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      link TEXT,
      author TEXT,
      summary TEXT NOT NULL DEFAULT '',
      published_at TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (feed_id, guid)
    );
    CREATE TABLE IF NOT EXISTS demo_seeded (user_id TEXT PRIMARY KEY);
    COMMENT ON TABLE feeds IS 'staging:private';
    COMMENT ON TABLE posts IS 'staging:private';
    COMMENT ON TABLE demo_seeded IS 'staging:private';
  `);
}

// Wraps a route so an unexpected database error becomes an honest 500.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  console.error(req.method, req.path, 'failed:', err.message);
  if (!res.headersSent) res.status(500).json({ error: 'That did not work on our side. Try again in a moment.' });
});

// Staging demo (?demo=1, staging only): four made-up feeds, 14 unread posts
// spread over the past week. Seeded once per user, recorded in
// demo_seeded, so the same viewer gets the same screen every time. The
// feeds are marked demo, so responses without ?demo=1 leave them out and
// refresh never touches them.
const DEMO_FEEDS = [
  {
    url: 'https://tinygarden.example/feed.xml', title: 'Tiny Garden Notes', siteUrl: 'https://tinygarden.example/',
    posts: [
      { n: 1, at: -115, author: 'Rowan', title: 'Why my balcony tomatoes finally ripened in October', link: '/posts/tomatoes-in-october',
        summary: 'A late heat wave, a bucket of rainwater and one stubborn plant. Here is what changed this year and what I would try again next spring.\n\nThe short version: I stopped feeding in August, moved the pots against the warm wall and pinched off every new flower, so the plant put its effort into the fruit it already had.' },
      { n: 2, at: -2870, author: 'Rowan', title: 'Saving seeds from this summer’s beans', link: '/posts/saving-bean-seeds',
        summary: 'Dry them on the vine, shell them indoors and label everything twice. A short checklist for next year’s planting.\n\nOne note from experience: beans keep their colour best if they finish drying on a windowsill, not in a sealed jar.' },
      { n: 3, at: -4300, author: 'Rowan', title: 'A rainwater barrel, one month in', link: '/posts/rainwater-barrel',
        summary: 'The barrel paid for itself in saved tap water alone. What surprised me was the temperature: rainwater is warmer at dusk, and the seedlings noticed.\n\nThe mesh lid keeps out leaves and mosquitoes. Cleaning it takes five minutes.' },
      { n: 4, at: -7100, author: 'Rowan', title: 'Five herbs that forgive neglect', link: '/posts/five-forgiving-herbs',
        summary: 'Sage, rosemary, chives, oregano and mint. Miss a watering, come back in a week, and they are still standing. Beginners start here.\n\nMint is the only one that needs a pot of its own, and the reason is its roots, not its manners.' },
      { n: 5, at: -9800, author: 'Rowan', title: 'What I planted too early this spring', link: '/posts/planted-too-early',
        summary: 'The soil was ready before the nights were. A short list of what sat sulking in cold ground and what I will wait two more weeks for next year.\n\nThe beans were the worst of it. The peas did not mind at all.' },
    ],
  },
  {
    url: 'https://breadlab.example/weekly.xml', title: 'Bread Lab Weekly', siteUrl: 'https://breadlab.example/',
    posts: [
      { n: 1, at: -300, author: 'Bea', title: 'A slower rye starter, fed twice a day', link: '/posts/slower-rye-starter',
        summary: 'Our test loaves rose higher on a cooler schedule. The method, the timings we logged and the one mistake that cost us a batch.\n\nRye wants patience, not warmth. Two small feeds a day at room temperature beat one big feed by the oven.' },
      { n: 2, at: -1500, author: 'Bea', title: 'The 80 percent hydration loaf, tamed', link: '/posts/high-hydration-tamed',
        summary: 'Wet dough looks unmanageable until you learn four folds. We wrote the schedule so you can follow it while the kettle boils.\n\nThe crust came out thinner, not thicker, which nobody in the lab predicted.' },
      { n: 3, at: -4300, author: 'Bea', title: 'Oven spring: what actually made the difference', link: '/posts/oven-spring',
        summary: 'We split one dough across three pans and changed one thing each. Steam, stone and a longer final proof, in order of effect.\n\nThe stone mattered most. Steam mattered less than the internet says.' },
      { n: 4, at: -6100, author: 'Bea', title: 'Our plain white loaf, from starter to crumb', link: '/posts/plain-white-loaf',
        summary: 'The recipe we hand to anyone who asks where to begin. Four ingredients, one bowl, and a crumb photo of every attempt we logged.\n\nThe beginner loaves in the photos are honest. Do not compare yourself to the last one.' },
    ],
  },
  {
    url: 'https://pixeltrail.example/rss.xml', title: 'Pixel Trail', siteUrl: 'https://pixeltrail.example/',
    posts: [
      { n: 1, at: -1600, author: 'Miko', title: 'Drawing a whole forest in sixteen colours', link: '/posts/forest-sixteen-colours',
        summary: 'Limiting the palette forced better choices about light. A walkthrough of the tiles, the shading rules and the final scene.\n\nFour of the sixteen do nothing but bridge the shadows. Removing them makes the whole forest go flat.' },
      { n: 2, at: -2900, author: 'Miko', title: 'Tile size and the illusion of distance', link: '/posts/tile-size-distance',
        summary: 'Small tiles make everything look far away, until they do not. Notes from three maps drawn at three sizes.\n\nThe trick nobody mentions: keep the horizon line high and let the foreground go detailed and dark.' },
      { n: 3, at: -5600, author: 'Miko', title: 'Shading rules for a lantern-lit cave', link: '/posts/lantern-cave-shading',
        summary: 'One light source, two rules, and a scene that reads at a glance. The rules survive being copied, which is the point.\n\nWarm light on everything within reach of the lantern, cool everywhere else, and never blend between them.' },
    ],
  },
  {
    url: 'https://quietmaps.example/feed.xml', title: 'Quiet Maps', siteUrl: 'https://quietmaps.example/',
    posts: [
      { n: 1, at: -1800, author: 'Sable', title: 'Contour lines, explained with a potato', link: '/posts/contours-with-a-potato',
        summary: 'Slice it, trace it, stack the outlines. The easiest way we have found to show how a hill turns into a topographic map.\n\nA lumpy sweet potato makes better outlines than a neat one. The wobbles are the lesson.' },
      { n: 2, at: -3100, author: 'Sable', title: 'Reading a legend like a short story', link: '/posts/reading-a-legend',
        summary: 'Every map legend quietly tells you what the mapmaker worried about. We read three old hiking maps and guessed the anxieties behind each symbol.\n\nThe third map devotes five symbols to bogs. It was written after one very bad weekend.' },
    ],
  },
];

async function ensureDemoSeed(userId, at) {
  const marked = await pool.query(
    'INSERT INTO demo_seeded (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  if (!marked.rowCount) return; // already seeded for this user
  for (const feed of DEMO_FEEDS) {
    const ins = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, demo) VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
      [userId, feed.url, feed.title, feed.siteUrl]);
    let feedId = ins.rows[0] && ins.rows[0].id;
    if (!feedId) {
      const ex = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [userId, feed.url]);
      feedId = ex.rows[0].id;
    }
    for (const post of feed.posts) {
      await pool.query(
        `INSERT INTO posts (feed_id, guid, title, link, author, summary, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (feed_id, guid) DO NOTHING`,
        [feedId, feed.url + '#' + post.n, post.title, feed.siteUrl.replace(/\/$/, '') + post.link,
         post.author, post.summary, new Date(new Date(at).getTime() + post.at * 60_000)]);
    }
  }
}

// GET /api/reader: the feeds (with unread counts and per-feed errors) and
// every unread post, newest first by published_at, falling back to
// created_at. Demo rows only join in on ?demo=1, and only on staging.
app.get('/api/reader', wrap(async (req, res) => {
  const uid = req.user ? req.user.id : null;
  const demo = !!uid && req.query.demo === '1' && IS_STAGING;
  if (!uid) return res.json({ feeds: [], posts: [] }); // a guest sees the empty screen
  if (demo) await ensureDemoSeed(uid, req.now);
  const feeds = (await pool.query(
    `SELECT f.id, f.url, f.title, f.last_error,
       (SELECT count(*)::int FROM posts p WHERE p.feed_id = f.id AND p.read_at IS NULL) AS unread
     FROM feeds f
     WHERE f.user_id = $1 AND ($2::bool OR f.demo = false)
     ORDER BY f.created_at, f.id`, [uid, demo])).rows;
  const posts = (await pool.query(
    `SELECT p.id, p.feed_id, p.title, p.link, p.author, p.summary, p.published_at, p.created_at,
            f.title AS feed_title, f.site_url
     FROM posts p JOIN feeds f ON f.id = p.feed_id
     WHERE f.user_id = $1 AND p.read_at IS NULL AND ($2::bool OR f.demo = false)
     ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC`, [uid, demo])).rows;
  res.json({ feeds, posts });
}));

// POST /api/feeds { url }: fetch, parse, store. 400 with a plain `reason`
// for anything the person typed wrong or that could not be fetched.
app.post('/api/feeds', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const url = normalizeFeedUrl(req.body && req.body.url);
  if (!url) {
    return res.status(400).json({
      error: 'not-a-feed',
      reason: 'That address does not look like a feed. It should point at the page the feed is served from, like example.com/feed.xml.',
    });
  }
  const existing = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [req.user.id, url]);
  if (existing.rows.length) {
    return res.status(400).json({ error: 'already-added', reason: 'That feed is already in your list.' });
  }
  try {
    const parsed = await fetchFeed(url);
    const ins = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, demo, last_fetched_at)
       VALUES ($1, $2, $3, $4, false, $5) ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
      [req.user.id, url, parsed.title || url, parsed.siteUrl || '', req.now]);
    if (!ins.rows.length) {
      return res.status(400).json({ error: 'already-added', reason: 'That feed is already in your list.' });
    }
    const added = await insertPosts(ins.rows[0].id, parsed.posts);
    res.json({ ok: true, id: ins.rows[0].id, title: parsed.title || url, added });
  } catch (err) {
    console.warn('add feed failed:', err.message);
    const code = err.code === 'EGUARD' ? 'address-not-allowed'
      : err.code === 'ENOTFEED' ? 'not-a-feed' : 'could-not-reach';
    res.status(400).json({ error: code, reason: err.reason || 'The feed could not be added.' });
  }
}));

// New posts into storage; existing (feed_id, guid) pairs are left alone.
async function insertPosts(feedId, posts) {
  let added = 0;
  for (const post of posts.slice(0, 100)) {
    const r = await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, author, summary, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedId, post.guid.slice(0, 2000), (post.title || '').slice(0, 2000), post.link || null,
       (post.author || '').slice(0, 500) || null, (post.summary || '').slice(0, 20_000), post.published]);
    added += r.rowCount;
  }
  return added;
}

app.delete('/api/feeds/:id', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'No such feed.' });
  const del = await pool.query('DELETE FROM feeds WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  if (!del.rowCount) return res.status(404).json({ error: 'No such feed.' });
  res.json({ ok: true }); // the posts went with it (ON DELETE CASCADE)
}));

// POST /api/posts/:id/read: set read_at, once. idempotent.
app.post('/api/posts/:id/read', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(404).json({ error: 'No such post.' });
  const r = await pool.query(
    `UPDATE posts p SET read_at = $3
     WHERE p.id = $1 AND p.read_at IS NULL
       AND EXISTS (SELECT 1 FROM feeds f WHERE f.id = p.feed_id AND f.user_id = $2)`,
    [id, req.user.id, req.now]);
  res.json({ ok: true, wasUnread: r.rowCount > 0 });
}));

// POST /api/refresh { feedId? }: fetch the non-demo feeds (or one), insert
// what is new, and record how each one went. Demo feeds are made up, so
// they are never fetched.
app.post('/api/refresh', wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const feedId = Number(req.body && req.body.feedId);
  const one = Number.isSafeInteger(feedId) && feedId > 0;
  const rows = (await pool.query(
    'SELECT id, url FROM feeds WHERE user_id = $1 AND demo = false' + (one ? ' AND id = $2' : '') + ' ORDER BY created_at',
    one ? [req.user.id, feedId] : [req.user.id])).rows;
  const results = await Promise.all(rows.map((feed) => refreshFeed(feed, req.user.id, req.now)));
  res.json({ results });
}));

async function refreshFeed(feed, uid, at) {
  try {
    const parsed = await fetchFeed(feed.url);
    const added = await insertPosts(feed.id, parsed.posts);
    await pool.query(
      `UPDATE feeds SET last_error = NULL, last_fetched_at = $2,
         title = CASE WHEN title = '' OR title = url THEN $3 ELSE title END
       WHERE id = $1`, [feed.id, at, parsed.title || feed.url]);
    return { id: feed.id, ok: true, added };
  } catch (err) {
    await pool.query('UPDATE feeds SET last_error = $2, last_fetched_at = $3 WHERE id = $1',
      [feed.id, (err.reason || err.message || 'The feed could not be fetched.').slice(0, 500), at]);
    return { id: feed.id, ok: false, error: err.reason || 'The feed could not be fetched.' };
  }
}

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
  await bootSchema();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // The platform stops a container with SIGTERM: stop accepting, give
  // in-flight requests a few seconds to drain, then close the database
  // pool so nothing is left half-written.
  let closing = false;
  const shutdown = (sig) => {
    if (closing) return;
    closing = true;
    console.log(`Received ${sig}, shutting down…`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => pool.end().then(() => process.exit(0)), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
