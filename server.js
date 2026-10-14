const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { fetchFeed, FetchError } = require('./feed-fetch');

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

// ── Schema (idempotent, on boot) ─────────────────────────────────────────
// Both tables hold one person's own feeds and read state: private.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS feeds (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  site_url text,
  hue int NOT NULL,
  is_demo boolean NOT NULL DEFAULT false,
  last_error text,
  last_fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url ON feeds (user_id, url);
CREATE TABLE IF NOT EXISTS posts (
  id serial PRIMARY KEY,
  feed_id int NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  guid text NOT NULL,
  title text,
  link text,
  summary text,
  published_at timestamptz NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS posts_feed_guid ON posts (feed_id, guid);
CREATE INDEX IF NOT EXISTS posts_feed_read ON posts (feed_id, read_at);
COMMENT ON TABLE feeds IS 'staging:private';
COMMENT ON TABLE posts IS 'staging:private';
`;

async function applySchema() {
  await pool.query(SCHEMA);
}

// `?demo=1` answers include demo feeds only in staging. A guest (no user)
// gets empty lists.
function wantsDemo(req) {
  return IS_STAGING && req.query.demo === '1';
}

function scope(req) {
  return { userId: req.user ? req.user.id : null, demo: wantsDemo(req) };
}

// ── Staging demo (first version's populated preview) ────────────────────
// Only in staging, only with ?demo=1, idempotent: five made-up feeds of the
// viewer's own and 26 fixed posts, 23 unread and 3 already read. Refresh
// never touches demo feeds.
const DEMO_FEEDS = [
  { key: 'fieldnotes', title: 'Field Notes', site: 'https://fieldnotes.example', hue: 1 },
  { key: 'pixel', title: 'Pixel Daily', site: 'https://pixeldaily.example', hue: 2 },
  { key: 'salt', title: 'Salt', site: 'https://salt.example', hue: 3 },
  { key: 'garden', title: 'Garden Ledger', site: 'https://gardenledger.example', hue: 4 },
  { key: 'tide', title: 'Tidewatch', site: 'https://tidewatch.example', hue: 5 },
];

// [feedKey, title, summary, minutesAgo, read]
const DEMO_POSTS = [
  ['pixel', 'A calmer way to build design tokens', 'Why one small palette beats forty near-duplicates, and how a team of three cut theirs down in an afternoon.', 12, false],
  ['fieldnotes', 'Notes from a week of slow cycling in Portugal', 'Seven days, four hundred kilometres, and the small villages where the cafés open at six.', 70, false],
  ['garden', 'What to sow in March if the ground is still cold', 'Peas, broad beans and spinach all cope with frost. Start them indoors and harden off.', 140, false],
  ['salt', 'The bread that fed a harbour town', 'A baker in Cádiz still uses a starter older than her grandmother.', 240, false],
  ['tide', 'Spring tides: what the numbers actually mean', 'A plain guide to reading tide tables before your next coastal walk.', 300, false],
  ['pixel', 'Type scales you can explain in one sentence', 'Four sizes are enough for most apps. Here is how to choose them.', 560, false],
  ['fieldnotes', 'Packing list for a night on the ridge', 'Light, warm and dry: the short list that has never let me down.', 900, false],
  ['garden', 'A cold frame from old windows', 'Two panes, four hinges and a weekend. The seedlings came through a hard frost.', 1220, false],
  ['tide', 'Why the tide goes out for hours before a storm', 'Old saying, real physics. What to believe and what to ignore.', 1500, false],
  ['salt', 'Five pantry meals for the end of the week', 'Anchovies, tin tomatoes, stale bread. Supper is closer than it looks.', 1800, false],
  ['pixel', 'Icons that survive a redesign', 'Draw the grid first. The strokes follow, and the icon set stops dating.', 2050, false],
  ['fieldnotes', 'Riding the coast road in the rain', 'Wet brakes, empty lanes and the best hour of the whole trip.', 2350, false],
  ['garden', 'Reading your soil with a jam jar', 'Water, soil, shake, wait. The layers tell you more than a kit.', 2650, false],
  ['tide', 'The quay wall and its tide marks', 'What a century of high water left written in the stone.', 2950, false],
  ['salt', 'How to season a cast-iron pan', 'Oil, heat, patience. Then eggs that never stick again.', 3250, false],
  ['pixel', 'Empty states are not blank screens', 'The moment to teach the app is the moment there is nothing in it.', 3550, false],
  ['fieldnotes', 'A beginner’s pump track, rated', 'Plastic or dirt, and which one forgives a wobble at speed.', 3850, false],
  ['garden', 'Saving seed from your own beans', 'Leave the pods, forget the fuss, label the jar twice.', 4150, false],
  ['tide', 'Footpaths that flood at high water', 'Six crossings, their safe hours, and the one bridge to trust.', 4450, false],
  ['salt', 'The case for cooking beans from dry', 'An overnight soak, a bay leaf, and why the tin never quite compares.', 4750, false],
  ['pixel', 'One typeface, used well', 'A single family with a real bold beats three faces that barely know each other.', 5050, false],
  ['fieldnotes', 'Fixing a puncture without losing your gloves', 'A method for cold hands, in four calm steps.', 5350, false],
  ['garden', 'Compost that actually gets hot', 'Balance the greens and browns, and turn it before it slumps.', 5650, false],
  // Already read, older.
  ['tide', 'Reading a beach at low water', 'Gullies, shelves and the places the flat sand keeps its secrets.', 6800, true],
  ['salt', 'A lunch of leftovers, done properly', 'Cold roast, hot pan, a fried egg on top. Nothing more.', 7600, true],
  ['pixel', 'Choosing a second colour', 'The first colour does the work. The second one gets out of the way.', 8400, true],
];

async function ensureDemo(userId, now) {
  for (const f of DEMO_FEEDS) {
    await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, hue, is_demo, created_at)
       VALUES ($1, $2, $3, $4, $5, true, $6) ON CONFLICT (user_id, url) DO NOTHING`,
      [userId, f.site + '/feed', f.title, f.site, f.hue, now]
    );
  }
  const ids = await pool.query(
    `SELECT id, url FROM feeds WHERE user_id = $1 AND is_demo = true`,
    [userId]
  );
  const byUrl = new Map(ids.rows.map((r) => [r.url, r.id]));
  for (let i = 0; i < DEMO_POSTS.length; i++) {
    const [key, title, summary, minutesAgo, read] = DEMO_POSTS[i];
    const feed = DEMO_FEEDS.find((f) => f.key === key);
    const feedId = byUrl.get(feed.site + '/feed');
    if (!feedId) continue;
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, summary, published_at, read_at)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (feed_id, guid) DO NOTHING`,
      [
        feedId,
        'demo-' + key + '-' + i,
        title,
        summary,
        new Date(now.getTime() - minutesAgo * 60_000),
        read ? new Date(now.getTime() - minutesAgo * 60_000 + 60_000) : null,
      ]
    );
  }
}

// ── Routes ───────────────────────────────────────────────────────────────
// All scoped to req.user.id; a guest gets empty lists. Without ?demo=1 the
// answers leave out demo feeds and their posts.

app.get('/api/posts', async (req, res, next) => {
  try {
    const { userId, demo } = scope(req);
    if (userId && demo) await ensureDemo(userId, req.now);
    if (!userId) {
      return res.json({ posts: [], unreadCount: 0, feedCount: 0, failedFeeds: [], staging: IS_STAGING });
    }
    const posts = await pool.query(
      `SELECT p.id, p.title, p.link, p.summary, p.published_at, f.title AS feed_title,
              f.hue, f.site_url
       FROM posts p JOIN feeds f ON f.id = p.feed_id
       WHERE f.user_id = $1 AND p.read_at IS NULL AND ($2::boolean OR f.is_demo = false)
       ORDER BY p.published_at DESC LIMIT 300`,
      [userId, demo]
    );
    const counts = await pool.query(
      `SELECT COUNT(DISTINCT f.id)::int AS feed_count,
              COUNT(p.id) FILTER (WHERE p.read_at IS NULL)::int AS unread_count
       FROM feeds f LEFT JOIN posts p ON p.feed_id = f.id
       WHERE f.user_id = $1 AND ($2::boolean OR f.is_demo = false)`,
      [userId, demo]
    );
    const failed = await pool.query(
      `SELECT title FROM feeds WHERE user_id = $1 AND last_error IS NOT NULL AND ($2::boolean OR is_demo = false)`,
      [userId, demo]
    );
    res.json({
      posts: posts.rows,
      unreadCount: counts.rows[0].unread_count,
      feedCount: counts.rows[0].feed_count,
      failedFeeds: failed.rows.map((r) => r.title),
      staging: IS_STAGING,
    });
  } catch (err) {
    next(err);
  }
});

function firstWords(s, n) {
  const words = String(s || '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, n).join(' ');
}

async function mapLimit(list, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const j = i++;
      await fn(list[j], j);
    }
  });
  await Promise.all(workers);
}

app.post('/api/refresh', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const feeds = await pool.query(
      `SELECT id, url FROM feeds WHERE user_id = $1 AND is_demo = false ORDER BY id`,
      [req.user.id]
    );
    await mapLimit(feeds.rows, 4, async (feed) => {
      try {
        const parsed = await fetchFeed(feed.url);
        for (const item of parsed.items) {
          await pool.query(
            `INSERT INTO posts (feed_id, guid, title, link, summary, published_at)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (feed_id, guid) DO NOTHING`,
            [
              feed.id,
              item.guid,
              item.title || firstWords(item.summary, 12) || 'Untitled post',
              /^https?:\/\//i.test(item.link || '') ? item.link : null,
              item.summary,
              item.publishedAt || new Date(),
            ]
          );
        }
        await pool.query(
          `UPDATE feeds SET title = $2, site_url = $3, last_error = NULL, last_fetched_at = $4 WHERE id = $1`,
          [feed.id, parsed.title || 'Untitled feed', parsed.siteUrl, new Date()]
        );
      } catch (e) {
        await pool.query(
          `UPDATE feeds SET last_error = $2, last_fetched_at = $3 WHERE id = $1`,
          [feed.id, e instanceof FetchError ? e.code : 'unreachable', new Date()]
        );
      }
    });
    // No posts in the answer: the client calls GET /api/posts again.
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/api/feeds', async (req, res, next) => {
  try {
    const { userId, demo } = scope(req);
    if (userId && demo) await ensureDemo(userId, req.now);
    if (!userId) return res.json({ feeds: [] });
    const rows = await pool.query(
      `SELECT f.id, f.title, f.site_url, f.hue, f.is_demo, f.last_error,
              (SELECT COUNT(*)::int FROM posts p WHERE p.feed_id = f.id AND p.read_at IS NULL) AS unread_count
       FROM feeds f WHERE f.user_id = $1 AND ($2::boolean OR f.is_demo = false) ORDER BY f.id`,
      [userId, demo]
    );
    res.json({ feeds: rows.rows });
  } catch (err) {
    next(err);
  }
});

async function nextHue(userId) {
  const used = await pool.query(`SELECT hue, COUNT(*)::int AS n FROM feeds WHERE user_id = $1 GROUP BY hue`, [userId]);
  const taken = new Set(used.rows.map((r) => r.hue));
  for (let h = 1; h <= 5; h++) {
    if (!taken.has(h)) return h;
  }
  const total = used.rows.reduce((sum, r) => sum + r.n, 0);
  return (total % 5) + 1;
}

app.post('/api/feeds', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'account_required' });
    const raw = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
    if (!raw) return res.status(422).json({ error: 'not_a_feed' });
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
    const dup = await pool.query(`SELECT id FROM feeds WHERE user_id = $1 AND url = $2`, [req.user.id, url]);
    if (dup.rows.length) return res.status(409).json({ error: 'duplicate' });
    let parsed;
    try {
      parsed = await fetchFeed(url);
    } catch (e) {
      const code = e instanceof FetchError ? e.code : 'unreachable';
      return res.status(422).json({ error: code });
    }
    const hue = await nextHue(req.user.id);
    const inserted = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, hue, last_fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, title, site_url, hue, is_demo, last_error`,
      [req.user.id, url, parsed.title, parsed.siteUrl, hue, new Date()]
    );
    const feed = inserted.rows[0];
    for (const item of parsed.items) {
      await pool.query(
        `INSERT INTO posts (feed_id, guid, title, link, summary, published_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (feed_id, guid) DO NOTHING`,
        [
          feed.id,
          item.guid,
          item.title || firstWords(item.summary, 12) || 'Untitled post',
          /^https?:\/\//i.test(item.link || '') ? item.link : null,
          item.summary,
          item.publishedAt || new Date(),
        ]
      );
    }
    res.status(201).json({ feed });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/feeds/:id', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'account_required' });
    const del = await pool.query(`DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id`, [
      Number(req.params.id) || 0,
      req.user.id,
    ]);
    if (!del.rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/posts/:id/read', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'account_required' });
    const upd = await pool.query(
      `UPDATE posts SET read_at = $2
       WHERE id = $1 AND read_at IS NULL
         AND feed_id IN (SELECT id FROM feeds WHERE user_id = $3)
       RETURNING id`,
      [Number(req.params.id) || 0, new Date(), req.user.id]
    );
    res.json({ ok: true, marked: upd.rows.length > 0 });
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

let server = null;
let shuttingDown = false;

async function start() {
  await applySchema().catch((err) => {
    console.error('schema failed: ' + err.message);
  });
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

// Stop accepting, drain about 3 s, close the pool, exit.
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const finish = () => {
    pool.end().then(() => process.exit(0)).catch(() => process.exit(0));
  };
  if (!server) return finish();
  server.close(() => finish());
  setTimeout(finish, 3000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(err => { console.error(err); process.exit(1); });
