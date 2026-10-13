// bread.js: the bread maths, pure — no DOM, so Node can test it.
//
// All ingredient percentages are of the TOTAL flour T, which includes the
// flour inside the starter (a starter is 100% hydration: half flour, half
// water). Hydration h is total water over T, starter water included, so
// added water = h·T − starter/2 and added flour = T − starter/2.

/** °C to °F, rounded to the nearest 5 °F. */
export function cToF(c) {
  return Math.round(((c * 9) / 5 + 32) / 5) * 5;
}

/** The gauge's zone word for a hydration percentage. */
export function zoneOf(h) {
  if (h < 62) return 'stiff';
  if (h <= 75) return 'soft';
  return 'slack';
}

// Display order of the five kinds.
export const KIND_ORDER = ['sourdough', 'bagels', 'sourdoughBagels', 'rye', 'sandwich'];

// Bake stage icons are drawn in app.js; `scaled` stages take the minutes
// bakeMinutes() returns. fixedMinutes are the minutes of the unscaled oven
// stages, summed into the bake heading (the boiling stage is per side and
// not counted).
export const BREADS = {
  sourdough: {
    name: 'Sourdough',
    unit: { one: 'loaf', many: 'loaves' },
    defaults: { hydration: 75, count: 1, size: 900 },
    ranges: { hydration: [50, 90], count: [1, 12], size: [300, 2000] },
    step: { size: 50 },
    typical: { lo: 70, hi: 80 },
    insideNote: 'An open, airy crumb that takes a little practice to shape.',
    usesStarter: true,
    ingredients: [
      { key: 'flour', name: 'Bread flour' },
      { key: 'water', name: 'Water', note: 'Lukewarm, about 26 °C' },
      { key: 'starter', name: 'Active starter', note: 'Fed and bubbly, 100% hydration' },
      { key: 'salt', name: 'Salt', pct: 2 },
    ],
    rise: {
      total: 'About 1 day',
      steps: [
        { name: 'Mix and rest', hint: 'Flour and water, then starter and salt', duration: '45 min' },
        { name: 'Bulk rise', hint: 'At room temperature, folding every 30 min for the first 2 hours, until risen by half', duration: '4 to 5 h', rise: true },
        { name: 'Shape', hint: 'Pre-shape, rest 20 min, shape tight', duration: '30 min' },
        { name: 'Cold proof', hint: 'Covered, in the fridge', duration: '12 to 16 h', rise: true },
      ],
    },
    bake: {
      tempC: 250,
      preheat: 'Preheat the oven with a Dutch oven inside for 45 min.',
      per: 'per loaf',
      defaultSize: 900,
      fixedMinutes: 20,
      lastBase: 25,
      roundTo: 5,
      stages: [
        { icon: 'lid', text: '20 min at 250 °C, lid on' },
        { icon: 'pot', scaled: true, text: (m) => `${m} min at 230 °C (${cToF(230)} °F), lid off`, done: 'Until deep brown and 96 °C inside' },
      ],
      cool: 'Cool 1 hour before slicing.',
      oneAtATime: 'Bake one loaf at a time.',
    },
  },

  bagels: {
    name: 'Bagels',
    unit: { one: 'bagel', many: 'bagels' },
    defaults: { hydration: 58, count: 8, size: 110 },
    ranges: { hydration: [50, 90], count: [1, 24], size: [60, 200] },
    step: { size: 10 },
    typical: { lo: 55, hi: 62 },
    insideNote: 'A dense, chewy dough that holds its shape in the water.',
    usesStarter: false,
    ingredients: [
      { key: 'flour', name: 'Bread flour' },
      { key: 'water', name: 'Water', note: 'Lukewarm, about 26 °C' },
      { key: 'yeast', name: 'Yeast', note: 'Instant dry yeast', pct: 1 },
      { key: 'salt', name: 'Salt', pct: 2 },
      { key: 'malt', name: 'Barley malt syrup', pct: 4 },
    ],
    rise: {
      total: 'About 15 h, mostly overnight',
      steps: [
        { name: 'Mix and knead', hint: 'A firm dough; knead until it springs back', duration: '15 min' },
        { name: 'Bulk rise', hint: 'Covered, at room temperature', duration: '1 h', rise: true },
        { name: 'Shape', hint: 'Roll ropes, ring them around two fingers', duration: '20 min' },
        { name: 'Cold proof', hint: 'On a lined tray, in the fridge', duration: '12 to 18 h', rise: true },
      ],
    },
    bake: {
      tempC: 230,
      preheat: 'Preheat the oven to 230 °C.',
      per: 'per tray',
      defaultSize: 110,
      fixedMinutes: 0,
      lastBase: 18,
      roundTo: 1,
      stages: [
        { icon: 'boil', text: 'Boil 1 min per side in water with a spoon of malt syrup' },
        { icon: 'pot', scaled: true, text: (m) => `${m} min at 230 °C on a lined tray`, done: 'Until glossy and deep golden brown' },
      ],
      cool: 'Cool 30 min on a rack.',
      oneAtATime: null,
    },
  },

  sourdoughBagels: {
    name: 'Sourdough bagels',
    unit: { one: 'bagel', many: 'bagels' },
    defaults: { hydration: 60, count: 8, size: 110 },
    ranges: { hydration: [50, 90], count: [1, 24], size: [60, 200] },
    step: { size: 10 },
    typical: { lo: 56, hi: 63 },
    insideNote: 'Chewy like a bagel, with a deeper sour flavour.',
    usesStarter: true,
    ingredients: [
      { key: 'flour', name: 'Bread flour' },
      { key: 'water', name: 'Water', note: 'Lukewarm, about 26 °C' },
      { key: 'starter', name: 'Active starter', note: 'Fed and bubbly, 100% hydration' },
      { key: 'salt', name: 'Salt', pct: 2 },
      { key: 'malt', name: 'Barley malt syrup', pct: 4 },
    ],
    rise: {
      total: 'About 1 day',
      steps: [
        { name: 'Mix and knead', hint: 'A firm dough; knead until it springs back', duration: '15 min' },
        { name: 'Bulk rise', hint: 'Covered, at room temperature', duration: '4 to 6 h', rise: true },
        { name: 'Shape', hint: 'Roll ropes, ring them around two fingers', duration: '20 min' },
        { name: 'Cold proof', hint: 'On a lined tray, in the fridge', duration: '12 to 18 h', rise: true },
      ],
    },
    bake: {
      tempC: 230,
      preheat: 'Preheat the oven to 230 °C.',
      per: 'per tray',
      defaultSize: 110,
      fixedMinutes: 0,
      lastBase: 20,
      roundTo: 1,
      stages: [
        { icon: 'boil', text: 'Boil 1 min per side in water with a spoon of malt syrup' },
        { icon: 'pot', scaled: true, text: (m) => `${m} min at 230 °C on a lined tray`, done: 'Until glossy and deep golden brown' },
      ],
      cool: 'Cool 30 min on a rack.',
      oneAtATime: null,
    },
  },

  rye: {
    name: 'Rye',
    unit: { one: 'loaf', many: 'loaves' },
    defaults: { hydration: 78, count: 1, size: 900 },
    ranges: { hydration: [50, 90], count: [1, 12], size: [300, 1500] },
    step: { size: 50 },
    typical: { lo: 70, hi: 85 },
    insideNote: 'A dense, moist crumb that keeps well.',
    usesStarter: false,
    flourSplit: { rye: 0.6, flour: 0.4 },
    ingredients: [
      { key: 'rye', name: 'Rye flour' },
      { key: 'flour', name: 'Bread flour' },
      { key: 'water', name: 'Water', note: 'Lukewarm, about 26 °C' },
      { key: 'yeast', name: 'Yeast', note: 'Instant dry yeast', pct: 1.5 },
      { key: 'salt', name: 'Salt', pct: 2 },
      { key: 'caraway', name: 'Caraway seeds', pct: 1.5 },
    ],
    rise: {
      total: 'About 4 h',
      steps: [
        { name: 'Mix', hint: 'A sticky paste, no kneading', duration: '10 min' },
        { name: 'Bulk rise', hint: 'Covered, at room temperature', duration: '1 to 1.5 h', rise: true },
        { name: 'Shape', hint: 'Into a greased tin, with wet hands', duration: '10 min' },
        { name: 'Proof', hint: 'In the tin, until cracks show on top', duration: '45 min to 1 h', rise: true },
      ],
    },
    bake: {
      tempC: 240,
      preheat: 'Preheat the oven to 240 °C.',
      per: 'per loaf',
      defaultSize: 900,
      fixedMinutes: 10,
      lastBase: 45,
      roundTo: 5,
      stages: [
        { icon: 'pot', text: '10 min at 240 °C' },
        { icon: 'pot', scaled: true, text: (m) => `${m} min at 200 °C`, done: 'Until 98 °C inside' },
      ],
      cool: 'Rest 12 to 24 h before slicing.',
      oneAtATime: null,
    },
  },

  sandwich: {
    name: 'Sandwich loaf',
    unit: { one: 'loaf', many: 'loaves' },
    defaults: { hydration: 64, count: 1, size: 850 },
    ranges: { hydration: [50, 90], count: [1, 12], size: [400, 1500] },
    step: { size: 50 },
    typical: { lo: 60, hi: 68 },
    insideNote: 'A soft, fine crumb built for slicing.',
    usesStarter: false,
    ingredients: [
      { key: 'flour', name: 'Bread flour' },
      { key: 'water', name: 'Water', note: 'Warm, about 30 °C' },
      { key: 'yeast', name: 'Yeast', note: 'Instant dry yeast', pct: 1.5 },
      { key: 'salt', name: 'Salt', pct: 2 },
      { key: 'sugar', name: 'Sugar', pct: 5 },
      { key: 'butter', name: 'Butter', note: 'Soft, at room temperature', pct: 8 },
    ],
    rise: {
      total: 'About 3.5 h',
      steps: [
        { name: 'Mix and knead', hint: 'Until smooth and elastic', duration: '10 to 15 min' },
        { name: 'Bulk rise', hint: 'Covered, until doubled', duration: '1 to 1.5 h', rise: true },
        { name: 'Shape', hint: 'Into a buttered tin', duration: '10 min' },
        { name: 'Proof', hint: 'In the tin, until 2 cm above the rim', duration: '45 min to 1 h', rise: true },
      ],
    },
    bake: {
      tempC: 190,
      preheat: 'Preheat the oven to 190 °C.',
      per: 'per loaf',
      defaultSize: 850,
      fixedMinutes: 0,
      lastBase: 35,
      roundTo: 5,
      stages: [
        { icon: 'pot', scaled: true, text: (m) => `${m} min at 190 °C`, done: 'Until golden and 93 °C inside' },
      ],
      cool: 'Cool 1 hour in a rack.',
      oneAtATime: null,
    },
  },
};

