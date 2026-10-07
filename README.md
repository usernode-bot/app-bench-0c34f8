# Bread Bot

Your personal bread recipe calculator, built on Homeroom. Pick a bread
(sourdough, bagels, sourdough bagels, rye, sandwich loaf), set the hydration,
how many loaves and how big, and it tells you how many grams of each
ingredient to weigh, how long to let the dough rise, and at what temperature
and for how long to bake it.

## How it works

- One static screen, `public/index.html`. The ratios per bread type live in a
  small table in its client script: no database, no network calls, nothing
  saved between visits. The page works signed in, as a guest, and offline.
- Water is hydration percent × flour; the other ingredients are standard
  baker's percentages per bread type (sourdough types use starter, the rest
  instant yeast). Rows are rounded to whole grams so they add up to the exact
  dough weight (`loaves × loaf size`).
- Rye's flour is presented as two rows (70% bread flour, 30% rye flour), but
  the flour is still one number, so the dough total is unchanged.
- The proofing timeline draws each rise stage (plus a bagel's boil) sized to
  its length, never narrower than 12% of the bar; the exact duration is
  written inside each segment.

## Development

- `npm run build` compiles `styles/tailwind-input.css` to
  `public/tailwind.css` at image build time. Colours are token pairs (a light
  and a dark look that follow the viewer's Homeroom theme); the palette and
  the screen's design rules live in `CLAUDE.md` under "## Design".
- The platform's auth, bridge and design conventions are in `CLAUDE.md` and
  the hosted platform rules it points at.

## Improving the app

Ask Homeroom bot: open the app on Homeroom, tap the Homeroom icon in the
header, then **Suggest an improvement**. You can also run Claude Code against
this repo directly; start with `CLAUDE.md`.
