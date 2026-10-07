/*
 * Bread Bot's formula module — the only place bread maths lives.
 *
 * No DOM. It sets window.Bread in the browser and module.exports under
 * Node, so server.js can validate posted inputs against exactly the same
 * formulas the page renders from.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bread = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Loaf size choices in grams of raw dough; 1000 displays as "1 kg".
  var SIZES = [450, 800, 1000];
  // Bagel pieces are sized in grams of dough; a batch is divided into this
  // many-gram pieces, rounded to whole bagels.
  var PIECE_GRAMS = 115;

  /*
   * Each bread: the suggested hydration range and its default (percent of
   * total flour), the flour mix and other ingredients as percent of total
   * flour, the leaven, and the copy for its unit ("Loaves"/"Loaf size" or
   * "Batches"/"Dough per batch").
   */
  var BREADS = {
    sourdough: {
      key: 'sourdough',
      label: 'Sourdough',
      range: [68, 82],
      def: 75,
      flours: [
        { key: 'flour_bread', name: 'Bread flour', detail: 'Strong white flour', percent: 90 },
        { key: 'flour_wholewheat', name: 'Whole wheat flour', detail: 'For flavour', percent: 10 }
      ],
      others: [{ key: 'salt', name: 'Salt', detail: 'Fine sea salt', percent: 2 }],
      leaven: { kind: 'starter', percent: 20 },
      water: { detail: 'Lukewarm, about 27°C' },
      batch: false
    },
    bagels: {
      key: 'bagels',
      label: 'Bagels',
      range: [55, 62],
      def: 58,
      flours: [
        { key: 'flour_bread', name: 'Bread flour', detail: 'High protein if you have it', percent: 100 }
      ],
      others: [
        { key: 'malt', name: 'Barley malt syrup', detail: 'Or honey', percent: 3 },
        { key: 'salt', name: 'Salt', detail: 'Fine sea salt', percent: 2 }
      ],
      leaven: { kind: 'yeast', percent: 0.75 },
      water: { detail: 'Cool, about 20°C' },
      batch: true
    },
    sourdough_bagels: {
      key: 'sourdough_bagels',
      label: 'Sourdough bagels',
      range: [56, 64],
      def: 60,
      flours: [
        { key: 'flour_bread', name: 'Bread flour', detail: 'High protein if you have it', percent: 100 }
      ],
      others: [
        { key: 'malt', name: 'Barley malt syrup', detail: 'Or honey', percent: 3 },
        { key: 'salt', name: 'Salt', detail: 'Fine sea salt', percent: 2 }
      ],
      leaven: { kind: 'starter', percent: 20 },
      water: { detail: 'Cool, about 20°C' },
      batch: true
    },
    rye: {
      key: 'rye',
      label: 'Rye',
      range: [70, 85],
      def: 78,
      flours: [
        { key: 'flour_rye', name: 'Rye flour', detail: 'Medium or light rye', percent: 40 },
        { key: 'flour_bread', name: 'Bread flour', detail: 'Strong white flour', percent: 60 }
      ],
      others: [{ key: 'salt', name: 'Salt', detail: 'Fine sea salt', percent: 2 }],
      leaven: { kind: 'yeast', percent: 1 },
      water: { detail: 'Lukewarm, about 27°C' },
      batch: false
    },
    sandwich: {
      key: 'sandwich',
      label: 'Sandwich loaf',
      range: [60, 70],
      def: 65,
      flours: [
        { key: 'flour_bread', name: 'Bread flour', detail: 'Strong white flour', percent: 100 }
      ],
      others: [
        { key: 'butter', name: 'Butter', detail: 'Softened', percent: 6 },
        { key: 'sugar', name: 'Sugar', detail: 'Caster or granulated', percent: 4 },
        { key: 'salt', name: 'Salt', detail: 'Fine sea salt', percent: 2 }
      ],
      leaven: { kind: 'yeast', percent: 1.2 },
      water: { detail: 'Lukewarm, about 27°C' },
      batch: false
    }
  };

  // The nouns for the result title: "2 sourdough loaves", "1 rye loaf".
  var LOAF_NOUNS = {
    sourdough: ['sourdough loaf', 'sourdough loaves'],
    rye: ['rye loaf', 'rye loaves'],
    sandwich: ['sandwich loaf', 'sandwich loaves']
  };

  /*
   * Rise steps, minutes at a kitchen around 24°C. The step with adjusts:
   * true lengthens or shortens about 1% per point of hydration away from
   * the bread's default. The boil step is marked oven-bound (not part of
   * the rise total).
   */
  var RISE_STEPS = {
    sourdough: [
      { name: 'Mix and rest', cue: 'Mix flour and water, rest, then add starter and salt', minutes: 30 },
      { name: 'Bulk rise', cue: 'Fold 4 times in the first 2 hours. Done when 50% bigger', minutes: 270, adjusts: true },
      { name: 'Shape and rest', cue: 'Shape into rounds, rest seam side up', minutes: 20 },
      { name: 'Cold proof', cue: 'Covered, in the fridge', minutes: 720 }
    ],
    bagels: [
      { name: 'Mix and knead', cue: 'Stiff and smooth', minutes: 10 },
      { name: 'First rise', cue: 'Covered, until puffy', minutes: 60, adjusts: true },
      { name: 'Divide and shape', cue: null, minutes: 20 },
      { name: 'Cold proof', cue: 'On a tray, covered, in the fridge', minutes: 720 },
      { name: 'Boil', cue: 'In water with 1 tbsp malt syrup, per side', minutes: 1, oven: true }
    ],
    sourdough_bagels: [
      { name: 'Mix and knead', cue: 'Stiff and smooth', minutes: 10 },
      { name: 'Bulk rise', cue: 'Covered, until puffy', minutes: 240, adjusts: true },
      { name: 'Divide and shape', cue: null, minutes: 20 },
      { name: 'Cold proof', cue: 'On a tray, covered, in the fridge', minutes: 720 },
      { name: 'Boil', cue: 'In water with 1 tbsp malt syrup, per side', minutes: 1, oven: true }
    ],
    rye: [
      { name: 'Mix', cue: 'No knead: rye has little gluten', minutes: 5 },
      { name: 'Bulk rise', cue: 'Covered, until clearly puffy', minutes: 90, adjusts: true },
      { name: 'Shape', cue: 'One round or a tin, seam up', minutes: 10 },
      { name: 'Proof', cue: 'Covered, until it springs back slowly', minutes: 45 }
    ],
    sandwich: [
      { name: 'Mix and knead', cue: 'Smooth and elastic', minutes: 10 },
      { name: 'First rise', cue: 'Covered, until doubled', minutes: 75, adjusts: true },
      { name: 'Shape into tin', cue: 'Seam down, in a greased 900 g tin', minutes: 10 },
      { name: 'Proof', cue: 'Until 2 cm above the tin', minutes: 60 }
    ]
  };

  /*
   * Bake plans. mainC is the headline temperature, secondC a later one;
   * the step keyed "sizeMinutes" takes its minutes from the loaf size
   * (450 / 800 / 1000 g). doneC is the inside temperature that means done;
   * bagels have none ("until deep brown" in the step's detail instead).
   */
  // A step with tempC carries its own oven temperature; its detail gains
  // the Fahrenheit beside it. The preheat step keeps a literal detail.
  var BAKES = {
    sourdough: {
      mainC: 250,
      secondC: 230,
      steps: [
        { name: 'Preheat', detail: 'Dutch oven inside, 250°C', minutes: 45 },
        { name: 'Lid on', tempC: 250, minutes: 20 },
        { name: 'Lid off', tempC: 230, until: 'until deep brown', sizeMinutes: [15, 25, 30] }
      ],
      doneC: 96,
      note: 'Bake the {count} loaves one at a time and reheat the pot for 10 min between them.',
      noteWhen: 'loaves'
    },
    bagels: {
      mainC: 230,
      steps: [
        { name: 'Preheat', detail: 'Oven and tray, 230°C', minutes: 30 },
        { name: 'Bake', tempC: 230, until: 'until deep brown', minutes: 18 }
      ],
      note: 'Bake one tray at a time.',
      noteWhen: 'batches'
    },
    sourdough_bagels: {
      mainC: 230,
      steps: [
        { name: 'Preheat', detail: 'Oven and tray, 230°C', minutes: 30 },
        { name: 'Bake', tempC: 230, until: 'until deep brown', minutes: 18 }
      ],
      note: 'Bake one tray at a time.',
      noteWhen: 'batches'
    },
    rye: {
      mainC: 230,
      secondC: 210,
      steps: [
        { name: 'Preheat', detail: 'Oven and a tray for steam, 230°C', minutes: 30 },
        { name: 'With steam', tempC: 230, until: 'steam on', minutes: 10 },
        { name: 'Bake', tempC: 210, sizeMinutes: [30, 40, 45] }
      ],
      doneC: 96
    },
    sandwich: {
      mainC: 190,
      steps: [
        { name: 'Preheat', detail: 'Oven only, 190°C', minutes: 20 },
        { name: 'Bake in tin', tempC: 190, until: 'until golden', sizeMinutes: [28, 35, 40] }
      ],
      doneC: 90
    }
  };

  function round15(mins) {
    return Math.max(15, Math.round(mins / 15) * 15);
  }

  function sizeIndex(size) {
    return SIZES.indexOf(size);
  }

  function calculate(inputs) {
    var b = BREADS[inputs.bread];
    var h = inputs.hydration;
    var count = inputs.count;
    var size = inputs.size;
    var dough = count * size;
    var hPct = h / 100;

    // Percentages of total flour that are not flour or water: the "others"
    // plus instant yeast. A starter is inside the flour and the water, so
    // it does not join the divisor.
    var otherPct = b.others.reduce(function (s, o) { return s + o.percent; }, 0);
    if (b.leaven.kind === 'yeast') otherPct += b.leaven.percent;

    var flourTotal = dough / (1 + hPct + otherPct / 100);
    var waterTotal = flourTotal * hPct;
    var starter = b.leaven.kind === 'starter' ? flourTotal * b.leaven.percent / 100 : 0;
    // A starter fed at 100% hydration is half flour, half water.
    var starterFlour = starter / 2;
    var starterWater = starter / 2;
    var addedWater = waterTotal - starterWater;

    function grams(g) { return g >= 10 ? Math.round(g) : Math.round(g * 10) / 10; }

    var ingredients = [];
    b.flours.forEach(function (f) {
      // The starter's flour is taken from the bread flour share.
      var g = flourTotal * f.percent / 100;
      if (f.key === 'flour_bread') g -= starterFlour;
      ingredients.push({ key: f.key, name: f.name, detail: f.detail, grams: grams(g) });
    });
    ingredients.push({
      key: 'water', name: 'Water', detail: b.water.detail, grams: grams(addedWater)
    });
    if (starter > 0) {
      ingredients.push({
        key: 'starter', name: 'Starter',
        detail: 'Fed and bubbly, 100% hydration', grams: grams(starter)
      });
    }
    b.others.forEach(function (o) {
      ingredients.push({ key: o.key, name: o.name, detail: o.detail, grams: grams(flourTotal * o.percent / 100) });
    });
    if (b.leaven.kind === 'yeast') {
      ingredients.push({
        key: 'yeast', name: 'Instant yeast', detail: 'Mix in with the flour',
        grams: grams(flourTotal * b.leaven.percent / 100)
      });
    }

    // Bagel types: the dough is divided into pieces of about PIECE_GRAMS.
    var pieces = 0;
    var pieceGrams = 0;
    if (b.batch) {
      pieces = Math.max(1, Math.round(dough / PIECE_GRAMS));
      pieceGrams = Math.round(dough / pieces);
    }

    var title;
    var line;
    if (b.batch) {
      title = (pieces * count) + ' bagels';
      line = count + ' batch' + (count > 1 ? 'es' : '') + ' of ' + size + ' g, divided into ' +
        pieces + ' pieces of ' + pieceGrams + ' g';
    } else {
      var noun = LOAF_NOUNS[inputs.bread][count > 1 ? 1 : 0];
      title = count + ' ' + noun;
      line = size + ' g each, ' + thousands(dough) + ' g of dough in total';
    }

    // Rise steps: the adjusting step moves about 1% per hydration point
    // away from the bread's default, rounded to 15 minutes.
    var riseSteps = RISE_STEPS[inputs.bread].map(function (s) {
      var mins = s.minutes;
      if (s.adjusts) {
        mins = round15(mins * (1 - 0.01 * (h - b.def)));
      }
      var cue = s.cue;
      if (cue === null) {
        cue = pieces + ' pieces of ' + pieceGrams + ' g, rolled into rings';
      }
      return { name: s.name, cue: cue, minutes: mins };
    });
    var riseTotal = riseSteps.reduce(function (s, st) { return st.oven ? s : s + st.minutes; }, 0);

    // Bake: wetter dough (5 points or more above the default) bakes a
    // little longer; the extra goes on the longest oven stage.
    var sizeIx = sizeIndex(size);
    var mainC = BAKES[inputs.bread].mainC;
    var secondC = BAKES[inputs.bread].secondC || null;
    var bakeSteps = BAKES[inputs.bread].steps.map(function (s) {
      var mins = s.sizeMinutes ? s.sizeMinutes[sizeIx] : s.minutes;
      var step = { name: s.name, tempC: s.tempC || null, minutes: mins, preheat: !s.tempC };
      step.detail = step.preheat ? s.detail
        : s.tempC + '°C (' + toF(s.tempC) + '°F)' + (s.until ? ', ' + s.until : '');
      return step;
    });
    if (h >= b.def + 5) {
      var longest = null;
      bakeSteps.forEach(function (s) {
        if (!s.preheat && (!longest || s.minutes > longest.minutes)) longest = s;
      });
      if (longest) longest.minutes += 2;
    }

    var note = null;
    if (BAKES[inputs.bread].noteWhen === 'loaves' && count > 1) {
      note = BAKES[inputs.bread].note.replace('{count}', count);
    }
    if (BAKES[inputs.bread].noteWhen === 'batches' && count > 1) {
      note = BAKES[inputs.bread].note;
    }

    var flourLine = null;
    if (starter > 0) {
      flourLine = thousands(Math.round(flourTotal)) + ' g of flour and ' +
        thousands(Math.round(waterTotal)) + ' g of water in all, counting the starter.';
    }

    return {
      bread: inputs.bread,
      label: b.label,
      hydration: h,
      count: count,
      size: size,
      dough: dough,
      batch: b.batch,
      pieces: pieces,
      pieceGrams: pieceGrams,
      title: title,
      line: line,
      ingredients: ingredients,
      flourTotal: flourTotal,
      waterTotal: waterTotal,
      flourLine: flourLine,
      riseSteps: riseSteps,
      riseTotal: riseTotal,
      bake: {
        mainC: mainC,
        secondC: secondC,
        steps: bakeSteps,
        doneC: BAKES[inputs.bread].doneC || null,
        note: note
      }
    };
  }

  function thousands(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function validInputs(inputs) {
    return !!inputs &&
      Object.prototype.hasOwnProperty.call(BREADS, inputs.bread) &&
      Number.isInteger(inputs.hydration) && inputs.hydration >= 50 && inputs.hydration <= 90 &&
      Number.isInteger(inputs.count) && inputs.count >= 1 && inputs.count <= 12 &&
      SIZES.indexOf(inputs.size) !== -1;
  }

  // "Sourdough, 2 × 800 g, 75%" — 1000 g shows as "1 kg".
  function autoName(inputs) {
    var b = BREADS[inputs.bread];
    var sizeLabel = inputs.size === 1000 ? '1 kg' : inputs.size + ' g';
    return b.label + ', ' + inputs.count + ' × ' + sizeLabel + ', ' + inputs.hydration + '%';
  }

  function formatGrams(g) {
    if (g < 10) return (Math.round(g * 10) / 10).toFixed(1) + ' g';
    return thousands(Math.round(g)) + ' g';
  }

  function formatMinutes(mins) {
    if (mins < 60) return mins + ' min';
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return m ? h + ' h ' + m + ' min' : h + ' h';
  }

  function toF(c) {
    return Math.round(c * 9 / 5 + 32);
  }

  return {
    BREADS: BREADS,
    SIZES: SIZES,
    calculate: calculate,
    validInputs: validInputs,
    autoName: autoName,
    formatGrams: formatGrams,
    formatMinutes: formatMinutes,
    toF: toF
  };
});