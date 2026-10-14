# Bread Bot

Your personal bread recipe calculator. Pick a bread — sourdough, bagels,
sourdough bagels, rye or sandwich loaf — set the hydration, how many loaves
and how big each one is, then tap Calculate. You get the grams of every
ingredient, the baker's percentages, how long to let it rise, and the oven
temperature and bake time.

## How it works

- **Recipes** are standard baker's percentages, written as flour = 100%.
  The water comes from the hydration you set; the rest of each recipe
  (starter, salt, sugar, yeast, butter) is a fixed percent of the flour.
- **The bake time** grows or shrinks by 5 minutes for every 200 g a loaf is
  above or below its usual size (2 minutes per 20 g for bagels), never
  below half.
- **Nothing is saved**: each visit calculates fresh, by choice. The
  calculation is a pure function in the page — no server route, no table.

The recipes and their rise and bake rules live in `RECIPES` in
`public/app.js`; adjust them there.

## Developing

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**, and describe
the change in plain English. You can also run Claude Code against this
repo directly; start with `CLAUDE.md`, which carries the app-specific
notes and points at the platform rules.

The styling is Tailwind CSS, precompiled by `npm run build` during image
creation with either Kubernetes/Paketo or standalone Docker, in a light
and a dark look that follow the viewer's Homeroom theme.
