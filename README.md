# Bread Bot

Your personal bread recipe calculator. Pick one of five breads — sourdough,
bagels, sourdough bagels, rye or sandwich loaf — set the hydration, the
count and each loaf's weight, tap **Calculate recipe**, and a recipe slip
fills in: every ingredient in grams next to its baker's percentage, the
total dough, numbered rise steps, and the oven stages with their
temperatures and minutes.

One screen, built for the phone. The recipes are fixed formulas in
`public/recipe.js` — no AI, no database, nothing saved. Everything is in
grams and Celsius.

On staging, `?demo=1` shows a sample bake (sourdough at 75% hydration,
2 loaves of 900 g) already calculated, so the populated screen can be seen
without setting anything.

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. You can also
run Claude Code against this repo directly; start with `CLAUDE.md`, which
carries the app-specific notes and points at the platform rules.