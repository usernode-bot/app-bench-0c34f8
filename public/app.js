// app.js: Bread Bot's one screen. The maths live in bread.js; this file
// draws them and keeps each kind's settings in localStorage.
//
// The three number fields update the recipe as they are typed into: an
// out-of-range value keeps its place in the field, marks the field
// aria-invalid, and swaps the results for one line that says what to fix.
// On blur the value is clamped back into range.

import { h, api, isDemo } from '/kit/dom.js';
import { showDemoLabel } from '/kit/demo.js';
import { BREADS, KIND_ORDER, calculate, clampSettings, validate, zoneOf, gaugeNote } from '/bread.js';

const STORE_KEY = 'breadbot:v1';

// Stage and kind icons, drawn from the app's subject. Static strings only.
const ICONS = {
  sourdough: '<path d="M3 17c0-5.5 4-9.5 9-9.5s9 4 9 9.5z"/><path d="M8.5 12.5c2-1.6 5-1.6 7 0"/><path d="M2 17h20"/>',
  bagels: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/>',
  sourdoughBagels: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3"/><path d="M7.5 7.5l1 .7M16.5 7.5l-1 .7M17 15.5l-1-.4M7 15.5l1-.4"/>',
  rye: '<ellipse cx="12" cy="13" rx="9.5" ry="5.5"/><path d="M7 10.5l1.5 3M11 9.5l1.5 3M15 10l1.5 3"/>',
  sandwich: '<path d="M5 20v-8.6A3.4 3.4 0 0 1 4 9c0-2.3 2-4 4.5-4h7C18 5 20 6.7 20 9a3.4 3.4 0 0 1-1 2.4V20z"/><path d="M5 20h14"/>',
  lid: '<path d="M4 13h16v4a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/><path d="M2.5 13h19"/><path d="M9 10h6M12 10V8"/>',
  pot: '<path d="M4 13h16v4a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/><path d="M2.5 13h19"/>',
  boil: '<path d="M4 13h16v4a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z"/><path d="M2.5 13h19"/><path d="M8 9.5c1-1 2-1 3 0M13 9.5c1-1 2-1 3 0"/>',
  timer: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.5M10 3h4"/>',
};

