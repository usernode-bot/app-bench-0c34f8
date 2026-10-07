'use strict';

/*
 * Bread Bot — the bread recipe calculator.
 *
 * The maths at the top is pure: it takes plain numbers and returns plain
 * data, so tests/recipe.test.js can run it with a bare `node --test`.
 * The browser wiring at the bottom only runs where a DOM exists, so the
 * same file can be required from node and loaded as a page script.
 *
 * Class names are written as whole literals throughout so the Tailwind
 * build (which scans this file as text) sees every one of them.
 */

// ── Recipe maths ────────────────────────────────────────────────────────────

const SALT_PCT = 0.02; // salt, share of flour weight, every type
const STARTER_PCT = 0.2; // sourdough starter, share of flour weight (100% hydration)

const LOAVES_MIN = 1;
const LOAVES_MAX = 12;
const LOAF_SIZE_MIN = 100;
const LOAF_SIZE_MAX = 3000;

// Per-type presets: the leaven share of flour, the rise/oven/bake plan, and
// the proofing timeline stages (minutes) the strip draws.
const BREAD_TYPES = {
  sourdough: {
    label: 'Sourdough',
    leavenPct: 0,
    starter: true,
    rise: 'Bulk rise 5 h, then cold proof 12 h in the fridge',
    oven: '240°C',
    bake: '45 min (20 min covered, then 25 min uncovered)',
    boil: null,
    stages: [
      { name: 'Mix', minutes: 20 },
      { name: 'Bulk rise', minutes: 300 },
      { name: 'Shape', minutes: 15 },
      { name: 'Cold proof', minutes: 720 },
      { name: 'Bake', minutes: 45 },
    ],
  },
  bagels: {
    label: 'Bagels',
    leavenPct: 0.01,
    starter: false,
    rise: 'Rise 1 h, then rest 20 min after shaping',
    oven: '220°C',
    bake: '20 min',
    boil: '30 s per side',
    stages: [
      { name: 'Mix', minutes: 15 },
      { name: 'Rise', minutes: 60 },
      { name: 'Shape', minutes: 15 },
      { name: 'Rest', minutes: 20 },
      { name: 'Boil', minutes: 2 },
      { name: 'Bake', minutes: 20 },
    ],
  },
  'sourdough-bagels': {
    label: 'Sourdough bagels',
    leavenPct: 0,
    starter: true,
    rise: 'Cold ferment 12 h, then rest 20 min after shaping',
    oven: '220°C',
    bake: '22 min',
    boil: '30 s per side',
    stages: [
      { name: 'Mix', minutes: 20 },
      { name: 'Ferment', minutes: 720 },
      { name: 'Shape', minutes: 15 },
      { name: 'Rest', minutes: 20 },
      { name: 'Boil', minutes: 2 },
      { name: 'Bake', minutes: 22 },
    ],
  },
  rye: {
    label: 'Rye',
    leavenPct: 0.015,
    starter: false,
    rise: 'Rise 2 h, then proof 45 min',
    oven: '220°C',
    bake: '50 min',
    boil: null,
    stages: [
      { name: 'Mix', minutes: 15 },
      { name: 'Rise', minutes: 120 },
      { name: 'Shape', minutes: 10 },
      { name: 'Proof', minutes: 45 },
      { name: 'Bake', minutes: 50 },
    ],
  },
  'sandwich-loaf': {
    label: 'Sandwich loaf',
    leavenPct: 0.01,
    starter: false,
    rise: 'Rise 1.5 h, then proof 1 h in the tin',
    oven: '190°C',
    bake: '35 min',
    boil: null,
    stages: [
      { name: 'Mix', minutes: 15 },
      { name: 'Rise', minutes: 90 },
      { name: 'Shape', minutes: 10 },
      { name: 'Proof', minutes: 60 },
      { name: 'Bake', minutes: 35 },
    ],
  },
};

const TYPE_ORDER = ['sourdough', 'bagels', 'sourdough-bagels', 'rye', 'sandwich-loaf'];

