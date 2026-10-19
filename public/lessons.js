/* The lesson catalogue: readable by the browser (as window.EAR_LESSONS)
   and by server.js (as module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.EAR_LESSONS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Notes are MIDI numbers; C4 is 60. Intervals play up from C, chords are
  // voiced inside C4 to C5, progressions as four chords a step of 0.8 s apart.
  var FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  function names(midis) {
    return midis.map(function (m) { return FLAT[m % 12]; }).join(' ');
  }
  function chord(midis) { return { notes: midis, small: names(midis) }; }
  function interval(semis) {
    return { notes: [60, 60 + semis], small: 'C → ' + FLAT[semis % 12] };
  }
  function prog(song, chords) {
    return { chords: chords, song: song, small: names(chords[0]) + ' – ' + names(chords[1]) + ' – ' + names(chords[2]) + ' – ' + names(chords[3]) };
  }
  var C = [60, 64, 67], F = [65, 69, 72], G = [59, 62, 67], Am = [60, 64, 69];

  var lessons = [
    {
      id: 'notes-1', name: 'Notes 1: Octave and fifth', type: 'notes', unit: 'interval sizes', total: 12,
      items: [
        Object.assign(interval(12), { kind: 'interval', label: 'Octave', desc: 'The same note again, higher. The two blend like one.' }),
        Object.assign(interval(7), { kind: 'interval', label: 'Fifth', desc: 'A wide, open gap. The frame of every chord.' })
      ]
    },
    {
      id: 'notes-2', name: 'Notes 2: Add the thirds', type: 'notes', unit: 'interval sizes', total: 12,
      items: [
        Object.assign(interval(4), { kind: 'interval', label: 'Major third', desc: 'Four steps up. The bright step of a major chord.' }),
        Object.assign(interval(3), { kind: 'interval', label: 'Minor third', desc: 'Three steps up. The darker step of a minor chord.' })
      ]
    },
    {
      id: 'notes-3', name: 'Notes 3: Add the fourth and sixth', type: 'notes', unit: 'interval sizes', total: 12,
      items: [
        Object.assign(interval(12), { kind: 'interval', label: 'Octave', desc: 'The same note again, higher. The two blend like one.' }),
        Object.assign(interval(7), { kind: 'interval', label: 'Fifth', desc: 'A wide, open gap. The frame of every chord.' }),
        Object.assign(interval(4), { kind: 'interval', label: 'Major third', desc: 'Four steps up. The bright step of a major chord.' }),
        Object.assign(interval(3), { kind: 'interval', label: 'Minor third', desc: 'Three steps up. The darker step of a minor chord.' }),
        Object.assign(interval(5), { kind: 'interval', label: 'Fourth', desc: 'Five steps up. A steady step, a fifth not yet filled in.' }),
        Object.assign(interval(9), { kind: 'interval', label: 'Major sixth', desc: 'Eight steps up. Bright, like a fifth turned the other way.' })
      ]
    },
    {
      id: 'notes-4', name: 'Notes 4: Add the seconds and sixths', type: 'notes', unit: 'interval sizes', total: 12,
      items: [
        Object.assign(interval(12), { kind: 'interval', label: 'Octave', desc: 'The same note again, higher. The two blend like one.' }),
        Object.assign(interval(7), { kind: 'interval', label: 'Fifth', desc: 'A wide, open gap. The frame of every chord.' }),
        Object.assign(interval(4), { kind: 'interval', label: 'Major third', desc: 'Four steps up. The bright step of a major chord.' }),
        Object.assign(interval(3), { kind: 'interval', label: 'Minor third', desc: 'Three steps up. The darker step of a minor chord.' }),
        Object.assign(interval(5), { kind: 'interval', label: 'Fourth', desc: 'Five steps up. A steady step, a fifth not yet filled in.' }),
        Object.assign(interval(9), { kind: 'interval', label: 'Major sixth', desc: 'Eight steps up. Bright, like a fifth turned the other way.' }),
        Object.assign(interval(2), { kind: 'interval', label: 'Major second', desc: 'A whole step. The gap you walk, not leap.' }),
        Object.assign(interval(10), { kind: 'interval', label: 'Minor seventh', desc: 'Ten steps up, one short of the octave. Wide and restless.' }),
        Object.assign(interval(8), { kind: 'interval', label: 'Minor sixth', desc: 'Eight steps up, darker than a major sixth.' })
      ]
    },
    {
      id: 'notes-5', name: 'Notes 5: The full set', type: 'notes', unit: 'interval sizes', total: 12,
      items: [
        Object.assign(interval(12), { kind: 'interval', label: 'Octave', desc: 'The same note again, higher. The two blend like one.' }),
        Object.assign(interval(7), { kind: 'interval', label: 'Fifth', desc: 'A wide, open gap. The frame of every chord.' }),
        Object.assign(interval(4), { kind: 'interval', label: 'Major third', desc: 'Four steps up. The bright step of a major chord.' }),
        Object.assign(interval(3), { kind: 'interval', label: 'Minor third', desc: 'Three steps up. The darker step of a minor chord.' }),
        Object.assign(interval(5), { kind: 'interval', label: 'Fourth', desc: 'Five steps up. A steady step, a fifth not yet filled in.' }),
        Object.assign(interval(9), { kind: 'interval', label: 'Major sixth', desc: 'Eight steps up. Bright, like a fifth turned the other way.' }),
        Object.assign(interval(2), { kind: 'interval', label: 'Major second', desc: 'A whole step. The gap you walk, not leap.' }),
        Object.assign(interval(10), { kind: 'interval', label: 'Minor seventh', desc: 'Ten steps up, one short of the octave. Wide and restless.' }),
        Object.assign(interval(8), { kind: 'interval', label: 'Minor sixth', desc: 'Eight steps up, darker than a major sixth.' }),
        Object.assign(interval(1), { kind: 'interval', label: 'Minor second', desc: 'One step, very close. The hardest pair to tell apart.' }),
        Object.assign(interval(6), { kind: 'interval', label: 'Tritone', desc: 'Halfway across the octave. Restless, it wants to resolve.' }),
        Object.assign(interval(11), { kind: 'interval', label: 'Major seventh', desc: 'One step below the octave. It leans hard toward home.' })
      ]
    },
    {
      id: 'chords-1', name: 'Chords 1: Major and minor', type: 'chords', unit: 'chord types', total: 6,
      items: [
        Object.assign(chord(C), { kind: 'chord', label: 'Major', desc: 'A bright shape. Root, a third four steps up, then the fifth.' }),
        Object.assign(chord([60, 63, 67]), { kind: 'chord', label: 'Minor', desc: 'A darker shape. The middle note sits one step lower.' })
      ]
    },
    {
      id: 'chords-2', name: 'Chords 2: Triads', type: 'chords', unit: 'chord types', total: 6,
      items: [
        Object.assign(chord(C), { kind: 'chord', label: 'Major', desc: 'A bright shape. Root, a third four steps up, then the fifth.' }),
        Object.assign(chord([60, 63, 67]), { kind: 'chord', label: 'Minor', desc: 'A darker shape. The middle note sits one step lower.' }),
        Object.assign(chord([60, 63, 66]), { kind: 'chord', label: 'Diminished', desc: 'A tense shape. Both the third and the fifth are lowered.' }),
        Object.assign(chord([60, 65, 67]), { kind: 'chord', label: 'Suspended', desc: 'A floating shape. The third is swapped for a fourth.' })
      ]
    },
    {
      id: 'chords-3', name: 'Chords 3: Add sevenths', type: 'chords', unit: 'chord types', total: 6,
      items: [
        Object.assign(chord(C), { kind: 'chord', label: 'Major', desc: 'A bright shape. Root, a third four steps up, then the fifth.' }),
        Object.assign(chord([60, 63, 67]), { kind: 'chord', label: 'Minor', desc: 'A darker shape. The middle note sits one step lower.' }),
        Object.assign(chord([60, 63, 66]), { kind: 'chord', label: 'Diminished', desc: 'A tense shape. Both the third and the fifth are lowered.' }),
        Object.assign(chord([60, 65, 67]), { kind: 'chord', label: 'Suspended', desc: 'A floating shape. The third is swapped for a fourth.' }),
        Object.assign(chord([60, 64, 68]), { kind: 'chord', label: 'Augmented', desc: 'A stretched, odd shape. The fifth is raised a step.' }),
        Object.assign(chord([60, 64, 67, 70]), { kind: 'chord', label: 'Dominant seventh', desc: 'A bluesy shape that leans toward home.' })
      ]
    },
    {
      id: 'progressions-1', name: 'Progressions 1: Three-chord hymns', type: 'progressions', unit: 'progressions', total: 6,
      items: [
        Object.assign(prog('Amazing Grace', [C, F, G, C]), { kind: 'progression', label: 'Amazing Grace', desc: 'I IV V I. Home, lift, turn, home. You know it from the hymn.' }),
        Object.assign(prog('Let It Be', [C, G, Am, F]), { kind: 'progression', label: 'Let It Be', desc: 'I V vi IV. Home, turn, away, lift, back to the verse.' })
      ]
    },
    {
      id: 'progressions-2', name: 'Progressions 2: More songs and hymns', type: 'progressions', unit: 'progressions', total: 6,
      items: [
        Object.assign(prog('Amazing Grace', [C, F, G, C]), { kind: 'progression', label: 'Amazing Grace', desc: 'I IV V I. Home, lift, turn, home. You know it from the hymn.' }),
        Object.assign(prog('Let It Be', [C, G, Am, F]), { kind: 'progression', label: 'Let It Be', desc: 'I V vi IV. Home, turn, away, lift, back to the verse.' }),
        Object.assign(prog('Stand By Me', [C, Am, F, G]), { kind: 'progression', label: 'Stand By Me', desc: 'I vi IV V. Home, away, lift, turn home.' }),
        Object.assign(prog('Silent Night', [C, G, C, F]), { kind: 'progression', label: 'Silent Night', desc: 'I V I IV. The carol leans away and settles back.' })
      ]
    },
    {
      id: 'progressions-3', name: 'Progressions 3: The full set', type: 'progressions', unit: 'progressions', total: 6,
      items: [
        Object.assign(prog('Amazing Grace', [C, F, G, C]), { kind: 'progression', label: 'Amazing Grace', desc: 'I IV V I. Home, lift, turn, home. You know it from the hymn.' }),
        Object.assign(prog('Let It Be', [C, G, Am, F]), { kind: 'progression', label: 'Let It Be', desc: 'I V vi IV. Home, turn, away, lift, back to the verse.' }),
        Object.assign(prog('Stand By Me', [C, Am, F, G]), { kind: 'progression', label: 'Stand By Me', desc: 'I vi IV V. Home, away, lift, turn home.' }),
        Object.assign(prog('Silent Night', [C, G, C, F]), { kind: 'progression', label: 'Silent Night', desc: 'I V I IV. The carol leans away and settles back.' }),
        Object.assign(prog('Zombie', [Am, F, C, G]), { kind: 'progression', label: 'Zombie', desc: 'vi IV I V. The same four chords, starting away from home.' }),
        Object.assign(prog('La Bamba', [C, F, G, F]), { kind: 'progression', label: 'La Bamba', desc: 'I IV V IV. The three-chord hymn with a lift at the end.' })
      ]
    }
  ];

  lessons.forEach(function (l) {
    l.questions = 10;
    l.items.forEach(function (it) {
      if (!it.notes) it.notes = it.chords[0];
    });
  });

  return lessons;
});