/* Bread Bot: pick a bread, set the dough, tap Calculate, and read the
   grams, the baker's percentages and the rise and bake settings.
   Everything runs here in the page; nothing is stored anywhere. */

// One entry per bread, in the order the chips show them. Ingredient
// percentages are baker's percentages of the flour: the flour rows carry
// their share of the 100% (rye splits 70/30), and the row whose pct is
// 'hydration' is the water, whose percent is the hydration you set.
// bakeBase/bakeStep: the bake time grows or shrinks by bakeStep minutes
// for every bakePer grams a loaf is above or below the usual size, never
// below half the base time.
const RECIPES = {
  sourdough: {
    name: 'sourdough',
    hydration: 75, hydrationMin: 60, hydrationMax: 90,
    count: 2, countMin: 1, countMax: 24,
    size: 800, sizeMin: 300, sizeMax: 2000, sizeStep: 50,
    unitOne: 'loaf', unitOther: 'loaves',
    ingredients: [
      { name: 'Bread flour', short: 'Flour', pct: 100, flour: true },
      { name: 'Water', short: 'Water', pct: 'hydration' },
      { name: 'Sourdough starter', short: 'Starter', pct: 15 },
      { name: 'Salt', short: 'Salt', pct: 2 },
    ],
    riseLabel: 'Bulk rise', rise: '5 h',
    bakeTemp: '240 °C', bakeBase: 45, bakePer: 200, bakeStep: 5,
    timing: 'Bulk rise at 24 °C with folds every 45 minutes. Shape, then proof 12 hours in the fridge. Bake covered for 25 minutes, then uncovered for 20.',
  },
  bagels: {
    name: 'bagels',
    hydration: 58, hydrationMin: 50, hydrationMax: 65,
    count: 8, countMin: 1, countMax: 24,
    size: 110, sizeMin: 60, sizeMax: 200, sizeStep: 10,
    unitOne: 'bagel', unitOther: 'bagels',
    ingredients: [
      { name: 'Bread flour', short: 'Flour', pct: 100, flour: true },
      { name: 'Water', short: 'Water', pct: 'hydration' },
      { name: 'Instant yeast', short: 'Yeast', pct: 1 },
      { name: 'Salt', short: 'Salt', pct: 2 },
      { name: 'Sugar', short: 'Sugar', pct: 3 },
    ],
    riseLabel: 'Rise', rise: '1 h',
    boil: '1 min a side',
    bakeTemp: '220 °C', bakeBase: 20, bakePer: 20, bakeStep: 2,
    timing: 'Rise 1 hour, then overnight in the fridge. Boil 1 minute a side, then bake until glossy and deep brown.',
  },
  'sourdough-bagels': {
    name: 'sourdough bagels',
    hydration: 58, hydrationMin: 50, hydrationMax: 65,
    count: 8, countMin: 1, countMax: 24,
    size: 110, sizeMin: 60, sizeMax: 200, sizeStep: 10,
    unitOne: 'bagel', unitOther: 'bagels',
    ingredients: [
      { name: 'Bread flour', short: 'Flour', pct: 100, flour: true },
      { name: 'Water', short: 'Water', pct: 'hydration' },
      { name: 'Sourdough starter', short: 'Starter', pct: 20 },
      { name: 'Salt', short: 'Salt', pct: 2 },
      { name: 'Sugar', short: 'Sugar', pct: 3 },
    ],
    riseLabel: 'Bulk rise', rise: '6 h',
    boil: '1 min a side',
    bakeTemp: '220 °C', bakeBase: 22, bakePer: 20, bakeStep: 2,
    timing: 'Bulk rise 6 hours, then overnight in the fridge. Boil 1 minute a side, then bake until glossy and deep brown.',
  },
  rye: {
    name: 'rye',
    hydration: 80, hydrationMin: 70, hydrationMax: 100,
    count: 1, countMin: 1, countMax: 24,
    size: 900, sizeMin: 300, sizeMax: 2000, sizeStep: 50,
    unitOne: 'loaf', unitOther: 'loaves',
    ingredients: [
      { name: 'Rye flour', short: 'Rye', pct: 70, flour: true },
      { name: 'Bread flour', short: 'Bread', pct: 30, flour: true },
      { name: 'Water', short: 'Water', pct: 'hydration' },
      { name: 'Sourdough starter', short: 'Starter', pct: 20 },
      { name: 'Salt', short: 'Salt', pct: 2 },
    ],
    riseLabel: 'Bulk rise', rise: '3 h',
    bakeTemp: '230 °C', bakeBase: 55, bakePer: 200, bakeStep: 5,
    timing: 'Bulk rise 3 hours, then shape and proof 1 hour in the tin. Bake it right through: rye stays dense and keeps for days.',
  },
  sandwich: {
    name: 'sandwich loaf',
    hydration: 65, hydrationMin: 55, hydrationMax: 75,
    count: 1, countMin: 1, countMax: 24,
    size: 900, sizeMin: 300, sizeMax: 2000, sizeStep: 50,
    unitOne: 'loaf', unitOther: 'loaves',
    ingredients: [
      { name: 'Bread flour', short: 'Flour', pct: 100, flour: true },
      { name: 'Water', short: 'Water', pct: 'hydration' },
      { name: 'Instant yeast', short: 'Yeast', pct: 1.5 },
      { name: 'Salt', short: 'Salt', pct: 2 },
      { name: 'Sugar', short: 'Sugar', pct: 4 },
      { name: 'Butter', short: 'Butter', pct: 6 },
    ],
    riseLabel: 'Rise', rise: '1 h 30 min',
    bakeTemp: '190 °C', bakeBase: 35, bakePer: 200, bakeStep: 5,
    timing: 'Rise 1 hour 30 minutes, then shape and proof 1 hour in the tin. Bake until golden and the loaf sounds hollow.',
  },
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Grams: whole numbers, one decimal under 10 g.
function fmtGrams(grams) {
  if (grams < 10) return grams.toFixed(1) + ' g';
  return Math.round(grams).toLocaleString('en-US') + ' g';
}

function fmtMinutes(minutes) {
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? hours + ' h ' + rest + ' min' : hours + ' h';
}

// The one place the numbers come from: pure, and happy with anything the
// clamped steppers can produce. Throws when the recipe itself is missing.
function calculate(input) {
  const recipe = RECIPES[input.bread];
  if (!recipe) throw new Error('no recipe for ' + input.bread);

  const hydration = clamp(input.hydration, recipe.hydrationMin, recipe.hydrationMax);
  const count = clamp(input.count, recipe.countMin, recipe.countMax);
  const size = clamp(input.size, recipe.sizeMin, recipe.sizeMax);

  const pctSum = recipe.ingredients.reduce((sum, ing) => {
    const pct = ing.pct === 'hydration' ? hydration : ing.pct;
    return sum + pct;
  }, 0);
  const flour = count * size / (pctSum / 100);

  const ingredients = recipe.ingredients.map((ing) => {
    const pct = ing.pct === 'hydration' ? hydration : ing.pct;
    return { name: ing.name, short: ing.short, pct, grams: flour * pct / 100 };
  });

  const sizeDelta = Math.round((size - recipe.size) / recipe.bakePer);
  const bakeMinutes = Math.max(
    recipe.bakeBase + sizeDelta * recipe.bakeStep,
    Math.ceil(recipe.bakeBase / 2)
  );

  return {
    ingredients,
    totalDough: count * size,
    tiles: [
      recipe.boil
        ? { small: 'Boil', strong: recipe.boil }
        : { small: recipe.riseLabel, strong: recipe.rise },
      { small: 'Bake at', strong: recipe.bakeTemp },
      { small: 'Bake for', strong: fmtMinutes(bakeMinutes) },
    ],
    timing: recipe.timing,
  };
}

// ── The page ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtNumber(value) {
  return value.toLocaleString('en-US');
}

const state = {
  bread: 'sourdough',
  hydration: RECIPES.sourdough.hydration,
  count: RECIPES.sourdough.count,
  size: RECIPES.sourdough.size,
  calculated: false, // a Calculate has happened, so changes make results stale
};

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// Render every number on the page, set the row labels to this bread's
// unit words, and mark the limits on the steppers.
function renderSettings() {
  const recipe = RECIPES[state.bread];
  $('hydration-val').textContent = state.hydration + '%';
  $('count-val').textContent = String(state.count);
  $('size-val').textContent = state.size + ' g';

  $('count-label').textContent = capitalize(recipe.unitOther);
  $('size-label').textContent = 'Size of each ' + recipe.unitOne;
  $('count-minus').setAttribute('aria-label', 'Fewer ' + recipe.unitOther);
  $('count-plus').setAttribute('aria-label', 'More ' + recipe.unitOther);
  $('size-minus').setAttribute('aria-label', 'Smaller ' + recipe.unitOne);
  $('size-plus').setAttribute('aria-label', 'Bigger ' + recipe.unitOne);

  $('hydration-minus').disabled = state.hydration <= recipe.hydrationMin;
  $('hydration-plus').disabled = state.hydration >= recipe.hydrationMax;
  $('count-minus').disabled = state.count <= recipe.countMin;
  $('count-plus').disabled = state.count >= recipe.countMax;
  $('size-minus').disabled = state.size <= recipe.sizeMin;
  $('size-plus').disabled = state.size >= recipe.sizeMax;
}

