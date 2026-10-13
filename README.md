# Bread Bot

A bread recipe calculator on [Homeroom](https://app.onhomeroom.com). Pick
one of five breads — Sourdough, Bagels, Sourdough bagels, Rye, Sandwich
loaf — set the hydration, how many loaves (or bagels), and how much each
one weighs, and the screen live-updates to show:

- every ingredient in grams, with rows that sum to the dough weight exactly;
- a baker's-percentage strip (flour at 100%, everything else scaled
  against it) in the ingredient's own colour;
- the rise steps, and the bake temperature and time, scaled to your loaf
  size.

There is no Calculate button and nothing to save: change a setting, the
recipe follows. There is no database either — everything is computed on
the fly.

## How it fits together

- `public/index.html` — the screen's skeleton (settings rows, section
  containers), plus the platform's bridge and theme scripts.
- `public/app.js` — wiring and rendering: reads the settings, calls the
  maths, redraws. No framework, just `public/kit/dom.js`'s `h()` helper.
- `public/breads.js` — the recipe data and all the maths, pure (no DOM),
  so it can be reasoned about and tested on its own.
- `server.js` — the platform's auth and hosted-asset plumbing, plus
  `GET /api/demo`, which serves example settings to staging previews
  opened with `?demo=1` and `null` everywhere else.

All the recipe maths lives in `public/breads.js` and is pure — see
`CLAUDE.md` before changing anything about it.

## Styling

Tailwind CSS, precompiled by `npm run build` during image creation with
either Kubernetes/Paketo or standalone Docker, in a light and a dark look
that follow the viewer's Homeroom theme. The palette and the app's own
components (`.chip`, `.stepper`, `.range`, `.strip`, `.step`,
`.bake-panel`, `.swatch`) live in `styles/tailwind-input.css`; re-theme
by changing the token values there.