const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { fetchFeed, parseFeed, FeedError } = require('./feed');

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

// ── Feeds and posts ──────────────────────────────────────────────────────
// Every viewer's feeds and posts are theirs alone (staging:private tables:
// the platform backs up and clears them like account data). Reads scope to
// req.user.id; guests get an empty list; writes need an account.

// The boot migration: idempotent, so it is safe on every start.
async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS feeds (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    site_url TEXT,
    demo BOOLEAN NOT NULL DEFAULT FALSE,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS posts (
    id SERIAL PRIMARY KEY,
    feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    link TEXT,
    published_at TIMESTAMPTZ,
    snippet TEXT NOT NULL DEFAULT '',
    content_html TEXT NOT NULL DEFAULT '',
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL)`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url_uq ON feeds (user_id, url)');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS posts_feed_guid_uq ON posts (feed_id, guid)');
  await pool.query('CREATE INDEX IF NOT EXISTS posts_feed_read_idx ON posts (feed_id, read_at)');
  await pool.query("COMMENT ON TABLE feeds IS 'staging:private'");
  await pool.query("COMMENT ON TABLE posts IS 'staging:private'");
}

// Store what a parse found, unread, under the feed. ON CONFLICT DO NOTHING:
// a guid already stored keeps its read_at, so re-reading a feed never marks
// a read post unread again.
async function storeItems(feedId, parsed, now) {
  for (const item of parsed.items.slice(0, 200)) {
    if (!item.guid && !item.title) continue;
    await pool.query(`INSERT INTO posts (feed_id, guid, title, link, published_at, snippet, content_html, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedId, item.guid, item.title, item.link || null, item.publishedAt || now, item.snippet, item.contentHtml, now]);
  }
}

// Refresh one feed. A failure is recorded on the feed, not thrown: the rest
// of the list must still load, and the failed feed says so above it.
async function refreshFeed(feed, now) {
  try {
    const parsed = parseFeed(await fetchFeed(feed.url));
    await storeItems(feed.id, parsed, now);
    await pool.query('UPDATE feeds SET last_error = NULL, title = $2, site_url = $3 WHERE id = $1',
      [feed.id, parsed.title || feed.title, parsed.siteUrl || feed.site_url]);
  } catch (err) {
    console.warn(`refresh ${feed.url}: ${err.message}`);
    await pool.query('UPDATE feeds SET last_error = $2 WHERE id = $1', [feed.id, err.message]);
  }
}

