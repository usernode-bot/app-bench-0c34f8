const express = require('express');
const path = require('path');
const dns = require('dns');
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

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'public')));

// ── Tables ───────────────────────────────────────────────────────────────
// Both tables are private: they hold the feeds a person follows and what
// they have read and saved. Staging copies their schema without the rows.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id bigserial PRIMARY KEY,
      user_id text NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      site_url text,
      color smallint NOT NULL DEFAULT 1,
      is_demo boolean NOT NULL DEFAULT false,
      last_fetched_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, url)
    )`);
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id bigserial PRIMARY KEY,
      feed_id bigint NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid text NOT NULL,
      title text NOT NULL,
      link text,
      excerpt text,
      published_at timestamptz NOT NULL DEFAULT now(),
      read_at timestamptz,
      saved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (feed_id, guid)
    )`);
  await pool.query(`COMMENT ON TABLE posts IS 'staging:private'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS posts_feed_published_idx
    ON posts (feed_id, published_at DESC)`);
}

// ── Fetching a feed safely ───────────────────────────────────────────────
// Every address a person types, and every address a feed redirects to, is
// checked before it is connected to: http(s) only, a public address only,
// and the connection is pinned to the address that was checked.
function isPrivateAddress(ip) {
  if (!ip) return true;
  if (ip.includes(':')) {
    const low = ip.toLowerCase();
    if (low === '::' || low === '::1') return true;
    if (low.startsWith('fe80:') || low.startsWith('fec0:')) return true;
    if (/^f[cd][0-9a-f]{2}:/.test(low)) return true;
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

async function checkedAddress(host) {
  let addrs;
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new FeedError('That address could not be reached.');
  }
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new FeedError('That address is not allowed.');
  }
  return addrs[0].address;
}

class FeedError extends Error {}

const MAX_BODY = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

async function fetchFeedUrl(raw, redirects = 0) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new FeedError('That address is not a valid web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FeedError('Only http and https addresses can be added.');
  }
  if (redirects > MAX_REDIRECTS) {
    throw new FeedError('That address redirected too many times.');
  }
  const address = await checkedAddress(url.hostname);
  const family = address.includes(':') ? 6 : 4;
  const mod = url.protocol === 'https:' ? https : http;
  const result = await new Promise((resolve, reject) => {
    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'user-agent': 'RSS Reader (feed fetcher)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
      },
      timeout: 10_000,
      servername: url.hostname,
      lookup: (hostname, opts, cb) => {
        if (typeof opts === 'function') return opts(null, address, family);
        // Node may ask for every address (happy eyeballs). The connection
        // stays pinned to the one address this request checked.
        if (opts && opts.all) return cb(null, [{ address, family }]);
        cb(null, address, family);
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, url).toString() });
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new FeedError('That feed answered with an error (' + res.statusCode + ').'));
      }
      const type = String(res.headers['content-type'] || '').toLowerCase();
      const chunks = [];
      let size = 0;
      let done = false;
      res.on('data', (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > MAX_BODY) {
          done = true;
          res.destroy();
          return reject(new FeedError('That feed is too large.'));
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (!done) resolve({ body: Buffer.concat(chunks).toString('utf8'), type });
      });
      res.on('error', () => {
        if (!done) { done = true; reject(new FeedError('That feed could not be read.')); }
      });
    });
    req.on('timeout', () => req.destroy(new FeedError('That feed took too long to answer.')));
    req.on('error', (err) => {
      reject(err instanceof FeedError ? err : new FeedError('That address could not be reached.'));
    });
    req.end();
  });
  if (result.redirect) return fetchFeedUrl(result.redirect, redirects + 1);
  return result;
}

// ── Parsing RSS 2.0 and Atom ─────────────────────────────────────────────
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: '#cdata',
  trimValues: true,
});

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function nodeText(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return nodeText(v[0]);
  if (typeof v === 'object') {
    return nodeText(v['#text'] ?? v['#cdata'] ?? '');
  }
  return '';
}

