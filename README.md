# Tier List

A shared S to F tier list for a group of friends. Everyone in the group
keeps the same lists, like Bay Area restaurants or movies to rewatch,
adds things to rank, and drags each thing into a tier to score it.

- **Your view** puts each thing in the tier you voted it into, and shows
  the crowd's tier beside it.
- **Crowd view** puts each thing in the tier the group's votes average
  to, with a small stacked bar of everyone's tiers. Things nobody has
  voted on wait in a "No votes yet" tray.
- Tap a thing to see the crowd's stacked bar, your vote, and how each
  person voted. Whoever added a thing can remove it; anyone can report
  one.
- Whoever started a list can delete it.

The staging preview opens the populated demo with `?demo=1`: the
"Bay Area restaurants (Staging demo)" list and "Movies to rewatch", with
votes from four made-up friends, and the viewer's own. Nothing is written
in production.

## Running it

```sh
npm ci --include=dev
npm run build      # compiles public/tailwind.css from styles/tailwind-input.css
npm start          # node server.js, needs DATABASE_URL
```

On Homeroom the platform injects the database URL, the identity token's
public key and the app id, and builds the stylesheet during image
creation.
