# RSS Reader

A Feedly-style RSS reader on Homeroom: add the RSS feeds of the sites you
follow, and every unread post from all of them shows up in one scrolling
list. Tap a post to read a preview inside the app, and follow the link out
to the full article. Each person's feeds and posts are their own.

## How it works

- **Sign-in** — the server verifies the platform-issued user token (an
  RS256 JWT) on every request, so the app always knows whose feeds it is
  showing. Guests can read but not change anything.
- **Feeds** — `feeds` and `posts` tables in the app's own Postgres
  database, both marked `staging:private` (per-user data). Adding a feed
  fetches and parses it first, so a mistyped address is rejected rather
  than saved as a broken feed.
- **The list** — one screen: every unread post across all feeds, newest
  first, with an unread dot in each feed's own colour. Tapping a post
  opens the preview and marks it read.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during
  image creation, in a light and a dark look that follow the viewer's
  Homeroom theme.
- **Demo** — open the app with `?demo=1` in staging to see it populated
  with labelled, obviously fake feeds and posts.

## Development

`node server.js` starts the app (Express). `npm run build` recompiles
`public/tailwind.css` from `styles/tailwind-input.css` and
`tailwind.config.js`. To change the app, ask Homeroom bot, or run Claude
Code against this repo and start with `CLAUDE.md`.
