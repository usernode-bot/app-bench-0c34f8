'use strict';

/* Unit tests for lib/feeds.js: parsing the three feed formats, date and
 * link handling, htmlToText, HTML feed discovery, and the private-address
 * screen. Fixtures are inline; nothing here touches the network. */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decodeEntities,
  findFeedLinkInHtml,
  htmlToText,
  isPrivateAddress,
  parseFeed,
} = require('../lib/feeds');

const NOW = new Date('2026-10-07T12:00:00Z');

/* ── RSS 2.0 ──────────────────────────────────────────────────────────── */

const RSS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Staging demo: Test Blog</title>
    <link>https://example.com/</link>
    <description>testing</description>
    <item>
      <title>First &amp; foremost</title>
      <link>https://example.com/posts/first</link>
      <guid>first-1</guid>
      <pubDate>Wed, 07 Oct 2026 09:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<p>Full <b>content</b> wins.</p><script>alert(1)</script>]]></content:encoded>
      <description><![CDATA[<p>Short description.</p>]]></description>
      <dc:creator>Asha Rao</dc:creator>
    </item>
    <item>
      <title>Second post</title>
      <link>https://example.com/posts/second</link>
      <pubDate>Wed, 07 Oct 2026 08:00:00 GMT</pubDate>
      <description>Just a description this time.</description>
    </item>
    <item>
      <title>Solo</title>
    </item>
  </channel>
</rss>`;

test('parses an RSS 2.0 feed with multiple items', () => {
  const parsed = parseFeed(RSS_XML, { now: NOW });
  assert.ok(parsed, 'a well-formed RSS document parses');
  assert.equal(parsed.title, 'Staging demo: Test Blog');
  assert.equal(parsed.items.length, 3);
});

test('prefers content:encoded over description and reduces it to text', () => {
  const parsed = parseFeed(RSS_XML, { now: NOW });
  const first = parsed.items[0];
  assert.equal(first.title, 'First & foremost');
  assert.match(first.summary, /Full content wins\./);
  assert.doesNotMatch(first.summary, /alert|<|>/);
  assert.equal(first.author, 'Asha Rao');
  assert.equal(first.guid, 'first-1');
  assert.equal(first.link, 'https://example.com/posts/first');
});

test('a single item still arrives as one item', () => {
  const single = `<?xml version="1.0"?><rss version="2.0"><channel><title>Solo feed</title>
    <item><title>Only post</title><link>https://example.com/only</link><guid>only-1</guid>
    <pubDate>Wed, 07 Oct 2026 07:00:00 GMT</pubDate></item></channel></rss>`;
  const parsed = parseFeed(single, { now: NOW });
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, 'Only post');
});

test('a missing guid falls back to the link', () => {
  const parsed = parseFeed(RSS_XML, { now: NOW });
  const second = parsed.items[1];
  assert.equal(second.guid, 'https://example.com/posts/second');
});

test('an item with no description gets empty summary text', () => {
  const parsed = parseFeed(RSS_XML, { now: NOW });
  assert.equal(parsed.items[2].summary, '');
});

/* ── Atom ─────────────────────────────────────────────────────────────── */

const ATOM_XML = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom demo</title>
  <entry>
    <title>Entry one</title>
    <link rel="alternate" href="https://example.org/one"/>
    <link rel="self" href="https://example.org/feed/one"/>
    <id>urn:uuid:aaa</id>
    <published>2026-10-06T10:00:00Z</published>
    <content type="html">&lt;p&gt;Entry body&lt;/p&gt;</content>
    <author><name>Jun Park</name></author>
  </entry>
  <entry>
    <title>Entry two</title>
    <link href="https://example.org/two"/>
    <id>urn:uuid:bbb</id>
    <updated>2026-10-05T10:00:00Z</updated>
    <summary>Fallback summary</summary>
  </entry>
</feed>`;

test('parses an Atom feed: alternate link, id as guid, author name', () => {
  const parsed = parseFeed(ATOM_XML, { now: NOW });
  assert.ok(parsed, 'a well-formed Atom document parses');
  assert.equal(parsed.title, 'Atom demo');
  assert.equal(parsed.items.length, 2);
  const one = parsed.items[0];
  assert.equal(one.link, 'https://example.org/one');
  assert.equal(one.guid, 'urn:uuid:aaa');
  assert.equal(one.author, 'Jun Park');
  assert.match(one.summary, /Entry body/);
});

test('Atom falls back to the first link href and updated date', () => {
  const parsed = parseFeed(ATOM_XML, { now: NOW });
  const two = parsed.items[1];
  assert.equal(two.link, 'https://example.org/two');
  assert.equal(new Date(two.published).toISOString(), '2026-10-05T10:00:00.000Z');
  assert.equal(two.summary, 'Fallback summary');
  assert.equal(two.author, null);
});

/* ── RSS 1.0 (RDF) ────────────────────────────────────────────────────── */

