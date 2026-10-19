// Bread Bot: a bread choice and three numbers, turned into a baker's formula.
//
// The BREADS table holds the formulas — common baker's percentages as
// starting points, not tested recipes. Rise times assume a kitchen at about
// 24°C. Hydration counts only the added water; the starter is a separate
// ingredient at 100% hydration, so it is not part of the water percentage.

'use strict';

const BREADS = {
  sourdough: {
    name: 'Sourdough',
    hydration: 75,
    size: 800,
    count: 1,
    countLabel: 'Loaves',
    countWord: 'loaves',
    sizeLabel: 'Loaf size',
    flours: [{ name: 'Bread flour', pct: 100 }],
    extras: [{ name: 'Salt', pct: 2 }, { name: 'Starter', pct: 20 }],
    rise: { value: '5 h', label: 'Bulk rise' },
    oven: '230°C',
    bake: 45,
    sizeAdjust: true,
    steps: (m) => [
      'Mix, then bulk rise 5 h at room temperature, folding every 30 min for the first 2 h.',
      'Shape, then proof 12 h in the fridge.',
      `Bake at 230°C, covered for 20 min, uncovered for ${m - 20} min.`,
    ],
  },
  bagels: {
    name: 'Bagels',
    hydration: 58,
    size: 110,
    count: 8,
    countLabel: 'Bagels',
    countWord: 'bagels',
    sizeLabel: 'Bagel size',
    flours: [{ name: 'Bread flour', pct: 100 }],
    extras: [
      { name: 'Salt', pct: 2 },
      { name: 'Instant yeast', pct: 1 },
      { name: 'Barley malt syrup', pct: 3 },
    ],
    rise: { value: '1 h', label: 'First rise' },
    oven: '220°C',
    bake: 20,
    sizeAdjust: false,
    steps: () => [
      'Mix, then first rise 1 h at room temperature.',
      'Shape into rings, then retard 12 h in the fridge.',
      'Boil 1 min a side, then bake at 220°C for 20 min.',
    ],
  },
  'sourdough-bagels': {
    name: 'Sourdough bagels',
    hydration: 58,
    size: 110,
    count: 8,
    countLabel: 'Bagels',
    countWord: 'bagels',
    sizeLabel: 'Bagel size',
    flours: [{ name: 'Bread flour', pct: 100 }],
    extras: [
      { name: 'Salt', pct: 2 },
      { name: 'Starter', pct: 20 },
      { name: 'Barley malt syrup', pct: 3 },
    ],
    rise: { value: '4 h', label: 'Bulk rise' },
    oven: '220°C',
    bake: 22,
    sizeAdjust: false,
    steps: () => [
      'Mix, then bulk rise 4 h at room temperature.',
      'Shape into rings, then retard 12 h in the fridge.',
      'Boil 1 min a side, then bake at 220°C for 22 min.',
    ],
  },
  rye: {
    name: 'Rye',
    hydration: 80,
    size: 900,
    count: 1,
    countLabel: 'Loaves',
    countWord: 'loaves',
    sizeLabel: 'Loaf size',
    flours: [
      { name: 'Rye flour', pct: 60 },
      { name: 'Bread flour', pct: 40 },
    ],
    extras: [{ name: 'Salt', pct: 2 }, { name: 'Starter', pct: 20 }],
    rise: { value: '3 h', label: 'Bulk rise' },
    oven: '230°C',
    bake: 50,
    sizeAdjust: true,
    steps: (m) => [
      'Mix, then bulk rise 3 h at room temperature.',
      'Shape, then proof 1 h.',
      `Bake at 230°C for 15 min, then lower the oven to 210°C for ${m - 15} min.`,
    ],
  },
  sandwich: {
    name: 'Sandwich loaf',
    hydration: 62,
    size: 900,
    count: 1,
    countLabel: 'Loaves',
    countWord: 'loaves',
    sizeLabel: 'Loaf size',
    flours: [{ name: 'Bread flour', pct: 100 }],
    extras: [
      { name: 'Salt', pct: 2 },
      { name: 'Instant yeast', pct: 1.5 },
      { name: 'Sugar', pct: 5 },
      { name: 'Butter', pct: 8 },
    ],
    rise: { value: '1.5 h', label: 'First rise' },
    oven: '190°C',
    bake: 35,
    sizeAdjust: true,
    steps: (m) => [
      'Mix, then first rise 1.5 h at room temperature.',
      'Shape, then proof 1 h in a buttered tin.',
      `Bake at 190°C for ${m} min.`,
    ],
  },
};

const RANGES = {
  hydration: [50, 100],
  count: [1, 24],
  size: [50, 2000],
};

const $ = (id) => document.getElementById(id);
const el = {
  demoNote: document.querySelector('[data-usernode-demo-note]'),
  chips: Array.from(document.querySelectorAll('.chip')),
  hydration: $('hydration'),
  count: $('count'),
  size: $('size'),
  countLabel: $('count-label'),
  sizeLabel: $('size-label'),
  unitCount: $('unit-count'),
  title: $('card-title'),
  meta: $('card-meta'),
  rowsHead: $('rows-head'),
  rows: $('rows'),
  total: $('recipe-total'),
  totalPct: $('total-pct'),
  totalGrams: $('total-grams'),
  fix: $('fix'),
  bake: $('bake'),
  rise: $('rise-value'),
  riseLabel: $('rise-label'),
  oven: $('oven-value'),
  bakeValue: $('bake-value'),
  steps: $('steps'),
};

