# Block World

A shared 3D voxel world you build together, like creative mode. Fly over a
64 by 64 grass plain, pick a block from the palette (grass, stone, wood,
glass, brick or sand), and tap the plain or any block to place it. Switch to
Break to take a block away. Every block you place or break appears for
everyone else in the project straight away, and the pill at the top right
says who has the world open.

The world is one shared plain for the whole project. Blocks snap to a grid,
there is nothing to fall into, and anyone signed in can build and change
anything. The grass plain itself stays.

## Getting around

- Tap and drag the world to look around.
- On a phone, the round move pad at the bottom left moves you forward, back
  and sideways; the arrows on the right fly you up and down.
- On a computer, W A S D moves you and Space / Shift fly up and down.

## On staging

Open the app with `?demo=1` to see a populated world: a cottage, a stone
tower, a sand path, a hill with a tree, and your own half-finished brick
wall. Everything there can be built on, and changes are kept.

## Running it

    npm install
    npm run build
    node server.js

`npm run build` compiles `styles/tailwind-input.css` into
`public/tailwind.css`. three.js is served from `node_modules` at
`/vendor/three.module.js`.
