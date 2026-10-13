// Loading (skeleton), empty (the load found nothing), error (it failed, with
// Try again) and content: exactly one shows, starting on the skeleton.
import { h, clear } from './dom.js';

/**
 * createStates(el, { rows, empty: { title, text, action: { label, onClick, primary } }, error: { title, text } })
 * gives { content, run(task), loading(), empty(), error(), ready() }. task(content)
 * renders and returns false for empty; a throw shows the error, whose Try again reruns it.
 */
export function createStates(el, { rows = 4, skeleton, empty = {}, error = {} } = {}) {
  let last = null;
  const skeletonEl = skeleton ? skeleton() : h('div', { 'aria-busy': 'true' },
    h('p', { class: 'sr-only', role: 'status' }, 'Loading'),
    h('ul', { class: 'un-group kit-group', 'aria-hidden': 'true' },
      Array.from({ length: rows }, (_, i) => h('li', { class: 'un-group-row kit-skeleton-row' },
        h('span', { class: i % 2 ? 'skeleton h-4 w-1/2' : 'skeleton h-4 w-3/4' }),
        h('span', { class: 'skeleton h-3 w-1/3' })))));
  const action = empty.action;
  const emptyEl = h('div', { class: 'state-empty' },
    h('h2', { class: 'text-heading' }, empty.title || 'Nothing here yet'),
    empty.text ? h('p', { class: 'text-body text-muted' }, empty.text) : null,
    action ? h('button', { type: 'button', class: action.primary ? 'btn-primary mt-2' : 'btn-secondary mt-2', on: { click: action.onClick } }, action.label) : null);
  const errorEl = h('div', { class: 'state-error', role: 'alert' },
    h('h2', { class: 'text-heading' }, error.title || 'This did not load'),
    h('p', { class: 'text-body text-muted' }, error.text || 'Something went wrong on our side. Nothing you saved is lost.'),
    h('button', { type: 'button', class: 'btn-secondary mt-2', on: { click: () => (last ? run(last) : null) } }, 'Try again'));
  const content = h('div', { class: 'kit-content' });
  const parts = { loading: skeletonEl, empty: emptyEl, error: errorEl, ready: content };
  clear(el).append(skeletonEl, emptyEl, errorEl, content);

  function show(which) {
    for (const [name, node] of Object.entries(parts)) node.hidden = name !== which;
    el.dataset.state = which;
  }
  async function run(task) {
    last = task;
    show('loading');
    try {
      const found = await task(content);
      show(found === false ? 'empty' : 'ready');
    } catch (err) {
      console.warn('Load failed:', err && err.message);
      show('error');
    }
  }
  show('loading');
  return {
    content, run,
    loading: () => show('loading'), empty: () => show('empty'), error: () => show('error'), ready: () => show('ready'),
  };
}
