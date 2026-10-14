# Club Votes

A place for our club to decide things together. One feed of decision
questions: anyone posts a question with 2 to 6 options, everyone picks one
option to vote for (one vote each, changeable or takeable back), names show
next to each vote, and a notched tally bar shows the standing. Comments stay
under every decision, and the person who posted it can close it, which stops
voting and records the outcome ("Chosen: X, N of M votes", or "Tied").

Built on Homeroom: sign-in, the database and the light/dark theme come from
the platform. To change the app, ask Homeroom bot (open the app on Homeroom,
tap the Homeroom icon, then **Suggest an improvement**), or run Claude Code
against this repo directly; start with `CLAUDE.md`.

## Layout

- `server.js` — the Express app: platform auth, the club's own rules
  (2 to 6 different options, no voting on a closed decision, close is the
  poster's alone, comment deletion is the comment's author alone, reports),
  and the staging demo behind `?demo=1`.
- `kit/server.js` — the shared resource behind `/api/decisions` (decisions,
  their votes and their comments on Postgres). Shared, do not edit.
- `public/` — the app: `index.html` (the drawn feed screen), `app.js`
  (feed, detail, voting, comments, menus), `screens.css` (the drawn
  screen's styles), `kit/` (shared browser modules, do not edit).
- `styles/tailwind-input.css` — the design kit: colour tokens in a light and
  a dark look, and the components. `npm run build` compiles it to
  `public/tailwind.css`.

## Staging demo

A staging preview opened with `?demo=1` seeds about a dozen made-up club
questions with varied tallies (two already decided, one clear winner and one
tie), one open decision posted by the viewer so Close and Delete can be
tried, and a note saying the people and entries are made up. Always written
with `ON CONFLICT DO NOTHING`, so it never overwrites anything.

## Tests

`dapp.json` names the checks that gate merge: the feed loads, the populated
demo shows its note, and `/health` answers.
