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

// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process. This handler is what makes
// the same relative paths work under a plain `node server.js`, where there
// is no edge in front of the app at all.
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
// the middleware below. Production always gets the real time. A staging
// preview may be shown as of a chosen moment: the platform opens it with
// `?un-now=<ISO time>`, and the page sends `usernode.now()` on as the
// `x-usernode-now` header. Only a staging container reads either.
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

// index.html carries an inline SVG icon; answer 204 so anything that
// still probes /favicon.ico doesn't fall through to the auth-gated
// catch-all and surface a 401 in the console on every fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──────────────────────────────────────────────────────────────

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      site_url text,
      color integer NOT NULL DEFAULT 1,
      is_demo boolean NOT NULL DEFAULT false,
      last_fetched_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, url)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id serial PRIMARY KEY,
      feed_id integer NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid text NOT NULL,
      title text NOT NULL,
      link text,
      author text,
      published_at timestamptz NOT NULL,
      excerpt text,
      body text,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (feed_id, guid)
    )`);
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE posts IS 'staging:private'`);
}

// ── Fetch guard ───────────────────────────────────────────────────────────
// Every typed feed address goes through safeFetch: http(s) only, no address
// inside the network it runs in, at most 3 redirects (each checked again),
// 8 s and 2 MB.

const MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

function isPrivateIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 6) {
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    if (v === '::' || v === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(v)) return true; // unique local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(v)) return true; // link local fe80::/10
    if (/^ff[0-9a-f]{2}:/.test(v)) return true; // multicast
    return false;
  }
  if (fam === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link local + metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    if (p[0] >= 224) return true;
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true;
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true;
    return false;
  }
  return true;
}

async function assertPublicUrl(url) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('bad_address');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost') throw new Error('blocked_address');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('blocked_address');
    return;
  }
  const addrs = await dns.lookup(host, { all: true, verbatim: true });
  if (!addrs.length) throw new Error('site_unreachable');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('blocked_address');
  }
}

async function safeFetch(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new Error('bad_address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('bad_address');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= 3; hop++) {
      await assertPublicUrl(url);
      const res = await fetch(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'user-agent': 'RSSReader/1.0',
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('site_unreachable');
        if (hop === 3) throw new Error('site_unreachable');
        url = new URL(loc, url);
        continue;
      }
      if (!res.ok) throw new Error('site_unreachable');
      if (!res.body) return { text: await res.text(), finalUrl: url.href };
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BYTES) {
          ctrl.abort();
          throw new Error('too_large');
        }
        chunks.push(Buffer.from(value));
      }
      return { text: Buffer.concat(chunks).toString('utf8'), finalUrl: url.href };
    }
    throw new Error('site_unreachable');
  } finally {
    clearTimeout(timer);
  }
}

// ── Feed parsing (RSS 2.0 and Atom) ───────────────────────────────────────

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  // Feeds routinely carry thousands of entity references in their bodies.
  // The limits still bound expansion, so a hostile feed cannot balloon.
  processEntities: {
    enabled: true,
    maxEntitySize: 10000,
    maxExpansionDepth: 10,
    maxTotalExpansions: 200000,
    maxExpandedLength: 4000000,
    maxEntityCount: 1000,
  },
});

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function textOf(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') return textOf(v['#text']);
  return '';
}

function attrOf(v, name) {
  return v && typeof v === 'object' ? String(v['@_' + name] || '') : '';
}

function safeLink(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '-', mdash: '-', hellip: '...', lsquo: "'", rsquo: "'",
    ldquo: '"', rdquo: '"', bull: '-', middot: '-',
  };
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X'
        ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return Object.prototype.hasOwnProperty.call(named, e) ? named[e] : m;
  });
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote|tr|section|article)\s*>/gi, '\n\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  return s
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function oneLine(s) {
  return htmlToText(s).replace(/\s*\n+\s*/g, ' ').trim();
}

function excerptOf(text) {
  const flat = oneLine(text);
  if (flat.length <= 200) return flat;
  const cut = flat.slice(0, 200);
  const space = cut.lastIndexOf(' ');
  return (space > 120 ? cut.slice(0, space) : cut).replace(/[,;:.\-]$/, '') + '...';
}

