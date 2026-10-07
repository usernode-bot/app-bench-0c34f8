# Bread Bot

A bread recipe calculator, built on Homeroom. Pick a bread type (sourdough,
bagels, sourdough bagels, rye, sandwich loaf), set the hydration, how many
loaves and how big, and tap Calculate: you get every ingredient in grams, a
baking plan (rise, oven temperature, bake duration, plus a boil step for
bagels), and a proofing timeline from mix to bake.

The maths runs entirely in the page from standard baking ratios — flour
from dough weight and hydration, 2% salt, instant yeast or a 100%-hydration
starter per type — so there is no backend logic, no accounts and nothing
saved. Each calculation is fresh.

## Running it

- `npm run build` compiles `styles/tailwind-input.css` to
  `public/tailwind.css` (the image build does this too).
- `npm start` serves the app.
- `node --test tests/recipe.test.js` runs the unit tests for the recipe
  maths.

## Design

The app's look — palette, type and the proofing timeline signature element —
is written down in `CLAUDE.md` under `## Design`; later changes follow it.
Light and dark both follow the viewer's Homeroom theme.
