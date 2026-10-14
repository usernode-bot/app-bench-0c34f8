// The bread maths, with nothing about the page in it: a BREADS table and
// calculate({ type, hydration, count, size }), which returns the ingredients
// in grams with their baker's percentages, the rise steps and the bake steps.
// Every displayed string is worked out here so the page only renders.

export const BREADS = {
  sourdough: {
    label: 'Sourdough',
    unit: ['loaf', 'loaves'],
    hydration: 75,
    leaven: { kind: 'starter', name: 'Starter', sub: 'fed, bubbly', percent: 20 },
    salt: 2,
    flourName: 'Bread flour',
    sizes: [450, 680, 900],
    maxCount: 12,
    rise: [
      { name: 'Bulk rise', min: 240, max: 300, tip: 'At about 24°C. Stretch and fold every 30 min for the first 2 h.' },
      { name: 'Shape and proof', min: 60, max: 120, tip: 'Or overnight in the fridge, 8 to 14 h.' },
    ],
    bake: [
      { name: 'Preheat', icon: 'oven', temp: 250, desc: 'With a Dutch oven inside, 45 min.' },
      { name: 'Lid on', icon: 'timer', temp: 250, desc: 'One loaf at a time.', time: [20, 20, 20] },
      { name: 'Lid off', icon: 'timer', temp: 230, desc: 'Until deep brown.', time: [15, 20, 25] },
    ],
  },
  bagels: {
    label: 'Bagels',
    unit: ['bagel', 'bagels'],
    hydration: 58,
    leaven: { kind: 'yeast', name: 'Instant yeast', sub: null, percent: 1 },
    salt: 2,
    flourName: 'Bread flour',
    sizes: [90, 110, 130],
    maxCount: 24,
    rise: [
      { name: 'Bulk rise', min: 60, max: 60, tip: 'Cover the bowl and leave it somewhere cool.' },
      { name: 'Shape and proof', min: 30, max: 30, tip: 'Poked dough springs back slowly when it is ready. Or in the fridge overnight.' },
    ],
    bake: [
      { name: 'Boil', icon: 'pot', desc: 'Then straight onto the tray.', value: '1 min a side' },
      { name: 'Bake', icon: 'oven', temp: 220, desc: 'Until shiny and deep gold.', time: [18, 20, 22] },
    ],
  },
  'sourdough-bagels': {
    label: 'Sourdough bagels',
    unit: ['bagel', 'bagels'],
    hydration: 60,
    leaven: { kind: 'starter', name: 'Starter', sub: 'fed, bubbly', percent: 20 },
    salt: 2,
    flourName: 'Bread flour',
    sizes: [90, 110, 130],
    maxCount: 24,
    rise: [
      { name: 'Bulk rise', min: 240, max: 360, tip: 'At about 24°C. Slower than yeasted dough.' },
      { name: 'Shape and proof', min: 480, max: 720, tip: 'In the fridge, covered, overnight.' },
    ],
    bake: [
      { name: 'Boil', icon: 'pot', desc: 'Then straight onto the tray.', value: '1 min a side' },
      { name: 'Bake', icon: 'oven', temp: 220, desc: 'Until shiny and deep gold.', time: [18, 20, 22] },
    ],
  },
  rye: {
    label: 'Rye',
    unit: ['loaf', 'loaves'],
    hydration: 80,
    leaven: { kind: 'yeast', name: 'Instant yeast', sub: null, percent: 1.5 },
    salt: 2,
    flourName: 'Rye flour',
    sizes: [450, 680, 900],
    maxCount: 12,
    rise: [
      { name: 'Bulk rise', min: 60, max: 90, tip: 'Rye rises less than wheat. Stop when it looks puffy.' },
      { name: 'Shape and proof', min: 45, max: 60, tip: 'In a well-floured proofing basket or tin.' },
    ],
    bake: [
      { name: 'Bake, hot', icon: 'oven', temp: 230, desc: 'With steam if you have a way to make it.', time: [10, 10, 10] },
      { name: 'Turn down', icon: 'timer', temp: 200, desc: 'Until the crust is firm and dark.', time: [30, 40, 50] },
    ],
  },
  'sandwich-loaf': {
    label: 'Sandwich loaf',
    unit: ['loaf', 'loaves'],
    hydration: 65,
    leaven: { kind: 'yeast', name: 'Instant yeast', sub: null, percent: 1 },
    salt: 2,
    flourName: 'Bread flour',
    sizes: [450, 680, 900],
    maxCount: 12,
    rise: [
      { name: 'Bulk rise', min: 60, max: 90, tip: 'Until puffy rather than doubled.' },
      { name: 'Shape and proof', min: 45, max: 60, tip: 'In the greased tin, until it crowns the rim.' },
    ],
    bake: [
      { name: 'Bake', icon: 'oven', temp: 190, desc: 'Until the top is golden and the base sounds hollow.', time: [30, 35, 40] },
    ],
  },
};

