// The five bread formulas and the calculator. Pure: no DOM, so app.js can
// render whatever calculate() returns. Baker's percentages are of TOTAL
// flour (rye's rye + bread flours together still make 100%).

export const KINDS = {
  sourdough: {
    name: 'Sourdough',
    bagel: false,
    defaults: { hydration: 76, count: 2, grams: 900 },
    ref: 900, // the dough weight the bake times are written for
    roundTo: 5, // bake minutes round to this
    boil: false,
    ingredients: (h) => [
      { name: 'Bread flour', pct: 100 },
      { name: 'Water', pct: h },
      { name: 'Active starter', pct: 20 },
      { name: 'Salt', pct: 2 },
    ],
    rise: [
      { time: '5 h', text: 'Bulk rise at about 24°C, folding every 30 min for the first 2 h' },
      { time: '12 to 16 h', text: 'Shape, then cold proof in the fridge' },
    ],
    bake: [
      { minutes: 20, tempC: 250, text: 'covered' },
      { minutes: 25, tempC: 230, text: 'uncovered, until deep brown' },
    ],
  },
  bagels: {
    name: 'Bagels',
    bagel: true,
    defaults: { hydration: 58, count: 8, grams: 110 },
    ref: 110,
    roundTo: 1,
    boil: true,
    ingredients: (h) => [
      { name: 'Bread flour', pct: 100 },
      { name: 'Water', pct: h },
      { name: 'Barley malt syrup', pct: 4 },
      { name: 'Salt', pct: 2 },
      { name: 'Instant yeast', pct: 1 },
    ],
    rise: [
      { time: '1 h', text: 'Bulk rise' },
      { time: '12 h', text: 'Shape, then cold proof in the fridge' },
    ],
    bake: [{ minutes: 18, tempC: 230, text: '' }],
  },
  'sourdough-bagels': {
    name: 'Sourdough bagels',
    bagel: true,
    defaults: { hydration: 60, count: 8, grams: 110 },
    ref: 110,
    roundTo: 1,
    boil: true,
    ingredients: (h) => [
      { name: 'Bread flour', pct: 100 },
      { name: 'Water', pct: h },
      { name: 'Active starter', pct: 25 },
      { name: 'Barley malt syrup', pct: 4 },
      { name: 'Salt', pct: 2 },
    ],
    rise: [
      { time: '4 h', text: 'Bulk rise at about 24°C' },
      { time: '12 to 16 h', text: 'Shape, then cold proof in the fridge' },
    ],
    bake: [{ minutes: 18, tempC: 230, text: '' }],
  },
  rye: {
    name: 'Rye',
    bagel: false,
    defaults: { hydration: 78, count: 1, grams: 900 },
    ref: 900,
    roundTo: 5,
    boil: false,
    ingredients: (h) => [
      { name: 'Rye flour', pct: 60 },
      { name: 'Bread flour', pct: 40 },
      { name: 'Water', pct: h },
      { name: 'Active starter', pct: 20 },
      { name: 'Salt', pct: 2 },
    ],
    rise: [
      { time: '3 h', text: 'Bulk rise at about 26°C' },
      { time: '1 h', text: 'Shape, then proof' },
    ],
    bake: [
      { minutes: 15, tempC: 240, text: '' },
      { minutes: 35, tempC: 210, text: '' },
    ],
  },
  'sandwich-loaf': {
    name: 'Sandwich loaf',
    bagel: false,
    defaults: { hydration: 64, count: 1, grams: 900 },
    ref: 900,
    roundTo: 5,
    boil: false,
    ingredients: (h) => [
      { name: 'Bread flour', pct: 100 },
      { name: 'Water', pct: h },
      { name: 'Butter', pct: 8 },
      { name: 'Sugar', pct: 5 },
      { name: 'Salt', pct: 2 },
      { name: 'Instant yeast', pct: 1.5 },
    ],
    rise: [
      { time: '1.5 h', text: 'Bulk rise' },
      { time: '1 h', text: 'Shape, then proof in a buttered tin' },
    ],
    bake: [{ minutes: 35, tempC: 190, text: '' }],
  },
};

/** Grams on a baker's scale: whole grams from 10 g up, 0.1 g below. */
export function fmtGrams(g) {
  return g >= 10 ? String(Math.round(g)) : (Math.round(g * 10) / 10).toFixed(1);
}

/**
 * Work out a recipe. hydration is water as a % of flour, count the number of
 * loaves (or bagels), grams the dough weight per loaf in grams. Returns the
 * ingredient lines (grams and baker's %), the total dough, and the rise and
 * bake steps, ready to show.
 */
export function calculate(kind, hydration, count, grams) {
  const b = KINDS[kind];
  const ingredients = b.ingredients(hydration);
  const pctSum = ingredients.reduce((sum, i) => sum + i.pct, 0);
  const totalFlour = (count * grams) / (pctSum / 100);
  const lines = ingredients.map((i) => ({
    name: i.name,
    pct: i.pct,
    grams: (totalFlour * i.pct) / 100,
  }));

  // Bake minutes grow with the cube root of the dough weight against the
  // size the times were written for; boil time does not scale.
  const factor = Math.cbrt(grams / b.ref);
  const bake = [];
  if (b.boil) bake.push({ time: '30 s', text: 'a side' });
  for (const step of b.bake) {
    const minutes = Math.max(b.roundTo, Math.round((step.minutes * factor) / b.roundTo) * b.roundTo);
    const tempF = Math.round(((step.tempC * 9) / 5 + 32) / 5) * 5;
    bake.push({
      time: `${minutes} min`,
      text: `${step.tempC}°C (${tempF}°F)${step.text ? `, ${step.text}` : ''}`,
    });
  }

  return {
    name: b.name,
    bagel: b.bagel,
    lines,
    pctSum,
    totalDough: count * grams,
    rise: b.rise.map((s) => ({ ...s })),
    bake,
  };
}