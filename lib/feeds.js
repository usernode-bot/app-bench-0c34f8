// Fetching and parsing feeds, with no dependencies beyond Node's own modules.
//
// safeFetch(url) does the network half with a strict URL guard (https only,
// no private addresses, redirects followed by hand and re-checked each hop).
// parseFeed(xml, baseUrl) is a small tolerant scanner for RSS 2.0, RSS 1.0
// and Atom, not a full XML parser. toText(html) turns whatever a feed's
// summary holds into plain text: this app never puts feed HTML on the page.

const net = require('net');
const dns = require('dns').promises;
const crypto = require('crypto');

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const UA = 'RSS Reader (Homeroom)';
const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5';

/** A short reason for a failure, safe to show and to store in feeds.last_error. */
class FeedError extends Error {}

// ── The URL guard ─────────────────────────────────────────────────────────

/** Normalise a feed URL: lower-case host, no fragment, no hash of tracking. Returns null when it is not a usable https address. */
function normaliseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== '443') return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  return url;
}

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split('.').map(Number);
    if (a === 10 || a === 127) return true;                       // private, loopback
    if (a === 172 && b >= 16 && b <= 31) return true;             // private
    if (a === 192 && b === 168) return true;                      // private
    if (a === 169 && b === 254) return true;                      // link-local
    if (a === 100 && b >= 64 && b <= 127) return true;            // CGNAT
    if (a === 0) return true;                                     // unspecified
    if (a >= 224) return true;                                    // multicast + reserved
    return false;
  }
  const low = address.toLowerCase();
  if (low === '::' || low === '::1') return true;                 // unspecified, loopback
  const head = low.split(':')[0];
  if (head.startsWith('fe8') || head.startsWith('fe9') || head.startsWith('fea') || head.startsWith('feb')) return true; // link-local
  if (/^f[cd]/.test(head)) return true;                           // unique-local
  if (head.startsWith('ff')) return true;                         // multicast
  if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7)); // IPv4-mapped
  return false;
}

/** The host must resolve, and every address it resolves to must be public. */
async function guardHost(url) {
  let records;
  try {
    records = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new FeedError('That address can\'t be reached from here');
  }
  if (!records.length) throw new FeedError('That address can\'t be reached from here');
  for (const { address } of records) {
    if (isPrivateIp(address)) throw new FeedError('That address can\'t be reached from here');
  }
}

/**
 * Fetch a feed over https, following at most 3 redirects (each hop guarded
 * again). Resolves { url, body } — url is the final address after redirects.
 * Throws a FeedError with a short reason.
 */
async function safeFetch(rawUrl) {
  let url = normaliseUrl(rawUrl);
  if (!url) throw new FeedError('Use the https address of the feed');
  for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
    await guardHost(url);
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'User-Agent': UA, Accept: ACCEPT },
      });
    } catch (err) {
      throw new FeedError(err && err.name === 'TimeoutError'
        ? 'That site didn\'t answer. Check the address and try again.'
        : 'That address can\'t be reached from here');
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new FeedError('That address can\'t be reached from here');
      if (hops === MAX_REDIRECTS) throw new FeedError('That address can\'t be reached from here');
      const next = normaliseUrl(new URL(loc, url).href);
      if (!next) throw new FeedError('Use the https address of the feed');
      url = next;
      continue;
    }
    if (!res.ok) throw new FeedError(`The site answered with an error (HTTP ${res.status})`);
    const type = res.headers.get('content-type') || '';
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new FeedError('That feed is too large to read');
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    return { url: url.href, body, type };
  }
  throw new FeedError('That address can\'t be reached from here');
}

// ── Parsing ───────────────────────────────────────────────────────────────

function stripComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

function unwrapCdata(text) {
  if (text == null) return '';
  return String(text).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner);
}

/** The local name of a tag: "content:encoded" -> "encoded", "dc:date" -> "date". */
function localName(tag) {
  return tag.replace(/^.*:/, '').toLowerCase();
}

/** Read the first child element with one of these local names, CDATA-unwrapped. */
function childText(item, names) {
  for (const name of names) {
    const re = new RegExp(`<([A-Za-z0-9_:-]*?)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</\\1?${name}\\2?>`, 'i');
    const m = item.match(re);
    if (m && m[2] != null) {
      const text = unwrapCdata(m[2]).trim();
      if (text) return text;
    }
  }
  return '';
}

