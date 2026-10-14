# RSS Reader

An RSS reader for Homeroom, in the spirit of Feedly: add the RSS or Atom
feeds of sites you like and see all their unread posts in one scrolling
list, newest first. Tapping a post opens an inline preview, with a link to
read the full article in the browser. Marking a post read happens the
moment you tap it. Each person's feeds are private to them.

## How it works

- **One screen, Unread** — posts from every feed you follow, unread only,
  newest first. The list refreshes when the app opens, when you come back
  to it, and from the Refresh button in the header.
- **Add feed** — the sheet takes a feed address; the server fetches it
  (guarded fetch: public hosts only, 10 s timeout, 2 MB cap, redirects
  re-checked) and verifies it really parses as RSS 2.0, RSS 1.0 or Atom
  before saving. If it does not, the sheet says so and keeps what you
  typed.
- **Tap to read** — the first tap on a post expands the preview and marks
  it read at once (the orange dot becomes a ring); the post leaves the
  list on the next load. "Open article" opens the real article in a new
  browser tab.
- **Feeds** — the Feeds sheet lists your feeds by name and address, each
  with a Remove (confirmed). A feed that failed to load says so in the
  sheet and as a line under the header, with a Retry link; one bad feed
  never takes down the whole list.
- **Staging demo** — on staging, opening the app with `?demo=1` adds four
  made-up feeds and about twenty posts so the screen can be seen
  populated; everything on it works. Demo feeds never appear without the
  flag.

## Data

- `feeds` — one row per followed feed (private to its owner; the table is
  marked `staging:private`): user, address, title, site, a `demo` flag and
  the last fetch error.
- `read_marks` — which posts of which feed you have read, keyed by the
  feed's guid; removed with their feed.

## Development

- `npm run build` compiles the Tailwind stylesheet (`styles/tailwind-input.css`
  → `public/tailwind.css`); the image build runs it, so nothing compiled is
  committed.
- `npm start` runs the server (`node server.js`); the schema is created on
  boot.
- The frontend is plain ES modules in `public/` (no build step), using the
  platform's UI kit in `public/kit/`.

Platform rules live in the hosted conventions at
https://app.onhomeroom.com/claude.md; app-specific notes are in `CLAUDE.md`.
