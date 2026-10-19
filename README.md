# RSS Reader

Follow your RSS feeds and read new posts in one list. Each person adds
their own feeds (any RSS 2.0 or Atom address), scrolls one mixed list of
unread posts from all of them with the newest first, and taps a post to
read a preview: the feed, the time, the title, the author if the feed
names one, and the text the feed includes, as plain paragraphs. From the
preview, "Open full article" opens the post's own page in the browser.

Feeds and read state are private to each member. Opening a preview marks
the post read; it stays in the list, dimmed, until the next time the app
opens. Feeds refresh each time the app is opened — nothing is fetched in
the background, and there are no folders or categories in this first
version. From the "N feeds" control you can see your feeds (with a
per-feed note when its last refresh failed) and remove one; removing a
feed removes its posts too.

## How it works

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request; visitors without an account see the
  empty state, read-only.
- **Database** — the app's own private Postgres database holds two
  tables, `feeds` and `posts`, both marked `staging:private`.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme. See `CLAUDE.md`'s "## Design" for the palette.
- **Staging demo** — on staging, `/?demo=1` seeds the viewer's own five
  made-up feeds with about 14 unread posts so the screen can be seen
  populated. Every control works on them.

## Developing

`npm run build` compiles the stylesheet (`styles/tailwind-input.css` +
`tailwind.config.js` → `public/tailwind.css`). `node server.js` starts
the app; see `CLAUDE.md` for the app-specific notes and the platform
rules.