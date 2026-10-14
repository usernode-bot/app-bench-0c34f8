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

## Starter template (replaced)

The starter-template hero screen was replaced by the real app in the
first version, as that section instructed. Platform infrastructure in
`public/index.html` that must never be dropped when editing it: the
`usernode-dev-console@1` forwarder `<script>`, the bridge `<script>`,
and the theme `<script>` right after the bridge tag (it sets a `dark`
class on `<html>` from the viewer's Homeroom theme). Everything ships in
both looks — the colour tokens carry them — and there is no theme
picker: the viewer's Homeroom setting is the control. "The platform's
light/dark theme inside the app frame" in the platform conventions has
the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About RSS Reader

A Feedly-like RSS reader: each member adds the RSS/Atom feeds they
follow, and reads everything from all of them in one scrolling unread
list, newest first. Tapping a post opens a plain-text preview with a
link to the original article, and marks the post read. Feeds and
reading state are private to each member (all tables are
`staging:private`). Posts refresh when the list opens; there is no
background refresh, folders, or mark-all-read in the first version.

## Design

This app's look. The first real version filled in the blanks; every later
change follows it, and updates it when a request changes the look on purpose.

- **Palette:** warm paper neutrals (light ground `250 249 246`, dark
  `24 22 20`) with a deep teal accent — `15 118 110` on white text in
  light, `45 212 191` with `4 47 46` text in dark. Feed names are amber
  ink (`146 64 14` light / `251 191 120` dark); the unread dot is the
  accent teal. All values live in `styles/tailwind-input.css`.
- **Signature element:** the masthead chip — a feed's first letter in
  white serif on one of five fixed ink colours (amber, teal, blue,
  violet, rose; same in both looks), picked by hashing the feed's URL
  mod 5, so each feed keeps its colour everywhere it appears.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  (change their sizes in `tailwind.config.js` if you must, not their
  number). Reading text is serif (`ui-serif`, Georgia); the meta lines —
  feed name, time, excerpts, buttons in sheets — are sans.
- One filled button per view: the header's Add feed (outlined while the
  list is empty, because the empty state carries the filled one), and
  Open full article in the preview.

Marked intentionally different from the generic kit: the drawn spec's
screens are reproduced (screen 1 as the main view, screen 2 as the
preview), with their own `390px` `.app` column rather than
`page-column`, so rows keep the drawn rhythm at phone width.

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

- All four tables (`feeds`, `posts`, `post_reads`, `demo_removed_feeds`)
  are marked `staging:private`.
- Plain text only: feed content is stored tag-stripped and
  entity-decoded; links must be http(s).
- The only dependency beyond the starter set is `fast-xml-parser`.
- On staging, `?demo=1` seeds made-up feeds/posts (urls under
  `https://staging-demo.invalid/`); a removed demo feed is tombstoned in
  `demo_removed_feeds` so it stays removed.
- Outbound feed fetches all go through the SSRF-guarded `safeFetch`
  (http/https, ports 80/443 only, private/loopback IPs refused, 8 s
  timeout, 2 MB cap). Never fetch a feed URL another way.
- The two page checks in `dapp.json` set `allowConsoleErrors: true`. The
  platform's bridge script probes the platform's custom-domain endpoint
  when the page's own host could be one (two or more dots), and the
  checks load the app via `127.0.0.1` — three dots, so the probe fires
  and the platform answers 404 ("not a custom domain"). The bridge
  handles that answer gracefully, but Chromium still logs it as a
  console error, which fails any check without the flag. The app itself
  loads with zero console errors (verified against a fresh `localhost`
  link, which the bridge never probes). If a check ever fails with a
  console error again, reproduce with a `localhost` link first to see
  whether the app or the platform bridge emitted it.
