# Tier List

A shared tier board for ranking things with friends, starting with Bay Area
restaurants.

- **My view** puts every thing in the tier row you gave it. Drag a card into
  a row (or open it and tap S to F) to add or change your vote; things you
  have not placed wait in a tray under the board.
- **Crowd view** shows each thing in the row of the crowd average, with
  everyone who voted on it.
- Tap a card to see who added it, how each person voted, and the crowd
  average. From there you can clear your vote, remove a thing you added, or
  report one.
- Anyone can add a thing to a list, start another list for a different kind
  of thing, or report a list. The list's creator can remove it.

The first list is Bay Area restaurants. On staging, open the preview with
`?demo=1` to see the board filled with sample data for four made-up people.

## Running it

```sh
npm ci --include=dev
npm run build   # compiles styles/tailwind-input.css to public/tailwind.css
npm start
```

Sign-in, the database and the bridge come from the Homeroom platform (see
`CLAUDE.md`).
