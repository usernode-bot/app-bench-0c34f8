# Bread Bot — notes for Claude Code

This app runs on **Homeroom**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Homeroom's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

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
its silence is not proof the checkout is current. Inside Homeroom's dev-chat
the platform fixes the base commit, and none of this applies.

## Starter template

Replaced by the real app (the recipe calculator). The
`usernode-starter-notice@1` block is gone from `public/index.html`; the
`usernode-dev-console@1` forwarder `<script>`, the bridge `<script>` and
the theme `<script>` right after it are platform infrastructure — keep
all three. The app follows the viewer's Homeroom theme (light and dark);
do not add a theme picker.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Bread Bot

Bread Bot is a bread recipe calculator for home bakers. The user picks
one of five breads (sourdough, bagels, sourdough bagels, rye, sandwich
loaf), sets hydration, loaf count and loaf size, taps Calculate, and
gets every ingredient in grams, the rise steps with times, and the
bake plan. Recipes can be saved, reopened with one tap, and deleted.

## Design

This app's look. Every later change follows it, and updates it when a
request changes the look on purpose.

- **Palette:** accent is crust brown (light `122 69 24`, dark
  `232 170 92` — a warm gold in the dark look), second colour is wheat
  gold (the crumb fill and the suggested-range band), on a flour-pale
  ground with warm grey-brown neutrals. Both values live in
  `styles/tailwind-input.css` as `--accent` / `--wheat` / the neutrals.
- **Signature element:** the crumb slice — a small SVG slice of bread
  beside the hydration readout whose holes grow and multiply as
  hydration rises (r = baseR × (0.35 + 1.3 × (h−50)/40)), so the
  slider's effect is visible at a glance.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  — four sizes, nothing in between.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`), plus
the app's own controls (`.chip`, `.segmented`, `.stepper`, `.range-wrap`).
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
  ("Staging mock data" in the platform conventions). Here: seven recipes
  named "Staging demo: …", behind `IS_STAGING && ?demo=1`, written once
  per viewer.
- No cards in cards, no uppercase eyebrows, no emoji as icons.

## App-specific conventions

- **All bread math lives in `public/bread.js`** (shared by browser and
  server). Never compute ingredient grams, rise times or bake plans
  anywhere else, and keep the server-side validation reading the same
  module's `validInputs`.
- **Saved recipes store inputs, never results.** The `saved_recipes`
  table holds bread, hydration, loaf count and size; the result is
  always recomputed on open, so a formula fix reaches every saved
  recipe.
- `saved_recipes` and `demo_seeds` are marked `staging:private`
  (schema-only staging copies): they hold per-user data with nothing
  worth copying into a staging demo except the seeded rows the app
  writes itself.
- **Check sign-in:** `dapp.json` declares `inLoopCheckAuth` pointing at
  `POST /api/check-session`, a staging-only endpoint that signs the
  browser in as one fixed fake account (`check-user`) so
  `usernode-run-checks` can exercise the protected routes locally. Keep
  it staging-only, keep it fixed to that one account, and never let it
  read anyone else's data.
- Gram values round to whole grams, except anything under 10 g (salt,
  yeast) which keeps one decimal.
- No new npm dependencies without a strong reason; the app currently
  needs only express, pg and jsonwebtoken.
