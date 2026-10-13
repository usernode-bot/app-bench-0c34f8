// A list of items, each row one big tap target, drawn as the native UI kit's
// inset-grouped list (un-group), and the detail screen an item opens to.
import { h, icon, clear } from './dom.js';

/**
 * renderList(el, items, { title, subtitle, meta, onOpen, label })
 * title(item), subtitle(item) and meta(item) return text, an element or null.
 * With onOpen(item, rowButton) every row is a button; without it rows are plain.
 */
export function renderList(el, items, { title = (item) => item.title, subtitle = () => null, meta = () => null, onOpen, label } = {}) {
  const list = h('ul', { class: 'un-group kit-group', 'aria-label': label || null });
  for (const item of items) {
    const sub = subtitle(item);
    const side = meta(item);
    const inner = [
      h('span', { class: 'kit-row-text' },
        h('span', { class: 'kit-row-title' }, title(item)),
        sub == null || sub === '' ? null : h('span', { class: 'kit-row-sub' }, sub)),
      side == null || side === '' ? null : h('span', { class: 'kit-row-meta' }, side),
    ];
    let row;
    if (onOpen) {
      row = h('button', { type: 'button', class: 'list-row kit-row', on: { click: () => onOpen(item, row) } },
        inner, icon('chevron', 'kit-row-chevron'));
    } else {
      row = h('div', { class: 'list-row' }, inner);
    }
    list.append(h('li', { class: 'un-group-row', 'data-id': item.id }, row));
  }
  clear(el).append(list);
  return list;
}

/** renderDetail(el, { title, meta, body, onBack, backLabel }) gives { section(label) (a part below to render into), focus() }. */
export function renderDetail(el, { title, meta, body, onBack, backLabel = 'Back' }) {
  const heading = h('h2', { class: 'text-title kit-detail-title', tabindex: '-1' }, title);
  const article = h('article', { class: 'kit-detail' },
    h('header', { class: 'kit-detail-head' },
      onBack ? h('button', { type: 'button', class: 'btn-secondary', on: { click: onBack } }, icon('back'), backLabel) : null,
      heading,
      meta ? h('p', { class: 'text-small text-muted' }, meta) : null,
      body ? h('p', { class: 'kit-detail-body' }, body) : null));
  clear(el).append(article);
  return {
    section(label) {
      const box = h('div');
      article.append(h('section', { class: 'kit-section' }, label ? h('h3', { class: 'section-label' }, label) : null, box));
      return box;
    },
    // Waits a frame, so it also works from inside createStates' run(), whose
    // content is still hidden until the task returns.
    focus: () => requestAnimationFrame(() => heading.focus()),
  };
}
