# Block World

A shared 3D voxel building space on Homeroom, like a creative-mode block
game. Everyone in the project flies around one flat grass plain, places
and breaks blocks from a palette of six classic types (Grass, Stone,
Wood, Glass, Brick, Sand), and sees each other's builds appear as they go.

- **Fly** — drag to look around; on a phone a move pad plus fly up/down
  buttons, on a computer W A S D with Space (up) and Shift (down).
  No gravity, nothing to fall into.
- **Build** — pick a block from the palette of little 3D cubes, tap the
  grass or the side of any block to place it; switch to Break to remove
  one. Blocks snap to the grid, up to 32 high, over a 64 by 64 plain.
- **Together** — the world is shared and one for the whole project:
  blocks are stored in Postgres and broadcast live over Server-Sent
  Events, so everyone with the world open sees every change at once, and
  a note says who just built. Anyone signed in can build on or break any
  block, whoever placed it; the grass plain itself stays.

The world starts empty ("Nothing built yet"); on staging, `?demo=1` seeds
an idempotent demo: builds by Maya, Dev, Sam and Priya plus your own
half-finished brick wall.

## Running

`npm install`, then `node server.js` (or `npm start`). `npm run build`
compiles the Tailwind stylesheet. The app needs `DATABASE_URL` and, on
the platform, the usual `USERNODE_*` variables; visitors without a
Homeroom account can look around but not build.

## Layout

- `public/index.html` — the one screen: the world canvas, tools, move pad,
  palette and state panels.
- `public/app.js` — the three.js scene, controls, optimistic edits, SSE.
- `public/screens.css` — the screen's own styles, on the design kit's tokens.
- `server.js` — routes (`/api/world`, `/api/blocks`, `/api/stream`),
  schema migration, staging demo seeding.
- `styles/tailwind-input.css` + `tailwind.config.js` — the design kit.

`CLAUDE.md` carries the app-specific notes and the design description;
the platform conventions are at https://app.onhomeroom.com/claude.md.