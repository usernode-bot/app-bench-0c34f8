# Club Votes

A decisions app for clubs and groups. Anyone posts a question with two to
six choices, everyone votes — one vote per person, changeable or takeable
back at any time — and the comments under each question carry the
discussion. The tally bar shows at a glance where the club is leaning.

Runs on **Homeroom**: sign-in is the platform-issued user token (no
accounts to build), the app has its own private Postgres database, and the
stylesheet is precompiled by `npm run build` during image creation in a
light and a dark look that follow the viewer's Homeroom theme.

- **Home** — open questions in two sections: waiting for your vote (new
  ones marked), and the ones you already voted on, with your pick shown.
- **A question** — the tally, full-width vote buttons (tap another choice
  to change your vote, tap yours again to take it back), and comments,
  oldest first.
- **Safety** — any question or comment can be reported; it is hidden for
  you at once, and for everyone once three members have reported it.
  Question authors can delete their own question.

## To change this app

Ask Homeroom bot: open the app on Homeroom, tap the Homeroom icon in the
header, then **Suggest an improvement**, and describe the change in plain
English. You can also run Claude Code against this repo directly; start
with `CLAUDE.md`, which carries the app-specific notes and points at the
platform rules.