const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const http = require('http');
const https = require('https');
const dns = require('dns');
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

// ── Schema ────────────────────────────────────────────────────────────────
// Both tables are per-person data (feeds and read state are private), so
// both are marked `staging:private`: staging copies the schema without the
// rows. Applied idempotently on boot.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      site_url TEXT,
      is_demo BOOLEAN NOT NULL DEFAULT FALSE,
      last_error TEXT,
      last_fetched_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url_key ON feeds (user_id, url)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id BIGSERIAL PRIMARY KEY,
      feed_id BIGINT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT,
      summary TEXT,
      published_at TIMESTAMPTZ NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS posts_feed_guid_key ON posts (feed_id, guid)');
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE posts IS 'staging:private'`);
}

// ── Guarded feed fetching ─────────────────────────────────────────────────
// Every address a person typed (and every redirect it follows) is fetched
// with a guard: http or https only, no userinfo in the URL, DNS resolved
// first and each answer checked, and the connection made only to a checked
// address — loopback, private, link-local (cloud metadata), CGNAT and
// reserved ranges are refused, IPv4 and IPv6. At most 3 redirects (each hop
// re-resolved and re-checked), a 10 s timeout and a 2 MB body limit.
const BODY_LIMIT = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;

function ipv4Blocked(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return true;               // this-host, private, loopback
  if (a === 169 && b === 254) return true;                          // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;                 // private
  if (a === 192 && b === 168) return true;                          // private
  if (a === 100 && b >= 64 && b <= 127) return true;                // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;    // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true;             // benchmarking
  if (a >= 224) return true;                                        // multicast + reserved
  return false;
}

// True when the address must not be connected to. Returns a reason string.
function ipBlocked(ip) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return ipv4Blocked(mapped[1]) ? 'private address' : null;
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return 'loopback address';
  if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) {
    return 'link-local address';                                    // fe80::/10, metadata included
  }
  if (v6.startsWith('fc') || v6.startsWith('fd')) return 'private address'; // fc00::/7
  if (v6.startsWith('::ffff:')) {                                   // mapped, hex form
    const parts = v6.slice(7).split(':').filter(Boolean);
    if (parts.length === 2) {
      const hi = parseInt(parts[0], 16), lo = parseInt(parts[1], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        return ipv4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`) ? 'private address' : null;
      }
    }
  }
  return null;
}

// A lookup function handed to http/https: every answer is resolved fresh and
// checked, so a DNS rebinding or a redirect to an internal name is refused.
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    const family = opts && opts.family;
    const usable = (addrs || [])
      .filter(a => !family || a.family === family)
      .filter(a => !ipBlocked(a.address));
    if (!usable.length) return cb(new Error('address not allowed'));
    cb(null, usable[0].address, usable[0].family);
  });
}

function guardedFetch(urlStr, depth = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('not a valid address')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(new Error('only http and https addresses'));
    }
    if (u.username || u.password) return reject(new Error('not a valid address'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: (u.pathname || '/') + (u.search || ''),
      method: 'GET',
      lookup: safeLookup,
      timeout: FETCH_TIMEOUT_MS,
      headers: {
        'user-agent': 'RSSReader/1.0',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const loc = res.headers.location;
        if (!loc || depth >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
        return resolve(guardedFetch(new URL(loc, u).toString(), depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('the server answered ' + res.statusCode));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > BODY_LIMIT) {
          req.destroy();
          return reject(new Error('the feed is too large'));
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('the address took too long to answer')));
    req.on('error', reject);
    req.end();
  });
}

// ── Feed parsing (RSS 2.0, RSS 1.0, Atom) ─────────────────────────────────
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true, parseTagValue: false });

function toArr(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

function txt(v) {
  if (v == null) return '';
  if (Array.isArray(v)) v = v[0];
  if (typeof v === 'object') v = v['#text'];
  return v == null ? '' : String(v).trim();
}

// The link of an RSS item or Atom entry: Atom links are objects with @href.
function linkOf(v) {
  const first = Array.isArray(v) ? v[0] : v;
  if (first && typeof first === 'object') {
    const alt = toArr(v).find(l => l['@_rel'] === 'alternate' || !l['@_rel']);
    return txt(alt && (alt['@_href'] || alt['#text'])) || txt(first['@_href'] || first['#text']);
  }
  return txt(v);
}

// Feed-provided text to plain text: HTML stripped, entities decoded,
// paragraph breaks kept so the preview can show them.
function htmlToText(html) {
  let s = String(html == null ? '' : html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, '\n\n').replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0?39;|&#x0?27;/gi, "'");
  s = s.replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ' '; } });
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, n) => {
    try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ' '; }
  });
  return s
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim()
    .slice(0, 2000);
}

