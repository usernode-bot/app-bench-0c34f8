// Bread Bot: one screen that turns bread settings into a recipe.
// Pure client-side: nothing is fetched, nothing is stored, so reopening
// starts at sourdough again.

import { h, isDemo } from '/kit/dom.js';
import { toast } from '/kit/native.js';

const fmt = (n) => Math.round(n).toLocaleString('en-US');

// Path data for the rise-and-bake row icons, taken from the drawn screen.
const ICONS = {
  rise: ['M4 20h16M6 20c0-6 2.5-9 6-9s6 3 6 9', 'M12 7V3M9.5 5L12 3l2.5 2'],
  proof: ['M4 12a8 4 0 0016 0z', 'M8 9c1-2 2.5-3 4-3s3 1 4 3'],
  boil: ['M4 10h16v5a4 4 0 01-4 4H8a4 4 0 01-4-4z', 'M9 7c0-1 1-1 1-2M13 7c0-1 1-1 1-2M17 7c0-1 1-1 1-2'],
  ovenLid: ['M3 4h18v16H3z', 'M3 9h18M7 14h10M8 17h8'],
  oven: ['M3 4h18v16H3z', 'M3 9h18M7 14h10'],
};

const BREADS = {
  sourdough: {
    name: 'Sourdough',
    one: 'loaf', many: 'loaves',
    countLabel: 'Loaves', weightLabel: 'Each loaf weighs',
    waterSub: 'Lukewarm, about 27°C',
    hydration: 75, count: 2, weight: 900, sizes: [500, 750, 1000],
    starter: true, yeastPct: 0, extras: [],
    timing: [
      { icon: 'rise', t: 'Bulk rise', sub: 'Stretch and fold every 30 min for the first 2 h, at about 24°C', g: '4 to 6 h' },
      { icon: 'proof', t: 'Shape and proof', sub: 'In a floured basket, covered, in the fridge. Or 1 to 2 h at room temperature', g: '8 to 16 h' },
      { icon: 'ovenLid', t: 'Bake at 250°C (480°F)', sub: 'In a covered pot, lid on', g: '20 min' },
      { icon: 'oven', t: 'Then 230°C (450°F)', sub: 'Lid off, until deep brown and hollow when tapped', g: '20 to 25 min' },
    ],
    cooling: 'Cool for at least 1 hour before slicing.',
  },
  bagels: {
    name: 'Bagels',
    one: 'bagel', many: 'bagels',
    countLabel: 'Bagels', weightLabel: 'Each bagel weighs',
    waterSub: 'Cool, about 21°C',
    hydration: 58, count: 8, weight: 110, sizes: [90, 110, 130],
    starter: false, yeastPct: 0.01,
    extras: [{ t: 'Malt syrup', sub: 'In the dough, plus a spoon in the boiling water', pct: 0.03 }],
    timing: [
      { icon: 'rise', t: 'Bulk rise', sub: 'At room temperature, covered', g: '1 h' },
      { icon: 'proof', t: 'Shape and proof', sub: 'On a floured tray, covered, in the fridge', g: '8 to 12 h' },
      { icon: 'boil', t: 'Boil', sub: '1 minute a side, a few at a time', g: '1 min a side' },
      { icon: 'oven', t: 'Bake at 220°C (425°F)', sub: 'Until shiny and deep brown', g: '18 to 22 min' },
    ],
    cooling: 'Cool on a rack before toasting or eating.',
  },
  'sourdough-bagels': {
    name: 'Sourdough bagels',
    one: 'bagel', many: 'bagels',
    countLabel: 'Bagels', weightLabel: 'Each bagel weighs',
    waterSub: 'Cool, about 21°C',
    hydration: 60, count: 8, weight: 110, sizes: [90, 110, 130],
    starter: true, yeastPct: 0,
    extras: [{ t: 'Malt syrup', sub: 'In the dough, plus a spoon in the boiling water', pct: 0.03 }],
    timing: [
      { icon: 'rise', t: 'Bulk rise', sub: 'Stretch and fold every 30 min for the first 2 h, at about 24°C', g: '4 to 6 h' },
      { icon: 'proof', t: 'Shape and proof', sub: 'On a floured tray, covered, in the fridge', g: '8 to 12 h' },
      { icon: 'boil', t: 'Boil', sub: '1 minute a side, a few at a time', g: '1 min a side' },
      { icon: 'oven', t: 'Bake at 220°C (425°F)', sub: 'Until shiny and deep brown', g: '20 to 25 min' },
    ],
    cooling: 'Cool on a rack before toasting or eating.',
  },
  rye: {
    name: 'Rye',
    one: 'loaf', many: 'loaves',
    countLabel: 'Loaves', weightLabel: 'Each loaf weighs',
    waterSub: 'Lukewarm, about 27°C',
    hydration: 78, count: 1, weight: 900, sizes: [500, 750, 1000],
    starter: false, yeastPct: 0.015, extras: [],
    timing: [
      { icon: 'rise', t: 'Bulk rise', sub: 'At room temperature, covered; it will not double', g: '1 h' },
      { icon: 'proof', t: 'Shape and proof', sub: 'In a floured basket or a tin, at room temperature', g: '45 to 60 min' },
      { icon: 'ovenLid', t: 'Bake at 230°C (450°F)', sub: 'With steam, a tray of water below', g: '10 min' },
      { icon: 'oven', t: 'Then 200°C (400°F)', sub: 'Steam out, until firm to the touch', g: '40 to 50 min' },
    ],
    cooling: 'Wrap and rest for 12 hours before slicing.',
  },
  sandwich: {
    name: 'Sandwich loaf',
    one: 'loaf', many: 'loaves',
    countLabel: 'Loaves', weightLabel: 'Each loaf weighs',
    waterSub: 'Lukewarm, about 27°C',
    hydration: 65, count: 1, weight: 900, sizes: [500, 750, 1000],
    starter: false, yeastPct: 0.015,
    extras: [
      { t: 'Sugar', pct: 0.04 },
      { t: 'Butter', sub: 'Softened', pct: 0.06 },
    ],
    timing: [
      { icon: 'rise', t: 'Bulk rise', sub: 'In a bowl, covered, until doubled', g: '1 to 1.5 h' },
      { icon: 'proof', t: 'Shape and proof', sub: 'In a greased tin, until it crowns the rim', g: '45 to 60 min' },
      { icon: 'oven', t: 'Bake at 190°C (375°F)', sub: 'Until golden and hollow when tapped', g: '30 to 35 min' },
    ],
    cooling: 'Cool in the tin for 10 minutes, then on a rack.',
  },
};

