// Reading feeds for the server: a safe fetch (public web addresses only),
// feed discovery on a site page, parsing with rss-parser, and the
// normalising that turns a parsed item into a posts row. Every failure is a
// FeedError whose message is written to be shown to the person who added the
// feed — plain words, no stack traces.

const dns = require('dns').promises;
const Parser = require('rss-parser');

const MAX_BYTES = 3 * 1024 * 1024; // a feed bigger than this is refused
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT = 10_000;
const MAX_POSTS_PER_FEED = 30;
const MAX_SUMMARY = 4000;

class FeedError extends Error {}

/** A web address (http or https) that the server may fetch: no credentials,
 * and a host that resolves to a public address only — so a feed URL can never
 * point this server back at itself, the database or the cluster's private
 * network. The lookup is injectable so tests run with no network. */
async function assertPublicUrl(rawUrl, { lookup = (host, opts) => dns.lookup(host, opts) } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FeedError('That address is not a web address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FeedError('That address is not a web address');
  }
  if (url.username || url.password) {
    throw new FeedError('That address is not public');
  }
  let addresses;
  try {
    addresses = await lookup(url.hostname, { all: true });
  } catch {
    throw new FeedError('The site did not answer');
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new FeedError('That address is not public');
  }
  return url;
}

// The address ranges a feed may not resolve to: this machine, private
// networks, link-local, carrier-grade NAT, multicast and the unspecified
// address — plus IPv6 forms of the same and IPv4-mapped IPv6.
function isPrivateAddress(address) {
  if (address.includes(':')) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^[fcd]/.test(lower); // fc00::/7 (unique local), fe80::/10 (link-local), ff00::/8 (multicast)
  }
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Fetch a URL with the guards on: public address, manual redirects that are
 * re-checked at every hop, ten seconds, three megabytes. Returns the final
 * URL and the body as text. */
async function safeFetch(rawUrl, { lookup } = {}) {
  let url = await assertPublicUrl(rawUrl, { lookup });
  for (let hops = 0; ; hops += 1) {
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        headers: {
          'User-Agent': 'RSS Reader (Homeroom)',
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8',
        },
      });
    } catch {
      throw new FeedError('The site did not answer');
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      try { res.body?.cancel(); } catch {}
      if (!location || hops >= MAX_REDIRECTS) throw new FeedError('The site answered with an error (' + res.status + ')');
      url = new URL(location, url);
      url = await assertPublicUrl(url.href, { lookup }); // every hop is re-checked
      continue;
    }
    if (!res.ok) throw new FeedError('The site answered with an error (' + res.status + ')');
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_BYTES) throw new FeedError('The feed is too large to read');
    const body = await readCapped(res);
    return { url: url.href, body };
  }
}

// Stream the body in, refusing anything past the cap even when no
// content-length was declared.
async function readCapped(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new FeedError('The feed is too large to read');
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').concat(chunks.map((c) => new Uint8Array(c)));
}

// The feed's own address on a site page: the first <link rel="alternate">
// pointing at an RSS or Atom type, resolved against the page's URL.
function discoverFeedUrl(html, base) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const rel = tag.match(/\brel\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const type = tag.match(/\btype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = tag.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!rel || !type || !href) continue;
    const relValue = (rel[2] ?? rel[3] ?? (rel[4] || '')).toLowerCase();
    const typeValue = (type[2] ?? type[3] ?? (type[4] || '')).toLowerCase();
    if (!/\balternate\b/.test(relValue)) continue;
    if (!/application\/(rss|atom)\+xml/.test(typeValue)) continue;
    try {
      const resolved = new URL(href[2] ?? href[3] ?? href[4], base);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') return resolved.href;
    } catch {}
  }
  return null;
}

const parser = new Parser({
  customFields: { item: ['content:encoded', 'id'] },
});

/** Parse a fetched feed body into { url, title, siteUrl, items } — items
 * already normalised to posts-shaped rows, newest first, 30 at most. */
async function parseFeedBody(body, { url, now = new Date() } = {}) {
  let parsed;
  try {
    parsed = await parser.parseString(body);
  } catch {
    throw new FeedError('No RSS or Atom feed was found at that address');
  }
  const hostname = new URL(url).hostname;
  let siteUrl = null;
  if (parsed.link) {
    try {
      const resolved = new URL(parsed.link, url);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') siteUrl = resolved.href;
    } catch {}
  }
  const title = String(parsed.title || '').trim() || hostname;
  const items = (parsed.items || [])
    .map((item) => normalizeItem(item, { siteUrl, now }))
    .filter(Boolean)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, MAX_POSTS_PER_FEED);
  return { url, title, siteUrl, items };
}

// One parsed item, shaped like a posts row: guid (the dedupe key), title,
// link, author, summary (plain text, paragraphs kept) and publishedAt.
function normalizeItem(item, { siteUrl, now }) {
  const iso = isoDate(item.isoDate || item.pubDate);
  const publishedAt = iso && new Date(iso) <= now ? iso : new Date(now).toISOString();
  let link = null;
  const rawLink = item.link || item.url;
  if (rawLink) {
    try {
      const resolved = new URL(String(rawLink), siteUrl || undefined);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') link = resolved.href;
    } catch {}
  }
  const summary = toPlainText(item['content:encoded'] || item.content || item.contentSnippet || item.summary || '');
  let title = String(item.title || '').trim();
  if (!title) title = summary.slice(0, 80).trim() || 'Untitled post';
  const guid = String(item.guid || item.id || link || (title + publishedAt) || 'untitled').slice(0, 500);
  const author = String(item.creator || item.author || '').trim() || null;
  return { guid, title, link, author, summary, publishedAt };
}

function isoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Fetch a feed, and if that address turned out to be a site page rather
 * than a feed, look for its feed link and fetch that once. */
async function loadFeed(rawUrl, opts = {}) {
  const { url, body } = await safeFetch(rawUrl, opts);
  try {
    return await parseFeedBody(body, { url, now: opts.now });
  } catch (err) {
    if (!(err instanceof FeedError) || !looksLikeHtml(body)) throw err;
    const feedUrl = discoverFeedUrl(body, url);
    if (!feedUrl) throw err;
    const second = await safeFetch(feedUrl, opts);
    try {
      return await parseFeedBody(second.body, { url: second.url, now: opts.now });
    } catch {
      throw new FeedError('No RSS or Atom feed was found at that address');
    }
  }
}

function looksLikeHtml(body) {
  return /<html\b|<!doctype html/i.test(body.slice(0, 1000));
}

// HTML to plain text, keeping paragraph breaks: scripts and styles dropped
// whole, block ends become blank lines, tags stripped, entities decoded,
// whitespace collapsed inside a paragraph, 4000 characters at most.
function toPlainText(html) {
  if (!html) return '';
  let text = String(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(?:p|li|div|h[1-6]|blockquote|tr)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let out = paragraphs.join('\n\n');
  if (out.length > MAX_SUMMARY) {
    out = out.slice(0, MAX_SUMMARY);
    const lastSpace = out.lastIndexOf(' ');
    if (lastSpace > MAX_SUMMARY * 0.6) out = out.slice(0, lastSpace);
    out = out.trimEnd() + '…';
  }
  return out;
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCode(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (_, name) => named[name.toLowerCase()] ?? '&' + name + ';');
}

function safeFromCode(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

module.exports = {
  FeedError,
  assertPublicUrl,
  safeFetch,
  discoverFeedUrl,
  parseFeedBody,
  loadFeed,
  toPlainText,
  isPrivateAddress,
};