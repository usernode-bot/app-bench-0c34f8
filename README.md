# Bread Bot

Your personal bread recipe calculator. Pick a bread — sourdough, bagels,
sourdough bagels, rye or a sandwich loaf — set the hydration, how many to
bake and how much dough each one weighs, and the whole recipe is worked out
in grams as you move the controls. No Calculate button: everything updates
live.

What you get for any choice:

- exact grams for every ingredient (flour, water, starter or yeast, salt
  and the rest), worked out with baker's percentages;
- the rise steps in order, with what to watch for and how long each takes;
- the bake temperature (°C and °F) and time, with the details that matter
  — lid on and off for sourdough, a boil first for bagels;
- a loaf cross-section whose blue water line rides up with hydration, so
  you can see how wet the dough is.

Grams only, no cups or spoons: a kitchen scale is the one tool this app
assumes.

## How it works

- `public/recipes.js` — the bread table and `calculate()`, a pure ES
  module. All percentages are of total flour; a starter counts as 100%
  hydration (half flour, half water), and its share comes off the first
  flour. Tested in Node with `npm test`.
- `public/app.js` — the screen: fills the drawn markup in
  `public/index.html` live on every input.
- Settings are remembered per bread kind in this browser
  (`localStorage`, key `breadbot:v1`). A staging demo (`?demo=1`) shows
  server-provided made-up settings instead, kept in memory only.
- Sizes from 50 to 3,000 g per loaf or bagel are accepted; anything else
  shows a clear message instead of a nonsense recipe.
- There is no database — the whole app is a calculation.

## Design

See `CLAUDE.md` ("## Design") for the palette and rules the screen
follows; the tokens live in `styles/tailwind-input.css` and
`public/screens.css`.

## Platform

The app runs on Homeroom: sign-in and theming are the platform's (see
`CLAUDE.md`), and `npm run build` precompiles the Tailwind stylesheet on
every image build.