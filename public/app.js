// Bread Bot: turn bread settings into a recipe. Everything is computed in
// the browser from standard baker's percentages — no server, no database.
// The screen is the drawn one (usernode-spec-screens@1 in index.html): this
// script fills its drawn rows from data and wires the controls.
import { h, clear, isDemo } from '/kit/dom.js';
import { rowsFrom, fillIn } from '/kit/fill.js';

// ── Line icons, in the drawn set's style ─────────────────────────────────
const ICON_D = {
  wheat: 'M12 21V9M12 9c-2-1-3-3-3-5 2 0 3 2 3 5zM12 9c2-1 3-3 3-5-2 0-3 2-3 5zM12 14c-2-1-3-3-3-4 2 0 3 1 3 4zM12 14c2-1 3-3 3-4-2 0-3 1-3 4z',
  drop: 'M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z',
  jar: 'M7 8h10v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2zM6 5h12v3H6zM10 13h.01M14 16h.01M12 11h.01',
  packet: 'M8 9h8l-1 11H9zM9 9V6a3 3 0 0 1 6 0v3M11 6h.01M13 6h.01',
  block: 'M5 10h14v6H5zM7 10V7h10v3',
  dough: 'M5 20h14M7 20v-6a5 5 0 0 1 10 0v6M12 4v3M9 5l1 2M15 5l-1 2',
  basket: 'M4 14a8 5 0 0 0 16 0zM8 11c1-2 7-2 8 0',
  oven: 'M3 5h18v15H3zM3 9h18M7 7h.01M10 7h.01M9 15h6',
  pot: 'M6 11h12v4a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3zM4 11h2M18 11h2M9 8c0-1.2 1-1.3 1-2.5M13 8c0-1.2 1-1.3 1-2.5',
};

function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ic');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICON_D[name] || '');
  svg.appendChild(path);
  return svg;
}

