const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');

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

/* ── Data ──────────────────────────────────────────────────────────────
 * Both tables are `staging:private`: each person's feeds, read state and
 * saved posts are theirs alone and never copied to staging previews.
 */
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      site_url TEXT,
      color INT NOT NULL DEFAULT 1 CHECK (color BETWEEN 1 AND 8),
      is_demo BOOLEAN NOT NULL DEFAULT false,
      last_fetched_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, url)
    )`);
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      feed_id BIGINT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT,
      excerpt TEXT,
      published_at TIMESTAMPTZ NOT NULL,
      read_at TIMESTAMPTZ,
      saved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (feed_id, guid)
    )`);
  await pool.query(`COMMENT ON TABLE posts IS 'staging:private'`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS posts_feed_published_idx ON posts (feed_id, published_at DESC)`);
}

/* ── Guarded feed fetching ─────────────────────────────────────────────
 * Every fetched address is http(s) only; DNS is resolved first and any
 * loopback, private, link-local, CGNAT or metadata address is refused,
 * then the connection is made to the address that was checked. Redirects
 * are followed at most 3 times, each re-checked the same way. 10 s
 * timeout, 2 MB body limit, and nothing but XML is ever parsed.
 */
class FeedError extends Error {}

function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
    if (a === 169 && b === 254) return true;            // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;              // 192.0.0.0/24
    return false;
  }
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIp(mapped[1]);
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const first = parseInt((v6.split(':')[0] || '0'), 16);
  if (Number.isNaN(first)) return true;
  if ((first & 0xfe00) === 0xfc00) return true;         // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true;         // link-local fe80::/10
  if (first === 0x2001 && /^2001:db8:/i.test(v6)) return true;
  return false;
}

async function resolveChecked(hostname) {
  let addrs;
  try {
    addrs = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new FeedError('That address could not be found.');
  }
  for (const a of addrs) if (!isBlockedIp(a.address)) return a.address;
  throw new FeedError('That address points at a private network, so it was not fetched.');
}

async function guardedFetchText(urlStr, redirects = 0) {
  let u;
  try { u = new URL(urlStr); } catch { throw new FeedError('That address is not a valid URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new FeedError('Only http and https addresses can be fetched.');
  }
  const ip = await resolveChecked(u.hostname);
  const mod = u.protocol === 'https:' ? https : http;
  return await new Promise((resolve, reject) => {
    const lookup = (_host, _opts, cb) => cb(null, ip, net.isIPv4(ip) ? 4 : 6);
    const req = mod.request(u, {
      lookup,
      servername: u.hostname,
      timeout: 10000,
      headers: {
        'User-Agent': 'RSSReader/1.0 (Homeroom)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const loc = res.headers.location;
        if (!loc) return reject(new FeedError('That address did not answer with a feed.'));
        if (redirects >= 3) return reject(new FeedError('That address redirected too many times.'));
        let next;
        try { next = new URL(loc, u).toString(); } catch { return reject(new FeedError('That address redirected to an invalid URL.')); }
        return resolve(guardedFetchText(next, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new FeedError('That address answered with HTTP ' + res.statusCode + ', not a feed.'));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 2 * 1024 * 1024) {
          req.destroy();
          reject(new FeedError('That feed is larger than 2 MB.'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => reject(new FeedError('The feed could not be read.')));
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new FeedError('That address took too long to answer.'));
    });
    req.on('error', () => reject(new FeedError('That address could not be reached.')));
    req.end();
  });
}

/* ── Feed parsing (RSS 2.0 or Atom) ──────────────────────────────────── */
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });

function txt(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (typeof v === 'object' && v['#text'] != null) return String(v['#text']).trim();
  return '';
}

function asArray(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }

function stripHtml(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_m, d) => { try { return String.fromCodePoint(parseInt(d, 16)); } catch { return ''; } });
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 300) s = s.slice(0, 297).replace(/\s+\S*$/, '') + '…';
  return s;
}

function parseDate(v) {
  const s = txt(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function linkHref(links, rel) {
  for (const l of asArray(links)) {
    if (typeof l === 'object' && l['@_href']) {
      if (rel ? l['@_rel'] === rel : !l['@_rel'] || l['@_rel'] === 'alternate') return String(l['@_href']);
    }
  }
  return '';
}

function safeLink(u) {
  const s = txt(u);
  return /^https?:\/\//i.test(s) ? s : null;
}

function parseFeed(xmlText) {
  let doc;
  try { doc = xmlParser.parse(xmlText); } catch { throw new FeedError('That address did not answer with valid XML.'); }
  const channel = doc.rss && doc.rss.channel;
  const atom = doc.feed;
  if (channel) {
    return {
      title: txt(channel.title) || 'Untitled feed',
      siteUrl: safeLink(channel.link),
      items: asArray(channel.item).map((it) => ({
        guid: txt(it.guid) || txt(it.link),
        title: txt(it.title) || '(untitled post)',
        link: safeLink(it.link),
        excerpt: stripHtml(it.description),
        published: parseDate(it.pubDate),
      })),
    };
  }
  if (atom) {
    return {
      title: txt(atom.title) || 'Untitled feed',
      siteUrl: safeLink(linkHref(atom.link)),
      items: asArray(atom.entry).map((e) => ({
        guid: txt(e.id) || linkHref(e.link),
        title: txt(e.title) || '(untitled post)',
        link: safeLink(linkHref(e.link)),
        excerpt: stripHtml(e.summary != null ? e.summary : e.content),
        published: parseDate(e.updated) || parseDate(e.published),
      })),
    };
  }
  throw new FeedError('That address is not an RSS or Atom feed.');
}

async function fetchAndParseFeed(url) {
  return parseFeed(await guardedFetchText(url));
}

async function storeFeedItems(feedId, parsed, now) {
  const items = parsed.items.filter((it) => it.guid).slice(0, 100);
  for (const it of items) {
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, excerpt, published_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedId, it.guid, it.title, it.link, it.excerpt, it.published || now, now]);
  }
  return items.length;
}

/* ── Routes ──────────────────────────────────────────────────────────── */

// Express 4 does not catch async handlers' rejections; without this, one
// failed query would take the whole process down.
function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function demoActive(req) {
  return IS_STAGING && req.query['demo'] === '1' && !!req.user;
}

app.get('/api/feeds', wrap(async (req, res) => {
  await ensureDemo(req);
  const uid = req.user ? req.user.id : null;
  if (!uid) return res.json({ feeds: [] });
  const { rows } = await pool.query(
    `SELECT id, title, url, site_url, color, is_demo, last_fetched_at, last_error
     FROM feeds WHERE user_id = $1 AND ($2::boolean OR NOT is_demo)
     ORDER BY created_at, id`,
    [uid, demoActive(req)]);
  res.json({ feeds: rows });
}));

app.post('/api/feeds', wrap(async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  if (!url) return res.status(422).json({ error: 'Enter the address of a feed.' });
  if (!/^https?:\/\//i.test(url)) {
    return res.status(422).json({ error: 'The address must start with http:// or https://.' });
  }
  let parsed;
  try {
    parsed = await fetchAndParseFeed(url);
  } catch (err) {
    return res.status(422).json({ error: err.message || 'That address could not be fetched.' });
  }
  const uid = req.user.id;
  const existing = await pool.query(`SELECT id FROM feeds WHERE user_id = $1 AND url = $2`, [uid, url]);
  if (existing.rows.length) {
    return res.status(409).json({ error: 'You already follow this feed.' });
  }
  const count = await pool.query(`SELECT count(*)::int AS n FROM feeds WHERE user_id = $1`, [uid]);
  const color = (count.rows[0].n % 8) + 1;
  const inserted = await pool.query(
    `INSERT INTO feeds (user_id, url, title, site_url, color, last_fetched_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id, title, url, site_url, color`,
    [uid, url, parsed.title, parsed.siteUrl, color, req.now]);
  const feed = inserted.rows[0];
  await storeFeedItems(feed.id, parsed, req.now);
  res.status(201).json({ feed });
}));

app.delete('/api/feeds/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(422).json({ error: 'Unknown feed.' });
  const gone = await pool.query(`DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id`, [id, req.user.id]);
  if (!gone.rows.length) return res.status(404).json({ error: 'Unknown feed.' });
  res.json({ ok: true });
}));

app.post('/api/refresh', wrap(async (req, res) => {
  const uid = req.user.id;
  const { rows: feeds } = await pool.query(
    `SELECT id, url, title FROM feeds WHERE user_id = $1 AND NOT is_demo ORDER BY created_at, id`, [uid]);
  const results = [];
  // A few at a time, so one slow feed doesn't hold up the others for long.
  for (let i = 0; i < feeds.length; i += 3) {
    await Promise.all(feeds.slice(i, i + 3).map(async (feed) => {
      try {
        const parsed = await fetchAndParseFeed(feed.url);
        await storeFeedItems(feed.id, parsed, req.now);
        await pool.query(`UPDATE feeds SET last_fetched_at = $2, last_error = NULL WHERE id = $1`, [feed.id, req.now]);
        results.push({ id: feed.id, title: feed.title, ok: true });
      } catch (err) {
        await pool.query(`UPDATE feeds SET last_error = $2 WHERE id = $1`, [feed.id, err.message || 'Could not be fetched.']);
        results.push({ id: feed.id, title: feed.title, ok: false, error: err.message });
      }
    }));
  }
  res.json({ results });
}));

app.get('/api/posts', wrap(async (req, res) => {
  await ensureDemo(req);
  const uid = req.user ? req.user.id : null;
  const demo = demoActive(req);
  if (!uid) return res.json({ posts: [], unread: 0, saved: 0, demo });
  const view = req.query.view === 'saved' ? 'saved' : req.query.view === 'all' ? 'all' : 'unread';
  const cond = view === 'saved' ? 'p.saved_at IS NOT NULL'
    : view === 'all' ? 'TRUE' : 'p.read_at IS NULL';
  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.link, p.excerpt, p.published_at, p.read_at, p.saved_at,
            f.id AS feed_id, f.title AS feed_title, f.color AS feed_color, f.site_url AS feed_site_url
     FROM posts p JOIN feeds f ON f.id = p.feed_id
     WHERE f.user_id = $1 AND ($2::boolean OR NOT f.is_demo) AND ${cond}
     ORDER BY p.published_at DESC
     LIMIT 300`,
    [uid, demo]);
  const counts = await pool.query(
    `SELECT
       count(*) FILTER (WHERE p.read_at IS NULL)::int AS unread,
       count(*) FILTER (WHERE p.saved_at IS NOT NULL)::int AS saved
     FROM posts p JOIN feeds f ON f.id = p.feed_id
     WHERE f.user_id = $1 AND ($2::boolean OR NOT f.is_demo)`,
    [uid, demo]);
  res.json({
    posts: rows,
    unread: counts.rows[0].unread,
    saved: counts.rows[0].saved,
    demo,
  });
}));

