'use strict';
/* Fetching and parsing RSS/Atom feeds, with no npm packages: Node's own
 * fetch and a hand-written XML reader. Two jobs:
 *
 *   safeFetch(url)  — get a feed's bytes without letting the address point
 *                     back at this machine or the platform (SSRF guard).
 *   parseFeed(text) — turn RSS 2.0 or Atom XML into plain objects.
 *
 * A FeedError is a message fit to show the person who typed the address.
 */

const dns = require('dns').promises;
const net = require('net');

class FeedError extends Error {}

/** Whether an IP may not be reached from inside the platform: loopback,
 * private, link-local, CGNAT, benchmarking, multicast/reserved, and the
 * cloud metadata endpoint (169.254.169.254 sits in link-local). */
function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;                       // this-network, private, loopback
    if (a === 169 && b === 254) return true;                                // link-local (incl. metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;                       // private
    if (a === 192 && b === 168) return true;                                // private
    if (a === 100 && b >= 64 && b <= 127) return true;                      // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true;                   // benchmarking
    if (a >= 224) return true;                                              // multicast + reserved
    return false;
  }
  const n = ip.toLowerCase();
  if (n === '::' || n === '::1') return true;                               // unspecified, loopback
  if (/^f[ef]/.test(n) || /^ff/.test(n)) return true;                       // fc00-fdff private, fe80-feff link-local, ff00 multicast
  const mapped = n.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})(?:%\d+)?$/);      // ::ffff:192.0.2.1 and v6 forms ending in v4
  if (mapped && net.isIPv4(mapped[1])) return isBlockedIp(mapped[1]);
  return false;
}

/** The first address the host resolves to, if none is blocked. */
async function resolveHost(hostname) {
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new FeedError('That address could not be found.');
  }
  const allowed = records.filter((record) => !isBlockedIp(record.address));
  if (!allowed.length) {
    // Every answer is loopback, private or otherwise unreachable from here.
    throw new FeedError('That address is not reachable from here.');
  }
  return allowed[0].address;
}

const USER_AGENT = 'Homeroom RSS Reader (+https://onhomeroom.com)';

/**
 * Fetch a feed's bytes: http or https only, the host resolved and checked
 * before each hop, at most 3 redirects re-checked the same way, an 8 second
 * timeout and a 2 MB body limit. Returns { text, url, contentType }.
 * Throws a FeedError with a message fit to show.
 */
async function safeFetch(rawUrl, { timeoutMs = 8000, maxBytes = 2 * 1024 * 1024 } = {}) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new FeedError('That address is not a valid URL.');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new FeedError('Only http and https addresses work here.');
  }
  if (!target.hostname) throw new FeedError('That address has no site in it.');

  for (let hop = 0; hop <= 3; hop += 1) {
    await resolveHost(target.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(target, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
      });
    } catch {
      throw new FeedError('The site could not be reached.');
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      try { if (res.body) res.body.cancel(); } catch { /* already gone */ }
      if (!location) throw new FeedError('The site sent an incomplete redirect.');
      if (hop === 3) throw new FeedError('The site redirects too many times.');
      let next;
      try {
        next = new URL(location, target);
      } catch {
        throw new FeedError('The site sent a redirect that does not parse.');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new FeedError('The site redirects somewhere that is not a website.');
      }
      target = next;
      continue;
    }

    if (!res.ok) throw new FeedError(`The site answered with an error (${res.status}).`);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) throw new FeedError('That feed is too large to read.');
    return { text: buffer.toString('utf8'), url: target.href, contentType: type };
  }
  throw new FeedError('The site redirects too many times.');
}

/* ── The XML reader ────────────────────────────────────────────────────────
 * A small tolerant parser: it reads a tree of { name, attrs, children }
 * where text and CDATA are { text } children. It is not a general XML
 * validator — feeds in the wild are often not — so mismatches are
 * absorbed rather than thrown: a closing tag with no open match is
 * ignored, and unclosed tags end at the document's end.
 */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', copy: '©', reg: '®', trade: '™', eacute: 'é',
  egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä',
  szlig: 'ß', laquo: '«', raquo: '»', middot: '·', bull: '•', deg: '°',
  frac12: '½', frac14: '¼', frac34: '¾', times: '×', divide: '÷',
};

