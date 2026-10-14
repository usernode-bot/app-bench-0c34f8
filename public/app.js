/* Bread Bot — the recipe calculator. Pure client-side: no tables, no API.
 *
 * Every class name below is a whole literal (Tailwind compiles this file's
 * text); the screen's own look lives in public/screens.css.
 */
(function () {
  'use strict';

  // Water carries the hydration percentage; 'h' stands in for it here.
  var BREADS = {
    'sourdough': {
      name: 'Sourdough', nounOne: 'sourdough loaf', nounMany: 'sourdough loaves',
      hydration: 72, size: 750,
      items: [['Bread flour', 100], ['Water', 'h'], ['Salt', 2], ['Starter', 20]],
      rise: '4 to 6 hr', riseNote: 'at 24°C, then 1 to 2 hr shaped',
      bake: '230°C', bakeNote: '45 min, steam first 20',
    },
    'bagels': {
      name: 'Bagels', nounOne: 'bagel', nounMany: 'bagels',
      hydration: 58, size: 110, countLabel: 'Bagels', sizeLabel: 'Size per bagel',
      items: [['Bread flour', 100], ['Water', 'h'], ['Salt', 2], ['Instant yeast', 1], ['Malt syrup', 3]],
      rise: '1 hr', riseNote: 'at 24°C, then 20 min shaped',
      bake: '220°C', bakeNote: '20 min, boil 1 min a side first',
    },
    'sourdough-bagels': {
      name: 'Sourdough bagels', nounOne: 'sourdough bagel', nounMany: 'sourdough bagels',
      hydration: 58, size: 110, countLabel: 'Bagels', sizeLabel: 'Size per bagel',
      items: [['Bread flour', 100], ['Water', 'h'], ['Salt', 2], ['Starter', 20], ['Malt syrup', 3]],
      rise: '4 to 5 hr', riseNote: 'at 24°C, then overnight in the fridge',
      bake: '220°C', bakeNote: '20 min, boil 1 min a side first',
    },
    'rye': {
      name: 'Rye', nounOne: 'rye loaf', nounMany: 'rye loaves',
      hydration: 75, size: 750,
      items: [['Rye flour', 50], ['Bread flour', 50], ['Water', 'h'], ['Salt', 2], ['Starter', 20]],
      rise: '3 to 4 hr', riseNote: 'at 24°C, then 1 hr shaped',
      bake: '230°C', bakeNote: '50 min, steam first 15',
    },
    'sandwich-loaf': {
      name: 'Sandwich loaf', nounOne: 'sandwich loaf', nounMany: 'sandwich loaves',
      hydration: 65, size: 900,
      items: [['Bread flour', 100], ['Water', 'h'], ['Salt', 2], ['Instant yeast', 1.5], ['Sugar', 5], ['Butter', 8]],
      rise: '1 to 1½ hr', riseNote: 'at 24°C, then 1 hr in the pan',
      bake: '190°C', bakeNote: '35 min',
    },
  };

  //   keeps a number and its unit on one line: the rise and bake cards
  // are narrow, and '1 to 2 / hr shaped' breaks an orphaned 'hr' onto its
  // own line.
  var COUNT_MIN = 1, COUNT_MAX = 24;
  var SIZE_MIN = 50, SIZE_MAX = 2000, SIZE_SMALL = 200, SIZE_SMALL_STEP = 10, SIZE_BIG_STEP = 50;
  var DIAL_CIRCUMFERENCE = 239; // r = 38

  var state = {
    bread: 'sourdough',
    hydration: 72,
    count: 2,
    size: 750,
    baked: false,
  };

  function $(id) { return document.getElementById(id); }

  // Grams, in hundredths so the rows add up to the total dough exactly.
  // Under 10 g shows one decimal, everything else whole grams; the rounding
  // remainder lands on the largest flour row.
  function calc() {
    var bread = BREADS[state.bread];
    var total = state.count * state.size;
    var pcts = bread.items.map(function (it) { return it[1] === 'h' ? state.hydration : it[1]; });
    var sumP = pcts.reduce(function (a, b) { return a + b; }, 0);
    var H = 100 * total; // hundredths of a gram
    var flourIdx = -1, flourPct = -1;
    var rows = bread.items.map(function (it, i) {
      var h = Math.round(H * pcts[i] / sumP);
      var shown = h < 1000 ? Math.round(h / 10) * 10 : Math.round(h / 100) * 100;
      var name = it[0];
      if (name.slice(-5).toLowerCase() === 'flour' && pcts[i] > flourPct) {
        flourPct = pcts[i]; flourIdx = i;
      }
      return { name: name, pct: pcts[i], hundredths: shown };
    });
    var remainder = H - rows.reduce(function (a, r) { return a + r.hundredths; }, 0);
    if (remainder !== 0 && flourIdx >= 0) rows[flourIdx].hundredths += remainder;
    return { bread: bread, total: total, rows: rows };
  }

  function fmtH(h) {
    if (h < 1000) return (h / 100).toFixed(1);
    return Math.round(h / 100).toLocaleString('en-US');
  }

  function fmtG(n) { return n.toLocaleString('en-US'); }

  function renderInputs() {
    var bread = BREADS[state.bread];
    var h = state.hydration;
    $('dial-fill').setAttribute('stroke-dasharray', Math.round(h / 100 * DIAL_CIRCUMFERENCE) + ' ' + DIAL_CIRCUMFERENCE);
    $('dial-num').textContent = h + '%';
    $('h-big').textContent = h + '% water';
    $('h-words').textContent = fmtG(h * 10) + ' g water for every 1,000 g flour. Higher is wetter and more open.';
    var slider = $('hydration');
    slider.value = h;
    $('h-minus').disabled = h <= 50;
    $('h-plus').disabled = h >= 100;
    $('count-label').textContent = bread.countLabel || 'Loaves';
    $('size-label').textContent = bread.sizeLabel || 'Size per loaf';
    $('count-val').textContent = state.count;
    $('size-val').textContent = fmtG(state.size) + ' g';
    $('count-minus').disabled = state.count <= COUNT_MIN;
    $('count-plus').disabled = state.count >= COUNT_MAX;
    $('size-minus').disabled = state.size <= SIZE_MIN;
    $('size-plus').disabled = state.size >= SIZE_MAX;
    document.querySelectorAll('#chips .chip').forEach(function (chip) {
      var on = chip.getAttribute('data-bread') === state.bread;
      chip.classList.toggle('on', on);
      chip.setAttribute('aria-pressed', String(on));
      chip.querySelector('svg').toggleAttribute('hidden', !on);
    });
  }

  function renderRecipe() {
    var c = calc();
    var bread = c.bread;
    $('recipe-title').textContent = 'Your recipe: ' + state.count + ' ' +
      (state.count === 1 ? bread.nounOne : bread.nounMany);
    $('recipe-rows').innerHTML = c.rows.map(function (r) {
      return '<li class="list-row"><span class="n">' + r.name + '</span><b>' +
        fmtH(r.hundredths) + ' g</b><span class="pct">' + r.pct + '%</span></li>';
    }).join('');
    $('recipe-total').textContent = 'Total dough ' + fmtG(c.total) +
      ' g. Percentages are of the flour, the baker’s way.';
    $('rise-val').textContent = bread.rise;
    $('rise-note').textContent = bread.riseNote;
    $('bake-val').textContent = bread.bake;
    $('bake-note').textContent = bread.bakeNote;
  }

  function render() {
    renderInputs();
    if (state.baked) {
      $('recipe-empty').hidden = true;
      $('recipe').hidden = false;
      renderRecipe();
    }
  }

  function pickBread(key) {
    var bread = BREADS[key];
    if (!bread) return;
    state.bread = key;
    state.hydration = bread.hydration;
    state.size = bread.size;
    render();
  }

  function stepSize(dir) {
    var step = state.size < SIZE_SMALL ? SIZE_SMALL_STEP : SIZE_BIG_STEP;
    state.size = Math.min(SIZE_MAX, Math.max(SIZE_MIN, state.size + dir * step));
    render();
  }

  function wire() {
    document.querySelectorAll('#chips .chip').forEach(function (chip) {
      chip.addEventListener('click', function () { pickBread(chip.getAttribute('data-bread')); });
    });
    $('hydration').addEventListener('input', function () {
      state.hydration = Number(this.value);
      render();
    });
    $('h-minus').addEventListener('click', function () {
      state.hydration = Math.max(50, state.hydration - 1); render();
    });
    $('h-plus').addEventListener('click', function () {
      state.hydration = Math.min(100, state.hydration + 1); render();
    });
    $('count-minus').addEventListener('click', function () {
      state.count = Math.max(COUNT_MIN, state.count - 1); render();
    });
    $('count-plus').addEventListener('click', function () {
      state.count = Math.min(COUNT_MAX, state.count + 1); render();
    });
    $('size-minus').addEventListener('click', function () { stepSize(-1); });
    $('size-plus').addEventListener('click', function () { stepSize(1); });
    $('bake').addEventListener('click', function () {
      state.baked = true;
      render();
      $('recipe').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  // The staging demo (?demo=1): a sample bake, nothing stored.
  function demo() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('demo') !== '1') return false;
    state.bread = 'sourdough';
    state.hydration = 72;
    state.count = 2;
    state.size = 750;
    state.baked = true;
    $('demo-note').hidden = false;
    return true;
  }

  wire();
  demo();
  render();
})();