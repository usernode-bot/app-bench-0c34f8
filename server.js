const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const http = require('http');
const https = require('https');
const net = require('net');
const dnsProm = require('dns').promises;
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
// All three tables are the member's own reading data (their feeds, their
// read state), so each is `staging:private`: staging copies the schema
// without the rows.
async function bootSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      site_url TEXT,
      is_demo BOOLEAN NOT NULL DEFAULT FALSE,
      demo_removed BOOLEAN NOT NULL DEFAULT FALSE,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query('ALTER TABLE feeds ADD COLUMN IF NOT EXISTS demo_removed BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      feed_id BIGINT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      title TEXT,
      link TEXT,
      author TEXT,
      published_at TIMESTAMPTZ,
      excerpt TEXT,
      body_text TEXT,
      is_demo BOOLEAN NOT NULL DEFAULT FALSE
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_reads (
      user_id TEXT NOT NULL,
      post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, post_id)
    )`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS feeds_user_url ON feeds (user_id, url)');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS posts_feed_guid ON posts (feed_id, guid)');
  await pool.query('CREATE INDEX IF NOT EXISTS posts_feed_published ON posts (feed_id, published_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS posts_published ON posts (published_at DESC)');
  await pool.query("COMMENT ON TABLE feeds IS 'staging:private'");
  await pool.query("COMMENT ON TABLE posts IS 'staging:private'");
  await pool.query("COMMENT ON TABLE post_reads IS 'staging:private'");
}

// ── safeFetch: the guard for every typed address and every refresh ───────
// http/https on ports 80/443 only; DNS resolved locally and every answer
// checked against loopback, private, link-local, CGNAT, multicast and
// metadata ranges (IPv4 and IPv6) before we connect; at most 3 redirects,
// each hop re-resolved and re-checked; 8 s timeout; 2 MB read cap.
class FetchError extends Error {
  constructor(kind, status) {
    super(kind);
    this.kind = kind;
    this.status = status;
  }
}

function isBlockedAddress(addr) {
  if (addr.includes(':')) {
    const a = addr.toLowerCase();
    if (a.startsWith('::ffff:')) return isBlockedAddress(a.slice(7));
    if (a.includes('.')) {
      // IPv4-mapped written longhand (::127.0.0.1, ::0a00:0001 style tails)
      const tail = a.split(':').pop();
      if (net.isIP(tail) === 4) return isBlockedAddress(tail);
    }
    if (a === '::' || a === '::1') return true;
    const [head, tailz] = a.split('::');
    const groups = (head ? head.split(':') : [])
      .concat(new Array(Math.max(0, 8 - (head ? head.split(':').length : 0) - (tailz ? tailz.split(':').length : 0))).fill('0'))
      .concat(tailz ? tailz.split(':') : []);
    const h = groups.slice(0, 8).map((g) => parseInt(g || '0', 16));
    if (h.length < 8 || h.some((n) => Number.isNaN(n))) return true;
    const [f, s] = h;
    if ((f & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((f & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((f & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (f === 0x2002) return true; // 6to4, embeds an IPv4 address
    if (f === 0 && s === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0) return true; // ::/96 compatible
    if (f === 0x64 && s === 0xff9b) return true; // 64:ff9b::/96 NAT64
    if (f === 0x100) return true; // 100::/64 discard
    if (f === 0xfe00 && h[1] === 0) return true; // ECN / experimental edge
    return false;
  }
  const o = addr.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = o;
  return (
    a === 0 || // this network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local (cloud metadata lives here)
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0/24, 192.0.2/24 TEST-NET
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18/15
    (a === 198 && b === 51) || // TEST-NET-2
    (a === 203 && b === 0) || // TEST-NET-3
    a >= 224 // multicast 224/4 and reserved 240/4
  );
}

function guardedLookup(hostname, options, callback) {
  dnsProm
    .lookup(hostname, { all: true, verbatim: true })
    .then((addrs) => {
      if (!addrs || !addrs.length) return callback(new FetchError('unreachable'));
      for (const a of addrs) {
        if (isBlockedAddress(a.address)) return callback(new FetchError('unreachable'));
      }
      let pick = addrs[0];
      if (options && options.family === 6) pick = addrs.find((x) => x.family === 6) || pick;
      if (options && options.family === 4) pick = addrs.find((x) => x.family === 4) || pick;
      callback(null, pick.address, pick.family);
    })
    .catch(() => callback(new FetchError('unreachable')));
}

function safeFetch(urlStr, { redirects = 3, timeoutMs = 8000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      return reject(new FetchError('unreachable'));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(new FetchError('unreachable'));
    }
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    if (port !== 80 && port !== 443) return reject(new FetchError('unreachable'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        lookup: guardedLookup,
        timeout: timeoutMs,
        setHost: true,
        headers: {
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
          'user-agent': 'RSSReader/1.0 (feed fetcher)',
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new FetchError('unreachable'));
          let next;
          try {
            next = new URL(res.headers.location, u).toString();
          } catch {
            return reject(new FetchError('unreachable'));
          }
          return resolve(safeFetch(next, { redirects: redirects - 1, timeoutMs, maxBytes }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new FetchError('unreachable', res.statusCode));
        }
        let size = 0;
        const chunks = [];
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new FetchError('unreachable'));
          } else {
            chunks.push(c);
          }
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', () => reject(new FetchError('unreachable')));
      }
    );
    req.on('timeout', () => {
      req.destroy(new FetchError('unreachable'));
    });
    req.on('error', (err) => reject(err instanceof FetchError ? err : new FetchError('unreachable')));
    req.end();
  });
}

// ── Feed parsing (RSS 2.0 and Atom) ───────────────────────────────────────
// Feed content is stored as PLAIN TEXT only: tags stripped, entities
// decoded. The page renders it with textContent and never injects feed HTML.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function txt(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object' && typeof v['#text'] === 'string') return v['#text'];
  return '';
}

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä', ugrave: 'ù' };
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = parseInt(h, 16);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const n = parseInt(d, 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    })
    .replace(/&([a-z]+);/gi, (m, name) => Object.prototype.hasOwnProperty.call(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : m);
}

function plainText(html) {
  return decodeEntities(
    String(html == null ? '' : html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(String(s).trim());
  return isNaN(d.getTime()) ? null : d;
}

function safeLink(u) {
  try {
    const l = new URL(u);
    return l.protocol === 'http:' || l.protocol === 'https:' ? l.toString() : null;
  } catch {
    return null;
  }
}

function parseFeed(xml) {
  let doc;
  try {
    doc = xmlParser.parse(xml);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;

  // RSS 2.0 (and 0.9x)
  if (doc.rss && doc.rss.channel) {
    const ch = doc.rss.channel;
    const items = toArray(ch.item).map((it) => {
      const title = plainText(txt(it.title));
      const linkRaw = txt(it.link) || (txt(it.guid) && txt(it['@_isPermaLink']) !== 'false' ? txt(it.guid) : '') || title;
      const content = plainText(txt(it['content:encoded']) || txt(it.description) || txt(it.summary));
      return {
        guid: plainText(txt(it.guid)) || safeLink(txt(it.link)) || title,
        title,
        link: safeLink(txt(it.link)),
        author: plainText(txt(it['dc:creator']) || txt(it.author)),
        publishedAt: parseDate(txt(it.pubDate) || txt(it['dc:date']) || txt(it.date)),
        bodyText: content,
      };
    });
    return {
      title: plainText(txt(ch.title)) || null,
      siteUrl: safeLink(txt(ch.link)),
      items: items.filter((i) => i.guid || i.title),
    };
  }

  // Atom
  if (doc.feed && doc.feed.entry) {
    const feed = doc.feed;
    const links = toArray(feed.link);
    const alt = links.find((l) => l['@_rel'] === 'alternate') || links.find((l) => !l['@_rel']) || links[0];
    const entries = toArray(feed.entry).map((en) => {
      const elinks = toArray(en.link);
      const ealt = elinks.find((l) => l['@_rel'] === 'alternate') || elinks.find((l) => !l['@_rel']) || elinks[0];
      const title = plainText(txt(en.title));
      const authors = toArray(en.author);
      const author = plainText(authors.map((a) => txt(a.name) || txt(a)).join(', '));
      return {
        guid: plainText(txt(en.id)) || safeLink(ealt ? txt(ealt['@_href']) : '') || title,
        title,
        link: safeLink(ealt ? txt(ealt['@_href']) : ''),
        author,
        publishedAt: parseDate(txt(en.published) || txt(en.updated)),
        bodyText: plainText(txt(en.content) || txt(en.summary) || txt(en.description)),
      };
    });
    return {
      title: plainText(txt(feed.title)) || null,
      siteUrl: alt ? safeLink(txt(alt['@_href'])) : null,
      items: entries.filter((i) => i.guid || i.title),
    };
  }
  return null;
}

async function saveItems(feedId, items, isDemo) {
  const clean = items
    .filter((i) => i.guid)
    .slice(0, 60)
    .map((i) => {
      const body = String(i.bodyText || '').slice(0, 20000);
      return [
        feedId,
        i.guid.slice(0, 500),
        i.title ? i.title.slice(0, 500) : null,
        i.link,
        i.author ? i.author.slice(0, 200) : null,
        i.publishedAt,
        body.slice(0, 300),
        body,
        isDemo,
      ];
    });
  for (const row of clean) {
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, author, published_at, excerpt, body_text, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (feed_id, guid) DO UPDATE SET
         title = EXCLUDED.title,
         link = EXCLUDED.link,
         author = EXCLUDED.author,
         published_at = COALESCE(EXCLUDED.published_at, posts.published_at),
         excerpt = EXCLUDED.excerpt,
         body_text = EXCLUDED.body_text`,
      row
    );
  }
  return clean.length;
}

