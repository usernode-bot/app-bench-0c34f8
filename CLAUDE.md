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

The screen this app currently ships — the "Starter template" hero with
the app's thumbnail tile and the plain-English note on how the app gets
built (by asking Homeroom bot) — is placeholder content from the
Homeroom starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the `usernode-starter-notice@1` block in `public/index.html`
  (both sentinel comments and everything between them),
- rewrite `README.md` to describe the actual app.

Keep the `usernode-dev-console@1` forwarder `<script>` when rewriting the
HTML — that block is platform infrastructure, not template content. So is
the bridge `<script>`. The design kit is not placeholder either: build the
real app with it, and fill in "## Design" below.

The screen has a light and a dark look and follows the viewer's Homeroom
theme, switching live when they change it: the theme `<script>` right after
the bridge tag sets a `dark` class on `<html>`. Keep that script, and give
everything you build both looks (the design kit's colour tokens carry both), unless one
fixed look is the point of this app, like a game's own scene; then say so
under "## Design" below. Unless a request asks for one, add
no theme picker: the viewer's Homeroom setting is the control. "The
platform's light/dark theme inside the app frame" in the platform
conventions has the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Block World

A shared 3D voxel world, like creative mode: one flat grass plain that
everyone in the project flies around, placing and breaking blocks from a
palette of six classic types. The world is the screen. Changes arrive live
for everyone with it open.

## Design

One job: building. The world fills the whole window and the quiet panels sit
on top of it; on a wider window the controls stay in one centred column. The
palette of little 3D cubes is the signature element, each cube drawn in the
material of the block it places.

- **Palette:** accent: brick orange (light `194 65 12`, dark `251 146 60`,
  with dark text `28 25 23` on the dark accent); the held swatch is soft
  orange (`--accent-soft`); neutrals: warm greys (`ground`, `surface`,
  `raised`, `line`), dark in the dark look. The six block materials do not
  change between looks: grass `84 150 62`, stone `130 130 134`, wood
  `150 100 56`, glass `160 210 230` (see-through), brick `166 70 52`, sand
  `216 190 120`. The sky is `--sky-top` to `--sky-bottom`: daylight on the
  light look, dusk on the dark one, with dimmer sunlight on the blocks.
- **Signature element:** the block palette as a row of little 3D cubes in
  their own materials, like holding a block in your hand.
- **Type scale:** `text-title` 20/28, `text-heading` 16/24 bold, `text-body`
  15/22, `text-small` 14/20, in the rounded system face (`ui-rounded`).
- **Screen shape:** this app is its own scene, so its screen fills the window
  rather than sitting in a `page-column`; the floating controls keep to a
  42rem column in the middle on a wide window.

Both looks are kept: the viewer's Homeroom theme sets them, and the world's
light and sky follow it.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`page-column`, `btn-primary`, `btn-secondary`, `field`, `list`, `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, ...): never a raw hex value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- A field's label says what it is; its placeholder, if any, is an example
  that says so ("e.g. 5.0"), never a bare value that could pass for one
  already entered.
- Each screen sits in `page-column`, one centred column on a wide window.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry. Loading has the content's
  own shape (its rows, with `skeleton` bars for their text).
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions).
- No cards in cards, no uppercase eyebrows, no emoji as icons.
- A header that shows the app's own mark shows the project's icon there
  (the emoji in `dapp.json`'s `icon` block) or no mark at all: never an
  empty tile, and never `brand/icon.png`, which the app does not serve.

## App-specific conventions

- One shared world for the whole project. `blocks` holds one row per cell,
  keyed `(x, y, z)`. The grass plain is y = 0 and is never stored or
  breakable; builds run from y = 1 to y = 32, with x and z in -32..31.
- `is_demo` rows are the staging demo's builds. They are only read back on
  staging with `?demo=1`; placing on a cell turns it into a normal row
  (`is_demo = false`). Never show `is_demo` rows on a plain route.
- The six block types are a fixed set (`grass`, `stone`, `wood`, `glass`,
  `brick`, `sand`); their colours live in `styles/tailwind-input.css` as
  `--mat-*` tokens and are the same in both looks.
- The world's live updates are Server-Sent Events on `/api/stream`. Every
  edit is applied optimistically and rolled back if the save fails.
