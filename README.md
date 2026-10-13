# RSS Reader

All the unread posts from your RSS and Atom feeds, in one list, newest
first. Built to run on Homeroom: every person's feeds and read marks are
their own.

## What it does

- **The list.** Unread posts from all your feeds, newest first, an orange
  unread dot on each row, and a line above the list saying how many unread
  posts from how many feeds. The list refreshes when it opens, when you tap
  Refresh, and when you pull down.
- **Add feed.** Paste a feed address (RSS or Atom), tap Add feed. The feed
  is fetched and checked before it is saved; if it will not load, the form
  says so and keeps what you typed. Fetching is guarded: http(s) only,
  private and loopback addresses refused on every redirect hop, 10 s
  timeout, 2 MB limit (see `feeds.js`).
- **Read a post.** Tapping a post marks it read right away and opens a
  preview: the article's summary text in the app's serif, and an
  "Open in browser" link to the full thing. Read rows stay dimmed in the
  list until it next loads.
- **Your feeds.** A link under the list opens a sheet with every feed's
  address and a Remove button, which asks first.
- **Honest states.** Four grey placeholder rows while loading; "Add your
  first feed" when you have none; "You're all caught up" when there is
  nothing unread; a line above the list when one feed failed but the rest
  loaded; and a full error state that says your feeds are saved.

## How it is built

- **Server** (`server.js`, `feeds.js`): Express + Postgres. Two tables,
  `feeds` and `posts` (both private to the signed-in person). `GET
  /api/posts` refreshes your feeds and returns unread posts; `POST
  /api/feeds`, `DELETE /api/feeds/:id` and `POST /api/posts/:id/read` do
  the rest. `feeds.js` is the guarded fetch and the rss-parser wrapping.
- **Client** (`public/`): the drawn screens from the spec, filled with
  real data by `public/app.js` using the kit in `public/kit/` (states,
  sheets, toasts, the native UI kit when the platform provides it). Styles
  are the design kit in `styles/tailwind-input.css` compiled by Tailwind
  (`npm run build`) plus the screens' own `public/screens.css`.

## Design

RSS-orange accent on warm greys; post titles and preview text in the
system serif (`ui-serif`, Georgia), everything else sans. The signature
element is the orange unread dot, and the RSS wave mark leads the empty
states and the favicon. Both looks follow the viewer's Homeroom theme.
Details in `CLAUDE.md`.

## Staging demo

Open any staging preview with `?demo=1` to see the populated app with four
made-up feeds and fourteen made-up posts ("Staging demo: these feeds and
posts are made up." shows at the top). All the controls work; reads you
make there stay for that preview. The demo rows show only with
`?demo=1`; without it the app is exactly as a new user finds it.

## Not in this version

Mark all read, mark unread, feed discovery, OPML import/export, background
refresh, folders, saved posts, search, full article fetching, and deleting
old read posts.