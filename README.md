# RSS Reader

All your RSS feeds in one scrolling list. Add the feeds you follow, see
every unread post from all of them in one merged list, newest first, and
tap a post to preview it with a link to open the full thing in the
browser. Each person's feeds and posts are their own.

- **Add a feed** — paste a feed address or just a site's address; the app
  finds the feed on the site if needed and names it from the feed itself.
  Adding the same feed twice does nothing except tell you it is already
  there.
- **Read** — one list of unread posts across all your feeds, each with an
  orange unread dot, its source and how long ago it was posted. Opening a
  post's preview marks it read: the dot clears and the row stays put until
  the next refresh. **Mark all read** clears the lot at once.
- **Refresh** — the list refreshes when the app opens and whenever you tap
  Refresh. A feed that cannot be reached is skipped and named in a one-line
  note; everything else still loads.
- **Manage feeds** — My feeds lists what you follow, each with a Remove
  button. Removing a feed also removes its posts.

## How it works

Node/Express + Postgres. The server fetches and parses feeds with
`rss-parser` (10s timeout, 5 MB response cap); the browser never fetches a
feed itself. Feeds and posts live in two `staging:private` tables owned by
the viewer's Homeroom user id; a post counts as read when its preview is
opened (`posts.read_at`).

Tailwind CSS is precompiled by `npm run build` during image creation, in a
light and a dark look that follow the viewer's Homeroom theme. The design
kit lives in `styles/tailwind-input.css`; the app's look is written down in
`CLAUDE.md`.

## Development

```sh
npm install
npm run build        # compile public/tailwind.css
npm start            # needs DATABASE_URL
```

Staging previews seed two obviously fake demo feeds and five unread posts
behind `/?demo=1`, so the populated screen can be seen without real data.
