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

The starter template was replaced by the app's first real screen (the
calculator). The notes that remain are platform infrastructure: keep the
`usernode-dev-console@1` forwarder `<script>`, the bridge `<script>` and
the theme `<script>` in `public/index.html` through any rewrite.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Bread Bot

Bread Bot is a bread recipe calculator. The user picks one of five breads
(sourdough, bagels, sourdough bagels, rye, sandwich loaf), sets hydration,
loaf count and dough weight per loaf, and taps Calculate to get every
ingredient in grams with its baker's percentage, the rise steps, and the
bake temperature and time. Everything is worked out in the browser: no
database, no accounts, nothing saved. The formulas are the single source
of truth in `public/breads.js`; `public/app.js` only renders.

## Design

This app's look: a baker's notes. Every later change follows it, and
updates it when a request changes the look on purpose.

- **Palette:** flour and crust. Neutrals are pale flour white (light
  ground) through dark crust (dark ground and text); the action colour is
  a deep baked crust brown in the light look and a wheat amber in the
  dark, each with cream/dark-crust text on it. A second colour, wheat
  (`--wheat`), only tints the chosen bread chip. Values live in
  `styles/tailwind-input.css` (`:root` and `.dark`), named in
  `tailwind.config.js`.
- **Signature element:** the recipe card as a baker's formula — flour at
  100%, every other ingredient a percentage of it, tabular numbers lined
  up in columns, the total under a double rule like a ledger.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  (unchanged). Headings use the rounded system face (`fontFamily.rounded`,
  `ui-rounded` with a system-ui fallback); numbers are tabular so columns
  line up.
- **No fixed look:** both looks follow the viewer's Homeroom theme, via
  the theme `<script>` in `public/index.html`.

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
- Nothing here loads over the network, so there is no loading state; the
  recipe card has an honest empty state before the first Calculate, and
  the dough-weight error shows under its field.
- The staging demo (`?demo=1` on staging) is just the starting state with
  the sample recipe already calculated, labelled once with a
  "Staging demo" line; it stores nothing.
- No cards in cards, no uppercase eyebrows, no emoji as icons.
- A header that shows the app's own mark shows the project's icon there
  (the emoji in `dapp.json`'s `icon` block) or no mark at all: never an
  empty tile, and never `brand/icon.png`, which the app does not serve.

## App-specific conventions

- Amounts are shown in grams only (temperatures: Celsius with Fahrenheit
  in brackets); no ounces or cups unless a request asks.
- Hydration is the water as a percentage of flour; the starter is its own
  ingredient line, not part of the hydration.
- Loaf size is the dough weight per loaf in grams, 50 to 3000; count is
  1 to 24; hydration 50 to 100 in steps of 1.
- Bake minutes scale by the cube root of dough weight against each
  bread's reference size, rounded to 5 min (1 min for bagels); boil time
  does not scale. Fahrenheit is rounded to the nearest 5.
- Keep `public/breads.js` pure (no DOM) so the maths stays checkable on
  its own; `public/app.js` renders the drawn screen in `public/index.html`
  through `fill.js`, rather than rebuilding its markup.
- Avoid adding new dependencies; the app has none beyond the template's.
