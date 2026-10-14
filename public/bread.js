// The recipe maths, pure and DOM-free: public/app.js renders what
// calculate() returns. All weights are grams, temperatures °C.

export const BREADS = {
  sourdough: {
    label: 'Sourdough',
    unit: 'loaf',
    hydration: 75,
    weight: 900,
    hint: 'Water as a share of flour. Sourdough usually sits at 70 to 80%.',
    flours: [{ name: 'Bread flour', pct: 100 }],
    extras: [{ name: 'Active starter', pct: 20 }, { name: 'Salt', pct: 2 }],
    rise: [
      { label: 'Bulk rise', min: 270, max: 330, place: 'room', note: 'Room at about 24°C, stretch and fold every 30 min for the first 2 h' },
      { label: 'Shape, then cold proof', min: 480, max: 840, place: 'fridge', note: 'In the fridge, covered' },
    ],
    boil: false,
    bake: { reference: 900, stages: [
      { label: 'Lid on', c: 250, minutes: 20, note: 'Preheat a Dutch oven' },
      { label: 'Lid off', c: 230, minutes: 22, note: 'Until deep brown, 96°C inside' },
    ] },
  },
  bagels: {
    label: 'Bagels',
    unit: 'bagel',
    hydration: 58,
    weight: 110,
    hint: 'Water as a share of flour. Bagel dough stays stiff, around 55 to 60%.',
    flours: [{ name: 'Bread flour', pct: 100 }],
    extras: [{ name: 'Instant yeast', pct: 1 }, { name: 'Salt', pct: 2 }, { name: 'Sugar', pct: 3 }],
    rise: [
      { label: 'Bulk rise', min: 60, max: 90, place: 'room', note: 'Room at about 24°C, until puffy' },
      { label: 'Shape, then cold proof', min: 720, max: 1440, place: 'fridge', note: 'In the fridge, covered, overnight' },
    ],
    boil: true,
    bake: { reference: 110, stages: [
      { label: 'Bake', c: 230, minutes: 16, note: 'Until golden and shiny, turning once' },
    ] },
  },
  'sourdough-bagels': {
    label: 'Sourdough bagels',
    unit: 'bagel',
    hydration: 60,
    weight: 110,
    hint: 'Water as a share of flour. These sit between the two, around 57 to 63%.',
    flours: [{ name: 'Bread flour', pct: 100 }],
    extras: [{ name: 'Active starter', pct: 25 }, { name: 'Salt', pct: 2 }, { name: 'Sugar', pct: 3 }],
    rise: [
      { label: 'Bulk rise', min: 75, max: 105, place: 'room', note: 'Room at about 24°C, until puffy' },
      { label: 'Shape, then cold proof', min: 720, max: 1440, place: 'fridge', note: 'In the fridge, covered, overnight' },
    ],
    boil: true,
    bake: { reference: 110, stages: [
      { label: 'Bake', c: 230, minutes: 16, note: 'Until golden and shiny, turning once' },
    ] },
  },
  rye: {
    label: 'Rye',
    unit: 'loaf',
    hydration: 75,
    weight: 900,
    hint: 'Water as a share of flour. Rye holds water well, around 70 to 80%.',
    flours: [{ name: 'Rye flour', pct: 60 }, { name: 'Bread flour', pct: 40 }],
    extras: [{ name: 'Active starter', pct: 20 }, { name: 'Salt', pct: 2 }, { name: 'Caraway seeds', pct: 1.5 }],
    rise: [
      { label: 'Bulk rise', min: 240, max: 300, place: 'room', note: 'Room at about 24°C; rye rises slowly' },
      { label: 'Shape, then proof', min: 90, max: 120, place: 'room', note: 'In a greased loaf pan, covered' },
    ],
    boil: false,
    bake: { reference: 900, stages: [
      { label: 'Hot start', c: 230, minutes: 20, note: 'With a pan of water for steam' },
      { label: 'Finish', c: 200, minutes: 40, note: 'Until it sounds hollow underneath' },
    ] },
  },
  sandwich: {
    label: 'Sandwich loaf',
    unit: 'loaf',
    hydration: 65,
    weight: 900,
    hint: 'Water as a share of flour. Sandwich loaves sit around 60 to 70%.',
    flours: [{ name: 'Bread flour', pct: 100 }],
    extras: [{ name: 'Instant yeast', pct: 1.5 }, { name: 'Salt', pct: 2 }, { name: 'Sugar', pct: 6 }, { name: 'Butter', pct: 8 }],
    rise: [
      { label: 'Bulk rise', min: 60, max: 90, place: 'room', note: 'Room at about 24°C, until doubled' },
      { label: 'Shape, then proof', min: 60, max: 90, place: 'room', note: 'In the loaf pan, until it crowns the rim' },
    ],
    boil: false,
    bake: { reference: 900, stages: [
      { label: 'Bake', c: 190, minutes: 35, note: 'Until golden, 90°C inside' },
    ] },
  },
};

/** Grams round to whole numbers, or to 0.5 g under 10 g. */
export function roundGrams(g) {
  return g < 10 ? Math.round(g * 2) / 2 : Math.round(g);
}

/** °F is °C × 9/5 + 32, rounded to 5. */
export function toFahrenheit(c) {
  return Math.round((c * 9 / 5 + 32) / 5) * 5;
}

/**
 * calculate({ type, hydration, count, weight }): every ingredient's share of
 * the flour weight and its grams, the total dough weight, the rise stages
 * (wetter dough rises a little faster: 15 min per 5 hydration points away
 * from the bread's default) and the bake stages (bake minutes grow with the
 * loaf weight, by the square root of weight over the reference weight).
 */
export function calculate({ type, hydration, count, weight }) {
  const bread = BREADS[type];
  if (!bread) throw new Error(`Unknown bread type: ${type}`);
  const rows = [
    ...bread.flours.map((f) => ({ name: f.name, pct: f.pct })),
    { name: 'Water', pct: hydration },
    ...bread.extras.map((e) => ({ ...e })),
  ];
  const sum = rows.reduce((s, r) => s + r.pct, 0);
  const flour = count * weight / (sum / 100);
  const ingredients = rows.map((r) => ({ name: r.name, pct: r.pct, grams: roundGrams(flour * r.pct / 100) }));
  const total = ingredients.reduce((s, r) => s + r.grams, 0);

  const shift = (hydration - bread.hydration) * 3; // 15 min per 5 points
  const rise = bread.rise.map((stage) => ({
    ...stage,
    min: Math.max(10, stage.min - shift),
    max: Math.max(20, stage.max - shift),
  }));

  const scale = Math.sqrt(weight / bread.bake.reference);
  const bake = {
    ...bread.bake,
    stages: bread.bake.stages.map((s) => ({ ...s, minutes: Math.round(s.minutes * scale) })),
  };

  return { label: bread.label, unit: bread.unit, hydration, count, weight, ingredients, total, rise, bake };
}
