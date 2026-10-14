# Bread Bot — notes for Claude Code

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

The starter's placeholder screen was replaced by the app's first version
(the recipe calculator): `public/index.html` no longer carries the
`usernode-starter-notice@1` block, and `README.md` describes the real app.
The `usernode-dev-console@1` forwarder `<script>`, the bridge `<script>`
and the theme `<script>` right after it are platform infrastructure, not
app content: keep them through any rewrite. The screen still has a light
and a dark look and follows the viewer's Homeroom theme; give everything
you build both looks (the design kit's colour tokens carry both), unless
one fixed look is the point of this app, then say so under "## Design"
below. Unless a request asks for one, add no theme picker: the viewer's
Homeroom setting is the control. "The platform's light/dark theme inside
the app frame" in the platform conventions has the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Bread Bot

Bread Bot is a bread recipe calculator: pick a bread (sourdough, bagels,
sourdough bagels, rye, sandwich loaf), set the hydration, how many loaves
and how big, and it works out the grams of every ingredient, the rise time
and the oven temperature and time. It is a pure client-side calculator —
no database, no API routes, nothing saved between visits.

## Design

This app's look, set by its first version. Every later change follows it,
and updates it when a request changes the look on purpose.

- **Palette:** flour and parchment neutrals (warm cream ground, white
  surface, warm grey-brown text) with a crust brown as the one action
  colour: light `140 82 40`, dark `217 154 98`. Named only as the kit's
  tokens in `styles/tailwind-input.css`.
- **Signature element:** the baker's percentage dial — a ring that fills to
  the hydration with the number in its centre, beside a plain-words line
  ("720 g water for every 1,000 g flour"). The recipe repeats the baker's
  formula: each ingredient row shows its grams large and its percentage of
  the flour small and muted.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`,
  on `ui-rounded` (the system's rounded face, friendly like a kitchen
  notebook), set in `tailwind.config.js`.
- **The filled-control rule:** Bake It is the only filled control on the
  screen. The selected bread chip is outlined in crust brown with a check,
  never filled; the rise and bake cards' icons take the accent.

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
  own shape (its rows, with `skeleton` bars for their text). Bread Bot loads
  nothing, so it has no loading or error state: before the first Bake It it
  shows the empty state alone.
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions).
- No cards in cards, no uppercase eyebrows, no emoji as icons.
- A header that shows the app's own mark shows the project's icon there
  (the emoji in `dapp.json`'s `icon` block) or no mark at all: never an
  empty tile, and never `brand/icon.png`, which the app does not serve.

## App-specific conventions

- Grams are whole, or one decimal under 10 g ("5.4 g" of yeast); the
  rounding remainder goes on the largest flour row so the rows always add
  up to the total dough weight exactly.
- Recipes come from the `BREADS` table in `public/app.js`: simple standard
  ratios per bread as baker's percentages of the flour. Sourdough breads
  use a starter, the yeast breads use instant yeast, and the starter is
  listed as its own ingredient rather than counted in the flour and water.
- Picking a bread resets hydration and size to that bread's usual values
  but keeps the loaf count.
- Rise times are estimates for a room at about 24°C; bake times assume a
  home oven.
- The staging demo is the `?demo=1` UI state in `public/app.js` (Sourdough,
  72%, 2 × 750 g, recipe shown): it stores nothing, so nothing is gated on
  `USERNODE_ENV`.
