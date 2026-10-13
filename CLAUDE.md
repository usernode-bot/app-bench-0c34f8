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

## First-version template notes

The first version was built on the screens the spec drew (the platform
carried them into `public/index.html` with styles in `public/screens.css`):
the drawn markup stays, `public/app.js` fills it, and the kit draws the
votes and the comments. Keep that approach for later changes too — fill
the drawn elements, don't redraw them. The screen-2-only rules in
`screens.css` are scoped to `[data-spec-screen="2"]` so they never leak
onto the list screen.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About Club Votes

A club's yes-or-no decision board. Anyone signs in and posts a question
the club needs to decide; everyone votes Yes or No and talks it through in
comments under the question. Counts only, never names. Reports flag a
question or comment for a person to look at; nothing is hidden
automatically.

## Design

This app's look. Every later change follows it, and updates it when a
request changes the look on purpose.

- **Palette:** ballot indigo accent (`--accent`) on cool grey neutrals;
  Yes is green (`--yes`), No is orange (`--no`), everywhere those appear.
- **Signature element:** the tally bar — green fills from the left for
  Yes, orange follows for No, a small gap between, on a raised track. It
  fills against the number of people who have voted on any question here
  (`GET /api/voters`), so a full-length bar means "all of them". A
  question with no votes shows an empty bar and "No votes yet, be the
  first"; the detail line says "15 of the 19 people voting here have had
  their say".
- **Type scale:** `text-title`, `text-heading`, `text-body`, `text-small`.
  Question titles and the app name sit in the system serif
  (`ui-serif`, the `font-title` family); everything else is the system
  sans.
- The app follows the viewer's Homeroom light/dark theme; no fixed look.

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

- The `reports` table is **staging:private** (`COMMENT ON TABLE reports IS
  'staging:private'` in server.js): schema copies to staging, rows never
  do. Never give a public table a foreign key to it.
- Questions, votes and comments come from the platform's kit resource
  (`kit/server.js`), never hand-rolled routes; `choice`/option id 0 is
  Yes, 1 is No.
