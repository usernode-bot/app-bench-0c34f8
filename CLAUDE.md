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

A personal RSS reader that works like Feedly: you add feeds by address and
read all their unread posts in one scrolling list. Tapping a post marks it
read and shows a preview of the article (the feed's own text and images),
with a button that opens the full story on its site. Feeds refresh when you
open the app or tap Refresh, never on a background timer. Every person's
feeds and read marks are private to them.

## Design

- **Palette:** warm paper neutrals with one amber accent for actions. Light:
  ground 250 249 247, surface white, raised 244 242 238, fg 31 27 22, muted
  94 87 78, line 229 225 218, accent 180 83 9 (amber, on-accent white).
  Dark: ground 20 18 16, surface 30 27 24, raised 42 38 34, fg 240 236 230,
  muted 170 162 152, line 64 59 53, accent 245 165 60 (on-accent 38 22 4).
  Six feed tones given to feeds in turn (`--feed-1` to `--feed-6`: light
  amber, sea, plum, fern, rose, slate with white initials; dark lighter
  tints with `--on-feed` 28 25 23).
- **Signature element:** every post row starts with a round badge holding
  its feed's initial in that feed's tone, so sources are told apart at a
  glance. A read post's badge fades to 40% and its title turns muted.
- **Type scale:** `text-title`, `text-heading` (1.125rem, the row-title
  size: a reader's list, not a dashboard), `text-body`, `text-small`.
  Post titles, the preview's headline and the article use the serif reading
  face (`font-reading`: ui-serif, Charter, Iowan Old Style, Georgia); names,
  times and buttons use the system sans. Icons are thin line icons.
- **One fixed look:** none. The app follows the viewer's Homeroom theme and
  ships both looks.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`, plus
this app's `kit-article` and `kit-row-*`).
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

- Both tables (`feeds`, `posts`) are private (`staging:private`): a
  person's feeds and what they read are theirs alone.
- No new npm packages: feeds are fetched with Node's built-in `fetch` and
  parsed by the hand-written reader in `lib/feeds.js`.
- Outbound feed fetches go through `safeFetch` in `lib/feeds.js` only
  (SSRF-guarded: no loopback, private, link-local, CGNAT or metadata
  addresses; at most 3 redirects; 8 s timeout; 2 MB body limit).
- Article HTML from feeds is stored raw in `posts.content_html` and is
  sanitised on the client (a DOMParser allowlist in `public/app.js`):
  never rendered as-is, never trusted server-side.
- Demo rows are feeds with `is_demo = true`. Refresh skips them and every
  response without `?demo=1` leaves them out, so the plain route keeps its
  real empty state. Rows rendered from data carry `data-post-row`.
- Words: "feed", "post", "Unread", "Add feed", "Your feeds", "Open full
  story", "Remove", "All caught up".
