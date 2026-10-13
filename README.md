# RSS Reader

A small RSS reader in the Feedly style: add the RSS or Atom feeds you
follow, see all their unread posts in one scrolling list, newest first.
Tap a post to read a preview and open the full article in your browser.
Every person's feeds and reading state are their own.

## How it works

- **Unread list** — `GET /api/posts` refreshes each of your feeds (in
  parallel), adds any posts not stored yet, and returns your unread
  posts newest first, with a count line and per-feed failures.
- **Add feed** — `POST /api/feeds` fetches and parses the address before
  saving it: not reachable or not a feed answers 400 with a plain
  reason, a feed you already have answers 409.
- **Read state** — tapping a post marks it read immediately
  (`POST /api/posts/:id/read`) and opens the preview; on close the post
  leaves the list. Reads are idempotent and per viewer.
- **Fetch guard** — `feed.js` fetches feeds through a guard: web
  addresses only (ports 80/443), no addresses with a password in them,
  no loopback, private, link-local or metadata addresses (checked at the
  DNS step, with the connection pinned to an address that passed), at
  most three redirects (each re-checked), 8 s timeout, 2 MB cap.
- **Staging demo** — on staging, `/?demo=1` stands in four made-up feeds
  with 23 unread posts so the populated screen can be seen. Demo feeds
  are never fetched and demo posts carry no link.

## Data

Two tables, both per person and both `staging:private` (staging's shared
database must not seed or copy them):

- `feeds` — url, title, site_url, whether it is a demo stand-in, and
  `last_error` (the failure line above the list). Unique per viewer per
  url.
- `posts` — guid, title, link, summary, author, published_at, fetched_at
  and read_at, one row per feed item. Unique per feed per guid.

## Design

The look is described in `CLAUDE.md` under "## Design": cool paper-grey
neutrals with one RSS orange accent, a serif masthead tag per post, and
the four-size type scale from `tailwind.config.js`. Colour tokens live
in `styles/tailwind-input.css`, in a light and a dark look that follow
the viewer's Homeroom theme.