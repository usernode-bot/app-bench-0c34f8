# Bread Bot

Bread Bot turns a bread choice and a few numbers into a full baker's formula:
grams for every ingredient, rise times, oven temperature and bake time.

Pick one of five breads (sourdough, bagels, sourdough bagels, rye or a
sandwich loaf); the app fills in that bread's usual hydration and loaf size.
Set the hydration percent, how many loaves or bagels and how big each one is,
and the formula card fills in as you type:

- each ingredient as a baker's percentage, with its grams beside it,
- a total that always matches the dough you asked for (loaves x size),
- the rise time, oven temperature and bake time, with the size adjusting the
  bake time for loaves bigger or smaller than the usual one,
- and short steps for mixing, shaping, proofing and baking.

Out-of-range or empty numbers show a line that says which field to fix and
what range works.

Everything runs in the browser. Nothing is saved: reloading starts again from
the sourdough defaults. The staging preview opened with `?demo=1` shows a
sample two-loaf bake.

The percentage formulas are common baker's starting points, not tested
recipes. They live in `public/app.js` (`BREADS`); rise times assume a kitchen
at about 24°C.

## Running it

- `npm ci` then `npm start` (or `node server.js`).
- `npm run build` compiles the Tailwind stylesheet to `public/tailwind.css`.

## Previewing

The staging preview opens on the defaults. Add `?demo=1` to see the sample
bake with the "Staging demo" line.
