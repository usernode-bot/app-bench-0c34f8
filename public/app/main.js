// Wires the drawn screen: state in, everything shown, on every input. The
// shell in index.html keeps the drawn structure; the dynamic rows (bread
// tiles, steppers, ingredients, bake, timeline) are rendered from data with
// the same markup, synchronously on load, so the screen never shows a blank.

import { h, clear, isDemo, api } from '/kit/dom.js';
import { showDemoLabel } from '/kit/demo.js';
import { STYLES, defaultsFor, clampInput, calculate, formatGrams, formatDuration, formatTotal, formatOffset } from './bread.js';
import { icon } from './icons.js';

const app = document.getElementById('app');
const els = {
  styles: document.getElementById('styles'),
  hydValue: document.getElementById('hyd-value'),
  slider: document.getElementById('hydration'),
  dough: document.getElementById('dough'),
  legend: document.getElementById('legend'),
  ratio: document.getElementById('ratio'),
  counts: document.getElementById('counts'),
  ingFor: document.getElementById('ing-for'),
  ingredients: document.getElementById('ingredients'),
  bake: document.getElementById('bake'),
  tlTotal: document.getElementById('tl-total'),
  timeline: document.getElementById('timeline'),
};

let state = defaultsFor('sourdough');
const fmtN = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ── The five bread tiles, built once, pressed per state. ──────────────────
const keys = Object.keys(STYLES);
const tiles = keys.map((key) => {
  const b = h('button', { class: 'style', type: 'button', 'aria-pressed': 'false' }, icon(key), STYLES[key].label);
  b.addEventListener('click', () => {
    const next = defaultsFor(key);
    // Same unit keeps the count and size, clamped; a new unit takes the new bread's.
    const keep = STYLES[state.style].unit === STYLES[key].unit ? { count: state.count, size: state.size } : {};
    state = clampInput({ ...next, ...keep });
    render();
  });
  return b;
});
clear(els.styles).append(...tiles);

// ── The two steppers, built once, labels and outputs per state. ───────────
const countLabel = h('span');
const countOut = h('output');
const countMinus = h('button', { type: 'button' }, icon('minus'));
const countPlus = h('button', { type: 'button' }, icon('plus'));
const sizeLabel = h('span');
const sizeSub = h('span', { class: 'sub' });
const sizeOut = h('output');
const sizeMinus = h('button', { type: 'button' }, icon('minus'));
const sizePlus = h('button', { type: 'button' }, icon('plus'));

const bumpCount = (d) => { state = clampInput({ ...state, count: state.count + d }); render(); };
const bumpSize = (d) => { state = clampInput({ ...state, size: state.size + d * STYLES[state.style].sizeStep }); render(); };
countMinus.addEventListener('click', () => bumpCount(-1));
countPlus.addEventListener('click', () => bumpCount(1));
sizeMinus.addEventListener('click', () => bumpSize(-1));
sizePlus.addEventListener('click', () => bumpSize(1));

clear(els.counts).append(
  h('li', { class: 'list-row' }, h('div', { class: 'grow' }, countLabel),
    h('div', { class: 'stepper' }, countMinus, countOut, countPlus)),
  h('li', { class: 'list-row' }, h('div', { class: 'grow' }, sizeLabel, sizeSub),
    h('div', { class: 'stepper' }, sizeMinus, sizeOut, sizePlus)),
);

// ── Hydration. ────────────────────────────────────────────────────────────
els.slider.addEventListener('input', () => {
  state = clampInput({ ...state, hydration: Number(els.slider.value) });
  render();
});

// ── Render everything the state decides. ──────────────────────────────────
function render() {
  const r = calculate(state);
  const s = STYLES[state.style];
  const loaf = s.unit === 'loaf';

  tiles.forEach((b, i) => b.setAttribute('aria-pressed', String(keys[i] === state.style)));

  els.hydValue.textContent = `${state.hydration}%`;
  els.slider.value = state.hydration;
  els.slider.setAttribute('aria-valuetext', `${state.hydration} percent`);

  const flourPct = Math.round((r.flour / (r.flour + r.water)) * 100);
  clear(els.dough).append(
    h('div', { class: 'flour', style: `width:${flourPct}%` }),
    h('div', { class: 'water', style: `width:${100 - flourPct}%` }));
  els.dough.setAttribute('aria-label', `Flour ${fmtN(r.flour)} g, water ${fmtN(r.water)} g`);
  clear(els.legend).append(
    h('span', {}, h('i', { class: 'sw', style: 'background:rgb(var(--wheat))' }), `Flour ${fmtN(r.flour)} g`),
    h('span', {}, h('i', { class: 'sw', style: 'background:rgb(var(--water))' }), `Water ${fmtN(r.water)} g`));
  els.ratio.textContent = r.ratioText;

  countLabel.textContent = loaf ? 'Loaves' : 'Bagels';
  countOut.textContent = state.count;
  countMinus.setAttribute('aria-label', `One fewer ${s.unit}`);
  countPlus.setAttribute('aria-label', `One more ${s.unit}`);
  countMinus.disabled = state.count <= s.countMin;
  countPlus.disabled = state.count >= s.countMax;
  sizeLabel.textContent = loaf ? 'Loaf size' : 'Bagel size';
  sizeSub.textContent = `Dough per ${s.unit}`;
  sizeOut.textContent = `${fmtN(state.size)} g`;
  sizeMinus.setAttribute('aria-label', `${s.sizeStep} g smaller`);
  sizePlus.setAttribute('aria-label', `${s.sizeStep} g bigger`);
  sizeMinus.disabled = state.size <= s.sizeMin;
  sizePlus.disabled = state.size >= s.sizeMax;

  els.ingFor.textContent = `for ${plural(state.count, s.unit, loaf ? 'loaves' : 'bagels')}`;
  clear(els.ingredients).append(
    ...r.rows.map((row) => h('li', { class: 'list-row ing' },
      icon(row.icon),
      h('div', { class: 'grow' }, row.name,
        h('span', { class: 'sub' }, `${row.pct}%${row.tip ? `, ${row.tip}` : ''}`)),
      h('div', { class: 'grams' }, formatGrams(row.grams), h('small', {}, 'g')))),
    h('li', { class: 'list-row total' },
      h('div', { class: 'grow' }, 'Total dough'),
      h('div', { class: 'grams' }, fmtN(r.total), h('small', {}, 'g'))));

  clear(els.bake).append(
    icon('oven'),
    h('div', {},
      h('div', { class: 'big' }, `${r.bake.c}°C`, h('span', { class: 'f' }, `${r.bake.f}°F`)),
      h('p', {}, r.bake.text)));

  els.tlTotal.textContent = `about ${formatTotal(r.totalMinutes)}`;
  clear(els.timeline).append(...r.steps.map((st) =>
    h('li', {},
      h('span', { class: 'at' }, formatOffset(st.at)),
      h('span', { class: 'rail' }, h('i', { class: `dot${st.rise ? ' rise' : ''}${st.end ? ' end' : ''}` })),
      h('div', { class: 'step' }, h('b', {}, st.title), h('div', { class: 'sub' }, st.text)))));
}

render();

// Staging demo (?demo=1): take the example bake from the server and say so.
if (isDemo()) {
  api('GET', '/api/demo').then((data) => {
    if (data && data.demo) {
      state = clampInput({ ...state, ...data.preset });
      render();
      showDemoLabel(app, 'Staging demo: the settings here are an example bake.');
    }
  }).catch((err) => console.warn('Demo preset unavailable:', err && err.message));
}