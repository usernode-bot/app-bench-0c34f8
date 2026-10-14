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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── The app's own routes ──────────────────────────────────────────────────
// Each person's feeds are private to them: every query filters on
// user_id = req.user.id. Both tables are staging:private (see ensureSchema).

const { safeFetch, parseFeed } = require('./lib/feeds');
const { demoFeeds, demoItems } = require('./lib/demo');

// The schema, created idempotently on boot.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      url text NOT NULL,
      title text NOT NULL DEFAULT '',
      site_url text,
      demo boolean NOT NULL DEFAULT false,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url_idx ON feeds (user_id, url);
    CREATE TABLE IF NOT EXISTS read_marks (
      feed_id integer NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
      guid text NOT NULL,
      read_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (feed_id, guid)
    );
  `);
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE read_marks IS 'staging:private'`);
}

// Demo seeding: staging only, and only when the viewer opened the app with
// ?demo=1. Writes the four made-up feeds once (ON CONFLICT DO NOTHING), so
// tapping, removing and marking read work on real rows. The demo flag keeps
// them out of every response without ?demo=1, so the plain app still shows
// its real empty state.
async function seedDemoFeeds(userId) {
  // Seed once per viewer: the seeds are real rows, so a feed the viewer
  // removed stays removed on the next demo visit (and a viewer who
  // removed all four has opted out of the demo).
  const { rows: have } = await pool.query(
    `SELECT 1 FROM feeds WHERE user_id = $1 AND demo = true LIMIT 1`, [userId]);
  if (have.length) return;
  const values = demoFeeds();
  await pool.query(
    `INSERT INTO feeds (user_id, url, title, site_url, demo)
     SELECT $1, f.url, f.title, f.site_url, true
     FROM unnest($2::text[], $3::text[], $4::text[]) AS f(url, title, site_url)
     ON CONFLICT (user_id, url) DO NOTHING`,
    [userId, values.map((f) => f.url), values.map((f) => f.title), values.map((f) => f.siteUrl)]
  );
}

const MAX_FEEDS = 50;

