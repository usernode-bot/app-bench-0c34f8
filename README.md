# Bread Bot

Bread Bot turns four choices into a home-baking recipe: pick a bread
type, set the hydration, how many loaves and how big, and it works out
the ingredient weights in grams, the rise stages from mix to bake, and
the oven temperature and time.

## What it calculates

- **Five bread types** — Sourdough, Bagels, Sourdough bagels, Rye and
  Sandwich loaf, each with its own rise stages, bake temperature and
  duration.
- **Ingredients in grams** — flour solved from the total dough weight
  (loaves × loaf size), water set by the hydration percentage, salt
  always at 2% of the flour weight, and either a 1:1-fed starter (the
  sourdough types) or dry yeast (the rest). Water is reduced by the
  starter's own flour and water so the set hydration stays true for the
  whole dough.
- **Rise and bake** — a timeline of the five stages (Mix, Rise, Shape,
  Proof, Bake) with each stage's duration, plus the oven temperature in
  Celsius and Fahrenheit and how the loaf is baked (covered, boiled,
  on a stone or in a pan).

Hydration clamps to 50–100%, loaves is a whole number from 1, and loaf
size clamps to 100–5000 g. The recipe is computed on the spot and
nothing is stored, so the app works the same signed in or as a guest.

## Development

A small Express server serving one static page; all calculation is
client-side (`public/app.js`) and the database the template ships is
unused. Styles are Tailwind, precompiled by `npm run build` during the
image build, in a light and a dark look that follow the viewer's
Homeroom theme. The design brief lives in `CLAUDE.md` under "## Design".