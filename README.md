# Club Votes

A club decision-making app on [Homeroom](https://app.onhomeroom.com). Anyone
posts a decision — with options, or as a plain Yes/No — everyone votes (one
vote per person, changeable or take-backable until it closes), and people
comment under each decision. The person who posted a decision can **Close as
decided**, which stops voting and marks the leading option as the outcome.

## Screens

- **Decisions** — open decisions first (newest at the top), then decided ones
  marked with an amber badge. Each row shows the question, who posted it and
  when, a tally bar, the leading option, whether you voted, and the comment
  count.
- **A decision** — the full question, its options as wide buttons whose fill
  shows each share, your vote (tap again to take it back), a summary line,
  Close as decided (the author only), and comments oldest first with a
  composer. The ⋯ menus offer Report on other people's posts and Delete on
  your own.

## How it is built

- `server.js` — Express + Postgres. The decision, vote and comment tables and
  their API come from the Homeroom kit (`kit/server.js`, mounted as the
  `decisions` resource). On top of it: closures (`decision_closures`, author
  only, checked before every vote), reports (`reports`, marked
  `staging:private`), and graceful shutdown.
- `public/index.html` + `public/app.js` — the two screens the spec drew,
  filled with live data by the Homeroom fill kit (`public/kit/`).
- `styles/tailwind-input.css` — the design kit: ballot-ink indigo accent,
  decided amber, warm grey neutrals; `npm run build` compiles it to
  `public/tailwind.css`.

## Staging demo

With `?demo=1` on staging, the app seeds about ten made-up decisions by fake
members (plus one copy of a decision posted by the viewer, so Close and
Delete can be tried on it) and marks the screen "Staging demo".
