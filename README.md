# RSS Reader

All your favourite sites' new posts, in one list. Add an RSS or Atom feed by
address and every unread post from your feeds gathers in one scrolling list,
newest first. Tap a post to mark it read and preview the article (the feed's
own text and images), then open the full story on its site in your browser.

- **Add feed** saves a feed to your account; its posts show up straight away.
- **Refresh** fetches new posts on demand. New posts are also fetched when
  you open the app — never on a background timer.
- **Your feeds** lists what you follow, and a Remove button (which asks
  first) takes a feed and its posts away.
- A feed that fails to update is named above the list, with a Retry; posts
  from your other feeds still show.
- Your feeds and what you have read are yours alone.

One screen: **Unread**. Read posts stay dimmed for a few minutes so you can
find your way back, then leave the list.

## Stack

Node and Express, Postgres, a precompiled Tailwind stylesheet from the
Homeroom design kit. No RSS packages: feeds are fetched through the
SSRF-guarded fetcher in `lib/feeds.js` and parsed by the hand-written XML
reader there. Article HTML is sanitised in the browser from an allowlist.

## Run

```sh
npm ci --include=dev
npm run build
node server.js
```

`DATABASE_URL`, `USERNODE_JWT_PUBLIC_KEY`, `USERNODE_APP_ID` and `PORT` are
injected by the Homeroom platform; there are no other settings.
