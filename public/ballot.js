// The ballot-box signature: hand-counted tally marks and the names of the
// people who voted, like a show of hands. Pure drawing on top of the kit's
// vote buttons — no kit file is changed here.

const NS = 'http://www.w3.org/2000/svg';

/** A line icon in the drawn style: 16-18 px, round caps, currentColor. */
export function lineIcon(d, { size = 16, stroke = 1.8 } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': stroke, 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(k, v);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
}

/** The small check in "You voted …". */
export const checkIcon = () => lineIcon('M5 12l5 5 9-10', { stroke: 2.2 });
/** The speech bubble on a comment count. */
export const bubbleIcon = () => lineIcon('M4 5h16v11H9l-5 4z');
/** The flag on a Report button. */
export const flagIcon = () => lineIcon('M5 21V4h11l-2 4 2 4H5', { size: 18 });

/**
 * tallySvg(count): hand-counted tally marks, groups of five (four upright
 * strokes and a diagonal fifth), wrapping into a new group. Null for no
 * votes. Decorative — the count is always written nearby in words.
 */
export function tallySvg(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!n) return null;
  const shown = Math.min(n, 20); // after 20 marks the words next to it carry the number
  const truncated = n > shown;
  const groups = Math.floor(shown / 5);
  const rest = shown % 5;
  const paths = [];
  for (let g = 0; g < groups; g += 1) {
    const x = g * 22;
    paths.push(`M${x + 2} 3v12M${x + 6} 3v12M${x + 10} 3v12M${x + 14} 3v12M${x} 13L${x + 16} 5`);
  }
  let extra = '';
  for (let k = 0; k < rest; k += 1) extra += `M${groups * 22 + 2 + k * 4} 3v12`;
  if (extra) paths.push(extra);
  let end = groups ? (groups - 1) * 22 + 16 : -4;
  if (rest) end = groups * 22 + 2 + (rest - 1) * 4;
  let text = null;
  if (truncated) {
    const label = `+${n - shown}`;
    text = document.createElementNS(NS, 'text');
    text.setAttribute('x', end + 9);
    text.setAttribute('y', '14');
    text.setAttribute('font-size', '12');
    text.setAttribute('fill', 'currentColor');
    text.setAttribute('stroke', 'none');
    text.textContent = label;
    end += 9 + label.length * 7;
  }
  const width = end + 6;
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({
    class: 'tally', width, height: 18, viewBox: `0 0 ${width} 18`, fill: 'none',
    stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(k, String(v));
  for (const d of paths) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  if (text) svg.appendChild(text);
  return svg;
}

/**
 * decorateVotes(root, state, voters): dress the kit's vote buttons for this
 * app — the mark, label and count go into the drawn top row, and under each
 * button come its tally marks and the names of the people who chose it
 * (voters: { [optionId]: [name] }, the viewer first as "You"). Safe to call
 * again after a vote: old marks and names are replaced, counts come from
 * `state`.
 */
export function decorateVotes(root, state, voters = null) {
  for (const o of state.options) {
    const button = root.querySelector(`.kit-vote[data-option="${o.id}"]`);
    if (!button) continue;
    const fill = button.querySelector(':scope > .kit-vote-fill');
    let top = button.querySelector(':scope > .v-top');
    if (!top) {
      top = document.createElement('span');
      top.className = 'v-top';
      button.insertBefore(top, fill ? fill.nextSibling : button.firstChild);
      for (const name of ['kit-vote-mark', 'kit-vote-label', 'kit-vote-count']) {
        const el = button.querySelector(`:scope > .${name}`);
        if (el) top.append(el);
      }
    }
    for (const el of button.querySelectorAll(':scope > .v-marks, :scope > .names')) el.remove();
    const marks = document.createElement('span');
    marks.className = 'v-marks';
    const t = tallySvg(o.count);
    if (t) marks.append(t);
    button.append(marks);
    const names = (voters && (voters[o.id] || voters[String(o.id)])) || [];
    if (names.length) button.append(hspan('names', names.join(', ')));
  }
}

function hspan(cls, text) {
  const el = document.createElement('span');
  el.className = cls;
  el.textContent = text;
  return el;
}