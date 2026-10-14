// app.js: wires the drawn screen to recipes.js. All state lives in memory;
// every control re-renders the whole recipe, so nothing can go stale.
import { calculate, typeById, fmtMin } from '/recipes.js';
import { rowsFrom, fillIn } from '/kit/fill.js';
import { toast } from '/kit/native.js';

const $ = (sel) => document.querySelector(sel);
const root = document.documentElement;

const els = {
  demoLine: $('#demo-line'),
  chips: [...document.querySelectorAll('.chips .chip')],
  hydrationVal: $('#hydration-val'),
  hydration: $('#hydration'),
  countLabel: $('#count-label'),
  countVal: $('#count-val'),
  countMinus: $('#count-minus'),
  countPlus: $('#count-plus'),
  sizeLabel: $('#size-label'),
  sizeSeg: $('#size-seg'),
  customRow: $('#custom-row'),
  customSize: $('#custom-size'),
  loading: $('#loading'),
  secIngredients: $('#sec-ingredients'),
  secRise: $('#sec-rise'),
  secBake: $('#sec-bake'),
  sizeError: $('#size-error'),
  ingredients: $('#ingredients'),
  totalDough: $('#total-dough'),
  totalTime: $('#total-time'),
  strip: $('#rise-strip'),
  segs: { mix: $('#seg-mix'), rise: $('#seg-rise'), proof: $('#seg-proof'), bake: $('#seg-bake') },
  steps: $('#steps'),
  ovenTemp: $('#oven-temp'),
  ovenTempNote: $('#oven-temp-note'),
  ovenTime: $('#oven-time'),
  ovenTimeNote: $('#oven-time-note'),
  copyBtn: $('#copy-btn'),
};

// Sourdough, 75%, 2 loaves at 900 g: the screen's own starting point, and
// the staging demo's preset too.
const state = { type: 'sourdough', hydration: 75, count: 2, sizeIdx: 2, custom: false, customText: '' };

// The drawn lists: keep one row each as the row to repeat, drop the samples.
const proofIcon = els.steps.children[1] ? els.steps.children[1].querySelector('svg').outerHTML : '';
const ingRow = rowsFrom(els.ingredients);
const stepRow = rowsFrom(els.steps);

const sizeLabel = (g) => (g === 1000 ? '1 kg' : `${g} g`);
const currentSize = () => {
  const t = typeById(state.type);
  return state.custom ? Number(state.customText) : t.sizes[state.sizeIdx];
};

function segBtn(label, pressed, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.setAttribute('aria-pressed', String(pressed));
  b.addEventListener('click', onClick);
  return b;
}

function renderSizeSeg() {
  const t = typeById(state.type);
  const btns = t.sizes.map((g, i) =>
    segBtn(sizeLabel(g), !state.custom && state.sizeIdx === i, () => {
      state.custom = false;
      state.sizeIdx = i;
      render();
    }));
  btns.push(segBtn('Custom', state.custom, () => {
    state.custom = true;
    els.customRow.hidden = false;
    els.customSize.focus();
    render();
  }));
  els.sizeSeg.replaceChildren(...btns);
  els.sizeSeg.style.gridTemplateColumns = `repeat(${btns.length}, 1fr)`;
  els.customRow.hidden = !state.custom;
}

// One strip segment: its width grows with its minutes (a minimum width keeps
// short steps readable), the label sits under the time.
function fillSeg(el, step) {
  const b = el.querySelector('b');
  b.textContent = fmtMin(step.minutes);
  while (b.nextSibling) b.nextSibling.remove();
  b.after(document.createTextNode(step.cold ? `${step.name}, fridge` : step.name));
  el.style.flex = String(step.minutes);
}

function render() {
  const t = typeById(state.type);
  for (const chip of els.chips) {
    chip.setAttribute('aria-pressed', String(chip.dataset.type === state.type));
  }
  const res = calculate({ type: state.type, hydration: state.hydration, count: state.count, size: currentSize() });

  els.hydrationVal.textContent = `${state.hydration}%`;
  els.hydration.value = state.hydration;
  els.countLabel.textContent = t.countLabel;
  els.countVal.textContent = state.count;
  els.countMinus.disabled = state.count <= 1;
  els.countPlus.disabled = state.count >= t.maxCount;
  els.sizeLabel.textContent = t.sizeLabel;
  renderSizeSeg();

  els.loading.hidden = true;
  const ok = !res.error;
  els.sizeError.textContent = res.error || '';
  els.sizeError.hidden = ok;
  els.secIngredients.hidden = !ok;
  els.secRise.hidden = !ok;
  els.secBake.hidden = !ok;
  els.copyBtn.disabled = !ok;
  if (!ok) return;

  els.ingredients.replaceChildren(...res.ingredients.map((ing) => fillIn(ingRow(), {
    '.nm': ing.name,
    '.nt': { text: ing.note, hidden: !ing.note },
    '.pct': typeof ing.pct === 'string' ? ing.pct : `${ing.pct}%`,
    '.g': ing.text,
  })));
  els.totalDough.textContent = `${res.totalG.toLocaleString('en')} g of dough`;

  for (const [key, step] of [['mix', res.steps[0]], ['rise', res.steps[1]], ['proof', res.steps[2]], ['bake', res.steps[3]]]) {
    fillSeg(els.segs[key], step);
  }
  els.strip.setAttribute('aria-label', res.steps.map((s) =>
    `${s.name.toLowerCase()} ${fmtMin(s.minutes)}${s.cold ? ' in the fridge' : ''}`).join(', '));

  const [rise, proof] = [res.steps[1], res.steps[2]];
  els.steps.replaceChildren(...[rise, proof].map((step, i) => {
    const row = fillIn(stepRow(), {
      '.nm': step.name,
      '.small': step.detail,
      '.val': fmtMin(step.minutes),
    });
    if (i === 1 && proofIcon) row.querySelector('svg').outerHTML = proofIcon;
    return row;
  }));

  els.ovenTemp.textContent = `${res.bake.c} °C`;
  els.ovenTempNote.textContent = `${res.bake.f} °F, ${res.bake.tempNote}`;
  els.ovenTime.textContent = `${res.bake.minutes} min`;
  els.ovenTimeNote.textContent = res.bake.timeNote;
  els.totalTime.textContent = `About ${fmtMin(res.totalTime)}${res.totalTime % 60 ? ' min' : ''}`;
  if (!els.demoLine.hidden) els.demoLine.textContent = demoLineText();
}

