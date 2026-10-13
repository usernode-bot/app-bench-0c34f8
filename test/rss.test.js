// Unit tests for lib/rss.js: URL rules, the private-address refusal, feed
// parsing (RSS 2.0, Atom, RDF), HTML-to-paragraphs, and the feed-link probe.
// Pure parts only — safeFetch itself needs a network and is exercised by the
// app's checks instead.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NotAFeed,
  normalizeUrl,
  parseFeed,
  htmlToParagraphs,
  findFeedLink,
  ipv4Private,
  isPrivateRecord,
  allRecordsPublic,
} = require('../lib/rss');

const NOW = new Date('2026-10-13T12:00:00Z');

// ── normalizeUrl ───────────────────────────────────────────────────────────

test('normalizeUrl adds https:// when there is no scheme', () => {
  assert.equal(normalizeUrl(' example.com/feed.xml '), 'https://example.com/feed.xml');
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
});

test('normalizeUrl keeps an explicit http URL', () => {
  assert.equal(normalizeUrl('http://example.com/feed.xml'), 'http://example.com/feed.xml');
});

test('normalizeUrl drops a fragment', () => {
  assert.equal(normalizeUrl('https://example.com/feed#top'), 'https://example.com/feed');
});

test('normalizeUrl refuses other schemes and credentials', () => {
  assert.throws(() => normalizeUrl('ftp://example.com/feed.xml'));
  assert.throws(() => normalizeUrl('javascript:alert(1)'));
  assert.throws(() => normalizeUrl('https://user:pass@example.com/feed.xml'));
  assert.throws(() => normalizeUrl('https://example.com:8080/feed.xml'));
  assert.throws(() => normalizeUrl(''));
  assert.throws(() => normalizeUrl('not a url at all'));
});

// ── Private-address refusal ────────────────────────────────────────────────

test('refuses loopback, private, link-local and reserved IPv4 addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.9', '192.168.1.20', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '999.1.1.1']) {
    assert.equal(ipv4Private(ip), true, ip);
  }
});

test('allows a public IPv4 address', () => {
  assert.equal(ipv4Private('93.184.216.34'), false);
  assert.equal(ipv4Private('172.32.0.1'), false);
});

test('refuses IPv6 loopback, unique-local, link-local and IPv4-mapped forms', () => {
  for (const a of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:192.168.1.1', '::ffff:10.0.0.5']) {
    assert.equal(isPrivateRecord({ address: a, family: 6 }), true, a);
  }
  assert.equal(isPrivateRecord({ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }), false);
});

test('allRecordsPublic needs at least one record and no refused ones', () => {
  assert.equal(allRecordsPublic([]), false);
  assert.equal(allRecordsPublic(undefined), false);
  assert.equal(allRecordsPublic([{ address: '93.184.216.34', family: 4 }]), true);
  assert.equal(allRecordsPublic([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]), false);
});

// ── parseFeed ──────────────────────────────────────────────────────────────

const RSS_XML = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Pocket Gardens Weekly &amp; Friends</title>
    <link>https://pocketgardens.example</link>
    <item>
      <title>Basil, <em>kindly</em></title>
      <link>https://pocketgardens.example/posts/basil</link>
      <guid>post-1</guid>
      <pubDate>Tue, 13 Oct 2026 09:00:00 GMT</pubDate>
      <dc:creator>Fern Example</dc:creator>
      <description><![CDATA[<p>Three pots, one east window.</p><p>Pinch the top leaves.</p>]]></description>
    </item>
    <item>
      <title>No date at all</title>
      <description>Short one, no guid and no link either.</description>
    </item>
    <item>
      <title>From the far future</title>
      <link>https://pocketgardens.example/posts/future</link>
      <pubDate>Wed, 13 Oct 2126 09:00:00 GMT</pubDate>
      <description>Clamp me.</description>
    </item>
    <item>
      <title>Bad date becomes the fetch time</title>
      <link>https://pocketgardens.example/posts/bad</link>
      <pubDate>not a date</pubDate>
      <description>Clamp me too.</description>
    </item>
  </channel>
</rss>`;

test('parseFeed reads RSS 2.0: title, items, guids, author, HTML text', () => {
  const feed = parseFeed(RSS_XML, 'https://pocketgardens.example/feed.xml', NOW);
  assert.equal(feed.title, 'Pocket Gardens Weekly & Friends');
  assert.equal(feed.siteUrl, 'https://pocketgardens.example/');
  assert.equal(feed.items.length, 4);
  const first = feed.items[0];
  assert.equal(first.title, 'Basil, kindly');
  assert.equal(first.guid, 'post-1');
  assert.equal(first.author, 'Fern Example');
  assert.equal(first.link, 'https://pocketgardens.example/posts/basil');
  assert.deepEqual(htmlToParagraphs(first.text), ['Three pots, one east window.', 'Pinch the top leaves.']);
});

test('parseFeed turns a missing date into the fetch time', () => {
  const feed = parseFeed(RSS_XML, 'https://pocketgardens.example/feed.xml', NOW);
  assert.equal(feed.items[1].date.toISOString(), NOW.toISOString());
});

test('parseFeed clamps future dates to the fetch time', () => {
  const feed = parseFeed(RSS_XML, 'https://pocketgardens.example/feed.xml', NOW);
  assert.equal(feed.items[2].date.toISOString(), NOW.toISOString());
});

test('parseFeed turns an invalid date into the fetch time', () => {
  const feed = parseFeed(RSS_XML, 'https://pocketgardens.example/feed.xml', NOW);
  assert.equal(feed.items[3].date.toISOString(), NOW.toISOString());
});

test('parseFeed falls back to a hash guid when there is none', () => {
  const feed = parseFeed(RSS_XML, 'https://pocketgardens.example/feed.xml', NOW);
  assert.match(feed.items[1].guid, /^[0-9a-f]{40}$/);
});

const ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Orbit Diary</title>
  <link rel="self" href="https://orbitdiary.example/feed.atom"/>
  <link rel="alternate" href="https://orbitdiary.example"/>
  <entry>
    <id>urn:orbit:post-9</id>
    <title>Naming every crater after a sandwich</title>
    <link href="https://orbitdiary.example/posts/craters"/>
    <author><name>Sol Example</name></author>
    <published>2026-10-12T08:30:00Z</published>
    <content type="html">&lt;p&gt;The committee could not agree.&lt;/p&gt;</content>
  </entry>
</feed>`;

