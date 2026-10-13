// Bread Bot's data and maths, with no DOM in it: the table of breads, the
// recipe calculation behind the formula sheet and the rise-and-bake timeline,
// and the two format helpers the page and the tests share.
//
// Baker's percentages are of the TOTAL flour F — every flour row plus the
// flour inside the starter, which the starter (kept at 100% hydration) brings
// in as half its own weight. So F = T / (1 + h + Σ other pcts), where T is
// count × size, h the hydration, and the sum counts every non-flour,
// non-water row. The starter then takes its flour back out of the FIRST flour
// row and its water out of the water row, so what you weigh adds up to T.

export const BREADS = {
  sourdough: {
    name: 'Sourdough',
    hydration: { min: 65, max: 85, def: 75 },
    count: { def: 1, max: 6, label: 'Loaves', one: 'loaf', unit: 'loaf' },
    sizes: [
      { label: 'Small', g: 700 },
      { label: 'Medium', g: 900 },
      { label: 'Large', g: 1200 },
    ],
    sizeDef: 900,
    starter: 20,
    rows: [
      { key: 'breadFlour', name: 'Bread flour', kind: 'flour', pct: 90 },
      { key: 'wholeWheat', name: 'Whole wheat flour', kind: 'flour', pct: 10 },
      { key: 'water', name: 'Water', kind: 'water', note: 'About 24°C' },
      { key: 'starter', name: 'Starter', kind: 'starter', pct: 20, note: 'Active, fed 4 to 8 h before' },
      { key: 'salt', name: 'Salt', kind: 'other', pct: 2 },
    ],
    feel: [
      'Firm and easy to shape.',
      'Open crumb, a little sticky to shape.',
      'Very open crumb, wet and slack: for practised hands.',
    ],
    steps: [
      { name: 'Mix and rest', kind: 'hand', min: 30, advice: 'Flour and water only, then add starter and salt.' },
      { name: 'Bulk rise', kind: 'rise', min: 270, bulk: true, advice: 'At 24°C. Stretch and fold every 30 min for the first 2 h. Done when about 50% bigger.' },
      { name: 'Shape', kind: 'hand', min: 15, pieces: true, advice: 'Divide into {pieces}, shape and put in floured baskets.' },
      { name: 'Cold proof', kind: 'rise', min: 720, advice: 'Covered, in the fridge. Anywhere from 10 to 16 h works.' },
      { name: 'Bake, lid on', kind: 'bake', min: 20, oven: [250, 480], advice: 'In a preheated Dutch oven, one loaf at a time.' },
      { name: 'Bake, lid off', kind: 'bake', min: 25, oven: [230, 450], bakeAdjust: true, advice: 'Until deep brown and hollow when tapped.' },
      { name: 'Cool', kind: 'hand', min: 60, advice: 'On a rack before slicing.' },
    ],
  },

  bagels: {
    name: 'Bagels',
    hydration: { min: 52, max: 65, def: 58 },
    count: { def: 8, max: 24, label: 'Bagels', one: 'bagel', unit: 'bagel' },
    sizes: [
      { label: 'Mini', g: 70 },
      { label: 'Classic', g: 115 },
      { label: 'Big', g: 140 },
    ],
    sizeDef: 115,
    starter: 0,
    rows: [
      { key: 'breadFlour', name: 'Bread flour', kind: 'flour', pct: 100 },
      { key: 'water', name: 'Water', kind: 'water', note: 'Lukewarm, about 30°C' },
      { key: 'malt', name: 'Barley malt syrup', kind: 'other', pct: 4, note: 'Or the same weight of honey' },
      { key: 'salt', name: 'Salt', kind: 'other', pct: 2 },
      { key: 'yeast', name: 'Instant yeast', kind: 'other', pct: 1, fine: true },
    ],
    feel: [
      'Very stiff: knead it well.',
      'Stiff and smooth: a dense, chewy bagel.',
      'A little softer, still chewy.',
    ],
    steps: [
      { name: 'Mix and knead', kind: 'hand', min: 15, advice: 'Knead about 10 min until smooth. The dough is stiff on purpose.' },
      { name: 'Bulk rise', kind: 'rise', min: 60, advice: 'Covered, at 24°C.' },
      { name: 'Shape', kind: 'hand', min: 20, pieces: true, advice: 'Divide into {pieces} and roll into rings.' },
      { name: 'Cold rest', kind: 'rise', min: 720, advice: 'On a lined tray, covered, in the fridge overnight.' },
      { name: 'Boil', kind: 'hand', min: 10, advice: '1 min each side in simmering water, a few at a time.' },
      { name: 'Bake', kind: 'bake', min: 20, oven: [220, 425], bakeAdjust: true, advice: 'Until deep golden.' },
      { name: 'Cool', kind: 'hand', min: 20, advice: 'On a rack.' },
    ],
  },

  sourdoughBagels: {
    name: 'Sourdough bagels',
    hydration: { min: 52, max: 65, def: 60 },
    count: { def: 8, max: 24, label: 'Bagels', one: 'bagel', unit: 'bagel' },
    sizes: [
      { label: 'Mini', g: 70 },
      { label: 'Classic', g: 115 },
      { label: 'Big', g: 140 },
    ],
    sizeDef: 115,
    starter: 20,
    rows: [
      { key: 'breadFlour', name: 'Bread flour', kind: 'flour', pct: 100 },
      { key: 'water', name: 'Water', kind: 'water', note: 'Lukewarm, about 30°C' },
      { key: 'starter', name: 'Starter', kind: 'starter', pct: 20, note: 'Active, fed 4 to 8 h before' },
      { key: 'malt', name: 'Barley malt syrup', kind: 'other', pct: 4, note: 'Or the same weight of honey' },
      { key: 'salt', name: 'Salt', kind: 'other', pct: 2 },
    ],
    feel: [
      'Very stiff: knead it well.',
      'Stiff and smooth: a dense, chewy bagel.',
      'A little softer, still chewy.',
    ],
    steps: [
      { name: 'Mix and knead', kind: 'hand', min: 20, advice: 'Flour and water first, then starter, malt and salt; knead 10 min.' },
      { name: 'Bulk rise', kind: 'rise', min: 240, bulk: true, advice: 'At 24°C, until puffed but not doubled.' },
      { name: 'Shape', kind: 'hand', min: 20, pieces: true, advice: 'Divide into {pieces} and roll into rings.' },
      { name: 'Cold rest', kind: 'rise', min: 600, advice: 'On a lined tray, covered, in the fridge overnight.' },
      { name: 'Boil', kind: 'hand', min: 10, advice: '1 min each side in simmering water, a few at a time.' },
      { name: 'Bake', kind: 'bake', min: 20, oven: [220, 425], bakeAdjust: true, advice: 'Until deep golden.' },
      { name: 'Cool', kind: 'hand', min: 20, advice: 'On a rack.' },
    ],
  },

  rye: {
    name: 'Rye',
    hydration: { min: 62, max: 80, def: 70 },
    count: { def: 1, max: 6, label: 'Loaves', one: 'loaf', unit: 'loaf' },
    sizes: [
      { label: 'Small', g: 500 },
      { label: 'Medium', g: 800 },
      { label: 'Large', g: 1000 },
    ],
    sizeDef: 800,
    starter: 0,
    rows: [
      { key: 'breadFlour', name: 'Bread flour', kind: 'flour', pct: 60 },
      { key: 'ryeFlour', name: 'Rye flour', kind: 'flour', pct: 40 },
      { key: 'water', name: 'Water', kind: 'water' },
      { key: 'salt', name: 'Salt', kind: 'other', pct: 2 },
      { key: 'yeast', name: 'Instant yeast', kind: 'other', pct: 1, fine: true },
      { key: 'caraway', name: 'Caraway seeds', kind: 'other', pct: 1.5, fine: true, note: 'Optional' },
    ],
    feel: [
      'Dense and easy to handle.',
      'Sticky but shapeable: classic rye.',
      'Very sticky: wet hands and a scraper help.',
    ],
    steps: [
      { name: 'Mix and knead', kind: 'hand', min: 20, advice: 'Rye needs little kneading: 5 min until it just comes together.' },
      { name: 'Bulk rise', kind: 'rise', min: 90, advice: 'At 24°C, until about one and a half times bigger.' },
      { name: 'Shape', kind: 'hand', min: 15, pieces: true, advice: 'Divide into {pieces} with wet hands and put in the pans.' },
      { name: 'Proof', kind: 'rise', min: 60, advice: 'Until the tops spring back slowly when pressed.' },
      { name: 'Bake', kind: 'bake', min: 60, oven: [200, 400], bakeAdjust: true, advice: 'With steam for the first 15 min, until the crust is firm.' },
      { name: 'Cool', kind: 'hand', min: 90, advice: 'Rye slices best the next day.' },
    ],
  },

  sandwich: {
    name: 'Sandwich loaf',
    hydration: { min: 58, max: 72, def: 65 },
    count: { def: 1, max: 6, label: 'Loaves', one: 'loaf', unit: 'loaf' },
    sizes: [
      { label: 'Small pan', g: 650 },
      { label: 'Standard pan', g: 850 },
      { label: 'Large pan', g: 1100 },
    ],
    sizeDef: 850,
    starter: 0,
    rows: [
      { key: 'breadFlour', name: 'Bread flour', kind: 'flour', pct: 100 },
      { key: 'water', name: 'Water', kind: 'water', note: 'Lukewarm, about 30°C' },
      { key: 'butter', name: 'Butter', kind: 'other', pct: 6, note: 'Softened' },
      { key: 'sugar', name: 'Sugar', kind: 'other', pct: 5 },
      { key: 'salt', name: 'Salt', kind: 'other', pct: 2 },
      { key: 'yeast', name: 'Instant yeast', kind: 'other', pct: 1.2, fine: true },
    ],
    feel: [
      'Firm and easy to knead.',
      'Soft and supple: a fine, even crumb.',
      'Soft and slack: handle it gently.',
    ],
    steps: [
      { name: 'Mix and knead', kind: 'hand', min: 25, advice: 'Knead until the dough passes the windowpane test.' },
      { name: 'Bulk rise', kind: 'rise', min: 90, advice: 'At 24°C, until doubled.' },
      { name: 'Shape', kind: 'hand', min: 15, pieces: true, advice: 'Divide into {pieces}, flatten, roll up and put in the pans.' },
      { name: 'Proof', kind: 'rise', min: 60, advice: 'Until the dough crowns the pans by about 2 cm.' },
      { name: 'Bake', kind: 'bake', min: 35, oven: [190, 375], bakeAdjust: true, advice: 'Until golden and hollow when tapped.' },
      { name: 'Cool', kind: 'hand', min: 60, advice: 'In the pan 10 min, then on a rack.' },
    ],
  },
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Grams as displayed: whole above 10 g, one decimal below it.
const roundG = (g) => (g < 10 ? Math.round(g * 10) / 10 : Math.round(g));

export function formatGrams(g) {
  const n = roundG(g);
  return `${n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString('en-US')} g`;
}

export function formatDuration(min) {
  min = Math.round(min);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

export function calculate(kind, { hydration, count, size }) {
  const b = BREADS[kind];
  const h = clamp(Math.round(hydration), b.hydration.min, b.hydration.max);
  const n = clamp(Math.round(count), 1, b.count.max);
  const sz = clamp(Math.round(size), 50, 3000);
  const total = n * sz;

  const otherSum = b.rows
    .filter((r) => r.kind === 'other')
    .reduce((s, r) => s + r.pct, 0);
  const flour = total / (1 + h / 100 + otherSum / 100);
  const starterG = b.starter ? (b.starter / 100) * flour : 0;

  const rows = b.rows.map((r, i) => {
    let grams;
    if (r.kind === 'starter') grams = starterG;
    else if (r.kind === 'water') grams = (h / 100) * flour - starterG / 2;
    else if (r.kind === 'flour') grams = (r.pct / 100) * flour - (b.starter && i === 0 ? starterG / 2 : 0);
    else grams = (r.pct / 100) * flour;
    const pct = (grams / flour) * 100;
    return {
      ...r,
      grams: roundG(grams),
      pctText: r.fine ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`,
    };
  });

  const pieces = n === 1 ? `one piece of ${sz} g` : `${n} pieces of ${sz} g`;
  const steps = b.steps.map((s) => {
    let min = s.min;
    // Starter breads only: bulk rise runs 10 min shorter per 5 hydration
    // points above the default, 10 min longer per 5 below, to the nearest 5.
    if (s.bulk) {
      min += Math.round((-(h - b.hydration.def) * 2) / 5) * 5;
    }
    // The last bake step scales with the dough size (clamped) and, a little,
    // with a wetter dough, to the minute.
    if (s.bakeAdjust) {
      const factor = clamp(Math.sqrt(sz / b.sizeDef), 0.7, 1.4);
      min = Math.round(s.min * factor + Math.max(0, (h - b.hydration.def) / 5));
    }
    return { ...s, min, advice: s.advice.replace('{pieces}', pieces) };
  });
  const totalMin = steps.reduce((s, st) => s + st.min, 0);
  // The header total rounds to the nearest 30 min once it is over 2 h.
  const aboutMin = totalMin >= 120 ? Math.round(totalMin / 30) * 30 : totalMin;

  // Where the hydration sits between its floor and its ceiling picks the
  // feel note: the low third, the middle one, or the high one.
  const span = b.hydration.max - b.hydration.min;
  const band = h < b.hydration.min + span / 3 ? 0 : h < b.hydration.min + (2 * span) / 3 ? 1 : 2;

  return {
    name: b.name,
    starter: b.starter > 0,
    hydration: h,
    count: n,
    size: sz,
    countLabel: n === 1 ? b.count.one : b.count.label.toLowerCase(),
    sizeLabel: `Dough per ${b.count.unit}`,
    total,
    flour,
    rows,
    steps,
    totalMin,
    aboutMin,
    feel: b.feel[band],
  };
}