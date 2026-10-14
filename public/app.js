// Wires the drawn screen: the controls feed state, Calculate runs
// bread.js's calculate() and renders the recipe into the drawn layout.
// Nothing here loads: the empty and error states are static in index.html.
import { h, isDemo } from '/kit/dom.js';
import { calculate, BREADS } from '/bread.js';
import { showDemoLabel } from '/kit/demo.js';

const state = { type: 'sourdough', hydration: 75, count: 2, size: 900 };
let hasRecipe = false;

const $ = (sel) => document.querySelector(sel);
const main = $('#app');
const types = $('.types');
const hydrationInput = $('#hydration');
const hydrationVal = $('#hydration-val');
const trackFill = $('.track i');
const thumb = $('.thumb');
const countEl = $('#count');
const lessBtn = $('.stepper .less');
const moreBtn = $('.stepper .more');
const countLabel = $('#count-label');
const sizeLabel = $('#size-label');
const segBtns = Array.from(document.querySelectorAll('.seg button'));
const recipe = $('[data-recipe]');
const recipeTitle = $('#recipe-title');
const recipeSub = $('#recipe-sub');
const stale = $('#stale');
const ingList = $('#ing-list');
const riseList = $('#rise-list');
const bakeList = $('#bake-list');
const emptyEl = $('#recipe-empty');
const errorEl = $('#recipe-error');

// The step icons, drawn exactly as the drawn screen drew them (plus a pot
// for the bagel boil).
const STEP_ICONS = {
  bowl: [['path', { d: 'M6 20h12M7 20V9h10v11' }], ['path', { d: 'M8 9c0-3 2-4 4-4s4 1 4 4' }]],
  proof: [['path', { d: 'M4 15c0-4 3.5-6.5 8-6.5s8 2.5 8 6.5v2H4z' }], ['path', { d: 'M12 3v3' }]],
  oven: [['rect', { x: 3, y: 5, width: 18, height: 15, rx: 2 }], ['path', { d: 'M3 9h18M7 14h10' }]],
  timer: [['circle', { cx: 12, cy: 13, r: 8 }], ['path', { d: 'M12 9v4l2.5 2M10 3h4' }]],
  pot: [['path', { d: 'M4 10h16' }], ['path', { d: 'M6 10v5a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-5' }], ['path', { d: 'M9 6.5v-2M15 6.5v-2' }]],
};
const RISE_ICONS = ['bowl', 'proof'];

function stepIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of STEP_ICONS[name] || []) {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

function stepRow(step, iconName) {
  return h('li', { class: 'list-row' },
    h('div', { class: 'step' },
      stepIcon(iconName),
      h('div', null,
        h('div', { class: 'n' }, step.name),
        h('div', { class: 'd' }, step.desc || step.tip)),
      h('span', { class: 'v' }, step.value || step.duration)));
}

// An ingredient row in the drawn markup, its bar the baker's formula:
// flour fills it whole, everything else by its share of the flour.
function ingRow(item) {
  return h('li', { class: 'list-row' },
    h('div', { class: 'ing' },
      h('span', { class: 'n' }, item.name),
      item.sub ? h('span', { class: 'text-small muted' }, item.sub) : null,
      h('span', { class: 'g' }, `${item.grams} g`)),
    h('div', { class: 'bar formula-bar' },
      h('span', { class: 't' }, h('i', { style: `width:${item.percent}%` })),
      h('span', { class: 'p' }, item.percentLabel)));
}

function renderControls() {
  const bread = BREADS[state.type];
  for (const btn of types.querySelectorAll('.type')) {
    const on = btn.dataset.bread === state.type;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }
  hydrationInput.value = state.hydration;
  hydrationVal.textContent = `${state.hydration}%`;
  const pct = ((state.hydration - 55) / 35) * 100;
  trackFill.style.width = `${pct}%`;
  thumb.style.left = `calc(${pct}% - 14px)`;
  countEl.textContent = state.count;
  lessBtn.disabled = state.count <= 1;
  moreBtn.disabled = state.count >= bread.maxCount;
  lessBtn.setAttribute('aria-label', `Down to 1 ${bread.unit[0]}`);
  moreBtn.setAttribute('aria-label', `Up to ${bread.maxCount} ${bread.unit[1]}`);
  countLabel.textContent = bread.unit[0] === 'bagel' ? 'Bagels' : 'Loaves';
  sizeLabel.textContent = bread.unit[0] === 'bagel' ? 'Bagel size' : 'Loaf size';
  segBtns.forEach((btn, i) => {
    btn.textContent = `${bread.sizes[i]} g`;
    const on = bread.sizes[i] === state.size;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  });
}

function markStale() {
  if (hasRecipe) stale.hidden = false;
}

function show(which) {
  recipe.hidden = which !== 'recipe';
  emptyEl.hidden = which !== 'empty';
  errorEl.hidden = which !== 'error';
}

function calculateNow() {
  try {
    const result = calculate(state);
    recipeTitle.textContent = result.title;
    recipeSub.textContent = result.subtitle;
    ingList.replaceChildren(...result.ingredients.map(ingRow));
    riseList.replaceChildren(...result.rise.map((step, i) => stepRow(step, RISE_ICONS[i])));
    bakeList.replaceChildren(...result.bake.map((step) => stepRow(step, step.icon)));
    hasRecipe = true;
    stale.hidden = true;
    show('recipe');
  } catch (err) {
    console.warn('Could not calculate:', err && err.message);
    show('error');
  }
}

types.addEventListener('click', (event) => {
  const btn = event.target.closest('.type');
  if (!btn || btn.dataset.bread === state.type) return;
  const bread = BREADS[btn.dataset.bread];
  // A new bread brings its own usual hydration and middle size; the count
  // stays but is clamped to the bread's maximum.
  state.type = btn.dataset.bread;
  state.hydration = bread.hydration;
  state.size = bread.sizes[1];
  state.count = Math.min(state.count, bread.maxCount);
  renderControls();
  markStale();
});

hydrationInput.addEventListener('input', () => {
  state.hydration = Number(hydrationInput.value);
  renderControls();
  markStale();
});

lessBtn.addEventListener('click', () => {
  state.count = Math.max(1, state.count - 1);
  renderControls();
  markStale();
});

moreBtn.addEventListener('click', () => {
  state.count = Math.min(BREADS[state.type].maxCount, state.count + 1);
  renderControls();
  markStale();
});

for (const seg of segBtns) {
  seg.addEventListener('click', () => {
    state.size = BREADS[state.type].sizes[Number(seg.dataset.size)];
    renderControls();
    markStale();
  });
}

$('#calculate').addEventListener('click', calculateNow);
$('#retry').addEventListener('click', calculateNow);

renderControls();
show('empty');

// The staging demo (?demo=1): a sample bake already set up and calculated,
// nothing stored. In production ?demo=1 does nothing.
if (document.documentElement.dataset.env === 'staging' && isDemo()) {
  showDemoLabel(main, 'Staging demo: a sample bake. Change anything and tap Calculate.');
  calculateNow();
}
