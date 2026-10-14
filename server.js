const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
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

// ── Feed fetching ─────────────────────────────────────────────────────────
// Every address a person typed (and every redirect it follows) is fetched
// through a guard: http or https only, DNS resolved by us, the connection
// made to a checked address and refused for loopback, private, link-local,
// CGNAT and metadata ranges (IPv4 and IPv6). At most 3 redirects, each
// re-checked, a 10 s timeout and a 2 MB body limit.

const blocklist = new net.BlockList();
for (const [subnet, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocklist.addSubnet(subnet, bits, 'ipv4');
blocklist.addAddress('255.255.255.255', 'ipv4');
for (const [subnet, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
]) {
  try { blocklist.addSubnet(subnet, bits, 'ipv6'); } catch {}
}
// No ::ffff:0:0/96 here: node normalises every IPv4 address to its mapped
// form for comparison, so that subnet would block all of IPv4. An address
// written as ::ffff:a.b.c.d is checked through blockedIp instead.

function blockedIp(ip) {
  let addr = String(ip);
  // An IPv4 address in IPv6 form: check the IPv4 half.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) addr = mapped[1];
  const version = net.isIP(addr);
  if (!version) return true;
  try {
    return blocklist.check(addr, version === 4 ? 'ipv4' : 'ipv6');
  } catch { return true; }
}

// dns.lookup stand-in passed to http/https: resolves the hostname, then
// refuses to hand back any address the connection may not go to. This is
// what makes the connection go to a checked address rather than one DNS
// could have changed between the check and the connect. The caller's
// family and hints (node passes ADDRCONFIG, which leaves out IPv6 when the
// host has no IPv6 route) are honoured so the pick is one we can reach.
function guardedLookup(hostname, opts, cb) {
  dns.lookup(hostname, {
    all: true,
    verbatim: true,
    family: (opts && Number(opts.family)) || 0,
    hints: (opts && Number(opts.hints)) || 0,
  }).then((list) => {
    const ok = list.filter((a) => !blockedIp(a.address));
    if (!ok.length) return cb(fetchError('blocked', 'That address is not allowed.'));
    // Node asks for both lookup callback shapes: an array of addresses when
    // it passes `all: true`, a single one otherwise.
    if (opts && opts.all) return cb(null, ok);
    const want = Number(opts && opts.family);
    const pick = ok.find((a) => (want === 4 || want === 6) && a.family === want) || ok[0];
    cb(null, pick.address, pick.family);
  }).catch(cb);
}

const MAX_BODY = 2 * 1024 * 1024;
function fetchError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

// GET one address with the guard above. Resolves { body, finalUrl } or
// rejects with e.code = 'blocked' | 'not_feed' | 'unreachable'.
function guardedGet(urlStr, depth = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(fetchError('not_feed', 'Not an address.')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(fetchError('blocked', 'Only http and https addresses work.'));
    }
    // An IP literal never reaches the lookup below: net.connect uses a
    // hostname's lookup result, but connects to an IP literal directly.
    // Check literals here.
    const literal = u.hostname.startsWith('[')
      ? u.hostname.slice(1, -1)
      : u.hostname;
    if (net.isIP(literal) && blockedIp(literal)) {
      return reject(fetchError('blocked', 'That address is not allowed.'));
    }
    const req = (u.protocol === 'https:' ? https : http).get(u, {
      lookup: guardedLookup,
      timeout: 10_000,
      headers: {
        // Name the reader and accept feeds, so picky servers send XML.
        'User-Agent': 'RSSReader/1.0 (Homeroom app)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (depth >= 3) return reject(fetchError('unreachable', 'Too many redirects.'));
        const loc = res.headers.location;
        if (!loc) return reject(fetchError('unreachable', 'Redirect without an address.'));
        const next = new URL(loc, u);
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return reject(fetchError('blocked', 'Only http and https addresses work.'));
        }
        return resolve(guardedGet(next.toString(), depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(fetchError('unreachable', 'The address answered ' + res.statusCode + '.'));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy();
          reject(fetchError('unreachable', 'The response was too large.'));
        } else chunks.push(c);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks), finalUrl: u.toString() }));
    });
    req.on('timeout', () => { req.destroy(); reject(fetchError('unreachable', 'The address timed out.')); });
    req.on('error', (e) => reject(fetchError('unreachable', e.message)));
  });
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // Keep numbers as strings: a guid of "1234" is text, not a number.
  parseTagValue: false,
  parseAttributeValue: false,
});

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v['#text'] === 'string') return v['#text'];
  return '';
}

