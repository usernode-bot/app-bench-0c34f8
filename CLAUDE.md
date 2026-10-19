# Block World — notes for Claude Code

This app runs on **Homeroom**. The platform conventions are the single
source of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.):

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

**Inside Homeroom** (its dev chat, and Homeroom bot's builds), do not
fetch that URL: what applies to your change is already in your
instructions, and the `homeroom` MCP server's
`get_platform_conventions` reads any one section of the conventions
when you need it. The two sections below are for working outside
Homeroom; skip them there.

**Anywhere else** (Claude Code run against this repo locally, or another
harness), fetch it at the start of each session. The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

## Connector permission prompts (outside Homeroom)

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) once you accept the workspace trust dialog.
See `.claude/README.md` for the whole story, including what to do if you
are still being prompted.

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom (its dev
chat, and Homeroom bot's builds) the platform fixes the base commit, and none
of this applies.

## Starter template

The starter template was replaced by the real app in the first version:
the template screen and its notice are gone, and `README.md` describes
the app. The `usernode-dev-console@1` forwarder, the bridge `<script>`
and the theme `<script>` in `public/index.html` are platform
infrastructure — keep them through any later rewrite.

The world screen is the app's own scene: unlike a reading screen, it
fills the window (`.bw` is full-height rather than a `page-column` —
the one deliberate exception, because it is a 3D world). It still has a
light and a dark look that follow the viewer's Homeroom theme; add no
theme picker.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Block World

A shared 3D voxel building space for the project, like a block game's
creative mode: everyone flies around one flat grass plain, places and
breaks blocks from a palette of six classic types, and sees everyone
else's builds appear live. One world for the whole project; no gravity,
no survival, no avatars.

## Design

This app's look. Every later change follows it, and updates it when a
request changes the look on purpose.

- **Palette:** warm stone-grey neutrals (`ground`, `surface`, `raised`,
  `fg`, `muted`, `line`); one action colour, a brick orange — light
  194 65 12, dark 251 146 60 with dark text 28 25 23 on it (`accent`,
  `on-accent`), with a soft orange for the held palette swatch
  (`accent-soft`, light 255 237 224, dark 67 30 10); sky tokens
  (`sky-top`/`sky-bottom`, dusk in the dark look) and `grass` for the
  plain behind the canvas. The six block materials are fixed colours,
  never tokens: grass 84 150 62, stone 130 130 134, wood 150 100 56,
  glass 160 210 230 (see-through), brick 166 70 52, sand 216 190 120 —
  the same in both looks, so a cube in the palette looks like the block
  it places. In the dark look the panels go dark grey and the sky turns
  to dusk, with dimmer sunlight on the blocks.
- **Signature element:** the palette of little 3D cubes, each drawn in
  its own material, like picking a block up in your hand. The world
  itself fills the screen; the quiet panels sit on top of it, and the
  brick orange marks only the tool you are holding.
- **Type scale:** `text-title` 20/28, `text-heading` 16/24 bold,
  `text-body` 15/22, `text-small` 14/20, in the rounded system face
  (`ui-rounded`), which suits the toy-block feel.
- **One fixed look:** none — both looks, following the viewer's theme.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`page-column`, `btn-primary`, `btn-secondary`, `field`, `list`, `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, ...) plus the six fixed block materials: never a raw
  hex value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- A field's label says what it is; its placeholder, if any, is an example
  that says so ("e.g. 5.0"), never a bare value that could pass for one
  already entered.
- The world screen fills the window (see "Starter template" above); any
  later, ordinary screen sits in `page-column`.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry. Loading has the content's
  own shape (its rows, with `skeleton` bars for their text).
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions). Block World's demo is
  `?demo=1` only: builds by Maya, Dev, Sam and Priya, marked `is_demo`.
- No cards in cards, no uppercase eyebrows, no emoji as icons.
- A header that shows the app's own mark shows the project's icon there
  (the emoji in `dapp.json`'s `icon` block) or no mark at all: never an
  empty tile, and never `brand/icon.png`, which the app does not serve.

## App-specific conventions

- One world, one `blocks` table (public): primary key `(x, y, z)`;
  `type` is one of the six; `placed_by`, `placed_at`; `is_demo` rows are
  hidden from every answer without `?demo=1` on staging. `demo_seeded`
  keys (`'world'`, `'viewer:<username>'`) make the demo idempotent.
- Bounds are checked on the server: x and z in -32..31, y in 1..32
  (y 0 is the grass plain, which cannot be broken). A place is an upsert
  that sets `is_demo=false`.
- Writes need an account; guests may read and fly. Any signed-in person
  can break any block, whoever placed it.
- Live updates go through `/api/stream` (SSE: `set`, `clear`, `presence`),
  heartbeat every 25s. Edits are optimistic in the client and rolled back
  on failure.
- three.js is the only runtime dependency beyond the platform's; it is
  served from `node_modules` at `/vendor/three.module.js` (plus
  `three.core.js`, which the module imports). Avoid adding new
  dependencies.
