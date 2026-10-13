// The platform's native UI kit (usernode-native), loaded once by relative
// path if the page has not loaded it: the stylesheet before the app's own (so
// the app's tokens and utilities come after it, as on the platform's shell),
// then the script. Every kit module starts this on import. If it fails or is
// slow, the pieces fall back to their own sheet and toast, and only a
// console.warn says so.

const CSS = '/usernode-native/v1/native.css';
const JS = '/usernode-native/v1/native.js';
let ready = null;

/** Resolves window.unNative, or null when it is missing, fails or takes longer than `timeout` ms. */
export function loadNative({ timeout = 4000 } = {}) {
  if (ready) return ready;
  ready = new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    if (window.unNative) return resolve(window.unNative);
    if (!document.querySelector(`link[href$="${CSS}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS;
      document.head.insertBefore(link, document.head.querySelector('link[rel="stylesheet"]'));
    }
    let script = document.querySelector(`script[src$="${JS}"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = JS;
      document.head.append(script);
    }
    let timer = null;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!window.unNative) console.warn('The native UI kit did not load; the kit uses its own sheet and toast.');
      resolve(window.unNative || null);
    };
    timer = setTimeout(done, timeout);
    script.addEventListener('load', done);
    script.addEventListener('error', done);
  });
  return ready;
}

/** The native kit if it has loaded by now, else null. */
export const native = () => (typeof window !== 'undefined' && window.unNative) || null;

let own = null;

/**
 * A short notice ("Saved", "Your vote was not saved"): unNative.toast when the
 * native kit is loaded, else the kit's own. Options go to unNative.toast.
 */
export function toast(message, options) {
  const un = native();
  if (un && typeof un.toast === 'function') return un.toast(message, options);
  if (own) own.remove();
  const el = document.createElement('div');
  el.className = 'kit-toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  own = el;
  setTimeout(() => { if (own === el) { el.remove(); own = null; } }, 3000);
  return { el, dismiss: () => el.remove() };
}

loadNative();
