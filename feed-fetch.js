'use strict';

/* Guarded fetching and RSS 2.0 / Atom parsing.
 *
 * Everything the app knows about a feed comes through here: a URL is checked
 * before a connection is made (loopback, private, link-local, CGNAT,
 * multicast, unspecified and IPv6 ULA addresses are refused, so a feed
 * address cannot be used to reach the app's own database host), and what
 * comes back is parsed into plain text — never HTML the page could render.
 */

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { XMLParser } = require('fast-xml-parser');

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB body limit
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'RSSReader/1.0 (Homeroom)';

// A failure with a code the API can name: not_a_feed, web_page, unreachable,
// blocked_address.
class FetchError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function isBlockedIp(ip) {
  const v6 = ip.includes(':');
  if (v6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true; // unspecified, loopback
    if (lower.startsWith('fe80')) return true; // link-local
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local (ULA fc00::/7)
    if (/^ff/.test(lower)) return true; // multicast
    // IPv4-mapped IPv6 (::ffff:10.0.0.1 and the like) — check the mapped part.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 127 || a === 10) return true; // unspecified, loopback, private
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast (224-239) and reserved (240-255)
  return false;
}

// The `lookup` option of http(s).request: resolve the hostname, refuse
// blocked answers, and hand the checked address to the connection itself so
// no second, unchecked resolution can redirect it.
function guardLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, family: options.family || 0 }, (err, addresses) => {
    if (err) return callback(err);
    const allowed = addresses.filter((a) => !isBlockedIp(a.address));
    if (!allowed.length) return callback(new FetchError('blocked_address'));
    callback(null, allowed[0].address, allowed[0].family);
  });
}

// A URL the app is willing to open: http or https, ports 80 and 443 only,
// no credentials in it.
function checkUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) return null;
  if (url.username || url.password) return null;
  if (!url.hostname) return null;
  return url;
}

function fetchOnce(url, redirects) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: 'GET',
        lookup: guardLookup,
        timeout: TIMEOUT_MS,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
        },
      },
      (res) => {
        // Follow at most 3 redirects, each one checked again.
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) return reject(new FetchError('unreachable'));
          const next = checkUrl(new URL(res.headers.location, url).toString());
          if (!next) return reject(new FetchError('blocked_address'));
          return resolve(fetchOnce(next, redirects + 1));
        }
        if ((res.statusCode || 500) >= 400) {
          res.resume();
          return reject(new FetchError('unreachable'));
        }
        const type = (res.headers['content-type'] || '').toLowerCase();
        if (type.includes('text/html') || type.includes('application/xhtml')) {
          res.resume();
          return reject(new FetchError('web_page'));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(new FetchError('unreachable'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', () => reject(new FetchError('unreachable')));
      }
    );
    req.on('timeout', () => req.destroy(new FetchError('unreachable')));
    req.on('error', (err) => reject(err instanceof FetchError ? err : new FetchError('unreachable')));
    req.end();
  });
}

// Fetch a feed address with the guard. Throws a FetchError with a code.
async function guardedFetch(rawUrl) {
  const url = checkUrl(rawUrl);
  if (!url) throw new FetchError('blocked_address');
  return fetchOnce(url, 0);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isNaN(code) || code > 0x10ffff ? whole : String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// Feed HTML becomes plain text: tags stripped, entities decoded, whitespace
// collapsed. The client renders this with textContent, never as HTML.
function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

// A value from the parsed XML may be a string, a number, an object with a
// '#text' key (when it carried attributes) or an array of any of these.
function textOf(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    const first = value.find((v) => v != null && textOf(v) !== '');
    return first ? textOf(first) : '';
  }
  if (typeof value === 'object') return textOf(value['#text'] ?? Object.values(value)[0]);
  return String(value);
}

function capAtWord(text, max) {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return (cut > max * 0.6 ? text.slice(0, cut) : text.slice(0, max)).trimEnd();
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(textOf(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });

function simpleHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// Parse RSS 2.0 or Atom into plain text. Throws not_a_feed when the body is
// neither.
function parseFeed(xmlText) {
  let doc;
  try {
    doc = parser.parse(xmlText);
  } catch {
    throw new FetchError('not_a_feed');
  }
  const rss = doc && doc.rss && doc.rss.channel;
  const atom = doc && doc.feed;
  if (!rss && !atom) throw new FetchError('not_a_feed');

  if (rss) {
    const channel = Array.isArray(rss) ? rss[0] : rss;
    const rawItems = channel.item ? (Array.isArray(channel.item) ? channel.item : [channel.item]) : [];
    return {
      title: htmlToText(textOf(channel.title)) || 'Untitled feed',
      siteUrl: textOf(channel.link && channel.link['#text'] !== undefined ? channel.link['#text'] : channel.link) || null,
      items: rawItems.map((item) => {
        const summary = htmlToText(textOf(item.description) || textOf(item['content:encoded']));
        const rawLink = textOf(item.link);
        return {
          guid: textOf(item.guid) || rawLink || simpleHash(textOf(item.title) + '|' + textOf(item.pubDate)),
          title: htmlToText(textOf(item.title)) || summary.split(' ').slice(0, 12).join(' ') || 'Untitled post',
          link: /^https?:\/\//.test(rawLink) ? rawLink : null,
          summary: capAtWord(summary, 2000),
          publishedAt: parseDate(item.pubDate),
        };
      }),
    };
  }

  const rawEntries = atom.entry ? (Array.isArray(atom.entry) ? atom.entry : [atom.entry]) : [];
  const siteLink = [].concat(atom.link || []).find((l) => l && l['@_rel'] === 'alternate') || [].concat(atom.link || [])[0];
  return {
    title: htmlToText(textOf(atom.title)) || 'Untitled feed',
    siteUrl: siteLink ? textOf(siteLink['@_href']) : null,
    items: rawEntries.map((entry) => {
      const links = [].concat(entry.link || []);
      const chosen = links.find((l) => l && (l['@_rel'] === 'alternate' || !l['@_rel'])) || links[0];
      const rawLink = chosen ? textOf(chosen['@_href']) : '';
      const summary = htmlToText(textOf(entry.summary) || textOf(entry.content));
      return {
        guid: textOf(entry.id) || rawLink || simpleHash(textOf(entry.title) + '|' + textOf(entry.updated)),
        title: htmlToText(textOf(entry.title)) || summary.split(' ').slice(0, 12).join(' ') || 'Untitled post',
        link: /^https?:\/\//.test(rawLink) ? rawLink : null,
        summary: capAtWord(summary, 2000),
        publishedAt: parseDate(entry.published) || parseDate(entry.updated),
      };
    }),
  };
}

module.exports = { guardedFetch, parseFeed, FetchError };