// ── Staging demo (?demo=1) ───────────────────────────────────────────────
// Written once per viewer, on the first ?demo=1 request: four made-up feeds
// (hosts end .invalid and are never fetched) and sixteen unread posts on
// gentle everyday topics, minutes to days old, dated against req.now. Fixed
// guids + ON CONFLICT DO NOTHING keep it idempotent. Demo content is
// authored here, not fetched, so it is trusted as-is.
const DEMO_FEEDS = [
  { key: 'pg', title: 'Pocket Garden Weekly', slug: 'pocket-garden-weekly' },
  { key: 'tb', title: 'Tinkerbench Notes', slug: 'tinkerbench-notes' },
  { key: 'sk', title: 'Slow Kitchen Journal', slug: 'slow-kitchen-journal' },
  { key: 'mt', title: 'Meadow Trail Blog', slug: 'meadow-trail-blog' },
];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const DEMO_POSTS = [
  { feed: 'pg', guid: 'demo-pg-1', ago: 12 * 60_000, title: 'Five herbs that grow happily on a windowsill', snippet: 'Basil, chives and mint need little more than a bright sill and a weekly drink. Here is how to start them from cuttings this month.', html: '<p>Basil, chives and mint need little more than a bright sill and a weekly drink. Start them from cuttings: a finger-length stem in a glass of water roots within two weeks.</p><img src="/demo/herbs.svg" alt="Line drawing of two pots of herbs on a sill"><p>Pot them up once the roots are as long as your thumbnail, and pinch off the tips every fortnight so they grow bushy rather than tall.</p>' },
  { feed: 'tb', guid: 'demo-tb-1', ago: 1 * HOUR, title: 'Building a tiny weather station from spare parts', snippet: 'A sensor, a microcontroller and an old jam jar make a surprisingly accurate rain gauge. Parts list and wiring inside.', html: '<p>A sensor, a microcontroller and an old jam jar make a surprisingly accurate rain gauge. The jar sits outside; the sensor sits under it; a line of code does the sums.</p><p>The whole build costs about as much as a sandwich and takes an afternoon. The parts list and the wiring sketch are at the end of the post.</p>' },
  { feed: 'sk', guid: 'demo-sk-1', ago: 3 * HOUR, title: 'The one-pan lentil soup we keep coming back to', snippet: 'Red lentils, a tin of tomatoes and a squeeze of lemon. Twenty-five minutes, one pan, and it freezes well for later.', html: '<p>Red lentils, a tin of tomatoes and a squeeze of lemon. Twenty-five minutes, one pan, and it freezes well for later.</p><p>Rinse the lentils until the water runs clear, then everything goes in at once. The lemon goes in last, off the heat, or it turns dull.</p>' },
  { feed: 'mt', guid: 'demo-mt-1', ago: 1 * DAY, title: 'A quiet loop walk through the sample valley', snippet: 'Six kilometres of gentle paths, two footbridges and a bench with the best view of the made-up river. Map and photos.', html: '<p>Six kilometres of gentle paths, two footbridges and a bench with the best view of the made-up river. Allow two hours with a stop.</p><p>Start at the car park gate and keep the water on your left. The second footbridge is the one with the carved handrail.</p>' },
  { feed: 'pg', guid: 'demo-pg-2', ago: 2 * DAY, title: 'Why your tomato leaves curl, and what to do', snippet: 'Curling leaves are usually heat or uneven watering, rarely disease. Three checks to run before you reach for anything else.', html: '<p>Curling leaves are usually heat or uneven watering, rarely disease. Check the soil a knuckle deep: dry on top and damp below means the watering is close enough.</p><p>Only when the curl comes with spotting or sticky residue is it worth looking for something to spray. Usually there is not.</p>' },
  { feed: 'tb', guid: 'demo-tb-2', ago: 8 * HOUR, title: 'Labelling every cable, finally', snippet: 'A strip of masking tape and a pencil outlast every printed label we have tried. A ten-minute job that pays back for years.', html: '<p>A strip of masking tape and a pencil outlast every printed label we have tried. The pencil does not flake, and the tape peels off a plug without leaving glue.</p><p>Label both ends. In six months you will not remember which brick is which, and you will thank a ten-minute job from today.</p>' },
  { feed: 'pg', guid: 'demo-pg-3', ago: 5 * HOUR, title: 'A compost caddy that does not smell', snippet: 'The trick is a lid that seals and a fortnightly rinse with the hose. What to look for when you pick one.', html: '<p>The trick is a lid that seals and a fortnightly rinse with the hose. Everything else — charcoal filters, liners — is optional.</p><p>Pick one that opens one-handed, because the other hand is usually holding a chopping board.</p>' },
  { feed: 'sk', guid: 'demo-sk-2', ago: 1 * DAY, title: 'A loaf that forgives a lazy morning', snippet: 'A wet dough mixed the night before needs no kneading and no attention. It bakes in a covered pot while the kettle boils.', html: '<p>A wet dough mixed the night before needs no kneading and no attention. It bakes in a covered pot while the kettle boils.</p><p>Mix flour, water, salt and a scrape of yeast, put a plate over the bowl, and go to bed. In the morning it has risen by itself.</p>' },
  { feed: 'mt', guid: 'demo-mt-2', ago: 2 * DAY, title: 'Where the footbridge crosses at low water', snippet: 'The stepping stones beside it dry within an hour of the rain stopping. Which route to take after a wet week.', html: '<p>The stepping stones beside the bridge dry within an hour of the rain stopping. After a wet week, take the bridge — the middle stone wobbles.</p><p>Look for kingfishers from the far bank in the early evening. They fish below the second bend.</p>' },
  { feed: 'sk', guid: 'demo-sk-3', ago: 3 * DAY, title: 'Pickling a jar of red onions in ten minutes', snippet: 'Thin slices, vinegar, a spoon of sugar and a pinch of salt. They keep three weeks in the door of the fridge.', html: '<p>Thin slices, vinegar, a spoon of sugar and a pinch of salt. They keep three weeks in the door of the fridge and improve everything from eggs to curries.</p><p>Use a clean jar, not one that held chutney. The onions turn pink by the next day; that is meant to happen.</p>' },
  { feed: 'tb', guid: 'demo-tb-3', ago: 2 * DAY, title: 'A desk lamp brought back with one small switch', snippet: 'Flicking switches fail before bulbs do. Twenty minutes and one part, and the lamp went back to work.', html: '<p>Flicking switches fail before bulbs do. The lamp clicked, did nothing, and sat in a drawer for a year before twenty minutes and one part brought it back.</p><p>Unplug it first. Photograph the wiring before you undo anything. The rest is patient screwing.</p>' },
  { feed: 'pg', guid: 'demo-pg-4', ago: 4 * DAY, title: 'When to bring the pots back indoors', snippet: 'Nights below seven degrees are the cue for tender plants. How to move them without bringing the bugs in too.', html: '<p>Nights below seven degrees are the cue for tender plants. Move them over a week, in and out by day, so they take the change slowly.</p><p>Before they come in, give the leaves a rinse and check under them. The bugs you miss in October are the ones you meet all winter.</p>' },
  { feed: 'mt', guid: 'demo-mt-3', ago: 3 * DAY, title: 'Reading the sky before an evening stroll', snippet: 'Pink at the base of a cloud means dry for another hour. A short guide to the three clouds worth knowing.', html: '<p>Pink at the base of a cloud means dry for another hour. Three clouds are worth knowing by name, and two of them mean go home.</p><p>The guide takes ten minutes to read and the next walk to try out. Keep the map in your pocket whatever the sky says.</p>' },
  { feed: 'sk', guid: 'demo-sk-4', ago: 6 * DAY, title: 'Tea, toast and the case for a slower breakfast', snippet: 'Ten quiet minutes before the day starts costs nothing and changes how the morning goes. A short argument for it.', html: '<p>Ten quiet minutes before the day starts costs nothing and changes how the morning goes. Make the tea, sit down, eat the toast without a screen.</p><p>That is the whole idea. The hard part is only doing it tomorrow as well.</p>' },
  { feed: 'tb', guid: 'demo-tb-4', ago: 5 * DAY, title: 'Making a rain gauge from a jam jar', snippet: 'A straight-sided jar on level ground in the open reads as well as the thing you can buy. How to mark and place it.', html: '<p>A straight-sided jar on level ground in the open reads as well as the thing you can buy. Mark millimetres on tape down the side with a ruler.</p><p>Empty it at the same time each morning. Two weeks of readings and you will know your garden better than the forecast does.</p>' },
  { feed: 'pg', guid: 'demo-pg-5', ago: 5 * DAY, title: 'A watering can with a long spout earns its keep', snippet: 'The rose at the end is what saves the seedlings. Why the cheap one with the long spout beats the fancy one.', html: '<p>The rose at the end is what saves the seedlings: it breaks the water into rain instead of a jet. That is the whole secret.</p><p>Buy the cheap one with the longest spout you can find and a rose that screws off. The fancy ones are heavy and proud of it.</p>' },
];

