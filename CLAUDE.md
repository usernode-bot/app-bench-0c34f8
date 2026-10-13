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

A personal RSS reader in the Feedly style. Each person adds the RSS or
Atom feeds they follow and sees all their unread posts in one scrolling
list, newest first, with a count line ("23 posts from 4 feeds"). Tapping
a post marks it read right away (the creator chose this) and opens a
preview with the post's summary; "Open full article" opens the post's
own link in the browser, and read posts leave the list on close. Feeds
and reading state are per viewer; guests can look at the shell but every
write needs an account. Adding a feed is validated by actually fetching
it through the guard in `feed.js`: not reachable or not a feed answers
400 with a plain reason, one you already have answers 409. A feed that
fails on refresh keeps its saved posts and shows a failure line above the
list. Not in this version: removing or renaming feeds, autodiscovery,
OPML, filtering, mark-all-read, unread-again, a read list, background
refresh, pull-to-refresh, images or HTML in previews, sharing, saving,
notifications.

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** accent RSS orange (light 194 65 12 with white text on it;
  dark 251 146 60 with near-black-orange text on it); no second colour;
  cool paper-grey neutrals, slightly blue-cool in light, blue-dark in dark.
- **Signature element:** the masthead tag — each post names its feed in a
  bold italic serif tag with a soft orange underline; the preview body is
  serif too.
- **Type scale:** `text-title` (28/34), `text-heading` (22/28),
  `text-body` (17/24), `text-small` (14/20), set in `tailwind.config.js`.

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

- Both tables (`feeds`, `posts`) are per viewer and marked
  `staging:private`; the staging demo (`?demo=1`, staging only) stands in
  four made-up feeds with 23 unread posts. Demo feeds are never fetched
  and demo posts carry no link.
- Read posts leave the unread list on preview close; there is no read
  list and no unread-again.
- The only server dependency beyond the platform's is `fast-xml-parser`
  (feed parsing). Avoid adding more.
- Feed fetches always go through the guard in `feed.js`; never fetch a
  feed URL directly.
