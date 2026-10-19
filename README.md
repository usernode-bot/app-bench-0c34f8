# Ear Trainer

Train your ear to hear intervals, chords and chord progressions.

- **Pick a lesson.** Lessons are grouped as Notes, Chords and Progressions.
  Each type starts with two sounds that are far apart and adds closer ones
  lesson by lesson, until the last lesson quizzes the full set.
- **Hear a sound, name it.** Tap Play, then tap the answer you heard. Every
  sound in the lesson is offered as an answer. Sounds are made in the browser
  with a soft synthesised piano tone, with no recordings.
- **Learn from each answer.** The right answer turns amber and shows its
  notes, and the piano strip lights the keys of the sound you heard.
- **Progressions from songs and hymns.** Each progression is labelled with a
  song it is heard in, such as Amazing Grace, Let It Be or Silent Night.
- **See how you did.** A session is 10 questions. Your best score is kept for
  every lesson, and the Lessons list shows it. Signed-in people's scores are
  saved; guests can practise without saving.

The app runs on Homeroom. Its database is the app's own private Postgres, and
the platform supplies the signed-in identity. Styling is Tailwind, compiled at
image build time, in a light and a dark look that follow the viewer's theme.
