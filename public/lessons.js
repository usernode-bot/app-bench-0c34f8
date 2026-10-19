/* The lesson catalogue: the built-in ear training lessons.
 *
 * Read by the browser (as window.LESSONS, loaded before app.js) and by
 * server.js (as module.exports) so both sides agree on every lesson id.
 * Each lesson is cumulative: a lesson holds every sound of the lessons
 * before it plus the new ones it adds.
 */
(function (root) {
  'use strict';

  // Relative notes, played up from C4 (MIDI 60).
  const INTERVALS = {
    octave: { label: 'Octave', semitones: 12, notes: ['C', 'C'], description: 'The same note again, one octave higher.' },
    fifth: { label: 'Fifth', semitones: 7, notes: ['C', 'G'], description: 'Open and steady, seven steps up from the root.' },
    majorThird: { label: 'Major third', semitones: 4, notes: ['C', 'E'], description: 'Bright and warm, four steps up.' },
    minorThird: { label: 'Minor third', semitones: 3, notes: ['C', 'Eb'], description: 'Dark and soft, three steps up.' },
    fourth: { label: 'Fourth', semitones: 5, notes: ['C', 'F'], description: 'Like the start of a fanfare, five steps up.' },
    majorSixth: { label: 'Major sixth', semitones: 9, notes: ['C', 'A'], description: 'Wide and open, nine steps up.' },
    majorSecond: { label: 'Major second', semitones: 2, notes: ['C', 'D'], description: 'One step apart, the start of a scale.' },
    minorSeventh: { label: 'Minor seventh', semitones: 10, notes: ['C', 'Bb'], description: 'Bluesy and wide, ten steps up.' },
    minorSixth: { label: 'Minor sixth', semitones: 8, notes: ['C', 'Ab'], description: 'Tender and close, eight steps up.' },
    minorSecond: { label: 'Minor second', semitones: 1, notes: ['C', 'C#'], description: 'The tightest step: two notes right beside each other.' },
    tritone: { label: 'Tritone', semitones: 6, notes: ['C', 'F#'], description: 'Restless and in between, six steps up.' },
    majorSeventh: { label: 'Major seventh', semitones: 11, notes: ['C', 'B'], description: 'Almost an octave, leaning in, eleven steps up.' },
  };

  function interval(id) {
    const i = INTERVALS[id];
    return {
      id,
      kind: 'interval',
      label: i.label,
      notes: [60, 60 + i.semitones],
      answerNotes: 'C and ' + i.notes[1],
      description: i.description,
    };
  }

  // Chords, heard from C. notes are what the piano strip lights up.
  const CHORDS = {
    major: {
      label: 'Major', notes: [60, 64, 67], answerNotes: 'C E G',
      description: 'A bright shape. Root, a third four steps up, then the fifth.',
    },
    minor: {
      label: 'Minor', notes: [60, 63, 67], answerNotes: 'C Eb G',
      description: 'A darker shape. Root, a third three steps up, then the fifth.',
    },
    diminished: {
      label: 'Diminished', notes: [60, 63, 66], answerNotes: 'C Eb Gb',
      description: 'Tense and narrow. Two minor thirds stacked.',
    },
    suspended: {
      label: 'Suspended', notes: [60, 65, 67], answerNotes: 'C F G',
      description: 'Open and floating. The third is replaced by a fourth.',
    },
    augmented: {
      label: 'Augmented', notes: [60, 64, 68], answerNotes: 'C E G#',
      description: 'Bright and uneasy. Two major thirds stacked.',
    },
    dominantSeventh: {
      label: 'Dominant seventh', notes: [60, 64, 67, 70], answerNotes: 'C E G Bb',
      description: 'A major triad with a flat seventh, leaning to resolve.',
    },
  };

  function chord(id) {
    const c = CHORDS[id];
    return {
      id,
      kind: 'chord',
      label: c.label,
      notes: c.notes,
      answerNotes: c.answerNotes,
      description: c.description,
    };
  }

  // Progressions in C: four chords, each voiced inside C4 to C5.
  const VOICINGS = {
    I: [60, 64, 67],
    IV: [65, 69, 72],
    V: [62, 67, 71],
    vi: [64, 69, 72],
  };

  const PROGRESSIONS = {
    'I IV V I': { song: 'Amazing Grace' },
    'I V vi IV': { song: 'Let It Be' },
    'I vi IV V': { song: 'Stand By Me' },
    'I V I IV': { song: 'Silent Night' },
    'vi IV I V': { song: 'Zombie' },
    'I IV V IV': { song: 'La Bamba' },
  };

  function progression(label) {
    const p = PROGRESSIONS[label];
    const chords = label.split(' ').map((roman) => VOICINGS[roman]);
    return {
      id: label,
      kind: 'progression',
      label,
      song: p.song,
      chords,
      notes: chords.reduce((all, voicing) => all.concat(voicing), []),
      answerNotes: p.song,
      description: 'Heard in ' + p.song + '.',
    };
  }

  const LESSONS = [
    {
      id: 'notes-1', name: 'Notes 1: Octave and fifth', type: 'notes',
      unit: 'intervals', total: 12, questionCount: 10,
      items: [interval('octave'), interval('fifth')],
    },
    {
      id: 'notes-2', name: 'Notes 2: Add the thirds', type: 'notes',
      unit: 'intervals', total: 12, questionCount: 10,
      items: [interval('octave'), interval('fifth'), interval('majorThird'), interval('minorThird')],
    },
    {
      id: 'notes-3', name: 'Notes 3: Add the fourth and sixth', type: 'notes',
      unit: 'intervals', total: 12, questionCount: 10,
      items: [interval('octave'), interval('fifth'), interval('majorThird'), interval('minorThird'),
        interval('fourth'), interval('majorSixth')],
    },
    {
      id: 'notes-4', name: 'Notes 4: Add the close ones', type: 'notes',
      unit: 'intervals', total: 12, questionCount: 10,
      items: [interval('octave'), interval('fifth'), interval('majorThird'), interval('minorThird'),
        interval('fourth'), interval('majorSixth'), interval('majorSecond'), interval('minorSeventh'),
        interval('minorSixth')],
    },
    {
      id: 'notes-5', name: 'Notes 5: All twelve intervals', type: 'notes',
      unit: 'intervals', total: 12, questionCount: 10,
      items: [interval('octave'), interval('fifth'), interval('majorThird'), interval('minorThird'),
        interval('fourth'), interval('majorSixth'), interval('majorSecond'), interval('minorSeventh'),
        interval('minorSixth'), interval('minorSecond'), interval('tritone'), interval('majorSeventh')],
    },
    {
      id: 'chords-1', name: 'Chords 1: Major and minor', type: 'chords',
      unit: 'chord types', total: 6, questionCount: 10,
      items: [chord('major'), chord('minor')],
    },
    {
      id: 'chords-2', name: 'Chords 2: Triads', type: 'chords',
      unit: 'chord types', total: 6, questionCount: 10,
      items: [chord('major'), chord('minor'), chord('diminished'), chord('suspended')],
    },
    {
      id: 'chords-3', name: 'Chords 3: Triads and sevenths', type: 'chords',
      unit: 'chord types', total: 6, questionCount: 10,
      items: [chord('major'), chord('minor'), chord('diminished'), chord('suspended'),
        chord('augmented'), chord('dominantSeventh')],
    },
    {
      id: 'progressions-1', name: 'Progressions 1: Three-chord hymns', type: 'progressions',
      unit: 'progressions', total: 6, questionCount: 10,
      items: [progression('I IV V I'), progression('I V vi IV')],
    },
    {
      id: 'progressions-2', name: 'Progressions 2: Pop changes', type: 'progressions',
      unit: 'progressions', total: 6, questionCount: 10,
      items: [progression('I IV V I'), progression('I V vi IV'),
        progression('I vi IV V'), progression('I V I IV')],
    },
    {
      id: 'progressions-3', name: 'Progressions 3: The full set', type: 'progressions',
      unit: 'progressions', total: 6, questionCount: 10,
      items: [progression('I IV V I'), progression('I V vi IV'),
        progression('I vi IV V'), progression('I V I IV'),
        progression('vi IV I V'), progression('I IV V IV')],
    },
  ];

  const api = { LESSONS, getLesson: (id) => LESSONS.find((l) => l.id === id) || null };

  if (typeof root !== 'undefined') root.LESSONS = LESSONS;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
