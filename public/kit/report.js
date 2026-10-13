// A report: per option or category, its count in words, its percent and a bar.
import { h, clear, plural } from './dom.js';
import { percents } from './tally.js';

/** countBy(items, key) gives [{ label, count }], most first (ties keep first-seen order). key: a field name or item => label. Pure. */
export function countBy(items, key) {
  const pick = typeof key === 'function' ? key : (item) => item[key];
  const counts = new Map();
  for (const item of items) {
    const label = pick(item);
    if (label == null || label === '') continue;
    counts.set(String(label), (counts.get(String(label)) || 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

/**
 * renderReport(el, rows, { label, unit, total })
 * rows: [{ label, count }]. unit: ['vote', 'votes'] names what is counted.
 * total: false hides the "12 votes in all" line.
 */
export function renderReport(el, rows, { label = null, unit = ['item', 'items'], total = true } = {}) {
  const sum = rows.reduce((s, r) => s + r.count, 0);
  const pct = percents(rows.map((r) => r.count));
  const list = h('ul', { class: 'kit-report', 'aria-label': label });
  rows.forEach((r, i) => {
    const fill = h('span', { class: 'kit-bar-fill' });
    fill.style.width = `${pct[i]}%`;
    list.append(h('li', { class: 'kit-report-row' },
      h('p', { class: 'kit-report-line' },
        h('span', { class: 'kit-report-label' }, r.label),
        h('span', { class: 'kit-report-count' }, `${plural(r.count, unit[0], unit[1])}, ${pct[i]}%`)),
      h('span', { class: 'kit-bar', 'aria-hidden': 'true' }, fill)));
  });
  clear(el).append(list);
  if (total) el.append(h('p', { class: 'kit-report-total' }, `${plural(sum, unit[0], unit[1])} in all`));
  return list;
}
