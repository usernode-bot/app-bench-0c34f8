// Staging demo data for ?demo=1: five made-up feeds and sixteen posts, the
// same shape the drawn screens showed — Byte Garden, Trailhead Notes, The
// Slow Kitchen, Orbit Weekly and the Lantern Street Journal, spread over the
// last week. Written for the viewing account once, fixed guids, so an
// ON CONFLICT DO NOTHING insert is idempotent.

const FEEDS = [
  {
    url: 'https://bytegarden.example/feed.xml',
    title: 'Byte Garden',
    siteUrl: 'https://bytegarden.example',
    color: 1,
    slug: 'bytegarden',
    posts: [
      {
        guid: 'demo-1',
        slug: 'a-small-boring-database',
        title: 'A small, boring database is still the right first choice',
        author: 'Mira Okafor',
        minutesAgo: 18,
        summary: 'Most new projects never outgrow one well-indexed table. We kept everything in a single Postgres database for three years, through two redesigns and a tenfold jump in readers.\n\nWhen we finally split it, the reason was not speed. It was that two teams kept stepping on each other\'s migrations. Here is the checklist we used to decide, and what we would do differently.',
      },
      {
        guid: 'demo-6',
        slug: 'writing-error-messages',
        title: 'Writing error messages people actually read',
        author: 'Mira Okafor',
        minutesAgo: 420,
        summary: 'Say what failed, say what still works, offer the next step. Three rules, and the before and after from our own app.\n\nThe hardest rule is the second one. "Your upload failed" is true and useless, because the reader cannot tell whether their work is gone. "Your upload failed, but your draft is saved" changes what the next minute feels like.',
      },
      {
        guid: 'demo-11',
        slug: 'keyboard-shortcuts',
        title: 'Keyboard shortcuts are a feature, not a power-user extra',
        author: 'Priya Raman',
        minutesAgo: 4320,
        summary: 'Every action that has a button deserves a key. Notes from adding forty shortcuts without breaking anything.\n\nWe started with the ten actions the support tickets mentioned most. A week later people who had never called themselves power users were writing in to ask for more.',
      },
    ],
  },
  {
    url: 'https://trailheadnotes.example/feed.xml',
    title: 'Trailhead Notes',
    siteUrl: 'https://trailheadnotes.example',
    color: 2,
    slug: 'trailheadnotes',
    posts: [
      {
        guid: 'demo-2',
        slug: 'packing-light-ridge-walk',
        title: 'Packing light for a three-day ridge walk in early autumn',
        author: 'Tom Ellery',
        minutesAgo: 60,
        summary: 'The list got shorter every year. This is what survived, what we stopped carrying, and the one thing we always forget.\n\nThe one thing, every time, is the map case. The map is in the pack, the case is on the table by the door, and the first hour of day one is spent wishing they had met.',
      },
      {
        guid: 'demo-8',
        slug: 'reading-a-contour-map',
        title: 'Reading a contour map without getting lost in the lines',
        author: 'Tom Ellery',
        minutesAgo: 1680,
        summary: 'Close lines are steep, wide ones are gentle. A ten-minute guide with a practice map you can print at home.\n\nStart with the two rules and ignore the rest for now: where the lines bunch up, the ground rises fast, and where a stream runs, the ground falls. Everything else is detail you can add later.',
      },
      {
        guid: 'demo-14',
        slug: 'walking-in-the-rain',
        title: 'The quiet pleasure of walking in the rain',
        author: 'Tom Ellery',
        minutesAgo: 3456,
        read: true,
        summary: 'The fells empty out by ten and the paths are yours. What to wear, what to leave at home, and why the map stays dry in a bread bag.\n\nA bread bag beats a twenty-pound map case. It folds to nothing, it lives in a hip-belt pocket, and if it tears you are never more than a shop away from a replacement.',
      },
    ],
  },
  {
    url: 'https://theslowkitchen.example/feed.xml',
    title: 'The Slow Kitchen',
    siteUrl: 'https://theslowkitchen.example',
    color: 3,
    slug: 'theslowkitchen',
    posts: [
      {
        guid: 'demo-3',
        slug: 'roasted-squash-soup',
        title: 'Roasted squash soup that tastes better the next day',
        author: 'June Alvarez',
        minutesAgo: 180,
        summary: 'One tray, one pot and a spoonful of miso. Make a double batch on Sunday and lunch is sorted for the week.\n\nThe miso is the whole trick. It does not make the soup taste of miso; it makes the squash taste more like itself, the way a good stock does for a gravy.',
      },
      {
        guid: 'demo-7',
        slug: 'pantry-staples',
        title: 'Five pantry staples worth buying in bulk',
        author: 'June Alvarez',
        minutesAgo: 1620,
        summary: 'Rice, lentils, oats, tinned tomatoes and good salt. What to look for, and how to store them so they keep.\n\nBuy the salt last. It keeps forever, it is the cheapest of the five, and every shop sells a different one, so it is the easiest to decide on after you have carried the rest home.',
      },
      {
        guid: 'demo-13',
        slug: 'bread-dough-flour',
        title: 'Why your bread dough needs less flour than the recipe says',
        author: 'June Alvarez',
        minutesAgo: 7200,
        summary: 'Wet dough is harder to handle and makes a better loaf. How to work with it using only a scraper and a little patience.\n\nFlour varies more than any other ingredient in the recipe, by harvest, by mill, by the weather that week. The recipe\'s number is a starting point; your dough is the measurement that matters.',
      },
    ],
  },
  {
    url: 'https://orbitweekly.example/feed.xml',
    title: 'Orbit Weekly',
    siteUrl: 'https://orbitweekly.example',
    color: 4,
    slug: 'orbitweekly',
    posts: [
      {
        guid: 'demo-4',
        slug: 'lunar-relay-satellite',
        title: 'What the new lunar relay satellite will let rovers do',
        author: 'Ada Nwosu',
        minutesAgo: 300,
        summary: 'A steady link to the far side means longer drives, more pictures sent home and fewer hours waiting for a pass overhead.\n\nUntil now a rover on the far side went silent whenever Earth was below its horizon, which is most of the time. A relay overhead changes the rhythm of a mission from short windows to a working day.',
      },
      {
        guid: 'demo-9',
        slug: 'spot-the-space-station',
        title: 'How to spot the space station from your back garden',
        author: 'Ada Nwosu',
        minutesAgo: 1740,
        summary: 'It is the brightest moving thing in the evening sky. Pass times, where to look, and why it never blinks.\n\nThe never-blinks part is the giveaway. Aircraft flash; the station glides. If the light you are watching holds steady from horizon to horizon, you are not looking at a plane.',
      },
      {
        guid: 'demo-15',
        slug: 'backyard-radio-telescope',
        title: 'A backyard radio telescope on a village budget',
        author: 'Ada Nwosu',
        minutesAgo: 2160,
        summary: 'A dish nobody wanted, a receiver kit and a wet field. What the astronomy club heard in its first month.\n\nThe dish came from a satellite TV installer who was replacing them all with flat panels. It had spent ten years pointed at the wrong patch of sky for its new job, which is the best kind of irony for a telescope.',
      },
    ],
  },
  {
    url: 'https://lanternstreet.example/feed.xml',
    title: 'Lantern Street Journal',
    siteUrl: 'https://lanternstreet.example',
    color: 5,
    slug: 'lanternstreet',
    posts: [
      {
        guid: 'demo-5',
        slug: 'corner-bakery-at-four',
        title: 'The corner bakery that opens at four so the night shift can eat',
        author: 'Sam Okafor',
        minutesAgo: 1560,
        summary: 'For thirty years the lights have come on before anyone else\'s on the street. We spent a morning behind the counter.\n\nThe four o\'clock opening was never a plan. The bakery\'s first owner could not sleep before the dough was set, and the nurses coming off nights at the hospital two streets over started knocking.',
      },
      {
        guid: 'demo-10',
        slug: 'library-lending-tools',
        title: 'The library is lending out tools now, and people love it',
        author: 'Sam Okafor',
        minutesAgo: 2880,
        summary: 'Drills, ladders, a sewing machine and one very popular carpet cleaner. Six months in, the waiting list keeps growing.\n\nThe carpet cleaner has a waiting list of eleven. The librarians have started calling it the most borrowed object in the building, which is saying something in a place with forty thousand books.',
      },
      {
        guid: 'demo-12',
        slug: 'reading-room-post-office',
        title: 'A reading room opens above the old post office',
        author: 'Sam Okafor',
        minutesAgo: 5760,
        read: true,
        summary: 'Eight desks, good lamps and no rule about talking quietly. The first week\'s bookings filled in an afternoon.\n\nThe no-quiet-rule surprised everyone, including the people who run it. "The library up the road does quiet," one of them said. "This room does company."',
      },
      {
        guid: 'demo-16',
        slug: 'night-bus-parcels',
        title: 'The night bus that carries more parcels than people',
        author: 'Sam Okafor',
        minutesAgo: 10080,
        summary: 'Two passengers, forty parcels and a driver who knows every shortcut. The 00:40 service keeps the high street open longer than the shops do.\n\nThe parcels ride for free, within reason. The driver\'s rule is anything that fits on a seat goes on a seat, and anything that does not goes on the next one, which is why the 00:40 has fewer seats than it used to.',
      },
    ],
  },
];