// Parses fetched XML into { title, siteUrl, items: [{ guid, title, link,
// summary, publishedAt }] }. Throws when the document is not a feed.
function parseFeedDoc(xml) {
  const doc = xmlParser.parse(String(xml));
  if (!doc || typeof doc !== 'object') throw new Error('not a feed');
  let title = '', siteUrl = '', rawItems = [];
  if (doc.rss && doc.rss.channel) {
    const channel = toArr(doc.rss.channel)[0] || {};
    title = txt(channel.title);
    siteUrl = linkOf(channel.link);
    rawItems = toArr(channel.item);
  } else if (doc['rdf:RDF']) {
    const rdf = doc['rdf:RDF'];
    const channel = toArr(rdf.channel)[0] || {};
    title = txt(channel.title) || txt(rdf['@_about'] ? '' : '');
    siteUrl = linkOf(channel.link);
    rawItems = toArr(rdf.item);
  } else if (doc.feed) {
    title = txt(doc.feed.title);
    siteUrl = linkOf(doc.feed.link);
    rawItems = toArr(doc.feed.entry);
  } else {
    throw new Error('not a feed');
  }
  const items = [];
  for (const it of rawItems.slice(0, 100)) {
    const link = linkOf(it.link || it['@_href'] || '') || '';
    const guid = txt(it.guid) || txt(it.id) || txt(it['dc:identifier']) || link;
    const summary = htmlToText(it.description != null ? it.description : (it.summary != null ? it.summary : it.content));
    let published = new Date(txt(it.pubDate) || txt(it['dc:date']) || txt(it.published) || txt(it.updated));
    if (isNaN(published.getTime())) published = null;
    if (!guid && !link) continue;
    items.push({
      guid: guid || link,
      title: txt(it.title) || '(untitled post)',
      link: link.slice(0, 2000),
      summary,
      publishedAt: published,
    });
  }
  if (!title) title = '(unnamed feed)';
  return { title, siteUrl: siteUrl.slice(0, 2000), items };
}

const FEED_ERROR_MESSAGES = {
  'not a feed': 'That address does not look like a feed. Check it and try again.',
  'only http and https addresses': 'Only http and https addresses work here.',
  'not a valid address': 'That is not a valid address. Check it and try again.',
};

function feedErrorMessage(err) {
  const m = err && err.message ? err.message : '';
  return FEED_ERROR_MESSAGES[m] || 'Could not reach that address. Check it and try again.';
}

// Stores a parsed feed's items. Insert time stands in when the item carries
// no date of its own.
async function storeItems(feedId, items, now) {
  if (!items.length) return;
  const values = [];
  const params = [];
  for (const it of items) {
    const base = params.length;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
    params.push(feedId, it.guid.slice(0, 2000), it.title.slice(0, 500), it.link, it.summary, it.publishedAt || now);
  }
  await pool.query(
    `INSERT INTO posts (feed_id, guid, title, link, summary, published_at)
     VALUES ${values.join(', ')} ON CONFLICT (feed_id, guid) DO NOTHING`,
    params);
}

