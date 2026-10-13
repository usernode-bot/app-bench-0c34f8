# Bread Bot

A bread recipe calculator on Homeroom. Pick a bread — sourdough, bagels,
sourdough bagels, rye or sandwich loaf — set the hydration, how many
loaves or bagels you want and how big each one should be, tap
**Calculate**, and get the exact grams of every ingredient, the rise
steps with their times, and the oven temperature and bake duration.

## How the maths works

Everything is baker's percentages of the **total flour** (F), the flour
in the final dough including what the starter brings:

- Total dough D = count × size
- F = D / (1 + hydration% + salt% + extras%) — the starter's flour is
  part of F, but it is *not* in the denominator, because the starter is
  flour and water already mixed (100% hydration)
- Starter = levain% × F, split evenly into flour and water, and that
  flour and water are subtracted from what you add by hand
- Rye splits its flour 70% rye / 30% bread, and the starter's flour
  counts toward the rye

The screen always shows a recipe for the current starting settings, and
marks it stale (faded, with a note) when the settings change until you
tap Calculate again.

## Layout

- `public/index.html` — the screen, originally drawn from the spec and
  now wired to data
- `public/app/recipe.js` — the pure recipe module: bread definitions,
  `calculate`, `validate`, `defaultsFor`, `formatGrams`, `bakeMinutes`
- `public/app/main.js` — screen wiring: state, controls, rendering
- `test/recipe.test.mjs` — unit tests (`npm test`), including the two
  worked examples from the spec
- `public/screens.css` — the drawn screen's own styles
- `styles/tailwind-input.css` + `tailwind.config.js` — the design kit;
  `npm run build` compiles the stylesheet
- `server.js` — static hosting, auth, and `GET /api/demo` (staging-only
  sample settings for `?demo=1`)

## Staging demo

On a staging preview, open `/?demo=1` to start from a sample bake
(2 sourdough loaves, 900 g each at 75% hydration) with a note that says
so. Production always serves the normal defaults.