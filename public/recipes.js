// recipes.js: the bread tables and the pure calculation behind the screen.
// No DOM here: `calculate()` takes the dough settings and returns the recipe,
// or `{ error }` when the size is not a usable number of grams.
//
// Baker's percentages, one table per bread. Hydration is the whole dough's
// (the starter's flour and water counted in), so the water line is what you
// actually add. Total flour is dough / (1 + h + salt + yeast + extras); a
// starter's own flour and water are already inside h and the flour shares,
// so the starter adds nothing to the denominator and the ingredients sum
// exactly to the dough weight.
export const TYPES = [
  {
    id: 'sourdough',
    label: 'Sourdough',
    countLabel: 'Loaves', countWord: 'loaves', maxCount: 12,
    sizeLabel: 'Loaf size',
    sizes: [450, 680, 900, 1000], defaultSize: 900,
    defaultHydration: 75,
    flours: [['Bread flour', 0.9], ['Whole wheat flour', 0.1]],
    leaven: { kind: 'starter', pct: 0.2, name: 'Sourdough starter', note: 'fed, 100% hydration' },
    extras: [],
    rise: { minutes: 270, detail: 'Covered at about 24 °C, 4 sets of folds in the first 2 h, until risen by half' },
    proof: { minutes: 720, cold: true, detail: 'Shaped, in a floured basket, in the fridge' },
    bake: { c: 240, minutes: 45, tempNote: 'preheat a Dutch oven', timeNote: '20 lid on, 25 lid off' },
  },
  {
    id: 'bagels',
    label: 'Bagels',
    countLabel: 'Bagels', countWord: 'bagels', maxCount: 24,
    sizeLabel: 'Bagel size',
    sizes: [90, 110, 130], defaultSize: 110,
    defaultHydration: 58,
    flours: [['Bread flour', 1]],
    leaven: { kind: 'yeast', pct: 0.01, name: 'Instant yeast' },
    extras: [{ name: 'Malt syrup', pct: 0.03 }],
    rise: { minutes: 60, detail: 'Covered in the bowl, until puffy' },
    proof: { minutes: 720, cold: true, detail: 'Shaped, on lined sheets, in the fridge' },
    bake: { c: 220, minutes: 20, tempNote: 'boil 1 min a side first', timeNote: 'on a lined sheet' },
  },
  {
    id: 'sourdough-bagels',
    label: 'Sourdough bagels',
    countLabel: 'Bagels', countWord: 'bagels', maxCount: 24,
    sizeLabel: 'Bagel size',
    sizes: [90, 110, 130], defaultSize: 110,
    defaultHydration: 58,
    flours: [['Bread flour', 1]],
    leaven: { kind: 'starter', pct: 0.2, name: 'Sourdough starter', note: 'fed, 100% hydration' },
    extras: [{ name: 'Malt syrup', pct: 0.03 }],
    rise: { minutes: 300, detail: 'Covered at room temperature, until puffy' },
    proof: { minutes: 720, cold: true, detail: 'Shaped, on lined sheets, in the fridge' },
    bake: { c: 220, minutes: 22, tempNote: 'boil 1 min a side first', timeNote: 'on a lined sheet' },
  },
  {
    id: 'rye',
    label: 'Rye',
    countLabel: 'Loaves', countWord: 'loaves', maxCount: 12,
    sizeLabel: 'Loaf size',
    sizes: [450, 680, 900, 1000], defaultSize: 900,
    defaultHydration: 80,
    flours: [['Rye flour', 0.6], ['Bread flour', 0.4]],
    leaven: { kind: 'yeast', pct: 0.012, name: 'Instant yeast' },
    extras: [],
    rise: { minutes: 90, detail: 'Covered in the bowl, until risen by a third' },
    proof: { minutes: 60, cold: false, detail: 'Shaped, in a floured basket, in a warm spot' },
    bake: { c: 230, minutes: 40, tempNote: 'bake with steam', timeNote: 'on a baking stone' },
  },
  {
    id: 'sandwich-loaf',
    label: 'Sandwich loaf',
    countLabel: 'Loaves', countWord: 'loaves', maxCount: 12,
    sizeLabel: 'Loaf size',
    sizes: [450, 680, 900, 1000], defaultSize: 900,
    defaultHydration: 65,
    flours: [['Bread flour', 1]],
    leaven: { kind: 'yeast', pct: 0.015, name: 'Instant yeast' },
    extras: [{ name: 'Butter', pct: 0.06 }, { name: 'Sugar', pct: 0.04 }],
    rise: { minutes: 90, detail: 'Covered in the bowl, until doubled' },
    proof: { minutes: 60, cold: false, detail: 'Shaped, in the greased tin, until the dough crowns the rim' },
    bake: { c: 190, minutes: 35, tempNote: 'in a greased loaf tin', timeNote: 'golden on top when done' },
  },
];