function renderResults(result) {
  $('ingredients-label').textContent =
    'Ingredients for ' + state.count + ' ' + recipeNameUnit() + ', ' +
    fmtNumber(result.totalDough) + ' g of dough';

  const list = $('ingredients');
  list.replaceChildren();
  for (const ing of result.ingredients) {
    const row = el('li', 'list-row');
    row.append(el('span', 'grow', ing.name), el('span', 'val', fmtGrams(ing.grams)));
    list.append(row);
  }

  const notebook = $('notebook');
  notebook.replaceChildren();
  for (const ing of result.ingredients) {
    const row = el('div', 'nrow');
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.width = Math.min(ing.pct, 100) + '%';
    bar.append(fill);
    row.append(el('b', null, ing.short), bar, el('span', 'pct', ing.pct + '%'));
    notebook.append(row);
  }

  const tiles = $('tiles');
  tiles.replaceChildren();
  for (const tile of result.tiles) {
    const box = el('div', 'tile');
    box.append(el('small', null, tile.small), el('strong', null, tile.strong));
    tiles.append(box);
  }

  $('timing-note').textContent = result.timing;
}

// "2 sourdough loaves", "8 bagels", "1 rye loaf": the unit word is only
// added when the bread's name does not already say it.
function recipeNameUnit() {
  const recipe = RECIPES[state.bread];
  const unit = state.count === 1 ? recipe.unitOne : recipe.unitOther;
  return recipe.name.endsWith(unit) ? recipe.name : recipe.name + ' ' + unit;
}

function showSection(which) {
  $('results-empty').hidden = which !== 'empty';
  $('results-error').hidden = which !== 'error';
  $('results').hidden = which !== 'results';
}

function runCalculate() {
  $('stale').hidden = true;
  try {
    renderResults(calculate(state));
    showSection('results');
    state.calculated = true;
  } catch (err) {
    showSection('error');
  }
}

function markStale() {
  if (state.calculated) $('stale').hidden = false;
}

// ── Wiring ───────────────────────────────────────────────────────────────

for (const chip of $('chips').querySelectorAll('[data-bread]')) {
  chip.addEventListener('click', () => {
    const bread = chip.dataset.bread;
    if (bread === state.bread) return;
    state.bread = bread;
    // A fresh bread starts from its usual numbers.
    const recipe = RECIPES[bread];
    state.hydration = recipe.hydration;
    state.count = recipe.count;
    state.size = recipe.size;
    for (const other of $('chips').querySelectorAll('[data-bread]')) {
      other.classList.toggle('on', other === chip);
      other.setAttribute('aria-pressed', String(other === chip));
    }
    renderSettings();
    markStale();
  });
}

// One stepper handler per button: the step and the limits belong to the
// bread in play (hydration 1%, size 50 g for loaves and 10 g for bagels),
// so they are read at click time.
function stepper(id, key, direction) {
  $(id).addEventListener('click', () => {
    const recipe = RECIPES[state.bread];
    const step = {
      hydration: 1,
      count: 1,
      size: recipe.sizeStep,
    }[key];
    const limits = {
      hydration: [recipe.hydrationMin, recipe.hydrationMax],
      count: [recipe.countMin, recipe.countMax],
      size: [recipe.sizeMin, recipe.sizeMax],
    }[key];
    state[key] = clamp(state[key] + direction * step, limits[0], limits[1]);
    renderSettings();
    markStale();
  });
}

stepper('hydration-minus', 'hydration', -1);
stepper('hydration-plus', 'hydration', 1);
stepper('count-minus', 'count', -1);
stepper('count-plus', 'count', 1);
stepper('size-minus', 'size', -1);
stepper('size-plus', 'size', 1);

$('calculate').addEventListener('click', runCalculate);
$('retry').addEventListener('click', runCalculate);

renderSettings();

// The staging demo (?demo=1): the example recipe, already calculated,
// exactly as the spec drew it. It writes nothing.
if (new URLSearchParams(location.search).has('demo')) {
  $('demo-line').hidden = false;
  runCalculate();
}
