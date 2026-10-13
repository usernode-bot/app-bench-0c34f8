# Bread Bot 🍞

Your personal bread recipe calculator. Pick one of five breads — sourdough,
bagels, sourdough bagels, rye or a sandwich loaf — set the hydration, how many
loaves or bagels you're baking and how big, and the screen answers live (there
is no Calculate button):

- **Ingredients** in grams, per bread, scaled to your dough.
- **The dough bar** — flour against water — moving with the hydration slider.
- **Bake** temperature and time, scaled to loaf size.
- **A full timeline** from mixing to cooling, with clock offsets from when you
  start.

Everything is computed in the page; nothing is stored. The maths live in
`public/app/bread.js` (pure, no DOM) with their tests in `test/bread.test.mjs`
(`npm test`); the screen wires them up in `public/app/main.js`.

## Running it

- `npm run build` compiles the Tailwind stylesheet (also done on every image
  build).
- `npm test` runs the maths tests.
- `npm start` serves the app; staging previews open with `?demo=1` to show a
  worked example bake.

## How to change this app

Ask Homeroom bot: open the app on Homeroom, tap the Homeroom icon in the
header, then **Suggest an improvement**, and describe the change in plain
English. You can also run Claude Code against this repo directly; start with
`CLAUDE.md`, which carries the app-specific notes and points at the platform
rules.