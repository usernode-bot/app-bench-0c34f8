/* Guarded feed fetching and an RSS 2.0 / Atom parse into plain text.
 *
 * Every error thrown carries a `code` the client can name:
 *   blocked_address - not http(s), wrong port, credentials, or a private host
 *   unreachable     - DNS, connection, timeout, too many redirects, bad status
 *   web_page        - the address answered with an HTML page, not a feed
 *   not_a_feed      - it is XML but neither RSS 2.0 nor Atom
 */

const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

class FetchError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/* Refuse loopback, private, link-local, CGNAT, multicast, unspecified and
   IPv6 ULA addresses (IPv4-mapped IPv6 is unwrapped first). */
function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    if (o[0] === 0 || o[0] === 127 || o[0] === 10 || o[0] >= 224) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const addr = ip.toLowerCase();
    const mapped = addr.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    if (addr === '::' || addr === '::1') return true;
    const first = parseInt(addr.split(':')[0], 16);
    if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
    return false;
  }
  return true;
}

function checkUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError('unreachable', 'bad url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new FetchError('blocked_address');
  }
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (port !== 80 && port !== 443) throw new FetchError('blocked_address');
  if (u.username || u.password) throw new FetchError('blocked_address');
  return u;
}

/* Resolve first, refuse private answers, then connect to the very address
   that was checked (SNI still names the hostname). */
function guardedGet(u) {
  return new Promise((resolve, reject) => {
    dns.lookup(u.hostname, { all: true }, (err, addrs) => {
      if (err) return reject(new FetchError('unreachable', 'dns'));
      const ok = addrs.filter((a) => !isBlockedIp(a.address));
      if (!ok.length) return reject(new FetchError('blocked_address'));
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(
        {
          host: ok[0].address,
          servername: u.hostname,
          port: u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80,
          path: u.pathname + u.search,
          method: 'GET',
          headers: {
            Host: u.host,
            Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
            'User-Agent': 'RSS Reader (Homeroom app)',
          },
        },
        (res) => resolve(res)
      );
      req.setTimeout(TIMEOUT_MS, () => {
        req.destroy(new FetchError('unreachable', 'timeout'));
      });
      req.on('error', (e) => reject(e instanceof FetchError ? e : new FetchError('unreachable', e.message)));
      req.end();
    });
  });
}

function readBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        res.destroy();
        return reject(new FetchError('unreachable', 'too large'));
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', (e) => reject(new FetchError('unreachable', e.message)));
  });
}

async function getFollow(u, redirects) {
  const res = await guardedGet(u);
  const status = res.statusCode || 0;
  if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
    if (redirects >= MAX_REDIRECTS) throw new FetchError('unreachable', 'too many redirects');
    res.resume();
    return getFollow(new URL(res.headers.location, u), redirects + 1);
  }
  if (status < 200 || status >= 300) {
    res.resume();
    throw new FetchError('unreachable', 'status ' + status);
  }
  const type = String(res.headers['content-type'] || '');
  if (/\btext\/html\b/i.test(type)) {
    res.resume();
    throw new FetchError('web_page');
  }
  return readBody(res);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e] || m;
  });
}

/* Feed text is never rendered as HTML: tags out, entities decoded. Cut at a
   word, at most about 2,000 characters. */
function toPlainText(html) {
  let s = String(html)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s).replace(/\s+/g, ' ').trim();
  if (s.length > 2000) s = s.slice(0, 2000).slice(0, Math.max(0, s.lastIndexOf(' ')));
  return s;
}

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const nodeText = (x) => {
  if (x == null) return '';
  if (typeof x === 'string' || typeof x === 'number') return String(x);
  if (typeof x === 'object' && '#text' in x) return String(x['#text'] || '');
  return '';
};

function firstLink(entry) {
  const links = asArray(entry.link);
  for (const l of links) {
    const href = typeof l === 'object' && l ? l['@_href'] : l;
    const t = typeof href === 'string' ? href.trim() : '';
    if (/^https?:\/\//i.test(t)) return t;
  }
  return null;
}

function parseFeed(xml) {
  let doc;
  try {
    doc = new XMLParser({ ignoreAttributes: false }).parse(xml);
  } catch {
    throw new FetchError('not_a_feed');
  }
  const rssChannel = doc && doc.rss && doc.rss.channel;
  const atomFeed = doc && doc.feed;
  let rawItems;
  let feedTitle;
  let siteUrl;
  if (rssChannel) {
    rawItems = asArray(rssChannel.item);
    feedTitle = nodeText(rssChannel.title);
    siteUrl = nodeText(rssChannel.link) || null;
  } else if (atomFeed) {
    rawItems = asArray(atomFeed.entry);
    feedTitle = nodeText(atomFeed.title);
    siteUrl = firstLink(atomFeed) || null;
  } else {
    throw new FetchError('not_a_feed');
  }

  const items = rawItems.slice(0, 100).map((it) => {
    const summary = toPlainText(
      (it.description !== undefined ? it.description : it.summary !== undefined ? it.summary : it.content) || ''
    );
    const title = toPlainText(nodeText(it.title));
    const link = firstLink(it) || (typeof it.link === 'string' && /^https?:\/\//i.test(it.link) ? it.link : null);
    const guid =
      nodeText(it.guid || it.id).trim() ||
      (link ? link : '') ||
      crypto.createHash('sha1').update(title + '|' + nodeText(it.pubDate || it.published || it.updated)).digest('hex');
    const dateRaw = nodeText(it.pubDate || it.published || it.updated || it['dc:date']);
    let publishedAt = dateRaw ? new Date(dateRaw) : null;
    if (!publishedAt || isNaN(publishedAt.getTime())) publishedAt = null;
    return { guid: String(guid), title, link, summary, publishedAt };
  });

  return { title: toPlainText(feedTitle) || 'Untitled feed', siteUrl: siteUrl ? toPlainText(siteUrl) : null, items };
}

/* Fetch a feed through the guard and parse it. Returns
   { title, siteUrl, items } with plain-text fields. */
async function fetchFeed(rawUrl) {
  const u = checkUrl(String(rawUrl || '').trim());
  const xml = await getFollow(u, 0);
  return parseFeed(xml);
}

module.exports = { fetchFeed, FetchError };