// ── The breads ───────────────────────────────────────────────────────────
// Percentages are baker's percentages (of the total flour). Rise minutes are
// at the default hydration; bake minutes are at the reference weight.
const WATER_SUB = 'Lukewarm, about 26°C';
const BREADS = {
  sourdough: {
    label: 'Sourdough',
    hMin: 65, hMax: 85, hDef: 75, countDef: 1, weightDef: 900,
    countLabel: 'Loaves', countOne: 'loaf', weightLabel: 'Weight per loaf',
    ends: ['65% firm', '85% open crumb'],
    flour: [{ share: 1, name: 'Bread flour', sub: 'Strong white', icon: 'wheat' }],
    starter: { pct: 20, name: 'Sourdough starter', sub: 'Active, fed 1:1', icon: 'jar' },
    others: [{ pct: 2, name: 'Salt', sub: 'Fine sea salt', icon: 'packet' }],
    rise: [
      { title: 'Bulk rise', sub: 'At about 24°C, until 50% bigger', min: 270, icon: 'dough' },
      { title: 'Shape and proof', sub: 'In a floured basket, in the fridge', min: 720, icon: 'basket' },
    ],
    boil: null,
    bake: [
      { title: 'Lid on', temp: 250, note: '', min: 20 },
      { title: 'Lid off', temp: 230, note: 'until deep brown', min: 22 },
    ],
    ref: 900,
  },
  bagels: {
    label: 'Bagels',
    hMin: 52, hMax: 65, hDef: 58, countDef: 8, weightDef: 110,
    countLabel: 'Bagels', countOne: 'bagel', weightLabel: 'Weight per bagel',
    ends: ['52% chewy', '65% tender'],
    flour: [{ share: 1, name: 'Bread flour', sub: 'Strong white', icon: 'wheat' }],
    starter: null,
    others: [
      { pct: 1, name: 'Instant yeast', sub: 'Mixed into the water', icon: 'packet' },
      { pct: 2, name: 'Salt', sub: 'Fine sea salt', icon: 'packet' },
      { pct: 2, name: 'Malt syrup', sub: 'Barley malt, in the boil too', icon: 'drop' },
    ],
    rise: [
      { title: 'Rise', sub: 'At room temperature, until puffy', min: 60, icon: 'dough' },
      { title: 'Proof', sub: 'After shaping, until a dent springs back slowly', min: 30, icon: 'basket' },
    ],
    boil: { title: 'Boil', sub: 'Simmering water, 1 min a side', min: 1, icon: 'pot' },
    bake: [{ title: 'Bake', temp: 220, note: 'until shiny and brown', min: 18 }],
    ref: 110,
  },
  'sourdough-bagels': {
    label: 'Sourdough bagels',
    hMin: 52, hMax: 65, hDef: 58, countDef: 8, weightDef: 110,
    countLabel: 'Bagels', countOne: 'bagel', weightLabel: 'Weight per bagel',
    ends: ['52% chewy', '65% tender'],
    flour: [{ share: 1, name: 'Bread flour', sub: 'Strong white', icon: 'wheat' }],
    starter: { pct: 20, name: 'Sourdough starter', sub: 'Active, fed 1:1', icon: 'jar' },
    others: [
      { pct: 2, name: 'Salt', sub: 'Fine sea salt', icon: 'packet' },
      { pct: 2, name: 'Malt syrup', sub: 'Barley malt, in the boil too', icon: 'drop' },
    ],
    rise: [
      { title: 'Bulk rise', sub: 'At room temperature, until puffy', min: 240, icon: 'dough' },
      { title: 'Shape and proof', sub: 'In the fridge, after shaping', min: 720, icon: 'basket' },
    ],
    boil: { title: 'Boil', sub: 'Simmering water, 1 min a side', min: 1, icon: 'pot' },
    bake: [{ title: 'Bake', temp: 220, note: 'until shiny and brown', min: 20 }],
    ref: 110,
  },
  rye: {
    label: 'Rye',
    hMin: 70, hMax: 90, hDef: 80, countDef: 1, weightDef: 900,
    countLabel: 'Loaves', countOne: 'loaf', weightLabel: 'Weight per loaf',
    ends: ['70% dense', '90% moist'],
    flour: [
      { share: 0.7, name: 'Rye flour', sub: 'Medium or light rye, 70% of the flour', icon: 'wheat' },
      { share: 0.3, name: 'Bread flour', sub: 'Strong white, 30% of the flour', icon: 'wheat' },
    ],
    starter: { pct: 30, name: 'Rye starter', sub: 'Active and bubbly', icon: 'jar' },
    others: [{ pct: 2, name: 'Salt', sub: 'Fine sea salt', icon: 'packet' }],
    rise: [
      { title: 'Bulk rise', sub: 'At room temperature, until noticeably puffy', min: 120, icon: 'dough' },
      { title: 'Shape and proof', sub: 'In a floured tin, until risen a little', min: 60, icon: 'basket' },
    ],
    boil: null,
    bake: [
      { title: 'Hot bake', temp: 250, note: 'with steam', min: 10 },
      { title: 'Low bake', temp: 210, note: 'until the crust is firm', min: 50 },
    ],
    ref: 900,
  },
  sandwich: {
    label: 'Sandwich loaf',
    hMin: 58, hMax: 72, hDef: 65, countDef: 1, weightDef: 900,
    countLabel: 'Loaves', countOne: 'loaf', weightLabel: 'Weight per loaf',
    ends: ['58% close', '72% soft'],
    flour: [{ share: 1, name: 'Bread flour', sub: 'Strong white', icon: 'wheat' }],
    starter: null,
    others: [
      { pct: 8, name: 'Butter', sub: 'Softened', icon: 'block' },
      { pct: 5, name: 'Sugar', sub: 'White sugar', icon: 'packet' },
      { pct: 1.5, name: 'Instant yeast', sub: 'Mixed into the flour', icon: 'packet' },
      { pct: 2, name: 'Salt', sub: 'Fine sea salt', icon: 'packet' },
    ],
    rise: [
      { title: 'Rise', sub: 'At room temperature, until doubled', min: 90, icon: 'dough' },
      { title: 'Proof', sub: 'In the greased tin, until the rim is level', min: 60, icon: 'basket' },
    ],
    boil: null,
    bake: [{ title: 'Bake', temp: 190, note: 'until golden and hollow', min: 35 }],
    ref: 900,
  },
};

