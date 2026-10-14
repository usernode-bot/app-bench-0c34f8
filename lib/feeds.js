// Fetching and parsing RSS 2.0, RSS 1.0 and Atom feeds, with no new
// dependencies. Every server fetch of a typed address goes through
// fetchGuarded below, so a feed address can never be used to reach this
// app's own network: only http(s) out to a public address.
'use strict';

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

// ── The fetch guard ──────────────────────────────────────────────────────
// A GuardError means the address was refused before anything was fetched;
// its `reason` is a plain sentence for the person who typed the address.
class GuardError extends Error {
  constructor(reason) {
    super(reason);
    this.code = 'EGUARD';
    this.reason = reason;
  }
}

function guardError(hostname, why) {
  return new GuardError(`${hostname} is not allowed. Feed addresses must point at a public site.`);
}

// Public addresses only: refuse loopback, private, link-local (the cloud
// metadata service is link-local), CGNAT, multicast and reserved ranges,
// for IPv4 and IPv6 alike.
function isAllowedIp(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false; // this-host, private, loopback
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false;           // link-local (incl. 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return false;  // private
    if (a === 192 && b === 168) return false;           // private
    if (a >= 224) return false;                         // multicast, broadcast, reserved
    return true;
  }
  if (kind !== 6) return false;
  const low = ip.toLowerCase();
  if (low === '::' || low === '::1') return false;
  const parts = expandV6(low);
  const first = parts[0];
  if ((first & 0xff00) === 0xff00) return false;          // ff00::/8 multicast
  if ((first & 0xffc0) === 0xfe80) return false;          // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return false;          // fc00::/7 private ULA
  if (parts[5] === 0xffff) {
    // ::ffff:a.b.c.d — IPv4-mapped, apply the IPv4 rules to it
    return isAllowedIp(`${parts[6] >> 8}.${parts[6] & 255}.${parts[7] >> 8}.${parts[7] & 255}`);
  }
  return true;
}

function expandV6(ip) {
  if (ip.startsWith('::ffff:')) {
    const v4 = ip.slice(7).split('.').map(Number);
    return [0, 0, 0, 0, 0, 0xffff, (v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]].map(Number);
  }
  let head = ip;
  let tail = [];
  if (ip.includes('::')) {
    const [l, r = ''] = ip.split('::');
    head = l ? l.split(':') : [];
    tail = r ? r.split(':') : [];
  } else {
    head = ip.split(':');
  }
  const groups = head.map(hexPart).concat(tail.map(hexPart));
  while (groups.length < 8) groups.splice(head.length, 0, 0);
  return groups.map((g) => g || 0).slice(0, 8);
}

function hexPart(s) { return s ? parseInt(s, 16) || 0 : 0; }

// The `lookup` option net.connect accepts: resolve, check EVERY address the
// name has, and only then hand over one that passed. Checking all of them
// is what stops a lookup returning one public and one private address.
function guardedLookup(host, opts, cb) {
  // Node 20+ answers with the whole checked list when it asked for `all`
  // (its autoSelectFamily does), with the single address otherwise.
  const all = !!(opts && opts.all);
  const done = (err, address, family) => process.nextTick(() => cb(err, address, family));
  if (net.isIP(host)) {
    return isAllowedIp(host)
      ? done(null, all ? [{ address: host, family: net.isIP(host) }] : host, net.isIP(host))
      : done(guardError(host));
  }
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return done(err);
    const ok = addrs.filter((a) => isAllowedIp(a.address));
    if (!ok.length) return done(guardError(host));
    if (all) return process.nextTick(() => cb(null, ok));
    const want = Number(opts && opts.family) || 0;
    const pick = ok.find((a) => a.family === want) || ok[0];
    done(null, pick.address, pick.family);
  });
}

