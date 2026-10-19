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

## About Bread Bot

Bread Bot is a bread recipe calculator: pick one of five breads (sourdough,
bagels, sourdough bagels, rye, sandwich loaf), set the hydration, loaf count
and loaf size, and it works out the grams of every ingredient plus rise and
bake settings for that batch. One screen, pure client-side — nothing loads
from a server, nothing is saved.

## Design

This app's look: the colours of flour, crust and wheat. Every later change
follows it, and updates it when a request changes the look on purpose.

- **Palette:** accent: wheat gold; second: crust brown (the picked bread
  chip and the formula card's top edge); neutrals: flour white, warm
  brown-greys. Light and dark values live in `styles/tailwind-input.css`
  as the `ground`/`surface`/`raised`/`fg`/`muted`/`line`/`accent`/`crust`
  tokens.
- **Signature element:** the recipe card, styled as a baker's formula card —
  crust-brown top edge, dashed rules between ingredient rows, each
  ingredient's baker's percentage in small muted text beside its grams, and
  the hydration as a round dial filled in wheat gold to that percentage.
- **Type scale:** `text-title` (28/36), `text-heading`, `text-body`,
  `text-small`. Headings and the dial's number use the `font-serif` stack
  (ui-serif, Georgia); everything else `font-rounded` (ui-rounded,
  system-ui) with tabular figures for grams.
- The screen follows the viewer's Homeroom theme (light and dark); no
  theme picker.

## App-specific conventions

- All recipe data lives in `RECIPES` in `public/index.html` — the five
  breads with their baker's percentages, hydration ranges, default batch
  and rise/bake texts. The calculator is the script below it.
- The five recipes are built in and fixed (the creator's choice); only
  hydration, count and size change. Starter and yeast count as a share of
  the flour; the starter's own flour and water are not added to the
  hydration.
- Grams are shown as whole numbers, amounts under 10 g to one decimal,
  with `toLocaleString('en')` commas ("1,600 g").
- On staging, `/?demo=1` opens the screen with the demo recipe already
  worked out (2 sourdough loaves of 800 g at 75%) and a "Staging demo"
  line; it needs `data-env="staging"` on `<html>`, which server.js adds
  when `USERNODE_ENV` is staging. Nothing is stored.
- The main screen is the platform-drawn spec screen: its styles are in
  `public/screens.css`, not the Tailwind kit — change them only where
  behaviour needs it.

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

_(optional — e.g. "all currency values stored as integer cents, not
floats"; "the `posts` table is append-only"; "avoid adding new
dependencies"; etc.)_
