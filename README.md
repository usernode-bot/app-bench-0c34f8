# RSS Reader

A Feedly-style RSS reader for Homeroom. Add the RSS feeds you follow and see
all their unread posts in one scrolling list, newest first. Tap a post for an
in-app preview of the article as the feed carried it, with a link to open the
full thing in your browser. Tapping a post marks it read. Every person's
feeds and read marks are their own — nothing is shared.

## How it works

- `server.js` — the Express server: platform-issued token auth (guests may
  look around read-only), the API (`/api/posts`, `/api/feeds`), and the
  staging demo (`/?demo=1` shows obviously fake feeds and posts).
- `feeds.js` — fetching and parsing. Every feed address goes through a guard
  (http/https only, ports 80/443, DNS resolved and checked against private
  and loopback ranges before connecting, 8 s timeout, 2 MB cap, no
  redirects past 3, no cookies), then parsed as RSS 2.0, Atom or RSS 1.0,
  and the article HTML the feed carries is sanitized to a small tag
  allowlist before it is ever shown.
- `public/` — the reader. `index.html` and `screens.css` are the screens the
  spec drew; `app.js` fills them from the API. The kit under `public/kit/`
  is platform infrastructure.
- `styles/tailwind-input.css` + `tailwind.config.js` — the design kit
  (colour tokens, components). `npm run build` compiles the stylesheet to
  `public/tailwind.css`.

## Data

Three per-viewer tables in the app's own database, all marked
`staging:private`: `feeds`, `posts`, `demo_seeds` (see the schema in
`server.js`). Feeds added under `?demo=1` are real feeds; the seeded demo
feeds are fake and never fetched.

## Rebuilding the stylesheet

`npm ci --include=dev && npm run build` (the platform image build does this
for you).
