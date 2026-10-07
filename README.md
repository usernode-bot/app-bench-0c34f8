# Tier List

Rank anything with your group, from Bay Area restaurants to movie night
picks. Anyone can create a list and add items to it; everyone drags each
item into their own S to D tiers, and the crowd's ranking sits beside
yours. Open any item to see exactly who put it where.

## How it works

- **Lists** — one per topic ("Bay Area restaurants", "Movies for movie
  night"). The name at the top is a button: tap it to switch lists or start
  a new one.
- **Your tiers** — the ladder runs S (red) through D (green). Every item
  starts in the "Not ranked yet" tray; drag it into a row to rank it, drag
  it again to change your mind, or drag it back to unrank it. Everything a
  drag does can also be done by tapping an item and using the tier buttons.
- **Crowd** — the same ladder showing the tier most people picked for each
  item, with your own choice beside it.
- **Who put it where** — every item opens to its votes by name, tier by
  tier.
- Other people's votes appear every 20 seconds, when you come back to the
  app, and on pull to refresh.

## Try it

The staging preview opens with `?demo=1` on a ready-made demo: two fake
lists with votes from made-up people, and 11 restaurants already ranked by
you, so the ladder is full and differs from the crowd's in places. Without
the demo, a fresh app opens on "Start your first tier list".

## Plumbing

- **Sign-in** — the server verifies the platform-issued user token (an
  RS256 JWT) on every request, so the app already knows who is using it.
  Writes need an account; guests can look around read-only.
- **Database** — the app's own Postgres: `lists`, `items`, `placements`
  (one vote per person per item) and `demo_viewers` for the staging demo.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme. The design kit lives in `styles/tailwind-input.css`; the app's
  look is written down in `CLAUDE.md` under "## Design".
- **Tests** — `npm test` runs the crowd-tally unit tests;
  `dapp.json`'s `tests` run as browser checks on every proposal.