app.patch('/api/posts/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(422).json({ error: 'Unknown post.' });
  const body = req.body || {};
  const sqlSets = [];
  const params = [id, req.user.id];
  if (typeof body.read === 'boolean') {
    params.push(body.read, req.now);
    sqlSets.push(`read_at = CASE WHEN $${params.length - 1}::boolean THEN $${params.length}::timestamptz ELSE NULL END`);
  }
  if (typeof body.saved === 'boolean') {
    params.push(body.saved, req.now);
    sqlSets.push(`saved_at = CASE WHEN $${params.length - 1}::boolean THEN $${params.length}::timestamptz ELSE NULL END`);
  }
  if (!sqlSets.length) return res.status(422).json({ error: 'Nothing to change.' });
  const { rows } = await pool.query(
    `UPDATE posts p SET ${sqlSets.join(', ')}
     FROM feeds f
     WHERE p.feed_id = f.id AND p.id = $1 AND f.user_id = $2
     RETURNING p.id, p.title, p.link, p.excerpt, p.published_at, p.read_at, p.saved_at,
               f.id AS feed_id, f.title AS feed_title, f.color AS feed_color, f.site_url AS feed_site_url`,
    params);
  if (!rows.length) return res.status(404).json({ error: 'Unknown post.' });
  res.json({ post: rows[0] });
}));

