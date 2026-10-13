'use strict';
// Tests for lib/feed-parse.js: RSS, Atom and the guards around them.
// Run with `npm test` (node --test).

const test = require('node:test');
const assert = require('node:assert');
const { parseFeed, findFeedLinks, toText, decodeEntities, NotAFeed } = require('../lib/feed-parse');

const NOW = new Date('2026-10-13T12:00:00Z');

test('parses RSS 2.0 with CDATA and content:encoded', () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel>
      <title>Site News</title><link>https://news.example/</link>
      <item>
        <title><![CDATA[Beans & rain]]></title>
        <link>https://news.example/beans</link>
        <content:encoded><![CDATA[<p>First para.</p><p>Second <b>para</b>.</p>]]></content:encoded>
        <pubDate>Tue, 13 Oct 2026 09:30:00 GMT</pubDate>
        <guid>beans-1</guid>
      </item>
    </channel></rss>`;
  const f = parseFeed(xml, 'https://news.example/feed', { now: NOW });
  assert.equal(f.title, 'Site News');
  assert.equal(f.siteUrl, 'https://news.example/');
  assert.equal(f.items.length, 1);
  const it = f.items[0];
  assert.equal(it.title, 'Beans & rain');
  assert.equal(it.link, 'https://news.example/beans');
  assert.equal(it.summary, 'First para.\n\nSecond para.');
  assert.equal(it.publishedAt.toISOString(), '2026-10-13T09:30:00.000Z');
  assert.equal(it.guid, 'beans-1');
});

test('parses Atom: rel=alternate link, content, author name, id', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom">
    <title type="text">Journal</title>
    <link href="https://journal.example/"/>
    <entry>
      <title>A walk</title>
      <link rel="self" href="https://journal.example/a-walk/self"/>
      <link rel="alternate" type="text/html" href="/a-walk"/>
      <content>&lt;p&gt;Notes from the path.&lt;/p&gt;</content>
      <!-- &lt;p&gt; in a feed means the literal text "<p>", not markup:
           the summary keeps it verbatim, which the preview renders as text. -->
      <published>2026-10-12T08:00:00Z</published>
      <id>tag:journal.example,2026:12</id>
      <author><name>Sam Okafor</name></author>
    </entry>
  </feed>`;
  const f = parseFeed(xml, 'https://journal.example/feed', { now: NOW });
  assert.equal(f.items[0].link, 'https://journal.example/a-walk');
  assert.equal(f.items[0].summary, '<p>Notes from the path.</p>');
  assert.equal(f.items[0].author, 'Sam Okafor');
  assert.equal(f.items[0].guid, 'tag:journal.example,2026:12');
});

test('decodes named and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt;&#39;&#x27;'), "a & b <c>''");
  assert.equal(decodeEntities('wide &#128512;'), 'wide \u{1F600}');
  assert.equal(decodeEntities('narrow&nbsp;space'), 'narrow space');
});

test('a javascript: link is dropped, an http link survives', () => {
  const xml = `<rss><channel><title>t</title>
    <item><title>one</title><link>javascript:alert(1)</link></item>
    <item><title>two</title><link>https://ok.example/x</link></item>
  </channel></rss>`;
  const f = parseFeed(xml, 'https://x.example/feed', { now: NOW });
  assert.equal(f.items[0].link, null);
  assert.equal(f.items[1].link, 'https://ok.example/x');
});

test('a missing date falls back to fetch time; a far-future date too', () => {
  const xml = `<rss><channel><title>t</title>
    <item><title>no date</title></item>
    <item><title>future</title><pubDate>Tue, 13 Oct 2030 09:30:00 GMT</pubDate></item>
  </channel></rss>`;
  const f = parseFeed(xml, 'https://x.example/feed', { now: NOW });
  assert.equal(f.items[0].publishedAt.toISOString(), NOW.toISOString());
  assert.equal(f.items[1].publishedAt.toISOString(), NOW.toISOString());
});

test('guid falls back to a digest of title and date', () => {
  const xml = `<rss><channel><title>t</title>
    <item><title>hashy</title><pubDate>Tue, 13 Oct 2026 09:30:00 GMT</pubDate></item>
  </channel></rss>`;
  const f = parseFeed(xml, 'https://x.example/feed', { now: NOW });
  assert.match(f.items[0].guid, /^[0-9a-f]{40}$/);
});

test('an empty title takes the first 80 characters of the summary', () => {
  const xml = `<rss><channel><title>t</title>
    <item><description>${'word '.repeat(30)}</description></item>
  </channel></rss>`;
  const f = parseFeed(xml, 'https://x.example/feed', { now: NOW });
  assert.equal(f.items[0].title.length, 80);
  assert.ok(f.items[0].title.startsWith('word'));
});

test('toText drops script and style whole, keeps paragraphs, caps length', () => {
  const html = '<p>Hi<script>evil()</script></p><style>.x{}</style><p>One<br>Two</p><p>Three</p>';
  assert.equal(toText(html), 'Hi\n\nOne\nTwo\n\nThree');
  assert.equal(toText('<p>' + 'x'.repeat(100) + '</p>', 10), 'x'.repeat(10));
  assert.equal(toText(null), '');
});

test('findFeedLinks reads advertised alternates and resolves them', () => {
  const html = `<html><head>
    <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
    <link rel="alternate" type="application/atom+xml" href="https://else.example/atom">
    <link rel="stylesheet" href="/style.css">
  </head></html>`;
  const links = findFeedLinks(html, 'https://site.example/blog/');
  assert.deepEqual(links, ['https://site.example/feed.xml', 'https://else.example/atom']);
});

test('a body with no items is not a feed', () => {
  assert.throws(() => parseFeed('<html><body>hi</body></html>', 'https://x.example/'), NotAFeed);
  assert.throws(() => parseFeed('', 'https://x.example/'), NotAFeed);
});

test('an RSS author of "email (Name)" becomes the name', () => {
  const xml = `<rss><channel><title>t</title>
    <item><title>x</title><author>list@example.com (Rowan Field)</author></item>
  </channel></rss>`;
  const f = parseFeed(xml, 'https://x.example/feed', { now: NOW });
  assert.equal(f.items[0].author, 'Rowan Field');
});