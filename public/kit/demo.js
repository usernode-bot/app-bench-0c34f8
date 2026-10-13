// Staging demo data (?demo=1 on staging only): varied, made-up rows, the same
// for the same seed and "now". The screen says "Staging demo" once.
import { h } from './dom.js';

/** Made-up people: fake ids and usernames, never real accounts. */
export const DEMO_PEOPLE = Object.freeze(['Ana', 'Ben', 'Chioma', 'Dev', 'Elif', 'Farah', 'Gus', 'Hana', 'Ivo', 'Jules', 'Kemal', 'Lucia']
  .map((name, i) => Object.freeze({ id: -(i + 1), username: `staging-demo-${name.toLowerCase()}`, name })));

/** A small seeded random number generator (mulberry32): rng(7)() gives 0 to 1. */
export function rng(seed = 1) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// How the votes fall, row by row: a few, a clear lead, close, none, spread, a tie.
const SHAPES = ['few', 'lead', 'close', 'none', 'spread', 'tie', 'lead', 'close', 'few', 'spread'];
const MINUTE = 60000;

/**
 * demoItems({ titles, bodies, categories, options, comments, seed, now, firstId })
 * titles: strings or { title, body, category, options }, one row each.
 * options: ['Yes', 'No'], or a list of lists used in turn. Rows come newest
 * first, ids counting up from firstId (README.md has their shape).
 */
export function demoItems({ titles = [], bodies = [], categories = [], options = ['Yes', 'No'], comments = [], seed = 1, now = new Date(), firstId = 900001 } = {}) {
  const r = rng(seed);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const shuffled = (list) => list.map((x) => [r(), x]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
  const end = new Date(now).getTime();
  const sets = Array.isArray(options[0]) ? options : [options];
  let at = end - int(4, 40) * MINUTE;
  let commentId = firstId;
  return titles.map((entry, i) => {
    const own = typeof entry === 'object' && entry ? entry : { title: entry };
    if (i > 0) at -= int(35, 26 * 60) * MINUTE;
    const created = at;
    const author = DEMO_PEOPLE[(i * 5 + int(0, 2)) % DEMO_PEOPLE.length];
    const labels = (own.options || sets[i % sets.length]).map(String);
    const category = categories.length ? categories[int(0, categories.length - 1)] : null;
    const picks = votePicks(SHAPES[i % SHAPES.length], labels.length, int, r);
    const voters = shuffled(DEMO_PEOPLE.filter((p) => p !== author));
    const when = () => new Date(created + Math.floor(r() * (end - created))).toISOString();
    const votes = picks.map((optionId, k) => ({ userId: voters[k].id, optionId, createdAt: when() }));
    const talk = comments.length ? (SHAPES[i % SHAPES.length] === 'none' ? int(0, 1) : int(0, 4)) : 0;
    const thread = Array.from({ length: talk }, (_, k) => {
      const who = voters[(k * 3 + i) % voters.length];
      return { id: commentId++, author: who.name, authorId: who.id, body: comments[(i * 3 + k) % comments.length], createdAt: when() };
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      id: firstId + i,
      title: String(own.title),
      body: own.body != null ? String(own.body) : (bodies.length && i % 4 !== 3 ? bodies[i % bodies.length] : ''),
      category: own.category != null ? String(own.category) : category,
      author: author.name,
      authorId: author.id,
      createdAt: new Date(created).toISOString(),
      options: labels.map((label, k) => ({ id: k, label })),
      votes,
      comments: thread,
    };
  });
}

function votePicks(shape, n, int, r) {
  const any = () => int(0, n - 1);
  if (shape === 'none' || n < 1) return [];
  if (shape === 'few') return Array.from({ length: int(1, 3) }, any);
  if (shape === 'spread') return Array.from({ length: int(5, 10) }, any);
  const a = any();
  const b = n > 1 ? (a + 1 + int(0, n - 2)) % n : a;
  if (shape === 'lead') return Array.from({ length: int(6, 10) }, () => (r() < 0.75 ? a : any()));
  if (shape === 'tie') return Array.from({ length: 2 * int(2, 4) }, (_, k) => (k % 2 ? b : a));
  return Array.from({ length: 2 * int(3, 4) + 1 }, (_, k) => (k % 2 ? b : a));
}

/** Put the one "Staging demo" line at the top of el, once. */
export function showDemoLabel(el, text = 'Staging demo: the people and entries here are made up.') {
  if (el.querySelector(':scope > .kit-demo-label')) return;
  el.prepend(h('p', { class: 'kit-demo-label', role: 'note' }, text));
}