function stripHtml(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => safeCodePoint(Number(d)))
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeCodePoint(n) {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
    ? String.fromCodePoint(n) : ' ';
}

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

// Atom links: <link href="…" rel="alternate"/> or <link href="…"/>.
function atomLink(links) {
  const list = Array.isArray(links) ? links : links ? [links] : [];
  for (const l of list) {
    if (l && typeof l === 'object' && l['@_href'] && (!l['@_rel'] || l['@_rel'] === 'alternate')) {
      return String(l['@_href']);
    }
  }
  return '';
}

const asArray = (v) => (Array.isArray(v) ? v : v != null ? [v] : []);

// Recognise RSS 2.0, RSS 1.0 (RDF) and Atom, or return null: not a feed.
function extractFeed(doc) {
  const rss = doc.rss;
  const rdf = doc['rdf:RDF'] || doc.RDF;
  const atom = doc.feed;
  if (rss && rss.channel) {
    const ch = Array.isArray(rss.channel) ? rss.channel[0] : rss.channel;
    const items = asArray(ch.item).map((it) => {
      const link = textOf(it.link);
      return {
        guid: textOf(it.guid) || link,
        title: textOf(it.title),
        link,
        summary: stripHtml(textOf(it.description) || textOf(it['content:encoded'])),
        publishedAt: parseDate(textOf(it.pubDate) || textOf(it['dc:date'])),
      };
    });
    return { title: textOf(ch.title), siteUrl: textOf(ch.link), items };
  }
  if (atom) {
    const entries = asArray(atom.entry).map((e) => {
      const link = atomLink(e.link);
      return {
        guid: textOf(e.id) || link,
        title: textOf(e.title),
        link,
        summary: stripHtml(textOf(e.summary) || textOf(e.content)),
        publishedAt: parseDate(textOf(e.published) || textOf(e.updated)),
      };
    });
    return { title: textOf(atom.title), siteUrl: atomLink(atom.link), items: entries };
  }
  if (rdf) {
    const ch = rdf.channel ? (Array.isArray(rdf.channel) ? rdf.channel[0] : rdf.channel) : {};
    const items = asArray(rdf.item).map((it) => {
      const link = textOf(it.link);
      return {
        guid: (typeof it['@_rdf:about'] === 'string' ? it['@_rdf:about'] : '') || link,
        title: textOf(it.title),
        link,
        summary: stripHtml(textOf(it.description)),
        publishedAt: parseDate(textOf(it['dc:date'])),
      };
    });
    return { title: textOf(ch.title), siteUrl: textOf(ch.link), items };
  }
  return null;
}

// Fetch one address and read it as a feed. Throws with e.code:
// 'not_feed' (parsed but not RSS/Atom), 'unreachable', 'blocked'.
async function fetchFeed(urlStr) {
  const resp = await guardedGet(urlStr);
  let doc;
  try {
    doc = xmlParser.parse(resp.body.toString('utf8'));
  } catch {
    throw fetchError('not_feed', 'That address is not a feed.');
  }
  const feed = extractFeed(doc);
  if (!feed) throw fetchError('not_feed', 'That address is not a feed.');
  return feed;
}

// ── Database ──────────────────────────────────────────────────────────────

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      site_url TEXT,
      is_demo BOOLEAN NOT NULL DEFAULT false,
      last_error TEXT,
      last_fetched_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, url)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id BIGSERIAL PRIMARY KEY,
      feed_id BIGINT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      title TEXT,
      link TEXT,
      summary TEXT,
      published_at TIMESTAMPTZ NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (feed_id, guid)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS posts_feed_published ON posts (feed_id, published_at DESC)`);
  // Both tables hold one person's own reading: private in staging.
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE posts IS 'staging:private'`);
  // Remembers that a viewer's ?demo=1 preview was seeded, so a removed demo
  // feed stays removed on the next visit.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_seeds (
      user_id TEXT PRIMARY KEY,
      seeded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await pool.query(`COMMENT ON TABLE demo_seeds IS 'staging:private'`);
}

function clamp(s, n) { return String(s || '').slice(0, n); }

