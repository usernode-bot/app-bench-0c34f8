// The feed fetcher: turn a feed URL into { title, siteUrl, items: [...] }.
// Everything an app can be pointed at on the internet is untrusted, so the
// guard below refuses the addresses a malicious feed URL would aim us at
// (the container's own services, the cloud metadata endpoint, ...) before
// any connection is made.
const dns = require('dns').promises;
const net = require('net');
const { XMLParser } = require('fast-xml-parser');

const FETCH_TIMEOUT = 8000;   // per request, guard included
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  processEntities: true,
});

// Fetch a feed and parse it. Throws Error with a plain-words message when the
// URL is not something we would fetch or the body is not a feed.
async function fetchFeed(url) {
  const body = await guardedGet(url);
  const parsed = parseFeed(body, url);
  if (!parsed.title && !parsed.items.length) {
    throw new Error('That page is not a feed. Paste a feed link (often ending in .xml or /feed).');
  }
  return parsed;
}

// http/https only, no credentials in the URL, DNS-resolved and every address
// checked before we connect, redirects re-checked, size and time capped.
async function guardedGet(rawUrl, depth = 0) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('That is not a link. Paste a feed link starting with http:// or https://.');
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error('Only http and https feeds work. Paste a feed link starting with http:// or https://.');
  }
  if (url.username || url.password) {
    throw new Error('Links with a username in them do not work here.');
  }
  url.hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
  await assertPublicHost(url.hostname);

  let res;
  try {
    res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      headers: {
        'User-Agent': 'Homeroom RSS Reader (+https://app.onhomeroom.com)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
    });
  } catch (err) {
    throw new Error('That link would not load. Check it and try again.');
  }

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get('location');
    res.body?.cancel?.();
    if (!location) throw new Error('That link would not load. Check it and try again.');
    if (depth >= MAX_REDIRECTS) throw new Error('That link redirects too many times.');
    return guardedGet(new URL(location, url).href, depth + 1);
  }
  if (!res.ok) {
    throw new Error(`That link answered with an error (${res.status}). Check it and try again.`);
  }

  const declared = (res.headers.get('content-length') || '');
  if (declared && Number(declared) > MAX_BYTES) throw new Error('That feed is too large to read.');

  // Read up to the cap, then stop, whatever the body promises to be.
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      reader.cancel();
      throw new Error('That feed is too large to read.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Resolve the host and refuse anything private, local or otherwise not the
// public internet. Applies to IPv4 and IPv6 alike, checked per redirect hop.
async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) throw new Error('Only public internet feeds work.');
    return;
  }
  let addrs = [];
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('That web address does not exist. Check the link.');
  }
  if (!addrs.length || !addrs.every((a) => isPublicIp(a.address))) {
    throw new Error('That address is not on the public internet, so we do not fetch it.');
  }
}

function isPublicIp(ip) {
  const v4 = ip.includes('.') && !ip.includes(':');
  if (v4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && inRange(b, 16, 31)) || (a === 192 && b === 168)
      || (a === 100 && inRange(b, 64, 127))
      || (a === 198 && (b === 18 || b === 19)) || a === 224 || a >= 240) return false;
    return true;
  }
  // IPv6: loopback, link-local, unique-local, multicast, IPv4-mapped, docs.
  const v6 = ip.replace(/%/g, '').toLowerCase();
  if (v6 === '::' || v6 === '::1') return false;
  const first = parseInt(v6.split(':')[0] || '0', 16);
  if (first >= 0xfe80 && first <= 0xfebf) return false; // link-local
  if (first >= 0xfc00 && first <= 0xfdff) return false; // unique-local
  if ((first & 0xff00) === 0xff00) return false;        // multicast
  if (v6.startsWith('2001:db8:')) return false;         // documentation
  if (v6.startsWith('::ffff:')) {
    return isPublicIp(v6.slice(7)); // mapped IPv4, judge as IPv4
  }
  return first >= 0x2000; // global unicast space starts at 2000::
}

