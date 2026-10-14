// The per-bread table and the pure calculator. Percentages are baker's
// percentages of the total flour; grams are worked out from them, so this
// module has no DOM and no state. Weights are grams and temperatures °C only.

const LOAF_SIZES = [
  { g: 500, label: '500 g' },
  { g: 800, label: '800 g' },
  { g: 1000, label: '1 kg' },
  { g: 1500, label: '1.5 kg' },
];

const BAGEL_SIZES = [
  { g: 100, label: '100 g' },
  { g: 115, label: '115 g' },
  { g: 130, label: '130 g' },
];

// starter is a ready, active starter (half flour, half water), counted in
// the flour and water totals. rye is the rye share of the flour, the rest
// bread flour. yeast, sugar and butter are direct additions.
export const BREADS = [
  {
    id: 'sourdough',
    name: 'Sourdough',
    kind: 'loaf',
    hydration: 75,
    band: [68, 82],
    starter: 0.2,
    count: 2,
    size: 800,
    bulk: 270,
    bulkNote: 'at about 24 °C, folding every 30 min',
    proof: 90,
    proofNote: 'or overnight in the fridge',
    waterNote: 'about 26 °C',
    note: "The starter's flour and water count toward the hydration.",
    bake: [
      { label: 'Covered', sub: '250 °C, lid on', min: 20 },
      { label: 'Uncovered', sub: '230 °C, until deep brown', min: 22 },
    ],
  },
  {
    id: 'bagels',
    name: 'Bagels',
    kind: 'bagel',
    hydration: 58,
    band: [55, 62],
    yeast: 0.01,
    sugar: 0.03,
    count: 8,
    size: 115,
    bulk: 60,
    bulkNote: 'at room temperature',
    proof: 30,
    proofNote: 'shaped, on the tray',
    waterNote: 'cool, about 18 °C',
    bake: [
      { label: 'Boil', boil: true },
      { label: 'Bake', sub: '220 °C', min: 18 },
    ],
  },
  {
    id: 'sourdough-bagels',
    name: 'Sourdough bagels',
    kind: 'bagel',
    hydration: 60,
    band: [55, 64],
    starter: 0.2,
    sugar: 0.03,
    count: 8,
    size: 115,
    bulk: 240,
    bulkNote: 'at about 24 °C',
    proof: 90,
    proofNote: 'or overnight in the fridge',
    waterNote: 'about 24 °C',
    note: "The starter's flour and water count toward the hydration.",
    bake: [
      { label: 'Boil', boil: true },
      { label: 'Bake', sub: '220 °C', min: 18 },
    ],
  },
  {
    id: 'rye',
    name: 'Rye',
    kind: 'loaf',
    hydration: 80,
    band: [75, 88],
    rye: 0.6,
    yeast: 0.01,
    count: 2,
    size: 800,
    bulk: 90,
    bulkNote: 'at about 24 °C',
    proof: 60,
    proofNote: 'in a floured tin',
    waterNote: 'about 24 °C',
    note: 'Rye is 60% of the flour, bread flour the rest.',
    bake: [
      { label: 'Start hot', sub: '240 °C', min: 10 },
      { label: 'Lower to finish', sub: '210 °C', min: 45 },
    ],
  },
  {
    id: 'sandwich',
    name: 'Sandwich loaf',
    kind: 'loaf',
    hydration: 64,
    band: [60, 70],
    yeast: 0.015,
    sugar: 0.04,
    butter: 0.06,
    count: 2,
    size: 800,
    bulk: 90,
    bulkNote: 'at about 24 °C',
    proof: 60,
    proofNote: 'in greased tins',
    waterNote: 'lukewarm, about 35 °C',
    bake: [
      { label: 'Bake', sub: '190 °C', min: 35 },
    ],
  },
];

export const bread = (id) => BREADS.find((b) => b.id === id) || BREADS[0];

export const sizesFor = (b) => (b.kind === 'bagel' ? BAGEL_SIZES : LOAF_SIZES);

