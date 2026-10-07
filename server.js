const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── RSS Reader ──────────────────────────────────────────────────────────────
// Two public tables are a shared cache (a feed is the same for everyone who
// subscribes to it); the two private tables hold personal data (who reads
// what) and are marked private so staging copies them schema-only.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS feeds (
    id          serial PRIMARY KEY,
    url         text NOT NULL UNIQUE,
    title       text,
    site_url    text,
    fetched_at  timestamptz,
    last_error  text
  );
  CREATE TABLE IF NOT EXISTS feed_items (
    id           serial PRIMARY KEY,
    feed_id      integer NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid         text NOT NULL,
    title        text,
    url          text,
    summary      text,
    published_at timestamptz,
    UNIQUE (feed_id, guid)
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id    text NOT NULL,
    feed_id    integer NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, feed_id)
  );
  CREATE TABLE IF NOT EXISTS read_state (
    user_id text NOT NULL,
    item_id integer NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
    read_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, item_id)
  );
`;
async function ensureSchema() {
  await pool.query(SCHEMA_SQL);
  await pool.query("COMMENT ON TABLE subscriptions IS 'staging:private'");
  await pool.query("COMMENT ON TABLE read_state IS 'staging:private'");
}

// Feeds refresh when someone opens the app: a feed not fetched in the last
// five minutes is re-fetched then ("now" per request, so a staging preview
// opened as of a chosen moment refreshes against that moment).
const FRESH_MS = 5 * 60 * 1000;
const MAX_ITEMS_PER_FEED = 50;
const MAX_POSTS_RETURNED = 200;
const FETCH_TIMEOUT_MS = 5000;   // per feed; refreshes run in parallel
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const FEED_PARSER = new Parser({ customFields: { item: ['summary'] } });

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”',
};
// Feeds arrive with encoded entities ("Tesla&#8217;s"); tags are stripped
// first, then what remains is decoded, so a tag smuggled as an entity
// surfaces as inert text the page renders with textContent.
function decodeEntities(s) {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] || m;
  });
}
function stripHtml(raw) {
  return decodeEntities(String(raw || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    ).trim();
}

// The feed address is user-supplied, so fetching is bounded: http(s) only,
// and hosts that resolve to loopback, private or link-local space are
// refused — checked again on every redirect hop.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1' || v6.startsWith('fe80') ||
      v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('ff')) return true;
  if (v6.startsWith('::ffff:')) return isPrivateIp(v6.slice(7));
  return false;
}

async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Not a valid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be feeds');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length) throw new Error('Could not resolve that address');
  if (addrs.some(a => isPrivateIp(a.address))) {
    throw new Error('That address is not reachable from here');
  }
  return url;
}

async function readBodyCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY_BYTES) { reader.cancel(); throw new Error('Feed is too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchFeedXml(urlStr, redirectsLeft = MAX_REDIRECTS) {
  const url = await assertPublicUrl(urlStr);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'manual',
      headers: {
        'user-agent': 'Homeroom RSS Reader',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('Redirected with no destination');
      if (redirectsLeft <= 0) throw new Error('Too many redirects');
      return await fetchFeedXml(new URL(loc, url).href, redirectsLeft - 1);
    }
    if (!res.ok) throw new Error('The server answered ' + res.status);
    const text = await readBodyCapped(res);
    if (!text.trim()) throw new Error('The server sent an empty response');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Keeps the newest 50 items per feed, upserting by (feed_id, guid); rows that
// have fallen out of the feed are left in place so read marks survive.
async function storeItems(feedId, items) {
  const cleaned = (items || []).map(item => {
    const title = stripHtml(item.title).slice(0, 300) || 'Untitled';
    const link = item.link || null;
    const summary = stripHtml(item.contentSnippet || item.content || item.summary).slice(0, 600);
    const guid = String(item.guid || item.id || '') ||
      (link ? 'link:' + link : '') ||
      'hash:' + crypto.createHash('sha1').update((link || '') + '\u0000' + (item.title || '')).digest('hex');
    const pub = item.isoDate ? new Date(item.isoDate) : item.pubDate ? new Date(item.pubDate) : null;
    return { guid, title, link, summary, pub: pub && !isNaN(pub) ? pub : null };
  });
  cleaned.sort((a, b) => (b.pub ? b.pub.getTime() : 0) - (a.pub ? a.pub.getTime() : 0));
  for (const it of cleaned.slice(0, MAX_ITEMS_PER_FEED)) {
    await pool.query(
      `INSERT INTO feed_items (feed_id, guid, title, url, summary, published_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (feed_id, guid) DO UPDATE
         SET title = EXCLUDED.title, url = EXCLUDED.url,
             summary = EXCLUDED.summary, published_at = EXCLUDED.published_at`,
      [feedId, it.guid, it.title, it.link, it.summary, it.pub]);
  }
}

async function refreshFeed(feed, now) {
  try {
    const xml = await fetchFeedXml(feed.url);
    const parsed = await FEED_PARSER.parseString(xml);
    await storeItems(feed.id, parsed.items);
    await pool.query(
      'UPDATE feeds SET title = $2, site_url = $3, fetched_at = $4, last_error = NULL WHERE id = $1',
      [feed.id, stripHtml(parsed.title).slice(0, 300) || feed.url, parsed.link || null, now]);
  } catch (err) {
    // Record the failure and stamp fetched_at anyway so the next open does
    // not hammer a broken feed; its cached posts keep serving.
    await pool.query('UPDATE feeds SET last_error = $2, fetched_at = $3 WHERE id = $1',
      [feed.id, String(err.message || err).slice(0, 200), now]);
  }
}

// Staging fixtures, merged into /api/posts and /api/feeds behind ?demo=1 so a
// staging preview can show the populated screen: in-memory only, nothing is
// written to the database and no row is attributed to the viewer.
function demoData(now) {
  const hoursAgo = h => new Date(now.getTime() - h * 3600 * 1000).toISOString();
  const feeds = [
    { id: 'demo-f1', url: 'https://demo.example.com/tech-weekly.xml', title: 'Staging demo: Tech Weekly', unread: 3, last_error: null },
    { id: 'demo-f2', url: 'https://demo.example.com/city-dispatch.xml', title: 'Staging demo: City Dispatch', unread: 2, last_error: null },
    { id: 'demo-f3', url: 'https://demo.example.com/slow-baking-notes.xml', title: 'Staging demo: Slow Baking Notes', unread: 2, last_error: 'Fetch failed: the server could not be reached' },
  ];
  const post = (n, feed, title, summary, h) => ({
    id: 'demo-' + n, title, summary, url: 'https://demo.example.com/' + n,
    feed_title: feeds[feed].title, published_at: hoursAgo(h),
  });
  const posts = [
    post(1, 0, 'Why RSS never died', 'RSS never went away, it just stopped being fashionable. This piece walks through why syndication still beats an algorithmic timeline for people who would rather choose their own sources.', 2),
    post(2, 0, 'The quiet return of syndication', 'More writers are publishing plain feeds again. A look at the tools, the habits and the readers behind the trend.', 5),
    post(3, 0, 'A field guide to feed readers', 'Every reader makes the same trade-offs in a different order. This guide compares them on speed, filters and how they handle a thousand subscriptions.', 25),
    post(4, 1, 'New bike lanes reach the old quarter', 'The council approved the last two segments on Tuesday. Here is the map, the timeline, and what shopkeepers along the route had to say.', 9),
    post(5, 1, 'A market returns to Mill Street', 'After three years of renovation work, the Saturday market is back. What is new, what stayed, and where to find the stalls that moved.', 49),
    post(6, 2, 'Notes on slow software', 'Some tools get better the less you touch them. Notes on software that is designed to be left alone, and the maintenance rhythm that keeps it that way.', 72),
    post(7, 2, 'Sourdough, patience, and small hours', 'A baking log from a month of long ferments, with timings that survived a busy week and one that did not.', 96),
  ];
  return { feeds, posts };
}

// Viewer identity: guests have none, so their read routes return empty lists
// rather than errors. Writes never reach a guest (the middleware answers 401
// `account_required` first).
function viewerId(req) {
  return req.user ? String(req.user.id) : null;
}

function parseId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

app.get('/api/posts', async (req, res) => {
  const demo = IS_STAGING && req.query.demo === '1';
  const userId = viewerId(req);
  try {
    let posts = [];
    if (userId) {
      const subs = await pool.query(
        'SELECT f.id, f.url, f.fetched_at FROM feeds f JOIN subscriptions s ON s.feed_id = f.id WHERE s.user_id = $1',
        [userId]);
      const stale = subs.rows.filter(f => !f.fetched_at || (req.now - new Date(f.fetched_at)) > FRESH_MS);
      if (stale.length) await Promise.allSettled(stale.map(f => refreshFeed(f, req.now)));
      const rows = await pool.query(
        `SELECT fi.id, fi.title, fi.url, fi.summary, fi.published_at, f.title AS feed_title
         FROM subscriptions s
         JOIN feeds f ON f.id = s.feed_id
         JOIN feed_items fi ON fi.feed_id = f.id
         LEFT JOIN read_state r ON r.item_id = fi.id AND r.user_id = $1
         WHERE s.user_id = $1 AND r.item_id IS NULL
         ORDER BY fi.published_at DESC NULLS LAST
         LIMIT $2`,
        [userId, MAX_POSTS_RETURNED]);
      posts = rows.rows;
    }
    if (demo) {
      // Merge the in-memory fixtures in with whatever the viewer really has;
      // nothing is written and no row is attributed to the viewer.
      posts = posts.concat(demoData(req.now).posts)
        .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
        .slice(0, MAX_POSTS_RETURNED);
    }
    res.json({ posts });
  } catch (err) {
    console.warn('GET /api/posts failed: ' + (err.message || err));
    res.status(500).json({ error: 'Could not load posts' });
  }
});

app.get('/api/feeds', async (req, res) => {
  const demo = IS_STAGING && req.query.demo === '1';
  const userId = viewerId(req);
  try {
    let feeds = [];
    if (userId) {
      const rows = await pool.query(
        `SELECT f.id, f.url, COALESCE(f.title, f.url) AS title, f.last_error,
                COUNT(*) FILTER (WHERE r.item_id IS NULL)::int AS unread
         FROM subscriptions s
         JOIN feeds f ON f.id = s.feed_id
         LEFT JOIN feed_items fi ON fi.feed_id = f.id
         LEFT JOIN read_state r ON r.item_id = fi.id AND r.user_id = $1
         WHERE s.user_id = $1
         GROUP BY f.id, s.created_at
         ORDER BY s.created_at`,
        [userId]);
      feeds = rows.rows;
    }
    if (demo) feeds = feeds.concat(demoData(req.now).feeds);
    res.json({ feeds });
  } catch (err) {
    console.warn('GET /api/feeds failed: ' + (err.message || err));
    res.status(500).json({ error: 'Could not load feeds' });
  }
});

app.post('/api/feeds', async (req, res) => {
  const raw = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!raw) return res.status(400).json({ error: 'Enter a feed address.' });
  let url;
  try {
    url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
  } catch {
    return res.status(400).json({ error: 'Enter an http or https address, e.g. https://example.com/feed.xml.' });
  }
  try { await assertPublicUrl(url.href); } catch (err) {
    return res.status(400).json({ error: err.message + '. Nothing was added.' });
  }
  try {
    const xml = await fetchFeedXml(url.href);
    const parsed = await FEED_PARSER.parseString(xml);
    const feedRow = await pool.query(
      `INSERT INTO feeds (url, title, site_url, fetched_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (url) DO UPDATE
         SET title = EXCLUDED.title, site_url = EXCLUDED.site_url,
             fetched_at = EXCLUDED.fetched_at, last_error = NULL
       RETURNING id`,
      [url.href, stripHtml(parsed.title).slice(0, 300) || url.hostname, parsed.link || null, req.now]);
    const feedId = feedRow.rows[0].id;
    await storeItems(feedId, parsed.items);
    // Idempotent: re-adding your own or someone else's feed just subscribes
    // you to the shared cache row; existing read marks still apply.
    await pool.query('INSERT INTO subscriptions (user_id, feed_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [String(req.user.id), feedId]);
    res.json({ ok: true, id: feedId, title: stripHtml(parsed.title) || url.hostname });
  } catch (err) {
    console.warn('POST /api/feeds failed for ' + url.href + ': ' + (err.message || err));
    res.status(400).json({ error: 'That address is not a readable feed. Check it and try again; nothing was added.' });
  }
});

app.delete('/api/feeds/:id', async (req, res) => {
  const feedId = parseId(req.params.id);
  if (!feedId) return res.status(404).json({ error: 'Not found' });
  try {
    // Unsubscribe only: the cache rows and other subscribers stay.
    await pool.query('DELETE FROM subscriptions WHERE user_id = $1 AND feed_id = $2',
      [String(req.user.id), feedId]);
    res.json({ ok: true });
  } catch (err) {
    console.warn('DELETE /api/feeds/:id failed: ' + (err.message || err));
    res.status(500).json({ error: 'Could not remove feed' });
  }
});

app.post('/api/posts/:id/read', async (req, res) => {
  const id = String(req.params.id);
  // Demo posts live in memory only, so there is nothing to mark.
  if (id.startsWith('demo-')) return res.json({ ok: true });
  const itemId = parseId(id);
  if (!itemId) return res.status(404).json({ error: 'Not found' });
  try {
    await pool.query('INSERT INTO read_state (user_id, item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [String(req.user.id), itemId]);
    res.json({ ok: true });
  } catch (err) {
    console.warn('POST /api/posts/:id/read failed: ' + (err.message || err));
    res.status(404).json({ error: 'Not found' });
  }
});

app.post('/api/read-all', async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO read_state (user_id, item_id)
       SELECT $1, fi.id FROM feed_items fi
       JOIN subscriptions s ON s.feed_id = fi.feed_id AND s.user_id = $1
       LEFT JOIN read_state r ON r.item_id = fi.id AND r.user_id = $1
       WHERE r.item_id IS NULL
       ON CONFLICT DO NOTHING`,
      [String(req.user.id)]);
    res.json({ ok: true });
  } catch (err) {
    console.warn('POST /api/read-all failed: ' + (err.message || err));
    res.status(500).json({ error: 'Could not mark posts read' });
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

async function start() {
  await ensureSchema();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // Drain in-flight requests and close the pool when the platform stops us.
  const shutdown = signal => {
    console.log(signal + ' received, shutting down');
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
