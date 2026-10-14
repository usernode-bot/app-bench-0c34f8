const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { guardedFetch, parseFeed, FetchError } = require('./feed-fetch');

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

/* ── The app ─────────────────────────────────────────────────────────────
 * Feeds and posts are per person: every query is scoped to req.user.id and
 * a guest gets empty lists. Read state lives on posts.read_at.
 */

// Schema, applied idempotently on boot. Both tables are private: they hold
// one person's own feeds and reading state.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      site_url text,
      hue int NOT NULL DEFAULT 1,
      is_demo boolean NOT NULL DEFAULT false,
      last_error text,
      last_fetched_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url_idx ON feeds (user_id, url);
    CREATE TABLE IF NOT EXISTS posts (
      id serial PRIMARY KEY,
      feed_id integer NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid text NOT NULL,
      title text NOT NULL,
      link text,
      summary text,
      published_at timestamptz NOT NULL,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS posts_feed_guid_idx ON posts (feed_id, guid);
    CREATE INDEX IF NOT EXISTS posts_feed_read_idx ON posts (feed_id, read_at);
  `);
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE posts IS 'staging:private'`);
}

// Demo rows are for the viewer's own eyes and stay out of every answer
// without ?demo=1. ?demo=1 is passed on by the client.
function wantsDemo(req) {
  return IS_STAGING && req.query.demo === '1';
}

// The hue of a new feed: the lowest of 1 to 5 not used yet, and once all
// five are in use, (count mod 5) + 1.
async function nextHue(userId, client) {
  const { rows } = await client.query('SELECT hue FROM feeds WHERE user_id = $1', [userId]);
  const used = new Set(rows.map((r) => r.hue));
  for (let hue = 1; hue <= 5; hue++) {
    if (!used.has(hue)) return hue;
  }
  return (rows.length % 5) + 1;
}

const unreadExpr = `(SELECT count(*) FROM posts p WHERE p.feed_id = f.id AND p.read_at IS NULL)`;

// GET /api/posts — the person's unread posts, newest first, with their feed
// title and hue, plus the counts the heading line needs. A guest gets an
// empty list.
app.get('/api/posts', async (req, res) => {
  const uid = req.user ? req.user.id : null;
  const demo = wantsDemo(req) && uid;
  const demoFilter = demo ? '' : ' AND NOT f.is_demo';
  if (demo) await ensureDemoData(uid, req.now);
  if (!uid) {
    return res.json({ posts: [], unreadCount: 0, feedCount: 0, failedFeeds: 0, staging: IS_STAGING });
  }
  const posts = await pool.query(
    `SELECT p.id, p.title, p.link, p.summary, p.published_at, f.title AS feed_title, f.hue
     FROM posts p JOIN feeds f ON f.id = p.feed_id
     WHERE f.user_id = $1 AND p.read_at IS NULL${demoFilter}
     ORDER BY p.published_at DESC
     LIMIT 300`,
    [uid]
  );
  const counts = await pool.query(
    `SELECT count(*) FILTER (WHERE p.read_at IS NULL) AS unread,
            count(DISTINCT f.id) AS feeds,
            count(DISTINCT f.id) FILTER (WHERE f.last_error IS NOT NULL) AS failed
     FROM feeds f LEFT JOIN posts p ON p.feed_id = f.id
     WHERE f.user_id = $1${demoFilter}`,
    [uid]
  );
  const c = counts.rows[0];
  res.json({
    posts: posts.rows.map((r) => ({ ...r, published_at: r.published_at.toISOString() })),
    unreadCount: Number(c.unread),
    feedCount: Number(c.feeds),
    failedFeeds: Number(c.failed),
    staging: IS_STAGING,
  });
});