// Writes the demo feeds and posts once per viewer. Returns true when the
// viewer is in demo mode, and false for real data (or a guest).
async function seedDemo(req) {
  if (!(IS_STAGING && req.query.demo === '1' && req.user)) return false;
  const { rows } = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND demo = TRUE LIMIT 1', [req.user.id]);
  if (rows.length) return true;
  const ids = {};
  for (const f of DEMO_FEEDS) {
    const url = `https://${f.slug}.invalid/feed.xml`;
    const ins = await pool.query(`INSERT INTO feeds (user_id, url, title, site_url, demo, created_at)
      VALUES ($1, $2, $3, $4, TRUE, $5) ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
      [req.user.id, url, f.title, `https://${f.slug}.invalid`, req.now]);
    if (ins.rows.length) ids[f.key] = ins.rows[0].id;
  }
  for (const p of DEMO_POSTS) {
    const feedId = ids[p.feed];
    if (!feedId) continue;
    await pool.query(`INSERT INTO posts (feed_id, guid, title, link, published_at, snippet, content_html, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedId, p.guid, p.title, `https://${DEMO_FEEDS.find((f) => f.key === p.feed).slug}.invalid/posts/${p.guid}`,
        new Date(req.now.getTime() - p.ago), p.snippet, p.html, req.now]);
  }
  return true;
}

