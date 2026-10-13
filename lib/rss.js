// Fetching and parsing RSS and Atom feeds, safely. Pure apart from safeFetch
// (and its DNS lookups). CLAUDE.md's "App-specific conventions" records the
// rules: only public web addresses, checked at every hop, feeds fetched only
// through safeFetch.
'use strict';

const dns = require('dns');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** Thrown when the fetched page parses as none of the feed formats. */
class NotAFeed extends Error {}

function badAddress() {
  return new Error("That doesn't look like a web address.");
}

/**
 * Trim the input, add https:// when there is no scheme, accept http and
 * https only, ports 80 and 443 or none, no credentials in the URL. Returns
 * the absolute URL as a string, or throws "That doesn't look like a web
 * address."
 */
function normalizeUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw badAddress();
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw badAddress();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badAddress();
  if (url.username || url.password) throw badAddress();
  if (url.port && url.port !== '80' && url.port !== '443') throw badAddress();
  url.hash = '';
  return url.toString();
}

/** Whether an IPv4 address sits in a range this app refuses (pure). */
function ipv4Private(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // this host, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  return a >= 224; // multicast and reserved
}

/** Whether a DNS lookup record (dns.lookup with all: true) is refused (pure). */
function isPrivateRecord(record) {
  if (!record || typeof record.address !== 'string') return true;
  if (record.family === 4) return ipv4Private(record.address);
  const a = record.address.toLowerCase();
  if (a === '::' || a === '::1') return true;
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
  if (mapped) return ipv4Private(mapped[1]);
  if (/^f[cd][0-9a-f]{2}:/.test(a)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(a)) return true; // fe80::/10 link-local
  return false;
}

/** Whether every record of a host is a public address we may fetch (pure). */
function allRecordsPublic(records) {
  return Array.isArray(records) && records.length > 0 && !records.some(isPrivateRecord);
}

async function assertPublicHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let records;
  try {
    records = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new Error("That address didn't answer. Check it and try again");
  }
  if (!allRecordsPublic(records)) {
    throw new Error('Only public web addresses can be added.');
  }
}

/** Read a response body up to MAX_BYTES, refusing anything longer. */
async function readBody(res) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch { /* already closing */ }
      throw new Error("That address didn't answer. Check it and try again");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Decode bytes with the Content-Type or XML declaration's charset, UTF-8 as the fallback. */
function decodeBody(buf, contentType) {
  let charset = /charset=["']?([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const head = buf.subarray(0, 1024).toString('latin1');
    charset = /encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  }
  if (charset) {
    try {
      return new TextDecoder(charset, { fatal: false }).decode(buf);
    } catch {
      // unknown label: fall through to UTF-8
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

/**
 * Fetch a public http(s) URL and return { body, contentType, url }: the body
 * as text (decoded through its declared charset), and the final URL after
 * redirects. Refuses private addresses, follows at most 3 redirects (each
 * hop re-checked), times out at 10 s and stops reading after 3 MB.
 */
async function safeFetch(url) {
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw badAddress();
  await assertPublicHost(target);
  const res = await fetch(target, {
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.5',
      'User-Agent': 'RSS Reader (Homeroom)',
    },
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (res.body) { try { await res.body.cancel(); } catch { /* already closed */ } }
    if (location) {
      const next = new URL(location, target);
      if (next.protocol === 'http:' || next.protocol === 'https:') {
        // Follow the hop, with one fewer redirect left.
        if (MAX_REDIRECTS > 0) return safeFetch.call(null, next, MAX_REDIRECTS - 1);
      }
    }
    throw new Error("That address didn't answer. Check it and try again");
  }
  if (!res.ok) throw new Error("That address didn't answer. Check it and try again");
  const buf = await readBody(res);
  const contentType = res.headers.get('content-type') || '';
  return { body: decodeBody(buf, contentType), contentType, url: target.toString() };
}

// safeFetch recurses with a redirect budget; give it a second parameter
// without widening the public signature's meaning.
const safeFetchBase = safeFetch;
// eslint-disable-next-line no-func-assign
safeFetch = async function safeFetch(url, redirects = MAX_REDIRECTS) {
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw badAddress();
  await assertPublicHost(target);
  const res = await fetch(target, {
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.5',
      'User-Agent': 'RSS Reader (Homeroom)',
    },
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    if (res.body) { try { await res.body.cancel(); } catch { /* already closed */ } }
    if (location && redirects > 0) {
      const next = new URL(location, target);
      if (next.protocol === 'http:' || next.protocol === 'https:') {
        return safeFetch(next, redirects - 1);
      }
    }
    throw new Error("That address didn't answer. Check it and try again");
  }
  if (!res.ok) throw new Error("That address didn't answer. Check it and try again");
  const buf = await readBody(res);
  const contentType = res.headers.get('content-type') || '';
  return { body: decodeBody(buf, contentType), contentType, url: target.toString() };
};
void safeFetchBase;

const PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  trimValues: true,
});

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** The text of a parsed node: 'x', or { '@_attr': …, '#text': 'x' } → 'x'.
 * Inline markup (a title with an <em> in it) parses as child keys; their
 * text is gathered too, so nothing in the middle of a title is lost. */
function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object') return '';
  const parts = [];
  if (typeof node['#text'] === 'string') parts.push(node['#text']);
  for (const [key, value] of Object.entries(node)) {
    if (key === '#text' || key.startsWith('@_')) continue;
    if (typeof value === 'string') parts.push(value);
    else if (value && typeof value === 'object' && typeof value['#text'] === 'string') parts.push(value['#text']);
  }
  return parts.join(' ');
}

function stripTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An item or channel link: a bare string, or an Atom <link> by rel. */
function linkOf(node, rel = null) {
  const pick = (entry) => {
    const href = typeof entry === 'object' && entry ? entry['@_href'] : textOf(entry);
    if (!href) return null;
    try {
      const url = new URL(href, 'https://placeholder.invalid');
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    } catch { /* not a URL */ }
    return null;
  };
  const entries = asArray(node);
  if (rel) {
    const named = entries.filter((e) => typeof e === 'object' && e && (e['@_rel'] || 'alternate') === rel);
    for (const e of named) { const hit = pick(e); if (hit) return hit; }
    return null;
  }
  for (const e of entries) { const hit = pick(e); if (hit) return hit; }
  return null;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
};

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => codePointText(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePointText(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (whole, name) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

function codePointText(code) {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/**
 * Feed HTML to plain paragraphs: script, style and iframe go with their
 * contents; p, br, li, h1–h6, div and blockquote boundaries become breaks;
 * every other tag is stripped; named and numeric entities are decoded. The
 * page renders the result as text only, so feed HTML never reaches the DOM.
 */
function htmlToParagraphs(html) {
  if (!html) return [];
  let s = String(html);
  s = s.replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<(script|style|iframe)\b[^>]*>/gi, '');
  s = s.replace(/<\/?(p|br|li|h[1-6]|div|blockquote)\b[^>]*>/gi, '\x00');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  // A boundary mark splits paragraphs; every other run of whitespace (a
  // literal newline inside a paragraph included) collapses to one space.
  return s
    .replace(/[^\S\x00]+/g, ' ')
    .split(/\x00+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The first <link rel="alternate" type="application/(rss|atom)+xml"> href, resolved. */
function findFeedLink(html, baseUrl) {
  const tags = String(html || '').match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = /rel\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1] || '';
    const type = /type\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1] || '';
    const href = /href\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (!href || !/alternate/i.test(rel)) continue;
    if (!/application\/(rss|atom)\+xml/i.test(type)) continue;
    try {
      const url = new URL(href, baseUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.toString();
    } catch { /* not a URL */ }
  }
  return null;
}

function guidOf(item, title, date, link) {
  const guid = textOf(item.guid) || textOf(item.id);
  if (guid) return guid;
  if (link) return link;
  return crypto.createHash('sha1').update(`${title}\u0000${date}`).digest('hex');
}

function authorOf(item) {
  const direct = stripTags(textOf(item.author));
  if (direct) return direct;
  const creator = stripTags(textOf(item['dc:creator']));
  if (creator) return creator;
  if (item.author && typeof item.author === 'object') {
    const name = stripTags(textOf(item.author.name));
    if (name) return name;
  }
  return '';
}

function textOfItem(item) {
  return textOf(item['content:encoded']) || textOf(item.content) || textOf(item.description) || textOf(item.summary) || '';
}

function dateOf(item, fallback) {
  const raw = textOf(item.pubDate) || textOf(item.published) || textOf(item.updated) || textOf(item['dc:date']);
  const t = raw ? new Date(raw).getTime() : NaN;
  if (!Number.isFinite(t)) return new Date(fallback);
  return new Date(Math.min(t, new Date(fallback).getTime()));
}

/**
 * Parse a feed's XML: RSS 2.0 (channel.item), RSS 1.0/RDF (rdf:RDF.item) or
 * Atom (feed.entry, links by rel). `now` is the fetch time: an invalid or
 * missing date becomes it, and future dates are clamped to it. Returns
 * { title, siteUrl, items: [{ guid, title, link, author, text, date }] } and
 * throws NotAFeed when no root matches.
 */
function parseFeed(xml, baseUrl, now = new Date()) {
  let doc;
  try {
    doc = PARSER.parse(String(xml || ''));
  } catch {
    throw new NotAFeed("That page isn't a feed. Paste the feed's own address, often ending in /feed or .xml");
  }
  let channelTitle = '';
  let siteUrl = null;
  let rawItems = null;
  if (doc && doc.rss && doc.rss.channel) {
    channelTitle = stripTags(textOf(doc.rss.channel.title));
    siteUrl = linkOf(doc.rss.channel.link);
    rawItems = asArray(doc.rss.channel.item);
  } else if (doc && doc['rdf:RDF']) {
    channelTitle = stripTags(textOf(doc['rdf:RDF'].channel && doc['rdf:RDF'].channel.title));
    siteUrl = linkOf(doc['rdf:RDF'].channel && doc['rdf:RDF'].channel.link);
    rawItems = asArray(doc['rdf:RDF'].item);
  } else if (doc && doc.feed) {
    channelTitle = stripTags(textOf(doc.feed.title));
    siteUrl = linkOf(doc.feed.link, 'alternate');
    rawItems = asArray(doc.feed.entry);
  } else {
    throw new NotAFeed("That page isn't a feed. Paste the feed's own address, often ending in /feed or .xml");
  }
  const items = rawItems.map((item) => {
    const title = stripTags(textOf(item.title)) || 'Untitled post';
    const link = linkOf(item.link);
    const date = dateOf(item, now);
    return {
      guid: String(guidOf(item, title, date.toISOString(), link)),
      title,
      link,
      author: authorOf(item),
      text: textOfItem(item),
      date,
    };
  });
  return { title: channelTitle, siteUrl, items };
}

module.exports = {
  NotAFeed,
  normalizeUrl,
  safeFetch,
  parseFeed,
  htmlToParagraphs,
  findFeedLink,
  // Exposed pure helpers for the tests.
  ipv4Private,
  isPrivateRecord,
  allRecordsPublic,
};