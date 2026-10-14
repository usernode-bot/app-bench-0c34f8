# Bread Bot

Pick a bread, set your dough, get the recipe. Bread Bot is a personal
bread recipe calculator: choose one of five breads (sourdough, bagels,
sourdough bagels, rye, sandwich loaf), set the hydration, the count and
size of the loaves or bagels, and it works out the grams of each
ingredient, the rise times, and the bake temperature and time.

## How it works

The screen is one page. The bread chips, hydration slider, count
stepper and size segments all redraw the formula card immediately —
there is no Calculate button. The recipe itself is pure maths:
baker's percentages over the total dough weight, with a 100%-hydration
starter contributing half its weight as flour and half as water for the
sourdough breads. Nothing is stored and nothing is fetched; the app has
no database tables and no API endpoints.

## Development

- `node server.js` serves the app (static files plus the auth-gated
  HTML shell); `npm run build` recompiles `public/tailwind.css` from
  `styles/tailwind-input.css`.
- `public/bread.js` is the recipe engine, with no DOM in it — the
  screen behaviour in `public/app.js` fills the drawn screen in
  `public/index.html` from its `calc()`.
- `CLAUDE.md` carries the app-specific notes and points at the
  platform rules.
