// Bread Bot's page: renders the five bread pills, the dough controls, the
// formula sheet and the rise-and-bake timeline from one state object, and
// recomputes the recipe on every input — there is no Calculate button.
import { h, clear, api, isDemo, plural, icon } from '/kit/dom.js';
import { showDemoLabel } from '/kit/demo.js';
import { createStates } from '/kit/states.js';
import { BREADS, calculate, formatGrams, formatDuration } from './recipe.js';
import { breadIcon, ingredientIcon, minusIcon, plusIcon } from './icons.js';

const STORE_KEY = 'breadbot:v1';
const KINDS = Object.keys(BREADS);

const mainEl = document.querySelector('main');
const breadPills = document.getElementById('bread-pills');
const doughList = document.getElementById('dough-list');
const formulaBox = document.getElementById('formula');
const timelineBox = document.getElementById('timeline');

const demo = isDemo();
const state = { kind: 'sourdough', settings: {} };

// The demo fetch is shared: the formula and the timeline each run a task, but
// the choices load once.
let demoPromise = null;
let demoFailed = false;
let formulaStates = null;
let timelineStates = null;

const defaults = (kind) => {
  const b = BREADS[kind];
  return { hydration: b.hydration.def, count: b.count.def, size: b.sizeDef };
};
const settingsFor = (kind) => state.settings[kind] || (state.settings[kind] = defaults(kind));

// A saved setting set is honoured only when every field is a whole number
// inside its bread's ranges; otherwise that bread falls back to its defaults.
const inRange = (s, kind) => {
  const b = BREADS[kind];
  return s && typeof s === 'object'
    && Number.isInteger(s.size) && s.size >= 50 && s.size <= 3000
    && Number.isInteger(s.hydration) && s.hydration >= b.hydration.min && s.hydration <= b.hydration.max
    && Number.isInteger(s.count) && s.count >= 1 && s.count <= b.count.max;
};

function load() {
  if (demo) return;
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return;
    if (BREADS[raw.kind]) state.kind = raw.kind;
    if (raw.settings && typeof raw.settings === 'object') {
      for (const [kind, s] of Object.entries(raw.settings)) {
        if (inRange(s, kind)) state.settings[kind] = { hydration: s.hydration, count: s.count, size: s.size };
      }
    }
  } catch {}
}

function save() {
  if (demo) return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {}
}

let set = null; // the current bread's settings
let refs = {};
let formulaTarget = formulaBox;
let timelineTarget = timelineBox;

const bread = () => BREADS[state.kind];
const fmtNum = (n) => Math.round(n).toLocaleString('en-US');

function renderPills() {
  clear(breadPills).append(
    ...KINDS.map((kind) => h('button', {
      class: 'bread',
      type: 'button',
      'aria-pressed': kind === state.kind ? 'true' : 'false',
      on: { click: () => pick(kind) },
    }, breadIcon(kind), BREADS[kind].name)),
  );
}

function pick(kind) {
  if (state.kind === kind) return;
  state.kind = kind;
  set = settingsFor(kind);
  renderPills();
  renderDough();
  onUserChange();
}

