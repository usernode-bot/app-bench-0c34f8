# Club Votes

A place for a club to decide things together. Anyone can post something the
club needs to decide, such as where to meet or what to do next; everyone
votes on the options, and the discussion happens in the comments under each
decision.

The one screen lists the club's decisions: open ones first, newest first,
each with a tappable bar per option, and decided ones below, their result
marked in green. One vote per person per decision, changeable or taken back
until the person who posted it marks it decided. Comments open in a sheet
under each decision. Decisions and comments can be reported to the club's
moderators, and their authors can delete them.

## Running it

- **Sign-in** — the server verifies the platform-issued user token (an RS256
  JWT) on every request, so the app knows who is using it. Guests can read
  but not vote or post.
- **Database** — the app's own Postgres database holds the decisions, votes
  and comments; reports go to a staging-private table for the moderators.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme. The design kit lives in `styles/tailwind-input.css`.

On staging, opening the app with `?demo=1` shows the populated demo: about
a dozen made-up decisions by made-up people, three of them decided, plus
the viewer's own votes and one decision of their own.

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. `CLAUDE.md`
carries the app-specific notes and points at the platform rules.
