// A comment thread, oldest first, and a composer (Ctrl or Cmd + Enter posts).
// A failed post keeps the text: a 4xx shows under the field, else a toast.
import { h, clear, uid, timeAgo } from './dom.js';
import { toast } from './native.js';

/** The three-dot mark of a More button, in the text colour. */
function dots() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' })) {
    svg.setAttribute(k, v);
  }
  for (const cx of [5, 12, 19]) {
    const circle = document.createElementNS(ns, 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '1.6');
    svg.appendChild(circle);
  }
  return svg;
}

/**
 * renderComments(el, { comments: [{ id, author, body, createdAt }], onAdd, label, placeholder, max, emptyText, onReport })
 * onAdd(text) saves and resolves with the saved comment.
 * onReport(comment, button), when given, puts a 44 px More button on every
 * comment row (report, and anything else a row offers).
 * Returns { add(comment) } for comments that arrive another way.
 */
export function renderComments(el, {
  comments = [], onAdd, label = 'Add a comment', placeholder = '', max = 1000,
  emptyText = 'No comments yet.', postLabel = 'Post comment', onReport,
}) {
  const id = uid('kit-comment');
  const list = h('ul', { class: 'un-group kit-group', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const none = h('p', { class: 'kit-comments-none' }, emptyText);
  const field = h('textarea', { class: 'field', id, name: 'comment', rows: '2', maxlength: String(max), placeholder: placeholder || null });
  const send = h('button', { type: 'submit', class: 'btn-secondary', disabled: true }, postLabel);
  const error = h('p', { class: 'kit-error', role: 'alert', hidden: true });
  const form = h('form', { class: 'kit-composer' },
    h('label', { class: 'kit-label', for: id }, label), field,
    h('div', { class: 'kit-composer-actions' }, send), error);
  let busy = false;

  function row(c) {
    const more = onReport ? h('button', {
      type: 'button', class: 'kit-icon-button', 'aria-label': 'More for this comment',
      on: { click: () => onReport(c, more) },
    }, dots()) : null;
    return h('li', { class: 'un-group-row list-row kit-comment', 'data-id': c.id },
      h('p', { class: 'kit-comment-meta' },
        h('span', { class: 'kit-comment-author' }, c.author || 'Someone'),
        c.createdAt ? h('time', { datetime: new Date(c.createdAt).toISOString() }, timeAgo(c.createdAt)) : null),
      h('p', { class: 'kit-comment-body' }, c.body),
      more);
  }
  function add(c) {
    list.append(row(c));
    list.hidden = false;
    none.hidden = true;
  }

  field.addEventListener('input', () => { send.disabled = busy || !field.value.trim(); });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = field.value.trim();
    if (!text || busy) return;
    busy = true;
    send.disabled = true;
    send.textContent = 'Posting';
    error.hidden = true;
    try {
      const saved = onAdd ? await onAdd(text) : null;
      add(saved && saved.body != null ? saved : { author: 'You', body: text, createdAt: new Date().toISOString() });
      field.value = '';
    } catch (err) {
      if (err && err.status >= 400 && err.status < 500) {
        error.textContent = err.message;
        error.hidden = false;
      } else {
        toast('Your comment was not posted. Try again in a moment.');
      }
    } finally {
      busy = false;
      send.textContent = postLabel;
      send.disabled = !field.value.trim();
      field.focus();
    }
  });

  clear(el).append(list, none, form);
  list.hidden = true;
  for (const c of comments) add(c);
  return { add };
}
