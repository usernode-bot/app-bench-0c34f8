// Tests for lib/feeds.js: the URL guard and the tolerant feed parser.
// All tests are offline — safeFetch is only exercised on inputs it rejects
// before any network call.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FeedError, normaliseUrl, isPrivateIp, safeFetch, parseFeed, findFeedLink, toText,
} = require('../lib/feeds');

const FETCHED_AT = new Date('2026-10-13T12:00:00Z');

// ── The URL guard ─────────────────────────────────────────────────────────

test('normaliseUrl keeps a plain https address and drops the fragment', () => {
  const url = normaliseUrl('https://Example.com/Feed.xml#row');
  assert.equal(url.href, 'https://example.com/Feed.xml');
});

test('normaliseUrl refuses anything that is not plain https', () => {
  for (const bad of [
    'http://example.com/feed.xml',
    'ftp://example.com/feed.xml',
    'https://user:pass@example.com/feed.xml',
    'https://example.com:8443/feed.xml',
    'not a url',
    '',
  ]) {
    assert.equal(normaliseUrl(bad), null, bad);
  }
});

test('isPrivateIp refuses loopback, private, link-local and CGNAT ranges', () => {
  for (const bad of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1',
  ]) {
    assert.equal(isPrivateIp(bad), true, bad);
  }
});

test('isPrivateIp allows public addresses', () => {
  for (const good of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::1111']) {
    assert.equal(isPrivateIp(good), false, good);
  }
});

test('safeFetch refuses non-https addresses before touching the network', async () => {
  await assert.rejects(() => safeFetch('http://example.com/feed.xml'), (err) => {
    assert.ok(err instanceof FeedError);
    assert.match(err.message, /https address/);
    return true;
  });
});

test('safeFetch refuses hosts that resolve to private or link-local addresses', async () => {
  await assert.rejects(() => safeFetch('https://localhost/feed.xml'), FeedError);
  await assert.rejects(() => safeFetch('https://169.254.169.254/latest/meta-data/'), FeedError);
  await assert.rejects(() => safeFetch('https://[::1]/feed.xml'), FeedError);
});

// ── toText ────────────────────────────────────────────────────────────────

test('toText drops script and style whole and turns tags into text', () => {
  const out = toText('<p>First para.</p><script>alert(1)</script><style>x{}</style><p>Second &amp; last<br/>line</p>');
  assert.equal(out, 'First para.\n\nSecond & last\n\nline');
});

test('toText decodes named and numeric entities and collapses whitespace', () => {
  const out = toText('A &#8220;quoted&#8221; &lt;tag&gt;  and   a  &#x2014; dash');
  assert.equal(out, 'A “quoted” <tag> and a — dash');
});

test('toText caps long text at a word boundary with an ellipsis', () => {
  const out = toText('word '.repeat(600), 100);
  assert.ok(out.length <= 101, `length ${out.length}`);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.startsWith('word word w…'.slice(0, 12) + 'w'));
});

// ── parseFeed: RSS 2.0 ────────────────────────────────────────────────────

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Example Garden Weekly</title>
<link>https://example.com/garden</link>
<description>A weekly allotment letter</description>
<item>
<title><![CDATA[Tomatoes &amp; the warm spell]]></title>
<link>/garden/tomatoes</link>
<guid>garden-1</guid>
<pubDate>Mon, 12 Oct 2026 08:00:00 GMT</pubDate>
<description><![CDATA[<p>First para.</p><script>alert(1)</script><p>Second para.</p>]]></description>
</item>
<item>
<title>Second post &lt;updated&gt;</title>
<link>https://elsewhere.example.org/post</link>
<pubDate>Tue, 13 Oct 2026 10:00:00 GMT</pubDate>
<author>pat@example.com (Pat Example)</author>
</item>
</channel></rss>`;

test('parseFeed reads RSS 2.0: titles, relative links, CDATA, entities', () => {
  const feed = parseFeed(RSS, 'https://example.com/garden/feed.xml', FETCHED_AT);
  assert.equal(feed.title, 'Example Garden Weekly');
  assert.equal(feed.siteUrl, 'https://example.com/garden');
  assert.equal(feed.items.length, 2);
  const [first, second] = feed.items;
  assert.equal(first.title, 'Tomatoes & the warm spell');
  assert.equal(first.link, 'https://example.com/garden/tomatoes');
  assert.equal(first.guid, 'garden-1');
  assert.equal(first.author, null);
  assert.equal(first.summary, 'First para.\n\nSecond para.');
  assert.equal(first.publishedAt.toISOString(), '2026-10-12T08:00:00.000Z');
  assert.equal(second.title, 'Second post <updated>');
  assert.equal(second.author, 'pat@example.com (Pat Example)');
});

test('parseFeed falls back to the link, then a hash, when an item has no guid', () => {
  const feed = parseFeed(RSS, 'https://example.com/garden/feed.xml', FETCHED_AT);
  const second = feed.items[1];
  assert.equal(second.guid, 'https://elsewhere.example.org/post');
  const noId = parseFeed(
    '<rss version="2.0"><channel><title>T</title><item><title>Only a title</title></item></channel></rss>',
    'https://example.com/feed.xml',
    FETCHED_AT,
  );
  assert.match(noId.items[0].guid, /^hash:[0-9a-f]{40}$/);
});

test('parseFeed keeps a javascript: link out', () => {
  const feed = parseFeed(
    '<rss version="2.0"><channel><title>T</title><item><title>X</title><link>javascript:alert(1)</link></item></channel></rss>',
    'https://example.com/feed.xml',
    FETCHED_AT,
  );
  assert.equal(feed.items[0].link, null);
});

test('parseFeed clamps a future pubDate to the fetch time', () => {
  const feed = parseFeed(
    '<rss version="2.0"><channel><title>T</title><item><title>X</title><pubDate>Mon, 12 Oct 2031 08:00:00 GMT</pubDate></item></channel></rss>',
    'https://example.com/feed.xml',
    FETCHED_AT,
  );
  assert.equal(feed.items[0].publishedAt.toISOString(), FETCHED_AT.toISOString());
});

// ── parseFeed: Atom ───────────────────────────────────────────────────────

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Sample Kitchen</title>
<link href="https://example.com/kitchen"/>
<link rel="self" href="https://example.com/kitchen/feed.atom"/>
<entry>
<title>Overnight bread, with a picture</title>
<link rel="alternate" href="https://example.com/kitchen/bread"/>
<link rel="self" href="https://example.com/kitchen/bread/amp"/>
<id>urn:uuid:5bd1a3e0</id>
<published>2026-10-13T07:30:00Z</published>
<author><name>Jamie Placeholder</name></author>
<summary type="html">&lt;p&gt;Mix it before bed.&lt;/p&gt;&lt;p&gt;Bake it after breakfast.&lt;/p&gt;</summary>
</entry>
</feed>`;

