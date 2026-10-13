// Tests for feeds.js: what a parsed feed becomes (RSS 2.0 and Atom), feed
// discovery on a site page, the HTML-to-text rules, and the guard that only
// lets the server fetch public web addresses. The URL guard's DNS lookup is
// injected, so nothing here touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FeedError,
  assertPublicUrl,
  discoverFeedUrl,
  parseFeedBody,
  toPlainText,
} = require('../feeds');

const NOW = new Date('2026-10-13T12:00:00Z');

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Byte Garden</title>
  <link>https://bytegarden.example/</link>
  <description>Notes on small software.</description>
  <item>
    <title>The newer post</title>
    <link>https://bytegarden.example/newer</link>
    <guid>bg-2</guid>
    <pubDate>Mon, 12 Oct 2026 09:30:00 GMT</pubDate>
    <dc:creator>Priya Raman</dc:creator>
    <content:encoded><![CDATA[<p>First paragraph.</p><p>Second paragraph.</p>]]></content:encoded>
  </item>
  <item>
    <title>The older post</title>
    <link>https://bytegarden.example/older</link>
    <guid>bg-1</guid>
    <pubDate>Sun, 11 Oct 2026 08:00:00 GMT</pubDate>
  </item>
</channel>
</rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Trailhead Notes</title>
  <link href="https://trailheadnotes.example/"/>
  <entry>
    <title>A ridge walk</title>
    <id>tag:trailheadnotes.example,2026:ridge</id>
    <link href="https://trailheadnotes.example/ridge"/>
    <updated>2026-10-12T07:15:00Z</updated>
    <content type="html">&lt;p&gt;Pack light.&lt;/p&gt;</content>
  </entry>
</feed>`;

test('an RSS 2.0 feed normalises to post rows, newest first', async () => {
  const feed = await parseFeedBody(RSS, { url: 'https://bytegarden.example/feed.xml', now: NOW });
  assert.equal(feed.title, 'Byte Garden');
  assert.equal(feed.siteUrl, 'https://bytegarden.example/');
  assert.equal(feed.items.length, 2);
  assert.equal(feed.items[0].guid, 'bg-2');
  assert.equal(feed.items[0].title, 'The newer post');
  assert.equal(feed.items[0].link, 'https://bytegarden.example/newer');
  assert.equal(feed.items[0].author, 'Priya Raman');
  assert.equal(feed.items[0].publishedAt, '2026-10-12T09:30:00.000Z');
  assert.equal(feed.items[0].summary, 'First paragraph.\n\nSecond paragraph.');
  assert.equal(feed.items[1].guid, 'bg-1');
  assert.ok(feed.items[0].publishedAt > feed.items[1].publishedAt);
});

test('an Atom feed normalises to post rows', async () => {
  const feed = await parseFeedBody(ATOM, { url: 'https://trailheadnotes.example/feed.xml', now: NOW });
  assert.equal(feed.title, 'Trailhead Notes');
  assert.equal(feed.siteUrl, 'https://trailheadnotes.example/');
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].guid, 'tag:trailheadnotes.example,2026:ridge');
  assert.equal(feed.items[0].title, 'A ridge walk');
  assert.equal(feed.items[0].link, 'https://trailheadnotes.example/ridge');
  assert.equal(feed.items[0].publishedAt, '2026-10-12T07:15:00.000Z');
  assert.equal(feed.items[0].summary, 'Pack light.');
});

test('a body that is not a feed is refused with the shown message', async () => {
  await assert.rejects(
    () => parseFeedBody('this is not xml at all', { url: 'https://bytegarden.example/feed.xml', now: NOW }),
    (err) => err instanceof FeedError && err.message === 'No RSS or Atom feed was found at that address',
  );
});

test('feed discovery finds the feed link on a site page', () => {
  const html = `<html><head>
    <link rel="stylesheet" href="/style.css">
    <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
    <link rel="alternate" type="application/atom+xml" href="https://elsewhere.example/atom">
  </head><body>hello</body></html>`;
  assert.equal(discoverFeedUrl(html, 'https://bytegarden.example/blog/'), 'https://bytegarden.example/feed.xml');
  assert.equal(discoverFeedUrl('<html><head><title>nothing</title></head></html>', 'https://bytegarden.example/'), null);
});

test('toPlainText drops scripts and keeps paragraphs', () => {
  const html = '<p>Keep this.</p><script>alert("drop")</script><style>.a{}</style><p>And this.</p>';
  assert.equal(toPlainText(html), 'Keep this.\n\nAnd this.');
  assert.equal(toPlainText('<p>One line<br>with a break</p>'), 'One line with a break');
  assert.equal(toPlainText(''), '');
});

const lookupPublic = async () => [{ address: '93.184.216.34', family: 4 }];
// Stands in for DNS, answering an IP literal with itself the way the real
// resolver does, so each address the test names is what the guard must judge.
const lookupSelf = async (host) => [{ address: host.replace(/^\[|\]$/g, ''), family: host.includes(':') ? 6 : 4 }];

test('the URL guard refuses private and loopback addresses', async () => {
  const refusing = async () => [{ address: '127.0.0.1', family: 4 }];
  for (const [url, lookup] of [
    ['http://127.0.0.1/feed.xml', lookupSelf],
    ['http://10.0.0.5/feed.xml', lookupSelf],
    ['http://[::1]/feed.xml', lookupSelf],
    ['http://192.168.1.20/feed.xml', lookupSelf],
    ['file:///etc/passwd', lookupPublic],
    ['https://public.example/feed.xml', refusing],
  ]) {
    await assert.rejects(() => assertPublicUrl(url, { lookup }), FeedError);
  }
});

test('the URL guard accepts a public web address and refuses non-web schemes', async () => {
  const url = await assertPublicUrl('https://public.example/feed.xml', { lookup: lookupPublic });
  assert.equal(url.hostname, 'public.example');
  await assert.rejects(() => assertPublicUrl('ftp://public.example/feed.xml', { lookup: lookupPublic }), FeedError);
  await assert.rejects(
    () => assertPublicUrl('https://user:pass@public.example/feed.xml', { lookup: lookupPublic }),
    (err) => err.message === 'That address is not public',
  );
});