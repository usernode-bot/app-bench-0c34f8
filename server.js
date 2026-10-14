const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { safeFetch, discover, parseFeed } = require('./lib/feeds.js');

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

// ── Schema ─────────────────────────────────────────────────────────────────
// Two per-viewer tables. Feeds follow their own rows; posts belong to the
// feed and go away with it (ON DELETE CASCADE). A comment on each table marks
// it `staging:private`, which is the platform's convention for staging demo
// data: it is never copied into production.
async function bootSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      site_url TEXT,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_checked_at TIMESTAMPTZ,
      last_error TEXT,
      is_demo BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE (user_id, url)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id BIGSERIAL PRIMARY KEY,
      feed_id BIGINT NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT '',
      published_at TIMESTAMPTZ,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ,
      UNIQUE (feed_id, guid)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS posts_feed_idx ON posts (feed_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS posts_read_idx ON posts (read_at)`);
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE posts IS 'staging:private'`);
}

// ── Staging demo data ──────────────────────────────────────────────────────
// `?demo=1` (staging only) seeds four made-up feeds and about fourteen posts
// the first time a viewer opens the demo. Rows are marked is_demo and stored
// per viewer, so reads and removals stick; every insert is
// ON CONFLICT DO NOTHING, so re-seeding is a no-op. Content is invented,
// obviously fake, and safe (no real brands, people or claims).
const DEMO_FEEDS = [
  {
    url: 'https://demo.example/garden-notes.xml',
    title: 'Demo Garden Notes',
    site: 'https://demo.example/garden',
    items: [
      ['dg-1', 'Five pretend tomatoes that grew in a made-up greenhouse', 'The sample greenhouse had a good week: the cherry tomatoes ripened early, the basil stopped sulking, and the watering rota held up through the heat.', 'today 9:40'],
      ['dg-2', 'Why our sample compost heap smells faintly of oranges', 'A made-up heap turned itself into garden gold over the weekend. Here is what the pretend thermometer said about the layers, and when to turn.', 'yesterday 17:05'],
      ['dg-3', 'A fictional frost date, and what to plant around it', 'Our imaginary almanac says the first frost lands in six weeks. Three pretend crops that go in now, and one to wait on.', 'today 7:12'],
    ],
  },
  {
    url: 'https://demo.example/bike-workshop.xml',
    title: 'Sample Bike Workshop',
    site: 'https://demo.example/bikes',
    items: [
      ['sb-1', 'Truing a wheel with nothing but a zip tie and patience', 'A zip tie zip-tied to the frame makes a fine gauge. This invented technique trues a wheel close enough for the road home.', 'today 8:15'],
      ['sb-2', "Readers' made-up commutes, ranked by puddles", 'Twelve pretend commuters sent in their routes. The winner crosses a ford, a towpath and one construction site every morning.', 'yesterday 12:48'],
      ['sb-3', 'The fictional case for riding in the rain', 'Rain riding is a skill the sample workshop believes in. Fenders, gloves and a dry pair of socks waiting at home.', 'yesterday 9:30'],
      ['sb-4', 'A pretend puncture, and the plug that saved the ride', 'The sample thorn went through a brand-new tyre. Tubeless plugs exist for exactly this invented crisis.', 'today 6:50'],
    ],
    broken: true,
  },
  {
    url: 'https://demo.example/test-kitchen.xml',
    title: 'Test Kitchen Weekly',
    site: 'https://demo.example/kitchen',
    items: [
      ['tk-1', 'A fake soup recipe that tastes exactly like Tuesday', 'Potato, leek, and an entirely invented pinch of something. Tuesday, in a bowl, for four.', 'today 7:02'],
      ['tk-2', 'The imaginary difference between roasting pans', 'We made-up-baked the same chicken in three pretend pans. Dark metal wins, and by how much may surprise you.', 'yesterday 15:20'],
      ['tk-3', 'Sample sourdough, day three of an invented starter', 'The pretend starter doubled overnight and smells of yogurt. Tomorrow: first loaf, and a made-up scoring pattern.', 'today 5:45'],
    ],
  },
  {
    url: 'https://demo.example/sky-journal.xml',
    title: 'Placeholder Sky Journal',
    site: 'https://demo.example/sky',
    items: [
      ['pj-1', 'Spotting imaginary comets from a rooftop that does not exist', 'The fictional comet C/2026 Demo swings past the pretend horizon tonight. Binoculars, a thermos, and a neighbour with a telescope.', 'yesterday 21:30'],
      ['pj-2', 'A made-up cloud atlas for the week ahead', 'Sample stratus in the morning, invented cumulus by noon. What each pretend shape says about tomorrow.', 'today 8:02'],
      ['pj-3', 'The fictional aurora forecast, explained plainly', 'Our imaginary space-weather desk rates the coming nights. Where and when to look, in one made-up map.', 'yesterday 19:10'],
      ['pj-4', 'Placeholder meteor shower: the practical guide', 'The pretend shower peaks on Thursday. Three invented tips: lie back, look northeast, give your eyes twenty minutes.', 'today 6:20'],
    ],
  },
];

