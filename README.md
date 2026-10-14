# RSS Reader

A quiet, personal RSS reader on Homeroom: add the feed of a site you
follow, and its unread posts show up in one scrolling list, newest first.
Tap a post for a preview with a link to open the full article on the
site. Feeds are private to the person who added them.

## What it does

- **Unread list** — every feed's new posts in one list, grouped by day
  (Today, Yesterday, and so on), each row with an unread dot, the feed's
  name, the time, the title and a two-line summary from the feed.
- **Preview** — tapping a row marks it read and opens a sheet with the
  feed-provided summary and an *Open full article* button that opens the
  post in the browser.
- **Add feed** — paste the address of a site's feed; the app fetches and
  validates it server-side before saving it under the name the feed
  gives. Errors say which problem it was (not a feed, unreachable, or
  already in the list) and keep what was typed.
- **Manage feeds** — a Feeds sheet lists every feed with its address;
  removing one (with a confirm) removes its posts too.
- **Honest states** — caught-up, no-feeds-yet, loading (the list's own
  shape with skeleton bars) and a retry-able error state.

`?demo=1` (staging only) seeds six made-up feeds and twenty posts so the
populated screen can be seen; everything works on the demo rows exactly
as it would on real ones.

## How it runs

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request. Feeds and posts are private per user.
- **Database** — a private Postgres database holds two tables, `feeds`
  and `posts`; the server creates them on boot if missing.
- **Feed fetching** — done server-side through an SSRF-guarded fetch
  (http/https only, private addresses blocked, redirects re-checked,
  short timeout and a size cap). RSS 2.0, RSS 1.0 and Atom are parsed.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during
  image creation, in a light and a dark look that follow the viewer's
  Homeroom theme. See `CLAUDE.md` for the design notes.