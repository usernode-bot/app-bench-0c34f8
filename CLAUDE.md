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

Replaced: the first version (the reader) replaced the starter screen, and
README.md describes the actual app. The platform's spec screens live in
`public/index.html` and `public/screens.css`; keep the dev-console
forwarder `<script>`, the bridge `<script>` and the theme `<script>` when
editing the HTML.

If a rule below conflicts with the hosted conventions, the hosted
conventions win. This file is **app-specific** — write down things about
*this* app that belong in the repo: product intent, data-model quirks,
style preferences, opt-in policies (e.g. which tables you've marked
private), etc.

---

## About RSS Reader

RSS Reader is a personal feed reader, like Feedly: each member adds their
own RSS 2.0 or Atom feeds (by exact feed address), scrolls one mixed list
of unread posts from all of them with the newest first, and taps a post to
read a preview with the feed's text as plain paragraphs and a button that
opens the full article in the browser. Opening a preview marks the post
read. Feeds and read state are private to each member. Feeds refresh when
the app opens; there is no background refresh, no folders, no OPML.

## Design

This app's look. Set by the first version's spec; every later change
follows it, and updates it when a request changes the look on purpose.

- **Palette:** warm paper neutrals (ground `247 245 240` / `24 21 18`,
  surface white-warm, warm grey line and muted text), one calm action
  colour: deep teal `15 118 110` / `45 190 175`, and five feed spine
  colours given out in turn as feeds are added (`--f1` to `--f5`: brick,
  blue, ochre, plum, leaf; dark values in the same hue).
- **Signature element:** each post row carries a small feed-coloured spine
  strip down its left edge, so the mixed list reads like stacked magazine
  spines; the same colour appears as a tick in the preview and next to
  each feed in the feeds list.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  (unchanged in `tailwind.config.js`). Headings and article text are set
  in a serif (`font-display`: ui-serif/Georgia); labels in the rounded
  sans the screens use.
- Both looks follow the viewer's Homeroom theme; there is no fixed look.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`page-column`, `btn-primary`, `btn-secondary`, `field`, `list`, `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, `--f1` to `--f5`, ...): never a raw hex value or a
  stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- A field's label says what it is; its placeholder, if any, is an example
  that says so ("e.g. 5.0"), never a bare value that could pass for one
  already entered.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry. Loading has the content's
  own shape (its rows, with `skeleton` bars for their text).
- The staging demo is `/?demo=1` (staging only): the viewer's own five
  made-up feeds with about 14 unread posts, labelled once with
  `data-usernode-demo-note` in the list label.
- No cards in cards, no uppercase eyebrows, no emoji as icons.

## App-specific conventions

- Both tables (`feeds`, `posts`) are marked `staging:private`: they hold
  whose feeds a person follows and what they have read.
- Feed text is stored and shown as plain text only (`excerpt` about 200
  characters, `body` about 20 KB of plain paragraphs). Nothing from a feed
  may run in the page: render feed-derived strings with `textContent`,
  never markup.
- Every feed fetch goes through `safeFetch` in `server.js` (http and https
  only, SSRF-guarded, at most 3 redirects, 8 s, 2 MB). Don't fetch feed
  URLs around it.
- Words: "feed", "post", "unread", "Add feed", "Open full article",
  "Remove", "Refreshed", "All caught up". A post is marked read the moment
  its preview opens.
- `fast-xml-parser` is the only dependency added so far; avoid adding
  more unless a request needs them.