/** The kind's settings clamped to its limits, as whole numbers. */
export function clampSettings(settings) {
  const kind = BREADS[settings.kind];
  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(Number(v))));
  return {
    kind: settings.kind,
    hydration: clamp(settings.hydration, kind.ranges.hydration),
    count: clamp(settings.count, kind.ranges.count),
    size: clamp(settings.size, kind.ranges.size),
  };
}

/**
 * Whether a settings object is typeable as it stands: one message per field,
 * or null when the field is fine. Empty and non-finite values are invalid.
 */
export function validate(settings) {
  const kind = BREADS[settings.kind];
  const check = (value, [lo, hi], whole) => {
    if (!Number.isFinite(value)) return 'Type a number';
    if (value < lo || value > hi) return `Between ${lo} and ${hi}`;
    if (whole && !Number.isInteger(value)) return 'A whole number';
    return null;
  };
  return {
    hydration: check(settings.hydration, kind.ranges.hydration, false),
    count: check(settings.count, kind.ranges.count, true),
    size: check(settings.size, kind.ranges.size, true),
  };
}

/** The minutes of a bake's last (scaled) stage for a dough weight. */
export function bakeMinutes(kind, size) {
  const bake = BREADS[kind].bake;
  const raw = bake.lastBase * Math.sqrt(size / bake.defaultSize);
  const step = bake.roundTo;
  return Math.max(10, Math.round(raw / step) * step);
}

