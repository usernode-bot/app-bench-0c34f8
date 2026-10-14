'use strict';

// Fetching and parsing RSS/Atom feeds for server.js. Everything a person
// typed goes through the guard first: http/https only, ports 80/443, DNS
// resolved and checked against loopback/private/link-local/CGNAT/metadata
// ranges (v4 and v6) before we connect to the checked address, at most 3
// redirects (each re-checked), 8 s timeout, 2 MB cap, no cookies or tokens.

const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const sanitizeHtml = require('sanitize-html');

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// A refused fetch, with the message shown to the person who typed the address.
class GuardError extends Error {}

const NOT_REACHED = 'That address could not be reached.';
const NOT_ALLOWED = 'That address is not allowed.';

// ── The address guard ─────────────────────────────────────────────────────

/** Add https:// when there is no scheme; refuse anything but http(s) on 80/443. */
function normalizeAddress(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new GuardError('Type a feed address first.');
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text);
  } catch {
    throw new GuardError('That does not look like an address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GuardError('Only http and https addresses are allowed.');
  }
  const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) throw new GuardError(NOT_ALLOWED);
  url.hash = '';
  url.username = '';
  url.password = '';
  return url;
}

function v4Forbidden(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  if (o[0] === 0 || o[0] === 10 || o[0] === 127) return true; // unspecified, private, loopback
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // private
  if (o[0] === 192 && o[1] === 168) return true; // private
  if (o[0] === 169 && o[1] === 254) return true; // link-local, cloud metadata
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
  return false;
}

function ipForbidden(ip) {
  const family = net.isIP(ip);
  if (family === 4) return v4Forbidden(ip);
  if (family !== 6) return true; // not an IP we can check
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)(?:%\d+)?$/);
  if (mapped) return v4Forbidden(mapped[1]);
  if (lower === '::' || lower === '::1') return true; // unspecified, loopback
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('fec0')) return true; // deprecated site-local
  return false;
}

/** Resolve the hostname and refuse forbidden addresses. Returns the checked address. */
async function resolveHost(hostname) {
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new GuardError(NOT_REACHED);
  }
  if (!addrs.length) throw new GuardError(NOT_REACHED);
  for (const a of addrs) {
    if (ipForbidden(a.address)) throw new GuardError(NOT_ALLOWED);
  }
  return addrs[0];
}

