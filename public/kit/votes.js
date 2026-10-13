// Vote buttons: a <button> per option, aria-pressed on the viewer's choice, a
// count and a bar. The tally moves at once; a failed save goes back, with a toast.
import { h, icon, clear } from './dom.js';
import { tally, applyVote, voteSummary } from './tally.js';
import { toast } from './native.js';

/**
 * renderVotes(el, { options: [{ id, label, count }], mine, onVote, label, layout, summary })
 * onVote(id or null) saves; it may resolve the saved { options, mine }.
 * layout: 'stack' or 'row'. Returns { update(state), state() }.
 */
export function renderVotes(el, { options = [], mine = null, onVote, label = 'Vote', layout = 'stack', summary = true }) {
  let state = { options, mine };
  let busy = false;
  const group = h('div', { class: layout === 'row' ? 'kit-votes kit-votes-row' : 'kit-votes', role: 'group', 'aria-label': label });
  const line = summary ? h('p', { class: 'kit-vote-summary', 'aria-live': 'polite' }) : null;
  const buttons = new Map();
  clear(el).append(group, ...(line ? [line] : []));

  function build() {
    clear(group);
    buttons.clear();
    for (const o of state.options) {
      const parts = {
        fill: h('span', { class: 'kit-vote-fill', 'aria-hidden': 'true' }),
        count: h('span', { class: 'kit-vote-count' }),
      };
      const button = h('button', { type: 'button', class: 'kit-vote', 'data-option': o.id, on: { click: () => pick(o.id) } },
        parts.fill,
        h('span', { class: 'kit-vote-mark', 'aria-hidden': 'true' }, icon('check', 'h-4 w-4')),
        h('span', { class: 'kit-vote-label' }, o.label),
        parts.count);
      buttons.set(o.id, { button, ...parts });
      group.append(button);
    }
  }

  function draw() {
    const t = tally(state);
    for (const o of t.options) {
      const b = buttons.get(o.id);
      b.button.setAttribute('aria-pressed', String(o.chosen));
      b.fill.style.width = `${o.percent}%`;
      b.count.replaceChildren(String(o.count), h('span', { class: 'sr-only' }, o.count === 1 ? ' vote' : ' votes'));
    }
    if (line) line.textContent = voteSummary(t);
  }

  async function pick(id) {
    if (busy) return;
    const before = state;
    state = applyVote(state, id);
    busy = true;
    draw();
    try {
      const saved = onVote ? await onVote(state.mine) : null;
      if (saved && Array.isArray(saved.options)) update(saved);
    } catch (err) {
      state = before;
      toast(`Your vote was not saved. ${err && err.status >= 400 && err.status < 500 ? err.message : 'Try again in a moment.'}`);
    } finally {
      busy = false;
      draw();
    }
  }

  function update(next) {
    const same = next.options.length === state.options.length && next.options.every((o, i) => o.id === state.options[i].id);
    state = { options: next.options, mine: next.mine ?? null };
    if (!same) build();
    draw();
  }

  build();
  draw();
  return { update, state: () => tally(state) };
}
