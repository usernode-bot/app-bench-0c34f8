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

## About RSS Reader

A personal RSS reader, like a quieter Feedly: the user adds the feed of
a site they follow, and every unread post across all their feeds shows
up in one scrolling list, newest first, grouped by day. Tapping a post
marks it read and opens a preview sheet with the feed's own summary and
an *Open full article* link to the site. Feeds, and their posts, are
private to the person who added them.

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** warm paper greys for the neutrals; deep teal
  (`--accent`) for the primary action and the unread dots; a source
  brown (`--source`) for feed names and their RSS badge.
- **Signature element:** the unread dot — solid teal, becoming an empty
  ring once read — and the brown RSS badge naming the source next to
  every time.
- **Type scale:** `text-title`, `text-heading`, `text-body`,
  `text-small`; post titles read serif (`font-serif`), dates, feed
  names and controls are the rounded sans (`font-rounded`).
- The screen has a light and a dark look and follows the viewer's
  Homeroom theme, switching live: the theme `<script>` in
  `public/index.html` sets a `dark` class on `<html>`.

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

- The `feeds` and `posts` tables are per-user (`user_id` on every feed,
  posts reach it through `feed_id`); both are marked
  `COMMENT ... 'staging:private'`.
- Feed URLs are only ever fetched server-side, through `guardedFetch`
  in `server.js`: http/https only, private and loopback addresses
  blocked (re-checked on every redirect), 10s timeout, 2MB cap. Never
  fetch a user-supplied URL any other way.
- `?demo=1` seeds six made-up feeds and twenty posts on staging only
  (`IS_STAGING`); demo rows carry `is_demo = TRUE` and are excluded
  from every response without `demo=1`, so the plain route stays empty.
  Demo guids are fixed (`demo-001`..`demo-020`), so seeding is
  idempotent.
- Titles and summaries come from the feed; the app stores them as text
  (no HTML) and renders with `textContent` only.
- Avoid new dependencies; fast-xml-parser is the one parsing library.
