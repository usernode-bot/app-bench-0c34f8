// Bread maths, pure: the five styles, ingredient grams, bake and timeline.
// No DOM here, so Node's test runner can import it (public/app/package.json
// marks this directory as an ES module).
//
// Percentages are of total flour TF. A starter is 100% hydration (half flour,
// half water) and is itself a percentage of TF. Dough weight
// W = count x size; TF = W / (1 + H/100 + E/100), E being the extras' share
// (everything but flour, water and starter).

const fmtN = (n) => Number(n).toLocaleString('en-US');

/** "931", "5.3", "1,034": rows of 10 g or more are whole grams, smaller ones one decimal. */
export function formatGrams(g) {
  if (g < 10) return (Math.round(g * 10) / 10).toFixed(1);
  return fmtN(Math.round(g));
}

/** "4 h 30 min", "45 min", "1 h". */
export function formatDuration(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** The timeline heading's "about": a near-enough remainder drops to the hour
 * ("about 14 h"), a real one stays ("about 18 h 25 min"), as drawn. */
export function formatTotal(min) {
  const m = Math.round(min);
  return formatDuration(m % 60 < 15 ? m - (m % 60) : m);
}

/** "17:40" — the clock time a step starts, counted from when you begin. */
export function formatOffset(min) {
  const m = Math.round(min);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

const SCALED = (base, size, ref, step) => Math.round((base * Math.cbrt(size / ref)) / step) * step;

// Ingredient specs: kind 'flour' | 'water' | 'starter' | 'extra'; grams(tf, h, s)
// with s the starter's grams; share(h, sp) is the shown percentage of TF.
export const STYLES = {
  sourdough: {
    label: 'Sourdough', unit: 'loaf', hydration: 72, count: 2, size: 900,
    countMin: 1, countMax: 12, sizeMin: 400, sizeMax: 2000, sizeStep: 50,
    starterPct: 20, ratioNote: ', counting the starter.',
    ingredients: [
      { name: 'Bread flour', icon: 'flour', kind: 'flour', share: () => 90, g: (tf, h, s) => tf - s / 2 },
      { name: 'Water', icon: 'water', kind: 'water', tip: 'lukewarm', share: (h) => h - 10, g: (tf, h, s) => (h / 100) * tf - s / 2 },
      { name: 'Sourdough starter', icon: 'starter', kind: 'starter', tip: 'active, fed 4 to 12 h before', share: (h, sp) => sp, g: (tf, h, s) => s },
      { name: 'Salt', icon: 'salt', kind: 'extra', pct: 2, share: () => 2, g: (tf) => 0.02 * tf },
    ],
    bake: (count, size) => {
      const off = SCALED(25, size, 900, 5);
      return {
        c: 250, f: 480, minutes: 20 + off,
        text: `Lid on for 20 min, then lid off at 230°C (450°F) for ${off} min.` + (count > 1 ? ' Each loaf on its own.' : ''),
      };
    },
    steps: (count, size, bake) => [
      { title: 'Mix flour and water', text: 'Rest covered, 45 min', min: 45 },
      { title: 'Add starter and salt', text: 'Squeeze in until smooth, 10 min', min: 10 },
      { title: 'Bulk rise', rise: true, text: `${formatDuration(270)}, 4 sets of folds in the first 2 h`, min: 270 },
      { title: 'Divide and shape', text: `${count} ${count === 1 ? 'piece' : 'pieces'} of ${fmtN(size)} g, 15 min`, min: 15 },
      { title: 'Cold proof', rise: true, text: 'In the fridge, 12 h (8 to 16 h is fine)', min: 720 },
      { title: 'Bake', text: `Preheat 45 min before, bake ${formatDuration(bake.minutes)}`, min: bake.minutes },
      { title: 'Cool on a rack', end: true, text: 'At least 1 h before slicing' },
    ],
  },

  bagels: {
    label: 'Bagels', unit: 'bagel', hydration: 58, count: 8, size: 110,
    countMin: 1, countMax: 24, sizeMin: 60, sizeMax: 160, sizeStep: 10,
    starterPct: 0, ratioNote: '. Bagels are usually 55 to 62%.',
    ingredients: [
      { name: 'High-protein bread flour', icon: 'flour', kind: 'flour', share: () => 100, g: (tf) => tf },
      { name: 'Water', icon: 'water', kind: 'water', tip: 'lukewarm', share: (h) => h, g: (tf, h) => (h / 100) * tf },
      { name: 'Barley malt syrup', icon: 'syrup', kind: 'extra', pct: 4, tip: 'or honey', share: () => 4, g: (tf) => 0.04 * tf },
      { name: 'Salt', icon: 'salt', kind: 'extra', pct: 2, share: () => 2, g: (tf) => 0.02 * tf },
      { name: 'Instant yeast', icon: 'yeast', kind: 'extra', pct: 1, share: () => 1, g: (tf) => 0.01 * tf },
    ],
    bake: (_count, size) => {
      const t = SCALED(18, size, 110, 1);
      return {
        c: 220, f: 425, minutes: t,
        text: `${t} min, until deep golden. Boil first: 30 s a side in 2 L of water with 1 tbsp malt syrup.`,
      };
    },
    steps: (count, size, bake) => [
      { title: 'Mix and knead', text: 'Stiff and smooth, 10 min', min: 10 },
      { title: 'First rise', rise: true, text: 'Covered, 1 h', min: 60 },
      { title: 'Divide and shape', text: `${count} ${count === 1 ? 'piece' : 'pieces'} of ${fmtN(size)} g into rings, 20 min`, min: 20 },
      { title: 'Cold proof', rise: true, text: 'In the fridge, 12 h', min: 720 },
      { title: 'Boil', text: 'A few at a time, 15 min', min: 15 },
      { title: 'Bake', text: formatDuration(bake.minutes), min: bake.minutes },
      { title: 'Cool on a rack', end: true, text: 'At least 20 min' },
    ],
  },

  'sourdough-bagels': {
    label: 'Sourdough bagels', unit: 'bagel', hydration: 60, count: 8, size: 110,
    countMin: 1, countMax: 24, sizeMin: 60, sizeMax: 160, sizeStep: 10,
    starterPct: 20, ratioNote: ', counting the starter. Usually 58 to 65%.',
    ingredients: [
      { name: 'Bread flour', icon: 'flour', kind: 'flour', share: () => 90, g: (tf, h, s) => tf - s / 2 },
      { name: 'Water', icon: 'water', kind: 'water', share: (h) => h - 10, g: (tf, h, s) => (h / 100) * tf - s / 2 },
      { name: 'Sourdough starter', icon: 'starter', kind: 'starter', share: (h, sp) => sp, g: (tf, h, s) => s },
      { name: 'Barley malt syrup', icon: 'syrup', kind: 'extra', pct: 4, tip: 'or honey', share: () => 4, g: (tf) => 0.04 * tf },
      { name: 'Salt', icon: 'salt', kind: 'extra', pct: 2, share: () => 2, g: (tf) => 0.02 * tf },
    ],
    bake: (_count, size) => {
      const t = SCALED(20, size, 110, 1);
      return {
        c: 220, f: 425, minutes: t,
        text: `${t} min, until deep golden. Boil first: 30 s a side in 2 L of water with 1 tbsp malt syrup.`,
      };
    },
    steps: (count, size, bake) => [
      { title: 'Mix and knead', text: 'Stiff and smooth, 10 min', min: 10 },
      { title: 'Bulk rise', rise: true, text: 'Covered, 4 h', min: 240 },
      { title: 'Divide and shape', text: `${count} ${count === 1 ? 'piece' : 'pieces'} of ${fmtN(size)} g into rings, 20 min`, min: 20 },
      { title: 'Cold proof', rise: true, text: 'In the fridge, 12 h', min: 720 },
      { title: 'Boil', text: 'A few at a time, 15 min', min: 15 },
      { title: 'Bake', text: formatDuration(bake.minutes), min: bake.minutes },
      { title: 'Cool on a rack', end: true, text: 'At least 20 min' },
    ],
  },

  rye: {
    label: 'Rye', unit: 'loaf', hydration: 75, count: 1, size: 1000,
    countMin: 1, countMax: 12, sizeMin: 400, sizeMax: 2000, sizeStep: 50,
    starterPct: 20, ratioNote: ', counting the starter. Rye takes 70 to 85%.',
    ingredients: [
      { name: 'Rye starter', icon: 'starter', kind: 'starter', tip: 'rye-fed, active', share: (h, sp) => sp, g: (tf, h, s) => s },
      { name: 'Dark rye flour', icon: 'flour', kind: 'flour', share: () => 50, g: (tf, h, s) => 0.6 * tf - s / 2 },
      { name: 'Bread flour', icon: 'flour', kind: 'flour', share: () => 40, g: (tf) => 0.4 * tf },
      { name: 'Water', icon: 'water', kind: 'water', share: (h) => h - 10, g: (tf, h, s) => (h / 100) * tf - s / 2 },
      { name: 'Salt', icon: 'salt', kind: 'extra', pct: 2, share: () => 2, g: (tf) => 0.02 * tf },
    ],
    bake: (_count, size) => {
      const t2 = SCALED(45, size, 1000, 5);
      return {
        c: 240, f: 465, minutes: 15 + t2,
        text: `15 min at 240°C (465°F), then ${t2} min at 210°C (410°F), in a greased tin.`,
      };
    },
    steps: (count, size, bake) => [
      { title: 'Mix', text: 'Flour, water and starter, 10 min', min: 10 },
      { title: 'Bulk rise', rise: true, text: 'Covered, 1 h 30 min', min: 90 },
      { title: 'Shape with wet hands', text: `${count} ${count === 1 ? 'piece' : 'pieces'} of ${fmtN(size)} g into the tin, 15 min`, min: 15 },
      { title: 'Final proof', rise: true, text: 'Until cracks show, 1 h', min: 60 },
      { title: 'Bake', text: formatDuration(bake.minutes), min: bake.minutes },
      { title: 'Rest wrapped', end: true, text: '12 to 24 h before slicing' },
    ],
  },

  sandwich: {
    label: 'Sandwich loaf', unit: 'loaf', hydration: 65, count: 1, size: 900,
    countMin: 1, countMax: 12, sizeMin: 400, sizeMax: 2000, sizeStep: 50,
    starterPct: 0, ratioNote: '. Sandwich loaves are usually 60 to 70%.',
    ingredients: [
      { name: 'Bread flour', icon: 'flour', kind: 'flour', share: () => 100, g: (tf) => tf },
      { name: 'Water', icon: 'water', kind: 'water', tip: 'or milk', share: (h) => h, g: (tf, h) => (h / 100) * tf },
      { name: 'Butter', icon: 'butter', kind: 'extra', pct: 6, tip: 'soft', share: () => 6, g: (tf) => 0.06 * tf },
      { name: 'Sugar', icon: 'sugar', kind: 'extra', pct: 4, share: () => 4, g: (tf) => 0.04 * tf },
      { name: 'Salt', icon: 'salt', kind: 'extra', pct: 2, share: () => 2, g: (tf) => 0.02 * tf },
      { name: 'Instant yeast', icon: 'yeast', kind: 'extra', pct: 1.5, share: () => 1.5, g: (tf) => 0.015 * tf },
    ],
    bake: (_count, size) => {
      const t = SCALED(35, size, 900, 5);
      return { c: 190, f: 375, minutes: t, text: `${t} min in a greased 900 g (2 lb) tin.` };
    },
    steps: (count, size, bake) => [
      { title: 'Mix and knead', text: 'Stiff and smooth, 10 min', min: 10 },
      { title: 'First rise', rise: true, text: 'Covered, 1 h 15 min', min: 75 },
      { title: 'Shape into the tin', text: `${count} ${count === 1 ? 'piece' : 'pieces'} of ${fmtN(size)} g, 10 min`, min: 10 },
      { title: 'Second rise', rise: true, text: 'In the tin, 50 min', min: 50 },
      { title: 'Bake', text: formatDuration(bake.minutes), min: bake.minutes },
      { title: 'Cool on a rack', end: true, text: 'At least 1 h before slicing' },
    ],
  },
};

/** The screen's starting values for one bread. */
export function defaultsFor(styleKey) {
  const s = STYLES[styleKey];
  return { style: styleKey, hydration: s.hydration, count: s.count, size: s.size };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || lo)));

