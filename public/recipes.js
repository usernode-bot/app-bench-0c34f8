// Pure recipe maths: the five breads, their ingredient percentages, and how
// the rise and bake timings bend with hydration and loaf size. No DOM, no
// state: calculate() takes the settings and returns the recipe or the fields
// that are wrong. Nothing here touches the network or storage.

export const BREADS = {
  sourdough: {
    label: 'Sourdough',
    unit: 'loaf',
    hydration: 75,
    flour: 500,
    ingredients: [
      { name: 'Bread flour', pct: 100 },
      { name: 'Water', pct: 'hydration' },
      { name: 'Starter', pct: 20 },
      { name: 'Salt', pct: 2 },
    ],
    rises: [
      { icon: 'clock', title: 'Bulk rise, at about 24 °C', hours: [4, 4.5],
        note: 'Stretch and fold every 30 minutes for the first 2 hours.' },
      { icon: 'dough', title: 'Shape, then proof', hours: [1, 2],
        note: 'Or overnight in the fridge for a tangier loaf.' },
    ],
    bake: {
      stages: [
        { c: 250, min: 20, label: 'covered' },
        { c: 230, min: 25, label: 'uncovered' },
      ],
      note: 'Bake one loaf at a time.',
    },
  },
  bagels: {
    label: 'Bagels',
    unit: 'bagel',
    hydration: 58,
    flour: 100,
    ingredients: [
      { name: 'Bread flour', pct: 100 },
      { name: 'Water', pct: 'hydration' },
      { name: 'Instant yeast', pct: 1 },
      { name: 'Salt', pct: 2 },
      { name: 'Sugar or malt syrup', pct: 2 },
    ],
    rises: [
      { icon: 'clock', title: 'Bulk rise', hours: [1, 1.5],
        note: 'Chill the shaped bagels afterwards: cold dough holds its shape.' },
      { icon: 'dough', title: 'Shape, then proof', hours: [0.5, 1],
        note: 'Or proof overnight in the fridge for more flavour.' },
    ],
    boil: {
      title: 'Boil',
      lines: ['1 minute per side'],
      note: 'Work in batches of 2 or 3; they puff as they boil.',
    },
    bake: {
      stages: [{ c: 220, min: 18 }],
      note: 'Golden on top, still chewy inside.',
    },
  },
  sourdoughBagels: {
    label: 'Sourdough bagels',
    unit: 'bagel',
    hydration: 58,
    flour: 100,
    ingredients: [
      { name: 'Bread flour', pct: 100 },
      { name: 'Water', pct: 'hydration' },
      { name: 'Starter', pct: 20 },
      { name: 'Salt', pct: 2 },
      { name: 'Sugar or malt syrup', pct: 2 },
    ],
    rises: [
      { icon: 'clock', title: 'Bulk rise', hours: [3, 4],
        note: 'Sourdough bagels rise slowly; give them the time.' },
      { icon: 'dough', title: 'Shape, then proof', hours: [1, 2],
        note: 'Or overnight in the fridge.' },
    ],
    boil: {
      title: 'Boil',
      lines: ['1 minute per side'],
      note: 'Work in batches of 2 or 3; they puff as they boil.',
    },
    bake: {
      stages: [{ c: 230, min: 20 }],
      note: 'Golden on top, still chewy inside.',
    },
  },
  rye: {
    label: 'Rye',
    unit: 'loaf',
    hydration: 72,
    flour: 500,
    ingredients: [
      { name: 'Rye flour', pct: 40 },
      { name: 'Bread flour', pct: 60 },
      { name: 'Water', pct: 'hydration' },
      { name: 'Instant yeast', pct: 1 },
      { name: 'Salt', pct: 2 },
    ],
    rises: [
      { icon: 'clock', title: 'Bulk rise', hours: [1.5, 2],
        note: 'Rye rises less; do not wait for it to double.' },
      { icon: 'dough', title: 'Shape, then proof', hours: [0.5, 1],
        note: 'Let it come about halfway up the tin.' },
    ],
    bake: {
      stages: [
        { c: 230, min: 20 },
        { c: 200, min: 25, label: 'uncovered' },
      ],
      note: 'Rye keeps for days and slices better tomorrow.',
    },
  },
  sandwich: {
    label: 'Sandwich loaf',
    unit: 'loaf',
    hydration: 65,
    flour: 500,
    ingredients: [
      { name: 'Bread flour', pct: 100 },
      { name: 'Water', pct: 'hydration' },
      { name: 'Instant yeast', pct: 1 },
      { name: 'Salt', pct: 2 },
      { name: 'Sugar', pct: 4 },
      { name: 'Butter', pct: 6 },
    ],
    rises: [
      { icon: 'clock', title: 'Bulk rise', hours: [1, 1.5],
        note: 'Until puffed, not necessarily doubled.' },
      { icon: 'dough', title: 'Shape, then proof', hours: [0.5, 1],
        note: 'Risen to about 2 cm above the rim of the tin.' },
    ],
    bake: {
      stages: [{ c: 190, min: 35 }],
      note: 'Turn out and cool on a rack before slicing.',
    },
  },
};

