# Bread Bot

Your personal bread recipe calculator. Pick a bread (sourdough, bagels,
sourdough bagels, rye or sandwich loaf), set the hydration, how many loaves
and how big each one is, and a baker's formula card fills in at once: grams
for every ingredient, the rise time, the oven temperature and the bake time.

- **One screen, nothing to save.** The card updates as you set the numbers;
  bigger or smaller loaves than the bread's usual size adjust the bake time.
- **Baker's percentages.** Hydration counts only the added water; the starter
  is a separate 100%-hydration ingredient. The total always equals the dough
  you asked for.
- **Starting points, not tested recipes.** The formulas are common baker's
  percentages, and the rise times assume a kitchen at about 24°C.

## How it is built

Everything runs in the browser: the formulas live in `public/app.js`, the
screen in `public/index.html`. There are no tables, no routes and nothing is
stored; reloading starts again from the sourdough defaults. The design kit
(colour tokens, components) is in `styles/tailwind-input.css`, described in
`CLAUDE.md` under "## Design".

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. You can also
run Claude Code against this repo directly; start with `CLAUDE.md`.