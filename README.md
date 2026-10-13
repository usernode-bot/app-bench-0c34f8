# Club Votes

A place for our club to decide things together. Anyone can post a
yes-or-no question the club needs to decide. Everyone votes, and the talk
happens in comments under each question.

## What is here

- **Question list** — the open questions, newest first. Each row shows its
  tally bar, the Yes and No counts, whether you voted, how many comments
  there are, and how long ago it was asked.
- **Question detail** — the tally bar, big Yes and No vote buttons, and the
  comments, oldest first, with a box to add yours. Tap your choice again to
  take your vote back; tap the other side to change it.
- **New question** — a sheet with a required question and optional details.
- **Report** — a quiet link on the question and on every comment. A report
  is recorded for a person to look at; nothing is hidden automatically.

Counts only, never names: nobody sees who voted which way.

## Design

The signature element is the tally bar: green fills from the left for Yes,
orange follows for No. It fills against everyone who has voted on any
question here, so a full-length bar means "all of them" — and you can see
the club waking up as the bar grows. The same green and orange carry
through to the counts and to your chosen vote button.

## Data

- `questions`, `questions_votes`, `questions_comments` come from the
  platform's kit (`kit/server.js`); `choice` is 0 for Yes, 1 for No.
- `reports` (kind, target_id, reporter_id, created_at) is written by
  `POST /api/reports` and is **staging:private**: its schema copies to
  staging, its rows never leave the environment they were made in. No
  public table points at it. A repeat report by the same person on the
  same thing is a no-op.
- `GET /api/voters` gives how many people have voted on anything; the
  tallies fill against that.

## Staging demo

`?demo=1` on a staging preview seeds about a dozen made-up questions with
varied votes and short comment threads, marked with one "Staging demo"
line. Everything on it works.