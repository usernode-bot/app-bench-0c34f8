'use strict';
// Tests for lib/feed-fetch.js: the URL forms accepted and the addresses
// refused. Run with `npm test` (node --test).

const test = require('node:test');
const assert = require('node:assert');
const { normalizeUrl, isBlockedAddress, shortReason, FeedError } = require('../lib/feed-fetch');

test('normalizeUrl adds https to a bare address and keeps http(s)', () => {
  assert.equal(normalizeUrl('example.com/feed').href, 'https://example.com/feed');
  assert.equal(normalizeUrl('http://example.com/feed').href, 'http://example.com/feed');
  assert.equal(normalizeUrl('  HTTPS://Example.COM/Feed ').href, 'https://example.com/Feed');
});

test('normalizeUrl drops the fragment and refuses bad forms', () => {
  assert.equal(normalizeUrl('https://example.com/feed#x').href, 'https://example.com/feed');
  assert.throws(() => normalizeUrl('ftp://example.com/feed'), FeedError);
  assert.throws(() => normalizeUrl('javascript:alert(1)'), FeedError);
  assert.throws(() => normalizeUrl('not a url'), FeedError);
  assert.throws(() => normalizeUrl(''), FeedError);
});

test('loopback, private, link-local and reserved IPv4 is blocked', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '172.31.255.255',
    '169.254.169.254', '100.64.0.1', '0.1.2.3', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test('public IPv4 and IPv6 is allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700::6810:85e3', '2a00:1450:4001:81b::200e']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('IPv6 loopback, link-local, unique-local and mapped IPv4 is blocked', () => {
  for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', '::ffff:10.0.0.1', '0:0:0:0:0:0:127.0.0.1']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test('an address we cannot parse is not one we trust', () => {
  assert.equal(isBlockedAddress('not-an-ip'), true);
  assert.equal(isBlockedAddress('1:2:3:4:5:6:7:8:9'), true);
});

test('shortReason keeps a plain phrase for the known failures', () => {
  assert.equal(shortReason(new FeedError('No feed found at that address. Try the site\'s feed link, often ending in /feed or /rss.')), 'it is not a feed any more');
  assert.equal(shortReason(Object.assign(new Error('x'), { status: 404 })), 'error 404');
  assert.equal(shortReason(new Error('That address cannot be reached from here.')), 'this app may not fetch it');
  assert.equal(shortReason(new Error('something odd')), 'the site did not answer');
});