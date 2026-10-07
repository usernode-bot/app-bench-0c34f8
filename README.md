# Tier List

Rank anything with friends, from S to F. One shared board per group:
anyone adds a thing to rank (a Bay Area taco spot, a film, anything),
then everyone drags it into their own tier rows. A Crowd tab shows the
tier most people picked, and tapping a thing shows how everyone voted.

## How it works

- **Add a thing** — the Add button at the top. It shows up for everyone,
  starting in your "Not ranked yet" tray.
- **Rank it** — on **My tiers**, drag a thing into a row (press and hold
  on a phone), or tap it and pick a tier letter in its panel. One vote per
  person per thing; ranking again replaces your tier; Unrank takes your
  vote back.
- **Crowd** — the second tab puts each thing in the tier most people
  picked (ties go to the higher tier) and shows how many people voted.
  Things nobody has ranked yet sit below the board.
- **How everyone voted** — tap any thing to see who added it, your tier,
  and each person's tier, best tier first.
- **Report** — a thing disappears for you at once, and for everyone once
  3 different people have reported it. Nothing else can be edited or
  deleted, the person who added it included.

## How it's built

- Express + Postgres on the Homeroom scaffold; sign-in is the
  platform-issued iframe token. Visitors with no account can look at both
  tabs and the panels but not add, rank or report.
- Tables, created idempotently on boot in `server.js`: `items` (public),
  `votes` (public, one row per person per thing), `item_reports`
  (`staging:private`).
- Staging seeds seven fake "Staging demo …" Bay Area spots with votes
  from three made-up people so previews have something to drag;
  production starts empty.
- Styling is this repo's Tailwind kit — see `## Design` in `CLAUDE.md`.
  Drag-to-place, sheets, alerts and toasts come from the platform's
  native UI kit.
