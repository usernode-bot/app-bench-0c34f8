# Club Votes

The things a club needs to settle, in one place. Anyone signed in to
Homeroom posts a **decision** — a title and the details — and the club
votes on it: **Agree**, **Disagree** or **Abstain**. Votes are not
secret; the tally shows who chose what. The person who posted the
decision closes the vote when the club has settled it, which locks the
result (Agreed, Turned down, Tied, or No votes) but leaves the comments
open.

## How it works

- **The list** — Open decisions first (newest first), then Decided ones
  (most recently settled first). Each row carries the ballot bar, the
  Agree/Disagree/Abstain counts, your vote, and the result once decided.
- **A decision** — the full title and details, the large ballot bar,
  one vote button per choice with its count and who voted that way,
  the comment thread, and — for the poster only — the button to mark it
  decided.
- **Reports** — the three-dots menu on other people's decisions and
  comments hides content for the reporter; three distinct reports hide
  it for everyone. Hidden content never leaves the server: it is
  filtered out in SQL before it reaches any list or detail screen.
- **Guests** — people without a Homeroom account can read everything
  but cannot post, vote or comment.

## Under the hood

- Node + Express + Postgres. `server.js` wires the platform middleware
  (auth, staging time) and mounts the app's routes from `decisions.js`;
  all five tables are created idempotently in `migrate()`.
- Votes are stored per person (`decisions_votes`), so taking a vote back
  or changing it is a plain upsert and names can be shown on the tally.
- The result is written once, when the poster closes the vote; there is
  no reopen.
- The frontend is two drawn screens (`public/index.html`) filled by
  `public/app.js` from the ES-module pieces in `public/kit/`. The list
  reuses its rows between the every-30-seconds refreshes, so the ballot
  bars slide when a tally changes.
- Staging preview: open with `?demo=1` for a full set of made-up
  decisions (plus one posted by "you"), and a small "Staging demo" note.

## Develop

```sh
npm install
npm run build        # compile Tailwind (styles/tailwind-input.css → public/tailwind.css)
node server.js       # needs DATABASE_URL; USERNODE_* env for real sign-in
```

`CLAUDE.md` has the app-specific conventions and points at the Homeroom
platform rules.