const crumbWord = (h) => (h < 58 ? 'Stiff' : h < 66 ? 'Soft' : h < 78 ? 'Open and airy' : 'Wet and very open');

/**
 * compute(settings) -> { rows, total, note } for a valid dough weight, else
 * null. Pure: the grams follow baker's percentages for the bread, scaled to
 * the flour the loaf count and weight need. The starter is 100% hydration
 * (half flour, half water) at 20% of the flour, so its share is not an
 * addition: its flour and water already sit inside the flour and hydration
 * percentages, and the added flour and water are the rest.
 */
export function compute({ bread, hydration, count, weight }) {
  const b = BREADS[bread];
  const w = Number(weight);
  if (!Number.isFinite(w) || w < 50 || w > 3000) return null;
  const h = hydration / 100;
  const others = 0.02 + b.yeastPct + b.extras.reduce((s, e) => s + e.pct, 0);
  const F = (count * w) / (1 + h + others); // total flour, grams

  const rows = [];
  const add = (t, g, sub) => rows.push({ t, g: Math.round(g), sub: sub || null });
  if (b.starter) {
    add('Bread flour', F * 0.9);
    add('Water', (h - 0.1) * F, b.waterSub);
    add('Starter', F * 0.2, 'Fed and bubbly, half flour, half water');
  } else if (bread === 'rye') {
    add('Rye flour', F * 0.6, '60% rye, 40% bread flour');
    add('Bread flour', F * 0.4);
    add('Water', h * F, b.waterSub);
  } else {
    add('Bread flour', F);
    add('Water', h * F, b.waterSub);
  }
  add('Salt', F * 0.02);
  if (b.yeastPct) add('Instant yeast', F * b.yeastPct);
  for (const e of b.extras) add(e.t, F * e.pct, e.sub);
  const total = rows.reduce((s, r) => s + r.g, 0);
  rows.push({ t: 'Total dough', sub: b.starter ? "Hydration counts the starter's water" : 'Everything above, weighed and mixed', g: total, tot: true });

  let note = null;
  if (b.starter) {
    const starter = Math.round(F * 0.2);
    const x = Math.ceil((starter + 20) / 3);
    note = { x, leftover: x * 3 - starter };
  }
  return { rows, total, note, flour: F };
}

