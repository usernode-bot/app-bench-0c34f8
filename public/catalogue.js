/* Ear Trainer catalogue: the three lesson types and their twelve items each.
 *
 * Loaded by the browser with a <script> tag (window.EAR_CATALOGUE) and by
 * server.js with require() to validate the ids answers carry.
 *
 * Item ids are PERMANENT: progress rows in the database reference them, so
 * renaming one would strand the progress stored under it. Add new ids
 * instead.
 *
 * The order of an items array is the order the lessons introduce them in:
 * level 1 takes the first 2, level 2 the first 4, then 6, 9 and all 12.
 */
(function (root, factory) {
  var catalogue = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalogue;
  if (root) root.EAR_CATALOGUE = catalogue;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LEVEL_SIZES = [2, 4, 6, 9, 12];
  var LEVEL_WORDS = ['Two', 'Four', 'Six', 'Nine'];

  var lessons = {
    notes: {
      kind: 'notes',
      title: 'Notes',
      noun: 'gap',
      nounPlural: 'gaps',
      soundNoun: 'two notes',
      allLabel: 'All 12 gaps',
      subtitle: 'Intervals from a random note',
      question: 'Which gap did you hear?',
      items: [
        // level 1
        { id: 'octave', label: 'Octave', semitones: 12, close: ['perf-fifth', 'major-sixth', 'minor-seventh'] },
        { id: 'perf-fifth', label: 'Perfect fifth', semitones: 7, close: ['perf-fourth', 'tritone', 'octave'] },
        // level 2
        { id: 'major-third', label: 'Major third', semitones: 4, close: ['minor-third', 'perf-fourth', 'major-second'] },
        { id: 'perf-fourth', label: 'Perfect fourth', semitones: 5, close: ['perf-fifth', 'major-third', 'tritone'] },
        // level 3
        { id: 'minor-third', label: 'Minor third', semitones: 3, close: ['major-third', 'major-second', 'minor-second'] },
        { id: 'major-sixth', label: 'Major sixth', semitones: 9, close: ['minor-sixth', 'minor-seventh', 'octave'] },
        // level 4
        { id: 'major-second', label: 'Major second', semitones: 2, close: ['minor-second', 'minor-third', 'major-third'] },
        { id: 'minor-seventh', label: 'Minor seventh', semitones: 10, close: ['major-sixth', 'octave', 'major-seventh'] },
        { id: 'tritone', label: 'Tritone', semitones: 6, close: ['perf-fourth', 'perf-fifth', 'major-seventh'] },
        // level 5
        { id: 'minor-second', label: 'Minor second', semitones: 1, close: ['major-second', 'minor-third', 'major-third'] },
        { id: 'minor-sixth', label: 'Minor sixth', semitones: 8, close: ['major-sixth', 'minor-seventh', 'perf-fifth'] },
        { id: 'major-seventh', label: 'Major seventh', semitones: 11, close: ['octave', 'minor-seventh', 'major-sixth'] }
      ]
    },

    chords: {
      kind: 'chords',
      title: 'Chords',
      noun: 'chord',
      nounPlural: 'chords',
      soundNoun: 'chord',
      allLabel: 'All 12 chords',
      subtitle: 'Chords in a random key',
      question: 'Which chord is it?',
      items: [
        // level 1
        { id: 'major', label: 'Major', intervals: [0, 4, 7], close: ['minor', 'augmented', 'major-seventh'] },
        { id: 'minor', label: 'Minor', intervals: [0, 3, 7], close: ['major', 'diminished', 'minor-seventh'] },
        // level 2
        { id: 'diminished', label: 'Diminished', intervals: [0, 3, 6], close: ['minor', 'half-diminished', 'diminished-seventh'] },
        { id: 'augmented', label: 'Augmented', intervals: [0, 4, 8], close: ['major', 'diminished', 'dominant-seventh'] },
        // level 3
        { id: 'dominant-seventh', label: 'Dominant seventh', intervals: [0, 4, 7, 10], close: ['major-seventh', 'minor-seventh', 'major'] },
        { id: 'major-seventh', label: 'Major seventh', intervals: [0, 4, 7, 11], close: ['dominant-seventh', 'major', 'minor-major-seventh'] },
        // level 4
        { id: 'minor-seventh', label: 'Minor seventh', intervals: [0, 3, 7, 10], close: ['minor', 'dominant-seventh', 'half-diminished'] },
        { id: 'sus2', label: 'Suspended second', intervals: [0, 2, 7], close: ['sus4', 'major', 'minor'] },
        { id: 'sus4', label: 'Suspended fourth', intervals: [0, 5, 7], close: ['sus2', 'major', 'minor'] },
        // level 5
        { id: 'half-diminished', label: 'Half diminished', intervals: [0, 3, 6, 10], close: ['diminished', 'diminished-seventh', 'minor-seventh'] },
        { id: 'diminished-seventh', label: 'Diminished seventh', intervals: [0, 3, 6, 9], close: ['diminished', 'half-diminished', 'minor-seventh'] },
        { id: 'minor-major-seventh', label: 'Minor major seventh', intervals: [0, 3, 7, 11], close: ['minor-seventh', 'major-seventh', 'minor'] }
      ]
    },

    progressions: {
      kind: 'progressions',
      title: 'Progressions',
      noun: 'song',
      nounPlural: 'songs',
      soundNoun: 'progression',
      allLabel: 'All 12 songs and hymns',
      subtitle: 'Popular songs and hymns',
      question: 'Which progression is it?',
      items: [
        // level 1
        { id: 'amen', roman: 'IV I', mode: 'major', song: 'Amen', described: 'the Amen ending of hymns', close: ['hit-the-road-jack', 'amazing-grace', 'let-it-be'] },
        { id: 'hit-the-road-jack', roman: 'i bVII bVI V', mode: 'minor', song: 'Hit the Road Jack', described: 'the shape of Hit the Road Jack', close: ['amen', 'stand-by-me', 'zombie'] },
        // level 2
        { id: 'let-it-be', roman: 'I V vi IV', mode: 'major', song: 'Let It Be', described: 'the shape of Let It Be', close: ['stand-by-me', 'zombie', 'amazing-grace'] },
        { id: 'amazing-grace', roman: 'I IV I V', mode: 'major', song: 'Amazing Grace', described: 'the shape of Amazing Grace', close: ['let-it-be', 'amen', 'la-bamba'] },
        // level 3
        { id: 'zombie', roman: 'vi IV I V', mode: 'major', song: 'Zombie', described: 'the shape of Zombie', close: ['stand-by-me', 'let-it-be', 'sweet-home-alabama'] },
        { id: 'stand-by-me', roman: 'I vi IV V', mode: 'major', song: 'Stand By Me', described: 'the shape of Stand By Me', close: ['let-it-be', 'zombie', 'autumn-leaves'] },
        // level 4
        { id: 'autumn-leaves', roman: 'ii V I', mode: 'major', song: 'Autumn Leaves', described: 'the shape of Autumn Leaves', close: ['let-it-be', 'pachelbels-canon', 'silent-night'] },
        { id: 'sweet-home-alabama', roman: 'I bVII IV', mode: 'major', song: 'Sweet Home Alabama', described: 'the shape of Sweet Home Alabama', close: ['la-bamba', 'zombie', 'hit-the-road-jack'] },
        { id: 'la-bamba', roman: 'I IV V', mode: 'major', song: 'La Bamba', described: 'the shape of La Bamba', close: ['sweet-home-alabama', 'amazing-grace', 'let-it-be'] },
        // level 5
        { id: 'silent-night', roman: 'I V I IV I', mode: 'major', song: 'Silent Night', described: 'the shape of Silent Night', close: ['pachelbels-canon', 'autumn-leaves', 'amazing-grace'] },
        { id: 'pachelbels-canon', roman: 'I V vi iii IV I IV V', mode: 'major', song: "Pachelbel's Canon", described: "the shape of Pachelbel's Canon", close: ['silent-night', 'autumn-leaves', 'let-it-be'] },
        { id: 'johnny-b-goode', roman: 'I I IV I V IV I V', mode: 'major', song: 'Johnny B. Goode', described: 'the 12 bar blues of Johnny B. Goode', close: ['sweet-home-alabama', 'la-bamba', 'stand-by-me'] }
      ]
    }
  };

  // id -> item, per lesson type, built once.
  var byId = {};
  Object.keys(lessons).forEach(function (kind) {
    byId[kind] = {};
    lessons[kind].items.forEach(function (item) { byId[kind][item.id] = item; });
  });

  function isKind(kind) {
    return Object.prototype.hasOwnProperty.call(lessons, kind);
  }

  function getItem(kind, itemId) {
    return (isKind(kind) && byId[kind][itemId]) || null;
  }

  function hasItem(kind, itemId) {
    return !!getItem(kind, itemId);
  }

  // The items in a level: the first N of the lesson type's list.
  function itemsForLevel(kind, level) {
    if (!isKind(kind) || !(level >= 1 && level <= LEVEL_SIZES.length)) return [];
    return lessons[kind].items.slice(0, LEVEL_SIZES[level - 1]);
  }

  function levelName(kind, level) {
    if (!isKind(kind)) return '';
    if (level === LEVEL_SIZES.length) return 'Full set';
    return LEVEL_WORDS[level - 1] + ' ' + lessons[kind].nounPlural;
  }

  function levelSubtitle(kind, level) {
    if (!isKind(kind)) return '';
    if (level === LEVEL_SIZES.length) return lessons[kind].allLabel;
    if (level === 1) return 'The most different ones';
    return 'Adds closer sounding ones';
  }

  return {
    kinds: ['notes', 'chords', 'progressions'],
    levelSizes: LEVEL_SIZES,
    lessons: lessons,
    isKind: isKind,
    getItem: getItem,
    hasItem: hasItem,
    itemsForLevel: itemsForLevel,
    levelName: levelName,
    levelSubtitle: levelSubtitle
  };
});
