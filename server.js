const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const { discoverFeed, refreshFeed } = require('./lib/feeds');
const { SAMPLE_FEED, DEMO_FEEDS } = require('./lib/demo');

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

// Health is checked by the platform's probes: serve 503 once we are leaving
// rotation so pollers see the shutdown rather than a connection reset.
let shuttingDown = false;

app.get('/health', (_req, res) =>
  res.status(shuttingDown ? 503 : 200).json({ status: shuttingDown ? 'shutting-down' : 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
/* ── Data model ──────────────────────────────────────────────────────────
 *
 * Three tables, applied idempotently on boot. What a person follows and
 * reads is theirs alone, so all three are marked 'staging:private' —
 * staging previews copy the schema, never the rows. No public table
 * references them. Read state lives on the post (not a join table) because
 * feeds and posts are already per person.
 */
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      kind text NOT NULL DEFAULT 'rss',
      url text NOT NULL,
      site_url text,
      title text NOT NULL,
      color_index int NOT NULL DEFAULT 1,
      etag text,
      last_modified text,
      last_fetched_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url_idx ON feeds (user_id, url);
    CREATE TABLE IF NOT EXISTS posts (
      id bigserial PRIMARY KEY,
      feed_id int NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid text NOT NULL,
      title text NOT NULL,
      link text,
      author text,
      summary text,
      summary_truncated boolean NOT NULL DEFAULT false,
      published_at timestamptz NOT NULL,
      fetched_at timestamptz NOT NULL,
      read_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS posts_feed_guid_idx ON posts (feed_id, guid);
    CREATE INDEX IF NOT EXISTS posts_feed_read_pub_idx ON posts (feed_id, read_at, published_at DESC);
    CREATE TABLE IF NOT EXISTS demo_seeds (
      user_id text PRIMARY KEY,
      seeded_at timestamptz NOT NULL DEFAULT now()
    );
    COMMENT ON TABLE feeds IS 'staging:private';
    COMMENT ON TABLE posts IS 'staging:private';
    COMMENT ON TABLE demo_seeds IS 'staging:private';
  `);
}

/* The lowest free feed colour (1..8) for this person, cycling once all
 * eight are taken. */
async function pickColorIndex(userId) {
  const rows = await pool.query('SELECT color_index FROM feeds WHERE user_id = $1', [userId]);
  const used = new Set(rows.rows.map((r) => r.color_index));
  for (let i = 1; i <= 8; i++) if (!used.has(i)) return i;
  return (rows.rows.length % 8) + 1;
}

/* ── Sample feed and staging demo ──────────────────────────────────────── */

/* Adds the sample feed for a person. Idempotent on (user_id, url): a
 * second call returns the existing feed and adds nothing. */
async function addSampleFeed(userId, now) {
  const existing = await pool.query(
    'SELECT id, title, color_index FROM feeds WHERE user_id = $1 AND url = $2',
    [userId, SAMPLE_FEED.url]
  );
  if (existing.rowCount) {
    const row = existing.rows[0];
    return { id: row.id, title: row.title, url: SAMPLE_FEED.url, siteUrl: null, colorIndex: row.color_index, newPosts: 0 };
  }
  const colorIndex = await pickColorIndex(userId);
  const ins = await pool.query(
    `INSERT INTO feeds (user_id, kind, url, title, color_index, last_fetched_at)
     VALUES ($1, 'sample', $2, $3, $4, $5) RETURNING id`,
    [userId, SAMPLE_FEED.url, SAMPLE_FEED.title, colorIndex, now]
  );
  const feedId = ins.rows[0].id;
  for (const [i, post] of SAMPLE_FEED.posts.entries()) {
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, author, summary, summary_truncated, published_at, fetched_at, read_at)
       VALUES ($1, $2, $3, NULL, $4, $5, false, $6, $7, NULL)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [
        feedId,
        post.guid,
        post.title,
        SAMPLE_FEED.author,
        post.paragraphs.join('\n\n'),
        new Date(now.getTime() - SAMPLE_FEED.offsetsMinutes[i] * 60000),
        now,
      ]
    );
  }
  return {
    id: feedId,
    title: SAMPLE_FEED.title,
    url: SAMPLE_FEED.url,
    siteUrl: null,
    colorIndex,
    newPosts: SAMPLE_FEED.posts.length,
  };
}

/* Seeds the viewer's own staging demo feeds on their first ?demo=1 request.
 * The demo_seeds row is the one-time gate: a reload changes nothing, and
 * what the viewer did to the demo rows (read, removed) stays. Nothing runs
 * outside staging or without ?demo=1 — the caller checks both. */
async function seedDemoFor(userId, now) {
  const claim = await pool.query(
    'INSERT INTO demo_seeds (user_id, seeded_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id',
    [userId, now]
  );
  if (!claim.rowCount) return;
  for (const demoFeed of DEMO_FEEDS) {
    const ins = await pool.query(
      `INSERT INTO feeds (user_id, kind, url, site_url, title, color_index, last_fetched_at)
       VALUES ($1, 'demo', $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, url) DO NOTHING
       RETURNING id`,
      [userId, 'staging-demo:' + demoFeed.slug, 'https://example.com/', demoFeed.title, demoFeed.colorIndex, now]
    );
    if (!ins.rowCount) continue;
    const feedId = ins.rows[0].id;
    for (const post of demoFeed.posts) {
      await pool.query(
        `INSERT INTO posts (feed_id, guid, title, link, author, summary, summary_truncated, published_at, fetched_at, read_at)
         VALUES ($1, $2, $3, $4, $5, $6, false, $7, $8, NULL)
         ON CONFLICT (feed_id, guid) DO NOTHING`,
        [
          feedId,
          post.guid,
          post.title,
          'https://example.com/',
          demoFeed.author,
          post.paragraphs.join('\n\n'),
          new Date(now.getTime() - post.minutesAgo * 60000),
          now,
        ]
      );
    }
  }
}

/* ── API ─────────────────────────────────────────────────────────────────
 *
 * Every route touches only rows whose feed belongs to req.user. Guests
 * already get 401 'account_required' on writes from the auth middleware;
 * reads answer with an empty guest view. */
function userIdOf(req) {
  return String(req.user.id);
}

function feedRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    siteUrl: row.site_url,
    colorIndex: row.color_index,
    unreadCount: Number(row.unread_count || 0),
    lastError: row.last_error,
    lastFetchedAt: row.last_fetched_at,
  };
}

function postRow(row) {
  return {
    id: Number(row.id),
    feedId: row.feed_id,
    guid: row.guid,
    title: row.title,
    link: row.link,
    author: row.author,
    summary: row.summary,
    summaryTruncated: row.summary_truncated,
    publishedAt: row.published_at,
    readAt: row.read_at,
  };
}

app.get('/api/posts', async (req, res) => {
  try {
    if (!req.user) return res.json({ guest: true, feeds: [], posts: [] });
    const userId = userIdOf(req);
    // Staging's populated demo: seed once per account, only on ?demo=1.
    const demo = IS_STAGING && req.query.demo === '1';
    if (demo) {
      try {
        await seedDemoFor(userId, req.now);
      } catch (err) {
        console.warn('demo seed failed: ' + err.message);
      }
    }
    // Demo feeds exist only for the ?demo=1 staging view; the plain route
    // never shows them, so it stays production-shaped.
    const demoFilter = demo ? '' : "AND f.kind <> 'demo'";
    const feedsQ = await pool.query(
      `SELECT f.id, f.kind, f.title, f.url, f.site_url, f.color_index, f.last_error, f.last_fetched_at,
              (SELECT count(*) FROM posts p WHERE p.feed_id = f.id AND p.read_at IS NULL)::int AS unread_count
       FROM feeds f
       WHERE f.user_id = $1 ${demoFilter}
       ORDER BY f.created_at, f.id`,
      [userId]
    );
    const postsQ = await pool.query(
      `SELECT p.id, p.feed_id, p.guid, p.title, p.link, p.author, p.summary, p.summary_truncated, p.published_at, p.read_at
       FROM posts p JOIN feeds f ON f.id = p.feed_id
       WHERE f.user_id = $1 AND p.read_at IS NULL ${demoFilter}
       ORDER BY p.published_at DESC, p.id DESC
       LIMIT 501`,
      [userId]
    );
    const truncated = postsQ.rows.length > 500;
    res.json({
      feeds: feedsQ.rows.map(feedRow),
      posts: postsQ.rows.slice(0, 500).map(postRow),
      truncated,
    });
  } catch (err) {
    console.error('GET /api/posts failed: ' + err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/feeds', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const raw = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
    // Accept a feed address or a bare site address; anything else is not a
    // web address.
    let candidate = raw;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = 'https://' + candidate;
    let url = null;
    try {
      const parsed = new URL(candidate);
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.hostname &&
        (!parsed.port || parsed.port === '80' || parsed.port === '443')
      ) {
        url = parsed.toString();
      }
    } catch {}
    if (!url) return res.status(400).json({ error: 'invalid_url' });

    const countQ = await pool.query(
      "SELECT count(*)::int AS n FROM feeds WHERE user_id = $1 AND kind <> 'demo'",
      [userId]
    );
    if (countQ.rows[0].n >= 100) return res.status(409).json({ error: 'too_many_feeds' });

    const dup = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [userId, url]);
    if (dup.rowCount) return res.status(409).json({ error: 'already_following' });

    let discovered;
    try {
      discovered = await discoverFeed(url);
    } catch (err) {
      const code = err && err.code;
      if (code === 'invalid_url') return res.status(400).json({ error: 'invalid_url' });
      if (code === 'unreachable' || code === 'too_large') return res.status(502).json({ error: 'unreachable' });
      return res.status(422).json({ error: 'no_feed_found' });
    }

    // The stored URL is the final feed URL after discovery and redirects, so
    // a second address that lands on the same feed is caught here too.
    const dupFinal = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [userId, discovered.url]);
    if (dupFinal.rowCount) return res.status(409).json({ error: 'already_following' });

    const colorIndex = await pickColorIndex(userId);
    const ins = await pool.query(
      `INSERT INTO feeds (user_id, kind, url, site_url, title, color_index, last_fetched_at)
       VALUES ($1, 'rss', $2, $3, $4, $5, $6)
       RETURNING id, title, url, site_url, color_index`,
      [userId, discovered.url, discovered.siteUrl, discovered.title, colorIndex, req.now]
    );
    const feedRowDb = ins.rows[0];

    // Bring the newest 50 items in: the 10 newest unread, the rest already
    // read, so a long archive does not flood the list.
    const items = [...discovered.items]
      .sort((a, b) => b.published - a.published)
      .slice(0, 50);
    let newPosts = 0;
    for (const [i, item] of items.entries()) {
      const readAt = i < 10 ? null : req.now;
      await pool.query(
        `INSERT INTO posts (feed_id, guid, title, link, author, summary, summary_truncated, published_at, fetched_at, read_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (feed_id, guid) DO NOTHING`,
        [feedRowDb.id, item.guid, item.title, item.link, item.author, item.summary, item.summaryTruncated, item.published, req.now, readAt]
      );
      if (!readAt) newPosts++;
    }

    res.status(201).json({
      feed: {
        id: feedRowDb.id,
        kind: 'rss',
        title: feedRowDb.title,
        url: feedRowDb.url,
        siteUrl: feedRowDb.site_url,
        colorIndex: feedRowDb.color_index,
        unreadCount: newPosts,
        lastError: null,
        lastFetchedAt: req.now,
      },
      newPosts,
    });
  } catch (err) {
    console.error('POST /api/feeds failed: ' + err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/feeds/sample', async (req, res) => {
  try {
    const feed = await addSampleFeed(userIdOf(req), req.now);
    res.status(201).json({ feed, newPosts: feed.newPosts });
  } catch (err) {
    console.error('POST /api/feeds/sample failed: ' + err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/feeds/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'invalid_url' });
    const result = await pool.query('DELETE FROM feeds WHERE id = $1 AND user_id = $2', [id, userIdOf(req)]);
    res.json({ deleted: result.rowCount });
  } catch (err) {
    console.error('DELETE /api/feeds/:id failed: ' + err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const force = !!(req.body && req.body.force);
    // Demo and sample feeds never fetch: their posts are stored, not syndicated.
    const selection = force
      ? "kind = 'rss'"
      : "kind = 'rss' AND (last_fetched_at IS NULL OR last_fetched_at < $2)";
    const cutoff = new Date(req.now.getTime() - 10 * 60 * 1000);
    const feedsQ = await pool.query(
      `SELECT id, url, title, etag, last_modified FROM feeds WHERE user_id = $1 AND ${selection}`,
      force ? [userId] : [userId, cutoff]
    );
    const feeds = feedsQ.rows;
    let checked = 0;
    let newPosts = 0;
    const failed = [];
    let index = 0;
    const runNext = async () => {
      while (index < feeds.length) {
        const feed = feeds[index++];
        try {
          const result = await refreshFeed(pool, feed, req.now);
          checked++;
          newPosts += result.newPosts;
        } catch {
          failed.push(feed.id);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, feeds.length) }, runNext));
    res.json({ checked, newPosts, failed });
  } catch (err) {
    console.error('POST /api/refresh failed: ' + err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/posts/read', async (req, res) => {
  try {
    const userId = userIdOf(req);
    const ids = Array.isArray(req.body && req.body.ids)
      ? req.body.ids.map(Number).filter(Number.isSafeInteger).slice(0, 500)
      : [];
    if (!ids.length) return res.json({ updated: 0 });
    const read = !req.body || req.body.read !== false;
    const readAt = read ? req.now : null;
    // The ownership filter is the WHERE, not the app: a post id this user
    // does not own is silently left alone.
    const result = await pool.query(
      `UPDATE posts SET read_at = $2
       WHERE id = ANY($1::bigint[]) AND feed_id IN (SELECT id FROM feeds WHERE user_id = $3)`,
      [ids, readAt, userId]
    );
    res.json({ updated: result.rowCount });
  } catch (err) {
    console.error('POST /api/posts/read failed: ' + err.message);
    res.status(500).json({ error: 'server_error' });
  }
});

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

  const DRAIN_MS = 3000;
  const shutdown = async (signal) => {
    if (shuttingDown) return; // SIGTERM then SIGINT must not double-run
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining`);
    server.close(() => {}); // stop accepting new connections
    if (server.closeIdleConnections) server.closeIdleConnections();
    const forceClose = setTimeout(() => {
      if (server.closeAllConnections) server.closeAllConnections();
    }, DRAIN_MS);
    forceClose.unref();
    try {
      await pool.end();
    } catch (err) {
      console.error('[shutdown] pool.end failed: ' + err.message);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
