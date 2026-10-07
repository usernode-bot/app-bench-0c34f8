'use strict';

/* Fetching and parsing for RSS Reader.
 *
 * Every outbound fetch the app makes goes through safeFetch() here: it only
 * speaks http/https on the default ports, resolves the host itself and
 * refuses to connect to loopback, private, link-local, carrier-grade NAT,
 * multicast or IPv6-ULA addresses, so a "feed URL" cannot be used to reach
 * things on the app's own network. Feed URLs are user input; treat them as
 * hostile.
 *
 * KNOWN RESIDUAL: the resolve-then-connect gap. safeFetch resolves the host
 * with dns.promises.lookup and then lets fetch() resolve it again, so a
 * hostile DNS server could return a public address for the check and a
 * private one for the connection (DNS rebinding). Closing that gap needs a
 * custom agent that connects to the checked address; noted here rather than
 * half-done.
 */

const dns = require('dns').promises;
const net = require('net');
const { XMLParser } = require('fast-xml-parser');

const FETCH_TIMEOUT_MS = 10000;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'HomeroomRSSReader/1.0';
const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const COMMON_FEED_PATHS = ['/feed', '/rss.xml', '/feed.xml', '/atom.xml', '/index.xml'];

function httpError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

/* ── Address screening ─────────────────────────────────────────────────── */

function isPrivateAddress(address) {
  if (typeof address !== 'string') return true;
  let addr = address.trim().toLowerCase();
  // IPv4-mapped IPv6, dotted form first (::ffff:192.168.1.1)
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) addr = mapped[1];
  if (net.isIPv4(addr)) {
    const octets = addr.split('.').map(Number);
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;           // this-host, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return true;          // carrier-grade NAT
    if (a === 169 && b === 254) return true;                    // link-local (cloud metadata lives here)
    if (a === 172 && b >= 16 && b <= 31) return true;           // private
    if (a === 192 && b === 168) return true;                    // private
    if (a >= 224) return true;                                  // multicast + reserved
    return false;
  }
  if (!net.isIPv6(addr)) return true; // unparseable: refuse
  if (addr === '::' || addr === '::1') return true;             // unspecified, loopback
  if (/^f[cd]/.test(addr)) return true;                         // fc00::/7 unique-local
  if (/^fe[89ab]/.test(addr)) return true;                      // fe80::/10 link-local
  if (/^ff/.test(addr)) return true;                            // ff00::/8 multicast
  // IPv4-mapped IPv6 in hex form (::ffff:c0a8:101)
  const hexMapped = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return isPrivateAddress([(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.'));
  }
  return false;
}

function assertPublicUrl(url) {
  if (!(url instanceof URL)) throw httpError('invalid_url', 'not a URL');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw httpError('invalid_url', 'scheme not allowed: ' + url.protocol);
  if (url.port && url.port !== '80' && url.port !== '443') throw httpError('invalid_url', 'port not allowed: ' + url.port);
  if (!url.hostname) throw httpError('invalid_url', 'no hostname');
}

/* ── safeFetch ─────────────────────────────────────────────────────────── */

async function readBodyWithCap(res, cap) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value ? value.length : 0;
    if (total > cap) {
      try { await reader.cancel(); } catch {}
      throw httpError('too_large', 'response larger than ' + cap + ' bytes');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * guarded fetch for user-supplied addresses. Returns
 * { finalUrl, status, body, etag, lastModified, notModified } and throws an
 * Error with .code 'invalid_url' | 'unreachable' | 'too_large'.
 */
async function safeFetch(rawUrl, { headers = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError('invalid_url', 'not a URL: ' + String(rawUrl).slice(0, 200));
  }
  assertPublicUrl(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Resolve the host ourselves and refuse private addresses before the
    // connection is attempted. (The resolve-then-connect gap above applies.)
    let addrs;
    try {
      addrs = await dns.lookup(url.hostname, { all: true });
    } catch {
      throw httpError('unreachable', 'could not resolve ' + url.hostname);
    }
    if (!addrs.length) throw httpError('unreachable', 'no addresses for ' + url.hostname);
    for (const a of addrs) {
      if (isPrivateAddress(a.address)) {
        throw httpError('invalid_url', 'address ' + a.address + ' is not public');
      }
    }

    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        headers: {
          'user-agent': USER_AGENT,
          accept: ACCEPT,
          ...headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw httpError('unreachable', 'fetch failed: ' + (err && err.message));
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw httpError('unreachable', 'redirect without a location');
      if (hop === MAX_REDIRECTS) throw httpError('unreachable', 'too many redirects');
      let next;
      try {
        next = new URL(location, url);
      } catch {
        throw httpError('unreachable', 'bad redirect location');
      }
      assertPublicUrl(next);
      url = next;
      continue;
    }

    if (res.status === 304) {
      return { finalUrl: url.toString(), status: 304, body: '', etag: null, lastModified: null, notModified: true };
    }
    if (!res.ok) {
      throw httpError('unreachable', 'HTTP ' + res.status);
    }
    const body = await readBodyWithCap(res, MAX_BODY_BYTES);
    return {
      finalUrl: url.toString(),
      status: res.status,
      body,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      notModified: false,
    };
  }
  throw httpError('unreachable', 'too many redirects');
}

/* ── HTML helpers ──────────────────────────────────────────────────────── */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü',
  ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ', euro: '€', pound: '£',
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isSafeInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const cp = parseInt(dec, 10);
      return Number.isSafeInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&([a-z]+);/gi, (whole, name) => {
      const mapped = NAMED_ENTITIES[name.toLowerCase()];
      return mapped === undefined ? whole : mapped;
    });
}

