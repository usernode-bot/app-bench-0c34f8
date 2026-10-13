// Bread Bot's screen: wires the drawn screen to the recipe maths in
// recipe.js. One way round: settings state in, screen out; Calculate is the
// only thing that refreshes the recipe. The drawn rows come from the screen
// itself (rowsFrom), filled with data (fillIn) — never rebuilt.
import { BREADS, calculate, validate, defaultsFor } from './recipe.js';
import { api, isDemo, h } from '/kit/dom.js';
import { rowsFrom, fillIn } from '/kit/fill.js';
import { showDemoLabel } from '/kit/demo.js';

const app = document.querySelector('.app');
const $ = (id) => document.getElementById(id);

const chipsBox = document.querySelector('.chips');
const chipBtns = [...chipsBox.querySelectorAll('.chip')];
const jar = document.querySelector('.jar');
const doughFill = jar.querySelector('.dough-fill');
const doughLine = jar.querySelector('.dough-line');
const bubbles = [...jar.querySelectorAll('circle')].map((c) => {
  c.dataset.cy = c.getAttribute('cy');
  return c;
});

const hydVal = $('hyd-val');
const hydHint = $('hyd-hint');
const hydErr = $('hyd-err');
const hydRange = $('hyd-range');
const hydFill = $('hyd-fill');
const hydKnob = $('hyd-knob');
const hydMinus = $('hyd-minus');
const hydPlus = $('hyd-plus');
const hydTyp = $('hyd-typ');

const countLab = $('count-lab');
const countVal = $('count-val');
const countErr = $('count-err');
const countMinus = $('count-minus');
const countPlus = $('count-plus');
const sizeLab = $('size-lab');
const sizeVal = $('size-val');
const sizeErr = $('size-err');
const sizeMinus = $('size-minus');
const sizePlus = $('size-plus');
const totDough = $('tot-dough');
const calcBtn = $('calc');
const staleNote = $('stale-note');

const recipe = $('recipe');
const ingSub = $('ing-sub');
const ingList = $('ing-list');
const riseList = $('rise-list');
const bakeSub = $('bake-sub');
const bakeCard = document.querySelector('.oven').parentElement;
const feedNote = $('feed-note');

// The row to repeat for the ingredient list, and its total row (kept aside
// before rowsFrom clears the drawn samples).
const sumSample = ingList.querySelector('.list-row.sum').cloneNode(true);
const ingRow = rowsFrom(ingList);
const riseRow = rowsFrom(riseList);

// One inline drawing per ingredient, in the screen's own style.
const ING_ICONS = {
  flour: '<path d="M7 8h10l1 12H6z"/><path d="M8 8c0-2 1.5-4 4-4s4 2 4 4"/><path d="M10 13h4"/>',
  'rye-flour': '<path d="M12 21v-8"/><path d="M12 13c-2.5-.4-3.5-1.8-3.5-3.8 2 0 3.5 1.4 3.5 3.8z"/><path d="M12 13c2.5-.4 3.5-1.8 3.5-3.8-2 0-3.5 1.4-3.5 3.8z"/><path d="M12 9.5c-2.5-.4-3.5-1.8-3.5-3.8 2 0 3.5 1.4 3.5 3.8z"/><path d="M12 9.5c2.5-.4 3.5-1.8 3.5-3.8-2 0-3.5 1.4-3.5 3.8z"/>',
  water: '<path d="M12 3c3 4 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 3-7 6-11z"/>',
  starter: '<path d="M7 7h10v12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z"/><path d="M6 4h12v3H6z"/><circle cx="10" cy="14" r="1"/><circle cx="14" cy="16" r="1"/>',
  salt: '<path d="M8 20h8l1-11H7z"/><path d="M7 9h10"/><path d="M10 5h4v4h-4z"/>',
  malt: '<path d="M8 8h8v11a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2z"/><path d="M9 4h6v4H9z"/><path d="M8 13h8"/>',
  yeast: '<circle cx="9" cy="10" r="3"/><circle cx="15.5" cy="9" r="2"/><circle cx="14" cy="15.5" r="3.5"/>',
  sugar: '<rect x="5.5" y="12" width="6.5" height="6.5" rx="1"/><rect x="12" y="5.5" width="6.5" height="6.5" rx="1"/>',
  butter: '<path d="M6 9h12v9H6z"/><path d="M8 9V6h8v3"/><path d="M9 12h6"/>',
};

function makeIcon(key) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ING_ICONS[key] || ING_ICONS.flour;
  return svg;
}

// ── State ─────────────────────────────────────────────────────────────────
const state = { type: 'sourdough', hydration: 75, count: 2, size: 900 };
let calculated = null; // the recipe on screen; null only before the first render

