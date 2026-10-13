'use strict';
// Fetching feeds from the public internet, safely. Only this module's
// safeFetch leaves the process: every request and every redirect hop passes
// the address guard (DNS lookup first, private addresses refused), with a
// 10 s timeout, a 5 MB body cap and at most 4 redirects. lib/feeds-api.js
// calls loadFeed; its FeedError messages are shown to people as they are.

const dns = require('dns').promises;
const { parseFeed, findFeedLinks, NotAFeed } = require('./feed-parse');

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const MAX_HOPS = 4;

class FeedError extends Error {}

const BAD_ADDRESS = 'That address cannot be reached from here.';
const BAD_FORM = 'Enter a web address, for example example.com/feed.';
const DID_NOT_ANSWER = 'That address did not answer. Check it and try again.';
const NO_FEED = "No feed found at that address. Try the site's feed link, often ending in /feed or /rss.";

// Trim, add https:// when there is no scheme, keep only http/https, drop the
// hash, lowercase the host.
function normalizeUrl(input) {
  let v = String(input || '').trim();
  if (!v) throw new FeedError(BAD_FORM);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
  let u;
  try { u = new URL(v); } catch { throw new FeedError(BAD_FORM); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FeedError(BAD_FORM);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  return u;
}

// The 8 groups of an IPv6 address, or null when it is not parseable.
function expandV6(s) {
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  let tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  // A trailing IPv4 dotted quad (::ffff:10.0.0.1) is two groups, not one
  // segment: parseInt would read only its first number. Anything dotted
  // elsewhere is not a form we trust.
  const last = tail[tail.length - 1];
  if (last && last.includes('.')) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(last)) return null;
    const [a, b, c, d] = last.split('.').map(Number);
    if (a > 255 || b > 255 || c > 255 || d > 255) return null;
    tail = tail.slice(0, -1).concat(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
  } else if (head.some((g) => g.includes('.'))) {
    return null;
  }
  const mid = Array(Math.max(0, 8 - head.length - tail.length)).fill('0');
  const groups = [...head, ...mid, ...tail].map((g) => parseInt(g || '0', 16));
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g))) return null;
  return groups;
}

// True for loopback, private, link-local (including the cloud metadata
// address), CGNAT, this-network, multicast and reserved ranges, in IPv4,
// IPv6 and IPv4-mapped forms. Exported for the tests.
function isBlockedAddress(ip) {
  const s = String(ip).toLowerCase().split('%')[0];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) {
    const [a, b] = s.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
    if (a === 100 && (b & 0xc0) === 64) return true;   // CGNAT 100.64/10
    if (a === 169 && b === 254) return true;           // link-local (and metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;  // private
    if (a === 192 && b === 168) return true;           // private
    if (a >= 224) return true;                         // multicast and reserved
    return false;
  }
  if (s === 'localhost') return true;
  const g = expandV6(s);
  if (!g) return true; // an address we cannot parse is not one we trust
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) {
    return isBlockedAddress(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // ::ffff:1.2.3.4
  }
  if (g.every((n) => n === 0)) return true; // ::
  if (g[0] === 0 && g[7] === 1) return true; // ::1
  if (g[0] >= 0xfc00 && g[0] <= 0xfdff) return true; // fc00::/7 unique local
  if (g[0] >= 0xfe80 && g[0] <= 0xfebf) return true; // fe80::/10 link-local
  return false;
}

// Refuse a hostname or port the app will not fetch, then refuse any address
// the host resolves to. Runs before every request and every redirect hop.
async function assertReachable(hostname, port) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) throw new FeedError(BAD_ADDRESS);
  if (port && port !== 80 && port !== 443) throw new FeedError(BAD_ADDRESS);
  let addrs;
  try {
    addrs = await dns.lookup(hostname, { all: true });
  } catch {
    throw new FeedError(DID_NOT_ANSWER);
  }
  for (const { address } of addrs) {
    if (isBlockedAddress(address)) throw new FeedError(BAD_ADDRESS);
  }
}

// safeFetch(url) → { res, url }, with url the final URL after redirects.
async function safeFetch(url, hops = 0) {
  const u = url instanceof URL ? url : new URL(url);
  await assertReachable(u.hostname, u.port ? Number(u.port) : 0);
  let res;
  try {
    res = await fetch(u, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'User-Agent': 'RSSReader/1.0 (Homeroom)',
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.5',
      },
    });
  } catch {
    throw new FeedError(DID_NOT_ANSWER);
  }
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location');
    if (!loc) throw new FeedError(DID_NOT_ANSWER);
    if (hops >= MAX_HOPS) throw new FeedError('That address redirected too many times.');
    let next;
    try { next = new URL(loc, u); } catch { throw new FeedError(DID_NOT_ANSWER); }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new FeedError(BAD_ADDRESS);
    return safeFetch(next, hops + 1);
  }
  if (res.status >= 400) {
    const err = new FeedError(`That address answered with error ${res.status}.`);
    err.status = res.status;
    throw err;
  }
  return { res, url: u };
}

// Read the body, aborting past 5 MB.
async function readBody(res) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new FeedError('That feed is too large to read (over 5 MB).');
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    if (err instanceof FeedError) throw err;
    throw new FeedError(DID_NOT_ANSWER);
  }
  return Buffer.concat(chunks);
}

/**
 * loadFeed(input, { now }) → { url, title, siteUrl, items }, the parsed feed
 * at its final URL. An ordinary website's body goes through findFeedLinks and
 * the first advertised feed is fetched through the same guard, once.
 * Throws FeedError whose message is fit to show under the add-feed field.
 */
async function loadFeed(input, opts = {}) {
  const first = normalizeUrl(input);
  const { res, url } = await safeFetch(first);
  const text = (await readBody(res)).toString('utf8');
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const looksHtml = type.includes('html') || /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text);
  if (!looksHtml) {
    try {
      return { ...parseFeed(text, url.href, opts), url: url.href };
    } catch (err) {
      if (err instanceof NotAFeed) throw new FeedError(NO_FEED);
      throw err;
    }
  }
  const links = findFeedLinks(text, url.href);
  if (!links.length) throw new FeedError(NO_FEED);
  const second = await safeFetch(links[0]);
  const xml = (await readBody(second.res)).toString('utf8');
  try {
    return { ...parseFeed(xml, second.url.href, opts), url: second.url.href };
  } catch (err) {
    if (err instanceof NotAFeed) throw new FeedError(NO_FEED);
    throw err;
  }
}

// The short plain reason a refresh failed, stored in feeds.last_error.
function shortReason(err) {
  if (err && err.status) return `error ${err.status}`;
  const m = String((err && err.message) || '');
  if (/redirected too many times/.test(m)) return 'it redirected too many times';
  if (/too large/.test(m)) return 'it is too large to read';
  if (/cannot be reached/.test(m)) return 'this app may not fetch it';
  if (/No feed found|not a feed/.test(m)) return 'it is not a feed any more';
  if (/Enter a web address/.test(m)) return 'its address is not valid';
  return 'the site did not answer';
}

module.exports = { loadFeed, safeFetch, normalizeUrl, isBlockedAddress, readBody, shortReason, FeedError };