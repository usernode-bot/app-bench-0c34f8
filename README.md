# Club Votes

A decision board for clubs on Homeroom. Anyone posts something to decide
with a set of choices, every member votes with one changeable vote, people
talk it over in comments, and whoever posted it closes it with the winning
choice into the Decided list.

## How it is built

- **server.js** — Express, platform-issued JWTs (users sign writes, guests
  read only), the hosted-asset proxy, graceful shutdown.
- **decisions.js** — the decisions API and its tables (`decisions`,
  `decision_votes`, `decision_comments`, plus `reports`, which is marked
  `staging:private`: what members report stays with the platform).
- **public/app.js** — fills the drawn screen (the spec's slips and Decided
  list) with real data, using the kit in `public/kit/`.
- **public/screens.css** — the drawn screens' own styles; the design kit's
  tokens and components are in `styles/tailwind-input.css`, compiled to
  `public/tailwind.css` by `npm run build`.

Staging previews support `?demo=1`: about ten open decisions and four
decided ones from made-up members, plus — for the signed-in viewer, once —
their vote on two slips and one tied decision of their own to try closing.
The same page without `?demo=1` shows the real, empty board.
