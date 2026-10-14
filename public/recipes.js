// recipes.js: Bread Bot's bread presets and the gram calculator.
// Pure data and functions, no DOM — public/app.js renders what
// calculate() returns. All amounts are grams, rounded to whole grams.

export const LIMITS = {
  hydration: { min: 50, max: 90 },
  count: { min: 1, max: 24 },
  weight: { min: 50, max: 3000 },
};

// Each bread's usual recipe, in baker's percentages of the total flour F.
// The starter is fed at equal flour and water: half of it counts as flour,
// half as water, so it counts towards the hydration.
export const BREADS = {
  sourdough: {
    key: 'sourdough',
    label: 'Sourdough',
    countLabel: 'Loaves', perLabel: 'Dough per loaf',
    one: 'loaf', many: 'loaves',
    hydration: 75, count: 1, weight: 900,
    starter: { name: 'Starter, fed', pct: 20 },
    flours: [{ name: 'Bread flour', share: 1 }],
    others: [{ name: 'Salt', pct: 2 }],
    steps: [
      { kind: 'rise', name: 'Bulk rise', desc: 'Room temperature, fold every 30 min', time: '4 to 5 h' },
      { kind: 'fridge', name: 'Shape and proof', desc: 'In the fridge, covered', time: '12 to 16 h' },
      { kind: 'bake', name: 'Bake, lid on', desc: 'Preheated Dutch oven', temp: 250, time: '20 min' },
      { kind: 'bake', name: 'Bake, lid off', desc: 'Until deep brown', temp: 230, time: '25 min' },
    ],
  },
  bagels: {
    key: 'bagels',
    label: 'Bagels',
    countLabel: 'Bagels', perLabel: 'Dough per bagel',
    one: 'bagel', many: 'bagels',
    hydration: 58, count: 8, weight: 110,
    starter: null,
    flours: [{ name: 'Bread flour', share: 1 }],
    others: [
      { name: 'Instant yeast', pct: 1 },
      { name: 'Salt', pct: 2 },
      { name: 'Barley malt syrup', pct: 4 },
    ],
    steps: [
      { kind: 'rise', name: 'Rise', desc: 'Room temperature, covered', time: '1 h' },
      { kind: 'proof', name: 'Shape and proof', desc: 'On the bench, covered', time: '30 min' },
      { kind: 'boil', name: 'Boil', desc: 'A gentle simmer, a few at a time', time: '1 min a side' },
      { kind: 'bake', name: 'Bake', desc: 'On a lined tray', temp: 220, time: '18 min' },
    ],
  },
  'sourdough-bagels': {
    key: 'sourdough-bagels',
    label: 'Sourdough bagels',
    countLabel: 'Bagels', perLabel: 'Dough per bagel',
    one: 'bagel', many: 'bagels',
    hydration: 60, count: 8, weight: 110,
    starter: { name: 'Starter, fed', pct: 20 },
    flours: [{ name: 'Bread flour', share: 1 }],
    others: [
      { name: 'Salt', pct: 2 },
      { name: 'Malt syrup', pct: 4 },
    ],
    steps: [
      { kind: 'rise', name: 'Bulk rise', desc: 'Room temperature, covered', time: '4 to 5 h' },
      { kind: 'fridge', name: 'Shape and proof', desc: 'In the fridge, covered', time: '12 h' },
      { kind: 'boil', name: 'Boil', desc: 'A gentle simmer, a few at a time', time: '1 min a side' },
      { kind: 'bake', name: 'Bake', desc: 'On a lined tray', temp: 220, time: '20 min' },
    ],
  },
  rye: {
    key: 'rye',
    label: 'Rye',
    countLabel: 'Loaves', perLabel: 'Dough per loaf',
    one: 'loaf', many: 'loaves',
    hydration: 78, count: 1, weight: 900,
    starter: { name: 'Rye starter, fed', pct: 20 },
    flours: [
      { name: 'Rye flour', share: 0.7 },
      { name: 'Bread flour', share: 0.3 },
    ],
    others: [{ name: 'Salt', pct: 2 }],
    steps: [
      { kind: 'rise', name: 'Bulk rise', desc: 'Room temperature, covered', time: '2 to 3 h' },
      { kind: 'proof', name: 'Proof in the tin', desc: 'Covered, until it domes', time: '1 to 2 h' },
      { kind: 'bake', name: 'Bake, hot', desc: 'With steam', temp: 240, time: '10 min' },
      { kind: 'bake', name: 'Bake, low', desc: 'Until firm', temp: 200, time: '50 min' },
    ],
  },
  sandwich: {
    key: 'sandwich',
    label: 'Sandwich loaf',
    countLabel: 'Loaves', perLabel: 'Dough per loaf',
    one: 'loaf', many: 'loaves',
    hydration: 65, count: 1, weight: 900,
    starter: null,
    flours: [{ name: 'Bread flour', share: 1 }],
    others: [
      { name: 'Instant yeast', pct: 1.5 },
      { name: 'Salt', pct: 2 },
      { name: 'Sugar', pct: 4 },
      { name: 'Butter', pct: 6 },
    ],
    steps: [
      { kind: 'rise', name: 'Rise', desc: 'Room temperature, covered', time: '1 to 1.5 h' },
      { kind: 'proof', name: 'Proof in the tin', desc: 'Until it crowns the tin', time: '45 to 60 min' },
      { kind: 'bake', name: 'Bake', desc: 'Middle shelf', temp: 190, time: '35 min' },
    ],
  },
};

