// Wires the calculator: the drawn screen's inputs into calculate() from
// bread.js, and the result back into the drawn rows' markup. Nothing is
// sent anywhere; nothing is saved.
import { isDemo } from '/kit/dom.js';
import { showDemoLabel } from '/kit/demo.js';
import { rowsFrom, fillIn } from '/kit/fill.js';
import { BREADS, calculate, toFahrenheit } from './bread.js';

const $ = (id) => document.getElementById(id);
const main = document.querySelector('main');

const tiles = [...document.querySelectorAll('.bt .b')];
const hydration = $('hydration');
const hydrationValue = $('hydration-value');
const hydrationHint = $('hydration-hint');
const countLabel = $('count-label');
const countLess = $('count-less');
const countMore = $('count-more');
const countValue = $('count-value');
const weightLabel = $('weight-label');
const weightInput = $('weight');
const weightError = $('weight-error');
const stale = $('stale');
const empty = $('recipe-empty');
const card = $('formula-card');
const summary = $('formula-summary');
const totRow = $('formula-total');
const riseSection = $('rise-section');
const riseList = $('rise-list');
const bakeSection = $('bake-section');
const bakeList = $('bake-list');
const bakeNote = $('bake-note');

// The drawn sample rows are the rows to repeat: keep one copy of each, drop
// the samples, and fill fresh copies at render (fill.js's way).
const formulaRowTpl = (() => {
  const rows = [...card.querySelectorAll('.g:not(.k):not(.tot)')];
  const tpl = rows[0].cloneNode(true);
  for (const r of rows) r.remove();
  return tpl;
})();
const riseRowTpl = rowsFrom(riseList);
const bakeRowTpl = rowsFrom(bakeList);