// GET /api/posts: the viewer's unread posts, newest first. Each feed is
// fetched in parallel; a feed that fails does not fail the response, it
// becomes feeds[i].error (and feeds.last_error) and shows as a line under
// the header. Demo feeds (with ?demo=1) are served from lib/demo.js with no
// network touched. A guest gets { feeds: [], posts: [] }.
app.get('/api/posts', async (req, res) => {
  if (!req.user) return res.json({ feeds: [], posts: [], demo: req.query.demo === '1' });
  const wantDemo = req.query.demo === '1';
  try {
    if (wantDemo && IS_STAGING) await seedDemoFeeds(req.user.id);
    const { rows: feedRows } = await pool.query(
      wantDemo
        ? `SELECT id, url, title, site_url, demo, last_error FROM feeds WHERE user_id = $1 ORDER BY created_at, id`
        : `SELECT id, url, title, site_url, demo, last_error FROM feeds WHERE user_id = $1 AND demo = false ORDER BY created_at, id`,
      [req.user.id]
    );
    const feeds = [];
    const postLists = await Promise.all(feedRows.map(async (row) => {
      const feed = { id: row.id, title: row.title, url: row.url, error: null };
      feeds.push(feed);
      try {
        let items;
        if (row.demo) {
          if (!IS_STAGING) return [];
          items = demoItems(row.url, req.now);
        } else {
          const xml = await safeFetch(row.url);
          items = parseFeed(xml).items;
        }
        const { rows: read } = await pool.query(
          `SELECT guid FROM read_marks WHERE feed_id = $1`, [row.id]);
        const readSet = new Set(read.map((r) => r.guid));
        // The feed came back fine: drop any stale failure note.
        if (row.last_error) {
          pool.query(`UPDATE feeds SET last_error = NULL WHERE id = $1 AND last_error IS NOT NULL`, [row.id])
            .catch((e) => console.warn('last_error clear failed: ' + e.message));
        }
        return items
          .filter((it) => !readSet.has(it.guid))
          .map((it) => ({
            feedId: row.id,
            feedTitle: row.title || hostOf(row.url),
            guid: it.guid,
            title: it.title,
            link: it.link,
            publishedAt: it.publishedAt,
            excerpt: it.excerpt,
            preview: it.preview,
          }));
      } catch (err) {
        feed.error = err && err.message ? String(err.message) : 'The feed did not load.';
        // Keep last_error as the most recent failure note for this feed.
        pool.query(`UPDATE feeds SET last_error = $2 WHERE id = $1`, [row.id, feed.error])
          .catch((e) => console.warn('last_error update failed: ' + e.message));
        return [];
      }
    }));
    // Sort the merged list newest first; a post with no date sorts last.
    const posts = [].concat(...postLists).sort((a, b) => {
      const ta = a.publishedAt ? Date.parse(a.publishedAt) : -Infinity;
      const tb = b.publishedAt ? Date.parse(b.publishedAt) : -Infinity;
      return tb - ta;
    });
    res.json({ feeds, posts, demo: wantDemo });
  } catch (err) {
    console.error('GET /api/posts failed: ' + (err.stack || err));
    res.status(500).json({ error: 'Your posts did not load. Your feeds are saved.' });
  }
});

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// POST /api/feeds { url }: validate that the address really serves an RSS or
// Atom feed, then save it. 201 { feed }, or 400 with a message fit to show.
app.post('/api/feeds', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const url = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!url) return res.status(400).json({ error: 'Give the address of the feed.' });
  let target;
  try {
    target = new URL(url);
  } catch {
    return res.status(400).json({ error: 'That is not a valid address. Check it and try again.' });
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only http and https addresses work.' });
  }
  const { rows: existing } = await pool.query(
    `SELECT id FROM feeds WHERE user_id = $1 AND url = $2`, [req.user.id, target.href]);
  if (existing.length) return res.status(400).json({ error: 'You already follow this feed.' });
  const { rows: countRows } = await pool.query(
    `SELECT count(*)::int AS n FROM feeds WHERE user_id = $1 AND demo = false`, [req.user.id]);
  if (countRows[0].n >= MAX_FEEDS) {
    return res.status(400).json({ error: `You follow the most feeds this version allows (${MAX_FEEDS}).` });
  }
  let parsed;
  try {
    parsed = parseFeed(await safeFetch(target.href));
  } catch (err) {
    const message = err && err.message ? String(err.message) : 'That address is not an RSS or Atom feed.';
    return res.status(400).json({ error: message === 'That address is not an RSS or Atom feed.' ? message : `Could not read that feed: ${message}` });
  }
  const title = parsed.title || target.hostname;
  const { rows } = await pool.query(
    `INSERT INTO feeds (user_id, url, title, site_url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, url) DO UPDATE SET title = EXCLUDED.title, site_url = EXCLUDED.site_url, last_error = NULL
     RETURNING id, url, title, site_url`,
    [req.user.id, target.href, title, parsed.siteUrl || null]);
  res.status(201).json({ feed: rows[0] });
});

// DELETE /api/feeds/:id: the viewer's own feed only; its read marks go with
// it (ON DELETE CASCADE).
app.delete('/api/feeds/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'That feed does not exist.' });
  const { rows } = await pool.query(
    `DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id`, [id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'That feed does not exist.' });
  res.json({ ok: true });
});

// POST /api/read { feedId, guid }: one read mark, for the viewer's own feed.
// Idempotent: marking again is fine.
app.post('/api/read', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const feedId = Number(req.body && req.body.feedId);
  const guid = req.body && typeof req.body.guid === 'string' ? req.body.guid.slice(0, 500) : '';
  if (!Number.isInteger(feedId) || feedId <= 0 || !guid) {
    return res.status(400).json({ error: 'That read mark is missing its post.' });
  }
  const { rows } = await pool.query(
    `SELECT id FROM feeds WHERE id = $1 AND user_id = $2`, [feedId, req.user.id]);
  if (!rows.length) return res.status(403).json({ error: 'That feed is not one of yours.' });
  await pool.query(
    `INSERT INTO read_marks (feed_id, guid, read_at) VALUES ($1, $2, $3)
     ON CONFLICT (feed_id, guid) DO NOTHING`,
    [feedId, guid, req.now]);
  res.json({ ok: true });
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
  await ensureSchema();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // Stop cleanly: stop taking connections, drain briefly, close the pool.
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    server.close(() => {
      pool.end().then(() => process.exit(0), () => process.exit(0));
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
