# Bread Bot

A one-screen bread calculator for home bakers. Pick a bread kind
(sourdough, bagels, sourdough bagels, rye, or a sandwich loaf), set the
hydration, the number of loaves or bagels and the dough weight per piece,
and the screen shows:

- **Ingredients** in whole grams that sum exactly to the total dough
  (starter counted as 100% hydration, so its flour and water are part of
  the percentages).
- **Rise schedule** as numbered steps with durations, the rise steps
  marked.
- **Bake** temperature in °C with the °F beside it, preheat note, oven
  stages scaled to the dough size, and resting notes.

Everything updates live as the settings change — there is no Calculate
button. A hydration gauge doubles as the hydration slider: the soft band
marks the kind's typical range, the wheat fill tracks the dough, and the
gauge word (Stiff, Soft, Slack) says how the dough will feel.

Each kind remembers its own settings in the browser (`localStorage` key
`breadbot:v1`). In staging, `?demo=1` opens on sample settings and
writes nothing.

## Layout

- `server.js` — Express server: platform token auth, `/api/demo`, static
  files.
- `public/bread.js` — the bread maths, pure (no DOM), so Node can test it.
- `public/app.js` — the screen; draws the kind tiles, gauge, steppers and
  the three result sections from `bread.js`.
- `public/index.html` — the HTML shell.
- `styles/tailwind-input.css` — the design kit: colour tokens (light and
  dark) and the app's components; `npm run build` compiles it to
  `public/tailwind.css`.
- `test/bread.test.js` — Node's test runner over `bread.js`
  (`npm test`).

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**, and describe
what you'd like in plain English. You can also run Claude Code against
this repo directly; start with `CLAUDE.md`.