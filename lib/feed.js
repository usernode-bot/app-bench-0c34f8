'use strict';

// Fetching and parsing of RSS and Atom feeds, built in so the app needs no
// new dependencies. safeFetch refuses addresses that resolve to private
// network space, so a pasted feed URL cannot be used to reach the platform's
// own services or the container's neighbours.

const dns = require('dns').promises;
const net = require('net');

const TIMEOUT_MS = 8000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** An Error with an HTTP-ish status, so routes can answer with it. */
function httpError(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

// ── Private-address guard ────────────────────────────────────────────────────

function v4IsPrivate(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // unspecified, private, loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast (224/4) and reserved (240/4)
  return false;
}

function v6IsPrivate(addr) {
  const ip = String(addr).toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4IsPrivate(mapped[1]); // IPv4-mapped form judges the IPv4
  if (!net.isIPv6(ip)) return true; // not parseable: refuse
  if (ip === '::' || ip === '::1') return true; // unspecified, loopback
  const hex = parseInt(ip.split(':')[0], 16);
  if (Number.isNaN(hex)) return true;
  if ((hex & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((hex & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((hex & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/** True when the address must not be fetched (private, loopback, …). */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return v4IsPrivate(ip);
  if (net.isIPv6(ip)) return v6IsPrivate(ip);
  return true;
}

// ── Safe fetch ───────────────────────────────────────────────────────────────

/** The host of a URL object, without IPv6 brackets. */
function hostOf(url) {
  return url.hostname.replace(/^\[|\]$/g, '');
}

async function assertPublicHost(url) {
  const host = hostOf(url);
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await dns.lookup(host, { all: true });
    } catch {
      throw httpError(502, 'That address did not answer');
    }
    if (!addresses.length) throw httpError(502, 'That address did not answer');
  }
  for (const entry of addresses) {
    const ip = typeof entry === 'string' ? entry : entry.address;
    if (isPrivateAddress(ip)) throw httpError(403, 'That address cannot be reached');
  }
}

/**
 * Fetch a public web address safely: http/https only, every hop (redirects
 * included) resolved and refused if it points at private space, 8 s timeout,
 * the body read up to 2 MB. Throws Errors with plain-words messages.
 */
async function safeFetch(rawUrl, hops = 0) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError(400, 'That address does not look like a web address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError(400, 'Only http and https addresses can be fetched');
  }
  await assertPublicHost(url);

  let res;
  try {
    res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': 'RSSReader (Homeroom)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
    });
  } catch {
    throw httpError(502, 'That address did not answer');
  }

  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.get('location');
    try { await res.arrayBuffer(); } catch { /* already gone */ }
    if (!location) throw httpError(502, 'That address did not answer');
    if (hops >= MAX_REDIRECTS) throw httpError(502, 'That address redirected too many times');
    return safeFetch(new URL(location, url).toString(), hops + 1);
  }
  return res;
}

/** The body of a safeFetch response, read up to maxBytes and cut there. */
async function readBodyCapped(res, maxBytes = MAX_BYTES) {
  if (!res.body) return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= maxBytes) {
      try { await reader.cancel(); } catch { /* already closed */ }
      break;
    }
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

// ── Text helpers ─────────────────────────────────────────────────────────────

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', copy: '©', reg: '®', shy: '',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', times: '×', deg: '°', plusmn: '±',
  agrave: 'à', eacute: 'é', egrave: 'è', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä',
};

/** Decode named (a small common set) and numeric entities. */
function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      return match;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named != null ? named : match;
  });
}

/** Unwrap one CDATA section, if the text is one. */
function unwrapCdata(text) {
  const m = String(text).match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/);
  return m ? m[1] : text;
}

/** The raw text of the first <name> element in scope, CDATA unwrapped.
 *  Entities stay encoded here: toText and the link resolvers decode them
 *  once, after any tags in the value are gone — decoding first would turn
 *  "&lt;b&gt;" in a title into a tag that the tag-stripper then eats. */
function tagText(scope, name) {
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '\\s*>', 'i');
  const m = scope.match(re);
  if (!m) return null;
  return unwrapCdata(m[1]).trim();
}

