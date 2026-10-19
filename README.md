# Tier List

A shared tier board for ranking things with friends. One list at a time
(the first is Bay Area restaurants), six tier rows, S through F. Everyone
drags each thing into the tier where they think it belongs: your
placements are your own votes, never a shared final ranking. Next to your
board, the crowd's view places every thing at its crowd average, and each
thing's detail shows who added it, every person's vote by name, and the
average.

Anyone can add new things to rank, and anyone can start a new list for
something else (a name, and what one thing on it is called, like
"movie"). Whoever starts a list can remove it; anything can be reported,
and reports are recorded only.

## How it runs

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request. Guests can look around read-only;
  every write needs an account.
- **Database** — Postgres: `lists`, `items`, `votes` (one row per person
  per item, primary key `(item_id, user_id)`), `reports` and
  `demo_seeded`, all public tables, schema applied idempotently on boot.
- **Styling** — Tailwind CSS, precompiled by `npm run build` at image
  build time, in a light and a dark look that follow the viewer's Homeroom
  theme. The tier band colours are kit tokens (`tier-s` … `tier-f`).
- **Staging demo** — on staging only, `?demo=1` seeds a populated demo of
  the Bay Area restaurants list for the viewer, once, with three made-up
  friends' votes and the viewer's own nine votes already in.

`npm start` runs `node server.js`; `npm run build` compiles the
stylesheet. See `CLAUDE.md` for the app's design notes.