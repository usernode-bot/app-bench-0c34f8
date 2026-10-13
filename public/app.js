// Bread Bot's screen: reads the settings, calls the pure maths in
// breads.js, and redraws the recipe. No Calculate button — every change
// redraws. Class names are whole literals so the Tailwind build sees them.

import { BREADS, computeRecipe, bakeMinutes, toF, formatGrams, isValidSize } from '/breads.js';
import { h, clear, api, isDemo } from '/kit/dom.js';
import { showDemoLabel } from '/kit/demo.js';

const MIN_COUNT = 1;
const MAX_COUNT = 24;

const state = {
  type: 'sourdough',
  hydration: 75,
  count: 1,
  size: 900,
};

const $ = (id) => document.getElementById(id);

/* ── Drawn icons ──────────────────────────────────────────────────────────
 * Line drawings in the current text colour (fixed markup, never user text).
 */

const ICONS = {
  // Breads (the chips)
  loaf: '<path d="M4 18h16a1 1 0 0 0 1-1c0-4.4-4-8-9-8s-9 3.6-9 8a1 1 0 0 0 1 1z"/><path d="M9 10.5 7.5 8.5"/><path d="M12 10V7.5"/><path d="M15 10.5l1.5-2"/>',
  bagel: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/>',
  'sourdough-bagel': '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><circle cx="18" cy="6" r="2"/>',
  rye: '<path d="M3 17h18v-4.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4z"/><path d="M8 11.5v4"/><path d="M12 11.5v4"/><path d="M16 11.5v4"/>',
  sandwich: '<path d="M3 10c0-2.8 4-5 9-5s9 2.2 9 5z"/><path d="M3 10h18"/><path d="M5 10v8h14v-8"/>',
  // Steps (the timeline)
  rise: '<path d="M12 20V6"/><path d="M6 12l6-6 6 6"/>',
  shape: '<path d="M4 5h16l-6 7v6l-4 2v-8z"/>',
  fridge: '<path d="M6 3h12v18H6z"/><path d="M6 10h12"/><path d="M10 6v2.5"/><path d="M10 13v3"/>',
  boil: '<path d="M4 11h16v2a7 7 0 0 1-7 7h-2a7 7 0 0 1-7-7z"/><path d="M9 7c0-1.5 1-1.5 1-3"/><path d="M14 7c0-1.5 1-1.5 1-3"/>',
  oven: '<path d="M4 5h16v15H4z"/><path d="M4 10h16"/><path d="M7 7.5h.01"/><path d="M12 7.5h.01"/><path d="M17 7.5h.01"/>',
};

function draw(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || ICONS.loaf;
  return svg;
}

// Swatch and strip colours, one per material tone. Whole literals, so the
// Tailwind extractor sees every class.
const TONE_BG = {
  flour: 'bg-ing-flour',
  rye: 'bg-ing-rye',
  water: 'bg-ing-water',
  leaven: 'bg-ing-leaven',
  salt: 'bg-ing-salt',
  sweet: 'bg-ing-sweet',
  fat: 'bg-ing-fat',
};

/* ── Words ──────────────────────────────────────────────────────────────── */

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function countWord(bread, count) {
  return count === 1 ? `1 ${bread.noun[0]}` : `${count} ${bread.noun[1]}`;
}

// A number and its unit stay on one line: no lone "h", "min" or "°C"
// wrapping onto the next line in the step text.
function glueUnits(text) {
  return String(text).replace(/(\d)\s+(h|min|s|cm|°C|°F|g)\b/g, '$1 $2');
}

/* ── Settings ───────────────────────────────────────────────────────────── */

function syncSettings() {
  const bread = BREADS[state.type];
  const slider = $('hydration');
  slider.value = state.hydration;
  slider.style.setProperty('--fill', `${((state.hydration - 50) / 40) * 100}%`);
  $('hydration-val').textContent = `${state.hydration}%`;
  $('hydration-typical').textContent = `Typical for ${bread.name.toLowerCase()}: ${bread.typical.hydration}%`;
  $('count-label').textContent = cap(state.count === 1 ? bread.noun[0] : bread.noun[1]);
  $('count-val').textContent = state.count;
  $('count-minus').disabled = state.count <= MIN_COUNT;
  $('count-plus').disabled = state.count >= MAX_COUNT;
  $('size').value = state.size;
}

/* ── Recipe ─────────────────────────────────────────────────────────────── */

function renderChips() {
  clear($('chips')).append(
    ...Object.values(BREADS).map((bread) => {
      const chip = h('button', { type: 'button', class: 'chip', 'aria-pressed': String(bread.id === state.type) }, draw(bread.icon), bread.name);
      chip.addEventListener('click', () => {
        state.type = bread.id;
        Object.assign(state, bread.typical);
        syncSettings();
        renderChips();
        render();
      });
      return chip;
    }),
  );
}

function renderStrip(recipe) {
  const strip = clear($('strip'));
  const pcts = clear($('pcts'));
  const parts = [];
  for (const row of recipe.rows) {
    if (row.grams <= 0) continue;
    strip.append(h('i', { class: TONE_BG[row.tone] || TONE_BG.flour }));
    strip.lastChild.style.flexGrow = String(row.pct);
    parts.push(`${row.label || row.name} ${row.pct}%`);
    const labelled = row.pct >= 18;
    const cell = h('div', { class: 'min-w-0 overflow-hidden whitespace-nowrap' }, labelled ? `${row.label || row.name} ${row.pct}%` : null);
    cell.style.flexGrow = String(row.pct);
    pcts.append(cell);
  }
  strip.setAttribute('aria-label', `Baker's percentages against the flour: ${parts.join(', ')}`);
}

