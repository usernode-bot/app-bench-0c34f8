# RSS Reader

One list of unread posts from your own RSS and Atom feeds, newest first.

- **Your feeds** — paste a feed address, and its posts land in your Unread
  list. Feeds are refreshed each time you open the list.
- **One unread list** — posts from all your feeds mixed together, newest
  first, with a masthead chip for the feed they came from.
- **Preview, then open** — tapping a post marks it read and opens a preview
  of what the feed shares, with a button for the full article in your
  browser.
- **Private** — feeds and read state are per member and stored in the app's
  own database tables, all marked `staging:private`.

## How it runs

- **Sign-in** — the server verifies the platform-issued user token (an RS256
  JWT) on every request; the app has no accounts of its own.
- **Database** — three private tables: `feeds`, `posts` and `post_reads`.
- **Styling** — Tailwind CSS, precompiled by `npm run build`, in a light and
  a dark look that follow the viewer's Homeroom theme. `CLAUDE.md`'s
  "## Design" describes the look.

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. You can also
run Claude Code against this repo directly; start with `CLAUDE.md`.