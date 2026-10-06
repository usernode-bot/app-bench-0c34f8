# Tier List

Rank anything with friends, from S tier down. One screen: a board of five
tier rows (S, A, B, C, D) where each thing is a chip you drag into the tier
you think it belongs in. Anyone can add new things for the whole group to
rank, a toggle switches between your view and the crowd's, and tapping any
chip opens its detail sheet with the crowd tally, how each person voted, and
buttons that set your placement without dragging. A Report action removes a
thing from the board for everyone.

## How it works

- **Sign-in** — you're signed in through Homeroom automatically: the server
  verifies the platform-issued token (an RS256 JWT) on every request.
  Visitors without an account can look at the board and details, but every
  write needs an account.
- **Database** — the app's own private Postgres holds three tables: `items`
  (things to rank), `votes` (append-only placements; the latest vote per
  person per thing wins) and `reports` (kept private to staging, one report
  hides a thing).
- **API** — five JSON routes: `GET /api/items`, `GET /api/votes`,
  `POST /api/items`, `POST /api/votes` and `POST /api/items/:id/report`.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme. The accent is ember; the tier rows are the signature element.

## Changing this app

Open the app on Homeroom, tap the Homeroom icon in the header, then
**Suggest an improvement**, and describe what you'd like in plain English.
You can also run Claude Code against this repo directly; start with
`CLAUDE.md`, which carries the app-specific notes and points at the platform
rules.