/** The href of an Atom <link> (rel=alternate or no rel) inside a chunk. */
function atomLink(chunk) {
  const links = chunk.match(/<link\b[^>]*>/g) || [];
  let bare = '';
  for (const tag of links) {
    const href = (tag.match(/href\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (!href) continue;
    const rel = (tag.match(/rel\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (!rel || rel.toLowerCase() === 'alternate') return unwrapCdata(href).trim();
    if (!rel) bare = unwrapCdata(href).trim();
  }
  return bare;
}

/** Decode the entities a feed may use, named, decimal and hex. */
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—',
  ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  copy: '©', reg: '®', trade: '™', eacute: 'é',egrave: 'è',agrave: 'à',uuml: 'ü',ouml: 'ö',auml: 'ä',szlig: 'ß',ccedil: 'ç',
};
function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCode(Number(d)))
    .replace(/&([a-z]+);/gi, (_, name) => (NAMED[name.toLowerCase()] !== undefined ? NAMED[name.toLowerCase()] : `&${name};`));
}
function safeCode(code) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/**
 * Feed HTML (or text with stray tags) to plain text: paragraphs from <p> and
 * <br>, script and style dropped whole, every other tag dropped, whitespace
 * collapsed, capped at `cap` characters at a word boundary with an ellipsis.
 */
function toText(html, cap = 1500) {
  let text = String(html || '');
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeEntities(text);
  text = text.replace(/[ \t\r\f]+/g, ' ').replace(/ *\n+ */g, '\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (cap && text.length > cap) {
    const cut = text.slice(0, cap);
    const at = cut.lastIndexOf(' ');
    text = (at > cap * 0.6 ? cut.slice(0, at) : cut).trimEnd() + '…';
  }
  return text;
}

/** A Date from the date formats feeds use; null when it cannot be read. */
function parseDate(value) {
  if (!value) return null;
  const t = Date.parse(unwrapCdata(value).trim());
  return Number.isFinite(t) ? new Date(t) : null;
}

function guidFor(item, link, title, date) {
  const guid = childText(item, ['guid', 'id']);
  if (guid) return guid.slice(0, 500);
  if (link) return link.slice(0, 500);
  return 'hash:' + crypto.createHash('sha1').update(`${title}\u0000${date ? date.toISOString() : ''}`).digest('hex');
}

/** Keep a link only when it is a real http(s) address. */
function safeLink(raw, baseUrl) {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim(), baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * parseFeed(xml, baseUrl): a tolerant scanner for RSS 2.0, RSS 1.0 and Atom.
 * Resolves { title, siteUrl, items: [{ guid, title, link, summary, author, publishedAt }] }
 * or throws a FeedError("No feed was found at that address").
 */
function parseFeed(xml, baseUrl, fetchedAt = new Date()) {
  const source = stripComments(String(xml || ''));
  const isAtom = /<feed[\s>]/i.test(source) && !/<rss[\s>]/i.test(source);
  const rootMatch = source.match(/<(rss|feed|rdf:rdf)[\s>][\s\S]*?>([\s\S]*)(?:<\/\1>)?\s*$/i);
  if (!rootMatch) throw new FeedError('No feed was found at that address');

  const head = source.slice(0, rootMatch.index + rootMatch[0].indexOf('>') + 1);
  const channel = source.slice(head.length);
  // The channel header: everything before the first item/entry.
  const firstChunk = channel.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i);
  const channelHead = firstChunk > 0 ? channel.slice(0, firstChunk) : channel;
  const feedTitle = toText(childText(channelHead, ['title']), 300)
    || (baseUrl ? safeHost(baseUrl) : '') || 'Feed';

  const siteUrl = isAtom
    ? safeLink(atomLink(channelHead) || '', baseUrl)
    : safeLink(childText(channelHead, ['link']), baseUrl);

  const chunks = isAtom
    ? splitChunks(channel, 'entry')
    : splitChunks(channel, 'item');
  if (!chunks.length && !childText(source, ['title'])) {
    throw new FeedError('No feed was found at that address');
  }

  const items = chunks.map((chunk) => {
    const title = toText(childText(chunk, ['title']), 300);
    const link = isAtom
      ? safeLink(atomLink(chunk), baseUrl)
      : safeLink(childText(chunk, ['link']), baseUrl);
    let date = parseDate(childText(chunk, ['pubdate', 'date', 'published', 'updated']));
    if (!date || date.getTime() > fetchedAt.getTime() + 60_000) date = fetchedAt;
    const author = toText(childText(chunk, ['author', 'creator', 'name']), 200) || null;
    // Atom hides its HTML behind entities; decode first so toText sees the
// real tags. (A plain-text "&lt;tag&gt;" becomes a tag here — the feed
// asked for markup, and it is stripped either way.)
const summary = toText(decodeEntities(childText(chunk, ['description', 'summary', 'encoded', 'content'])));
    return {
      guid: guidFor(chunk, link, title, date),
      title: title || '(untitled post)',
      link,
      summary,
      author,
      publishedAt: date,
    };
  }).filter((item) => item.title !== '(untitled post)' || item.summary || item.link);

  if (!items.length && !feedTitle) throw new FeedError('No feed was found at that address');
  return { title: feedTitle, siteUrl: siteUrl || null, items };
}

function safeHost(baseUrl) {
  try { return new URL(baseUrl).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Split into the chunks between <item>…</item> (or <entry>), outermost-first. */
function splitChunks(xml, tag) {
  const re = new RegExp(`<${tag}(?=\\s|>)([\\s\\S]*?)</${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

/**
 * findFeedLink(html, baseUrl): when the answer is a web page, the address of
 * the RSS or Atom feed it names in <link rel="alternate">, else null.
 */
function findFeedLink(html, baseUrl) {
  const tags = String(html || '').match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = (tag.match(/rel\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const type = (tag.match(/type\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const href = (tag.match(/href\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (!href || !/alternate/i.test(rel)) continue;
    if (!/application\/(rss|atom)\+xml/i.test(type)) continue;
    try {
      const url = new URL(unwrapCdata(href).trim(), baseUrl);
      if (url.protocol === 'https:') return url.href;
    } catch {}
  }
  return null;
}

module.exports = {
  FeedError,
  normaliseUrl,
  isPrivateIp,
  safeFetch,
  parseFeed,
  findFeedLink,
  toText,
};