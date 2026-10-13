// Bread Bot's screen: the drawn calculator (public/index.html), filled and
// wired. State lives here, the maths in breads.js; nothing is sent anywhere.
import { fillIn, rowsFrom } from '/kit/fill.js';
import { isDemo } from '/kit/dom.js';
import { KINDS, calculate, fmtGrams } from './breads.js';

const chips = [...document.querySelectorAll('.chip')];
const range = document.getElementById('hydration');
const hydrationVal = document.getElementById('hydration-val');
const countLabel = document.getElementById('count-label');
const countVal = document.getElementById('count-val');
const countMinus = document.getElementById('count-minus');
const countPlus = document.getElementById('count-plus');
const gramsInput = document.getElementById('grams');
const gramsField = document.getElementById('grams-field');
const gramsLabel = document.getElementById('grams-label');
const gramsError = document.getElementById('grams-error');
const card = document.getElementById('recipe-card');
const emptyEl = document.getElementById('recipe-empty');
const fullEl = document.getElementById('recipe-full');
const staleEl = document.getElementById('recipe-stale');
const demoEl = document.getElementById('demo-label');
const calcBtn = document.getElementById('calculate');

// The drawn rows: keep one of each as the row to copy, drop the samples.
const tbody = document.getElementById('recipe-body');
const totalRow = tbody.querySelector('tr.total');
const ingRow = rowsFrom(tbody, 'tr:not(.total)');
const riseList = document.getElementById('rise-steps');
const bakeList = document.getElementById('bake-steps');
const riseRow = rowsFrom(riseList);
const bakeRow = rowsFrom(bakeList);

const MIN_GRAMS = 50;
const MAX_GRAMS = 3000;
const MAX_COUNT = 24;

const state = { kind: 'sourdough', hydration: 76, count: 2, grams: 900 };
let calculated = false; // a recipe is showing
let changed = false; // an input moved since that Calculate

const kind = () => KINDS[state.kind];

function syncInputs() {
  range.value = state.hydration;
  hydrationVal.textContent = `${state.hydration}%`;
  countVal.textContent = state.count;
  countMinus.disabled = state.count <= 1;
  countPlus.disabled = state.count >= MAX_COUNT;
  countLabel.textContent = kind().bagel ? 'Bagels' : 'Loaves';
  gramsLabel.textContent = kind().bagel ? 'Dough per bagel' : 'Dough per loaf';
  gramsInput.value = state.grams;
  for (const c of chips) c.setAttribute('aria-checked', String(c.dataset.kind === state.kind));
}

// Picking a bread resets all three settings to that bread's defaults.
function pickBread(name) {
  state.kind = name;
  const d = KINDS[name].defaults;
  state.hydration = d.hydration;
  state.count = d.count;
  state.grams = d.grams;
  syncInputs();
  clearGramsError();
}

function markChanged() {
  if (!calculated || changed) return;
  changed = true;
  staleEl.hidden = false;
}

function clearGramsError() {
  gramsError.hidden = true;
  gramsField.removeAttribute('aria-invalid');
  gramsInput.removeAttribute('aria-invalid');
}

function showGramsError() {
  gramsError.hidden = false;
  gramsField.setAttribute('aria-invalid', 'true');
  gramsInput.setAttribute('aria-invalid', 'true');
}

function render() {
  const r = calculate(state.kind, state.hydration, state.count, state.grams);
  const noun = r.bagel
    ? (state.count === 1 ? 'bagel' : 'bagels')
    : (state.count === 1 ? 'loaf' : 'loaves');

  fillIn(card, {
    '#recipe-name': r.name,
    '#recipe-meta': `${state.count} ${noun} of ${state.grams} g at ${state.hydration}% hydration`,
  });

  tbody.replaceChildren(
    ...r.lines.map((line) => fillIn(ingRow(), {
      'td.name': line.name,
      'td.g': `${fmtGrams(line.grams)} g`,
      'td.pct': `${line.pct}%`,
    })),
    totalRow,
  );
  fillIn(totalRow, {
    'td.g': `${state.count * state.grams} g`,
    'td.pct': `${r.pctSum}%`,
  });

  riseList.replaceChildren(...r.rise.map((s) => fillIn(riseRow(), { b: s.time, span: s.text })));
  bakeList.replaceChildren(...r.bake.map((s) => fillIn(bakeRow(), { b: s.time, span: s.text })));

  emptyEl.hidden = true;
  fullEl.hidden = false;
  staleEl.hidden = true;
  calculated = true;
  changed = false;
}

function calculateNow() {
  const raw = String(gramsInput.value).trim();
  const grams = Number(raw);
  if (raw === '' || !Number.isFinite(grams) || grams < MIN_GRAMS || grams > MAX_GRAMS) {
    showGramsError();
    return; // the recipe stays as it was
  }
  clearGramsError();
  state.grams = grams;
  render();
}

for (const chip of chips) {
  chip.addEventListener('click', () => {
    if (chip.dataset.kind === state.kind) return;
    pickBread(chip.dataset.kind);
    markChanged();
  });
}

range.addEventListener('input', () => {
  state.hydration = Number(range.value);
  hydrationVal.textContent = `${state.hydration}%`;
  markChanged();
});

countMinus.addEventListener('click', () => {
  state.count = Math.max(1, state.count - 1);
  countVal.textContent = state.count;
  countMinus.disabled = state.count <= 1;
  countPlus.disabled = false;
  markChanged();
});

countPlus.addEventListener('click', () => {
  state.count = Math.min(MAX_COUNT, state.count + 1);
  countVal.textContent = state.count;
  countPlus.disabled = state.count >= MAX_COUNT;
  countMinus.disabled = false;
  markChanged();
});

gramsInput.addEventListener('input', () => {
  clearGramsError();
  markChanged();
});

calcBtn.addEventListener('click', calculateNow);

// Start: the calculator with sourdough's settings filled in and an empty
// recipe card. On a staging preview opened with ?demo=1 the same screen
// comes up with the sample recipe already calculated; nothing is stored.
syncInputs();
emptyEl.hidden = false;
fullEl.hidden = true;
if (document.documentElement.dataset.env === 'staging' && isDemo()) {
  demoEl.hidden = false;
  calculateNow();
}