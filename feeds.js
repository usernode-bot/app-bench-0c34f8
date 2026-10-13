'use strict';
// Fetching and parsing RSS/Atom feeds, safely: the app fetches whatever
// address a person pastes, so every fetch is guarded — http(s) only, DNS
// resolved and checked against loopback, private, link-local and metadata
// addresses on every hop (redirects followed at most 3 times), a 10 s
// timeout and a 2 MB body limit. Parsing is rss-parser (RSS and Atom).

const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const Parser = require('rss-parser');

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// Addresses a pasted feed URL must never reach: the app's own internals,
// other machines on the network, and cloud metadata endpoints.
function isPublicIp(ip) {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  const low = ip.toLowerCase();
  if (low === '::' || low === '::1') return false;
  if (low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd')) return false;
  // IPv4-mapped (::ffff:10.0.0.1) and other IPv6-wrapped IPv4.
  const mapped = low.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPublicIp(mapped[1]);
  const tail = low.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (tail) return isPublicIp(tail[1]);
  return true;
}

async function assertPublicHost(hostname) {
  if (/^[\d.]+$/.test(hostname)) {
    if (!isPublicIp(hostname)) throw new Error('bad-host');
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addrs || !addrs.length) throw new Error('bad-host');
  for (const { address } of addrs) {
    if (!isPublicIp(address)) throw new Error('bad-host');
  }
}

/**
 * safeFetch(url): guarded GET of a feed's XML.
 * Returns { url, text } for the final response. Throws an Error whose
 * `kind` is one of 'bad-url', 'bad-host', 'unreachable', 'too-big',
 * 'timeout', 'http' — mapped to plain words by the caller.
 */
async function safeFetch(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw kinded('bad-url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw kinded('bad-url');
  if (!url.hostname) throw kinded('bad-url');

  for (let hop = 0; ; hop += 1) {
    try {
      await assertPublicHost(url.hostname);
    } catch {
      throw kinded('bad-host');
    }
    const res = await request(url);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop >= MAX_REDIRECTS) {
        res.resume();
        throw kinded('unreachable');
      }
      let next;
      try {
        next = new URL(res.headers.location || '', url);
      } catch {
        throw kinded('unreachable');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw kinded('bad-url');
      res.resume();
      url = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      res.resume();
      throw kinded('http', res.status);
    }
    const text = await body(res);
    return { url: url.href, text };
  }

  function request(url) {
    return new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.get(url, { timeout: TIMEOUT_MS, headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } }, resolve);
      req.on('timeout', () => req.destroy(kinded('timeout')));
      req.on('error', (err) => reject(err.kind ? err : kinded('unreachable')));
    });
  }

  async function body(res) {
    const chunks = [];
    let size = 0;
    for await (const chunk of res) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        res.destroy();
        throw kinded('too-big');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

function kinded(kind, status) {
  return Object.assign(new Error(kind), { kind, status });
}

// HTML tags and the usual entities, out of a feed's summary text.
function plainText(value) {
  if (!value) return '';
  return String(value)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ''; }
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
}

const parser = new Parser({ customFields: { item: [['dc:creator', 'creator']] } });

/**
 * parseFeed(xml): RSS or Atom to { title, siteUrl, items }.
 * Each item: { guid, title, link, author, summary, publishedAt }.
 * Throws when the XML is not a feed at all.
 */
async function parseFeed(xml) {
  let out;
  try {
    out = await parser.parseString(xml);
  } catch {
    throw Object.assign(new Error('That address is not a feed (RSS or Atom).'), { notFeed: true });
  }
  const items = (out.items || []).map((item, i) => {
    const published = item.isoDate || item.pubDate;
    const publishedAt = published && !Number.isNaN(new Date(published).getTime())
      ? new Date(published) : null;
    return {
      guid: String(item.guid || item.link || `${item.title || 'post'}-${publishedAt ? publishedAt.toISOString() : i}`),
      title: plainText(item.title).slice(0, 300) || 'Untitled post',
      link: /^https?:\/\//i.test(String(item.link || '')) ? String(item.link) : null,
      author: plainText(item.creator).slice(0, 120) || null,
      summary: plainText(item.contentSnippet || item.summary || item.content || item['content:encoded']).slice(0, 4000),
      publishedAt,
    };
  });
  if (!out.title && !items.length) {
    throw Object.assign(new Error('That address is not a feed (RSS or Atom).'), { notFeed: true });
  }
  return {
    title: plainText(out.title).slice(0, 200) || 'Untitled feed',
    siteUrl: /^https?:\/\//i.test(String(out.link || '')) ? String(out.link) : null,
    items,
  };
}

/** A safeFetch error in plain words, for a form or a list line. */
function fetchError(err) {
  switch (err && err.kind) {
    case 'bad-url': return 'That does not look like a web address.';
    case 'bad-host': return 'That address is not reachable from here.';
    case 'timeout': return 'That address took too long to answer.';
    case 'too-big': return 'That address answered with too much data to be a feed.';
    case 'http': return `That address answered with an error (HTTP ${err.status}).`;
    default: return 'That address could not be reached.';
  }
}

module.exports = { safeFetch, parseFeed, fetchError };