const ALL_POSTS = FEEDS.flatMap((feed) => feed.posts);

/** Seed the viewing account's demo feeds and posts, once, idempotently.
 * `now` is the request's "now" so the relative times land where they should
 * on a staged preview. Returns nothing; failures are the caller's to log. */
async function seedDemoFor(pool, userId, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const feedIds = new Map();
  for (const feed of FEEDS) {
    const checkedAt = new Date(nowMs - 2 * 60000);
    const inserted = await pool.query(
      `INSERT INTO feeds (user_id, url, title, site_url, color, is_demo, last_checked_at)
       VALUES ($1, $2, $3, $4, $5, true, $6)
       ON CONFLICT (user_id, url) DO NOTHING
       RETURNING id`,
      [userId, feed.url, feed.title, feed.siteUrl, feed.color, checkedAt]);
    let id = inserted.rows[0] && inserted.rows[0].id;
    if (!id) {
      const found = await pool.query('SELECT id FROM feeds WHERE user_id = $1 AND url = $2', [userId, feed.url]);
      id = found.rows[0] && found.rows[0].id;
    }
    if (id) feedIds.set(feed.url, id);
  }
  for (const feed of FEEDS) {
    const feedId = feedIds.get(feed.url);
    if (!feedId) continue;
    for (const post of feed.posts) {
      const publishedAt = new Date(nowMs - post.minutesAgo * 60000);
      await pool.query(
        `INSERT INTO posts (feed_id, guid, title, link, author, summary, published_at, read_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (feed_id, guid) DO NOTHING`,
        [
          feedId,
          post.guid,
          post.title,
          `https://${feed.slug}.example/${post.slug}`,
          post.author,
          post.summary,
          publishedAt,
          post.read ? publishedAt : null,
        ]);
    }
  }
}

module.exports = { FEEDS, ALL_POSTS, seedDemoFor };