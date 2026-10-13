import test from 'node:test';
import assert from 'node:assert/strict';
import { BREADS, KIND_ORDER, calculate } from '../public/recipes.js';

const gramsOf = (res, key) => {
  const ing = res.ingredients.find((i) => i.key === key);
  assert.ok(ing, `no ingredient ${key}`);
  return ing.grams;
};

test('sourdough example: 75%, two 900 g loaves', () => {
  const res = calculate('sourdough', 75, 2, 900);
  assert.equal(gramsOf(res, 'flour'), 915);
  assert.equal(gramsOf(res, 'water'), 661);
  assert.equal(gramsOf(res, 'starter'), 203);
  assert.equal(gramsOf(res, 'salt'), 20);
  assert.equal(res.totalDough, 1800);
  const sum = res.ingredients.reduce((s, i) => s + i.grams, 0);
  assert.ok(Math.abs(sum - 1800) <= 2, `ingredients sum to ${sum}, not 1800`);
  assert.equal(res.bake.temp, '250 °C');
  assert.match(res.bake.note, /one loaf at a time/);
});

test('every kind: ingredients add up to the total dough', () => {
  for (const kind of KIND_ORDER) {
    const b = BREADS[kind];
    const res = calculate(kind, b.hydration, b.count.def, b.size.def);
    assert.equal(res.error, undefined, `${kind} errored`);
    const sum = res.ingredients.reduce((s, i) => s + i.grams, 0);
    assert.ok(Math.abs(sum - res.totalDough) <= 2, `${kind}: ${sum} vs ${res.totalDough}`);
  }
});

test('true hydration (starter counted) matches the dial', () => {
  for (const kind of KIND_ORDER) {
    const b = BREADS[kind];
    const res = calculate(kind, b.hydration, b.count.def, b.size.def);
    const starter = b.starter ? gramsOf(res, 'starter') / 2 : 0;
    const water = gramsOf(res, 'water') + starter;
    const flour = res.ingredients.filter((i) => i.tone === 'flour').reduce((s, i) => s + i.grams, 0) + starter;
    const actual = water / flour;
    assert.ok(Math.abs(actual - b.hydration / 100) < 0.005, `${kind}: hydration ${actual}, wanted ${b.hydration / 100}`);
  }
});

test('rye shows two flours and the starter comes off the rye', () => {
  const res = calculate('rye', 80, 1, 900);
  const rye = gramsOf(res, 'ryeFlour');
  const bread = gramsOf(res, 'flour');
  const starter = gramsOf(res, 'starter') / 2;
  const share = (rye + starter) / (rye + starter + bread);
  assert.ok(Math.abs(share - 0.7) < 0.005, `rye share ${share}, wanted 0.7`);
  assert.equal(res.ingredients.filter((i) => i.tone === 'flour').length, 2);
});

test('a size outside 50 to 3000 g is an error, not a recipe', () => {
  for (const size of [0, 49, 3001, NaN, '', 'abc', Infinity]) {
    assert.deepEqual(calculate('sourdough', 75, 1, size), { error: 'size' });
  }
});

test('hydration and count clamp into range', () => {
  const low = calculate('sourdough', 40, 0, 900);
  assert.equal(low.settings.hydration, 60);
  assert.equal(low.settings.count, 1);
  const high = calculate('sourdough', 99, 99, 900);
  assert.equal(high.settings.hydration, 90);
  assert.equal(high.settings.count, 12);
});

test('bagels scale with count', () => {
  const res = calculate('bagels', 60, 8, 115);
  assert.equal(res.totalDough, 920);
  const res24 = calculate('bagels', 60, 24, 115);
  assert.equal(res24.totalDough, 920 * 3);
  assert.equal(res24.ingredients.find((i) => i.key === 'malt').grams,
               res.ingredients.find((i) => i.key === 'malt').grams * 3);
});