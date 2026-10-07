# RSS Reader

Follow RSS feeds and read them in one place. Add a feed's address, and one
screen shows every unread post from all of your feeds, newest first. Tap a
post for a short preview with a link to open the full article in your
browser. Each person's feeds and read marks are their own.

- **Sign-in** — the server verifies the platform-issued user token on every
  request, so the app already knows who is using it. Guests can look but
  need an account to add feeds or mark posts read.
- **Feeds** — fetched server-side with Node's `fetch` and parsed with
  `rss-parser` (RSS and Atom). Posts are cached in the app database and
  refreshed when someone opens the app (feeds not fetched in the last five
  minutes are re-fetched then). Addresses that are not readable feeds are
  refused with a message, and fetching is bounded (public addresses only,
  timeouts, size cap, redirect limit).
- **Database** — the app's own Postgres. The `feeds` and `feed_items` tables
  are a shared public cache; `subscriptions` and `read_state` are private
  per-user tables, so each person's feeds stay theirs.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme: a warm amber accent over ink neutrals, with an unread-dot list as
  the signature element.

Staging previews can show a populated screen with
[`?demo=1`](README.md#staging-demo-data): three in-memory "Staging demo"
feeds, written nowhere and attributed to no one.

## Development

```sh
npm install
npm run build   # compiles styles/tailwind-input.css to public/tailwind.css
npm start
```

To change this app, ask Homeroom bot, or run Claude Code against this repo;
`CLAUDE.md` carries the app-specific notes and points at the platform rules.