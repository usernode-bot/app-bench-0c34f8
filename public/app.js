// Bread Bot: pick a bread, set the dough, tap Calculate. All the maths
// lives in recipes.js; this file holds the state and fills the screen the
// spec drew (kept in index.html, styled by screens.css), using its drawn
// rows as the templates.

import { isDemo } from '/kit/dom.js';
import { showDemoLabel } from '/kit/demo.js';
import { rowsFrom, fillIn } from '/kit/fill.js';
import { calculate, BREADS, formatGrams } from '/recipes.js';

const root = document.querySelector('[data-spec-screen="1"]');
const cardSlot = root.querySelector('[data-card-slot]');
const emptyState = root.querySelector('[data-empty]');
const errorState = root.querySelector('[data-error-state]');
const errorText = root.querySelector('[data-error-text]');
const card = root.querySelector('[data-recipe]');
const stale = root.querySelector('[data-stale]');

const rows = {
  hydration: root.querySelector('[data-setting="hydration"]'),
  count: root.querySelector('[data-setting="count"]'),
  flour: root.querySelector('[data-setting="flour"]'),
};

// The drawn formula row and step, to repeat for each ingredient and step.
// The header row of the formula is kept as drawn; rowsFrom repeats only
// the sample row beneath it.
const formulaList = root.querySelector('.formula');
const formulaHead = formulaList.querySelector('li.hd');
const formulaRow = rowsFrom(formulaList, 'li:not(.hd)');
const stepRow = rowsFrom(root.querySelector('.steps'), 'li');

// Sensible starting dough: two loaves of sourdough.
let state = { kind: 'sourdough', hydration: 75, count: 2, flour: 500 };

const LIMITS = { hydration: [50, 100], count: [1, 24] };
const unitPlural = (unit, n) => (n === 1 ? unit : unit === 'loaf' ? 'loaves' : unit + 's');

// ── Icons: the line drawings the steps use ────────────────────────────────
const ICON_PATHS = {
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  dough: '<path d="M3 17a9 8 0 0 1 18 0z"/><path d="M12 9V5M9 6l3-2 3 2"/>',
  oven: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><rect x="7" y="12" width="10" height="5" rx="1"/>',
};

function stepIcon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = ICON_PATHS[name] || '';
  return svg;
}

// ── The settings rows ─────────────────────────────────────────────────────
function renderRows() {
  const bread = BREADS[state.kind];
  rows.hydration.querySelector('[data-value]').textContent = `${state.hydration} %`;
  rows.count.querySelector('[data-value]').textContent = String(state.count);
  rows.count.querySelector('[data-label]').textContent = bread.unit === 'loaf' ? 'Loaves' : 'Bagels';
  rows.flour.querySelector('[data-label]').textContent = `Flour per ${bread.unit}`;
  rows.flour.querySelector('[data-input]').value = String(state.flour);
  for (const [name, row] of Object.entries(rows)) {
    const [lo, hi] = LIMITS[name] || [];
    for (const btn of row.querySelectorAll('[data-step]')) {
      btn.disabled = btn.dataset.step === 'down' ? state[name] <= lo : state[name] >= hi;
    }
  }
}

function setFieldError(name, message) {
  const p = rows[name].querySelector('[data-error]');
  if (!message) { p.hidden = true; p.textContent = ''; return; }
  p.hidden = false;
  p.textContent = message;
}

function clearErrors() {
  for (const name of Object.keys(rows)) setFieldError(name, null);
}

// ── The recipe card ───────────────────────────────────────────────────────
function renderCard({ ingredients, total, steps }) {
  const bread = BREADS[state.kind];
  card.querySelector('[data-title]').textContent =
    `${bread.label}, ${state.count} ${unitPlural(bread.unit, state.count)}`;
  card.querySelector('[data-total]').textContent = `${formatGrams(total)} g dough`;
  stale.hidden = true;

  const ul = card.querySelector('.formula');
  ul.replaceChildren(formulaHead, ...ingredients.map((ing) => fillIn(formulaRow(), {
    ':scope > span:first-child': ing.name,
    'span.g': `${formatGrams(ing.grams)} g`,
    'span.pc': String(ing.pct),
  })));

  const ol = card.querySelector('.steps');
  ol.replaceChildren(...steps.map((step) => {
    const li = fillIn(stepRow(), {
      'p.text-small.muted': step.title,
      'p.big': step.lines[0],
      'p.note': step.note,
      ':scope > .ic': { children: [stepIcon(step.icon)] },
    });
    // A bake with two stages draws its second line under the first.
    for (const line of step.lines.slice(1)) {
      const big = li.querySelector('p.big');
      big.after(big.cloneNode(true));
      big.nextSibling.textContent = line;
    }
    return li;
  }));
}

function showCard(on) {
  emptyState.hidden = on;
  errorState.hidden = on;
  card.hidden = !on;
}

function calculateNow() {
  const result = calculate(state);
  if (result.errors) {
    clearErrors();
    for (const [name, message] of Object.entries(result.errors)) {
      if (name in rows) setFieldError(name, message);
    }
    errorText.textContent = Object.values(result.errors).join('. ') + '.';
    showCard(false);
    return;
  }
  clearErrors();
  renderCard(result);
  showCard(true);
}

// Any change after a calculation makes the card stale until Calculate again.
function changed(name) {
  if (!card.hidden) stale.hidden = false;
  if (name) setFieldError(name, null);
}

// ── Wiring the drawn screen ───────────────────────────────────────────────
for (const chip of root.querySelectorAll('[data-bread]')) {
  const kind = chip.dataset.bread;
  const pick = () => {
    if (state.kind === kind) return;
    state = {
      kind,
      hydration: BREADS[kind].hydration,
      count: state.count,
      flour: BREADS[kind].flour,
    };
    renderRows();
    syncChips();
    clearErrors();
    changed();
  };
  chip.addEventListener('click', pick);
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
  });
}

function syncChips() {
  for (const chip of root.querySelectorAll('[data-bread]')) {
    const on = chip.dataset.bread === state.kind;
    chip.classList.toggle('on', on);
    chip.setAttribute('aria-pressed', String(on));
  }
}

function nudge(name, dir) {
  const [lo, hi] = LIMITS[name];
  state[name] = Math.min(hi, Math.max(lo, state[name] + dir));
  renderRows();
  changed(name);
}

for (const [name, row] of Object.entries(rows)) {
  for (const btn of row.querySelectorAll('[data-step]')) {
    btn.addEventListener('click', () => nudge(name, btn.dataset.step === 'down' ? -1 : 1));
  }
}

rows.flour.querySelector('[data-input]').addEventListener('input', (e) => {
  const raw = e.target.value.trim();
  state.flour = raw === '' ? NaN : Number(raw);
  changed('flour');
});

root.querySelector('[data-calculate]').addEventListener('click', () => {
  syncChips();
  calculateNow();
});

// ── Staging demo (?demo=1 on staging): example settings, calculated once ──
if (isDemo() && document.documentElement.dataset.env === 'staging') {
  showDemoLabel(document.getElementById('app'), 'Staging demo: example settings filled in.');
  state = { kind: 'sourdough', hydration: 78, count: 2, flour: 500 };
}

renderRows();
syncChips();
if (isDemo() && document.documentElement.dataset.env === 'staging') calculateNow();