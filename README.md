# RSS Reader

All your favourite sites' new posts in one list. Paste the link to a
site's RSS feed, and the app fetches it, lists every unread post newest
first, and previews a post in-app when you tap it (marking it read,
Feedly-style). A button opens the full article in your browser. Each
person keeps their own feeds.

## How it works

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. Visitors without a Homeroom account can look around
  read-only; adding feeds and marking posts read need an account.
- **Database** — the app's own private Postgres database holds two
  tables, `feeds` and `posts`. Both are marked **staging:private**: one
  person's feeds and posts are never another's, and staging demo data
  is written per viewer on first `?demo=1` visit.
- **Fetching** — feeds are fetched over plain HTTP(S) through one
  guarded function (`feeds.js`): default ports only, no credentials,
  DNS resolved and checked here (loopback, private, link-local,
  CGNAT, multicast and metadata addresses refused), the connection
  made to the checked address, at most 3 redirects re-checked the same
  way, 8 s and 2 MB caps. Feeds are parsed with fast-xml-parser for
  RSS 2.0, RSS 1.0 and Atom; summaries are stripped to plain text and
  shown as text, never HTML.
- **Styling** — Tailwind CSS, precompiled by `npm run build` with the
  design kit in `styles/tailwind-input.css`, in a light and a dark look
  that follow the viewer's Homeroom theme.

## Changing the app

Ask Homeroom bot: open the app on Homeroom, tap the Homeroom icon in
the header, then **Suggest an improvement**. You can also run Claude
Code against this repo directly; start with `CLAUDE.md`, which carries
the app-specific notes and points at the platform rules.