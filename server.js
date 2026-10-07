const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const Parser = require('rss-parser');

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

// Set by the shutdown handler at the bottom; /health reports it so anything
// polling readiness sees the container leaving rotation.
let shuttingDown = false;

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting-down' });
  res.json({ status: 'ok' });
});

// ── RSS Reader data model ─────────────────────────────────────────────────
// A person's subscriptions and reading history are personal, so both tables
// are marked `staging:private`: staging copies their schema, never their
// rows. Schema is applied idempotently on boot (see `migrate`).
//
// Read state lives on the post row itself (`read_at`): posts are per-user,
// so no separate read table. The dedup key for refreshes is
// (user_id, feed_id, guid); a post's guid falls back to its URL, then to a
// hash of its title, for feeds that ship neither.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      username text,
      url text NOT NULL,
      title text NOT NULL,
      site_url text,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url_idx ON feeds (user_id, url)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id serial PRIMARY KEY,
      feed_id integer NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      user_id text NOT NULL,
      guid text NOT NULL,
      url text,
      title text,
      summary text,
      published_at timestamptz,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`COMMENT ON TABLE posts IS 'staging:private'`);
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS posts_user_feed_guid_idx ON posts (user_id, feed_id, guid)`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS posts_user_read_idx ON posts (user_id, read_at)`);
}

// ── Feed fetching and parsing ─────────────────────────────────────────────
// The browser never fetches a feed itself: feeds are fetched and parsed
// here, server-side, with a timeout and a response cap so a slow or huge
// upstream cannot hang requests.
const FEED_TIMEOUT_MS = 10_000;
const FEED_MAX_BYTES = 5 * 1024 * 1024;

// Paste a feed address or just a site's address. Normalise to one canonical
// form per feed so adding the same feed twice lands on the same row:
// default to https, drop the fragment, drop a trailing slash on the path.
function normalizeFeedUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.href;
}

async function fetchWithLimit(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    headers: { 'user-agent': 'RSS Reader (Homeroom app)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html' },
    redirect: 'follow',
  });
  if (!res.ok) { const err = new Error('HTTP ' + res.status); err.code = 'unreachable'; throw err; }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > FEED_MAX_BYTES) {
      reader.cancel();
      const err = new Error('Response larger than 5 MB'); err.code = 'unparseable'; throw err;
    }
    chunks.push(Buffer.from(value));
  }
  return { text: Buffer.concat(chunks).toString('utf8'), finalUrl: res.url || url };
}

// A site URL without a feed at it: scan the HTML for the standard
// <link rel="alternate" type="application/rss+xml"> discovery tag.
function findFeedLinkInHtml(html, baseUrl) {
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/\brel\s*=\s*["']?[^"'>\s]*alternate/i.test(tag)) continue;
    if (!/\btype\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']*)["']/i);
    if (!href) continue;
    try { return new URL(href[1], baseUrl).href; } catch { /* a broken href is not ours to fix */ }
  }
  return null;
}

function looksLikeXml(text) {
  return /^\s*(?:<\?xml|<rss|<feed|<rdf)/i.test(text);
}

// Fetch `url` as a feed; if it turns out to be an HTML page, follow its
// discovery link. Throws with a `code` of 'unreachable' (no answer),
// 'no_feed' (an HTML page with no feed link) or 'unparseable'.
async function fetchFeed(url) {
  let { text, finalUrl } = await fetchWithLimit(url);
  if (!looksLikeXml(text)) {
    if (!/<html|<!doctype html/i.test(text)) { const err = new Error('Not XML'); err.code = 'unparseable'; throw err; }
    const discovered = findFeedLinkInHtml(text, finalUrl);
    if (!discovered) { const err = new Error('No feed link on page'); err.code = 'no_feed'; throw err; }
    ({ text } = await fetchWithLimit(discovered));
    if (!looksLikeXml(text)) { const err = new Error('Discovered link is not a feed'); err.code = 'unparseable'; throw err; }
  }
  try {
    const parser = new Parser({ timeout: FEED_TIMEOUT_MS });
    const parsed = await parser.parseString(text);
    if (!parsed || !Array.isArray(parsed.items)) { const err = new Error('Feed has no items'); err.code = 'unparseable'; throw err; }
    return { parsed };
  } catch (err) {
    if (err.code) throw err;
    const wrapped = new Error('Feed could not be parsed'); wrapped.code = 'unparseable'; throw wrapped;
  }
}

function fetchErrorMessage(err) {
  if (err && err.code === 'no_feed') return 'We reached the site but found no feed there. Try pasting the feed address itself.';
  if (err && err.code === 'unparseable') return 'That address does not look like a feed we can read.';
  return 'We could not reach that feed. Check the address and try again.';
}

// Feed content is untrusted: strip tags and cap the summary.
function summarize(item) {
  const raw = String(item.contentSnippet || item.summary || item.content || '');
  const text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim();
  if (text.length <= 300) return text;
  return text.slice(0, 300).replace(/\s+\S*$/, '') + '…';
}

