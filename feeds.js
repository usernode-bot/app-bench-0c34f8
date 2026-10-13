// Feeds: fetch, parse and store RSS/Atom feeds for the reader.
// All routes are scoped to the signed-in user; tables are staging:private.
'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { XMLParser } = require('fast-xml-parser');

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_SUMMARY = 1200;
const MAX_TITLE = 300;

class FeedError extends Error {}
const badAddress = () => new FeedError('Enter a web address, like https://example.com/feed');
const didNotAnswer = () => new FeedError('That address did not answer. Check it and try again.');
const notAFeed = () => new FeedError('That page is not a feed, and it does not link to one.');

// ── URL guard ──────────────────────────────────────────────────────────────
// Only public http(s) addresses: no other schemes, no loopback, private,
// link-local (including the cloud metadata address), CGNAT or 0/8 hosts.

function schemeAllowed(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
}

function ipBlocked(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local, the metadata address
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    return false;
  }
  if (net.isIP(ip) === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = s.startsWith('::ffff:') ? s.slice(7) : null;
    if (mapped && mapped.includes('.')) return ipBlocked(mapped); // v4-mapped
    if (/^f[cd]/.test(s)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(s)) return true; // fe80::/10 link-local
    return false;
  }
  return true; // not an address we understand: refuse
}

/** Resolve the host and refuse anything private, before fetching. */
async function resolveSafeHost(hostname) {
  let addrs;
  try {
    addrs = await dns.promises.lookup(hostname, { all: true });
  } catch {
    throw didNotAnswer();
  }
  if (!addrs.length || addrs.some((a) => ipBlocked(a.address))) {
    throw new FeedError('That address points somewhere this app cannot reach.');
  }
}

// ── safeFetch ──────────────────────────────────────────────────────────────

async function readCapped(response) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new FeedError('That address answered with too much data.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/** Fetch a public http(s) URL: scheme and host checked, redirects re-checked, 10 s timeout, 2 MB cap. */
async function safeFetch(url, redirectsLeft = MAX_REDIRECTS) {
  const u = schemeAllowed(url);
  if (!u) throw badAddress();
  await resolveSafeHost(u.hostname);
  let res;
  try {
    res = await fetch(u, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': 'RSS Reader (Homeroom)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, text/html;q=0.7, */*;q=0.5',
      },
    });
  } catch {
    throw didNotAnswer();
  }
  if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
    if (redirectsLeft <= 0) throw didNotAnswer();
    const next = new URL(res.headers.get('location'), u);
    await safeAbort(res);
    if (!schemeAllowed(next.href)) throw badAddress();
    return safeFetch(next.href, redirectsLeft - 1);
  }
  if (!res.ok) {
    await safeAbort(res);
    throw didNotAnswer();
  }
  const text = await readCapped(res);
  return { text, finalUrl: u.href, contentType: res.headers.get('content-type') || '' };
}

async function safeAbort(res) {
  try { await res.body.cancel(); } catch {}
}

// ── Feed discovery and parsing ─────────────────────────────────────────────

/** The first <link rel="alternate" type="…rss+xml|atom+xml" href> on a page, resolved against its URL. */
function discoverFeedUrl(html, base) {
  const tags = String(html).match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = /rel\s*=\s*["']?([^"'>\s]+)/i.exec(tag);
    const type = /type\s*=\s*["']?([^"'>\s]+)/i.exec(tag);
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!href) continue;
    const isAlternate = rel && /alternate/i.test(rel[1]);
    const isFeed = type && /(rss|atom)\+xml/i.test(type[1]);
    if (!isFeed || (rel && !isAlternate)) continue;
    try { return new URL(href[1], base).href; } catch { continue; }
  }
  return null;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  processEntities: { limit: 4096 },
});

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const text = (x) => {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'number') return String(x);
  if (typeof x === 'object') return typeof x['#text'] === 'string' ? x['#text'] : '';
  return '';
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body.toLowerCase()) ? ENTITIES[body.toLowerCase()] : all;
  });
}

