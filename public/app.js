/* Bread Bot — recipe data and calculation.
 *
 * Everything here is client-side and stateless: the four choices (bread
 * type, hydration, loaves, loaf size) are turned into a recipe when
 * Calculate is tapped, and nothing is stored. Class names are whole
 * literals so the precompiled Tailwind build includes them (see the note
 * in index.html).
 */

// Baker's percentages per type. Leaven: the starter is fed 1:1 (half
// flour, half water), so it counts at half its percentage and the water
// line is cut by the same amount — that keeps the set hydration true for
// the whole dough. Dry yeast is neither flour nor water, so it counts in
// full and takes nothing from the water. "other" are the small extras
// each recipe adds. Salt is always 2% of the flour weight.
const TYPES = [
  {
    id: 'sourdough',
    label: 'Sourdough',
    flourLabel: 'Bread flour',
    leaven: { label: 'Starter, fed 1:1', pct: 20, starter: true },
    other: [],
    stages: [
      ['Mix', '15 min'], ['Rise', '5 h'], ['Shape', '15 min'], ['Proof', '2 h'], ['Bake', '45 min'],
    ],
    bake: '250 °C (480 °F) covered for 20 min, then 230 °C (450 °F) for 25 min.',
  },
  {
    id: 'bagels',
    label: 'Bagels',
    flourLabel: 'Bread flour',
    leaven: { label: 'Dry yeast', pct: 1, starter: false },
    other: [{ label: 'Sugar or malt', pct: 3 }],
    stages: [
      ['Mix', '10 min'], ['Rise', '1 h'], ['Shape', '15 min'], ['Proof', '30 min'], ['Bake', '20 min'],
    ],
    bake: 'Boil 30 s per side, then 220 °C (425 °F) for 20 min.',
  },
  {
    id: 'sourdough-bagels',
    label: 'Sourdough bagels',
    flourLabel: 'Bread flour',
    leaven: { label: 'Starter, fed 1:1', pct: 20, starter: true },
    other: [{ label: 'Sugar or malt', pct: 3 }],
    stages: [
      ['Mix', '15 min'], ['Rise', '4 h'], ['Shape', '15 min'], ['Proof', '2 h'], ['Bake', '22 min'],
    ],
    bake: 'Boil 30 s per side, then 230 °C (450 °F) for 22 min.',
  },
  {
    id: 'rye',
    label: 'Rye',
    flourLabel: 'Flour (rye blend)',
    leaven: { label: 'Dry yeast', pct: 1, starter: false },
    other: [{ label: 'Caraway seeds', pct: 1 }],
    stages: [
      ['Mix', '10 min'], ['Rise', '1.5 h'], ['Shape', '10 min'], ['Proof', '1 h'], ['Bake', '40 min'],
    ],
    bake: '230 °C (450 °F) for 15 min, then 200 °C (400 °F) for 25 min.',
  },
  {
    id: 'sandwich-loaf',
    label: 'Sandwich loaf',
    flourLabel: 'Bread flour',
    leaven: { label: 'Dry yeast', pct: 1, starter: false },
    other: [{ label: 'Butter', pct: 4 }, { label: 'Sugar', pct: 6 }],
    stages: [
      ['Mix', '15 min'], ['Rise', '1.5 h'], ['Shape', '10 min'], ['Proof', '1 h'], ['Bake', '35 min'],
    ],
    bake: '190 °C (375 °F) for 35 min, in a pan.',
  },
];

// Class names, as whole literals for the Tailwind compiler.
const CHIP_OFF = 'inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-small font-medium text-fg'
  + ' focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
const CHIP_ON = 'inline-flex min-h-11 items-center rounded-lg border border-accent bg-accent px-3 text-small font-medium text-on-accent'
  + ' focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
const ROW_NAME = 'text-fg';
const ROW_GRAMS = 'ml-auto font-semibold tabular-nums';
const STEP_DOT = 'mx-auto h-2.5 w-2.5 rounded-full bg-accent';
const STEP_NAME = 'mt-1 text-small text-fg';
const STEP_TIME = 'text-small text-muted';
const BAKE_LABEL = 'font-medium text-fg';

// The three inputs and their sensible ranges. Out-of-range values clamp on
// change; blank or non-numeric reverts to the fallback.
const FIELDS = {
  hydration: { el: 'bb-hydration', hint: 'bb-hydration-hint', min: 50, max: 100, fallback: 75, whole: false, hintText: '50 to 100 %' },
  loaves: { el: 'bb-loaves', hint: 'bb-loaves-hint', min: 1, max: Infinity, fallback: 1, whole: true, hintText: '1 or more' },
  loafSize: { el: 'bb-loaf-size', hint: 'bb-loaf-size-hint', min: 100, max: 5000, fallback: 900, whole: false, hintText: '100 to 5000 g' },
};

const form = document.getElementById('bb-form');
const results = document.getElementById('bb-results');
const chipsBox = document.getElementById('bb-chips');

let currentType = TYPES[0].id;

function fieldEls(key) {
  return { input: document.getElementById(FIELDS[key].el), hint: document.getElementById(FIELDS[key].hint) };
}

// The number in a field, or null when it is blank or not a number.
function readNumber(el) {
  const n = Number(el.value.trim());
  return el.value.trim() !== '' && Number.isFinite(n) ? n : null;
}

// A field is valid when it holds a number inside its range (a whole
// number for loaves).
function fieldValid(key) {
  const f = FIELDS[key];
  const n = readNumber(fieldEls(key).input);
  if (n === null) return false;
  if (f.whole && !Number.isInteger(n)) return false;
  return n >= f.min && n <= f.max;
}

