# Bread Bot

A bread recipe calculator. Pick one of five breads (sourdough, bagels,
sourdough bagels, rye or a sandwich loaf), set the hydration, how many
loaves or bagels and how big each one is, then tap **Get recipe**. Bread Bot
works out the batch: the grams of every ingredient, the bulk rise and final
proof times, and the bake temperature and time.

The five recipes are fixed. Everything is worked out in the browser: there is
no database and nothing is saved. On a staging preview, open `/?demo=1` for a
worked example (2 sourdough loaves of 800 g at 75%).

## Making changes

Run Claude Code against this repo, or ask Homeroom bot. Start with
`CLAUDE.md`, which carries the app-specific notes and points at the platform
rules. `npm run build` compiles the Tailwind stylesheet; `npm start` runs the
server.