// POST /api/refresh — re-check every non-demo feed, 4 at a time. Answers
// with no posts; the client asks for the list again.
app.post('/api/refresh', async (req, res) => {
  if (!req.user) return res.json({ ok: true });
  const { rows: feeds } = await pool.query(
    'SELECT * FROM feeds WHERE user_id = $1 AND is_demo = false',
    [req.user.id]
  );
  for (let i = 0; i < feeds.length; i += 4) {
    await Promise.all(feeds.slice(i, i + 4).map((feed) => refreshFeed(feed, req.now)));
  }
  res.json({ ok: true });
});

async function refreshFeed(feed, now) {
  try {
    const body = await guardedFetch(feed.url);
    const parsed = parseFeed(body);
    await storeItems(feed, parsed, now);
    await pool.query('UPDATE feeds SET last_error = NULL, last_fetched_at = $2 WHERE id = $1', [feed.id, now]);
  } catch (err) {
    const message = err instanceof FetchError ? err.message : 'unreachable';
    await pool.query('UPDATE feeds SET last_error = $2 WHERE id = $1', [feed.id, message]);
  }
}

async function storeItems(feed, parsed, now) {
  for (const item of parsed.items) {
    // A link the guard would refuse is stored as no link at all.
    const link = item.link && /^https?:\/\//.test(item.link) ? item.link : null;
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, summary, published_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feed.id, item.guid, item.title || 'Untitled post', link, item.summary, item.publishedAt || now]
    );
  }
}

// GET /api/feeds — the person's feeds with their unread counts and, where a
// feed could not be checked last time, its error.
app.get('/api/feeds', async (req, res) => {
  const uid = req.user ? req.user.id : null;
  const demo = wantsDemo(req) && uid;
  const demoFilter = demo ? '' : ' AND NOT f.is_demo';
  if (demo) await ensureDemoData(uid, req.now);
  if (!uid) return res.json({ feeds: [] });
  const { rows } = await pool.query(
    `SELECT f.id, f.title, f.site_url, f.url, f.hue, f.last_error, ${unreadExpr} AS unread
     FROM feeds f WHERE f.user_id = $1${demoFilter}
     ORDER BY f.created_at, f.id`,
    [uid]
  );
  res.json({ feeds: rows.map((r) => ({ ...r, unread: Number(r.unread) })) });
});

