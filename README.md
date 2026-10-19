# RSS Reader

Follow RSS and Atom feeds and read everything new in one list. Each
person adds their own feeds, and their feeds and what they have read are
private to them.

- Add a feed by pasting its exact RSS or Atom address. The app checks
  that the address really is a feed before saving it.
- The reader shows one list of unread posts from all your feeds, newest
  first, each with a coloured strip for its feed.
- Tap a post to read a preview. Opening it marks the post read, and
  "Open full article" opens the original page in the browser.
- Tap the feed count to manage feeds, see which one failed to refresh,
  and remove any you no longer follow.
- Feeds refresh each time the app opens. Nothing is fetched in the
  background.

## Development

The app runs on Homeroom. `server.js` serves the page and the JSON API,
and stores feeds and posts in the app's own Postgres database. The page
is plain `public/index.html` with a Tailwind stylesheet compiled at
image-build time from `styles/tailwind-input.css`.

```sh
npm ci
npm run build   # compile public/tailwind.css
node server.js
```

Open `/?demo=1` on a staging build to see the reader filled with
made-up feeds. Start with `CLAUDE.md` for the app's look and the platform
rules.
