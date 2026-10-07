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

A personal RSS reader, like Feedly in miniature: you add your own feeds by
pasting a feed or site address, and read every unread post from all of them
in one scrolling list, newest first. Tapping a post opens its preview in
place and marks it read; "Open full post" goes to the article in the
browser. Feeds, posts and read state are per signed-in person and private
(`staging:private` tables). The server fetches and parses feeds, since
browsers cannot fetch other sites directly, through one guarded fetcher
(`lib/feeds.js`).

## Design

This app's look. Set by the first real version (the "Read all your RSS
feeds as one list of unread posts" build); every later change follows it,
and updates it when a request changes the look on purpose.

- **Palette:** cool, paper-like greys (ground 247 247 248 light / 17 18 20
  dark; surface white / 26 27 30; raised; fg; muted; line) with a single
  action colour, RSS orange (accent 194 65 12 light / 251 146 60 dark) on
  "Add feed", "Open full post" and the focus ring only, plus danger red for
  the error line and the remove confirm. Eight feed colours `src-1` to
  `src-8` (blue, teal, violet, rose, amber, green, indigo, ocean), given
  out in order as feeds are added; they reach the screen only through the
  `.s1`-`.s8` classes, which set `color` for `.feed-dot`'s `currentColor`.
- **Signature element:** the feed dot. Each feed has its own colour; the
  dot sits beside every post from that feed and on the feed's chip, so the
  chip row doubles as the legend. The dot is also the read marker: filled
  means unread, an outline ring (`.is-read .feed-dot`) means opened.
- **Type scale:** `text-small` 14 px (meta, chips, labels), `text-body`
  17 px (titles, field, buttons; preview text at `leading-7`),
  `text-heading` 21 px (an opened post's title), `text-title` 28 px
  ("Unread"). Reading text (post titles, preview paragraphs) is the device
  serif (`font-serif`); controls, feed names, times and counts are the
  device sans (default).

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and the components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`, plus
this app's `icon-btn`, `chip`, `feed-dot`, `post-row`, `post-preview`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, ...): never a raw hex value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- A field's label says what it is; its placeholder, if any, is an example
  that says so ("e.g. example.com/blog"), never a bare value that could
  pass for one already entered.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry.
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions).
- No cards in cards, no uppercase eyebrows, no emoji as icons.

## App-specific conventions

- All three tables (`feeds`, `posts`, `demo_seeds`) are private
  (`COMMENT ON TABLE ... IS 'staging:private'`): what a person follows and
  reads is theirs only. No public table references them.
- All outbound fetching goes through `lib/feeds.js`'s `safeFetch`, never a
  bare `fetch` to a user-supplied address. Feed content is reduced to
  plain text by `htmlToText` before storage; the page renders with
  `textContent` only, so no feed HTML or remote image reaches the DOM.
- The sample feed has `kind = 'sample'` (`sample:welcome`); staging demo
  feeds `kind = 'demo'` (`staging-demo:*`), written once per account on a
  `?demo=1` staging request, read only then, and never fetched.
  `POST /api/refresh` only ever touches `kind = 'rss'`.
- Times come from `req.now` server-side and `usernode.now()` client-side,
  never `new Date()`, wherever they decide what shows.
- The page maps the add-feed error codes (`invalid_url`, `no_feed_found`,
  `unreachable`, `already_following`, `too_many_feeds`) to sentences in
  `ADD_ERROR_COPY` in `public/app.js`.
- Previews are capped at 8,000 characters (`summary_truncated`), the list
  at the newest 500 unread posts, and each feed is pruned to its newest
  200 posts (read ones only).