function guidFor(item, url) {
  if (item.guid && String(item.guid).trim()) return String(item.guid).trim();
  if (url) return url;
  return 'hash:' + crypto.createHash('sha1').update(String(item.title || '')).digest('hex').slice(0, 20);
}

async function upsertPosts(feedId, userId, items) {
  for (const item of items.slice(0, 50)) {
    const url = item.link && /^https?:\/\//i.test(item.link) ? item.link : null;
    let publishedAt = item.isoDate ? new Date(item.isoDate) : (item.pubDate ? new Date(item.pubDate) : null);
    if (!publishedAt || isNaN(publishedAt.getTime())) publishedAt = null;
    await pool.query(
      `INSERT INTO posts (feed_id, user_id, guid, url, title, summary, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, feed_id, guid) DO NOTHING`,
      [feedId, userId, guidFor(item, url), url,
        (item.title || 'Untitled post').trim().slice(0, 300) || 'Untitled post',
        summarize(item), publishedAt]);
  }
}

// Refetch one feed and record how it went in `last_error` (the one-line
// note the list shows). A failing feed never fails the request.
async function refreshFeed(feed) {
  try {
    const { parsed } = await fetchFeed(feed.url);
    await upsertPosts(feed.id, feed.user_id, parsed.items);
    if (feed.last_error) {
      await pool.query('UPDATE feeds SET last_error = NULL WHERE id = $1', [feed.id]);
    }
    return null;
  } catch (err) {
    const message = fetchErrorMessage(err);
    await pool.query('UPDATE feeds SET last_error = $2 WHERE id = $1', [feed.id, message]);
    return { title: feed.title, message };
  }
}

// ── Staging demo data ─────────────────────────────────────────────────────
// Behind `?demo=1` on a staging build only, seed two obviously fake feeds
// and five unread posts for the viewing user, so the populated screen can
// be seen without real feeds. Idempotent; boot-time seeding inserts
// nothing, so the unseeded route shows the real empty state.
const DEMO_FEEDS = [
  {
    url: 'https://staging-demo.slowweb.example/feed',
    title: 'Staging Demo: The Slow Web',
    siteUrl: 'https://staging-demo.slowweb.example',
    posts: [
      { title: 'Staging demo: A calmer way to follow the web', ageMinutes: 120,
        summary: 'Why plain feeds are quietly coming back, what a good reader should do, and a short reading list to start from.' },
      { title: 'Staging demo: Reading more by carrying less', ageMinutes: 2 * 24 * 60,
        summary: 'A pocket notebook, a two-page essay, and the surprising payoff of finishing one short thing a day.' },
      { title: 'Staging demo: The case for the personal homepage', ageMinutes: 3 * 24 * 60,
        summary: 'Own a little corner of the web, post when you like, and let the aggregator take care of the rest.' },
    ],
  },
  {
    url: 'https://staging-demo.kitchennotes.example/rss',
    title: 'Staging Demo: Kitchen Notes',
    siteUrl: 'https://staging-demo.kitchennotes.example',
    posts: [
      { title: 'Staging demo: Choosing a kettle that lasts', ageMinutes: 5 * 60,
        summary: 'What to look for: a replaceable element, a lid that opens fully, and why the priciest is rarely the longest-lived.' },
      { title: 'Staging demo: A week of 20-minute dinners', ageMinutes: 26 * 60,
        summary: 'Five dinners for busy evenings, each with a short list of ingredients you probably already have.' },
    ],
  },
];

// Demo feeds carry a reserved host so a real refresh never tries to fetch
// them. Only staging sees them.
function isDemoFeedUrl(url) { return /^https:\/\/staging-demo\./.test(url || ''); }

