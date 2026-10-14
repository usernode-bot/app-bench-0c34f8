# Club Votes

A place for a club to decide things together. Anyone can post something
the club needs to decide, everyone votes Yes or No, people talk it
through in comments under each decision, and the person who posted it
closes it when the club has had its say.

## How it works

- **Decisions list** with three tabs: Open, Closed and Posted by you.
  Each open decision is a card with its question, a tally bar (green for
  Yes, brick red for No, the empty track is everyone who has not voted
  yet), your Yes/No buttons and the comment count. Below the open cards,
  recently closed decisions show their result ("Yes 9", "No 6",
  "Tied at 4").
- **A decision's own screen** shows the details, a larger tally, the
  vote buttons and the comments, oldest first, each with the writer's
  name, when they wrote it and how they voted. The poster gets Close
  decision and Delete; anyone can report a decision or comment they did
  not post; you can delete your own comments.
- **Voting** is one Yes or No per person. Tap to vote, tap again to take
  it back, switch any time until the decision closes. There is no Maybe.
- The header counts what is open and what still waits on your vote;
  each card shows how many of the club's members have voted.

## Building and running

- `npm start` runs the server (`server.js`, Express + Postgres).
- `npm run build` compiles `styles/tailwind-input.css` to
  `public/tailwind.css`; the Docker image build does this for you.
- The schema is created idempotently at boot. On staging, opening the
  app with `?demo=1` fills the screen with made-up club decisions (and
  the viewer's own rows) so the populated app can be seen; every answer
  without `?demo=1` leaves those rows out.

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. You can
also run Claude Code against this repo directly; start with `CLAUDE.md`,
which carries the app-specific notes and points at the platform rules.
