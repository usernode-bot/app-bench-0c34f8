'use strict';

/* Safe outbound feed fetching, with Node's built-in fetch only.
 *
 * fetchFeed(input) → { xml, url } where xml is the feed body (≤ 2 MB) —
 * or throws an Error whose `code` is one of:
 *   invalid_url  the address is not a usable http(s) URL
 *   unreachable  DNS, network, timeout, redirect loop or an unsafe host
 *
 * Unsafe addresses are refused before each request: the host is resolved
 * with dns.lookup(all: true) and any address in a loopback, private,
 * CGNAT, link-local, unspecified, IPv6 ULA or IPv6 link-local range
 * refuses the whole fetch. Redirects are followed manually (at most 3
 * hops) and re-checked at every hop, so a public feed cannot bounce the
 * server at something internal.
 */

const dns = require('dns').promises;

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  throw err;
}

/* ── URL normalisation ─────────────────────────────────────────────────── */

// An address typed without a scheme is tried as https:// (spec).
function normalizeFeedUrl(input) {
  if (typeof input !== 'string') fail('invalid_url');
  let text = input.trim();
  if (!text) fail('invalid_url');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = 'https://' + text;
  let url;
  try { url = new URL(text); } catch { fail('invalid_url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('invalid_url');
  if (url.username || url.password) fail('invalid_url');
  if (url.hostname.length > 253) fail('invalid_url');
  url.hash = '';
  return url;
}

/* ── Address screening ─────────────────────────────────────────────────── */

function unsafeIPv4(octets) {
  if (octets.length !== 4 || octets.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = octets;
  if (a === 0) return true;                      // "this" network / unspecified
  if (a === 10) return true;                     // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 127) return true;                    // loopback
  if (a === 169 && b === 254) return true;       // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;  // private
  if (a === 192 && b === 168) return true;       // private
  if (a >= 224) return true;                     // multicast / reserved
  return false;
}

// Expand an IPv6 address to its eight 16-bit groups (zeros filled in).
function ipv6Groups(host) {
  let text = host.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length > 7) return null;
  const groups = [];
  for (const part of left.concat(right)) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  while (groups.length < 8) groups.push(0);
  return groups;
}

function unsafeIPv6(host) {
  const groups = ipv6Groups(host);
  if (!groups) return true;
  const first8 = (i) => (groups[i] >> 8) & 0xff;
  const last8 = (i) => groups[i] & 0xff;

  // An IPv4 address embedded in IPv6 — IPv4-mapped (::ffff:0:0/96) or
  // NAT64 (64:ff9b::/96) — is screened as the IPv4 address it stands for.
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  const nat64 =
    groups[0] === 0x0064 && groups[1] === 0xff9b &&
    groups.slice(2, 6).every((g) => g === 0);
  if (mapped || nat64) {
    return unsafeIPv4([first8(6), last8(6), first8(7), last8(7)]);
  }

  if (groups.every((g) => g === 0)) return true;                    // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 loopback
  // fe80::/10 link-local: first byte 0xfe, second byte's top two bits 10.
  if (first8(0) === 0xfe && (groups[0] & 0x0300) === 0x0200) return true;
  // fc00::/7 unique local: first byte 0xfc or 0xfd.
  if (first8(0) === 0xfc || first8(0) === 0xfd) return true;
  return false;
}

async function assertHostIsPublic(hostname) {
  // URL.hostname keeps the square brackets of a literal IPv6 address.
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '');
  // A literal IP in the URL never hits DNS: screen it directly.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (unsafeIPv4(host.split('.').map(Number))) fail('unreachable');
    return;
  }
  if (host.includes(':')) {
    if (unsafeIPv6(host)) fail('unreachable');
    return;
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    fail('unreachable');
  }
  if (!records || !records.length) fail('unreachable');
  for (const record of records) {
    if (record.family === 4) {
      if (unsafeIPv4(record.address.split('.').map(Number))) fail('unreachable');
    } else if (record.family === 6) {
      if (unsafeIPv6(record.address)) fail('unreachable');
    }
  }
}

/* ── Body reading ──────────────────────────────────────────────────────── */

async function readBodyCapped(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BYTES) fail('unreachable', 'feed too large');
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ── Entry point ───────────────────────────────────────────────────────── */

async function fetchOnce(url) {
  await assertHostIsPublic(url.hostname);
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location');
    response.body?.cancel?.().catch?.(() => {});
    if (!location) fail('unreachable');
    return { redirect: new URL(location, url) };
  }
  if (!response.ok) fail('unreachable');
  return { body: await readBodyCapped(response) };
}

async function fetchFeed(input) {
  const first = normalizeFeedUrl(input);
  let url = first;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('unreachable');
    let result;
    try {
      result = await fetchOnce(url);
    } catch (err) {
      if (err && (err.code === 'unreachable' || err.code === 'invalid_url')) throw err;
      fail('unreachable');
    }
    if (result.body !== undefined) return { xml: result.body, url };
    url = result.redirect;
  }
  fail('unreachable', 'too many redirects');
}

module.exports = { fetchFeed, normalizeFeedUrl };