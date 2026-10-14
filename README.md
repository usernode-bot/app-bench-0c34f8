# RSS Reader

All your favourite sites' new posts, in one list. Add the RSS or Atom feed
of a site (or just the site's address and the app finds the feed), and every
unread post shows up in one scrolling list, newest first, grouped by day.
Tap a post for a preview and a link to open the full article in the browser.
Feeds are per user: everyone follows their own.

## How it works

- **One screen.** The Unread list. The add-feed field sits at the top,
  a "Following N feeds" line opens the Manage feeds sheet, and posts are
  grouped under Today, Yesterday and dates.
- **Marking read.** Opening a post's preview marks it read: its feed symbol
  turns grey and the title fades. The row stays until the app is opened
  again. There is no unread state kept server-side beyond `read_at`.
- **Fetching.** The server fetches feeds on page load (feeds not checked in
  the last two minutes refresh in parallel) and stores the latest 50 posts
  per feed. `lib/feeds.js` does the guarded fetching (http/https only,
  private and loopback addresses refused, 8s timeout, 2MB cap) and parses
  RSS 2.0 and Atom with plain string handling. No new packages.
- **Auth.** The platform's iframe token identifies the viewer; all data is
  per user. Both tables (`feeds`, `posts`) are marked `staging:private`.

## Staging demo

On staging, `/?demo=1` shows the populated screen with four made-up feeds
and their posts (one deliberately "failing"), so the list, previews and
manage sheet can be seen without adding real feeds. Adding, previews and
removals work in the demo too.

## Design

Orange, drawn from the RSS feed symbol (a dot with two broadcast arcs),
on cool clean greys. Post titles and preview text are serif; everything
else is the system sans. The feed symbol is the signature element: it
appears beside each post (orange when new, grey when read) and as the
favicon. Everything is built from the design kit's colour tokens in
`styles/tailwind-input.css`, in a light and a dark look that follow the
viewer's Homeroom theme.

## Development

`node server.js` serves the app; `npm run build` compiles the stylesheet
(Tailwind precompiled per app, see `CLAUDE.md` and the hosted platform
conventions for the platform rules).