async function seedDemo(userId, now) {
  // Seed once per viewer, not per visit: a marker row (never shown) means a
  // feed the viewer removed stays removed, as reads do.
  const mark = await pool.query(
    `INSERT INTO feeds (user_id, url, title, site_url, is_demo, last_checked_at)
     VALUES ($1, 'urn:rss-reader:demo:seeded', 'Demo', '', TRUE, NOW())
     ON CONFLICT (user_id, url) DO NOTHING
     RETURNING id`,
    [userId]);
  if (!mark.rows.length) return;
  // Spread the posts across Today, Yesterday and the day before, keyed to the
  // request's "now" so the day headings always come out right.
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (const feed of DEMO_FEEDS) {
    const res = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, is_demo, last_checked_at, last_error)
       VALUES ($1, $2, $3, $4, TRUE, NOW(), $5)
       ON CONFLICT (user_id, url) DO NOTHING
       RETURNING id`,
      [userId, feed.url, feed.title, feed.site, feed.broken ? 'Could not be read just now.' : null]);
    if (!res.rows.length) continue; // already seeded for this viewer
    const feedId = res.rows[0].id;
    for (const [guid, title, snippet, when] of feed.items) {
      const [day, time] = when.split(' ');
      const [h, m] = time.split(':').map(Number);
      const date = new Date(midnight.getTime() - (day === 'yesterday' ? 1 : day === 'today' ? 0 : 2) * 86400000);
      date.setHours(h, m, 0, 0);
      await pool.query(
        `INSERT INTO posts (feed_id, guid, title, link, snippet, published_at, first_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (feed_id, guid) DO NOTHING`,
        [feedId, guid, title, 'https://example.com/rss-reader-demo#' + guid, snippet, date]);
    }
  }
}

// ── Refreshing a feed ──────────────────────────────────────────────────────
const REFRESH_AFTER_MS = 2 * 60 * 1000;

async function refreshFeed(feed) {
  try {
    const { text } = await safeFetch(feed.url);
    const parsed = parseFeed(text, feed.url);
    if (!parsed) throw new Error('No feed found at that address.');
    if (parsed.items.length) {
      const values = [];
      const rows = parsed.items.map((item, i) => {
        values.push(feed.id, item.guid, item.title.slice(0, 300), item.link, (item.snippet || '').slice(0, 300),
          item.date || null);
        return `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`;
      });
      await pool.query(
        `INSERT INTO posts (feed_id, guid, title, link, snippet, published_at)
         VALUES ${rows.join(', ')}
         ON CONFLICT (feed_id, guid) DO NOTHING`,
        values);
    }
    await pool.query(`UPDATE feeds SET last_checked_at = NOW(), last_error = NULL WHERE id = $1`, [feed.id]);
  } catch (err) {
    // A feed that cannot be read never fails the response; its earlier posts
    // stay, and the list shows one line for it.
    await pool.query(`UPDATE feeds SET last_checked_at = NOW(), last_error = $2 WHERE id = $1`,
      [feed.id, 'Could not be read just now.']);
    console.warn(`feed refresh failed for feed ${feed.id}: ${err.message}`);
  }
}

async function refreshStaleFeeds(userId, nowMs) {
  const res = await pool.query(
    `SELECT id, url FROM feeds
     WHERE user_id = $1 AND is_demo = FALSE
       AND (last_checked_at IS NULL OR last_checked_at < $2)
     LIMIT 10`,
    [userId, new Date(nowMs - REFRESH_AFTER_MS)]);
  if (res.rows.length) await Promise.all(res.rows.map(refreshFeed));
}

// ── API ────────────────────────────────────────────────────────────────────
// The viewer's feeds and their unread posts, newest first, grouped by day in
// the page. Guests see a signed-out notice instead. A feed that cannot be
// read right now is reported with `failed` (its earlier posts still show).
app.get('/api/posts', async (req, res) => {
  if (!req.user) {
    if (req.guest) return res.json({ signedOut: true });
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const userId = req.user.id;
  const demo = IS_STAGING && req.query.demo === '1';
  try {
    if (demo) await seedDemo(userId, req.now);
    await refreshStaleFeeds(userId, req.now.getTime());

    const feedsRes = await pool.query(
      `SELECT id, title, last_error FROM feeds WHERE user_id = $1
         AND ($2 OR is_demo = FALSE) AND NOT (is_demo AND url = 'urn:rss-reader:demo:seeded')
       ORDER BY added_at`,
      [userId, demo]);
    const failed = feedsRes.rows.filter((f) => f.last_error).map((f) => f.title);
    const postsRes = await pool.query(
      `SELECT p.id, p.title, p.link, p.snippet, p.published_at, p.first_seen_at, p.read_at,
              f.title AS feed_title
       FROM posts p JOIN feeds f ON f.id = p.feed_id
       WHERE f.user_id = $1 AND ($2 OR f.is_demo = FALSE) AND p.read_at IS NULL
       ORDER BY COALESCE(p.published_at, p.first_seen_at) DESC, p.id DESC`,
      [userId, demo]);
    res.json({
      feeds: feedsRes.rows.map((f) => ({ id: f.id, title: f.title })),
      failed,
      unreadCount: postsRes.rows.length,
      posts: postsRes.rows.map((p) => ({
        id: p.id,
        feed: p.feed_title,
        title: p.title,
        link: p.link,
        snippet: p.snippet,
        date: p.published_at || p.first_seen_at,
      })),
    });
  } catch (err) {
    console.error('GET /api/posts failed: ' + err.message);
    res.status(500).json({ error: 'Your posts did not load. Your feeds are still saved.' });
  }
});

// Add a feed: fetch the address, discover a feed when it is a site, parse it,
// store the feed and its items. 400 with a short sentence when the address is
// unreachable or has no feed; 409 when the viewer already follows it.
app.post('/api/feeds', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const userId = req.user.id;
  const raw = typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!raw) return res.status(400).json({ error: 'Paste a feed or site address first.' });
  let address = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) address = 'https://' + address;

  let fetched;
  try {
    fetched = await safeFetch(address);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (fetched.status >= 400) return res.status(400).json({ error: 'That address could not be reached. Check it and try again.' });

  let parsed = parseFeed(fetched.text, fetched.url.href);
  let feedUrl = fetched.url.href;
  if (!parsed) {
    // Not a feed: look for one advertised by the page.
    const found = discover(fetched.text, fetched.url.href);
    if (!found) return res.status(400).json({ error: 'No feed was found at that address. Paste the feed address itself.' });
    try {
      const second = await safeFetch(found);
      parsed = parseFeed(second.text, second.url.href);
      feedUrl = second.url.href;
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  if (!parsed || !parsed.items.length) {
    return res.status(400).json({ error: 'No feed was found at that address. Paste the feed address itself.' });
  }

  try {
    const feedRes = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, url) DO NOTHING
       RETURNING id, title`,
      [userId, feedUrl, parsed.title || feedUrl, null]);
    if (!feedRes.rows.length) return res.status(409).json({ error: 'You are already following that feed.' });
    const feedId = feedRes.rows[0].id;
    const values = [];
    const rows = parsed.items.map((item, i) => {
      values.push(feedId, item.guid, item.title.slice(0, 300), item.link, (item.snippet || '').slice(0, 300), item.date || null);
      return `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`;
    });
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, snippet, published_at)
       VALUES ${rows.join(', ')}
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      values);
    await pool.query(`UPDATE feeds SET last_checked_at = NOW() WHERE id = $1`, [feedId]);
    res.status(201).json({ added: feedRes.rows[0].title || feedUrl });
  } catch (err) {
    console.error('POST /api/feeds failed: ' + err.message);
    res.status(500).json({ error: 'The feed could not be saved. Try again.' });
  }
});

// Stop following a feed. Only the viewer's own; its posts go with it.
app.delete('/api/feeds/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'That feed could not be removed.' });
  const res2 = await pool.query(`DELETE FROM feeds WHERE id = $1 AND user_id = $2`, [id, req.user.id]);
  if (!res2.rowCount) return res.status(404).json({ error: 'That feed was already removed.' });
  res.json({ removed: true });
});

// Mark a post read. Idempotent, the viewer's own only.
app.post('/api/posts/:id/read', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'That post could not be marked.' });
  const res2 = await pool.query(
    `UPDATE posts p SET read_at = COALESCE(p.read_at, NOW())
     FROM feeds f
     WHERE p.id = $1 AND p.feed_id = f.id AND f.user_id = $2`,
    [id, req.user.id]);
  if (!res2.rowCount) return res.status(404).json({ error: 'That post could not be marked.' });
  res.json({ read: true });
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
  await bootSchema();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // The platform stops the container with SIGTERM: close the server, give
  // open requests 3 s to drain, then close the pool and leave.
  let stopping = false;
  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    const force = setTimeout(() => process.exit(1), 3000);
    force.unref();
    server.close();
    try { await pool.end(); } catch { /* the pool is already gone */ }
    clearTimeout(force);
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
