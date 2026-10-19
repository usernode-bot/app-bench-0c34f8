# Block World

A shared 3D voxel building game, like Minecraft creative mode. Fly around a
small floating island in the sky, place and break blocks from a hotbar of
eight block types, and see everyone else's builds appear within a few
seconds. One shared world for the whole group; visitors can fly and look,
placing asks them to make an account.

## How it works

- **Fly:** drag to look around; on a phone pinch to fly forward or back, on
  a computer W A S D move and the mouse looks around. Space and Shift (or
  the fly buttons) rise and sink. There is no gravity, walking or collision:
  you always fly.
- **Build:** pick Place or Break in the switch, then tap a block or aim the
  crosshair and press the big button. Blocks save to the server right away;
  a failed save reverts the block and says so.
- **Live:** every client polls the change log every 3 seconds, so others'
  blocks appear without reloading. The header shows who has built and who is
  building now.

## Stack

- `server.js` — Express + Postgres: the `blocks` table is the world's truth,
  `block_changes` is the follow-along log, `world_meta` holds one-time seed
  flags. The starter island is generated in code on first boot.
- `public/world.js` — a three.js scene (one `InstancedMesh` per block type),
  fly camera, aiming and optimistic writes.
- Styling is Tailwind, precompiled at build time from `styles/tailwind-input.css`
  into `public/tailwind.css`, in a light and a dark look that follow the
  viewer's Homeroom theme.