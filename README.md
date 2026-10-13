# Club Votes

A place for a club to decide things together. Anyone posts a question the
club needs to decide; everyone votes (once, changeable until you're happy);
the result is a hand-counted tally of marks with the voters' names beside
it, like a show of hands. Comments sit under each question for the talk
before and after the vote. Nothing ever closes: a question stays open and
anyone can take their vote back or change it at any time.

## How it works

- **One screen, one detail view.** The main screen lists open questions,
  newest first, each with who asked it, the leading answer, whether you
  voted and how many comments it has. Tapping one opens the question:
  vote buttons with tally marks and voter names, the comment thread, and
  Report on anything posted by someone else.
- **Posting** happens in a form sheet: the question (required, up to 120
  characters), optional details, and up to six answers. Leave the answers
  empty and the question is a simple Agree / Disagree.
- **Signing in** is the platform's job: the server verifies the
  Homeroom-issued token (an RS256 JWT) on every request. Visitors without
  a Homeroom account can read everything but not vote, post or comment.
- **Data** lives in the app's own Postgres database: the kit's
  `questions` / `questions_votes` / `questions_comments` tables, plus
  `voter_names` (public — each voter's username, for the show of hands)
  and `reports` (private — what members flagged).
- **Styling** is the design kit in `styles/tailwind-input.css`: warm
  neutrals with a deep indigo accent, in a light and a dark look that
  follow the viewer's Homeroom theme. The signature element is the tally
  marks (`public/ballot.js`).

## Development

- `node server.js` runs the app (needs `DATABASE_URL`).
- `npm run build` recompiles `public/tailwind.css` (the image build does
  this on every deploy).
- `?demo=1` on a staging preview seeds made-up club questions so the
  populated screens can be seen; the people and entries there are made up.

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. You can also
run Claude Code against this repo directly; start with `CLAUDE.md`, which
carries the app-specific notes and points at the platform rules.