# RSS Reader

A Feedly-like feed reader on Homeroom: add the RSS or Atom feeds you
follow, see every unread post in one scrolling list, newest first, and
tap a post to read a preview of it inside the app. A link at the bottom
of the preview opens the full post in the browser. Feeds are private —
every user follows their own.

## How it works

- **Backend** (`feeds.js`, `lib/rss.js`) — Express routes over Postgres.
  Feeds are fetched and parsed server-side with
  [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser)
  (RSS 2.0, RSS 1.0/RDF and Atom). Fetching goes through `safeFetch`:
  only public addresses, re-checked at every redirect hop, with a 10 s
  timeout and a 3 MB cap — a feed URL can never be used to reach the
  platform's internal services.
- **Frontend** (`public/`) — one screen: the unread list with filter
  pills per feed, a preview sheet, and a "Your feeds" sheet for
  removing feeds. Built with the platform's kit (`public/kit/`) and the
  design kit in `styles/tailwind-input.css`.
- **Read state** — marking a post read is per user; posts you read
  stay greyed out in the list until you next open the app.
- **Staging demo** — `?demo=1` on staging seeds five made-up feeds and
  ten posts so the populated screen can be seen without real URLs.

## Development

- `npm test` — unit tests for the feed library (`node --test`).
- `npm run build:css` — recompile `public/tailwind.css` after changing
  `styles/tailwind-input.css` or any Tailwind class.

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. You can
also run Claude Code against this repo directly; start with `CLAUDE.md`.