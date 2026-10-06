# Tier List

A shared tier list for ranking things with friends — Bay Area restaurants
today, anything tomorrow. Anyone in the project adds an item to rank, then
everyone drags it into the tier they think it belongs in, from S down to F.

- **Add** — type a name and tap Add; the item appears for everyone, starting
  in Not ranked yet.
- **Rank** — drag a chip into a tier row on desktop; on a phone, step it
  with the chip's Move up and Move down buttons. Your board saves as you go,
  and changing your mind just overwrites your tier.
- **Compare** — switch between Your list and Crowd list. The crowd tier is
  where most people put an item (a tie goes to the higher tier); items
  nobody has voted on sit in Not ranked yet.
- **Who voted what** — tap any item to see each person's tier for it, your
  own marked, and the crowd tally.

Guests can look at the board but not rank; ranking needs a Homeroom account.

## How it runs

- Express + Postgres, signed in through Homeroom's iframe token (no accounts
  of its own). Two tables: `items` (one row per thing to rank) and
  `placements` (append-only votes; the highest `id` per person per item
  wins). Both public — they carry names, nothing sensitive.
- Tailwind is precompiled by `npm run build` during image creation into
  `public/tailwind.css`, in a light and a dark look that follow the viewer's
  Homeroom theme. The kit lives in `styles/tailwind-input.css`; the app's
  look is written down in `CLAUDE.md` under "## Design".
- A staging-only seed fills the board with obviously fake restaurants
  (Birch & Vine and friends) so a fresh preview is populated.

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**, and describe
the change in plain English. You can also run Claude Code against this repo
directly; start with `CLAUDE.md`.