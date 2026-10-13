# RSS Reader

A calm place to read the web. Follow the sites you care about, see their
new posts in one unread list, newest first, and read a preview without
leaving the app.

- **Add a feed** by pasting an address — a feed URL, or just a website's
  address and the app finds its feed. Up to 100 feeds.
- **One Unread list** of posts from the last 30 days (at most 300),
  grouped by day. Unread posts carry the app's orange feed mark; opening
  one marks it read, and it stays greyed in place until your next visit.
  "Mark as unread" in the preview undoes it.
- **Previews** show the feed, title, author and summary in a serif reading
  face, with one filled button: Open full article, which opens the post in
  your browser.
- **Your feeds** lists every feed with its unread count, and lets you
  refresh a feed that failed or remove it.
- The list refreshes itself when it is older than 15 minutes; **Refresh**
  forces a check of every feed.

Built for [Homeroom](https://app.onhomeroom.com): sign-in is the
platform's own (a token on every request, no accounts to build), each
reader's subscriptions and read posts live in the app's private Postgres
database, and the look follows the viewer's Homeroom theme, light and
dark. In staging, open `?demo=1` to see the app populated with made-up
feeds and posts that belong to your account only.

## Developing

- `npm ci --include=dev && npm run build` compiles the Tailwind
  stylesheet (`styles/tailwind-input.css` → `public/tailwind.css`); the
  image build runs it on every deploy.
- `npm test` runs the feed parsing and fetching tests.
- `node server.js` starts the app; `CLAUDE.md` carries the app-specific
  notes and points at the platform rules.

To change the app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**.