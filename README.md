# Tier List

Rank anything with friends, from S tier down. Everyone in the group ranks
the same items into five tiers, S to D, and can compare their own
placements with the crowd's and with each person's.

- **Your tiers** — drag an item chip into the band you think it belongs in,
  or tap the chip and pick a tier from the buttons. Only you change your
  own placements.
- **Crowd** — each item sits in the tier most people chose, with the vote
  count on its chip. A tie goes to the topmost tier.
- **Who put it where** — tap any item to see the counts per tier, every
  person's placement, and to set your own without dragging.
- **Add and share** — anyone can add a new item for everyone to rank, and
  anyone can start a new list (the first one is Bay Area restaurants).

Sign-in goes through Homeroom automatically: the server verifies the
platform-issued user token on every request, so there are no accounts to
build. Visitors without an account can look at everything but are asked to
make an account when they try to place or add.

## How it works

- **Server** — a small Express app (`server.js`) with a Postgres database
  and six routes: list, create, and read lists; add items; read an item's
  tally; and place an item. Placements are **append-only**: a move inserts
  a row, and the latest row per item and person is that person's tier, so
  the history stays.
- **Front end** — one page (`public/index.html`), vanilla JS, with drag by
  Pointer Events (one path for touch and mouse) and the item detail sheet
  as the no-drag fallback.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme. The palette (deep amber accent, warm stone neutrals, five tier
  hues) is described in `CLAUDE.md` and lives in `styles/tailwind-input.css`.

## Developing

- `npm start` runs the server (`PORT`, `DATABASE_URL`).
- `npm run build` compiles `styles/tailwind-input.css` to
  `public/tailwind.css` (the image build does this for you).
- Staging boots with a seeded demo list, "Staging demo: Bay Area
  restaurants", with fake items and placements, so the board has something
  to show.
