'use strict';

/* A small, string-based reader for RSS 2.0 and Atom feeds.
 *
 * Deliberately no XML library and no npm packages: this app's spec asks for
 * a built-in reader that finds <item> blocks in RSS 2.0 (title, link,
 * description, pubDate, guid) and <entry> blocks in Atom (title, link href,
 * summary or content, published or updated), unescapes entities and returns
 * plain values. It never evaluates anything it reads — every value comes
 * back as text, and the caller decides what to store.
 */

// Collapse whitespace runs and trim, so excerpts and titles render cleanly.
function collapse(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// Remove markup, dropping script/style blocks entirely.
function stripTags(html) {
  return String(html)
    .replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
}

// Decode the XML entities and numeric character references a feed may use.
// &amp; is handled last so a doubly-escaped "&amp;lt;" comes back as "&lt;".
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n) {
  try {
    return Number.isFinite(n) && n >= 0 ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}

// Inner text of an element: CDATA is taken literally (tags stripped, but
// entities inside CDATA are data, not markup, and are left alone); plain
// markup is stripped and then entity-decoded.
function textOf(raw) {
  if (!raw) return '';
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>/.exec(raw);
  if (cdata) return collapse(stripTags(cdata[1]));
  return collapse(decodeEntities(stripTags(raw)));
}

// The first <tag>…</tag> inside a block of XML.
function innerOf(block, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</\\s*' + tag + '\\s*>', 'i');
  const m = re.exec(block);
  return m ? m[1] : '';
}

function collectBlocks(xml, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</\\s*' + tag + '\\s*>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

function attrOf(tag, name) {
  const m = new RegExp('\\b' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
  return m ? (m[2] !== undefined ? m[2] : m[3]) : '';
}

// The post's address: Atom carries it in <link href="…"> (prefer
// rel="alternate", the plain link), RSS in <link>text</link>. Only http(s)
// URLs are kept — anything else (javascript:, data:, garbage) is dropped.
function linkOf(block) {
  const tags = block.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = attrOf(tag, 'rel').toLowerCase();
    if (rel === '' || rel === 'alternate') {
      const href = attrOf(tag, 'href');
      if (href) return cleanUrl(href);
    }
  }
  const rss = /<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i.exec(block);
  if (rss) return cleanUrl(decodeEntities(stripTags(rss[1])));
  return '';
}

function cleanUrl(u) {
  const t = decodeEntities(String(u || '')).trim();
  return /^https?:\/\//i.test(t) ? t : '';
}

// The excerpt: the description or summary with tags stripped, truncated to
// about 280 characters.
function excerptOf(raw) {
  const t = textOf(raw);
  if (!t) return '';
  return t.length > 280 ? t.slice(0, 279).trimEnd() + '…' : t;
}

function dateOf(raw) {
  const t = Date.parse(textOf(raw));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Parse a feed document. Returns { title, posts: [{guid, title, link,
// excerpt, publishedAt}] } or null when the document is not recognisably a
// feed. RSS 2.0 items and Atom entries are handled the same way; guid falls
// back to the link and then the title so refreshes can match posts up.
function parseFeed(xml) {
  if (typeof xml !== 'string' || !xml) return null;
  if (!/<(feed|rss|rdf|rdf:rdf|channel)[\s>]/i.test(xml)) return null;
  const blocks = collectBlocks(xml, 'item').concat(collectBlocks(xml, 'entry'));
  if (!blocks.length && !/<(channel|feed)[\s>]/i.test(xml)) return null;

  // The feed's own title: in both formats it is the first <title> in the
  // document, before any post's.
  const title = textOf(innerOf(xml, 'title'));

  const posts = [];
  for (const block of blocks) {
    const postTitle = textOf(innerOf(block, 'title'));
    const link = linkOf(block);
    const excerpt =
      excerptOf(innerOf(block, 'description')) ||
      excerptOf(innerOf(block, 'summary')) ||
      excerptOf(innerOf(block, 'content')) ||
      excerptOf(innerOf(block, 'content:encoded'));
    const publishedAt =
      dateOf(innerOf(block, 'pubDate')) ||
      dateOf(innerOf(block, 'published')) ||
      dateOf(innerOf(block, 'updated')) ||
      dateOf(innerOf(block, 'dc:date'));
    const guid =
      textOf(innerOf(block, 'guid')) || textOf(innerOf(block, 'id')) || link || postTitle;
    if (!guid) continue;
    posts.push({
      guid,
      title: postTitle,
      link,
      excerpt,
      publishedAt,
    });
  }
  return { title, posts };
}

module.exports = { parseFeed };