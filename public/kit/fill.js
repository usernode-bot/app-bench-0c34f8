// fill.js: the screens the plan drew, filled with real data instead of
// rebuilt. The platform carries the plan's screens into public/index.html
// before the build starts (screen 1 in place, screen 2 and on as
// <template data-spec-screen="N">), with their styles in public/screens.css.
// Their lists hold sample rows. Keep that markup: take one sample row as the
// row to repeat, drop the samples, and fill each copy by CSS selector.
//
//   import { rowsFrom, fillIn, screen } from '/kit/fill.js';
//
// Everything is set as text or as a checked attribute, never as HTML.

const BLOCKED_ATTR = /^on/i;
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster']);
const SAFE_URL = /^(?:https?:|mailto:|tel:|\/|\.{0,2}\/|#|\?)/i;

function safeUrl(value) {
  const text = String(value).trim();
  // A relative path with no scheme ("posts/3") is safe too.
  return SAFE_URL.test(text) || !/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : null;
}

function setAttr(el, name, value) {
  if (BLOCKED_ATTR.test(name)) throw new Error(`fill.js: set ${name} with on: {}, not as an attribute`);
  if (value === null || value === undefined || value === false) {
    el.removeAttribute(name);
    return;
  }
  const text = value === true ? '' : String(value);
  if (URL_ATTRS.has(name.toLowerCase())) {
    const url = safeUrl(text);
    if (url === null) { el.removeAttribute(name); return; }
    el.setAttribute(name, url);
    return;
  }
  el.setAttribute(name, text);
}

/**
 * Fill `el` (a row, a screen) by selector. Each key is a CSS selector inside
 * it ('' or ':scope' is `el` itself); each value is:
 *   - a string or number: its text (textContent);
 *   - null or undefined: left as drawn;
 *   - a Node: put in place of its children;
 *   - an object of any of:
 *       text      its text
 *       hidden    true hides it, false shows it
 *       class     { name: true|false } adds or removes each class
 *       attr      { name: value } sets each attribute (null or false removes;
 *                 href and src only take http(s), mailto, tel or relative)
 *       on        { event: handler } listens
 *       children  Nodes to put in place of its children
 * Every element a selector matches is filled. A selector that matches
 * nothing is an error, so a renamed class in the markup fails loudly.
 * Returns `el`.
 */
export function fillIn(el, map = {}) {
  for (const [selector, value] of Object.entries(map)) {
    const targets = selector === '' || selector === ':scope' ? [el] : [...el.querySelectorAll(selector)];
    if (!targets.length) throw new Error(`fill.js: nothing matches "${selector}"`);
    for (const t of targets) apply(t, value);
  }
  return el;
}

function apply(t, value) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string' || typeof value === 'number') { t.textContent = String(value); return; }
  if (typeof Node !== 'undefined' && value instanceof Node) { t.replaceChildren(value); return; }
  if (typeof value !== 'object') return;
  if ('text' in value && value.text !== null && value.text !== undefined) t.textContent = String(value.text);
  if ('hidden' in value) t.hidden = !!value.hidden;
  for (const [name, on] of Object.entries(value.class || {})) t.classList.toggle(name, !!on);
  for (const [name, v] of Object.entries(value.attr || {})) setAttr(t, name, v);
  for (const [event, handler] of Object.entries(value.on || {})) t.addEventListener(event, handler);
  if (Array.isArray(value.children)) t.replaceChildren(...value.children);
}

/**
 * A drawn list's row, to repeat: the first child of `listEl` that matches
 * `rowSelector` (its first element child by default) is kept as the row and
 * every sample row is removed. Returns make(), which gives a fresh copy each
 * call. Call it once, before the first render.
 *
 *   const postRow = rowsFrom(document.querySelector('.list'));
 *   list.replaceChildren(...posts.map((p) => fillIn(postRow(), {
 *     '.post-title': p.title,
 *     '.post-time': timeAgo(p.publishedAt),
 *     '': { class: { 'is-read': p.read } },
 *     'button': { on: { click: () => open(p) } },
 *   })));
 */
export function rowsFrom(listEl, rowSelector = null) {
  if (!listEl) throw new Error('fill.js: rowsFrom needs the drawn list');
  const rows = [...listEl.children].filter((c) => (rowSelector ? c.matches(rowSelector) : true));
  if (!rows.length) throw new Error('fill.js: the drawn list has no row to repeat');
  const sample = rows[0].cloneNode(true);
  for (const r of rows) r.remove();
  return () => sample.cloneNode(true);
}

/**
 * A copy of another screen the plan drew (<template data-spec-screen="N">),
 * ready to fill and put where that view belongs. Screen 1 is in the page
 * already. Null when the plan drew no such screen.
 */
export function screen(n, doc = document) {
  const tpl = doc.querySelector(`template[data-spec-screen="${Number(n)}"]`);
  if (!tpl) return null;
  const copy = tpl.content.firstElementChild ? tpl.content.firstElementChild.cloneNode(true) : null;
  return copy;
}

/**
 * The drawn groups of a list split by heading (Today, Yesterday, a date):
 * the first heading and the first list after it are kept as the group to
 * repeat, and every drawn heading and list is removed. Returns
 * make(heading), which gives a fresh { heading, list } pair: the heading
 * filled with `heading` (text, a Node, or a fillIn map) and the list empty,
 * for the rows rowsFrom makes. Take the row with rowsFrom first, then call
 * this, then append each pair where the list renders (createStates' box).
 *
 *   const postRow = rowsFrom(document.querySelector('.list'));
 *   const group = groupsFrom(document.querySelector('.app'), '.section-label', '.list');
 *   for (const [day, posts] of byDay) {
 *     const g = group(day);
 *     g.list.append(...posts.map((p) => fillIn(postRow(), { '.post-title': p.title })));
 *     box.append(g.heading, g.list);
 *   }
 */
export function groupsFrom(container, headingSelector, listSelector) {
  const heading = container && container.querySelector(headingSelector);
  const list = container && container.querySelector(listSelector);
  if (!heading || !list) throw new Error('fill.js: groupsFrom needs a drawn heading and list');
  const h = heading.cloneNode(true);
  const l = list.cloneNode(false);
  for (const el of [...container.querySelectorAll(`${headingSelector}, ${listSelector}`)]) el.remove();
  return (value) => {
    const head = h.cloneNode(true);
    if (isFillMap(value)) fillIn(head, value);
    else apply(head, value);
    return { heading: head, list: l.cloneNode(false) };
  };
}

const APPLY_KEYS = ['text', 'hidden', 'class', 'attr', 'on', 'children'];

/** Whether `value` is a fillIn map (selector keys) rather than one element's value. Pure. */
function isFillMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof Node !== 'undefined' && value instanceof Node) return false;
  return !Object.keys(value).some((k) => APPLY_KEYS.includes(k));
}
