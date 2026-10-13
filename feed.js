'use strict';
// Fetching and parsing RSS and Atom feeds for the add-feed flow and the
// unread list refresh. Addresses here are ones people typed, so every fetch
// goes through the guard below: http/https only, ports 80 and 443, hostnames
// resolved and refused when they point at loopback, private, link-local,
// CGNAT or metadata addresses, redirects followed by hand (at most 3, each
// hop re-checked), 5 MB cap, 10 s timeout, a plain User-Agent.
//
// parseFeed reads RSS 2.0, RSS 1.0 (RDF) and Atom into
// { title, siteUrl, items: [{ guid, title, link, publishedAt, contentHtml, snippet }] }.
// contentHtml is sanitized here (text tags, links and https images only);
// the snippet is the plain text of about 200 characters.

const { XMLParser } = require('fast-xml-parser');
const sanitizeHtml = require('sanitize-html');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'RSS-Reader/1.0 (feed fetcher)';

class FeedError extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
});

// ── The fetch guard ──────────────────────────────────────────────────────

function isPrivateIp(ip) {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 169 && b === 254) return true; // link-local, incl. metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  const low = String(ip).toLowerCase();
  if (low === '::' || low === '::1') return true;
  if (low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd')) return true;
  if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7));
  return /^64:ff9b/.test(low); // NAT64 mapping of a v4 address
}

async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new FeedError('That site could not be reached.');
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw new FeedError('That site could not be reached.');
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) {
    throw new FeedError('That site could not be reached.');
  }
}

function checkUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new FeedError('That does not look like an address.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FeedError('Only http and https addresses work.');
  }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    throw new FeedError('Only addresses on ports 80 and 443 work.');
  }
  return parsed;
}

async function fetchGuarded(url, redirects = 0) {
  const parsed = checkUrl(url);
  await assertPublicHost(parsed.hostname);
  let res;
  try {
    res = await fetch(parsed, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8',
      },
    });
  } catch (err) {
    throw new FeedError(err && err.name === 'TimeoutError'
      ? 'That site took too long to answer.' : 'That site could not be reached.');
  }
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.get('location');
    if (!location) throw new FeedError('That site answered with a redirect that goes nowhere.');
    if (redirects >= MAX_REDIRECTS) throw new FeedError('That address redirects too many times.');
    res.body?.cancel?.();
    return fetchGuarded(new URL(location, parsed).href, redirects + 1);
  }
  if (!res.ok) throw new FeedError(`That site answered with an error (${res.status}).`);
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_BYTES) {
    throw new FeedError('That feed is too large to read.');
  }
  const body = await res.arrayBuffer();
  if (body.byteLength > MAX_BYTES) throw new FeedError('That feed is too large to read.');
  return Buffer.from(body).toString('utf8');
}

/** Guarded fetch of a feed address: returns the response body as text. */
async function fetchFeed(url) {
  return fetchGuarded(url);
}

// ── Parsing ──────────────────────────────────────────────────────────────

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
  if (typeof v === 'object') return text(v['#text'] != null ? v['#text'] : v.value);
  return '';
};

const firstLink = (entry) => {
  for (const link of asArray(entry.link)) {
    const rel = link && typeof link === 'object' ? link['@_rel'] : null;
    if (!rel || rel === 'alternate') return typeof link === 'object' ? link['@_href'] : link;
  }
  return '';
};

const whenOf = (item) => {
  for (const key of ['pubDate', 'published', 'updated', 'dc:date', 'date']) {
    const raw = text(item[key]);
    if (!raw) continue;
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
};

const contentOf = (item) => {
  for (const key of ['content:encoded', 'content', 'description', 'summary']) {
    const raw = item[key];
    if (raw == null) continue;
    const html = typeof raw === 'object' ? text(raw) : String(raw);
    if (html.trim()) return html;
  }
  return '';
};

function guidOf(item, link) {
  const explicit = text(item.guid) || text(item.id);
  if (explicit) return explicit;
  if (link) return link;
  return 'hash:' + crypto.createHash('sha256')
    .update(`${text(item.title)}|${whenOf(item) ? whenOf(item).toISOString() : ''}`)
    .digest('hex').slice(0, 32);
}

const SANITIZE = {
  allowedTags: ['a', 'p', 'br', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li',
    'em', 'strong', 'b', 'i', 'u', 's', 'code', 'pre', 'img', 'figure', 'figcaption', 'hr',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'dl', 'dt', 'dd', 'sup', 'sub', 'small', 'span'],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title', 'width', 'height'],
  },
  allowedSchemes: ['http', 'https'],
  nonTextTags: ['style', 'script', 'noscript', 'iframe', 'object', 'embed', 'form', 'textarea'],
  transformTags: {
    img: (tagName, attribs) => ({
      tagName: 'img',
      attribs: {
        src: attribs.src || '',
        alt: attribs.alt || '',
        loading: 'lazy',
        referrerpolicy: 'no-referrer',
      },
    }),
  },
};

const snippetOf = (html) => {
  const t = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= 200) return t;
  return `${t.slice(0, 197).replace(/\s+\S*$/, '').trim()}…`;
};

function normalizeItem(item) {
  const contentHtml = sanitizeHtml(contentOf(item), SANITIZE);
  return {
    guid: guidOf(item, text(item.link)),
    title: text(item.title),
    link: text(item.link),
    publishedAt: whenOf(item),
    contentHtml,
    snippet: snippetOf(contentHtml),
  };
}

/** Parse a feed's XML into { title, siteUrl, items }. Throws FeedError when it is not a feed. */
function parseFeed(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new FeedError('That address does not look like a feed.');
  }
  if (doc && doc.rss && doc.rss.channel) {
    const channel = doc.rss.channel;
    return {
      title: text(channel.title),
      siteUrl: text(channel.link) || null,
      items: asArray(channel.item).map(normalizeItem),
    };
  }
  if (doc && doc.feed) {
    const feed = doc.feed;
    return {
      title: text(feed.title),
      siteUrl: firstLink(feed) || null,
      items: asArray(feed.entry).map((entry) => {
        const item = { ...entry, link: firstLink(entry), guid: entry.id };
        return normalizeItem(item);
      }),
    };
  }
  const rdf = doc && (doc['rdf:RDF'] || doc.RDF);
  if (rdf) {
    return {
      title: text(rdf.channel && rdf.channel.title),
      siteUrl: (rdf.channel && text(rdf.channel.link)) || null,
      items: asArray(rdf.item).map((entry) => {
        const item = { ...entry, link: text(entry.link) || entry['@_rdf:about'] };
        return normalizeItem(item);
      }),
    };
  }
  throw new FeedError('That address does not look like a feed.');
}

module.exports = { fetchFeed, parseFeed, FeedError };