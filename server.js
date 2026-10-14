const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { fetchFeed, assertPublicUrl } = require('./lib/fetchFeed');

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

// ── Schema ─────────────────────────────────────────────────────────────────
// Each person's feeds and posts are their own: both tables carry user_id (or
// feed_id into a user-scoped feeds row) and every query filters on it. In
// staging both are marked staging:private, so the platform's demo data
// seeding does not write into them.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS feeds (
    id          serial PRIMARY KEY,
    user_id     text NOT NULL,
    url         text NOT NULL,
    title       text NOT NULL,
    site_url    text,
    color_index int NOT NULL DEFAULT 0,
    is_demo     boolean NOT NULL DEFAULT false,
    last_error  text,
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS posts (
    id           serial PRIMARY KEY,
    feed_id      int NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid         text NOT NULL,
    title        text NOT NULL,
    link         text,
    snippet      text,
    image_url    text,
    published_at timestamptz,
    read_at      timestamptz,
    is_demo      boolean NOT NULL DEFAULT false,
    UNIQUE (feed_id, guid)
  );
  CREATE INDEX IF NOT EXISTS posts_feed_idx ON posts (feed_id);
  COMMENT ON TABLE feeds IS 'staging:private';
  COMMENT ON TABLE posts IS 'staging:private';