// ── Controls ────────────────────────────────────────────────────────────────

for (const chip of els.chips) {
  chip.addEventListener('click', () => {
    if (chip.dataset.type === state.type) return;
    const t = typeById(chip.dataset.type);
    state.type = t.id;
    state.hydration = t.defaultHydration;
    state.sizeIdx = t.sizes.indexOf(t.defaultSize);
    state.custom = false;
    state.count = Math.min(state.count, t.maxCount);
    render();
  });
}
els.chips.forEach((chip) => {
  chip.setAttribute('aria-pressed', String(chip.dataset.type === state.type));
});

els.hydration.addEventListener('input', () => {
  state.hydration = Number(els.hydration.value);
  render();
});
els.countMinus.addEventListener('click', () => {
  state.count = Math.max(1, state.count - 1);
  render();
});
els.countPlus.addEventListener('click', () => {
  state.count = Math.min(typeById(state.type).maxCount, state.count + 1);
  render();
});
els.customSize.addEventListener('input', () => {
  state.customText = els.customSize.value.trim();
  render();
});

// ── Copy recipe ─────────────────────────────────────────────────────────────

function recipeText() {
  const t = typeById(state.type);
  const res = calculate({ type: state.type, hydration: state.hydration, count: state.count, size: currentSize() });
  if (res.error) return null;
  const lines = [
    t.label,
    `${state.count} ${t.countWord} at ${res.size} g, ${state.hydration}% hydration`,
    '',
    `Ingredients (${res.totalG.toLocaleString('en')} g of dough)`,
    ...res.ingredients.map((ing) => {
      const pct = typeof ing.pct === 'string' ? ing.pct : `${ing.pct}%`;
      return `- ${ing.name}${ing.note ? ` (${ing.note})` : ''}, ${pct}: ${ing.text}`;
    }),
    '',
    'Rise schedule',
    ...res.steps.map((s) =>
      `- ${s.name}: ${fmtMin(s.minutes)}${s.cold ? ', in the fridge' : ''}${s.detail ? `. ${s.detail}` : ''}`),
    '',
    `Bake: ${res.bake.c} °C (${res.bake.f} °F) for ${res.bake.minutes} min, ${res.bake.tempNote}. ${res.bake.timeNote}.`,
  ];
  return lines.join('\n');
}

els.copyBtn.addEventListener('click', async () => {
  const text = recipeText();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Recipe copied');
  } catch {
    // The iframe may refuse the clipboard API; a user gesture also lets the
    // older command copy. If neither works, say so and leave the recipe up.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    toast(ok ? 'Recipe copied' : 'Could not copy the recipe');
  }
});

// ── Staging demo ────────────────────────────────────────────────────────────
// Only on a staging preview opened with ?demo=1: the preset is the screen's
// own default, so it changes nothing and writes nothing.

const params = new URLSearchParams(location.search);
if (root.hasAttribute('data-staging') && params.get('demo') === '1') {
  els.demoLine.hidden = false;
  els.demoLine.textContent = demoLineText();
}

function demoLineText() {
  const t = typeById(state.type);
  const word = state.count === 1 ? 'one' : state.count === 2 ? 'two' : state.count === 3 ? 'three' : state.count;
  const label = t.label.toLowerCase();
  // The plural name: "bagels" already says the count word; "sourdough"
  // needs it; a "loaf" label swaps to its plural ("sandwich loaf" ->
  // "sandwich loaves").
  const plural = label.endsWith(t.countWord) ? label
    : label.endsWith('loaf') ? `${label.slice(0, -4)}${t.countWord}`
    : `${label} ${t.countWord}`;
  // The singular: a "loaf" label is already singular ("sandwich loaf"),
  // a plural label drops its "s" ("bagels" -> "bagel"), otherwise the
  // label reads as one loaf ("rye loaf").
  const name = state.count === 1
    ? (label.endsWith('loaf') ? label : label.endsWith('s') ? label.slice(0, -1) : `${label} loaf`)
    : plural;
  return `Staging demo: ${word} ${currentSize()} g ${name}`;
}

render();