/** Decode XML and the common HTML entities; unknown ones are left as written. */
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X'
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return ENTITIES[name] !== undefined ? ENTITIES[name] : whole;
  });
}

function parseAttrs(chunk) {
  const attrs = {};
  const re = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]*))?/g;
  for (const match of chunk.matchAll(re)) {
    const raw = match[2];
    if (raw === undefined) { attrs[match[1]] = ''; continue; }
    const q = raw[0];
    attrs[match[1]] = (q === '"' || q === "'") ? raw.slice(1, -1) : raw;
  }
  return attrs;
}

/** Where a `<tag …>` ends, skipping quoted attribute values. */
function tagEnd(text, start) {
  let quote = null;
  for (let i = start + 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

function parseXml(text) {
  const root = { name: '#document', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];

  while (i < text.length) {
    if (/^<!\[CDATA\[/.test(text.slice(i, i + 9))) {
      const end = text.indexOf(']]>', i + 9);
      const chunk = end === -1 ? text.slice(i + 9) : text.slice(i + 9, end);
      top().children.push({ text: chunk });
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (/^<!--/.test(text.slice(i, i + 4))) {
      const end = text.indexOf('-->', i + 4);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (/^<\?/.test(text.slice(i, i + 2))) {
      const end = text.indexOf('?>', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (/^<!/.test(text.slice(i, i + 2))) {
      const end = text.indexOf('>', i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text[i] === '<' && text[i + 1] === '/') {
      const end = text.indexOf('>', i + 2);
      const name = (end === -1 ? text.slice(i + 2) : text.slice(i + 2, end)).trim().toLowerCase();
      const at = stack.map((el) => el.name).lastIndexOf(name);
      if (at > 0) stack.length = at; // pop to the matching open tag
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (text[i] === '<') {
      const end = tagEnd(text, i);
      if (end === -1) break; // truncated tag: the rest is not XML
      const chunk = text.slice(i + 1, end);
      const spaceAt = chunk.search(/[\s]/);
      const name = (spaceAt === -1 ? chunk : chunk.slice(0, spaceAt)).toLowerCase();
      const attrs = spaceAt === -1 ? {} : parseAttrs(chunk.slice(spaceAt + 1));
      i = end + 1;
      if (name.startsWith('!') || name.startsWith('?')) continue;
      if (chunk.endsWith('/')) {
        top().children.push({ name, attrs, children: [] });
        continue;
      }
      const el = { name, attrs, children: [] };
      top().children.push(el);
      stack.push(el);
      continue;
    }
    const next = text.indexOf('<', i);
    const chunk = next === -1 ? text.slice(i) : text.slice(i, next);
    if (chunk.trim()) top().children.push({ text: chunk });
    i = next === -1 ? text.length : next;
  }
  return root;
}

/** The element's direct children with a local name (name:prefix stripped). */
function childrenOf(el, localName) {
  const wanted = String(localName).toLowerCase();
  return el.children.filter((c) => c.name && c.name.split(':').pop() === wanted);
}

/** First direct child with a local name, or null. */
function childOf(el, localName) {
  return childrenOf(el, localName)[0] || null;
}

/** The element's text: text and CDATA children joined, entities decoded. */
function textOf(el) {
  return decodeEntities(el.children.filter((c) => typeof c.text === 'string').map((c) => c.text).join('')).trim();
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** RFC 822 ("Wed, 02 Oct 2024 08:00:00 GMT"), RFC 3339/ISO, or null. */
function parseDate(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const rfc822 = text.match(/^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([+-]\d{4}|[A-Za-z]{1,5})?/);
  if (rfc822) {
    const [, d, mon, y, hh = '0', mm = '00', ss = '00', zone] = rfc822;
    const month = MONTHS[mon.slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      let offset = 0;
      if (zone && /^[+-]\d{4}$/.test(zone)) {
        offset = (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))) * (zone[0] === '-' ? -1 : 1);
      }
      const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
      const utc = Date.UTC(year, month, Number(d), Number(hh), Number(mm), Number(ss));
      const when = new Date(utc - offset * 60000);
      if (!Number.isNaN(when.getTime())) return when;
    }
  }
  const fallback = new Date(text);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** Plain text out of a fragment the feed says is HTML, for the snippet. */
function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** What makes a stable id for a post: guid, then id, then link, then title. */
function pickGuid(item, link, title) {
  return textOr(item, 'guid') || textOr(item, 'id') || link || title || null;
}

function textOr(item, name) {
  const child = childOf(item, name);
  return child ? textOf(child) : null;
}

function hrefOfLink(item) {
  for (const link of childrenOf(item, 'link')) {
    const rel = (link.attrs.rel || '').toLowerCase();
    if (rel === '' || rel === 'alternate') {
      return (link.attrs.href ? decodeEntities(link.attrs.href) : textOf(link)) || null;
    }
  }
  return null;
}

function authorOf(item) {
  const atom = childOf(item, 'author');
  if (atom) {
    const name = childOf(atom, 'name');
    if (name) return textOf(name) || null;
  }
  return textOr(item, 'creator') || textOr(item, 'author') || null;
}

function firstWords(text, count = 12) {
  return (text || '').split(/\s+/).slice(0, count).join(' ');
}

function shorten(text, max = 240) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

/**
 * parseFeed(xml) → { title, siteUrl, posts: [{ guid, title, link, author,
 * publishedAt, contentHtml, summaryText }] }, or null when the document is
 * neither RSS 2.0 nor Atom (no channel/entry structure at all).
 */
function parseFeed(xml) {
  const doc = parseXml(String(xml || '').replace(/^﻿/, ''));
  // RSS 2.0 (an <rss> or <channel> root) or Atom (a <feed> root).
  const channel = doc.children.find((c) => c.name === 'channel' || (c.name === 'rss' && childOf(c, 'channel')));
  const rssRoot = channel || doc.children.find((c) => c.name === 'channel');
  const atomFeed = doc.children.find((c) => c.name === 'feed');
  const feedEl = atomFeed || (rssRoot ? (childOf(rssRoot, 'channel') || rssRoot) : null);
  if (!feedEl) return null;

  const items = atomFeed ? childrenOf(feedEl, 'entry') : childrenOf(feedEl, 'item');
  const feedTitle = textOr(feedEl, 'title');
  const siteUrl = atomFeed
    ? hrefOfLink(feedEl)
    : (textOr(feedEl, 'link') || null);

  const posts = [];
  for (const item of items.slice(0, 200)) {
    const title = textOr(item, 'title') || '';
    const link = atomFeed ? hrefOfLink(item) : (textOr(item, 'link') || textOr(item, 'guid')) || null;
    const description = textOr(item, 'description') || textOr(item, 'summary') || '';
    const contentHtml = textOr(item, 'encoded') || textOr(item, 'content') || description || '';
    const published = parseDate(textOr(item, 'pubdate') || textOr(item, 'published') || textOr(item, 'updated') || textOr(item, 'date'));
    const guid = pickGuid(item, link, title);
    if (guid == null && !title && !link) continue;
    const snippet = shorten(htmlToText(contentHtml) || htmlToText(description));
    posts.push({
      guid,
      title: title || firstWords(snippet) || 'Untitled post',
      link,
      author: authorOf(item),
      publishedAt: published,
      contentHtml,
      summaryText: snippet,
    });
  }

  return {
    title: feedTitle || null,
    siteUrl: siteUrl || null,
    posts,
  };
}

module.exports = { safeFetch, parseFeed, parseDate, htmlToText, FeedError };
