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

## About RSS Reader

A Feedly-style reader: the person adds the address of a feed or a site,
and the app shows every unread post from all their feeds in one
scrolling list, newest first, grouped under Today / Yesterday / Earlier.
Tapping a post opens an in-app preview and marks it read; a link opens
the full article in the browser. Feeds and read state are private to
each account. The server fetches and parses the feeds itself; the
client never talks to a feed server.

## Design

This app's look. Every change follows it, and updates it when a request
changes the look on purpose.

- **Palette:** accent is RSS orange (warm, loud enough to be the one
  brand colour); neutrals are cool greys on a near-white ground (light)
  and near-black ground (dark). Feed tiles add six source colours
  (`src-1`..`src-6`: blue, green, purple, amber, cyan, rose) used to
  tell feeds apart.
- **Signature element:** the feed letter tile — a small rounded square
  in the feed's source colour with the first letter of the feed's name
  (skipping a leading "The"). It appears on every post row, in the
  preview sheet head and on each row of the Feeds sheet.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`.
  Headlines and the preview body are serif (Charter stack, the `.serif`
  class); everything else is the kit's sans.
- Reading a post fades its row out of the list; that motion is part of
  the look, keep it when touching the list.

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

- The `feeds` and `posts` tables are marked `staging:private` (see their
  `COMMENT ON TABLE` in `server.js`). Every query on them is scoped by
  `user_id` — a person's feeds and read state are never visible to or
  writable by another account.
- The server fetches web content only through `feeds.js`'s `safeFetch`
  (public addresses only, manual re-checked redirects, 10 s timeout,
  3 MB cap). Never `fetch` a feed URL directly elsewhere in the server.
- Feed failures are `FeedError`s whose messages are written to be shown
  verbatim to the person who added the feed — keep them plain words.
- Feed colours (`feeds.color` 1..6) are assigned at insert time and
  never change; rows and tiles read them as `src-1`..`src-6`.
- Posts are deduped per feed by `guid`; unread only live in the main
  list, and read posts older than 30 days are deleted on refresh.
- Demo data (`?demo=1`) is seeded once per viewing account, but rows
  with `is_demo` are visible only to requests that carry `?demo=1` —
  the plain screen shows only the account's real feeds, so demo
  seeding never changes what an account sees without the flag.
