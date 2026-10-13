# RSS Reader

A feed reader, like Feedly: paste the address of a blog or news site,
follow its feed, and all the feeds you follow mix into one scrolling list
of unread posts, newest first. Tap a post to read a preview here and open
the full article in your browser; tapping it marks it read. Your feeds and
what you have read are private to you.

Built to run on [Homeroom](https://app.onhomeroom.com): people sign in with
their Homeroom account (the server verifies the platform-issued token on
every request) and each person has their own feeds and read state in the
app's private Postgres database.

## How it works

- **Server** (`server.js`, `feeds.js`) — Express. `feeds.js` holds the
  reader: fetching feeds safely (public web addresses only, with an
  SSRF guard), parsing RSS 2.0 / Atom / RSS 1.0 (RDF) with
  `fast-xml-parser`, and the API routes. Feed content is always rendered
  as plain text, never as HTML.
- **Client** (`public/app.js`) — fills the screen the spec drew with the
  platform's UI kit: the unread list grouped Today / Yesterday / Earlier,
  a preview sheet per post, a "Your feeds" sheet to add and remove feeds.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme. `public/screens.css` carries the screens the spec drew.
- **Staging demo** — with `?demo=1` in staging, the screen shows five
  invented feeds and fourteen posts so the reader can be seen without
  following anything; demo feeds are never fetched.

## Development

```sh
npm install
npm run build   # compile public/tailwind.css from the Tailwind config
npm test        # node --test: feed parsing and URL-guard unit tests
node server.js  # start locally
```