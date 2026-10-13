// Unit tests for the recipe maths, run with `npm test`
// (node --test). These import the browser module straight from public/app/,
// which is why public/app/package.json marks it as an ES module.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BREADS, calculate, validate, defaultsFor, formatGrams, bakeMinutes } from '../public/app/recipe.js';

test('the sourdough example from the spec: 915 / 661 / 203 / 20 and feed 70', () => {
  const r = calculate({ type: 'sourdough', hydration: 75, count: 2, size: 900 });
  const g = (name) => r.ingredients.find((p) => p.name === name).grams;
  assert.equal(g('Bread flour'), 915);
  assert.equal(g('Water'), 661);
  assert.equal(g('Starter'), 203);
  assert.equal(g('Salt'), 20);
  assert.equal(r.feed.starter, 70);
  assert.equal(r.feed.flour, 70);
  assert.equal(r.feed.water, 70);
  assert.equal(r.totalDough, 1800);
  assert.equal(r.summary, '2 sourdough loaves');
});

test('the bagel example from the spec: 558 / 323 / 22 / 11 / 5.6', () => {
  const r = calculate({ type: 'bagels', hydration: 58, count: 8, size: 115 });
  const g = (name) => r.ingredients.find((p) => p.name === name).grams;
  assert.equal(g('Bread flour'), 558);
  assert.equal(g('Water'), 323);
  assert.equal(g('Barley malt syrup'), 22);
  assert.equal(g('Salt'), 11);
  assert.equal(g('Instant yeast'), 5.6);
  assert.equal(r.feed, null);
  assert.equal(r.summary, '8 bagels');
});

test('for every type the displayed parts add up to the total dough, within 2 g', () => {
  for (const type of Object.keys(BREADS)) {
    const d = BREADS[type];
    for (const size of [d.sizeLo, d.size, d.sizeHi]) {
      const r = calculate({ type, hydration: d.hydration.typical, count: d.count, size });
      const drift = Math.abs(r.totalDough - Number(r.totalText.replace(/,/g, '')));
      assert.ok(drift <= 2, `${type} at ${size} g: parts ${r.totalText} vs dough ${r.totalDough}`);
    }
  }
});

test('starter flour and water are subtracted from the flour and water rows', () => {
  const r = calculate({ type: 'sourdough', hydration: 75, count: 2, size: 900 });
  const g = (name) => r.ingredients.find((p) => p.name === name).grams;
  // F is exact in r.totalFlour; the rows are display-rounded, so compare with
  // a small tolerance: flour added 915 = F − Sf; water added 661 = h·F − Sw.
  assert.ok(Math.abs(g('Bread flour') + g('Starter') / 2 - r.totalFlour) < 1, 'flour split');
  assert.ok(Math.abs(g('Water') + g('Starter') / 2 - r.totalWater) < 1, 'water split');
});

test('rye splits its flour 70/30 with the starter flour counted toward rye', () => {
  const r = calculate({ type: 'rye', hydration: 80, count: 1, size: 900 });
  const rye = r.ingredients.find((p) => p.name === 'Rye flour').grams;
  const bread = r.ingredients.find((p) => p.name === 'Bread flour').grams;
  assert.equal(Math.round((rye + 99 / 2) / r.totalFlour * 100), 70);
  assert.equal(Math.round(bread / r.totalFlour * 100), 30);
});

test('defaultsFor always sets the typical hydration, and resets count and size only across the loaf/bagel switch', () => {
  const cur = { hydration: 62, count: 3, size: 1200 };
  // loaf to loaf: hydration changes, count and size stay
  let d = defaultsFor('rye', 'sourdough', cur);
  assert.deepEqual(d, { hydration: 80, count: 3, size: 1200 });
  // loaf to bagel: everything resets
  d = defaultsFor('bagels', 'sourdough', cur);
  assert.deepEqual(d, { hydration: 58, count: 8, size: 115 });
  // bagel to bagel: count and size stay
  d = defaultsFor('sourdough-bagels', 'bagels', cur);
  assert.deepEqual(d, { hydration: 58, count: 3, size: 1200 });
  // no previous type: full defaults
  d = defaultsFor('sourdough', null, cur);
  assert.deepEqual(d, { hydration: 75, count: 1, size: 900 });
});

test('validate rejects 0, 25, blank and out-of-range sizes, and passes good settings', () => {
  assert.deepEqual(Object.keys(validate({ type: 'sourdough', hydration: 75, count: 2, size: 900 })), []);
  assert.ok(validate({ type: 'sourdough', hydration: 25, count: 2, size: 900 }).hydration);
  assert.ok(validate({ type: 'sourdough', hydration: 101, count: 2, size: 900 }).hydration);
  assert.ok(validate({ type: 'sourdough', hydration: 75, count: 0, size: 900 }).count);
  assert.ok(validate({ type: 'sourdough', hydration: 75, count: 25, size: 900 }).count);
  assert.ok(validate({ type: 'sourdough', hydration: 75, count: 2, size: 20 }).size);
  assert.ok(validate({ type: 'sourdough', hydration: 75, count: 2, size: '' }).size);
  // 62.5% is not an integer
  assert.ok(validate({ type: 'sourdough', hydration: 62.5, count: 2, size: 900 }).hydration);
  assert.equal(validate({ type: 'sourdough', hydration: 75, count: 2, size: 20 }).size, 'Enter 300 to 2,000 g');
});

test('bakeMinutes adjusts at 1,200 g and 600 g for loaves, 150 g and 90 g for bagels', () => {
  assert.equal(bakeMinutes('loaf', 1200), 5);
  assert.equal(bakeMinutes('loaf', 900), 0);
  assert.equal(bakeMinutes('loaf', 600), -5);
  assert.equal(bakeMinutes('bagel', 150), 3);
  assert.equal(bakeMinutes('bagel', 115), 0);
  assert.equal(bakeMinutes('bagel', 90), -3);
});

test('bake times shift with loaf size and ranges stay ranges', () => {
  const big = calculate({ type: 'sourdough', hydration: 75, count: 1, size: 1200 });
  assert.equal(big.bake.stages[1].label, 'Lid off, 25 to 30 min');
  const small = calculate({ type: 'sourdough', hydration: 75, count: 1, size: 600 });
  assert.equal(small.bake.stages[1].label, 'Lid off, 15 to 20 min');
  const mid = calculate({ type: 'sourdough', hydration: 75, count: 1, size: 900 });
  assert.equal(mid.bake.stages[1].label, 'Lid off, 20 to 25 min');
  const bagel = calculate({ type: 'bagels', hydration: 58, count: 8, size: 60 });
  assert.equal(bagel.bake.stages[0].label, '15 to 19 min');
});

test('formatGrams uses thousands separators and one decimal where asked', () => {
  assert.equal(formatGrams(1016.9), '1,017');
  assert.equal(formatGrams(915), '915');
  assert.equal(formatGrams(5.576, 1), '5.6');
});

test('two-stage bakes show both stages; sandwich loaf gets its extras', () => {
  const r = calculate({ type: 'sandwich', hydration: 65, count: 1, size: 900 });
  const names = r.ingredients.map((p) => p.name);
  for (const n of ['Instant yeast', 'Sugar', 'Butter', 'Water or milk']) assert.ok(names.includes(n), n);
  const rye = calculate({ type: 'rye', hydration: 80, count: 1, size: 900 });
  assert.equal(rye.bake.stages.length, 2);
  const sd = calculate({ type: 'sourdough', hydration: 75, count: 1, size: 900 });
  assert.equal(sd.bake.stages.length, 2);
});