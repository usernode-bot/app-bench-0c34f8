// Unit tests for the crowd's view, shared with the page via public/crowd.js.
// Run with: npm test
const test = require('node:test');
const assert = require('node:assert');
const { tally, crowdTier, TIERS } = require('../public/crowd.js');

const vote = (username, tier) => ({ user_id: username, username, tier, placed_at: 0 });

test('crowdTier is null with no votes', () => {
  assert.equal(crowdTier([]), null);
  assert.equal(crowdTier(undefined), null);
  assert.equal(crowdTier(null), null);
});

test('crowdTier returns the clear majority', () => {
  // Zuni Café's fixed demo spread: one S, three A, one B, one C.
  const votes = [
    vote('staging-demo-priya', 'S'),
    vote('staging-demo-maya', 'A'),
    vote('staging-demo-devon', 'A'),
    vote('staging-demo-omar', 'A'),
    vote('staging-demo-kai', 'B'),
    vote('staging-demo-lena', 'C'),
  ];
  assert.equal(crowdTier(votes), 'A');
});

test('a two-way tie resolves to the tier nearest the median vote', () => {
  // Votes: A, A, C, C, D. Tied at 2: A (index 1) and C (index 3).
  // The median vote of [1,1,3,3,4] is the middle element, 3 (C), so C is
  // zero steps from the median and A is two: C wins despite the tie.
  const votes = [
    vote('u1', 'A'), vote('u2', 'A'), vote('u3', 'C'),
    vote('u4', 'C'), vote('u5', 'D'),
  ];
  assert.equal(crowdTier(votes), 'C');
});

test('a symmetric tie goes to the higher tier', () => {
  // Votes: A, C. Tied at 1. The median of [1,3] (lower median) is 1, so
  // A (distance 0) beats C (distance 2).
  assert.equal(crowdTier([vote('u1', 'A'), vote('u2', 'C')]), 'A');
});

test('a tie among far-apart tiers picks the closest to the median', () => {
  // Votes: S, S, B, D, D. Tied at 2: S (0) and D (4). The median vote is
  // B (2); S is 2 away, D is 2 away. Still tied, so the higher tier: S.
  const votes = [
    vote('u1', 'S'), vote('u2', 'S'), vote('u3', 'B'),
    vote('u4', 'D'), vote('u5', 'D'),
  ];
  assert.equal(crowdTier(votes), 'S');
});

test('tally counts and groups usernames per tier, S through D', () => {
  const votes = [
    vote('maya', 'S'), vote('devon', 'S'),
    vote('priya', 'B'),
    vote('kai', 'D'),
  ];
  const counts = tally(votes);
  assert.deepEqual(counts.map((c) => c.tier), TIERS);
  assert.deepEqual(counts.map((c) => c.count), [2, 0, 1, 0, 1]);
  assert.deepEqual(counts[0].voters.map((v) => v.username), ['maya', 'devon']);
  assert.deepEqual(counts[2].voters.map((v) => v.username), ['priya']);
  assert.deepEqual(counts[4].voters.map((v) => v.username), ['kai']);
  assert.deepEqual(counts[1].voters, []);
});

test('tally ignores a vote whose tier is not one of S A B C D', () => {
  const votes = [vote('maya', 'A'), vote('rogue', 'Z')];
  const counts = tally(votes);
  assert.equal(counts[1].count, 1);
});