// Unread posts, newest first, with their feed's title; the viewer's feed
// count; the titles of feeds that failed their last refresh; and whether
// this is the staging demo.
app.get('/api/posts', async (req, res) => {
  try {
    if (!req.user) return res.json({ posts: [], feedCount: 0, failed: [], demo: false });
    const demo = await seedDemo(req);
    const { rows: feeds } = await pool.query(
      'SELECT id, url, title, site_url FROM feeds WHERE user_id = $1 AND demo = FALSE', [req.user.id]);
    // One slow feed must not hold up the list: each is capped by fetchFeed's
    // own 10 s timeout, and they refresh in parallel.
    await Promise.all(feeds.map((f) => refreshFeed(f, req.now)));
    const { rows } = await pool.query(`SELECT p.id, p.feed_id, p.title, p.link, p.published_at, p.snippet, p.content_html,
        f.title AS feed_title
      FROM posts p JOIN feeds f ON f.id = p.feed_id
      WHERE f.user_id = $1 AND p.read_at IS NULL
      ORDER BY p.published_at DESC NULLS LAST, p.id DESC LIMIT 500`, [req.user.id]);
    const { rows: counted } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM feeds WHERE user_id = $1', [req.user.id]);
    const { rows: failed } = await pool.query(
      'SELECT title FROM feeds WHERE user_id = $1 AND demo = FALSE AND last_error IS NOT NULL', [req.user.id]);
    return res.json({
      posts: rows.map((r) => ({
        id: r.id, feedId: r.feed_id, feedTitle: r.feed_title, title: r.title, link: r.link,
        publishedAt: r.published_at, snippet: r.snippet, contentHtml: r.content_html,
      })),
      feedCount: counted[0].n,
      failed: failed.map((r) => r.title),
      demo,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
  }
});

// Add a feed: fetch it through the guard, parse it, store it unread.
app.post('/api/feeds', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  try {
    const url = typeof (req.body || {}).url === 'string' ? req.body.url.trim() : '';
    if (!url) return res.status(400).json({ error: 'Paste the address of a feed first.' });
    const dup = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [req.user.id, url]);
    if (dup.rows.length) return res.status(409).json({ error: 'That feed is already added.' });
    let parsed;
    try {
      parsed = parseFeed(await fetchFeed(url));
    } catch (err) {
      if (err instanceof FeedError) return res.status(400).json({ error: err.message });
      throw err;
    }
    const { rows } = await pool.query(`INSERT INTO feeds (user_id, url, title, site_url, created_at)
      VALUES ($1, $2, $3, $4, $5) RETURNING id, url, title`,
      [req.user.id, url, parsed.title || url, parsed.siteUrl, req.now]);
    await storeItems(rows[0].id, parsed, req.now);
    return res.json({ feed: { id: rows[0].id, url: rows[0].url, title: rows[0].title }, added: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
  }
});

// Mark one of the viewer's own posts read, once. Tapping is what counts as
// reading; read_at is left alone if it is already set.
app.post('/api/posts/:id/read', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'That post does not exist.' });
    const { rows } = await pool.query(`UPDATE posts SET read_at = $3
      WHERE id = $1 AND read_at IS NULL
        AND feed_id IN (SELECT id FROM feeds WHERE user_id = $2) RETURNING id`,
      [id, req.user.id, req.now]);
    return res.json({ ok: true, read: rows.length > 0 });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side. Try again in a moment.' });
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

async function start() {
  await migrate();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // Stop cleanly: finish open requests, drain the pool, exit. SIGTERM is
  // what the platform sends; SIGINT covers Ctrl-C under `node server.js`.
  let closing = false;
  const stop = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: finishing open requests`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
