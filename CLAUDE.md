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

Replaced by the first real version: the spec's bread calculator screen
(the one drawn under `usernode-spec-screens@1`). The starter guidance
below still holds where it is about platform infrastructure.

Keep the `usernode-dev-console@1` forwarder `<script>` in
`public/index.html` — platform infrastructure, not template content. So is
the bridge `<script>` and the theme `<script>` that sets a `dark` class on
`<html>` from the viewer's Homeroom setting. Give everything both looks
(the design kit's colour tokens carry both). Unless a request asks for
one, add no theme picker: the viewer's Homeroom setting is the control.
"The platform's light/dark theme inside the app frame" in the platform
conventions has the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Bread Bot

Bread Bot turns a few settings into a bread recipe you can bake from: pick
a bread (sourdough, bagels, sourdough bagels, rye, sandwich loaf), set the
hydration, the loaf count and the baked weight per loaf, and it works out
the grams and baker's percentages of every ingredient, the rise-and-bake
timeline, and the oven setting scaled to loaf size. Everything is computed
in the browser; nothing is saved. The spec's drawn screens live in
`public/index.html` / `public/screens.css` — keep their markup and styles,
wire behaviour only.

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** warm flour-pale neutrals; one accent, crust brown
  (light `140 74 30`, dark `232 160 92`); plus `--wheat` and `--crumb`,
  two colours that exist for the timeline (rise in crumb, proof in wheat,
  bake in the accent). The drawn screen's colours live in the tokens.
- **Signature element:** the recipe sheet laid out like a baker's formula —
  grams beside baker's percentages under the bread's name — with the
  rise-and-bake timeline strip under it (segment widths follow the real
  stage durations) and a drawn line icon per bread.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`,
  system-ui sans; even-width figures (`.num`) so table columns line up.
- No fixed look: everything follows the viewer's Homeroom theme.

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

- The recipe maths is in `public/app.js` and runs entirely client-side;
  there is no recipe storage and no `/api` route. Grams round to whole
  numbers (yeast to the half gram); bake time scales with loaf size by the
  cube root of the weight against each bread's reference loaf, to the
  nearest 5 minutes.
- Valid baked weight is 50–3,000 g; loaves 1–24. Weight values are typed
  grams, never stored floats — nothing is stored at all.
- The staging demo (`?demo=1`, only when `data-staging="1"` on `<html>`)
  prefills Sourdough, 75%, 2 loaves, 900 g. Production ignores `?demo=1`.
