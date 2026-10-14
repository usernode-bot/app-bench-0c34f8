# Club Votes

A club decision board. Anyone in the club posts a question the club needs
to decide; members vote Yes, No or Abstain and see a live tally; the
person who posted it closes the vote when it is settled. The result line
says it in plain words: "Passed 7 to 1", "Not passed 3 to 5",
"Tied 4 to 4, not passed". A vote passes by simple majority of the votes
cast; abstentions show in the tally but do not count as a vote; closed
votes stay closed and keep their frozen counts.

Decisions carry a comment thread for discussion. Comments and decisions
can be reported (one report per person per thing, recorded for the club's
moderators); you can delete your own posts.

## Running it

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app always knows who is
  using it. No accounts to build.
- **Database** — the app's own private Postgres database holds the
  decisions, votes, comments and reports.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during
  image creation with either Kubernetes/Paketo or standalone Docker, in a
  light and a dark look that follow the viewer's Homeroom theme.

## Screens

- **Decisions** (`#/`) — open decisions as ballot-paper cards (cream,
  folded top-right corner) with a tally bar, vote buttons, comment count
  and Open/Closed tabs. A floating button posts a new decision.
- **Decision** (`#/d/<id>`) — the full question and details, vote
  buttons, the result line once closed, the comment thread, and — for the
  person who posted it — Delete, and Close vote with a confirmation.
- **New decision** (`#/new`) — one question, optional details.

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. You can
also run Claude Code against this repo directly; start with `CLAUDE.md`,
which carries the app-specific notes and points at the platform rules.