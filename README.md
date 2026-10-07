# Tier List

Rank things with friends, from S tier down. Anyone in the group can add a
thing to rank (a bay area restaurant, a film, anything), everyone drags it
where they think it belongs, and the group can compare notes.

- **My board** — your own tiers, S through F. Drag things in from the
  **Things to rank** list; every drop saves on its own, there is no save
  button.
- **Crowd view** — where most people put each thing, with a count of how
  many picked each tier.
- **How everyone voted** — tap any thing, in either view, to see each
  person's current tier for it.

Anyone signed in can add things and rank them; a visitor without an account
can look around read-only. There is no deleting or renaming yet, only adding
and ranking.

## Development

The app is a small Express + Postgres server (`server.js`) serving a single
page (`public/index.html`), styled with Tailwind, precompiled by
`npm run build` during the image build in a light and a dark look that
follow the viewer's Homeroom theme. The design kit lives in
`styles/tailwind-input.css`; app-specific notes are in `CLAUDE.md`, which
also points at the platform conventions.