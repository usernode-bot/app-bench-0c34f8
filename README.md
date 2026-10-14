# Bread Bot

Your personal bread recipe calculator, on Homeroom. Pick a bread — sourdough,
bagels, sourdough bagels, rye or sandwich loaf — set the hydration, how many
loaves and how heavy each one is, and tap Calculate to get the grams of every
ingredient, how long to let it rise, and the oven temperature and time.

## How it works

- Everything is computed in the browser from standard baker's percentages per
  bread type. There is no database table, no API route and no new dependency;
  the server only serves the page and verifies the platform's identity token.
- Hydration is water as a percentage of the total flour, counting the water and
  flour inside the starter. A starter is fed 1:1, so its flour and water are
  taken out of the flour and water lines. Every line is rounded to whole grams
  and the remainder lands on water, so the lines add up to the dough total.
- Rise times shift with hydration (wetter dough rises faster) and bake times
  shift with loaf weight. They are a guide: each step's sub-line says what to
  look for.
- Nothing is saved. Each visit starts from the bread's defaults.

## Building it

`npm run build` compiles `styles/tailwind-input.css` (the app's design kit) to
`public/tailwind.css`; the Docker or Paketo image build runs it on every deploy.
The screen's markup is in `public/index.html`, its script in `public/app.js`.

## Design

See the "## Design" section of `CLAUDE.md`: flour-grey neutrals with a
crust-brown accent, a loaf-slice hydration dial as the signature element, and a
light and a dark look that follow the viewer's Homeroom theme.
