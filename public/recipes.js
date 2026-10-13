// The bread table and the maths behind the recipe. Pure ES module, no DOM
// access, so it can be tested in Node (test/recipes.test.js).
//
// Percentages are of total flour (baker's percent). A starter is taken as
// 100% hydration: half flour, half water. Hydration counts all the water
// against all the flour, the starter's share included.

export const KIND_ORDER = ['sourdough', 'bagels', 'sourdoughBagels', 'rye', 'sandwich'];

export const BREADS = {
  sourdough: {
    name: 'Sourdough',
    hydration: 75,
    count: { label: 'Loaves', min: 1, max: 12, def: 1 },
    size: { label: 'Dough per loaf', noun: 'loaf', plural: 'loaves', presets: [500, 800, 900], def: 900 },
    flours: [{ key: 'flour', name: 'Bread flour', pct: 100, note: 'Strong white', tone: 'flour', first: true }],
    starter: { key: 'starter', name: 'Active starter', pct: 20, note: 'Fed and bubbly, equal flour and water' },
    others: [{ key: 'salt', name: 'Salt', pct: 2, note: 'Fine sea salt', tone: 'salt' }],
    steps: [
      { name: 'Mix and rest', what: 'Flour and water first, then starter and salt', dur: '45 min' },
      { name: 'Bulk rise', what: 'Stretch and fold every 30 min for 2 h, until about half again as big', dur: '4 to 5 h' },
      { name: 'Shape', what: 'Pre-shape, rest 20 min, shape tight', dur: '30 min' },
      { name: 'Cold proof', what: 'Covered, in the fridge', dur: '8 to 14 h' },
    ],
    bake: {
      temp: '250 °C', tempHint: '480 °F, preheat 45 min', time: '45 min', split: '20 min lid on, 25 min lid off',
      note: (count) => 'In a Dutch oven' + (count > 1 ? ', one loaf at a time' : '') + '. Done when deep brown and hollow-sounding underneath.',
    },
  },
  bagels: {
    name: 'Bagels',
    hydration: 60,
    count: { label: 'Bagels', min: 1, max: 24, def: 8 },
    size: { label: 'Dough per bagel', noun: 'bagel', plural: 'bagels', presets: [100, 115, 130], def: 115 },
    flours: [{ key: 'flour', name: 'Bread flour', pct: 100, note: 'Strong white', tone: 'flour', first: true }],
    starter: null,
    others: [
      { key: 'yeast', name: 'Instant yeast', pct: 1, note: 'Mixed into the flour', tone: 'lev' },
      { key: 'salt', name: 'Salt', pct: 2, note: 'Fine sea salt', tone: 'salt' },
      { key: 'malt', name: 'Barley malt syrup', pct: 4, note: 'In the dough and the boil water', tone: 'salt' },
    ],
    steps: [
      { name: 'Knead', what: 'Until smooth and elastic', dur: '10 min' },
      { name: 'First rise', what: 'Covered, until puffed', dur: '1 h' },
      { name: 'Shape', what: 'Roll into ropes, loop into rings', dur: '15 min' },
      { name: 'Cold proof', what: 'Covered, in the fridge', dur: '8 to 12 h' },
      { name: 'Boil', what: 'With barley malt syrup, a few at a time', dur: '1 min a side' },
    ],
    bake: {
      temp: '220 °C', tempHint: '425 °F', time: '20 min', split: '',
      note: 'Boil first, then bake on a lined tray. Done when shiny and deep gold.',
    },
  },
  sourdoughBagels: {
    name: 'Sourdough bagels',
    hydration: 60,
    count: { label: 'Bagels', min: 1, max: 24, def: 8 },
    size: { label: 'Dough per bagel', noun: 'bagel', plural: 'bagels', presets: [100, 115, 130], def: 115 },
    flours: [{ key: 'flour', name: 'Bread flour', pct: 100, note: 'Strong white', tone: 'flour', first: true }],
    starter: { key: 'starter', name: 'Active starter', pct: 20, note: 'Fed and bubbly, equal flour and water' },
    others: [
      { key: 'salt', name: 'Salt', pct: 2, note: 'Fine sea salt', tone: 'salt' },
      { key: 'malt', name: 'Barley malt syrup', pct: 4, note: 'In the dough and the boil water', tone: 'salt' },
    ],
    steps: [
      { name: 'Knead', what: 'Until smooth and elastic', dur: '10 min' },
      { name: 'Bulk rise', what: 'Covered, until puffy', dur: '4 h' },
      { name: 'Shape', what: 'Roll into ropes, loop into rings', dur: '15 min' },
      { name: 'Cold proof', what: 'Covered, in the fridge', dur: '12 to 18 h' },
      { name: 'Boil', what: 'With barley malt syrup, a few at a time', dur: '1 min a side' },
    ],
    bake: {
      temp: '220 °C', tempHint: '425 °F', time: '22 min', split: '',
      note: 'Boil first, then bake on a lined tray. Done when golden and firm.',
    },
  },
  rye: {
    name: 'Rye',
    hydration: 80,
    count: { label: 'Loaves', min: 1, max: 12, def: 1 },
    size: { label: 'Dough per loaf', noun: 'loaf', plural: 'loaves', presets: [500, 800, 900], def: 900 },
    flours: [
      { key: 'ryeFlour', name: 'Rye flour', pct: 70, note: 'Dark or medium', tone: 'flour', first: true },
      { key: 'flour', name: 'Bread flour', pct: 30, note: 'Strong white', tone: 'flour' },
    ],
    starter: { key: 'starter', name: 'Rye starter', pct: 20, note: 'Fed and bubbly, equal flour and water' },
    others: [{ key: 'salt', name: 'Salt', pct: 2, note: 'Fine sea salt', tone: 'salt' }],
    steps: [
      { name: 'Mix', what: 'Stir together, no kneading', dur: '10 min' },
      { name: 'Bulk rise', what: 'Covered, until risen by about half', dur: '2 to 3 h' },
      { name: 'Shape into tin', what: 'Wet hands, smooth the top', dur: '10 min' },
      { name: 'Final proof', what: 'In the tin, until the top starts to crack', dur: '1 to 1.5 h' },
    ],
    bake: {
      temp: '240 °C', tempHint: 'then 210 °C, 465 then 410 °F', time: '55 min', split: '15 min hot, 40 min lower',
      note: 'Rest for 24 h before slicing. Done when it sounds hollow underneath.',
    },
  },
  sandwich: {
    name: 'Sandwich loaf',
    hydration: 65,
    count: { label: 'Loaves', min: 1, max: 12, def: 1 },
    size: { label: 'Dough per loaf', noun: 'loaf', plural: 'loaves', presets: [500, 800, 900], def: 900 },
    flours: [{ key: 'flour', name: 'Bread flour', pct: 100, note: 'Strong white', tone: 'flour', first: true }],
    starter: null,
    others: [
      { key: 'yeast', name: 'Instant yeast', pct: 1.5, note: 'Mixed into the flour', tone: 'lev' },
      { key: 'salt', name: 'Salt', pct: 2, note: 'Fine sea salt', tone: 'salt' },
      { key: 'sugar', name: 'Sugar', pct: 4, note: 'Feeds the yeast and browns the crust', tone: 'salt' },
      { key: 'butter', name: 'Butter', pct: 6, note: 'Softened', tone: 'salt' },
    ],
    steps: [
      { name: 'Knead', what: 'Until smooth and springy', dur: '10 min' },
      { name: 'First rise', what: 'Covered, until doubled', dur: '1 to 1.5 h' },
      { name: 'Shape into tin', what: 'Flatten, roll tight, seam down', dur: '15 min' },
      { name: 'Second rise', what: 'In the tin, until just above the rim', dur: '45 to 60 min' },
    ],
    bake: {
      temp: '190 °C', tempHint: '375 °F', time: '35 min', split: '',
      note: 'Bake in a loaf tin. Done when golden and pulling away from the tin.',
    },
  },
};

