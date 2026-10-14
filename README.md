# Bread Bot 🍞

Your personal bread recipe calculator. Pick a bread — sourdough, bagels,
sourdough bagels, rye or a sandwich loaf — set the hydration, how many
loaves and how big each one is, then tap **Calculate**. Bread Bot works out
the grams of every ingredient, the baker's percentages, how long to let it
rise, and the oven temperature and bake time.

## How it works

- Everything runs in the page: the recipe rules are `RECIPES` in
  `public/app.js` and the calculation is a pure function. There is no
  server route, no table and no storage — each visit calculates fresh.
- Grams and degrees Celsius only. Bake times adjust to loaf size.
- The built-in recipes are standard baker's percentages: a starting point
  to adjust later.

## Building and styling

Styling is Tailwind, precompiled by `npm run build` (Docker or Paketo runs
it on every image build) into `public/tailwind.css`, in a light and a dark
look that follow the viewer's Homeroom theme. The palette and components
live in `styles/tailwind-input.css`; see `CLAUDE.md` under "## Design".

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**, and describe
the change in plain English. You can also run Claude Code against this
repo directly; start with `CLAUDE.md`.
