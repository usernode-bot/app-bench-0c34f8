// Bread Bot's recipe maths: pure functions, no DOM. Imported by main.js in
// the browser and by test/recipe.test.mjs under Node, so it must stay free
// of anything browser-shaped.
//
// All percentages are baker's percentages of TOTAL flour F (the flour added
// plus the flour inside the starter). Hydration counts all water, including
// the starter's. The starter is 100% hydration: half flour, half water.
//
//   D = count × size                 total dough, g
//   F = D / (1 + h + salt + extras)  the starter is NOT added here: its
//                                    flour and water are already inside F and h
//   S = levain% × F ;  Sf = Sw = S/2
//   flour to add = F − Sf (split by the bread's flour mix)
//   water to add = h·F − Sw
//   salt, yeast, malt, sugar, butter = pct × F
//   feed note: each = ceil(S/3/5)×5 g of starter, flour and water

// Rounds a gram figure for display. Yeast always gets one decimal, and so
// does salt under 10 g; everything else is a whole number.
export function formatGrams(n, decimals = 0) {
  const v = Number(Number(n).toFixed(decimals));
  return decimals ? v.toFixed(decimals) : v.toLocaleString('en-US');
}

// How many decimals a displayed ingredient gets.
function decimalsFor(key, grams) {
  if (key === 'yeast') return 1;
  if (key === 'salt' && Math.round(grams) < 10) return 1;
  return 0;
}

// The bake-time adjustment for very large or very small bakes: loaves of
// 1,200 g or more add 5 min to the last stage, 600 g or less take 5 min off;
// bagels 150 g or more add 3 min, 90 g or less take 3 min off.
export function bakeMinutes(family, size) {
  if (family === 'bagel') return size >= 150 ? 3 : size <= 90 ? -3 : 0;
  return size >= 1200 ? 5 : size <= 600 ? -5 : 0;
}

function timeLabel(from, to) {
  return from === to ? `${from} min` : `${from} to ${to} min`;
}

