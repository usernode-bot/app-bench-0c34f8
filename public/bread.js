// Bread Bot's bread table and the pure calculation behind the formula card.
// Plain objects in, plain objects out: no DOM, no fetching, no state — the
// screen in app.js renders whatever calc() returns.
//
// Percentages are baker's percentages, of the total flour T. The starter is
// kept at 100% hydration (half flour, half water), so a 20% starter adds 10%
// flour and 10% water, and the hydration number counts what is in the
// starter. T = dough / (1 + hydration + the other percentages), with the
// starter's own percentage left out of that sum (see the spec's formula).

const BREADS = {
  sourdough: {
    name: 'Sourdough',
    hydration: { def: 75, min: 65, max: 90, note: 'Sourdough usually 70 to 80%' },
    unit: { label: 'Loaves', sizeLabel: 'Loaf size', one: 'loaf', many: 'loaves', min: 1, max: 12 },
    sizes: { small: 500, medium: 900, large: 1200 },
    leaven: 'starter',
    starterPct: 20,
    yeastPct: 0,
    flours: [{ name: 'Bread flour', pct: 100 }],
    extras: [],
    rise: [
      { name: 'Bulk rise', sub: 'covered, at about 24°C / 75°F, with folds in the first 2 h', time: '4 to 6 h' },
      { name: 'Shape, then final proof', sub: 'in the fridge, or 1 to 2 h on the counter', time: '8 to 14 h' },
    ],
    bake: [
      { name: 'Lid on', sub: 'in a preheated Dutch oven', temp: '250°C / 480°F',
        times: { small: '20 min', medium: '20 min', large: '20 min' } },
      { name: 'Lid off', sub: 'until deep brown, 96°C / 205°F inside', temp: '230°C / 450°F',
        times: { small: '15 to 20 min', medium: '20 to 25 min', large: '30 to 35 min' } },
    ],
  },
  bagels: {
    name: 'Bagels',
    hydration: { def: 58, min: 50, max: 65, note: 'Bagels usually 55 to 60%' },
    unit: { label: 'Bagels', sizeLabel: 'Bagel size', one: 'bagel', many: 'bagels', min: 1, max: 24 },
    sizes: { small: 90, medium: 115, large: 140 },
    leaven: 'yeast',
    starterPct: 0,
    yeastPct: 1,
    flours: [{ name: 'Bread flour', pct: 100 }],
    extras: [{ icon: 'malt', name: 'Malt syrup or sugar', pct: 4 }],
    rise: [
      { name: 'First rise', sub: 'covered, until puffy', time: '1 h' },
      { name: 'Shape, then cold proof', sub: 'in the fridge, on a lined tray', time: '8 to 12 h' },
    ],
    bake: [
      { name: 'Boil', sub: '1 min a side, then drain well', time: '1 min a side' },
      { name: 'Bake', sub: 'on a lined tray, well spaced', temp: '220°C / 425°F',
        times: { small: '15 to 19 min', medium: '18 to 22 min', large: '21 to 25 min' } },
    ],
  },
  'sourdough-bagels': {
    name: 'Sourdough bagels',
    hydration: { def: 58, min: 50, max: 65, note: 'Sourdough bagels usually 55 to 60%' },
    unit: { label: 'Bagels', sizeLabel: 'Bagel size', one: 'bagel', many: 'bagels', min: 1, max: 24 },
    sizes: { small: 90, medium: 115, large: 140 },
    leaven: 'starter',
    starterPct: 20,
    yeastPct: 0,
    flours: [{ name: 'Bread flour', pct: 100 }],
    extras: [{ icon: 'malt', name: 'Malt syrup or sugar', pct: 4 }],
    rise: [
      { name: 'Bulk rise', sub: 'covered, at room temperature', time: '4 to 5 h' },
      { name: 'Shape, then cold proof', sub: 'in the fridge, on a lined tray', time: '8 to 14 h' },
    ],
    bake: [
      { name: 'Boil', sub: '1 min a side, then drain well', time: '1 min a side' },
      { name: 'Bake', sub: 'on a lined tray, well spaced', temp: '220°C / 425°F',
        times: { small: '17 to 21 min', medium: '20 to 24 min', large: '23 to 27 min' } },
    ],
  },
  rye: {
    name: 'Rye',
    hydration: { def: 78, min: 65, max: 90, note: 'Rye usually 75 to 85%' },
    unit: { label: 'Loaves', sizeLabel: 'Loaf size', one: 'loaf', many: 'loaves', min: 1, max: 12 },
    sizes: { small: 500, medium: 900, large: 1200 },
    leaven: 'yeast',
    starterPct: 0,
    yeastPct: 1.5,
    flours: [{ name: 'Rye flour', pct: 70 }, { name: 'Bread flour', pct: 30 }],
    extras: [],
    rise: [
      { name: 'First rise', sub: 'covered, in the bowl', time: '1 to 1.5 h' },
      { name: 'Pan proof', sub: 'in a greased loaf pan', time: '45 to 60 min' },
    ],
    bake: [
      { name: 'Hot start', sub: 'with steam, on a baking stone or tray', temp: '230°C / 450°F',
        times: { small: '10 min', medium: '10 min', large: '10 min' } },
      { name: 'Reduce the heat', sub: 'until the loaf sounds hollow underneath', temp: '200°C / 400°F',
        times: { small: '30 to 40 min', medium: '40 to 50 min', large: '50 to 60 min' } },
    ],
  },
  'sandwich-loaf': {
    name: 'Sandwich loaf',
    hydration: { def: 62, min: 55, max: 72, note: 'Sandwich loaf usually 58 to 65%' },
    unit: { label: 'Loaves', sizeLabel: 'Loaf size', one: 'loaf', many: 'loaves', min: 1, max: 12 },
    sizes: { small: 500, medium: 900, large: 1200 },
    leaven: 'yeast',
    starterPct: 0,
    yeastPct: 1.5,
    flours: [{ name: 'Bread flour', pct: 100 }],
    extras: [
      { icon: 'sugar', name: 'Sugar', pct: 5 },
      { icon: 'butter', name: 'Butter', pct: 6 },
    ],
    rise: [
      { name: 'First rise', sub: 'covered, in the bowl', time: '1 to 1.5 h' },
      { name: 'Pan proof', sub: 'in a greased loaf pan, to the rim', time: '45 to 60 min' },
    ],
    bake: [
      { name: 'Bake', sub: 'on the middle shelf, until golden', temp: '190°C / 375°F',
        times: { small: '25 to 30 min', medium: '30 to 35 min', large: '40 to 45 min' } },
    ],
  },
};

