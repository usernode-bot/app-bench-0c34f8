'use strict';

// Fetching and parsing RSS/Atom feeds, with the guards the spec asks for:
// http(s) only, a DNS lookup whose addresses are checked against the private
// ranges (loopback, private, link-local, CGNAT, metadata) before every hop,
// at most 3 redirects each re-checked, an 8 s timeout and a 2 MB cap.

const dns = require('dns').promises;
const net = require('net');

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;

// ── Address guards ─────────────────────────────────────────────────────────

function isBlockedIp4(a, b) {
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local (the metadata host lives here)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isBlockedIp6(ip) {
  const v = ip6ToBigInt(ip);
  if (v === null) return true; // unparseable: refuse
  if (v === 0n) return true; // ::
  if (v === 1n) return true; // ::1
  if ((v >> 121n) === 0x7en) return true; // fc00::/7 unique local
  if ((v >> 118n) === 0x3fan) return true; // fe80::/10 link-local
  if ((v >> 120n) === 0xffn) return true; // ff00::/8 multicast
  if ((v >> 32n) === 0xffffn) { // ::ffff:0808:0808 — mapped v4 in hex form
    return isBlockedIp4(Number((v >> 24n) & 0xffn), Number((v >> 16n) & 0xffn));
  }
  if (v >= 0x64ff9a00n && v <= 0x64ff9affn) return true; // 64:ff9a::/96 mapped v4 (well-known prefix)
  return false;
}

// Expand an IPv6 address to its 128-bit number. Null when it is not valid.
function ip6ToBigInt(ip) {
  if (ip.includes('::') && ip.split('::').length > 2) return null;
  const parts = ip.split('::');
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts[1] !== undefined ? parts[1].split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (!ip.includes('::') && missing !== 0)) return null;
  const groups = left.concat(Array(missing).fill('0'), right);
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    value = (value << 16n) | BigInt(parseInt(g, 16));
  }
  return value;
}

function isBlockedIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const o = ip.split('.').map(Number);
    return isBlockedIp4(o[0], o[1], o[2]);
  }
  if (kind === 6) {
    // A mapped v4 address is checked by its v4 part, in either form.
    const quad = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (quad) {
      const o = quad[1].split('.').map(Number);
      return isBlockedIp4(o[0], o[1]);
    }
    const v = ip6ToBigInt(ip);
    if (v !== null && (v >> 32n) === 0xffffn) {
      return isBlockedIp4(Number((v >> 24n) & 0xffn), Number((v >> 16n) & 0xffn));
    }
    return isBlockedIp6(ip);
  }
  return true;
}

// Resolve a hostname and refuse it when any of its addresses is private.
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) throw new Error('That address is not reachable from here.');
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('That address could not be reached. Check it and try again.');
  }
  if (!addrs.length) throw new Error('That address could not be reached. Check it and try again.');
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new Error('That address is not reachable from here.');
  }
}

// ── The guarded fetch ──────────────────────────────────────────────────────

async function readCapped(body) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch { /* the body is gone either way */ }
      throw new Error('That page is too large to read.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch a URL with every guard applied. Resolves { url, status, type, text }
 * for any answer; throws with a short, showable message when the address is
 * not reachable, private, too large or too slow. Each redirect hop is
 * re-checked against the private ranges.
 */
async function safeFetch(url, depth = 0) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('That address does not look right. Check it and try again.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https addresses work.');
  }
  await assertPublicHost(u.hostname);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(u, {
      redirect: 'manual',
      signal: ctrl.signal,
      headers: {
        'user-agent': 'RSSReader/1.0 (feed reader)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.8',
      },
    });
  } catch {
    clearTimeout(timer);
    throw new Error('That address could not be reached. Check it and try again.');
  }
  try {
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('That address could not be reached.');
      if (depth >= MAX_REDIRECTS) throw new Error('That address redirects too many times.');
      if (res.body) await res.body.cancel().catch(() => {});
      return safeFetch(new URL(loc, u).href, depth + 1);
    }
    const text = await readCapped(res.body);
    return { url: u, status: res.status, type: res.headers.get('content-type') || '', text: text.toString('utf8') };
  } finally {
    clearTimeout(timer);
  }
}

// ── Feed discovery ─────────────────────────────────────────────────────────

function attr(tags, name) {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tags.match(re);
  if (!m) return null;
  return m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
}

/**
 * Look for <link rel="alternate" type="…rss…|…atom…" href="…"> in an HTML
 * page and resolve it against the page's address. Returns the feed URL, or
 * null when the page advertises none.
 */
