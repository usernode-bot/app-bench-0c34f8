// Tests for public/bread.js — the bread maths, run with `node --test test/`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BREADS, KIND_ORDER, calculate, clampSettings, validate, bakeMinutes,
  cToF, roundToTotal, zoneOf, gaugeNote,
} from '../public/bread.js';

const settings = (kind, overrides = {}) => ({ kind, ...BREADS[kind].defaults, ...overrides });
const gramsOf = (r) => Object.fromEntries(r.ingredients.map((i) => [i.key, i.grams]));
const sumOf = (r) => r.ingredients.reduce((s, i) => s + i.grams, 0);

test('worked example: sourdough 75%, 2 loaves of 900 g', () => {
  const r = calculate(settings('sourdough', { count: 2, size: 900 }));
  const g = gramsOf(r);
  assert.equal(r.total, 1800);
  assert.equal(g.flour, 915);
  assert.equal(g.water, 661);
  assert.equal(g.starter, 204);
  assert.equal(g.salt, 20);
  assert.equal(sumOf(r), 1800);
});

test('worked example: bagels 58%, 8 bagels of 110 g', () => {
  const r = calculate(settings('bagels'));
  const g = gramsOf(r);
  assert.equal(r.total, 880);
  assert.equal(g.flour, 534);
  assert.equal(g.water, 309);
  assert.equal(g.yeast, 5);
  assert.equal(g.salt, 11);
  assert.equal(g.malt, 21);
  assert.equal(sumOf(r), 880);
});

test('every kind at its limits: whole grams summing exactly to count × size', () => {
  for (const kind of KIND_ORDER) {
    const hi = BREADS[kind].ranges;
    const cases = [
      {},
      { count: hi.count[0], size: hi.size[0] },
      { count: hi.count[1], size: hi.size[1] },
      { hydration: hi.hydration[0] },
      { hydration: hi.hydration[1] },
    ];
    for (const overrides of cases) {
      const s = settings(kind, overrides);
      const r = calculate(s);
      assert.equal(sumOf(r), s.count * s.size, `${kind} ${JSON.stringify(overrides)}`);
      for (const ing of r.ingredients) {
        assert.ok(Number.isInteger(ing.grams) && ing.grams >= 0, `${kind}: ${ing.key}`);
      }
    }
  }
});

test('hydration reflects total water over total flour, starter included', () => {
  for (const kind of KIND_ORDER) {
    for (const hydration of [55, 68, 82]) {
      const s = settings(kind, { hydration });
      const g = gramsOf(calculate(s));
      const T = (g.flour || 0) + (g.rye || 0) + (g.starter || 0) / 2;
      const W = (g.water || 0) + (g.starter || 0) / 2;
      const h = (W / T) * 100;
      assert.ok(Math.abs(h - hydration) < 1.5, `${kind} at ${hydration}%: got ${h.toFixed(1)}%`);
    }
  }
});

test('rye splits the flour 60/40', () => {
  const g = gramsOf(calculate(settings('rye')));
  assert.ok(Math.abs(g.rye / g.flour - 1.5) < 0.05, `rye ${g.rye} vs bread ${g.flour}`);
});

test('clampSettings rounds and clamps to the kind limits', () => {
  assert.deepEqual(
    clampSettings({ kind: 'sourdough', hydration: 120, count: 99, size: 9 }),
    { kind: 'sourdough', hydration: 90, count: 12, size: 300 },
  );
  assert.deepEqual(
    clampSettings({ kind: 'bagels', hydration: 58.4, count: 8.5, size: 110.5 }),
    { kind: 'bagels', hydration: 58, count: 9, size: 111 },
  );
});

test('validate rejects out-of-range, empty and non-integer values', () => {
  assert.deepEqual(validate(settings('sourdough')), { hydration: null, count: null, size: null });
  const bad = validate({ kind: 'sourdough', hydration: 95, count: 0, size: 250 });
  assert.ok(bad.hydration && bad.count && bad.size);
  assert.ok(validate({ kind: 'sourdough', hydration: NaN, count: 1, size: 900 }).hydration);
  assert.ok(validate({ kind: 'sourdough', hydration: 75, count: 2.5, size: 900 }).count);
  assert.ok(validate({ kind: 'rye', hydration: 75, count: 1, size: 2500 }).size);
});

test('bakeMinutes scales with dough size and holds its minimum', () => {
  assert.equal(bakeMinutes('sourdough', 900), 25);
  assert.ok(bakeMinutes('sourdough', 2000) > bakeMinutes('sourdough', 900));
  assert.ok(bakeMinutes('sourdough', 300) < bakeMinutes('sourdough', 900));
  assert.ok(bakeMinutes('bagels', 60) >= 10);
  assert.equal(bakeMinutes('bagels', 110), 18);
  // A default size gives the base times the schedule was written for.
  for (const kind of KIND_ORDER) {
    const bake = BREADS[kind].bake;
    assert.equal(bakeMinutes(kind, bake.defaultSize), bake.lastBase, kind);
  }
});

test('a bigger bake gets a longer bake time', () => {
  const small = calculate(settings('sandwich', { size: 400 }));
  const big = calculate(settings('sandwich', { size: 1500 }));
  assert.ok(big.bake.minutes > small.bake.minutes);
  assert.equal(small.bake.minutes, 25);
  assert.equal(big.bake.minutes, 45);
});

test('cToF rounds to the nearest 5 °F', () => {
  assert.equal(cToF(250), 480);
  assert.equal(cToF(230), 445);
  assert.equal(cToF(190), 375);
  assert.equal(cToF(240), 465);
});

test('"Bake one loaf at a time" only shows for several loaves', () => {
  assert.equal(calculate(settings('sourdough', { count: 1 })).bake.oneAtATime, null);
  assert.ok(calculate(settings('sourdough', { count: 2 })).bake.oneAtATime);
});

test('roundToTotal sums to the total', () => {
  const parts = [
    { key: 'a', value: 10.4 }, { key: 'b', value: 10.4 }, { key: 'c', value: 9.2 },
  ];
  const out = roundToTotal(parts, 30);
  assert.equal(out.a + out.b + out.c, 30);
  for (const k of ['a', 'b', 'c']) assert.ok(Number.isInteger(out[k]));
});

test('zoneOf draws the gauge zones', () => {
  assert.equal(zoneOf(61), 'stiff');
  assert.equal(zoneOf(62), 'soft');
  assert.equal(zoneOf(75), 'soft');
  assert.equal(zoneOf(76), 'slack');
});

test('gaugeNote names the typical range', () => {
  const note = gaugeNote('sourdough', 75);
  assert.match(note, /Typical for sourdough: 70 to 80%/);
  assert.match(gaugeNote('sourdough', 60), /Stiffer than usual/);
  assert.match(gaugeNote('sourdough', 85), /Wetter than usual/);
  assert.match(gaugeNote('sourdough', 75), /open, airy crumb/);
});