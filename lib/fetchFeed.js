// Fetch and parse an RSS or Atom feed, guarded: http and https only, never a
// loopback, private, link-local, CGNAT or metadata address (checked for every
// resolved address and again on every redirect), at most 3 redirects, 2 MB,
// 8 s. Parse with rss-parser, which reads both formats.
const dns = require('dns').promises;
const net = require('net');
const Parser = require('rss-parser');

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const parser = new Parser({
  timeout: 7000,
  customFields: {
    item: ['media:content', 'media:thumbnail', 'content:encoded'],
  },
});

// ── Address guard ──────────────────────────────────────────────────────────

const BLOCKED_V4 = [
  ['0.0.0.0', 8],      // this host
  ['10.0.0.0', 8],     // private
  ['100.64.0.0', 10],  // CGNAT
  ['127.0.0.0', 8],    // loopback
  ['169.254.0.0', 16], // link-local (includes cloud metadata)
  ['172.16.0.0', 12],  // private
  ['192.0.0.0', 24],   // IETF protocol assignments
  ['192.0.2.0', 24],   // TEST-NET
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15],  // benchmarking
  ['198.51.100.0', 24],// TEST-NET
  ['203.0.113.0', 24], // TEST-NET
  ['224.0.0.0', 4],    // multicast
  ['240.0.0.0', 4],    // reserved
];

function v4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function inCidr(intIp, base, bits) {
  const b = v4ToInt(base);
  if (b === null || intIp === null) return false;
  if (bits === 0) return true;
  const mask = bits >= 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (intIp & mask) === (b & mask);
}

function isForbiddenIp(ip) {
  if (net.isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return n !== null && BLOCKED_V4.some(([base, bits]) => inCidr(n, base, bits));
  }
  const hex = expandV6(ip);
  if (hex === null) return true; // unparseable: refuse
  // IPv4-mapped (::ffff:0:0/96) and translated (64:ff9b::/96): judge the v4 inside.
  for (const prefix of ['00000000000000000000ffff', '0000000000000000000064ff9b']) {
    if (hex.startsWith(prefix)) {
      const n = Number.parseInt(hex.slice(24), 16);
      const dotted = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      const v4 = v4ToInt(dotted);
      return v4 !== null && BLOCKED_V4.some(([base, bits]) => inCidr(v4, base, bits));
    }
  }
  const n = BigInt('0x' + hex);
  if (n === 0n) return true;                          // ::
  if (n === 1n) return true;                          // ::1
  if ((n >> 120n) === 0xffn) return true;             // multicast ff00::/8
  if ((n >> 118n) === 0x3fen) return true;            // link-local fe80::/10
  if ((n >> 121n) === 0x7en) return true;             // unique-local fc00::/7
  if ((n >> 96n) === 0x20010db8n) return true;        // documentation 2001:db8::/32
  if ((n >> 96n) === 0x100n) return true;             // discard-only 100::/64
  if ((n >> 96n) === 0x20010n) return true;           // Teredo 2001:0::/32
  return false;
}

/** Expand an IPv6 address to 32 hex chars, or null when it is not valid. */
function expandV6(str) {
  if (typeof str !== 'string' || !str.includes(':')) return null;
  let groups;
  if (str.includes('::')) {
    const parts = str.split('::');
    if (parts.length !== 2) return null;
    const head = parts[0] ? parts[0].split(':') : [];
    const tail = parts[1] ? parts[1].split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    groups = str.split(':');
  }
  if (groups.length !== 8) return null;
  let out = '';
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out += g.toLowerCase().padStart(4, '0');
  }
  return out;
}

async function assertPublicUrl(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error('That address does not look right.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https addresses work.');
  }
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (net.isIP(host)) {
    if (isForbiddenIp(host)) throw new Error('That address is not allowed.');
  } else {
    let resolved;
    try {
      resolved = await dns.lookup(host, { all: true, verbatim: true });
    } catch {
      throw new Error('That address could not be found.');
    }
    if (!resolved.length) throw new Error('That address could not be found.');
    if (resolved.some((a) => isForbiddenIp(a.address))) {
      throw new Error('That address is not allowed.');
    }
  }
  return url;
}

// ── Guarded fetch ──────────────────────────────────────────────────────────

async function readCapped(body) {
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      try { body.cancel(); } catch {}
      throw new Error('That feed is too large to read.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function guardedFetch(urlStr) {
  let current = await assertPublicUrl(urlStr);
  for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': 'RSSReader/1.0',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      if (res.body) try { await res.body.cancel(); } catch {}
      if (!location) throw new Error('That address could not be reached.');
      if (hops === MAX_REDIRECTS) throw new Error('That address redirects too much.');
      current = await assertPublicUrl(new URL(location, current).href);
      continue;
    }
    if (!res.ok) throw new Error('That address could not be reached.');
    const declared = Number.parseInt(res.headers.get('content-length') || '', 10);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      try { await res.body.cancel(); } catch {}
      throw new Error('That feed is too large to read.');
    }
    return Buffer.from(await readCapped(res.body));
  }
  throw new Error('That address redirects too much.');
}

// ── Parsing ────────────────────────────────────────────────────────────────

function firstHttpsImage(...candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && /^https:\/\//.test(value)) return value;
  }
  return null;
}

function snippetOf(item) {
  const text = (item.contentSnippet || item.content || '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 400);
}

function imageOf(item) {
  const enclosure = Array.isArray(item.enclosure) ? item.enclosure[0] : item.enclosure;
  const media = item['media:content'] || item['media:thumbnail'];
  const mediaUrl = media && (media.$ && media.$.url || media.url);
  const direct = firstHttpsImage(enclosure && enclosure.url, mediaUrl);
  if (direct) return direct;
  const html = item['content:encoded'] || item.content || '';
  const match = html.match(/<img[^>]*\ssrc=["']([^"']+)["']/i);
  if (match && /^https:\/\//.test(match[1])) return match[1];
  return null;
}

/** fetchFeed(url) → { title, siteUrl, items: [{ guid, title, link, snippet, imageUrl, publishedAt }] } */
async function fetchFeed(url) {
  const xml = await guardedFetch(url);
  let parsed;
  try {
    parsed = await parser.parseString(xml.toString('utf8'));
  } catch {
    throw new Error('That address answered, but it is not an RSS or Atom feed.');
  }
  const items = (parsed.items || [])
    .map((item) => {
      const link = (item.link || '').trim();
      const title = (item.title || '').replace(/\s+/g, ' ').trim();
      const published = item.isoDate || item.pubDate || null;
      let publishedAt = null;
      if (published) {
        const date = new Date(published);
        if (!Number.isNaN(date.getTime())) publishedAt = date.toISOString();
      }
      return {
        guid: (item.guid || item.id || link || '').trim(),
        title,
        link: /^https?:\/\//.test(link) ? link : null,
        snippet: snippetOf(item),
        imageUrl: imageOf(item),
        publishedAt,
      };
    })
    .filter((item) => item.guid && (item.title || item.snippet));
  return {
    title: (parsed.title || '').trim(),
    siteUrl: typeof parsed.link === 'string' && /^https?:\/\//.test(parsed.link) ? parsed.link : null,
    items,
  };
}

module.exports = { fetchFeed, assertPublicUrl };