function renderIngredients(recipe) {
  const list = clear($('ingredients'));
  for (const row of recipe.rows) {
    list.append(h('li', { class: 'list-row' },
      h('span', { class: `swatch ${TONE_BG[row.tone] || TONE_BG.flour}`, 'aria-hidden': 'true' }),
      h('div', { class: 'kit-row-text' },
        h('span', { class: 'kit-row-title' }, row.name),
        row.note ? h('span', { class: 'kit-row-sub' }, row.note) : null),
      h('span', { class: 'shrink-0 text-body font-semibold' }, `${formatGrams(row.grams)} g`),
    ));
  }
  const note = $('hydration-note');
  if (recipe.totalHydration != null) {
    note.textContent = `Total hydration, starter included: ${recipe.totalHydration}%. The starter is half flour, half water.`;
    note.hidden = false;
  } else {
    note.hidden = true;
  }
}

function renderSteps(recipe) {
  const bread = recipe.bread;
  const list = clear($('steps'));
  // The last shaping before the bake carries the divide note: how many
  // pieces this batch makes.
  for (const step of bread.steps) {
    const isShape = step.icon === 'shape';
    const meta = glueUnits(step.meta || (isShape
      ? (state.count === 1 ? `One ${bread.noun[0]}` : `${state.count} ${bread.shapeUnit} of ${state.size} g`)
      : null));
    list.append(h('li', { class: 'step' },
      h('span', { class: 'step-ico', 'aria-hidden': 'true' }, draw(step.icon)),
      h('div', { class: 'min-w-0' },
        h('p', { class: 'step-title' }, step.title),
        meta ? h('p', { class: 'step-meta' }, meta) : null,
        step.sub ? h('p', { class: 'step-sub' }, glueUnits(step.sub)) : null),
    ));
  }
  const bake = bread.bake;
  const panel = h('div', { class: 'bake-panel' });
  bake.phases.forEach((phase, i) => {
    const last = i === bake.phases.length - 1;
    const min = last ? bakeMinutes(phase.min, state.size, bake.refSize) : phase.min;
    panel.append(h('div', { class: 'bake-line' },
      h('strong', { class: 'whitespace-nowrap' }, glueUnits(`${phase.label}: ${phase.c} °C`)),
      h('small', { class: 'whitespace-nowrap' }, glueUnits(`${min} min · ${toF(phase.c)} °F`)),
    ));
  });
  panel.append(h('p', { class: 'text-small text-muted' }, glueUnits(bake.done)));
  list.append(h('li', { class: 'step step-bake' },
    h('span', { class: 'step-ico', 'aria-hidden': 'true' }, draw('oven')),
    h('div', { class: 'min-w-0' },
      h('p', { class: 'step-title' }, 'Bake'),
      h('p', { class: 'step-sub' }, glueUnits(bake.sub)),
      panel),
  ));
}

function render() {
  const bread = BREADS[state.type];
  const valid = isValidSize(state.size);
  const err = $('size-error');
  err.hidden = valid;
  $('size').setAttribute('aria-invalid', valid ? 'false' : 'true');

  const recipe = computeRecipe(state);
  $('recipe-section').hidden = !recipe;
  $('ingredients-section').hidden = !recipe;
  $('steps-section').hidden = !recipe;
  $('recipe-empty').hidden = !!recipe;
  if (!recipe) return;

  $('total').textContent = `${formatGrams(recipe.dough)} g`;
  $('total-note').textContent = `of dough for ${countWord(bread, state.count)}`;
  renderStrip(recipe);
  renderIngredients(recipe);
  renderSteps(recipe);
}

/* ── Events ─────────────────────────────────────────────────────────────── */

$('hydration').addEventListener('input', (e) => {
  state.hydration = Number(e.target.value);
  syncSettings();
  render();
});

$('count-minus').addEventListener('click', () => {
  state.count = Math.max(MIN_COUNT, state.count - 1);
  syncSettings();
  render();
});
$('count-plus').addEventListener('click', () => {
  state.count = Math.min(MAX_COUNT, state.count + 1);
  syncSettings();
  render();
});

$('size').addEventListener('input', (e) => {
  const value = Number(e.target.value);
  state.size = Number.isFinite(value) && e.target.value !== '' ? value : NaN;
  render();
});

/* ── Boot ───────────────────────────────────────────────────────────────── */

renderChips();
syncSettings();

if (isDemo()) {
  // Staging demo: skeleton while the example settings load, then fill them
  // in. Anything goes wrong, say so in the console and show the defaults.
  const skel = h('div', { class: 'flex flex-col gap-2', 'aria-hidden': 'true' },
    h('div', { class: 'skeleton h-8 w-44' }),
    h('div', { class: 'skeleton h-10' }),
    h('div', { class: 'skeleton h-24' }));
  $('recipe-section').append(skel);
  api('GET', '/api/demo')
    .then((data) => {
      const demo = data && data.demo;
      if (!demo) {
        console.warn('No staging demo data returned; showing default settings.');
        return;
      }
      state.type = BREADS[demo.type] ? demo.type : state.type;
      state.hydration = demo.hydration;
      state.count = demo.count;
      state.size = demo.size;
      syncSettings();
      renderChips();
      showDemoLabel($('app'), 'Staging demo: example settings filled in for you. Change anything to try it.');
    })
    .catch((err) => console.warn('Staging demo failed to load; showing default settings.', err))
    .finally(() => {
      skel.remove();
      render();
    });
} else {
  render();
}