function discover(html, base) {
  if (typeof html !== 'string') return null;
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = (attr(tag, 'rel') || '').toLowerCase();
    if (!rel.split(/\s+/).includes('alternate')) continue;
    const type = (attr(tag, 'type') || '').toLowerCase();
    if (!/rss|atom/.test(type)) continue;
    const href = attr(tag, 'href');
    if (!href) continue;
    try {
      return new URL(href, base).href;
    } catch { /* a broken href is not a feed */ }
  }
  return null;
}

// ── Parsing ────────────────────────────────────────────────────────────────

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', mdash: '-',
  ndash: '-', middot: '·', eacute: 'é', ouml: 'ö', uuml: 'ü',
};

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : m));
}

function safeCodePoint(code) {
  // Refuse control characters and lone surrogates.
  if (!Number.isFinite(code) || code < 32 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return '';
  return String.fromCodePoint(code);
}

function stripTags(html) {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/** Element text with CDATA unwrapped, entities decoded and tags stripped.
 *  Decoding runs before stripping, because sources escape markup into the
 *  text ("&lt;b&gt;"); once more after stripping for double-escaped feeds. */
function textOf(raw) {
  if (raw == null) return '';
  let text = String(raw);
  const cdata = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  text = cdata ? cdata[1] : text.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = decodeEntities(text);
  text = stripTags(text);
  text = decodeEntities(text);
  return text.replace(/\s+/g, ' ').trim();
}

function value(block, tag) {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i'));
  return m ? m[1] : null;
}

function snippetOf(raw) {
  return textOf(raw).slice(0, 300);
}

function dateOf(raw) {
  if (!raw) return null;
  const t = Date.parse(textOf(raw));
  return Number.isFinite(t) ? new Date(t) : null;
}

function linkOf(raw, base) {
  const text = textOf(raw);
  if (!text) return null;
  try {
    const u = new URL(text, base || undefined);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}

/**
 * Parse an RSS 2.0 or Atom document with plain string parsing, resolving
 * relative item addresses against baseURL (the feed's own address). Returns
 * { title, items: [{ guid, title, link, date, snippet }] }, or null when the
 * document is neither. Items without an http(s) link, a title or a guid are
 * dropped. At most 50 items are kept.
 */
function parseFeed(xml, baseURL) {
  if (typeof xml !== 'string' || xml.length > 4 * MAX_BYTES) return null;
  const trimmed = xml.replace(/^﻿/, '').trim();
  const head = trimmed.slice(0, 2000);
  const isRss = /<rss[\s>]|<channel[\s>]/i.test(head) || /<rdf:rdf[\s>]/i.test(head);
  const isAtom = /<feed[\s>]/i.test(head);
  if (!isRss && !isAtom) return null;
  const base = baseURL || null;

  let title = '';
  let itemBlocks = [];
  if (isAtom) {
    const rootTitle = trimmed.match(/<feed[\s>][\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
    title = rootTitle ? textOf(rootTitle[1]) : '';
    itemBlocks = trimmed.match(/<entry[\s>][\s\S]*?<\/entry\s*>/gi) || [];
    return finish(title, itemBlocks, (block) => atomItem(block, base));
  }
  const channelTitle = trimmed.match(/<channel[\s>][\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
  title = channelTitle ? textOf(channelTitle[1]) : '';
  itemBlocks = trimmed.match(/<item[\s>][\s\S]*?<\/item\s*>/gi) || [];
  return finish(title, itemBlocks, (block) => rssItem(block, base));
}

function finish(title, blocks, read) {
  const items = [];
  for (const block of blocks.slice(0, 50)) {
    const item = read(block);
    if (!item) continue;
    items.push(item);
  }
  return { title: title || '', items };
}

function rssItem(block, base) {
  const title = textOf(value(block, 'title'));
  const link = linkOf(value(block, 'link'), base);
  const guid = textOf(value(block, 'guid')) || link;
  if (!title || !link || !guid) return null;
  return {
    guid,
    title,
    link,
    date: dateOf(value(block, 'pubDate') || value(block, 'dc:date')),
    snippet: snippetOf(value(block, 'description') || value(block, 'content:encoded')),
  };
}

function atomItem(block, base) {
  const title = textOf(value(block, 'title'));
  const guid = textOf(value(block, 'id'));
  let link = null;
  for (const tag of block.match(/<link\b[^>]*>/gi) || []) {
    const href = attr(tag, 'href');
    if (!href) continue;
    const rel = (attr(tag, 'rel') || 'alternate').toLowerCase();
    const resolved = linkOf(href, base);
    if (!resolved) continue;
    if (rel === 'alternate') { link = resolved; break; }
    if (!link) link = resolved;
  }
  if (!title || !link || !guid) return null;
  return {
    guid,
    title,
    link,
    date: dateOf(value(block, 'published') || value(block, 'updated')),
    snippet: snippetOf(value(block, 'summary') || value(block, 'content')),
  };
}

module.exports = { safeFetch, discover, parseFeed, isBlockedIp };
