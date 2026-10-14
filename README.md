# Club Votes

A club decision board on Homeroom. Anyone posts something for the club to
decide; everyone votes (one vote per person, changeable or taken back);
people discuss under each decision in comments. The person who posted it
closes the decision when it is settled, and the winner stays visible.

## How it works

- **The list** (home screen): every open decision, newest first, each with a
  question, a one-line tally ("Hall leads with 6 of 9 votes", "Tied at 4",
  "No votes yet"), a segmented tally bar whose leader is in the accent
  colour, your own vote, a comment count and who posted it. Closed
  decisions keep their place with the winner line ("Thursday won with 10 of
  14 votes", or "Closed in a tie") and a Closed tag.
- **New decision**: a question (required), two to six optional options
  (leave them out for a plain Yes or No), and optional details.
- **The detail screen**: vote by tapping an option; tap another to change
  your vote; tap your own again to take it back. Comments, oldest first,
  with a More menu on each (report; the writer can delete their own).
- **Close decision**: a button on the detail screen, only for the person
  who posted it (the server answers 403 to anyone else). Closing is final;
  after it the counts freeze and nobody can vote (409).
- **Reports** record that somebody flagged a decision or comment. They
  never hide anything and are not shown anywhere.
- **Guests** (visitors without a Homeroom account) can read everything but
  not post, vote, comment or close; they see a "Sign in to vote" hint.

## Data

Three public tables: `decisions` (question, options, poster, `closed_at`),
`decisions_votes` (one row per person per decision, primary key
`(item_id, user_id)`) and `decisions_comments`. `reports` is
`staging:private` (who flagged what is nobody's business but the club's),
with a unique index on `(kind, target_id, reporter_id)` so a person reports
a thing once, and no foreign keys, so a report of something since deleted
is still a record.

Staging only: `?demo=1` seeds twelve made-up club decisions (with votes and
comments) once, marks two of them closed, and gives each viewer their first
votes on two rows, so the populated screen can be seen without touching
real data. The plain route never shows demo rows.

## Layout

- `server.js` — Express + Postgres: the decisions resource (from
  `kit/server.js`), the close, comment-delete and report routes, the
  graceful shutdown handler.
- `public/app.js` — the front end: it fills in the drawn list markup in
  `public/index.html` and renders detail screens from the kit's
  list/votes/comments pieces.
- `public/kit/` — the platform's shared UI kit (states, sheets, votes,
  comments, native menus), ES modules, no build step.
- `styles/tailwind-input.css` + `tailwind.config.js` — the design tokens;
  `npm run build` compiles them to `public/tailwind.css`.