/** "1,017" — whole numbers with thousands separators, as grams are shown. */
function fmtG(n) {
  return Math.round(n).toLocaleString('en-US');
}

/** The size whose weight is closest to a custom weight: its times apply. */
function nearestSizeKey(sizes, grams) {
  return Object.keys(sizes).reduce((best, key) =>
    (Math.abs(sizes[key] - grams) < Math.abs(sizes[best] - grams) ? key : best));
}

/**
 * calc({ type, hydration, count, size, customGrams }) — everything the
 * formula card shows, for the settings given. Returns { invalid: true } when
 * the settings cannot make a recipe (a custom weight outside 50 to 3,000 g).
 */
export function calc({ type, hydration, count, size, customGrams }) {
  const bread = BREADS[type];
  if (!bread) return { invalid: true };

  let sizeG;
  let sizeKey = size;
  if (size === 'custom') {
    const grams = Math.round(Number(customGrams));
    if (!Number.isFinite(grams) || grams < 50 || grams > 3000) return { invalid: true };
    sizeG = grams;
    sizeKey = nearestSizeKey(bread.sizes, grams);
  } else {
    sizeG = bread.sizes[size] ?? bread.sizes.medium;
  }

  const h = Math.min(bread.hydration.max,
    Math.max(bread.hydration.min, Math.round(Number(hydration) || bread.hydration.def)));
  const n = Math.min(bread.unit.max, Math.max(bread.unit.min, Math.round(Number(count) || 1)));

  const dough = n * sizeG;
  const otherPct = 2 + bread.yeastPct + bread.extras.reduce((sum, e) => sum + e.pct, 0);
  const T = dough / (1 + h / 100 + otherPct / 100);
  const starter = bread.leaven === 'starter' ? (bread.starterPct / 100) * T : 0;
  const starterFlourPct = starter ? bread.starterPct / 2 : 0;
  const g = (x) => Math.round(x);

  const ingredients = bread.flours.map((f) => ({
    icon: 'flour',
    name: f.name,
    pct: bread.flours.length === 1 ? 100 - starterFlourPct : f.pct,
    grams: g(bread.flours.length === 1 ? T - starter / 2 : (f.pct / 100) * T),
  }));
  ingredients.push({ icon: 'water', name: 'Water', pct: h - starterFlourPct, grams: g((h / 100) * T - starter / 2) });
  if (starter) {
    ingredients.push({ icon: 'starter', name: 'Starter', sub: 'active, 100% hydration', pct: bread.starterPct, grams: g(starter) });
  } else {
    ingredients.push({ icon: 'yeast', name: 'Instant yeast', pct: bread.yeastPct, grams: g((bread.yeastPct / 100) * T) });
  }
  for (const e of bread.extras) ingredients.push({ ...e, grams: g((e.pct / 100) * T) });
  ingredients.push({ icon: 'salt', name: 'Salt', pct: 2, grams: g(0.02 * T) });

  return {
    hydration: h,
    count: n,
    total: dough,
    totalLabel: `Dough for ${n} ${n === 1 ? bread.unit.one : bread.unit.many} of ${fmtG(sizeG)} g`,
    note: `${fmtG(T)} g flour to ${fmtG((h / 100) * T)} g water${starter ? ', counting what is in the starter' : ''}`,
    bar: { flour: (100 / (100 + h)) * 100, water: (h / (100 + h)) * 100 },
    ingredients,
    rise: bread.rise,
    bake: bread.bake.map((b) => ({ name: b.name, sub: b.sub, temp: b.temp, time: b.time || b.times[sizeKey] })),
  };
}

export const DEFAULTS = { type: 'sourdough', hydration: 75, count: 2, size: 'medium', customGrams: '' };
export { BREADS, fmtG };
