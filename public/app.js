// Bread Bot's screen: the drawn markup in index.html, filled live from
// recipes.js. No Calculate button — every input re-renders the recipe.

import { api, h, isDemo } from './kit/dom.js';
import { showDemoLabel } from './kit/demo.js';
import { rowsFrom, fillIn } from './kit/fill.js';
import { BREADS, KIND_ORDER, calculate } from './recipes.js';

const app = document.querySelector('.app');
const $ = (sel) => app.querySelector(sel);
const KEY = 'breadbot:v1';
const DEMO_TEXT = 'Staging demo: these saved settings are made up.';

const kindEls = [...app.querySelectorAll('.kinds .kind')];
const segEls = [...app.querySelectorAll('.seg [role="radio"]')];
const slider = $('#hydration');
const hydrationVal = $('#hydrationVal');
const countLabel = $('#countLabel');
const countVal = $('#countVal');
const minus = $('#countMinus');
const plus = $('#countPlus');
const sizeLabel = $('#sizeLabel');
const sizeVal = $('#sizeVal');
const otherWrap = $('#otherWrap');
const sizeOther = $('#sizeOther');
const sizeMsg = $('#sizeMsg');
const states = $('#states');
const sections = ['loafSec', 'ingSec', 'riseSec', 'bakeSec'].map((id) => document.getElementById(id));
const loafSvg = $('#loafSvg');
const waterRect = $('#loafWater');
const waterLine = $('#loafLine');
const waterLabel = $('#loafWaterLabel');
const totalText = $('#loafTotal');
const loavesHint = $('#loavesHint');
const ingLabel = $('#ingLabel');
const ingList = $('#ingredientsList');
const riseList = $('#riseList');
const bakeTemp = $('#bakeTemp');
const bakeTempHint = $('#bakeTempHint');
const bakeTime = $('#bakeTime');
const bakeSplit = $('#bakeSplit');
const bakeNote = $('#bakeNote');

// The drawn sample rows become the templates; they are removed from the
// screen and remade per render.
const ingRow = rowsFrom(ingList);
const riseRow = rowsFrom(riseList);

const TONE = { flour: 'd-flour', water: 'd-water', lev: 'd-lev', salt: 'd-salt' };

// ── Settings ──────────────────────────────────────────────────────────────
// Remembered per bread kind, in this browser. During a staging demo the
// settings come from the server and stay in memory only.

function defaultsFor(kind) {
  const b = BREADS[kind];
  return { hydration: b.hydration, count: b.count.def, size: b.size.def };
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && BREADS[s.kind] && s.byKind && typeof s.byKind === 'object') return s;
  } catch (_) {}
  return null;
}

let state = loadState() || { kind: 'sourdough', byKind: {} };
let demoActive = false;

function cur(kind = state.kind) {
  return { ...defaultsFor(kind), ...(state.byKind[kind] || {}) };
}

function save() {
  if (demoActive) return;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
}

function update(part) {
  state.byKind[state.kind] = { ...cur(), ...part };
  save();
  render();
}

function selectKind(kind) {
  if (!BREADS[kind]) return;
  state.kind = kind;
  save();
  render();
}

function normalize(s) {
  const kind = BREADS[s.kind] ? s.kind : 'sourdough';
  const byKind = {};
  for (const [k, v] of Object.entries(s.byKind || {})) {
    if (!BREADS[k] || !v || typeof v !== 'object') continue;
    const def = BREADS[k];
    const hy = Number(v.hydration);
    const c = Number(v.count);
    const z = Number(v.size);
    byKind[k] = {
      hydration: Number.isFinite(hy) ? Math.min(90, Math.max(60, Math.round(hy))) : def.hydration,
      count: Number.isFinite(c) ? Math.min(def.count.max, Math.max(def.count.min, Math.round(c))) : def.count.def,
      size: Number.isFinite(z) && String(v.size).trim() !== '' ? z : def.size.def,
    };
  }
  return { kind, byKind };
}

// ── The recipe area's states ──────────────────────────────────────────────

function showState(node) {
  sections.forEach((el) => { el.hidden = true; });
  states.replaceChildren(node);
  states.hidden = false;
}

function showRecipe() {
  states.hidden = true;
  states.replaceChildren();
  sections.forEach((el) => { el.hidden = false; });
}

function showSkeleton() {
  showState(h('div', { class: 'flex flex-col gap-7', 'aria-hidden': 'true' },
    h('div', { class: 'skeleton h-40 w-full' }),
    h('div', { class: 'list' },
      [1, 2, 3, 4].map(() => h('div', { class: 'kit-skeleton-row' },
        h('div', { class: 'skeleton h-4 w-1/3' }),
        h('div', { class: 'skeleton h-4 w-1/4' }))))));
}

let demoError = null;

function showDemoError() {
  if (demoError) return;
  demoError = h('div', { class: 'state-error', role: 'alert' },
    h('p', { class: 'text-small text-fg' }, 'The staging demo settings did not load. The calculator still works.'),
    h('button', { class: 'btn-secondary text-small', on: { click: retryDemo } }, 'Retry'));
  app.prepend(demoError);
}

function clearDemoError() {
  if (demoError) {
    demoError.remove();
    demoError = null;
  }
}

async function loadDemo() {
  try {
    const r = await api('GET', '/api/demo');
    if (r && r.demo && r.settings) {
      state = normalize(r.settings);
      demoActive = true;
      showDemoLabel(app, DEMO_TEXT);
      clearDemoError();
    }
  } catch (_) {
    showDemoError();
  }
}

