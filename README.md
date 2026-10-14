# RSS Reader

All the new posts from the RSS feeds you follow, in one list. You add a
feed by pasting its address (or just the website's), the app finds the
site's feed, and every unread post from all your feeds shows in one
scrolling list, newest first, grouped by day. Tapping a post opens a
preview of the article inside the app, marks it read, and offers a link
to the full story in your browser.

Each person's feeds and read posts are their own: both tables are
`staging:private`, and every route is scoped to the signed-in user.

## How it works

- **Adding a feed** — the server fetches the address (http/https only,
  internal addresses refused, redirects rechecked, an 8 s timeout and a
  2 MB limit), follows a website's `<link rel="alternate">` to its feed
  when you pasted the site, and parses RSS 2.0 or Atom. The feed's own
  name is kept.
- **The list** — every time the app opens, the server fetches all your
  feeds in parallel and returns the posts you have not read yet. One
  feed failing does not hide the others; a line names it with a Retry.
- **Reading** — opening a post's preview marks it read for you alone;
  it leaves the list the next time the app loads.

## Staging demo

On a staging preview opened with `?demo=1`, the app seeds five made-up
feeds and about sixteen invented posts (no network fetches, fixed
example.com addresses) so the populated screen can be seen. Feeds you
remove or read marks you make there stay; without `?demo=1` the demo
feeds are hidden.

## Building

`npm run build` compiles the design kit (`styles/tailwind-input.css`) to
`public/tailwind.css`; the Dockerfile and Paketo both run it on every
image build. Run locally with `node server.js` and a `DATABASE_URL`.
