# RSS Reader

A personal RSS reader on the Feedly model, built on Homeroom. You add your
own RSS or Atom feeds, and the app shows every unread post from all of them
in one scrolling list, newest first. Tapping a post marks it read and opens
a preview with the article's text and images from the feed itself, plus an
**Open full article** link for the rest. Each person's feeds are their own:
the `feeds` and `posts` tables are per-user and marked `staging:private`.

## How it works

- **Sign-in** — the server verifies the platform-issued user token (an
  RS256 JWT) on every request, so the app already knows who is using it.
  Signed-out visitors can look around read-only; marking a post read needs
  an account.
- **Feeds** — added by URL from the **Add feed** button. The server fetches
  and parses the feed itself (`feed-parse.js`, no new npm dependencies:
  RSS 2.0 and Atom, a 10-second timeout, a 2 MB body cap, at most three
  redirects) and stores its posts. A feed that stops answering shows a
  **Couldn't reach** line with **Retry** in the **Feeds** sheet and never
  breaks the list.
- **Reading** — posts are marked read the moment they are tapped to
  preview; read posts leave the unread list for good. Feeds refresh when
  the app opens, or by pulling the list down.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme. The design (deep teal accent over warm neutrals, the teal unread
  dot as the signature element) is written down in `CLAUDE.md`.
- **Staging previews** — the private tables start empty, so a fresh
  preview would show only the empty state. Open the app with `?demo=1` to
  see the populated screen with obviously fake feeds and posts
  ("Staging demo …") served from memory, without touching the database.

## Development

`npm run build` compiles `styles/tailwind-input.css` to
`public/tailwind.css` (the Dockerfile does this on every image build).
`npm start` runs the app on port 3000 against `DATABASE_URL`. The automated
checks live in `dapp.json`'s `tests` array. App-specific notes and the
design record are in `CLAUDE.md`; the platform-wide rules are at
https://app.onhomeroom.com/claude.md.