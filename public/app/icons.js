// The line SVGs of the drawn screens: one drawing per bread, per ingredient
// and the oven, all on one stroke weight (1.6), plus the stepper's minus and
// plus at the controls' 2. Built with createElementNS, never innerHTML.

const P = (d) => ['path', { d }];
const C = (cx, cy, r) => ['circle', { cx, cy, r }];

const ICONS = {
  // Breads (named by their style key).
  sourdough: [P('M3 17c0-6 4-10 9-10s9 4 9 10z'), P('M8 12c2.5-2 5.5-2 8 0')],
  bagels: [C(12, 12, 8.5), C(12, 12, 3)],
  'sourdough-bagels': [C(12, 12, 8.5), C(12, 12, 3), P('M6.5 8c1.5-1.6 3.3-2.4 5.5-2.4')],
  rye: [['ellipse', { cx: 12, cy: 13, rx: 9.5, ry: 5 }], P('M7 15l2-4'), P('M11 15l2-4'), P('M15 15l2-4')],
  sandwich: [P('M5 11c0-3.5 3-6 7-6s7 2.5 7 6'), P('M5 11h14v8H5z')],

  // Ingredients.
  flour: [P('M12 21V8'), P('M12 12c-2.5 0-4-1.5-4-4 2.5 0 4 1.5 4 4z'), P('M12 12c2.5 0 4-1.5 4-4-2.5 0-4 1.5-4 4z'), P('M12 7c-1.5-1-1.5-3 0-4 1.5 1 1.5 3 0 4z')],
  water: [P('M12 3c3.5 4.5 6 8 6 11a6 6 0 0 1-12 0c0-3 2.5-6.5 6-11z')],
  starter: [P('M7 9h10l-1 11H8z'), P('M7 9c0-2 1.5-3 3-3 .5-2 3.5-2 4 0 1.5 0 3 1 3 3'), C(11, 14, 0.6), C(13.5, 16.5, 0.6)],
  salt: [P('M8 9h8v11H8z'), P('M9 9V6h6v3'), P('M10 4h4')],
  yeast: [C(8, 10, 2.5), C(15, 8, 2), C(14, 15, 3), C(7.5, 16.5, 1.5)],
  syrup: [P('M9 4h6'), P('M10 4v3l-4 5v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6l-4-5V4'), P('M6 14h12')],
  butter: [P('M4 13l8-5 8 5-8 5z'), P('M4 13v4l8 5v-4'), P('M20 13v4l-8 5v-4')],
  sugar: [P('M8 4h6v6H8z'), P('M5 12h6v6H5z'), P('M13 13h6v6h-6z')],

  // Bake and stepper controls.
  oven: [P('M4 4h16v16H4z'), P('M4 8h16'), P('M7 6h.01'), P('M10 6h.01'), P('M8 15c0-2 1.8-3.5 4-3.5s4 1.5 4 3.5z')],
  minus: { w: 2, el: [P('M6 12h12')] },
  plus: { w: 2, el: [P('M6 12h12'), P('M12 6v12')] },
};

/** A line icon as an SVG element: icon('flour'), icon('minus'). */
export function icon(name, cls) {
  const spec = ICONS[name] || [];
  const el = spec.el || spec;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const attrs = {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': spec.w || 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  };
  if (cls) attrs.class = cls;
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  for (const [tag, tagAttrs] of el) {
    const child = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(tagAttrs)) child.setAttribute(k, String(v));
    svg.append(child);
  }
  return svg;
}