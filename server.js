const express = require('express');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
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

// ── Schema (all tables staging:private) ───────────────────────────────────

async function bootSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      site_url TEXT,
      is_demo BOOLEAN NOT NULL DEFAULT FALSE,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url ON feeds (user_id, url);
    CREATE TABLE IF NOT EXISTS posts (
      id BIGSERIAL PRIMARY KEY,
      feed_id BIGINT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT,
      author TEXT,
      published_at TIMESTAMPTZ,
      excerpt TEXT,
      body_text TEXT,
      is_demo BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS posts_feed_guid ON posts (feed_id, guid);
    CREATE TABLE IF NOT EXISTS post_reads (
      user_id TEXT NOT NULL,
      post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, post_id)
    );
    -- Tombstones so a demo feed a viewer removed stays removed on reload.
    CREATE TABLE IF NOT EXISTS demo_removed_feeds (
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      PRIMARY KEY (user_id, url)
    );
  `);
  for (const t of ['feeds', 'posts', 'post_reads', 'demo_removed_feeds']) {
    await pool.query(`COMMENT ON TABLE ${t} IS 'staging:private'`);
  }
}

// ── Guarded fetch ─────────────────────────────────────────────────────────
// Every typed address and every feed refresh goes through safeFetch: only
// http/https on ports 80/443, DNS resolved and checked before connecting
// (loopback, private, link-local, CGNAT, multicast, reserved and metadata
// addresses refused, IPv4 and IPv6), the connection pinned to the checked
// IP, at most 3 redirects each re-checked, 8 s timeout, 2 MB cap.

const FETCH_TIMEOUT = 8000;
const MAX_BODY = 2 * 1024 * 1024;

function isBlockedAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;               // this-network, private, loopback
    if (a === 169 && b === 254) return true;                          // link-local (cloud metadata lives here)
    if (a === 172 && b >= 16 && b <= 31) return true;                 // private
    if (a === 192 && b === 168) return true;                          // private
    if (a === 100 && b >= 64 && b <= 127) return true;                // CGNAT
    if (a === 192 && b === 0 && c === 0) return true;                 // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return true;             // benchmarking
    if (a >= 224) return true;                                        // multicast and reserved
    return false;
  }
  const l = ip.toLowerCase();
  if (l === '::1' || l === '::') return true;                         // loopback, unspecified
  if (/^fe[89ab]/.test(l)) return true;                               // link-local
  if (/^f[cd]/.test(l)) return true;                                  // unique local
  if (/^ff/.test(l)) return true;                                     // multicast
  if (l.startsWith('64:ff9b:')) return true;                          // NAT64 (embeds an IPv4 target)
  const v4mapped = l.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);     // IPv4-mapped
  if (v4mapped) return isBlockedAddress(v4mapped[1]);
  return false;
}

async function resolveHost(hostname) {
  const addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addrs.length) throw new Error('could not resolve that address');
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) throw new Error('that address is not allowed');
  }
  return addrs[0].address;
}

function requestOnce(u, ip) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      host: ip, // the checked IP, not the hostname
      servername: u.hostname, // SNI and certificate check against the real name
      port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        host: u.hostname,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        'user-agent': 'RSSReader/1.0',
      },
    }, resolve);
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT, () =>
      req.destroy(Object.assign(new Error('that address took too long to answer'), { timedOut: true })));
    req.end();
  });
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    res.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        res.destroy();
        reject(new Error('the response was too large'));
        return;
      }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  });
}

async function safeFetch(rawUrl, redirects = 0) {
  if (redirects > 3) throw new Error('too many redirects');
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('that address is not a URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('only http and https are allowed');
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) throw new Error('only ports 80 and 443 are allowed');
  const ip = await resolveHost(u.hostname);
  const res = await requestOnce(u, ip);
  if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
    res.resume();
    const loc = res.headers.location;
    if (!loc) throw new Error('that address redirected nowhere');
    return safeFetch(new URL(loc, u).toString(), redirects + 1);
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error('that address answered with HTTP ' + res.statusCode);
  }
  const text = await readBody(res);
  return { text, finalUrl: u.toString() };
}

// ── Feed parsing (RSS 2.0 and Atom) ───────────────────────────────────────

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });

function one(x) { return Array.isArray(x) ? x[0] : x; }
function many(x) { return Array.isArray(x) ? x : x == null ? [] : [x]; }
function textOf(x) {
  if (x == null) return '';
  if (typeof x === 'object') return textOf(one(x['#text'] != null ? x['#text'] : x));
  return String(x);
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©',
};

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}

// Feed content is stored as plain text only: tags stripped, entities
// decoded, block boundaries kept as blank lines. The page renders this with
// textContent and never injects feed HTML.
function toPlainText(html) {
  const withBreaks = String(html || '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(?:p|div|h[1-6]|li|blockquote|tr)\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n\n');
  const text = decodeEntities(withBreaks.replace(/<[^>]+>/g, ''));
  return text.split(/\n+/).map((s) => s.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n\n');
}

function cleanAuthor(raw) {
  let a = String(raw || '').trim();
  a = a.replace(/^[^\s@]+@[^\s@]+\s*/, ''); // "mail@example.com Name" forms
  a = a.replace(/\((.*?)\)/, '$1').trim(); // "Name (by Name)" forms
  return a || null;
}

// Returns { title, siteUrl, items } or null when the text is not a feed.
function parseFeed(text) {
  let doc;
  try { doc = xmlParser.parse(text); } catch { return null; }
  if (!doc || typeof doc !== 'object') return null;
  let title = '', siteUrl = '', raw = [];
  const rss = one(doc.rss);
  const atom = one(doc.feed);
  if (rss && rss.channel) {
    const ch = one(rss.channel);
    title = textOf(one(ch.title));
    siteUrl = textOf(one(ch.link));
    raw = many(ch.item).map((it) => ({
      guid: textOf(one(it.guid)),
      title: textOf(one(it.title)),
      link: textOf(one(it.link)),
      author: textOf(one(it.author)) || textOf(one(it['dc:creator'])),
      date: textOf(one(it.pubDate)) || '',
      html: textOf(one(it['content:encoded'])) || textOf(one(it.description)) || '',
    }));
  } else if (atom) {
    title = textOf(one(atom.title));
    const links = many(atom.link);
    const alt = links.find((l) => l && l['@_rel'] === 'alternate') || links.find((l) => l && !l['@_rel']);
    siteUrl = alt ? String(alt['@_href'] || '') : '';
    raw = many(atom.entry).map((en) => {
      const elinks = many(en.link);
      const l = elinks.find((x) => x && x['@_rel'] === 'alternate') || elinks.find((x) => x && !x['@_rel']) || elinks[0];
      return {
        guid: textOf(one(en.id)),
        title: textOf(one(en.title)),
        link: l ? String(l['@_href'] || '') : '',
        author: textOf(one(one(en.author) && one(en.author).name)) || textOf(one(en.author)),
        date: textOf(one(en.published)) || textOf(one(en.updated)) || '',
        html: textOf(one(en.content)) || textOf(one(en.summary)) || '',
      };
    });
  } else {
    return null;
  }
  const items = raw.map((it) => {
    const bodyText = toPlainText(it.html);
    let date = it.date ? new Date(it.date) : null;
    if (!date || isNaN(date.getTime())) date = null;
    const link = /^https?:\/\//i.test(it.link) ? it.link : null;
    // guid falls back to the link, then to the title
    const guid = it.guid || link || it.title;
    return {
      guid: guid ? String(guid).slice(0, 500) : null,
      title: (it.title || '(untitled)').slice(0, 500),
      link,
      author: cleanAuthor(it.author),
      publishedAt: date,
      bodyText,
      excerpt: bodyText.slice(0, 300),
    };
  }).filter((it) => it.guid);
  return { title: title.slice(0, 300), siteUrl: /^https?:\/\//i.test(siteUrl) ? siteUrl : null, items };
}

async function upsertPosts(feedId, items, isDemo) {
  for (const it of items.slice(0, 100)) {
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, author, published_at, excerpt, body_text, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedId, it.guid, it.title, it.link, it.author, it.publishedAt, it.excerpt, it.bodyText, isDemo]
    );
  }
}

async function refreshFeed(feed) {
  try {
    const { text } = await safeFetch(feed.url);
    const parsed = parseFeed(text);
    if (!parsed) throw new Error('not a feed');
    await upsertPosts(feed.id, parsed.items, feed.is_demo);
    await pool.query('UPDATE feeds SET last_error = NULL WHERE id = $1', [feed.id]);
  } catch (err) {
    await pool.query('UPDATE feeds SET last_error = $2 WHERE id = $1',
      [feed.id, String((err && err.message) || err).slice(0, 200)]);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

// Refreshes the member's non-demo feeds (8 s each, in parallel; one failure
// only marks that feed's last_error) and returns the unread posts, newest
// first, plus the feed count. A guest gets an empty list.
app.get('/api/posts', async (req, res) => {
  const demo = IS_STAGING && req.query.demo === '1';
  if (!req.user) return res.json({ demo: false, feeds: 0, posts: [] });
  try {
    if (demo) await writeDemoData(req.user.id, req.now);
    const feedRows = (await pool.query('SELECT id, url, is_demo FROM feeds WHERE user_id = $1', [req.user.id])).rows;
    // Refresh never fetches demo feeds.
    await Promise.all(feedRows.filter((f) => !f.is_demo).map(refreshFeed));
    const demoFilter = demo ? '' : 'AND NOT p.is_demo AND NOT f.is_demo';
    const posts = (await pool.query(
      `SELECT p.id, p.title, p.link, p.author, p.published_at, p.excerpt, p.body_text,
              f.title AS feed_title, f.url AS feed_url
       FROM posts p JOIN feeds f ON f.id = p.feed_id
       LEFT JOIN post_reads r ON r.post_id = p.id AND r.user_id = $1
       WHERE f.user_id = $1 AND r.post_id IS NULL ${demoFilter}
       ORDER BY p.published_at DESC NULLS LAST, p.id DESC
       LIMIT 500`,
      [req.user.id]
    )).rows;
    // The count matches what the page is showing: demo feeds only count on
    // a demo page.
    const feeds = (await pool.query(
      'SELECT count(*)::int AS n FROM feeds WHERE user_id = $1' + (demo ? '' : ' AND NOT is_demo'),
      [req.user.id]
    )).rows[0].n;
    res.json({ demo, feeds, posts });
  } catch (err) {
    console.warn('GET /api/posts failed: ' + ((err && err.message) || err));
    res.status(500).json({ error: 'load_failed' });
  }
});

app.get('/api/feeds', async (req, res) => {
  if (!req.user) return res.json({ feeds: [] });
  // Demo feeds live in the demo world only: the Feeds sheet shows them on
  // a demo page, never on a plain one.
  const demo = IS_STAGING && req.query.demo === '1';
  const feeds = (await pool.query(
    'SELECT id, url, title, site_url, is_demo, last_error FROM feeds WHERE user_id = $1' +
      (demo ? '' : ' AND NOT is_demo') + ' ORDER BY created_at',
    [req.user.id]
  )).rows;
  res.json({ feeds });
});

app.post('/api/feeds', async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  if (!/^https?:\/\/\S+\.\S+/i.test(url)) return res.status(422).json({ error: 'not_a_feed' });
  let parsed;
  try {
    const { text } = await safeFetch(url);
    parsed = parseFeed(text);
  } catch (err) {
    return res.status(502).json({ error: 'unreachable' });
  }
  if (!parsed) return res.status(422).json({ error: 'not_a_feed' });
  const dup = (await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [req.user.id, url])).rows;
  if (dup.length) return res.status(409).json({ error: 'already_added' });
  const inserted = (await pool.query(
    'INSERT INTO feeds (user_id, url, title, site_url) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.user.id, url, parsed.title || 'Untitled feed', parsed.siteUrl]
  )).rows[0];
  await upsertPosts(inserted.id, parsed.items, false);
  res.json({ id: inserted.id, title: parsed.title });
});

app.delete('/api/feeds/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  const found = (await pool.query('SELECT id, url, is_demo FROM feeds WHERE id = $1 AND user_id = $2',
    [id, req.user.id])).rows[0];
  if (!found) return res.status(404).json({ error: 'not_found' });
  if (found.is_demo) {
    // A removed demo feed stays removed on the next demo load.
    await pool.query('INSERT INTO demo_removed_feeds (user_id, url) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, found.url]);
  }
  await pool.query('DELETE FROM feeds WHERE id = $1', [id]); // cascades to posts and reads
  res.json({ ok: true });
});

// Idempotent, and only for a post in one of the member's own feeds.
app.post('/api/posts/:id/read', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  await pool.query(
    `INSERT INTO post_reads (user_id, post_id)
     SELECT $1, $2
     WHERE EXISTS (
       SELECT 1 FROM posts p JOIN feeds f ON f.id = p.feed_id WHERE p.id = $2 AND f.user_id = $1
     )
     ON CONFLICT DO NOTHING`,
    [req.user.id, id]
  );
  res.json({ ok: true });
});

// ── Staging demo (?demo=1) ────────────────────────────────────────────────
// Written only on staging, only for the viewing account, only when the page
// asks with ?demo=1. Idempotent: every write is ON CONFLICT DO NOTHING, so
// reloads change nothing, and what the viewer read or removed stays that
// way. Everything is invented and obviously fake.

const DEMO_FEEDS = [
  {
    url: 'https://staging-demo.invalid/pixel-lantern/feed.xml',
    title: 'Pixel Lantern',
    site: 'https://staging-demo.invalid/pixel-lantern',
    posts: [
      { guid: 'pl-one-lens', h: 0.3, author: 'Rae Fictional', title: 'Shooting city nights with one lens',
        body: 'For one week I left every lens at home except a 35mm. The first night was frustrating, the third was freeing.\n\nYou stop swapping glass and start walking further. Every picture here was made within twenty minutes of a tram stop.' },
      { guid: 'pl-histogram', h: 5, author: 'Casey Placeholder', title: 'Why your histogram lies a little',
        body: 'The histogram on the back of your camera describes the JPEG preview, not the raw file. If you shoot raw, up to a stop of headroom is hiding at the right edge.\n\nLearn to read the blinkies instead, and expose for what you will recover later.' },
      { guid: 'pl-window-light', h: 27, author: 'Rae Fictional', title: 'A short field guide to window light',
        body: 'North-facing windows give you the same soft light all day, which is why painters loved them. South-facing ones give you drama by the hour.\n\nMove your subject a metre and you have a new portrait. The floor is a fill card.' },
      { guid: 'pl-one-button', h: 52, author: 'Pat Example', title: 'The one-button camera experiment',
        body: 'A camera with one button and no menu sounds like a gimmick until you hand it to someone who has never taken a picture they liked.\n\nTwelve of thirteen people in our test made something worth keeping.' },
      { guid: 'pl-slides', h: 96, author: 'Sam Sample', title: 'Scanning old slides on a kitchen table',
        body: 'A light panel, a bracket and a macro lens beat most flatbeds, and the whole rig costs less than a night out.\n\nDust first, shoot raw, and flip the curves later. The slides from 1974 held up better than the film from 2004.' },
    ],
  },
  {
    url: 'https://staging-demo.invalid/weeknight-kitchen/feed.xml',
    title: 'Weeknight Kitchen',
    site: 'https://staging-demo.invalid/weeknight-kitchen',
    posts: [
      { guid: 'wk-five-ingredient', h: 1.5, author: 'Alex Pretend', title: 'A five-ingredient dinner that isn’t sad',
        body: 'Sausage, a tin of beans, one lemon, whatever greens are left, and good olive oil. That is the whole list.\n\nThe trick is browning the sausage properly and dressing the greens while the pan is still hot.' },
      { guid: 'wk-rice', h: 21, author: 'Rae Fictional', title: 'The best way to cook rice on the stove',
        body: 'A tested method with exact water ratios for short, medium and long grain, and one rule that never changes: once it boils, the lid stays on.\n\nRest it off the heat for ten minutes. Fluff with a fork, never a spoon.' },
      { guid: 'wk-pasta-water', h: 45, author: 'Casey Placeholder', title: 'How salty should pasta water be',
        body: 'Seasoned cooks say the sea. Tests say about one percent by weight, which is noticeably less salty than the sea.\n\nSauce carries most of the seasoning. Salty water is for the noodle itself.' },
      { guid: 'wk-bread', h: 78, author: 'Pat Example', title: 'Why your bread is dense, and how to fix it',
        body: 'Under-proofing is the usual cause. Look for these three signs before baking: the dough has risen about half again, wobbles like set custard, and a poked dent springs back slowly.\n\nA cooler kitchen just means a longer proof. Give it the time.' },
      { guid: 'wk-knife', h: 120, author: 'Sam Sample', title: 'A cheap knife, sharpened well',
        body: 'A sharp modest knife outcuts a dull expensive one every time. Twenty minutes with a stone and every knife in the drawer is a better knife.\n\nStart on the coarse stone only when the edge is truly gone.' },
    ],
  },
  {
    url: 'https://staging-demo.invalid/odd-maps/feed.xml',
    title: 'Odd Maps Daily',
    site: 'https://staging-demo.invalid/odd-maps',
    posts: [
      { guid: 'om-lighthouses', h: 2, author: 'Rae Fictional', title: 'A map of every lighthouse still staffed',
        body: 'Fewer than thirty remain, and one keeper explains what a night shift looks like. Most sit on rock nobody would build on today.\n\nThe map clusters them where fog does, not where ships do.' },
      { guid: 'om-timezones', h: 30, author: 'Casey Placeholder', title: 'Why time zones bend around islands',
        body: 'Kiribati moved the whole country a day forward in 1995 so a single country would not span two dates. The line still dips around it like a ribbon.\n\nPolitics drew these lines, not geometry.' },
      { guid: 'om-paper-map', h: 55, author: 'Pat Example', title: 'The quiet return of the paper map',
        body: 'Sales of printed atlases are up for the third year running. People say they buy them for the trips where the phone dies.\n\nCity maps sell better than road atlases, and folding one back is still the hard part.' },
      { guid: 'om-borders', h: 74, author: 'Alex Pretend', title: 'Drawing borders with a ruler and a grudge',
        body: 'Some of the straightest lines on any map were drawn in a room far from the terrain, in an afternoon, with a ruler.\n\nThis week: three borders you can walk across without noticing, and one you can see from space.' },
      { guid: 'om-bus-stop', h: 110, author: 'Sam Sample', title: 'The loneliest bus stop in Europe',
        body: 'It runs twice a week, has no road to it, and serves a farmhouse and a chapel. Someone fights for it at every budget meeting.\n\nThe timetable is handwritten. The bus is always full.' },
    ],
  },
  {
    url: 'https://staging-demo.invalid/keyboard-corner/feed.xml',
    title: 'Keyboard Corner',
    site: 'https://staging-demo.invalid/keyboard-corner',
    posts: [
      { guid: 'kc-shortcuts', h: 4, author: 'Casey Placeholder', title: 'Notes on the new keyboard shortcuts',
        body: 'A short list of the changes that actually matter for daily use, and the two that will trip you up for a week.\n\nThe rest is muscle memory retraining itself. Give it until Friday.' },
      { guid: 'kc-split', h: 26, author: 'Rae Fictional', title: 'Split keyboards for people with small desks',
        body: 'You do not need a 75 centimetre board to go split. Two tenkeyless halves, a tenting kit, and a desk that forgives cables.\n\nShoulders report in by day three: fewer complaints.' },
      { guid: 'kc-lubing', h: 50, author: 'Alex Pretend', title: 'Lubing switches without a lab coat',
        body: 'A brush, a pot of the right grease, an afternoon and a podcast. The result is quieter, not faster, and that is the point.\n\nSkip the springs unless you know what you want.' },
      { guid: 'kc-keycaps', h: 80, author: 'Sam Sample', title: 'The case for a boring keycap set',
        body: 'Blank grey caps look stern but read fine, wear evenly and cost a third of the artful ones.\n\nLegends fade on the cheap sets anyway. The fingers learn the map regardless.' },
      { guid: 'kc-arrow-keys', h: 100, author: 'Pat Example', title: 'One week without arrow keys',
        body: 'A layer with hjkl, a week of fumbling, and then something clicks: the hands stop travelling.\n\nI switched back for two games and immediately noticed the reaching.' },
    ],
  },
  {
    url: 'https://staging-demo.invalid/soup-season/feed.xml',
    title: 'Soup Season',
    site: 'https://staging-demo.invalid/soup-season',
    posts: [
      { guid: 'ss-twelve', h: 3, author: 'Alex Pretend', title: 'Twelve soups for the first cold week',
        body: 'Lentil, miso, white bean and more, all done in under an hour. Several are one pot and one pan of bread.\n\nStart with the lentil. It forgives everything.' },
      { guid: 'ss-lentil', h: 24, author: 'Rae Fictional', title: 'Lentil soup that doesn’t taste like punishment',
        body: 'Brown lentils, one onion, a carrot, cumin toasted until it smells like a market, and lemon at the end, not the start.\n\nBlend half, leave half. Texture is the whole meal.' },
      { guid: 'ss-miso', h: 47, author: 'Casey Placeholder', title: 'A miso soup for Tuesday nights',
        body: 'Dashi from a jar is fine. Tofu cut small, one scallion, and the miso stirred in off the boil so it stays round.\n\nTen minutes, one pot, and the kettle does half the work.' },
      { guid: 'ss-white-bean', h: 72, author: 'Sam Sample', title: 'White bean, lemon, and too much parsley',
        body: 'The bunch of parsley wilting in the drawer is exactly what this soup is for. Beans, stock, rind of the lemon, and the greens at the end.\n\nA slice of toast on the bottom. Do not skip it.' },
      { guid: 'ss-freezing', h: 105, author: 'Pat Example', title: 'Freezing soup without losing the texture',
        body: 'Cool it fast, leave out the dairy and the pasta, and freeze flat in bags. Cream and noodles go in when it is reheated.\n\nLabel everything. January you will not remember February’s cleverness.' },
    ],
  },
];

// Three demo posts are pre-read on the first insert only.
const DEMO_PRE_READ = new Set(['pl-one-button', 'om-timezones', 'kc-arrow-keys']);

async function writeDemoData(userId, now) {
  for (const feed of DEMO_FEEDS) {
    const removed = (await pool.query(
      'SELECT 1 FROM demo_removed_feeds WHERE user_id = $1 AND url = $2', [userId, feed.url]
    )).rows.length;
    if (removed) continue;
    const ins = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, is_demo)
       VALUES ($1, $2, $3, $4, TRUE) ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
      [userId, feed.url, feed.title, feed.site]
    );
    const feedId = ins.rows.length ? ins.rows[0].id
      : (await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [userId, feed.url])).rows[0].id;
    for (const p of feed.posts) {
      const published = new Date(now.getTime() - p.h * 3600 * 1000);
      const bodyText = p.body;
      const post = await pool.query(
        `INSERT INTO posts (feed_id, guid, title, link, author, published_at, excerpt, body_text, is_demo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
         ON CONFLICT (feed_id, guid) DO NOTHING RETURNING id`,
        [feedId, p.guid, p.title, feed.site + '/' + p.guid, p.author, published,
          bodyText.slice(0, 300), bodyText]
      );
      if (post.rows.length && DEMO_PRE_READ.has(p.guid)) {
        await pool.query(
          'INSERT INTO post_reads (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [userId, post.rows[0].id]
        );
      }
    }
  }
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
  await bootSchema();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  return server;
}

// Stop listening, let in-flight requests finish (at most ~3 s), close the
// database pool, then exit.
function shutDown(server) {
  let done = false;
  const finish = () => { if (!done) { done = true; pool.end().finally(() => process.exit(0)); } };
  server.close(finish);
  setTimeout(() => {
    server.closeAllConnections && server.closeAllConnections();
    finish();
  }, 3000).unref();
}

start().then((server) => {
  process.on('SIGTERM', () => shutDown(server));
  process.on('SIGINT', () => shutDown(server));
}).catch(err => { console.error(err); process.exit(1); });
