# Bread Bot

A bread calculator for home bakers. Pick a bread — sourdough, bagels,
sourdough bagels, rye or a sandwich loaf — set the hydration, how many
loaves (or bagels) and how big each one should be, and Bread Bot weighs out
every ingredient in grams, with baker's percentages, plus the rise and bake
steps: times and oven temperatures for that bread.

Everything runs in the browser: nothing is stored, there is no sign-in wall
beyond the platform's own, and the recipe recalculates only when you tap
**Calculate recipe** — change a setting after that and the recipe fades
until you recalculate.

## How it works

- `public/index.html` — the one screen, drawn statically with Sourdough's
  defaults so it never shows blank.
- `public/recipes.js` — the bread presets and `calculate()`, the gram maths,
  pure and DOM-free.
- `public/app.js` — wires the screen to the calculator: the hydration dial,
  the bread tiles, the batch stepper and the recipe list.
- `server.js` — the platform scaffold: token verification, the hosted
  platform assets, static files, and a graceful shutdown for redeployments.

## Staging preview

A staging preview of the app can be opened with `?demo=1`: it shows a
pre-calculated sample recipe (Sourdough, 75%, two loaves of 900 g) labelled
"Staging demo", with every control working. Nothing is stored.

## Styling

Tailwind CSS, precompiled by `npm run build` during image creation with
either Kubernetes/Paketo or standalone Docker, in a light and a dark look
that follow the viewer's Homeroom theme. The palette lives in
`styles/tailwind-input.css`; CLAUDE.md's "## Design" describes the look.
