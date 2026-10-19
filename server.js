const express = require('express');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
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

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Schema ────────────────────────────────────────────────────────────────
// Both tables are personal data (whose feeds, what someone has read), so
// both are marked staging:private: staging copies the schema, never rows.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      site_url TEXT,
      color SMALLINT NOT NULL DEFAULT 1,
      is_demo BOOLEAN NOT NULL DEFAULT false,
      last_fetched_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url_idx ON feeds (user_id, url)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id BIGSERIAL PRIMARY KEY,
      feed_id BIGINT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT,
      author TEXT,
      published_at TIMESTAMPTZ,
      excerpt TEXT,
      body TEXT,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (feed_id, guid)
    )`);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS posts_feed_published_idx ON posts (feed_id, published_at)');
  await pool.query("COMMENT ON TABLE feeds IS 'staging:private'");
  await pool.query("COMMENT ON TABLE posts IS 'staging:private'");
  // Marks that a viewer's staging demo was already written, so ?demo=1
  // seeds once per account and what the viewer did to the demo rows
  // (opened, removed a feed) stays.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_seed_marks (
      user_id TEXT PRIMARY KEY,
      seeded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query("COMMENT ON TABLE demo_seed_marks IS 'staging:private'");
}

// ── Fetch guard (safeFetch) ───────────────────────────────────────────────
// Every typed feed address goes through here: only http/https, DNS resolved
// and every answer checked against loopback, private, link-local, CGNAT and
// metadata ranges (IPv4 and IPv6), at most 3 redirects followed by hand with
// each hop re-checked, 8 s and 2 MB at most.
const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function ipIsBlocked(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;          // this-host, private, loopback
    if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;           // private
    if (a === 192 && b === 168) return true;                    // private
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT
    return false;
  }
  if (net.isIP(ip) === 6) {
    const low = ip.toLowerCase();
    if (low === '::' || low === '::1') return true;             // unspecified, loopback
    if (/^f[cd]/.test(low)) return true;                        // unique local fc00::/7
    if (/^fe[89ab]/.test(low)) return true;                     // link-local fe80::/10
    const mapped = low.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/); // v4-mapped
    if (mapped) return ipIsBlocked(mapped[1]);
    return false;
  }
  return true; // unparseable addresses are refused, not allowed
}

async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIP(host)) {
    if (ipIsBlocked(host)) throw new Error('That address points inside the network');
    return;
  }
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length) throw new Error('The site could not be found');
  for (const r of records) {
    if (ipIsBlocked(r.address)) throw new Error('That address points inside the network');
  }
}

async function safeFetch(url, redirects = 0) {
  let u;
  try { u = new URL(url); } catch { throw new Error('That is not a valid address'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https addresses work');
  }
  await assertPublicHost(u.hostname);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(u, {
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    });
  } catch {
    throw new Error('The site did not answer');
  } finally {
    clearTimeout(timer);
  }

  if (REDIRECT_STATUSES.has(res.status)) {
    const loc = res.headers.get('location');
    try { if (res.body) res.body.cancel(); } catch {}
    if (!loc) throw new Error('The site did not answer');
    if (redirects >= 3) throw new Error('The site redirected too many times');
    return safeFetch(new URL(loc, u).href, redirects + 1);
  }
  if (!res.ok) throw new Error('The site answered with an error (' + res.status + ')');

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) throw new Error('The feed is too large');
      chunks.push(value);
    }
  } catch (err) {
    if (err && /too large/.test(err.message)) throw err;
    throw new Error('The site did not answer');
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ── Feed parsing (RSS 2.0 and Atom) ───────────────────────────────────────
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
});
const MAX_BODY_CHARS = 20 * 1024;
const EXCERPT_CHARS = 200;

function asArray(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (typeof v === 'object') {
    if (v['#text'] != null) return String(v['#text']).trim();
    if (v['@_href'] != null) return String(v['@_href']).trim();
  }
  return '';
}

function safeLink(u) {
  if (!u) return null;
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null;
  } catch { return null; }
}

function atomLinkHref(links) {
  const arr = asArray(links);
  if (!arr.length) return '';
  const alternate = arr.find(l => l && typeof l === 'object' &&
    (l['@_rel'] === 'alternate' || l['@_rel'] == null));
  const pick = alternate || arr[0];
  return typeof pick === 'string' ? pick : (pick && pick['@_href']) || '';
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function parseFeed(xmlText) {
  let doc;
  try { doc = xmlParser.parse(xmlText); } catch { return null; }
  const channel = doc && doc.rss && doc.rss.channel;
  if (channel) {
    const ch = asArray(channel)[0] || {};
    const items = asArray(ch.item);
    return {
      title: textOf(ch.title),
      siteUrl: safeLink(textOf(ch.link)),
      items: items.map(it => ({
        guid: textOf(it.guid) || textOf(it.link) || textOf(it.title),
        title: textOf(it.title),
        link: safeLink(textOf(it.link)),
        author: textOf(it['dc:creator']) || textOf(it.author),
        published: parseDate(textOf(it.pubDate) || textOf(it['dc:date'])),
        html: textOf(it['content:encoded']) || textOf(it.description),
      })),
    };
  }
  const atom = doc && doc.feed;
  if (atom) {
    return {
      title: textOf(atom.title),
      siteUrl: safeLink(atomLinkHref(atom.link)),
      items: asArray(atom.entry).map(e => ({
        guid: textOf(e.id) || atomLinkHref(e.link) || textOf(e.title),
        title: textOf(e.title),
        link: safeLink(atomLinkHref(e.link)),
        author: e.author ? textOf(e.author.name) || textOf(e.author) : '',
        published: parseDate(textOf(e.published) || textOf(e.updated)),
        html: textOf(e.content) || textOf(e.summary),
      })),
    };
  }
  return null;
}

// Feed text becomes plain paragraphs: nothing from a feed can run inside
// the app, so no markup, no images, and the page renders it via
// textContent only.
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, code) => {
    if (code[0] === '#') {
      const num = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      if (!Number.isFinite(num) || num < 32 || num > 0x10ffff || num === 0x7f) return m;
      try { return String.fromCodePoint(num); } catch { return m; }
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named != null ? named : m;
  });
}

function htmlToParagraphs(html) {
  if (!html) return [];
  let t = String(html);
  t = t.replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
       .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ');
  t = t.replace(/<\s*(?:br|\/p|\/div|\/li|\/h[1-6]|\/blockquote|\/tr)\s*>/gi, '\n\n')
       .replace(/<\s*(?:p|div|li|h[1-6]|blockquote|tr)[^>]*>/gi, '\n\n')
       .replace(/<[^>]+>/g, ' ');
  t = decodeEntities(t);
  return t.split(/\n{2,}/)
    .map(s => s.replace(/[\s ]+/g, ' ').trim())
    .filter(Boolean);
}

function makeExcerpt(paragraphs) {
  const text = paragraphs.join(' ');
  if (text.length <= EXCERPT_CHARS) return text || null;
  const cut = text.slice(0, EXCERPT_CHARS);
  const sp = cut.lastIndexOf(' ');
  return (sp > EXCERPT_CHARS / 2 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

// ── Feed storage ──────────────────────────────────────────────────────────
async function insertPosts(feedId, items) {
  let added = 0;
  for (const it of items) {
    if (!it.guid || !it.title) continue;
    const paragraphs = htmlToParagraphs(it.html);
    const body = paragraphs.join('\n\n');
    const { rowCount } = await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, author, published_at, excerpt, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedId,
       it.guid.slice(0, 512),
       it.title.slice(0, 500),
       it.link,
       it.author ? it.author.slice(0, 200) : null,
       it.published, // falls back to first-seen time (created_at) when null
       makeExcerpt(paragraphs),
       body ? body.slice(0, MAX_BODY_CHARS) : null]);
    added += rowCount;
  }
  return added;
}

async function refreshFeed(feed, now) {
  try {
    const xml = await safeFetch(feed.url);
    const parsed = parseFeed(xml);
    if (!parsed) throw new Error('The address is not an RSS or Atom feed');
    await insertPosts(feed.id, parsed.items);
    await pool.query('UPDATE feeds SET last_fetched_at = $2, last_error = NULL WHERE id = $1',
      [feed.id, now]);
    return true;
  } catch (err) {
    await pool.query('UPDATE feeds SET last_fetched_at = $2, last_error = $3 WHERE id = $1',
      [feed.id, now, String(err.message || 'Could not refresh').slice(0, 300)]);
    return false;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────
// Everything is scoped to req.user.id. Guests (no account) get empty
// lists from the GETs and the middleware's 401 on every write.

app.get('/api/posts', async (req, res) => {
  const uid = req.user ? req.user.id : null;
  if (!uid) {
    return res.json({ posts: [], feed_count: 0, unread_count: 0,
      last_refreshed_at: null, failed_feeds: 0, demo: false });
  }
  const demo = IS_STAGING && req.query.demo === '1';
  if (demo) await seedDemo(uid, req.now);

  const { rows } = await pool.query(
    `SELECT p.id, p.title, p.link, p.author, p.published_at, p.excerpt, p.body, p.read_at,
            f.title AS feed_title, f.color AS feed_color, f.site_url
       FROM posts p JOIN feeds f ON f.id = p.feed_id
      WHERE f.user_id = $1 AND p.read_at IS NULL
      ORDER BY COALESCE(p.published_at, p.created_at) DESC
      LIMIT 200`, [uid]);
  const { rows: sums } = await pool.query(
    `SELECT COUNT(*)::int AS feed_count,
            MAX(last_fetched_at) AS last_refreshed_at,
            COUNT(*) FILTER (WHERE last_error IS NOT NULL)::int AS failed_feeds
       FROM feeds WHERE user_id = $1`, [uid]);
  res.json({
    posts: rows,
    feed_count: sums[0].feed_count,
    unread_count: rows.length,
    last_refreshed_at: sums[0].last_refreshed_at,
    failed_feeds: sums[0].failed_feeds,
    demo,
  });
});

app.post('/api/refresh', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, url, last_fetched_at FROM feeds WHERE user_id = $1 AND NOT is_demo',
    [req.user.id]);
  const results = await Promise.all(rows.map(f => refreshFeed(f, req.now)));
  res.json({
    refreshed: results.filter(Boolean).length,
    failed: results.filter(r => !r).length,
  });
});

app.get('/api/feeds', async (req, res) => {
  const uid = req.user ? req.user.id : null;
  if (!uid) return res.json({ feeds: [] });
  const { rows } = await pool.query(
    `SELECT id, url, title, site_url, color, is_demo, last_fetched_at, last_error
       FROM feeds WHERE user_id = $1 ORDER BY created_at ASC, id ASC`, [uid]);
  res.json({ feeds: rows });
});

app.post('/api/feeds', async (req, res) => {
  const raw = req.body && req.body.url;
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(422).json({ error: 'not_a_feed' });
  }
  let url;
  try { url = new URL(raw.trim()); } catch {
    return res.status(422).json({ error: 'not_a_feed' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return res.status(422).json({ error: 'not_a_feed' });
  }

  const existing = await pool.query(
    'SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [req.user.id, url.href]);
  if (existing.rowCount) return res.status(409).json({ error: 'already_following' });

  let parsed;
  try {
    parsed = parseFeed(await safeFetch(url.href));
  } catch (err) {
    return res.status(422).json({ error: 'unreachable', detail: String(err.message || err) });
  }
  if (!parsed || !parsed.items.length || !parsed.title) {
    return res.status(422).json({ error: 'not_a_feed' });
  }

  // The spine colour: the next in turn (1 to 5) per user.
  const { rows: used } = await pool.query(
    'SELECT color FROM feeds WHERE user_id = $1', [req.user.id]);
  const taken = new Set(used.map(r => r.color));
  let color = 1;
  while (color <= 5 && taken.has(color)) color++;
  if (color > 5) color = (used.length % 5) + 1;

  const { rows: inserted } = await pool.query(
    `INSERT INTO feeds (user_id, url, title, site_url, color, last_fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, url, title, site_url, color`,
    [req.user.id, url.href,
     parsed.title.slice(0, 200), parsed.siteUrl, color, req.now]);
  const feed = inserted[0];
  await insertPosts(feed.id, parsed.items);
  res.status(201).json({ feed });
});

app.delete('/api/feeds/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  const { rowCount } = await pool.query(
    'DELETE FROM feeds WHERE id = $1 AND user_id = $2', [id, req.user.id]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true }); // its posts go with it, via ON DELETE CASCADE
});

app.post('/api/posts/:id/read', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  const { rowCount } = await pool.query(
    `UPDATE posts SET read_at = $3
      WHERE id = $1 AND read_at IS NULL
        AND feed_id IN (SELECT id FROM feeds WHERE user_id = $2)`,
    [id, req.user.id, req.now]);
  if (!rowCount) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// ── Staging demo (?demo=1, staging only) ─────────────────────────────────
// The first version's populated preview: the viewer's own five made-up
// feeds with about 14 unread posts from the past week, times relative to
// req.now. Idempotent through the unique keys, so a reload changes
// nothing and what the viewer read stays read. Demo feeds never refresh.
const DEMO_FEEDS = [
  { url: 'https://pastryledger.example/feed.xml', title: 'The Pastry Ledger',
    site: 'https://pastryledger.example', color: 1 },
  { url: 'https://kernelnotes.example/feed.xml', title: 'Kernel Notes',
    site: 'https://kernelnotes.example', color: 2 },
  { url: 'https://fieldguideweekly.example/feed.xml', title: 'Field Guide Weekly',
    site: 'https://fieldguideweekly.example', color: 3 },
  { url: 'https://typeandgrid.example/feed.xml', title: 'Type & Grid',
    site: 'https://typeandgrid.example', color: 4 },
  { url: 'https://balconygarden.example/feed.xml', title: 'Balcony Garden',
    site: 'https://balconygarden.example', color: 5 },
];

const DEMO_POSTS = [
  { feed: 0, guid: 'pastry-laminate', min: 12,
    title: 'Why your laminated dough keeps leaking butter',
    link: 'https://pastryledger.example/posts/laminated-dough-butter',
    paragraphs: [
      'Temperature is usually the culprit, not technique. Butter that warms past 18 degrees seeps into the flour instead of staying in its layers, and no amount of folding afterward puts it back.',
      'A simple fridge schedule fixed it for me: twenty minutes in the freezer between every two turns, and the dough rests overnight before shaping. The layers bake tall instead of pooling at the bottom of the tin.',
    ] },
  { feed: 1, guid: 'kernel-sched', min: 60,
    title: 'Scheduler changes landing in the next release',
    link: 'https://kernelnotes.example/posts/scheduler-next-release',
    paragraphs: [
      'A walk through the patches that reduce latency on busy machines: the run queue gets a shorter memory, and tasks that wake up together are now gathered before they are placed.',
      'Benchmarks on a loaded eight-core box show the tail latency down by a fifth. Nothing changes for single-task workloads, which is exactly the point.',
    ] },
  { feed: 2, guid: 'field-trails', min: 120, author: 'Rowan Example',
    title: 'Ten quiet trails within an hour of the city',
    link: 'https://fieldguideweekly.example/posts/ten-quiet-trails',
    paragraphs: [
      'Most guides send you to the same five summits. These routes trade fame for silence, with clear paths, shade and places to sit.',
      'The first loop starts behind the old reservoir car park and climbs gently through beech woods for two kilometres before opening onto a long grassy ridge. Start early and bring water: only three of the ten have a tap at the trailhead, and none of them sell anything once you are past the gate.',
    ] },
  { feed: 3, guid: 'type-small-text', min: 180,
    title: 'Setting small text so it stays readable',
    link: 'https://typeandgrid.example/posts/setting-small-text',
    paragraphs: [
      'Spacing, weight and size choices for captions and footnotes: small text wants more room between lines, not a smaller face.',
      'The rule I keep coming back to is that a caption should never be set tighter than the text it explains. Give it a little air and it stops looking like an afterthought.',
    ] },
  { feed: 0, guid: 'pastry-proofers', min: 320,
    title: 'An honest review of three home proofing boxes',
    link: 'https://pastryledger.example/posts/proofing-box-review',
    paragraphs: [
      'We tested each overnight with the same sourdough batch, weighing the dough before and after and logging the room temperature every hour.',
      'The mid-priced box won: the cheapest held a steady temperature but ran three degrees warm, and the expensive one spent more effort on its light than its thermostat.',
    ] },
  { feed: 4, guid: 'garden-lettuce', min: 1560,
    title: 'Sowing lettuce in late spring heat',
    link: 'https://balconygarden.example/posts/lettuce-late-spring',
    paragraphs: [
      'Shade cloth, deep watering and which varieties bolt last: lettuce gives up in heat long before the calendar says it should.',
      'Thirty percent shade cloth made the difference on my balcony. Water in the evening, not the morning, and choose oakleaf types, which hold on weeks longer than the crispheads.',
    ] },
  { feed: 1, guid: 'kernel-flame', min: 1680,
    title: 'Reading a flame graph without getting lost',
    link: 'https://kernelnotes.example/posts/reading-flame-graphs',
    paragraphs: [
      'Start at the widest bar and work outward. Everything else is decoration until you know which single frame is eating the time.',
      'The common mistake is chasing the tallest stack. Height only says how deep the call went; width is where the samples piled up.',
    ] },
  { feed: 0, guid: 'pastry-morning-bun', min: 1800,
    title: 'A short history of the morning bun',
    link: 'https://pastryledger.example/posts/morning-bun-history',
    paragraphs: [
      'The morning bun is younger than it pretends to be. The spiral, the orange and the cinnamon all arrive in the last hundred years, in that order.',
      'Before that it was a plain knot of enriched dough sold warm from the baker window, and the accounts books that survive suggest it sold better that way.',
    ] },
  { feed: 2, guid: 'field-boots', min: 3000, author: 'Rowan Example',
    title: 'Mud season: which boots actually dry',
    link: 'https://fieldguideweekly.example/posts/mud-season-boots',
    paragraphs: [
      'We soaked six pairs, walked them dry and timed it. The lesson is that the boot that dries fastest is not the one that keeps water out best, and you must choose.',
      'Rubber dries overnight and breathes never. Treat the choice as two boots for two seasons instead of one boot for all of them.',
    ] },
  { feed: 3, guid: 'type-recipe', min: 3120,
    title: 'Choosing a text face for a recipe site',
    link: 'https://typeandgrid.example/posts/recipe-site-text-face',
    paragraphs: [
      'Recipes are lists wearing a story costume. The type has to survive being read at arm length with wet hands.',
      'That argues for a generous x-height and numerals that line up in a column. Everything else on a recipe page is negotiable; those two things are not.',
    ] },
  { feed: 4, guid: 'garden-herbs', min: 4320,
    title: 'Three herbs that like a windy balcony',
    link: 'https://balconygarden.example/posts/windy-balcony-herbs',
    paragraphs: [
      'Thyme, rosemary and chives shrug off gusts that flatten basil.',
      'The woody herbs came from hillsides and it shows. Give them the windward rail, keep the basil in the lee of the wall, and the whole box evens out.',
    ] },
  { feed: 1, guid: 'kernel-fan', min: 4400,
    title: 'What your fan is telling you',
    link: 'https://kernelnotes.example/posts/what-your-fan-says',
    paragraphs: [
      'A fan that ramps every few minutes on an idle machine is usually a process waking up, not a failing bearing.',
      'Trace the wakeups before you buy anything. In my case it was a log shipper on a thirty-second timer, and a config change bought me the silence back.',
    ] },
  { feed: 0, guid: 'pastry-brown-butter', min: 5760,
    title: 'Brown butter, weighed and measured',
    link: 'https://pastryledger.example/posts/brown-butter-measured',
    paragraphs: [
      'Browning butter loses water, so a cup in is not a cup out. Recipes that swap it one to one end up greasy for a reason.',
      'Weigh before and after and top up with milk to the original weight. It reads fussy until the first batch of cookies comes out with the texture you wanted.',
    ] },
  { feed: 2, guid: 'field-lichen', min: 7200, author: 'Rowan Example',
    title: 'A pocket guide to city lichen',
    link: 'https://fieldguideweekly.example/posts/city-lichen',
    paragraphs: [
      'Lichen is the quietest air quality meter in the city, and it grows on every second wall once you start looking.',
      'Three kinds cover most of it: a pale crust, a leafy rosette and a shrubby tuft. More leafy and shrubby forms mean cleaner air, and a wall of crust only means the opposite.',
    ] },
];

async function seedDemo(uid, now) {
  // Once per viewing account: after this, reloads change nothing and what
  // the viewer did to the demo rows stays.
  const mark = await pool.query(
    'INSERT INTO demo_seed_marks (user_id, seeded_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING',
    [uid, now]);
  if (!mark.rowCount) return;
  for (const f of DEMO_FEEDS) {
    await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, color, is_demo, last_fetched_at)
       VALUES ($1, $2, $3, $4, $5, true, $6) ON CONFLICT (user_id, url) DO NOTHING`,
      [uid, f.url, f.title, f.site, f.color, now]);
  }
  const { rows } = await pool.query(
    'SELECT id, url FROM feeds WHERE user_id = $1 AND is_demo', [uid]);
  const feedIdByUrl = Object.fromEntries(rows.map(r => [r.url, r.id]));
  for (const p of DEMO_POSTS) {
    const feed = DEMO_FEEDS[p.feed];
    const paragraphs = p.paragraphs;
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, author, published_at, excerpt, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedIdByUrl[feed.url], p.guid, p.title, p.link, p.author || null,
       new Date(now.getTime() - p.min * 60000),
       makeExcerpt(paragraphs),
       paragraphs.join('\n\n')]);
  }
}

// ── Static files and the HTML shell ──────────────────────────────────────
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

// ── Start and graceful shutdown ───────────────────────────────────────────
// On shutdown: stop accepting connections, drain about 3 s, close the pool,
// exit.
let server;

function shutdown(signal) {
  console.log(signal + ': shutting down');
  if (!server) process.exit(0);
  server.close(() => { /* drained */ });
  setTimeout(() => {
    pool.end().catch(() => {}).finally(() => process.exit(0));
  }, 3000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
  await ensureSchema();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });
