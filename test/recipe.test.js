'use strict';
// Unit tests for public/bread/recipe.js: the spec's check figures, the row
// sums, the format helpers and the timeline adjustments. The module is an ES
// module under public/ (which the browser serves raw), so each test imports
// it across the CJS/ESM boundary.

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../public/bread/recipe.js');
const grams = (calc) => Object.fromEntries(calc.rows.map((r) => [r.key, r.grams]));
const step = (calc, name) => calc.steps.find((s) => s.name === name);

test('sourdough check figures: 2 loaves of 900 g at 75%', async () => {
  const { calculate } = await load();
  const calc = calculate('sourdough', { hydration: 75, count: 2, size: 900 });
  assert.equal(Math.round(calc.flour), 1017);
  const g = grams(calc);
  assert.equal(g.breadFlour, 814);
  assert.equal(g.wholeWheat, 102);
  assert.equal(g.water, 661);
  assert.equal(g.starter, 203);
  assert.equal(g.salt, 20);
  assert.equal(calc.total, 1800);
  // Displayed percentages, of total flour: bread flour rounds to 80%.
  const pct = Object.fromEntries(calc.rows.map((r) => [r.key, r.pctText]));
  assert.equal(pct.breadFlour, '80%');
  assert.equal(pct.wholeWheat, '10%');
  assert.equal(pct.water, '65%');
  assert.equal(pct.starter, '20%');
  assert.equal(pct.salt, '2%');
});

test('bagel check figures: 8 bagels of 115 g at 58%', async () => {
  const { calculate } = await load();
  const calc = calculate('bagels', { hydration: 58, count: 8, size: 115 });
  assert.equal(Math.round(calc.flour), 558);
  const g = grams(calc);
  assert.equal(g.breadFlour, 558);
  assert.equal(g.water, 323);
  assert.equal(g.malt, 22);
  assert.equal(g.salt, 11);
  // Under 10 g keeps one decimal.
  assert.equal(g.yeast, 5.6);
});

test('each bread weighs its rows to within 2 g of the total dough', async () => {
  const { BREADS, calculate } = await load();
  for (const kind of Object.keys(BREADS)) {
    const b = BREADS[kind];
    const calc = calculate(kind, { hydration: b.hydration.def, count: b.count.def, size: b.sizeDef });
    const sum = calc.rows.reduce((s, r) => s + r.grams, 0);
    assert.ok(Math.abs(sum - calc.total) <= 2, `${kind}: rows sum to ${sum}, total is ${calc.total}`);
  }
});

test('starter breads have a starter row and no yeast; the rest the opposite', async () => {
  const { BREADS, calculate } = await load();
  for (const [kind, b] of Object.entries(BREADS)) {
    const keys = calculate(kind, { hydration: b.hydration.def, count: b.count.def, size: b.sizeDef })
      .rows.map((r) => r.key);
    if (b.starter) {
      assert.ok(keys.includes('starter'), `${kind} should carry a starter row`);
      assert.ok(!keys.includes('yeast'), `${kind} should not carry yeast`);
    } else {
      assert.ok(!keys.includes('starter'), `${kind} should not carry a starter row`);
      assert.ok(keys.includes('yeast'), `${kind} should carry yeast`);
    }
  }
});

test('the water row plus half the starter adds up to the hydration', async () => {
  const { BREADS, calculate } = await load();
  for (const kind of ['sourdough', 'sourdoughBagels']) {
    const b = BREADS[kind];
    const calc = calculate(kind, { hydration: b.hydration.def, count: b.count.def, size: b.sizeDef });
    const g = grams(calc);
    const water = g.water + g.starter / 2;
    assert.ok(Math.abs(water - (b.hydration.def / 100) * calc.flour) <= 1,
      `${kind}: hydration water ${water} g should be ${b.hydration.def}% of ${calc.flour} g`);
  }
});

test('formatGrams: one decimal under 10 g, whole grams, a thousands separator', async () => {
  const { formatGrams } = await load();
  assert.equal(formatGrams(5.6), '5.6 g');
  assert.equal(formatGrams(20), '20 g');
  assert.equal(formatGrams(1800), '1,800 g');
});

test('formatDuration: minutes, hours and minutes, whole hours', async () => {
  const { formatDuration } = await load();
  assert.equal(formatDuration(270), '4 h 30 min');
  assert.equal(formatDuration(20), '20 min');
  assert.equal(formatDuration(720), '12 h');
});

test('bulk rise shortens as hydration rises, on starter breads only', async () => {
  const { BREADS, calculate } = await load();
  const at = (kind, h) => step(calculate(kind, { hydration: h, count: BREADS[kind].count.def, size: BREADS[kind].sizeDef }), 'Bulk rise').min;
  assert.equal(at('sourdough', 75), 270);
  assert.equal(at('sourdough', 85), 250); // 10 points above: 20 min shorter
  assert.equal(at('sourdough', 65), 290); // 10 points below: 20 min longer
  assert.equal(at('bagels', 58), 60);
  assert.equal(at('bagels', 65), 60); // a yeasted bread does not adjust
});

test('the last bake scales with dough size, clamped at 0.7 and 1.4', async () => {
  const { calculate } = await load();
  const bake = (size) => step(calculate('sourdough', { hydration: 75, count: 1, size }), 'Bake, lid off').min;
  assert.equal(bake(900), 25); // the default size keeps the base time
  assert.equal(bake(1200), Math.round(25 * Math.sqrt(1200 / 900)));
  assert.equal(bake(3000), Math.round(25 * 1.4)); // clamped at the top
  assert.equal(bake(50), Math.round(25 * 0.7)); // clamped at the bottom
});

test('the header total rounds to the nearest 30 min above 2 h', async () => {
  const { BREADS, calculate } = await load();
  const b = BREADS.sourdough;
  const calc = calculate('sourdough', { hydration: b.hydration.def, count: b.count.def, size: b.sizeDef });
  assert.ok(calc.totalMin >= 120);
  assert.equal(calc.aboutMin % 30, 0);
  assert.ok(Math.abs(calc.aboutMin - calc.totalMin) <= 15);
});