# Club Votes

A club decides things here. Anyone posts a decision — a question with
two or more choices — and every member votes with one tap. You can
change your vote any time until whoever posted it closes the vote.
Each decision has its own comments, so the discussion lives under the
question it is about. When a vote closes, the winning choice is marked
and the decision moves to **Decided**; a level result is marked **Tied**.

## How it works

- **The list** (`#/`) — open decisions newest first, then everything
  decided. Each card shows the question, a tally strip of one mark per
  member, the choices with their vote counts, and a link to its
  comments.
- **A decision** (`#/d/:id`) — the votes, the full comment thread
  oldest first, and, for whoever posted it, **Close vote** and
  **Delete decision**. Report buttons sit on other people's decisions
  and comments.
- **Posting** (`#/new`) — a question and at least two choices; add as
  many more as you need.

Whoever posted a decision is the only one who can close or delete it.
Anyone signed in can vote and comment; guests can read everything but
the app stays read-only for them. Deleting a decision removes its
votes and comments with it.

## Under the hood

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request; guests get a read-only view.
- **Database** — the app's own Postgres database holds decisions,
  choices, votes (one per member per decision), comments, and reports.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during
  image creation, in a light and a dark look that follow the viewer's
  Homeroom theme.

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**, and
describe the change in plain English. You can also run Claude Code
against this repo directly; start with `CLAUDE.md`, which carries the
app-specific notes and points at the platform rules.