// ── The screen ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  wrap: document.querySelector('.wrap'),
  breads: $('breads'),
  meterFill: $('meter-fill'), meterPct: $('meter-pct'), meterCrumb: $('meter-crumb'),
  hydration: $('hydration'), rangeFill: $('range-fill'), rangeKnob: $('range-knob'),
  countLabel: $('count-label'), countValue: $('count-value'),
  countMinus: $('count-minus'), countPlus: $('count-plus'),
  weightLabel: $('weight-label'), weight: $('weight'), seg: $('seg'),
  recipeSub: $('recipe-sub'), copy: $('copy'), recipe: $('recipe'),
  recipeEmpty: $('recipe-empty'), emptyTitle: $('empty-title'), useMedium: $('use-medium'),
  timingSection: $('timing-section'), timing: $('timing'), cooling: $('cooling'),
};
const tplRow = $('tpl-recipe-row'), tplNote = $('tpl-note'), tplTiming = $('tpl-timing-row');

const state = { bread: 'sourdough', hydration: 75, count: 2, weight: 900 };

function setIcon(svg, name) {
  svg.replaceChildren(...(ICONS[name] || []).map((d) => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    return p;
  }));
}

function row(template, { t, sub, g, tot }) {
  const li = template.content.firstElementChild.cloneNode(true);
  li.querySelector('.t').textContent = t;
  const subEl = li.querySelector('.sub');
  if (sub) subEl.textContent = sub; else subEl.hidden = true;
  li.querySelector('.g').textContent = `${fmt(g)} g`;
  if (tot) li.classList.add('tot');
  return li;
}

function timingRow({ icon, t, sub, g }) {
  const li = tplTiming.content.firstElementChild.cloneNode(true);
  setIcon(li.querySelector('.ic'), icon);
  li.querySelector('.t').textContent = t;
  const subEl = li.querySelector('.sub');
  if (sub) subEl.textContent = sub; else subEl.hidden = true;
  li.querySelector('.g').textContent = g;
  return li;
}

function recipeText(out, b, s) {
  const lines = [`Bread Bot recipe: ${b.name}`,
    `${s.count} ${s.count === 1 ? b.one : b.many}, ${fmt(s.count * Number(s.weight))} g of dough, ${s.hydration}% hydration`,
    '', 'Ingredients'];
  for (const r of out.rows) lines.push(`${r.t}: ${fmt(r.g)} g`);
  if (out.note) lines.push('', `Feed your starter first: 4 to 12 hours before mixing, stir ${out.note.x} g starter, ${out.note.x} g flour and ${out.note.x} g water. Use it once it has doubled; the ${out.note.leftover} g left over keeps it going.`);
  lines.push('', 'Rise and bake');
  for (const t of b.timing) lines.push(`${t.t} (${t.g}): ${t.sub}`);
  lines.push(b.cooling);
  return lines.join('\n');
}

