# Bread Bot 🍞

Your personal bread recipe calculator. Pick a bread — sourdough, bagels,
sourdough bagels, rye or a sandwich loaf — set the hydration, how many
loaves (or bagels) and how heavy each one is, and Bread Bot tells you how
many grams of each ingredient to weigh, how long to let the dough rise and
proof, and at what temperature and how long to bake it.

## How it works

- **Pick a bread.** Each one starts at its own usual hydration, count and
  size, so the recipe makes sense straight away.
- **Set the dough.** Drag the hydration slider (50% to 90%), use + and −
  for how many (1 to 24), and tap Small, Medium or Large or type the exact
  dough weight of each one (50 to 3,000 g).
- **Read the recipe.** Grams of flour, water, salt and leaven (sourdoughs
  use a starter, with a feeding note), plus the extras that bread needs,
  and the total dough weight. It updates as you change anything.
- **Rise and bake.** Bulk rise, shape and proof, then oven temperature in
  °C and °F and the bake time. Bagels also get a boiling step.
- **Copy recipe** puts the whole recipe on your clipboard as text.

Nothing is signed in, saved or stored: it is a pure calculator page, and
reopening it starts at sourdough again. Grams come from baker's
percentages per bread, scaled to the flour your settings imply; salt is
2% of the flour; hydration counts the water inside the starter.

## Layout

- `public/index.html` — the one calculator screen.
- `public/app.js` — the `BREADS` table, the pure `compute(settings)` and
  the rendering.
- `styles/tailwind-input.css` — the design kit; `npm run build` compiles
  it to `public/tailwind.css` on every image build.
- `server.js` — the platform's auth (iframe token injection) and static
  file serving. No routes, no database tables.

## Changing this app

Ask Homeroom bot: open the app on Homeroom, tap the Homeroom icon in the
header, then **Suggest an improvement**, and describe the change in plain
English. You can also run Claude Code against this repo directly; start
with `CLAUDE.md`, which carries the app-specific notes and points at the
platform rules.
