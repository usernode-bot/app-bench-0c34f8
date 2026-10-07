# Tier List

A shared board where a group ranks anything — restaurants, films, pizza
places — from S to F tier. One list per topic. Anyone can add new things to
rank; everyone drags them into the tier they think they belong in. Each
person sees their own placements and the crowd's view side by side, and can
open any thing to see exactly who voted for which tier.

## How it works

- **The board** — six tier bands, S to F, each led by a coloured letter
  tile. Drag a thing into a band (long-press on touch, drag on desktop), or
  tap it and use the **Move to** buttons in its sheet.
- **Yours / Crowd** — the toggle switches the same board between your
  placements and where most people put each thing, with a vote count per
  band. Ties go to the tier that comes first in S to F order.
- **Votes** — every thing's sheet lists each member's name next to the tier
  they put it in. Members can change their placement any time; the newest
  one wins.
- **Lists** — the picker at the top switches boards; **New list** starts one
  for another topic. The app boots with a sample list, Bay Area restaurants.

Guests (visitors without a Homeroom account) can look around the board but
need an account to add things or vote.

## Under the hood

- **Server** — `server.js`: Express with the platform's token auth, three
  public Postgres tables (`lists`, `items`, `placements` — one row per
  member per thing, so the newest placement is an upsert), and JSON APIs
  for lists, things and placements.
- **Client** — `public/index.html`, one page, no routing. Drag is pointer
  events (long-press lift on touch) plus HTML5 drag events on desktop; the
  item sheet, new-list prompt and toasts are the platform's native UI kit.
- **Styling** — the design kit in `styles/tailwind-input.css`: a warm gold
  accent over warm stone neutrals, one colour token per tier letter, light
  and dark looks that follow the viewer's Homeroom theme. `npm run build`
  compiles it to `public/tailwind.css` on every image build.

## Developing

`node server.js` against a `DATABASE_URL`; `npm run build` compiles the
stylesheet. `CLAUDE.md` carries the app's design notes and platform rules.