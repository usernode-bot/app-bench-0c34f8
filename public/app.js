// Bread Bot's screen: pick a bread, set the dough, calculate the recipe slip.
// All client side: the maths lives in recipe.js, nothing is saved or sent.
import { BREADS, computeRecipe } from './recipe.js';

const app = document.querySelector('.app');
const slip = document.getElementById('slip');
const slipEmpty = document.getElementById('slip-empty');
const slipTitle = document.getElementById('slip-title');
const slipSub = document.getElementById('slip-sub');
const staleNote = document.getElementById('slip-stale');
const ingList = document.getElementById('ing');
const stepList = document.getElementById('steps');
const bakeBox = document.getElementById('bake');
const bakeNote = document.getElementById('bake-note');
const hydNum = document.getElementById('hyd-num');
const gaugeFill = document.getElementById('gauge-fill');
const gaugeThumb = document.getElementById('gauge-thumb');
const range = document.getElementById('hydration');
const countSpan = document.getElementById('count');
const countLabel = document.getElementById('count-label');
const minusBtn = document.getElementById('count-minus');
const plusBtn = document.getElementById('count-plus');
const sizeInput = document.getElementById('size');
const sizeLabel = document.getElementById('size-label');
const countError = document.getElementById('count-error');
const sizeError = document.getElementById('size-error');
const calcBtn = document.getElementById('calc');
const tiles = [...app.querySelectorAll('.kind')];

// The drawn rows are the templates to copy; one of each shape.
const ingRow = ingList.querySelector('.list-row:not(.total)').cloneNode(true);
const totalRow = ingList.querySelector('.list-row.total').cloneNode(true);
const stepRow = stepList.querySelector('li').cloneNode(true);
const ovenBox = bakeBox.querySelector('.oven').cloneNode(true);

let kind = BREADS[0];
let hydration = kind.hydration;
let count = 1;
let size = kind.size;
let calculated = false;

const fmtG = (n) => (n < 10 || !Number.isInteger(n) ? n.toFixed(1) : n.toLocaleString('en-US'));

function clearError(el) { el.hidden = true; el.textContent = ''; }
function showError(el, msg) { el.textContent = msg; el.hidden = false; }

function drawGauge() {
  hydNum.textContent = `${hydration}%`;
  const w = ((hydration - 50) / 40) * 100;
  gaugeFill.style.width = `${w}%`;
  gaugeThumb.style.left = `calc(${w}% - 14px)`;
}

function drawCount() {
  countSpan.textContent = String(count);
  minusBtn.disabled = count <= 1;
  plusBtn.disabled = count >= 24;
}

function drawWords() {
  countLabel.textContent = kind.bagels ? 'Bagels' : 'Loaves';
  sizeLabel.textContent = kind.bagels ? 'Each bagel weighs' : 'Each loaf weighs';
  minusBtn.setAttribute('aria-label', kind.bagels ? 'Fewer bagels' : 'Fewer loaves');
  plusBtn.setAttribute('aria-label', kind.bagels ? 'More bagels' : 'More loaves');
}

function markStale() {
  if (!calculated) return;
  slip.classList.add('stale');
  staleNote.hidden = false;
}

function selectKind(id) {
  const next = BREADS.find((b) => b.id === id);
  if (!next) return;
  const wasBagel = kind.bagels;
  kind = next;
  for (const t of tiles) {
    const on = t.dataset.kind === kind.id;
    t.classList.toggle('on', on);
    t.setAttribute('aria-pressed', String(on));
  }
  hydration = kind.hydration;
  range.value = String(hydration);
  if (wasBagel !== kind.bagels) {
    size = kind.size;
    sizeInput.value = String(size);
    clearError(sizeError);
  }
  drawGauge();
  drawWords();
}

function renderSlip(r) {
  const unit = count === 1 ? (kind.bagels ? 'bagel' : 'loaf') : (kind.bagels ? 'bagels' : 'loaves');
  slipTitle.textContent = `${kind.label}, ${count} ${unit} of ${fmtG(r.size)} g`;
  slipSub.textContent = `${fmtG(r.total)} g of dough at ${r.hydration}% hydration`;
  ingList.replaceChildren(...r.ingredients.map((i) => {
    const row = (i.total ? totalRow : ingRow).cloneNode(true);
    row.querySelector('.ing').textContent = i.name;
    row.querySelector('.pct').textContent = i.total ? '' : `${i.pct}%`;
    row.querySelector('.g').textContent = `${fmtG(i.grams)} g`;
    return row;
  }));
  stepList.replaceChildren(...r.steps.map((s, i) => {
    const row = stepRow.cloneNode(true);
    row.querySelector('.n').textContent = String(i + 1);
    row.querySelector('strong').textContent = s.title;
    row.querySelector('.sub').textContent = s.sub;
    return row;
  }));
  bakeBox.replaceChildren(...r.bake.map((b) => {
    const box = ovenBox.cloneNode(true);
    box.querySelector('.temp').textContent = `${b.temp} °C`;
    box.querySelector('.sub').textContent = `${b.minutes} min${b.note ? `, ${b.note}` : ''}`;
    return box;
  }));
  bakeNote.textContent = r.note;
  bakeNote.hidden = !r.note;
}

function calculate() {
  const size = Number(sizeInput.value);
  const recipe = computeRecipe({ kind: kind.id, hydration, count, size });
  if (recipe.errors) {
    if (recipe.errors.count) showError(countError, recipe.errors.count); else clearError(countError);
    if (recipe.errors.size) showError(sizeError, recipe.errors.size); else clearError(sizeError);
    return;
  }
  clearError(countError);
  clearError(sizeError);
  calculated = true;
  slip.classList.remove('stale');
  staleNote.hidden = true;
  slipEmpty.hidden = true;
  slip.hidden = false;
  renderSlip(recipe);
}

for (const t of tiles) t.addEventListener('click', () => { selectKind(t.dataset.kind); markStale(); });
range.addEventListener('input', () => { hydration = Number(range.value); drawGauge(); markStale(); });
minusBtn.addEventListener('click', () => { count = Math.max(1, count - 1); drawCount(); markStale(); });
plusBtn.addEventListener('click', () => { count = Math.min(24, count + 1); drawCount(); markStale(); });
sizeInput.addEventListener('input', () => { clearError(sizeError); markStale(); });
calcBtn.addEventListener('click', calculate);

// The staging demo (?demo=1 on staging only): the drawn bake, preset and calculated.
const staging = typeof window.BREAD_ENV === 'object' && window.BREAD_ENV && window.BREAD_ENV.staging === true;
const demo = staging && new URLSearchParams(window.location.search).get('demo') === '1';

// Empty the slip: the drawn values were samples; the real recipe fills it.
ingList.replaceChildren();
stepList.replaceChildren();
bakeBox.replaceChildren();
bakeNote.textContent = '';
bakeNote.hidden = true;
slip.hidden = true;

drawGauge();
drawCount();
drawWords();

if (demo) {
  count = 2;
  drawCount();
  const line = document.createElement('p');
  line.className = 'kit-demo-label';
  line.setAttribute('role', 'note');
  line.textContent = 'Staging demo: a sample bake. Change anything and calculate again.';
  app.querySelector('header').after(line);
  calculate();
}