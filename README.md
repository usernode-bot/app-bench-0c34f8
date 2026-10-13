# RSS Reader

A quiet, unread-first RSS reader for Homeroom. Add any RSS or Atom feed
by its https address; its new posts show up in one scrolling list,
newest first, grouped Today, Yesterday and Earlier. Open a post's
preview to read the summary the feed shares — opening it marks the post
read — and follow the "Open in browser" button to read the full article
on the publisher's site. Every viewer has their own list: feeds and
read state are per person, not shared.

## How it works

- **The page** (`public/`) — one main screen (unread list, feed filter
  chips, refresh), a preview sheet per post, and a "Your feeds" sheet
  that adds and removes feeds. Plain ES modules, no build step.
- **The API** (`server.js`) — `GET /api/posts`, `POST /api/refresh`,
  `POST /api/feeds`, `DELETE /api/feeds/:id`, `POST /api/posts/:id/read`.
  Feeds are fetched four at a time; the server talks to the platform
  Postgres directly.
- **Fetching feeds** (`lib/feeds.js`) — an https-only fetch with a
  strict URL guard (no private or loopback addresses, redirects
  re-checked, 8 s timeout, 2 MB cap) and a small tolerant parser for
  RSS 2.0, RSS 1.0 and Atom. Feed HTML is never rendered: summaries
  become plain text. No dependencies beyond Node's own modules.
- **Data** — `feeds`, `posts` and `demo_seeds` tables, per viewer.
  New feeds keep only their 50 newest items, and items older than 14
  days are stored already read.

## Staging demo

On a staging preview opened with `?demo=1` (staging only), the app
seeds four plainly invented feeds and 24 posts so the populated screen
can be seen. They are labelled "Staging demo: these feeds and posts are
made up." and are never fetched from the network. The overlay shows
only behind `?demo=1`: the plain screen always lists the viewer's real
feeds alone, so demo rows an earlier demo visit seeded never reach it.

## Development

```sh
npm install
npm test          # lib/feeds.js: the URL guard and the parser
npm run build     # precompile Tailwind (public/tailwind.css)
npm start         # node server.js
```

## Design

See `CLAUDE.md` under "## Design": cool grey neutrals with one orange
accent, serif titles over sans chrome, and the orange unread dot as the
app's signature.