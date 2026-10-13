// Bread Bot: a few settings in, an exact recipe out. Everything is worked
// out in the browser (the spec's calculation); nothing is fetched or saved,
// and each visit starts fresh.

import { h, clear, isDemo } from './kit/dom.js';

const $ = (id) => document.getElementById(id);

// The breads, with their usual numbers: salt and the leaven as baker's
// percentages, the bake loss, the rise times (fixed per bread), and the
// bake with the loaf weight it is measured at. `min` is each rise stage's
// midpoint in minutes, for the timeline strip's widths.
const BREADS = {
  sourdough: {
    name: 'Sourdough', hyd: 75, loss: 0.12, unit: 'loaf', unitPlural: 'loaves',
    leaven: { label: 'Starter', pct: 20 },
    flours: [{ label: 'Bread flour', pct: 100 }],
    bulk: { time: '4 to 5 h', sub: 'Covered, at 24 °C, with folds', min: 270 },
    proof: { time: '1 to 2 h', sub: 'Shaped, until it springs back slowly', min: 90 },
    boil: null,
    bake: { c: 230, base: 45, ref: 900, sub: 'Covered 20 min, then uncovered' },
  },
  bagels: {
    name: 'Bagels', hyd: 58, loss: 0.10, unit: 'bagel', unitPlural: 'bagels',
    leaven: { label: 'Instant yeast', pct: 1, halfGram: true },
    flours: [{ label: 'Bread flour', pct: 100 }],
    bulk: { time: '1 h', sub: 'At room temperature', min: 60 },
    proof: { time: '45 min', sub: 'Shaped, until puffy', min: 45 },
    boil: { time: '1 min a side', sub: 'Then back onto the tray' },
    bake: { c: 220, base: 20, ref: 110, sub: 'On a lined tray' },
  },
  'sourdough-bagels': {
    name: 'Sourdough bagels', hyd: 58, loss: 0.10, unit: 'bagel', unitPlural: 'bagels',
    leaven: { label: 'Starter', pct: 20 },
    flours: [{ label: 'Bread flour', pct: 100 }],
    bulk: { time: '4 h', sub: 'At room temperature', min: 240 },
    proof: { time: '1 h', sub: 'Shaped, until puffy', min: 60 },
    boil: { time: '1 min a side', sub: 'Then back onto the tray' },
    bake: { c: 220, base: 22, ref: 110, sub: 'On a lined tray' },
  },
  rye: {
    name: 'Rye', hyd: 80, loss: 0.12, unit: 'loaf', unitPlural: 'loaves',
    leaven: { label: 'Starter', pct: 25 },
    flours: [{ label: 'Rye flour', pct: 70 }, { label: 'Bread flour', pct: 30 }],
    bulk: { time: '2 to 3 h', sub: 'At room temperature', min: 150 },
    proof: { time: '1 h', sub: 'Shaped, until it springs back slowly', min: 60 },
    boil: null,
    bake: { c: 230, base: 55, ref: 900, sub: 'With steam for the first 20 min' },
  },
  sandwich: {
    name: 'Sandwich loaf', hyd: 65, loss: 0.10, unit: 'loaf', unitPlural: 'loaves',
    leaven: { label: 'Instant yeast', pct: 1, halfGram: true },
    flours: [{ label: 'Bread flour', pct: 100 }],
    bulk: { time: '1 to 1.5 h', sub: 'At room temperature', min: 75 },
    proof: { time: '45 to 60 min', sub: 'In the tin, until it crowns the rim', min: 52 },
    boil: null,
    bake: { c: 190, base: 35, ref: 900, sub: 'On the middle rack' },
  },
};

const SALT_PCT = 2;
const MIN_WEIGHT = 50;
const MAX_WEIGHT = 3000;

const state = { bread: 'sourdough', hyd: 75, loaves: 2 };

