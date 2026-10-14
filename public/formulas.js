/* Bread Bot's formula maths. Pure and client-side: the same table feeds the
 * calculator in the page and the default recipe names on the server (kept in
 * sync by hand). Nothing here reads or writes the network.
 *
 * Flour is the base at 100%; every other ingredient is a baker's percentage
 * of the total flour. Hydration counts the ADDED water only, not the water
 * inside the starter. Rye's 100% is a mix: 60% rye flour + 40% bread flour.
 */
(function () {
  'use strict';

  var BREADS = {
    sourdough: {
      label: 'Sourdough',
      unit: 'loaves',
      unitOne: 'loaf',
      defaultHydration: 72,
      defaultFlour: 500,
      flourMin: 200, flourMax: 1500, flourStep: 50,
      flours: [['Bread flour', 100]],
      others: function (h) { return [['Water', h], ['Starter', 20], ['Salt', 2]]; },
      riseBase: 300, riseTemp: 24, riseNote: '',
      bakeTemps: [240, 220], bakeBase: 45, bakeNote: 'lidded 25',
    },
    bagels: {
      label: 'Bagels',
      unit: 'bagels',
      unitOne: 'bagel',
      defaultHydration: 58,
      defaultFlour: 75,
      flourMin: 50, flourMax: 200, flourStep: 10,
      flours: [['Bread flour', 100]],
      others: function (h) { return [['Water', h], ['Instant yeast', 1], ['Salt', 2], ['Malt syrup', 3]]; },
      riseBase: 60, riseTemp: 24, riseNote: 'then boil 1 min',
      bakeTemps: [220], bakeBase: 20, bakeNote: '',
    },
    sourdoughBagels: {
      label: 'Sourdough bagels',
      unit: 'bagels',
      unitOne: 'bagel',
      defaultHydration: 58,
      defaultFlour: 75,
      flourMin: 50, flourMax: 200, flourStep: 10,
      flours: [['Bread flour', 100]],
      others: function (h) { return [['Water', h], ['Starter', 25], ['Salt', 2], ['Malt syrup', 3]]; },
      riseBase: 720, riseTemp: null, riseNote: 'in the fridge, then boil 1 min',
      bakeTemps: [220], bakeBase: 22, bakeNote: '',
    },
    rye: {
      label: 'Rye',
      unit: 'loaves',
      unitOne: 'loaf',
      defaultHydration: 78,
      defaultFlour: 500,
      flourMin: 200, flourMax: 1500, flourStep: 50,
      flours: [['Rye flour', 60], ['Bread flour', 40]],
      others: function (h) { return [['Water', h], ['Starter', 20], ['Salt', 2]]; },
      riseBase: 180, riseTemp: 26, riseNote: '',
      bakeTemps: [250, 210], bakeBase: 60, bakeNote: '',
    },
    sandwich: {
      label: 'Sandwich loaf',
      unit: 'loaves',
      unitOne: 'loaf',
      defaultHydration: 65,
      defaultFlour: 500,
      flourMin: 200, flourMax: 1500, flourStep: 50,
      flours: [['Bread flour', 100]],
      others: function (h) { return [['Water', h], ['Instant yeast', 1.5], ['Salt', 2], ['Sugar', 4], ['Butter', 6]]; },
      riseBase: 90, riseTemp: 24, riseNote: 'then 1 h in the tin',
      bakeTemps: [190], bakeBase: 35, bakeNote: '',
    },
  };

  function fmtPct(p) {
    var n = Math.round(p * 10) / 10;
    return (n % 1 === 0 ? String(Math.round(n)) : String(n)) + '%';
  }

  function fmtGrams(g) {
    return g.toLocaleString('en-US');
  }

  // 300 -> "5 h", 90 -> "1.5 h", 45 -> "45 min"
  function fmtDuration(min) {
    if (min % 60 === 0) return (min / 60) + ' h';
    if (min % 30 === 0) {
      var h = min / 60;
      return (Math.round(h * 10) / 10) + ' h';
    }
    return min + ' min';
  }

  // Wetter dough rises a little faster and bakes a little longer: per 5
  // hydration points above the bread's default, rise drops 5% and bake
  // gains 2 minutes. Mirrored below the default. Rise rounds to 15 min,
  // bake to 1 min.
  function adjusted(bread, hydration) {
    var steps = (hydration - bread.defaultHydration) / 5;
    var rise = Math.round((bread.riseBase * (1 - 0.05 * steps)) / 15) * 15;
    var bake = Math.max(1, Math.round(bread.bakeBase + 2 * steps));
    return { rise: rise, bake: bake };
  }

  // calculate(bread, hydration, count, flourPer) -> the whole formula sheet:
  // ingredient rows (grams rounded, baker's %), rise, bake and time.
  function calculate(breadKey, hydration, count, flourPer) {
    var b = BREADS[breadKey];
    if (!b) return null;
    var flourTotal = count * flourPer;
    var rows = [];
    var doughTotal = 0;
    var i, name, pct, grams;
    for (i = 0; i < b.flours.length; i++) {
      name = b.flours[i][0];
      pct = b.flours[i][1];
      grams = Math.round(flourTotal * pct / 100);
      rows.push({ name: name, pct: pct, grams: grams, isFlour: true });
      doughTotal += grams;
    }
    var rest = b.others(hydration);
    for (i = 0; i < rest.length; i++) {
      name = rest[i][0];
      pct = rest[i][1];
      grams = Math.round(flourTotal * pct / 100);
      rows.push({ name: name, pct: pct, grams: grams, isFlour: false });
      doughTotal += grams;
    }
    var adj = adjusted(b, hydration);
    var riseNote = [];
    if (b.riseTemp !== null) riseNote.push('at ' + b.riseTemp + '°C');
    if (b.riseNote) riseNote.push(b.riseNote);
    return {
      bread: breadKey,
      label: b.label,
      unit: b.unit,
      count: count,
      hydration: hydration,
      flourPer: flourPer,
      rows: rows,
      flourTotal: flourTotal,
      doughTotal: doughTotal,
      heading: b.label + ', ' + count + ' ' + (count === 1 ? b.unitOne : b.unit),
      sub: fmtGrams(flourTotal) + ' g flour, ' + fmtGrams(doughTotal) + ' g dough',
      rise: { big: fmtDuration(adj.rise), note: riseNote.join(', ') },
      bake: {
        big: b.bakeTemps[0] + '°C',
        note: b.bakeTemps[1] ? 'then ' + b.bakeTemps[1] + '°C' : '',
      },
      time: { big: adj.bake + ' min', note: b.bakeNote || '' },
    };
  }

  // The name a recipe gets when saved with the name field left blank.
  function defaultName(breadKey, count) {
    var b = BREADS[breadKey];
    if (!b) return 'My recipe';
    return b.label + ', ' + count + ' ' + (count === 1 ? b.unitOne : b.unit);
  }

  window.BreadFormulas = {
    BREADS: BREADS,
    calculate: calculate,
    defaultName: defaultName,
    fmtPct: fmtPct,
    fmtGrams: fmtGrams,
  };
})();