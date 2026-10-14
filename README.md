# RSS Reader

A small Feedly-style reader for a Homeroom group. Add an RSS feed by link
and all the unread posts from every feed you follow show up in one list,
newest first. Tap a post to read a preview of it (that marks it read) and
open the full story on its site from there. Feeds, posts and read state
are each person's own: nobody else in the group sees what you follow or
what you have read.

## How it works

- **Server** (`server.js`) — Express + Postgres. On boot it creates the
  `feeds` and `posts` tables (both `staging:private`). `GET /api/posts`
  refreshes your feeds, saves any new posts and answers with your unread
  list plus per-feed errors. `POST /api/feeds` fetches and parses the link
  first, so only real feeds are saved; `DELETE /api/feeds/:id` removes a
  feed and its posts; `POST /api/posts/:id/read` marks a post read.
- **Feed fetcher** (`lib/feeds.js`) — reads RSS 2.0, RSS 1.0 and Atom with
  `fast-xml-parser`. Before it connects anywhere it refuses non-public
  addresses (loopback, private ranges, the cloud metadata endpoint), and
  it caps redirects, response size and time so one bad feed cannot tie up
  the app.
- **Front end** (`public/`) — one screen built on the platform's design
  kit and native UI kit: loading skeletons, the empty states, the preview
  sheet, Add feed, and a feeds list where feeds can be removed. Staging's
  `?demo=1` shows a populated demo made entirely of made-up feeds and
  posts.

## Developing

`npm install`, then `node server.js` (with `DATABASE_URL` set). The
stylesheet is precompiled from `styles/tailwind-input.css` by
`npm run build`; the image build runs it on every deploy. `CLAUDE.md`
carries the app-specific notes and points at the platform rules.
