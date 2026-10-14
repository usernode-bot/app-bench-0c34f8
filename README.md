# Bread Bot 🍞

Your personal bread recipe calculator. Pick a bread — sourdough, bagels,
sourdough bagels, rye or sandwich loaf — set the hydration, how many
loaves (or bagels) and how big each one is, then tap **Bake It**.

You get:

- the grams of every ingredient, each with its baker's percentage of the
  flour, adding up to the exact total dough weight;
- how long to let the dough rise, and at what room temperature;
- the oven temperature and bake time.

The hydration dial is a baker's formula ring: it fills to your hydration
and says what the number means in plain words ("720 g water for every
1,000 g flour").

## How it works

A pure client-side calculator: the bread table and the math live in
`public/app.js`, and nothing is saved between visits. Amounts come from
standard ratios per bread as baker's percentages of the flour; sourdough
breads use a starter, the yeast breads use instant yeast.

## Building it

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**, and describe
the app you want in plain English. You can also run Claude Code against
this repo directly; start with `CLAUDE.md`, which carries the app's design
notes and points at the platform rules.