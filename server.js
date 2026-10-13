const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { safeFetch, parseFeed, fetchError } = require('./feeds');

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

// ── Feeds and posts ─────────────────────────────────────────────────────────
// Each person's feeds and their read/unread state, private to them: every
// query filters by feeds.user_id. The app fetches each feed when the list
// opens and on Refresh or pull down; it never checks in the background.
const MAX_POSTS = 500;

const feedOut = (r) => ({ id: r.id, title: r.title, url: r.url, error: r.last_error || null });
const postOut = (r) => ({
  id: r.id, feedTitle: r.feed_title, title: r.title, link: r.link,
  author: r.author, summary: r.summary, publishedAt: r.published_at,
});

async function insertItems(feedId, items, now) {
  for (const item of items.slice(0, 100)) {
    await pool.query(`INSERT INTO posts (feed_id, guid, title, link, author, summary, published_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
    [feedId, item.guid, item.title, item.link, item.author, item.summary, item.publishedAt || now, now]);
  }
}

// One feed, fetched and parsed; a failure goes in last_error, never throws.
async function refreshFeed(feed, now) {
  try {
    const { url, text } = await safeFetch(feed.url);
    const parsed = await parseFeed(text);
    await insertItems(feed.id, parsed.items, now);
    await pool.query('UPDATE feeds SET title = $2, site_url = COALESCE($3, site_url), last_error = NULL WHERE id = $1',
      [feed.id, parsed.title, parsed.siteUrl]);
  } catch (err) {
    console.warn('feed refresh failed: ' + feed.url + ' — ' + (err && err.message));
    await pool.query('UPDATE feeds SET last_error = $2 WHERE id = $1', [feed.id, fetchError(err)]);
  }
}

const SELECT_FEEDS = 'SELECT id, url, title, site_url, last_error, is_demo FROM feeds WHERE user_id = $1 ORDER BY created_at, id';
// The plain route answers what production would: the rows ?demo=1 wrote for
// the viewing account are demo rows and never part of the person's real
// list, here or on any later visit without ?demo=1.
const SELECT_FEEDS_REAL = 'SELECT id, url, title, site_url, last_error, is_demo FROM feeds WHERE user_id = $1 AND NOT is_demo ORDER BY created_at, id';

app.get('/api/posts', async (req, res) => {
  // Read routes must not assume req.user: a signed-out visitor (or a guest)
  // reads an empty list, not an error — writes still need an account.
  const uid = req.user ? Number(req.user.id) : null;
  const demo = IS_STAGING && req.query.demo === '1' && req.user ? await writeDemo(uid, req.now) : false;
  const feedQuery = demo ? SELECT_FEEDS : SELECT_FEEDS_REAL;
  const first = await pool.query(feedQuery, [uid]);
  // Refresh the person's real feeds in parallel; demo feeds are never fetched.
  await Promise.all(first.rows.filter((f) => !f.is_demo).map((f) => refreshFeed(f, req.now)));
  const feeds = await pool.query(feedQuery, [uid]);
  const { rows } = await pool.query(`SELECT p.*, f.title AS feed_title FROM posts p JOIN feeds f ON f.id = p.feed_id
    WHERE f.user_id = $1 ${demo ? '' : 'AND f.is_demo = false'} AND p.read_at IS NULL
    ORDER BY p.published_at DESC, p.id DESC LIMIT ${MAX_POSTS}`, [uid]);
  return res.json({ posts: rows.map(postOut), feeds: feeds.rows.map(feedOut), demo });
});

app.post('/api/feeds', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const uid = Number(req.user.id);
  const raw = typeof (req.body || {}).url === 'string' ? req.body.url.trim() : '';
  if (!raw) return res.status(400).json({ error: 'Paste the feed address first.' });
  let fetched;
  try {
    fetched = await safeFetch(raw);
    await parseFeed(fetched.text);
  } catch (err) {
    const message = err && err.notFeed ? err.message : fetchError(err);
    return res.status(400).json({ error: message });
  }
  const parsed = await parseFeed(fetched.text);
  const dup = await pool.query('SELECT 1 FROM feeds WHERE user_id = $1 AND url = $2', [uid, fetched.url]);
  if (dup.rows.length) return res.status(400).json({ error: 'You already added this feed.' });
  const { rows } = await pool.query(
    'INSERT INTO feeds (user_id, url, title, site_url, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [uid, fetched.url, parsed.title, parsed.siteUrl, req.now]);
  await insertItems(rows[0].id, parsed.items, req.now);
  return res.status(201).json({ feed: { id: rows[0].id, title: parsed.title, url: fetched.url } });
});

app.delete('/api/feeds/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'That feed could not be found.' });
  const { rows } = await pool.query('DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id', [id, Number(req.user.id)]);
  if (!rows.length) return res.status(404).json({ error: 'That feed is not in your list.' });
  return res.json({ ok: true });
});

app.post('/api/posts/:id/read', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'That post could not be found.' });
  await pool.query(`UPDATE posts SET read_at = $3 WHERE id = $1 AND read_at IS NULL
    AND feed_id IN (SELECT id FROM feeds WHERE user_id = $2)`, [id, Number(req.user.id), req.now]);
  return res.json({ ok: true });
});

// ── Staging demo (IS_STAGING && ?demo=1 only) ───────────────────────────────
// The viewing account gets their own four made-up feeds and 14 posts (12
// unread, 2 already read), written once: fixed guids and ON CONFLICT DO
// NOTHING, so a reload changes nothing and reads persist. Refresh skips
// these feeds (is_demo), so the .test addresses are never fetched. They
// show only on ?demo=1: the plain route filters is_demo rows out, so it
// always answers what production would.
const DEMO_FEEDS = [
  { url: 'https://feeds.example-garden.test/rss.xml', title: 'The Example Garden Journal', site: 'https://example-garden.test' },
  { url: 'https://feeds.demo-cycling.test/rss.xml', title: 'Demo Cycling Weekly', site: 'https://demo-cycling.test' },
  { url: 'https://feeds.sample-kitchen.test/rss.xml', title: 'Sample Kitchen Notes', site: 'https://sample-kitchen.test' },
  { url: 'https://feeds.fictional-space.test/rss.xml', title: 'Fictional Space Desk', site: 'https://fictional-space.test' },
];
const MINUTE = 60_000;
const DEMO_POSTS = [
  { url: DEMO_FEEDS[0].url, guid: 'demo-garden-001', age: 12, title: 'Ten tomato varieties we grew on a pretend balcony', author: 'Demo Author',
    summary: 'A season of made-up harvests, from the sweet cherry types that never stopped fruiting to the beefsteaks that sulked all July.' },
  { url: DEMO_FEEDS[1].url, guid: 'demo-cycling-001', age: 60, title: 'How to patch a tube in five minutes, roadside', author: 'Demo Rider',
    summary: 'The kit that fits in a saddle bag, and the one step most riders skip that makes the patch hold.' },
  { url: DEMO_FEEDS[2].url, guid: 'demo-kitchen-001', age: 180, title: 'A weeknight lentil soup that tastes like Sunday', author: 'Demo Cook',
    summary: 'Smoked paprika, a squeeze of lemon at the end, and twenty-five minutes on the hob.' },
  { url: DEMO_FEEDS[3].url, guid: 'demo-space-001', age: 360, title: 'A meteor shower worth setting an alarm for', author: 'Demo Skywatcher',
    summary: 'The peak, where to look, and why a deck chair beats a telescope this week.' },
  { url: DEMO_FEEDS[1].url, guid: 'demo-cycling-002', age: 300, title: 'The flat river loop, mapped for slow riders', author: 'Demo Rider',
    summary: 'Fourteen kilometres with no hills at all, three bench stops and an ice cream stand at the halfway point.' },
  { url: DEMO_FEEDS[0].url, guid: 'demo-garden-002', age: 420, title: 'The compost bin we built from old pallets', author: 'Demo Author',
    summary: 'Four pallets, a handful of screws and a winter of guessing. What broke down well, what just sat there, and the turn schedule we settled on.' },
  { url: DEMO_FEEDS[2].url, guid: 'demo-kitchen-002', age: 540, title: 'The only pancake ratio you need to memorise', author: 'Demo Cook',
    summary: 'One egg, one cup of flour, one cup of milk. Sunday is saved; add blueberries at your own risk.' },
  { url: DEMO_FEEDS[0].url, guid: 'demo-garden-003', age: 1300, title: "A beginner's guide to not overwatering", author: 'Demo Author',
    summary: 'The finger test, the pot-weight trick, and why the saddest-looking plant on the balcony was drinking far too much.' },
  { url: DEMO_FEEDS[3].url, guid: 'demo-space-002', age: 1680, read: true, title: 'What the new test telescope saw in its first week', author: 'Demo Skywatcher',
    summary: 'Early images from an imaginary observatory, and why its engineers are pleased with the mirror.' },
  { url: DEMO_FEEDS[1].url, guid: 'demo-cycling-003', age: 1200, title: 'Winter gloves, ranked by somebody with cold hands', author: 'Demo Rider',
    summary: 'Five pairs, one genuinely warm winner, and the shame of the freezer test.' },
  { url: DEMO_FEEDS[3].url, guid: 'demo-space-003', age: 1900, title: 'The satellite that photographs gardens from orbit', author: 'Demo Skywatcher',
    summary: 'Imaginary land-plot imagery, one made-up launch, and what a lettuce looks like from five hundred kilometres up.' },
  { url: DEMO_FEEDS[2].url, guid: 'demo-kitchen-003', age: 2040, read: true, title: 'Stock take: the freezer, honestly', author: 'Demo Cook',
    summary: 'An inventory of three bags of peas, an ancient curry and hope. The meals we planned to use all of it up.' },
  { url: DEMO_FEEDS[1].url, guid: 'demo-cycling-004', age: 2200, title: 'What a tune-up actually includes', author: 'Demo Rider',
    summary: "We watched the whole workshop: cables, brake pads, wheel truing, and the mysterious ten-minute ritual called 'the wiggle'." },
  { url: DEMO_FEEDS[0].url, guid: 'demo-garden-004', age: 2880, title: 'Seed swap day: what we brought home', author: 'Demo Author',
    summary: "Marigolds, two kinds of lettuce and a mystery packet labelled only 'purple'. The whole swap, catalogued." },
];

async function writeDemo(uid, now) {
  for (const feed of DEMO_FEEDS) {
    await pool.query(
      'INSERT INTO feeds (user_id, url, title, site_url, is_demo, created_at) VALUES ($1, $2, $3, $4, true, $5) ON CONFLICT DO NOTHING',
      [uid, feed.url, feed.title, feed.site, now]);
  }
  const { rows } = await pool.query('SELECT id, url FROM feeds WHERE user_id = $1 AND is_demo', [uid]);
  const byUrl = new Map(rows.map((r) => [r.url, r.id]));
  for (const post of DEMO_POSTS) {
    const feedId = byUrl.get(post.url);
    if (!feedId) continue;
    await pool.query(`INSERT INTO posts (feed_id, guid, title, link, author, summary, published_at, read_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
    [feedId, post.guid, post.title, new URL('/posts/' + post.guid, post.url.replace('/rss.xml', '')).href, post.author, post.summary,
      new Date(now.getTime() - post.age * MINUTE), post.read ? now : null, now]);
  }
  return true;
}

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS feeds (
    id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL,
    site_url TEXT, last_error TEXT, is_demo BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (user_id, url))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY, feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid TEXT NOT NULL, title TEXT NOT NULL, link TEXT, author TEXT, summary TEXT,
    published_at TIMESTAMPTZ NOT NULL, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (feed_id, guid))`);
  await pool.query('CREATE INDEX IF NOT EXISTS posts_feed_published_idx ON posts (feed_id, published_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS posts_user_unread_idx ON posts (feed_id, read_at)');
  // Both tables hold one person's own feeds and read marks: private.
  await pool.query("COMMENT ON TABLE feeds IS 'staging:private'");
  await pool.query("COMMENT ON TABLE posts IS 'staging:private'");
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
  // Stop cleanly: stop listening, drain for up to 3 s, close the pool, exit.
  const stop = (signal) => {
    console.log(`${signal}: shutting down`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
