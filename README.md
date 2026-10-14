# Bread Bot 🍞

Your personal bread recipe calculator. Pick a bread, set your numbers, get
the recipe.

- **Pick a bread** from five: Sourdough, Bagels, Sourdough bagels, Rye and
  Sandwich loaf. Picking one sets the hydration and loaf size to that
  bread's usual values.
- **Set hydration** with the slider or the minus and plus buttons, from 50%
  to 100%. The baker's percentage dial fills to match.
- **Set how many and how big**: loaves (bagels for the two bagel breads)
  and the size of each in grams.
- **Tap Bake It** and get every ingredient in grams with its baker's
  percentage, the total dough weight, how long the dough rises and at what
  room temperature, and the oven temperature and bake time. Change anything
  afterwards and the recipe updates as you go.

Nothing is saved between visits; each visit starts fresh on Sourdough with
an empty recipe until you tap Bake It.

## How it works

A pure client-side calculator: no database, no API routes. Recipes come
from a table of standard baker's percentages per bread in
`public/app.js`, scaled to your total dough weight.

## Developing

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**, and describe
the change in plain English. You can also run Claude Code against this
repo directly; start with `CLAUDE.md`, which carries the app's design
notes and points at the platform rules.