// One guarded GET: http(s) only, every redirect's address re-checked, no
// cookies sent or kept, 10s timeout, 5MB body limit. Resolves
// { body, finalUrl } or rejects with a GuardError or an Error with .reason.
function fetchGuarded(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(notFeed()); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(new GuardError(`${u.protocol.replace(':', '')} addresses are not allowed. Use a http or https address.`));
    }
    // Node does not call the lookup hook for an IP-literal host — it connects
    // straight to it — so the guard has to check that kind of host itself.
    if (net.isIP(u.hostname) && !isAllowedIp(u.hostname)) {
      return reject(guardError(u.hostname));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET',
      lookup: guardedLookup,
      timeout: TIMEOUT_MS,
      headers: {
        'User-Agent': 'RSSReader/1.0 (Homeroom app; feed reader)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
        'Accept-Language': '*',
      },
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume();
        const loc = res.headers.location;
        if (!loc) return reject(reachErr('The site redirected without an address to go to.'));
        if (redirects >= MAX_REDIRECTS) return reject(reachErr('The site redirected too many times.'));
        let next;
        try { next = new URL(loc, u); } catch { return reject(reachErr('The site redirected to an address we cannot read.')); }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return reject(new GuardError('The site redirected to an address that is not allowed.'));
        }
        return resolve(fetchGuarded(next.toString(), redirects + 1));
      }
      if (status !== 200) {
        res.resume();
        return reject(reachErr(status === 404 ? 'Nothing is served at that address (404).' : `The site answered with error ${status}.`));
      }
      const chunks = [];
      let size = 0;
      let settled = false;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          settled = true;
          req.destroy();
          reject(reachErr('The feed is larger than 5 MB.'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ body: Buffer.concat(chunks).toString('utf8'), finalUrl: u.toString() });
      });
      res.on('error', (err) => { if (!settled) { settled = true; reject(reachErr('The connection dropped while reading the feed.')); } });
    });
    req.on('timeout', () => req.destroy(new GuardError('The site took too long to answer (over 10s).')));
    req.on('error', (err) => {
      if (err.code === 'EGUARD') return reject(err);
      if (err instanceof GuardError) return reject(err);
      if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'ENODATA') {
        return reject(reachErr('That address does not point at a site we can reach.'));
      }
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
        return reject(reachErr('The site refused the connection or took too long.'));
      }
      if (err.code === 'EPROTO' || /SSL|TLS|certificate/i.test(err.message)) {
        return reject(reachErr('A secure connection to the site could not be made.'));
      }
      reject(reachErr('The site could not be reached.'));
    });
    req.end();
  });
}

function notFeed() {
  const e = new Error('That address does not look like a feed.');
  e.reason = 'That address does not look like a feed. It should point at the page the feed is served from, like example.com/feed.xml.';
  e.code = 'ENOTFEED';
  return e;
}

function reachErr(why) {
  const e = new Error(why);
  e.reason = why;
  e.code = 'EREACH';
  return e;
}

// "example.com/feed.xml" → "https://example.com/feed.xml". Returns null for
// anything that is not a plausible address.
function normalizeFeedUrl(input) {
  const raw = String(input || '').trim();
  if (!raw || /\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || !u.hostname.includes('.')) return null;
  u.hash = '';
  return u.toString();
}

// Fetch, parse, and shape: { url, finalUrl, title, siteUrl, posts }.
// Rejects with .reason (a plain sentence) when anything is off.
async function fetchFeed(url) {
  const { body, finalUrl } = await fetchGuarded(url);
  const parsed = parseFeed(body, finalUrl);
  if (!parsed) {
    const e = notFeed();
    e.reason = 'The site answered, but what it serves there is not a feed. Check the address is the page the feed is served from.';
    throw e;
  }
  return { url, finalUrl, title: parsed.title, siteUrl: parsed.siteUrl, posts: parsed.posts };
}

