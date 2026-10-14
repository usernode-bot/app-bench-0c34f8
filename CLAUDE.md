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
(the bread recipe calculator). The `usernode-spec-screens@1` block in
`public/index.html` is the real screen now, wired by `public/app.js`.

---

## About Bread Bot

A bread recipe calculator: pick a bread (sourdough, bagels, sourdough
bagels, rye, sandwich loaf), set the hydration, the number of loaves and
the size of each, then tap Calculate. It answers with the grams of every
ingredient, the baker's percentages, the rise time, and the oven
temperature and bake time. Nothing is saved — each visit calculates
fresh, by the creator's choice.

## Design

This app's look. Every later change follows it, and updates it when a
request changes the look on purpose.

- **Palette:** warm flour-paper neutrals (ground `250 247 242`, surface
  white, raised `243 237 227`); the accent is crust brown `132 78 38` for
  the selected bread and the Calculate button; wheat `226 190 120` (with
  wheat ink `92 60 10` on it) for the percentage bars and the
  "flour = 100%" tag. Dark look, same tokens: ground `26 20 16`, surface
  `38 30 24`, raised `50 40 32`, text `246 239 230`, muted `190 176 160`,
  line `76 63 52`, crust brown toasted to `222 166 112` with dark text
  `43 25 10` on it, wheat `201 163 92` with wheat ink `43 29 6`.
- **Signature element:** the baker's percentage page — a ruled notebook
  card on the raised tone with a wheat border, one ruled line per
  ingredient: its name, a wheat bar, and its percent of the flour.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`.
  Headings and the notebook's figures are a serif (`ui-serif`, Georgia),
  like a handwritten recipe book; the rest is the rounded system face.
- The header is the name and tagline with no tile (this app's rules allow
  only its own icon or no mark there).

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

- Recipes, their hydration/count/size limits and their rise and bake
  rules live in `RECIPES` in `public/app.js`; adjust them there.
- Nothing is stored: no table, no local storage. The calculation is a
  pure function in the page. The `?demo=1` demo is page state and writes
  nothing.
- Hydration counts only the water you add; the starter is its own
  ingredient and its water is not subtracted.
- Grams and degrees Celsius only (no Fahrenheit, ounces or cups).
- The staging demo, opened with `?demo=1`, shows the page already
  calculated for two 800 g sourdough loaves at 75%.
