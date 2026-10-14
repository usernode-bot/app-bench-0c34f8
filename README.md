# Club Votes

One list of the club's decisions. Open ones at the top, newest first; the
ones already decided below them. Anyone in the club can vote by tapping a
choice, change their vote until the vote is closed, and join the
discussion under each decision.

- **Voting** — tap a choice to vote, tap another to change. Votes are
  shown as counts only; nobody sees who voted what.
- **Closing** — the person who posted a decision closes the vote. The
  leading choice is marked as the winner (calm blue-green), or both are
  when it is a tie.
- **Discussion** — every decision has its own comment thread, oldest
  first. You can delete your own comments.
- **Reports** — a quiet Report button on other people's decisions and
  comments. Reporting never hides anything.
- **Deciding things together** — anyone can post a decision: a question
  and at least two choices, with more rows added as needed.

The tally strip is the app's mark: one stroke per member, grouped in
struck fives, filled in brick red as votes come in, pale where they
haven't, and calm blue-green once the vote is closed.

The app runs on [Homeroom](https://app.onhomeroom.com). Sign-in comes from
the platform, so there are no accounts to build; visitors without a
Homeroom account can read but not vote or comment. The app has its own
private Postgres database, and Tailwind CSS is precompiled by
`npm run build` during image creation, in a light and a dark look that
follow the viewer's Homeroom theme.

To change the app, ask Homeroom bot (open the app on Homeroom, tap the
Homeroom icon in the header, then **Suggest an improvement**), or run
Claude Code against this repo directly — start with `CLAUDE.md`, which
carries the app-specific notes and points at the platform rules.