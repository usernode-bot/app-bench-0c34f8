# Tier List — notes for Claude Code

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

## About Tier List

A shared tier list for a Homeroom group: separate lists per topic
(restaurants, movies), anyone adds items, everyone drags each item into
their own S to D tiers, and every item opens to show the crowd's tally and
who voted where, by name. The crowd's tier is a simple tally (see
"App-specific conventions"), not a weighted score.

## Design

This app's look, set by its first version. Every later change follows it,
and updates it when a request changes the look on purpose.

- **Palette:** cool grey neutrals (ground, surface, raised, line) so the
  tier colours stay the loudest thing on screen; one cobalt ink accent
  (`accent`, the only filled button colour, and the focus ring) that the
  ladder never uses, so an action reads as ink, not as a tier. The five
  tier colours are the subject's own, light pastel bands and dark deep
  bands: `tier-s` warm red, `tier-a` orange, `tier-b` yellow, `tier-c`
  lime green, `tier-d` green.
- **Signature element:** the tier ladder. Five stacked rows, each a solid
  label cell on the left holding the tier letter in large heavy rounded
  type on the tier's full colour, beside a row area tinted with the same
  colour at about a third strength. The same five colours, as 22 px letter
  squares (`mark`), mark the crowd's tier or yours beside every item and
  back the tally bars in an opened item, so one colour always means one
  tier. Text on a tier colour is always `text-fg`, never white.
- **Type scale:** `text-title` (28, weight 800, rounded face), `text-heading`
  (20), `text-body` (16), `text-small` (13/18). Tier letters, the list name
  and an opened item's name use `font-rounded` (the system's rounded face,
  SF Pro Rounded on Apple devices); everything else is the system face.
- Both looks follow the viewer's Homeroom theme and switch live; there is
  no theme picker.

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

## App-specific conventions

- Tier letters are the fixed set S, A, B, C, D on every list; lists do not
  get custom tier names.
- The crowd's tier is a plain tally of who placed each item where, no
  weighted scoring. Ties go to the tier nearest the median vote, then to
  the higher tier. That logic lives only in `public/crowd.js`, shared by
  the page (`window.TierCrowd`), the server and the tests — never
  reimplement it.
- Demo rows (lists, items, votes from the made-up `staging-demo-*` people)
  are `is_demo = true` / seeded behind `IS_STAGING`, and are read or
  written only on requests carrying `?demo=1` in staging. The viewer's own
  demo votes are written once per account (tracked in `demo_viewers`);
  edits the viewer makes afterwards stay.
- A vote is one row per person per item (`placements`); "not ranked" means
  no row. Within a tier, a person's items keep the order they were placed;
  no finer order is kept.
- Item names are text only, trimmed and whitespace-collapsed, 1 to 60
  characters, unique per list ignoring case and spacing.
- Timestamps come from `req.now`, never `NOW()`.
