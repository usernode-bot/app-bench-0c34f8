# Bread Bot

Pick a bread, set the dough, get the recipe. One screen: choose one of
five breads (Sourdough, Bagels, Sourdough bagels, Rye, Sandwich loaf),
set the hydration, how many loaves or bagels, how much each weighs, and
tap **Calculate**. Bread Bot answers with the baker's formula in grams
of every ingredient, the rise stages with their times and where they
happen, and the bake temperature and time.

The maths runs in the browser, from the baker's percentages each bread
carries in `public/bread.js`. Nothing is saved and nothing is sent
anywhere.

## How it fits together

- `public/bread.js` — the recipe data and maths, pure and DOM-free.
- `public/app.js` — wires the drawn screen's inputs to the maths and
  renders the results back into its rows.
- `public/index.html`, `public/screens.css` — the screen, as the spec
  drew it.
- `styles/tailwind-input.css`, `tailwind.config.js` — the palette (both
  looks) and type scale, compiled to `public/tailwind.css` by
  `npm run build`.
- `server.js` — serves the app, verifies the platform-issued user token,
  shuts down cleanly on SIGTERM/SIGINT.

## Staging demo

On staging, open the app with `?demo=1` to see it pre-filled with a
sample Sourdough calculation, labelled "Staging demo: sample settings
filled in, nothing is saved."

## Platform

This app runs on Homeroom; `CLAUDE.md` points at the platform rules.
