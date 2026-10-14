# RSS Reader

Follow your favourite feeds in one scrolling list. RSS Reader is a personal
reader on Homeroom: you add the RSS or Atom feeds you want, and it shows
every unread post from them in one list, newest first, grouped by day.
Tapping a post opens a preview of it (the summary the feed shares), with a
button that opens the full article in your browser. Each person's feeds and
read posts are their own: nobody else in the project can see them.

## How it works

- **Unread** — opening the app refreshes your feeds and lists every unread
  post under Today, Yesterday and then the date. A post counts as read once
  you tap it; it stays where it is until you leave, and is not listed again
  next time.
- **Add feed** — paste the feed's address. The app checks it is really a
  feed, saves it under its own name and shows its posts straight away.
- **Feeds** — your feeds with their addresses; Remove takes a feed, and its
  posts, off your list after you confirm.
- **Private** — your feeds and reads are stored per person and never shared.

## Technical notes

- `server.js` is an Express app with Postgres (`feeds` and `posts`, both
  `staging:private`), feed fetching through a SSRF guard (http/https only,
  checked addresses, 3 redirects, 10 s timeout, 2 MB limit) and parsing via
  `fast-xml-parser` (RSS 2.0, RSS 1.0 and Atom).
- On staging, `?demo=1` seeds the viewer six made-up feeds and about twenty
  posts so the populated screen can be seen; demo feeds are never fetched
  and every response without `?demo=1` leaves demo rows out.
- Styling is Tailwind, precompiled by `npm run build` at image build, in a
  light and a dark look that follow the viewer's Homeroom theme. The design
  kit and this app's look are described in `CLAUDE.md` under "## Design".

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**, and describe
the change in plain English. You can also run Claude Code against this repo
directly; start with `CLAUDE.md`.