// ── The recipe model ─────────────────────────────────────────────────────
// Hydration counts the starter's water and flour, and a starter is fed 1:1,
// so half its flour and half its water come out of those two lines. Every
// line is rounded to whole grams and the remainder lands on water, so the
// lines add up to the dough total.
function calculate({ bread, hydration, count, weight }) {
  const b = BREADS[bread];
  const D = count * weight;
  const h = hydration / 100;
  const s = b.starter ? b.starter.pct / 100 : 0;
  const additives = b.others.reduce((sum, o) => sum + o.pct, 0) / 100;
  const F = D / (1 + h + additives);
  const starterMass = s * F;
  const starterFlour = starterMass / 2;
  const starterWater = starterMass / 2;

  const ingredients = [];
  for (const [i, f] of b.flour.entries()) {
    const grams = f.share * F - (i === 0 ? starterFlour : 0);
    ingredients.push({ icon: f.icon, name: f.name, sub: f.sub, grams });
  }
  ingredients.push({
    icon: 'drop', name: 'Water', sub: WATER_SUB,
    grams: h * F - starterWater,
  });
  if (b.starter) {
    ingredients.push({ icon: b.starter.icon, name: b.starter.name, sub: b.starter.sub, grams: starterMass });
  }
  for (const o of b.others) {
    ingredients.push({ icon: o.icon, name: o.name, sub: o.sub, grams: o.pct / 100 * F });
  }
  // Whole grams; water takes the rounding remainder.
  for (const ing of ingredients) ing.grams = Math.round(ing.grams);
  const rounded = ingredients.reduce((sum, ing) => sum + ing.grams, 0);
  ingredients.find((ing) => ing.name === 'Water').grams += D - rounded;

  // Wetter dough rises faster: 15 min per 5 hydration points, never below
  // half the base time.
  const shift = Math.round((hydration - b.hDef) / 5) * 15;
  const rise = b.rise.map((step, i) => {
    const min = i === 0 ? Math.max(Math.round(step.min / 2), step.min - shift) : step.min;
    return { ...step, min };
  });
  // Bigger loaves bake longer: 2 min per 100 g from the reference weight,
  // on the final bake stage only, never below 8 min.
  const bake = b.bake.map((stage, i) => {
    const isFinal = i === b.bake.length - 1;
    const min = isFinal
      ? Math.max(8, Math.round(stage.min + (weight - b.ref) / 100 * 2))
      : stage.min;
    const f = Math.round(stage.temp * 9 / 5 + 32);
    const sub = `${stage.temp}°C, ${f}°F${stage.note ? ', ' + stage.note : ''}`;
    return { title: stage.title, sub, min, icon: 'oven' };
  });
  if (b.boil) {
    bake.unshift({ title: b.boil.title, sub: b.boil.sub, min: b.boil.min, icon: b.boil.icon });
  }

  return { bread, count, ingredients, rise, bake, dough: D };
}

// ── Formatting ───────────────────────────────────────────────────────────
const nf = (n) => n.toLocaleString('en-US');
const fmtMin = (min) => (min >= 60 && min % 60 === 0
  ? { main: nf(min / 60), unit: 'h' }
  : min > 60
    ? { main: `${Math.floor(min / 60)} h ${min % 60}`, unit: 'min' }
    : { main: nf(min), unit: 'min' });

// ── The drawn screen's parts ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const chips = [...document.querySelectorAll('.chip[data-bread]')];
const slider = $('hydration');
const dialN = $('dial-n');
const dialArc = $('dial-arc');
const dialFill = $('dial-fill');
const dialKnob = $('dial-knob');
const holes = [...document.querySelectorAll('#dial-holes ellipse')].map((e) => ({
  el: e, rx: +e.getAttribute('rx'), ry: +e.getAttribute('ry'),
}));
const countInput = $('count');
const weightInput = $('weight');
const weightErr = $('weight-err');

// One drawn row per list is kept as the row to repeat.
const ingRow = rowsFrom($('ing-list'));
const riseRow = rowsFrom($('rise-list'));
const bakeRow = rowsFrom($('bake-list'));
const sections = $('recipe-sections');
const recipeBody = $('recipe-body');

let settings = null;
let calculated = false;

// ── Controls and the dial ────────────────────────────────────────────────
function currentBread() {
  return BREADS[settings.bread];
}

function syncControls() {
  const b = currentBread();
  for (const chip of chips) {
    chip.setAttribute('aria-pressed', String(chip.dataset.bread === settings.bread));
  }
  $('count-label').textContent = b.countLabel;
  $('weight-label').textContent = b.weightLabel;
  weightInput.setAttribute('aria-label', b.weightLabel);
  $('ends-lo').textContent = b.ends[0];
  $('ends-hi').textContent = b.ends[1];
  slider.min = b.hMin;
  slider.max = b.hMax;
  slider.value = settings.hydration;
  countInput.textContent = settings.count;
  if (document.activeElement !== weightInput) weightInput.value = settings.weight;
  syncDial();
}

