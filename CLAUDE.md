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

The starter template screen has been replaced by the real app (first
version, spec'd in issue #1). The `usernode-dev-console@1` forwarder
`<script>`, the bridge `<script>` and the theme `<script>` in
`public/index.html` are platform infrastructure, not template content —
keep them. The real screens (the unread list and the preview sheet) are
drawn screen markup in `public/index.html` with styles in
`public/screens.css`, filled from data by `public/app.js` using the kit
in `public/kit/` (`rowsFrom`/`fillIn`, `createStates`, `openSheet`,
`openFormSheet`).

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About RSS Reader

A Feedly-style reader for a Homeroom group: add an RSS feed by link, see
all unread posts from all your feeds in one newest-first list, tap a post
for a preview (tapping marks it read) with an "Open in browser" link, and
remove feeds. Feeds, posts and read state are per-user and private. This
first version does nothing more: no site-to-feed discovery, OPML,
folders, filters, mark-all-read or background fetching.

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** RSS orange accent (`--accent` in light, a brighter tangerine
  in dark) over warm paper neutrals (warm off-white ground, warm browns for
  text and lines); danger red for error states only.
- **Signature element:** the RSS broadcast mark (a dot with two arcs, in
  `--signal`) and the orange unread dot beside every unread post; titles
  and the preview body are set in serif.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  (`text-heading` is 1.125rem for row titles).
- **One fixed look:** none — both looks follow the viewer's Homeroom theme.

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

- Both tables, `feeds` and `posts`, are `staging:private` (per-user data).
- Upserts of posts (`ON CONFLICT (feed_id, guid) DO NOTHING`) never touch
  `read_at`: adding or refreshing a feed must not mark anything read.
- A post counts read as soon as it is tapped; the row fades but stays in
  place until the next load.
- Demo rows (`is_demo = true`, seeded only on staging with `?demo=1`, feeds
  never fetched) are excluded from every response without `?demo=1`.
