const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const feeds = require('./feeds');

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

// ── This app's own data ──────────────────────────────────────────────────

// Every table here is per-viewer: only the person whose feeds they are ever
// reads them. Marked `staging:private` so staging demo data never lands in
// a production database.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      site_url text,
      demo boolean NOT NULL DEFAULT false,
      last_error text,
      last_fetched_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, url)
    );
    CREATE TABLE IF NOT EXISTS posts (
      id serial PRIMARY KEY,
      feed_id integer NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
      guid text NOT NULL,
      title text NOT NULL,
      link text,
      snippet text NOT NULL DEFAULT '',
      content_html text NOT NULL DEFAULT '',
      published_at timestamptz,
      read_at timestamptz,
      UNIQUE (feed_id, guid)
    );
    CREATE TABLE IF NOT EXISTS demo_seeds (
      user_id text PRIMARY KEY,
      seeded_at timestamptz NOT NULL
    );
  `);
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE posts IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE demo_seeds IS 'staging:private'`);
}

// `?demo=1` shows the staging demo: one set of made-up feeds per viewer,
// seeded once and then never fetched. Production ignores the flag entirely.
app.use('/api', (req, _res, next) => {
  req.demoMode = IS_STAGING && req.query.demo === '1';
  next();
});

const hoursAgo = (now, h) => new Date(now.getTime() - h * 3600_000);

// Obviously fake seed data for the staging demo only ("Staging mock data"
// in the platform conventions): five pretend feeds on example.invalid
// addresses, never fetched.
const DEMO_FEEDS = [
  {
    title: 'Example Garden Notes', url: 'https://garden.example.invalid/feed.xml',
    site: 'https://garden.example.invalid', mono: 'GN', posts: [
      { ago: 2, title: 'Sample post: planting tomatoes in October, a made-up guide',
        snippet: 'Demo text for a pretend gardening blog. The beds were turned over last weekend and the first cover crop is going in now.' },
      { ago: 7, title: 'A made-up autumn tidy-up for the sample borders',
        snippet: 'Fictional garden notes: cutting back the dead stalks, mulching the pretend beds and the labels that faded in the sun.' },
      { ago: 26, title: 'Demo diary: the sample greenhouse meets its first frost',
        snippet: 'Not real weather or a real greenhouse. The panes fogged over, the thermometer read low and the made-up seedlings waited it out.' },
      { ago: 72, title: 'Pretend plan: crop rotation for an imaginary allotment',
        snippet: 'Sample writing about moving the beans to where the peas were, and the onions following the garlic, in a garden that does not exist.' },
    ],
  },
  {
    title: 'Sample Bike Workshop', url: 'https://bikes.example.invalid/feed.xml',
    site: 'https://bikes.example.invalid', mono: 'BW', posts: [
      { ago: 4, title: 'Fixing a squeaky chain, step by step (demo)',
        snippet: 'A fictional repair note: clean the links, dry them, then oil one link at a time and wipe off what is left over.' },
      { ago: 9, title: 'Demo check-up: brakes that stop a pretend bike on time',
        snippet: 'Made-up maintenance notes for the staging preview: pad wear, cable stretch and the art of the four-millimetre gap.' },
      { ago: 30, title: 'A fictional winter checklist for a sample commuter',
        snippet: 'Nothing here is real advice: lights charged, tyres a little softer, and a mudguard fitted to an imaginary frame.' },
      { ago: 96, title: 'Pretend history: the sample frame that came back from the shed',
        snippet: 'A made-up story about a rusty sample bike, three evenings of work and a very satisfied imaginary owner.' },
    ],
  },
  {
    title: 'Demo Kitchen Log', url: 'https://kitchen.example.invalid/feed.xml',
    site: 'https://kitchen.example.invalid', mono: 'KL', posts: [
      { ago: 6, title: 'Five pretend soups for a rainy week',
        snippet: 'Made-up recipes for this preview: leek and potato, a red lentil pot and three more that nobody has cooked.' },
      { ago: 12, title: 'Sample notes: bread that rises in a cold kitchen',
        snippet: 'Demo baking talk for the staging preview: a longer prove, a warmer bowl and a loaf that still came out flat.' },
      { ago: 28, title: 'A made-up pantry clear-out, one shelf at a time',
        snippet: 'Fictional kitchen log: the three-year-old lentils went, the half jar of sumac stayed, and the shelf looks lighter for it.' },
      { ago: 100, title: 'Pretend taste test: three sample apple varieties',
        snippet: 'Not real fruit or real verdicts. One crisp, one floury and one that made the imaginary judge say "pie" out loud.' },
    ],
  },
  {
    title: 'Placeholder Weather Desk', url: 'https://weather.example.invalid/feed.xml',
    site: 'https://weather.example.invalid', mono: 'WD', posts: [
      { ago: 20, title: 'Test forecast: fog over the sample valley',
        snippet: 'Not a real forecast. Morning fog lifting by noon over an imaginary town, with light wind from the west.' },
      { ago: 48, title: 'Demo outlook: a made-up week of drizzle and one dry day',
        snippet: 'Sample weather writing for the staging preview: grey, grey, grey, one suspiciously sunny Thursday, then grey again.' },
      { ago: 120, title: 'Placeholder note: why the imaginary wind direction matters',
        snippet: 'Made-up meteorology for a town that does not exist: easterlies bring the sample frost, westerlies bring the pretend rain.' },
    ],
  },
  {
    title: 'Test Pattern Tech', url: 'https://tech.example.invalid/feed.xml',
    site: 'https://tech.example.invalid', mono: 'TP', posts: [
      { ago: 52, title: 'Demo review: a keyboard that does not exist',
        snippet: 'Fake product notes written for the staging preview: quiet keys, a long cable and a battery that lasts a while.' },
      { ago: 74, title: 'Sample guide: backing up a pretend photo library',
        snippet: 'Demo how-to for the staging preview: one copy on the imaginary drive, one in the make-believe cloud, one you can hold.' },
      { ago: 140, title: 'Test log: the sample laptop that survived a coffee spill',
        snippet: 'A fictional repair diary: rice did nothing, a screwdriver did most of it, and the pretend machine lived to type again.' },
    ],
  },
];

