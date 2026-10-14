/* Bread Bot: turn a bread choice and three numbers into a recipe.
 *
 * Everything runs in the page — no server route, no storage. The recipes
 * live in RECIPES below as baker's percentages, with the simple built-in
 * rise and bake rules; adjust them there. Renders with textContent only.
 */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }

  /* One entry per bread, as the spec's table sets them.
   * hydration/count/size carry their default and limits; flour and extras
   * are percentages of the flour (water uses the hydration setting). */
  var RECIPES = {
    sourdough: {
      label: 'Sourdough',
      unit: 'loaves',
      unitOne: 'loaf',
      sizeLabel: 'Size of each loaf',
      hydration: { def: 75, min: 60, max: 90 },
      count: { def: 2, min: 1, max: 24 },
      size: { def: 800, min: 300, max: 2000, step: 50 },
      flour: [{ label: 'Bread flour', short: 'Flour', pct: 100 }],
      extras: [
        { label: 'Sourdough starter', short: 'Starter', pct: 15 },
        { label: 'Salt', short: 'Salt', pct: 2 },
      ],
      rise: { label: 'Bulk rise', text: '5 h' },
      bakeTemp: 240,
      bakeBase: 45,
      bakeAdj: { grams: 200, minutes: 5 },
      note: 'Bulk rise at 24 °C with folds every 45 minutes. Shape, then proof 12 hours in the fridge. Bake covered for 25 minutes, then uncovered for 20.',
    },
    bagels: {
      label: 'Bagels',
      unit: 'bagels',
      unitOne: 'bagel',
      sizeLabel: 'Size of each bagel',
      hydration: { def: 58, min: 50, max: 65 },
      count: { def: 8, min: 1, max: 24 },
      size: { def: 110, min: 60, max: 200, step: 10 },
      flour: [{ label: 'Bread flour', short: 'Flour', pct: 100 }],
      extras: [
        { label: 'Instant yeast', short: 'Yeast', pct: 1 },
        { label: 'Salt', short: 'Salt', pct: 2 },
        { label: 'Sugar', short: 'Sugar', pct: 3 },
      ],
      rise: { label: 'Rise', text: '1 h' },
      bakeTemp: 220,
      bakeBase: 20,
      bakeAdj: { grams: 20, minutes: 2 },
      note: 'Shape and chill overnight in the fridge. Boil 1 minute a side, then bake.',
    },
    'sourdough-bagels': {
      label: 'Sourdough bagels',
      unit: 'bagels',
      unitOne: 'bagel',
      sizeLabel: 'Size of each bagel',
      hydration: { def: 58, min: 50, max: 65 },
      count: { def: 8, min: 1, max: 24 },
      size: { def: 110, min: 60, max: 200, step: 10 },
      flour: [{ label: 'Bread flour', short: 'Flour', pct: 100 }],
      extras: [
        { label: 'Sourdough starter', short: 'Starter', pct: 20 },
        { label: 'Salt', short: 'Salt', pct: 2 },
        { label: 'Sugar', short: 'Sugar', pct: 3 },
      ],
      rise: { label: 'Bulk rise', text: '6 h' },
      bakeTemp: 220,
      bakeBase: 22,
      bakeAdj: { grams: 20, minutes: 2 },
      note: 'Bulk rise 6 hours, then shape and chill overnight in the fridge. Boil 1 minute a side, then bake.',
    },
    rye: {
      label: 'Rye',
      unit: 'loaves',
      unitOne: 'loaf',
      sizeLabel: 'Size of each loaf',
      hydration: { def: 80, min: 70, max: 100 },
      count: { def: 1, min: 1, max: 24 },
      size: { def: 900, min: 300, max: 2000, step: 50 },
      flour: [
        { label: 'Rye flour', short: 'Rye flour', pct: 70 },
        { label: 'Bread flour', short: 'Bread flour', pct: 30 },
      ],
      extras: [
        { label: 'Sourdough starter', short: 'Starter', pct: 20 },
        { label: 'Salt', short: 'Salt', pct: 2 },
      ],
      rise: { label: 'Bulk rise', text: '3 h' },
      bakeTemp: 230,
      bakeBase: 55,
      bakeAdj: { grams: 200, minutes: 5 },
      note: 'Shape and proof 1 hour in the tin. Bake uncovered.',
    },
    sandwich: {
      label: 'Sandwich loaf',
      unit: 'loaves',
      unitOne: 'loaf',
      sizeLabel: 'Size of each loaf',
      hydration: { def: 65, min: 55, max: 75 },
      count: { def: 1, min: 1, max: 24 },
      size: { def: 900, min: 300, max: 2000, step: 50 },
      flour: [{ label: 'Bread flour', short: 'Flour', pct: 100 }],
      extras: [
        { label: 'Instant yeast', short: 'Yeast', pct: 1.5 },
        { label: 'Salt', short: 'Salt', pct: 2 },
        { label: 'Sugar', short: 'Sugar', pct: 4 },
        { label: 'Butter', short: 'Butter', pct: 6 },
      ],
      rise: { label: 'Rise', text: '1 h 30 min' },
      bakeTemp: 190,
      bakeBase: 35,
      bakeAdj: { grams: 200, minutes: 5 },
      note: 'Shape and proof 1 hour in the tin. Bake uncovered.',
    },
  };

  var BREAD_ORDER = ['sourdough', 'bagels', 'sourdough-bagels', 'rye', 'sandwich'];

  var state = {
    bread: 'sourdough',
    hydration: RECIPES.sourdough.hydration.def,
    count: RECIPES.sourdough.count.def,
    size: RECIPES.sourdough.size.def,
  };
  var calculated = false;

  /* ── Formatting ─────────────────────────────────────────────────────── */

  // Whole grams; one decimal under 10 g.
  function grams(g) {
    if (g < 10) {
      var tenth = Math.round(g * 10) / 10;
      return (Number.isInteger(tenth) ? tenth.toFixed(0) : tenth.toFixed(1)) + ' g';
    }
    return Math.round(g).toLocaleString('en-US') + ' g';
  }

  function fmtInt(n) { return n.toLocaleString('en-US'); }

  // The bake time grows or shrinks by the recipe's rule for its usual loaf
  // size, and never falls below half of it.
  function bakeTime(recipe, size) {
    var adj = Math.round(
      (size - recipe.size.def) / recipe.bakeAdj.grams * recipe.bakeAdj.minutes
    );
    var t = Math.max(recipe.bakeBase + adj, recipe.bakeBase / 2);
    if (t < 60) return t + ' min';
    var h = Math.floor(t / 60);
    var m = t % 60;
    return m ? h + ' h ' + m + ' min' : h + ' h';
  }

  /* ── The calculation: a pure function ───────────────────────────────── */

  // Total dough = count × size; flour comes out of the sum of percentages,
  // with the water set to the hydration. Hydration counts only the water
  // you add; the starter is its own ingredient.
  function calculate(input) {
    var recipe = RECIPES[input.bread];
    if (!recipe) throw new Error('unknown bread');
    var total = input.count * input.size;
    var flourPct = recipe.flour.reduce(function (sum, f) { return sum + f.pct; }, 0);
    var sum = flourPct + input.hydration;
    recipe.extras.forEach(function (e) { sum += e.pct; });
    var flour = total / (sum / 100);

    var rows = recipe.flour.map(function (f) {
      return { label: f.label, short: f.short, pct: f.pct, grams: flour * f.pct / flourPct };
    });
    rows.push({ label: 'Water', short: 'Water', pct: input.hydration, grams: flour * input.hydration / 100 });
    recipe.extras.forEach(function (e) {
      rows.push({ label: e.label, short: e.short, pct: e.pct, grams: flour * e.pct / 100 });
    });

    return {
      recipe: recipe,
      count: input.count,
      size: input.size,
      total: total,
      rows: rows,
      rise: recipe.rise,
      bakeTemp: recipe.bakeTemp,
      bakeTime: bakeTime(recipe, input.size),
      note: recipe.note,
    };
  }

  /* ── Rendering (textContent only) ───────────────────────────────────── */

  function renderChips() {
    BREAD_ORDER.forEach(function (key) {
      var chip = $('chip-' + key);
      var on = key === state.bread;
      chip.classList.toggle('on', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function renderControls() {
    var recipe = RECIPES[state.bread];
    $('hydration-num').textContent = state.hydration + '%';
    $('count-num').textContent = String(state.count);
    $('size-num').textContent = fmtInt(state.size) + ' g';
    $('count-label').textContent = recipe.unit.charAt(0).toUpperCase() + recipe.unit.slice(1);
    $('size-label').textContent = recipe.sizeLabel;
    $('count-minus').setAttribute('aria-label', 'Fewer ' + recipe.unit);
    $('count-plus').setAttribute('aria-label', 'More ' + recipe.unit);
    $('hydration-minus').disabled = state.hydration <= recipe.hydration.min;
    $('hydration-plus').disabled = state.hydration >= recipe.hydration.max;
    $('count-minus').disabled = state.count <= recipe.count.min;
    $('count-plus').disabled = state.count >= recipe.count.max;
    $('size-minus').disabled = state.size <= recipe.size.min;
    $('size-plus').disabled = state.size >= recipe.size.max;
    $('size-minus').setAttribute('aria-label', recipe.sizeLabel.toLowerCase() + ' less');
    $('size-plus').setAttribute('aria-label', recipe.sizeLabel.toLowerCase() + ' more');
  }

  function renderResults(result) {
    var recipe = result.recipe;
    // "2 sourdough loaves"; where the unit is the name ("8 bagels"), once.
    var what = recipe.unit === recipe.label.toLowerCase()
      ? (result.count === 1 ? recipe.unitOne : recipe.unit)
      : recipe.label.toLowerCase() + ' ' + (result.count === 1 ? recipe.unitOne : recipe.unit);
    $('ingredients-label').textContent =
      'Ingredients for ' + result.count + ' ' + what + ', ' +
      fmtInt(result.total) + ' g of dough';

    var list = $('ingredients');
    list.textContent = '';
    result.rows.forEach(function (row) {
      var li = document.createElement('li');
      li.className = 'list-row';
      var name = document.createElement('span');
      name.className = 'grow';
      name.textContent = row.label;
      var amount = document.createElement('span');
      amount.className = 'val';
      amount.textContent = grams(row.grams);
      li.appendChild(name);
      li.appendChild(amount);
      list.appendChild(li);
    });

    var notebook = $('notebook');
    notebook.textContent = '';
    result.rows.forEach(function (row) {
      var line = document.createElement('div');
      line.className = 'nrow';
      var name = document.createElement('b');
      name.textContent = row.short;
      var bar = document.createElement('div');
      bar.className = 'bar';
      var fill = document.createElement('i');
      fill.style.width = Math.min(row.pct, 100) + '%';
      bar.appendChild(fill);
      var pct = document.createElement('span');
      pct.className = 'pct';
      pct.textContent = row.pct + '%';
      line.appendChild(name);
      line.appendChild(bar);
      line.appendChild(pct);
      notebook.appendChild(line);
    });

    $('rise-label').textContent = result.rise.label;
    $('rise-value').textContent = result.rise.text;
    $('bake-temp').textContent = result.bakeTemp + ' °C';
    $('bake-time').textContent = result.bakeTime;
    $('timing-note').textContent = result.note;
  }

  function show(which) {
    $('empty').hidden = which !== 'empty';
    $('results').hidden = which !== 'results';
    $('error').hidden = which !== 'error';
    if (which !== 'results') $('stale').hidden = true;
  }

  function runCalc() {
    try {
      renderResults(calculate(state));
      calculated = true;
      $('stale').hidden = true;
      show('results');
    } catch (err) {
      show('error');
    }
  }

  // Any setting change after a calculation leaves the old numbers on
  // screen, so say they are old.
  function markStale() {
    if (calculated) $('stale').hidden = false;
  }

  function setBread(key) {
    if (!RECIPES[key] || key === state.bread) return;
    state.bread = key;
    state.hydration = RECIPES[key].hydration.def;
    state.count = RECIPES[key].count.def;
    state.size = RECIPES[key].size.def;
    renderChips();
    renderControls();
    markStale();
  }

  function nudge(field, direction) {
    var recipe = RECIPES[state.bread];
    var limits = field === 'size' ? recipe.size
      : field === 'count' ? recipe.count : recipe.hydration;
    var step = field === 'size' ? recipe.size.step : 1;
    var next = state[field] + direction * step;
    state[field] = Math.min(limits.max, Math.max(limits.min, next));
    renderControls();
    markStale();
  }

  /* ── Wire up ────────────────────────────────────────────────────────── */

  BREAD_ORDER.forEach(function (key) {
    $('chip-' + key).addEventListener('click', function () { setBread(key); });
  });
  [['hydration', -1], ['hydration', 1], ['count', -1], ['count', 1], ['size', -1], ['size', 1]]
    .forEach(function (pair) {
      $(pair[0] + (pair[1] < 0 ? '-minus' : '-plus'))
        .addEventListener('click', function () { nudge(pair[0], pair[1]); });
    });
  $('calculate').addEventListener('click', runCalc);
  $('retry').addEventListener('click', runCalc);

  renderChips();
  renderControls();
  show('empty');

  // The staging demo: an example recipe, already calculated. Page state
  // only — it writes nothing and works in every environment.
  if (new URLSearchParams(window.location.search).get('demo') === '1') {
    $('demo-line').hidden = false;
    runCalc();
  }
})();
