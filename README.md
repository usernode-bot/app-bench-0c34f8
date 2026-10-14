# Bread Bot

Turn bread choices into a recipe. Pick one of five breads (sourdough, bagels,
sourdough bagels, rye or sandwich loaf), set the hydration, choose how many
loaves or bagels and how big, tap **Calculate**, and get the grams of every
ingredient with each one's baker's percentage, the rise times, and the oven
temperature and bake time.

It is a calculator you fill in each time: nothing is saved or shared.
Everything runs in the browser — there are no API routes and no tables.

## How it works

- `public/bread.js` is the pure calculation: a `BREADS` table (default
  hydration, leaven, sizes, rise and bake schedules for each bread) and
  `calculate()`, which treats flour as the whole of the dough and every
  other ingredient as a share of it, and adjusts rise and bake for
  hydration.
- `public/app.js` wires the controls to it and renders the recipe into the
  screen's drawn layout, including the formula bars under each ingredient.
- `public/index.html` is the screen, with its styles split between
  `public/screens.css` (the drawn layout) and the design kit compiled to
  `public/tailwind.css` by `npm run build`.

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. You can also
run Claude Code against this repo directly; start with `CLAUDE.md`.
