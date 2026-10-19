# Block World

A 3D voxel creative building game, like Minecraft's creative mode. Everyone
in the group flies around one small floating island in the sky and places or
breaks blocks from a hotbar of eight block types: Grass, Dirt, Stone, Oak
planks, Leaves, Water, Sand and Brick. The world is shared, so everyone sees
everyone else's builds within a few seconds.

## Playing

- **Fly around.** Drag with one finger to look, pinch to fly forward or back.
  Hold the up and down arrows to rise and sink. On a computer, W A S D move,
  dragging the mouse looks around, and Space and Shift rise and sink.
- **Place and break.** Pick Place or Break in the switch on the right. Tap a
  block, or aim the crosshair and press the big button. Placing puts the
  chosen block on the face you aimed at; breaking removes the block.
- **Pick a block.** Tap a slot on the hotbar (on a computer, keys 1 to 8).

The island starts with a grass top, dirt sides, a tapering stone underside, a
small pond, a sandy edge and one tree. Blocks stay until someone breaks them.

## How it works

- `server.js` serves the page and the API, and owns the `blocks`,
  `block_changes` and `world_meta` tables in Postgres.
- `public/world.js` draws the island with three.js and keeps it in step with
  the server: it loads the world once, then polls `/api/changes` every three
  seconds. Writes are optimistic and go back if the server refuses them.
- `styles/tailwind-input.css` and `tailwind.config.js` hold the design kit.

The demo preview on staging (`?demo=1`) fills the island with a few builds by
made-up members and is labelled "Staging demo".
