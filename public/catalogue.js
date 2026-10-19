/* Ear Trainer's catalogue: the three lesson types and their 12 items each,
 * in learning order (the level sets are prefixes of these lists).
 *
 * Each item: id (permanent — it keys the progress table), label (what the
 * option shows), sub (the option's second line), recipe (how the synth plays
 * it), near (the closest-sounding items, which become the wrong options),
 * and song (progressions only). Level sizes are cumulative: level N's set is
 * the first sizes[N-1] items. The browser loads this with a script tag and
 * server.js requires it to validate ids, so it must work both ways.
 */
'use strict';

const LEVEL_SIZES = [2, 4, 6, 9, 12];

const NOTES = [
  { id: 'octave', label: 'Octave', sub: '12 semitones', recipe: { type: 'notes', semitones: 12 },
    near: ['perfect-fifth'] },
  { id: 'perfect-fifth', label: 'Perfect fifth', sub: '7 semitones', recipe: { type: 'notes', semitones: 7 },
    near: ['perfect-fourth', 'octave'] },
  { id: 'major-third', label: 'Major third', sub: '4 semitones', recipe: { type: 'notes', semitones: 4 },
    near: ['minor-third', 'perfect-fourth'] },
  { id: 'perfect-fourth', label: 'Perfect fourth', sub: '5 semitones', recipe: { type: 'notes', semitones: 5 },
    near: ['perfect-fifth', 'major-third', 'tritone'] },
  { id: 'minor-third', label: 'Minor third', sub: '3 semitones', recipe: { type: 'notes', semitones: 3 },
    near: ['major-third', 'perfect-fourth'] },
  { id: 'major-sixth', label: 'Major sixth', sub: '9 semitones', recipe: { type: 'notes', semitones: 9 },
    near: ['octave', 'major-seventh', 'minor-seventh'] },
  { id: 'major-second', label: 'Major second', sub: '2 semitones', recipe: { type: 'notes', semitones: 2 },
    near: ['minor-second', 'minor-third', 'minor-seventh'] },
  { id: 'minor-seventh', label: 'Minor seventh', sub: '10 semitones', recipe: { type: 'notes', semitones: 10 },
    near: ['major-seventh', 'major-sixth', 'major-second'] },
  { id: 'tritone', label: 'Tritone', sub: '6 semitones', recipe: { type: 'notes', semitones: 6 },
    near: ['perfect-fourth', 'perfect-fifth', 'minor-sixth'] },
  { id: 'minor-second', label: 'Minor second', sub: '1 semitone', recipe: { type: 'notes', semitones: 1 },
    near: ['major-second', 'minor-third'] },
  { id: 'minor-sixth', label: 'Minor sixth', sub: '8 semitones', recipe: { type: 'notes', semitones: 8 },
    near: ['major-sixth', 'perfect-fifth', 'tritone'] },
  { id: 'major-seventh', label: 'Major seventh', sub: '11 semitones', recipe: { type: 'notes', semitones: 11 },
    near: ['minor-seventh', 'octave', 'major-sixth'] },
];

const CHORDS = [
  { id: 'major', label: 'Major', sub: '1 3 5', recipe: { type: 'chords', intervals: [0, 4, 7] },
    near: ['minor', 'augmented', 'major-seventh'] },
  { id: 'minor', label: 'Minor', sub: '1 b3 5', recipe: { type: 'chords', intervals: [0, 3, 7] },
    near: ['major', 'diminished', 'minor-seventh'] },
  { id: 'diminished', label: 'Diminished', sub: '1 b3 b5', recipe: { type: 'chords', intervals: [0, 3, 6] },
    near: ['minor', 'diminished-seventh', 'half-diminished'] },
  { id: 'augmented', label: 'Augmented', sub: '1 3 #5', recipe: { type: 'chords', intervals: [0, 4, 8] },
    near: ['major', 'diminished-seventh'] },
  { id: 'dominant-seventh', label: 'Dominant seventh', sub: '1 3 5 b7', recipe: { type: 'chords', intervals: [0, 4, 7, 10] },
    near: ['major-seventh', 'minor-seventh', 'major'] },
  { id: 'major-seventh', label: 'Major seventh', sub: '1 3 5 7', recipe: { type: 'chords', intervals: [0, 4, 7, 11] },
    near: ['dominant-seventh', 'minor-seventh', 'minor-major-seventh'] },
  { id: 'minor-seventh', label: 'Minor seventh', sub: '1 b3 5 b7', recipe: { type: 'chords', intervals: [0, 3, 7, 10] },
    near: ['dominant-seventh', 'major-seventh', 'half-diminished'] },
  { id: 'suspended-second', label: 'Suspended second', sub: '1 2 5', recipe: { type: 'chords', intervals: [0, 2, 7] },
    near: ['suspended-fourth', 'major'] },
  { id: 'suspended-fourth', label: 'Suspended fourth', sub: '1 4 5', recipe: { type: 'chords', intervals: [0, 5, 7] },
    near: ['suspended-second', 'major', 'minor'] },
  { id: 'half-diminished', label: 'Half diminished', sub: '1 b3 b5 b7', recipe: { type: 'chords', intervals: [0, 3, 6, 10] },
    near: ['minor-seventh', 'diminished-seventh', 'diminished'] },
  { id: 'diminished-seventh', label: 'Diminished seventh', sub: '1 b3 b5 6', recipe: { type: 'chords', intervals: [0, 3, 6, 9] },
    near: ['diminished', 'half-diminished', 'augmented'] },
  { id: 'minor-major-seventh', label: 'Minor major seventh', sub: '1 b3 5 7', recipe: { type: 'chords', intervals: [0, 3, 7, 11] },
    near: ['minor-seventh', 'major-seventh', 'minor'] },
];

