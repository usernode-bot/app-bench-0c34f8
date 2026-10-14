// Fetching and parsing RSS/Atom feeds, safely.
//
// safeFetch talks only to public http(s) hosts (it resolves DNS and refuses
// loopback, private, link-local and metadata addresses, checks every redirect
// hop too), times out after 10 s and reads at most 2 MB. parseFeed turns the
// XML of RSS 2.0, RSS 1.0 and Atom into plain text: no HTML ever reaches the
// page, because the client sets everything as text.

const dns = require('dns').promises;
const net = require('net');
const { XMLParser } = require('fast-xml-parser');

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

// ── The guarded fetch ─────────────────────────────────────────────────────

/** A string reason when the address must not be fetched, else null. */
function blockedIpReason(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return 'a loopback or private address';
    if (a === 169 && b === 254) return 'a link-local address';
    if (a === 172 && b >= 16 && b <= 31) return 'a private address';
    if (a === 192 && b === 168) return 'a private address';
    if (a === 100 && b >= 64 && b <= 127) return 'a carrier-grade NAT address';
    if (a === 198 && (b === 18 || b === 19)) return 'a reserved address';
    if (a === 192 && b === 0 && c === 0) return 'a reserved address';
    if (a >= 224) return 'a multicast or reserved address';
    return null;
  }
  const hex = expandV6(ip);
  if (!hex) return 'an invalid address';
  if (/^0{32}$/.test(hex)) return 'an unspecified address';
  if (/^0{31}1$/.test(hex)) return 'a loopback address';
  const g = hex.match(/.{4}/g).map((x) => parseInt(x, 16));
  if (g[0] === 0xfc || g[0] === 0xfd) return 'a private address';
  if (g[0] === 0xfe && (g[1] & 0xc0) === 0x80) return 'a link-local address';
  if (g[0] === 0xff) return 'a multicast address';
  // ::ffff:10.0.0.1 and friends carry an IPv4 address at the end.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return blockedIpReason(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  return null;
}

/** An IPv6 address as 32 hex digits, or null. */
function expandV6(ip) {
  if (!net.isIPv6(ip)) return null;
  let text = ip;
  if (text.includes('%')) text = text.split('%')[0]; // drop a zone id
  const [head, tail] = text.split('::');
  const h = head ? head.split(':').filter(Boolean) : [];
  const t = tail !== undefined ? tail.split(':').filter(Boolean) : [];
  const parts = text.includes('::')
    ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
    : h;
  if (parts.length !== 8) return null;
  return parts.map((x) => x.padStart(4, '0')).join('');
}

/** Resolve the host and refuse it unless every address is public. */
async function assertPublicHost(hostname) {
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error('That address does not resolve. Check it and try again.');
  }
  if (!addrs.length) throw new Error('That address does not resolve. Check it and try again.');
  for (const { address } of addrs) {
    const reason = blockedIpReason(address);
    if (reason) throw new Error(`That address points at ${reason}, so it cannot be fetched.`);
  }
}

/** Read the body, stopping past 2 MB. */
async function readLimited(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('That feed is bigger than 2 MB.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * safeFetch(url): http and https only, DNS-resolved and refused for loopback,
 * private, link-local and metadata hosts, up to 3 redirects (each hop checked
 * again), 10 s timeout, at most 2 MB of body. Throws Errors whose messages
 * are fit to show a person.
 */
async function safeFetch(url, redirects = MAX_REDIRECTS) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Error('That is not a valid address.');
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('Only http and https addresses work.');
  }
  await assertPublicHost(target.hostname);
  let res;
  try {
    res = await fetch(target, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'user-agent': 'RSSReader/1.0 (Homeroom app)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml; q=0.9, */*; q=0.8',
      },
    });
  } catch (err) {
    if (err && err.name === 'TimeoutError') throw new Error('The site took too long to answer.');
    throw new Error('That site did not answer. Check the address and try again.');
  }
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    if (redirects <= 0) throw new Error('That address redirects too many times.');
    const location = res.headers.get('location');
    if (!location) throw new Error('That site answered with a redirect that goes nowhere.');
    try { await res.body?.cancel(); } catch { /* already closed */ }
    return safeFetch(new URL(location, target), redirects - 1);
  }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw new Error(`The site answered with error ${res.status}.`);
  }
  return readLimited(res);
}

// ── Parsing ───────────────────────────────────────────────────────────────

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', eacute: 'é', egrave: 'è', agrave: 'à',
  ccedil: 'ç', ouml: 'ö', uuml: 'ü', auml: 'ä', szlig: 'ß',
};

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCode(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (all, name) => ENTITIES[name.toLowerCase()] ?? all);
}

