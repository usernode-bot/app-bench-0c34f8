# RSS Reader

Follow your RSS feeds in one scrolling list. Paste a feed's address, and every
unread post from your feeds lands in one newest-first list, each unread post
carrying an ink dot. Tapping a post marks it read and opens an inline preview
with an excerpt from the feed and a link to open the full article in the
browser. Each person's feeds are their own; visitors without an account can
look around read-only.

## How it works

- **Sign-in** — the server verifies the platform-issued user token (an RS256
  JWT) on every request, so the app already knows who is using it. Writes
  from visitors without an account are answered 401 `account_required`,
  which the bridge turns into a make-an-account prompt.
- **Feeds** — adding a feed fetches the address once to check it really is
  an RSS 2.0 or Atom feed, parsed by a small built-in XML reader
  (`server/feedxml.js`) with no extra npm packages. The list refreshes every
  feed when it opens and when you tap Refresh; nothing runs on a timer.
  Feeds that could not be reached are named in a notice while the posts
  already stored still show.
- **Database** — two tables, `feeds` and `posts`, both marked
  `staging:private` since feeds and reading state are personal. The schema
  is created idempotently on boot. Read state lives on `posts.read_at`.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme. The app's look is written down in `CLAUDE.md` under **Design**.

## Developing

- `npm ci --include=dev && npm run build` — compile the stylesheet.
- `node server.js` — run locally (needs `DATABASE_URL`).
- On staging, `/?demo=1` shows obviously fake demo posts so the populated
  screen can be seen without network access; real staging databases start
  empty.