test('parses an RSS 1.0 (RDF) feed', () => {
  const rdf = `<?xml version="1.0"?>
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
           xmlns="http://purl.org/rss/1.0/"
           xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel rdf:about="https://example.net/"><title>RDF demo</title></channel>
    <item rdf:about="https://example.net/a">
      <title>RDF item</title>
      <link>https://example.net/a</link>
      <dc:description>An RDF body.</dc:description>
      <dc:creator>Mari Lind</dc:creator>
      <dc:date>2026-10-04T08:30:00Z</dc:date>
    </item>
  </rdf:RDF>`;
  const parsed = parseFeed(rdf, { now: NOW });
  assert.ok(parsed, 'a well-formed RDF document parses');
  assert.equal(parsed.title, 'RDF demo');
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, 'RDF item');
  assert.equal(parsed.items[0].author, 'Mari Lind');
  assert.equal(parsed.items[0].guid, 'https://example.net/a');
  assert.match(parsed.items[0].summary, /An RDF body\./);
});

/* ── dates, links, titles, guids ──────────────────────────────────────── */

test('future and unparseable dates fall back to the fetch time', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
    <item><title>Future</title><guid>f1</guid><pubDate>Wed, 07 Oct 2036 09:00:00 GMT</pubDate></item>
    <item><title>Broken</title><guid>f2</guid><pubDate>not a date</pubDate></item>
    <item><title>Missing</title><guid>f3</guid></item>
  </channel></rss>`;
  const parsed = parseFeed(xml, { now: NOW });
  for (const item of parsed.items) {
    assert.equal(item.published.getTime(), NOW.getTime());
  }
});

test('links that are not http(s) are dropped', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
    <item><title>FTP</title><link>ftp://files.example.com/doc</link><guid>l1</guid></item>
    <item><title>Javascript</title><link>javascript:alert(1)</link><guid>l2</guid></item>
    <item><title>Https ok</title><link>https://example.com/ok</link><guid>l3</guid></item>
  </channel></rss>`;
  const parsed = parseFeed(xml, { now: NOW });
  assert.equal(parsed.items[0].link, null);
  assert.equal(parsed.items[1].link, null);
  assert.equal(parsed.items[2].link, 'https://example.com/ok');
});

test('an empty title becomes Untitled post', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
    <item><title></title><guid>e1</guid></item>
  </channel></rss>`;
  const parsed = parseFeed(xml, { now: NOW });
  assert.equal(parsed.items[0].title, 'Untitled post');
});

test('duplicate guids within one fetch: first wins', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
    <item><title>First</title><guid>dup</guid></item>
    <item><title>Second</title><guid>dup</guid></item>
  </channel></rss>`;
  const parsed = parseFeed(xml, { now: NOW });
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, 'First');
});

test('a non-feed document parses to null', () => {
  assert.equal(parseFeed('<html><body>hello</body></html>', { now: NOW }), null);
  assert.equal(parseFeed('', { now: NOW }), null);
  assert.equal(parseFeed(null, { now: NOW }), null);
});

/* ── htmlToText ───────────────────────────────────────────────────────── */

test('htmlToText strips scripts and tags, keeps paragraph breaks, decodes entities', () => {
  const { text } = htmlToText(
    '<p>One &amp; two</p><script>evil()</script><style>.x{}</style><p>Three<br>lines</p><iframe src="x"></iframe>'
  );
  assert.equal(text, 'One & two\n\nThree\nlines');
});

test('htmlToText truncates on a word boundary and sets the flag', () => {
  const long = '<p>' + 'word '.repeat(3000) + 'tailword</p>';
  const result = htmlToText(long);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 8000);
  assert.ok(result.text.endsWith('tailword') === false || result.text.length < long.length);
  assert.ok(!/\s$/.test(result.text), 'no trailing space left by the cut');
});

test('htmlToText leaves short text untruncated', () => {
  const result = htmlToText('<p>Short.</p>');
  assert.equal(result.text, 'Short.');
  assert.equal(result.truncated, false);
});

test('decodeEntities handles named and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b &#8217; c &#x27; d &nbsp;e'), "a & b ’ c ' d  e");
});

/* ── HTML feed discovery ──────────────────────────────────────────────── */

test('findFeedLinkInHtml finds the alternate link and resolves it relatively', () => {
  const html = `<!doctype html><html><head>
    <link rel="stylesheet" href="/style.css">
    <link rel="alternate" type="application/rss+xml" title="RSS" href="/feed.xml">
    </head><body></body></html>`;
  assert.equal(findFeedLinkInHtml(html, 'https://blog.example.com/posts/'), 'https://blog.example.com/feed.xml');
});

test('findFeedLinkInHtml prefers a relative address and resolves against the page', () => {
  const html = '<link rel="alternate" type="application/atom+xml" href="atom.xml">';
  assert.equal(findFeedLinkInHtml(html, 'https://blog.example.com/'), 'https://blog.example.com/atom.xml');
});

test('findFeedLinkInHtml returns null without a feed link', () => {
  assert.equal(findFeedLinkInHtml('<link rel="icon" href="/f.ico">', 'https://x.example.com/'), null);
});

/* ── isPrivateAddress ─────────────────────────────────────────────────── */

test('isPrivateAddress refuses loopback, private, link-local and mapped addresses', () => {
  for (const refused of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.1.20', '172.16.0.9', '100.64.0.1', '0.0.0.0', '224.0.0.5', '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:192.168.1.1']) {
    assert.equal(isPrivateAddress(refused), true, 'refuses ' + refused);
  }
});

test('isPrivateAddress accepts a public address', () => {
  for (const allowed of ['93.184.216.34', '8.8.8.8', '2606:4700::6810:85e5']) {
    assert.equal(isPrivateAddress(allowed), false, 'accepts ' + allowed);
  }
});
