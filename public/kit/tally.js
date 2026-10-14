// Vote maths, pure. A vote state is { options: [{ id, label, count }], mine },
// mine being the viewer's option id or null.

/** Whole percents that add up to exactly 100 (largest remainder); all 0 with no votes. */
export function percents(counts) {
  const total = counts.reduce((s, n) => s + n, 0);
  if (!total) return counts.map(() => 0);
  const raw = counts.map((n) => (n * 100) / total);
  const out = raw.map(Math.floor);
  let left = 100 - out.reduce((s, n) => s + n, 0);
  const order = raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0; k += 1, left -= 1) out[order[k % order.length][1]] += 1;
  return out;
}

/**
 * Everything a screen shows about a vote state:
 * { options: [{ id, label, count, percent, share, chosen, leading }], total, mine, leaders, tied }
 */
export function tally({ options = [], mine = null } = {}) {
  const counts = options.map((o) => Math.max(0, Math.floor(Number(o.count) || 0)));
  const total = counts.reduce((s, n) => s + n, 0);
  const pct = percents(counts);
  const top = Math.max(0, ...counts);
  const leaders = top > 0 ? options.filter((_, i) => counts[i] === top).map((o) => o.id) : [];
  const chosen = options.some((o) => o.id === mine) ? mine : null;
  return {
    options: options.map((o, i) => ({
      ...o, count: counts[i], percent: pct[i], share: total ? counts[i] / total : 0,
      chosen: o.id === chosen, leading: leaders.includes(o.id),
    })),
    total,
    mine: chosen,
    leaders,
    tied: leaders.length > 1,
  };
}

/** A vote state from raw votes [{ userId, optionId }], seen by viewerId (null for a guest). */
export function fromVotes(options, votes = [], viewerId = null) {
  const own = votes.find((v) => viewerId != null && v.userId === viewerId);
  return {
    options: options.map((o) => ({ ...o, count: votes.filter((v) => v.optionId === o.id).length })),
    mine: own ? own.optionId : null,
  };
}

/** The viewer taps option `id`: it becomes their vote, or, if it already was, the vote is taken back. */
export function applyVote(state, id) {
  const next = state.mine === id ? null : id;
  const options = state.options.map((o) => {
    const count = (Number(o.count) || 0) - (o.id === state.mine ? 1 : 0) + (o.id === next ? 1 : 0);
    return { ...o, count: Math.max(0, count) };
  });
  return { options, mine: next };
}

/** In words: "No votes yet", "1 vote, Yes leads", "6 votes, tied". */
export function voteSummary(state) {
  const t = state && state.leaders ? state : tally(state);
  if (!t.total) return 'No votes yet';
  const n = `${t.total} ${t.total === 1 ? 'vote' : 'votes'}`;
  if (t.tied) return `${n}, tied`;
  const lead = t.options.find((o) => o.leading);
  return `${n}, ${lead.label} leads`;
}
