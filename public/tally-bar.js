// The tally bar, Club Votes' signature element: one rounded track, one
// segment per option with votes (flex-grow by count, thin gaps between), and
// a key line of dot + count underneath that always lists all three options.
// No votes at all draws the empty dashed track and says "No votes yet".
// Colours come from the for/against/abstain tokens. The list rows use the
// 10 px track; the detail screen passes { size: 'lg' } for .tally-lg.
import { h, clear } from './kit/dom.js';

// Segments and dots are chosen by the option's position in the resource's
// fixed option order: For, Against, Abstain. These are whole literals so the
// Tailwind compiler sees them.
const SEGMENTS = ['tally-for', 'tally-against', 'tally-abstain'];
const DOTS = ['tally-dot-for', 'tally-dot-against', 'tally-dot-abstain'];

/**
 * tallyParts(options): the pure half. Options with votes, in For/Against/
 * Abstain order, as { id, label, count, cls }, and the total. Zero-count
 * options take no segment (an empty option is no slice of the bar).
 */
export function tallyParts(options = []) {
  const segments = (Array.isArray(options) ? options : [])
    .map((o, i) => ({
      id: o.id,
      label: String(o.label),
      count: Math.max(0, Math.floor(Number(o.count) || 0)),
      cls: SEGMENTS[i % SEGMENTS.length],
    }))
    .filter((s) => s.count > 0);
  return { segments, total: segments.reduce((sum, s) => sum + s.count, 0) };
}

/**
 * renderTallyBar(el, options, { size }): clears el and draws the bar and its
 * key line. size 'lg' is the detail screen's taller track. Returns the bar.
 * The bar is role="img" with the counts in words, so the picture itself is
 * what screen readers read.
 */
export function renderTallyBar(el, options = [], { size = 'sm' } = {}) {
  const all = Array.isArray(options) ? options : [];
  const { segments, total } = tallyParts(all);
  const bar = h('div', { class: size === 'lg' ? 'tally tally-lg' : 'tally', role: 'img',
    'aria-label': total ? segments.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(', ') : 'No votes yet' });
  for (const s of segments) {
    const seg = h('span', { class: `tally-seg ${s.cls}`, style: `flex-grow:${s.count}` });
    bar.append(seg);
  }
  if (!total) bar.classList.add('tally-none');

  const key = h('div', { class: 'tally-key' });
  if (total) {
    all.forEach((o, i) => key.append(
      h('span', { class: 'inline-flex items-center gap-1.5' },
        h('i', { class: DOTS[i % DOTS.length], 'aria-hidden': 'true' }),
        `${Math.max(0, Math.floor(Number(o.count) || 0))} ${String(o.label).toLowerCase()}`)));
  } else {
    key.append('No votes yet');
  }
  clear(el).append(bar, key);
  return bar;
}