// What the dough will be like at a hydration, for the dial's description.
export function doughDescription(hydration) {
  if (hydration < 62) return 'Stiff dough, tight crumb';
  if (hydration < 70) return 'Medium dough, even crumb';
  if (hydration < 79) return 'Soft dough, open crumb';
  return 'Wet dough, very open crumb';
}

// Turn { type, hydration, count, weight } into a recipe:
// rows (name, grams, pct of total flour), the total and the steps.
//
// The dough to make is D = count × weight. Total flour is
// F = D / (1 + hydration + every non-starter percentage). The starter is
// not an extra: it is weighed out instead of part of the flour and water
// (half of it is flour, half water), so its percentage stays out of the
// denominator and the rows still sum to the target dough weight.
export function calculate({ type, hydration, count, weight }) {
  const bread = BREADS[type];
  if (!bread) throw new Error(`Unknown bread type: ${type}`);
  const h = hydration / 100;
  const target = count * weight;
  const otherPct = bread.others.reduce((sum, o) => sum + o.pct, 0);
  const F = target / (1 + h + otherPct / 100);

  const pctOf = (grams) => Math.round((grams / F) * 100);
  const rows = [];

  if (bread.starter) {
    const starter = (bread.starter.pct / 100) * F;
    const flourAdded = F - starter / 2;
    const waterAdded = h * F - starter / 2;
    // Rye splits the added flour 70% rye, 30% bread flour; the last share
    // takes what rounding leaves, so the rows keep summing to the target.
    let left = Math.round(flourAdded);
    bread.flours.forEach((flour, i) => {
      const grams = i === bread.flours.length - 1
        ? left
        : Math.round(flourAdded * flour.share);
      left -= grams;
      rows.push({ name: flour.name, grams, pct: pctOf(flourAdded * flour.share) });
    });
    rows.push({ name: 'Water', grams: Math.round(waterAdded), pct: pctOf(waterAdded) });
    rows.push({ name: bread.starter.name, grams: Math.round(starter), pct: bread.starter.pct });
  } else {
    rows.push({ name: 'Bread flour', grams: Math.round(F), pct: 100 });
    rows.push({ name: 'Water', grams: Math.round(h * F), pct: Math.round(h * 100) });
  }

  for (const other of bread.others) {
    rows.push({ name: other.name, grams: Math.round((other.pct / 100) * F), pct: other.pct });
  }

  const total = rows.reduce((sum, row) => sum + row.grams, 0);
  return {
    bread,
    hydration,
    count,
    weight,
    rows,
    total,
    steps: bread.steps,
  };
}