// ── Controls ──────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function renderChips() {
  for (const btn of chipBtns) {
    const on = btn.dataset.type === state.type;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-checked', String(on));
    btn.tabIndex = on ? 0 : -1;
  }
}

function renderHydration() {
  hydVal.replaceChildren(String(state.hydration), h('small', null, '%'));
  hydRange.value = state.hydration;
  hydRange.setAttribute('aria-valuetext', `${state.hydration} percent`);
  const pct = ((state.hydration - 50) / 50) * 100;
  hydFill.style.width = `${pct}%`;
  hydKnob.style.left = `calc(${pct}% - 13px)`;
  hydMinus.disabled = state.hydration <= 50;
  hydPlus.disabled = state.hydration >= 100;
  // The dough level inside the jar follows the hydration (75% is where the
  // screen drew it): one percent is about one pixel.
  const y = Math.round(clamp(52 + (75 - state.hydration) * 1.05, 24, 92));
  doughFill.setAttribute('d', `M15 ${y}c8-8 46-8 54 0v${100 - y}a7 7 0 0 1-7 7H22a7 7 0 0 1-7-7z`);
  doughLine.setAttribute('d', `M15 ${y}c8-8 46-8 54 0`);
  doughFill.style.d = `path("${doughFill.getAttribute('d')}")`;
  doughLine.style.d = `path("${doughLine.getAttribute('d')}")`;
  for (const b of bubbles) {
    b.setAttribute('cy', clamp(Number(b.dataset.cy) + (y - 52), y + 6, 96));
  }
}

function renderSteppers() {
  const B = BREADS[state.type];
  countLab.textContent = B.family === 'bagel' ? 'Bagels' : 'Loaves';
  sizeLab.textContent = B.family === 'bagel' ? 'Each bagel' : 'Each loaf';
  // While a field is being typed in, leave its value alone — a half-typed
  // entry must not be rewritten from state.
  if (document.activeElement !== countVal) countVal.value = state.count;
  countVal.setAttribute('aria-label', countLab.textContent);
  if (document.activeElement !== sizeVal) sizeVal.value = state.size;
  sizeVal.min = B.sizeLo;
  sizeVal.max = B.sizeHi;
  sizeVal.step = B.sizeStep;
  sizeVal.setAttribute('aria-label', `${sizeLab.textContent}, grams`);
  sizeMinus.setAttribute('aria-label', `${B.sizeStep} g less`);
  sizePlus.setAttribute('aria-label', `${B.sizeStep} g more`);
  countMinus.disabled = !Number.isInteger(state.count) || state.count <= 1;
  countPlus.disabled = !Number.isInteger(state.count) || state.count >= 24;
  sizeMinus.disabled = !Number.isInteger(state.size) || state.size <= B.sizeLo;
  sizePlus.disabled = !Number.isInteger(state.size) || state.size >= B.sizeHi;
}

function renderControls() {
  const B = BREADS[state.type];
  renderChips();
  renderHydration();
  hydHint.textContent = B.hint;
  hydTyp.textContent = `Typical for ${B.label.toLowerCase()}: ${B.hydration.lo} to ${B.hydration.hi}%`;
  renderSteppers();
  updateTotal();
}

function updateTotal() {
  totDough.textContent = Number.isInteger(state.count) && Number.isInteger(state.size)
    ? `${(state.count * state.size).toLocaleString('en-US')} g`
    : '—';
}

// ── The recipe ────────────────────────────────────────────────────────────
function renderRecipe(r) {
  ingSub.textContent = r.summary;

  const rows = r.ingredients.map((p) => {
    const row = fillIn(ingRow(), {
      '.tx b': p.name,
      '.tx i': p.note,
      '.g': { children: [document.createTextNode(p.text), h('span', null, 'g')] },
    });
    row.querySelector('.ic').replaceWith(makeIcon(p.key));
    return row;
  });
  rows.push(fillIn(sumSample.cloneNode(true), {
    '.tx b': 'Total dough',
    '.tx i': r.sumNote,
    '.g': { children: [document.createTextNode(r.totalText), h('span', null, 'g')] },
  }));
  ingList.replaceChildren(...rows);

  feedNote.textContent = r.feed ? r.feed.text : '';
  feedNote.hidden = !r.feed;

  riseList.replaceChildren(...r.rise.map((s, i) => fillIn(riseRow(), {
    '.n': String(i + 1),
    '.tx b': s.name,
    '.tx i': s.how,
    '.when': s.time,
  })));

  bakeSub.textContent = r.vessel;
  const [first, second] = r.bake.stages;
  fillIn(bakeCard, {
    '#b1-tt': `${first.c}°C`,
    '#b1-tf': `${first.f}°F`,
    '#b1-tl': first.label,
    '#b2': { hidden: !second },
    '#b2-tt': second ? `${second.c}°C` : '',
    '#b2-tf': second ? `${second.f}°F` : '',
    '#b2-tl': second ? second.label : '',
    '.done': r.bake.done,
  });
}

