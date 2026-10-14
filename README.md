# RSS Reader

One screen, one job: read all the unread posts from your own RSS feeds
in one scrolling list, newest first.

- **Add a feed** — type the address (like `example.com/feed.xml`) and
  tap Add. Feeds sit above the list as chips, each with its unread
  count and an × that asks before it removes the feed.
- **Read** — each row shows the feed, how long ago, the title and a
  two-line summary, with an amber dot while it is unread. Tapping a
  row opens a preview sheet with the full summary and an
  "Open in browser" button; opening the preview marks the post read,
  and it leaves the list when the sheet closes.
- **Refresh** — feeds are checked when the app opens, when a feed is
  added, and from the refresh button in the header. No background
  scheduling.

Every viewer sees only their own feeds, posts and read marks.

## Design

Warm grey neutrals with an amber accent, in a light and a dark look
that follow the viewer's Homeroom theme. The signature element is the
amber unread dot, which goes hollow when the post is read. Post titles
and preview text are serif; everything else is system sans. The header
carries a broadcast-waves mark in amber.

## How it is put together

- `public/app.js` — the screen: cloned from the drawn spec screens and
  filled with real data through the platform's design kit.
- `lib/feeds.js` — fetching and parsing RSS 2.0, RSS 1.0 and Atom with
  no dependencies, behind a fetch guard that only ever reaches public
  http(s) addresses (every redirect re-checked, no cookies, 10s
  timeout, 5 MB limit).
- `server.js` — the API and the per-user data tables (`feeds`,
  `posts`, `demo_seeded`), all marked `staging:private`.
- Staging demo — `/?demo=1` (staging only) seeds four made-up feeds so
  the populated screen can be seen without adding anything real.