/** °F = °C × 9/5 + 32, rounded to 5. */
export function toF(c) {
  return Math.round((c * 9 / 5 + 32) / 5) * 5;
}

const fmtNum = (n) => n.toLocaleString('en-US');

/** Grams: whole numbers, except one decimal below 10 g. */
export function formatGrams(g) {
  if (g < 10 && g % 1 !== 0) return g.toFixed(1);
  return fmtNum(Math.round(g));
}

/** "4", "4½", "½": hours to the nearest half, for a rise line. */
function fmtHours(h) {
  const whole = Math.floor(h);
  const half = h - whole === 0.5;
  return whole === 0 ? '½' : `${whole}${half ? '½' : ''}`;
}

function fmtRange(hours) {
  const [lo, hi] = hours;
  if (lo === hi) return `${fmtHours(lo)} ${lo === 1 ? 'hour' : 'hours'}`;
  return `${fmtHours(lo)} to ${fmtHours(hi)} hours`;
}

/**
 * calculate({ kind, hydration, count, flour }) →
 *   { ingredients: [{ name, grams, pct }], total, steps } or { errors }.
 * Steps carry their icon, their line(s) and their note; rises already
 * include the hydration adjustment and the bake its size adjustment.
 */
export function calculate({ kind, hydration, count, flour }) {
  const bread = BREADS[kind];
  if (!bread) return { errors: { kind: 'Pick a bread' } };

  const errors = {};
  if (!Number.isInteger(hydration) || hydration < 50 || hydration > 100) {
    errors.hydration = 'Hydration goes from 50 to 100%';
  }
  if (!Number.isInteger(count) || count < 1 || count > 24) {
    errors.count = `${bread.label === 'Bagels' || bread.label === 'Sourdough bagels' ? 'Bagels' : 'Loaves'} go from 1 to 24`;
  }
  if (!Number.isInteger(flour) || flour < 50 || flour > 3000) {
    errors.flour = `Flour per ${bread.unit} goes from 50 to 3000 g`;
  }
  if (Object.keys(errors).length) return { errors };

  // Ingredients. Salt is always 2%; water is the hydration itself.
  const ingredients = bread.ingredients.map((ing) => {
    const pct = ing.pct === 'hydration' ? hydration : ing.pct;
    const raw = flour * pct / 100;
    const grams = raw < 10 && raw % 1 !== 0 ? Math.round(raw * 10) / 10 : Math.round(raw);
    return { name: ing.name, grams, pct };
  });
  const total = ingredients.reduce((sum, ing) => sum + ing.grams, 0) * count;

  // Every 5 points of hydration from the bread's start shifts the rises
  // 10%, to the nearest half hour.
  const factor = 1 - (hydration - bread.hydration) / 50;
  const rise = (step) => ({
    icon: step.icon,
    title: step.title,
    lines: [fmtRange(step.hours.map((h) => Math.max(0.5, Math.round(h * factor * 2) / 2)))],
    note: step.note,
  });

  // Every 250 g of flour from the starting size shifts the bake 5 minutes,
  // spread over the stages.
  const delta = Math.round((flour - bread.flour) / 250 * 5);
  const baseMin = bread.bake.stages.reduce((sum, s) => sum + s.min, 0);
  const bake = {
    icon: 'oven',
    title: 'Bake',
    lines: bread.bake.stages.map((s) => {
      const min = Math.max(5, s.min + Math.round(s.min * delta / baseMin));
      return s.label ? `${s.c} °C, ${min} min ${s.label}` : `${s.c} °C, ${min} min`;
    }),
    note: `${bread.bake.stages.map((s) => `${s.c} °C is ${toF(s.c)} °F`).join(', ')}. ${bread.bake.note}`,
  };

  const steps = [...bread.rises.map(rise)];
  if (bread.boil) steps.push({ icon: 'clock', ...bread.boil });
  steps.push(bake);

  return { ingredients, total, steps };
}