// Grams are whole numbers; amounts under 10 g get one decimal.
const grams = (x) => {
  const n = x >= 10 ? Math.round(x) : Math.round(x * 10) / 10;
  return `${n.toLocaleString('en-US')} g`;
};

const minutes = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`);

// Wetter dough rises faster: 5 min per hydration point away from the
// bread's default, rounded to 5 min.
const riseShift = (b, hydration) => Math.round(((b.hydration - hydration) * 5) / 5);

// Bigger loaves bake longer: 5 min per 250 g away from 800 g. Bagel times
// stay fixed.
const bakeShift = (b, size) => (b.kind === 'bagel' ? 0 : Math.round((size - 800) / 250) * 5);

/**
 * calculate({ type, hydration, count, size }) →
 * { title, totals, ingredients, note, rise, bake }
 */
export function calculate({ type, hydration, count, size }) {
  const b = bread(type);
  const h = hydration / 100;
  // Everything but the starter's own share is part of the dough weight.
  const perFlour = 1 + h + 0.02 + (b.yeast || 0) + (b.sugar || 0) + (b.butter || 0);
  const flourTotal = (count * size) / perFlour;
  const waterTotal = flourTotal * h;
  const starter = (b.starter || 0) * flourTotal;
  const starterFlour = starter / 2;
  const starterWater = starter / 2;
  const salt = 0.02 * flourTotal;

  const ingredients = [];
  if (b.rye) {
    ingredients.push({ name: 'Rye flour', sub: `${Math.round(b.rye * 100)}% of the flour`, g: b.rye * flourTotal });
    ingredients.push({ name: 'Bread flour', sub: `${Math.round((1 - b.rye) * 100)}% of the flour`, g: (1 - b.rye) * flourTotal });
  } else {
    ingredients.push({ name: 'Bread flour', g: flourTotal - starterFlour });
  }
  ingredients.push({ name: 'Water', sub: b.waterNote, g: waterTotal - starterWater });
  if (starter) ingredients.push({ name: 'Starter', sub: 'active, fed 4 to 8 hours ago', g: starter });
  if (b.yeast) ingredients.push({ name: 'Instant yeast', g: b.yeast * flourTotal });
  if (b.sugar) ingredients.push({ name: b.id === 'bagels' ? 'Malt or sugar' : 'Sugar', g: b.sugar * flourTotal });
  if (b.butter) ingredients.push({ name: 'Butter', sub: 'softened', g: b.butter * flourTotal });
  ingredients.push({ name: 'Salt', g: salt });

  const shift = riseShift(b, hydration);
  const rise = [
    { name: 'Bulk rise', sub: b.bulkNote, text: minutes(Math.max(15, b.bulk + shift)) },
    { name: 'Shape and proof', sub: b.proofNote, text: minutes(Math.max(15, b.proof + shift)) },
  ];

  const bShift = bakeShift(b, size);
  const bake = b.bake.map((step) => ({
    boil: !!step.boil,
    name: step.label,
    sub: step.boil ? '1 min a side' : step.sub,
    text: step.boil ? '2 min' : minutes(Math.max(5, step.min + bShift)),
  }));

  // "2 sourdough loaves, 800 g each", "8 bagels, 115 g each", "1 rye loaf":
  // the bread's own name already says loaf for sandwich, so never double it.
  const baseName = b.name.toLowerCase();
  const unit = b.kind === 'bagel'
    ? (count === 1 ? baseName.replace(/s$/, '') : baseName)
    : baseName.endsWith('loaf')
      ? (count === 1 ? baseName : baseName.replace(/loaf$/, 'loaves'))
      : `${baseName} ${count === 1 ? 'loaf' : 'loaves'}`;
  const title = `${count} ${unit}, ${size >= 1000 ? `${(size / 1000).toLocaleString('en-US')} kg` : `${size} g`} each`;

  return {
    title,
    totals: `${grams(count * size)} of dough with ${grams(flourTotal)} flour in all`,
    ingredients: ingredients.map((row) => ({ ...row, text: grams(row.g) })),
    note: b.note || null,
    rise,
    bake,
  };
}
