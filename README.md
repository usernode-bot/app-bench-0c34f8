# Club Votes

A place for a club to decide things together. Anyone posts something the
club needs to decide, everyone votes **Yes** or **No**, people talk it
through in comments, and the person who posted it closes it when they are
ready.

- **Post a decision** — a question and optional details, from the
  **New decision** button at the bottom of the screen.
- **Vote** — Yes or No on the list or on the opened decision. You can
  switch your vote, or tap your choice again to take it back, until it
  closes. One vote per person.
- **Discuss** — flat comments under each decision, oldest first, each
  showing how its writer voted. You can delete your own comments.
- **Close it** — the poster closes a decision when ready; it moves to
  **Closed** with its result: "Yes 9", "No 6" or "Tied at 4".
- **Report** — every decision or comment someone else posted has a Report
  link; it is recorded for the club's admins and hides nothing.

The header counts what is open and what still needs your vote; "9 of 12
voted" is measured against the project's real member list. Tabs: **Open**,
**Closed** and **Posted by you**.

## Running it

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app already knows who is
  using it. No accounts to build. Visitors without an account may read.
- **Database** — the app's own private Postgres: `decisions`, `votes`,
  `comments` and `reports` (the last one marked `staging:private`).
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme.

## Staging demo

On a staging preview, open the app with `?demo=1` to see it populated:
about eight open decisions from made-up members (Mina, Tomas, Priya, Dev,
Ana), one posted by you, your votes on several, a few dozen comments and
four closed decisions, two of them closed by you. Everything works on it.
The plain route never shows demo rows.

## Design

The look lives in `CLAUDE.md` ("## Design") and is built from the kit in
`styles/tailwind-input.css`.