function safeFromCode(code) {
  try {
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** The text of a node the parser gave: a string, or { '#text', ...attrs }. */
function txt(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  return typeof node['#text'] === 'string' ? node['#text'] : '';
}

function linkList(node) {
  return [].concat(node == null ? [] : node).map((l) => (typeof l === 'string' ? l : l && l['@_href'])).filter(Boolean);
}

/** An Atom link: prefer rel="alternate" or no rel at all. */
function atomLink(links) {
  const pick = links.find((l) => l && typeof l === 'object' && l['@_rel'] === 'alternate')
    || links.find((l) => l && typeof l === 'object' && !l['@_rel'])
    || links[0];
  return typeof pick === 'string' ? pick : pick && pick['@_href'];
}

function when(...candidates) {
  for (const value of candidates) {
    const raw = txt(value);
    if (!raw) continue;
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

/** HTML as plain text: scripts and tags out, entities decoded, blank lines folded. */
function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split plain text into paragraphs of a readable length. */
function toParagraphs(text) {
  const paras = text.split(/\n{2,}/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  const out = [];
  for (const para of paras) {
    if (para.length <= 600) { out.push(para); continue; }
    const sentences = para.split(/(?<=[.!?])\s+/);
    let chunk = '';
    for (const sentence of sentences) {
      if (chunk && (chunk + ' ' + sentence).length > 400) { out.push(chunk.trim()); chunk = sentence; }
      else chunk = chunk ? chunk + ' ' + sentence : sentence;
    }
    if (chunk.trim()) out.push(chunk.trim());
  }
  return out;
}

/** The excerpt: the first ~200 characters at a word boundary. */
function excerptFrom(paras, max = 200) {
  const text = paras.join(' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd() + '…';
}

/** The preview paragraphs, up to about 1,200 characters. */
function previewFrom(paras, max = 1200) {
  const out = [];
  let size = 0;
  for (const para of paras) {
    if (out.length && size + para.length > max) break;
    out.push(para);
    size += para.length;
    if (size >= max) break;
  }
  return out;
}

function shapeItem({ guid, title, link, publishedAt, bodyHtml }) {
  const clean = htmlToText(bodyHtml);
  const paras = toParagraphs(clean);
  const heading = decodeEntities(String(title || '')).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  return {
    guid: guid || link || heading,
    title: heading || '(untitled post)',
    link: link || null,
    publishedAt,
    excerpt: excerptFrom(paras),
    preview: previewFrom(paras),
  };
}

const NOT_A_FEED = 'That address is not an RSS or Atom feed.';

/**
 * parseFeed(xml): RSS 2.0, RSS 1.0 and Atom to
 * { title, siteUrl, items: [{ guid, title, link, publishedAt, excerpt, preview }] }.
 * Throws the NOT_A_FEED message when the XML is not one of those.
 */
function parseFeed(xml) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error(NOT_A_FEED);
  }
  if (!doc || typeof doc !== 'object') throw new Error(NOT_A_FEED);

  let title = '';
  let siteUrl = null;
  let rawItems = null;

  if (doc.rss && (doc.rss.channel || doc.rss.item)) {
    const channel = [].concat(doc.rss.channel || [])[0] || {};
    const links = linkList(channel.link);
    title = txt(channel.title);
    siteUrl = links[0] || null;
    rawItems = [].concat(channel.item || []);
    rawItems = rawItems.map((it) => shapeItem({
      guid: txt(it.guid) || null,
      title: txt(it.title),
      link: linkList(it.link)[0] || null,
      publishedAt: when(it.pubDate, it['dc:date']),
      bodyHtml: txt(it['content:encoded']) || txt(it.description),
    }));
  } else if (doc['rdf:RDF']) {
    const rdf = doc['rdf:RDF'];
    const channel = [].concat(rdf.channel || [])[0] || {};
    title = txt(channel.title);
    siteUrl = linkList(channel.link)[0] || null;
    rawItems = [].concat(rdf.item || []).map((it) => shapeItem({
      guid: linkList(it.link)[0] || null,
      title: txt(it.title),
      link: linkList(it.link)[0] || null,
      publishedAt: when(it['dc:date'], it.pubDate),
      bodyHtml: txt(it.description) || txt(it['content:encoded']),
    }));
  } else if (doc.feed) {
    const feed = doc.feed;
    title = txt(feed.title);
    siteUrl = atomLink(linkList(feed.link)) || null;
    rawItems = [].concat(feed.entry || []).map((entry) => shapeItem({
      guid: txt(entry.id) || null,
      title: txt(entry.title),
      link: atomLink(linkList(entry.link)) || null,
      publishedAt: when(entry.published, entry.updated),
      bodyHtml: txt(entry.content) || txt(entry.summary),
    }));
  } else {
    throw new Error(NOT_A_FEED);
  }

  return {
    title: title || '',
    siteUrl,
    items: rawItems.filter((it) => it.guid).slice(0, 100),
  };
}

module.exports = { safeFetch, parseFeed };
