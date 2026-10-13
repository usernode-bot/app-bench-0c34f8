# Club Votes — notes for Claude Code

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

## About Club Votes

A place for a club to decide things together. Anyone posts a yes/no
question, everyone votes (one vote per person, changeable, takeable
back), counts show live on the card, and comments sit under each
question for talking it through. Questions can be reported (hidden for
the reporter at one report, for everyone at three) and their authors can
delete them.

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** warm paper neutrals (off-white ground, warm dark grey
  text in the light look; warm dark browns in the dark look) with one
  accent: ballot-ink indigo. Everything carries both looks; the viewer's
  Homeroom theme is the switch, and no theme picker exists.
- **Signature element:** the hand-tally marks — votes drawn as tally
  strokes in gates of five (four strokes plus the slash), capped at 30
  before the number stands alone. The square ballot mark fills with the
  accent when yours.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`.
  Question titles and the app title set in `font-ballot` (the platform's
  system serif, named in `tailwind.config.js`); everything else system-ui.
- The kit is in `styles/tailwind-input.css`: colour tokens with a light
  and a dark value (named in `tailwind.config.js`), and a few components
  (`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
  `card`, `section-label`, `skeleton`, `state-empty`, `state-error`).
  Re-theme by changing the token values there, keeping every text pair at
  4.5:1 or more in both looks.
- The drawn screens (`data-spec-screen="1"` in `public/index.html`, the
  screen 2 template) and `public/screens.css` carry the app's own
  component styles (`.card.q`, `.ballot`, `.kit-vote`, …), token-based.
  Their class rules are the styling source for those pieces; the screen 2
  overrides in `screens.css` are scoped to `[data-spec-screen="2"]` so
  they cannot retune the list screen.

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

- Ballot options are fixed: option 0 is Yes, option 1 is No. The kit's
  `resource` was mounted with `options: ['Yes', 'No']`; do not change the
  order or the labels.
- The `reports` table (in `server.js`) is marked `staging:private` and has
  no foreign key to the questions tables; who reported what must not show
  anywhere. Hiding is enforced in the `hiddenFor` middleware: one report
  hides a post for its reporter, three distinct reporters hide it for
  everyone (a hidden question answers 404 "That question is no longer
  here."; hidden comments drop out of the detail answer and the list's
  comment counts).
- `public/app.js` is the only screen logic; the drawn screens in
  `public/index.html` stay the shape of their markup — app code fills
  them (kit `fill.js`), it does not redraw them with `h()`.