export const typeById = (id) => TYPES.find((t) => t.id === id) || TYPES[0];

const SALT_PCT = 0.02;
const MIX_MINUTES = 20;
const MIN_SIZE = 50;
const MAX_SIZE = 3000;

/** Minutes as "20 min", "4 h 30", "12 h". */
export function fmtMin(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest}` : `${h} h`;
}

function fmtGrams(g, oneDecimalUnder10) {
  if (oneDecimalUnder10 && g < 10) return `${(Math.round(g * 10) / 10).toFixed(1)} g`;
  return `${Math.round(g).toLocaleString('en')} g`;
}

/**
 * calculate({ type, hydration, count, size }) -> the whole recipe.
 * `hydration` in percent (50-90), `count` loaves or bagels, `size` in grams.
 * Returns { error } when the size is blank, not a number, or outside
 * 50-3000 g, so no made-up zeros ever render.
 */
export function calculate({ type, hydration, count, size }) {
  const t = typeById(type);
  const grams = Number(size);
  if (!Number.isFinite(grams) || grams < MIN_SIZE || grams > MAX_SIZE) {
    return { error: `Enter a size from ${MIN_SIZE} to ${MAX_SIZE} g to see the recipe` };
  }

  const totalG = count * grams;
  const h = hydration / 100;
  const starter = t.leaven.kind === 'starter';
  // Dry yeast is added mass of its own, so it takes room in the denominator;
  // a starter's flour and water are already counted in h and the flour
  // shares (carved out of the added rows below).
  const leavenPct = starter ? 0 : t.leaven.pct;
  // A 100% hydration starter at `pct` of the total flour: half of it is
  // flour, half water, and both come out of the added flour and water.
  const starterShare = starter ? t.leaven.pct / 2 : 0;
  const extrasPct = t.extras.reduce((sum, e) => sum + e.pct, 0);
  const F = totalG / (1 + h + SALT_PCT + leavenPct + extrasPct);

  const ingredients = t.flours.map(([name, share]) => ({
    name,
    note: '',
    pct: Math.round(share * 100) - (starter ? Math.round((starterShare * share) * 100) : 0),
    grams: share * F - (starter ? starterShare * F * share : 0),
  }));

  const waterPct = Math.round((h - starterShare) * 100);
  ingredients.push({ name: 'Water', note: '', pct: waterPct, grams: (h - starterShare) * F });

  if (starter) {
    ingredients.push({
      name: t.leaven.name,
      note: t.leaven.note,
      pct: Math.round(t.leaven.pct * 100),
      grams: t.leaven.pct * F,
    });
  }

  for (const e of t.extras) {
    ingredients.push({ name: e.name, note: '', pct: Math.round(e.pct * 100), grams: e.pct * F });
  }
  if (!starter) {
    const yeastPct = t.leaven.pct * 100;
    ingredients.push({
      name: t.leaven.name,
      note: '',
      pct: `${Number.isInteger(yeastPct) ? yeastPct : yeastPct.toFixed(1)}%`,
      grams: t.leaven.pct * F,
    });
  }
  ingredients.push({ name: 'Salt', note: '', pct: 2, grams: SALT_PCT * F });

  // Yeast under 10 g gets one decimal.
  for (const ing of ingredients) {
    ing.text = fmtGrams(ing.grams, ing.name === 'Instant yeast');
  }

  const steps = [
    { name: 'Mix', minutes: MIX_MINUTES, cold: false, detail: '' },
    { name: 'First rise', minutes: t.rise.minutes, cold: false, detail: t.rise.detail },
    { name: 'Proof', minutes: t.proof.minutes, cold: t.proof.cold, detail: t.proof.detail },
    { name: 'Bake', minutes: t.bake.minutes, cold: false, detail: '' },
  ];

  return {
    totalG,
    type: t,
    hydration,
    count,
    size: grams,
    ingredients,
    steps,
    bake: {
      c: t.bake.c,
      f: Math.round((t.bake.c * 9) / 5 + 32),
      minutes: t.bake.minutes,
      tempNote: t.bake.tempNote,
      timeNote: t.bake.timeNote,
    },
    totalTime: MIX_MINUTES + t.rise.minutes + t.proof.minutes + t.bake.minutes,
  };
}
