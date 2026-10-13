# RSS Reader

A calm, Feedly-style RSS reader: add the feeds you like, and every unread
post from all of them shows up in one scrolling list, newest first. Tap a
post and its article opens right where it sits — text and pictures, with a
link to the full article on the source site. Reading a post marks it read.

- **One unread list** — an orange dot beside every unread post, the site's
  name beside it, and a count up top. Read posts lose the dot and fade.
- **Tap to read** — the article opens inline where the post sits, so you
  never lose your place. One post open at a time.
- **Your feeds are yours** — feeds and posts are private to each account;
  guests see an empty list.
- **Staging demo** — on staging, `?demo=1` shows four made-up feeds and
  sixteen made-up posts, labelled "Staging demo", so the populated screen
  can be seen without fetching anything.

Feeds are fetched by the server through a strict guard (http/https only,
public addresses only, size and time caps) and article HTML is sanitized
server-side, so pasted feed content can only ever show text, links and
https pictures.

## Run it

`npm install`, then `node server.js` (needs `DATABASE_URL` and the platform
JWT variables — on Homeroom these are injected). `npm run build` compiles
the Tailwind stylesheet during image build.

Start with `CLAUDE.md` for the app-specific notes; it points at the
platform rules.