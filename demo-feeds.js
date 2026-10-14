// The staging demo's made-up feeds and posts (?demo=1, staging only). Every
// feed and post here is invented, with example.com addresses, and never
// fetched over the network: the server answers from this file alone. Times
// are offsets from the request's own "now".
'use strict';

const DEMO_FEEDS = [
  {
    url: 'https://example.com/feeds/weather-desk',
    title: 'Example Weather Desk',
    color: 1,
    posts: [
      { guid: 'demo-weather-1', title: 'Sample post: a week of mild sunshine for the made-up town of Fernvale', minutesAgo: 12,
        summary: 'This is pretend weather for a pretend town. Fernvale can expect five dry days in a row, with soft winds from the west and afternoons warm enough for a light jacket. The made-up forecasters say a little cloud may roll in on Sunday, but nothing that should spoil a walk by the imaginary river. Read the full sample forecast for the hour by hour detail.' },
      { guid: 'demo-weather-2', title: 'Sample post: how the pretend river forecast is put together', daysAgo: 1,
        summary: 'A short tour of the imaginary gauges along the fictional river. Each morning a made-up observer reads three markers and sends the numbers to the sample desk, where they are turned into a friendly plain-language forecast nobody should plan a real picnic around.' },
      { guid: 'demo-weather-3', title: 'Sample post: what a invented fog signal means when you hear it', daysAgo: 2,
        summary: 'In the made-up harbour, one long blast means the fog has rolled in over the imaginary sandbar. This sample note explains the pretend signal codes, none of which any real harbour uses.' },
      { guid: 'demo-weather-4', title: 'Sample post: the fictional station on the hill gets new rain cups', daysAgo: 3,
        summary: 'The little weather station in this invented story has measured rain the same way for years. Today its imaginary caretaker swapped in larger cups, so the sample numbers will read a shade differently for a while.' },
    ],
  },
  {
    url: 'https://example.com/feeds/garden-notes',
    title: 'Sample Garden Notes',
    color: 3,
    posts: [
      { guid: 'demo-garden-1', title: 'Demo article: planting tomatoes in pots on a sunny balcony', hoursAgo: 1,
        summary: 'A made-up balcony, six hours of pretend sun, and three sample pots. This demo piece walks through choosing a pot, planting the seedling and the imaginary watering routine that keeps the fictional plant happy until the sample harvest.' },
      { guid: 'demo-garden-2', title: 'Demo article: five easy herbs for a windowsill', daysAgo: 1,
        summary: 'Basil, mint, chives, parsley and thyme: the five herbs this invented windowsill guide recommends. Each sample note says how much pretend light it wants and how often the fictional gardener should pinch it back.' },
      { guid: 'demo-garden-3', title: 'Demo article: a pretend allotment gets ready for the sample autumn', daysAgo: 2,
        summary: 'The imaginary plot holders are clearing beds, planting fictional garlic and arguing pleasantly about the sample compost heap. A gentle made-up read for the end of the season.' },
      { guid: 'demo-garden-4', title: 'Demo article: one homemade cold frame, built from invented planks', daysAgo: 3,
        summary: 'A sample build diary: four fictional planks, an old pretend window, and an afternoon. The demo measurements are all made up, so do not cut anything.' },
    ],
  },
  {
    url: 'https://example.com/feeds/placeholder-kitchen',
    title: 'The Placeholder Kitchen',
    color: 2,
    posts: [
      { guid: 'demo-kitchen-1', title: 'Test recipe: one pan lemon rice for a quiet weeknight', hoursAgo: 3,
        summary: 'Rice, a lemon, an onion and a made-up handful of peas. Everything cooks in one sample pan while the fictional kitchen fills with a pretend lemon smell. Ready in about the time this placeholder recipe says.' },
      { guid: 'demo-kitchen-2', title: 'Test recipe: the imaginary Saturday loaf, step by step', daysAgo: 1,
        summary: 'A sample sourdough story with pretend timings: a fictional starter, a slow sample rise and a very made-up crust. The test kitchen has never actually baked it, and it shows in the pictures we did not take.' },
      { guid: 'demo-kitchen-3', title: 'Test recipe: invented tomato soup for a rainy sample afternoon', daysAgo: 2,
        summary: 'Six placeholder tomatoes, one imaginary onion and a lot of pretend stirring. The sample soup is best with the fictional bread from last week’s test bake.' },
      { guid: 'demo-kitchen-4', title: 'Test recipe: a made-up picnic cake that travels well', daysAgo: 3,
        summary: 'The placeholder kitchen baked this sample cake three times on the same fictional day and ate every crumb. A pretend recipe for berries, lemon zest and an invented crumble top.' },
    ],
  },
  {
    url: 'https://example.com/feeds/code-weekly',
    title: 'Fictional Code Weekly',
    color: 4,
    posts: [
      { guid: 'demo-code-1', title: 'Sample news: version 2.0 of an imaginary text editor is out', hoursAgo: 5,
        summary: 'The fictional editor everyone in this made-up story uses has shipped its sample 2.0. The headline features are invented: a pretend command palette that guesses right and a fictional theme that follows the sample light of the day.' },
      { guid: 'demo-code-2', title: 'Sample news: the fictional package registry had a made-up hiccup', daysAgo: 1,
        summary: 'For twenty sample minutes on Tuesday, the imaginary registry served yesterday’s pretend metadata. Nothing broke, says the fictional incident note, but the sample postmortem is a good read anyway.' },
      { guid: 'demo-code-3', title: 'Sample news: a made-up conference announces its fictional schedule', daysAgo: 2,
        summary: 'Three days of invented talks, all imaginary: a sample keynote on pretend type systems and a fictional workshop where nobody is allowed to use a real keyboard.' },
      { guid: 'demo-code-4', title: 'Sample news: the pretend style guide goes sample open source', daysAgo: 3,
        summary: 'The fictional weekly’s own style rules, published for everyone to argue with. The sample repository includes the made-up lint rules that keep the imaginary prose tidy.' },
    ],
  },
  {
    url: 'https://example.com/feeds/museum-blog',
    title: 'Made Up Museum Blog',
    color: 5,
    posts: [
      { guid: 'demo-museum-1', title: 'Demo post: a new room of invented pottery opens on Saturday', daysAgo: 1,
        summary: 'Forty sample pots, none of them real, arranged by the fictional curator to tell the imaginary story of a made-up town’s clay. The demo room opens with pretend fanfares and free sample entry.' },
      { guid: 'demo-museum-2', title: 'Demo post: the fictional clock gallery chimes again', daysAgo: 2,
        summary: 'After a sample restoration that took two imaginary years, the made-up regulator clock in this demo gallery chimes on the fictional hour once more.' },
      { guid: 'demo-museum-3', title: 'Demo post: an invented map of the imaginary museum basement', daysAgo: 3,
        summary: 'The sample basement is a maze of pretend corridors and fictional storage racks. A made-up map, drawn for this demo post, shows where the imaginary crates nap.' },
    ],
  },
];

/**
 * The demo posts for one feed row, times set from the request's "now".
 * Returns { posts: [{ guid, link, title, publishedAt, summary }] }, newest first.
 */
function demoPostsFor(feed, now) {
  const found = DEMO_FEEDS.find((d) => d.url === feed.url);
  if (!found) return { posts: [] };
  const base = new Date(now).getTime();
  const posts = found.posts.map((p) => ({
    guid: p.guid,
    link: 'https://example.com/posts/' + p.guid,
    title: p.title,
    publishedAt: new Date(base - ((p.minutesAgo || 0) + (p.hoursAgo || 0) * 60 + (p.daysAgo || 0) * 60 * 24) * 60000).toISOString(),
    summary: p.summary,
  })).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return { posts };
}

module.exports = { DEMO_FEEDS, demoPostsFor };
