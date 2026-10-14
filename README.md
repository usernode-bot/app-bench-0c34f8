# Bread Bot

Your personal bread recipe calculator. Pick a bread — sourdough, bagels,
sourdough bagels, rye or sandwich loaf — set the hydration, how many loaves
(or bagels) and how much flour goes into each, and Bread Bot writes the
baker's formula sheet: grams for every ingredient with its baker's
percentage, how long to let it rise and at what temperature, and the oven
temperature and bake time.

Any recipe can be saved under a name and baked again later: saved recipes
are private to you, and reopening one restores its settings and recomputes
the formula.

## How it works

- The calculation runs entirely in the page (`public/formulas.js`), so it
  works for guests and offline; only saving, opening and deleting recipes
  touch the server.
- Recipes scale the baker's way, by flour weight: you set flour per loaf,
  total flour is loaves times that, and every other ingredient is a
  percentage of it. Hydration counts the added water only, not the water
  inside the starter.
- Rise and bake values start from each bread's standard percentages and
  shift slightly with hydration: a wetter dough rises a little faster and
  bakes a little longer.
- Temperatures are °C, weights are grams, rounded to the nearest gram.

## Development

- `npm run build` compiles `styles/tailwind-input.css` to
  `public/tailwind.css` (done on every image build).
- `npm start` runs `node server.js`; the platform signs user-identity
  tokens (RS256 JWTs) so the app always knows who is using it.
- Saved recipes live in the app's own Postgres database, in the
  `saved_recipes` table (`staging: private`).

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. You can also
run Claude Code against this repo directly; start with `CLAUDE.md`.
