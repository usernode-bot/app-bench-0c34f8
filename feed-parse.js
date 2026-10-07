'use strict';

// Feed fetching, RSS 2.0 and Atom parsing, and HTML sanitizing for the RSS
// Reader. Written for this app so no new npm dependencies are needed: fetch()
// is built into Node, and the two feed formats are parsed with a small set of
// regular expressions tuned to the shape real feeds use.
//
// Everything here treats feed content as untrusted: HTML is sanitized before
// it is ever stored, and sizes and time are capped.

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB cap on a feed's response body
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CONTENT_BYTES = 64 * 1024; // cap on one post's stored HTML

// A plain Error whose message is safe to show to the person adding a feed.
class FeedError extends Error {}

// ── Entities and escaping ────────────────────────────────────────────────

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '\u2019', lsquo: '\u2018',
  ldquo: '\u201c', rdquo: '\u201d', copy: '©', eacute: 'é',
};

function decodeEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; }
    })
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] || m);
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// The value of one attribute inside a raw attribute string, entity-decoded.
function attrValue(attrs, name) {
  const re = new RegExp(
    '(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = re.exec(attrs || '');
  if (!m) return null;
  const raw = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
  return decodeEntities(raw).trim();
}

// ── HTML sanitizing ──────────────────────────────────────────────────────

// Elements removed entirely, their content included. Anything not in the
// keep-list below also loses every attribute, which strips event handlers,
// style attributes and non-http(s) URLs everywhere else.
const DROP_ELEMENTS = 'script|style|iframe|object|embed|form|link|meta|base';

// Tags whose attributes survive sanitizing, and which of them do.
const KEPT_ATTRS = { a: ['href'], img: ['src', 'alt'] };

function sanitizeHtml(html) {
  if (!html) return '';
  let out = String(html);

  // Comments and declarations first, so nothing inside them is parsed later.
  out = out.replace(/<!--[\s\S]*?-->/g, '').replace(/<![\s\S]*?>/g, '');

  // Dangerous elements, content included; twice, for nested misuse.
  for (let pass = 0; pass < 2; pass++) {
    out = out.replace(
      new RegExp('<\\s*(?:' + DROP_ELEMENTS + ')\\b[^>]*>[\\s\\S]*?<\\s*/\\s*(?:' + DROP_ELEMENTS + ')\\s*>', 'gi'), '');
    out = out.replace(new RegExp('<\\s*/\\s*(?:' + DROP_ELEMENTS + ')\\s*>', 'gi'), '');
    out = out.replace(new RegExp('<\\s*(?:' + DROP_ELEMENTS + ')\\b[^>]*>', 'gi'), '');
  }

  // Walk every remaining tag and rebuild it from the attribute allowlist.
  // Only <a href> and <img src/alt> keep attributes, and only with an
  // http(s) target, so javascript: URLs and on* handlers cannot survive.
  out = out.replace(
    /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (_m, slash, rawName, attrs) => {
      const name = rawName.toLowerCase();
      if (slash) return '</' + name + '>';
      const kept = KEPT_ATTRS[name] || [];
      const keptAttrs = [];
      for (const attr of kept) {
        const value = attrValue(attrs, attr);
        if (value === null) continue;
        if ((attr === 'href' || attr === 'src') && !/^https?:\/\//i.test(value)) continue;
        keptAttrs.push(' ' + attr + '="' + escapeAttr(value) + '"');
      }
      // An img whose src was dropped would render as a broken-image box;
      // leave it out entirely.
      if (name === 'img' && !keptAttrs.some((a) => a.startsWith(' src='))) return '';
      return '<' + name + keptAttrs.join('') + '>';
    });

  return out.slice(0, MAX_CONTENT_BYTES);
}

// ── Small XML helpers ────────────────────────────────────────────────────

// Inner text of every <tag ...>...</tag> block in `xml`. Self-closing tags
// (Atom's <link href=… />) never match, which is what the callers want.
function extractBlocks(xml, tag) {
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<' + esc + '(\\s[^>]*)?>([\\s\\S]*?)<\\/\\s*' + esc + '\\s*>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[2]);
  return out;
}

function firstBlock(xml, tag) {
  const all = extractBlocks(xml, tag);
  return all.length ? all[0] : null;
}

// Remove every <tag> block, e.g. the items out of a channel to read its own
// title safely.
function stripBlocks(xml, tag) {
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return xml.replace(new RegExp('<' + esc + '\\b[^>]*>[\\s\\S]*?<\\/\\s*' + esc + '\\s*>', 'gi'), '');
}

// CDATA stays literal; otherwise one round of entity decoding turns an
// entity-encoded RSS description back into HTML.
function contentOf(raw) {
  if (raw === null || raw === undefined) return '';
  if (String(raw).includes('<![CDATA[')) {
    const parts = [];
    String(raw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner) => { parts.push(inner); return ''; });
    return parts.join('');
  }
  return decodeEntities(raw);
}