/** Feed HTML out, plain text in: tags gone, entities decoded, whitespace collapsed, blank lines kept. */
function stripHtml(html) {
  const withBreaks = String(html)
    .replace(/<\s*(br|p|div|li|tr|h[1-6]|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  const lines = decodeEntities(withBreaks)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n');
  return lines.replace(/\n{3,}/g, '\n\n').trim();
}

const clamp = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function hashGuid(title, date) {
  return 'h:' + crypto.createHash('sha1').update(`${title}\n${date}`).digest('hex');
}

function parseDate(raw, fallback) {
  for (const candidate of [raw].flat()) {
    const s = text(candidate);
    if (!s) continue;
    const t = Date.parse(s);
    if (Number.isFinite(t)) return new Date(Math.min(t, fallback.getTime()));
  }
  return fallback;
}

/** Keep only http(s) links. */
function safeLink(raw, base) {
  const s = text(raw).trim();
  if (!s) return null;
  try {
    const u = new URL(s, base || undefined);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Parse an RSS 2.0, Atom or RSS 1.0 (RDF) document into { title, items }. */
function parseFeed(xml, baseUrl, now = new Date()) {
  let doc;
  try {
    doc = xmlParser.parse(String(xml));
  } catch {
    throw notAFeed();
  }
  if (!doc || typeof doc !== 'object') throw notAFeed();

  let channelTitle = '';
  let rawItems = [];
  const rss = doc.rss && doc.rss.channel;
  if (rss) {
    channelTitle = text(asArray(rss)[0].title);
    rawItems = asArray(asArray(rss)[0].item);
  } else if (doc.feed) {
    const feed = asArray(doc.feed)[0];
    channelTitle = text(feed.title);
    rawItems = asArray(feed.entry);
  } else if (doc['rdf:RDF']) {
    const rdf = asArray(doc['rdf:RDF'])[0];
    if (rdf.channel) channelTitle = text(asArray(rdf.channel)[0].title);
    rawItems = asArray(rdf.item);
  }
  if (!rawItems.length && !channelTitle) throw notAFeed();

  const items = rawItems.map((entry) => {
    const title = clamp(stripHtml(text(entry.title)) || 'Untitled post', MAX_TITLE);
    // Atom links: objects with @href; pick rel="alternate" or no rel.
    let link = null;
    for (const l of asArray(entry.link)) {
      if (typeof l === 'string') { link = safeLink(l, baseUrl); continue; }
      const rel = l['@_rel'];
      const href = l['@_href'];
      if ((rel === 'alternate' || !rel) && href && !link) link = safeLink(href, baseUrl);
    }
    if (!link) link = safeLink(entry.link, baseUrl);
    const guid = text(entry.guid) || text(entry.id) || (link ? decodeEntities(link) : '') || hashGuid(title, text(entry.pubDate) || text(entry.published) || text(entry.updated) || text(entry['dc:date']));
    const published = parseDate([entry.pubDate, entry.published, entry.updated, entry['dc:date']], now);
    const summarySource = [entry.description, entry.summary, entry['content:encoded'], entry.content].find((c) => stripHtml(c || ''));
    const summary = clamp(stripHtml(summarySource || ''), MAX_SUMMARY);
    const author = text(entry.author && entry.author.name) || text(entry.author) || text(entry['dc:creator']) || null;
    return { guid, title, link, author, summary, published };
  });

  return { title: clamp(stripHtml(channelTitle), MAX_TITLE), items };
}

// ── Demo data (staging, ?demo=1 only) ──────────────────────────────────────

const DEMO_FEEDS = [
  { title: 'Tidepool Notes', url: 'https://tidepoolnotes.example/feed', color: 1 },
  { title: 'Kettle and Crumb', url: 'https://kettleandcrumb.example/feed', color: 2 },
  { title: 'Orbit Weekly', url: 'https://orbitweekly.example/feed', color: 3 },
  { title: 'The Slow Bike', url: 'https://theslowbike.example/feed', color: 4 },
  { title: 'Pocket Garden', url: 'https://pocketgarden.example/feed', color: 5 },
];

const MINUTE = 60_000;
// 14 posts, 3 read: 11 unread rows over Today, Yesterday and Earlier.
const DEMO_POSTS = [
  { feed: 0, title: 'The sea stars are back on the north rocks', minutesAgo: 25,
    author: 'Mara Finch', link: 'https://tidepoolnotes.example/sea-stars-return',
    summary: 'After three quiet winters, our low-tide count on Saturday found forty-one ochre stars on the north rocks, most of them small enough to sit on a thumbnail.\n\nThat is the first real sign of young stars settling here since the wasting years. We will count again at the next spring tide and post the numbers side by side.' },
  { feed: 1, title: 'A rye loaf that forgives a late start', minutesAgo: 65,
    author: 'Priya Anand', link: 'https://kettleandcrumb.example/rye-late-start',
    summary: 'Mix it before work, shape it after dinner, bake it in the morning.' },
  { feed: 2, title: 'How to spot the station passing over tonight', minutesAgo: 3 * 60,
    author: 'Theo Mars', link: 'https://orbitweekly.example/station-tonight',
    summary: 'It crosses low in the west just after nine. No telescope needed.' },
  { feed: 3, title: 'Fixing a squeaky chain in ten minutes', minutesAgo: 5 * 60,
    author: 'Sam Okafor', link: 'https://theslowbike.example/squeaky-chain',
    summary: 'A rag, a drop of oil and some patience. Here is the order that works.' },
  { feed: 4, title: 'Basil on a windowsill, week four', minutesAgo: 7 * 60,
    author: 'June Callow', link: 'https://pocketgarden.example/basil-week-four',
    summary: 'Pinching the tops made it bushier than I expected. Photos inside.' },
  { feed: 0, title: 'What lives under a single rock', minutesAgo: 27 * 60,
    author: 'Mara Finch', link: 'https://tidepoolnotes.example/under-one-rock',
    summary: 'We turned one over, counted, and put it back exactly as it was.' },
  { feed: 2, title: 'A small moon with a very long tail', minutesAgo: 30 * 60,
    author: 'Theo Mars', link: 'https://orbitweekly.example/small-moon-long-tail',
    summary: 'Why the newest comet looks brighter in photos than to the eye.' },
  { feed: 1, title: 'Five ways to use up a sad banana', minutesAgo: 33 * 60,
    author: 'Priya Anand', link: 'https://kettleandcrumb.example/sad-banana',
    summary: 'Bread is the obvious one. The pancakes are better.' },
  { feed: 3, title: 'A flat, quiet loop along the canal', minutesAgo: 2 * 24 * 60 + 4 * 60,
    author: 'Sam Okafor', link: 'https://theslowbike.example/canal-loop',
    summary: 'Twenty-two kilometres, two cafes, no hills worth the name.' },
  { feed: 4, title: 'Saving seeds from this year’s tomatoes', minutesAgo: 3 * 24 * 60 + 2 * 60,
    author: 'June Callow', link: 'https://pocketgarden.example/saving-seeds',
    summary: 'Ferment, rinse, dry on a plate. Label everything twice.' },
  { feed: 0, title: 'Reading a tide table without a headache', minutesAgo: 5 * 24 * 60 + 60,
    author: 'Mara Finch', link: 'https://tidepoolnotes.example/tide-table',
    summary: 'Two numbers matter. The rest is there for sailors.' },
  { feed: 0, title: 'Winter storms rearranged the spit again', minutesAgo: 4 * 24 * 60 + 5 * 60, read: true,
    author: 'Mara Finch', link: 'https://tidepoolnotes.example/storm-spit',
    summary: 'The path is different this year. Boots and a torch after dark.' },
  { feed: 1, title: 'Sourdough starter, week three', minutesAgo: 5 * 24 * 60 + 3 * 60, read: true,
    author: 'Priya Anand', link: 'https://kettleandcrumb.example/starter-week-three',
    summary: 'It doubled on schedule for the first time. Notes on the flour.' },
  { feed: 4, title: 'Moss on the north-facing sill', minutesAgo: 2 * 24 * 60 + 8 * 60, read: true,
    author: 'June Callow', link: 'https://pocketgarden.example/moss-sill',
    summary: 'A patch of moss asks for almost nothing, which is the point.' },
].map((p, i) => ({ ...p, guid: `demo-${i + 1}` }));

// ── Database helpers ───────────────────────────────────────────────────────

function colorForUrl(url) {
  let host = 'host';
  try { host = new URL(url).hostname; } catch {}
  return (crypto.createHash('sha1').update(host).digest()[0] % 6) + 1;
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      site_url text,
      color smallint NOT NULL,
      is_demo boolean NOT NULL DEFAULT false,
      last_checked_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, url)
    )`);
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id serial PRIMARY KEY,
      feed_id int NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid text NOT NULL,
      title text NOT NULL,
      link text,
      author text,
      summary text,
      published_at timestamptz NOT NULL,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (feed_id, guid)
    )`);
  await pool.query(`COMMENT ON TABLE posts IS 'staging:private'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS posts_feed_unread ON posts (feed_id, read_at, published_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_seeds (
      user_id text PRIMARY KEY,
      seeded_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`COMMENT ON TABLE demo_seeds IS 'staging:private'`);
}

async function seedDemo(pool, userId, now) {
  // One row proves this viewer's demo was written; a removed demo feed stays
  // removed on reload.
  const claimed = await pool.query(
    'INSERT INTO demo_seeds (user_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING user_id',
    [userId]);
  if (!claimed.rowCount) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [i, feed] of DEMO_FEEDS.entries()) {
      const inserted = await client.query(
        `INSERT INTO feeds (user_id, url, title, site_url, color, is_demo, last_checked_at, created_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, $6) RETURNING id`,
        [userId, feed.url, feed.title, feed.url.replace(/\/feed$/, '/'), feed.color, now]);
      const feedId = inserted.rows[0].id;
      for (const post of DEMO_POSTS.filter((p) => p.feed === i)) {
        await client.query(
          `INSERT INTO posts (feed_id, guid, title, link, author, summary, published_at, read_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [feedId, post.guid, post.title, post.link, post.author, post.summary,
            new Date(now.getTime() - post.minutesAgo * MINUTE),
            post.read ? now : null]);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** In-memory demo for signed-out visitors on ?demo=1: nothing is stored. */
function demoForGuest(now) {
  const feeds = DEMO_FEEDS.map((f, i) => ({ id: -(i + 1), title: f.title, url: f.url, siteUrl: f.url.replace(/\/feed$/, '/'), color: f.color, unread: 0, lastCheckedAt: now.toISOString(), lastError: null }));
  const posts = DEMO_POSTS.map((p, i) => ({
    id: -(i + 1),
    feedId: -(p.feed + 1),
    source: DEMO_FEEDS[p.feed].title,
    color: DEMO_FEEDS[p.feed].color,
    title: p.title,
    link: p.link,
    author: p.author,
    summary: p.summary,
    publishedAt: new Date(now.getTime() - p.minutesAgo * MINUTE).toISOString(),
    read: !!p.read,
  }));
  feeds.forEach((f, i) => { f.unread = posts.filter((p) => p.feedId === f.id && !p.read).length; });
  return {
    posts: posts.filter((p) => !p.read),
    feeds,
    feedCount: feeds.length,
    checkedAt: now.toISOString(),
    failed: [],
    demo: true,
    guest: true,
  };
}

const POST_COLS = `p.id, p.feed_id AS "feedId", p.title, p.link, p.author, p.summary, p.published_at AS "publishedAt",
  f.title AS source, f.color, f.is_demo AS "isDemo", f.created_at AS "feedCreated"`;

// ── Routes ─────────────────────────────────────────────────────────────────

function mount(app, pool, { IS_STAGING = false } = {}) {
  const demoWanted = (req) => IS_STAGING && req.query.demo === '1';

  async function maybeSeed(req) {
    if (req.user && demoWanted(req)) await seedDemo(pool, String(req.user.id), req.now);
  }

  app.get('/api/posts', async (req, res) => {
    const demo = demoWanted(req);
    if (!req.user) {
      return res.json(demo ? demoForGuest(req.now) : { posts: [], feedCount: 0, guest: true });
    }
    try {
      await maybeSeed(req);
      const userId = String(req.user.id);
      const demoFilter = demo ? '' : ' AND f.is_demo = false';
      const { rows } = await pool.query(
        `SELECT ${POST_COLS} FROM posts p JOIN feeds f ON f.id = p.feed_id
         WHERE f.user_id = $1 AND p.read_at IS NULL${demoFilter}
         ORDER BY p.published_at DESC LIMIT 200`, [userId]);
      const counts = await pool.query(
        `SELECT COUNT(*)::int AS feed_count, MAX(last_checked_at) AS checked_at FROM feeds f
         WHERE f.user_id = $1${demo ? '' : ' AND f.is_demo = false'}`, [userId]);
      const failed = await pool.query(
        `SELECT id AS "feedId", title FROM feeds f WHERE f.user_id = $1 AND last_error IS NOT NULL${demo ? '' : ' AND f.is_demo = false'} ORDER BY id`, [userId]);
      const offsetMs = Math.max(0, req.now.getTime() - (rows.find((r) => r.isDemo)?.feedCreated ? new Date(rows.find((r) => r.isDemo).feedCreated).getTime() : req.now.getTime()));
      const posts = rows.map((r) => ({
        id: r.id,
        feedId: r.feedId,
        source: r.source,
        color: r.color,
        title: r.title,
        link: r.link,
        author: r.author,
        summary: r.summary,
        publishedAt: new Date(new Date(r.publishedAt).getTime() + (r.isDemo ? offsetMs : 0)).toISOString(),
      }));
      res.json({
        posts,
        feedCount: counts.rows[0].feed_count,
        checkedAt: counts.rows[0].checked_at ? new Date(counts.rows[0].checked_at).toISOString() : null,
        failed: failed.rows,
        demo,
      });
    } catch (err) {
      console.warn('GET /api/posts failed:', err.message);
      res.status(500).json({ error: 'Your posts did not load. Try again in a moment.' });
    }
  });

  app.get('/api/feeds', async (req, res) => {
    const demo = demoWanted(req);
    if (!req.user) {
      return res.json(demo ? { feeds: demoForGuest(req.now).feeds, demo, guest: true } : { feeds: [], demo, guest: true });
    }
    try {
      await maybeSeed(req);
      const { rows } = await pool.query(
        `SELECT f.id, f.title, f.url, f.site_url AS "siteUrl", f.color, f.last_checked_at AS "lastCheckedAt", f.last_error AS "lastError",
           COUNT(p.id) FILTER (WHERE p.read_at IS NULL)::int AS unread
         FROM feeds f LEFT JOIN posts p ON p.feed_id = f.id
         WHERE f.user_id = $1${demo ? '' : ' AND f.is_demo = false'}
         GROUP BY f.id ORDER BY f.created_at, f.id`, [String(req.user.id)]);
      res.json({ feeds: rows, demo });
    } catch (err) {
      console.warn('GET /api/feeds failed:', err.message);
      res.status(500).json({ error: 'Your feeds did not load. Try again in a moment.' });
    }
  });

  app.post('/api/feeds', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'account_required' });
    const raw = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!raw) return res.status(400).json({ error: 'Enter a web address, like https://example.com/feed' });
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const first = schemeAllowed(candidate);
    if (!first) return res.status(400).json({ error: 'Enter a web address, like https://example.com/feed' });
    const userId = String(req.user.id);
    try {
      let { text: body, finalUrl, contentType } = await safeFetch(first.href);
      let feedUrl = finalUrl;
      const looksHtml = /text\/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
      if (looksHtml) {
        const discovered = discoverFeedUrl(body, feedUrl);
        if (!discovered) throw notAFeed();
        const second = await safeFetch(discovered);
        body = second.text;
        feedUrl = second.finalUrl;
      }
      const parsed = parseFeed(body, feedUrl, req.now);
      if (!parsed.items.length && !parsed.title) throw notAFeed();
      const host = (() => { try { return new URL(feedUrl).hostname; } catch { return feedUrl; } })();
      const title = parsed.title || host;
      const siteUrl = (() => { try { const u = new URL(feedUrl); return `${u.protocol}//${u.host}/`; } catch { return null; } })();

      const dupe = await pool.query(
        'SELECT id FROM feeds WHERE user_id = $1 AND url IN ($2, $3) LIMIT 1',
        [userId, first.href, feedUrl]);
      if (dupe.rowCount) return res.status(409).json({ error: 'You already follow this feed.' });

      const inserted = await pool.query(
        `INSERT INTO feeds (user_id, url, title, site_url, color, last_checked_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, title, url, site_url AS "siteUrl", color`,
        [userId, feedUrl, title, siteUrl, colorForUrl(feedUrl), req.now]);
      const feedId = inserted.rows[0].id;
      const items = [...parsed.items]
        .sort((a, b) => b.published - a.published)
        .slice(0, 10);
      for (const item of items) {
        await pool.query(
          `INSERT INTO posts (feed_id, guid, title, link, author, summary, published_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (feed_id, guid) DO NOTHING`,
          [feedId, item.guid, item.title, item.link, item.author, item.summary, item.published]);
      }
      res.status(201).json({ feed: inserted.rows[0], added: items.length });
    } catch (err) {
      if (err instanceof FeedError) return res.status(400).json({ error: err.message });
      console.warn('POST /api/feeds failed:', err.message);
      res.status(500).json({ error: 'That feed could not be added. Try again in a moment.' });
    }
  });

  app.delete('/api/feeds/:id', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'account_required' });
    try {
      const gone = await pool.query(
        'DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id',
        [Number(req.params.id) || 0, String(req.user.id)]);
      if (!gone.rowCount) return res.status(404).json({ error: 'That feed is not on your list.' });
      res.json({ ok: true });
    } catch (err) {
      console.warn('DELETE /api/feeds failed:', err.message);
      res.status(500).json({ error: 'That feed could not be removed. Try again in a moment.' });
    }
  });

  app.post('/api/refresh', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'account_required' });
    const userId = String(req.user.id);
    try {
      const { rows } = await pool.query(
        `SELECT id, title, url, last_checked_at AS "lastCheckedAt" FROM feeds
         WHERE user_id = $1 AND is_demo = false ORDER BY id`, [userId]);
      const due = rows.filter((f) => !f.lastCheckedAt || req.now.getTime() - new Date(f.lastCheckedAt).getTime() > 60_000);
      const failed = [];
      let newPosts = 0;
      let checked = 0;
      // Demo feeds count as checked and are never fetched.
      await pool.query('UPDATE feeds SET last_checked_at = $2 WHERE user_id = $1 AND is_demo = true', [userId, req.now]);
      for (let i = 0; i < due.length; i += 4) {
        await Promise.all(due.slice(i, i + 4).map(async (feed) => {
          try {
            const { text } = await safeFetch(feed.url);
            const parsed = parseFeed(text, feed.url, req.now);
            const items = [...parsed.items].sort((a, b) => b.published - a.published).slice(0, 30);
            for (const item of items) {
              const put = await pool.query(
                `INSERT INTO posts (feed_id, guid, title, link, author, summary, published_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (feed_id, guid) DO NOTHING`,
                [feed.id, item.guid, item.title, item.link, item.author, item.summary, item.published]);
              newPosts += put.rowCount;
            }
            await pool.query('UPDATE feeds SET last_checked_at = $2, last_error = NULL WHERE id = $1', [feed.id, req.now]);
            checked += 1;
          } catch (err) {
            const message = err instanceof FeedError ? err.message : 'Did not answer last time.';
            await pool.query('UPDATE feeds SET last_checked_at = $2, last_error = $3 WHERE id = $1', [feed.id, req.now, message]);
            failed.push({ feedId: feed.id, title: feed.title });
          }
        }));
      }
      res.json({ checked, newPosts, failed });
    } catch (err) {
      console.warn('POST /api/refresh failed:', err.message);
      res.status(500).json({ error: 'Could not check your feeds. Your saved posts are still here.' });
    }
  });

  app.post('/api/posts/:id/read', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'account_required' });
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'That post is not on your list.' });
    if (id < 0) return res.json({ ok: true }); // a signed-out visitor's demo post: page-only
    try {
      await pool.query(
        `UPDATE posts SET read_at = $2 WHERE id = $1 AND read_at IS NULL
           AND feed_id IN (SELECT id FROM feeds WHERE user_id = $3)`,
        [id, req.now, String(req.user.id)]);
      res.json({ ok: true });
    } catch (err) {
      console.warn('POST read failed:', err.message);
      res.status(500).json({ error: 'Could not mark that post as read. Try again in a moment.' });
    }
  });

  app.post('/api/posts/read', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'account_required' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500) : [];
    if (!ids.length) return res.json({ marked: 0 });
    try {
      const marked = await pool.query(
        `UPDATE posts p SET read_at = $2 FROM feeds f
         WHERE p.feed_id = f.id AND f.user_id = $1 AND p.id = ANY($3) AND p.read_at IS NULL`,
        [String(req.user.id), req.now, ids]);
      res.json({ marked: marked.rowCount });
    } catch (err) {
      console.warn('POST mark all read failed:', err.message);
      res.status(500).json({ error: 'Could not mark those posts as read. Try again in a moment.' });
    }
  });

  return { migrate: () => migrate(pool) };
}

module.exports = { mount, safeFetch, discoverFeedUrl, parseFeed, ipBlocked, schemeAllowed, stripHtml };