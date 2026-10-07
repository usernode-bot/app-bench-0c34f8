# Tier List

Rank anything with friends, from S to F. A shared tier board: anyone adds a
thing to rank (a bay area restaurant, a film, anything), everyone drags the
chips into their own tiers, and the crowd's shared ranking sits one toggle
away.

- **Rank it**: drag a chip from the *To rank* pile into one of six tier
  rows, S down to F. Dragging it again moves it, so a placement is never
  stuck. The item sheet also has tier buttons, so placing works without
  dragging too.
- **See the crowd**: the toggle at the top switches between *My tiers*, your
  own placements, and *Crowd*, one averaged tier per item in the same rows.
- **See the votes**: tap any item to see how each person placed it, with the
  crowd's average at the top.

Sign-in comes from Homeroom (the platform verifies who you are; no accounts
to set up here). Guests can look around; adding and placing ask for a
Homeroom account. Staging is seeded with obviously fake demo restaurants so
the populated board can be seen.

## For developers

The stack is small: Express + Postgres (`items` and `placements` tables,
schema applied on boot in `server.js`), and one static screen in
`public/index.html` that talks to four `/api` routes. Tailwind is
precompiled by `npm run build` (Docker or Paketo) into `public/tailwind.css`
from the design kit in `styles/tailwind-input.css`; the app's look is
written down in `CLAUDE.md` under **## Design**.

To run it locally: `npm ci`, `npm run build`, then `node server.js` with
`DATABASE_URL` set. The platform conventions at
<https://app.onhomeroom.com/claude.md> cover auth, staging and theming.