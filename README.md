# Tier List

A shared tier list for ranking anything with friends, starting with Bay
Area restaurants. Anyone signed in can add a new thing for everyone to
rank; every person drags each thing into the tier they think it belongs
in, from S tier down to D.

- **Two views** — *My list* shows your own tiers and is where you drag
  things; *Crowd* shows the tier most people chose for each thing, with
  vote counts, and is read-only.
- **Tap for detail** — a thing's sheet shows its name, five tier buttons
  (so you can rank without dragging), and how each person voted.
- **Anyone can add** — new things go on the board for everyone to rank.
- **Guests read, members vote** — visitors without a Homeroom account see
  everything but can't place tiers, add things or report.
- **Reports** — one report per person per thing hides it from everyone.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during image
  creation, in a light and a dark look that follow the viewer's Homeroom
  theme. The palette and the tier badges are described in `CLAUDE.md`.

## API

| Route | What it does |
| --- | --- |
| `GET /api/items` | Every unreported item with your tier, the crowd tier and vote counts |
| `POST /api/items` | Add a thing (signed in; trimmed name, 1–80 chars) |
| `PUT /api/items/:id/placement` | Set your tier (`S`–`D`) for a thing |
| `GET /api/items/:id/votes` | Who voted where on a thing |
| `POST /api/items/:id/report` | Report a thing (one per person; hides it) |

To change this app, ask Homeroom bot: open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**. You can also
run Claude Code against this repo directly; start with `CLAUDE.md`, which
carries the app-specific notes and points at the platform rules.