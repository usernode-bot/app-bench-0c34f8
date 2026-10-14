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

The starter's placeholder screen was replaced by the app's first real
version (see "About" below); the notes it carried about replacing the
template are gone with it. The `usernode-dev-console@1` forwarder, the
bridge `<script>` and the theme `<script>` in `public/index.html` are
platform infrastructure: keep them through any rewrite.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Club Votes

A place for a club to decide things together. Anyone in the club posts
something the club needs to decide, everyone votes **Yes** or **No**,
people discuss it in flat comments under each one, and the person who
posted a decision closes it when they are ready. The main screen's one
job is to show what needs deciding and get your vote in: mostly reading
and tapping Yes or No. Voting is deliberately simple — one yes-or-no
choice per person per decision, changeable until it closes; no Maybe
option, no deadlines, no reopening.

## Design

This app's look, set by the first version. Every later change follows it,
and updates it when a request changes the look on purpose.

- **Palette:** fern green (`--accent`) for Yes and the one main action,
  brick red (`--no`) for No and the against colour, on warm green-grey
  neutrals (`--ground`, `--surface`, `--raised`, `--fg`, `--muted`,
  `--line`). Light values in `styles/tailwind-input.css`'s `:root`; dark
  values in its `.dark` block.
- **Signature element:** the tally bar — green for yes and red for no,
  filling left to right against a light empty track, where the empty part
  is the members who have not voted yet. The same bar, larger, heads an
  opened decision.
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`,
  on a rounded system stack (`ui-rounded` with a system fallback, set in
  `tailwind.config.js`) for the friendly club feel.
- The app follows the viewer's Homeroom theme (light and dark); there is
  no fixed look and no theme picker.

The kit is in `styles/tailwind-input.css`: colour tokens with a light and
a dark value (named in `tailwind.config.js`), and a few components
(`page-column`, `btn-primary`, `btn-secondary`, `field`, `list`, `list-row`,
`card`, `section-label`, `skeleton`, `state-empty`, `state-error`).
Re-theme by changing the token values there, keeping every text pair at
4.5:1 or more in both looks.

- Colour comes only from the tokens (`bg-ground`, `bg-surface`,
  `text-fg`, `text-muted`, `border-line`, `bg-accent` with
  `text-on-accent`, `--no` for the against colour): never a raw hex value
  or a stock palette class.
- Tap targets are at least 44 px; the buttons and fields already are.
- A field's label says what it is; its placeholder, if any, is an example
  that says so ("e.g. 5.0"), never a bare value that could pass for one
  already entered.
- Each screen sits in one centred column on a wide window (the spec
  screens' `[data-spec-screen]` rule does this; `page-column` elsewhere).
- Every screen that loads data has honest loading, empty and error states.
  Never show the empty state while loading or after a failure; an error says
  what failed, what still works, and offers Retry. Loading has the content's
  own shape (its rows, with `skeleton` bars for their text).
- No cards in cards, no uppercase eyebrows, no emoji as icons.
- A header that shows the app's own mark shows the project's icon there
  (the emoji in `dapp.json`'s `icon` block) or no mark at all: never an
  empty tile, and never `brand/icon.png`, which the app does not serve.

## App-specific conventions

- **Words:** "decision", "vote", "Yes", "No", "comment", "Close decision",
  "Closed", "New decision", "Report" — one word for one thing, everywhere.
- **The `reports` table is `staging:private`** (it records who reported
  what) and carries no foreign keys; the other tables are public.
- **Demo rows.** Rows written by the `?demo=1` staging demo carry
  `demo = true` and are left out of every API answer without `demo=1`.
  A viewer's own demo rows are written once, on their first `?demo=1`
  request, with fixed ids and `ON CONFLICT DO NOTHING`.
- **Times** come from `req.now` (the platform convention), not `NOW()`.
- **One vote per person per decision**, stored as the primary key
  `(decision_id, user_id)`; choice is 'yes' or 'no' only.
- **No new dependencies** without a reason; the app is Express, pg and
  vanilla JS in the page.
- Comments are flat (no replies), never edited, deleted only by their
  writer; decisions are closed or deleted only by their poster.
