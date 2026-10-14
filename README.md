# Club Votes

A place for a club to decide things together. Anyone posts a question the
club needs to decide; everyone votes Yes, No or Abstain and sees the tally;
the comments under each decision are where it gets talked through. Whoever
posted a decision closes the vote when it's decided, with a simple majority
of votes cast deciding: abstentions count as taking part, not as votes, and
a tie doesn't pass. Closed votes stay closed, but their comments stay open.

## Running it

- `npm ci --include=dev`, then `npm run build` (compiles
  `styles/tailwind-input.css` to `public/tailwind.css`).
- `node server.js` with `DATABASE_URL` set. The schema is created
  idempotently on boot.
- The app is built to run on Homeroom: sign-in is the platform's
  iframe token, there are no accounts of its own, and guests may read.

## Data

Tables `decisions`, `votes` and `comments` are public. `reports` is marked
`staging:private` (it only needs to exist for the club to look at later, and
no public table points into it). Demo rows, written for a viewer's `?demo=1`
staging preview on that viewer's first such request, carry `demo_for` =
that viewer's id and are invisible to every request without `?demo=1`.

## Checks

`dapp.json`'s `tests` run on every proposal: the populated staging demo
list, the plain route's empty state, and `/health`.
