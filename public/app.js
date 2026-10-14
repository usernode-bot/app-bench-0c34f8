// Bread Bot: turn bread choices into a recipe. Client-only: settings go to
// recipes.js's calculate(), nothing is stored, nothing is fetched after
// load. The screen's drawn markup (public/index.html) is filled in place:
// drawn rows are the row to copy, every value is set from the calculation.

import { h } from '/kit/dom.js';
import { rowsFrom } from '/kit/fill.js';
import { bread, sizesFor, calculate } from '/recipes.js';

const $ = (sel) => document.querySelector(sel);

const EMPTY_TEXT = 'Your recipe shows here. Pick a bread and tap Calculate recipe.';
const STALE_TEXT = 'Settings changed. Tap Calculate recipe to update.';

const state = {
  type: 'sourdough',
  hydration: 75,
  count: 2,
  size: 800,
  calculated: false, // a recipe has been shown; edits make it stale
};

// ── The hydration dial ────────────────────────────────────────────────────
// A baker's scale: the arc is 50% (left) to 90% (right) over a half turn.
const CX = 150;
const CY = 150;
const angle = (v) => ((180 - (v - 50) * 4.5) * Math.PI) / 180;
const at = (v, r) => [CX + r * Math.cos(angle(v)), CY - r * Math.sin(angle(v))];

const SVG_NS = 'http://www.w3.org/2000/svg';

// Icons for the rise and bake rows, in the drawn .ic style.
const ICON_PATHS = {
  clock: ['M12 7v5l3 2', 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z'],
  oven: ['M3 5h18v15H3z', 'M3 9h18', 'M7 14h10'],
  boil: ['M12 4c3 4 5.5 6.9 5.5 9.9a5.5 5.5 0 0 1-11 0C6.5 10.9 9 8 12 4z'],
};

function iconSvg(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  for (const d of ICON_PATHS[name] || ICON_PATHS.oven) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

// The dial's marks: ticks on the arc, labels outside it. Drawn here so they
// sit exactly where the needle's scale puts them.
function drawTicks() {
  const ticks = document.getElementById('dial-ticks');
  for (const v of [50, 60, 70, 80, 90]) {
    const [x1, y1] = at(v, 120);
    const [x2, y2] = at(v, 102);
    ticks.appendChild(hNS('line', { x1, y1, x2, y2, class: 'tk' }));
    const [tx, ty] = at(v, 134);
    ticks.appendChild(hNS('text', { x: tx, y: ty + 4, class: 'tk-lb' }, v));
  }
}

function hNS(tag, attrs, text) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, typeof v === 'number' ? v.toFixed(1) : v);
  }
  if (text !== undefined) el.textContent = text;
  return el;
}

function drawDial() {
  const b = bread(state.type);
  const v = state.hydration;
  const band = document.getElementById('dial-band');
  const [bx1, by1] = at(b.band[0], 120);
  const [bx2, by2] = at(b.band[1], 120);
  band.setAttribute('d', `M${bx1.toFixed(1)} ${by1.toFixed(1)}a120 120 0 0 1 ${(bx2 - bx1).toFixed(1)} ${(by2 - by1).toFixed(1)}`);
  const needle = document.getElementById('dial-needle');
  const [nx, ny] = at(v, 96);
  needle.setAttribute('x2', nx.toFixed(1));
  needle.setAttribute('y2', ny.toFixed(1));
  document.querySelector('.dial svg title').textContent = `Hydration dial at ${v} percent`;
  document.querySelector('.dial .n').textContent = `${v}%`;
  document.querySelector('.dial .s').textContent =
    `${v} g water for every 100 g flour. ${b.name} usually ${b.band[0]} to ${b.band[1]}%.`;
  const pct = ((v - 50) / 40) * 100;
  document.querySelector('.range .fi').style.width = `${pct}%`;
  document.querySelector('.range .th').style.left = `calc(${pct}% - 14px)`;
  $('#hydration').value = v;
}

// ── The controls ──────────────────────────────────────────────────────────

function renderChips() {
  const chips = [...document.querySelectorAll('.chips .chip')];
  chips.forEach((chip) => {
    const on = chip.dataset.type === state.type;
    chip.classList.toggle('on', on);
    chip.setAttribute('aria-checked', String(on));
    chip.tabIndex = on ? 0 : -1;
  });
}

function renderSizes() {
  const b = bread(state.type);
  $('#unit-label').textContent = b.kind === 'bagel' ? 'Bagels' : 'Loaves';
  const seg = $('.seg');
  const hadFocus = seg.contains(document.activeElement);
  seg.replaceChildren(
    ...sizesFor(b).map((s) =>
      h('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': String(state.size === s.g),
        tabindex: state.size === s.g ? '0' : '-1',
        class: state.size === s.g ? 'on' : null,
        'data-size': s.g,
      }, s.label)
    )
  );
  if (hadFocus) seg.querySelector('[aria-checked="true"]')?.focus();
}