const state = { bread: 'sourdough' };

const fmt = (n) => n.toLocaleString('en');
const fmtPct = (p) => String(Math.round(p * 100) / 100);

// A field's number, or null when it is empty or not numeric.
function num(value) {
  const t = String(value).trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// The first out-of-range or empty field, in field order: the card says which
// number to fix and what range works, in place of the grams.
function firstProblem(b, h, count, size) {
  if (h === null || h < RANGES.hydration[0] || h > RANGES.hydration[1]) {
    return 'Fix the hydration: set it between 50 and 100%.';
  }
  const n = count === null ? null : Math.round(count);
  if (n === null || n < RANGES.count[0] || n > RANGES.count[1]) {
    return `Fix the number of ${b.countWord}: set it between 1 and 24.`;
  }
  if (size === null || size < RANGES.size[0] || size > RANGES.size[1]) {
    return `Fix the ${b.sizeLabel.toLowerCase()}: set it between 50 and 2,000 g.`;
  }
  return null;
}

// Bigger loaves bake longer: 5 minutes for every 200 g above or below the
// bread's usual size, never below 25 minutes. Bagels always bake the same.
function bakeMinutes(b, size) {
  if (!b.sizeAdjust) return b.bake;
  const delta = Math.round((size - b.size) / 200) * 5;
  return Math.max(25, b.bake + delta);
}

// Flour = dough ÷ (Σ% ÷ 100). Every other ingredient is rounded to whole
// grams, and the remainder goes to the bread flour (the last flour in the
// list, for rye too) so the total always equals the dough asked for.
function calc(b, h, count, size) {
  const n = Math.round(count);
  const dough = n * size;
  const pctSum =
    b.flours.reduce((s, f) => s + f.pct, 0) +
    h +
    b.extras.reduce((s, x) => s + x.pct, 0);
  const base = dough / (pctSum / 100);

  const grams = new Map();
  let left = dough;
  const restFlour = b.flours[b.flours.length - 1];
  const rounded = [
    ...b.flours.slice(0, -1),
    { name: 'Water', pct: h },
    ...b.extras,
  ];
  for (const item of rounded) {
    const g = Math.round((item.pct / 100) * base);
    grams.set(item.name, g);
    left -= g;
  }
  grams.set(restFlour.name, left);

  // Card order: the flours, water, then the rest.
  const rows = [
    ...b.flours.map((f) => ({ name: f.name, pct: f.pct })),
    { name: 'Water', pct: h },
    ...b.extras,
  ].map((item) => ({ name: item.name, pct: item.pct, g: grams.get(item.name) }));
  return { n, dough, pctSum, rows };
}

function render() {
  const b = BREADS[state.bread];
  const h = num(el.hydration.value);
  const count = num(el.count.value);
  const size = num(el.size.value);
  const problem = firstProblem(b, h, count, size);

  const shown = [el.meta, el.rowsHead, el.rows, el.total, el.bake, el.steps];
  if (problem) {
    for (const node of shown) node.hidden = true;
    el.fix.textContent = problem;
    el.fix.hidden = false;
    return;
  }
  el.fix.hidden = true;
  for (const node of shown) node.hidden = false;

  const { n, dough, pctSum, rows } = calc(b, h, count, size);
  const m = bakeMinutes(b, size);

  el.title.textContent = `${b.name} formula`;
  el.meta.textContent = `${fmt(n)} ${b.countWord} at ${fmt(size)} g, ${fmt(dough)} g dough in total`;
  el.rows.innerHTML = rows
    .map(
      (r) =>
        `<div class="row"><span>${r.name}</span><span>${fmtPct(r.pct)}%</span><span>${fmt(r.g)} g</span></div>`
    )
    .join('');
  el.totalPct.textContent = `${fmtPct(pctSum)}%`;
  el.totalGrams.textContent = `${fmt(dough)} g`;
  el.rise.textContent = b.rise.value;
  el.riseLabel.textContent = b.rise.label;
  el.oven.textContent = b.oven;
  el.bakeValue.textContent = `${m} min`;
  el.steps.innerHTML = b
    .steps(m)
    .map((s) => `<li>${s}</li>`)
    .join('');
}

// Picking a bread fills in its usual hydration and size; the count stays.
function selectBread(key) {
  const b = BREADS[key];
  if (!b) return;
  state.bread = key;
  el.hydration.value = b.hydration;
  el.size.value = b.size;
  el.countLabel.textContent = b.countLabel;
  el.sizeLabel.textContent = b.sizeLabel;
  el.unitCount.textContent = b.countWord;
  for (const chip of el.chips) {
    const on = chip.dataset.bread === key;
    chip.classList.toggle('on', on);
    chip.setAttribute('aria-pressed', String(on));
  }
  render();
}

for (const chip of el.chips) {
  chip.addEventListener('click', () => selectBread(chip.dataset.bread));
}
for (const input of [el.hydration, el.count, el.size]) {
  input.addEventListener('input', render);
}

// The staging preview (?demo=1) opens on the demo bake: Sourdough, 75%,
// 2 loaves of 800 g — the defaults — with its staging note showing.
const demo = new URLSearchParams(location.search).get('demo');
if (demo === '1' && el.demoNote) el.demoNote.hidden = false;

render();