const PROGRESSIONS = [
  { id: 'amen', label: 'IV I', song: 'Amen ending (hymns)', recipe: { type: 'progression', key: 'major', numerals: ['IV', 'I'] },
    near: ['amazing-grace', 'la-bamba'] },
  { id: 'hit-the-road-jack', label: 'i bVII bVI V', song: 'Hit the Road Jack', recipe: { type: 'progression', key: 'minor', numerals: ['i', 'bVII', 'bVI', 'V'] },
    near: ['zombie', 'sweet-home-alabama', 'stand-by-me'] },
  { id: 'let-it-be', label: 'I V vi IV', song: 'Let It Be', recipe: { type: 'progression', key: 'major', numerals: ['I', 'V', 'vi', 'IV'] },
    near: ['zombie', 'stand-by-me', 'pachelbel-canon'] },
  { id: 'amazing-grace', label: 'I IV I V', song: 'Amazing Grace', recipe: { type: 'progression', key: 'major', numerals: ['I', 'IV', 'I', 'V'] },
    near: ['amen', 'stand-by-me', 'la-bamba'] },
  { id: 'zombie', label: 'vi IV I V', song: 'Zombie', recipe: { type: 'progression', key: 'major', numerals: ['vi', 'IV', 'I', 'V'] },
    near: ['let-it-be', 'stand-by-me'] },
  { id: 'stand-by-me', label: 'I vi IV V', song: 'Stand By Me', recipe: { type: 'progression', key: 'major', numerals: ['I', 'vi', 'IV', 'V'] },
    near: ['zombie', 'let-it-be', 'amazing-grace'] },
  { id: 'autumn-leaves', label: 'ii V I', song: 'Autumn Leaves', recipe: { type: 'progression', key: 'major', numerals: ['ii', 'V', 'I'] },
    near: ['la-bamba', 'sweet-home-alabama'] },
  { id: 'sweet-home-alabama', label: 'I bVII IV', song: 'Sweet Home Alabama', recipe: { type: 'progression', key: 'major', numerals: ['I', 'bVII', 'IV'] },
    near: ['la-bamba', 'amen', 'autumn-leaves'] },
  { id: 'la-bamba', label: 'I IV V', song: 'La Bamba', recipe: { type: 'progression', key: 'major', numerals: ['I', 'IV', 'V'] },
    near: ['autumn-leaves', 'sweet-home-alabama', 'amazing-grace'] },
  { id: 'silent-night', label: 'I V I IV I', song: 'Silent Night', recipe: { type: 'progression', key: 'major', numerals: ['I', 'V', 'I', 'IV', 'I'] },
    near: ['amazing-grace', 'let-it-be'] },
  { id: 'pachelbel-canon', label: 'I V vi iii IV I IV V', song: "Pachelbel's Canon", recipe: { type: 'progression', key: 'major', numerals: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'] },
    near: ['let-it-be', 'zombie', 'stand-by-me'] },
  { id: 'johnny-b-goode', label: '12 bar blues', song: 'Johnny B. Goode', recipe: { type: 'progression', key: 'major', numerals: ['I', 'I', 'I', 'I', 'IV', 'IV', 'I', 'I', 'V', 'IV', 'I', 'I'] },
    near: ['la-bamba', 'sweet-home-alabama', 'silent-night'] },
];

const CATALOGUE = {
  notes: {
    label: 'Notes',
    tagline: 'Two notes, one after the other',
    ask: 'Which gap is it?',
    noun: 'gaps',
    nounSingular: 'gap',
    items: NOTES,
  },
  chords: {
    label: 'Chords',
    tagline: 'One chord at a time',
    ask: 'Which chord is it?',
    noun: 'chords',
    nounSingular: 'chord',
    items: CHORDS,
  },
  progressions: {
    label: 'Progressions',
    tagline: 'Popular songs and hymns',
    ask: 'Which progression is it?',
    noun: 'songs',
    nounSingular: 'progression',
    items: PROGRESSIONS,
  },
};

// The first level an item belongs to, from its place in the list (the level
// sets are the cumulative prefixes 2, 4, 6, 9, 12).
function levelOf(kind, itemId) {
  const items = CATALOGUE[kind] ? CATALOGUE[kind].items : null;
  if (!items) return 0;
  const at = items.findIndex(function (it) { return it.id === itemId; });
  if (at === -1) return 0;
  if (at < 2) return 1;
  if (at < 4) return 2;
  if (at < 6) return 3;
  if (at < 9) return 4;
  return 5;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CATALOGUE: CATALOGUE, LEVEL_SIZES: LEVEL_SIZES, levelOf: levelOf };
}