// ── The parser ───────────────────────────────────────────────────────────
// Collects <item>/<entry> elements without a real XML parser: scans tags,
// tracking CDATA sections, comments and nesting of the element itself.
function collectElements(xml, tag) {
  const openRe = new RegExp('<(?:[A-Za-z][\\w.-]*:)?' + tag + '(\\s[^>]*?)?/?>', 'gi');
  // Closes are matched by local name: `</dc:creator>` must close a search
  // for `dc:creator`, just as `</media:title>` closes one for `title`.
  const localTag = tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag;
  const out = [];
  let i = 0;
  for (;;) {
    openRe.lastIndex = i;
    const m = openRe.exec(xml);
    if (!m) break;
    if (insideCdata(xml, m.index) || insideComment(xml, m.index)) { i = m.index + 1; continue; }
    i = m.index + m[0].length;
    const attrs = m[1] || '';
    if (/\/\s*>$/.test(m[0])) { out.push({ inner: '', attrs }); continue; }
    let depth = 1;
    let closeAt = -1;
    let j = i;
    while (j < xml.length) {
      const lt = xml.indexOf('<', j);
      if (lt === -1) break;
      if (xml.startsWith('<![CDATA[', lt)) {
        const end = xml.indexOf(']]>', lt + 9);
        j = end === -1 ? xml.length : end + 3;
        continue;
      }
      if (xml.startsWith('<!--', lt)) {
        const end = xml.indexOf('-->', lt + 4);
        j = end === -1 ? xml.length : end + 3;
        continue;
      }
      const gt = xml.indexOf('>', lt);
      if (gt === -1) break;
      const raw = xml.slice(lt + 1, gt);
      const name = raw.match(/^\/?\s*(?:[A-Za-z][\w.-]*:)?([A-Za-z][\w.-]*)/);
      if (name && name[1].toLowerCase() === localTag.toLowerCase()) {
        if (raw.startsWith('/')) {
          depth -= 1;
          if (depth === 0) { closeAt = lt; j = gt + 1; break; }
        } else if (!/\/\s*$/.test(raw) && !raw.startsWith('?') && !raw.startsWith('!')) {
          depth += 1;
        }
      }
      j = gt + 1;
    }
    if (closeAt === -1) { out.push({ inner: xml.slice(i), attrs }); i = xml.length; }
    else { out.push({ inner: xml.slice(i, closeAt), attrs }); i = j; }
  }
  return out;
}

function insideCdata(xml, at) {
  const open = xml.lastIndexOf('<![CDATA[', at - 1);
  if (open === -1) return false;
  const close = xml.indexOf(']]>', open + 9);
  return close === -1 || close > at;
}

function insideComment(xml, at) {
  const open = xml.lastIndexOf('<!--', at - 1);
  if (open === -1) return false;
  const close = xml.indexOf('-->', open + 4);
  return close === -1 || close > at;
}

// The first named element's text, CDATA honoured, nested tags stripped.
function firstText(inner, names) {
  for (const name of names) {
    const el = collectElements(inner, name)[0];
    if (!el) continue;
    const text = elementText(el);
    if (text) return text;
  }
  return '';
}

function elementText(el) {
  const cdata = [...el.inner.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]).join('');
  if (cdata) return decodeEntities(cdata).replace(/<[^>]+>/g, ' ').trim();
  return decodeEntities(el.inner.replace(/<[^>]+>/g, ' ')).trim();
}

// Content (description/summary/content): plain text, paragraphs kept.
// Feed text is only ever text here — it is stored stripped and rendered as
// text on the page, never as HTML.
function cleanContent(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<!--[\s\S]*?-->/g, '');
  s = decodeEntities(s);
  if (/<[a-z!][^>]*>/i.test(s)) s = htmlToText(s);
  return s.trim();
}

function htmlToText(s) {
  return decodeEntities(s
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|pre)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\f]+/g, ' ')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', eacute: 'é', egrave: 'è', agrave: 'à',
  uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×',
  pound: '£', euro: '€', bull: '•', laquo: '«', raquo: '»', shy: '',
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body.toLowerCase()) ? ENTITIES[body.toLowerCase()] : all;
  });
}

