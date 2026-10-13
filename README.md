# Bread Bot

Your personal bread recipe calculator. Pick a bread, set the dough, get
the recipe — no accounts, nothing saved, no database.

1. **Pick a bread** — sourdough, bagels, sourdough bagels, rye or
   sandwich loaf, each with its own ingredient percentages and defaults.
2. **Set the dough** — hydration (50–100%), how many loaves or bagels
   (1–24), and how much flour each one gets (50–3000 g).
3. **Tap Calculate** — the recipe card shows the grams of every
   ingredient with its baker's percentage, the total dough weight, and
   the steps in order: rises (adjusted for hydration), shaping and
   proofing, the boil for bagels, and the bake in °C and °F.

Change a setting after calculating and the card tells you it is stale —
tap Calculate again to update it.

## How it works

- `public/recipes.js` holds all the recipe maths as a pure module:
  the five breads, their baker's percentages, and how rise times bend
  with hydration and bake times with loaf size.
- `public/app.js` holds the screen: the state, the steppers, the field
  errors, the recipe card, and the staging `?demo=1` prefill.
- The app stores nothing. There are no tables; the database in the
  scaffold is unused.

## Platform notes

Sign-in, staging, and the precompiled Tailwind build (light and dark
look, following the viewer's Homeroom theme) are the platform's; see
`CLAUDE.md` for the app-specific notes and the hosted conventions for
the platform rules.