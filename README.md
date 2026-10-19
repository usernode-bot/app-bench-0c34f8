# Bread Bot

Your personal bread recipe calculator. Pick one of five breads — sourdough,
bagels, sourdough bagels, rye or sandwich loaf — set the hydration, how many
loaves and how big each one is, and get the grams of every ingredient, the
rise times, and the bake temperature and time for that batch.

## How it works

Everything is worked out in the browser from one screen:

- **Pick your bread** — each bread is a chip with its own built-in recipe and
  its own sensible hydration range.
- **Set the batch** — three steppers for hydration (1% steps), loaf count
  (1 to 12) and loaf size in grams (the dough weight per loaf).
- **Get recipe** — one recipe card per batch: a hydration dial, the grams of
  each ingredient with its baker's percentage, and the bulk rise, final
  proof and bake settings.

The five recipes are built in and fixed (the creator's choice for this first
version); only hydration, count and size change. Nothing is saved — each
visit starts fresh, and there is no server round-trip.

## Under the hood

- All recipe data lives in `RECIPES` in `public/index.html`; the calculator
  is the script below it.
- Styling is Tailwind, precompiled by `npm run build` during image creation,
  in a light and a dark look that follow the viewer's Homeroom theme. The
  palette and components are in `styles/tailwind-input.css`.
- The server verifies the platform-issued user token on every request, so
  the app knows who is using it. No accounts to build.

## Changing this app

Ask Homeroom bot: open the app on Homeroom, tap the Homeroom icon in the
header, then **Suggest an improvement**, and describe the app you want in
plain English. You can also run Claude Code against this repo directly;
start with `CLAUDE.md`, which carries the app-specific notes and points at
the platform rules.