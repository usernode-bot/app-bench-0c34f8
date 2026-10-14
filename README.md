# Bread Bot

Pick a bread, set the hydration and how much you're baking, and get the
recipe in grams: ingredients, rise times, and bake temperature and time.

- **Five breads** — sourdough, bagels, sourdough bagels, rye and sandwich
  loaf, each with its own defaults (hydration, loaf count and size) that
  load when you pick it.
- **Hydration dial** — a baker's scale from 50% to 90% with the bread's
  usual range shaded in, plus a slider for fine steps. The line under it
  says what the number means: grams of water per 100 g of flour.
- **The recipe** — worked out live in the browser from baker's
  percentages (salt 2% of flour, starter half flour half water and counted
  in the totals, rye 60/40 with bread flour, bagels get malt or sugar,
  sandwich loaf gets yeast, sugar and butter). Rise times shift with
  hydration (wetter dough rises faster); bake times shift with loaf size.
  Nothing is stored and nothing is fetched after load.

## How it's built

- `public/recipes.js` — the per-bread table and the pure calculator. No
  DOM, no state: `calculate({ type, hydration, count, size })` in,
  recipe rows out.
- `public/app.js` — the screen's behaviour: dial geometry, chips,
  stepper, size choices, and filling the drawn recipe rows. The screen
  markup is drawn in `public/index.html` and styled in
  `public/screens.css` from the design kit in `styles/tailwind-input.css`.
- Grams and °C only; whole grams, one decimal under 10 g.

## Notes

- The recipe area has three states: empty before the first calculation,
  stale when settings change after one, and the calculated recipe.
- On staging with `?demo=1` the screen opens pre-set to sourdough at 75%,
  2 loaves of 800 g, already calculated, and labelled "Staging demo".
- To change this app, ask Homeroom bot: open the app on Homeroom, tap the
  Homeroom icon in the header, then **Suggest an improvement**. You can
  also run Claude Code against this repo directly; start with
  `CLAUDE.md`, which carries the app-specific notes and points at the
  platform rules.
