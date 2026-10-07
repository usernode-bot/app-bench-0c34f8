// Unit tests for public/bread.js — the formulas the whole app relies on.
// Runs with `npm test` (node --test test/), no new dependencies.
const test = require('node:test');
const assert = require('node:assert/strict');
const Bread = require('../public/bread.js');

function grams(result, key) {
  const i = result.ingredients.find(x => x.key === key);
  assert.ok(i, 'ingredient ' + key + ' present');
  return i.grams;
}

test('sourdough 2 × 800 g at 75% gives the exact grams', () => {
  const r = Bread.calculate({ bread: 'sourdough', hydration: 75, count: 2, size: 800 });
  assert.equal(r.title, '2 sourdough loaves');
  assert.equal(grams(r, 'flour_bread'), 723);
  assert.equal(grams(r, 'flour_wholewheat'), 90);
  assert.equal(grams(r, 'water'), 588);
  assert.equal(grams(r, 'starter'), 181);
  assert.equal(grams(r, 'salt'), 18);
});

test('bagels 1 × 800 g at 58% gives 7 pieces of 114 g and 9.8 g of salt', () => {
  const r = Bread.calculate({ bread: 'bagels', hydration: 58, count: 1, size: 800 });
  assert.equal(r.title, '7 bagels');
  assert.equal(r.pieces, 7);
  assert.equal(r.pieceGrams, 114);
  assert.equal(r.line, '1 batch of 800 g, divided into 7 pieces of 114 g');
  assert.equal(grams(r, 'flour_bread'), 489);
  assert.equal(grams(r, 'water'), 283);
  assert.equal(grams(r, 'malt'), 15);
  assert.equal(grams(r, 'salt'), 9.8);
  assert.equal(grams(r, 'yeast'), 3.7);
});

test('each bread at its default sums to its dough within 2 g, with rise steps and a bake', () => {
  for (const key of Object.keys(Bread.BREADS)) {
    const def = Bread.BREADS[key].def;
    const r = Bread.calculate({ bread: key, hydration: def, count: 1, size: 800 });
    const sum = r.ingredients.reduce((s, i) => s + i.grams, 0);
    assert.ok(Math.abs(sum - 800) <= 2, key + ' sums to ' + sum);
    assert.ok(r.riseSteps.length >= 3, key + ' has rise steps');
    assert.ok(r.bake && r.bake.steps.length >= 2, key + ' has a bake');
  }
});

test('the adjusting rise step shortens as hydration rises and stays a multiple of 15', () => {
  for (const key of Object.keys(Bread.BREADS)) {
    const def = Bread.BREADS[key].def;
    const base = Bread.calculate({ bread: key, hydration: def, count: 1, size: 800 });
    // 15-minute rounding swallows small shortenings, so compare 15 points
    // apart (every bread's default allows that within the 50–90 slider).
    const wetter = Bread.calculate({ bread: key, hydration: Math.min(90, def + 15), count: 1, size: 800 });
    const step = (r) => r.riseSteps.find(s => s.name === 'Bulk rise' || s.name === 'First rise');
    assert.ok(step(wetter).minutes < step(base).minutes,
      key + ': rise shortens at higher hydration');
    for (const s of [step(base), step(wetter)]) {
      assert.equal(s.minutes % 15, 0, key + ': step is a multiple of 15');
      assert.ok(s.minutes >= 15, key + ': step is never under 15 min');
    }
  }
});

test('wetter dough bakes longer', () => {
  const base = Bread.calculate({ bread: 'sandwich', hydration: 65, count: 1, size: 800 });
  const wet = Bread.calculate({ bread: 'sandwich', hydration: 70, count: 1, size: 800 });
  const total = (r) => r.bake.steps.reduce((s, st) => s + st.minutes, 0);
  assert.equal(total(wet), total(base) + 2);
});

test('toF converts exactly and rounds', () => {
  assert.equal(Bread.toF(250), 482);
  assert.equal(Bread.toF(190), 374);
});

test('validInputs rejects bad input and accepts good input', () => {
  const good = { bread: 'rye', hydration: 78, count: 2, size: 800 };
  assert.equal(Bread.validInputs(good), true);
  assert.equal(Bread.validInputs({ ...good, bread: 'ciabatta' }), false);
  assert.equal(Bread.validInputs({ ...good, size: 500 }), false);
  assert.equal(Bread.validInputs({ ...good, hydration: 95 }), false);
  assert.equal(Bread.validInputs({ ...good, hydration: 75.5 }), false);
  assert.equal(Bread.validInputs({ ...good, count: 0 }), false);
  assert.equal(Bread.validInputs(null), false);
});

test('autoName formats 1000 g as 1 kg', () => {
  assert.equal(Bread.autoName({ bread: 'sourdough', hydration: 75, count: 2, size: 800 }),
    'Sourdough, 2 × 800 g, 75%');
  assert.equal(Bread.autoName({ bread: 'sourdough', hydration: 82, count: 1, size: 1000 }),
    'Sourdough, 1 × 1 kg, 82%');
});

test('formatGrams shows one decimal under 10 g', () => {
  assert.equal(Bread.formatGrams(723.2), '723 g');
  assert.equal(Bread.formatGrams(9.77), '9.8 g');
  assert.equal(Bread.formatGrams(3.66), '3.7 g');
});

test('formatMinutes renders the readout shapes the screen shows', () => {
  assert.equal(Bread.formatMinutes(30), '30 min');
  assert.equal(Bread.formatMinutes(1040), '17 h 20 min');
  assert.equal(Bread.formatMinutes(720), '12 h');
  assert.equal(Bread.formatMinutes(1), '1 min');
});