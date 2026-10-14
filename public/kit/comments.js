// A comment thread, oldest first, and a composer (Ctrl or Cmd + Enter posts).
// A failed post keeps the text: a 4xx shows under the field, else a toast.
import { h, icon, clear, uid, timeAgo } from './dom.js';
import { toast } from './native.js';

/**
 * renderComments(el, { comments: [{ id, author, body, createdAt }], onAdd, menu(comment, anchorEl),
 * label, placeholder, max, emptyText, postLabel })
 * onAdd(text) saves and resolves with the saved comment; leave it off for a
 * read-only thread (no composer). menu(comment, anchorEl) opens the row's
 * More menu; without it rows carry no button.
 * Returns { add(comment), remove(id) } for comments that arrive or leave
 * another way.
 */
export function renderComments(el, {
  comments = [], onAdd, menu, label = 'Add a comment', placeholder = '', max = 1000,
  emptyText = 'No comments yet.', postLabel = 'Post comment',
}) {
  const list = h('ul', { class: 'un-group kit-group', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const none = h('p', { class: 'kit-comments-none' }, emptyText);
  const parts = [list, none];

  if (onAdd) {
    const id = uid('kit-comment');
    const field = h('textarea', { class: 'field', id, name: 'comment', rows: '2', maxlength: String(max), placeholder: placeholder || null });
    const send = h('button', { type: 'submit', class: 'btn-secondary', disabled: true }, postLabel);
    const error = h('p', { class: 'kit-error', role: 'alert', hidden: true });
    const form = h('form', { class: 'kit-composer' },
      h('label', { class: 'kit-label', for: id }, label), field,
      h('div', { class: 'kit-composer-actions' }, send), error);
    let busy = false;

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

    parts.push(form);
  }

  function row(c) {
    const main = h('div', { class: 'kit-comment min-w-0 flex-1' },
      h('p', { class: 'kit-comment-meta' },
        h('span', { class: 'kit-comment-author' }, c.author || 'Someone'),
        c.createdAt ? h('time', { datetime: new Date(c.createdAt).toISOString() }, timeAgo(c.createdAt)) : null),
      h('p', { class: 'kit-comment-body' }, c.body));
    const more = menu ? h('button', { type: 'button', class: 'kit-icon-button', 'aria-label': 'More', on: { click: () => menu(c, more) } }, icon('more')) : null;
    return h('li', { class: 'un-group-row list-row', 'data-id': c.id }, main, more);
  }
  function add(c) {
    list.append(row(c));
    list.hidden = false;
    none.hidden = true;
  }
  function remove(id) {
    for (const li of list.querySelectorAll(`li[data-id="${CSS.escape(String(id))}"]`)) li.remove();
    if (!list.children.length) {
      list.hidden = true;
      none.hidden = false;
    }
  }

  clear(el).append(...parts);
  list.hidden = true;
  for (const c of comments) add(c);
  return { add, remove };
}
