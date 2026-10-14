// Fetching, finding and parsing feeds, safely: this code fetches addresses
// people paste in, so it never talks to the machine's own network and never
// pulls down an unbounded body.
'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns');
const { XMLParser } = require('fast-xml-parser');

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB body limit
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'Homeroom RSS Reader (+https://onhomeroom.com)';

/** A fetch failure that is fine to show the person who pasted the address. */
function fetchError(message) {
  return Object.assign(new Error(message), { safe: true });
}

// Addresses this container must never talk to: itself, the private network
// behind it, and the reserved ranges in between. Checked at connect time on
// every hop, so a name that resolves to an internal IP is refused.
function isBlockedIp(ip) {
  const v4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip);
  if (v4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // unspecified, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a >= 224) return true; // multicast, reserved, broadcast
    return false;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true; // unspecified, loopback
  if (/^f[cd]/.test(v6)) return true; // unique local
  if (/^fe[89ab]/.test(v6)) return true; // link-local
  if (/^ff/.test(v6)) return true; // multicast
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(v6);
  return mapped ? isBlockedIp(mapped[1]) : false;
}

// Resolve once, validate every answer, then pin the request to the first
// address that passed: the connection cannot be steered elsewhere by a
// second lookup behind our back.
function safeLookup(host, options, callback) {
  dns.lookup(host, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const allowed = (addresses || []).filter((a) => !isBlockedIp(a.address));
    if (!allowed.length) return callback(fetchError('That address points somewhere this app cannot go.'));
    const picked = allowed[0];
    callback(null, picked.address, picked.family);
  });
}

/**
 * safeFetch(url): GET an http(s) address and return { body, finalUrl }.
 * Manual redirects (at most 3, each rechecked), an 8 s timeout and a 2 MB
 * body limit. A non-2xx answer, a bad scheme or an unreachable host throws
 * a `safe` error whose message can be shown as it is.
 */
async function safeFetch(url, redirects = 0) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw fetchError('That is not a web address. Check it and try again.');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw fetchError('Only http and https addresses work.');
  }
  // Node skips the custom lookup for an address that is already an IP
  // literal, so the connect-time check never fires for one: check it here.
  const host = target.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedIp(host)) {
    throw fetchError('That address points somewhere this app cannot go.');
  }
  const mod = target.protocol === 'https:' ? https : http;
  const body = await new Promise((resolve, reject) => {
    const req = mod.get({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html, */*',
      },
      timeout: TIMEOUT_MS,
      lookup: safeLookup,
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume();
        const location = res.headers.location;
        if (!location) return reject(fetchError('Could not reach that address. Check it and try again.'));
        if (redirects >= MAX_REDIRECTS) return reject(fetchError('That address redirects too many times.'));
        let next;
        try { next = new URL(location, target).href; } catch {
          return reject(fetchError('That address redirects somewhere that is not a web address.'));
        }
        return safeFetch(next, redirects + 1).then(resolve, reject);
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(fetchError('Could not reach that address. Check it and try again.'));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          reject(fetchError('That address sends too much to read here.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => reject(fetchError('Could not read that address. Try again in a moment.')));
    });
    req.on('timeout', () => req.destroy(fetchError('That address took too long to answer.')));
    req.on('error', (err) => reject(err.safe ? err : fetchError('Could not reach that address. Check it and try again.')));
  });
  return { body, finalUrl: target.href };
}

// A first pass over a fetched document, only to decide where to look for the
// feed. Full parsing is parseFeed's job.
function looksLikeHtml(text) {
  return /<html[\s>]/i.test(text.slice(0, 1000)) || /^\s*<!doctype html/i.test(text);
}

/**
 * discover(html, baseUrl): the first <link rel="alternate"> on the page
 * whose type is an RSS or Atom feed, resolved against the page's address.
 * Null when the page offers none.
 */
function discover(html, baseUrl) {
  const tags = String(html).slice(0, 300 * 1024).match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = /rel\s*=\s*["']?([^"'\s>]+)/i.exec(tag);
    const type = /type\s*=\s*["']?([^"'\s>]+)/i.exec(tag);
    if (!rel || !/\balternate\b/i.test(rel[1])) continue;
    if (type && !/(?:rss|atom)\+xml/i.test(type[1])) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!href) continue;
    try {
      const resolved = new URL(href[1].trim(), baseUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') return resolved.href;
    } catch { /* a broken href is not a feed */ }
  }
  return null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
});

// A node that may be a string, { '#text': string } or a list of those.
function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node).trim();
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === 'object') return textOf(node['#text'] != null ? node['#text'] : null);
  return '';
}

// Summary text: the feed's HTML stripped down to plain sentences.
function plainText(html) {
  return String(html)
    .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&(?:#39|#x27);/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number(code);
      return num >= 32 && num < 0x110000 ? String.fromCodePoint(num) : ' ';
    })
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

function firstAlternateLink(entry) {
  const links = [].concat(entry.link || []);
  const alternate = links.find((l) => l && typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate'));
  if (alternate) return textOf(alternate['#text'] != null ? alternate['#text'] : '') || alternate['@_href'] || '';
  return textOf(links[0]) || '';
}

/**
 * parseFeed(xml): an RSS 2.0 or Atom document as
 * { title, items: [{ guid, link, title, publishedAt, summary }] }, summaries
 * stripped to plain text. Throws when the document is neither.
 */
function parseFeed(xml) {
  let doc;
  try {
    doc = parser.parse(String(xml));
  } catch {
    throw fetchError('That address is not a feed. Check it and try again.');
  }
  const rss = doc && doc.rss;
  const atom = doc && doc.feed;
  if (rss && rss.channel) {
    const channel = Array.isArray(rss.channel) ? rss.channel[0] : rss.channel;
    const items = [].concat(channel.item || []).filter(Boolean);
    return {
      title: plainText(textOf(channel.title)),
      items: items.map((item) => ({
        guid: textOf(item.guid),
        link: textOf(item.link) || textOf(item.guid),
        title: plainText(textOf(item.title)),
        publishedAt: parseDate(item.pubDate || item['dc:date']),
        summary: plainText(item.description || item['content:encoded'] || ''),
      })),
    };
  }
  if (atom) {
    const entries = [].concat(atom.entry || []).filter(Boolean);
    return {
      title: plainText(textOf(atom.title)),
      items: entries.map((entry) => ({
        guid: textOf(entry.id),
        link: firstAlternateLink(entry),
        title: plainText(textOf(entry.title)),
        publishedAt: parseDate(entry.published || entry.updated),
        summary: plainText(
          (entry.summary && (entry.summary['#text'] != null ? entry.summary['#text'] : entry.summary))
          || (entry.content && (entry.content['#text'] != null ? entry.content['#text'] : entry.content))
          || ''
        ),
      })),
    };
  }
  throw fetchError('That address is not a feed. Check it and try again.');
}

function parseDate(value) {
  const text = textOf(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

module.exports = { safeFetch, parseFeed, discover, looksLikeHtml, isBlockedIp };
