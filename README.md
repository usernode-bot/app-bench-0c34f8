# Bread Bot

A bread recipe calculator for Homeroom. Pick a bread, set your dough, and
the screen works out the grams and the timings.

## What it does

- **Five breads:** Sourdough, Bagels, Sourdough bagels, Rye and Sandwich
  loaf, as chips at the top of the screen.
- **Dough controls:** a hydration slider (50-90%), a count stepper
  (1-12 loaves or 1-24 bagels) and a size selector (450/680/900 g/1 kg for
  loaves, 90/110/130 g for bagels, or a Custom grams field for 50-3000 g).
- **Live recipe:** everything updates as you change a control. It shows
  the total dough weight, every ingredient in grams with its baker's
  percentage, a rise schedule strip (Mix, First rise, Proof, Bake, sized
  by how long each takes), and the bake: °C with °F underneath, time, and
  a per-bread note.
- **Copy recipe:** puts plain text of the whole recipe on the clipboard,
  with a "Recipe copied" toast. If copying is refused, the toast says so
  and the recipe stays on screen.
- **Invalid custom size:** a blank or out-of-range size shows
  "Enter a size from 50 to 3000 g to see the recipe" and Copy is disabled.
  Nothing made-up renders.

## How the maths works

Baker's percentages, one table per bread (`public/recipes.js`). Total
flour is `dough / (1 + hydration + salt + yeast + extras)`. Hydration is
the whole dough's (the starter's flour and water counted in), so the
water line is what you actually add, and a starter adds nothing to the
denominator: its grams are carved out of the added flour and water.
Ingredients sum exactly to the dough weight.

## Files

- `server.js` — Express: auth (platform JWTs, guest read-only), the
  hosted platform assets, the HTML shell.
- `public/index.html` — the screen's markup (the drawn template, wired).
- `public/app.js` — state, controls, rendering, copy, staging demo.
- `public/recipes.js` — the bread tables and the pure calculation.
- `public/screens.css` — the screen's own styles (drawn components).
- `styles/tailwind-input.css`, `tailwind.config.js` — the design kit.

## Design

One look that follows the viewer's Homeroom theme (light and dark).
Crust-brown accent, wheat gold for the rise strip (never for text),
rounded face for headings and big numbers. See `CLAUDE.md` for the
tokens.

## Staging demo

On a staging preview, open `/?demo=1`: the screen presets itself to two
900 g sourdough loaves and says so in one line under the title. It
changes nothing else and writes nothing.
