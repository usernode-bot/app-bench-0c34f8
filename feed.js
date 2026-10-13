// Fetching and parsing RSS and Atom feeds, for server.js.
//
// Every fetch goes through the guard below: the web only (http/https, ports
// 80 and 443), no addresses with a password in them, no loopback, private,
// link-local or otherwise internal addresses (checked at the DNS step, with
// the connection pinned to an address that passed), at most three redirects
// (each re-checked), eight seconds to answer, and two megabytes of body.
const dns = require('dns');
const http = require('http');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'RSS Reader (Homeroom)';

class FeedError extends Error {}

// ── The guard ──────────────────────────────────────────────────────────────

// A web address, or a plain reason the address is out of bounds.
function assertWebUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new FeedError('That is not a web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FeedError('The address must start with http:// or https://.');
  }
  if (url.username || url.password) {
    throw new FeedError('Addresses with a password in them are not supported.');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new FeedError('Only the usual web ports (80 and 443) are supported.');
  }
  return url;
}

// Whether an IP may not be reached from here: loopback, private, link-local,
// carrier-grade NAT, multicast, reserved ranges, and the cloud metadata
// service. IPv4 and IPv6, including IPv4 mapped into IPv6.
function isBlockedIp(ip) {
  let v4 = null;
  if (net_isIpv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) v4 = mapped[1];
    else if (lower === '::' || lower === '::1') return true;
    else {
      if (startsHex(lower, 'fe8') || startsHex(lower, 'fe9') || startsHex(lower, 'fea') || startsHex(lower, 'feb')) return true; // link-local
      if (startsHex(lower, 'fc') || startsHex(lower, 'fd')) return true; // unique local
      if (startsHex(lower, 'ff')) return true; // multicast
      if (lower.startsWith('2001:db8:')) return true; // documentation
      return false;
    }
  } else v4 = ip;
  const parts = v4.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true; // protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // documentation
  if (a === 203 && b === 0 && parts[2] === 113) return true; // documentation
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function net_isIpv6(s) {
  return s.includes(':');
}

function startsHex(lower, prefix) {
  return lower.startsWith(prefix);
}

// A dns.lookup that resolves every address and only answers with ones the
// guard allows, so the connection cannot slip off to an internal address.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const ok = addresses.filter((a) => !isBlockedIp(a.address));
    if (!ok.length) return callback(new FeedError('That address is not reachable from here.'));
    if (options && options.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}

// One GET through the guard. Redirects come back here, so each hop is
// re-checked for scheme, port, credentials and address.
function guardedGet(url, redirects) {
  return new Promise((resolve, reject) => {
    let mod;
    try {
      mod = assertWebUrl(url.toString()).protocol === 'https:' ? https : http;
    } catch (err) {
      return reject(err);
    }
    const req = mod.request(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      timeout: TIMEOUT_MS,
      lookup: safeLookup,
      servername: url.hostname,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const location = res.headers.location;
        if (!location) return reject(new FeedError('That address did not answer with a feed.'));
        if (redirects >= MAX_REDIRECTS) return reject(new FeedError('That address redirects too many times.'));
        let next;
        try {
          next = new URL(location, url);
        } catch {
          return reject(new FeedError('That address redirects somewhere unreadable.'));
        }
        return resolve(guardedGet(next, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new FeedError(`That address answered with status ${res.statusCode}.`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          reject(new FeedError('That feed is too large to read.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new FeedError('That address took too long to answer.')));
    req.on('error', (err) => reject(err instanceof FeedError ? err : new FeedError('That address could not be reached.')));
    req.end();
  });
}

// ── Parsing ────────────────────────────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
});

// A text node fast-xml-parser may hand over as a string, a number, or an
// object with the text in #text.
function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    if ('#text' in value) return textOf(value['#text']);
    if ('@_href' in value) return String(value['@_href']);
  }
  return String(value);
}

function asArray(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

// Summary HTML and CDATA down to plain text, with paragraph breaks kept.
function toPlain(html) {
  if (html == null) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
      if (body[0] === '#') {
        const code = /^#x/i.test(body) ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[body.toLowerCase()] || '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function httpLink(links) {
  for (const link of asArray(links)) {
    const href = textOf(link);
    if (/^https?:\/\//i.test(href)) return href;
  }
  return null;
}

function whenOf(...candidates) {
  for (const value of candidates) {
    if (!value) continue;
    const date = new Date(textOf(value));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

// RSS 2.0, RSS 1.0 (RDF) and Atom to the one shape server.js stores:
// { title, siteUrl, items: [{ guid, title, link, summary, author, publishedAt }] }
function parseFeed(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new FeedError('That address did not answer with readable XML.');
  }

  if (doc.rss && doc.rss.channel) {
    const channel = doc.rss.channel;
    const items = asArray(channel.item).map((item) => {
      const link = httpLink(item.link);
      const guid = textOf(item.guid);
      const title = toPlain(item.title);
      const summary = toPlain(item.description || item['content:encoded']);
      return {
        guid: guid || link || title || null,
        title,
        link,
        summary,
        author: toPlain(item['dc:creator'] || item.author) || null,
        publishedAt: whenOf(item.pubDate, item['dc:date']),
      };
    });
    return { title: toPlain(channel.title), siteUrl: httpLink(channel.link), items };
  }

  if (doc['rdf:RDF']) {
    const rdf = doc['rdf:RDF'];
    const channel = rdf.channel || {};
    const items = asArray(rdf.item).map((item) => {
      const link = httpLink(item.link);
      const title = toPlain(item.title);
      return {
        guid: link || title || null,
        title,
        link,
        summary: toPlain(item.description),
        author: toPlain(item['dc:creator']) || null,
        publishedAt: whenOf(item['dc:date']),
      };
    });
    return { title: toPlain(channel.title), siteUrl: httpLink(channel.link), items };
  }

  if (doc.feed) {
    const feed = doc.feed;
    const siteLink = asArray(feed.link).find((l) => l && l['@_rel'] !== 'self');
    const items = asArray(feed.entry).map((entry) => {
      const alt = asArray(entry.link).find((l) => !l || !l['@_rel'] || l['@_rel'] === 'alternate');
      const link = alt ? httpLink([alt['@_href']]) : null;
      const id = textOf(entry.id);
      const title = toPlain(entry.title);
      return {
        guid: id || link || title || null,
        title,
        link,
        summary: toPlain(entry.summary || entry.content),
        author: entry.author ? toPlain(entry.author.name) || null : null,
        publishedAt: whenOf(entry.published, entry.updated),
      };
    });
    return {
      title: toPlain(feed.title),
      siteUrl: siteLink ? httpLink([siteLink['@_href']]) : null,
      items,
    };
  }

  throw new FeedError('That address is not an RSS or Atom feed.');
}

// The whole thing: fetch through the guard, then parse.
async function fetchFeed(url) {
  const body = await guardedGet(new URL(url), 0);
  return parseFeed(body);
}

module.exports = { fetchFeed, assertWebUrl, isBlockedIp, toPlain };