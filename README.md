# Tier List

Rank anything with friends, from S to F tier — restaurants in the Bay
Area, films, parks, anything. Anyone signed in can add something to rank,
and everyone places it where they think it belongs.

- **My tiers** — the six rails S, A, B, C, D and F with your own
  placements. Drag a chip into a rail, or tap it and pick a tier (works
  with a keyboard, and on phones).
- **Crowd tiers** — the same rails with everyone's placements combined:
  each item sits in the tier most people chose, with a count of how many.
- **Item detail** — tap any chip to see who added it and how each person
  placed it, with your own placement highlighted.

Signed-out visitors can look around; adding and placing ask for an
account. Items and placements are public and live in two Postgres tables
(`items`, `placements`), created idempotently on boot.

## Development

- `npm ci`
- `npm run build` compiles `styles/tailwind-input.css` to
  `public/tailwind.css` (the image build does this on every deploy).
- Run locally with `DATABASE_URL=… node server.js`; with
  `USERNODE_ENV=staging` the app seeds a populated demo board ("Staging
  demo …" items) on boot.

The app's look — the coral palette, the tier ladder, the type — is written
down in `CLAUDE.md` under "Design".
