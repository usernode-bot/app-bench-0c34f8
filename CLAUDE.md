# RSS Reader — notes for Claude Code

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

## Template already replaced

The starter-template screen was removed when the first real feature was
built (the unread list in `public/index.html`, rendered by
`public/app.js`); `README.md` describes the actual app. The platform
infrastructure stays: the bridge `<script>`, the theme `<script>` right
after it, and the `usernode-dev-console@1` forwarder.

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

## About RSS Reader

A quiet, unread-first RSS reader. Each viewer adds their own RSS or
Atom feeds by https address; new posts collect in one list grouped
Today, Yesterday and Earlier. Opening a post's preview marks it read
and shows the summary the feed shares, with an "Open in browser"
button for the full article on the publisher's site. Feeds and read
state are per person, never shared.

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** cool grey neutrals (ground/surface/raised) with one orange
  accent — burnt orange in the light look (`--accent: 194 65 12`),
  bright orange in the dark (`251 146 60`); the unread dot uses the
  brighter `--unread` orange. Danger and focus follow the same warm range.
- **Signature element:** the orange unread dot on every unread row, and
  the feed mark in the header — a dot with two radiating waves, the
  classic feed symbol drawn in the accent. The empty state redraws it
  over a folded page.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`.
  Post titles and preview summaries are serif (the `font-serif` stack:
  Charter and friends); all app chrome — chips, meta, buttons, labels —
  is the kit's sans.

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

- The `feeds`, `posts` and `demo_seeds` tables are marked
  `staging:private`: feeds and read state are per viewer and never
  shared between people.
- Feed text is always put on the page as text, never as HTML:
  `lib/feeds.js` reduces every summary to plain text and the page
  inserts it through the kit's `h()` (text nodes only).
- Feed fetching is https-only with a strict URL guard in
  `lib/feeds.js` (no private or loopback addresses, redirects
  re-checked, 8 s timeout, 2 MB cap). Don't weaken it.
- Demo feeds (staging `?demo=1`) are invented in `lib/demo-feeds.js`
  and are never fetched from the network.
- No new npm dependencies: `lib/feeds.js` uses only Node's own modules.
- A new feed keeps only its 50 newest items; items older than 14 days
  are stored already read.