async function retryDemo() {
  clearDemoError();
  showSkeleton();
  await loadDemo();
  render();
}

// ── Render ────────────────────────────────────────────────────────────────

// An SVG geometry attribute, also set as a style property so a
// prefers-reduced-motion: no-preference browser can transition it.
function geom(el, attr, val) {
  el.setAttribute(attr, val);
  try { el.style[attr] = val + 'px'; } catch (_) {}
}

function render() {
  const b = BREADS[state.kind];
  const s = cur();
  const res = calculate(state.kind, s.hydration, s.count, s.size);

  // Controls read back from the state (focus is never moved here).
  const presets = b.size.presets;
  const chosen = presets.indexOf(Number(s.size));
  const other = chosen === -1;
  const checked = other ? 3 : chosen;
  segEls.forEach((el, i) => {
    if (i < 3) el.textContent = `${presets[i]} g`;
    el.setAttribute('aria-checked', String(i === checked));
    el.tabIndex = i === checked ? 0 : -1;
  });
  sizeLabel.textContent = b.size.label;
  sizeVal.textContent = String(s.size).trim() !== '' && Number.isFinite(Number(s.size)) ? `${s.size} g` : '—';
  otherWrap.hidden = !other;
  if (document.activeElement !== sizeOther) sizeOther.value = other ? String(s.size) : '';

  countLabel.textContent = b.count.label;
  countVal.textContent = String(s.count);
  minus.disabled = s.count <= b.count.min;
  plus.disabled = s.count >= b.count.max;

  kindEls.forEach((el) => {
    const on = el.dataset.kind === state.kind;
    el.setAttribute('aria-checked', String(on));
    el.tabIndex = on ? 0 : -1;
  });

  if (res.error === 'size') {
    sizeOther.setAttribute('aria-invalid', 'true');
    sizeMsg.hidden = false;
    showState(h('div', { class: 'state-empty' },
      h('p', { class: 'text-body font-medium text-fg' }, 'Enter a loaf size to see your recipe'),
      h('p', { class: 'text-small text-muted' }, 'Enter a size between 50 and 3,000 g.')));
    return;
  }
  sizeOther.removeAttribute('aria-invalid');
  sizeMsg.hidden = true;

  showRecipe();

  const n = res.settings.count;
  const noun = n === 1 ? b.size.noun : b.size.plural;
  loavesHint.textContent = `${n} ${noun}`;
  ingLabel.textContent = `Ingredients for ${n} ${noun}`;

  // The loaf: the blue water line rides up with hydration. 140 is the
  // dough floor, 90 the drawing's full height of the water range.
  const hy = res.settings.hydration / 100;
  const y = Math.round(140 - hy * 90);
  geom(waterRect, 'y', y);
  geom(waterRect, 'height', 143 - y);
  geom(waterLine, 'y1', y);
  geom(waterLine, 'y2', y);
  geom(waterLabel, 'y', y + 22);
  waterLabel.textContent = `Water ${res.settings.hydration}%`;
  totalText.textContent = `${res.totalDough.toLocaleString('en')} g of dough`;
  loafSvg.setAttribute('aria-label', `Water is ${res.settings.hydration}% of the flour by weight`);

  ingList.replaceChildren();
  for (const ing of res.ingredients) {
    const row = ingRow();
    row.querySelector('.dot').className = `dot ${TONE[ing.tone]}`;
    fillIn(row, { b: ing.name, small: ing.note });
    row.querySelector('.g').firstChild.nodeValue = String(ing.grams);
    ingList.append(row);
  }

  riseList.replaceChildren();
  res.steps.forEach((st, i) => {
    const row = riseRow();
    fillIn(row, { '.num': String(i + 1), b: st.name, small: st.what, '.dur': st.dur });
    riseList.append(row);
  });

  bakeTemp.textContent = res.bake.temp;
  bakeTempHint.textContent = res.bake.tempHint;
  bakeTime.textContent = res.bake.time;
  bakeSplit.textContent = res.bake.split;
  bakeSplit.hidden = !res.bake.split;
  bakeNote.textContent = res.bake.note;

  slider.value = String(res.settings.hydration);
  hydrationVal.textContent = `${res.settings.hydration}%`;
  slider.style.setProperty('--p', `${((res.settings.hydration - 60) / 30) * 100}%`);
}

// ── Wiring ────────────────────────────────────────────────────────────────

function wireRadios(els, onPick) {
  els.forEach((el, i) => {
    el.addEventListener('click', () => onPick(i));
    el.addEventListener('keydown', (e) => {
      const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      const n = (i + dir + els.length) % els.length;
      onPick(n);
      els[n].focus();
    });
  });
}

wireRadios(kindEls, (i) => selectKind(KIND_ORDER[i]));

wireRadios(segEls, (i) => {
  if (i < 3) {
    update({ size: BREADS[state.kind].size.presets[i] });
  } else {
    // Keep a size that is already off-preset; start blank otherwise.
    const presets = BREADS[state.kind].size.presets;
    const s = cur();
    const keep = presets.includes(Number(s.size)) ? '' : String(s.size);
    update({ size: keep });
    sizeOther.focus();
  }
});

slider.addEventListener('input', () => update({ hydration: Number(slider.value) }));

minus.addEventListener('click', () => update({ count: cur().count - 1 }));
plus.addEventListener('click', () => update({ count: cur().count + 1 }));

sizeOther.addEventListener('input', () => update({ size: sizeOther.value }));

// ── Boot ──────────────────────────────────────────────────────────────────

if (isDemo()) {
  showSkeleton();
  loadDemo().then(render);
} else {
  render();
}