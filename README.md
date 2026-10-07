# Bread Bot

A bread recipe calculator. Pick a bread (sourdough, bagels, sourdough
bagels, rye, sandwich loaf), set the hydration, how many loaves or bagels
and how big each one is, and the app shows the grams of every ingredient
plus a rise-and-bake plan, updating as you type.

## How the math works

All recipe numbers come from the `BREADS` table in `public/index.html`
and the baker's percentages around it — no AI, no server calls, nothing
saved:

- Hydration is water (or water and milk) as a percent of the total flour,
  settable from 50 to 100%.
- Total dough is count × size; flour = total dough ÷ (100% + hydration +
  salt + enrichments).
- The two sourdough breads use a 1:1 flour-water starter at 20% of the
  total flour, included in the flour and water totals; the others use
  instant yeast.
- Salt is 2% of the flour. Bagels get 2% sugar; the sandwich loaf gets 8%
  butter and a half-milk liquid. Rye is 60% rye flour, 40% bread flour.
- Rise times come from a per-bread table, adjusted ~2% per hydration point
  away from the bread's default (clamped to ±30%, rounded to 15 minutes).
  Bake times scale with loaf size (cube root), rounded to 5 minutes.

## Run locally

```sh
npm ci --include=dev
npm run build
npm start
```

Then open http://localhost:3000. Styling is Tailwind CSS, precompiled by
`npm run build` during image creation, in a light and a dark look that
follow the viewer's Homeroom theme.