`;

async function initSchema() {
  await pool.query(SCHEMA);
}

// The six colours a feed's unread dot is drawn in: feed N gets color_index N
// (bg-feed-1 … bg-feed-6 on the page).
const FEED_COLOURS = 6;

function nextColorIndex(rows) {
  const used = new Set(rows.map((r) => r.color_index));
  for (let i = 0; i < FEED_COLOURS; i += 1) if (!used.has(i)) return i;
  return rows.length % FEED_COLOURS;
}

// ── Demo data ──────────────────────────────────────────────────────────────
// On ?demo=1 in staging only, once per viewing account: four sample feeds and
// fourteen unread posts so the populated screen can be seen. Demo feeds are
// never fetched (their addresses are examples), and rows marked is_demo are
// excluded from EVERY response that did not ask for the demo, so the same
// account sees its real, and only its real, feeds without the parameter.

const DEMO_FEEDS = [
  {
    url: 'https://harborlane.example/feed.xml',
    title: 'Harbor Lane Garden Notes',
    posts: [
      { guid: 'hlg-5-tomatoes', title: 'Five tomatoes that shrug off a cold spring', snippet: 'We grew twelve varieties on the windy plot this year. These five set fruit weeks before the rest, and none of them needed a cloche after mid-May. First up is a small yellow cherry that ripened in early July even after two nights near freezing.', ago: [0, 25], image: '/demo/garden.svg' },
      { guid: 'hlg-garlic', title: 'Planting garlic the lazy way', snippet: 'Cloves straight into cold soil, a handful of compost on top, and forget about them until July. The bed by the fence has never done better.', ago: [1, 5] },
      { guid: 'hlg-slugs', title: 'A beer trap that actually works', snippet: 'Half bury a jar at soil level, top it up, and empty it each morning. After three nights the lettuce stops disappearing.', ago: [2, 3] },
      { guid: 'hlg-seed-order', title: 'What I ordered for next year, and why', snippet: 'Fewer varieties, more of the ones that produced. Two pages of notes from this season, cut down to one short list.', ago: [3, 2] },
    ],
  },
  {
    url: 'https://nightsky.example/weekly.xml',
    title: 'Night Sky Weekly',
    posts: [
      { guid: 'nsw-andromeda', title: 'The best week this autumn to spot the Andromeda galaxy', snippet: 'A dark moon and clear forecasts line up on Thursday. Here is where to look, why binoculars beat a telescope for it, and what to bring out with you.', ago: [0, 130], image: '/demo/sky.svg' },
      { guid: 'nsw-star-chart', title: 'How to read a star chart in five minutes', snippet: 'Hold it overhead, find north, and start from the brightest thing you can see. Everything else falls into place from there.', ago: [2, 4] },
      { guid: 'nsw-jupiter', title: 'Jupiter is back, and it is worth staying up for', snippet: 'It rises before eleven this month. Even steadily held binoculars show two or three of its moons, and the view gets better all autumn.', ago: [3, 1] },
      { guid: 'nsw-meteor', title: 'Saturday meteor night: what to realistically expect', snippet: 'Under a genuinely dark sky, one every few minutes, most of them faint. Go for the solitude and the surprise, not a fireworks show.', ago: [4, 6] },
    ],
  },
  {
    url: 'https://pocketkitchen.example/rss.xml',
    title: 'The Pocket Kitchen',
    posts: [
      { guid: 'tpk-lentils', title: 'One-pan lentils for a Tuesday night', snippet: 'Twenty minutes, one pan and a lemon. The trick is to toast the spices before the lentils go in, then let the whole thing sit off the heat for five minutes.', ago: [0, 300], image: '/demo/kitchen.svg' },
      { guid: 'tpk-freezer', title: 'Five things worth a corner of the freezer', snippet: 'Parmesan rinds, browned onions, chipotle in adobo, homemade stock, and sliced bread for toast emergencies. Each one saves a meal.', ago: [1, 9] },
      { guid: 'tpk-eggs', title: 'The egg test for a good pan', snippet: 'If an egg slides around on medium heat without oil, the pan is ready. A small habit that fixed both my scrambled eggs and my omelettes.', ago: [3, 7] },
    ],
  },
  {
    url: 'https://tidewater.example/rides.xml',
    title: 'Tidewater Cycling Club',
    posts: [
      { guid: 'tcc-coast-loop', title: 'Route notes: the coast loop is open again', snippet: 'The bridge repairs finished early. Expect fresh gravel on the north side for another week, and take the lower gate if you are on narrow tyres.', ago: [1, 20] },
      { guid: 'tcc-lights', title: 'Autumn lights: a short buying guide', snippet: 'A 400 lumen front and a flash rear cover the club rides from now on. Charge both, and mount the front on the bars, not the helmet.', ago: [2, 8] },
      { guid: 'tcc-sunday', title: "Sunday's social ride moves to ten", snippet: 'Same start, one hour later, so the coffee stop opens before we arrive. Roughly thirty miles at a talking pace.', ago: [4, 2] },
    ],
  },
];

async function seedDemo(userId, now) {
  const existing = await pool.query(
    'SELECT id FROM feeds WHERE user_id = $1 AND is_demo = true LIMIT 1',
    [userId],
  );
  if (existing.rows.length) return;

  const ago = ([days, minutes]) => new Date(now.getTime() - days * 86400000 - minutes * 60000);

  for (let i = 0; i < DEMO_FEEDS.length; i += 1) {
    const feed = DEMO_FEEDS[i];
    const inserted = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, color_index, is_demo)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id`,
      [userId, feed.url, feed.title, feed.url.replace(/\/feed\.xml$|\/weekly\.xml$|\/rss\.xml$|\/rides\.xml$/, '/'), i],
    );
    const feedId = inserted.rows[0].id;
    for (const post of feed.posts) {
      await pool.query(
        `INSERT INTO posts (feed_id, guid, title, link, snippet, image_url, published_at, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
        [feedId, post.guid, post.title, feed.url.replace(/\/[^/]*$/, '/posts/' + post.guid.replace(/[^a-z0-9-]/gi, '')), post.snippet, post.image || null, ago(post.ago)],
      );
    }
  }
}

// ── API ────────────────────────────────────────────────────────────────────

// The unread list, and everything the screen needs in one response: the
// viewer's feeds (for the Feeds sheet and each row's dot colour) and their
// unread posts, newest first. Guests get an empty read-only view.
app.get('/api/posts', async (req, res) => {
  if (!req.user) return res.json({ demo: false, feeds: [], posts: [], unread: 0, errors: [] });

  const wantsDemo = IS_STAGING && req.query.demo === '1';

  try {
    if (wantsDemo) await seedDemo(req.user.id, req.now);

    const demoFlag = wantsDemo;
    const feedRows = (await pool.query(
      `SELECT id, url, title, site_url, color_index, is_demo, last_error
         FROM feeds WHERE user_id = $1 AND is_demo = $2 ORDER BY created_at, id`,
      [req.user.id, demoFlag],
    )).rows;

    // Server-side refresh on list load: real feeds only, all in parallel, and
    // a failure never blocks the list — it lands in the feed's last_error and
    // shows as the quiet failed-feeds line.
    if (!wantsDemo && feedRows.length) {
      await Promise.allSettled(feedRows.map(async (feed) => {
        try {
          const parsed = await fetchFeed(feed.url);
          for (const item of parsed.items) {
            await pool.query(
              `INSERT INTO posts (feed_id, guid, title, link, snippet, image_url, published_at, is_demo)
               VALUES ($1, $2, $3, $4, $5, $6, $7, false) ON CONFLICT (feed_id, guid) DO NOTHING`,
              [feed.id, item.guid, item.title || 'Untitled', item.link, item.snippet, item.imageUrl, item.publishedAt],
            );
          }
          if (feed.last_error || !feed.title) {
            await pool.query('UPDATE feeds SET last_error = NULL, title = $2 WHERE id = $1', [feed.id, parsed.title || feed.title]);
          }
        } catch (err) {
          await pool.query('UPDATE feeds SET last_error = $2 WHERE id = $1', [feed.id, err.message]);
        }
      }));
    }

    const feeds = feedRows.map((f) => ({
      id: f.id,
      url: f.url,
      title: f.title,
      colorIndex: f.color_index,
      error: f.last_error || null,
    }));

    const postRows = (await pool.query(
      `SELECT p.id, p.title, p.link, p.snippet, p.image_url AS "imageUrl",
              p.published_at AS "publishedAt", p.feed_id AS "feedId"
         FROM posts p
         JOIN feeds f ON f.id = p.feed_id
        WHERE f.user_id = $1 AND f.is_demo = $2 AND p.read_at IS NULL
        ORDER BY p.published_at DESC NULLS LAST, p.id DESC`,
      [req.user.id, demoFlag],
    )).rows;

    const byId = new Map(feeds.map((f) => [f.id, f]));
    const posts = postRows
      .filter((p) => byId.has(p.feedId))
      .map((p) => ({ ...p, feedTitle: byId.get(p.feedId).title, colorIndex: byId.get(p.feedId).colorIndex }));

    return res.json({
      demo: demoFlag,
      feeds,
      posts,
      unread: posts.length,
      errors: feeds.filter((f) => f.error).map((f) => f.title),
    });
  } catch (err) {
    console.error('GET /api/posts failed: ' + err.message);
    return res.status(500).json({ error: 'The unread list could not be loaded.' });
  }
});

// Add a feed: fetch and parse it first, so a mistyped address is rejected
// here rather than saved as a broken feed. Then save it, with the next dot
// colour, and everything it currently carries.
app.post('/api/feeds', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const url = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!url) return res.status(400).json({ error: 'Type an address first.' });

  const existing = await pool.query(
    'SELECT id FROM feeds WHERE user_id = $1 AND url = $2',
    [req.user.id, url],
  );
  if (existing.rows.length) {
    return res.status(409).json({ error: 'You already have that feed.' });
  }

  let parsed;
  try {
    await assertPublicUrl(url);
    parsed = await fetchFeed(url);
  } catch (err) {
    return res.status(422).json({ error: err.message });
  }
  if (!parsed.items.length) {
    return res.status(422).json({ error: 'That feed has no posts in it.' });
  }

  const owned = (await pool.query('SELECT color_index FROM feeds WHERE user_id = $1', [req.user.id])).rows;
  const colorIndex = nextColorIndex(owned);

  const inserted = await pool.query(
    `INSERT INTO feeds (user_id, url, title, site_url, color_index)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, title, color_index AS "colorIndex"`,
    [req.user.id, url, parsed.title || url, parsed.siteUrl, colorIndex],
  );
  const feed = inserted.rows[0];

  for (const item of parsed.items) {
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, snippet, image_url, published_at, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false) ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feed.id, item.guid, item.title || 'Untitled', item.link, item.snippet, item.imageUrl, item.publishedAt],
    );
  }
  return res.status(201).json(feed);
});

// Remove a feed: its posts go with it.
app.delete('/api/feeds/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Feed not found.' });
  const deleted = await pool.query(
    'DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id',
    [id, req.user.id],
  );
  if (!deleted.rows.length) return res.status(404).json({ error: 'Feed not found.' });
  return res.json({ ok: true });
});

// Mark a post read: the unread list is every post without a read_at.
app.post('/api/posts/:id/read', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Post not found.' });
  const updated = await pool.query(
    `UPDATE posts SET read_at = $3
       FROM feeds
      WHERE posts.feed_id = feeds.id AND posts.id = $1 AND feeds.user_id = $2
        AND posts.read_at IS NULL
      RETURNING posts.id`,
    [id, req.user.id, req.now],
  );
  if (!updated.rows.length) return res.status(404).json({ error: 'Post not found.' });
  return res.json({ ok: true });
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

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
  await initSchema();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // Stop listening first, give in-flight requests a few seconds to finish,
  // then close the pool, so a redeploy never cuts a response mid-write.
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal}: shutting down`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
