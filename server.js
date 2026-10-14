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

let shuttingDown = false;
app.get('/health', (_req, res) => res.json({ status: shuttingDown ? 'shutting-down' : 'ok' }));

// ── Feeds, posts and read marks ────────────────────────────────────────────
// Everything here is one person's own: their feeds, the posts those feeds
// carried and what they have read. The tables are private and every query is
// scoped to req.user.id; a guest's GETs see an empty app, their writes are
// answered 401 by the middleware above.
const { safeFetch, parseFeed, FeedError } = require('./lib/feeds');

const feedRows = 'id, url, title, site_url, tone, last_fetched_at, last_error, is_demo';

async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS feeds (
    id serial PRIMARY KEY,
    user_id text NOT NULL,
    url text NOT NULL,
    title text NOT NULL,
    site_url text,
    tone int NOT NULL DEFAULT 0,
    last_fetched_at timestamptz,
    last_error text,
    is_demo boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url_idx ON feeds (user_id, url)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS posts (
    id serial PRIMARY KEY,
    feed_id int NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
    guid text NOT NULL,
    title text,
    link text,
    author text,
    published_at timestamptz,
    snippet text,
    content_html text,
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now())`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS posts_feed_guid_idx ON posts (feed_id, guid)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS posts_published_idx ON posts (published_at DESC)`);
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE posts IS 'staging:private'`);
}

/** Insert a parsed feed's posts; ones already stored are left alone. */
async function upsertPosts(feedId, parsed, at) {
  for (const post of parsed.posts) {
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, author, published_at, snippet, content_html)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedId,
        post.guid || post.title || post.link || '',
        post.title, post.link, post.author,
        post.publishedAt || at,
        post.summaryText,
        post.contentHtml]);
  }
}

/** One feed's update: fetch, parse, store, and record how it went. */
async function refreshFeed(feed, at) {
  try {
    const { text } = await safeFetch(feed.url);
    const parsed = parseFeed(text);
    if (!parsed) throw new FeedError('That address is not an RSS or Atom feed.');
    await upsertPosts(feed.id, parsed, at);
    await pool.query('UPDATE feeds SET last_fetched_at = $2, last_error = NULL WHERE id = $1', [feed.id, at]);
    return { id: feed.id, title: feed.title, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The site could not be reached.';
    await pool.query('UPDATE feeds SET last_fetched_at = $2, last_error = $3 WHERE id = $1', [feed.id, at, message]);
    return { id: feed.id, title: feed.title, ok: false, error: message };
  }
}

// ── The staging demo (?demo=1 on staging only) ────────────────────────────
// Five made-up feeds on .example addresses with made-up posts, so the list
// can be seen with no network. They belong to the viewer (user_id is theirs,
// is_demo true), every control works on them, and refresh skips them.
// Idempotent: the feed INSERTs say DO NOTHING, and nothing is written unless
// the account has no demo feeds left at all.
const DEMO_FEEDS = [
  { url: 'https://feeds.fernleaf-garden.example/feed.xml', title: 'Fernleaf Garden Journal',
    siteUrl: 'https://fernleaf-garden.example', tone: 0, author: 'Ivy Bramblewick',
    posts: [
      ['herbs-forgive', 'Five herbs that forgive a forgetful waterer', 12, 0,
        '<p>Thyme, rosemary and sage all prefer to dry out between drinks, which makes them ideal for a sunny sill you only remember on weekends.</p><p>Start with a terracotta pot, because it breathes. Use a gritty mix, one part sand to two parts compost, and water only when the top inch feels dry.</p><h3>1. Thyme</h3><p>Low, tough and happy in the brightest spot you have. Trim it after flowering and it stays bushy for years.</p><h3>2. Rosemary</h3><p>Give it the sunniest window in the house and resist the urge to water when it looks a little grey.</p>'],
      ['terracotta-seed', 'Starting basil from seed without a heat mat', 5, 1,
        '<p>Basil wants warmth more than light at first. A shelf above the fridge is enough, and a clear lid over the pot keeps the damp in.</p><p>Prick the seedlings out when their first true leaves show, and pinch the tops early or they sulk and go woody.</p>'],
      ['slug-barrier', 'A copper barrier that actually held', 2, 2,
        '<p>A strip of copper tape around the pot rim lasted the whole season. The slugs turned back every time, and the lettuces came in clean.</p>']],
  },
  { url: 'https://feeds.tidepool-times.example/feed.xml', title: 'The Tidepool Times',
    siteUrl: 'https://tidepool-times.example', tone: 1, author: 'The Tidepool Times',
    posts: [
      ['hermit-shells', 'What the hermit crabs did when the new shells arrived', 1, 0,
        '<p>A volunteer left a tray of empty shells at low tide. Within an hour a queue had formed, smallest crab at the back.</p><p>By dark every crab had a new address, and the old shells sat empty in a neat line along the rock.</p>'],
      ['tide-tables', 'Tide tables for the coming week', 30, 1,
        '<p>Low water falls mid-morning all week, which is the right window for the far pools. Bring a stick for the eelgrass.</p>'],
      ['seal-pup', 'A seal pup naps through the survey', 26, 2,
        '<p>Our count of the north beach was interrupted by a pup asleep on the warm rock, moulting and unbothered. We counted it once and let it sleep.</p>']],
  },
  { url: 'https://feeds.byte-sized-builds.example/feed.xml', title: 'Byte-Sized Builds',
    siteUrl: 'https://byte-sized-builds.example', tone: 2, author: 'Marlow Finch',
    posts: [
      ['bicycle-clock', 'A weekend clock made from an old bicycle wheel', 3, 0,
        '<p>Spokes for hour marks, a cheap quartz movement and a lot of sanding. Here is the parts list and the one mistake to avoid.</p><p>The mistake: drill the movement hole before you true the wheel, not after. A wheel that wobbles makes a clock that drifts.</p><h3>Parts</h3><ul><li>One 26-inch wheel, trued</li><li>A quartz movement with a long stem</li><li>Twelve spoke reflectors</li></ul>'],
      ['card-sort', 'Sorting a deck of cards by ear', 100, 1,
        '<p>A riffle is quieter than a drop. Listen for the snap of the last few cards and you can hear when a sort is nearly done.</p>'],
      ['pencil-shelf', 'A shelf held up by pencils and doubt', 49, 2,
        '<p>Six pencils in six holes, a board across, and it took a stack of hardbacks without complaint. Full build notes inside.</p>']],
  },
  { url: 'https://feeds.slow-kettle.example/feed.xml', title: 'Slow Kettle Recipes',
    siteUrl: 'https://slow-kettle.example', tone: 3, author: 'The Kettle',
    posts: [
      ['oat-three-ways', 'Oat porridge three ways, all under ten minutes', 25, 0,
        '<p>Start with the base, then go savoury with miso and spring onion, or sweet with stewed apple and a pinch of cinnamon.</p><p>The base is one part oats to two parts water and a good pinch of salt, simmered while you make tea.</p>'],
      ['cold-brew', 'Cold brew that does not go bitter', 74, 1,
        '<p>Coarse grind, cold water, and stop at fourteen hours. Past that it picks up a bitterness no amount of milk hides.</p>'],
      ['lemon-drizzle', 'The lemon drizzle my gran actually made', 98, 2,
        '<p>Two lemons, not one, and the syrup goes on while the cake is still warm. The crust is the whole point.</p>']],
  },
  { url: 'https://feeds.night-sky-notes.example/feed.xml', title: 'Night Sky Notes',
    siteUrl: 'https://night-sky-notes.example', tone: 4, author: 'Night Sky Notes',
    posts: [
      ['orion-returns', 'Orion clears the rooftops again', 122, 0,
        '<p>The hunter is back before midnight for the first time since spring. Look low and south-east, and give your eyes ten minutes.</p>'],
      ['meteor-peak', 'Tonight is the peak, if the cloud holds off', 146, 1,
        '<p>The radiant rises after ten. A deck chair and a flask beat any telescope for this one.</p>']],
  },
];

async function seedDemo(userId, at) {
  const { rows } = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND is_demo = true LIMIT 1', [userId]);
  if (rows.length) return;
  for (const feed of DEMO_FEEDS) {
    const { rows: inserted } = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, tone, is_demo)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (user_id, url) DO NOTHING
       RETURNING id`,
      [userId, feed.url, feed.title, feed.siteUrl, feed.tone]);
    const feedId = inserted.length ? inserted[0].id
      : (await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [userId, feed.url])).rows[0].id;
    for (const [guid, title, hoursAgo, ordinal, html] of feed.posts) {
      const published = new Date(at.getTime() - hoursAgo * 3600000);
      await pool.query(
        `INSERT INTO posts (feed_id, guid, title, link, author, published_at, snippet, content_html, read_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (feed_id, guid) DO NOTHING`,
        [feedId, guid, title,
          `${feed.siteUrl}/posts/${guid}`,
          feed.author,
          published,
          html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
          html,
          null]);
    }
  }
  // Two read a few minutes ago, so the dimmed state can be seen; read marks
  // older than this session's window drop off the list on their own.
  const minutesAgo = (mins) => new Date(at.getTime() - mins * 60000);
  await pool.query(
    `UPDATE posts SET read_at = $2
     WHERE guid = 'card-sort' AND feed_id IN (SELECT id FROM feeds WHERE user_id = $1 AND is_demo = true)`,
    [userId, minutesAgo(3)]);
  await pool.query(
    `UPDATE posts SET read_at = $2
     WHERE guid = 'tide-tables' AND feed_id IN (SELECT id FROM feeds WHERE user_id = $1 AND is_demo = true)`,
    [userId, minutesAgo(6)]);
  // Night Sky Notes did not update; the failure line above the list names it.
  await pool.query(
    `UPDATE feeds SET last_error = 'the site did not answer' WHERE user_id = $1 AND is_demo = true AND title = 'Night Sky Notes'`,
    [userId]);
}

