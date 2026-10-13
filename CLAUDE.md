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

One scrolling list of every unread post from the feeds a person added,
newest first. Add a feed by pasting the link to a site's RSS feed; tap a
post to preview it in-app, which marks it read (Feedly-style); a button
opens the full article in the browser. Each person keeps their own feeds
(feeds and posts are per-user). Staging carries a made-up demo list at
`/?demo=1` so the populated screen can be seen.

## Design

- **Palette:** warm grey neutrals with one RSS orange accent
  (`--accent` 194 65 12 light / 251 146 60 dark); feed badge colours
  `--feed-1`..`--feed-5` (blue, green, purple, rose, teal).
- **Signature element:** the round feed badge — a tile in the feed's
  colour with the feed's initial in serif, an orange unread dot on its
  corner; read posts keep the badge, dimmed, with the dot gone.
- **Type scale:** `text-title`, `text-heading`, `text-body`,
  `text-small`. Post titles and the preview use the serif stack
  (`ui-serif, Charter, Iowan Old Style, Georgia`); everything else is
  the sans `system-ui` stack.
- Two looks only, no fixed scene: everything follows the viewer's
  Homeroom theme via the token values in `styles/tailwind-input.css`
  (`:root` light, `.dark` dark). No theme picker.

The kit is in `styles/tailwind-input.css`. Re-theme by changing the
token values there, keeping every text pair at 4.5:1 or more in both
looks.

## App-specific conventions

- The `feeds` and `posts` tables are both marked **staging:private**;
  every query is scoped to the requesting user's id.
- All outbound fetching goes through `fetchFeed()` in `feeds.js` — the
  one guarded call (default ports only, no credentials, DNS checked and
  the connection pinned to the checked address, redirects re-checked,
  8 s / 2 MB caps). Nothing else in the app may open a network
  connection to an outside host.
- Post summaries are stored as plain text (HTML stripped, 4000 chars)
  and rendered as text, never HTML.
- Demo feeds (`demo = true`, `*.example` URLs) are never fetched.