function atomLink(node) {
  const links = asArray(node && node.link);
  const alternate = links.find((l) => l && typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate'));
  const chosen = alternate || links[0];
  if (chosen && typeof chosen === 'object' && chosen['@_href']) return String(chosen['@_href']);
  return nodeText(chosen);
}

function httpLink(value) {
  if (!value) return null;
  try {
    const u = new URL(String(value).trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function plainText(html) {
  return String(html || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : '';
      }
      return ENTITIES[code.toLowerCase()] ?? '';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function excerptOf(html) {
  const text = plainText(html);
  if (!text) return null;
  if (text.length <= 300) return text;
  const cut = text.slice(0, 300);
  const space = cut.lastIndexOf(' ');
  return (space > 200 ? cut.slice(0, space) : cut) + '…';
}

function parseFeed(xml, pageUrl) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new FeedError('That address is not an RSS or Atom feed.');
  }
  let channel;
  let items;
  let atom = false;
  if (doc.rss && doc.rss.channel) {
    channel = doc.rss.channel;
    items = asArray(channel.item);
  } else if (doc.feed) {
    channel = doc.feed;
    items = asArray(doc.feed.entry);
    atom = true;
  } else if (doc['rdf:RDF']) {
    channel = doc['rdf:RDF'].channel || {};
    items = asArray(doc['rdf:RDF'].item);
  } else {
    throw new FeedError('That address is not an RSS or Atom feed.');
  }
  const fallbackHost = (() => {
    try { return new URL(pageUrl).hostname; } catch { return 'Feed'; }
  })();
  const title = nodeText(channel.title).trim() || fallbackHost;
  const siteUrl = atom ? httpLink(atomLink(channel)) : httpLink(nodeText(channel.link));
  const posts = items.slice(0, 50).map((item) => {
    const link = httpLink(atom ? atomLink(item) : nodeText(item.link) || item['@_rdf:about']);
    const guid = nodeText(item.guid) || nodeText(item.id) || link || nodeText(item.title);
    const titleText = nodeText(item.title).trim();
    const excerpt = excerptOf(
      nodeText(item.description) ||
      nodeText(item.summary) ||
      nodeText(item['content:encoded']) ||
      nodeText(item.content)
    );
    const rawDate = nodeText(item.pubDate) || nodeText(item.published) ||
      nodeText(item.updated) || nodeText(item['dc:date']);
    const date = rawDate ? new Date(rawDate) : null;
    return {
      guid: guid ? String(guid) : null,
      title: titleText,
      link,
      excerpt,
      publishedAt: date && !Number.isNaN(date.getTime()) ? date : null,
    };
  }).filter((p) => p.guid && p.title);
  if (!posts.length) {
    throw new FeedError('That feed has no posts in it.');
  }
  return { title, siteUrl, posts };
}

async function fetchAndParse(raw) {
  const { body, type } = await fetchFeedUrl(raw);
  const text = body.replace(/^﻿/, '');
  const looksXml = /^\s*(<\?xml|<rss|<feed|<rdf:RDF)/i.test(text) || type.includes('xml');
  if (!looksXml) {
    throw new FeedError('That address is not an RSS or Atom feed.');
  }
  return parseFeed(text, raw);
}

// ── Demo data (staging only, `?demo=1` only) ─────────────────────────────
// Written for whoever opens the preview, once, so their own likes and
// reads stick. Every address is example.invalid, which never resolves and
// is never fetched; refresh skips demo feeds.
const DEMO_FEEDS = [
  { slug: 'circuit-weekly', title: 'Circuit Weekly' },
  { slug: 'kitchen-notes', title: 'Kitchen Notes' },
  { slug: 'quiet-software', title: 'Quiet Software' },
  { slug: 'space-desk', title: 'Space Desk' },
  { slug: 'nature-notes', title: 'Nature Notes' },
];

const DEMO_POSTS = [
  // Today, unread.
  { f: 0, h: 0.4, guid: 'demo-battery-chemistry', title: 'Why the new battery chemistry might finally reach phones', excerpt: 'Engineers say a silicon-rich anode could add a third more runtime without a bigger cell. The catch is how it behaves after a few hundred charges, and early tests are promising but small.' },
  { f: 1, h: 1, guid: 'demo-roast-potatoes', title: 'The crispiest roast potatoes need one odd step', excerpt: 'Parboil them, yes, but the step most people skip comes before the oven: letting the drained potatoes steam dry for two minutes, then shaking them until the edges roughen.' },
  { f: 2, h: 2, guid: 'demo-quieter-updates', title: 'Notes on a quieter kind of software update', excerpt: 'A small team writes about shipping fewer, larger releases, saying no to feature flags for everything, and keeping a changelog a person can actually read.' },
  { f: 3, h: 4, guid: 'demo-spiral-galaxy', title: 'Telescope spots the earliest spiral galaxy yet', excerpt: 'Astronomers say the galaxy, seen as it was about 12 billion years ago, already had the sweeping arms that were thought to form much later. The team is checking the shape against older images.' },
  { f: 4, h: 5, guid: 'demo-city-foxes', title: 'A field guide to city foxes after dark', excerpt: 'Foxes have learned the quiet hours of a city better than most of us. Here is what to look for on an evening walk, from tracks in a flower bed to the calls that sound almost like a bird.' },
  { f: 1, h: 7, guid: 'demo-sink-heat-pump', title: 'A tiny heat pump that fits under a sink', excerpt: 'An apartment-sized heat pump is being tested in a handful of older buildings. It trades a little power for far less noise, and it does not need a wall drilled through.' },
  // Yesterday, unread.
  { f: 2, h: 15, guid: 'demo-reading-list', title: 'On keeping a personal reading list', excerpt: null },
  { f: 1, h: 19, guid: 'demo-weeknight-dal', title: 'Weeknight dal, three ways', excerpt: 'One pot, three finishes: a fast weeknight version with a pressure cooker, a slower one for a Sunday, and a cold lunch the next day that is almost better than the first.' },
  { f: 3, h: 22, guid: 'demo-suit-fit-checks', title: 'Crew completes suit fit checks for the next moon trip', excerpt: 'The four astronauts spent the week in partial-gravity rigs, checking that they can reach every control in the suit without help. Two more rounds are planned before launch.' },
  { f: 4, h: 26, guid: 'demo-courtyard-garden', title: 'The courtyard garden that waters itself', excerpt: 'A shared courtyard in a block of flats uses a buried wick, a rain barrel and no electricity. Residents say the plants survived a hot summer for the price of some mulch.' },
  // Two days ago, unread.
  { f: 0, h: 40, guid: 'demo-laptop-fan', title: 'Why your laptop fan gets loud in summer', excerpt: null },
  { f: 1, h: 44, guid: 'demo-sourdough-rescue', title: 'Sourdough starter, rescued from the back of the fridge', excerpt: 'A neglected starter can usually be brought back in three feedings. The signs it is worth saving, and the ones that mean it is time to start again.' },
  // Read, not saved.
  { f: 0, h: 46, guid: 'demo-phone-tower', read: true, title: 'What a signal looks like when it leaves a phone tower', excerpt: 'A short explainer on beam shaping: why a modern tower aims its signal at your phone instead of bathing the whole street in it.' },
  { f: 1, h: 48, guid: 'demo-miso-soup', read: true, title: 'The five-minute miso soup', excerpt: 'Hot water, miso, and whatever you have on hand. The only rule is not to boil the miso, and the second rule is to use more than you think.' },
  { f: 2, h: 50, guid: 'demo-slow-laptop', read: true, title: 'A slow laptop is usually a full disk', excerpt: 'Before buying a new machine, look at what is actually using the space. A scanned-off copy of old photos and an old phone backup are the two most common culprits.' },
  { f: 3, h: 52, guid: 'demo-moon-dust', read: true, title: 'Moon dust, and why it sticks to everything', excerpt: 'The dust is sharp, charged, and hard to brush off a suit. Labs here on Earth are testing a coating that might let astronauts simply wipe it away.' },
  // Read and saved.
  { f: 4, h: 55, guid: 'demo-moss-walls', title: 'A field guide to moss on city walls', excerpt: 'Moss is a map of where water goes. Learning four common species tells you which walls stay damp, and which side of a building gets the morning sun.', saved: true },
  { f: 2, h: 56, guid: 'demo-newsletter-archive', title: 'How a newsletter keeps its archive readable', excerpt: 'Ten years of issues, one plain HTML page each, and no framework to upgrade. A writer explains the constraints that keep the archive working.', saved: true },
  { f: 1, h: 57, guid: 'demo-storing-herbs', title: 'Four ways to store fresh herbs', excerpt: 'Some want water, some want paper, and one wants the freezer. A short guide to making a bunch last the week.', saved: true },
  { f: 3, h: 58, guid: 'demo-paper-star-chart', title: 'The quiet return of the paper star chart', excerpt: null, saved: true },
];

async function ensureDemo(userId, now) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const feedIds = [];
    for (let i = 0; i < DEMO_FEEDS.length; i += 1) {
      const feed = DEMO_FEEDS[i];
      const url = 'https://example.invalid/' + feed.slug + '.xml';
      const inserted = await client.query(
        `INSERT INTO feeds (user_id, url, title, site_url, color, is_demo, last_fetched_at)
         VALUES ($1, $2, $3, $4, $5, true, $6)
         ON CONFLICT (user_id, url) DO NOTHING
         RETURNING id`,
        [userId, url, feed.title, url.replace(/\.xml$/, ''), i + 1, now]
      );
      if (inserted.rows.length) {
        feedIds.push(inserted.rows[0].id);
      } else {
        const existing = await client.query(
          'SELECT id FROM feeds WHERE user_id = $1 AND url = $2',
          [userId, url]
        );
        feedIds.push(existing.rows[0].id);
      }
    }
    for (const post of DEMO_POSTS) {
      const published = new Date(now.getTime() - post.h * 3600 * 1000);
      await client.query(
        `INSERT INTO posts (feed_id, guid, title, link, excerpt, published_at, read_at, saved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (feed_id, guid) DO NOTHING`,
        [
          feedIds[post.f],
          post.guid,
          post.title,
          'https://example.invalid/read/' + post.guid,
          post.excerpt,
          published,
          post.saved || post.read ? now : null,
          post.saved ? now : null,
        ]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function wantsDemo(req) {
  return IS_STAGING && req.query.demo === '1';
}

async function withDemo(req) {
  if (req.user && wantsDemo(req)) {
    await ensureDemo(String(req.user.id), req.now);
  }
}

// ── API ──────────────────────────────────────────────────────────────────
function userId(req) {
  return req.user ? String(req.user.id) : null;
}

app.get('/api/feeds', async (req, res, next) => {
  try {
    await withDemo(req);
    const uid = userId(req);
    if (!uid) return res.json({ feeds: [] });
    const result = await pool.query(
      `SELECT id, url, title, site_url, color, last_fetched_at, last_error
       FROM feeds
       WHERE user_id = $1 AND ($2::boolean OR is_demo = false)
       ORDER BY color, id`,
      [uid, wantsDemo(req)]
    );
    return res.json({ feeds: result.rows });
  } catch (err) {
    return next(err);
  }
});

app.post('/api/feeds', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'account_required' });
    let raw = req.body && req.body.url;
    if (typeof raw !== 'string' || !raw.trim()) {
      return res.status(422).json({ error: 'Enter the address of an RSS or Atom feed.' });
    }
    raw = raw.trim();
    if (raw.length > 2000) {
      return res.status(422).json({ error: 'That address is too long.' });
    }
    let parsed;
    try {
      parsed = await fetchAndParse(raw);
    } catch (err) {
      const message = err instanceof FeedError
        ? err.message
        : 'That address could not be reached.';
      return res.status(422).json({ error: message });
    }
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM feeds WHERE user_id = $1',
      [uid]
    );
    const color = (count.rows[0].n % 8) + 1;
    const client = await pool.connect();
    let feed;
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO feeds (user_id, url, title, site_url, color, last_fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, url, title, site_url, color, last_fetched_at, last_error`,
        [uid, raw, parsed.title, parsed.siteUrl, color, req.now]
      );
      feed = inserted.rows[0];
      for (const post of parsed.posts) {
        await client.query(
          `INSERT INTO posts (feed_id, guid, title, link, excerpt, published_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (feed_id, guid) DO NOTHING`,
          [
            feed.id,
            post.guid,
            post.title,
            post.link,
            post.excerpt,
            post.publishedAt || req.now,
          ]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') {
        return res.status(409).json({ error: 'You already follow this feed.' });
      }
      throw err;
    } finally {
      client.release();
    }
    return res.status(201).json({ feed });
  } catch (err) {
    return next(err);
  }
});

app.delete('/api/feeds/:id', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'account_required' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Feed not found.' });
    const result = await pool.query(
      `DELETE FROM feeds
       WHERE id = $1 AND user_id = $2 AND ($3::boolean OR is_demo = false)`,
      [id, uid, wantsDemo(req)]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Feed not found.' });
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

app.post('/api/refresh', async (req, res, next) => {
  try {
    await withDemo(req);
    const uid = userId(req);
    if (!uid) return res.json({ results: [] });
    const feeds = await pool.query(
      `SELECT id, url FROM feeds
       WHERE user_id = $1 AND is_demo = false
       ORDER BY id`,
      [uid]
    );
    const results = [];
    const list = feeds.rows;
    for (let i = 0; i < list.length; i += 3) {
      const batch = list.slice(i, i + 3);
      const settled = await Promise.all(batch.map(async (feed) => {
        try {
          const parsed = await fetchAndParse(feed.url);
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            for (const post of parsed.posts) {
              await client.query(
                `INSERT INTO posts (feed_id, guid, title, link, excerpt, published_at)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (feed_id, guid) DO NOTHING`,
                [
                  feed.id,
                  post.guid,
                  post.title,
                  post.link,
                  post.excerpt,
                  post.publishedAt || req.now,
                ]
              );
            }
            await client.query(
              `UPDATE feeds SET last_fetched_at = $1, last_error = NULL WHERE id = $2`,
              [req.now, feed.id]
            );
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
          } finally {
            client.release();
          }
          return { id: feed.id, ok: true };
        } catch (err) {
          const message = err instanceof FeedError
            ? err.message
            : 'That feed could not be updated.';
          await pool.query(
            'UPDATE feeds SET last_fetched_at = $1, last_error = $2 WHERE id = $3',
            [req.now, message, feed.id]
          ).catch(() => {});
          return { id: feed.id, ok: false, error: message };
        }
      }));
      results.push(...settled);
    }
    return res.json({ results });
  } catch (err) {
    return next(err);
  }
});

app.get('/api/posts', async (req, res, next) => {
  try {
    await withDemo(req);
    const uid = userId(req);
    if (!uid) return res.json({ posts: [], unread: 0, saved: 0 });
    const view = ['unread', 'saved', 'all'].includes(req.query.view)
      ? req.query.view
      : 'unread';
    const demo = wantsDemo(req);
    const where = 'f.user_id = $1 AND ($2::boolean OR f.is_demo = false)';
    const viewClause = view === 'unread'
      ? ' AND p.read_at IS NULL'
      : view === 'saved'
        ? ' AND p.saved_at IS NOT NULL'
        : '';
    const posts = await pool.query(
      `SELECT p.id, p.title, p.link, p.excerpt, p.published_at, p.read_at, p.saved_at,
              f.id AS feed_id, f.title AS feed_title, f.color
       FROM posts p
       JOIN feeds f ON f.id = p.feed_id
       WHERE ${where}${viewClause}
       ORDER BY p.published_at DESC, p.id DESC
       LIMIT 300`,
      [uid, demo]
    );
    const counts = await pool.query(
      `SELECT count(*) FILTER (WHERE p.read_at IS NULL)::int AS unread,
              count(*) FILTER (WHERE p.saved_at IS NOT NULL)::int AS saved
       FROM posts p
       JOIN feeds f ON f.id = p.feed_id
       WHERE ${where}`,
      [uid, demo]
    );
    return res.json({
      posts: posts.rows,
      unread: counts.rows[0].unread,
      saved: counts.rows[0].saved,
      demo: demo,
    });
  } catch (err) {
    return next(err);
  }
});

app.patch('/api/posts/:id', async (req, res, next) => {
  try {
    const uid = userId(req);
    if (!uid) return res.status(401).json({ error: 'account_required' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Post not found.' });
    const body = req.body || {};
    const sets = [];
    const values = [id, uid, wantsDemo(req)];
    if (typeof body.read === 'boolean') {
      values.push(body.read ? req.now : null);
      sets.push(`read_at = $${values.length}`);
    }
    if (typeof body.saved === 'boolean') {
      values.push(body.saved ? req.now : null);
      sets.push(`saved_at = $${values.length}`);
    }
    if (!sets.length) return res.status(422).json({ error: 'Nothing to change.' });
    const result = await pool.query(
      `UPDATE posts p SET ${sets.join(', ')}
       FROM feeds f
       WHERE p.id = $1 AND f.id = p.feed_id AND f.user_id = $2
         AND ($3::boolean OR f.is_demo = false)
       RETURNING p.id, p.read_at, p.saved_at`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found.' });
    return res.json({ post: result.rows[0] });
  } catch (err) {
    return next(err);
  }
});

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

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error(err);
  return res.status(500).json({ error: 'Something went wrong. Try again.' });
});

let server;
async function start() {
  await migrate();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

function shutdown(signal) {
  console.log(`${signal} received: draining`);
  const finish = () => pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
  if (!server) return finish();
  server.close(() => finish());
  setTimeout(finish, 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
