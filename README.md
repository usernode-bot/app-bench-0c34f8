# RSS Reader

Follow your favourite feeds in one scrolling list. You add your own RSS
feeds, read every unread post from them in one list with the newest first,
and tap a post to read a preview. From the preview you can open the full
article in your browser. Your feeds belong to you: each person signs in as
themselves and sees only their own feeds.

- **Unread** — all unread posts from your feeds, mixed together, newest
  first, each carrying its feed's colour down its left edge.
- **Add feed** — paste a feed's own address; the app checks it and adds its
  posts. Your feeds are re-checked for new posts when you open the app.
- **Preview** — tapping a post marks it read and shows the summary the feed
  sends, with a link to open the full article.
- **Feeds** — see and remove what you added.

## Running it

The server is `server.js` (`node server.js`); the stylesheet is compiled
from `styles/tailwind-input.css` by `npm run build` on every image build.
The staging preview's populated demo lives behind `?demo=1` and writes the
viewer's own made-up feeds and posts (`staging:private` tables).

To change this app, ask Homeroom bot, or run Claude Code against this repo
directly; start with `CLAUDE.md`, which carries the app-specific notes and
points at the platform rules.