// Refreshes one stored feed: fetch, parse, store new items, record the
// outcome. Never throws — the reason lands in feeds.last_error.
async function refreshFeed(feed, now) {
  try {
    const parsed = parseFeedDoc(await guardedFetch(feed.url));
    await storeItems(feed.id, parsed.items, now);
    await pool.query(
      'UPDATE feeds SET last_error = NULL, last_fetched_at = $2, title = $3, site_url = $4 WHERE id = $1',
      [feed.id, now, parsed.title, parsed.siteUrl]);
    return { ok: true };
  } catch (err) {
    await pool.query(
      'UPDATE feeds SET last_error = $2, last_fetched_at = $3 WHERE id = $1',
      [feed.id, err.message, now]);
    return { ok: false, title: feed.title };
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

// Marks one of the viewer's own posts as read.
app.post('/api/posts/:id/read', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const r = await pool.query(
    `UPDATE posts SET read_at = $2
     WHERE id = $1 AND feed_id IN (SELECT id FROM feeds WHERE user_id = $3)
     RETURNING id`,
    [id, req.now, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// The viewer's feeds, newest first.
app.get('/api/feeds', async (req, res) => {
  if (!req.user) return res.json({ feeds: [] });
  const demo = IS_STAGING && req.query.demo === '1';
  const r = await pool.query(
    `SELECT id, url, title, site_url, is_demo FROM feeds
     WHERE user_id = $1 ${demo ? '' : 'AND is_demo = FALSE'}
     ORDER BY created_at DESC, id DESC`,
    [req.user.id]);
  res.json({
    feeds: r.rows.map(f => ({
      id: f.id, url: f.url, title: f.title, siteUrl: f.site_url, isDemo: f.is_demo,
    })),
  });
});

// Adds a feed: fetch and parse the address, refuse it with a clear reason
// when it is not a feed, unreachable or already in the list, then store it
// and its items.
app.post('/api/feeds', async (req, res) => {
  const url = typeof (req.body || {}).url === 'string' ? req.body.url.trim() : '';
  if (!url) return res.status(400).json({ error: 'Enter a feed address.' });
  let parsed;
  try {
    parsed = parseFeedDoc(await guardedFetch(url));
  } catch (err) {
    return res.status(400).json({ error: feedErrorMessage(err) });
  }
  const added = await pool.query(
    `INSERT INTO feeds (user_id, url, title, site_url, last_fetched_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
    [req.user.id, url, parsed.title, parsed.siteUrl, req.now]);
  if (!added.rowCount) {
    return res.status(400).json({ error: 'That feed is already in your list.' });
  }
  await storeItems(added.rows[0].id, parsed.items, req.now);
  res.json({ ok: true, feed: { id: added.rows[0].id, url, title: parsed.title } });
});

// Removes one of the viewer's feeds; its posts go with it (cascade).
app.delete('/api/feeds/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const r = await pool.query(
    'DELETE FROM feeds WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// The unread list: refresh the viewer's own feeds in parallel (a failure
// sets last_error and does not stop the others), store new items, then
// return the unread posts with each feed's title. Guests get an empty list.
app.get('/api/posts', async (req, res) => {
  const demo = IS_STAGING && req.query.demo === '1';
  if (!req.user) {
    return res.json({ demo: false, posts: [], feedCount: 0, failedFeeds: [], updatedAt: req.now.toISOString() });
  }
  if (demo) await seedDemo(req.user.id, req.now);
  const feeds = (await pool.query(
    `SELECT id, url, title, is_demo FROM feeds
     WHERE user_id = $1 ${demo ? '' : 'AND is_demo = FALSE'}`,
    [req.user.id])).rows;
  const results = await Promise.all(
    feeds.filter(f => !f.is_demo).map(f => refreshFeed(f, req.now)));
  const failedFeeds = results.filter(r => !r.ok).map(r => r.title);
  const posts = (await pool.query(
    `SELECT p.id, p.title, p.link, p.summary, p.published_at, f.title AS feed_title
     FROM posts p JOIN feeds f ON f.id = p.feed_id
     WHERE f.user_id = $1 AND p.read_at IS NULL ${demo ? '' : 'AND f.is_demo = FALSE'}
     ORDER BY p.published_at DESC`,
    [req.user.id])).rows;
  res.json({
    demo,
    posts: posts.map(p => ({
      id: p.id,
      title: p.title,
      link: p.link,
      summary: p.summary || '',
      publishedAt: p.published_at.toISOString(),
      feedTitle: p.feed_title,
    })),
    feedCount: feeds.length,
    failedFeeds,
    updatedAt: req.now.toISOString(),
  });
});

// ── Staging demo (first version) ──────────────────────────────────────────
// On the first `?demo=1` request in staging, the viewer gets six made-up
// feeds and twenty made-up posts of their own (14 unread, 6 read), with
// fixed guids and ON CONFLICT DO NOTHING: a reload changes nothing, and the
// viewer's reads and removals stay. Demo feeds are never fetched. Every
// response without `?demo=1` leaves is_demo rows out, so the plain route
// stays production-shaped.
const DEMO_FEEDS = [
  { title: 'Pocket Tech', slug: 'pocket-tech' },
  { title: 'Small Kitchen', slug: 'small-kitchen' },
  { title: 'Slow Software', slug: 'slow-software' },
  { title: 'Field Notes', slug: 'field-notes' },
  { title: 'Harbour Weekly', slug: 'harbour-weekly' },
  { title: 'Night Sky Notes', slug: 'night-sky-notes' },
];

// feed index, hours before the seed moment, title, summary, read.
const DEMO_POSTS = [
  [0, 0.7, 'The quiet return of the dumbphone', 'Sales of basic handsets are up for a third year as people look for ways to switch off.', false],
  [1, 2, 'Why your focaccia needs more water than you think', 'A wetter dough gives the open, glossy crumb. Here is how to handle it without a mess.', false],
  [2, 3, 'Notes on a smaller, faster text editor', 'A week with an editor that opens instantly and does very little else, and why that was enough.', false],
  [3, 5, 'A map of every lighthouse still staffed', 'Fewer than twenty keepers remain worldwide. Their stories, and where to find them.', false],
  [4, 6, 'The ferry timetable is changing again', 'The autumn schedule adds one early sailing and drops the late one on Sundays. Here is what shifts.', false],
  [5, 7, 'Two meteor showers peak this week', 'Both are modest, but the Moon cooperates. The best hours are just after midnight.', false],
  [0, 20.5, 'Handheld consoles are getting weirdly good', 'Battery life is the new spec race, and the newest models finally last a full flight.', false],
  [3, 23, 'What a hundred-year-old seed vault teaches us', 'Inside the cold room where forgotten varieties wait for a second chance.', false],
  [2, 26, 'On the slow death of the home screen widget', 'Why the most promising idea in phone design never quite found its audience.', false],
  [2, 39, 'Version control without the jargon', 'Branch, merge, revert, explained the way you would explain them to a friend over coffee.', false],
  [5, 40, 'How to sketch the Moon in ten minutes', 'You need three pencils, one eraser, and the patience to squint. The rest is shading.', false],
  [3, 41.5, 'Counting herons from a harbour bench', 'A volunteer census, now in its ninth year, keeps finding more birds than the year before.', false],
  [1, 68, 'Bread flour, all purpose, and when it matters', 'Protein percentages, explained without the lab coat. Most weeknight baking cannot tell the difference.', false],
  [3, 90, 'The trail that repairs itself every spring', 'Volunteers re-lay the same four hundred metres of boardwalk each year. This is why.', false],
  [1, 27, 'The best way to cook a weeknight rice', 'Rinse, rest, and trust the lid. A method that works every time.', true],
  [1, 29, 'A five-ingredient soup for cold evenings', 'White beans, leek, potato, stock, and time. Dinner is ahead of you by half past seven.', true],
  [4, 33, 'The old dry dock gets new plans', 'After twenty years of arguments, the heritage listing finally comes with a budget attached.', true],
  [0, 92, 'What we lost when phones stopped having keys', 'A small eulogy for the keypad, from the people who still type blind.', true],
  [2, 94, 'A to-do list that forgets on purpose', 'If a task survives three days untouched, this one deletes it. Somehow, nothing is ever missed.', true],
  [5, 118, "A beginner's map of the autumn sky", 'Four constellations are enough to find your way around. Start with the one shaped like a kite.', true],
];

async function seedDemo(userId, now) {
  const existing = await pool.query(
    'SELECT 1 FROM feeds WHERE user_id = $1 AND is_demo = TRUE LIMIT 1', [userId]);
  if (existing.rowCount) return;
  const ids = [];
  for (const f of DEMO_FEEDS) {
    const url = `https://demo.example.com/${f.slug}/feed.xml`;
    const r = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, is_demo, last_fetched_at)
       VALUES ($1, $2, $3, $4, TRUE, $5)
       ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
      [userId, url, f.title, `https://demo.example.com/${f.slug}/`, now]);
    ids.push(r.rows[0] ? r.rows[0].id : null);
  }
  const values = [];
  const params = [];
  DEMO_POSTS.forEach(([feedIdx, hoursAgo, title, summary, read], i) => {
    const feedId = ids[feedIdx];
    if (!feedId) return;
    const base = params.length;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
    params.push(
      feedId,
      `demo-${String(i + 1).padStart(3, '0')}`,
      title,
      `https://demo.example.com/post/${i + 1}`,
      summary,
      new Date(now.getTime() - hoursAgo * 3600 * 1000),
      read ? now : null,
    );
  });
  await pool.query(
    `INSERT INTO posts (feed_id, guid, title, link, summary, published_at, read_at)
     VALUES ${values.join(', ')} ON CONFLICT (feed_id, guid) DO NOTHING`,
    params);
}

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

  // Stop accepting, drain about 3 s, close the pool, exit.
  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    server.close();
    await new Promise(r => setTimeout(r, 3000));
    try { await pool.end(); } catch {}
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
