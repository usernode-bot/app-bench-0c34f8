# Club Votes

A place for a club to decide things together. Anyone posts a question with
a few options, everyone votes (one option each, changeable until voting
closes), and the discussion happens in the comments. When the asker closes
voting, the question moves to **Decided** — the record of what the group
picked.

## How it works

- **The feed** shows open questions as ballot slips: a tally strip of the
  votes so far, who leads, and a perforated stub that reads **Voted** (box
  ticked) or **Vote**. Below it, **Decided** lists closed questions with
  their outcome.
- **Ask the club** opens a sheet: a question (required), optional details,
  and 2–6 options — leave them empty and it becomes a Yes/No vote.
- **A question's page** has the vote buttons (tap to vote, tap again to
  take it back), the live tally, and the comments. The asker can close
  voting or delete the question from the More menu; anything can be
  reported, and hidden content is never shown to anyone.
- Counts refresh quietly every 20 seconds while the screen is visible.
- Guests can read everything but cannot vote, comment, post or report.

On staging, open the app with `?demo=1` to see it populated with made-up
questions, votes and comments (including two already decided and one you
can close or delete yourself).

## Under the hood

- Homeroom supplies sign-in (a verified platform token on every request)
  and this app's own private Postgres database — no accounts to build.
- Tailwind CSS is precompiled by `npm run build` during image creation, in
  a light and a dark look that follow the viewer's Homeroom theme. The
  design kit (colour tokens and components) lives in
  `styles/tailwind-input.css`; `CLAUDE.md` describes the look.
- `public/kit/` is platform-provided shared UI (vote buttons, comments,
  sheets, states); the app's own screens are `public/app.js` on top of it.

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. You can also
run Claude Code against this repo directly; start with `CLAUDE.md`, which
carries the app-specific notes and points at the platform rules.