/** Fetch a URL through the guard, following at most 3 re-checked redirects. */
function fetchRaw(url, redirectsLeft = MAX_REDIRECTS) {
  const target = url instanceof URL ? url : new URL(String(url));
  const bareHost = target.hostname.replace(/^\[|\]$/g, '');
  let checked;
  const initial = net.isIP(bareHost) ? { address: bareHost, family: net.isIP(bareHost) } : null;
  if (initial) {
    if (ipForbidden(initial.address)) throw new GuardError(NOT_ALLOWED);
    checked = Promise.resolve(initial);
  } else {
    checked = resolveHost(bareHost);
  }
  return checked.then((ip) => new Promise((resolve, reject) => {
    // Pin the connection to the address we checked, not a second DNS
    // answer. Node may ask the lookup for every address at once (all: true,
    // its Happy Eyeballs), so answer in both shapes.
    const lookup = (_host, opts, cb) => (opts && opts.all
      ? cb(null, [{ address: ip.address, family: ip.family }])
      : cb(null, ip.address, ip.family));
    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(target, {
      lookup,
      timeout: FETCH_TIMEOUT_MS,
      headers: {
        // No cookies, tokens or credentials of any kind.
        'User-Agent': 'RSSReader/1.0 (Homeroom app)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume();
        const location = res.headers.location;
        let next;
        try {
          if (!location) throw new Error('no location');
          next = new URL(location, target);
        } catch {
          return reject(new GuardError(NOT_REACHED));
        }
        if (redirectsLeft < 1) return reject(new GuardError('That address redirected too many times.'));
        return resolve(fetchRaw(next, redirectsLeft - 1));
      }
      if (status !== 200) {
        res.resume();
        return reject(new GuardError(NOT_REACHED));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy(new GuardError('That feed is too big to read.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => reject(new GuardError(NOT_REACHED)));
    });
    req.on('timeout', () => req.destroy(new GuardError('That address took too long to answer.')));
    req.on('error', (err) => reject(err instanceof GuardError ? err : new GuardError(NOT_REACHED)));
    req.end();
  }));
}

/** fetchFeed(url): the guarded fetch plus parsing, for one feed address. */
async function fetchFeed(url) {
  const xml = await fetchRaw(normalizeAddress(url));
  return parseFeed(xml);
}

// ── Parsing (RSS 2.0, Atom, RSS 1.0) ─────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
});

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const asText = (x) => {
  if (x == null) return '';
  if (typeof x === 'object') return String(x['#text'] ?? x['@_href'] ?? '');
  return String(x);
};
const firstOkDate = (...values) => {
  for (const value of values) {
    const t = new Date(asText(value));
    if (!Number.isNaN(t.getTime())) return t.toISOString();
  }
  return null;
};

function parseFeed(xml) {
  let root;
  try {
    root = parser.parse(xml);
  } catch {
    throw new GuardError('That address is not a feed.');
  }
  if (root && root.rss && root.rss.channel) {
    return fromChannel(root.rss.channel, (item) => ({
      guid: asText(item.guid) || asText(item.link) || hashOf(`${asText(item.title)} ${asText(item.pubDate)}`),
      title: asText(item.title),
      link: asText(item.link) || null,
      publishedAt: firstOkDate(item.pubDate, item['dc:date']),
      content: asText(item['content:encoded']) || asText(item.description),
    }));
  }
  if (root && root.feed) {
    return fromChannel(root.feed, (entry) => {
      const links = asArray(entry.link).map((l) => ({ href: asText(l && l['@_href']), rel: asText(l && l['@_rel']) }));
      const link = (links.find((l) => l.href && (!l.rel || l.rel === 'alternate')) || links.find((l) => l.href) || {}).href || null;
      return {
        guid: asText(entry.id) || link || hashOf(`${asText(entry.title)} ${asText(entry.updated)}`),
        title: asText(entry.title),
        link,
        publishedAt: firstOkDate(entry.published, entry.updated),
        content: asText(entry.content) || asText(entry.summary),
      };
    });
  }
  if (root && root['rdf:RDF']) {
    return fromChannel(root['rdf:RDF'].channel || {}, (item) => ({
      guid: asText(item['rdf:about']) || asText(item.link) || hashOf(asText(item.title)),
      title: asText(item.title),
      link: asText(item.link) || null,
      publishedAt: firstOkDate(item['dc:date']),
      content: asText(item.description),
    }), asArray(root['rdf:RDF'].item));
  }
  throw new GuardError('That address is not a feed.');
}

function fromChannel(channel, readItem, rawItems) {
  const items = rawItems || asArray(channel.item);
  return {
    title: plainText(asText(channel.title)) || 'Untitled feed',
    siteUrl: asText(channel.link) || null,
    items: items.map((raw) => shapeItem(readItem(raw))),
  };
}

function shapeItem(raw) {
  const title = plainText(raw.title);
  const contentHtml = sanitizeContent(raw.content);
  const snippet = snippetFrom(raw.content);
  const fallbackTitle = title || snippet.split(/(?<=[.!?])\s| /)[0] ? snippet.split(/(?<=[.!?])\s| /).slice(0, 9).join(' ') : '';
  return {
    guid: String(raw.guid || raw.link || hashOf(`${title}|${raw.publishedAt || ''}`)),
    title,
    link: raw.link,
    publishedAt: raw.publishedAt,
    snippet,
    contentHtml,
    displayTitle: fallbackTitle,
  };
}

// ── Cleaning up what the feed carries ────────────────────────────────────

/** Titles and labels: text only, HTML entities decoded. */
function plainText(html) {
  return sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} }).trim();
}

/** The article text the feed carries, reduced to the tags we show. */
function sanitizeContent(html) {
  return sanitizeHtml(String(html || ''), {
    allowedTags: ['p', 'br', 'a', 'img', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'figure', 'figcaption'],
    allowedAttributes: { a: ['href'], img: ['src', 'alt'] },
    allowedSchemes: ['https'],
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
      img: sanitizeHtml.simpleTransform('img', { loading: 'lazy' }),
    },
  });
}

/** The first 220 characters of an item's text, as one line of plain words. */
function snippetFrom(html) {
  let text = sanitizeHtml(String(html || ''), { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 220) text = text.slice(0, 220).replace(/\s*\S*$/, '') + '…';
  return text;
}

function hashOf(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex');
}

/** The site's two-letter monogram: first letters of the first two title words. */
function monogram(title) {
  const words = String(title || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '??';
  const [first, second] = words;
  return ((first[0] || '') + (words.length > 1 ? (second[0] || '') : (first[1] || ''))).toUpperCase();
}

module.exports = {
  GuardError,
  NOT_REACHED,
  normalizeAddress,
  fetchFeed,
  parseFeed,
  sanitizeContent,
  plainText,
  snippetFrom,
  monogram,
};
