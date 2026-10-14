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

## Starter template → replaced

The starter-template screen was replaced by the app's real screen in the
first version (issue #1). The `usernode-dev-console@1` forwarder script,
the bridge `<script>` and the theme `<script>` in `public/index.html` are
platform infrastructure — keep them through any future rewrite.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Bread Bot

One screen: the user picks a bread (Sourdough, Bagels, Sourdough bagels,
Rye, Sandwich loaf), sets hydration, how many loaves/bagels, and flour
per piece, and taps "Calculate recipe" to get a baker's formula sheet —
grams and baker's % per ingredient (flour at 100% on top), rise
time/temperature, oven temperature and bake time. Recipes can be saved
(named or auto-named "Sourdough, 2 loaves"), reopened and deleted. The
maths is all client-side (`public/formulas.js`); the server only stores
the four settings + name and returns saved recipes.

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** accent: deep wheat gold (light `146 98 12`, dark
  `222 170 72`); second: crust brown (`crust` token, light `122 72 38`,
  dark `196 132 86`) for the selected bread chip and the formula sheet's
  outline; neutrals: flour white ground, white surfaces, pale oat raised,
  warm brown text.
- **Signature element:** the baker's formula sheet — the ingredient table
  with the flour row shaded at 100%, closed by the three-part Rise / Bake
  / Time footer.

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

- `public/formulas.js` is the single source of truth for the five breads
  (baker's percentages, defaults, flour ranges, rise/bake values) and the
  auto-name ("Sourdough, 2 loaves"). The server's `BREAD_LABELS`/`UNITS`
  maps in `server.js` are kept in sync by hand — change both together.
- Hydration counts **added water only**, not the water inside the starter.
- Rye's 100% is a 60/40 mix: rye flour, bread flour.
- Flour per piece: loaves 200–1500 step 50 g; bagels 50–200 step 10 g.
  Hydration 50–85 step 1; count 1–24. Picking a bread resets hydration
  and flour to that bread's defaults, keeps the count.
- `saved_recipes` is marked `staging:private`. The formula is never
  stored — only the four settings + name; the sheet recomputes.
- Demo rows (`is_demo = true`, six fixed `demo_key`s) are inserted only
  behind `IS_STAGING && ?demo=1` and are excluded from responses without
  `?demo=1`, so plain loads still see the honest empty state.
- No new dependencies.