export const DEFAULT_TYPE = 'sourdough';

const grams = (n) => Math.round(n).toLocaleString('en-US');
const oneDecimal = (n) => (Math.round(n * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });

// Times round to 5 minutes, or to 15 minutes past the hour.
const round5 = (m) => (m > 60 ? Math.round(m / 15) * 15 : Math.round(m / 5) * 5);

function fmtMinutes(m) {
  if (m % 60 === 0) return `${m / 60} h`;
  if (m < 60) return `${m} min`;
  if (m % 60 === 30) return `${(m / 60).toFixed(1)} h`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function fmtRange(lo, hi) {
  const a = round5(lo);
  const b = round5(hi);
  if (a === b) return fmtMinutes(a);
  if (a % 60 === 0 && b % 60 === 0) return `${a / 60} to ${b / 60} h`;
  return `${fmtMinutes(a)} to ${fmtMinutes(b)}`;
}

// °F, rounded to 5.
const fahrenheit = (c) => String(Math.round(((c * 9) / 5 + 32) / 5) * 5);
const tempLabel = (c) => `${c}°C / ${fahrenheit(c)}°F`;

/**
 * calculate({ type, hydration, count, size }) — the full recipe, or a throw
 * with a short message when the settings cannot make one.
 */
export function calculate({ type, hydration, count, size }) {
  const bread = BREADS[type];
  if (!bread) throw new Error('Pick a bread first.');
  hydration = Number(hydration);
  count = Math.round(Number(count));
  size = Number(size);
  if (!Number.isFinite(hydration) || hydration < 55 || hydration > 90) throw new Error('Set hydration between 55% and 90%.');
  if (!Number.isFinite(count) || count < 1 || count > bread.maxCount) throw new Error(`Set between 1 and ${bread.maxCount} ${bread.unit[1]}.`);
  if (!bread.sizes.includes(size)) throw new Error('Pick a size for this bread.');

  const sizeIndex = bread.sizes.indexOf(size);
  const leavenPct = bread.leaven.percent;
  const total = count * size;

  // Flour is the whole of it: every other ingredient is a share of the flour.
  const flour = total / (1 + hydration / 100 + bread.salt / 100 + leavenPct / 100);

  const ingredients = [
    { name: bread.flourName, grams: grams(flour), percent: 100, percentLabel: '100%' },
    { name: 'Water', grams: grams(flour * (hydration / 100)), percent: hydration, percentLabel: `${hydration}%` },
  ];
  if (bread.leaven.kind === 'starter') {
    ingredients.push({ name: bread.leaven.name, sub: bread.leaven.sub, grams: grams(flour * (leavenPct / 100)), percent: leavenPct, percentLabel: `${leavenPct}%` });
  } else {
    const yeast = flour * (leavenPct / 100);
    // Under 10 g, yeast shows one decimal (8.1 g, not 8 g).
    ingredients.push({ name: bread.leaven.name, sub: bread.leaven.sub, grams: yeast < 10 ? oneDecimal(yeast) : grams(yeast), percent: leavenPct, percentLabel: `${leavenPct}%` });
  }
  ingredients.push({ name: 'Salt', grams: grams(flour * (bread.salt / 100)), percent: bread.salt, percentLabel: `${bread.salt}%` });

  // Wetter dough rises a little faster and bakes a little longer: per 5
  // points of hydration from the bread's default, the bulk rise shifts 5%
  // and every timed bake step shifts 2 minutes.
  const points = (hydration - bread.hydration) / 5;
  const riseFactor = 1 - 0.05 * points;
  const bakeShift = Math.round(2 * points);

  const rise = bread.rise.map((step, i) => ({
    name: step.name,
    duration: i === 0 ? fmtRange(step.min * riseFactor, step.max * riseFactor) : fmtRange(step.min, step.max),
    tip: step.tip,
  }));

  const bake = bread.bake.map((step, i) => {
    if (!step.time) {
      return { name: step.name, desc: step.desc, value: step.temp ? tempLabel(step.temp) : step.value || '', icon: step.icon };
    }
    const minutes = Math.max(5, step.time[sizeIndex] + bakeShift);
    const desc = step.temp ? `At ${tempLabel(step.temp)}, ${lower(step.desc)}` : step.desc;
    return { name: step.name, desc, value: fmtMinutes(round5(minutes)), icon: step.icon };
  });

  const unitWord = count === 1 ? bread.unit[0] : bread.unit[1];
  return {
    title: `${bread.label}, ${count.toLocaleString('en-US')} ${unitWord} of ${size.toLocaleString('en-US')} g`,
    subtitle: `${total.toLocaleString('en-US')} g of dough at ${hydration}% hydration`,
    ingredients,
    rise,
    bake,
  };
}

function lower(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
