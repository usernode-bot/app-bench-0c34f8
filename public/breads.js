// Bread Bot's recipe data and maths. Pure: no DOM, so it can be reasoned
// about and tested on its own. All recipe maths lives in this file
// (CLAUDE.md's app-specific note).
//
// Percentages are of total flour, as bakers write them. `water: true` marks
// the row whose percentage is the hydration setting. `starter: true` marks
// the leaven, assumed to be half flour and half water.

export const BREADS = {
  sourdough: {
    id: 'sourdough',
    name: 'Sourdough',
    noun: ['loaf', 'loaves'],
    shapeUnit: 'pieces',
    icon: 'loaf',
    typical: { hydration: 75, count: 1, size: 900 },
    hasStarter: true,
    ingredients: [
      { name: 'Bread flour', pct: 100, tone: 'flour', label: 'Flour' },
      { name: 'Water', pct: 0, tone: 'water', water: true, label: 'Water' },
      { name: 'Active sourdough starter', pct: 20, tone: 'leaven', starter: true, label: 'Starter', note: 'fed and bubbly' },
      { name: 'Salt', pct: 2, tone: 'salt' },
    ],
    steps: [
      { icon: 'rise', title: 'Bulk rise', meta: '4 to 5 h at about 24 °C', sub: 'Stretch and fold every 30 min for the first 2 h. Done when it has grown by half.' },
      { icon: 'shape', title: 'Divide and shape', sub: 'Shape into tight rounds and put them in floured baskets.' },
      { icon: 'fridge', title: 'Cold proof', meta: '12 to 16 h in the fridge', sub: 'Bake straight from the fridge.' },
    ],
    bake: {
      phases: [
        { label: 'Lid on', c: 250, min: 20 },
        { label: 'Lid off', c: 230, min: 25 },
      ],
      refSize: 900,
      sub: 'In a preheated Dutch oven, one loaf at a time.',
      done: 'Done at 96 °C inside, or when the base sounds hollow.',
    },
  },

  bagels: {
    id: 'bagels',
    name: 'Bagels',
    noun: ['bagel', 'bagels'],
    shapeUnit: 'rings',
    icon: 'bagel',
    typical: { hydration: 58, count: 8, size: 110 },
    ingredients: [
      { name: 'Bread flour', pct: 100, tone: 'flour', label: 'Flour' },
      { name: 'Water', pct: 0, tone: 'water', water: true, label: 'Water' },
      { name: 'Instant yeast', pct: 1, tone: 'leaven' },
      { name: 'Salt', pct: 2, tone: 'salt' },
      { name: 'Barley malt syrup', pct: 4, tone: 'sweet' },
    ],
    steps: [
      { icon: 'rise', title: 'Knead', meta: '8 to 10 min', sub: 'Until smooth and elastic — this is a stiff dough.' },
      { icon: 'rise', title: 'First rise', meta: '1 h at room temperature', sub: 'Cover the bowl so it does not dry out.' },
      { icon: 'shape', title: 'Divide and shape', sub: 'Roll each piece into a rope, then join it into a ring.' },
      { icon: 'fridge', title: 'Cold proof', meta: '8 to 24 h in the fridge', sub: 'Well covered, so they keep their shape.' },
      { icon: 'boil', title: 'Boil', meta: '30 to 60 s per side', sub: 'A few at a time in simmering water with a spoon of barley malt syrup.' },
    ],
    bake: {
      phases: [{ label: 'Bake', c: 230, min: 18 }],
      refSize: 110,
      sub: 'On a lined tray, straight from the boil.',
      done: 'Done when deep golden brown and firm.',
    },
  },

  'sourdough-bagels': {
    id: 'sourdough-bagels',
    name: 'Sourdough bagels',
    noun: ['bagel', 'bagels'],
    shapeUnit: 'rings',
    icon: 'sourdough-bagel',
    typical: { hydration: 58, count: 8, size: 110 },
    hasStarter: true,
    ingredients: [
      { name: 'Bread flour', pct: 100, tone: 'flour', label: 'Flour' },
      { name: 'Water', pct: 0, tone: 'water', water: true, label: 'Water' },
      { name: 'Active sourdough starter', pct: 20, tone: 'leaven', starter: true, label: 'Starter', note: 'fed and bubbly' },
      { name: 'Salt', pct: 2, tone: 'salt' },
      { name: 'Barley malt syrup', pct: 4, tone: 'sweet' },
    ],
    steps: [
      { icon: 'rise', title: 'Bulk rise', meta: '4 to 5 h at about 24 °C', sub: 'Stretch and fold every 30 min for the first 2 h.' },
      { icon: 'shape', title: 'Divide and shape', sub: 'Roll each piece into a rope, then join it into a ring.' },
      { icon: 'fridge', title: 'Cold proof', meta: '12 to 16 h in the fridge', sub: 'Well covered, so they keep their shape.' },
      { icon: 'boil', title: 'Boil', meta: '30 to 60 s per side', sub: 'A few at a time in simmering water with a spoon of barley malt syrup.' },
    ],
    bake: {
      phases: [{ label: 'Bake', c: 230, min: 20 }],
      refSize: 110,
      sub: 'On a lined tray, straight from the boil.',
      done: 'Done when deep golden brown and firm.',
    },
  },

  rye: {
    id: 'rye',
    name: 'Rye',
    noun: ['loaf', 'loaves'],
    shapeUnit: 'pieces',
    icon: 'rye',
    typical: { hydration: 75, count: 1, size: 1000 },
    hasStarter: true,
    ingredients: [
      { name: 'Rye flour', pct: 70, tone: 'rye', label: 'Rye' },
      { name: 'Bread flour', pct: 30, tone: 'flour', label: 'Flour' },
      { name: 'Water', pct: 0, tone: 'water', water: true, label: 'Water' },
      { name: 'Rye sourdough starter', pct: 25, tone: 'leaven', starter: true, label: 'Starter', note: 'rye-fed and active' },
      { name: 'Salt', pct: 2, tone: 'salt' },
    ],
    steps: [
      { icon: 'rise', title: 'Mix', meta: 'No kneading', sub: 'Stir to a thick paste: rye has little gluten to build.' },
      { icon: 'rise', title: 'Bulk rise', meta: '2 to 3 h at about 27 °C', sub: 'It will not double. A little growth is enough.' },
      { icon: 'shape', title: 'Divide and shape', sub: 'Put the dough into a greased tin and smooth the top.' },
      { icon: 'rise', title: 'Second rise', meta: 'About 1 h, until cracks show', sub: 'The top splits as it rises. That is what you want.' },
    ],
    bake: {
      phases: [
        { label: 'Start hot', c: 240, min: 10 },
        { label: 'Turn down', c: 210, min: 45 },
      ],
      refSize: 1000,
      sub: 'In the tin, with a tray of water for steam.',
      done: 'Done at 98 °C inside. Rest 24 h before slicing.',
    },
  },

  sandwich: {
    id: 'sandwich',
    name: 'Sandwich loaf',
    noun: ['loaf', 'loaves'],
    shapeUnit: 'pieces',
    icon: 'sandwich',
    typical: { hydration: 62, count: 1, size: 850 },
    ingredients: [
      { name: 'Bread flour', pct: 100, tone: 'flour', label: 'Flour' },
      { name: 'Water', pct: 0, tone: 'water', water: true, label: 'Water' },
      { name: 'Instant yeast', pct: 1.2, tone: 'leaven' },
      { name: 'Salt', pct: 2, tone: 'salt' },
      { name: 'Sugar', pct: 5, tone: 'sweet' },
      { name: 'Butter, softened', pct: 6, tone: 'fat' },
    ],
    steps: [
      { icon: 'rise', title: 'Knead', meta: '10 min', sub: 'Until smooth and springy.' },
      { icon: 'rise', title: 'First rise', meta: '1 to 1.5 h until doubled', sub: 'Cover the bowl so it does not dry out.' },
      { icon: 'shape', title: 'Divide and shape', sub: 'Pat flat, roll it up tightly, and drop it into a greased tin.' },
      { icon: 'rise', title: 'Second rise', meta: '45 to 60 min, until 2 cm above the rim', sub: 'Cover loosely while it rises.' },
    ],
    bake: {
      phases: [{ label: 'Bake', c: 190, min: 35 }],
      refSize: 850,
      sub: 'On a middle shelf, until golden on top.',
      done: 'Done at 93 °C inside.',
    },
  },
};