function renderDough() {
  const b = bread();
  refs = {};
  clear(doughList).append(
    h('li', { class: 'list-row set' },
      h('div', { class: 'set-head' },
        h('span', null, 'Hydration'),
        refs.val = h('span', { class: 'val' }, `${set.hydration}%`)),
      h('input', {
        type: 'range',
        min: b.hydration.min,
        max: b.hydration.max,
        step: 1,
        value: set.hydration,
        'aria-label': 'Hydration',
        on: { input: (e) => {
          set.hydration = Number(e.target.value);
          refs.val.textContent = `${set.hydration}%`;
          refs.feel.textContent = feelNote();
          onUserChange();
        } },
      }),
      h('div', { class: 'ends text-small muted' },
        h('span', null, `${b.hydration.min}% firmer`),
        h('span', null, `${b.hydration.max}% wetter`)),
      refs.feel = h('p', { class: 'text-small muted' }, feelNote())),
    h('li', { class: 'list-row' },
      h('span', null, b.count.label),
      h('div', { class: 'stepper' },
        refs.minus = h('button', {
          class: 'btn-secondary', type: 'button',
          'aria-label': `One fewer ${b.count.unit}`,
          on: { click: () => step(-1) },
        }, minusIcon()),
        refs.n = h('span', { class: 'n' }, String(set.count)),
        refs.plus = h('button', {
          class: 'btn-secondary', type: 'button',
          'aria-label': `One more ${b.count.unit}`,
          on: { click: () => step(1) },
        }, plusIcon()))),
    (() => {
      refs.chips = b.sizes.map((chip) => ({
        chip,
        el: h('button', {
          class: 'preset', type: 'button',
          on: { click: () => {
            set.size = chip.g;
            refs.size.value = chip.g;
            syncSize();
            onUserChange();
          } },
        }, `${chip.label} ${chip.g} g`),
      }));
      return h('li', { class: 'list-row set' },
        h('div', { class: 'size' },
          h('label', { for: 'size-field' }, `Dough per ${b.count.unit}`),
          refs.size = h('input', {
            class: 'field', id: 'size-field', inputmode: 'numeric',
            value: set.size == null ? '' : set.size,
            on: { input: (e) => onSizeInput(e.target.value) },
          }),
          h('span', { class: 'muted' }, 'g')),
        h('div', { class: 'presets' }, refs.chips.map((c) => c.el)),
        refs.hint = h('p', { class: 'kit-hint text-danger', hidden: true }, 'Enter a weight from 50 to 3,000 g'));
    })(),
  );
  syncStepper();
  syncSize();
}

function feelNote() {
  // Where the hydration sits between its floor and its ceiling picks the
  // feel note: the low third, the middle one, or the high one.
  const b = bread();
  const span = b.hydration.max - b.hydration.min;
  const band = set.hydration < b.hydration.min + span / 3 ? 0
    : set.hydration < b.hydration.min + (2 * span) / 3 ? 1 : 2;
  return b.feel[band];
}

function step(d) {
  set.count = Math.min(bread().count.max, Math.max(1, set.count + d));
  refs.n.textContent = String(set.count);
  syncStepper();
  onUserChange();
}

function syncStepper() {
  refs.minus.disabled = set.count <= 1;
  refs.plus.disabled = set.count >= bread().count.max;
}

function onSizeInput(value) {
  const n = /^\d{1,4}$/.test(value.trim()) ? Number(value.trim()) : NaN;
  set.size = n >= 50 && n <= 3000 ? n : null;
  syncSize();
  onUserChange();
}

function syncSize() {
  refs.size.setAttribute('aria-invalid', set.size == null ? 'true' : 'false');
  refs.hint.hidden = set.size != null;
  for (const { chip, el } of refs.chips) {
    el.setAttribute('aria-pressed', set.size === chip.g ? 'true' : 'false');
  }
}

// Every control change lands here: persist (never in the demo) and recompute.
function onUserChange() {
  if (demoFailed) {
    // The controls still work after a failed demo load: show their recipe.
    formulaStates.ready();
    timelineStates.ready();
    demoFailed = false;
  }
  save();
  update();
}

function calc() {
  return inRange(set, state.kind) ? calculate(state.kind, set) : null;
}

function update() {
  const c = calc();
  renderFormula(formulaTarget, c);
  renderTimeline(timelineTarget, c);
}

// The heading counts the batch: "1 loaf of 900 g", "8 bagels of 115 g".
const batchText = (c) => `${plural(c.count, bread().count.one, bread().count.label.toLowerCase())} of ${formatGrams(c.size)}`;

