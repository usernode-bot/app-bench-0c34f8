# Tier List

Rank anything with friends, from restaurants to movies. A group keeps
shared lists of things to rank; anyone adds an item, everyone drags each
item into a tier (S at the top down to F), and each item shows your vote,
the crowd's tier and how every person voted.

- **Your view** puts each item where you put it, with the crowd's tier on
  its card; a tray holds what you have not ranked yet.
- **Crowd view** puts each item in the crowd's tier (the average of
  everyone's votes, rounded to the nearest tier), with a small stacked bar
  of everyone's tiers and the vote count.
- Tap an item for the crowd's stacked bar, your vote buttons, and how each
  person voted. Whoever added an item can remove it; anyone can report it
  (reports go to the group's admins and hide nothing by themselves).
- Lists are switched from the list name under the title; whoever started
  a list can delete it.

## Running it

- **Sign-in** — the server verifies the platform-issued user token
  (an RS256 JWT) on every request, so the app knows who is voting. Guests
  may look around read-only.
- **Database** — Postgres; the schema (`lists`, `items`, `votes`,
  `reports`) is created idempotently on boot.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme.

## Staging demo

Open a staging preview with `?demo=1` for a populated demo: a
"Bay Area restaurants" list with 15 restaurants voted on by four made-up
friends and you, plus a "Movies to rewatch" list. Everything works on the
demo rows: dragging, adding, removing, reporting.