/** Keep one input inside its bread's limits: hydration 50 to 90, the rest per style. */
export function clampInput(input) {
  const s = STYLES[input.style];
  return {
    style: input.style,
    hydration: clamp(input.hydration, 50, 90),
    count: clamp(input.count, s.countMin, s.countMax),
    size: clamp(input.size, s.sizeMin, s.sizeMax),
  };
}

const roundGrams = (g) => (g >= 10 ? Math.round(g) : Math.round(g * 10) / 10);

/**
 * Everything the screen shows for one input:
 * { rows, total, flour, water, ratioText, bake: { c, f, text, minutes },
 *   steps: [{ at, title, text, rise?, end? }], totalMinutes }
 */
export function calculate({ style, hydration, count, size }) {
  const s = STYLES[style];
  const h = clamp(hydration, 50, 90);
  const total = count * size;
  const extras = s.ingredients.reduce((sum, i) => sum + (i.kind === 'extra' ? i.pct : 0), 0);
  const tf = total / (1 + h / 100 + extras / 100);
  const starter = (s.starterPct / 100) * tf;

  const rows = s.ingredients.map((i) => ({
    name: i.name, icon: i.icon, kind: i.kind, tip: i.tip || '',
    pct: i.share(h, s.starterPct),
    grams: roundGrams(i.g(tf, h, starter)),
  }));

  const bake = s.bake(count, size);
  const rawSteps = s.steps(count, size, bake);
  let at = 0;
  const steps = rawSteps.map((st) => {
    const step = { ...st, at };
    if (st.min) at += st.min;
    return step;
  });

  return {
    rows,
    total,
    flour: Math.round(tf),
    water: Math.round((h / 100) * tf),
    ratioText: `${h} g of water for every 100 g of flour${s.ratioNote}`,
    bake,
    steps,
    totalMinutes: at,
  };
}