function svgEl(paths, cls) {
  const el = h('span', { class: cls, 'aria-hidden': 'true' });
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="h-full w-full">${paths}</svg>`;
  return el;
}

// ── state ─────────────────────────────────────────────────────────────────

let storageOn = true;
const state = { kind: 'sourdough', byKind: {} };
let draft = null; // the numbers the three fields hold right now
const refs = {};

/** The kind's saved settings (its defaults on first visit). */
function settings() {
  if (!state.byKind[state.kind]) {
    state.byKind[state.kind] = { ...BREADS[state.kind].defaults };
  }
  return { kind: state.kind, ...state.byKind[state.kind] };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!saved || !BREADS[saved.kind]) return;
    state.kind = saved.kind;
    for (const key of Object.keys(BREADS)) {
      if (saved.byKind && saved.byKind[key]) {
        state.byKind[key] = clampSettings({ kind: key, ...saved.byKind[key] });
      }
    }
  } catch { /* private mode or bad JSON: the defaults are fine */ }
}

function save() {
  if (!storageOn) return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

// ── the dough card ────────────────────────────────────────────────────────

// A position on the 50 to 90 gauge, as a percentage of the track.
const pct = (v) => `${((v - 50) / 40) * 100}%`;

const parse = (el) => (el.value.trim() === '' ? NaN : Number(el.value));

const validateDraft = () => validate({ ...draft, kind: state.kind });

/** Re-read a field on blur: clamp it into range, or restore the saved value. */
const normalize = (key) => {
  const base = Number.isFinite(draft[key]) ? draft[key] : settings()[key];
  applyChange(key, clampSettings({ ...draft, kind: state.kind, [key]: base })[key], null);
};

/** Step a stepper button, from the last valid value when the field is mid-edit. */
const nudge = (key, delta) => {
  const base = Number.isFinite(draft[key]) ? draft[key] : settings()[key];
  applyChange(key, clampSettings({ ...draft, kind: state.kind, [key]: base + delta })[key], null);
};

function applyChange(key, value, source) {
  draft = { ...draft, [key]: value };
  syncControls(source);
  const v = validateDraft();
  if (!v.hydration && !v.count && !v.size) {
    state.byKind[state.kind] = clampSettings({ ...draft, kind: state.kind });
    save();
  }
  updateResults();
}

function setHint(input, hint, message) {
  if (message) {
    input.setAttribute('aria-invalid', 'true');
    hint.textContent = message;
    hint.hidden = false;
  } else {
    input.removeAttribute('aria-invalid');
    hint.hidden = true;
  }
}

/** Push the draft into every control except the one being typed into. */
function syncControls(source) {
  const kind = BREADS[state.kind];
  const hydration = Number.isFinite(draft.hydration) ? draft.hydration : settings().hydration;
  const shown = Math.min(90, Math.max(50, Math.round(hydration)));
  if (source !== 'gauge') refs.gauge.value = String(shown);
  refs.gauge.setAttribute('aria-valuetext', `${shown} percent, ${zoneOf(shown)}`);
  refs.fill.style.width = pct(shown);
  refs.gaugeNote.textContent = gaugeNote(state.kind, shown);
  if (source !== 'hydration') refs.hydration.value = String(shown);

  const count = Number.isFinite(draft.count) ? draft.count : settings().count;
  const size = Number.isFinite(draft.size) ? draft.size : settings().size;
  if (source !== 'count') refs.count.value = String(count);
  if (source !== 'size') refs.size.value = String(size);
  refs.countMinus.disabled = Math.round(count) <= kind.ranges.count[0];
  refs.countPlus.disabled = Math.round(count) >= kind.ranges.count[1];
  refs.sizeMinus.disabled = Math.round(size) <= kind.ranges.size[0];
  refs.sizePlus.disabled = Math.round(size) >= kind.ranges.size[1];

  const v = validateDraft();
  setHint(refs.hydration, refs.hydrationHint, v.hydration);
  setHint(refs.count, refs.countHint, v.count);
  setHint(refs.size, refs.sizeHint, v.size);
}

function buildDough() {
  const kind = BREADS[state.kind];
  const s = settings();
  draft = { hydration: s.hydration, count: s.count, size: s.size };
  const box = document.getElementById('dough');
  box.replaceChildren();

  // The gauge: track with the typical-range band and the wheat fill, and a
  // transparent range input on top whose thumb is the handle.
  refs.band = h('div', { class: 'gauge-band' });
  refs.fill = h('div', { class: 'gauge-fill' });
  refs.gauge = h('input', {
    type: 'range', class: 'gauge-input', min: '50', max: '90', step: '1',
    'aria-label': 'Hydration',
  });
  refs.gauge.addEventListener('input', () => applyChange('hydration', Number(refs.gauge.value), 'gauge'));
  refs.band.style.left = pct(kind.typical.lo);
  refs.band.style.width = `${((kind.typical.hi - kind.typical.lo) / 40) * 100}%`;

  const zones = h('div', { class: 'flex justify-between px-0.5 text-small text-muted' },
    h('span', {}, 'Stiff'), h('span', {}, 'Soft'), h('span', {}, 'Slack'));

  refs.hydration = h('input', {
    type: 'number', inputmode: 'decimal', id: 'hydration-field',
    class: 'field w-20 text-right font-semibold tabular-nums',
    min: '50', max: '90', step: '1',
  });
  refs.hydration.addEventListener('input', () => applyChange('hydration', parse(refs.hydration), 'hydration'));
  refs.hydration.addEventListener('blur', () => normalize('hydration'));
  const hydrationHead = h('div', { class: 'flex items-end justify-between gap-3' },
    h('div', { class: 'flex flex-col' },
      h('label', { class: 'kit-label', for: 'hydration-field' }, 'Hydration'),
      h('span', { class: 'kit-hint' }, 'Water as a share of the flour'),
    ),
    h('div', { class: 'flex items-center gap-1' },
      refs.hydration,
      h('span', { class: 'text-small text-muted' }, '%'),
    ),
  );

  const stepper = (key, id, label, unit) => {
    const minus = h('button', { type: 'button', 'aria-label': unit ? `${kind.step.size} g less` : 'One fewer' },
      '−');
    const plus = h('button', { type: 'button', 'aria-label': unit ? `${kind.step.size} g more` : 'One more' },
      '+');
    const input = h('input', {
      type: 'number', inputmode: 'numeric', id,
      'aria-label': label, min: String(kind.ranges[key][0]), max: String(kind.ranges[key][1]),
      step: '1',
    });
    const stepSize = unit ? kind.step.size : 1; // loaves step by one, dough by grams
    input.addEventListener('input', () => applyChange(key, parse(input), key));
    input.addEventListener('blur', () => normalize(key));
    minus.addEventListener('click', () => nudge(key, -stepSize));
    plus.addEventListener('click', () => nudge(key, stepSize));
    refs[key] = input;
    refs[`${key}Minus`] = minus;
    refs[`${key}Plus`] = plus;
    const row = h('div', { class: 'stepper' }, minus, input,
      ...(unit ? [h('span', { class: 'stepper-unit' }, unit)] : []), plus);
    return row;
  };

  refs.gaugeNote = h('p', { class: 'text-small text-muted' }, '');
  refs.hydrationHint = h('p', { class: 'kit-hint text-danger', hidden: true });
  refs.countHint = h('p', { class: 'kit-hint text-danger', hidden: true });
  refs.sizeHint = h('p', { class: 'kit-hint text-danger', hidden: true });

  const countLabel = kind.unit.many === 'bagels' ? 'Bagels' : 'Loaves';
  box.append(h('div', { class: 'card flex flex-col gap-4' },
    hydrationHead,
    h('div', { class: 'flex flex-col gap-1' },
      h('div', { class: 'gauge' },
        h('div', { class: 'gauge-track' }, refs.band, refs.fill,
          h('div', { class: 'gauge-zone', style: 'left:30%' }),
          h('div', { class: 'gauge-zone', style: 'left:62.5%' })),
        refs.gauge),
      zones),
    refs.gaugeNote,
    refs.hydrationHint,
    h('div', { class: 'grid grid-cols-2 gap-3' },
      h('div', { class: 'flex flex-col gap-1' },
        h('label', { class: 'kit-label', for: 'count-field' }, countLabel),
        stepper('count', 'count-field', countLabel),
        refs.countHint),
      h('div', { class: 'flex flex-col gap-1' },
        h('label', { class: 'kit-label', for: 'size-field' }, `Dough per ${kind.unit.one}`),
        stepper('size', 'size-field', `Dough per ${kind.unit.one}`, 'g'),
        refs.sizeHint)),
  ));

  syncControls(null);
  updateResults();
}

// ── the results ───────────────────────────────────────────────────────────

/** One line instead of the recipe, naming the field to fix. */
function invalidLine(field) {
  const kind = BREADS[state.kind];
  const [lo, hi] = kind.ranges[field];
  const text = field === 'hydration'
    ? `Set hydration between ${lo} and ${hi} percent to see the recipe.`
    : field === 'count'
      ? `Set the number of ${kind.unit.many} between ${lo} and ${hi} to see the recipe.`
      : `Set the dough per ${kind.unit.one} between ${lo} and ${hi} g to see the recipe.`;
  return h('div', { class: 'state-empty' }, h('p', { class: 'text-body text-muted' }, text));
}

function updateResults() {
  const box = refs.results;
  box.replaceChildren();
  const v = validateDraft();
  const firstBad = ['hydration', 'count', 'size'].find((key) => v[key]);
  if (firstBad) {
    box.append(invalidLine(firstBad));
    return;
  }

  const calc = calculate(clampSettings({ ...draft, kind: state.kind }));
  const kind = BREADS[state.kind];
  const countWord = `${calc.count} ${calc.count === 1 ? kind.unit.one : kind.unit.many}`;

  const rows = calc.ingredients.map((ing) => h('li', { class: 'list-row items-start' },
    h('div', { class: 'kit-row-text' },
      h('span', { class: 'kit-row-title' }, ing.name),
      ...(ing.note ? [h('span', { class: 'row-note' }, ing.note)] : [])),
    h('div', { class: 'grams' }, String(ing.grams), h('span', { class: 'unit' }, ' g'))));
  rows.push(h('li', { class: 'list-row bg-raised' },
    h('span', { class: 'kit-row-title' }, 'Total'),
    h('div', { class: 'grams' }, String(calc.total), h('span', { class: 'unit' }, ' g'))));

  const ingredients = h('section', { class: 'flex flex-col gap-2' },
    h('div', { class: 'flex items-baseline justify-between gap-3 px-1' },
      h('h2', { class: 'font-display text-heading' }, 'Ingredients'),
      h('span', { class: 'text-small tabular-nums text-muted' }, `${countWord} of ${calc.size} g`)),
    h('ul', { class: 'list' }, rows),
    ...(calc.usesStarter ? [h('p', { class: 'px-1 text-small text-muted' },
      `The ${calc.hydration}% counts the flour and water inside the starter too.`)] : []));

  const riseRows = calc.rise.steps.map((step, i) => h('li', { class: 'list-row items-start' },
    h('span', { class: `step-num${step.rise ? ' step-num-rise' : ''}` }, String(i + 1)),
    h('div', { class: 'kit-row-text' },
      h('span', { class: 'kit-row-title' }, step.name),
      h('span', { class: 'row-note' }, step.hint)),
    h('span', { class: 'shrink-0 text-small font-medium tabular-nums text-fg' }, step.duration)));
  const rise = h('section', { class: 'flex flex-col gap-2' },
    h('div', { class: 'flex items-baseline justify-between gap-3 px-1' },
      h('h2', { class: 'font-display text-heading' }, 'Rise schedule'),
      h('span', { class: 'text-small text-muted' }, calc.rise.total)),
    h('ol', { class: 'list' }, riseRows),
    h('p', { class: 'px-1 text-small text-muted' },
      'Times assume a kitchen around 24 °C. Warmer rises faster.'));

  const bakeRows = calc.bake.stages.map((stage) => h('li', { class: 'list-row items-start' },
    svgEl(ICONS[stage.icon], 'mt-0.5 h-6 w-6 shrink-0 text-muted'),
    h('div', { class: 'kit-row-text' },
      h('span', { class: 'kit-row-title' }, stage.text),
      ...(stage.done ? [h('span', { class: 'row-note' }, stage.done)] : []))));
  const notes = [calc.bake.oneAtATime, calc.bake.cool].filter(Boolean).join(' ');
  if (notes) {
    bakeRows.push(h('li', { class: 'list-row items-start' },
      svgEl(ICONS.timer, 'mt-0.5 h-6 w-6 shrink-0 text-muted'),
      h('span', { class: 'kit-row-title' }, notes)));
  }
  const bake = h('section', { class: 'flex flex-col gap-2' },
    h('div', { class: 'flex items-baseline justify-between gap-3 px-1' },
      h('h2', { class: 'font-display text-heading' }, 'Bake'),
      h('span', { class: 'text-small font-medium tabular-nums text-muted' },
        `${calc.bake.minutes} min ${calc.bake.per}`)),
    h('div', { class: 'card flex flex-col gap-3' },
      h('div', { class: 'flex items-baseline gap-2' },
        h('span', { class: 'font-display text-title tabular-nums text-accent' }, `${calc.bake.tempC} °C`),
        h('span', { class: 'text-small tabular-nums text-muted' }, `${calc.bake.tempF} °F`)),
      h('p', { class: 'text-small text-muted' }, calc.bake.preheat),
      h('ul', { class: 'list' }, bakeRows)));

  box.append(ingredients, rise, bake);
}

// ── the kind tiles ────────────────────────────────────────────────────────

function buildKinds() {
  refs.tiles = {};
  const box = document.getElementById('kinds');
  box.replaceChildren();
  for (const key of KIND_ORDER) {
    const tile = h('button', {
      type: 'button', class: 'kind-tile',
      'aria-pressed': String(key === state.kind),
      on: { click: () => setKind(key) },
    }, svgEl(ICONS[key], 'kind-icon'), h('span', {}, BREADS[key].name));
    refs.tiles[key] = tile;
    box.append(tile);
  }
}

function setKind(key) {
  if (state.kind === key) return;
  state.kind = key;
  save();
  for (const [k, tile] of Object.entries(refs.tiles)) {
    tile.setAttribute('aria-pressed', String(k === key));
  }
  buildDough();
}

// ── start (buildDough renders the first results too) ──────────────────────

// ── staging demo ──────────────────────────────────────────────────────────

/** With ?demo=1 in staging, open on sample settings and write nothing. */
async function loadDemo() {
  try {
    const data = await api('GET', '/api/demo');
    if (!data || !data.demo || !data.settings) return;
    storageOn = false;
    state.kind = data.settings.kind;
    state.byKind[state.kind] = clampSettings({ kind: data.settings.kind, ...data.settings });
    buildKinds();
    buildDough();
    showDemoLabel(document.getElementById('app'),
      'Staging demo: sample settings for a weekend sourdough bake.');
  } catch { /* no demo endpoint here: keep the viewer's own settings */ }
}

// ── start ─────────────────────────────────────────────────────────────────

refs.results = document.getElementById('results');
loadState();
buildKinds();
buildDough();
if (isDemo()) loadDemo();