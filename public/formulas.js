/* Bread Bot's formula engine. Pure: no DOM, no server, no stored state.
   The page calls calculate() with the current settings and renders what
   comes back. Flour is the base at 100%; every other ingredient is a
   baker's percentage of the total flour, so scaling by flour weight is
   just arithmetic. Water's percentage is the hydration itself. */

const BREADS = {
  sourdough: {
    label: 'Sourdough',
    unit: 'loaves',
    singular: 'loaf',
    hydration: 72,
    flourPer: { min: 200, max: 1500, step: 50, def: 500 },
    parts: [
      { name: 'Bread flour', pct: 100, flour: true },
      { name: 'Water', water: true },
      { name: 'Starter', pct: 20 },
      { name: 'Salt', pct: 2 },
    ],
    rise: { steps: [300], sub: 'at 24°C' },
    bake: { temp: '240°C', sub: 'then 220°C', minutes: 45, note: 'lidded 25' },
  },
  bagels: {
    label: 'Bagels',
    unit: 'bagels',
    singular: 'bagel',
    hydration: 58,
    flourPer: { min: 50, max: 200, step: 10, def: 75 },
    parts: [
      { name: 'Bread flour', pct: 100, flour: true },
      { name: 'Water', water: true },
      { name: 'Instant yeast', pct: 1 },
      { name: 'Salt', pct: 2 },
      { name: 'Malt syrup', pct: 3 },
    ],
    rise: { steps: [60], sub: 'at 24°C, then boil 1 min' },
    bake: { temp: '220°C', sub: '', minutes: 20, note: '' },
  },
  'sourdough-bagels': {
    label: 'Sourdough bagels',
    unit: 'bagels',
    singular: 'bagel',
    hydration: 58,
    flourPer: { min: 50, max: 200, step: 10, def: 75 },
    parts: [
      { name: 'Bread flour', pct: 100, flour: true },
      { name: 'Water', water: true },
      { name: 'Starter', pct: 25 },
      { name: 'Salt', pct: 2 },
      { name: 'Malt syrup', pct: 3 },
    ],
    rise: { steps: [720], sub: 'in the fridge, boil 1 min' },
    bake: { temp: '220°C', sub: '', minutes: 22, note: '' },
  },
  rye: {
    label: 'Rye',
    unit: 'loaves',
    singular: 'loaf',
    hydration: 78,
    flourPer: { min: 200, max: 1500, step: 50, def: 500 },
    parts: [
      { name: 'Rye flour', pct: 60, flour: true },
      { name: 'Bread flour', pct: 40, flour: true },
      { name: 'Water', water: true },
      { name: 'Starter', pct: 20 },
      { name: 'Salt', pct: 2 },
    ],
    rise: { steps: [180], sub: 'at 26°C' },
    bake: { temp: '250°C', sub: 'then 210°C', minutes: 60, note: '' },
  },
  sandwich: {
    label: 'Sandwich loaf',
    unit: 'loaves',
    singular: 'loaf',
    hydration: 65,
    flourPer: { min: 200, max: 1500, step: 50, def: 500 },
    parts: [
      { name: 'Bread flour', pct: 100, flour: true },
      { name: 'Water', water: true },
      { name: 'Instant yeast', pct: 1.5 },
      { name: 'Salt', pct: 2 },
      { name: 'Sugar', pct: 4 },
      { name: 'Butter', pct: 6 },
    ],
    rise: { steps: [90, 60], sub: 'at 24°C, then in the tin' },
    bake: { temp: '190°C', sub: '', minutes: 35, note: '' },
  },
};

/* Rise shifts 5% per 5 hydration points (wetter rises faster, drier
   slower), rounded to 15 minutes; bake time gains 2 minutes per 5 points
   wetter, rounded to 1 minute. */
function calculate(key, hydration, count, flourPer) {
  const b = BREADS[key];
  const flourTotal = count * flourPer;
  const delta = hydration - b.hydration;
  const riseMinutes = b.rise.steps
    .map(m => Math.max(15, Math.round((m * (1 - delta * 0.01)) / 15) * 15))
    .reduce((a, m) => a + m, 0);
  const bakeMinutes = Math.max(1, Math.round(b.bake.minutes + delta * 0.4));
  const rows = b.parts.map(p => {
    const pct = p.water ? hydration : p.pct;
    return {
      name: p.name,
      pct,
      grams: Math.round((flourTotal * pct) / 100),
      flour: !!p.flour,
    };
  });
  const doughTotal = rows.reduce((s, r) => s + r.grams, 0);
  return {
    bread: key,
    title: b.label + ', ' + count + ' ' + (count === 1 ? b.singular : b.unit),
    flourTotal,
    doughTotal,
    rows,
    rise: { big: formatMinutes(riseMinutes), sub: b.rise.sub },
    bake: { big: b.bake.temp, sub: b.bake.sub },
    time: { big: formatMinutes(bakeMinutes), sub: b.bake.note },
  };
}

function formatMinutes(m) {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return h + ' h ' + r + ' min';
  if (h) return h + ' h';
  return r + ' min';
}

function formatGrams(g) {
  return g.toLocaleString('en-US');
}

window.BreadFormulas = { BREADS, calculate, formatMinutes, formatGrams };
