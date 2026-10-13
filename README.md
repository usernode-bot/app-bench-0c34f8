# RSS Reader

A quiet place to read your feeds. Add any RSS or Atom feed and its unread
posts appear in one scrolling list, newest first, grouped under Today,
Yesterday and Earlier. Tapping a post opens a preview and marks it read on
the spot; "Open full post" takes you to the article itself.

- **Feeds are private to you** — each viewer's subscriptions and read state
  live in their own rows in the app's database.
- **No new dependencies** — feeds are fetched and parsed by `lib/feed.js`
  (a small RSS 2.0 / RDF / Atom reader), and the server speaks plain
  Express and Postgres.
- **Safe fetching** — feed addresses are resolved and checked before any
  request is made; private and loopback addresses (and redirects into them)
  are refused, so a pasted URL cannot reach the platform's own services.
- **The staging demo** — on staging, `/?demo=1` seeds six made-up feeds and
  fourteen unread posts once per account, including one feed that shows its
  "did not update" notice with a working Retry.
- **Both looks** — a light and a dark appearance on the same tokens,
  following the viewer's Homeroom theme.

## Layout

- `server.js` — schema, API (`/api/posts`, `/api/feeds`, `/api/feeds/:id`,
  `/api/feeds/:id/refresh`, `/api/posts/:id/read`), demo seeding, shutdown.
- `lib/feed.js` — safe fetching and feed parsing.
- `lib/demo.js` — the staging demo data.
- `public/app.js` — the Unread screen; `public/kit/` is the shared UI kit.
- `test/feed.test.js` — parser and safety tests (`npm test`).
- `styles/tailwind-input.css` — the design tokens and components, compiled
  to `public/tailwind.css` by `npm run build`.