const demoHtml = (snippet) =>
  `<p>${snippet}</p>` +
  '<p>None of this is real advice: it is sample writing so the preview shows how a longer article reads, with a couple of paragraphs and a link at the end.</p>' +
  '<p>The made-up author will be back next week with another invented note.</p>';

async function seedDemo(userId, now) {
  const seeded = await pool.query('SELECT 1 FROM demo_seeds WHERE user_id = $1', [userId]);
  if (seeded.rowCount) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const feed of DEMO_FEEDS) {
      const row = await client.query(
        `INSERT INTO feeds (user_id, url, title, site_url, demo) VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [userId, feed.url, feed.title, feed.site]);
      for (const post of feed.posts) {
        await client.query(
          `INSERT INTO posts (feed_id, guid, title, link, snippet, content_html, published_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
          [row.rows[0].id, 'demo-' + feed.mono + '-' + post.ago, post.title,
           feed.site + '/posts/' + post.ago, post.snippet, demoHtml(post.snippet),
           hoursAgo(now, post.ago)]);
      }
    }
    await client.query('INSERT INTO demo_seeds (user_id, seeded_at) VALUES ($1, $2)', [userId, now]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Refresh the viewer's real feeds: fetch each in parallel (feeds.js's own
// guard and timeout bound every request), file what came back, and record a
// failure in last_error rather than failing the whole load — a feed that is
// down must not take the reader with it.
async function refreshFeeds(userId, now) {
  const found = await pool.query(
    'SELECT id, url FROM feeds WHERE user_id = $1 AND demo = false', [userId]);
  await Promise.allSettled(found.rows.map(async (feed) => {
    try {
      const parsed = await feeds.fetchFeed(feed.url);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'UPDATE feeds SET title = $2, site_url = $3, last_error = NULL, last_fetched_at = $4 WHERE id = $1',
          [feed.id, parsed.title, parsed.siteUrl, now]);
        for (const item of parsed.items.slice(0, 50)) {
          await client.query(
            `INSERT INTO posts (feed_id, guid, title, link, snippet, content_html, published_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (feed_id, guid) DO NOTHING`,
            [feed.id, item.guid, item.displayTitle || item.title || 'Untitled post',
             item.link, item.snippet, item.contentHtml,
             item.publishedAt ? new Date(item.publishedAt) : null]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      const message = err instanceof feeds.GuardError ? err.message : 'Could not refresh this feed.';
      console.warn(`feed ${feed.id} refresh failed: ${message}`);
      await pool.query('UPDATE feeds SET last_error = $2 WHERE id = $1', [feed.id, message]);
    }
  }));
}

const FEED_COLUMNS = 'id, url, title, site_url, demo, last_error, created_at';

// The demo view shows the seeded demo feeds; a feed added under ?demo=1 is a
// real feed, so it shows there too (everything the viewer owns). Outside
// ?demo=1 the demo feeds never show.
const ownFeeds = (demoMode) => (demoMode ? 'user_id = $1' : 'user_id = $1 AND demo = false');

app.get('/api/posts', async (req, res) => {
  const userId = req.user ? req.user.id : null;
  if (!userId) return res.json({ feeds: [], posts: [], demo: req.demoMode });
  try {
    if (req.demoMode) await seedDemo(userId, req.now);
    else await refreshFeeds(userId, req.now);
    const feedsOut = await pool.query(
      `SELECT ${FEED_COLUMNS} FROM feeds WHERE ${ownFeeds(req.demoMode)} ORDER BY id`,
      [userId]);
    const postsOut = await pool.query(
      `SELECT p.id, p.feed_id, p.title, p.link, p.snippet, p.published_at, p.read_at, f.title AS feed_title
       FROM posts p JOIN feeds f ON f.id = p.feed_id
       WHERE f.user_id = $1 AND p.read_at IS NULL AND ($2::boolean OR f.demo = false)
       ORDER BY p.published_at DESC NULLS LAST, p.id DESC`,
      [userId, req.demoMode]);
    res.json({ feeds: feedsOut.rows, posts: postsOut.rows, demo: req.demoMode });
  } catch (err) {
    console.error('posts load failed: ' + err.message);
    res.status(500).json({ error: 'Your posts did not load. Your feeds are still saved.' });
  }
});

app.get('/api/posts/:id', async (req, res) => {
  try {
    const found = await pool.query(
      `SELECT p.id, p.title, p.link, p.snippet, p.content_html, p.published_at, p.read_at, f.title AS feed_title
       FROM posts p JOIN feeds f ON f.id = p.feed_id
       WHERE p.id = $1 AND f.user_id = $2 AND ($3::boolean OR f.demo = false)`,
      [req.params.id, req.user.id, req.demoMode]);
    if (!found.rowCount) return res.status(404).json({ error: 'Post not found.' });
    res.json(found.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'This post did not open.' });
  }
});

app.post('/api/posts/:id/read', async (req, res) => {
  try {
    const done = await pool.query(
      `UPDATE posts p SET read_at = $2 FROM feeds f
       WHERE p.id = $1 AND p.feed_id = f.id AND f.user_id = $3 AND p.read_at IS NULL`,
      [req.params.id, req.now, req.user.id]);
    res.json({ ok: true, changed: done.rowCount });
  } catch (err) {
    res.status(500).json({ error: 'The post was not marked read.' });
  }
});

app.get('/api/feeds', async (req, res) => {
  try {
    const out = await pool.query(
      `SELECT ${FEED_COLUMNS} FROM feeds WHERE ${ownFeeds(req.demoMode)} ORDER BY id`,
      [req.user.id]);
    res.json({ feeds: out.rows, demo: req.demoMode });
  } catch (err) {
    res.status(500).json({ error: 'Your feeds did not load.' });
  }
});

app.post('/api/feeds', async (req, res) => {
  try {
    const address = feeds.normalizeAddress(req.body && req.body.url).href;
    const existing = await pool.query(
      'SELECT id FROM feeds WHERE user_id = $1 AND url = $2 AND demo = false',
      [req.user.id, address]);
    if (existing.rowCount) {
      return res.status(409).json({ error: 'You added that feed already.' });
    }
    const parsed = await feeds.fetchFeed(address);
    const inserted = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, last_fetched_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${FEED_COLUMNS}`,
      [req.user.id, address, parsed.title, parsed.siteUrl, req.now]);
    const feed = inserted.rows[0];
    for (const item of parsed.items.slice(0, 50)) {
      await pool.query(
        `INSERT INTO posts (feed_id, guid, title, link, snippet, content_html, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (feed_id, guid) DO NOTHING`,
        [feed.id, item.guid, item.displayTitle || item.title || 'Untitled post',
         item.link, item.snippet, item.contentHtml,
         item.publishedAt ? new Date(item.publishedAt) : null]);
    }
    res.status(201).json({ feed, demo: req.demoMode });
  } catch (err) {
    if (err instanceof feeds.GuardError) {
      return res.status(400).json({ error: err.message });
    }
    console.warn('feed add failed: ' + err.message);
    res.status(500).json({ error: 'The feed could not be added. Try again.' });
  }
});

app.delete('/api/feeds/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM feeds WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'The feed could not be removed.' });
  }
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

// Shut down cleanly: stop accepting, let running requests finish, close the
// database pool. The platform stops containers with SIGTERM.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: draining before exit`);
  server.close();
  setTimeout(() => pool.end().finally(() => process.exit(0)), 3000)
    .unref();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

let server;
async function start() {
  await ensureSchema();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