const MIN_SIZE = 50;
const MAX_SIZE = 3000;

// Turn a choice into a recipe. Hydration and count are clamped to their
// ranges; a size that is not a finite number from 50 to 3000 g is an error
// the app shows instead of numbers worked out from a bad value.
export function calculate(kind, hydration, count, size) {
  const b = BREADS[kind];
  if (!b) return { error: 'kind' };

  const h = Math.min(90, Math.max(60, Math.round(Number(hydration) || b.hydration)));
  const c = Math.min(b.count.max, Math.max(b.count.min, Math.round(Number(count)) || b.count.def));
  const grams = Number(size);
  if (!Number.isFinite(grams) || grams < MIN_SIZE || grams > MAX_SIZE) return { error: 'size' };

  const totalDough = grams * c;
  const extras = b.others.reduce((sum, o) => sum + o.pct, 0) / 100;
  const F = totalDough / (1 + h / 100 + extras);
  const S = ((b.starter ? b.starter.pct : 0) / 100) * F;

  // Whole grams, except small amounts (yeast) at half-gram steps.
  const round = (x) => (x < 10 ? Math.round(x * 2) / 2 : Math.round(x));

  const ingredients = [];
  for (const f of b.flours) {
    // The starter's flour comes off the first flour: bread flour, or rye
    // flour for rye.
    ingredients.push({ key: f.key, name: f.name, note: f.note, grams: round((f.pct / 100) * F - (f.first ? S / 2 : 0)), tone: f.tone });
  }
  ingredients.push({ key: 'water', name: 'Water', note: 'Lukewarm', grams: round((h / 100) * F - S / 2), tone: 'water' });
  if (b.starter) ingredients.push({ key: b.starter.key, name: b.starter.name, note: b.starter.note, grams: round(S), tone: 'lev' });
  for (const o of b.others) ingredients.push({ key: o.key, name: o.name, note: o.note, grams: round((o.pct / 100) * F), tone: o.tone });

  return {
    settings: { kind, hydration: h, count: c, size: grams },
    totalDough,
    ingredients,
    steps: b.steps,
    bake: {
      temp: b.bake.temp,
      tempHint: b.bake.tempHint,
      time: b.bake.time,
      split: b.bake.split,
      note: typeof b.bake.note === 'function' ? b.bake.note(c) : b.bake.note,
    },
  };
}