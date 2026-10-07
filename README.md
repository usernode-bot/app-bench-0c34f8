# Bread Bot

A bread recipe calculator for home bakers. Pick a bread — sourdough,
bagels, sourdough bagels, rye or a sandwich loaf — set the hydration,
the number of loaves and the loaf size, and tap Calculate. Bread Bot
weighs every ingredient in grams, lays out the rise steps with their
times, and gives the bake temperature and duration. Recipes can be
saved, reopened and deleted.

## How it works

- **The formulas live in one place** — `public/bread.js` holds every
  bread's flour blend, extras, leaven, rise plan and bake plan, plus
  the grams math. The browser uses it to render the result and the
  server uses it to validate saved input, so what you see and what is
  stored can never disagree.
- **Only inputs are stored** — a saved recipe keeps the bread,
  hydration, loaf count and size, never the computed grams. Results
  are always recalculated, so a formula fix updates every saved
  recipe the next time it is opened.
- **Saved per person** — recipes belong to the signed-in Homeroom
  user, in the app's own Postgres database (`saved_recipes` table,
  created on boot).

## Development

- `npm run build` — precompiles the Tailwind stylesheet into
  `public/tailwind.css` (the image build does this too).
- `npm test` — unit tests for the formula module (`node --test`).
- `npm start` — run the server; needs `DATABASE_URL` and, outside the
  platform, `USERNODE_JWT_PUBLIC_KEY` + `USERNODE_APP_ID` to accept
  sign-ins.

Staging has a populated demo: append `?demo=1` to the URL and each
viewer sees a handful of sample recipes on first view (staging only).

Start with `CLAUDE.md` for the app's design rules and the pointer to
the platform conventions.