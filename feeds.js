/* feeds.js: the RSS Reader's data half.
 *
 * Two tables, both staging:private (one person's feeds and posts are never
 * another's):
 *   feeds  — the feeds a person added (url, title, last_error, ...);
 *   posts  — the items those feeds carried (guid, title, link, summary,
 *            read_at).
 *
 * Every outside fetch goes through fetchFeed() below, the one guarded
 * function: it checks the URL, resolves DNS itself and refuses private
 * addresses, then connects to the address it checked. Feeds are parsed with
 * fast-xml-parser for RSS 2.0, RSS 1.0 and Atom; summaries are stripped to
 * plain text and never rendered as HTML.
 */
'use strict';

const express = require('express');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const MAX_BYTES = 2 * 1024 * 1024; // stop reading at 2 MB
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8000; // allow 8 s per hop
const MAX_SUMMARY = 4000;

/* ── Schema ─────────────────────────────────────────────────────────────── */

async function migrate(pool) {
  // Two boots racing on the same database both try the CREATE: the loser's
  // "duplicate key" on the catalogue means the table is there — carry on.
  const create = (sql) => pool.query(sql).catch((err) => {
    if (err && err.code !== '23505') throw err;
  });
  await create(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      site_url text,
      demo boolean NOT NULL DEFAULT false,
      last_error text,
      last_fetched_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, url)
    )`);
  await create(`
    CREATE TABLE IF NOT EXISTS posts (
      id serial PRIMARY KEY,
      feed_id integer NOT NULL REFERENCES feeds (id) ON DELETE CASCADE,
      user_id text NOT NULL,
      guid text NOT NULL,
      title text NOT NULL,
      link text,
      summary text,
      published_at timestamptz,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (feed_id, guid)
    )`);
}

/* ── The fetch guard ────────────────────────────────────────────────────── */

// The addresses no feed may live on: loopback, private, link-local (the
// cloud metadata address included), CGNAT, multicast and reserved ranges,
// for IPv4 and IPv6 alike.
function v4Blocked(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIp(ip) {
  const version = net.isIP(ip);
  if (version === 4) return v4Blocked(ip);
  if (version === 6) {
    const lower = ip.toLowerCase();
    const mapped = lower.startsWith('::ffff:') ? lower.slice(7) : null;
    if (mapped && net.isIP(mapped) === 4) return v4Blocked(mapped);
    if (lower === '::' || lower === '::1') return true;
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^ff/.test(lower)) return true; // ff00::/8 multicast
    return false;
  }
  return true; // not an address we understand: refuse
}

// Resolve DNS and hand back the checked address, or refuse.
function checkedLookup(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err || !addresses || !addresses.length) {
        return reject(new Error('That site could not be found. Check the link.'));
      }
      for (const a of addresses) {
        if (isBlockedIp(a.address)) {
          return reject(new Error('That address is not allowed.'));
        }
      }
      resolve(addresses[0].address);
    });
  });
}

function checkUrl(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https links work.');
  }
  if (u.username || u.password) {
    throw new Error('That link has credentials in it, which is not allowed.');
  }
  const defaultPort = u.protocol === 'https:' ? '443' : '80';
  if (u.port && u.port !== defaultPort) {
    throw new Error('Only feeds on the standard port work.');
  }
}

// One request, connected to the address already checked. Never follows
// redirects itself: fetchFeed() re-checks every hop.
function requestOnce(url, pinnedIp) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(value);
    };
    const req = mod.request(url, {
      method: 'GET',
      // Connect to the address we checked, whatever DNS says mid-flight.
      lookup: (_host, _opts, cb) => cb(null, pinnedIp, net.isIP(pinnedIp) || 4),
      servername: url.hostname,
      timeout: TIMEOUT_MS,
      headers: {
        'user-agent': 'RSSReader/1.0 (Homeroom app feed fetcher)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          return done(new Error('That feed is too large to read.'));
        }
        chunks.push(chunk);
      });
      res.on('end', () => done(null, {
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', () => done(new Error('The site did not answer properly.')));
    });
    req.on('timeout', () => {
      req.destroy();
      done(new Error('That site took too long to answer.'));
    });
    req.on('error', () => done(new Error('That site did not answer. Check the link and try again.')));
    req.end();
  });
}

/**
 * The one guarded outbound call: fetch a feed's XML as text.
 * http/https on the default port only, no credentials, DNS resolved and
 * checked here (loopback, private, link-local, CGNAT, multicast and
 * metadata addresses refused), the connection made to the checked address,
 * at most 3 redirects with every one checked the same way, 8 s and 2 MB caps.
 */
async function fetchFeed(rawUrl) {
  let current;
  try {
    current = new URL(String(rawUrl).trim());
  } catch {
    throw new Error('That link is not a valid web address.');
  }
  checkUrl(current);
  let redirects = 0;
  for (;;) {
    const pinnedIp = await checkedLookup(current.hostname);
    const res = await requestOnce(current, pinnedIp);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (++redirects > MAX_REDIRECTS) {
        throw new Error('That feed redirected too many times.');
      }
      let next;
      try {
        next = new URL(res.headers.location, current);
      } catch {
        throw new Error('That site sent a redirect we could not follow.');
      }
      checkUrl(next);
      current = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`The site answered with an error (${res.status}).`);
    }
    return res.body;
  }
}

/* ── Parsing: RSS 2.0, RSS 1.0 and Atom ─────────────────────────────────── */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', eacute: 'é',
};

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] || whole);
}

// Feed HTML to plain text, paragraphs kept as blank lines, 4000 chars at most.
function htmlToText(html) {
  if (html == null) return '';
  let s = String(html);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n\n');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, ' ').replace(/ *\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > MAX_SUMMARY ? s.slice(0, MAX_SUMMARY) : s;
}

// A parsed value may be a string, a number, or an object with #text when the
// element carried attributes.
function txt(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object' && '#text' in value) return String(value['#text'] || '');
  return '';
}

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

function toDate(value) {
  const t = Date.parse(txt(value));
  return Number.isNaN(t) ? null : new Date(t);
}

function parseFeed(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error('That page is not a feed we could read.');
  }

  // RSS 2.0 (and 0.9x): <rss><channel><item>.
  if (doc.rss && doc.rss.channel) {
    const channel = doc.rss.channel;
    const items = asArray(channel.item).map((item) => ({
      guid: txt(item.guid),
      title: htmlToText(item.title).split('\n')[0],
      link: txt(item.link),
      summary: htmlToText(item['content:encoded'] || item.description),
      publishedAt: toDate(item.pubDate) || toDate(item['dc:date']),
    }));
    return { title: htmlToText(channel.title).split('\n')[0], siteUrl: txt(channel.link), items };
  }

  // RSS 1.0 (RDF): <rdf:RDF><channel>…</channel><item>…</item></rdf:RDF>.
  if (doc['rdf:RDF']) {
    const rdf = doc['rdf:RDF'];
    const channel = rdf.channel || {};
    const items = asArray(rdf.item).map((item) => ({
      guid: txt(item['rdf:about']) || txt(item.guid),
      title: htmlToText(item.title).split('\n')[0],
      link: txt(item.link),
      summary: htmlToText(item.description),
      publishedAt: toDate(item['dc:date']),
    }));
    return { title: htmlToText(channel.title).split('\n')[0], siteUrl: txt(channel.link), items };
  }

  // Atom: <feed><entry>.
  if (doc.feed) {
    const feed = doc.feed;
    const pickLink = (entry) => {
      const links = asArray(entry.link);
      const alt = links.find((l) => l['@_rel'] === 'alternate') || links.find((l) => !l['@_rel']) || links[0];
      return alt ? txt(alt['@_href']) : '';
    };
    const items = asArray(feed.entry).map((entry) => ({
      guid: txt(entry.id),
      title: htmlToText(entry.title).split('\n')[0],
      link: pickLink(entry),
      summary: htmlToText(entry.content || entry.summary),
      publishedAt: toDate(entry.published) || toDate(entry.updated),
    }));
    return { title: htmlToText(feed.title).split('\n')[0], siteUrl: pickLink({ link: feed.link }), items };
  }

  throw new Error('That link is not an RSS or Atom feed.');
}

/* ── Staging demo (?demo=1): five made-up feeds, sixteen made-up posts ──── */

const DEMO_FEEDS = [
  { url: 'https://teapotweekly.example/feed.xml', title: 'Teapot Weekly (sample)', siteUrl: 'https://teapotweekly.example' },
  { url: 'https://gardennotes.example/feed.xml', title: 'Sample Garden Notes', siteUrl: 'https://gardennotes.example' },
  { url: 'https://bikelab.example/feed.xml', title: 'Fictional Bike Lab', siteUrl: 'https://bikelab.example' },
  { url: 'https://spacedesk.example/feed.xml', title: 'Example Space Desk', siteUrl: 'https://spacedesk.example' },
  { url: 'https://kitchen.example/feed.xml', title: 'Placeholder Kitchen', siteUrl: 'https://kitchen.example' },
];

// feed: index into DEMO_FEEDS; minutesAgo is relative to the request's "now".
const DEMO_POSTS = [
  { feed: 0, guid: 'demo-teapot-pour', minutesAgo: 12, title: 'Ten pretend teapots ranked by how well they pour', summary: 'We filled every made-up teapot in the office and timed the pour. The squat blue one won by a mile, a full cup in under four seconds without a single drip.', link: 'https://teapotweekly.example/2026/ten-teapots' },
  { feed: 1, guid: 'demo-garden-tomatoes', minutesAgo: 55, title: 'Why the imaginary tomatoes ripened early this year', summary: 'A warm spring and a very patient gardener. Here is the watering chart we never actually kept.', link: 'https://gardennotes.example/2026/early-tomatoes' },
  { feed: 0, guid: 'demo-teapot-cozy', minutesAgo: 100, title: 'A sample history of the teapot cosy, mostly invented', summary: 'From its alleged nineteenth-century debut to the knitted covers of today, a cosy tour in which no facts were harmed.', link: 'https://teapotweekly.example/2026/cosy-history' },
  { feed: 2, guid: 'demo-bike-bell', minutesAgo: 170, title: 'Testing a bicycle bell that plays four notes', summary: 'Our test rider rang it 400 times around a made-up park. The neighbours had opinions.', link: 'https://bikelab.example/2026/four-note-bell' },
  { feed: 4, guid: 'demo-kitchen-lentils', minutesAgo: 260, title: 'One-pan lentils for a week of sample lunches', summary: 'A recipe written for testing layouts. It probably tastes fine.', link: 'https://kitchen.example/2026/one-pan-lentils' },
  { feed: 3, guid: 'demo-space-comet', minutesAgo: 340, title: 'A demo comet is due to pass the demo moon on Tuesday', summary: 'Nothing here is real, but the orbit diagram is very nice. Bring a pretend telescope.', link: 'https://spacedesk.example/2026/demo-comet' },
  { feed: 1, guid: 'demo-garden-ferns', minutesAgo: 465, title: "A beginner's chart for watering pretend ferns", summary: 'Once a week, or when the sample soil looks sad. The chart fits on a postcard, which is where we drew it.', link: 'https://gardennotes.example/2026/fern-chart' },
  { feed: 0, guid: 'demo-teapot-mail', minutesAgo: 590, title: 'Reader mail: is my sample teapot too small?', summary: 'Our made-up agony aunt says no teapot is too small, only too ambitious. Five letters, five answers.', link: 'https://teapotweekly.example/2026/reader-mail' },
  { feed: 2, guid: 'demo-bike-penny', minutesAgo: 910, title: "We rode a pretend penny-farthing so you don't have to", summary: 'One lap of the sample loop, two sore wrists and a new respect for the invented handbrake.', link: 'https://bikelab.example/2026/penny-farthing' },
  { feed: 3, guid: 'demo-space-rover', minutesAgo: 1210, title: 'Our example rover has found sample water, probably', summary: 'The pretend spectrometer says yes, the invented geologist says maybe, and the press office says Tuesday.', link: 'https://spacedesk.example/2026/rover-water' },
  { feed: 1, guid: 'demo-garden-slugs', minutesAgo: 1560, title: 'Slugs in the demonstration garden: a calm guide', summary: 'They ate the whole sample lettuce bed overnight. We rebuilt it in the shed and called it planning.', link: 'https://gardennotes.example/2026/slugs' },
  { feed: 4, guid: 'demo-kitchen-scones', minutesAgo: 1900, title: 'The great sample scone experiment, batch four', summary: 'Batch four rose out of spite. Our made-up baker takes no credit, but keeps the recipe.', link: 'https://kitchen.example/2026/scones' },
  { feed: 2, guid: 'demo-bike-panniers', minutesAgo: 2280, title: 'Comparing five made-up panniers by how much they fit', summary: 'A loaf of sample bread, a laptop-shaped brick and one very patient test pigeon.', link: 'https://bikelab.example/2026/panniers' },
  { feed: 0, guid: 'demo-teapot-brewoff', minutesAgo: 2880, title: 'The great demonstration brew-off, round two', summary: 'Two pretend teams, one imaginary kettle and a score sheet nobody can find. Round one ended in a draw.', link: 'https://teapotweekly.example/2026/brew-off' },
  { feed: 3, guid: 'demo-space-sky', minutesAgo: 3390, title: "A beginner's map of the imaginary northern sky", summary: 'Six constellations, one made-up comet and a footnote for every star we could not name.', link: 'https://spacedesk.example/2026/northern-sky' },
  { feed: 2, guid: 'demo-bike-dynamo', minutesAgo: 4230, title: 'How our sample dynamo lights a whole pretend street', summary: 'Two watts, four bulbs and one very surprised electrical inspector, who is also made up.', link: 'https://bikelab.example/2026/dynamo' },
];

async function seedDemo(pool, userId, now) {
  const uid = String(userId);
  const ids = [];
  for (const f of DEMO_FEEDS) {
    const inserted = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, demo, created_at)
       VALUES ($1, $2, $3, $4, true, $5)
       ON CONFLICT (user_id, url) DO NOTHING RETURNING id`,
      [uid, f.url, f.title, f.siteUrl, new Date(now.getTime() - 30 * 86400000)]);
    if (inserted.rows[0]) ids.push(inserted.rows[0].id);
    else {
      const existing = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [uid, f.url]);
      ids.push(existing.rows[0].id);
    }
  }
  for (const p of DEMO_POSTS) {
    await pool.query(
      `INSERT INTO posts (feed_id, user_id, guid, title, link, summary, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [ids[p.feed], uid, p.guid, p.title, p.link, p.summary,
        new Date(now.getTime() - p.minutesAgo * 60000)]);
  }
}

/* ── Routes ─────────────────────────────────────────────────────────────── */

module.exports = function feedsRoutes(pool) {
  const router = express.Router();

  function mapFeed(f) {
    return {
      id: f.id, title: f.title, url: f.url, siteUrl: f.site_url,
      demo: f.demo, lastError: f.last_error, lastFetchedAt: f.last_fetched_at,
    };
  }

  function mapPost(p) {
    return {
      id: p.id, feedId: p.feed_id, feedTitle: p.feed_title, siteUrl: p.site_url,
      title: p.title, link: p.link, summary: p.summary,
      publishedAt: p.published_at, readAt: p.read_at,
    };
  }

  async function upsertItems(feed, items, now) {
    for (const item of items) {
      let guid = item.guid || item.link;
      if (!guid) {
        guid = crypto.createHash('sha1')
          .update(`${item.title || ''}|${item.publishedAt ? item.publishedAt.toISOString() : ''}`)
          .digest('hex');
      }
      const title = item.title || item.summary || '(untitled post)';
      await pool.query(
        `INSERT INTO posts (feed_id, user_id, guid, title, link, summary, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (feed_id, guid) DO NOTHING`,
        [feed.id, feed.user_id, guid.slice(0, 512), title.slice(0, 300),
          item.link ? String(item.link).slice(0, 2048) : null,
          item.summary ? String(item.summary).slice(0, MAX_SUMMARY) : null,
          item.publishedAt]);
    }
  }

  // Refresh one feed. A failure lands in last_error and does not fail the
  // request; the rest of the list still shows.
  async function refreshFeed(feed, now) {
    try {
      const parsed = parseFeed(await fetchFeed(feed.url));
      await upsertItems(feed, parsed.items, now);
      await pool.query('UPDATE feeds SET last_fetched_at = $1, last_error = NULL WHERE id = $2', [now, feed.id]);
    } catch (err) {
      const message = (err && err.message) || 'Could not be reached.';
      await pool.query('UPDATE feeds SET last_error = $1 WHERE id = $2', [message.slice(0, 300), feed.id]);
    }
  }

  // The unread list: refresh every real feed, then return the unread posts,
  // newest first, plus the feeds for the Add feed sheet.
  router.get('/api/posts', async (req, res) => {
    if (!req.user) return res.json({ posts: [], feeds: [], demo: false });
    const uid = String(req.user.id);
    const demoMode = IS_STAGING && req.query.demo === '1';
    if (demoMode) await seedDemo(pool, uid, req.now);

    const feeds = (await pool.query(
      `SELECT * FROM feeds WHERE user_id = $1 ${demoMode ? '' : 'AND demo = false'} ORDER BY created_at, id`,
      [uid])).rows;
    // Demo feeds are never fetched.
    await Promise.all(feeds.filter((f) => !f.demo).map((f) => refreshFeed(f, req.now)));

    const fresh = (await pool.query(
      `SELECT * FROM feeds WHERE user_id = $1 ${demoMode ? '' : 'AND demo = false'} ORDER BY created_at, id`,
      [uid])).rows;
    const posts = (await pool.query(
      `SELECT p.id, p.feed_id, p.title, p.link, p.summary, p.published_at, p.read_at,
              f.title AS feed_title, f.site_url
       FROM posts p JOIN feeds f ON f.id = p.feed_id
       WHERE p.user_id = $1 AND p.read_at IS NULL ${demoMode ? '' : 'AND f.demo = false'}
       ORDER BY p.published_at DESC NULLS LAST, p.id DESC`,
      [uid])).rows;
    res.json({ posts: posts.map(mapPost), feeds: fresh.map(mapFeed), demo: demoMode });
  });

  // Add a feed: fetch it through the guard, parse it, store it and its items.
  router.post('/api/feeds', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Make an account to add feeds.' });
    const raw = typeof (req.body && req.body.url) === 'string' ? req.body.url.trim() : '';
    if (!raw) return res.status(400).json({ error: 'Paste the feed link first.' });
    if (raw.length > 2048) return res.status(400).json({ error: 'That link is too long.' });

    let parsed;
    try {
      parsed = parseFeed(await fetchFeed(raw));
    } catch (err) {
      return res.status(400).json({ error: (err && err.message) || 'That link is not a feed.' });
    }

    const uid = String(req.user.id);
    let site = '';
    try {
      site = new URL(raw).origin;
    } catch {}
    const title = parsed.title || new URL(raw).hostname;
    const feed = (await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, url) DO UPDATE SET title = EXCLUDED.title, site_url = EXCLUDED.site_url
       RETURNING *`,
      [uid, raw, title.slice(0, 200), parsed.siteUrl || site])).rows[0];
    await upsertItems(feed, parsed.items, req.now);
    res.status(201).json({ feed: mapFeed(feed) });
  });

  // Remove one of the viewer's own feeds; its posts go with it (cascade).
  router.delete('/api/feeds/:id', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Make an account to remove feeds.' });
    const removed = await pool.query(
      'DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, String(req.user.id)]);
    if (!removed.rows.length) return res.status(404).json({ error: 'That feed is not on your list.' });
    res.json({ ok: true });
  });

  // Mark the viewer's own post read.
  router.post('/api/posts/:id/read', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Make an account to mark posts read.' });
    const marked = await pool.query(
      'UPDATE posts SET read_at = $1 WHERE id = $2 AND user_id = $3 RETURNING id',
      [req.now, req.params.id, String(req.user.id)]);
    if (!marked.rows.length) return res.status(404).json({ error: 'That post is not on your list.' });
    res.json({ ok: true });
  });

  return router;
};

module.exports.migrate = migrate;
module.exports.fetchFeed = fetchFeed;
module.exports.parseFeed = parseFeed;