// Unit tests for the tally bar's pure half, public/tally-bar.js.
// Runs with `npm test` (node --test) — no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tallyParts } from '../public/tally-bar.js';

const clubOptions = [
  { id: 0, label: 'For', count: 6 },
  { id: 1, label: 'Against', count: 4 },
  { id: 2, label: 'Abstain', count: 1 },
];

test('segments keep the For, Against, Abstain order with their classes', () => {
  const { segments, total } = tallyParts(clubOptions);
  assert.deepEqual(
    segments.map((s) => [s.label, s.count, s.cls]),
    [
      ['For', 6, 'tally-for'],
      ['Against', 4, 'tally-against'],
      ['Abstain', 1, 'tally-abstain'],
    ]);
  assert.equal(total, 11);
});

test('an option with no votes takes no segment', () => {
  const { segments, total } = tallyParts([
    { id: 0, label: 'For', count: 7 },
    { id: 1, label: 'Against', count: 0 },
    { id: 2, label: 'Abstain', count: 3 },
  ]);
  assert.deepEqual(segments.map((s) => s.label), ['For', 'Abstain']);
  assert.equal(total, 10);
});

test('no votes at all: no segments and a total of 0 (the dashed track)', () => {
  const { segments, total } = tallyParts(clubOptions.map((o) => ({ ...o, count: 0 })));
  assert.deepEqual(segments, []);
  assert.equal(total, 0);
});

test('counts that are not whole numbers are floored to whole votes', () => {
  const { segments } = tallyParts([{ id: 0, label: 'For', count: 2.9 }]);
  assert.equal(segments[0].count, 2);
  const { segments: none, total } = tallyParts([{ id: 0, label: 'For', count: 'x' }]);
  assert.deepEqual(none, []);
  assert.equal(total, 0);
});