/**
 * Largest-remainder rounding: whole grams for each part that sum to exactly
 * `total`. parts: [{ key, value }] with exact (fractional) grams.
 */
export function roundToTotal(parts, total) {
  const floors = parts.map((p) => Math.floor(p.value));
  let left = total - floors.reduce((s, n) => s + n, 0);
  const order = parts
    // Quantise the fractions so float noise can't break a real tie.
    .map((p, i) => [Math.round((p.value - floors[i]) * 1e9) / 1e9, i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const out = {};
  parts.forEach((p, i) => { out[p.key] = floors[i]; });
  for (let k = 0; left > 0; k += 1, left -= 1) out[parts[order[k % order.length][1]].key] += 1;
  return out;
}

/** The one line under the gauge for this hydration. */
export function gaugeNote(kindKey, hydration) {
  const kind = BREADS[kindKey];
  const base = `Typical for ${kind.name.toLowerCase()}: ${kind.typical.lo} to ${kind.typical.hi}%.`;
  const line = hydration < kind.typical.lo
    ? 'Stiffer than usual: a tighter crumb and easier shaping.'
    : hydration > kind.typical.hi
      ? 'Wetter than usual: expect a sticky, slack dough.'
      : kind.insideNote;
  return `${base} ${line}`;
}

/**
 * Everything the screen shows for a settings object: the ingredient grams
 * (summing exactly to count × size), the rise schedule and the bake card.
 */
export function calculate(settings) {
  const kind = BREADS[settings.kind];
  const h = settings.hydration / 100;
  const total = settings.count * settings.size;
  const othersSum = kind.ingredients.reduce((s, ing) => s + (ing.pct || 0), 0) / 100;
  const T = total / (1 + h + othersSum);
  const starter = kind.usesStarter ? 0.2 * T : 0;

  const parts = kind.ingredients.map((ing) => {
    if (ing.key === 'water') return { key: 'water', value: h * T - starter / 2 };
    if (ing.key === 'starter') return { key: 'starter', value: starter };
    if (kind.flourSplit && kind.flourSplit[ing.key] != null) {
      return { key: ing.key, value: kind.flourSplit[ing.key] * T };
    }
    if (ing.pct == null) return { key: ing.key, value: T - starter / 2 };
    return { key: ing.key, value: (ing.pct / 100) * T };
  });
  const grams = roundToTotal(parts, total);

  const bake = kind.bake;
  const lastMinutes = bakeMinutes(settings.kind, settings.size);
  return {
    kind: settings.kind,
    hydration: settings.hydration,
    count: settings.count,
    size: settings.size,
    total,
    ingredients: kind.ingredients.map((ing) => ({
      key: ing.key, name: ing.name, note: ing.note || null, grams: grams[ing.key],
    })),
    usesStarter: !!kind.usesStarter,
    rise: kind.rise,
    gauge: { typical: kind.typical, zone: zoneOf(settings.hydration), note: gaugeNote(settings.kind, settings.hydration) },
    bake: {
      tempC: bake.tempC,
      tempF: cToF(bake.tempC),
      preheat: bake.preheat,
      per: bake.per,
      minutes: bake.fixedMinutes + lastMinutes,
      stages: bake.stages.map((stage) => ({
        icon: stage.icon,
        text: stage.scaled ? stage.text(lastMinutes) : stage.text,
        done: stage.done || null,
      })),
      cool: bake.cool,
      oneAtATime: bake.oneAtATime && settings.count > 1 ? bake.oneAtATime : null,
    },
  };
}