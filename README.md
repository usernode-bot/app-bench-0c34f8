# Bread Bot 🍞

Turn bread choices into a full recipe: pick one of five breads — sourdough,
bagels, sourdough bagels, rye or sandwich loaf — set the hydration, the count
and the size of each piece, and the recipe is there, updating live as you
move any control. No Calculate button.

- **Formula sheet** — every ingredient in grams with its baker's percentage,
  and the total dough weight. Starter breads count the starter's own flour
  and water in the hydration.
- **Rise and bake timeline** — each step with its duration, hands-on or
  rising or baking, oven temperatures where they apply, and a strip drawn to
  scale that shows where the time really goes. Wet dough rises faster and big
  batches bake longer: the timeline adjusts for both.
- **Remembered** — your last choices per bread are kept on the device, so
  the app opens where you left it.

There is no database: the whole calculator is maths in the browser
(`public/bread/recipe.js`), and the server only serves the page. Choices
live in `localStorage` under `breadbot:v1`.

## Building on it

Ask Homeroom bot (open the app, tap the Homeroom icon, **Suggest an
improvement**), or run Claude Code against this repo — start with
`CLAUDE.md`, which carries the app-specific notes and points at the
platform rules.