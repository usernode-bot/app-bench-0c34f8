# RSS Reader

A quiet reader for people who follow a handful of things. Each member of
the app adds their own RSS feeds, and everything those feeds publish lands
in one scrolling list of unread posts, newest first. Tap a post to preview
it — the title, the feed, the date, the summary the feed sends — and open
the full article on the feed's own site. Tapping a post marks it read, and
read posts fade in place. Feeds are private: what you follow is yours.

## How it works

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so every list and every feed belongs to
  one person. No accounts to build.
- **Database** — two tables, `feeds` and `posts`, both per-user and marked
  `staging:private`. Posts are inserted with `ON CONFLICT DO NOTHING`, so
  re-reading a feed never duplicates anything.
- **Fetching** — `feed-fetch.js` fetches and parses feeds (RSS 2.0 and
  Atom): http/https only, standard ports, no credentials, a DNS check that
  refuses private and loopback addresses before anything connects, at most
  three redirects, a 10 s timeout and a 2 MB body limit. Feed text is
  reduced to plain text — never rendered as HTML.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme. The screens themselves are the ones the spec drew
  (`public/screens.css`).

## Trying it on staging

Open the app with `?demo=1`: five demo feeds and 26 fixed demo posts fill
the screen (23 unread, 3 already read) so the populated look can be seen
without adding anything. The demo feeds are never fetched.

## Notes for developers

Start with `CLAUDE.md` — it carries the app's product intent, the design
rules, and points at the platform conventions. To change the app, ask
Homeroom bot: open the app on Homeroom, tap the Homeroom icon in the
header, then **Suggest an improvement**.
