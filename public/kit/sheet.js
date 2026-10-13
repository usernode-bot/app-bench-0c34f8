// A sheet: unNative.presentSheet below 640 px, presentModal from 640 px, or
// the kit's own panel without the native kit. A dialog named by its title:
// Tab stays inside, Escape, Close or a tap outside closes it, focus returns.
// Not <dialog>/alert(): the app frame allows no modals.
import { h, icon, uid, clear } from './dom.js';
import { loadNative, toast } from './native.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let current = null;

/** openSheet({ title, content(body, close) or an element, onClose, returnFocus, closeLabel }) resolves { el, body, close() }. */
export async function openSheet({ title, content, onClose, returnFocus, closeLabel = 'Close' }) {
  if (current) current.close();
  const opener = returnFocus || document.activeElement;
  const handle = { body: null, el: null, close: () => close() };
  current = handle;
  let closed = false;
  let others = [];
  let dismiss = null;
  let surface = null;
  let trap = true;
  const un = await loadNative();
  if (closed) return handle;
  const titleId = uid('kit-sheet');
  const body = h('div', { class: 'kit-sheet-body' });
  const panel = h('div', { class: 'kit-sheet-panel' },
    h('div', { class: 'kit-sheet-head' },
      h('h2', { class: 'text-heading', id: titleId }, title),
      h('button', { type: 'button', class: 'kit-icon-button', 'aria-label': closeLabel, on: { click: () => close() } }, icon('close'))),
    body);
  if (typeof content === 'function') content(body, close);
  else if (content) body.append(content);
  const first = panel.querySelector('[autofocus]') || body.querySelector(FOCUSABLE);

  if (un) {
    const wide = matchMedia('(min-width: 640px)').matches;
    if (first) first.setAttribute('autofocus', '');
    const shown = (wide ? un.presentModal : un.presentSheet)({ contentEl: panel, onDismiss: finish });
    surface = shown.el;
    dismiss = () => shown.dismiss();
    trap = !wide; // presentModal keeps Tab inside, answers Escape and focuses the autofocus field itself
  } else {
    surface = h('div', { class: 'kit-sheet' }, panel);
    const layer = h('div', { class: 'kit-sheet-layer' }, h('div', { class: 'kit-sheet-backdrop', on: { click: () => close() } }), surface);
    others = [...document.body.children].filter((node) => !node.inert);
    for (const node of others) node.inert = true;
    document.documentElement.classList.add('kit-sheet-open');
    document.body.append(layer);
    dismiss = () => { layer.remove(); finish(); };
  }
  surface.setAttribute('role', 'dialog');
  surface.setAttribute('aria-modal', 'true');
  surface.setAttribute('aria-labelledby', titleId);
  if (!surface.hasAttribute('tabindex')) surface.tabIndex = -1;
  if (trap) {
    document.addEventListener('keydown', onKey, true);
    (first || surface).focus({ preventScroll: true });
  }
  Object.assign(handle, { el: surface, body });
  // Open at the top with the first label in view, whatever focusing scrolled,
  // and keep a focused field's label in view after the browser's own scroll.
  requestAnimationFrame(() => requestAnimationFrame(() => { body.scrollTop = 0; surface.scrollTop = 0; }));
  body.addEventListener('focusin', (e) => requestAnimationFrame(() => {
    const row = e.target.closest('.kit-choice, .kit-field');
    const scroller = body.scrollHeight > body.clientHeight ? body : surface;
    const over = row ? row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 4 : 0;
    if (over < 0) scroller.scrollTop += over;
  }));

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      const stops = [...surface.querySelectorAll(FOCUSABLE)].filter((node) => node.getClientRects().length);
      if (!stops.length) { e.preventDefault(); return; }
      const a = stops[0];
      const z = stops[stops.length - 1];
      const inside = surface.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === a || !inside)) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && (document.activeElement === z || !inside)) { e.preventDefault(); a.focus(); }
    }
  }
  function close() {
    if (current === handle) current = null;
    if (!dismiss) closed = true;
    else if (!closed) dismiss();
  }
  function finish() {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    for (const node of others) node.inert = false;
    document.documentElement.classList.remove('kit-sheet-open');
    if (current === handle) current = null;
    if (!current && opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    if (onClose) onClose();
  }
  return handle;
}

/**
 * renderForm(el, { fields, values, submitLabel, cancelLabel, onSubmit, onCancel })
 * fields: [{ name, label, type, required, max, placeholder, hint, options, min, none }]
 * type: text (default), textarea, number, date, select, choices (2 to 6 short
 * texts) or switch (un-switch, a boolean). A throw from onSubmit(values) shows
 * its message in the form; the values stay.
 */
export function renderForm(el, { fields, values = {}, submitLabel = 'Save', cancelLabel = 'Cancel', onSubmit, onCancel }) {
  const rows = fields.map((f) => fieldRow(f, values[f.name]));
  const error = h('p', { class: 'kit-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn-primary' }, submitLabel);
  const form = h('form', { class: 'kit-form', novalidate: true },
    rows.map((r) => r.el), error,
    h('div', { class: 'kit-form-actions' },
      onCancel ? h('button', { type: 'button', class: 'btn-secondary', on: { click: onCancel } }, cancelLabel) : null,
      submit));
  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    error.hidden = true;
    const bad = rows.filter((r) => !r.check());
    if (bad.length) { bad[0].focus(); return; }
    const out = Object.fromEntries(rows.map((r) => [r.name, r.value()]));
    busy = true;
    submit.disabled = true;
    submit.textContent = 'Saving';
    try {
      await onSubmit(out);
    } catch (err) {
      error.textContent = (err && err.message) || 'That did not save. Try again.';
      error.hidden = false;
    } finally {
      busy = false;
      submit.disabled = false;
      submit.textContent = submitLabel;
    }
  });
  clear(el).append(form);
  return form;
}

