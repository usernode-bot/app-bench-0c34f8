/* The crowd's view, shared by the page (browser global) and the tests and
 * server (CommonJS). The crowd's tier for an item is a simple tally: the
 * tier most people picked, with ties settled toward the middle of all the
 * votes. No weighted scores.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TierCrowd = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var TIERS = ['S', 'A', 'B', 'C', 'D'];
  var TIER_INDEX = { S: 0, A: 1, B: 2, C: 3, D: 4 };

  /* tally(votes) — counts and usernames per tier, S to D.
   * votes: [{ user_id, username, tier, placed_at }].
   * Returns [{ tier, count, voters: [{ user_id, username }] }], voters in
   * placement order, the viewer first only because the caller orders them.
   */
  function tally(votes) {
    var byTier = { S: [], A: [], B: [], C: [], D: [] };
    (votes || []).forEach(function (v) {
      var t = v && v.tier;
      if (t in byTier) byTier[t].push({ user_id: v.user_id, username: v.username });
    });
    return TIERS.map(function (t) {
      return { tier: t, count: byTier[t].length, voters: byTier[t] };
    });
  }

  /* crowdTier(votes) — the tier with the most votes, null with none.
   * Ties: among the tied tiers, the one closest to the median vote (tiers
   * indexed S=0 to D=4; the median of the sorted indices, the lower median
   * on even counts); still tied, the higher tier (the lower index).
   */
  function crowdTier(votes) {
    if (!votes || votes.length === 0) return null;
    var counts = tally(votes);
    var best = -1;
    counts.forEach(function (c) {
      if (c.count > best) best = c.count;
    });
    if (best <= 0) return null;
    var tied = counts.filter(function (c) { return c.count === best; })
      .map(function (c) { return TIER_INDEX[c.tier]; })
      .sort(function (a, b) { return a - b; });
    if (tied.length === 1) return TIERS[tied[0]];

    var indices = votes.map(function (v) { return TIER_INDEX[v.tier]; })
      .filter(function (i) { return i !== undefined; })
      .sort(function (a, b) { return a - b; });
    var median = indices[Math.floor((indices.length - 1) / 2)]; // lower median on even counts

    // The tied tier closest to the median; still tied, the higher tier
    // (the lower index), since `tied` is already sorted ascending.
    var pick = tied[0];
    for (var i = 1; i < tied.length; i++) {
      if (Math.abs(tied[i] - median) < Math.abs(pick - median)) pick = tied[i];
    }
    return TIERS[pick];
  }

  return { TIERS: TIERS, tally: tally, crowdTier: crowdTier };
});