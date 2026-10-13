# RSS Reader

All your favourite sites' new posts in one list. Add the address of a
feed or a site, and its new posts show up in a single scrolling list,
newest first. Tap a post to read a preview of it here, or open the full
article in your browser. Every person's feeds and read state are their
own: nothing is shared between accounts.

## How it works

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request. Guests can browse the empty screen;
  anything that changes data asks them to make an account.
- **Feeds** — the server fetches and parses RSS 2.0 and Atom feeds
  itself. A feed address is resolved and guarded before any fetch: only
  public web addresses are allowed, so a feed can never point the
  server back at itself or at the private network. Feeds are checked
  for new posts when the app loads and when you tap Refresh.
- **Database** — the app's private Postgres database stores feeds and
  posts. Both tables are marked private to the app, and every query is
  scoped to the signed-in person's id.
- **Styling** — Tailwind CSS, precompiled by `npm run build`, in a
  light and a dark look that follow the viewer's Homeroom theme.

## Staging demo

With `?demo=1` on staging, the app seeds a viewing account with five
made-up feeds and sixteen made-up posts so the populated screen can be
seen without pointing at real sites. The made-up data shows only while
the flag is on the address: without it, the screen shows just the
account's own feeds. A line at the top of the screen says the feeds
and posts are made up.

## Development

- `npm run build` — recompile the stylesheet (the committed
  `public/tailwind.css` is built, not hand-edited).
- `npm test` — the feed-reading tests (parsing, discovery, the
  URL guard). They run offline.
- To change this app, ask Homeroom bot: open the app on Homeroom, tap
  the Homeroom icon in the header, then **Suggest an improvement**. You
  can also run Claude Code against this repo directly; start with
  `CLAUDE.md`, which carries the app-specific notes and points at the
  platform rules.