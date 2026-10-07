# RSS Reader

All your RSS and Atom feeds in one scrolling list. Add the feeds you
follow, see every unread post from them newest-first, tap a post to read
the preview the feed itself provides, and open the full article in your
browser. Each person's feeds and reading state are their own; nobody else
sees what you follow.

Built on Homeroom: sign-in is handled by the platform (each visitor's
app token is verified on every request), the app has its own Postgres
database (`feeds` and `posts`, both private tables), and the stylesheet
is precompiled from `styles/tailwind-input.css` by `npm run build` at
image-build time, in a light and a dark look that follow the viewer's
Homeroom theme.

Feeds are fetched server-side with Node's built-in `fetch` and parsed by
a small hand-rolled extractor (`lib/feed-parser.js`) — no feed-parser
npm dependency. New posts are fetched when you open the app and when you
tap Refresh. The address is checked before a feed is saved: an
unreachable host, an HTML page, or a feed you already follow is reported
and nothing is stored.

To run it locally: `npm ci`, `npm run build`, then `node server.js` with
`DATABASE_URL` set. `npm test` runs the unit tests.

To change the app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon, then **Suggest an improvement**. You can also run Claude
Code against this repo directly; start with `CLAUDE.md`, which carries
the app-specific notes and points at the platform rules.