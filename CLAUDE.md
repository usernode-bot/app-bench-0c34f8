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

The starter template screen was replaced by Bread Bot's first real
screen (GitHub issue #1): the one-screen calculator. The
`usernode-starter-notice@1` boilerplate is gone from `public/index.html`;
the `usernode-dev-console@1`, bridge and theme scripts and the drawn
screen's structure in `public/screens.css` remain platform/design
infrastructure — keep them.

The screen has a light and a dark look and follows the viewer's Homeroom
theme, switching live when they change it: the theme `<script>` right after
the bridge tag sets a `dark` class on `<html>`. Keep that script, and give
everything you build both looks (the design kit's colour tokens carry
both). No theme picker: the viewer's Homeroom setting is the control.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Bread Bot

Bread Bot is a bread calculator for home bakers, all client-side. Pick one
of five breads (sourdough, bagels, sourdough bagels, rye, sandwich loaf),
set hydration, loaf count and dough weight per loaf, tap **Calculate
recipe**, and it weighs out every ingredient in grams with baker's
percentages plus the rise and bake steps. Nothing is stored: no database
tables, no saving. Recipes recalculate only on the button — a changed
setting fades the recipe until then.

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** accent: crust brown (light 138 74 28 / dark 230 160 94);
  second: pale dough (240 222 186 / dark 92 66 38) for the dial track,
  chosen tiles and step icons; neutrals: flour white and dark rye (light
  250 247 241 page, 38 27 18 text) becoming dark toasted brown in the dark
  look (24 18 13 page, 245 237 224 text).
- **Signature element:** the hydration dial — a big SVG arc gauge whose
  arc grows with the slider and whose centre shows the percentage and the
  dough description ("Soft dough, open crumb"). Nothing else in the app
  draws like it.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`;
  headings and numbers use the rounded display face
  (`fontFamily.display` in `tailwind.config.js`), body stays system sans.
- **One fixed look:** none — both looks follow the viewer's Homeroom theme.

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

- All ingredient amounts are whole grams; the gram maths lives only in
  `public/recipes.js` (pure, DOM-free) so it can be reasoned about alone.
- The starter is weighed out instead of extra flour and water (half of it
  is flour, half water), so its percentage stays out of the flour
  denominator and the rows still sum to the target dough weight.
- Rise and bake times and temperatures are preset per bread and never
  scale with loaf size (deliberate, not an oversight).
- `?demo=1` is the staging preview: pre-calculated sample, labelled
  "Staging demo", nothing stored.
