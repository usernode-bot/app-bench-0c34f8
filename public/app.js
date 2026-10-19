// The bread formula calculator. Everything runs in the page: pick a bread,
// set hydration, count and size, and the formula card fills in.
//
// The percentages are common baker's starting points, not tested recipes,
// and the rise times assume a kitchen at about 24°C. A bread ingredient with
// `remainder: true` takes whatever grams the other rounded ingredients leave,
// so the total always equals loaves x size.

(function () {
  'use strict';

  var BREADS = {
    sourdough: {
      label: 'Sourdough',
      hydration: 75,
      size: 800,
      count: 1,
      countLabel: 'Loaves',
      countNoun: 'loaves',
      countOne: 'loaf',
      sizeLabel: 'Loaf size',
      sizeNoun: 'loaf size',
      ingredients: [
        { name: 'Bread flour', pct: 100, remainder: true },
        { name: 'Water', water: true },
        { name: 'Salt', pct: 2 },
        { name: 'Starter', pct: 20 },
      ],
      rise: '5 h',
      riseLabel: 'Bulk rise',
      oven: '230°C',
      bakeMinutes: 45,
      steps: function (bake) {
        return [
          'Mix, then bulk rise 5 h at room temperature, folding every 30 min for the first 2 h.',
          'Shape, then proof 12 h in the fridge.',
          'Bake at 230°C, covered for 20 min, uncovered for ' + Math.max(bake.minutes - 20, 5) + ' min.',
        ];
      },
    },

    bagels: {
      label: 'Bagels',
      hydration: 58,
      size: 110,
      count: 8,
      countLabel: 'Bagels',
      countNoun: 'bagels',
      countOne: 'bagel',
      sizeLabel: 'Bagel size',
      sizeNoun: 'bagel size',
      ingredients: [
        { name: 'Bread flour', pct: 100, remainder: true },
        { name: 'Water', water: true },
        { name: 'Salt', pct: 2 },
        { name: 'Instant yeast', pct: 1 },
        { name: 'Barley malt syrup', pct: 3 },
      ],
      rise: '1 h',
      riseLabel: 'First rise',
      oven: '220°C',
      bakeMinutes: 20,
      fixedBake: true,
      steps: function (bake) {
        return [
          'Mix, then first rise 1 h at room temperature.',
          'Shape into ' + format(bake.count) + ' bagels, then chill 12 h in the fridge.',
          'Boil 1 min a side.',
          'Bake at 220°C for ' + bake.minutes + ' min.',
        ];
      },
    },

    'sourdough-bagels': {
      label: 'Sourdough bagels',
      hydration: 58,
      size: 110,
      count: 8,
      countLabel: 'Bagels',
      countNoun: 'bagels',
      countOne: 'bagel',
      sizeLabel: 'Bagel size',
      sizeNoun: 'bagel size',
      ingredients: [
        { name: 'Bread flour', pct: 100, remainder: true },
        { name: 'Water', water: true },
        { name: 'Salt', pct: 2 },
        { name: 'Starter', pct: 20 },
        { name: 'Barley malt syrup', pct: 3 },
      ],
      rise: '4 h',
      riseLabel: 'Bulk rise',
      oven: '220°C',
      bakeMinutes: 22,
      fixedBake: true,
      steps: function (bake) {
        return [
          'Mix, then bulk rise 4 h at room temperature.',
          'Shape into ' + format(bake.count) + ' bagels, then chill 12 h in the fridge.',
          'Boil 1 min a side.',
          'Bake at 220°C for ' + bake.minutes + ' min.',
        ];
      },
    },

    rye: {
      label: 'Rye',
      hydration: 80,
      size: 900,
      count: 1,
      countLabel: 'Loaves',
      countNoun: 'loaves',
      countOne: 'loaf',
      sizeLabel: 'Loaf size',
      sizeNoun: 'loaf size',
      ingredients: [
        { name: 'Rye flour', pct: 60 },
        { name: 'Bread flour', pct: 40, remainder: true },
        { name: 'Water', water: true },
        { name: 'Salt', pct: 2 },
        { name: 'Starter', pct: 20 },
      ],
      rise: '3 h',
      riseLabel: 'Bulk rise',
      oven: '230/210°C',
      bakeMinutes: 50,
      steps: function (bake) {
        return [
          'Mix, then bulk rise 3 h at room temperature.',
          'Shape, then proof 1 h.',
          'Bake at 230°C for 15 min, then at 210°C for ' + Math.max(bake.minutes - 15, 10) + ' min.',
        ];
      },
    },

    sandwich: {
      label: 'Sandwich loaf',
      hydration: 62,
      size: 900,
      count: 1,
      countLabel: 'Loaves',
      countNoun: 'loaves',
      countOne: 'loaf',
      sizeLabel: 'Loaf size',
      sizeNoun: 'loaf size',
      ingredients: [
        { name: 'Bread flour', pct: 100, remainder: true },
        { name: 'Water', water: true },
        { name: 'Salt', pct: 2 },
        { name: 'Instant yeast', pct: 1.5 },
        { name: 'Sugar', pct: 5 },
        { name: 'Butter', pct: 8 },
      ],
      rise: '1.5 h',
      riseLabel: 'First rise',
      oven: '190°C',
      bakeMinutes: 35,
      steps: function (bake) {
        return [
          'Mix, then first rise 1.5 h at room temperature.',
          'Shape and put in a tin, then proof 1 h.',
          'Bake at 190°C for ' + bake.minutes + ' min.',
        ];
      },
    },
  };

  var fields = {
    hydration: document.getElementById('hydration'),
    count: document.getElementById('count'),
    size: document.getElementById('size'),
  };

  var el = {
    chips: Array.prototype.slice.call(document.querySelectorAll('[data-bread]')),
    demoNote: document.querySelector('[data-usernode-demo-note]'),
    countLabel: document.querySelector('[data-count-label]'),
    sizeLabel: document.querySelector('[data-size-label]'),
    title: document.querySelector('[data-recipe-title]'),
    meta: document.querySelector('[data-recipe-meta]'),
    body: document.querySelector('[data-recipe-body]'),
    ingredients: document.querySelector('[data-ingredients]'),
    totalPct: document.querySelector('[data-recipe-total-pct]'),
    total: document.querySelector('[data-recipe-total]'),
    rise: document.querySelector('[data-rise]'),
    riseLabel: document.querySelector('[data-rise-label]'),
    oven: document.querySelector('[data-oven]'),
    bakeTime: document.querySelector('[data-bake-time]'),
    steps: document.querySelector('[data-steps]'),
    error: document.querySelector('[data-recipe-error]'),
  };

  var activeBread = 'sourdough';

  function format(n) {
    return Number(n).toLocaleString('en', { maximumFractionDigits: 1 });
  }

  function grams(n) {
    return Math.round(n).toLocaleString('en');
  }

  function readNumber(input) {
    var raw = input.value == null ? '' : input.value.trim();
    if (raw === '') return null;
    var n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function markInvalid(field, invalid) {
    if (invalid) fields[field].setAttribute('aria-invalid', 'true');
    else fields[field].removeAttribute('aria-invalid');
  }

  // Baker's formula: the dough splits by each ingredient's percentage of the
  // total flour. Everything but the remainder flour is rounded to whole
  // grams; the remainder flour takes what is left, so the total is exact.
  function buildRecipe(bread, hydration, count, size) {
    var dough = Math.round(count * size);
    var parts = bread.ingredients.map(function (ingredient) {
      return {
        name: ingredient.name,
        pct: ingredient.water ? hydration : ingredient.pct,
        remainder: Boolean(ingredient.remainder),
      };
    });
    var totalPct = parts.reduce(function (sum, part) { return sum + part.pct; }, 0);
    var flour = (dough * 100) / totalPct;
    var used = 0;
    parts.forEach(function (part) {
      if (part.remainder) return;
      part.grams = Math.round((flour * part.pct) / 100);
      used += part.grams;
    });
    var rest = parts.filter(function (part) { return part.remainder; })[0];
    if (rest) rest.grams = dough - used;
    return { dough: dough, totalPct: totalPct, parts: parts };
  }

  // 5 minutes more or less for every 200 g away from the bread's usual size,
  // never under 25 minutes. Bagels always bake the same time.
  function bakeMinutes(bread, size) {
    if (bread.fixedBake) return bread.bakeMinutes;
    var diff = size - bread.size;
    var steps = Math.sign(diff) * Math.floor(Math.abs(diff) / 200);
    return Math.max(25, bread.bakeMinutes + steps * 5);
  }

  function render() {
    var bread = BREADS[activeBread];
    var hydration = readNumber(fields.hydration);
    var countValue = readNumber(fields.count);
    var size = readNumber(fields.size);
    var count = countValue === null ? null : Math.round(countValue);

    var error = null;
    if (hydration === null || hydration < 50 || hydration > 100) {
      error = { field: 'hydration', message: 'Enter a hydration between 50 and 100%.' };
    } else if (count === null || count < 1 || count > 24) {
      error = { field: 'count', message: 'Enter 1 to 24 ' + bread.countNoun + '.' };
    } else if (size === null || size < 50 || size > 2000) {
      error = { field: 'size', message: 'Enter a ' + bread.sizeNoun + ' between 50 and 2,000 g.' };
    }

    el.title.textContent = bread.label + ' formula';
    markInvalid('hydration', Boolean(error) && error.field === 'hydration');
    markInvalid('count', Boolean(error) && error.field === 'count');
    markInvalid('size', Boolean(error) && error.field === 'size');

    if (error) {
      el.meta.hidden = true;
      el.body.hidden = true;
      el.error.hidden = false;
      el.error.querySelector('p').textContent = error.message;
      return;
    }

    var recipe = buildRecipe(bread, hydration, count, size);
    var minutes = bakeMinutes(bread, size);

    el.meta.hidden = false;
    el.body.hidden = false;
    el.error.hidden = true;

    el.meta.textContent = grams(count) + ' ' + (count === 1 ? bread.countOne : bread.countNoun) +
      ' at ' + format(size) + ' g, ' + grams(recipe.dough) + ' g dough in total';

    el.ingredients.replaceChildren.apply(el.ingredients, recipe.parts.map(function (part) {
      var row = document.createElement('div');
      row.className = 'row';
      var name = document.createElement('span');
      name.textContent = part.name;
      var percent = document.createElement('span');
      percent.textContent = format(part.pct) + '%';
      var amount = document.createElement('span');
      amount.textContent = grams(part.grams) + ' g';
      row.append(name, percent, amount);
      return row;
    }));

    el.totalPct.textContent = format(recipe.totalPct) + '%';
    el.total.textContent = grams(recipe.dough) + ' g';

    el.rise.textContent = bread.rise;
    el.riseLabel.textContent = bread.riseLabel;
    el.oven.textContent = bread.oven;
    el.bakeTime.textContent = minutes + ' min';

    el.steps.replaceChildren.apply(el.steps, bread.steps({ minutes: minutes, count: count }).map(function (text) {
      var item = document.createElement('li');
      item.textContent = text;
      return item;
    }));
  }

  function selectBread(key) {
    activeBread = key;
    var bread = BREADS[key];
    el.chips.forEach(function (chip) {
      var on = chip.getAttribute('data-bread') === key;
      chip.classList.toggle('on', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    // Picking a bread fills in its usual hydration and size; the loaf count
    // stays as it was.
    fields.hydration.value = String(bread.hydration);
    fields.size.value = String(bread.size);
    el.countLabel.textContent = bread.countLabel;
    el.sizeLabel.textContent = bread.sizeLabel;
    render();
  }

  el.chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      selectBread(chip.getAttribute('data-bread'));
    });
  });

  Object.keys(fields).forEach(function (key) {
    fields[key].addEventListener('input', render);
  });

  selectBread('sourdough');

  // The staging demo opens on a sample bake. It is only shown with ?demo=1.
  if (new URLSearchParams(window.location.search).get('demo') === '1') {
    fields.hydration.value = '75';
    fields.count.value = '2';
    fields.size.value = '800';
    el.demoNote.hidden = false;
    render();
  }
})();