// Line icons in the text colour, matching the drawn ones. Static strings.
const ICON_PATHS = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cold: '<path d="M12 3v18M5 7l14 10M19 7L5 17"/>',
  flame: '<path d="M12 3c3 4 5 6 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 1-9z"/>',
  water: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
};
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({
    width: '18', height: '18', viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(k, v);
  svg.innerHTML = ICON_PATHS[name] || '';
  return svg;
}

const MANY = { loaf: 'loaves', bagel: 'bagels' };
const CAP = { loaf: 'Loaves', bagel: 'Bagels' };

let type = 'sourdough';
let count = 2;
let weightTouched = false; // the field's value is the user's, not a default
let lastCalc = null; // { type, hydration, count, weight } of the rendered recipe

const bread = () => BREADS[type];

/** "1,800" — thousands separated, halves under 10 kept ("8.5"). */
const fmt = (n) => n.toLocaleString('en-US');
/** "197" or "198.5". */
const fmtPct = (p) => (p % 1 ? p.toFixed(1) : String(p));

/** "4 h 30 to 5 h 30", "8 to 14 h", "45 to 60 min". */
function fmtTime(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r}` : `${h} h`;
}
function fmtRange(a, b) {
  // Whole hours on both ends read compactly: "8 to 14 h".
  if (a >= 60 && a % 60 === 0 && b % 60 === 0) return `${a / 60} to ${b / 60} h`;
  return `${fmtTime(a)} to ${fmtTime(b)}`;
}

function unitWord(n) {
  return n === 1 ? bread().unit : MANY[bread().unit];
}

function currentInputs() {
  return { type, hydration: Number(hydration.value), count, weight: parseInt(weightInput.value, 10) };
}

function markStale() {
  if (!lastCalc) return;
  const now = currentInputs();
  stale.hidden = ['type', 'hydration', 'count', 'weight'].every((k) => now[k] === lastCalc[k]);
}

function updateStepper() {
  countLess.disabled = count <= 1;
  countMore.disabled = count >= 24;
  countValue.textContent = count;
  const many = MANY[bread().unit];
  countLess.setAttribute('aria-label', `Fewer ${many}`);
  countMore.setAttribute('aria-label', `More ${many}`);
}

function setType(t) {
  type = t;
  const b = bread();
  for (const tile of tiles) {
    const on = tile.dataset.type === t;
    tile.classList.toggle('on', on);
    tile.setAttribute('aria-pressed', String(on));
  }
  hydration.value = b.hydration;
  hydrationValue.textContent = `${b.hydration}%`;
  hydrationHint.textContent = b.hint;
  countLabel.textContent = CAP[b.unit];
  weightLabel.textContent = `Weight of each ${b.unit}`;
  // The count and a weight the user typed stay as they are; otherwise the
  // type's usual weight goes in.
  if (!weightTouched) weightInput.value = b.weight;
  updateStepper();
  markStale();
}

function validate() {
  const raw = weightInput.value.trim();
  const w = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(w >= 50 && w <= 3000)) {
    weightError.hidden = false;
    weightInput.setAttribute('aria-invalid', 'true');
    return null;
  }
  weightError.hidden = true;
  weightInput.removeAttribute('aria-invalid');
  return { type, hydration: Number(hydration.value), count, weight: w };
}

function render(inputs) {
  const r = calculate(inputs);
  lastCalc = { ...inputs };
  stale.hidden = true;
  empty.hidden = true;
  card.hidden = false;
  riseSection.hidden = false;
  bakeSection.hidden = false;

  summary.textContent = `${r.label}, ${inputs.count} ${unitWord(inputs.count)} of ${fmt(inputs.weight)} g, ${inputs.hydration}% hydration`;

  // A second Calculate starts from the first one's rows, not on top of them.
  for (const row of [...card.querySelectorAll('.g:not(.k):not(.tot)')]) row.remove();
  for (const ing of r.ingredients) {
    const row = formulaRowTpl.cloneNode(true);
    const [nameSpan, pc, gr] = row.children;
    nameSpan.textContent = ing.name;
    const bar = document.createElement('span');
    bar.className = 'bar';
    bar.style.width = `${Math.min(48, Math.max(2, Math.round(ing.pct * 0.48)))}px`;
    pc.replaceChildren(bar, document.createTextNode(`${fmtPct(ing.pct)}%`));
    gr.textContent = `${fmt(ing.grams)} g`;
    totRow.before(row);
  }
  const [totName, totPc, totGr] = totRow.children;
  totName.textContent = 'Total dough';
  totPc.replaceChildren(document.createTextNode(`${fmtPct(r.ingredients.reduce((s, i) => s + i.pct, 0))}%`));
  totGr.textContent = `${fmt(r.total)} g`;

  riseList.replaceChildren(...r.rise.map((stage) => fillIn(riseRowTpl(), {
    '.ic': { children: [icon(stage.place === 'fridge' ? 'cold' : 'clock')] },
    'div p:not(.sm)': stage.label,
    'div .sm': stage.note,
    '.tm': fmtRange(stage.min, stage.max),
  })));

  const bakeRows = [];
  if (bread().boil) {
    bakeRows.push(fillIn(bakeRowTpl(), {
      '.ic': { children: [icon('water')] },
      'div p:not(.sm)': 'Boil',
      'div .sm': '1 min each side',
      '.tm': '2 min',
    }));
  }
  for (const s of r.bake.stages) {
    bakeRows.push(fillIn(bakeRowTpl(), {
      '.ic': { children: [icon('flame')] },
      'div p:not(.sm)': s.label,
      'div .sm': s.note,
      '.tm': `${s.c}°C, ${s.minutes} min`,
    }));
  }
  bakeList.replaceChildren(...bakeRows);

  const parts = [];
  if (type === 'sourdough' && inputs.count > 1) parts.push('Bake one loaf at a time.');
  parts.push(`${r.bake.stages.map((s) => `${s.c}°C is ${toFahrenheit(s.c)}°F`).join(', ')}.`);
  bakeNote.textContent = parts.join(' ');
}

// ── Events ────────────────────────────────────────────────────────────────
for (const tile of tiles) tile.addEventListener('click', () => setType(tile.dataset.type));

hydration.addEventListener('input', () => {
  hydrationValue.textContent = `${hydration.value}%`;
  markStale();
});

countLess.addEventListener('click', () => { count = Math.max(1, count - 1); updateStepper(); markStale(); });
countMore.addEventListener('click', () => { count = Math.min(24, count + 1); updateStepper(); markStale(); });

weightInput.addEventListener('input', () => {
  weightTouched = true;
  weightError.hidden = true;
  weightInput.removeAttribute('aria-invalid');
  markStale();
});

$('calculate').addEventListener('click', () => {
  const inputs = validate();
  if (inputs) render(inputs);
});

// ── Start ─────────────────────────────────────────────────────────────────
if (isDemo()) {
  showDemoLabel(main, 'Staging demo: sample settings filled in, nothing is saved.');
}
setType('sourdough');
if (isDemo()) {
  const inputs = validate(); // the filled-in demo values
  if (inputs) render(inputs);
}