const isDemoRequest = (req) => IS_STAGING && req.query.demo === '1';

app.get('/api/posts', async (req, res) => {
  if (!req.user) return res.json({ posts: [], feeds: [], demo: false });
  try {
    const demo = isDemoRequest(req);
    if (demo) await seedDemo(req.user.id, req.now);
    // Posts read after `since` stay in the list dimmed, so a reload does not
    // fling the reader back to the top of what they were just reading.
    const sinceRaw = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
    const since = sinceRaw && !Number.isNaN(sinceRaw.getTime()) ? sinceRaw : new Date(0);
    const { rows: feeds } = await pool.query(
      `SELECT ${feedRows} FROM feeds WHERE user_id = $1 AND ($2::boolean OR is_demo = false)
       ORDER BY created_at, id`,
      [req.user.id, demo]);
    const { rows: posts } = await pool.query(
      `SELECT p.id, p.feed_id, p.title, p.link, p.author, p.published_at, p.snippet, p.read_at
       FROM posts p JOIN feeds f ON f.id = p.feed_id
       WHERE f.user_id = $1 AND (p.read_at IS NULL OR p.read_at >= $2) AND ($3::boolean OR f.is_demo = false)
       ORDER BY p.published_at DESC NULLS LAST, p.id DESC
       LIMIT 500`,
      [req.user.id, since, demo]);
    res.json({ posts, feeds, demo });
  } catch (err) {
    console.error('GET /api/posts failed:', err);
    res.status(500).json({ error: 'Your posts did not load. Try again in a moment.' });
  }
});