// Store a feed's parsed items. guid falls back to the link, then to a hash
// of the title, so a feed with neither still dedupes between refreshes.
async function storeItems(feedId, items, now) {
  for (const it of items) {
    let guid = clamp(it.guid, 500);
    const link = /^https?:\/\//i.test(String(it.link || '')) ? clamp(it.link, 2048) : null;
    if (!guid) guid = link || '';
    if (!guid) {
      guid = crypto.createHash('sha1')
        .update(clamp(it.title, 200) + '|' + (it.publishedAt ? it.publishedAt.toISOString() : ''))
        .digest('hex');
    }
    const published = it.publishedAt || now;
    const title = clamp(stripHtml(it.title), 500);
    const summary = clamp(it.summary, 10_000);
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, summary, published_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedId, guid, title, link, summary, published, now],
    );
  }
}

async function refreshFeed(feed, now) {
  try {
    const parsed = await fetchFeed(feed.url);
    await storeItems(feed.id, parsed.items, now);
    await pool.query('UPDATE feeds SET last_error = NULL, last_fetched_at = $2 WHERE id = $1', [feed.id, now]);
    return null;
  } catch (e) {
    await pool.query('UPDATE feeds SET last_error = $2, last_fetched_at = $3 WHERE id = $1',
      [feed.id, clamp(e.message, 300), now]);
    return feed.title;
  }
}

// ── Staging demo (?demo=1) ────────────────────────────────────────────────
// Only when IS_STAGING and the request says demo=1. Seeds the viewer's own
// six made-up feeds once, with fixed guids and ON CONFLICT DO NOTHING, so a
// reload changes nothing and the viewer's reads and removals stay.

const DEMO_FEEDS = [
  { slug: 'pocket-tech', title: 'Pocket Tech' },
  { slug: 'small-kitchen', title: 'Small Kitchen' },
  { slug: 'slow-software', title: 'Slow Software' },
  { slug: 'field-notes', title: 'Field Notes' },
  { slug: 'harbour-weekly', title: 'Harbour Weekly' },
  { slug: 'night-sky-notes', title: 'Night Sky Notes' },
];

// hours: how long ago, in hours from "now"; read: already read.
const DEMO_POSTS = [
  { slug: 'pocket-tech', hours: 0.7, title: 'The quiet return of the dumbphone', summary: 'Sales of basic handsets are up for a third year as people look for ways to switch off.' },
  { slug: 'small-kitchen', hours: 2, title: 'Why your focaccia needs more water than you think', summary: 'A wetter dough gives the open, glossy crumb. Here is how to handle it without a mess.' },
  { slug: 'slow-software', hours: 3, title: 'Notes on a smaller, faster text editor', summary: 'A week with an editor that opens instantly and does very little else, and why that was enough.' },
  { slug: 'field-notes', hours: 5, title: 'A map of every lighthouse still staffed', summary: 'Fewer than twenty keepers remain worldwide. Their stories, and where to find them.' },
  { slug: 'harbour-weekly', hours: 7, read: true, title: 'The ferry schedule gets its first autumn change', summary: 'Two early sailings move an hour later from next Monday, and the pier kiosk reopens for the season.' },
  { slug: 'pocket-tech', hours: 26, title: 'Handheld consoles are getting weirdly good', summary: 'Battery life is the new spec race, and the newest models finally last a full flight.' },
  { slug: 'small-kitchen', hours: 30, read: true, title: 'The best way to cook a weeknight rice', summary: 'Rinse, rest, and trust the lid. A method that works every time.' },
  { slug: 'field-notes', hours: 33, title: 'What a hundred-year-old seed vault teaches us', summary: 'Inside the cold room where forgotten varieties wait for a second chance.' },
  { slug: 'slow-software', hours: 36, title: 'On the slow death of the home screen widget', summary: 'Why the most promising idea in phone design never quite found its audience.' },
  { slug: 'night-sky-notes', hours: 38, title: 'Where to watch the meteor shower on Thursday', summary: 'A moonless evening and a clear eastern horizon make this week\'s shower worth setting an alarm for.' },
  { slug: 'harbour-weekly', hours: 40, read: true, title: 'Tide tables for the week ahead', summary: 'Spring tides bring the water in high and send it out far, with the low mid-afternoon.' },
  { slug: 'night-sky-notes', hours: 51, title: 'A beginner\'s map of the autumn constellations', summary: 'Four easy star patterns point the way to everything else in the northern sky this season.' },
  { slug: 'field-notes', hours: 56, title: 'The trail crew that rebuilt a mountain path by hand', summary: 'No machines, just shovels and patience. Six weeks of work on a path thousands will walk.' },
  { slug: 'pocket-tech', hours: 74, title: 'What repairable laptops mean for your next buy', summary: 'A score for how easy a machine is to fix is finally showing up on the box.' },
  { slug: 'small-kitchen', hours: 78, read: true, title: 'A cake that needs no oven at all', summary: 'Biscuits, cream and a night in the fridge. The summer dessert that never heats the kitchen.' },
  { slug: 'slow-software', hours: 81, title: 'Why my note file is one big text file', summary: 'Ten years of notes in a single plain file, searched instead of sorted, still works.' },
  { slug: 'harbour-weekly', hours: 100, read: true, title: 'The harbour seal that adopted a pontoon', summary: 'A regular visitor has claimed the north float, to the delight of morning rowers.' },
  { slug: 'night-sky-notes', hours: 103, title: 'How to photograph the moon with a phone', summary: 'Steady the phone, tap to focus on the disc, and drop the brightness. That is most of it.' },
  { slug: 'field-notes', hours: 123, title: 'Counting butterflies in a city park', summary: 'Volunteers walked the same loop every week all summer. The counts tell a quiet story.' },
  { slug: 'slow-software', hours: 126, read: true, title: 'In defence of the release notes nobody reads', summary: 'A good changelog is a diary of care. A few projects still write theirs by hand.' },
];

