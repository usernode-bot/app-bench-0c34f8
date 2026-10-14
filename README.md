# Club Votes

A place for your club to decide things together, on Homeroom. Anyone can
post something the club needs to decide — where to meet, what to do next —
with two to six options to pick from. Everyone votes (one vote each,
changeable or taken back until the decision closes), the club talks it
through in comments under each decision, and the person who posted it
closes it with the result. Closed decisions stay readable under "Decided",
with their final counts and their comments still open.

- **Decisions, votes and comments** live in Postgres, served by the app's
  Express server (`server.js` mounts the kit resource in `kit/server.js`
  and adds close, report and demo routes beside it).
- **Sign-in** is the platform's: Homeroom issues each viewer a token and the
  server verifies it, so the app always knows who is using it. Guests can
  read everything; voting, posting and commenting need an account.
- **Styling** is Tailwind CSS, precompiled by `npm run build` at image
  build time, in a light and a dark look that follow the viewer's Homeroom
  theme. The look is described in `CLAUDE.md`'s "## Design".
- **Staging demo:** a staging preview opened with `?demo=1` fills the feed
  with about twelve obviously made-up club decisions by made-up members
  (labelled "Staging demo" once), including one decision, some votes and a
  comment by whoever opened it, so every control has something real to act
  on. Nothing is seeded outside that route.

## Running it locally

```sh
npm ci
npm run build      # compiles styles/tailwind-input.css to public/tailwind.css
DATABASE_URL=postgres://... USERNODE_JWT_PUBLIC_KEY=... USERNODE_APP_ID=... node server.js
```

The platform sets those variables itself in production and in staging
previews. To change the app, ask Homeroom bot from the app's page, or run
Claude Code against this repo — start with `CLAUDE.md`.
