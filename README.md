# Ear Trainer

An app to learn relative notes, chords and basic chord progressions by ear.

The whole app is one practice screen: pick a lesson, tap Play to hear a
sound, then tap which of the lesson's sounds you heard. A piano strip
lights up the notes once you answer, so every answer teaches the shape of
what you heard. Each lesson type (Notes, Chords, Progressions) is a ladder:
it starts with two sounds that are far apart and adds closer ones lesson by
lesson, until the last lesson holds the full set. A session is 10
questions; your best score per lesson is kept and the app opens on the
lesson you played last.

Progressions are labelled with the songs and hymns they are heard in
(Amazing Grace, Let It Be, Stand By Me, Silent Night, Zombie, La Bamba).
Sounds are synthesised in the browser with a soft piano tone; there are no
recordings. Guests can practise, but only signed-in people's scores are
saved.

## Running it

- `npm ci --include=dev && npm run build` compiles `styles/tailwind-input.css`
  to `public/tailwind.css` (the image build does this too).
- `npm start` serves the app; it applies its database schema on boot.
- `?demo=1` on staging opens a populated demo partway through Chords 2.

## Design

The palette, signature element and rules for changing the look live in
`CLAUDE.md` under "## Design".