// Express 4 error handler: an API error answers 500 JSON instead of
// taking the process down.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

/* ── Staging demo ──────────────────────────────────────────────────────
 * The first `?demo=1` request writes the viewing user's five demo feeds
 * and about 20 posts spread over the three days before `req.now`.
 * Fixed guids + ON CONFLICT DO NOTHING keep a reload from changing
 * anything, so the viewer's reads and saves stay. Demo feeds are never
 * refreshed and their URLs are never fetched.
 */
const DEMO_FEEDS = [
  { url: 'https://example.invalid/feeds/circuit-weekly.xml', title: 'Circuit Weekly' },
  { url: 'https://example.invalid/feeds/kitchen-notes.xml', title: 'Kitchen Notes' },
  { url: 'https://example.invalid/feeds/quiet-software.xml', title: 'Quiet Software' },
  { url: 'https://example.invalid/feeds/space-desk.xml', title: 'Space Desk' },
  { url: 'https://example.invalid/feeds/nature-notes.xml', title: 'Nature Notes' },
];

// [feedIndex, hoursAgo, title, excerpt, read, saved]
const DEMO_POSTS = [
  [0, 0.4, 'Why the new battery chemistry might finally reach phones', 'Engineers say a silicon-rich anode could add a third more runtime without a bigger cell. The catch is how it behaves after a few hundred charges, and early tests are promising but small.', false, false],
  [1, 1, 'The crispiest roast potatoes need one odd step', 'Parboiling is the usual advice. The step almost everyone skips is letting them steam dry in the pot for a full minute before the fat goes in.', false, false],
  [2, 2, 'Notes on a quieter kind of software update', 'The best releases are the ones nobody notices. A short log of what it takes to ship a change that deletes more code than it adds.', false, false],
  [3, 4, 'Telescope spots the earliest spiral galaxy yet', 'The galaxy appears as it was a few hundred million years after the big bang, and its orderly arms are harder to explain than a chaotic one would be.', false, false],
  [4, 5, 'A field guide to city foxes after dark', 'Foxes live closer than most of us guess. A naturalist who has followed one den for three years explains what the tracks and the late-night calls mean.', false, false],
  [4, 7, 'Reading a landscape the way animals do', 'Paths that look random to us are maps to the animals that made them. A walk with a tracker who reads a hedgerow the way others read a page.', true, true],
  [1, 9, 'Three sauces from one tomato', 'The same ripe tomato becomes a butter sauce, a sharp one for grilled things, and a slow-cooked base for the week, depending on the pan.', true, false],
  [3, 9, 'A launch window, explained with paper planes', 'Why a mission to a neighbour planet waits for the planets to line up, demonstrated with a sheet of paper and a well-thrown plane.', true, false],
  [0, 16, 'The quiet comeback of the repairable laptop', 'Repair scores are printed on the box now. We took three apart to see whether the numbers hold up, and which screws are the honest ones.', false, false],
  [1, 18, 'A weeknight curry that starts with the spice tin', 'Toast the whole spices first and the rest of the pan takes care of itself. Ten minutes, one pot, and the leftovers are better the next day.', false, false],
  [2, 20, 'The case for shipping less software', 'Every feature you add is one you maintain forever. A maintainer of a small, popular library on saying no for ten years.', false, false],
  [3, 22, 'How a space suit is really a spaceship', 'Twenty layers of fabric, a portable life-support backpack and a lot of stitching: a walk through the lab where the next generation is assembled.', false, false],
  [0, 24, 'What a two-year-old phone battery really holds', 'We charged and drained the same phone every day for two years. The number left is not the one the spec sheet promised, and here is why.', true, true],
  [4, 26, 'The morning chorus, decoded', 'Birdsong peaks forty minutes before sunrise. Recording at the same hedge for a year reveals a strict order to who sings first.', false, false],
  [2, 27, 'A bug report that changed how I write code', 'The reproducible bug is a small act of kindness. On writing reports that maintainers actually thank you for.', false, false],
  [3, 29, 'The slow road back to the moon', 'The programme has slipped more than once. A timeline of what has to go right, and what each delay actually buys.', false, false],
  [1, 34, 'Bread flour versus plain, settled', 'We baked the same loaf eleven times. The difference is real but smaller than the bag suggests, and hydration matters more.', true, false],
  [2, 45, 'Slow software and the forty-year database', 'Some of the most reliable systems in the world are the oldest. What a four-decade deployment can teach a project that is three weeks old.', true, true],
  [4, 48, 'The urban bees are doing fine', 'Hives on rooftops outproduce their country cousins. A beekeeper on why city flowers, and fewer pesticides, make a surprising difference.', true, true],
  [0, 51, 'Charging at night, measured', 'Does overnight charging wear a battery faster than topping up through the day? A month of logging says less than the internet thinks.', true, false],
  [1, 40, 'What to do with a glut of courgettes', 'Six plants were two too many. A cook who froze, fermented and fried her way through August, with the three recipes worth repeating.', true, false],
];

