// Unit tests for feeds.js: parsing and the URL guard. No network, no
// database — nothing here fetches anything.
const test = require('node:test');
const assert = require('node:assert');
const { parseFeed, discoverFeedUrl, ipBlocked, schemeAllowed, stripHtml } = require('../feeds');

const NOW = new Date('2026-10-13T12:00:00Z');

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example Blog</title>
  <link>https://example.com/</link>
  <item>
    <title>First &amp; foremost</title>
    <link>https://example.com/one</link>
    <guid>post-1</guid>
    <pubDate>Tue, 13 Oct 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[<p>Hello <b>world</b>.</p><p>Second line.</p>]]></description>
  </item>
  <item>
    <title></title>
    <link>https://example.com/two</link>
    <guid isPermaLink="false">post-2</guid>
    <pubDate>Tue, 13 Oct 2026 11:30:00 GMT</pubDate>
    <description>Plain text summary</description>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>An entry</title>
    <link rel="alternate" href="https://example.org/a"/>
    <id>urn:uuid:aaa</id>
    <updated>2026-10-13T09:00:00Z</updated>
    <summary>Short summary</summary>
    <author><name>Ada Writer</name></author>
  </entry>
</feed>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/">
  <channel rdf:about="https://example.net/"><title>RDF Feed</title><link>https://example.net/</link></channel>
  <item rdf:about="https://example.net/x">
    <title>Old style item</title>
    <link>https://example.net/x</link>
    <description> rdf summary</description>
    <dc:date xmlns:dc="http://purl.org/dc/elements/1.1/">2026-10-12T08:00:00Z</dc:date>
  </item>
</rdf:RDF>`;

test('parseFeed reads RSS 2.0: titles, guids, dates, stripped summaries', () => {
  const { items } = parseFeed(RSS, 'https://example.com/feed', NOW);
  assert.equal(items.length, 2);
  const first = items[0];
  assert.equal(first.title, 'First & foremost');
  assert.equal(first.guid, 'post-1');
  assert.equal(first.link, 'https://example.com/one');
  assert.ok(first.summary.includes('Hello world') && first.summary.includes('Second line.'));
  assert.ok(!/[<>]/.test(first.summary), 'summary has no HTML left');
  assert.equal(new Date(first.published).toISOString(), '2026-10-13T10:00:00.000Z');
  // No title falls back, guid still read.
  assert.equal(items[1].title, 'Untitled post');
  assert.equal(items[1].guid, 'post-2');
});

test('parseFeed reads Atom entries', () => {
  const { items } = parseFeed(ATOM, 'https://example.org/atom', NOW);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'An entry');
  assert.equal(items[0].guid, 'urn:uuid:aaa');
  assert.equal(items[0].link, 'https://example.org/a');
  assert.equal(items[0].author, 'Ada Writer');
  assert.equal(new Date(items[0].published).toISOString(), '2026-10-13T09:00:00.000Z');
});

test('parseFeed reads RDF (RSS 1.0) feeds', () => {
  const { title, items } = parseFeed(RDF, 'https://example.net/rdf', NOW);
  assert.equal(title, 'RDF Feed');
  assert.equal(items[0].title, 'Old style item');
  assert.equal(new Date(items[0].published).toISOString(), '2026-10-12T08:00:00.000Z');
});

test('parseFeed rejects a page with no items and no title', () => {
  assert.throws(() => parseFeed('<html><body>not a feed</body></html>', 'https://x.example/'), /not a feed/i);
});

test('parseFeed clamps a future date to now', () => {
  const future = `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>
    <item><title>From the future</title><guid>g1</guid>
    <pubDate>Wed, 14 Oct 2026 10:00:00 GMT</pubDate><description>x</description></item>
  </channel></rss>`;
  const { items } = parseFeed(future, 'https://f.example/feed', NOW);
  assert.ok(new Date(items[0].published) <= NOW);
});

test('parseFeed keeps only public web links', () => {
  const weird = `<?xml version="1.0"?><rss version="2.0"><channel><title>W</title>
    <item><title>Odd link</title><link>ftp://example.com/file</link><guid>g1</guid><description>x</description></item>
    <item><title>Good link</title><link>http://example.com/ok</link><guid>g2</guid><description>y</description></item>
  </channel></rss>`;
  const { items } = parseFeed(weird, 'https://w.example/feed', NOW);
  assert.equal(items.length, 2);
  assert.equal(items[0].link, null, 'a non-web link is dropped');
  assert.equal(items[1].link, 'http://example.com/ok');
});

test('discoverFeedUrl finds an Atom link in HTML', () => {
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="/style.css">
    <link rel="alternate" type="application/atom+xml" title="Blog" href="/feed.xml">
  </head><body>hello</body></html>`;
  assert.equal(discoverFeedUrl(html, 'https://blog.example/posts/1'), 'https://blog.example/feed.xml');
});

test('discoverFeedUrl returns null when the page links no feed', () => {
  assert.equal(discoverFeedUrl('<html><head></head></html>', 'https://x.example/'), null);
});

test('ipBlocked refuses private and link-local addresses', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.9.9', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '100.64.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.ok(ipBlocked(ip), `${ip} must be blocked`);
  }
  for (const ip of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.ok(!ipBlocked(ip), `${ip} must be allowed`);
  }
});

test('schemeAllowed only lets http(s) through', () => {
  assert.equal(schemeAllowed('ftp://example.com/feed'), null);
  assert.equal(schemeAllowed('file:///etc/passwd'), null);
  assert.equal(schemeAllowed('gopher://example.com'), null);
  assert.ok(schemeAllowed('https://example.com/feed'));
  assert.ok(schemeAllowed('http://example.com/feed'));
});

test('stripHtml reduces markup to plain text', () => {
  assert.equal(stripHtml('<p>One</p><p>Two</p>'), 'One\nTwo');
  assert.equal(stripHtml('a &lt;b&gt; c'), 'a <b> c');
  assert.equal(stripHtml('line<br/>break'), 'line\nbreak');
});