function attr(el, name) {
  const m = (el.attrs || '').match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i'));
  return m ? (m[2] !== undefined ? m[2] : m[3]) : '';
}

function resolveLink(link, base) {
  const raw = String(link || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch { return ''; }
}

function parseDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

// parseFeed: null when the document is not a feed at all.
function parseFeed(xml, feedUrl) {
  if (!/<(?:[A-Za-z][\w.-]*:)?(?:rss|rdf|feed)[\s>]/i.test(xml.replace(/<!--[\s\S]*?-->/g, ''))) return null;
  const itemTagAt = firstTagAt(xml, ['item', 'entry']);
  const head = itemTagAt === -1 ? xml : xml.slice(0, itemTagAt);

  // The channel/feed title and site link come from before the first item.
  const channel = collectElements(head, 'channel')[0];
  const channelInner = channel ? channel.inner : head;
  const title = decodeText(firstText(channelInner, ['title']));
  const linkEl = collectElements(channelInner, 'link')[0];
  const siteUrl = linkEl ? (attr(linkEl, 'href') ? resolveLink(attr(linkEl, 'href'), feedUrl) : resolveLink(elementText(linkEl), feedUrl)) : '';

  const itemEls = collectElements(xml, 'item').concat(collectElements(xml, 'entry'));
  if (!itemEls.length && !title) return null;
  const posts = itemEls.map((el) => {
    const titleText = decodeText(firstText(el.inner, ['title']));
    let link = '';
    const linkEls = collectElements(el.inner, 'link');
    for (const l of linkEls) {
      const rel = attr(l, 'rel');
      const href = attr(l, 'href');
      if (href && (!rel || rel === 'alternate')) { link = href; break; }
      if (!href && !rel) link = elementText(l);
    }
    if (!link) link = firstText(el.inner, ['guid', 'id']);
    if (link && !/^https?:/i.test(link)) link = resolveLink(link, feedUrl) || '';
    const author = authorOf(el.inner);
    const published = parseDate(firstText(el.inner, ['pubDate', 'dc:date', 'published', 'updated', 'date']));
    const summary = cleanContent(firstRaw(el.inner, ['description', 'content:encoded', 'summary', 'content']));
    const guid = decodeText(firstText(el.inner, ['guid', 'id'])) || link || `${titleText}|${published ? published.toISOString() : ''}`;
    return { guid, title: titleText, link, author, summary, published };
  }).filter((p) => p.title || p.summary || p.link);
  return { title, siteUrl, posts };
}

function firstTagAt(xml, tags) {
  const re = new RegExp('<(?:[A-Za-z][\\w.-]*:)?(?:' + tags.join('|') + ')[\\s/>]', 'gi');
  for (;;) {
    const m = re.exec(xml);
    if (!m) return -1;
    if (!insideCdata(xml, m.index) && !insideComment(xml, m.index)) return m.index;
  }
}

function authorOf(inner) {
  const dc = firstText(inner, ['dc:creator']);
  if (dc) return decodeText(dc);
  const el = collectElements(inner, 'author')[0] || collectElements(inner, 'creator')[0];
  if (!el) return '';
  const name = firstText(el.inner, ['name']);
  const text = name || elementText(el);
  return decodeText(text.replace(/^[^<]*?<email>[\s\S]*?<\/email>\s*/i, '').split('(')[0].trim());
}

function decodeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

// The RAW inner of the first named element (CDATA markers intact), for
// content fields that cleanContent parses further.
function firstRaw(inner, names) {
  for (const name of names) {
    const el = collectElements(inner, name)[0];
    if (el) return el.inner;
  }
  return '';
}

module.exports = { fetchFeed, fetchGuarded, parseFeed, normalizeFeedUrl, isAllowedIp };