const demoEnsured = new Set();

async function ensureDemo(req) {
  if (!demoActive(req)) return;
  if (demoEnsured.has(req.user.id)) return;
  demoEnsured.add(req.user.id);
  const feedIds = [];
  for (let i = 0; i < DEMO_FEEDS.length; i++) {
    const f = DEMO_FEEDS[i];
    const up = await pool.query(
      `INSERT INTO feeds (user_id, url, title, color, is_demo, created_at)
       VALUES ($1, $2, $3, $4, true, $5)
       ON CONFLICT (user_id, url) DO NOTHING
       RETURNING id`,
      [req.user.id, f.url, f.title, i + 1, req.now]);
    if (up.rows.length) feedIds.push(up.rows[0].id);
    else {
      const found = await pool.query(`SELECT id FROM feeds WHERE user_id = $1 AND url = $2`, [req.user.id, f.url]);
      feedIds.push(found.rows[0].id);
    }
  }
  await Promise.all(DEMO_POSTS.map(async ([fi, hoursAgo, title, excerpt, read, saved], n) => {
    const published = new Date(req.now.getTime() - hoursAgo * 3600 * 1000);
    // example.invalid is never fetched; the link only gives Open full
    // article something real to open in the browser.
    const link = 'https://example.invalid/feeds/' + DEMO_FEEDS[fi].url.split('/').pop().replace(/\.xml$/, '') + '/post-' + (n + 1) + '.html';
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, excerpt, published_at, read_at, saved_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedIds[fi], `demo-f${fi}-p${hoursAgo}`, title, link, excerpt, published,
        read ? published : null, saved ? published : null]);
  }));
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

/* ── Boot and shutdown ───────────────────────────────────────────────── */
let server;

async function start() {
  await migrate();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

// Stop accepting connections, drain for about 3 s, close the pool, exit.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: closing server`);
  if (server) server.close();
  setTimeout(() => {
    pool.end().then(() => process.exit(0)).catch(() => process.exit(0));
  }, 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });