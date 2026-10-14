// app.js: wires the drawn calculator screen (screen 1 in public/index.html)
// to recipes.js. Everything is client-side: pick a bread, set hydration,
// count and size, tap Calculate recipe, read the recipe. Nothing is stored.

import { h } from '/kit/dom.js';
import { rowsFrom, fillIn } from '/kit/fill.js';
import { BREADS, LIMITS, calculate, doughDescription } from '/recipes.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => n.toLocaleString('en-US');

// The drawn track (M40 150A82 82 0 1 1 180 150): centre, radius, start
// angle and clockwise sweep of the gauge, which opens at the bottom. The
// radius is inset 8 px (half the stroke) from the 220×180 viewBox edge, so
// the stroke never clips.
const ARC = { cx: 110, cy: 107.3, r: 82, start: 148.62, sweep: 242.76 };

function arcPath(fraction) {
  const angle = (ARC.start + ARC.sweep * fraction) * (Math.PI / 180);
  const x = ARC.cx + ARC.r * Math.cos(angle);
  const y = ARC.cy + ARC.r * Math.sin(angle);
  const large = ARC.sweep * fraction > 180 ? 1 : 0;
  return `M40 150A82 82 0 ${large} 1 ${x.toFixed(1)} ${y.toFixed(1)}`;
}

// Line icons for the step kinds, in the drawn style (stroke, 1.8, round).
const STEP_ICONS = {
  rise: '<path d="M4 18h16M6 18a6 5 0 0 1 12 0"/><path d="M12 4v4M9 6l3-2 3 2"/>',
  proof: '<rect x="5" y="10" width="14" height="8" rx="2"/><path d="M8 10a4 4 0 0 1 8 0"/>',
  fridge: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 10h14M8 6.5h2"/>',
  boil: '<path d="M4 12h16v2a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M9 8c0-1 1-1.5 1-2.5M14 8c0-1 1-1.5 1-2.5"/>',
  bake: '<path d="M12 3v11"/><circle cx="12" cy="17" r="3.5"/><path d="M15 6h3M15 10h3"/>',
};

function stepIcon(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.innerHTML = STEP_ICONS[kind] || STEP_ICONS.bake; // static strings, no data
  return svg;
}

// "915 " + <small>g</small>, as the drawn rows show it.
function gramsFrag(g) {
  const frag = document.createDocumentFragment();
  frag.append(document.createTextNode(`${fmt(g)} `));
  frag.append(h('small', null, 'g'));
  return frag;
}

// A step's right-hand column: "250 °C<br>20 min" for bakes, else the time.
function qtyFrag(step) {
  if (!step.temp) return document.createTextNode(step.time);
  const frag = document.createDocumentFragment();
  frag.append(`${step.temp} °C`, document.createElement('br'), step.time);
  return frag;
}

const state = {
  type: 'sourdough',
  hydration: 75,
  count: 1,
  weight: 900,
  hasRecipe: false,
};

const els = {};
let ingRow, totRow, stepRow;

function weightValid() {
  const w = Number(els.weight.value);
  return Number.isFinite(w) && w >= LIMITS.weight.min && w <= LIMITS.weight.max;
}

function syncWeightValidity() {
  const ok = weightValid();
  els.weightMsg.hidden = ok;
  els.weight.setAttribute('aria-invalid', ok ? 'false' : 'true');
}

function syncDial() {
  const span = LIMITS.hydration.max - LIMITS.hydration.min;
  const fraction = (state.hydration - LIMITS.hydration.min) / span;
  els.dialValue.replaceChildren(
    document.createTextNode(String(state.hydration)),
    h('small', null, '%'),
  );
  els.dialDesc.textContent = doughDescription(state.hydration);
  els.dialArc.setAttribute('d', arcPath(fraction));
  const pct = fraction * 100;
  els.rngFill.style.width = `${pct}%`;
  els.rngThumb.style.left = `calc(${pct}% - 14px)`;
}

function syncTiles() {
  for (const tile of els.tiles) {
    const on = tile.dataset.bread === state.type;
    tile.classList.toggle('on', on);
    tile.setAttribute('aria-checked', String(on));
  }
}

function syncBatch() {
  const bread = BREADS[state.type];
  els.countLabel.textContent = bread.countLabel;
  els.perLabel.textContent = bread.perLabel;
  els.countValue.textContent = String(state.count);
  els.weight.value = String(state.weight);
}

// The recipe fades and says so once the settings no longer match it.
function markStale() {
  if (!state.hasRecipe) return;
  els.results.classList.add('opacity-40');
  els.recipeStale.hidden = false;
}

function freshRecipe() {
  els.results.classList.remove('opacity-40');
  els.recipeStale.hidden = true;
}

