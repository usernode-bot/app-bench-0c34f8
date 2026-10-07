'use strict';

/* A small hand-rolled RSS/Atom item extractor — no new npm dependency.
 *
 * parseFeed(xml, { url, fallbackDate }) returns
 *   { title, siteUrl, items: [{ guid, title, link, summary, publishedAt }] }
 * or throws an object with a `code`, so routes can answer with the API's
 * error names ('not_a_feed').
 *
 * It extracts, it does not fully parse: feeds in the wild are HTML-ish
 * XML, so every text field goes through the same forgiving text pipeline
 * (CDATA unwrap, entity decode, block tags to paragraph breaks, tag
 * strip, whitespace collapse) and comes out as plain text. Summaries are
 * stored as plain text and rendered with textContent, never innerHTML —
 * see the edge cases in the spec.
 */

const MAX_SUMMARY_CHARS = 20_000;
const MAX_TITLE_CHARS = 500;

function fail(code) {
  const err = new Error(code);
  err.code = code;
  throw err;
}

/* ── Text pipeline ─────────────────────────────────────────────────────── */

function unwrapCdata(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', eacute: 'é',uuml: 'ü',
};

function decodeEntities(text) {
  let out = text.replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
    safeCodePoint(parseInt(hex, 16)));
  out = out.replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)));
  // Named entities except amp, so "&amp;lt;" (a literal "&lt;" in the
  // source text) stays readable instead of turning into a stray tag.
  out = out.replace(/&([a-z]+);/gi, (whole, name) => {
    const lower = name.toLowerCase();
    if (lower === 'amp') return whole;
    return NAMED_ENTITIES[lower] !== undefined ? NAMED_ENTITIES[lower] : whole;
  });
  out = out.replace(/&amp;/g, '&');
  return out;
}

function safeCodePoint(n) {
  // Keep to valid scalar values; leave anything odd as written.
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  if (n >= 0xd800 && n <= 0xdfff) return '';
  return String.fromCodePoint(n);
}

// Block-level tags the summary keeps as paragraph breaks; everything else
// is stripped. script/style content is dropped whole.
function htmlToParagraphs(html) {
  let text = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  text = text
    .replace(/<br\s*\/?>/gi, '\n\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)\s*>/gi, '\n\n')
    .replace(/<(p|div|li|h[1-6]|blockquote|tr)\b[^>]*>/gi, '\n\n');
  text = text.replace(/<[^>]+>/g, '');
  return text;
}

function collapseWhitespace(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\r\n\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Feed text to plain paragraphs, '\n\n' between them.
function toPlainText(raw) {
  const text = collapseWhitespace(
    decodeEntities(htmlToParagraphs(unwrapCdata(String(raw ?? '')))));
  return text.length > MAX_SUMMARY_CHARS
    ? text.slice(0, MAX_SUMMARY_CHARS) : text;
}

// Titles lose their tags but never gain paragraph breaks.
function toPlainTitle(raw) {
  const text = collapseWhitespace(
    decodeEntities(htmlToParagraphs(unwrapCdata(String(raw ?? ''))))
      .replace(/\n+/g, ' '));
  return text.length > MAX_TITLE_CHARS ? text.slice(0, MAX_TITLE_CHARS) : text;
}

/* ── Small XML helpers ─────────────────────────────────────────────────── */

// Content of the first <tag>…</tag> (any namespace prefix), or null.
function tagContent(xml, localName) {
  const re = new RegExp(
    '<(?:[A-Za-z][\\w.-]*:)?' + localName + '(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z][\\w.-]*:)?' + localName + '\\s*>',
    'i');
  const m = xml.match(re);
  return m ? m[1] : null;
}

// Every <link …> tag in a block, with its attributes.
function linkTags(xml) {
  const tags = [];
  const re = /<(?:[A-Za-z][\w.-]*:)?link\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = {};
    const attrRe = /([A-Za-z][\w.-]*)\s*=\s*"([^"]*)"|([A-Za-z][\w.-]*)\s*=\s*'([^']*)'/g;
    let a;
    while ((a = attrRe.exec(m[1]))) {
      attrs[(a[1] || a[3]).toLowerCase()] = a[2] !== undefined ? a[2] : a[4];
    }
    tags.push({ attrs, selfClosing: /\/\s*$/.test(m[1]) });
  }
  return tags;
}

// Atom carries the address in href; prefer rel="alternate", then no rel.
function atomLink(xml) {
  const candidates = linkTags(xml);
  const withHref = candidates.filter((t) => t.attrs.href);
  const pick =
    withHref.find((t) => (t.attrs.rel || 'alternate') === 'alternate') ||
    withHref[0];
  return pick ? pick.attrs.href : null;
}

function looksLikeHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/* ── Dates ─────────────────────────────────────────────────────────────── */

function parseDate(raw, fallback) {
  const text = unwrapCdata(String(raw ?? '')).trim();
  if (!text) return fallback;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return fallback;
  if (date.getTime() > fallback.getTime() + 60_000) return fallback; // clamp future
  return date;
}

/* ── Feed-level fields ─────────────────────────────────────────────────── */

function feedTitleOf(doc) {
  const beforeItems = doc.split(/<(?:[A-Za-z][\w.-]*:)?(?:item|entry)\b/i)[0];
  const raw = tagContent(beforeItems, 'title');
  return raw !== null ? toPlainTitle(raw) : '';
}

function siteUrlOf(doc) {
  const beforeItems = doc.split(/<(?:[A-Za-z][\w.-]*:)?(?:item|entry)\b/i)[0];
  const atom = atomLink(beforeItems);
  if (looksLikeHttpUrl(atom)) return atom.trim();
  const raw = tagContent(beforeItems, 'link');
  if (raw && looksLikeHttpUrl(unwrapCdata(raw).trim())) {
    return unwrapCdata(raw).trim();
  }
  return null;
}

/* ── Items ─────────────────────────────────────────────────────────────── */

function itemBlocks(doc) {
  const blocks = [];
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  while ((m = re.exec(doc))) blocks.push({ kind: m[1].toLowerCase(), xml: m[2] });
  return blocks;
}

function readItem(block, fallbackDate) {
  const { kind, xml } = block;

  const title = toPlainTitle(tagContent(xml, 'title') ?? '');

  let link = null;
  if (kind === 'entry') {
    link = atomLink(xml);
  } else {
    // RSS: <link> holds the address as text. An <atom:link> extension with
    // an href and no text must not yield an empty address.
    const raw = tagContent(xml, 'link');
    const text = raw !== null ? unwrapCdata(raw).trim() : '';
    if (looksLikeHttpUrl(text)) link = text;
    else link = atomLink(xml);
    if (!link) {
      // guid is often the permalink (isPermaLink defaults to true).
      const guidRaw = tagContent(xml, 'guid');
      const guidText = guidRaw !== null ? unwrapCdata(guidRaw).trim() : '';
      if (looksLikeHttpUrl(guidText)) link = guidText;
    }
  }

  const guidRaw = tagContent(xml, kind === 'entry' ? 'id' : 'guid');
  const guidText = guidRaw !== null ? unwrapCdata(guidRaw).trim() : '';
  const dateRaw =
    tagContent(xml, 'pubDate') ??
    tagContent(xml, 'published') ??
    tagContent(xml, 'updated') ??
    tagContent(xml, 'date');
  const publishedAt = parseDate(dateRaw, fallbackDate);

  let guid = guidText || link ||
    (title ? title + ' ' + publishedAt.toISOString() : '');
  if (!guid) return null;

  const bodyRaw =
    tagContent(xml, 'encoded') ?? // <content:encoded>
    tagContent(xml, 'content') ?? // Atom <content>
    tagContent(xml, 'description') ??
    tagContent(xml, 'summary') ??
    '';
  const summary = toPlainText(bodyRaw);

  return {
    guid,
    title: title || '(untitled post)',
    link: looksLikeHttpUrl(link) ? link.trim() : null,
    summary,
    publishedAt,
  };
}

/* ── Entry point ───────────────────────────────────────────────────────── */

function parseFeed(xml, opts) {
  const options = opts || {};
  const fallbackDate = options.fallbackDate instanceof Date
    ? options.fallbackDate : new Date();

  if (typeof xml !== 'string' || !xml.trim()) fail('not_a_feed');

  // A feed is one of these roots; an HTML page (or anything else) is not.
  const doc = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (!/<rss\b/i.test(doc) && !/<feed\b/i.test(doc) && !/<rdf:rdf\b/i.test(doc)) {
    fail('not_a_feed');
  }

  const blocks = itemBlocks(doc);
  const items = [];
  for (const block of blocks) {
    const item = readItem(block, fallbackDate);
    if (item) items.push(item);
  }
  // Newest first; the route caps how many it keeps.
  items.sort((a, b) => b.publishedAt - a.publishedAt);

  let title = feedTitleOf(doc);
  if (!title && options.url) {
    try { title = new URL(options.url).hostname; } catch { title = ''; }
  }

  return {
    title,
    siteUrl: siteUrlOf(doc),
    items,
  };
}

module.exports = { parseFeed, toPlainText, toPlainTitle };