function syncDial() {
  const b = currentBread();
  const value = +slider.value;
  dialN.textContent = `${value}%`;
  const t = (value - b.hMin) / (b.hMax - b.hMin);
  const pct = Math.max(0, Math.min(100, t * 100));
  dialArc.setAttribute('stroke-dasharray', `${pct} 100`);
  dialArc.style.opacity = pct <= 0.1 ? '0' : '1';
  dialFill.style.width = `${pct}%`;
  dialKnob.style.left = `calc(${pct}% - ${28 * pct / 100}px)`;
  // The crumb's holes open up as hydration rises; the drawn sizes are the
  // middle of a bread's range.
  const scale = 0.55 + t * 0.9;
  for (const hole of holes) {
    hole.el.setAttribute('rx', (hole.rx * scale).toFixed(2));
    hole.el.setAttribute('ry', (hole.ry * scale).toFixed(2));
  }
}

function markStale() {
  if (!calculated) return;
  $('stale').hidden = false;
  sections.classList.add('stale');
}

function clearStale() {
  $('stale').hidden = true;
  sections.classList.remove('stale');
}

function checkWeight() {
  const valid = /^\d+$/.test(weightInput.value.trim())
    && +weightInput.value >= 50 && +weightInput.value <= 3000;
  weightErr.hidden = valid;
  weightInput.setAttribute('aria-invalid', valid ? 'false' : 'true');
  return valid;
}

// ── Rendering ────────────────────────────────────────────────────────────
function fillRow(make, x) {
  const li = fillIn(make(), {
    '.t': x.title || x.name,
    '.sub': x.sub,
    '.g': { children: [`${x.value} `, h('small', {}, x.unit)] },
  });
  li.querySelector('.ic').replaceWith(icon(x.icon));
  return li;
}

const EMPTY_TEXT = 'Your recipe shows here. Choose your bread and tap Calculate.';

function showEmpty() {
  clear(recipeBody).append(
    h('div', { class: 'state-empty' },
      h('p', { class: 'text-body text-muted' }, EMPTY_TEXT)));
  $('recipe-meta').textContent = '';
  clearStale();
}

function renderRecipe(r) {
  clear(recipeBody).append(sections);
  sections.hidden = false;
  $('recipe-meta').textContent =
    `${r.count} ${r.count === 1 ? currentBread().countOne : currentBread().countLabel.toLowerCase()}, ${nf(r.dough)} g dough`;
  $('ing-list').replaceChildren(...r.ingredients.map((ing) =>
    fillRow(ingRow, { icon: ing.icon, name: ing.name, sub: ing.sub, value: nf(ing.grams), unit: 'g' })));
  $('rise-list').replaceChildren(...r.rise.map((step) => {
    const t = fmtMin(step.min);
    return fillRow(riseRow, { icon: step.icon, title: step.title, sub: step.sub, value: t.main, unit: t.unit });
  }));
  $('bake-list').replaceChildren(...r.bake.map((stage) => {
    const t = fmtMin(stage.min);
    return fillRow(bakeRow, { icon: stage.icon, title: stage.title, sub: stage.sub, value: t.main, unit: t.unit });
  }));
  clearStale();
}

function doCalculate() {
  if (!checkWeight()) return; // the recipe stays as it was
  settings = { ...settings, weight: +weightInput.value };
  renderRecipe(calculate(settings));
  calculated = true;
}

// ── Wiring ───────────────────────────────────────────────────────────────
for (const chip of chips) {
  chip.addEventListener('click', () => {
    const b = BREADS[chip.dataset.bread];
    settings = { ...settings, bread: chip.dataset.bread, hydration: b.hDef, count: b.countDef, weight: b.weightDef };
    syncControls();
    markStale();
  });
}
slider.addEventListener('input', () => {
  settings.hydration = +slider.value;
  syncDial();
  markStale();
});
$('count-minus').addEventListener('click', () => {
  settings.count = Math.max(1, settings.count - 1);
  countInput.textContent = settings.count;
  markStale();
});
$('count-plus').addEventListener('click', () => {
  settings.count = Math.min(24, settings.count + 1);
  countInput.textContent = settings.count;
  markStale();
});
weightInput.addEventListener('input', () => {
  if (weightInput.value.trim() !== '') settings.weight = +weightInput.value;
  checkWeight();
  markStale();
});
$('calculate').addEventListener('click', doCalculate);

// ── Start ────────────────────────────────────────────────────────────────
function defaults(key) {
  const b = BREADS[key];
  return { bread: key, hydration: b.hDef, count: b.countDef, weight: b.weightDef };
}

if (isDemo()) {
  // The staging demo: a sample bake, already calculated.
  settings = { bread: 'sourdough', hydration: 75, count: 2, weight: 900 };
  syncControls();
  renderRecipe(calculate(settings));
  calculated = true;
  $('demo-label').hidden = false;
} else {
  settings = defaults('sourdough');
  syncControls();
  sections.hidden = true;
  showEmpty();
}
