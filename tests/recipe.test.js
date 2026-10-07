'use strict';

// The pure recipe maths in public/app.js, run with:
//   node --test tests/recipe.test.js

const test = require('node:test');
const assert = require('node:assert');
const { BREAD_TYPES, computeRecipe, stageWidths } = require('../public/app.js');

const sumRows = (rows) => rows.reduce((sum, row) => sum + row[1], 0);

test('worked example: sourdough, 70%, 2 loaves × 800 g', () => {
  const recipe = computeRecipe('sourdough', 70, 2, 800);
  assert.equal(recipe.error, undefined);
  assert.equal(recipe.dough, 1600);
  assert.deepEqual(
    Object.fromEntries(recipe.rows),
    { Flour: 837, 'Starter flour': 93, Water: 558, 'Starter water': 93, Salt: 19 },
  );
  assert.equal(sumRows(recipe.rows), 1600);
});

test('every type sums to the dough weight at 55% and 90% hydration', () => {
  for (const typeId of Object.keys(BREAD_TYPES)) {
    for (const hydration of [55, 90]) {
      for (const [loaves, loafSize] of [[1, 500], [3, 1200]]) {
        const recipe = computeRecipe(typeId, hydration, loaves, loafSize);
        assert.equal(recipe.error, undefined, typeId + ' at ' + hydration + '%');
        assert.ok(
          Math.abs(sumRows(recipe.rows) - recipe.dough) <= 2,
          typeId + ' at ' + hydration + '%: rows sum to the dough weight (±2 g rounding)',
        );
      }
    }
  }
});

test('sourdough water row stays positive even at 55% hydration', () => {
  for (const typeId of ['sourdough', 'sourdough-bagels']) {
    const recipe = computeRecipe(typeId, 55, 1, 500);
    const water = recipe.rows.find((row) => row[0] === 'Water')[1];
    assert.ok(water > 0, typeId + ' water row is ' + water + ' g');
  }
});

test('rejects loaves of 0 and loaf sizes of 50 g', () => {
  assert.ok(computeRecipe('rye', 70, 0, 800).error, 'zero loaves');
  assert.ok(computeRecipe('rye', 70, 13, 800).error, 'thirteen loaves');
  assert.ok(computeRecipe('rye', 70, 2.5, 800).error, 'half a loaf');
  assert.ok(computeRecipe('rye', 70, 2, 50).error, '50 g loaf');
  assert.ok(computeRecipe('rye', 70, 2, 3001).error, '3001 g loaf');
  assert.equal(computeRecipe('rye', 70, 12, 3000).error, undefined, 'edges of both ranges pass');
});

test('timeline widths stay within 6%–100% and cover every stage', () => {
  for (const typeId of Object.keys(BREAD_TYPES)) {
    const widths = stageWidths(BREAD_TYPES[typeId].stages);
    assert.equal(widths.length, BREAD_TYPES[typeId].stages.length);
    for (const width of widths) {
      assert.ok(width >= 6 && width <= 100, typeId + ' width ' + width);
    }
  }
});
