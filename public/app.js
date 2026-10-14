// Bread Bot's one screen: the drawn screen in index.html, filled from
// bread.js's calc(). Every setting change redraws the formula card at once
// (no Calculate button). Nothing is stored and nothing is fetched: the
// recipe is pure maths.
import { calc, BREADS, DEFAULTS, fmtG } from './bread.js';
import { rowsFrom } from '/kit/fill.js';
import { createStates } from '/kit/states.js';
import { showDemoLabel } from '/kit/demo.js';
import { h } from '/kit/dom.js';

const screen = document.querySelector('.bb');
const chips = [...screen.querySelectorAll('.chip')];
const hyd = document.getElementById('hydration');
const hydVal = document.getElementById('hyd-val');
const hydNote = document.getElementById('hyd-note');
const countLabel = document.getElementById('count-label');
const countVal = document.getElementById('count-val');
const minus = document.getElementById('count-minus');
const plus = document.getElementById('count-plus');
const sizeLabel = document.getElementById('size-label');
const segBtns = [...screen.querySelectorAll('.seg button')];
const customGrp = document.getElementById('custom-grp');
const customG = document.getElementById('custom-g');
const big = document.getElementById('hyd-big');
const barF = screen.querySelector('.bar .f');
const barW = screen.querySelector('.bar .w');
const note = document.getElementById('flour-water-note');
const list = document.getElementById('ingredients');
const totLabel = document.getElementById('tot-label');
const totG = document.getElementById('tot-g');
const riseOL = document.getElementById('rise-steps');
const bakeOL = document.getElementById('bake-steps');

// One row of each drawn list is the row to repeat; the drawn samples go.
const ingRow = rowsFrom(list);
const riseRow = rowsFrom(riseOL);
const bakeRow = rowsFrom(bakeOL);

// The ingredient icons, in the drawn line style. fill.js sets text and
// checked attributes only, so an icon is swapped by hand per row.
const ICON_PATHS = {
  flour: 'M7 4h10l-1 3 3 4v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8l3-4z|M8 7h8|M12 12v5M10 15l2 2 2-2',
  water: 'M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z',
  starter: 'M8 3h8v4H8z|M7 7h10v12a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z|M7 12h10|M15 16h.01',
  salt: 'M8 9h8l1 10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z|M9 9a3 3 0 0 1 6 0|M11 5h.01|M13 4h.01',
  yeast: 'M6 4h12v13a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z|M6 8h12|M10 13h.01|M14 15h.01',
  malt: 'M10 3h4v3l2 4v8a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-8l2-4z|M8 14h8|M10 3h4',
  sugar: 'M6 10h8v8H6z|M12 6h6v6h-4|M12 12v-2',
  butter: 'M4 10h16v7H4z|M7 10V7h10v3|M4 13.5h16',
};

function iconNode(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ width: '22', height: '22', viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(k, v);
  }
  for (const d of (ICON_PATHS[name] || '').split('|')) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

const state = { ...DEFAULTS };
const bread = () => BREADS[state.type];

// The card's four states. Empty is "these settings cannot make a recipe" (a
// custom weight outside 50 to 3,000 g); error is a rendering failure, whose
// Try again re-renders from the settings still on screen.
// createStates() clears its container, so keep the drawn card's own
// markup: save it first, then put it back inside the kit's content holder,
// where the ready state shows it.
const body = document.getElementById('formula-body');
const drawn = [...body.children];
const states = createStates(body, {
  rows: 3,
  empty: { title: 'Enter a weight',
    text: 'Enter a weight between 50 and 3,000 g to see the recipe' },
  error: { title: 'The recipe did not load',
    text: 'Something went wrong on our side. Your settings are still here.' },
});
// The drawn card sets its own spacing; the kit content's gaps would double it.
states.content.removeAttribute('class');
states.content.append(...drawn);

function ingLine(row, { icon, name, sub, pct, grams }) {
  row.querySelector('svg').replaceWith(iconNode(icon));
  const n = row.querySelector('.n');
  n.replaceChildren(document.createTextNode(name));
  if (sub) n.append(document.createElement('br'), h('span', { class: 'small muted' }, sub));
  row.querySelector('.pct').textContent = `${pct}%`;
  row.querySelector('.g').textContent = `${fmtG(grams)} g`;
  return row;
}