const MIN_GRAMS = 50;
const MAX_GRAMS = 3000;

/** Whether a loaf weight is one the calculator will answer for. */
export function isValidSize(size) {
  return Number.isFinite(size) && size >= MIN_GRAMS && size <= MAX_GRAMS;
}

/**
 * The recipe for one set of settings: ingredient rows in grams (they sum to
 * the dough weight exactly), the dough total, the strip percentages, and the
 * total hydration for starter breads. Returns null when the weight is not a
 * usable number — the screen shows its empty state then, never zeros.
 */
export function computeRecipe({ type, hydration, count, size }) {
  const bread = BREADS[type] || BREADS.sourdough;
  const h = Number(hydration);
  const n = Number(count);
  const g = Number(size);
  if (!Number.isFinite(h) || !Number.isFinite(n) || !isValidSize(g)) return null;

  const ingredients = bread.ingredients.map((i) => ({ ...i, pct: i.water ? h : i.pct }));
  const sumPct = ingredients.reduce((sum, i) => sum + i.pct, 0);
  const dough = n * g;
  const flour = dough / (sumPct / 100);

  const rows = ingredients.map((i) => {
    const raw = (flour * i.pct) / 100;
    const grams = raw < 10 ? Math.round(raw * 10) / 10 : Math.round(raw);
    return { ...i, grams };
  });

  // Flour takes up the rounding, so the rows sum to the dough weight exactly.
  // The diff can carry a tenth (a sub-10 g row rounds to 0.1 g), so the
  // absorbing row is adjusted at 0.1 g precision, never re-rounded to whole
  // grams — that would lose the diff and break the sum again.
  const diff = dough - rows.reduce((sum, r) => sum + r.grams, 0);
  if (diff !== 0) {
    let biggest = null;
    for (const r of rows) {
      if ((r.tone === 'flour' || r.tone === 'rye') && (!biggest || r.grams > biggest.grams)) biggest = r;
    }
    if (biggest) {
      biggest.grams = Math.round((biggest.grams + diff) * 10) / 10;
    }
  }

  // Total hydration, counting the starter's water (starter is half flour,
  // half water): (h + s/2) / (100 + s/2), all relative to flour.
  const starterRow = ingredients.find((i) => i.starter);
  const totalHydration = starterRow
    ? Math.round(((h + starterRow.pct / 2) / (100 + starterRow.pct / 2)) * 100)
    : null;

  return { bread, rows, sumPct, dough, totalHydration };
}

/**
 * The last bake phase's minutes, scaled from the bread's reference size:
 * × √(size / refSize), to the nearest minute below 30, the nearest 5 at 30
 * or more, never under 8.
 */
export function bakeMinutes(refMinutes, size, refSize) {
  const raw = refMinutes * Math.sqrt(Number(size) / refSize);
  if (!Number.isFinite(raw)) return refMinutes;
  const minutes = raw < 30 ? Math.round(raw) : Math.round(raw / 5) * 5;
  return Math.max(8, minutes);
}

/** °C to °F. */
export function toF(c) {
  return Math.round((c * 9) / 5 + 32);
}

/** Grams as words on the screen: one decimal under 10 g (or when the
 * rounding-diff absorption left a tenth), whole grams otherwise. */
export function formatGrams(g) {
  const r = Math.round(g * 10) / 10;
  if (r < 10 || !Number.isInteger(r)) return r.toFixed(1);
  return r.toLocaleString('en');
}