/** Feed HTML is reduced to plain text before it is ever stored. */
function htmlToText(html) {
  if (typeof html !== 'string') return { text: '', truncated: false };
  let s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n\n')
    .replace(/<(p|div|li|h[1-6]|tr|blockquote)\b[^>]*\/?>/gi, '\n\n');
  s = decodeEntities(s.replace(/<[^>]+>/g, ' '));
  s = s
    .split('\n')
    .map((line) => line.replace(/[\s ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  let truncated = false;
  if (s.length > 8000) {
    const cut = s.slice(0, 8000);
    const lastSpace = cut.lastIndexOf(' ');
    s = (lastSpace > 4000 ? cut.slice(0, lastSpace) : cut).trimEnd();
    truncated = true;
  }
  return { text: s, truncated };
}

/** First <link rel="alternate" type="…rss+xml|atom+xml" href> in an HTML
 *  page, resolved against the page URL. Exported for tests. */
function findFeedLinkInHtml(html, pageUrl) {
  if (typeof html !== 'string') return null;
  const tagRe = /<link\b[^>]*>/gi;
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    const tag = match[0];
    if (!/\brel\s*=\s*("[^"]*\balternate\b[^"]*"|'[^']*\balternate\b[^']*'|alternate)/i.test(tag)) continue;
    const type = tag.match(/\btype\s*=\s*("[^"]*"|'[^']*')/i);
    if (!type || !/application\/(rss|atom)\+xml/i.test(type[1])) continue;
    const href = tag.match(/\bhref\s*=\s*("[^"]*"|'[^']*')/i);
    if (!href) continue;
    const raw = href[1].slice(1, -1).trim();
    if (!raw) continue;
    try {
      return new URL(raw, pageUrl).toString();
    } catch {
      return null;
    }
  }
  return null;
}

function looksLikeHtml(body) {
  return typeof body === 'string' && /<\s*(!doctype|html|head|body)\b/i.test(body);
}

/* ── Feed parsing ──────────────────────────────────────────────────────── */

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(textOf).join(' ');
  if (typeof v === 'object') {
    if (typeof v['#text'] === 'string') return v['#text'];
    return '';
  }
  return '';
}

function cleanTitle(raw) {
  const stripped = decodeEntities(String(raw).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return stripped || 'Untitled post';
}

function httpLinkOrNull(raw, fallback) {
  const value = raw || fallback;
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!/^https?:\/\//i.test(candidate)) return null;
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

function atomLinkHref(link) {
  const links = toArray(link);
  let firstHref = null;
  for (const l of links) {
    if (typeof l === 'string') {
      if (firstHref === null) firstHref = l;
      continue;
    }
    if (l && l['@_href']) {
      if (l['@_rel'] === 'alternate') return l['@_href'];
      if (!l['@_rel'] && firstHref === null) firstHref = l['@_href'];
      else if (firstHref === null) firstHref = l['@_href'];
    }
  }
  return firstHref;
}

function authorOf(raw, kind) {
  if (kind === 'atom') {
    const authors = toArray(raw.author);
    for (const a of authors) {
      if (a && typeof a === 'object' && a.name != null) {
        const name = cleanTitle(textOf(a.name));
        if (name && name !== 'Untitled post') return name;
      } else if (typeof a === 'string' && a.trim()) {
        return a.trim();
      }
    }
    return null;
  }
  const dc = textOf(raw['dc:creator']).trim();
  if (dc) return dc;
  // RSS 2.0 author is "email (Name)"; prefer the name when present.
  const author = textOf(raw.author).trim();
  if (author) {
    const parens = author.match(/\(([^)]+)\)/);
    return parens ? parens[1].trim() : author;
  }
  return null;
}

/**
 * Parse one feed item into { guid, title, link, author, summary,
 * summaryTruncated, published }. `now` backs every missing or broken date.
 */
function normaliseItem(raw, now, kind) {
  if (!raw || typeof raw !== 'object') return null;

  const rawTitle = textOf(raw.title).trim();
  const title = rawTitle ? cleanTitle(rawTitle) : 'Untitled post';

  const linkCandidate = kind === 'atom'
    ? atomLinkHref(raw.link)
    : (typeof raw.link === 'string' ? raw.link : textOf(raw.link));
  const link = httpLinkOrNull(
    linkCandidate,
    typeof raw['rdf:about'] === 'string' ? raw['rdf:about'] : null
  );

  let guid = textOf(raw.guid).trim() || textOf(raw.id).trim();
  if (!guid) guid = link || title + ' ' + (raw.pubDate || raw['dc:date'] || '');

  const dateRaw = textOf(raw.pubDate) || textOf(raw['dc:date']) ||
    textOf(raw.published) || textOf(raw.updated) || '';
  let published = new Date(dateRaw);
  if (!(published instanceof Date) || Number.isNaN(published.getTime()) || published.getTime() > now.getTime()) {
    published = now;
  }

  const contentHtml = textOf(raw['content:encoded']) || textOf(raw.content) || textOf(raw.description) ||
    textOf(raw['dc:description']) || textOf(raw.summary) || '';
  const { text, truncated } = htmlToText(contentHtml);

  return {
    guid,
    title,
    link,
    author: authorOf(raw, kind),
    summary: text,
    summaryTruncated: truncated,
    published,
  };
}

/**
 * Parse a feed document (RSS 2.0, Atom, RSS 1.0). Returns
 * { title, items } or null when the body is not a feed.
 */
function parseFeed(xml, { now = new Date() } = {}) {
  if (typeof xml !== 'string' || !xml.trim()) return null;
  let doc;
  try {
    doc = xmlParser.parse(xml);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;

  let kind = 'rss';
  let feedTitle = null;
  let itemsRaw = null;

  if (doc.rss && doc.rss.channel) {
    const channel = toArray(doc.rss.channel)[0];
    feedTitle = textOf(channel && channel.title).trim() || null;
    itemsRaw = toArray(channel && channel.item);
  } else if (doc.feed) {
    kind = 'atom';
    const feed = toArray(doc.feed)[0];
    feedTitle = textOf(feed && feed.title).trim() || null;
    itemsRaw = toArray(feed && feed.entry);
  } else if (doc['rdf:RDF']) {
    const rdf = doc['rdf:RDF'];
    feedTitle = textOf(rdf.channel && rdf.channel.title).trim() || null;
    itemsRaw = toArray(rdf.item);
  } else {
    return null;
  }

  const items = [];
  const seen = new Set();
  for (const raw of itemsRaw) {
    const item = normaliseItem(raw, now, kind);
    if (!item || !item.guid || seen.has(item.guid)) continue; // duplicate guids: first wins
    seen.add(item.guid);
    items.push(item);
  }
  // A document that parses as XML but has no items and no title is not a feed.
  if (!items.length && !feedTitle) return null;
  return { title: feedTitle, items };
}

/* ── Discovery ─────────────────────────────────────────────────────────── */

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'Untitled feed';
  }
}

function siteOriginOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Find a feed for a site or feed address. Returns
 * { url, siteUrl, title, items } where url is the final feed URL after
 * discovery and redirects. Throws code 'invalid_url' | 'unreachable' |
 * 'no_feed_found' | 'too_large'.
 */
async function discoverFeed(rawUrl, opts = {}) {
  const first = await safeFetch(rawUrl, opts);
  const direct = parseFeed(first.body, { now: opts.now || new Date() });
  if (direct) {
    return {
      url: first.finalUrl,
      siteUrl: siteOriginOf(first.finalUrl),
      title: direct.title || hostnameOf(first.finalUrl),
      items: direct.items,
    };
  }

  if (looksLikeHtml(first.body)) {
    const linked = findFeedLinkInHtml(first.body, first.finalUrl);
    if (linked) {
      const res = await safeFetch(linked, opts);
      const parsed = parseFeed(res.body, { now: opts.now || new Date() });
      if (parsed) {
        return {
          url: res.finalUrl,
          siteUrl: siteOriginOf(res.finalUrl),
          title: parsed.title || hostnameOf(res.finalUrl),
          items: parsed.items,
        };
      }
    }
  }

  const origin = siteOriginOf(first.finalUrl);
  if (origin) {
    for (const path of COMMON_FEED_PATHS) {
      try {
        const res = await safeFetch(origin + path, opts);
        const parsed = parseFeed(res.body, { now: opts.now || new Date() });
        if (parsed) {
          return {
            url: res.finalUrl,
            siteUrl: siteOriginOf(res.finalUrl),
            title: parsed.title || hostnameOf(res.finalUrl),
            items: parsed.items,
          };
        }
      } catch {} // a wrong guess must not mask the search
    }
  }
  throw httpError('no_feed_found', 'no feed found at ' + first.finalUrl);
}

/* ── Refresh ───────────────────────────────────────────────────────────── */

/**
 * Fetch one stored feed and store any new posts. Conditional GET with the
 * feed's etag/last-modified; 304 counts as checked. Returns { newPosts }.
 */
async function refreshFeed(pool, feed, now) {
  const headers = {};
  if (feed.etag) headers['If-None-Match'] = feed.etag;
  if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;

  let res;
  try {
    res = await safeFetch(feed.url, { headers });
  } catch (err) {
    await pool.query(
      'UPDATE feeds SET last_fetched_at = $2, last_error = $3 WHERE id = $1',
      [feed.id, now, String(err.message || 'fetch failed').slice(0, 300)]
    );
    throw err;
  }

  if (res.notModified) {
    await pool.query(
      'UPDATE feeds SET last_fetched_at = $2, last_error = NULL WHERE id = $1',
      [feed.id, now]
    );
    return { newPosts: 0 };
  }

  const parsed = parseFeed(res.body, { now });
  if (!parsed) {
    await pool.query(
      'UPDATE feeds SET last_fetched_at = $2, last_error = $3 WHERE id = $1',
      [feed.id, now, 'The feed could not be read at the last check.']
    );
    throw httpError('no_feed_found', 'not a feed: ' + feed.url);
  }

  let newPosts = 0;
  for (const item of parsed.items) {
    const result = await pool.query(
      `INSERT INTO posts (feed_id, guid, title, link, author, summary, summary_truncated, published_at, fetched_at, read_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feed.id, item.guid, item.title, item.link, item.author, item.summary, item.summaryTruncated, item.published, now]
    );
    newPosts += result.rowCount;
  }

  await pool.query(
    'UPDATE feeds SET last_fetched_at = $2, etag = $3, last_modified = $4, last_error = NULL WHERE id = $1',
    [feed.id, now, res.etag, res.lastModified]
  );

  // Keep the newest 200 posts per feed; only read ones may be pruned.
  await pool.query(
    `DELETE FROM posts
     WHERE feed_id = $1 AND read_at IS NOT NULL
       AND id NOT IN (
         SELECT id FROM posts WHERE feed_id = $1
         ORDER BY published_at DESC, id DESC LIMIT 200
       )`,
    [feed.id]
  );

  return { newPosts };
}

module.exports = {
  ACCEPT,
  USER_AGENT,
  decodeEntities,
  discoverFeed,
  findFeedLinkInHtml,
  htmlToText,
  httpError,
  isPrivateAddress,
  parseFeed,
  refreshFeed,
  safeFetch,
};