/** An attribute value out of a tag's attribute text. */
function attr(attrs, name) {
  const m = attrs.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  if (!m) return null;
  return decodeEntities(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
}

/** HTML to plain text, entities decoded, whitespace collapsed, cut at a word. */
function toText(html, max = 600) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<\/(p|div|li|ul|ol|tr|blockquote|section|article|h[1-6])\s*>/gi, ' ');
  s = s.replace(/<(br|hr)\b[^>]*>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[\s\u00a0]+/g, ' ').trim();
  if (max && s.length > max) {
    let cut = s.slice(0, max);
    const space = cut.lastIndexOf(' ');
    if (space > max * 0.5) cut = cut.slice(0, space);
    s = cut.replace(/[\s,.;:!?]+$/, '') + '…';
  }
  return s;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Keep a link only when it resolves to an http(s) address. */
function resolveLink(href, baseUrl) {
  if (!href) return null;
  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** An Atom <link>: rel="alternate" or no rel, else the first with an href. */
function atomLink(scope) {
  const re = /<link\b([^>]*?)\/?>(?:\s*<\/link\s*>)?/gi;
  let fallback = null;
  let m;
  while ((m = re.exec(scope))) {
    const href = attr(m[1], 'href');
    if (!href) continue;
    const rel = (attr(m[1], 'rel') || '').toLowerCase();
    if (!rel || rel === 'alternate') return href;
    if (fallback == null) fallback = href;
  }
  return fallback;
}

function parseItem(item, baseUrl, fetchedAt) {
  // Link: an RSS <link> text first (its &amp; decoded), else an Atom <link href>.
  const rawLink = tagText(item, 'link');
  let link = resolveLink(rawLink != null ? decodeEntities(rawLink) : atomLink(item), baseUrl);

  let guid = tagText(item, 'guid') || tagText(item, 'id') || link;
  const title = toText(tagText(item, 'title'), 500) || '(untitled)';
  if (!guid) guid = title;

  const rawDate = tagText(item, 'pubDate') || tagText(item, 'published')
    || tagText(item, 'updated') || tagText(item, 'dc:date');
  let publishedAt = rawDate ? new Date(rawDate) : null;
  if (!publishedAt || Number.isNaN(publishedAt.getTime())) publishedAt = new Date(fetchedAt);
  if (publishedAt.getTime() > fetchedAt.getTime()) publishedAt = new Date(fetchedAt);

  // Body: the first of these that has any text.
  let excerpt = '';
  for (const name of ['content:encoded', 'description', 'summary', 'content']) {
    const raw = tagText(item, name);
    if (raw != null) {
      excerpt = toText(raw, 600);
      if (excerpt) break;
    }
  }

  return { guid: String(guid), title, link, excerpt, publishedAt };
}

/**
 * Parse an RSS 2.0, RSS 1.0 (RDF) or Atom document into
 * { title, link, posts: [{ guid, title, link, excerpt, publishedAt }] }.
 * Throws (code 'parse') when the text is not a feed.
 */
function parseFeed(xml, baseUrl, fetchedAt = new Date()) {
  const doc = String(xml).replace(/<!--[\s\S]*?-->/g, '');
  if (!/<rss\b|<rdf:RDF\b|<feed\b/i.test(doc)) {
    throw httpError(400, 'That page is not an RSS or Atom feed', 'parse');
  }
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  const posts = [];
  let m;
  while ((m = itemRe.exec(doc)) && posts.length < 500) {
    posts.push(parseItem(m[2], baseUrl, fetchedAt));
  }

  // Feed title and site link live outside the items.
  const rest = doc.replace(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const feedTitle = toText(tagText(rest, 'title'), 200);
  const rawFeedLink = tagText(rest, 'link');
  const feedLink = resolveLink(rawFeedLink != null ? decodeEntities(rawFeedLink) : atomLink(rest), baseUrl);

  return { title: feedTitle, link: feedLink, posts };
}

/** The first <link rel="alternate" type="application/rss+xml|atom+xml">, resolved. */
function discoverFeedUrl(html, baseUrl) {
  const re = /<link\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const rel = (attr(m[1], 'rel') || '').toLowerCase();
    const type = (attr(m[1], 'type') || '').toLowerCase();
    const href = attr(m[1], 'href');
    if (!href || !rel.includes('alternate')) continue;
    if (!/application\/(rss|atom)\+xml/.test(type)) continue;
    return resolveLink(href, baseUrl);
  }
  return null;
}

module.exports = { safeFetch, readBodyCapped, parseFeed, discoverFeedUrl, toText, isPrivateAddress };