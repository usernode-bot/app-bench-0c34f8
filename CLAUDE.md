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

RSS Reader is a personal feed reader: you paste an RSS or Atom feed's
address, and one screen lists every unread post from all of your feeds,
newest first. Tapping a post opens a short plain-text preview with a link
out to the full article in the browser. Feeds are fetched server-side and
posts are cached in the app database; subscriptions and read state are
per-user, so each person's feeds stay theirs.

## Design

This app's look. The first real version fills in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** a warm amber accent (`--accent` 180 83 9 light / 251 191 36
  dark) over the kit's warm ink greys, unchanged. The starter's teal was
  replaced on purpose. The focus ring follows the accent (217 119 6 light /
  252 211 109 dark); dark on-accent is 69 26 3. All text pairs keep 4.5:1
  or more in both looks.
- **Signature element:** the unread-dot newspaper index. Every row of
  Unread posts leads with a small amber dot (`h-2.5 w-2.5 rounded-full
  bg-accent`), like a ticked-off index of what you have not read; reading a
  post clears its dot and the row leaves the list.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  (the kit's defaults, unchanged).
- One job per screen: the reader screen shows everything unread in one
  scrolling list, and its one primary action is **Add feed**. Both looks
  follow the viewer's Homeroom theme; no fixed look and no theme picker.

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

- **Public cache tables, private per-user tables.** `feeds` and
  `feed_items` are a shared public cache: a feed is the same for everyone
  who subscribes, so two people who add the same address share one cached
  copy. `subscriptions` and `read_state` hold personal data (who reads
  what) and are marked `staging:private`. Private tables only reference
  public ones.
- **Plain-text-only summaries.** Summaries are stripped of HTML at parse
  time and capped at 600 characters; the page renders every feed string
  with `textContent`, never as HTML, so a feed cannot inject markup.
- **Feed fetching is bounded.** The feed URL is user-supplied: http(s)
  only, loopback/private/reserved addresses refused (re-checked on each
  redirect hop), a redirect limit, a 2 MB response cap and a 5 s timeout.
  On failure a feed's `last_error` is recorded and its cached posts keep
  serving; `fetched_at` is stamped either way so a broken feed is not
  hammered more than once per five minutes.
- **Read marks survive re-subscribing.** Removing a feed only unsubscribes
  the viewer; cached posts and read marks stay, so re-adding the same feed
  does not resurface old posts as unread. The unread list shows only
  unread posts — once read, a post is not reachable anywhere in the
  interface.
- **Time flows through the platform.** Read "now" through `req.now`
  server-side and `usernode.now()` in the page, never `new Date()` or SQL
  `NOW()`, wherever time decides what shows (feed freshness, post ages).
- **Demo fixtures are in-memory.** Staging previews with `?demo=1` merge
  three "Staging demo" feeds and their posts into `/api/posts` and
  `/api/feeds`, written nowhere and attributed to no one; demo post ids
  start with `demo-` and are a no-op for read marks.
