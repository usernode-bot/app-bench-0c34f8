'use strict';

// Unit tests for the hand-rolled feed parser. Run with `npm test`
// (node --test test/).

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeed, toPlainText } = require('../lib/feed-parser');

const FETCHED = new Date('2026-10-07T12:00:00Z');

test('parses RSS 2.0 with CDATA and content:encoded', () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Garden notes</title>
      <link>https://garden.example.com</link>
      <item>
        <title><![CDATA[Planting garlic &amp; onions]]></title>
        <link>https://garden.example.com/posts/garlic</link>
        <pubDate>Tue, 06 Oct 2026 09:30:00 GMT</pubDate>
        <content:encoded><![CDATA[<p>First paragraph.</p><p>Second <b>paragraph</b>.</p>]]></content:encoded>
      </item>
    </channel></rss>`;
  const feed = parseFeed(xml, { fallbackDate: FETCHED });
  assert.equal(feed.title, 'Garden notes');
  assert.equal(feed.siteUrl, 'https://garden.example.com');
  assert.equal(feed.items.length, 1);
  const item = feed.items[0];
  assert.equal(item.title, 'Planting garlic & onions');
  assert.equal(item.link, 'https://garden.example.com/posts/garlic');
  assert.equal(item.summary, 'First paragraph.\n\nSecond paragraph.');
  assert.equal(item.publishedAt.toISOString(), '2026-10-06T09:30:00.000Z');
  assert.ok(item.guid);
});

test('parses Atom with link href and id', () => {
  const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>City library</title>
      <link rel="self" href="https://library.example.com/feed"/>
      <link rel="alternate" href="https://library.example.com"/>
      <entry>
        <id>urn:uuid:1234-5678</id>
        <title>New reading room hours</title>
        <link rel="alternate" href="https://library.example.com/hours"/>
        <published>2026-10-05T14:30:00Z</published>
        <content>Room opens at eight.</content>
      </entry>
    </feed>`;
  const feed = parseFeed(xml, { fallbackDate: FETCHED });
  assert.equal(feed.title, 'City library');
  assert.equal(feed.siteUrl, 'https://library.example.com');
  const item = feed.items[0];
  assert.equal(item.guid, 'urn:uuid:1234-5678');
  assert.equal(item.link, 'https://library.example.com/hours');
  assert.equal(item.summary, 'Room opens at eight.');
  assert.equal(item.publishedAt.toISOString(), '2026-10-05T14:30:00.000Z');
});

test('decodes entities and turns block tags into paragraphs', () => {
  const html = '<h1>Heading</h1><p>A &amp; B &lt;tag&gt; caf&#233;</p>' +
    '<script>alert("nope")</script><div>Next<br/>line</div>';
  assert.equal(
    toPlainText(html),
    'Heading\n\nA & B <tag> café\n\nNext\n\nline');
});

test('guid falls back to the link, then to title and date', () => {
  const withLink = `<rss version="2.0"><channel><title>T</title>
    <item><title>One</title><link>https://t.example/one</link><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const a = parseFeed(withLink, { fallbackDate: FETCHED }).items[0];
  assert.equal(a.guid, 'https://t.example/one');

  const withNeither = `<rss version="2.0"><channel><title>T</title>
    <item><title>Two</title></item>
  </channel></rss>`;
  const b = parseFeed(withNeither, { fallbackDate: FETCHED }).items[0];
  assert.equal(b.guid, 'Two ' + FETCHED.toISOString());
});

test('an invalid date falls back to fetch time', () => {
  const xml = `<rss version="2.0"><channel><title>T</title>
    <item><title>One</title><pubDate>not a date at all</pubDate></item>
  </channel></rss>`;
  const item = parseFeed(xml, { fallbackDate: FETCHED }).items[0];
  assert.equal(item.publishedAt.toISOString(), FETCHED.toISOString());
});

test('a future date clamps to fetch time', () => {
  const xml = `<rss version="2.0"><channel><title>T</title>
    <item><title>One</title><pubDate>Sat, 01 Jan 2079 00:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const item = parseFeed(xml, { fallbackDate: FETCHED }).items[0];
  assert.equal(item.publishedAt.toISOString(), FETCHED.toISOString());
});

test('an HTML page is rejected as not_a_feed', () => {
  const html = `<!doctype html><html><head><title>Not a feed</title></head>
    <body><p>Hello</p></body></html>`;
  assert.throws(() => parseFeed(html, { fallbackDate: FETCHED }),
    (err) => err.code === 'not_a_feed');
});

test('an empty body is rejected as not_a_feed', () => {
  assert.throws(() => parseFeed('   ', { fallbackDate: FETCHED }),
    (err) => err.code === 'not_a_feed');
});

test('summaries are capped at 20 000 characters', () => {
  assert.equal(toPlainText('x'.repeat(30_000)).length, 20_000);
});

test('RSS guid is preferred over the link', () => {
  const xml = `<rss version="2.0"><channel><title>T</title>
    <item><title>One</title><guid>post-42</guid><link>https://t.example/one</link></item>
  </channel></rss>`;
  const item = parseFeed(xml, { fallbackDate: FETCHED }).items[0];
  assert.equal(item.guid, 'post-42');
});