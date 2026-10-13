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

## The screen

The main screen (`div[data-spec-screen="1"]` in `public/index.html`,
styled by `public/screens.css`) was drawn from the spec before the first
version was built. Keep its markup: wire behaviour with `data-*` hooks
and render its rows from data (`rowsFrom` in the kit keeps the drawn row
as the template). Do not redraw it; change it only where behaviour needs
it.

## About Bread Bot

A bread recipe calculator. The user picks one of five breads (sourdough,
bagels, sourdough bagels, rye, sandwich loaf), sets hydration, loaf/bagel
count and flour per loaf, and taps Calculate: they get the grams of every
ingredient with baker's percentages, the total dough weight, and the
steps in order — rises adjusted for hydration, the boil for bagels, and
the bake in °C and °F. Nothing is saved; there is no history and no
accounts beyond the platform's sign-in.

## Design

A flour-and-crust kitchen look: warm paper neutrals, a crust-brown
accent, and a doughy crumb tint behind the chosen chip and the step
icons. Both looks come from the same tokens (dark ground is a dark
crust, the accent warms to baked-crust orange).

- **Palette:** accent: crust brown (light `132 70 28`, dark `224 160 96`);
  second colour: crumb (the doughy tint, light `236 226 210`, dark
  `66 48 32`); neutrals: warm paper greys (ground/surface/line).
- **Signature element:** the recipe card — ingredient lines with dotted
  leaders, right-aligned tabular-nums grams, a baker's % column, a
  dashed divider, then the steps with line-drawn clock/dough/oven icons
  in crumb circles.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
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
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry.
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions).
- No cards in cards, no uppercase eyebrows, no emoji as icons.
- A header that shows the app's own mark shows the project's icon there
  (the emoji in `dapp.json`'s `icon` block) or no mark at all: never an
  empty tile, and never `brand/icon.png`, which the app does not serve.

## App-specific conventions

- **No data is stored.** No tables, no API writes; the scaffold database
  is unused. All the recipe maths is pure and lives in
  `public/recipes.js` — the screen (`public/app.js`) never does maths.
- Units and maths: hydration, percentages and counts are integers; grams
  are whole numbers (one decimal only below 10 g); salt is always 2% of
  flour; rises shift 10% per 5 hydration points from the bread's default;
  the bake shifts 5 min per 250 g of flour from the starting size.
- The staging `?demo=1` prefill is gated on the SERVER's environment,
  which it marks as `data-env="staging"` on `<html>` when serving the
  shell — never on the URL alone.