// POST /api/feeds {url} — check the address through the guard, store the
// feed and its items as unread. Error codes: not_a_feed, web_page,
// unreachable, blocked_address, duplicate.
app.post('/api/feeds', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const raw = typeof req.body && req.body.url === 'string' ? req.body.url.trim() : '';
  if (!raw) return res.status(400).json({ error: 'unreachable' });
  let normalized = raw;
  if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized;
  try {
    const parsedUrl = new URL(normalized);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return res.status(400).json({ error: 'blocked_address' });
    }
    normalized = parsedUrl.toString();
  } catch {
    return res.status(400).json({ error: 'unreachable' });
  }

  const dupe = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [req.user.id, normalized]);
  if (dupe.rows.length) return res.status(409).json({ error: 'duplicate' });

  let parsed;
  try {
    parsed = parseFeed(await guardedFetch(normalized));
  } catch (err) {
    const code = err instanceof FetchError ? err.message : 'unreachable';
    return res.status(400).json({ error: ['not_a_feed', 'web_page', 'unreachable', 'blocked_address'].includes(code) ? code : 'unreachable' });
  }

  const hue = await nextHue(req.user.id, pool);
  const { rows } = await pool.query(
    `INSERT INTO feeds (user_id, url, title, site_url, hue, last_fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.user.id, normalized, parsed.title, parsed.siteUrl, hue, req.now]
  );
  const feed = rows[0];
  await storeItems(feed, parsed, req.now);
  const { rows: withCount } = await pool.query(
    `SELECT f.id, f.title, f.site_url, f.url, f.hue, f.last_error, ${unreadExpr} AS unread
     FROM feeds f WHERE f.id = $1`,
    [feed.id]
  );
  res.status(201).json({ feed: { ...withCount[0], unread: Number(withCount[0].unread) } });
});

// DELETE /api/feeds/:id — the feed and its posts go (the posts follow by
// cascade). Only the owner can do this.
app.delete('/api/feeds/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const { rowCount } = await pool.query('DELETE FROM feeds WHERE id = $1 AND user_id = $2', [
    Number(req.params.id) || 0,
    req.user.id,
  ]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// POST /api/posts/:id/read — mark read (sets read_at only if it is null).
// Only the owner can do this. Failure here is the client's problem to live
// with: the preview still opens, the post stays unread.
app.post('/api/posts/:id/read', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const { rowCount } = await pool.query(
    `UPDATE posts SET read_at = $1
     WHERE id = $2 AND read_at IS NULL
       AND feed_id IN (SELECT id FROM feeds WHERE user_id = $3)`,
    [req.now, Number(req.params.id) || 0, req.user.id]
  );
  res.json({ ok: true, changed: rowCount > 0 });
});

/* ── Staging demo ────────────────────────────────────────────────────────
 * The first version's populated preview: five made-up feeds of the viewer's
 * own with 26 posts, 23 of them unread. Written once per viewer (the insert
 * conflicts on nothing new afterwards), so what they do to the rows stays.
 * Nothing is written outside staging or without demo=1.
 */

const DEMO_FEEDS = [
  { slug: 'pixeldaily', title: 'Pixel Daily', site: 'https://pixeldaily.example', hue: 2 },
  { slug: 'fieldnotes', title: 'Field Notes', site: 'https://fieldnotes.example', hue: 1 },
  { slug: 'gardenledger', title: 'Garden Ledger', site: 'https://gardenledger.example', hue: 4 },
  { slug: 'salt', title: 'Salt', site: 'https://salt.example', hue: 3 },
  { slug: 'tidewatch', title: 'Tidewatch', site: 'https://tidewatch.example', hue: 5 },
];

// [feed slug, minutes back from "now", title, summary, read?]
const DEMO_POSTS = [
  ['pixeldaily', 12, 'A calmer way to build design tokens', 'Why one small palette beats forty near-duplicates, and how a team of three cut theirs down in an afternoon.'],
  ['fieldnotes', 65, 'Notes from a week of slow cycling in Portugal', 'Seven days, four hundred kilometres, and the small villages where the cafés open at six.'],
  ['gardenledger', 122, 'What to sow in March if the ground is still cold', 'Peas, broad beans and spinach all cope with frost. Start them indoors and harden off.'],
  ['salt', 244, 'The bread that fed a harbour town', 'A baker in Cádiz still uses a starter older than her grandmother.'],
  ['tidewatch', 1100, 'Spring tides: what the numbers actually mean', 'A plain guide to reading tide tables before your next coastal walk.'],
  ['pixeldaily', 1590, 'Type scales you can explain in one sentence', 'Four sizes are enough for most apps. Here is how to choose them.'],
  ['fieldnotes', 2920, 'Packing list for a night on the ridge', 'Light, warm and dry: the short list.'],
  ['pixeldaily', 3010, 'Grids are a suggestion, not a law', 'Where a twelve-column grid helps, where it gets in the way, and when to trust your eye instead.'],
  ['gardenledger', 1700, 'The compost heap is a slow argument', 'Greens, browns, and the patience to let a pile finish its own business.'],
  ['fieldnotes', 1800, 'The gravel question: why wider is not always better', 'Forty-millimetre tyres felt wrong for a week. Then the roads turned to chalk.'],
  ['salt', 1560, 'Salt cod, soaked for three days', 'The old way of buying fish that keeps, and the dinners it still makes possible.'],
  ['tidewatch', 2400, 'The tide gate and the salt marsh', 'How a working sluice keeps a meadow dry and a channel deep.'],
  ['pixeldaily', 3015, 'The case for one typeface', 'Two families are often one too many. Notes on weight, width and letting a single face do all the work.'],
  ['fieldnotes', 4320, 'Reading a contour line the way a rider does', 'A steep side means a slow climb or a fast descent, and the map will not tell you which.'],
  ['gardenledger', 4440, 'Pruning the apple tree without fear', 'Take out the crossing branches first. The tree will forgive the rest.'],
  ['salt', 3140, 'A kitchen of one pot', 'Stews, soups and the quiet pleasure of washing up once.'],
  ['tidewatch', 3000, 'Neap weeks are for birdwatching', 'When the water stays close to the mud, the waders move in.'],
  ['pixeldaily', 4500, 'Notes on empty states', 'The screen a person meets before they have done anything is the one worth drafting first.'],
  ['fieldnotes', 4720, 'A flat white at the halfway point', 'Cycling cafés, ranked by nothing in particular, from the useful to the unforgettable.'],
  ['gardenledger', 4900, 'Slugs, and the truce we have reached', 'Beer traps, copper tape and a healthy respect for damp evenings.'],
  ['salt', 5240, 'Why lemons end almost every Spanish dish', 'Acid at the end, not the start: a small habit that lifts stews, soups and fried fish.'],
  ['tidewatch', 5100, 'A walk that only exists at low tide', 'The causeway to the island opens for four hours. The pub closes an hour before it shuts.'],
  ['fieldnotes', 5000, 'Fixing a puncture in the rain', 'Boots off, wet tyres, and the three-minute ritual that never goes to plan.'],
  ['tidewatch', 8700, 'Reading the beach after a storm', 'What a line of shells and wrack tells you about last night’s water.', true],
  ['gardenledger', 10100, 'A window box for a north-facing sill', 'Shade-tolerant herbs, and the ones that will sulk all winter.', true],
  ['salt', 11500, 'Stock from nothing', 'Skins, ends and peelings: a bag in the freezer that becomes dinner next week.', true],
];

let demoPending = null;
async function ensureDemoData(userId, now) {
  // One run per process: the second request waits for the first, and the
  // inserts' ON CONFLICT DO NOTHING keeps a reload (or another build's
  // process) from duplicating or undoing anything.
  if (demoPending) return demoPending;
  demoPending = (async () => {
    const client = await pool.connect();
    try {
      const existing = await client.query('SELECT count(*)::int AS n FROM feeds WHERE user_id = $1 AND is_demo = true', [userId]);
      if (existing.rows[0].n >= DEMO_FEEDS.length) return;
      for (const feed of DEMO_FEEDS) {
        const { rows } = await client.query(
          `INSERT INTO feeds (user_id, url, title, site_url, hue, is_demo, last_fetched_at)
           VALUES ($1, $2, $3, $4, $5, true, $6)
           ON CONFLICT (user_id, url) DO NOTHING
           RETURNING id`,
          [userId, feed.site + '/feed', feed.title, feed.site, feed.hue, now]
        );
        const feedId = rows.length
          ? rows[0].id
          : (await client.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [userId, feed.site + '/feed'])).rows[0].id;
        DEMO_POSTS.filter((p) => p[0] === feed.slug).forEach(([, minutes, title, summary, read], n) => {
          return client.query(
            `INSERT INTO posts (feed_id, guid, title, link, summary, published_at, read_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (feed_id, guid) DO NOTHING`,
            [
              feedId,
              `demo-${feed.slug}-${n}`,
              title,
              `${feed.site}/posts/${n + 1}`,
              summary,
              new Date(now.getTime() - minutes * 60_000),
              read ? new Date(now.getTime() - minutes * 60_000 + 3_600_000) : null,
            ]
          );
        });
      }
    } finally {
      client.release();
    }
  })().catch((err) => {
    demoPending = null;
    console.warn('demo seed failed: ' + err.message);
  });
  return demoPending;
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

let server;
async function start() {
  await ensureSchema();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

// Stop accepting, drain about 3 s, close the pool, exit.
function shutdown() {
  console.log('Shutting down');
  if (!server) process.exit(0);
  server.close(() => {
    pool.end().then(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(err => { console.error(err); process.exit(1); });