function bodyOf(text) {
  return htmlToText(text).slice(0, 20000);
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(String(v).trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function atomLink(node) {
  const links = asArray(node.link);
  const alt = links.find((l) => {
    const rel = attrOf(l, 'rel');
    return !rel || rel === 'alternate';
  });
  const picked = alt || links[0];
  return safeLink(attrOf(picked, 'href')) || safeLink(textOf(node.link));
}

function parseFeed(text, now) {
  let doc;
  try {
    doc = xml.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;

  let channel = doc.rss && doc.rss.channel;
  if (!channel && doc['rdf:RDF']) channel = doc['rdf:RDF'].channel;

  if (channel && typeof channel === 'object') {
    const items = asArray(channel.item)
      .slice(0, 60)
      .map((it) => {
        const link = safeLink(textOf(it.link));
        const body = textOf(it['content:encoded']) || textOf(it.description) || '';
        const summary = textOf(it.description) || textOf(it['content:encoded']) || '';
        return {
          guid: oneLine(textOf(it.guid)) || link || oneLine(textOf(it.title)) || String(Math.random()),
          title: oneLine(textOf(it.title)) || 'Untitled post',
          link,
          author: oneLine(textOf(it.author) || textOf(it['dc:creator'])),
          publishedAt: parseDate(textOf(it.pubDate) || textOf(it['dc:date'])),
          excerpt: excerptOf(summary),
          body: bodyOf(body),
        };
      })
      .filter((it) => it.title);
    return {
      title: oneLine(textOf(channel.title)) || 'Untitled feed',
      siteUrl: safeLink(textOf(channel.link)),
      items,
    };
  }

  const feed = doc.feed;
  if (feed && typeof feed === 'object') {
    const feedTitle = oneLine(textOf(feed.title));
    if (!feedTitle && feed.entry === undefined) return null;
    const items = asArray(feed.entry)
      .slice(0, 60)
      .map((it) => {
        const link = atomLink(it);
        const body = textOf(it.content) || textOf(it.summary) || '';
        const summary = textOf(it.summary) || textOf(it.content) || '';
        const authorNode = it.author;
        const author = oneLine(
          (authorNode && typeof authorNode === 'object' ? textOf(authorNode.name) : '')
          || textOf(authorNode)
        );
        return {
          guid: oneLine(textOf(it.id)) || link || String(Math.random()),
          title: oneLine(textOf(it.title)) || 'Untitled post',
          link,
          author,
          publishedAt: parseDate(textOf(it.published) || textOf(it.updated)),
          excerpt: excerptOf(summary),
          body: bodyOf(body),
        };
      })
      .filter((it) => it.title);
    return {
      title: feedTitle || 'Untitled feed',
      siteUrl: atomLink(feed),
      items,
    };
  }
  return null;
}

async function fetchFeed(url, now) {
  const res = await safeFetch(url);
  const parsed = parseFeed(res.text, now);
  if (!parsed) {
    const err = new Error('not_a_feed');
    err.code = 'not_a_feed';
    throw err;
  }
  return parsed;
}

function fetchErrorText(err) {
  if (err && err.code === 'not_a_feed') return "That address isn't an RSS or Atom feed.";
  return "That feed didn't answer.";
}

async function insertItems(feedId, items, now) {
  for (const it of items) {
    const published = it.publishedAt || now;
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, author, published_at, excerpt, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedId, it.guid, it.title, it.link || null, it.author || null,
        published, it.excerpt || '', it.body || '']
    );
  }
}

function userIdOf(req) {
  return req.user ? String(req.user.id) : null;
}

const demoWanted = (req) => IS_STAGING && req.query.demo === '1' && !!req.user;

// ── Demo data ─────────────────────────────────────────────────────────────
// Only on staging, only with ?demo=1. The same content ships in production
// code; only IS_STAGING gates it.

const DEMO_FEEDS = [
  { url: 'https://thepastryledger.example/feed.xml', title: 'The Pastry Ledger', siteUrl: 'https://thepastryledger.example', color: 1 },
  { url: 'https://kernelnotes.example/feed.xml', title: 'Kernel Notes', siteUrl: 'https://kernelnotes.example', color: 2 },
  { url: 'https://fieldguideweekly.example/feed.xml', title: 'Field Guide Weekly', siteUrl: 'https://fieldguideweekly.example', color: 3 },
  { url: 'https://typeandgrid.example/feed.xml', title: 'Type & Grid', siteUrl: 'https://typeandgrid.example', color: 4 },
  { url: 'https://balconygarden.example/feed.xml', title: 'Balcony Garden', siteUrl: 'https://balconygarden.example', color: 5 },
];

const DEMO_POSTS = [
  {
    feed: 0, minutesAgo: 12, author: 'Mara Tinsley',
    title: 'Why your laminated dough keeps leaking butter',
    excerpt: 'Temperature is usually the culprit, not technique. Here is a simple fridge schedule that fixed it.',
    body: 'Temperature is usually the culprit, not technique. When the butter block and the dough are more than a few degrees apart, the layers tear as you roll and the butter finds a way out.\n\nChill the block until it bends without cracking, and keep the dough cool enough that it does not feel warm under your palm. If the kitchen is above 24 degrees, work in ten-minute bursts and put the dough back in the fridge between them.\n\nThe schedule that fixed it for me: twenty minutes in the fridge after every single fold, no exceptions, and a final hour before the last roll.',
  },
  {
    feed: 1, minutesAgo: 60, author: 'Dev Raman',
    title: 'Scheduler changes landing in the next release',
    excerpt: 'A walk through the patches that reduce latency on busy machines.',
    body: 'A walk through the patches that reduce latency on busy machines. The biggest change is a smaller run queue per core, which cuts the time a task waits behind unrelated work.\n\nThe patches also shorten the window in which a waking task can land on a core that is about to sleep. That one change is most of the measured improvement on a four-core box under load.\n\nExpect the improvement to show up first in short interactive tasks and last in long batch jobs.',
  },
  {
    feed: 2, minutesAgo: 120, author: 'Rowan Example', read: true,
    title: 'Ten quiet trails within an hour of the city',
    excerpt: 'Fewer crowds, better views and parking that is actually free.',
    body: 'Most guides send you to the same five summits. These routes trade fame for silence, with clear paths, shade and places to sit.\n\nThe first loop starts behind the old reservoir car park and climbs gently through beech woods for two kilometres before opening onto a long grassy ridge.\n\nStart early and bring water: only three of the ten have a tap at the trailhead, and none of them sell anything once you are past the gate.',
  },
  {
    feed: 3, minutesAgo: 180, author: 'Ines Okoro',
    title: 'Setting small text so it stays readable',
    excerpt: 'Spacing, weight and size choices for captions and footnotes.',
    body: 'Spacing, weight and size choices for captions and footnotes. Small text fails more often from tight leading than from being small.\n\nGive anything under fourteen pixels a line height close to one and a half, and avoid light weights below sixteen. A slightly wider letter spacing helps at very small sizes, but only slightly.\n\nTest captions at the size they will actually appear, on a phone, in daylight. A desktop preview flatters text that is unreadable outdoors.',
  },
  {
    feed: 0, minutesAgo: 1440, author: 'Mara Tinsley',
    title: 'An honest review of three home proofing boxes',
    excerpt: 'We tested each overnight with the same sourdough batch.',
    body: 'We tested each overnight with the same sourdough batch, the same room and the same starting temperature. The cheapest box held a steady twenty-four degrees for most of the night.\n\nThe two pricier boxes ran a little warm and dried the surface of the dough. A damp towel over the top fixed it, but you should not need extra kit to make a box work.\n\nIf you already have a cool oven with the light on, save the money and use that.',
  },
  {
    feed: 4, minutesAgo: 1500, author: 'Ade Cole',
    title: 'Sowing lettuce in late spring heat',
    excerpt: 'Shade cloth, deep watering and which varieties bolt last.',
    body: 'Shade cloth, deep watering and which varieties bolt last. Lettuce sown after the first hot week needs help to germinate at all.\n\nSow in the cool of the evening, water the tray thoroughly and keep it out of direct sun until the first leaves show. A light shade cloth over the balcony does more than any amount of extra watering.\n\nFor late sowings, choose a loose-leaf variety and pick outer leaves early. The plant stays productive for weeks longer than a hearting type.',
  },
  {
    feed: 1, minutesAgo: 2880, author: 'Dev Raman',
    title: 'Reading a flame graph without getting lost',
    excerpt: 'Start at the widest bar and work outward.',
    body: 'Start at the widest bar and work outward. The widest bar is where the time went, not necessarily where the problem is.\n\nLook for a bar that is wide and ends in a single narrow leaf. That shape usually means a loop doing repeated work it could do once.\n\nIgnore anything below two percent of the total on the first pass. Come back to it only if the obvious candidates turn out to be innocent.',
  },
  {
    feed: 4, minutesAgo: 3150, author: 'Ade Cole',
    title: 'Three herbs that like a windy balcony',
    excerpt: 'Thyme, rosemary and chives shrug off gusts that flatten basil.',
    body: 'Thyme, rosemary and chives shrug off gusts that flatten basil. All three also tolerate the dry air that comes with a windy site.\n\nPlant them in deep pots so the roots stay cool, and water in the morning rather than the evening. Wind dries the surface fast, and damp leaves overnight invite mildew.\n\nBasil can still work, but keep it against the wall and out of the strongest gusts.',
  },
  {
    feed: 0, minutesAgo: 4300, author: 'Mara Tinsley',
    title: 'A proofing schedule for a cold kitchen',
    excerpt: 'Long, slow and forgiving, with a timetable you can actually keep.',
    body: 'Long, slow and forgiving, with a timetable you can actually keep. A cold kitchen is a gift for flavour if you plan around it.\n\nMix in the evening, leave the dough covered on the counter for an hour, then move it to the fridge overnight. Take it out in the morning and let it finish on the counter while you have breakfast.\n\nThe bread will be ready to bake around lunchtime, and the only thing you have to remember is when you started.',
  },
  {
    feed: 2, minutesAgo: 5000, author: 'Rowan Example',
    title: 'What to pack for a half-day hike',
    excerpt: 'A short list that covers weather, water and the unexpected.',
    body: 'A short list that covers weather, water and the unexpected. A half day is long enough to get cold, wet or lost, and short enough that you will be tempted to leave things behind.\n\nCarry one more layer than the forecast suggests, a litre of water per person, and a paper map if you know how to read it. A small first aid kit and a head torch weigh almost nothing.\n\nTell someone where you are going and when you expect to be back. That is the piece of kit people skip most often.',
  },
  {
    feed: 3, minutesAgo: 5800, author: 'Ines Okoro',
    title: 'Kerning pairs you can stop worrying about',
    excerpt: 'Which pairs still matter, and where the software already helps.',
    body: 'Which pairs still matter, and where the software already helps. Most modern fonts ship with pair adjustments that cover the usual suspects.\n\nThe pairs still worth checking by eye are the ones next to punctuation: a capital followed by a quote, a lowercase letter before a closing bracket, and anything set in all caps.\n\nIf a headline looks loose, fix the spacing of the whole line before adjusting individual pairs.',
  },
  {
    feed: 1, minutesAgo: 6500, author: 'Dev Raman',
    title: 'Why your build cache stopped working',
    excerpt: 'Three small changes that quietly invalidate everything.',
    body: 'Three small changes that quietly invalidate everything. The first is a timestamp written into a generated file, which changes on every run.\n\nThe second is a dependency resolved to a moving version tag, so the lockfile is no longer enough. The third is a build step that reads an environment variable you did not include in the cache key.\n\nCheck the cache key before you blame the cache itself. A cache that is never hit looks exactly like a broken one.',
  },
  {
    feed: 4, minutesAgo: 7300, author: 'Ade Cole',
    title: 'Tomatoes in a north-facing window',
    excerpt: 'They will not ripen on the vine, but they will still taste good.',
    body: 'They will not ripen on the vine, but they will still taste good. Choose a small cherry variety and give it the brightest spot you have.\n\nPinch out side shoots so the plant puts its energy into fruit, and feed it every week once the first flowers set. A north-facing window gives enough light for leaves, but the fruit needs the extra help.\n\nPick before the first cold night and ripen the last tomatoes on a sunny sill indoors.',
  },
  {
    feed: 2, minutesAgo: 8100, author: 'Rowan Example',
    title: 'Reading a paper map in the rain',
    excerpt: 'Fold it so the part you need stays dry.',
    body: 'Fold it so the part you need stays dry. A map folded to show one square at a time survives a lot more weather than one flapping open in the wind.\n\nKeep it in a plastic sleeve, or use a clear zip bag from the kitchen. Mark your route in pencil, not pen, so you can change it later.\n\nA compass is cheap and does not run out of battery. Learn which way north is before you need to know.',
  },
  {
    feed: 3, minutesAgo: 8900, author: 'Ines Okoro',
    title: 'Choosing a grid for a small screen',
    excerpt: 'Fewer columns than you think, and a lot more space around them.',
    body: 'Fewer columns than you think, and a lot more space around them. A four-column grid at phone width usually means four chances to misalign something.\n\nStart with two columns and generous gutters, and let full-width elements break out where they need to. The rhythm comes from the vertical spacing as much as the columns.\n\nTest with real text, including a long word and a number, before you commit to the layout.',
  },
];

async function seedDemo(req) {
  const userId = userIdOf(req);
  if (!userId) return;
  const now = req.now || new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const f of DEMO_FEEDS) {
      await client.query(
        `INSERT INTO feeds (user_id, url, title, site_url, color, is_demo, last_fetched_at, created_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, $6)
         ON CONFLICT (user_id, url) DO NOTHING`,
        [userId, f.url, f.title, f.siteUrl, f.color, now]
      );
    }
    const { rows } = await client.query(
      `SELECT id, url FROM feeds WHERE user_id = $1 AND is_demo = true`, [userId]
    );
    const idByUrl = new Map(rows.map((r) => [r.url, r.id]));
    for (const p of DEMO_POSTS) {
      const feed = DEMO_FEEDS[p.feed];
      const feedId = idByUrl.get(feed.url);
      if (!feedId) continue;
      const link = feed.siteUrl + '/posts/' + p.title
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const published = new Date(now.getTime() - p.minutesAgo * 60000);
      await client.query(
        `INSERT INTO posts (feed_id, guid, title, link, author, published_at, excerpt, body, read_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $6)
         ON CONFLICT (feed_id, guid) DO NOTHING`,
        [feedId, link, p.title, link, p.author, published,
          p.excerpt, p.body, p.read ? now : null]
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

// ── Routes ────────────────────────────────────────────────────────────────

app.get('/api/posts', async (req, res) => {
  const userId = userIdOf(req);
  if (!userId) {
    return res.json({ posts: [], feedCount: 0, unreadCount: 0, refreshedAt: null, failedFeeds: 0 });
  }
  const demo = demoWanted(req);
  try {
    if (demo) await seedDemo(req);
    const [stats, posts] = await Promise.all([
      pool.query(
        `SELECT count(*)::int AS feed_count,
                count(*) FILTER (WHERE last_error IS NOT NULL)::int AS failed_feeds,
                max(last_fetched_at) AS refreshed_at
           FROM feeds
          WHERE user_id = $1 AND ($2::boolean OR is_demo = false)`,
        [userId, demo]
      ),
      pool.query(
        `SELECT p.id, p.title, p.link, p.author, p.published_at, p.excerpt, p.body, p.read_at,
                f.title AS feed_title, f.color AS feed_color
           FROM posts p
           JOIN feeds f ON f.id = p.feed_id
          WHERE f.user_id = $1 AND p.read_at IS NULL
            AND ($2::boolean OR f.is_demo = false)
          ORDER BY p.published_at DESC, p.id DESC`,
        [userId, demo]
      ),
    ]);
    const s = stats.rows[0] || {};
    res.json({
      posts: posts.rows.map((p) => ({
        id: p.id,
        title: p.title,
        link: p.link,
        author: p.author,
        publishedAt: p.published_at,
        excerpt: p.excerpt,
        body: p.body,
        readAt: p.read_at,
        feedTitle: p.feed_title,
        feedColor: p.feed_color,
      })),
      feedCount: s.feed_count || 0,
      unreadCount: posts.rows.length,
      refreshedAt: s.refreshed_at,
      failedFeeds: s.failed_feeds || 0,
      demo,
    });
  } catch (err) {
    console.error('posts failed: ' + err.message);
    res.status(500).json({ error: 'posts_failed' });
  }
});

app.post('/api/refresh', async (req, res) => {
  const userId = userIdOf(req);
  if (!userId) return res.json({ refreshedAt: null, failedFeeds: 0 });
  try {
    const { rows: feeds } = await pool.query(
      `SELECT id, url FROM feeds WHERE user_id = $1 AND is_demo = false`, [userId]
    );
    let failed = 0;
    await Promise.all(feeds.map(async (feed) => {
      try {
        const parsed = await fetchFeed(feed.url, req.now);
        await insertItems(feed.id, parsed.items, req.now);
        await pool.query(
          `UPDATE feeds SET last_fetched_at = $1, last_error = NULL WHERE id = $2`,
          [req.now, feed.id]
        );
      } catch (err) {
        failed++;
        await pool.query(
          `UPDATE feeds SET last_fetched_at = $1, last_error = $2 WHERE id = $3`,
          [req.now, fetchErrorText(err), feed.id]
        ).catch(() => {});
      }
    }));
    const { rows } = await pool.query(
      `SELECT max(last_fetched_at) AS refreshed_at FROM feeds
        WHERE user_id = $1 AND is_demo = false`, [userId]
    );
    res.json({ refreshedAt: rows[0] ? rows[0].refreshed_at : null, failedFeeds: failed });
  } catch (err) {
    console.error('refresh failed: ' + err.message);
    res.status(500).json({ error: 'refresh_failed' });
  }
});

app.get('/api/feeds', async (req, res) => {
  const userId = userIdOf(req);
  if (!userId) return res.json({ feeds: [] });
  const demo = demoWanted(req);
  try {
    const { rows } = await pool.query(
      `SELECT id, url, title, site_url, color, last_fetched_at, last_error
         FROM feeds
        WHERE user_id = $1 AND ($2::boolean OR is_demo = false)
        ORDER BY created_at ASC, id ASC`,
      [userId, demo]
    );
    res.json({
      feeds: rows.map((f) => ({
        id: f.id,
        url: f.url,
        title: f.title,
        siteUrl: f.site_url,
        color: f.color,
        lastFetchedAt: f.last_fetched_at,
        lastError: f.last_error,
      })),
    });
  } catch (err) {
    console.error('feeds failed: ' + err.message);
    res.status(500).json({ error: 'feeds_failed' });
  }
});

app.post('/api/feeds', async (req, res) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: 'account_required' });
  const url = String((req.body && req.body.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(422).json({ error: 'bad_address' });
  }
  let parsed;
  try {
    parsed = await fetchFeed(url, req.now);
  } catch (err) {
    const code = err && err.code === 'not_a_feed' ? 'not_a_feed' : 'unreachable';
    return res.status(422).json({ error: code });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: last } = await client.query(
      `SELECT color FROM feeds WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [userId]
    );
    const color = last.length ? (last[0].color % 5) + 1 : 1;
    const inserted = await client.query(
      `INSERT INTO feeds (user_id, url, title, site_url, color, last_fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, url) DO NOTHING
       RETURNING id`,
      [userId, url, parsed.title, parsed.siteUrl || null, color, req.now]
    );
    if (!inserted.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'exists' });
    }
    const feedId = inserted.rows[0].id;
    for (const it of parsed.items) {
      const published = it.publishedAt || req.now;
      await client.query(
        `INSERT INTO posts (feed_id, guid, title, link, author, published_at, excerpt, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (feed_id, guid) DO NOTHING`,
        [feedId, it.guid, it.title, it.link || null, it.author || null,
          published, it.excerpt || '', it.body || '']
      );
    }
    await client.query('COMMIT');
    res.json({ feed: { id: feedId, url, title: parsed.title, color } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('add feed failed: ' + err.message);
    res.status(500).json({ error: 'add_failed' });
  } finally {
    client.release();
  }
});

app.delete('/api/feeds/:id', async (req, res) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: 'account_required' });
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM feeds WHERE id = $1 AND user_id = $2`, [id, userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('remove feed failed: ' + err.message);
    res.status(500).json({ error: 'remove_failed' });
  }
});

app.post('/api/posts/:id/read', async (req, res) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: 'account_required' });
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  try {
    const { rowCount } = await pool.query(
      `UPDATE posts p SET read_at = $1
         FROM feeds f
        WHERE p.id = $2 AND f.id = p.feed_id AND f.user_id = $3 AND p.read_at IS NULL`,
      [req.now, id, userId]
    );
    res.json({ ok: true, updated: rowCount });
  } catch (err) {
    console.error('mark read failed: ' + err.message);
    res.status(500).json({ error: 'read_failed' });
  }
});

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app. Every other
// tokenless case gets the "open in Homeroom" landing page instead.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
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

async function start() {
  await initDb();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  let closing = false;
  function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`${signal} received, shutting down`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => {
      pool.end().finally(() => process.exit(0));
    }, 3000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