function render() {
  const b = BREADS[state.bread];
  const out = compute(state);

  // Bread list
  for (const btn of els.breads.querySelectorAll('button[data-bread]')) {
    const on = btn.dataset.bread === state.bread;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
  }

  // Hydration meter and slider
  const f = Math.min(1, Math.max(0, (state.hydration - 50) / 40));
  els.meterFill.setAttribute('y', String(60 - 48 * f));
  els.meterFill.setAttribute('height', String(48 * f + 4));
  els.meterPct.textContent = `${state.hydration}%`;
  els.meterCrumb.textContent = crumbWord(state.hydration);
  els.hydration.value = state.hydration;
  els.rangeFill.style.width = `${f * 100}%`;
  els.rangeKnob.style.left = `${f * 100}%`;

  // Count and weight
  els.countLabel.textContent = b.countLabel;
  els.countValue.textContent = state.count;
  els.countMinus.disabled = state.count <= 1;
  els.countPlus.disabled = state.count >= 24;
  els.countMinus.setAttribute('aria-label', `Fewer ${b.countLabel.toLowerCase()}`);
  els.countPlus.setAttribute('aria-label', `More ${b.countLabel.toLowerCase()}`);
  els.weightLabel.textContent = b.weightLabel;
  if (document.activeElement !== els.weight) els.weight.value = state.weight;

  // Size segments: grams follow the bread; the one matching the weight is selected
  for (const btn of els.seg.querySelectorAll('button')) {
    const size = Number(btn.dataset.size);
    btn.querySelector('.seg-g').textContent = `${fmt(size)} g`;
    btn.classList.toggle('sel', Number(state.weight) === size);
    btn.setAttribute('aria-pressed', String(Number(state.weight) === size));
  }

  // Recipe and timing, or the empty state when the weight is out of range
  const valid = !!out;
  els.copy.hidden = !valid;
  els.recipe.hidden = !valid;
  els.recipeEmpty.hidden = valid;
  els.timingSection.hidden = !valid;
  if (!valid) {
    els.recipeSub.textContent = '';
    els.emptyTitle.textContent = `Set how heavy each ${b.one} is`;
    els.useMedium.textContent = `Use ${fmt(b.sizes[1])} g`;
    return;
  }

  els.recipeSub.textContent = `${state.count} ${state.count === 1 ? b.one : b.many}, ${fmt(state.count * Number(state.weight))} g of dough`;
  els.recipe.replaceChildren(...out.rows.map((r) => row(tplRow, r)));
  if (out.note) {
    const li = tplNote.content.firstElementChild.cloneNode(true);
    li.querySelector('p').append(`4 to 12 hours before mixing, stir ${out.note.x} g starter, ${out.note.x} g flour and ${out.note.x} g water. Use it once it has doubled; the ${out.note.leftover} g left over keeps it going.`);
    els.recipe.append(li);
  }
  els.timing.replaceChildren(...b.timing.map(timingRow));
  els.cooling.textContent = b.cooling;
}

// ── Wiring ─────────────────────────────────────────────────────────────────
for (const btn of els.breads.querySelectorAll('button[data-bread]')) {
  btn.addEventListener('click', () => {
    state.bread = btn.dataset.bread;
    const b = BREADS[state.bread];
    state.hydration = b.hydration;
    state.count = b.count;
    state.weight = b.weight;
    render();
  });
}

els.hydration.addEventListener('input', () => { state.hydration = Number(els.hydration.value); render(); });

els.countMinus.addEventListener('click', () => { state.count = Math.max(1, state.count - 1); render(); });
els.countPlus.addEventListener('click', () => { state.count = Math.min(24, state.count + 1); render(); });

els.weight.addEventListener('input', () => { state.weight = els.weight.value; render(); });

for (const btn of els.seg.querySelectorAll('button')) {
  btn.addEventListener('click', () => {
    state.weight = btn.dataset.size;
    render();
  });
}

els.useMedium.addEventListener('click', () => {
  state.weight = BREADS[state.bread].sizes[1];
  render();
});

els.copy.addEventListener('click', () => {
  const out = compute(state);
  if (!out) return;
  const b = BREADS[state.bread];
  navigator.clipboard.writeText(recipeText(out, b, state)).then(
    () => toast('Recipe copied'),
    () => toast("Couldn't copy. Select the recipe and copy it instead."),
  );
});

if (isDemo()) {
  els.wrap.prepend(h('p', { class: 'kit-demo-label' }, 'Staging demo: a sample sourdough bake'));
}

render();