function textOf(raw) {
  return contentOf(raw).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDate(raw) {
  const text = textOf(raw);
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : new Date(time);
}

// Deterministic stand-in guid for items with neither guid nor link.
function hashKey(text) {
  let hash = 5381;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  return 'hash-' + hash.toString(16);
}

// ── RSS 2.0 and Atom ─────────────────────────────────────────────────────

function parseRssItem(block) {
  const title = textOf(firstBlock(block, 'title'));
  const rawGuid = textOf(firstBlock(block, 'guid'));
  let url = textOf(firstBlock(block, 'link'));
  if (!url && /^https?:\/\//i.test(rawGuid)) url = rawGuid;
  const contentHtml = sanitizeHtml(
    contentOf(firstBlock(block, 'content:encoded')) || contentOf(firstBlock(block, 'description')));
  return {
    guid: rawGuid || url || hashKey(title),
    title: title || 'Untitled post',
    url: url || null,
    contentHtml,
    publishedAt: parseDate(firstBlock(block, 'pubDate')) || parseDate(firstBlock(block, 'dc:date')),
  };
}

function parseRss(xml) {
  const channelMatch = /<channel\b[^>]*>([\s\S]*?)<\/channel>/i.exec(xml);
  if (!channelMatch) return null;
  const head = stripBlocks(channelMatch[1], 'item');
  const title = textOf(firstBlock(head, 'title'));
  const siteUrl = textOf(firstBlock(head, 'link'));
  const items = extractBlocks(channelMatch[1], 'item').map(parseRssItem);
  return { title, siteUrl, items };
}

// Atom's <link> can be self-closing; prefer rel="alternate" or no rel.
function atomLink(block) {
  const re = /<link\b([^>]*?)(?:\/>|>([\s\S]*?)<\/link\s*>)/gi;
  let m;
  let fallback = null;
  while ((m = re.exec(block))) {
    const href = attrValue(m[1] || '', 'href');
    if (!href) continue;
    const rel = (attrValue(m[1] || '', 'rel') || '').toLowerCase();
    if (!rel || rel === 'alternate') return href;
    if (fallback === null) fallback = href;
  }
  return fallback;
}

function parseAtomItem(block) {
  const title = textOf(firstBlock(block, 'title'));
  const url = atomLink(block);
  const rawId = textOf(firstBlock(block, 'id'));
  const contentHtml = sanitizeHtml(
    contentOf(firstBlock(block, 'content')) || contentOf(firstBlock(block, 'summary')));
  return {
    guid: rawId || url || hashKey(title),
    title: title || 'Untitled post',
    url: url || null,
    contentHtml,
    publishedAt: parseDate(firstBlock(block, 'published')) || parseDate(firstBlock(block, 'updated')),
  };
}

function parseAtom(xml) {
  const feedMatch = /<feed\b[^>]*>([\s\S]*?)<\/feed>/i.exec(xml);
  if (!feedMatch) return null;
  const head = stripBlocks(feedMatch[1], 'entry');
  const title = textOf(firstBlock(head, 'title'));
  const siteUrl = atomLink(head);
  const items = extractBlocks(feedMatch[1], 'entry').map(parseAtomItem);
  return { title, siteUrl, items };
}

function parseFeed(xml) {
  const cleaned = String(xml || '').replace(/^\uFEFF/, '').trim();
  const rss = parseRss(cleaned);
  const atom = parseAtom(cleaned);
  const best = (rss && rss.items.length && rss) ||
    (atom && atom.items.length && atom) ||
    rss || atom;
  if (!best || !best.items.length) return null;
  return {
    title: best.title || 'Untitled feed',
    siteUrl: best.siteUrl || null,
    items: best.items,
  };
}

// ── Fetching ─────────────────────────────────────────────────────────────

function assertHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl).trim());
  } catch {
    throw new FeedError('Enter a full address, starting with http:// or https://.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FeedError('Only http:// and https:// addresses can be followed.');
  }
  return parsed.toString();
}

// One hop: 10-second timeout, then a size-capped read of the body.
async function fetchOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'user-agent': 'Homeroom RSS Reader (+https://onhomeroom.com)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BODY_BYTES) {
          controller.abort();
          throw new FeedError('That feed is too large to read (over 2 MB).');
        }
        chunks.push(Buffer.from(value));
      }
      return { ok: res.ok, status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') };
    }
    return { ok: res.ok, status: res.status, headers: res.headers, body: await res.text() };
  } catch (err) {
    if (err instanceof FeedError) throw err;
    if (err && err.name === 'AbortError') throw new FeedError('That address took too long to answer.');
    throw new FeedError("Couldn't reach that address.");
  } finally {
    clearTimeout(timer);
  }
}

// Fetch with at most MAX_REDIRECTS hops followed by hand.
async function fetchFollowing(rawUrl) {
  let url = rawUrl;
  for (let hop = 0; ; hop++) {
    const res = await fetchOnce(url);
    if (![301, 302, 303, 307, 308].includes(res.status) || hop >= MAX_REDIRECTS) {
      if (hop > MAX_REDIRECTS) throw new FeedError('That address redirects too many times.');
      return res;
    }
    const location = res.headers.get('location');
    if (!location) return res;
    url = new URL(location, url).toString();
    if (!/^https?:\/\//i.test(url)) throw new FeedError('That address redirects somewhere unexpected.');
  }
}

// Fetch a feed URL and parse it. Throws FeedError with a person-readable
// message for every failure a person can cause; returns
// { title, siteUrl, items: [{ guid, title, url, contentHtml, publishedAt }] }.
async function fetchFeed(rawUrl) {
  const url = assertHttpUrl(rawUrl);
  const res = await fetchFollowing(url);
  if (!res.ok) {
    throw new FeedError("Couldn't reach that address (HTTP " + res.status + ').');
  }
  const parsed = parseFeed(res.body);
  if (!parsed) {
    throw new FeedError("That address doesn't look like a feed.");
  }
  return parsed;
}

module.exports = { fetchFeed, parseFeed, sanitizeHtml, FeedError };