function inRange(n, lo, hi) { return n >= lo && n <= hi; }

// ── Parsing ────────────────────────────────────────────────────────────────

// RSS 2.0, RSS 1.0 (RDF) and Atom. Whatever else a URL serves, we answer
// "not a feed" rather than half-understand it.
function parseFeed(xml, sourceUrl) {
  let doc;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new Error('That page is not a feed. Paste a feed link (often ending in .xml or /feed).');
  }
  const rss = doc.rss && doc.rss.channel ? doc.rss.channel : null;
  const rdf = doc['rdf:RDF'] ? doc['rdf:RDF'] : null;
  const atom = doc.feed ? doc.feed : null;

  if (rss) {
    return {
      title: text(rss.title) || 'Untitled feed',
      siteUrl: firstLink(rss.link) || null,
      items: asArray(rss.item).map((it) => ({
        guid: text(it.guid) || text(it.link) || fallbackGuid(it),
        title: text(it.title) || '(untitled post)',
        link: text(it.link) || null,
        summary: htmlToText(it.description || it['content:encoded']),
        publishedAt: date(it.pubDate) || date(it['dc:date']),
      })),
    };
  }
  if (rdf) {
    const ch = rdf.channel || {};
    return {
      title: text(ch.title) || 'Untitled feed',
      siteUrl: firstLink(ch.link) || null,
      items: asArray(rdf.item).map((it) => ({
        guid: text(it.guid) || text(it.link) || fallbackGuid(it),
        title: text(it.title) || '(untitled post)',
        link: text(it.link) || null,
        summary: htmlToText(it.description || it['content:encoded']),
        publishedAt: date(it['dc:date']) || date(it.pubDate),
      })),
    };
  }
  if (atom) {
    const links = asArray(atom.link);
    const site = links.find((l) => l['@_rel'] === 'alternate') || links.find((l) => !l['@_rel']);
    return {
      title: text(atom.title) || 'Untitled feed',
      siteUrl: site ? site['@_href'] : null,
      items: asArray(atom.entry).map((it) => {
        const elinks = asArray(it.link);
        const el = elinks.find((l) => l['@_rel'] === 'alternate') || elinks.find((l) => !l['@_rel']) || elinks[0];
        return {
          guid: text(it.id) || (el && el['@_href']) || fallbackGuid(it),
          title: text(it.title) || '(untitled post)',
          link: el ? el['@_href'] : null,
          summary: htmlToText(it.summary || it.content),
          publishedAt: date(it.published) || date(it.updated),
        };
      }),
    };
  }
  return { title: '', siteUrl: null, items: [] };
}

function asArray(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function text(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x.trim();
  if (typeof x === 'number') return String(x);
  if (typeof x === 'object') {
    if (typeof x['#text'] === 'string') return x['#text'].trim();
    if (typeof x['@_href'] === 'string') return x['@_href'].trim();
    if (x['#text'] != null) return String(x['#text']).trim();
  }
  return '';
}

// A link that is a plain string beats an atom:link object; take the first.
function firstLink(link) {
  const list = asArray(link);
  const plain = list.find((l) => typeof l === 'string' && l.trim());
  return plain ? plain.trim() : null;
}

function fallbackGuid(it) {
  const seed = `${text(it.title)}|${date(it.pubDate) || date(it['dc:date']) || date(it.published) || date(it.updated)}`;
  return 'hash:' + Buffer.from(seed).toString('base64url');
}

function date(s) {
  const t = text(s);
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// The summary we keep is plain text: tags out, entities decoded, a few
// hundred characters is plenty for a preview row and a preview sheet.
function htmlToText(html) {
  if (html == null) return '';
  let s = typeof html === 'object' ? text(html) : String(html);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => (Number(n) < 0x110000 ? String.fromCodePoint(Number(n)) : ' '));
  s = s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  if (s.length > 600) s = s.slice(0, 600).replace(/\s+\S*$/, '') + '…';
  return s;
}

module.exports = { fetchFeed, isPublicIp, htmlToText };
