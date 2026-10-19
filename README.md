# Ear Trainer

Learn to hear relative notes, chords and chord progressions.

Pick a lesson type (Notes, Chords or Progressions), then a level. Each
level starts with a few very different sounds and adds closer-sounding
ones until, at level 5, you are asked about the full set of twelve. Tap
the round play button to hear the question, then tap the option you
heard. An item is mastered after three right answers in a row, and the
chord ladder fills a rung for each one.

Progressions come from a starter list of well known songs and hymns,
each played in a random key as plain piano-like chords made in the
browser. No recordings are used.

## Running it

```sh
npm install
npm run build   # compiles public/tailwind.css from styles/tailwind-input.css
npm start       # node server.js
```

The app runs inside Homeroom: the platform injects the signed-in
person's identity token (`?token=` on the iframe load, or the
`x-usernode-token` header at the app's own address), and `server.js`
verifies it. Guests can play; their progress is kept in the page only.

Progress is stored in Postgres (`DATABASE_URL`) in the `progress` table,
which is marked `staging:private`. The `?demo=1` staging preview shows
the viewer's own made-up progress.