// ── Validation and the stale state ────────────────────────────────────────
function clearError(input, hint) {
  hint.hidden = true;
  hint.textContent = '';
  input.removeAttribute('aria-invalid');
}

function showErrors(errors) {
  const fields = [[hydRange, hydErr, errors.hydration], [countVal, countErr, errors.count], [sizeVal, sizeErr, errors.size]];
  let first = null;
  for (const [input, hint, msg] of fields) {
    hint.hidden = !msg;
    hint.textContent = msg || '';
    if (msg) {
      input.setAttribute('aria-invalid', 'true');
      first = first || input;
    } else {
      input.removeAttribute('aria-invalid');
    }
  }
  if (first) first.focus();
}

function onCalc() {
  const errors = validate(state);
  showErrors(errors);
  if (Object.keys(errors).length) return; // the recipe stays stale
  calculated = calculate(state);
  renderRecipe(calculated);
  recipe.classList.remove('recipe-stale');
  staleNote.hidden = true;
}

function markStale() {
  if (!calculated) return;
  recipe.classList.add('recipe-stale');
  staleNote.hidden = false;
}

// ── Events ────────────────────────────────────────────────────────────────
function pickType(type) {
  if (type === state.type || !BREADS[type]) return;
  const prev = state.type;
  state.type = type;
  // A new bread starts from its typical hydration; count and size carry
  // over only within the loaf/bagel family.
  Object.assign(state, defaultsFor(type, prev, state));
  renderControls();
  markStale();
}

for (const btn of chipBtns) {
  btn.addEventListener('click', () => pickType(btn.dataset.type));
}
chipsBox.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const i = chipBtns.indexOf(document.activeElement);
  const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
  const next = chipBtns[(i + step + chipBtns.length) % chipBtns.length] || chipBtns[0];
  pickType(next.dataset.type);
  next.focus();
});

hydRange.addEventListener('input', () => {
  state.hydration = Number(hydRange.value);
  renderHydration();
  clearError(hydRange, hydErr);
  markStale();
});
hydMinus.addEventListener('click', () => {
  state.hydration = clamp(state.hydration - 1, 50, 100);
  renderHydration();
  clearError(hydRange, hydErr);
  markStale();
});
hydPlus.addEventListener('click', () => {
  state.hydration = clamp(state.hydration + 1, 50, 100);
  renderHydration();
  clearError(hydRange, hydErr);
  markStale();
});

function readNumber(input, fallback) {
  const v = input.value.trim();
  return v === '' ? NaN : (Number.isFinite(Number(v)) ? Number(v) : NaN);
}

countVal.addEventListener('input', () => {
  state.count = readNumber(countVal);
  renderSteppers();
  updateTotal();
  clearError(countVal, countErr);
  markStale();
});
countMinus.addEventListener('click', () => {
  state.count = clamp((Number.isInteger(state.count) ? state.count : 1) - 1, 1, 24);
  renderSteppers();
  updateTotal();
  clearError(countVal, countErr);
  markStale();
});
countPlus.addEventListener('click', () => {
  state.count = clamp((Number.isInteger(state.count) ? state.count : 1) + 1, 1, 24);
  renderSteppers();
  updateTotal();
  clearError(countVal, countErr);
  markStale();
});

sizeVal.addEventListener('input', () => {
  state.size = readNumber(sizeVal);
  renderSteppers();
  updateTotal();
  clearError(sizeVal, sizeErr);
  markStale();
});
const stepSize = (dir) => {
  const B = BREADS[state.type];
  const base = Number.isInteger(state.size) ? state.size : B.size;
  state.size = clamp(base + dir * B.sizeStep, B.sizeLo, B.sizeHi);
  renderSteppers();
  updateTotal();
  clearError(sizeVal, sizeErr);
  markStale();
};
sizeMinus.addEventListener('click', () => stepSize(-1));
sizePlus.addEventListener('click', () => stepSize(1));

calcBtn.addEventListener('click', onCalc);

// ── Start ─────────────────────────────────────────────────────────────────
async function start() {
  // A staging preview opened with ?demo=1 starts from the sample bake.
  if (isDemo()) {
    try {
      const d = await api('GET', '/api/demo');
      if (d && d.demo && d.settings) Object.assign(state, d.settings);
    } catch (err) {
      console.warn('demo settings unavailable, using the defaults:', err.message);
    }
  }
  renderControls();
  calculated = calculate(state);
  renderRecipe(calculated);
  if (isDemo()) showDemoLabel(app, 'Staging demo: these starting settings are a sample.');
  document.documentElement.dataset.ready = '1';
}

start();