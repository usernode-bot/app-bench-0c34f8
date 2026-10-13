'use strict';

// Tests for lib/feed.js: parsing (RSS, Atom, CDATA, entities), link
// handling, discovery, excerpt cutting and the private-address guard.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeed, discoverFeedUrl, toText, isPrivateAddress } = require('../lib/feed');

test('parses an RSS 2.0 feed with CDATA and entities', () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>My Feed &amp; More</title>
      <link>https://example.com/</link>
      <item>
        <title>A title with &lt;markup&gt;</title>
        <link>https://example.com/posts/1</link>
        <guid>post-1</guid>
        <pubDate>Mon, 12 Oct 2026 10:00:00 GMT</pubDate>
        <description><![CDATA[<p>First &amp; foremost, the <b>body</b>.</p>]]></description>
      </item>
      <item>
        <title>Second</title>
        <link>https://example.com/posts/2</link>
        <guid>post-2</guid>
        <pubDate>Tue, 13 Oct 2026 09:30:00 GMT</pubDate>
        <description>Plain text body</description>
      </item>
    </channel></rss>`;
  const feed = parseFeed(xml, 'https://example.com/feed.xml', new Date('2026-10-13T10:00:00Z'));
  assert.equal(feed.title, 'My Feed & More');
  assert.equal(feed.posts.length, 2);
  assert.equal(feed.posts[0].title, 'A title with <markup>');
  assert.equal(feed.posts[0].link, 'https://example.com/posts/1');
  assert.equal(feed.posts[0].guid, 'post-1');
  assert.equal(feed.posts[0].excerpt, 'First & foremost, the body .');
  assert.equal(feed.posts[1].publishedAt.toISOString(), '2026-10-13T09:30:00.000Z');
});

test('parses an Atom feed: href link, id, published, summary', () => {
  const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom Sample</title>
      <link rel="self" href="https://example.org/atom.xml"/>
      <link rel="alternate" href="https://example.org/"/>
      <entry>
        <title>An entry</title>
        <link rel="alternate" href="https://example.org/entries/7"/>
        <id>tag:example.org,2026:entry-7</id>
        <published>2026-10-12T08:00:00Z</published>
        <summary>Entry summary text</summary>
      </entry>
    </feed>`;
  const feed = parseFeed(xml, 'https://example.org/atom.xml', new Date('2026-10-13T10:00:00Z'));
  assert.equal(feed.title, 'Atom Sample');
  assert.equal(feed.posts[0].link, 'https://example.org/entries/7');
  assert.equal(feed.posts[0].guid, 'tag:example.org,2026:entry-7');
  assert.equal(feed.posts[0].excerpt, 'Entry summary text');
  assert.equal(feed.posts[0].publishedAt.toISOString(), '2026-10-12T08:00:00.000Z');
});

test('resolves a relative post link against the feed URL', () => {
  const xml = `<rss><channel><title>R</title>
    <item><title>Rel</title><link>/posts/relative</link><guid>r1</guid></item>
  </channel></rss>`;
  const feed = parseFeed(xml, 'https://example.com/dir/feed.xml', new Date());
  assert.equal(feed.posts[0].link, 'https://example.com/posts/relative');
});

test('drops javascript: links and falls back to the title as guid', () => {
  const xml = `<rss><channel><title>R</title>
    <item><title>Only a title</title><link>javascript:alert(1)</link></item>
  </channel></rss>`;
  const feed = parseFeed(xml, 'https://example.com/feed.xml', new Date());
  assert.equal(feed.posts[0].link, null);
  assert.equal(feed.posts[0].guid, 'Only a title');
});

test('clamps a future pubDate to the fetch time', () => {
  const fetchedAt = new Date('2026-10-13T10:00:00Z');
  const xml = `<rss><channel><title>R</title>
    <item><title>Time travel</title><guid>tt</guid>
    <pubDate>Wed, 14 Oct 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const feed = parseFeed(xml, 'https://example.com/feed.xml', fetchedAt);
  assert.equal(feed.posts[0].publishedAt.toISOString(), fetchedAt.toISOString());
});

test('refuses to parse HTML (an error page, not a feed)', () => {
  assert.throws(() => parseFeed('<!doctype html><html><head><title>Nope</title></head><body></body></html>',
    'https://example.com/', new Date()), /not an RSS or Atom feed/);
});

test('discoverFeedUrl finds the first alternate RSS/Atom link, resolved', () => {
  const html = `<html><head>
    <link rel="stylesheet" href="/style.css">
    <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
    <link rel="alternate" type="application/atom+xml" href="/atom.xml">
  </head><body></body></html>`;
  assert.equal(discoverFeedUrl(html, 'https://blog.example.com/index.html'),
    'https://blog.example.com/feed.xml');
  assert.equal(discoverFeedUrl('<html><head></head></html>', 'https://example.com/'), null);
});

test('toText strips tags, decodes entities and cuts at a word', () => {
  assert.equal(toText('<p>Hello <b>world</b>&hellip;</p>'), 'Hello world …');
  const long = 'word '.repeat(200);
  const cut = toText(long, 100);
  assert.ok(cut.length <= 101);
  assert.ok(cut.endsWith('…'));
  assert.ok(!/\s$/.test(cut.slice(0, -1)), 'cut lands after a word, not mid-word');
});

test('isPrivateAddress refuses loopback, private, link-local and mapped IPv4', () => {
  for (const bad of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '172.31.255.255',
    '169.254.1.1', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::',
    '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', 'not-an-ip']) {
    assert.equal(isPrivateAddress(bad), true, bad);
  }
  for (const good of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isPrivateAddress(good), false, good);
  }
});