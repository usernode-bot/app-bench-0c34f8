# Bread Bot

Turn a few settings into a bread recipe you can bake from. Pick a bread,
set the hydration, the number of loaves and their baked weight, and Bread
Bot works out the grams of every ingredient, how long to rise, and the
oven setting.

- **Calculator** — one screen. Bread type (sourdough, bagels, sourdough
  bagels, rye, sandwich loaf), a hydration slider from 50% to 90%, a
  loaf stepper, and a baked weight in grams. The recipe sheet shows grams
  and baker's percentages for every ingredient, a rise-and-bake timeline,
  and the oven temperature and time, scaled to your loaf size.
- **All in the browser** — the maths runs client-side; nothing is fetched,
  stored or saved, and each visit starts fresh.
- **Light and dark** — both looks follow the viewer's Homeroom theme.

## Changing it

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**, and describe
the change in plain English. You can also run Claude Code against this
repo directly; start with `CLAUDE.md`, which carries the app-specific
notes and points at the platform rules.

## Running it

`npm run build` compiles the stylesheet (Docker or Paketo do this on every
image build), `npm start` serves the app.