// The calculation: dough from the baked weight and the bake loss, every
// ingredient from the flour and its baker's percentage. Grams round to whole
// numbers, yeast to the half gram. Bake time grows with loaf size as the
// cube root of the weight against the bread's reference loaf, to the nearest
// 5 minutes; the rise times stay fixed.
function calc() {
  const b = BREADS[state.bread];
  const weight = Number($('weight').value);
  const dough = state.loaves * weight / (1 - b.loss);
  const pctSum = 100 + state.hyd + SALT_PCT + b.leaven.pct;
  const flour = dough / (pctSum / 100);
  const leavenG = b.leaven.halfGram
    ? Math.round(flour * b.leaven.pct / 100 * 2) / 2
    : Math.round(flour * b.leaven.pct / 100);
  const rows = [
    ...b.flours.map((f) => ({ label: f.label, g: Math.round(flour * f.pct / 100), pct: f.pct })),
    { label: 'Water', g: Math.round(flour * state.hyd / 100), pct: state.hyd },
    { label: b.leaven.label, g: leavenG, pct: b.leaven.pct },
    { label: 'Salt', g: Math.round(flour * SALT_PCT / 100), pct: SALT_PCT },
  ];
  return {
    b,
    rows,
    // The dough line is the sum of the listed grams, so the sheet adds up.
    total: rows.reduce((sum, r) => sum + r.g, 0),
    pctSum,
    bakeMin: Math.max(5, Math.round((b.bake.base * Math.cbrt(weight / b.bake.ref)) / 5) * 5),
  };
}

// "1,038 g", and a half gram for yeast where it matters.
const fmtG = (g) => `${g.toLocaleString('en-US', Number.isInteger(g) ? {} : { minimumFractionDigits: 1 })} g`;
const units = (b, n) => (n === 1 ? `1 ${b.unit}` : `${n} ${b.unitPlural}`);
// °F as the oven charts give it: to the nearest 25 °F (230 °C → 450 °F).
const toF = (c) => Math.round(((c * 9) / 5 + 32) / 25) * 25;

