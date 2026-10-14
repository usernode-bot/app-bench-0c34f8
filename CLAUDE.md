# Club Votes — notes for Claude Code

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

The starter template has been replaced: the first real version (the
decisions feed, voting, comments, close, More menus) is built, so the
`usernode-starter-notice@1` block this section described no longer exists.
Keep the `usernode-dev-console@1` forwarder `<script>`, the bridge
`<script>` and the theme `<script>` when rewriting the HTML — that block is
platform infrastructure, not template content.

---

## About Club Votes

A place for our club to decide things together. One feed of decision
questions. Anyone posts a decision: a Question (required), optional Details,
and 2 to 6 Options. There is no plain agree/disagree vote: everyone picks one
of the options the poster listed, one vote per person, changeable or takeable
back by re-tapping. Names show next to each vote, the viewer's own reads
"You". A notched tally bar (the app's signature element) shows the standing.
Comments run under every decision, oldest first; you can delete your own.
The poster can Close a decision, which stops voting and moves it under
"Decided" showing "Chosen: X, N of M votes" or "Tied"; comments stay open.
Every decision and comment carries a More menu: Report, and Delete (own
only). Voting happens in the opened detail view, not the feed card.

## Design

This app's look, from the spec it was built from. Every later change follows
it, and updates it when a request changes the look on purpose.

- **Palette:** warm grey neutrals with a deep ballot blue accent
  (accent `30 64 175` light, `147 170 253` dark; neutrals are stone-like
  warm greys; a separate `--tally` token tints the tally notches that are
  not the viewer's own).
- **Signature element:** the notched tally bar. One notch per vote, each
  1/(max(total, 10)) of the bar wide so small counts still read; over 30
  votes it becomes a solid fill of the option's share; the viewer's own
  option's notches are accent, the others' are `--tally`.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`
  (system sans; questions are semibold heading size). Unchanged.
- The feed is the screen the spec drew (`public/screens.css`); no fixed
  look, it follows the viewer's Homeroom light/dark theme.

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

- The shared kit (`kit/server.js`, `public/kit/*`) is mounted, not edited.
  Club Votes' own rules live in `server.js` as routes registered BEFORE the
  kit's: the 2 to 6 different options check on posting, the closed-decision
  guard on voting (409), close being the poster's alone, and comment
  deletion being the comment's author alone.
- `reports` is the one private table (`COMMENT ON TABLE reports IS
  'staging:private'`). No public table carries a foreign key to it.
- Voting means picking one of the poster's listed options; votes are stored
  as a choice index per user (kit's `(item_id, user_id)` primary key, so
  one vote per person by construction).
- Who voted what, by name, is served by `GET /api/decision-meta/:id?`
  (`voters`, `states`); voter names are remembered in `voter_names` when a
  vote is cast.
- Staging demo (`?demo=1`): made-up people and questions, ids from 900001,
  everything `ON CONFLICT DO NOTHING`, plus one open decision posted by the
  viewer (keyed once per viewer in `kit_demo_viewers` as `decisions_own`)
  so Close and Delete can be tried.
