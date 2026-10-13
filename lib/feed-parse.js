'use strict';
// Parsing feeds without dependencies: a small tag scanner, not a full XML
// parser. lib/feed-fetch.js calls parseFeed with the body safeFetch returned;
// findFeedLinks reads a site's advertised feed links. Every string that
// reaches the page goes through toText or is rendered as a text node, so feed
// HTML never becomes markup in the DOM.

class NotAFeed extends Error {}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const n = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body.toLowerCase()) ? NAMED[body.toLowerCase()] : m;
  });
}

// Feed HTML to plain text: script/style/iframe go whole, block ends become
// paragraph breaks, the other tags go, entities decode, spaces collapse,
// paragraphs stay as blank lines, capped at `cap` characters.
function toText(html, cap = 6000) {
  if (html == null) return '';
  const s = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|blockquote|pre|section|article)\s*>/gi, '\n\n')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s).replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, cap);
}

// An attribute of one tag string, decoded.
function attrOf(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : null;
}

// The feed links a site advertises: <link rel="alternate" type="…rss+xml|atom+xml">.
// JSON Feed is ignored in v1.
function findFeedLinks(html, baseUrl) {
  const out = [];
  for (const m of String(html || '').matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (attrOf(tag, 'rel') || '').toLowerCase();
    if (!/\balternate\b/.test(rel)) continue;
    const type = (attrOf(tag, 'type') || '').toLowerCase();
    if (!/(rss|atom)\+xml/.test(type)) continue;
    const href = attrOf(tag, 'href');
    if (!href) continue;
    try { out.push(new URL(href, baseUrl).href); } catch { /* a broken href is not a link */ }
  }
  return out;
}

function resolveUrl(raw, baseUrl) {
  if (!raw) return null;
  const v = decodeEntities(String(raw).trim());
  if (!v) return null;
  try {
    const u = new URL(v, baseUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null; // a javascript: link becomes null
  } catch { return null; }
}

// The first child with one of these names, as inner XML; for void/attribute
// forms (<link href="…"/>), the tag itself.
function firstChild(block, names) {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, 'i'));
    if (m) return m[1];
    const a = block.match(new RegExp(`<${name}\\s[^>]*>`, 'i'));
    if (a) return a[0];
  }
  return null;
}

function linkOf(block, baseUrl, atom) {
  if (atom) {
    let fallback = null;
    for (const m of block.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0];
      const rel = (attrOf(tag, 'rel') || 'alternate').toLowerCase();
      const href = attrOf(tag, 'href');
      if (!href) continue;
      const url = resolveUrl(href, baseUrl);
      if (!url) continue;
      if (rel === 'alternate') return url;
      if (!fallback && rel !== 'self' && rel !== 'enclosure' && rel !== 'hub') fallback = url;
    }
    return fallback;
  }
  const m = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link\s*>/i);
  if (m && m[1].trim()) return resolveUrl(m[1], baseUrl);
  const a = block.match(/<link\b[^>]*>/i);
  return a ? resolveUrl(attrOf(a[0], 'href'), baseUrl) : null;
}

function dateOf(block, fallback) {
  const raw = firstChild(block, ['pubDate', 'dc:date', 'published', 'updated']);
  if (!raw) return fallback;
  const t = new Date(toText(raw)).getTime();
  if (!Number.isFinite(t)) return fallback;
  if (t > fallback.getTime() + 60 * 60 * 1000) return fallback; // a date more than an hour ahead is wrong
  return new Date(t);
}

function authorOf(block, atom) {
  if (atom) {
    const a = block.match(/<author\b[^>]*>([\s\S]*?)<\/author\s*>/i);
    if (a) return toText(firstChild(a[1], ['name']) || '') || null;
    return null;
  }
  const dc = firstChild(block, ['dc:creator']);
  if (dc) return toText(dc) || null;
  const raw = firstChild(block, ['author']);
  if (!raw) return null;
  const text = toText(raw);
  const named = text.match(/\(([^)]+)\)/); // "list@example.com (Rowan Field)"
  return named ? named[1].trim() : text || null;
}

/**
 * parseFeed(xml, baseUrl, { now }) → { title, siteUrl, items }
 * items: [{ guid, title, link, author, summary, publishedAt }]. Throws
 * NotAFeed when the body is not RSS 2.0, RDF or Atom.
 */
function parseFeed(xml, baseUrl, { now = new Date() } = {}) {
  let s = String(xml || '');
  if (!/<(?:rss\b|rdf:rdf\b|feed[\s>])/i.test(s)) throw new NotAFeed('not a feed');
  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');

  const itemRe = /<(item|entry)[\s>][\s\S]*?<\/\1\s*>/gi;
  const first = itemRe.exec(s);
  itemRe.lastIndex = 0;
  const atom = !first || first[1].toLowerCase() === 'entry';
  const head = first ? s.slice(0, first.index) : s;

  const titleRaw = firstChild(head, ['title']);
  const feedTitle = toText(titleRaw || '').slice(0, 200);
  const siteUrl = linkOf(head, baseUrl, atom);

  const items = [];
  for (const m of s.matchAll(itemRe)) {
    const block = m[0];
    const title = toText((firstChild(block, ['title']) || '')).slice(0, 500);
    const link = linkOf(block, baseUrl, atom);
    const contentRaw = firstChild(block, atom ? ['content', 'summary'] : ['content:encoded', 'description']);
    const summary = toText(contentRaw, 6000);
    const publishedAt = dateOf(block, now);
    const guid = toText((firstChild(block, ['guid', 'id']) || '')) || link
      || require('crypto').createHash('sha1').update(`${title}|${publishedAt.toISOString()}`).digest('hex');
    const author = authorOf(block, atom);
    items.push({
      guid,
      title: title || (summary ? summary.replace(/\s+/g, ' ').slice(0, 80) : 'Untitled post'),
      link,
      author,
      summary,
      publishedAt,
    });
  }
  return { title: feedTitle, siteUrl, items };
}

module.exports = { parseFeed, findFeedLinks, toText, decodeEntities, NotAFeed };