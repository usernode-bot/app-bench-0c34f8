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
    // Reading the list anonymously is safe: it holds only per-person data,
    // and the route answers the signed-out view (an empty list) when no
    // token is carried. The staging demo's one-post read shows seeded fake
    // data, view-only, so the preview works wherever it is opened.
    // Everything writable stays behind authentication.
    if (req.method === 'GET' && req.path === '/api/posts') return next();
    if (IS_STAGING && req.method === 'GET' && req.query.demo === '1' &&
        /^\/api\/posts\/\d+$/.test(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  return res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// The reader's API: feeds and posts, scoped to the signed-in person.
// Mounted before the catch-all below, which would otherwise swallow /api/*.
require('./routes/feeds').register(app, pool, { IS_STAGING });

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

// ── Schema ────────────────────────────────────────────────────────────────
// Feeds and posts are personal data: subscriptions and reading state belong
// to one person, so both tables are marked 'staging:private' and staging
// copies carry schema only — they are seeded below. Every statement is
// idempotent, so booting against an existing database is a no-op.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      feed_url text NOT NULL,
      title text NOT NULL,
      site_url text,
      fetched_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS posts (
      id serial PRIMARY KEY,
      feed_id int NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      guid text NOT NULL,
      title text NOT NULL,
      link text,
      summary text,
      published_at timestamptz NOT NULL,
      read boolean NOT NULL DEFAULT false,
      fetched_at timestamptz NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_feed_url_idx
      ON feeds (user_id, feed_url);
    CREATE UNIQUE INDEX IF NOT EXISTS posts_feed_guid_idx
      ON posts (feed_id, guid);
    CREATE INDEX IF NOT EXISTS posts_user_read_published_idx
      ON posts (user_id, read, published_at DESC);
    COMMENT ON TABLE feeds IS 'staging:private';
    COMMENT ON TABLE posts IS 'staging:private';
  `);
}

// ── Staging seed ──────────────────────────────────────────────────────────
// Three obviously fake demo feeds owned by a fake user (never a visitor),
// so the populated list can be seen at /?demo=1 in the staging preview.
// Fixed ids and guids plus ON CONFLICT DO NOTHING keep re-booting
// idempotent. The demo user's feeds are never refreshed: refresh only
// touches the caller's own feeds.
const DEMO_USER_ID = 'staging-demo-user';

const DEMO_FEEDS = [
  { id: 900001, title: 'Staging demo: Garden notes',
    url: 'https://staging-demo.invalid/garden-notes/feed.xml',
    site: 'https://staging-demo.invalid/garden-notes' },
  { id: 900002, title: 'Staging demo: Bike workshop',
    url: 'https://staging-demo.invalid/bike-workshop/feed.xml',
    site: 'https://staging-demo.invalid/bike-workshop' },
  { id: 900003, title: 'Staging demo: City library',
    url: 'https://staging-demo.invalid/city-library/feed.xml',
    site: 'https://staging-demo.invalid/city-library' },
];

const DEMO_POSTS = [
  { feedId: 900001, guid: 'staging-demo-garden-1',
    title: 'Planting garlic before the first frost',
    link: 'https://staging-demo.invalid/garden-notes/planting-garlic',
    publishedAt: '2026-10-07T11:45:00Z',
    summary: 'Garlic wants a few cold weeks in the ground before it starts to grow, so the best time to plant is about a month before the soil freezes.\n\nBreak the bulb into cloves the day you plant, keep the papery skins on, and push each one in pointy end up, about two knuckles deep.\n\nCover the bed with straw once the first frost arrives and leave it alone until spring.' },
  { feedId: 900002, guid: 'staging-demo-bike-1',
    title: 'Truing a wheel at home with two zip ties',
    link: 'https://staging-demo.invalid/bike-workshop/truing-a-wheel',
    publishedAt: '2026-10-07T08:40:00Z',
    summary: 'A wheel that wobbles a little can be trued without a stand. Zip two ties to the fork or the frame so the ends sit close to the rim, one on each side.\n\nSpin the wheel and watch where it touches. Where the rim moves toward a tie, loosen the spokes on that side a quarter turn at a time.\n\nSmall moves. If a spoke nipple starts to resist, stop and leave the wheel for another day.' },
  { feedId: 900003, guid: 'staging-demo-library-1',
    title: 'New reading room hours from next week',
    link: 'https://staging-demo.invalid/city-library/reading-room-hours',
    publishedAt: '2026-10-06T10:00:00Z',
    summary: 'From next Monday the reading room opens an hour earlier, at eight in the morning, and closes at nine in the evening on weekdays.\n\nWeekend hours stay the same. The silent study room keeps its own schedule, posted at the door.' },
  { feedId: 900001, guid: 'staging-demo-garden-2',
    title: 'Saving tomato seeds for next spring',
    link: 'https://staging-demo.invalid/garden-notes/saving-tomato-seeds',
    publishedAt: '2026-10-04T09:00:00Z',
    summary: 'Choose seeds from your healthiest plant, not just your best-looking fruit. Scoop the seeds into a jar of water and leave them on a windowsill for three days.\n\nThe good seeds sink; the pulp and the duds float. Rinse, dry on a plate for a week, and store them in a paper envelope somewhere cool.' },
  { feedId: 900002, guid: 'staging-demo-bike-2',
    title: 'What tyre pressure to run in winter',
    link: 'https://staging-demo.invalid/bike-workshop/winter-tyre-pressure',
    publishedAt: '2026-10-03T12:00:00Z',
    summary: 'Cold mornings lower the gauge reading, so check pressure outside rather than in a warm hallway. A few psi less than your summer number buys grip on wet roads.\n\nDo not go so low that the tyre squirms in corners. If you can flatten the sidewall with your thumb, there is not enough air in it.' },
  { feedId: 900003, guid: 'staging-demo-library-2',
    title: 'The autumn programme of evening talks',
    link: 'https://staging-demo.invalid/city-library/autumn-talks',
    publishedAt: '2026-10-05T14:30:00Z',
    summary: 'The autumn programme of evening talks starts this month. This year the themes are local history, night-sky watching and the city’s old shopfronts.\n\nTalks are free, and seats can be reserved at the front desk from the Monday of each week.' },
  { feedId: 900001, guid: 'staging-demo-garden-3',
    title: 'Compost that never smells',
    link: 'https://staging-demo.invalid/garden-notes/compost-that-never-smells',
    publishedAt: '2026-10-02T15:00:00Z',
    summary: 'A smelly heap has too many soft green scraps and not enough dry material. Keep a bag of dead leaves, torn cardboard or straw next to the bin.\n\nEvery bucket of peelings gets a layer of the dry stuff on top. Turn the heap when you remember, not on a schedule, and it will smell of nothing but rain.' },
  { feedId: 900002, guid: 'staging-demo-bike-3',
    title: 'Fixing a puncture by the roadside',
    link: 'https://staging-demo.invalid/bike-workshop/roadside-puncture',
    publishedAt: '2026-10-01T17:20:00Z',
    summary: 'Keep the wheel on the bike while you find the hole: spin it and listen, or hold it close to your cheek and feel for the escaping air.\n\nThen take the wheel off, ease one bead from the rim with your thumbs only, and check the inside of the tyre with a finger before fitting the new tube. Whatever punctured the tube is usually still stuck in the rubber.' },
  { feedId: 900001, guid: 'staging-demo-garden-4',
    title: 'When to bring the lemon tree indoors',
    link: 'https://staging-demo.invalid/garden-notes/lemon-tree-indoors',
    publishedAt: '2026-10-01T08:30:00Z',
    summary: 'Citrus sulk at anything near freezing, so the tree moves indoors before the first cold night, not after it.\n\nGive it your brightest window, water it less than you did outside, and expect a few leaves to drop while it adjusts. It is sulking, not dying.' },
];

async function seedStagingDemo() {
  for (const feed of DEMO_FEEDS) {
    await pool.query(
      `INSERT INTO feeds (id, user_id, feed_url, title, site_url, fetched_at, created_at)
       VALUES ($1, $2, $3, $4, $5, '2026-10-07T09:00:00Z', now())
       ON CONFLICT (id) DO NOTHING`,
      [feed.id, DEMO_USER_ID, feed.url, feed.title, feed.site]);
  }
  for (const post of DEMO_POSTS) {
    await pool.query(
      `INSERT INTO posts (feed_id, user_id, guid, title, link, summary,
                          published_at, read, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, false, '2026-10-07T09:00:00Z')
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [post.feedId, DEMO_USER_ID, post.guid, post.title, post.link,
       post.summary, post.publishedAt]);
  }
}

// ── Start and shutdown ────────────────────────────────────────────────────
let shuttingDown = false;

async function start() {
  await ensureSchema();
  if (IS_STAGING) {
    try {
      await seedStagingDemo();
    } catch (err) {
      // Seed data is a preview convenience, not a service: boot anyway.
      console.warn('staging seed skipped: ' + err.message);
    }
  }
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutting down: draining connections');
    // /health answers 503 while this runs, so the load balancer stops
    // sending new requests before the process goes away.
    const drainTimer = setTimeout(() => {
      try { server.closeAllConnections?.(); } catch { /* already gone */ }
    }, 3000);
    server.close(() => {
      clearTimeout(drainTimer);
      pool.end().catch(() => {}).finally(() => process.exit(0));
    });
    // Belt and braces: the drain above can hang on a stuck socket.
    setTimeout(() => process.exit(0), 4000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
