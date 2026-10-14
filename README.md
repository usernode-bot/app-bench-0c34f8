# Bread Bot

Your personal bread recipe calculator. Pick a bread — sourdough, bagels,
sourdough bagels, rye or sandwich loaf — set the hydration, how many
loaves or bagels you're baking and how much flour goes into each piece,
and get a baker's formula sheet: grams for every ingredient with the
baker's percentages (flour at 100% on top), plus rise time and
temperature, oven temperature and bake time.

Recipes you like can be saved, reopened and deleted, so next weekend's
bake is two taps away.

## How it works

- **The maths is client-side.** `public/formulas.js` holds the five
  breads' baker's percentages and computes every formula in the page —
  nothing goes to the server to calculate. Recipes are saved as just the
  four settings plus a name; the formula is recomputed from them every
  time, never stored.
- **Scaling is by flour weight.** The number you set is the flour in each
  loaf or bagel; every ingredient scales from that.
- **Saved recipes** live in the app's own Postgres database
  (`saved_recipes`, staging:private). Sign-in is the platform's — the
  server verifies the platform-issued token (an RS256 JWT) on every
  request, and every write needs an account.
- **Styling** is Tailwind CSS, precompiled by `npm run build` during
  image creation, in a light and a dark look that follow the viewer's
  Homeroom theme. The palette (flour whites, warm browns, wheat gold)
  is in `styles/tailwind-input.css`.

## Hydration, briefly

Hydration counts the **added water only**, not the water inside the
starter. Rye's 100% is a mix: 60% rye flour, 40% bread flour. Wetter
dough rises a little faster and bakes a little longer: per 5 hydration
points above the bread's default, rise drops 5% and bake gains 2 minutes
(mirrored below the default).

## To change this app

Ask Homeroom bot: open the app on Homeroom, tap the Homeroom icon in the
header, then **Suggest an improvement**. You can also run Claude Code
against this repo directly; start with `CLAUDE.md`, which carries the
app-specific notes and points at the platform rules.

## Not in this version

Fahrenheit and ounces, editing or renaming saved recipes, custom
ingredients, starter water counted in hydration, bake timers and sharing.