# Club Votes

A place for your club to decide things together. Anyone can post a
question the club needs to settle — with two to six choices, or a plain
Yes or No — and everyone votes with one tap. Votes are changeable, and
each choice shows who picked it. A question's discussion lives under it
as comments, and anything that should not be here can be reported with
one tap.

## How it works

- **The board** — the club's open questions, newest first, each with the
  choice that is leading, a hand-counted tally of votes, who asked it
  and how many comments it has.
- **A question** — vote by tapping a choice, tap again to take your vote
  back, and say what you think in the comments. The names under each
  choice are the people who voted for it.
- **Reports** — a question or comment can be flagged with an optional
  reason. A report is recorded only: nothing is hidden or removed by
  one, and there is no way to read reports back yet.

Questions stay open for now — closing them comes later.

## Under the hood

- Sign-in, the private Postgres database, the precompiled Tailwind
  build and the light/dark looks are platform plumbing, described in
  `CLAUDE.md`.
- The question, vote and comment storage and routes come from the
  platform kit (`kit/server.js`); the tally marks, voter names and
  reports are this app's own code in `server.js` and `public/app.js`.
- On staging, `/?demo=1` seeds a board of made-up questions so the
  populated screen can be seen. Nothing you post there is real.

To change the app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. Or run
Claude Code against this repo directly; start with `CLAUDE.md`.