function render() {
  const b = BREADS[state.bread];

  for (const chip of document.querySelectorAll('#bread-types .chip')) {
    const on = chip.dataset.bread === state.bread;
    chip.classList.toggle('on', on);
    chip.setAttribute('aria-pressed', String(on));
  }
  $('hyd-val').textContent = `${state.hyd}%`;
  $('hydration').style.setProperty('--range-pct', `${((state.hyd - 50) / 40) * 100}%`);
  $('loaves-val').textContent = state.loaves;
  $('loaves-minus').disabled = state.loaves <= 1;
  $('loaves-plus').disabled = state.loaves >= 24;
  // Bagels change the words, not the maths.
  $('loaves-label').textContent = b.unit === 'bagel' ? 'Bagels' : 'Loaves';
  $('weight-unit').textContent = b.unit === 'bagel' ? 'per bagel' : 'per loaf';

  const raw = $('weight').value.trim();
  const n = Number(raw);
  const valid = raw !== '' && Number.isFinite(n) && n >= MIN_WEIGHT && n <= MAX_WEIGHT;
  const invalid = raw !== '' && !valid;
  $('weight-error').textContent = `Use a weight from ${MIN_WEIGHT.toLocaleString('en-US')} to ${MAX_WEIGHT.toLocaleString('en-US')} g`;
  $('weight-error').hidden = !invalid;
  if (invalid) $('weight').setAttribute('aria-invalid', 'true');
  else $('weight').removeAttribute('aria-invalid');

  // Blank weight: the empty sentence. Out of range: the recipe waits, and
  // the field says so. Otherwise: the recipe, live.
  $('recipe-empty').hidden = raw !== '';
  $('sheet').hidden = !valid;
  $('timeline').hidden = !valid;
  $('oven').hidden = !valid;
  if (!valid) return;

  const { b: bread, rows, total, pctSum, bakeMin } = calc();

  $('sheet-title').textContent = bread.name;
  $('sheet-sub').textContent = `${units(bread, state.loaves)} of ${n.toLocaleString('en-US')} g`;
  clear($('sheet-rows')).append(
    ...rows.map((r) => h('tr', null,
      h('td', null, r.label),
      h('td', { class: 'g' }, fmtG(r.g)),
      h('td', { class: 'p' }, `${r.pct}%`))),
    h('tr', { class: 'total' },
      h('td', null, 'Dough'),
      h('td', { class: 'g' }, fmtG(total)),
      h('td', { class: 'p' }, `${pctSum}%`)),
  );

  // The strip's widths follow the stage midpoints; the boil, when a bread
  // has one, is a short wheat step between shaping and the oven.
  const stages = [
    { cls: 's-mix', flex: 0.5, bg: 'rgb(var(--line))' },
    { cls: 's-bulk', flex: bread.bulk.min / 60, bg: 'rgb(var(--crumb))' },
    { cls: 's-shape', flex: 0.3, bg: 'rgb(var(--line))' },
    { cls: 's-proof', flex: bread.proof.min / 60, bg: 'rgb(var(--wheat))' },
    ...(bread.boil ? [{ cls: null, flex: 0.15, bg: 'rgb(var(--wheat))' }] : []),
    { cls: 's-bake', flex: bakeMin / 60, bg: 'rgb(var(--accent))' },
  ];
  clear($('strip')).append(...stages.map((s) => h('div', { class: s.cls, style: `flex:${s.flex};background:${s.bg}` })));

  const steps = [
    { dot: 'background:rgb(var(--crumb));border:1px solid rgb(var(--wheat))', title: 'Bulk rise', sub: bread.bulk.sub, time: bread.bulk.time },
    { dot: 'background:rgb(var(--wheat))', title: 'Final proof', sub: bread.proof.sub, time: bread.proof.time },
    ...(bread.boil ? [{ dot: 'background:rgb(var(--wheat))', title: 'Boil', sub: bread.boil.sub, time: bread.boil.time }] : []),
    { dot: 'background:rgb(var(--accent))', title: 'Bake', sub: bread.bake.sub, time: `${bakeMin} min` },
  ];
  clear($('timeline-rows')).append(...steps.map((s) => h('div', { class: 'list-row' },
    h('span', { class: 'dot', style: s.dot }),
    h('span', { class: 'row-main' }, s.title, h('br'), h('span', { class: 'text-small muted' }, s.sub)),
    h('span', { class: 'num' }, s.time))));

  $('oven-c').textContent = `${bread.bake.c} °C`;
  $('oven-c-sub').textContent = `${toF(bread.bake.c)} °F`;
  $('oven-time').textContent = `${bakeMin} min`;
  $('oven-time-sub').textContent = `for ${units(bread, state.loaves)}`;
}

// ── Wiring ──────────────────────────────────────────────────────────────────

for (const chip of document.querySelectorAll('#bread-types .chip')) {
  chip.addEventListener('click', () => {
    state.bread = chip.dataset.bread;
    // Each bread opens at its usual hydration.
    state.hyd = BREADS[state.bread].hyd;
    $('hydration').value = String(state.hyd);
    render();
  });
}
$('hydration').addEventListener('input', () => {
  state.hyd = Number($('hydration').value);
  render();
});
$('loaves-minus').addEventListener('click', () => {
  state.loaves = Math.max(1, state.loaves - 1);
  render();
});
$('loaves-plus').addEventListener('click', () => {
  state.loaves = Math.min(24, state.loaves + 1);
  render();
});
$('weight').addEventListener('input', render);

$('calculate').addEventListener('click', () => {
  const raw = $('weight').value.trim();
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n) || n < MIN_WEIGHT || n > MAX_WEIGHT) {
    $('weight').focus();
    return;
  }
  $('recipe').scrollIntoView({
    behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  });
});

// Staging demo (?demo=1 on a staging build only — data-staging on <html>):
// open on a recipe already worked out, every control still live. Production
// ignores ?demo=1. Idempotent: render() is a pure function of the settings.
if (isDemo() && document.documentElement.dataset.staging === '1') {
  state.bread = 'sourdough';
  state.hyd = 75;
  state.loaves = 2;
  $('hydration').value = '75';
  $('weight').value = '900';
  $('demo-note').hidden = false;
}
render();