/** openSheet + renderForm: closes once onSubmit resolves, then toasts savedMessage (null for none). */
export function openFormSheet({ title, onClose, returnFocus, savedMessage = 'Saved', ...form }) {
  return openSheet({
    title, onClose, returnFocus,
    content: (body, close) => renderForm(body, {
      onCancel: close, ...form,
      onSubmit: async (v) => { await form.onSubmit(v); close(); if (savedMessage) toast(savedMessage); },
    }),
  });
}

function fieldRow(f, value) {
  const id = uid('kit-field');
  const hint = f.hint ? h('p', { class: 'kit-hint', id: `${id}-hint` }, f.hint) : null;
  const error = h('p', { class: 'kit-error', id: `${id}-error`, hidden: true });
  const described = [hint && `${id}-hint`, `${id}-error`].filter(Boolean).join(' ');
  const label = [f.label, f.required ? null : h('span', { class: 'kit-optional' }, ' (optional)')];
  let inputs = [];
  let control = null;
  const input = (extra) => h('input', { class: 'field', type: 'text', maxlength: f.max ? String(f.max) : null, ...extra });

  if (f.type === 'choices') {
    const min = f.min ?? 2;
    const list = h('div', { class: 'kit-choices' });
    const more = h('button', { type: 'button', class: 'kit-add self-start', on: { click: () => { addChoice(''); inputs[inputs.length - 1].focus(); } } }, 'Add a choice');
    const addChoice = (text) => {
      const n = inputs.length + 1;
      const hintText = Array.isArray(f.placeholder) ? f.placeholder[n - 1] : f.placeholder;
      const box = input({ value: text || null, placeholder: hintText || null, 'aria-label': `${f.label}, choice ${n}`, 'aria-describedby': described });
      inputs.push(box);
      const remove = h('button', { type: 'button', class: 'kit-icon-button', 'aria-label': `Remove choice ${n}`, on: { click: () => {
        const at = inputs.indexOf(box);
        inputs = inputs.filter((x) => x !== box);
        wrap.remove();
        sync();
        inputs[Math.max(0, at - 1)].focus();
      } } }, icon('close'));
      const wrap = h('div', { class: 'kit-choice' }, box, remove);
      list.append(wrap);
      sync();
    };
    const sync = () => {
      inputs.forEach((x, i) => {
        x.setAttribute('aria-label', `${f.label}, choice ${i + 1}`);
        x.nextSibling.hidden = inputs.length <= min;
        x.nextSibling.setAttribute('aria-label', `Remove choice ${i + 1}`);
      });
      more.hidden = inputs.length >= (f.max || 6);
    };
    const start = Array.isArray(value) && value.length ? value : [];
    // A choices field the asker may leave empty (min 0) still opens with two
    // blank fields, so the form shows what a choice looks like.
    for (let i = 0; i < Math.max(min || 2, start.length); i += 1) addChoice(start[i]);
    const el = h('fieldset', { class: 'kit-field' }, h('legend', { class: 'kit-label mb-1' }, label), list, more, hint, error);
    const texts = () => inputs.map((x) => x.value.trim()).filter(Boolean);
    return {
      el, name: f.name, value: texts,
      focus: () => (inputs.find((x) => !x.value.trim()) || inputs[0]).focus(),
      check: () => {
        const t = texts();
        const need = t.length ? Math.max(min, 2) : min;
        const msg = t.length < need ? `Give at least ${Math.max(min, 2)} choices.`
          : new Set(t.map((x) => x.toLowerCase())).size < t.length ? 'Each choice needs a different name.' : '';
        return show(msg, inputs);
      },
    };
  }

  if (f.type === 'switch') {
    const box = h('input', { type: 'checkbox', class: 'un-switch', role: 'switch', name: f.name, 'aria-describedby': described });
    box.checked = !!value;
    const el = h('div', { class: 'kit-field' }, h('label', { class: 'kit-switch' }, h('span', { class: 'kit-label' }, f.label), box), hint, error);
    return { el, name: f.name, value: () => box.checked, focus: () => box.focus(), check: () => true };
  }
  const common = { id, name: f.name, required: !!f.required, 'aria-describedby': described };
  if (f.type === 'textarea') {
    control = h('textarea', { class: 'field', rows: '4', maxlength: f.max ? String(f.max) : null, placeholder: f.placeholder || null, ...common });
    if (value != null) control.value = String(value);
  } else if (f.type === 'select') {
    control = h('select', { class: 'field', ...common },
      f.required ? null : h('option', { value: '' }, f.none || 'None'),
      (f.options || []).map((o) => h('option', { value: typeof o === 'object' ? o.value : o }, typeof o === 'object' ? o.label : o)));
    if (value != null) control.value = String(value);
  } else {
    const type = ['number', 'date'].includes(f.type) ? f.type : 'text';
    control = input({ type, placeholder: f.placeholder || null, value: value == null ? null : String(value), ...common });
  }
  inputs = [control];
  const el = h('div', { class: 'kit-field' }, h('label', { class: 'kit-label', for: id }, label), control, hint, error);
  return {
    el, name: f.name, value: () => control.value.trim(), focus: () => control.focus(),
    check: () => show(f.required && !control.value.trim() ? `${f.label} is needed.` : '', inputs),
  };

  function show(msg, boxes) {
    error.textContent = msg;
    error.hidden = !msg;
    for (const box of boxes) {
      if (msg) box.setAttribute('aria-invalid', 'true');
      else box.removeAttribute('aria-invalid');
    }
    return !msg;
  }
}
