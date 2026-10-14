/* Bread Bot: a bread choice plus a few numbers, worked into a full recipe.
 * Pure client side: a BREADS table of baker's percentages, a small state,
 * and rendering into the screen the spec drew in public/index.html.
 * Nothing is saved and nothing loads, so there is no loading or error state.
 */
(function () {
  'use strict';

  // The dial's circumference: 2 × π × 38, the radius of the circle in
  // index.html. The fill's stroke-dasharray is hydration/100 × this.
  var DIAL_CIRCUMFERENCE = 239;

  var HYDRATION_MIN = 50;
  var HYDRATION_MAX = 100;
  var COUNT_MIN = 1;
  var COUNT_MAX = 24;
  var SIZE_MIN = 50;
  var SIZE_MAX = 2000;

  // Each bread's recipe as baker's percentages of the flour. Water is the
  // hydration percentage. The starter is its own ingredient, not counted in
  // the flour and water.
  var BREADS = {
    sourdough: {
      name: 'Sourdough',
      one: 'sourdough loaf', many: 'sourdough loaves',
      hydration: 72, size: 750, bagels: false,
      ingredients: [
        { name: 'Bread flour', pct: 100, flour: true },
        { name: 'Water', pct: 0, water: true },
        { name: 'Salt', pct: 2 },
        { name: 'Starter', pct: 20 },
      ],
      rise: { time: '4 to 6 hr', note: 'at 24°C, then 1 to 2 hr shaped' },
      bake: { temp: '230°C', time: '45 min', note: 'steam first 20' },
    },
    bagels: {
      name: 'Bagels',
      one: 'bagel', many: 'bagels',
      hydration: 58, size: 110, bagels: true,
      ingredients: [
        { name: 'Bread flour', pct: 100, flour: true },
        { name: 'Water', pct: 0, water: true },
        { name: 'Salt', pct: 2 },
        { name: 'Instant yeast', pct: 1 },
        { name: 'Malt syrup', pct: 3 },
      ],
      rise: { time: '1 hr', note: 'at 24°C, then 20 min shaped' },
      bake: { temp: '220°C', time: '20 min', note: 'boil 1 min a side first' },
    },
    'sourdough-bagels': {
      name: 'Sourdough bagels',
      one: 'sourdough bagel', many: 'sourdough bagels',
      hydration: 58, size: 110, bagels: true,
      ingredients: [
        { name: 'Bread flour', pct: 100, flour: true },
        { name: 'Water', pct: 0, water: true },
        { name: 'Salt', pct: 2 },
        { name: 'Starter', pct: 20 },
        { name: 'Malt syrup', pct: 3 },
      ],
      rise: { time: '4 to 5 hr', note: 'at 24°C, then overnight in the fridge' },
      bake: { temp: '220°C', time: '20 min', note: 'boil 1 min a side first' },
    },
    rye: {
      name: 'Rye',
      one: 'rye loaf', many: 'rye loaves',
      hydration: 75, size: 750, bagels: false,
      ingredients: [
        { name: 'Rye flour', pct: 50, flour: true },
        { name: 'Bread flour', pct: 50, flour: true },
        { name: 'Water', pct: 0, water: true },
        { name: 'Salt', pct: 2 },
        { name: 'Starter', pct: 20 },
      ],
      rise: { time: '3 to 4 hr', note: 'at 24°C, then 1 hr shaped' },
      bake: { temp: '230°C', time: '50 min', note: 'steam first 15' },
    },
    'sandwich-loaf': {
      name: 'Sandwich loaf',
      one: 'sandwich loaf', many: 'sandwich loaves',
      hydration: 65, size: 900, bagels: false,
      ingredients: [
        { name: 'Bread flour', pct: 100, flour: true },
        { name: 'Water', pct: 0, water: true },
        { name: 'Salt', pct: 2 },
        { name: 'Instant yeast', pct: 1.5 },
        { name: 'Sugar', pct: 5 },
        { name: 'Butter', pct: 8 },
      ],
      rise: { time: '1 to 1½ hr', note: 'at 24°C, then 1 hr in the pan' },
      bake: { temp: '190°C', time: '35 min', note: '' },
    },
  };

  var state = {
    breadId: 'sourdough',
    hydration: 72,
    count: 2,
    size: 750, // grams, per loaf (or per bagel)
    baked: false, // the recipe shows only after Bake It, then updates live
  };

  // ── The maths ───────────────────────────────────────────────────────────

  // Total dough T = count × size. Flour F = T / (sum of all percentages /
  // 100); each ingredient is F × pct / 100. Rows are rounded to whole grams
  // (one decimal under 10 g) and the remainder goes on the largest flour row,
  // so the rows add up to T exactly.
  function compute(bread) {
    var total = state.count * state.size;
    var pctSum = 0;
    bread.ingredients.forEach(function (ing) {
      pctSum += ing.water ? state.hydration : ing.pct;
    });
    var flour = total / (pctSum / 100);

    var rows = bread.ingredients.map(function (ing) {
      var pct = ing.water ? state.hydration : ing.pct;
      var grams = flour * pct / 100;
      grams = grams < 10 ? Math.round(grams * 10) / 10 : Math.round(grams);
      return { name: ing.name, pct: pct, grams: grams, flour: !!ing.flour };
    });

    var remainder = total - rows.reduce(function (sum, row) { return sum + row.grams; }, 0);
    if (remainder !== 0) {
      var biggest = null;
      rows.forEach(function (row) {
        if (row.flour && (!biggest || row.grams > biggest.grams)) biggest = row;
      });
      if (biggest) biggest.grams = Math.round((biggest.grams + remainder) * 10) / 10;
    }
    return { rows: rows, total: total };
  }

  // ── Formatting ──────────────────────────────────────────────────────────

  function thousands(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  // Grams: whole, or one decimal when the value is small ("5.4 g" of yeast)
  // or carries the rounding remainder ("536.6 g"), so the rows always add
  // up to the total dough weight exactly.
  function fmtGrams(g) {
    if (g < 10 || g !== Math.round(g)) {
      var s = g.toFixed(1);
      if (s.endsWith('.0')) s = s.slice(0, -2);
      return s + ' g';
    }
    return thousands(g) + ' g';
  }

  function fmtPct(p) {
    return String(p) + '%';
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  function $(id) { return document.getElementById(id); }

  function render() {
    var bread = BREADS[state.breadId];

    // The bread chips: outlined with a check when selected, so Bake It stays
    // the only filled control.
    Array.prototype.forEach.call(document.querySelectorAll('#chips .chip'), function (chip) {
      var on = chip.getAttribute('data-bread') === state.breadId;
      chip.classList[on ? 'add' : 'remove']('on');
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    // Labels: the bagel breads count bagels, not loaves.
    $('label-count').textContent = bread.bagels ? 'Bagels' : 'Loaves';
    $('label-size').textContent = bread.bagels ? 'Size per bagel' : 'Size per loaf';
    $('count-minus').setAttribute('aria-label', bread.bagels ? 'Fewer bagels' : 'Fewer loaves');
    $('count-plus').setAttribute('aria-label', bread.bagels ? 'More bagels' : 'More loaves');
    $('size-minus').setAttribute('aria-label', bread.bagels ? 'Smaller bagels' : 'Smaller loaves');
    $('size-plus').setAttribute('aria-label', bread.bagels ? 'Bigger bagels' : 'Bigger loaves');

    // The baker's percentage dial: a ring that fills to the hydration.
    $('dial-fill').setAttribute('stroke-dasharray',
      Math.round(state.hydration / 100 * DIAL_CIRCUMFERENCE) + ' ' + DIAL_CIRCUMFERENCE);
    $('dial-num').textContent = state.hydration + '%';
    $('hydration-big').textContent = state.hydration + '% water';
    $('hydration-words').textContent =
      thousands(state.hydration * 10) + ' g water for every 1,000 g flour. Higher is wetter and more open.';

    // The hydration slider: the fill and the thumb both come from the same
    // value, (hydration − 50) / 50 of the range, so the fill always ends at
    // the thumb's centre.
    var range = $('hydration');
    range.value = state.hydration;
    range.style.setProperty('--fill',
      (state.hydration - HYDRATION_MIN) / (HYDRATION_MAX - HYDRATION_MIN) * 100 + '%');

    // Loaves (or bagels) and size, with the steppers disabled at the ends.
    $('count').textContent = String(state.count);
    $('size').textContent = thousands(state.size) + ' g';
    $('count-minus').disabled = state.count <= COUNT_MIN;
    $('count-plus').disabled = state.count >= COUNT_MAX;
    $('size-minus').disabled = state.size <= SIZE_MIN;
    $('size-plus').disabled = state.size >= SIZE_MAX;

    if (state.baked) renderRecipe(bread);
  }

  function renderRecipe(bread) {
    var recipe = compute(bread);

    $('recipe-title').textContent = 'Your recipe: ' + state.count + ' ' +
      (state.count === 1 ? bread.one : bread.many);

    var list = $('recipe-list');
    list.textContent = '';
    recipe.rows.forEach(function (row) {
      var li = document.createElement('li');
      li.className = 'list-row';
      var name = document.createElement('span');
      name.className = 'n';
      name.textContent = row.name;
      var grams = document.createElement('b');
      grams.textContent = fmtGrams(row.grams);
      var pct = document.createElement('span');
      pct.className = 'pct';
      pct.textContent = fmtPct(row.pct);
      li.appendChild(name);
      li.appendChild(grams);
      li.appendChild(pct);
      list.appendChild(li);
    });

    $('recipe-total').textContent = 'Total dough ' + thousands(recipe.total) +
      " g. Percentages are of the flour, the baker's way.";

    $('rise-time').textContent = bread.rise.time;
    $('rise-note').textContent = bread.rise.note;
    $('bake-temp').textContent = bread.bake.temp;
    $('bake-time').textContent = bread.bake.note
      ? bread.bake.time + ', ' + bread.bake.note
      : bread.bake.time;

    $('recipe').hidden = false;
    $('recipe-empty').hidden = true;
  }

  // ── Events ──────────────────────────────────────────────────────────────

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  // Size moves 10 g at a time under 200 g and 50 g above.
  function sizeStep(value, direction) {
    if (direction < 0) return value <= 200 ? 10 : 50;
    return value < 200 ? 10 : 50;
  }

  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('#chips .chip'), function (chip) {
      chip.addEventListener('click', function () {
        var bread = BREADS[chip.getAttribute('data-bread')];
        if (!bread) return;
        // A new bread resets hydration and size to its usual values but
        // keeps the loaf count.
        state.breadId = chip.getAttribute('data-bread');
        state.hydration = bread.hydration;
        state.size = bread.size;
        render();
      });
    });

    $('hydration').addEventListener('input', function () {
      state.hydration = clamp(parseInt(this.value, 10) || HYDRATION_MIN, HYDRATION_MIN, HYDRATION_MAX);
      render();
    });
    $('hydration-minus').addEventListener('click', function () {
      state.hydration = clamp(state.hydration - 1, HYDRATION_MIN, HYDRATION_MAX);
      render();
    });
    $('hydration-plus').addEventListener('click', function () {
      state.hydration = clamp(state.hydration + 1, HYDRATION_MIN, HYDRATION_MAX);
      render();
    });

    $('count-minus').addEventListener('click', function () {
      state.count = clamp(state.count - 1, COUNT_MIN, COUNT_MAX);
      render();
    });
    $('count-plus').addEventListener('click', function () {
      state.count = clamp(state.count + 1, COUNT_MIN, COUNT_MAX);
      render();
    });

    $('size-minus').addEventListener('click', function () {
      state.size = clamp(state.size - sizeStep(state.size, -1), SIZE_MIN, SIZE_MAX);
      render();
    });
    $('size-plus').addEventListener('click', function () {
      state.size = clamp(state.size + sizeStep(state.size, 1), SIZE_MIN, SIZE_MAX);
      render();
    });

    $('bake').addEventListener('click', function () {
      state.baked = true;
      render();
      var recipe = $('recipe');
      var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      recipe.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    });
  }

  // ── Start ───────────────────────────────────────────────────────────────

  // The staging preview, ?demo=1: Sourdough at 72%, two 750 g loaves, the
  // recipe already worked out. A pure UI state: nothing is stored, so there
  // is nothing to gate on USERNODE_ENV.
  function demoRequested() {
    try {
      return new URLSearchParams(window.location.search).get('demo') === '1';
    } catch (err) {
      return false;
    }
  }

  wire();
  if (demoRequested()) {
    state.baked = true;
    $('demo-note').hidden = false;
  }
  render();
})();