// The five breads. Rise steps, oven settings and done lines are each
// bread's own; hydration carries the typical value and the range shown.
export const BREADS = {
  sourdough: {
    label: 'Sourdough',
    family: 'loaf',
    hydration: { typical: 75, lo: 70, hi: 80 },
    count: 1, size: 900, sizeStep: 50, sizeLo: 300, sizeHi: 2000,
    starter: 20, salt: 2, extras: [],
    flours: [{ key: 'flour', name: 'Bread flour', note: '90% of total flour' }],
    liquid: { name: 'Water', note: 'Lukewarm, about 27°C' },
    starterName: 'Starter', starterNote: 'Active, fed 1:1 flour and water',
    saltNote: '2% of total flour',
    hint: 'Water for every 100 g of flour. Higher makes a slacker, more open dough.',
    thing: 'sourdough loaf',
    vessel: 'in a Dutch oven',
    rise: [
      { name: 'Bulk rise', how: 'Stretch and fold every 30 min for the first 2 h, until risen by half', time: '4 to 5 h' },
      { name: 'Shape', how: 'Pre-shape, rest 20 min, then shape into a banneton', time: '30 min' },
      { name: 'Final proof', how: 'Covered, in the fridge', time: '12 to 16 h' },
    ],
    bake: {
      stages: [
        { c: 250, f: 480, label: 'Lid on, 20 min' },
        { c: 230, f: 450, stage: 'Lid off', time: [20, 25] },
      ],
      done: 'Preheat 45 min. Bake one loaf at a time. Done when deep brown and 96°C inside; cool 1 h before slicing.',
    },
  },

  bagels: {
    label: 'Bagels',
    family: 'bagel',
    hydration: { typical: 58, lo: 55, hi: 60 },
    count: 8, size: 115, sizeStep: 5, sizeLo: 60, sizeHi: 200,
    starter: 0, salt: 2, extras: [{ key: 'malt', name: 'Barley malt syrup', note: 'Or honey, 4% of flour', pct: 4 }, { key: 'yeast', name: 'Instant yeast', note: '1% of flour', pct: 1 }],
    flours: [{ key: 'flour', name: 'Bread flour', note: 'High protein, 100% of flour' }],
    liquid: { name: 'Water', note: 'Lukewarm, about 27°C' },
    saltNote: '2% of flour',
    hint: 'Water for every 100 g of flour. Lower makes the stiff, chewy dough bagels need.',
    thing: 'bagel',
    vessel: 'on a lined tray',
    rise: [
      { name: 'Knead and rest', how: 'Knead 10 min until smooth, then cover', time: '1 h' },
      { name: 'Shape', how: 'Roll ropes and join into rings', time: '20 min' },
      { name: 'Cold proof', how: 'Covered, in the fridge, until a ring floats in water', time: '8 to 12 h' },
      { name: 'Boil', how: 'In water with 1 tbsp malt syrup, each side', time: '1 min' },
    ],
    bake: {
      stages: [{ c: 220, f: 425, time: [18, 22] }],
      done: 'Preheat 30 min. Top with seeds straight after boiling. Done when glossy and deep golden.',
    },
  },

  'sourdough-bagels': {
    label: 'Sourdough bagels',
    family: 'bagel',
    hydration: { typical: 58, lo: 55, hi: 62 },
    count: 8, size: 115, sizeStep: 5, sizeLo: 60, sizeHi: 200,
    starter: 20, salt: 2, extras: [{ key: 'malt', name: 'Barley malt syrup', note: 'Or honey, 4% of flour', pct: 4 }],
    flours: [{ key: 'flour', name: 'Bread flour', note: '90% of total flour' }],
    liquid: { name: 'Water', note: 'Lukewarm, about 27°C' },
    starterName: 'Starter', starterNote: 'Active, fed 1:1 flour and water',
    saltNote: '2% of flour',
    hint: 'Water for every 100 g of flour. Lower makes the stiff, chewy dough bagels need.',
    thing: 'sourdough bagel',
    vessel: 'on a lined tray',
    rise: [
      { name: 'Bulk rise', how: 'Until risen by half, at about 24°C', time: '4 to 6 h' },
      { name: 'Shape', how: 'Roll ropes and join into rings', time: '20 min' },
      { name: 'Cold proof', how: 'Covered, in the fridge, until a ring floats in water', time: '10 to 14 h' },
      { name: 'Boil', how: 'In water with 1 tbsp malt syrup, each side', time: '1 min' },
    ],
    bake: {
      stages: [{ c: 220, f: 425, time: [20, 24] }],
      done: 'Preheat 30 min. Top with seeds straight after boiling. Done when glossy and deep golden.',
    },
  },

  rye: {
    label: 'Rye',
    family: 'loaf',
    hydration: { typical: 80, lo: 75, hi: 85 },
    count: 1, size: 900, sizeStep: 50, sizeLo: 300, sizeHi: 2000,
    starter: 20, salt: 2, extras: [],
    // 70% rye flour and 30% bread flour; the starter's flour counts toward rye.
    flours: [
      { key: 'rye-flour', name: 'Rye flour', note: '70% of total flour', share: 0.7 },
      { key: 'flour', name: 'Bread flour', note: '30% of total flour', share: 0.3 },
    ],
    liquid: { name: 'Water', note: 'Lukewarm, about 27°C' },
    starterName: 'Rye starter', starterNote: 'Active, fed 1:1 flour and water',
    saltNote: '2% of total flour',
    hint: 'Water for every 100 g of flour. Rye likes a wet, sticky dough.',
    thing: 'rye loaf',
    vessel: 'in a loaf tin',
    rise: [
      { name: 'Bulk rise', how: 'Until puffy but not doubled, at about 24°C', time: '2 to 3 h' },
      { name: 'Shape', how: 'Into a greased loaf tin, smooth the top', time: '15 min' },
      { name: 'Final proof', how: 'In the tin, until cracks show on top', time: '1 to 1.5 h' },
    ],
    bake: {
      stages: [
        { c: 240, f: 465, label: '15 min' },
        { c: 210, f: 410, time: [35, 40] },
      ],
      done: 'Preheat 45 min. Done when the cracks are deep brown. Rest 12 h before slicing.',
    },
  },

  sandwich: {
    label: 'Sandwich loaf',
    family: 'loaf',
    hydration: { typical: 65, lo: 60, hi: 70 },
    count: 1, size: 900, sizeStep: 50, sizeLo: 300, sizeHi: 2000,
    starter: 0, salt: 2,
    extras: [
      { key: 'yeast', name: 'Instant yeast', note: '1.2% of flour', pct: 1.2 },
      { key: 'sugar', name: 'Sugar', note: '5% of flour', pct: 5 },
      { key: 'butter', name: 'Butter', note: 'Softened, 8% of flour', pct: 8 },
    ],
    flours: [{ key: 'flour', name: 'Bread flour', note: '100% of total flour' }],
    liquid: { name: 'Water or milk', note: 'Lukewarm, about 27°C' },
    saltNote: '2% of total flour',
    hint: 'Water for every 100 g of flour. Milk makes a softer crumb than water.',
    thing: 'sandwich loaf',
    vessel: 'in a loaf tin',
    rise: [
      { name: 'Knead and bulk rise', how: 'Knead 10 min until smooth, then cover until doubled', time: '1 to 1.5 h' },
      { name: 'Shape', how: 'Into a greased loaf tin', time: '10 min' },
      { name: 'Final proof', how: 'In the tin, until 2 cm above the rim', time: '45 to 60 min' },
    ],
    bake: {
      stages: [{ c: 190, f: 375, time: [30, 35] }],
      done: 'Preheat 15 min. Done when golden and 90°C inside; turn out and cool on a rack.',
    },
  },
};

