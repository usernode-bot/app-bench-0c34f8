// The bread maths: totals add up, hydration is what the slider says, the
// spec's two example bakes reproduce exactly, bake times scale, formats match
// the drawn screen.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STYLES, defaultsFor, clampInput, calculate,
  formatGrams, formatDuration, formatTotal, formatOffset,
} from '../public/app/bread.js';

const HYDRATIONS = [50, 58, 72, 90];
const COMBOS = [
  { count: 1, size: 60 }, { count: 2, size: 900 },
  { count: 8, size: 110 }, { count: 12, size: 2000 },
];

test('row grams sum to the total dough weight', () => {
  for (const style of Object.keys(STYLES)) {
    for (const hydration of HYDRATIONS) {
      for (const combo of COMBOS) {
        const input = clampInput({ style, hydration, ...combo });
        const r = calculate(input);
        const sum = r.rows.reduce((a, row) => a + row.grams, 0);
        assert.ok(Math.abs(sum - r.total) <= 2,
          `${style} ${hydration}% ${input.count}x${input.size} g: rows ${sum} vs total ${r.total}`);
        for (const row of r.rows) {
          assert.ok(row.grams >= 0, `${style}: ${row.name} is negative`);
        }
      }
    }
  }
});

// Only the default count and size: the 0.5% tolerance is gram-rounding-safe
// there (every default dough weighs 880 g or more), not on 60 g bagels.
test('the water share follows the hydration slider', () => {
  for (const style of Object.keys(STYLES)) {
    for (const hydration of HYDRATIONS) {
      const r = calculate({ ...defaultsFor(style), hydration });
      const sum = (kind) => r.rows.filter((row) => row.kind === kind)
        .reduce((a, row) => a + row.grams, 0);
      const flour = sum('flour');
      const water = sum('water');
      const starter = sum('starter');
      // A starter is 100% hydration: half flour, half water.
      const ratio = (water + starter / 2) / (flour + starter / 2);
      assert.ok(Math.abs(ratio - hydration / 100) / (hydration / 100) < 0.005,
        `${style} ${hydration}%: water ratio ${(ratio * 100).toFixed(2)}%`);
    }
  }
});

test('the spec example bakes, gram for gram', () => {
  const sour = calculate({ style: 'sourdough', hydration: 72, count: 2, size: 900 });
  assert.deepEqual(sour.rows.map((row) => row.grams), [931, 641, 207, 21]);
  assert.equal(sour.flour, 1034);
  assert.equal(sour.water, 745);
  assert.equal(sour.totalMinutes, 1105);
  assert.equal(formatTotal(sour.totalMinutes), '18 h 25 min');

  const bag = calculate({ style: 'bagels', hydration: 58, count: 8, size: 110 });
  assert.deepEqual(bag.rows.map((row) => row.grams), [533, 309, 21, 11, 5.3]);
  assert.equal(bag.flour, 533);
  assert.equal(bag.water, 309);
  assert.equal(bag.totalMinutes, 843);
  assert.equal(formatTotal(bag.totalMinutes), '14 h');
});

const REF_SIZE = { sourdough: 900, bagels: 110, 'sourdough-bagels': 110, rye: 1000, sandwich: 900 };
const BAKE_BASE = { sourdough: 45, bagels: 18, 'sourdough-bagels': 20, rye: 60, sandwich: 35 };

test('bake time sits at its base for the reference size and only grows', () => {
  for (const [style, base] of Object.entries(BAKE_BASE)) {
    const s = STYLES[style];
    const atRef = calculate({ ...defaultsFor(style), size: REF_SIZE[style] }).bake.minutes;
    assert.equal(atRef, base, `${style} bakes ${atRef} min at its reference size`);
    let prev = 0;
    for (let size = s.sizeMin; size <= s.sizeMax; size += s.sizeStep) {
      const m = calculate({ ...defaultsFor(style), size }).bake.minutes;
      assert.ok(m >= prev, `${style} ${size} g bakes shorter (${m} min) than a smaller one (${prev} min)`);
      prev = m;
    }
  }
});

test('clamping keeps every input inside its limits', () => {
  assert.deepEqual(
    clampInput({ style: 'sourdough', hydration: 120, count: 99, size: 9999 }),
    { style: 'sourdough', hydration: 90, count: 12, size: 2000 });
  assert.deepEqual(
    clampInput({ style: 'bagels', hydration: 10, count: 0, size: 5 }),
    { style: 'bagels', hydration: 50, count: 1, size: 60 });
  assert.deepEqual(defaultsFor('bagels'), { style: 'bagels', hydration: 58, count: 8, size: 110 });
  assert.deepEqual(defaultsFor('rye'), { style: 'rye', hydration: 75, count: 1, size: 1000 });
});

test('the drawn formats', () => {
  assert.equal(formatGrams(5.33), '5.3');
  assert.equal(formatGrams(931.03), '931');
  assert.equal(formatGrams(1034.48), '1,034');
  assert.equal(formatDuration(270), '4 h 30 min');
  assert.equal(formatDuration(60), '1 h');
  assert.equal(formatDuration(45), '45 min');
  assert.equal(formatOffset(1060), '17:40');
  assert.equal(formatOffset(0), '0:00');
  assert.equal(formatTotal(843), '14 h');
  assert.equal(formatTotal(1105), '18 h 25 min');
});