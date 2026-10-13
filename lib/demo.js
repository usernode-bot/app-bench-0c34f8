'use strict';

// The staging demo (?demo=1 on staging only): six made-up feeds and 14
// unread posts, written once per viewing account. Every title and preview
// is obviously invented; nothing here is fetched from the network.

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const DEMO_FEEDS = [
  {
    title: 'Example Tech Weekly',
    site_url: 'https://example.com/tech-weekly',
    error: null,
    posts: [
      { offset: 12 * MINUTE, title: 'A pretend phone that folds into a perfect square', excerpt: 'Our imaginary reviewer spent a week with a phone that folds twice, ending up the size of a coaster. It fits in any pocket and none of it is real: this is sample text for the staging preview, written to show how a post’s opening paragraphs read here before you open the whole thing.' },
      { offset: 5 * HOUR, title: 'Why our fictional laptop has exactly one port', excerpt: 'The made-up laptop in this demo has a single plug, and our invented engineer defends it with three arguments that only work on paper. A good example of how a longer preview is cut here at a word, so the list stays easy to scan.' },
      { offset: 2 * 24 * HOUR + 4 * HOUR, title: 'Reviewing a keyboard that only exists in this demo', excerpt: 'This keyboard was never made, yet it typed every word of this made-up review. The switches are labelled sample, the keycaps are placeholder, and the verdict is: fine for pretend typing, unbeatable for staging screenshots.' },
    ],
  },
  {
    title: 'Sample Garden Notes',
    site_url: 'https://example.com/garden-notes',
    error: null,
    posts: [
      { offset: 48 * MINUTE, title: 'Seven made-up tomatoes to try on a windy balcony', excerpt: 'Every tomato in this list was invented for the staging demo, from the tiny Placeholder Cherry to the large Mock Beefsteak. None of them will grow anywhere, which makes them the easiest crop you will ever plan around on paper.' },
      { offset: 29 * HOUR, title: 'Composting for people who forget about compost', excerpt: 'A gentle invented system for sample gardeners: one bucket, one sticker that says TURN ME, and no guilt. This preview text stands in for the article’s opening paragraphs, the way a real feed’s summary would.' },
    ],
  },
  {
    title: 'Demo Kitchen Journal',
    site_url: 'https://example.com/kitchen-journal',
    error: null,
    posts: [
      { offset: 2 * HOUR, title: 'The test-kitchen lentil soup, version four', excerpt: 'The fictional test kitchen has cooked this soup four times this week and changed one thing each round. The recipe below is invented from top to bottom, which is why the measurements read like they were written by a demo builder.' },
      { offset: 33 * HOUR, title: 'Five breakfasts you can make with one sample pan', excerpt: 'Five imaginary breakfasts, one pretend pan, zero dirty dishes that matter. This made-up post shows how a feed’s longer entries look here, cut to about six hundred characters so the preview stays a preview.' },
      { offset: 4 * 24 * HOUR + 6 * HOUR, title: 'A slow Sunday bread from a starter called Placeholder', excerpt: 'The starter in this story was fed once, in theory, and has risen steadily ever since. A quiet made-up read for a sample Sunday morning, complete with timings that no clock has ever actually measured.' },
    ],
  },
  {
    title: 'Harbor Town Gazette (fake)',
    site_url: 'https://example.com/harbor-gazette',
    error: null,
    posts: [
      { offset: 65 * MINUTE, title: 'Imaginary ferry adds a second Tuesday crossing', excerpt: 'The fictional harbour master announced the extra crossing at a press event that never happened. Ticket prices in the article are sample numbers, and the mayor quoted in paragraph three is entirely made up for this staging demo.' },
      { offset: 31 * HOUR, title: 'Library extends hours for the pretend reading festival', excerpt: 'For one invented weekend the sample library will stay open late, with readings from books that do not exist. Organisers expect crowds of placeholder visitors, all of them welcome and none of them real.' },
    ],
  },
  {
    title: 'Mock Cycling Digest',
    site_url: 'https://example.com/cycling-digest',
    error: 'the site did not answer',
    posts: [
      { offset: 26 * HOUR, title: 'A route around three invented hills, ranked by snack stops', excerpt: 'This made-up route climbs three sample hills in order of how good the imaginary café at the top is. Total distance is a round pretend number, and the elevation profile is drawn from thin air, as every good staging demo should be.' },
      { offset: 3 * 24 * HOUR + 3 * HOUR, title: 'Fixing a flat on a bicycle made of example parts', excerpt: 'Our fictional mechanic demonstrates the repair on a bike assembled entirely from sample components. The puncture is theoretical, the patch is placeholder, and the wheel spins smoothly on the strength of invented confidence alone.' },
    ],
  },
  {
    title: 'Practice Birdwatch Log',
    site_url: 'https://example.com/birdwatch-log',
    error: null,
    posts: [
      { offset: 3 * HOUR, title: 'Placeholder herons spotted on the sample lake again this week', excerpt: 'The weekly count logged four pretend herons, two made-up moorhens and one very patient sample kingfisher. Every sighting in this demo stands in for a real entry, so the list has something honest-looking to show while it is staged.' },
      { offset: 2 * 24 * HOUR + 9 * HOUR, title: 'How to count sparrows that keep moving', excerpt: 'A short invented guide to tallying birds that refuse to sit still, written for the staging preview. The method is sample, the sparrow counts are placeholders, and the only real thing here is the advice to bring patience.' },
    ],
  },
];

/** Whether this is the first demo request for this account (writes the marker row). */
async function claimDemoViewer(pool, userId) {
  const first = await pool.query(
    'INSERT INTO rss_demo_viewers (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING user_id',
    [userId],
  );
  return first.rowCount > 0;
}

/** Seed the six demo feeds and their 14 unread posts, once per account. */
async function seedDemoFor(pool, userId, now) {
  if (!(await claimDemoViewer(pool, userId))) return;
  // A Date object goes to timestamptz columns; a bare ms number does not.
  const base = new Date(now);
  const baseMs = base.getTime();
  for (let i = 0; i < DEMO_FEEDS.length; i += 1) {
    const feed = DEMO_FEEDS[i];
    const url = `https://example.com/staging-demo/${feed.site_url.split('/').pop()}.xml`;
    const inserted = await pool.query(
      `INSERT INTO rss_feeds (user_id, url, title, site_url, color, demo, last_checked_at, last_error)
       VALUES ($1, $2, $3, $4, $5, true, $6, $7)
       ON CONFLICT (user_id, url) DO NOTHING
       RETURNING id`,
      [userId, url, feed.title, feed.site_url, i + 1, base, feed.error],
    );
    if (!inserted.rowCount) continue; // already there
    const feedId = inserted.rows[0].id;
    let n = 0;
    for (const post of feed.posts) {
      n += 1;
      const publishedAt = new Date(baseMs - post.offset);
      await pool.query(
        `INSERT INTO rss_posts (feed_id, user_id, guid, title, link, excerpt, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (feed_id, guid) DO NOTHING`,
        [feedId, userId, `${feed.site_url}#${n}`, post.title, `${feed.site_url}/posts/${n}`, post.excerpt, publishedAt],
      );
    }
  }
}

module.exports = { seedDemoFor, DEMO_FEEDS };