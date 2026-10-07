# RSS Reader

An RSS reader for a Homeroom group: add your own feeds, and read every
unread post from all of them in one scrolling list, newest first. Tap a
post to read its preview in place, then open the full article in your
browser with one tap. Feeds and read state are private to each person.

## How it works

- **Adding a feed.** Paste a feed address or just a site's address; the
  server fetches the page, looks for its feed link (and a few common feed
  paths), and brings in the newest 50 posts — the 10 newest unread, the
  rest already read so an archive does not flood the list. Up to 100 feeds
  per person.
- **Reading.** `GET /api/posts` returns the newest 500 unread posts across
  all feeds. Opening a preview marks the post read (per person); read posts
  stay in the list until the next refresh. "Mark all as read" clears the
  screen with an Undo.
- **New posts.** The server fetches and parses feeds (a browser cannot):
  on open, feeds not checked in the last 10 minutes are refreshed; the
  refresh button and pull-to-refresh force every feed. Feeds are polled
  conditionally with stored `etag`/`last_modified`, and each keeps its
  newest 200 posts.
- **Safety.** Every outbound fetch goes through `safeFetch` in
  `lib/feeds.js`: http/https on default ports only, host resolved and
  screened against loopback/private/link-local/CGNAT/multicast addresses
  before connecting, redirects re-checked, 10 s timeout, 3 MB body cap.
  Feed content is reduced to plain text server-side (`htmlToText`) and
  rendered with `textContent` only, so no feed HTML or remote image ever
  reaches the page.
- **Sample feed.** "Try the sample feed" on the empty screen adds six
  how-it-works posts (`kind = 'sample'`), removable like any feed.

## API

| Route | Does |
| --- | --- |
| `GET /api/posts` | Feeds (with unread counts) and the newest 500 unread posts. Guests get `{ guest: true }` with empty lists. In staging with `?demo=1`, seeds the viewer's own demo feeds once. |
| `POST /api/feeds` `{ url }` | Discover and follow a feed. Errors: 400 `invalid_url`, 422 `no_feed_found`, 502 `unreachable`, 409 `already_following`, 409 `too_many_feeds`. |
| `POST /api/feeds/sample` | Add the sample feed (idempotent). |
| `DELETE /api/feeds/:id` | Unfollow; posts cascade. |
| `POST /api/refresh` `{ force }` | Fetch `kind = 'rss'` feeds (sample and demo never fetch); all when `force`, else stale ones. Concurrency 4. |
| `POST /api/posts/read` `{ ids, read }` | Mark posts read/unread; only ids the caller owns are touched. |

## Tables

`feeds`, `posts` and `demo_seeds`, all `staging:private` (what a person
follows and reads is theirs). Schema is applied idempotently on boot.
Read state lives on the post because feeds are already per person.

## Staging demo

A staging preview opened with `?demo=1` gives the viewing account four
obviously fake feeds ("Staging demo: Slow Kitchen", "Night Bus Notes",
"Field Guide Weekly", "Plain Text Web") with 16 unread posts, written once
per account (`demo_seeds` gates re-seeding). They are `kind = 'demo'`,
never fetched, and only ever read when `?demo=1` is on the request; the
plain route stays production-shaped. Every control works on them.

## Design

See `CLAUDE.md` ("## Design"): cool paper greys, RSS orange for the one
action colour, a per-feed colour dot as the signature element, serif for
reading text and the system sans for controls.

## Development

- `npm run build` compiles `styles/tailwind-input.css` to
  `public/tailwind.css` (the Dockerfile does this on every image build).
- `npm test` runs the `lib/feeds.js` unit tests (`test/feeds.test.js`).