function updateHint(key) {
  const { hint } = fieldEls(key);
  hint.textContent = FIELDS[key].hintText;
  hint.hidden = fieldValid(key);
}

// Clamp on change: below the minimum becomes the minimum, above the
// maximum becomes the maximum; blank or non-numeric reverts to the
// fallback. Loaves is a whole number.
function clampField(key) {
  const f = FIELDS[key];
  const { input } = fieldEls(key);
  let n = readNumber(input);
  if (n === null) {
    n = f.fallback;
  } else {
    if (f.whole) n = Math.round(n);
    n = Math.min(f.max, Math.max(f.min, n));
  }
  input.value = String(n);
  updateHint(key);
}

// Weights in grams: whole-gram rounded, with one decimal for values that
// stay under 10 g. Water keeps one decimal too when the rounding of the
// smaller lines leaves the list a tenth of a gram off, so the list always
// sums exactly to the total dough weight.
function grams(v) {
  return (v < 10 || !Number.isInteger(v) ? v.toFixed(1) : String(v)) + ' g';
}

// Solve the flour weight from the total dough weight. The dough is one
// batch: loaves × loaf size is the total the percentages divide into.
function computeRecipe(type, hydrationPct, loaves, loafG) {
  const total = loaves * loafG;
  const h = hydrationPct / 100;
  const saltPct = 2;
  const leavenPct = type.leaven.pct;
  const otherPct = type.other.reduce((sum, o) => sum + o.pct, 0);
  const leavenFrac = (type.leaven.starter ? leavenPct / 2 : leavenPct) / 100;
  const flour = total / (1 + h + saltPct / 100 + leavenFrac + otherPct / 100);
  // Starter brings half its weight in flour and water with it, so the
  // water line is cut by that amount.
  const water = flour * h - (type.leaven.starter ? flour * leavenPct / 200 : 0);
  const lines = [
    { label: type.flourLabel, raw: flour },
    { label: 'Water', raw: water },
    { label: type.leaven.label, raw: flour * leavenPct / 100 },
    { label: 'Salt', raw: flour * saltPct / 100 },
  ].concat(type.other.map((o) => ({ label: o.label, raw: flour * o.pct / 100 })));
  // The water line absorbs the rounding leftover so the list sums exactly
  // to the total dough weight. The arithmetic runs in integer tenths of a
  // gram so no float dust reaches the page.
  const shownT = lines.map((l) => (Math.round(l.raw) < 10 ? Math.round(l.raw * 10) : Math.round(l.raw) * 10));
  shownT[1] += Math.round(total) * 10 - shownT.reduce((sum, v) => sum + v, 0);
  return { total, lines: lines.map((l, i) => ({ label: l.label, display: shownT[i] / 10 })) };
}

function render(typeKey, hydrationPct, loaves, loafG) {
  const type = TYPES.find((t) => t.id === typeKey);
  const recipe = computeRecipe(type, hydrationPct, loaves, loafG);

  document.getElementById('bb-ingredients').innerHTML = recipe.lines.map((l) =>
    '<li class="list-row"><span class="' + ROW_NAME + '">' + l.label + '</span>'
    + '<span class="' + ROW_GRAMS + '">' + grams(l.display) + '</span></li>'
  ).join('');

  const note = type.leaven.starter
    ? 'Starter already contains half its weight in flour and water. ' : '';
  document.getElementById('bb-dough-note').textContent =
    note + 'Total dough: ' + Math.round(recipe.total) + ' g.';

  document.getElementById('bb-timeline').innerHTML = type.stages.map((s) =>
    '<li class="flex-1 text-center"><div class="' + STEP_DOT + '"></div>'
    + '<div class="' + STEP_NAME + '">' + s[0] + '</div>'
    + '<div class="' + STEP_TIME + '">' + s[1] + '</div></li>'
  ).join('');

  document.getElementById('bb-bake').innerHTML =
    '<span class="' + BAKE_LABEL + '">Bake:</span> ' + type.bake;

  results.hidden = false;
}

function paintChips() {
  TYPES.forEach((t) => {
    const chip = chipsBox.querySelector('button[data-type="' + t.id + '"]');
    const on = t.id === currentType;
    chip.className = on ? CHIP_ON : CHIP_OFF;
    chip.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

TYPES.forEach((t) => {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.setAttribute('data-type', t.id);
  chip.textContent = t.label;
  chip.addEventListener('click', () => {
    currentType = t.id;
    paintChips();
  });
  chipsBox.appendChild(chip);
});
paintChips();

Object.keys(FIELDS).forEach((key) => {
  const { input } = fieldEls(key);
  input.addEventListener('input', () => updateHint(key));
  input.addEventListener('change', () => clampField(key));
  updateHint(key);
});

// The screen's one primary action. While a field is invalid the recipe is
// left alone and the field carries the fix; otherwise the recipe is
// computed on the spot.
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const bad = Object.keys(FIELDS).filter((key) => !fieldValid(key));
  if (bad.length) {
    bad.forEach((key) => {
      const { hint } = fieldEls(key);
      hint.textContent = FIELDS[key].hintText;
      hint.hidden = false;
    });
    return;
  }
  Object.keys(FIELDS).forEach((key) => { fieldEls(key).hint.hidden = true; });
  render(currentType,
    readNumber(fieldEls('hydration').input),
    readNumber(fieldEls('loaves').input),
    readNumber(fieldEls('loafSize').input));
});