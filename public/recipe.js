// Bread Bot's recipe maths, pure: one fixed table of the five breads, and the
// function that turns settings into grams, rise steps and oven stages. No AI,
// no server: everything here is data and arithmetic.

export const BREADS = [
  {
    id: 'sourdough',
    label: 'Sourdough',
    bagels: false,
    hydration: 75, // the usual hydration, where the gauge starts
    size: 900, // the usual loaf weight, and the bake-time reference
    flours: [{ name: 'Bread flour', pct: 100 }],
    others: [{ name: 'Active starter', pct: 20 }, { name: 'Salt', pct: 2 }],
    steps: [
      { title: 'Bulk rise, 4 to 6 h', sub: 'At about 24 °C, with a fold every 30 min for the first 2 h.' },
      { title: 'Shape', sub: 'Pre-shape, rest 20 min, then shape into rounds.' },
      { title: 'Cold proof, 12 to 16 h', sub: 'In the fridge, covered.' },
    ],
    bake: [
      { temp: 250, minutes: 20, note: 'lid on' },
      { temp: 230, minutes: 25, note: 'lid off' },
    ],
    note: 'Preheat the oven with a Dutch oven inside for 45 min. Done at 96 °C inside.',
  },
  {
    id: 'bagels',
    label: 'Bagels',
    bagels: true,
    hydration: 58,
    size: 110,
    flours: [{ name: 'Bread flour', pct: 100 }],
    others: [{ name: 'Barley malt syrup', pct: 4 }, { name: 'Salt', pct: 2 }, { name: 'Instant yeast', pct: 1 }],
    steps: [
      { title: 'Rise, 1 h', sub: 'Covered, at room temperature.' },
      { title: 'Shape', sub: 'Ring each piece by hand, then rest 20 min.' },
      { title: 'Boil, 1 min a side', sub: 'In water with a spoon of barley malt syrup.' },
    ],
    bake: [{ temp: 220, minutes: 18 }],
    note: 'Bake on a lined tray, in batches if they do not all fit.',
  },
  {
    id: 'sourdough-bagels',
    label: 'Sourdough bagels',
    bagels: true,
    hydration: 60,
    size: 110,
    flours: [{ name: 'Bread flour', pct: 100 }],
    others: [{ name: 'Active starter', pct: 20 }, { name: 'Barley malt syrup', pct: 4 }, { name: 'Salt', pct: 2 }],
    steps: [
      { title: 'Bulk rise, 4 to 5 h', sub: 'At about 24 °C.' },
      { title: 'Shape', sub: 'Ring each piece by hand.' },
      { title: 'Cold proof, 8 to 12 h', sub: 'In the fridge, covered.' },
      { title: 'Boil, 1 min a side', sub: 'In water with a spoon of barley malt syrup.' },
    ],
    bake: [{ temp: 220, minutes: 20 }],
    note: 'Bake on a lined tray; the cold proof happens overnight.',
  },
  {
    id: 'rye',
    label: 'Rye',
    bagels: false,
    hydration: 80,
    size: 900,
    flours: [{ name: 'Rye flour', pct: 70 }, { name: 'Bread flour', pct: 30 }],
    others: [{ name: 'Active starter', pct: 20 }, { name: 'Salt', pct: 2 }],
    steps: [
      { title: 'Bulk rise, 2 to 3 h', sub: 'Covered, at room temperature.' },
      { title: 'Shape', sub: 'Into an oval, seam up, seeds pressed on.' },
      { title: 'Proof, 1 to 1.5 h', sub: 'Until the dough springs back slowly.' },
    ],
    bake: [
      { temp: 240, minutes: 15 },
      { temp: 210, minutes: 40 },
    ],
    note: 'Done at 96 °C inside; cool fully before slicing.',
  },
  {
    id: 'sandwich',
    label: 'Sandwich loaf',
    bagels: false,
    hydration: 65,
    size: 900,
    flours: [{ name: 'Bread flour', pct: 100 }],
    others: [{ name: 'Butter', pct: 6 }, { name: 'Sugar', pct: 4 }, { name: 'Salt', pct: 2 }, { name: 'Instant yeast', pct: 1.5 }],
    steps: [
      { title: 'First rise, 1 to 1.5 h', sub: 'Covered, until doubled.' },
      { title: 'Shape into tin', sub: 'Roll tight and drop into a buttered loaf tin.' },
      { title: 'Second rise, 45 to 60 min', sub: 'Until the dough crowns the tin.' },
    ],
    bake: [{ temp: 190, minutes: 35 }],
    note: 'Brush the top with butter after baking for a soft crust.',
  },
];

// Grams are whole numbers, except under 10 g, which keep one decimal.
const round = (n) => (n < 10 ? Math.round(n * 10) / 10 : Math.round(n));

/**
 * computeRecipe({ kind, hydration, count, size }) gives the ingredient rows
 * (each { name, pct, grams }, then the total row), the rise steps and the
 * oven stages, or { errors } naming the fields that are out of range.
 * Flour is what is left of the total once the rounded rows are counted, so
 * the rows always add up to the total.
 */
export function computeRecipe({ kind, hydration, count, size }) {
  const bread = BREADS.find((b) => b.id === kind);
  const errors = {};
  if (!bread) errors.kind = 'Pick one of the five breads.';
  if (!Number.isFinite(hydration) || hydration < 50 || hydration > 90) {
    errors.hydration = 'Set hydration between 50 and 90%.';
  }
  if (!Number.isInteger(count) || count < 1 || count > 24) {
    errors.count = bread && bread.bagels ? 'Set a count from 1 to 24 bagels.' : 'Set a count from 1 to 24 loaves.';
  }
  if (!Number.isFinite(size) || size < 50 || size > 3000) {
    errors.size = 'Enter a weight from 50 to 3000 g';
  }
  if (!bread || Object.keys(errors).length) return { errors };

  const loaves = Math.round(count);
  const loafSize = Math.round(size);
  const total = loaves * loafSize;
  const water = hydration / 100;
  const otherPct = bread.others.reduce((s, o) => s + o.pct, 0) / 100;
  const flourExact = total / (1 + water + otherPct);

  const otherRows = bread.others.map((o) => ({ name: o.name, pct: o.pct, grams: round(flourExact * (o.pct / 100)) }));
  const waterRow = { name: 'Water', pct: hydration, grams: round(flourExact * water) };
  const used = otherRows.reduce((s, r) => s + r.grams, 0) + waterRow.grams;

  // The flours split what is left, largest share first; the last one takes
  // the remainder, so the flours add up exactly.
  let left = total - used;
  const flourRows = bread.flours.map((f, i) => {
    if (i === bread.flours.length - 1) {
      const row = { name: f.name, pct: f.pct, grams: left };
      left = 0;
      return row;
    }
    const rest = bread.flours.slice(i).reduce((s, x) => s + x.pct, 0);
    const g = round((left * f.pct) / rest);
    left = left - g;
    return { name: f.name, pct: f.pct, grams: g };
  });

  const scale = Math.sqrt(loafSize / bread.size);
  const bake = bread.bake.map((b) => ({
    temp: b.temp,
    minutes: Math.max(1, Math.round(b.minutes * scale)),
    note: b.note,
  }));

  return {
    size: loafSize,
    hydration,
    count: loaves,
    total,
    ingredients: [...flourRows, waterRow, ...otherRows, { name: 'Total dough', total: true, grams: total }],
    steps: bread.steps,
    bake,
    note: bread.note,
  };
}