async function refreshFeed(feed) {
  try {
    const xml = await safeFetch(feed.url);
    const parsed = parseFeed(xml);
    if (!parsed) throw new FetchError('not_a_feed');
    await saveItems(feed.id, parsed.items, feed.is_demo);
    await pool.query('UPDATE feeds SET last_error = NULL WHERE id = $1', [feed.id]);
  } catch (err) {
    await pool.query("UPDATE feeds SET last_error = 'Could not update just now' WHERE id = $1", [feed.id]);
  }
}

// ── Staging demo (?demo=1, first version only) ────────────────────────────
// Written only when IS_STAGING && demo=1, on the viewing account's first
// demo request. Fixed guids and ON CONFLICT DO NOTHING: reloads change
// nothing, and what the viewer reads or removes stays that way. Demo feeds
// are never refreshed over the network.
const DEMO_BASE = 'https://staging-demo.invalid';
const DEMO_FEEDS = [
  {
    slug: 'pixel-lantern',
    title: 'Pixel Lantern',
    author: 'Rae Fictional',
    posts: [
      ['slow-connection', 'Designing for the slow connection', 'Most of the web is built on fast wifi. Here is what changes when the page has to load on a train, in a lift, or at the far end of a field.', 'min-12', 'Send the words first, then the pictures. If the first screen needs four requests before anything appears, a person on a slow line sees nothing for a long time.'],
      ['dusk-light', 'Painting dusk light in six colours', 'A limited palette keeps a night scene calm: six paints, one rule about warm light, and the courage to leave most of the page dark.', 'hr-6', 'Pick the two colours that carry the mood and let everything else support them. A scene with twelve colours reads as busy before anyone decides why.'],
      ['walk-cycle', 'Why tiny animations still cost a frame', 'A one-second walk cycle hides more maths than you would think, from contact frames to the little overshoot that sells the weight.', 'day-1', 'Budget the frames before the drawing. Two poses and a hold beat a smooth cycle that stutters on the devices people actually hold.'],
      ['arcade-marquees', 'Colour palettes from old arcade marquees', 'Ten palettes lifted from 1980s shop signs, with hex codes and pairing notes for each.', 'day-3', 'The old sign painters worked from a fixed set of tubes, which is why the palettes hold together. Same trick, new medium.'],
      ['sprite-grids', 'Sprite grids are just good spacing', 'A 16 by 16 grid is not nostalgia. It is the smallest canvas where spacing still has room to breathe.', 'day-5', 'Draw the silhouette first. If it reads at 16 pixels, every later detail is decoration you can afford.'],
    ],
  },
  {
    slug: 'weeknight-kitchen',
    title: 'Weeknight Kitchen',
    author: 'June Placeholder',
    posts: [
      ['stove-rice', 'The best way to cook rice on the stove', 'A tested method with exact water ratios for short, medium and long grain, and the one step everyone skips.', 'hr-1', 'Rinse until the water runs clear, then leave the lid alone for ten minutes off the heat. The rest is measured water and patience.'],
      ['first-cold-week', 'Twelve soups for the first cold week', 'Lentil, miso, white bean and more, all done in under an hour from things already in the cupboard.', 'day-1', 'Each one starts with an onion and ends with something acidic. That is the whole architecture of a weeknight soup.'],
      ['dense-bread', 'Why your bread is dense, and how to fix it', 'Under-proofing is the usual cause. Look for these three signs before the loaf goes anywhere near the oven.', 'day-2', 'Dough is ready when a poke fills back in slowly, not quickly and never not at all. Warm the room, not the clock.'],
      ['one-pan', 'One pan, four vegetables, no recipe', 'A loose formula for clearing the drawer before shopping day: roast hot, dress sharp, eat over rice.', 'day-4', 'Cut everything the same size, oil it honestly, and put the tray where the heat actually is. Dinner in thirty minutes.'],
      ['salt-early', 'Salt early, taste late', 'When each salt addition actually lands, from the first sip of broth to the finishing pinch at the table.', 'day-6', 'Season in layers as you go and the final adjustment becomes a whisper instead of a rescue.'],
    ],
  },
  {
    slug: 'odd-maps-daily',
    title: 'Odd Maps Daily',
    author: 'Milo Example',
    posts: [
      ['staffed-lighthouses', 'A map of every lighthouse still staffed', 'Fewer than thirty remain, and one keeper explains what a night shift looks like from the top of one.', 'hr-2', 'The lamp turns itself these days. What does not turn itself is the weather log, the paint, and the long dark walk between buildings.'],
      ['paper-map-return', 'The quiet return of the paper map', 'Sales of printed atlases are up for the third year running, and the buyers are mostly under thirty.', 'day-2', 'A fold teaches a country in a way a pin never does: the whole shape, then the corner you are going to.'],
      ['long-stairways', "Mapping the world's longest stairways", 'From a hillside funicular that cheats to a cliff path with more steps than a skyscraper has floors.', 'day-5', 'Counting steps sounds like trivia until you walk one. The map notes which ones sell water at the top.'],
      ['walkable-bridges', 'Every bridge you can walk over in one day', 'A walking route that crosses eleven bridges and ends, deliberately, at a bakery.', 'day-6', 'Eleven sounds like a lot until the river bends. The route saves the oldest bridge for last on purpose.'],
      ['tidal-islands', 'Islands you can walk to, twice a day', 'Six causeways that appear on a falling tide, with the hours that keep you from getting stuck on the wrong side.', 'day-7', 'The tide table is the map. Everything else on the page is commentary.'],
    ],
  },
  {
    slug: 'keyboard-corner',
    title: 'Keyboard Corner',
    author: 'Ada Demo',
    posts: [
      ['new-shortcuts', 'Notes on the new keyboard shortcuts', 'A short list of the changes that actually matter for daily use, and the ones you can safely ignore.', 'hr-4', 'Learn two of them and your hands stay on the home row. The rest will find you when you need them.'],
      ['switches-explained', 'Switches, explained without the jargon', 'Linear, tactile and clicky: what each one actually feels like and who each one suits.', 'day-3', 'Press one slowly and listen. A clicky switch announces you, a tactile one confirms you, a linear one keeps quiet about the whole thing.'],
      ['keycap-cleaning', 'A cleaner way to clean keycaps', 'Lukewarm water, a soft brush and a great deal more patience than force.', 'day-6', 'Pull the caps, soak them while you dust the plate, and let everything dry fully before the first keystroke.'],
      ['cold-hands-board', 'Building a board for cold hands', 'Heavier switches, a taller wrist rest and a layout that keeps the common keys close.', 'day-5', 'Winter typing is a posture problem. The board is only half of it; the other half is where your elbows sit.'],
      ['cable-routing', 'Cable routing for tidy desks', 'Three runs of tape and a bit of planning keep a desk cable-free for years, not weeks.', 'day-4', 'Route along the back edge first, then branch. A desk that looks clean on Monday should look clean on Friday.'],
    ],
  },
  {
    slug: 'soup-season',
    title: 'Soup Season',
    author: 'Sam Sample',
    posts: [
      ['long-tuesday', 'The soup that fixes a long Tuesday', 'White bean, one onion, half a cabbage and time. Nothing else is needed and nothing else is missed.', 'hr-8', 'Cover the beans generously, let it go low, and do not stir until the cabbage has given up. Salt it at the end, not the start.'],
      ['miso-buying', 'Miso paste: a buying guide', 'White, yellow and red do different jobs. Here is which one to keep open in the fridge door.', 'day-2', 'White for Wednesday soups, red for stews that want to be noticed. Yellow waits in the middle for both.'],
      ['freezer-portions', 'Freezer portions that actually reheat', 'Cool it fast, leave headspace, label with the month, and never freeze a soup with potatoes.', 'day-4', 'Flat bags thaw in twenty minutes under a tap. A tub takes a day and eats your whole evening plan.'],
      ['odds-ends-broth', 'A broth from odds and ends', 'Peelings, ends, a bay leaf and an hour. Strain it twice and it tastes like you tried.', 'day-6', 'Keep a bag in the freezer for the trimmings. When it is full, the broth makes itself out of nothing.'],
      ['cold-soup', 'Cold soup that is not a smoothie', 'Cucumber, yogurt and dill, chilled four hours and served in wide bowls with bread on the side.', 'day-7', 'Blend, chill, taste for salt again after it is cold. Cold hides seasoning, so be a little brave.'],
    ],
  },
];