// Turn four choices into a recipe, or an { error } the screen shows inline.
// All ingredient rows are rounded to the nearest gram, so the rows can sit a
// gram or two away from the dough weight; the card caption says so.
function computeRecipe(typeId, hydrationPct, loaves, loafSize) {
  const type = BREAD_TYPES[typeId];
  if (!type) return { error: 'Choose a bread type.' };
  const h = Number(hydrationPct);
  if (!Number.isFinite(h) || h < 55 || h > 90) {
    return { error: 'Hydration must be between 55% and 90%.' };
  }
  const loafCount = Number(loaves);
  if (!Number.isInteger(loafCount) || loafCount < LOAVES_MIN || loafCount > LOAVES_MAX) {
    return { error: 'Enter a whole number of loaves between 1 and 12.' };
  }
  const size = Number(loafSize);
  if (!Number.isFinite(size) || size < LOAF_SIZE_MIN || size > LOAF_SIZE_MAX) {
    return { error: 'Enter a loaf size between 100 g and 3000 g.' };
  }

  const hydration = h / 100;
  const dough = loafCount * size;
  // Flour F is whatever mass is left once water, salt and the leaven take
  // their share of the dough. The starter is drawn from F and the water, so
  // it adds no extra mass.
  const F = dough / (1 + hydration + SALT_PCT + type.leavenPct);
  const salt = Math.round(SALT_PCT * F);

  let rows;
  if (type.starter) {
    // A 100% hydration starter: half flour, half water.
    const starterFlour = Math.round((STARTER_PCT / 2) * F);
    const starterWater = Math.round((STARTER_PCT / 2) * F);
    rows = [
      ['Flour', Math.round(F) - starterFlour],
      ['Starter flour', starterFlour],
      ['Water', Math.round(hydration * F) - starterWater],
      ['Starter water', starterWater],
    ];
  } else {
    rows = [
      ['Flour', Math.round(F)],
      ['Water', Math.round(hydration * F)],
      ['Instant yeast', Math.round(type.leavenPct * F)],
    ];
  }
  rows.push(['Salt', salt]);

  return {
    typeId,
    label: type.label,
    hydrationPct: h,
    loaves: loafCount,
    loafSize: size,
    dough,
    rows,
    stages: type.stages,
  };
}

// Segment widths for the proofing timeline: proportional to stage duration,
// with a minimum so a 2-minute boil stays legible.
function stageWidths(stages) {
  const total = stages.reduce((sum, stage) => sum + stage.minutes, 0);
  return stages.map((stage) => Math.max(6, (stage.minutes / total) * 100));
}

function formatMinutes(minutes) {
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? hours + ' h' : hours + ' h ' + rest + ' min';
}

function formatDoughTotal(grams) {
  if (grams < 1000) return 'About ' + grams + ' g of dough in total.';
  return 'About ' + Math.round(grams / 100) / 10 + ' kg of dough in total.';
}

// ── Browser wiring ──────────────────────────────────────────────────────────