async function seedDemoData(req) {
  if (!IS_STAGING || req.query.demo !== '1' || !req.user) return;
  const userId = req.user.id;
  for (const demo of DEMO_FEEDS) {
    let feedId;
    const existing = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [userId, demo.url]);
    if (existing.rows.length) {
      feedId = existing.rows[0].id;
    } else {
      const inserted = await pool.query(
        `INSERT INTO feeds (user_id, username, url, title, site_url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
        [userId, req.user.username || null, demo.url, demo.title, demo.siteUrl]);
      if (!inserted.rows.length) continue;
      feedId = inserted.rows[0].id;
    }
    for (const [i, post] of demo.posts.entries()) {
      await pool.query(
        `INSERT INTO posts (feed_id, user_id, guid, url, title, summary, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, feed_id, guid) DO NOTHING`,
        [feedId, userId, 'demo:' + post.title,
          demo.siteUrl + '/posts/' + (i + 1), post.title, post.summary,
          new Date(req.now.getTime() - post.ageMinutes * 60_000)]);
    }
  }
}

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── API ───────────────────────────────────────────────────────────────────
// Every query filters by req.user.id, so each person sees only their own
// feeds and posts. Guests (no account) read an empty list; every write
// they attempt is answered 401 `account_required` by the middleware above.

app.post('/api/feeds', async (req, res) => {
  const url = normalizeFeedUrl(req.body && req.body.url);
  if (!url) {
    return res.status(400).json({ error: 'invalid_url', message: 'Enter a valid feed or site URL.' });
  }
  try {
    const dup = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [req.user.id, url]);
    if (dup.rows.length) {
      return res.status(409).json({ error: 'duplicate', message: 'You already follow this feed.' });
    }
    let parsed;
    try {
      ({ parsed } = await fetchFeed(url));
    } catch (err) {
      return res.status(422).json({ error: err.code || 'unreachable', message: fetchErrorMessage(err) });
    }
    const feedUrl = url;
    let siteUrl = null;
    try { siteUrl = parsed.link ? new URL(parsed.link, feedUrl).href : new URL(feedUrl).origin; } catch { /* keep null */ }
    const title = (String(parsed.title || '').trim() || new URL(feedUrl).hostname).slice(0, 200);
    const inserted = await pool.query(
      `INSERT INTO feeds (user_id, username, url, title, site_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, url) DO NOTHING RETURNING *`,
      [req.user.id, req.user.username || null, feedUrl, title, siteUrl]);
    if (!inserted.rows.length) {
      return res.status(409).json({ error: 'duplicate', message: 'You already follow this feed.' });
    }
    await upsertPosts(inserted.rows[0].id, req.user.id, parsed.items);
    return res.status(201).json({ feed: inserted.rows[0] });
  } catch (err) {
    console.warn('POST /api/feeds failed: ' + err.message);
    return res.status(500).json({ error: 'server_error', message: 'Adding the feed failed. Try again.' });
  }
});

app.get('/api/feeds', async (req, res) => {
  if (!req.user) return res.json({ feeds: [] });
  try {
    await seedDemoData(req);
    const feeds = await pool.query(
      `SELECT id, url, title, site_url, last_error, created_at
       FROM feeds WHERE user_id = $1 ORDER BY created_at, id`, [req.user.id]);
    return res.json({ feeds: feeds.rows });
  } catch (err) {
    console.warn('GET /api/feeds failed: ' + err.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.delete('/api/feeds/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const deleted = await pool.query('DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id', [id, req.user.id]);
    if (!deleted.rows.length) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true });
  } catch (err) {
    console.warn('DELETE /api/feeds failed: ' + err.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Refetch every feed the user has. Per-feed failures are recorded in
// `last_error` and named in the response, never fail the request.
app.post('/api/feeds/refresh', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  try {
    await seedDemoData(req);
    const feeds = (await pool.query('SELECT * FROM feeds WHERE user_id = $1 ORDER BY created_at, id', [req.user.id])).rows;
    const failed = [];
    for (const feed of feeds) {
      if (isDemoFeedUrl(feed.url)) continue; // staging demo feeds are not real URLs
      const failure = await refreshFeed(feed);
      if (failure) failed.push(failure);
    }
    return res.json({ failed });
  } catch (err) {
    console.warn('POST /api/feeds/refresh failed: ' + err.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/api/posts', async (req, res) => {
  if (!req.user) return res.json({ posts: [] });
  try {
    await seedDemoData(req);
    // A post with no pubDate falls back to created_at for ordering.
    const posts = await pool.query(
      `SELECT p.id, p.title, p.summary, p.url, p.published_at, p.created_at,
              f.title AS feed_title
       FROM posts p JOIN feeds f ON f.id = p.feed_id
       WHERE p.user_id = $1 AND p.read_at IS NULL
       ORDER BY COALESCE(p.published_at, p.created_at) DESC
       LIMIT 200`, [req.user.id]);
    return res.json({ posts: posts.rows });
  } catch (err) {
    console.warn('GET /api/posts failed: ' + err.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Idempotent: reading an already-read post leaves `read_at` as it was.
app.post('/api/posts/:id/read', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    await pool.query(
      'UPDATE posts SET read_at = $2 WHERE id = $1 AND user_id = $3 AND read_at IS NULL',
      [id, req.now, req.user.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.warn('POST /api/posts/:id/read failed: ' + err.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/posts/read-all', async (req, res) => {
  try {
    await pool.query('UPDATE posts SET read_at = $2 WHERE user_id = $1 AND read_at IS NULL', [req.user.id, req.now]);
    return res.json({ ok: true });
  } catch (err) {
    console.warn('POST /api/posts/read-all failed: ' + err.message);
    return res.status(500).json({ error: 'server_error' });
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

const DRAIN_MS = 3000;
let server;

async function start() {
  await migrate();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

// Stop accepting connections, drain in-flight requests under a hard
// deadline, close the pool, exit. Idempotent: SIGTERM then SIGINT must not
// double-run.
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, draining`);
  if (server) {
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
  }
  try {
    await pool.end();
  } catch (e) {
    console.error('[shutdown] pool.end failed', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