const DEMO_READ_GUIDS = ['https://staging-demo.invalid/keyboard-corner#switches-explained', 'https://staging-demo.invalid/soup-season#cold-soup'];

function demoTime(offset, now) {
  // offsets like 'min-12', 'hr-6', 'day-3', relative to req.now
  const [unit, n] = [offset.slice(0, offset.indexOf('-')), Number(offset.slice(offset.indexOf('-') + 1))];
  const ms = unit === 'min' ? 60000 : unit === 'hr' ? 3600000 : 86400000;
  return new Date(now.getTime() - n * ms);
}

let ensuringDemo = null;
async function ensureDemo(userId, now) {
  if (!ensuringDemo) {
    ensuringDemo = (async () => {
      // Feeds the viewer removed stay removed: a demo_removed row is a
      // marker that this feed must not be written again.
      const existing = (
        await pool.query(
          'SELECT url, demo_removed FROM feeds WHERE user_id = $1 AND is_demo',
          [userId]
        )
      ).rows;
      const first = existing.length === 0;
      const removed = new Set(existing.filter((r) => r.demo_removed).map((r) => r.url));
      for (const f of DEMO_FEEDS) {
        const url = `${DEMO_BASE}/${f.slug}.xml`;
        if (removed.has(url)) continue;
        const ins = await pool.query(
          `INSERT INTO feeds (user_id, url, title, site_url, is_demo)
           VALUES ($1, $2, $3, $4, TRUE) ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
          [userId, url, f.title, `${DEMO_BASE}/${f.slug}`]
        );
        let feedId;
        if (ins.rows[0]) {
          feedId = ins.rows[0].id;
        } else {
          const found = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [userId, url]);
          feedId = found.rows[0].id;
        }
        for (const [slug, title, excerpt, offset, para2] of f.posts) {
          const body = `${excerpt}\n\n${para2}`;
          await pool.query(
            `INSERT INTO posts (feed_id, guid, title, link, author, published_at, excerpt, body_text, is_demo)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE)
             ON CONFLICT (feed_id, guid) DO NOTHING`,
            [
              feedId,
              `${DEMO_BASE}/${f.slug}#${slug}`,
              title,
              `${DEMO_BASE}/${f.slug}/${slug}`,
              f.author,
              demoTime(offset, now),
              excerpt,
              body,
            ]
          );
        }
      }
      if (first) {
        // A few already read, on the first insert only.
        await pool.query(
          `INSERT INTO post_reads (user_id, post_id)
           SELECT $1, p.id FROM posts p WHERE p.guid = ANY($2) AND p.is_demo
           ON CONFLICT (user_id, post_id) DO NOTHING`,
          [userId, DEMO_READ_GUIDS]
        );
      }
    })();
    try {
      await ensuringDemo;
    } finally {
      ensuringDemo = null;
    }
  } else {
    await ensuringDemo;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

// GET /api/posts: refresh the member's non-demo feeds in parallel, then
// return their unread posts, newest first. One failing feed sets that
// feed's last_error without failing the request.
app.get('/api/posts', async (req, res) => {
  const demo = IS_STAGING && req.query.demo === '1';
  if (!req.user) {
    // A guest sees an empty list; their feeds are nobody's business.
    return res.json({ posts: [], feedCount: 0, demo: false });
  }
  const userId = String(req.user.id);
  try {
    if (demo) await ensureDemo(userId, req.now);
    const feeds = (
      await pool.query('SELECT id, url, is_demo FROM feeds WHERE user_id = $1 AND NOT is_demo ORDER BY created_at', [userId])
    ).rows;
    await Promise.all(feeds.map((f) => refreshFeed(f)));
    const posts = (
      await pool.query(
        `SELECT p.id, p.title, p.author, p.published_at, p.excerpt, p.body_text, p.link, p.feed_id,
                f.title AS feed_title, f.url AS feed_url
         FROM posts p JOIN feeds f ON f.id = p.feed_id
         WHERE f.user_id = $1
           AND NOT EXISTS (SELECT 1 FROM post_reads r WHERE r.user_id = $1 AND r.post_id = p.id)
           ${demo ? '' : 'AND NOT p.is_demo'}
         ORDER BY p.published_at DESC NULLS LAST, p.id DESC
         LIMIT 200`,
        [userId]
      )
    ).rows;
    const feedCount = (
      await pool.query(
        `SELECT count(*)::int AS n FROM feeds WHERE user_id = $1 AND NOT demo_removed ${demo ? '' : 'AND NOT is_demo'}`,
        [userId]
      )
    ).rows[0].n;
    res.json({ posts, feedCount, demo: !!demo });
  } catch (err) {
    console.error('GET /api/posts failed: ' + err.message);
    res.status(500).json({ error: 'load_failed' });
  }
});

// GET /api/feeds: the member's feeds with their update state.
app.get('/api/feeds', async (req, res) => {
  const demo = IS_STAGING && req.query.demo === '1';
  if (!req.user) return res.json({ feeds: [], demo: false });
  const userId = String(req.user.id);
  try {
    const feeds = (
      await pool.query(
        `SELECT id, title, url, site_url, last_error FROM feeds
         WHERE user_id = $1 AND NOT demo_removed ${demo ? '' : 'AND NOT is_demo'} ORDER BY created_at`,
        [userId]
      )
    ).rows;
    res.json({ feeds, demo: !!demo });
  } catch (err) {
    console.error('GET /api/feeds failed: ' + err.message);
    res.status(500).json({ error: 'load_failed' });
  }
});

function normalizeFeedUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// POST /api/feeds {url}: guarded fetch, parse, save.
app.post('/api/feeds', async (req, res) => {
  const url = normalizeFeedUrl(req.body && req.body.url);
  if (!url) return res.status(422).json({ error: 'not_a_feed' });
  const userId = String(req.user.id);
  try {
    const dup = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [userId, url]);
    if (dup.rows.length) return res.status(409).json({ error: 'already_added' });
    let parsed;
    try {
      parsed = parseFeed(await safeFetch(url));
    } catch (err) {
      return res.status(502).json({ error: 'unreachable' });
    }
    if (!parsed || (!parsed.title && !parsed.items.length)) {
      return res.status(422).json({ error: 'not_a_feed' });
    }
    const saved = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url) VALUES ($1, $2, $3, $4) RETURNING id, title, url, site_url`,
      [userId, url, parsed.title, parsed.siteUrl]
    );
    const feed = saved.rows[0];
    await saveItems(feed.id, parsed.items, false);
    res.json({ feed });
  } catch (err) {
    console.error('POST /api/feeds failed: ' + err.message);
    res.status(500).json({ error: 'save_failed' });
  }
});

// DELETE /api/feeds/:id: only the member's own feed. Its posts go, and with
// them their reads (cascade). A demo feed keeps a marked row instead of
// being deleted, so the ?demo=1 writer never brings it back.
app.delete('/api/feeds/:id', async (req, res) => {
  const userId = String(req.user.id);
  try {
    const found = (
      await pool.query('SELECT id, is_demo FROM feeds WHERE id = $1 AND user_id = $2', [
        req.params.id,
        userId,
      ])
    ).rows;
    if (!found.length) return res.status(404).json({ error: 'not_found' });
    if (found[0].is_demo) {
      await pool.query('UPDATE feeds SET demo_removed = TRUE WHERE id = $1', [found[0].id]);
      await pool.query('DELETE FROM posts WHERE feed_id = $1', [found[0].id]);
    } else {
      await pool.query('DELETE FROM feeds WHERE id = $1', [found[0].id]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/feeds failed: ' + err.message);
    res.status(500).json({ error: 'delete_failed' });
  }
});

// POST /api/posts/:id/read: idempotent, only for a post in one of the
// member's own feeds.
app.post('/api/posts/:id/read', async (req, res) => {
  const userId = String(req.user.id);
  try {
    const own = await pool.query(
      `SELECT p.id FROM posts p JOIN feeds f ON f.id = p.feed_id WHERE p.id = $1 AND f.user_id = $2`,
      [req.params.id, userId]
    );
    if (!own.rows.length) return res.status(404).json({ error: 'not_found' });
    await pool.query('INSERT INTO post_reads (user_id, post_id) VALUES ($1, $2) ON CONFLICT (user_id, post_id) DO NOTHING', [
      userId,
      own.rows[0].id,
    ]);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST read failed: ' + err.message);
    res.status(500).json({ error: 'save_failed' });
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

// Graceful shutdown: stop accepting connections, drain ~3 s, close the
// pool, exit.
let server;
function shutdown() {
  if (shutdown.done) return;
  shutdown.done = true;
  console.log('Shutting down');
  server.close(() => {
    pool.end().then(() => process.exit(0)).catch(() => process.exit(0));
  });
  setTimeout(() => {
    pool.end().then(() => process.exit(0)).catch(() => process.exit(0));
  }, 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function start() {
  await bootSchema();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});