if (typeof document !== 'undefined' && document.getElementById('calculator')) {
  const PILL =
    'inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-4 text-small font-medium ' +
    'text-fg hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const PILL_SELECTED =
    'inline-flex min-h-11 items-center rounded-full border border-accent bg-accent px-4 text-small font-medium ' +
    'text-on-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

  const SIZE_PRESETS = [500, 800, 1000];

  const form = document.getElementById('calculator');
  const typePills = document.getElementById('type-pills');
  const sizePills = document.getElementById('size-pills');
  const hydration = document.getElementById('hydration');
  const hydrationReadout = document.getElementById('hydration-readout');
  const loavesInput = document.getElementById('loaves');
  const loafSizeInput = document.getElementById('loaf-size');
  const loavesError = document.getElementById('loaves-error');
  const loafSizeError = document.getElementById('loaf-size-error');
  const invite = document.getElementById('invite');
  const result = document.getElementById('result');
  const recipeSummary = document.getElementById('recipe-summary');
  const timeline = document.getElementById('timeline');
  const timelineKey = document.getElementById('timeline-key');
  const ingredients = document.getElementById('ingredients');
  const plan = document.getElementById('plan');

  const state = {
    typeId: 'sourdough',
    sizePreset: 800,
    lastRecipe: null,
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderTypePills() {
    typePills.textContent = '';
    for (const id of TYPE_ORDER) {
      const selected = id === state.typeId;
      const pill = el('button', selected ? PILL_SELECTED : PILL, BREAD_TYPES[id].label);
      pill.type = 'button';
      pill.setAttribute('role', 'radio');
      pill.setAttribute('aria-checked', selected ? 'true' : 'false');
      pill.addEventListener('click', () => {
        if (state.typeId === id) return;
        state.typeId = id;
        renderTypePills();
      });
      typePills.appendChild(pill);
    }
  }

  function renderSizePills() {
    sizePills.textContent = '';
    const choices = SIZE_PRESETS.concat(['custom']);
    for (const choice of choices) {
      const selected = choice === state.sizePreset;
      const label = choice === 'custom' ? 'Custom' : choice + ' g';
      const pill = el('button', selected ? PILL_SELECTED : PILL, label);
      pill.type = 'button';
      pill.setAttribute('aria-pressed', selected ? 'true' : 'false');
      pill.addEventListener('click', () => {
        if (choice === 'custom') {
          loafSizeInput.focus();
          return;
        }
        state.sizePreset = choice;
        loafSizeInput.value = String(choice);
        renderSizePills();
      });
      sizePills.appendChild(pill);
    }
  }

  hydration.addEventListener('input', () => {
    hydrationReadout.textContent = hydration.value + '%';
  });

  // Typing a size by hand leaves the presets: the Custom pill takes over.
  loafSizeInput.addEventListener('input', () => {
    if (state.sizePreset !== 'custom') {
      state.sizePreset = 'custom';
      renderSizePills();
    }
  });

  function showError(node, message) {
    node.textContent = message;
    node.hidden = false;
  }

  function clearErrors() {
    loavesError.hidden = true;
    loafSizeError.hidden = true;
  }

  function renderRecipe(recipe) {
    recipeSummary.textContent =
      recipe.loaves + ' loaves × ' + recipe.loafSize + ' g dough, ' +
      recipe.hydrationPct + '% hydration. ' + formatDoughTotal(recipe.dough);

    timeline.textContent = '';
    timelineKey.textContent = '';
    const widths = stageWidths(recipe.stages);
    const total = recipe.stages.reduce((sum, stage) => sum + stage.minutes, 0);
    recipe.stages.forEach((stage, i) => {
      // Short stages next to a long schedule are tinted, not solid, so the
      // strip reads as one shape with the long rises carrying it.
      const tinted = stage.minutes < total * 0.1;
      const segment = el('span', tinted ? 'h-full bg-accent/60' : 'h-full bg-accent');
      segment.style.width = widths[i].toFixed(2) + '%';
      timeline.appendChild(segment);
      timelineKey.appendChild(el('li', null, stage.name + ' ' + formatMinutes(stage.minutes)));
    });

    ingredients.textContent = '';
    for (const [name, grams] of recipe.rows) {
      const row = el('li', 'list-row justify-between');
      row.appendChild(el('span', null, name));
      row.appendChild(el('strong', 'tabular-nums', grams + ' g'));
      ingredients.appendChild(row);
    }

    plan.textContent = '';
    const type = BREAD_TYPES[recipe.typeId];
    const planRows = [
      ['Rise', type.rise],
    ];
    if (type.boil) planRows.push(['Boil', type.boil]);
    planRows.push(['Oven', type.oven], ['Bake', type.bake]);
    for (const [label, value] of planRows) {
      const row = el('li', 'list-row justify-between');
      row.appendChild(el('span', 'flex-none text-muted', label));
      row.appendChild(el('strong', 'text-right', value));
      plan.appendChild(row);
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    clearErrors();

    const loavesValue = loavesInput.value.trim();
    const sizeValue = loafSizeInput.value.trim();
    const loavesNum = Number(loavesValue);
    const sizeNum = Number(sizeValue);
    let bad = false;
    if (!Number.isInteger(loavesNum) || loavesNum < LOAVES_MIN || loavesNum > LOAVES_MAX) {
      showError(loavesError, 'Enter a whole number between 1 and 12.');
      bad = true;
    }
    if (!Number.isFinite(sizeNum) || sizeNum < LOAF_SIZE_MIN || sizeNum > LOAF_SIZE_MAX) {
      showError(loafSizeError, 'Enter a size between 100 g and 3000 g.');
      bad = true;
    }
    if (bad) return; // the last recipe stays on screen

    const recipe = computeRecipe(state.typeId, Number(hydration.value), loavesNum, sizeNum);
    if (recipe.error) return;

    state.lastRecipe = recipe;
    renderRecipe(recipe);
    invite.hidden = true;
    result.hidden = false;
  });

  loavesInput.addEventListener('input', () => { loavesError.hidden = true; });
  loafSizeInput.addEventListener('input', () => { loafSizeError.hidden = true; });

  renderTypePills();
  renderSizePills();
}

// Loadable from node for the tests.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BREAD_TYPES,
    TYPE_ORDER,
    computeRecipe,
    stageWidths,
    formatMinutes,
    formatDoughTotal,
  };
}