function renderFormula(target, c) {
  clear(target).append(...(c ? [
    h('div', { class: 'sheet-head' },
      h('h2', { class: 'serif text-heading' }, 'Formula'),
      h('span', { class: 'text-small muted' }, batchText(c))),
    h('ul', { class: 'list ing' },
      c.rows.map((row) => h('li', { class: 'list-row' },
        ingredientIcon(row.key),
        h('span', { class: 'name' },
          h('span', null, row.name),
          row.note ? h('span', { class: 'text-small muted' }, row.note) : null),
        h('span', { class: 'pct' }, row.pctText),
        h('span', { class: 'g' }, formatGrams(row.grams)))),
      h('li', { class: 'list-row total' },
        h('span', { class: 'name' }, 'Total dough'),
        h('span', { class: 'pct' }),
        h('span', { class: 'g' }, formatGrams(c.total)))),
    h('p', { class: 'note text-small muted' }, c.starter
      ? `Hydration ${c.hydration}% counts the water and flour inside the starter. Percentages are of all the flour, ${fmtNum(c.flour)} g.`
      : `Percentages are of the flour, ${fmtNum(c.flour)} g.`),
  ] : [
    h('div', { class: 'sheet-head' }, h('h2', { class: 'serif text-heading' }, 'Formula')),
    h('p', { class: 'note text-small muted' }, 'Enter a dough weight above to see the recipe'),
  ]));
}

function renderTimeline(target, c) {
  clear(target).append(...(c ? [
    h('div', { class: 'sheet-head' },
      h('h2', { class: 'serif text-heading' }, 'Rise and bake'),
      h('span', { class: 'text-small muted' }, `About ${formatDuration(c.aboutMin)}`)),
    h('div', { class: 'strip', 'aria-hidden': 'true' },
      c.steps.map((s) => h('span', {
        class: s.kind === 'hand' ? 's-hand' : s.kind === 'rise' ? 's-rise' : 's-bake',
        style: `flex:${s.min} 1 0%`,
      }))),
    h('div', { class: 'legend' },
      h('span', null, h('i', { class: 's-hand' }), 'Hands on'),
      h('span', null, h('i', { class: 's-rise' }), 'Rising'),
      h('span', null, h('i', { class: 's-bake' }), 'Baking')),
    h('ol', { class: 'steps' },
      c.steps.map((s) => h('li', { class: 'step' },
        h('span', { class: `dot${s.kind === 'rise' ? ' rise' : s.kind === 'bake' ? ' bake' : ''}` }),
        h('div', null,
          h('b', null, s.name),
          h('p', { class: 'text-small muted' }, s.advice),
          s.oven ? h('span', { class: 'oven' }, `${s.oven[0]}°C, ${s.oven[1]}°F`) : null),
        h('span', { class: 'dur' }, formatDuration(s.min))))),
    h('p', { class: 'note text-small muted' }, 'Times are a guide for a 24°C kitchen. A warmer room rises faster: watch the dough, not the clock.'),
  ] : [
    h('div', { class: 'sheet-head' }, h('h2', { class: 'serif text-heading' }, 'Rise and bake')),
    h('p', { class: 'note text-small muted' }, 'Enter a dough weight above to see the recipe'),
  ]));
}

function boot() {
  load();
  set = settingsFor(state.kind);
  renderPills();
  renderDough();

  if (demo) {
    const error = {
      title: 'The demo choices did not load',
      text: 'The calculator still works with your own choices.',
    };
    formulaStates = createStates(formulaBox, { rows: 5, error });
    timelineStates = createStates(timelineBox, { rows: 5, error });
    // While the states hold these two sections, the recipe renders into their
    // content boxes; if the load fails they flip back only when a control
    // moves, so the error with its Try again stays up until then.
    formulaTarget = formulaStates.content;
    timelineTarget = timelineStates.content;

    demoPromise = api('GET', '/api/demo');
    const task = async (box, render) => {
      try {
        const d = (await demoPromise).demo;
        if (!d || !BREADS[d.kind] || !inRange(d, d.kind)) throw new Error('bad demo data');
        state.kind = d.kind;
        state.settings[d.kind] = { hydration: d.hydration, count: d.count, size: d.size };
        set = settingsFor(d.kind);
        renderPills();
        renderDough();
        render(box);
      } catch (err) {
        demoFailed = true;
        throw err;
      }
    };
    formulaStates.run((box) => task(box, (t) => renderFormula(t, calc())));
    timelineStates.run((box) => task(box, (t) => renderTimeline(t, calc())));
    showDemoLabel(mainEl, 'Staging demo: these are example choices. Change anything to see the recipe update.');
    return;
  }

  update();
}

boot();