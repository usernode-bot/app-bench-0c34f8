// Shared helpers: elements (text is always text, never HTML), API calls, times in words.
// Importing any kit module also starts loading the native UI kit (native.js).
import './native.js';

/**
 * h('p', { class: 'text-small', on: { click }, hidden: true }, 'Hi ', node)
 * Strings become text nodes, so "<b>" shows as "<b>". null or false leaves an
 * attribute off; true sets it empty.
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'on') for (const [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
    else if (key === 'hidden') el.hidden = true;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  return append(el, children);
}

/** Append children: nodes as they are, anything else as text. */
export function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child == null || child === false) continue;
    el.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

let counter = 0;
/** A page-unique id, for label/for and aria pairs. */
export function uid(prefix = 'kit') {
  counter += 1;
  return `${prefix}-${counter}`;
}

const ICONS = {
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevron: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};

/** A line icon drawn in the text colour: check, chevron, back, close, plus, more. */
export function icon(name, cls = 'h-5 w-5') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const attrs = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: cls };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.appendChild(path);
  return svg;
}

const params = () => new URLSearchParams(globalThis.location ? globalThis.location.search : '');

/** Whether the page was opened with ?demo=1 (api() passes it on). */
export const isDemo = () => params().get('demo') === '1';

/** "Now": usernode.now() when the bridge has it (a preview can be set to a moment), else the clock. */
export function now() {
  const u = globalThis.usernode;
  return u && typeof u.now === 'function' ? u.now() : new Date();
}

/** api('POST', '/api/items', { title }): sends the token, the preview's "now" and ?demo=1; throws an Error fit to show. */
export async function api(method, path, body) {
  const q = params();
  const url = new URL(path, globalThis.location.href);
  if (q.get('demo') === '1') url.searchParams.set('demo', '1');
  const headers = { 'x-usernode-token': q.get('token') || '' };
  const u = globalThis.usernode;
  if (u && u.previewNow && typeof u.now === 'function') headers['x-usernode-now'] = u.now().toISOString();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('No connection. Check it and try again.'), { status: 0 });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error === 'account_required' ? 'Make an account to join in.'
      : res.status >= 500 || typeof data.error !== 'string' ? `That did not work (error ${res.status}). Try again in a moment.`
      : data.error;
    throw Object.assign(new Error(message), { status: res.status, data });
  }
  return data;
}

/** "1 vote", "3 votes". */
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "just now", "5 minutes ago", "3 hours ago", "yesterday", "4 days ago", else a short date. */
export function timeAgo(when, at = now()) {
  const t = new Date(when).getTime();
  const n = new Date(at).getTime();
  if (!Number.isFinite(t)) return '';
  const minutes = Math.floor(Math.max(0, n - t) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${plural(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, 'hour')} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const date = new Date(t);
  const year = date.getFullYear() !== new Date(n).getFullYear() ? { year: 'numeric' } : {};
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...year });
}