// The settings each bread starts from: always its typical hydration, and its
// count and size only when the shape family (loaf or bagel) changes — a 900 g
// bagel is never what anyone means, but 8 bagels after 8 bagels is.
export function defaultsFor(type, prevType, current = {}) {
  const B = BREADS[type];
  const prev = prevType ? BREADS[prevType] : null;
  const familyChanged = !prev || prev.family !== B.family;
  return {
    hydration: B.hydration.typical,
    count: familyChanged ? B.count : current.count,
    size: familyChanged ? B.size : current.size,
  };
}

// Returns { field: message } for anything out of range. Hydration and count
// are whole numbers; the size must sit inside the bread's own range.
export function validate(settings) {
  const errors = {};
  const B = BREADS[settings.type];
  const h = Number(settings.hydration);
  if (!Number.isInteger(h) || h < 50 || h > 100) errors.hydration = 'Enter 50 to 100%';
  const c = Number(settings.count);
  if (!Number.isInteger(c) || c < 1 || c > 24) errors.count = 'Enter 1 to 24';
  const s = Number(settings.size);
  if (!Number.isInteger(s) || s < B.sizeLo || s > B.sizeHi) {
    errors.size = `Enter ${B.sizeLo.toLocaleString('en-US')} to ${B.sizeHi.toLocaleString('en-US')} g`;
  }
  return errors;
}

// Turns settings into everything the recipe shows. Grams are display values
// (rounded the way they are shown); the total dough row is the sum of the
// displayed parts, so its note carries the exact flour and water.
export function calculate(settings) {
  const B = BREADS[settings.type];
  const h = settings.hydration / 100;
  const D = settings.count * settings.size;
  const extrasPct = B.extras.reduce((a, e) => a + e.pct, 0);
  const F = D / (1 + h + B.salt / 100 + extrasPct / 100);
  const S = B.starter ? (B.starter / 100) * F : 0;
  const Sf = S / 2;
  const Sw = S / 2;
  const waterTotal = h * F;

  const parts = [];
  const add = (key, name, note, grams) => {
    const dec = decimalsFor(key, grams);
    parts.push({ key, name, note, grams: Number(grams.toFixed(dec)), text: formatGrams(grams, dec) });
  };

  // Flour rows: the flour mix, minus the flour already in the starter (its
  // flour counts toward the mix's first share, rye for rye bread).
  let starterFlourLeft = Sf;
  for (const f of B.flours) {
    const share = 'share' in f ? f.share * F : F;
    const toAdd = Math.max(0, share - starterFlourLeft);
    starterFlourLeft = Math.max(0, starterFlourLeft - share);
    add(f.key, f.name, f.note, toAdd);
  }
  add('water', B.liquid.name, B.liquid.note, waterTotal - Sw);
  if (S) add('starter', B.starterName, B.starterNote, S);
  for (const e of B.extras) add(e.key, e.name, e.note, (e.pct / 100) * F);
  add('salt', 'Salt', B.saltNote, (B.salt / 100) * F);

  const total = parts.reduce((a, p) => a + p.grams, 0);

  // The night-before feed: a third of the starter, rounded up to 5 g.
  const feed = S
    ? (() => {
        const each = Math.ceil(S / 3 / 5) * 5;
        return { starter: each, flour: each, water: each, text: `The night before, feed ${each} g starter with ${each} g flour and ${each} g water. Use it when it has doubled.` };
      })()
    : null;

  // Bake stages: the last one's time shifts for very large or small bakes,
  // and ranges stay ranges.
  const adj = bakeMinutes(B.family, settings.size);
  const stages = B.bake.stages.map((s, i) => {
    if (Array.isArray(s.time)) {
      const from = s.time[0] + (i === B.bake.stages.length - 1 ? adj : 0);
      const to = s.time[1] + (i === B.bake.stages.length - 1 ? adj : 0);
      return { c: s.c, f: s.f, label: s.stage ? `${s.stage}, ${timeLabel(from, to)}` : timeLabel(from, to) };
    }
    return { c: s.c, f: s.f, label: s.label };
  });

  const noun = (n, thing) => `${n} ${n === 1 ? thing : thing.replace(/loaf$/, 'loaves') + (thing.includes('loaf') ? '' : 's')}`;

  return {
    type: settings.type,
    count: settings.count,
    size: settings.size,
    hydration: settings.hydration,
    totalDough: D,
    totalFlour: F,
    totalWater: waterTotal,
    summary: noun(settings.count, B.thing),
    countLabel: B.family === 'bagel' ? 'Bagels' : 'Loaves',
    sizeLabel: B.family === 'bagel' ? 'Each bagel' : 'Each loaf',
    typicalText: `Typical for ${B.label.toLowerCase()}: ${B.hydration.lo} to ${B.hydration.hi}%`,
    hint: B.hint,
    ingredients: parts,
    totalText: formatGrams(total),
    sumNote: `Total flour ${formatGrams(F)} g, water ${formatGrams(waterTotal)} g`,
    feed,
    rise: B.rise,
    vessel: B.vessel,
    bake: { stages, done: B.bake.done },
  };
}