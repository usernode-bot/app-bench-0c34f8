# Ear Trainer

An app to learn relative notes, chords and basic chord progressions by ear.
One screen plays a sound — a two-note gap, a chord, or a progression from a
well known song or hymn — and you tap what you heard. Each lesson type has
five levels that start with a few very different sounds and add closer ones
until you are quizzed on the full set. An item is mastered at three right
answers in a row, and the chord ladder fills one rung per mastered item.

## How it works

- `public/catalogue.js` holds the three lesson types, their 12 items each,
  sound recipes and the level sizes. Item ids are **permanent**: they key the
  progress table, so never rename or reuse one.
- `public/app.js` renders the screen, picks questions and plays sounds with a
  small Web Audio synth (no recordings; progressions are played in a random
  key as plain chords).
- `server.js` stores progress in the `progress` table (**staging:private**,
  one row per user, lesson type and item) behind `GET /api/progress`,
  `POST /api/answers` and `POST /api/progress/reset`. Guests can play but
  their answers are not saved.
- On staging, `?demo=1` seeds and shows a made-up set of progress for the
  signed-in viewer ("Staging demo: made-up progress for you"). Every control
  works on it.

## Design

See the "## Design" section of `CLAUDE.md` for the app's look: warm grey
neutrals, a deep teal action colour, soft amber for a right answer, the
system rounded typeface, and the chord ladder as the signature element.