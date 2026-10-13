# Club Votes

A place for a club to decide things together. Anyone posts a yes/no
question, everyone votes, and the count is on the card as it stands:
hand-tally marks, one vote per person, changeable, takeable back. Under
each question, comments to talk it through.

## How it works

- **The list** — every question, newest first. Each card carries the
  question, who asked it and when, the Yes/No ballot with live counts,
  and how the vote stands. Voting works straight from the list.
- **The question page** — tap a card (or its comments link) for the full
  question, your own vote with a line telling you what it is, and the
  comments, oldest first. Add a comment there.
- **Votes** — one per person. Tap the other box to change your vote; tap
  the one you chose again to take it back. The count updates as soon as
  you tap, and if the save fails it goes back and says so.
- **New question** — the header button opens a short sheet: the question
  (up to 140 characters) and, if it needs them, the details.
- **Reports** — a question or someone else's comment can be reported.
  One report hides it for the reporter; three distinct reporters hide it
  for everyone.
- **Deleting** — the person who asked a question can delete it, votes
  and comments with it.

## Under the hood

- Sign-in is the platform's: the server verifies the Homeroom-issued
  user token (an RS256 JWT) on every request, so the app knows who is
  voting. Visitors without a Homeroom account can read, but every write
  needs an account.
- The questions, votes and comments tables come from the platform kit
  (`public/kit/`, mounted in `server.js`); the reports table is this
  app's own.
- Styling is Tailwind CSS, precompiled by `npm run build` during image
  creation with either Kubernetes/Paketo or standalone Docker, in a
  light and a dark look that follow the viewer's Homeroom theme.
- To change the app, ask Homeroom bot (open the app, tap the Homeroom
  icon, **Suggest an improvement**) or run Claude Code against this
  repo; start with `CLAUDE.md`.