function renderRecipe(recipe) {
  state.hasRecipe = true;
  freshRecipe();
  els.recipeEmpty.hidden = true;
  els.recipeOut.hidden = false;
  const bread = recipe.bread;
  els.recipeTitle.textContent = `${bread.label}, ${fmt(recipe.count)} ${recipe.count === 1 ? bread.one : bread.many} of ${fmt(recipe.weight)} g`;
  els.ingredients.replaceChildren(
    ...recipe.rows.map((row) => fillIn(ingRow(), {
      '.grow': row.name,
      '.pct': `${row.pct}%`,
      '.gr': gramsFrag(row.grams),
    })),
    fillIn(totRow(), { '.gr': gramsFrag(recipe.total) }),
  );
  els.steps.replaceChildren(...recipe.steps.map((step) => fillIn(stepRow(), {
    '.ic': stepIcon(step.kind),
    '.k': step.name,
    '.d': step.desc,
    '.q': qtyFrag(step),
  })));
}

function selectType(type) {
  const bread = BREADS[type];
  state.type = type;
  state.hydration = bread.hydration;
  state.count = bread.count;
  state.weight = bread.weight;
  syncControls();
  markStale();
}

function syncControls() {
  els.hydration.value = String(state.hydration);
  syncDial();
  syncTiles();
  syncBatch();
  syncWeightValidity();
}

function stepCount(step) {
  state.count = Math.min(LIMITS.count.max, Math.max(LIMITS.count.min, state.count + step));
  els.countValue.textContent = String(state.count);
  markStale();
}

function bind() {
  for (const tile of els.tiles) {
    tile.addEventListener('click', () => selectType(tile.dataset.bread));
  }
  els.hydration.addEventListener('input', () => {
    state.hydration = Number(els.hydration.value);
    syncDial();
    markStale();
  });
  els.countMinus.addEventListener('click', () => stepCount(-1));
  els.countPlus.addEventListener('click', () => stepCount(1));
  els.weight.addEventListener('input', () => {
    syncWeightValidity();
    markStale();
  });
  els.calculate.addEventListener('click', () => {
    if (!weightValid()) {
      syncWeightValidity();
      return;
    }
    renderRecipe(calculate({
      type: state.type,
      hydration: state.hydration,
      count: state.count,
      weight: state.weight,
    }));
  });
  els.retry.addEventListener('click', () => location.reload());
}

function collectEls() {
  Object.assign(els, {
    screen: document.querySelector('[data-spec-screen="1"] .s'),
    tiles: [...document.querySelectorAll('#types [role="radio"]')],
    dialValue: $('dial-value'),
    dialDesc: $('dial-desc'),
    dialArc: $('dial-arc'),
    hydration: $('hydration'),
    rngFill: $('rng-fill'),
    rngThumb: $('rng-thumb'),
    countLabel: $('count-label'),
    perLabel: $('per-label'),
    countMinus: $('count-minus'),
    countPlus: $('count-plus'),
    countValue: $('count-value'),
    weight: $('weight'),
    weightMsg: $('weight-msg'),
    calculate: $('calculate'),
    results: $('results'),
    recipeEmpty: $('recipe-empty'),
    recipeOut: $('recipe-out'),
    recipeStale: $('recipe-stale'),
    recipeTitle: $('recipe-title'),
    ingredients: $('ingredients'),
    steps: $('steps'),
    appError: $('app-error'),
    retry: $('retry'),
  });
  // Row templates: keep one drawn row of each list, drop the samples.
  // Each is a function that returns a fresh clone of the drawn row.
  const totTemplate = els.ingredients.querySelector('.tot');
  totTemplate.remove();
  totRow = () => totTemplate.cloneNode(true);
  ingRow = rowsFrom(els.ingredients);
  stepRow = rowsFrom(els.steps);
}

function init() {
  collectEls();
  bind();
  const demo = new URLSearchParams(location.search).has('demo');
  if (demo) {
    els.screen.prepend(h('p', { class: 'kit-demo-label', id: 'demo' },
      'Staging demo: a sample recipe. Change anything to make your own.'));
    state.count = 2;
  }
  syncControls();
  if (demo) {
    renderRecipe(calculate({
      type: state.type,
      hydration: state.hydration,
      count: state.count,
      weight: state.weight,
    }));
  }
}

try {
  init();
} catch (err) {
  console.error('Bread Bot failed to start:', err);
  // The form is static markup, so the settings are still on screen.
  const error = $('app-error');
  if (error) {
    error.hidden = false;
    const out = $('recipe-out');
    if (out) out.hidden = true;
    const empty = $('recipe-empty');
    if (empty) empty.hidden = true;
  }
}
