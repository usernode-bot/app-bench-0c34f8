# Club Votes

A decision board for the club, on Homeroom. Anyone can post a decision
the club needs to make; every member votes For, Against or Abstain with
one tap (changeable, retractable); everyone talks it through in the
comments underneath.

## How it works

- **The board** — one list of open decisions, split into "Waiting for
  your vote" and "You voted". Each row shows who posted it and when,
  the tally bar (the app's signature element), the counts and the
  comment count.
- **A decision** — the details, where it stands as a large tally bar,
  three toggle buttons for your vote and the comments. Your vote saves
  straight away and moves the bar; tap the same option again to
  retract.
- **Comments** — short replies under each decision, with report (via
  the native more-menu) for things the club's people should look at.
- **Posting** — the "New decision" button opens a form sheet: a title
  (required, up to 120 characters) and optional details.

## Under the hood

- Decisions, votes and comments come from the kit's
  items-with-votes-and-comments resource (`kit/server.js`), mounted as
  `decisions` with three fixed options; client code is in `public/`,
  the tally bar in `public/tally-bar.js`.
- Reports go into the `reports` table, marked `staging:private`.
- Staging previews accept `?demo=1`, which seeds eight made-up
  decisions and made-up comment lines (labelled on screen as a demo)
  so the populated board can be seen without anyone typing first.
- Styling is Tailwind, precompiled by `npm run build`, in a light and
  a dark look that follow the viewer's Homeroom theme. The palette and
  the design rules live in `CLAUDE.md` and `styles/tailwind-input.css`.

## Development

- `npm start` runs the app (`node server.js`).
- `npm test` runs the unit tests for the tally bar's pure half.
- `npm run build` recompiles `public/tailwind.css`.
- The declared `dapp.json` checks need an authenticated browser to
  pass; see `CLAUDE.md` for how to run them locally.