# RSS Reader

A small RSS reader for Homeroom. Add the feeds you follow, then read
everything they have published recently in one scrolling list, newest
first. Each member's feeds and reading state are private to them.

## What it does

- **Add a feed** by its web address (an RSS or Atom feed URL). The
  server fetches it once to check it really is a feed, then saves it.
  If the address is not a feed, cannot be reached, or is already in
  your list, the sheet says so and keeps what you typed.
- **One unread list** mixes every feed's posts, newest first. Each row
  shows a masthead chip for its feed (the feed's first letter on one of
  five ink colours), the feed's name, how long ago it was published, the
  title, a two-line excerpt, and a dot while it is unread.
- **Tap a post** to open a preview: the feed, the date, the full text of
  the post, and a link to open the original article in your browser.
  Tapping a post marks it read; the row dims at once, and it is gone
  from the list the next time you open it.
- **Feeds sheet** lists what you follow, with a Remove button for each.
  A feed that could not be updated just now says so in the sheet.

## How it is built

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build.
- **Database** — the app's own private Postgres database. Four tables,
  each marked `staging:private`: `feeds`, `posts`, `post_reads` and
  `demo_removed_feeds`. Feeds, posts and read marks are per user.
- **Fetching** — posts refresh when you open the list, up to eight
  seconds per feed. If one feed cannot be reached, the rest of the list
  still loads and that feed carries the error into the Feeds sheet.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during
  image creation with either Kubernetes/Paketo or standalone Docker, in
  a light and a dark look that follow the viewer's Homeroom theme. The
  palette is warm paper neutrals with a deep teal accent; reading text
  is serif, the meta lines sans. See `CLAUDE.md` for the design notes.
- **Staging demo** — on staging, opening the app with `?demo=1` seeds a
  set of clearly made-up feeds and posts so the populated screen can be
  seen without real data.

## Changing this app

Open the app on Homeroom, tap the Homeroom icon in the header, then
**Suggest an improvement**, and describe what you want in plain
English. You can also run Claude Code against this repo directly;
start with `CLAUDE.md`, which carries the app-specific notes and points
at the platform rules.