function stepLine(row, name, sub, v) {
  const k = row.querySelector('.k');
  k.replaceChildren(document.createTextNode(name),
    document.createElement('br'), h('span', { class: 'small muted' }, sub));
  const cell = row.querySelector('.v');
  if (v.temp && v.time) cell.replaceChildren(document.createTextNode(v.temp), h('small', {}, v.time));
  else cell.replaceChildren(document.createTextNode(v.temp || v.time));
  return row;
}

/** Fill the card from calc(state). Returns false when the settings are invalid. */
function render() {
  const r = calc(state);
  if (r.invalid) return false;
  big.textContent = `${r.hydration}%`;
  barF.style.width = `${r.bar.flour}%`;
  barW.style.width = `${r.bar.water}%`;
  note.textContent = r.note;
  list.replaceChildren(...r.ingredients.map((i) => ingLine(ingRow(), i)));
  totLabel.textContent = r.totalLabel;
  totG.textContent = `${fmtG(r.total)} g`;
  riseOL.replaceChildren(...r.rise.map((s) => stepLine(riseRow(), s.name, s.sub, { time: s.time })));
  bakeOL.replaceChildren(...r.bake.map((s) => stepLine(bakeRow(), s.name, s.sub, s)));
  return true;
}

function refresh() {
  try {
    if (render() === false) states.empty();
    else states.ready();
  } catch (err) {
    console.warn('Render failed:', err && err.message);
    states.error();
  }
}

// ── Syncing the controls to the state ──────────────────────────────────────

function syncChips() {
  for (const chip of chips) {
    const on = chip.dataset.type === state.type;
    chip.classList.toggle('on', on);
    chip.setAttribute('aria-pressed', String(on));
  }
}

function syncHydration() {
  const hd = bread().hydration;
  hydNote.textContent = hd.note;
  hyd.min = hd.min;
  hyd.max = hd.max;
  state.hydration = Math.min(hd.max, Math.max(hd.min, state.hydration));
  hyd.value = state.hydration;
  hydVal.textContent = `${state.hydration}%`;
  const pct = ((state.hydration - hd.min) / (hd.max - hd.min)) * 100;
  screen.querySelector('.slider .fill').style.width = `${pct}%`;
  screen.querySelector('.slider .thumb').style.left = `calc(${pct}% - 14px)`;
}

function syncCount() {
  const u = bread().unit;
  countLabel.textContent = u.label;
  state.count = Math.min(u.max, Math.max(u.min, state.count));
  countVal.textContent = state.count;
  minus.disabled = state.count <= u.min;
  plus.disabled = state.count >= u.max;
}

function syncSizes() {
  const s = bread().sizes;
  sizeLabel.textContent = bread().unit.sizeLabel;
  for (const btn of segBtns) {
    const on = btn.dataset.size === state.size;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    if (btn.dataset.size !== 'custom') btn.querySelector('i').textContent = `${fmtG(s[btn.dataset.size])} g`;
  }
  customGrp.hidden = state.size !== 'custom';
  customG.value = state.customGrams;
}

// ── Events: every change re-renders ────────────────────────────────────────

for (const chip of chips) chip.addEventListener('click', () => {
  if (state.type === chip.dataset.type) return;
  state.type = chip.dataset.type;
  state.hydration = bread().hydration.def; // each bread has its own typical hydration
  syncChips(); syncHydration(); syncCount(); syncSizes(); refresh();
});

hyd.addEventListener('input', () => {
  state.hydration = Number(hyd.value);
  syncHydration(); refresh();
});

minus.addEventListener('click', () => {
  if (state.count > bread().unit.min) { state.count -= 1; syncCount(); refresh(); }
});
plus.addEventListener('click', () => {
  if (state.count < bread().unit.max) { state.count += 1; syncCount(); refresh(); }
});

for (const btn of segBtns) btn.addEventListener('click', () => {
  state.size = btn.dataset.size;
  syncSizes(); refresh();
});

customG.addEventListener('input', () => {
  state.customGrams = customG.value;
  refresh();
});

// The staging demo line: only on staging, only when the preview asks for it.
const staging = document.documentElement.dataset.env === 'staging';
if (staging && new URLSearchParams(location.search).get('demo') === '1') {
  showDemoLabel(screen, 'Staging demo: these settings are an example.');
}

// ── Start ──────────────────────────────────────────────────────────────────
syncChips(); syncHydration(); syncCount(); syncSizes();
states.run(async () => render());