app.post('/api/refresh', async (req, res) => {
  const feedId = req.body && Number.isInteger(Number(req.body.feedId)) ? Number(req.body.feedId) : null;
  const { rows: feeds } = await pool.query(
    'SELECT id, url, title FROM feeds WHERE user_id = $1 AND is_demo = false AND ($2::int IS NULL OR id = $2::int)',
    [req.user.id, feedId]);
  const results = await Promise.all(feeds.map((feed) => refreshFeed(feed, req.now)));
  res.json({ results });
});

app.get('/api/feeds', async (req, res) => {
  if (!req.user) return res.json({ feeds: [], demo: false });
  const { rows: feeds } = await pool.query(
    `SELECT ${feedRows} FROM feeds WHERE user_id = $1 AND ($2::boolean OR is_demo = false)
     ORDER BY created_at, id`,
    [req.user.id, isDemoRequest(req)]);
  res.json({ feeds, demo: isDemoRequest(req) });
});

app.post('/api/feeds', async (req, res) => {
  const raw = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!raw) return res.status(400).json({ error: 'Type a feed address first.' });
  const address = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw.replace(/^\/+/, '');
  let parsed;
  try {
    const { text } = await safeFetch(address);
    parsed = parseFeed(text);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'The site could not be reached.' });
  }
  if (!parsed || (!parsed.posts.length && !parsed.title)) {
    return res.status(400).json({ error: 'That address is not an RSS or Atom feed.' });
  }
  const title = parsed.title || new URL(address).hostname.replace(/^www\./, '');
  try {
    // The tone runs 0 to 5 in turn per user, so each feed's badge colour differs.
    const { rows } = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, tone, last_fetched_at)
       SELECT $1, $2, $3, $4, COALESCE((SELECT MAX(tone) + 1 FROM feeds WHERE user_id = $1 AND is_demo = false), 0) % 6, $5
       RETURNING ${feedRows}`,
      [req.user.id, address, title, parsed.siteUrl || null, req.now]);
    const feed = rows[0];
    if (parsed.posts.length) await upsertPosts(feed.id, parsed, req.now);
    res.status(201).json({ feed, added: parsed.posts.length });
  } catch (err) {
    if (err && (err.code === '23505' || /feeds_user_url_idx/.test(err.detail || err.message || ''))) {
      return res.status(400).json({ error: 'You already added that feed.' });
    }
    console.error('POST /api/feeds failed:', err);
    res.status(500).json({ error: 'The feed could not be saved. Try again.' });
  }
});

app.delete('/api/feeds/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'That feed is gone.' });
  const { rowCount } = await pool.query('DELETE FROM feeds WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  if (!rowCount) return res.status(404).json({ error: 'That feed is gone.' });
  res.json({ ok: true });
});

app.post('/api/posts/:id/read', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'That post is gone.' });
  const { rows } = await pool.query(
    `UPDATE posts SET read_at = $2
     WHERE id = $1 AND read_at IS NULL AND feed_id IN (SELECT id FROM feeds WHERE user_id = $3)
     RETURNING id, read_at`,
    [id, req.now, req.user.id]);
  if (rows.length) return res.json({ post: rows[0] });
  // Already read, or not ours: confirm which, so the client can tell the two apart.
  const { rows: existing } = await pool.query(
    `SELECT p.id, p.read_at FROM posts p JOIN feeds f ON f.id = p.feed_id WHERE p.id = $1 AND f.user_id = $2`,
    [id, req.user.id]);
  if (!existing.length) return res.status(404).json({ error: 'That post is gone.' });
  res.json({ post: existing[0] });
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

  // Stop accepting connections, let in-flight requests finish under a hard
  // 3 s deadline, close the pool and exit. A repeat signal is a no-op.
  const DRAIN_MS = 3000;
  return new Promise((resolve) => {
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[shutdown] ${signal} received, draining`);
      server.close(() => {});
      server.closeIdleConnections?.();
      const force = setTimeout(() => { server.closeAllConnections?.(); }, DRAIN_MS);
      force.unref?.();
      Promise.resolve().then(() => pool.end()).catch((err) => {
        console.error('[shutdown] pool.end failed:', err.message);
      }).finally(() => {
        clearTimeout(force);
        process.exit(0);
      });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    resolve(server);
  });
}

start().catch(err => { console.error(err); process.exit(1); });