test('parseFeed reads Atom: entries, ids as guids, the alternate link, author.name', () => {
  const feed = parseFeed(ATOM_XML, 'https://orbitdiary.example/feed.atom', NOW);
  assert.equal(feed.title, 'Orbit Diary');
  assert.equal(feed.siteUrl, 'https://orbitdiary.example/');
  const entry = feed.items[0];
  assert.equal(entry.guid, 'urn:orbit:post-9');
  assert.equal(entry.title, 'Naming every crater after a sandwich');
  assert.equal(entry.author, 'Sol Example');
  assert.equal(entry.link, 'https://orbitdiary.example/posts/craters');
  assert.deepEqual(htmlToParagraphs(entry.text), ['The committee could not agree.']);
});

const RDF_XML = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://bicycleshed.example">
    <title>The Bicycle Shed</title>
    <link>https://bicycleshed.example</link>
  </channel>
  <item rdf:about="https://bicycleshed.example/posts/bell">
    <title>Picking a bell that sounds friendly</title>
    <link>https://bicycleshed.example/posts/bell</link>
    <dc:date>2026-10-11T10:00:00Z</dc:date>
    <description>We rang eleven bells.</description>
  </item>
</rdf:RDF>`;

test('parseFeed reads RDF: items at the root, dc:date and dc:creator', () => {
  const feed = parseFeed(RDF_XML, 'https://bicycleshed.example/feed.rdf', NOW);
  assert.equal(feed.title, 'The Bicycle Shed');
  assert.equal(feed.items[0].title, 'Picking a bell that sounds friendly');
  assert.equal(feed.items[0].date.toISOString(), '2026-10-11T10:00:00.000Z');
});

test('parseFeed names an untitled post and an untitled feed', () => {
  const feed = parseFeed(
    `<rss version="2.0"><channel><link>https://quiet.example</link><item><link>https://quiet.example/a</link></item></channel></rss>`,
    'https://quiet.example/feed.xml',
    NOW,
  );
  assert.equal(feed.title, '');
  assert.equal(feed.items[0].title, 'Untitled post');
});

test('parseFeed refuses an HTML page with NotAFeed', () => {
  const html = '<!doctype html><html><head><title>A page</title></head><body><p>Hello</p></body></html>';
  assert.throws(() => parseFeed(html, 'https://example.com', NOW), NotAFeed);
});

// ── htmlToParagraphs ───────────────────────────────────────────────────────

test('htmlToParagraphs drops script, style and iframe with their contents', () => {
  const paras = htmlToParagraphs('<p>Keep this</p><script>alert("drop me")</script><style>.x{}</style><p>And this</p><iframe src="https://ad.example"></iframe>after');
  assert.deepEqual(paras, ['Keep this', 'And this', 'after']);
  assert.ok(!paras.join(' ').includes('alert'));
});

test('htmlToParagraphs breaks at p, br, li and headings and decodes entities', () => {
  const paras = htmlToParagraphs('<h1>First</h1><p>A &amp; B &lt;tag&gt; &#8212; ok</p>line<br>next<ul><li>Item</li></ul>');
  assert.deepEqual(paras, ['First', 'A & B <tag> — ok', 'line', 'next', 'Item']);
});

test('htmlToParagraphs collapses whitespace and skips empty paragraphs', () => {
  const paras = htmlToParagraphs('<p>   spaced\nout&nbsp;words   </p><p></p>');
  assert.deepEqual(paras, ['spaced out words']);
});

test('htmlToParagraphs handles empty input', () => {
  assert.deepEqual(htmlToParagraphs(''), []);
  assert.deepEqual(htmlToParagraphs(null), []);
});

// ── findFeedLink ───────────────────────────────────────────────────────────

test('findFeedLink finds the first alternate feed link, resolved against the page', () => {
  const html = '<head><link rel="stylesheet" href="/style.css"><link rel="alternate" type="application/rss+xml" title="Feed" href="/feed.xml"><link rel="alternate" type="application/atom+xml" href="/atom.xml"></head>';
  assert.equal(findFeedLink(html, 'https://example.com/blog/'), 'https://example.com/feed.xml');
});

test('findFeedLink ignores non-feed link tags and returns null when there is none', () => {
  assert.equal(findFeedLink('<link rel="alternate" type="text/html" href="/x">https', 'https://example.com'), null);
  assert.equal(findFeedLink('<p>no links</p>', 'https://example.com'), null);
});