function renderCount() {
  $('#count-n').textContent = state.count;
}

function radioKeys(container, onPick) {
  container.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(e.key)) return;
    const items = [...container.querySelectorAll('[role="radio"]')];
    const i = items.findIndex((el) => el.getAttribute('aria-checked') === 'true');
    const dir = ['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1;
    onPick(items[(i + dir + items.length) % items.length]);
    e.preventDefault();
  });
}

function wire() {
  const chips = document.querySelector('.chips');
  for (const chip of chips.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => pickBread(chip.dataset.type));
  }
  radioKeys(chips, (chip) => pickBread(chip.dataset.type));

  const seg = document.querySelector('.seg');
  const pickSize = (el) => setSize(Number(el.dataset.size));
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[role="radio"]');
    if (btn) pickSize(btn);
  });
  radioKeys(seg, pickSize);

  $('#count-minus').addEventListener('click', () => setCount(state.count - 1));
  $('#count-plus').addEventListener('click', () => setCount(state.count + 1));
  $('#hydration').addEventListener('input', (e) => {
    state.hydration = Number(e.target.value);
    state.calculated && goStale();
    drawDial();
  });

  $('#calculate').addEventListener('click', calculateRecipe);
}

function pickBread(type) {
  if (state.type === type) return;
  const b = bread(type);
  state.type = type;
  state.hydration = b.hydration;
  state.count = b.count;
  state.size = b.size;
  state.calculated && goStale();
  renderControls();
}

function setCount(n) {
  state.count = Math.min(24, Math.max(1, n));
  state.calculated && goStale();
  renderCount();
}

function setSize(g) {
  state.size = g;
  state.calculated && goStale();
  renderSizes();
}

function renderControls() {
  renderChips();
  renderSizes();
  renderCount();
  drawDial();
}

// ── The recipe area: empty, stale, result ────────────────────────────────

function showRecipeState(text) {
  const box = $('#recipe-state');
  box.querySelector('p').textContent = text;
  box.hidden = false;
  $('#recipe').hidden = true;
}

function goStale() {
  showRecipeState(STALE_TEXT);
}

// One copied drawn row, filled from a calculate() row. Same markup as drawn:
// optional .ic icon, .t title with an optional small, .g value.
function fillRow(row, { icon, name, sub, text }) {
  const ic = row.querySelector('.ic');
  if (ic && icon) ic.replaceChildren(iconSvg(icon));
  const t = row.querySelector('.t');
  if (t) {
    t.replaceChildren(name);
    if (sub) t.append(h('small', {}, sub));
  }
  const g = row.querySelector('.g');
  if (g) g.textContent = text;
  return row;
}

let ingList;
let makeIngRow;
let riseList;
let makeRiseRow;
let bakeList;
let makeBakeRow;

function calculateRecipe() {
  const r = calculate(state);
  $('#recipe-title').textContent = r.title;
  $('#recipe-total').textContent = r.totals;
  ingList.replaceChildren(...r.ingredients.map((row) => fillRow(makeIngRow(), row)));
  const note = $('#recipe-note');
  if (r.note) {
    note.textContent = r.note;
    note.hidden = false;
  } else {
    note.hidden = true;
  }
  riseList.replaceChildren(...r.rise.map((row) => fillRow(makeRiseRow(), { icon: 'clock', ...row })));
  bakeList.replaceChildren(...r.bake.map((row) => fillRow(makeBakeRow(), { icon: row.boil ? 'boil' : 'oven', ...row })));
  $('#recipe-state').hidden = true;
  $('#recipe').hidden = false;
  state.calculated = true;
}

// ── Boot ──────────────────────────────────────────────────────────────────
// The staging demo (?demo=1): Sourdough at 75%, 2 loaves of 800 g, already
// calculated, labelled once. Nothing is stored, so it is idempotent by
// construction.

function maybeDemo() {
  if (document.documentElement.dataset.env !== 'staging') return;
  if (new URLSearchParams(location.search).get('demo') !== '1') return;
  $('#demo-label').hidden = false;
  state.type = 'sourdough';
  state.hydration = 75;
  state.count = 2;
  state.size = 800;
  renderControls();
  calculateRecipe();
}

drawTicks();
ingList = $('#ing-list');
makeIngRow = rowsFrom(ingList);
riseList = $('#rise-list');
makeRiseRow = rowsFrom(riseList);
bakeList = $('#bake-list');
makeBakeRow = rowsFrom(bakeList);
wire();
renderControls();
showRecipeState(EMPTY_TEXT);
maybeDemo();
