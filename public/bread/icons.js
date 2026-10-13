// The bread and ingredient line icons, built with createElementNS from the
// path data of the drawn screens so they match stroke for stroke and take
// the text colour (svg.i fills none and strokes currentColor). An unknown
// key yields no icon rather than a placeholder.

const NS = 'http://www.w3.org/2000/svg';

// Each icon is a list of [tag, attrs] drawn in a 24×24 viewBox.
const BREAD_ICONS = {
  sourdough: [
    ['path', { d: 'M3 17c0-5 4-9 9-9s9 4 9 9z' }],
    ['path', { d: 'M8 12l3 2M12 11l3 2' }],
  ],
  bagels: [
    ['ellipse', { cx: 12, cy: 13, rx: 9, ry: 6 }],
    ['ellipse', { cx: 12, cy: 13, rx: 3, ry: 1.6 }],
  ],
  sourdoughBagels: [
    ['ellipse', { cx: 12, cy: 13, rx: 9, ry: 6 }],
    ['ellipse', { cx: 12, cy: 13, rx: 3, ry: 1.6 }],
    ['path', { d: 'M6 10.5l2 1M16 11.5l2-1' }],
  ],
  rye: [
    ['path', { d: 'M2 14c0-3.5 4.5-6 10-6s10 2.5 10 6-4.5 4-10 4-10-.5-10-4z' }],
    ['path', { d: 'M7 11l2 4M11 10.5l2 4.5M15 11l2 4' }],
  ],
  sandwich: [
    ['path', { d: 'M4 11c0-3 3.5-5 8-5s8 2 8 5v8H4z' }],
    ['path', { d: 'M4 11h16' }],
  ],
};

// A wheat ear, reused by the flours.
const WHEAT = [
  ['path', { d: 'M12 21V8' }],
  ['path', { d: 'M12 8c-2-1-3-3-3-5 2 1 3 3 3 5zM12 8c2-1 3-3 3-5-2 1-3 3-3 5z' }],
];

const INGREDIENT_ICONS = {
  breadFlour: [
    ...WHEAT,
    ['path', { d: 'M12 13c-2-1-4-2-4-5 2 1 4 2 4 5zM12 13c2-1 4-2 4-5-2 1-4 2-4 5z' }],
    ['path', { d: 'M12 18c-2-1-4-2-4-5 2 1 4 2 4 5zM12 18c2-1 4-2 4-5-2 1-4 2-4 5z' }],
  ],
  wholeWheat: [
    ...WHEAT,
    ['path', { d: 'M12 14c-2-1-4-2-4-5 2 1 4 2 4 5zM12 14c2-1 4-2 4-5-2 1-4 2-4 5z' }],
    ['circle', { cx: 7, cy: 18, r: 1 }],
    ['circle', { cx: 17, cy: 18, r: 1 }],
  ],
  ryeFlour: [
    ...WHEAT,
    ['path', { d: 'M12 14c-2-1-4-2-4-5 2 1 4 2 4 5zM12 14c2-1 4-2 4-5-2 1-4 2-4 5z' }],
    ['circle', { cx: 7, cy: 18, r: 1 }],
    ['circle', { cx: 17, cy: 18, r: 1 }],
  ],
  water: [['path', { d: 'M12 3c3 4 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 3-7 6-11z' }]],
  starter: [
    ['path', { d: 'M7 7h10v13H7z' }],
    ['path', { d: 'M9 3h6v4H9z' }],
    ['path', { d: 'M7 12c2-1 4 1 6 0s3-1 4 0' }],
  ],
  salt: [
    ['path', { d: 'M5 15l4-4 4 4-4 4z' }],
    ['path', { d: 'M13 8l3-3 3 3-3 3z' }],
    ['path', { d: 'M15 17l2-2 2 2-2 2z' }],
  ],
  yeast: [
    ['circle', { cx: 8, cy: 9, r: 2 }],
    ['circle', { cx: 15, cy: 7, r: 1.5 }],
    ['circle', { cx: 16, cy: 14, r: 2.2 }],
    ['circle', { cx: 9, cy: 16, r: 1.6 }],
  ],
  malt: [
    ['path', { d: 'M6 9h12v9a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3z' }],
    ['path', { d: 'M8 5h8v4H8z' }],
    ['path', { d: 'M9 14h6' }],
  ],
  caraway: [
    ['circle', { cx: 8, cy: 9, r: 1.2 }],
    ['circle', { cx: 14, cy: 8, r: 1.2 }],
    ['circle', { cx: 16, cy: 13, r: 1.2 }],
    ['circle', { cx: 10, cy: 14, r: 1.2 }],
    ['circle', { cx: 12, cy: 18, r: 1.2 }],
  ],
  butter: [
    ['path', { d: 'M4 10h16v9H4z' }],
    ['path', { d: 'M7 6h10v4H7z' }],
  ],
  sugar: [
    ['path', { d: 'M6 9l6-3 6 3v7l-6 3-6-3z' }],
    ['path', { d: 'M6 9l6 3 6-3M12 12v7' }],
  ],
};

function build(parts) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

export const breadIcon = (kind) => build(BREAD_ICONS[kind] || []);
export const ingredientIcon = (key) => build(INGREDIENT_ICONS[key] || []);

// The stepper's minus and plus, drawn like the drawn screens' steppers
// (a single line, and a line with a crossbar).
export function minusIcon() {
  return build([['path', { d: 'M6 12h12' }]]);
}
export function plusIcon() {
  return build([['path', { d: 'M6 12h12M12 6v12' }]]);
}