async function seedDemo(userId, now) {
  const claimed = await pool.query(
    'INSERT INTO demo_seeds (user_id, seeded_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING RETURNING user_id',
    [userId, now],
  );
  if (!claimed.rowCount) return; // already seeded: keep the viewer's reads and removals
  const ids = {};
  for (const f of DEMO_FEEDS) {
    const url = 'https://demo-homeroom.example/feeds/' + f.slug + '.xml';
    const ins = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, is_demo, last_fetched_at, created_at)
       VALUES ($1, $2, $3, $4, true, $5, $5) ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
      [userId, url, f.title, 'https://demo-homeroom.example/' + f.slug, now],
    );
    ids[f.slug] = ins.rows[0] ? ins.rows[0].id
      : (await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [userId, url])).rows[0].id;
  }
  let n = 0;
  for (const p of DEMO_POSTS) {
    n += 1;
    const published = new Date(now.getTime() - p.hours * 3600_000);
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, summary, published_at, read_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (feed_id, guid) DO NOTHING`,
      [
        ids[p.slug], 'demo-post-' + String(n).padStart(2, '0'),
        p.title, 'https://demo-homeroom.example/' + p.slug + '/' + n,
        p.summary, published, p.read ? published : null, now,
      ],
    );
  }
}

// ── API ───────────────────────────────────────────────────────────────────

const demoRequested = (req) => IS_STAGING && req.query.demo === '1';

app.get('/api/posts', async (req, res) => {
  if (!req.user) {
    // Guests look around read-only: an empty list, nothing stored.
    return res.json({ posts: [], feed_count: 0, failed_feeds: [], updated_at: null, demo: false, now: req.now.toISOString() });
  }
  const uid = String(req.user.id);
  const demo = demoRequested(req);
  try {
    if (demo) await seedDemo(uid, req.now);
    const feeds = (await pool.query(
      'SELECT id, url, title FROM feeds WHERE user_id = $1 AND NOT is_demo', [uid],
    )).rows;
    // Refresh in parallel; a feed that fails sets its own error and does not
    // stop the others.
    const failed = (await Promise.all(feeds.map((f) => refreshFeed(f, req.now)))).filter(Boolean);
    const posts = (await pool.query(
      `SELECT p.id, p.title, p.link, p.summary, p.published_at, p.read_at, f.title AS feed_title
         FROM posts p JOIN feeds f ON f.id = p.feed_id
        WHERE f.user_id = $1 AND p.read_at IS NULL ${demo ? '' : 'AND NOT f.is_demo'}
        ORDER BY p.published_at DESC`,
      [uid],
    )).rows;
    const count = (await pool.query(
      'SELECT count(*)::int AS n FROM feeds WHERE user_id = $1' + (demo ? '' : ' AND NOT is_demo'), [uid],
    )).rows[0].n;
    const updated = (await pool.query(
      'SELECT max(last_fetched_at) AS t FROM feeds WHERE user_id = $1' + (demo ? '' : ' AND NOT is_demo'), [uid],
    )).rows[0].t;
    return res.json({
      posts, feed_count: count, failed_feeds: failed,
      updated_at: (updated || req.now).toISOString(), demo, now: req.now.toISOString(),
    });
  } catch (e) {
    console.error('GET /api/posts failed: ' + e.message);
    return res.status(500).json({ error: 'Could not load your posts.' });
  }
});

app.post('/api/posts/:id/read', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad post id.' });
  try {
    const r = await pool.query(
      `UPDATE posts SET read_at = $2
         FROM feeds WHERE posts.feed_id = feeds.id AND posts.id = $1 AND feeds.user_id = $3
         RETURNING posts.id`,
      [id, req.now, String(req.user.id)],
    );
    if (!r.rowCount) return res.status(404).json({ error: 'No such post.' });
    return res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/posts/:id/read failed: ' + e.message);
    return res.status(500).json({ error: 'Could not mark that post read.' });
  }
});

app.get('/api/feeds', async (req, res) => {
  if (!req.user) return res.json({ feeds: [] });
  const demo = demoRequested(req);
  try {
    const feeds = (await pool.query(
      `SELECT id, url, title, site_url, last_error FROM feeds
        WHERE user_id = $1 ${demo ? '' : 'AND NOT is_demo'} ORDER BY created_at DESC`,
      [String(req.user.id)],
    )).rows;
    return res.json({ feeds });
  } catch (e) {
    console.error('GET /api/feeds failed: ' + e.message);
    return res.status(500).json({ error: 'Could not load your feeds.' });
  }
});

app.post('/api/feeds', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const uid = String(req.user.id);
  const url = clamp(typeof req.body?.url === 'string' ? req.body.url.trim() : '', 2048);
  if (!url) return res.status(400).json({ error: 'Enter the feed\'s address.' });
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch {
    return res.status(400).json({ error: 'That does not look like an address.' });
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only http and https addresses work.' });
  }
  try {
    const dup = await pool.query('SELECT 1 FROM feeds WHERE user_id = $1 AND url = $2', [uid, url]);
    if (dup.rowCount) return res.status(409).json({ error: 'That feed is already in your list.' });
    const parsed = await fetchFeed(url);
    const ins = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, is_demo, last_fetched_at, created_at)
       VALUES ($1, $2, $3, $4, false, $5, $5) RETURNING id`,
      [uid, url, clamp(parsed.title, 200) || 'Untitled feed', clamp(parsed.siteUrl, 2048) || null, req.now],
    );
    const feedId = ins.rows[0].id;
    await storeItems(feedId, parsed.items, req.now);
    const feed = (await pool.query('SELECT id, url, title, site_url FROM feeds WHERE id = $1', [feedId])).rows[0];
    return res.status(201).json({ feed });
  } catch (e) {
    if (e.code === 'not_feed') return res.status(422).json({ error: 'That address is not a feed.' });
    if (e.code === 'blocked') return res.status(422).json({ error: 'That address is not allowed.' });
    return res.status(502).json({ error: 'Couldn\'t reach that address. Check it and try again.' });
  }
});

app.delete('/api/feeds/:id', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Bad feed id.' });
  try {
    const r = await pool.query(
      'DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, String(req.user.id)],
    );
    if (!r.rowCount) return res.status(404).json({ error: 'No such feed.' });
    return res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/feeds/:id failed: ' + e.message);
    return res.status(500).json({ error: 'Could not remove that feed.' });
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

// ── Boot and shutdown ─────────────────────────────────────────────────────

let server;

async function start() {
  // Schema first: the routes query these tables from the first request on.
  for (let attempt = 1; ; attempt += 1) {
    try { await initDb(); break; } catch (e) {
      if (attempt >= 3) throw e;
      console.warn('database not ready (' + e.message + '), retrying');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

// Stop accepting, drain in-flight requests for about 3 s, close the pool,
// exit. The platform stops the container with SIGTERM on every deploy.
async function shutdown(signal) {
  console.log('Received ' + signal + ', shutting down');
  if (server) {
    if (server.closeIdleConnections) server.closeIdleConnections();
    server.close();
  }
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  try { await pool.end(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => { console.error(err); process.exit(1); });
