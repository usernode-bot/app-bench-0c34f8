# RSS Reader — notes for Claude Code

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

The starter template screen was replaced by the real reader (first
version, October 2026): the `usernode-starter-notice@1` block is gone from
`public/index.html` and `README.md` describes the app. Keep the platform
infrastructure when editing that file: the `usernode-dev-console@1`
forwarder script, the bridge `<script>`, the theme script after it, and the
design kit in `styles/tailwind-input.css`.

The screen has a light and a dark look and follows the viewer's Homeroom
theme, switching live when they change it: the theme `<script>` right after
the bridge tag sets a `dark` class on `<html>`. Keep that script, and give
everything you build both looks (the design kit's colour tokens carry both), unless one
fixed look is the point of this app, like a game's own scene; then say so
under "## Design" below. Unless a request asks for one, add
no theme picker: the viewer's Homeroom setting is the control. "The
platform's light/dark theme inside the app frame" in the platform
conventions has the details.

---

## About RSS Reader

The app works like Feedly: each person adds their own RSS feeds and reads
every unread post from all of them in one scrolling list, newest first.
Tapping a post opens an inline preview of its summary, with a link to open
the full article in the browser; opening the preview is what marks the post
read. Feeds are fetched and parsed server-side, never by the browser.

## Design

This app's look. The first real version filled it in; every later change
follows it, and updates it when a request changes the look on purpose.

- **Palette:** burnt orange accent (light: deep orange `194 65 12`; dark: a
  brighter orange `251 146 60` on near-black warm brown), chosen because
  orange is the colour of the RSS mark itself, on the kit's warm stone
  neutrals. The focus ring follows the accent. Every text pair stays at
  4.5:1 or more in both looks.
- **Signature element:** the unread-dot row. Every unread post carries a
  small orange dot beside a serif title, with its source name and age
  underneath in muted grey. Opening a post clears the dot, so the list
  quietly shows what you have and have not read. Nothing else is decorated.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`.
  Post titles and the Unread count read in the serif (`font-serif`, the
  Georgia/`ui-serif` stack); everything else in the system sans.
- Layout is a phone-width reading column (max-w-2xl), top to bottom: the
  Unread header with Refresh, the Add feed button, the merged unread list
  with previews opening inline, My feeds with Remove buttons, Mark all read
  at the bottom.

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

- The `feeds` and `posts` tables are marked `staging:private`: a person's
  subscriptions and reading history are personal.
- A post's dedup key is (`user_id`, `feed_id`, `guid`); the guid falls back
  to the post URL, then to a hash of its title, for feeds that ship neither.
- Read state is `posts.read_at` on the row (posts are per-user; no separate
  read table). Read timestamps and displayed ages use `req.now` and
  `usernode.now()`, never `new Date()`.
- One new server dependency: `rss-parser`. Don't add another without reason.
- Staging demo feeds (seeded behind `?demo=1`) use reserved
  `https://staging-demo.*` URLs, which the refresh route skips so it never
  tries to fetch them.
