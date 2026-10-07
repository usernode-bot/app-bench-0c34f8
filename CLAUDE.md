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

A personal RSS reader in the Feedly style: paste a feed's address, and every
unread post from your feeds lands in one newest-first list. Tapping a post
marks it read on the spot and opens an inline preview with the date, an
excerpt taken from the feed itself, and a link to the full article in the
browser. Each person's feeds are their own; visitors without an account can
look around read-only.

## Design

This app's look. Set by the first version below; every later change follows
it, and updates it when a request changes the look on purpose.

- **Palette:** press orange on warm stone neutrals. Accent `--accent` is a
  deep burnt orange in the light look (`194 65 12`) and a brighter ember
  orange in the dark (`251 146 60`), with white on the light accent and
  near-black `67 20 7` on the dark one; focus ring matches the accent. The
  neutrals keep the kit's warm stone values. Nothing on screen is coloured
  except the accent (the Add button, the preview link, the focus ring, the
  favicon) and the kit's danger red for error text.
- **Signature element:** the ink dot — a small solid near-black dot at the
  right edge of every unread row, like an uninked stamp waiting on the page,
  gone the moment the post is tapped. Backing it, each row carries the feed
  stamp, a letterpress-style badge with the feed's initial.
- **Type scale:** the kit's four sizes (`text-title`, `text-heading`,
  `text-body`, `text-small`), unchanged. Interface text in system sans
  (`font-sans`); post titles and preview text in system serif
  (`font-serif`, `ui-serif, Georgia, serif`) because this is reading matter.
- No fixed look: the screen follows the viewer's Homeroom theme in light and
  dark, via the template's theme script.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`btn-primary`, `btn-secondary`, `field`, `list` and `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`, plus the
reader's `feed-stamp`, `unread-dot` and `preview`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, ...): never a raw hex value or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- A field's label says what it is; its placeholder, if any, is an example
  that says so ("e.g. https://blog.example.com/feed.xml"), never a bare
  value that could pass for one already entered.
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry.
- Seed obviously fake staging demo data so the populated screen can be seen
  ("Staging mock data" in the platform conventions). This app does it at
  request time: staging-only `GET /api/posts?demo=1`, never touching the
  database.
- No cards in cards, no uppercase eyebrows, no emoji as icons.

## App-specific conventions

- The `feeds` and `posts` tables are marked `staging:private` (COMMENT ON
  TABLE): a person's feeds and reading state are personal. The `posts`
  table is private through its foreign key to `feeds`.
- Read state lives on `posts.read_at` (per-post), not in a separate table;
  every feed belongs to one user, so the per-post flag is already per-user.
- Feed fetching and parsing use only Node built-ins: built-in `fetch` with
  an 8 s AbortController timeout, and the string reader in
  `server/feedxml.js`. No new npm packages.
- At most 100 posts are kept per feed; the merged list returned to the page
  is capped at 200, newest first.
- Display times come from `req.now` on the server and `usernode.now()` in
  the page, forwarded as `x-usernode-now`, never `Date.now()` or SQL `NOW()`.