test('parseFeed reads Atom: alternate links, ids, authors, html summaries', () => {
  const feed = parseFeed(ATOM, 'https://example.com/kitchen/feed.atom', FETCHED_AT);
  assert.equal(feed.title, 'Sample Kitchen');
  assert.equal(feed.siteUrl, 'https://example.com/kitchen');
  assert.equal(feed.items.length, 1);
  const item = feed.items[0];
  assert.equal(item.title, 'Overnight bread, with a picture');
  assert.equal(item.link, 'https://example.com/kitchen/bread');
  assert.equal(item.guid, 'urn:uuid:5bd1a3e0');
  assert.equal(item.author, 'Jamie Placeholder');
  assert.equal(item.summary, 'Mix it before bed.\n\nBake it after breakfast.');
  assert.equal(item.publishedAt.toISOString(), '2026-10-13T07:30:00.000Z');
});

// ── parseFeed: RSS 1.0 ────────────────────────────────────────────────────

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns="http://purl.org/rss/1.0/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel rdf:about="https://example.com/transit">
<title>Pretend Transit Blog</title>
<link>https://example.com/transit</link>
<description>Buses, mostly</description>
</channel>
<item rdf:about="https://example.com/transit/night-bus">
<title>The night bus, explained</title>
<link>https://example.com/transit/night-bus</link>
<dc:date>2026-10-11T02:00:00Z</dc:date>
<dc:creator>Alex Sample</dc:creator>
<content:encoded><![CDATA[<p>Once every four years.</p>]]></content:encoded>
</item>
</rdf:RDF>`;

test('parseFeed reads RSS 1.0: dc:date, dc:creator, content:encoded', () => {
  const feed = parseFeed(RDF, 'https://example.com/transit/feed.rdf', FETCHED_AT);
  assert.equal(feed.title, 'Pretend Transit Blog');
  assert.equal(feed.items.length, 1);
  const item = feed.items[0];
  assert.equal(item.author, 'Alex Sample');
  assert.equal(item.publishedAt.toISOString(), '2026-10-11T02:00:00.000Z');
  assert.equal(item.summary, 'Once every four years.');
});

// ── Not a feed ────────────────────────────────────────────────────────────

test('parseFeed throws "No feed was found at that address" for other markup', () => {
  assert.throws(() => parseFeed('<html><body><p>Just a page</p></body></html>', 'https://example.com/', FETCHED_AT), (err) => {
    assert.ok(err instanceof FeedError);
    assert.equal(err.message, 'No feed was found at that address');
    return true;
  });
});

// ── findFeedLink ──────────────────────────────────────────────────────────

test('findFeedLink picks the https alternate feed link on a web page', () => {
  const html = `<link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
    <link rel="stylesheet" href="/style.css">`;
  assert.equal(findFeedLink(html, 'https://example.com/blog'), 'https://example.com/feed.xml');
});

test('findFeedLink ignores non-feed and non-https alternates', () => {
  const html = `<link rel="alternate" type="application/rss+xml" href="http://insecure.example/feed.xml">
    <link rel="alternate" type="text/html" href="https://example.com/amp">`;
  assert.equal(findFeedLink(html, 'https://example.com/'), null);
});