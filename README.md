# Bread Bot

Your personal bread recipe calculator. Pick one of five breads — sourdough,
bagels, sourdough bagels, rye or sandwich loaf — set the hydration, how many
loaves and how big, and tap Calculate: every ingredient in grams with its
baker's percentage, the rise steps, and the bake temperature and time, laid
out like a baker's formula with flour at 100%.

## How it works

- The five formulas and the calculator live in `public/breads.js` (pure
  maths, no DOM); `public/app.js` fills and wires the screen.
- Everything is worked out on the phone itself: no accounts, no database,
  nothing saved. The server only serves the page (and verifies the
  platform's token, as every Homeroom app does).
- Loaf size is the dough weight per loaf in grams; amounts are in grams
  only. Temperatures show Celsius with Fahrenheit alongside.
- The staging preview (`?demo=1` on staging) opens with a sample recipe
  already calculated and a "Staging demo" line; every control works as
  normal and nothing is stored.

## Styling

Tailwind CSS, precompiled by `npm run build` during image creation, in a
light and a dark look that follow the viewer's Homeroom theme. The palette
(flour and crust) and the baker's-formula signature are written down in the
`## Design` section of `CLAUDE.md`.

## Changing the app

Ask Homeroom bot: open the app on Homeroom, tap the Homeroom icon in the
header, then **Suggest an improvement**. You can also run Claude Code
against this repo directly; start with `CLAUDE.md`, which carries the
app-specific notes and points at the platform rules.