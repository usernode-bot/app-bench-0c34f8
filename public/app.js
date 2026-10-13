// Club Votes — the whole client. The feed of open questions as ballot slips,
// the "Decided" list, the detail screen (vote, tally, comments), the ask
// sheet, reports, and the staging demo extras. The kit (public/kit/) draws
// the shared pieces; this file only arranges them.

import { api, h, clear, icon, plural, timeAgo } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { tally } from '/kit/tally.js';
import { renderVotes } from '/kit/votes.js';
import { renderComments } from '/kit/comments.js';
import { renderReport } from '/kit/report.js';
import { openFormSheet } from '/kit/sheet.js';
import { showDemoLabel } from '/kit/demo.js';
import { loadNative, native, toast } from '/kit/native.js';

const listScreen = document.getElementById('list-screen');
const detailScreen = document.getElementById('detail-screen');
const detailMain = document.getElementById('detail');
const feedEl = document.getElementById('feed');
const openLabel = document.getElementById('open-label');
const decidedSec = document.getElementById('decided-sec');
const decidedEl = document.getElementById('decided');
const pageEl = document.getElementById('page');
const askBtn = document.getElementById('ask');

let currentId = null;      // the question on screen, or null for the feed
let feedShown = false;     // the feed's content is drawn (quiet refreshes only)
let detailDrawn = false;   // the detail's content is drawn
let commentTotal = 0;      // shown "Comments, N" count

loadNative();
askBtn.addEventListener('click', openAsk);

// ── The feed ───────────────────────────────────────────────────────────────

const feedView = createStates(feedEl, {
  rows: 4,
  empty: {
    title: 'No questions yet',
    text: 'Ask the first one and the club can vote on it.',
    action: { label: 'Ask the club', onClick: openAsk, primary: true },
  },
  error: {
    title: 'Questions did not load',
    text: 'Nothing is lost — your votes and comments are safe. Try again in a moment.',
  },
});

loadFeed();

async function loadFeed() {
  await feedView.run(fetchFeed);
}

async function fetchFeed(box) {
  const data = await api('GET', '/api/questions');
  if (data.demo) showDemoLabel(pageEl);
  const open = [];
  const decided = [];
  for (const q of data.items) (q.closedAt ? decided : open).push(q);
  if (!data.items.length) {
    decidedSec.hidden = true;
    return false;
  }
  feedShown = true;
  openLabel.textContent = `Open questions, ${open.length}`;
  decidedSec.hidden = decided.length === 0;
  clear(decidedEl).append(...decided.map(decidedRow));
  clear(box);
  if (open.length) {
    box.append(h('div', { class: 'feed' }, open.map(slip)));
  } else {
    box.append(h('p', { class: 'text-small muted px-1' }, 'Nothing is open right now.'));
  }
}

// A ballot slip: the tally strip, the lead line, the perforated stub.
function slip(q) {
  const t = tally(q.votes);
  const voted = q.votes.mine != null;
  return h('button', {
    type: 'button', class: 'card ballot', 'data-id': q.id,
    on: { click: () => { location.hash = `q-${q.id}`; } },
  },
    h('div', { class: 'b-main' },
      h('h3', { class: 'b-title' }, q.title),
      stripFor(t),
      leadP(t),
      h('p', { class: 'meta' },
        h('span', {}, `${q.byMe ? 'You' : q.author}, ${timeAgo(q.createdAt)}`),
        q.commentCount > 0
          ? h('span', {}, bubbleSvg(), String(q.commentCount))
          : 'No comments')),
    h('div', { class: voted ? 'stub voted' : 'stub', 'aria-hidden': 'true' },
      stubSvg(voted), h('b', {}, voted ? 'Voted' : 'Vote')));
}

function decidedRow(q) {
  return h('li', {},
    h('button', {
      type: 'button', class: 'list-row w-full text-left', 'data-id': q.id,
      on: { click: () => { location.hash = `q-${q.id}`; } },
    },
      tickSvg('d-mark'),
      h('div', { class: 'd-text' },
        h('span', { class: 'd-title' }, q.title),
        h('span', { class: 'text-small muted' }, outcomeText(tally(q.votes)))),
      chevronSvg('chev')));
}

// ── Tally strip and lead/outcome lines ─────────────────────────────────────

const TALLY = ['tally-1', 'tally-2', 'tally-3', 'tally-4'];

// Segments ranked by count; the leading option takes tally-1, and from the
// fourth rank on everything shares tally-4.
function stripFor(t, large) {
  const ranked = [...t.options].sort((a, b) => b.count - a.count);
  return h('div', {
    class: large ? 'tally-strip-lg' : 'tally-strip',
    role: 'img',
    'aria-label': leadText(t),
  },
    ranked.map((o, i) => h('i', { class: TALLY[Math.min(i, 3)], style: `width:${o.percent}%` })));
}

function leadersOf(t) {
  return t.options.filter((o) => o.leading);
}

function leadText(t) {
  if (!t.total) return 'No votes yet';
  const lead = leadersOf(t);
  if (t.tied) {
    const each = `${plural(lead[0].count, 'vote', 'votes')} each`;
    return lead.length === 2
      ? `${lead[0].label} and ${lead[1].label} are tied, ${each}`
      : `${lead.length} options are tied, ${each}`;
  }
  return `${lead[0].label} leads, ${lead[0].count} of ${t.total} votes`;
}

function leadP(t) {
  if (!t.total) return h('p', { class: 'lead muted' }, 'No votes yet');
  const lead = leadersOf(t);
  if (t.tied) {
    const each = `${plural(lead[0].count, 'vote', 'votes')} each`;
    return lead.length === 2
      ? h('p', { class: 'lead' }, h('b', {}, lead[0].label), ' and ', h('b', {}, lead[1].label), ` are tied, ${each}`)
      : h('p', { class: 'lead' }, `${lead.length} options are tied, ${each}`);
  }
  return h('p', { class: 'lead' }, h('b', {}, lead[0].label), ` leads, ${lead[0].count} of ${t.total} votes`);
}

function outcomeText(t) {
  if (!t.total) return 'Closed with no votes';
  const lead = leadersOf(t);
  if (t.tied) {
    return lead.length === 2
      ? `Tied between ${lead[0].label} and ${lead[1].label}`
      : `Tied between ${lead.map((o) => o.label).join(', ')}`;
  }
  return `Picked ${lead[0].label}, ${lead[0].count} of ${t.total} votes`;
}

// ── The detail screen ──────────────────────────────────────────────────────

async function loadDetail(id) {
  detailDrawn = false;
  clear(detailMain).append(loadingRows(3));
  try {
    const data = await api('GET', `/api/questions/${id}`);
    if (currentId !== id) return; // the viewer moved on already
    clear(detailMain);
    drawDetail(detailMain, data.item, data.comments);
    detailDrawn = true;
  } catch (err) {
    if (currentId !== id) return;
    clear(detailMain).append(h('div', { class: 'state-error' },
      h('p', { class: 'kit-detail-body' }, err.message || 'This did not load.'),
      h('p', { class: 'text-small muted' }, 'Your votes and comments are safe.'),
      h('button', { type: 'button', class: 'btn-secondary', on: { click: () => loadDetail(id) } }, 'Try again')));
  }
}

function drawDetail(box, item, comments) {
  const t = tally(item.votes);
  const closed = Boolean(item.closedAt);
  commentTotal = comments.length;
  const countLabel = h('h3', { class: 'section-label' }, `Comments, ${commentTotal}`);

  const commentsBox = h('div', {});
  renderComments(commentsBox, {
    comments,
    onAdd: async (text) => {
      const out = await api('POST', `/api/questions/${item.id}/comments`, { body: text });
      commentTotal += 1;
      countLabel.textContent = `Comments, ${commentTotal}`;
      return out.comment;
    },
    emptyText: 'No comments yet. Say what you think.',
    placeholder: 'e.g. I can bring the folding chairs',
  });

  const article = h('article', { class: 'kit-detail' },
    h('header', { class: 'kit-detail-head' },
      h('div', { class: 'bar' },
        h('button', { type: 'button', class: 'btn-secondary', on: { click: goBack } }, icon('back'), 'Questions'),
        h('button', {
          type: 'button', class: 'kit-icon-button', 'aria-label': 'More',
          on: { click: (e) => questionMenu(e.currentTarget, item) },
        }, dotsSvg())),
      h('h2', { class: 'text-title kit-detail-title', tabindex: '-1' }, item.title),
      h('p', { class: 'text-small muted' }, `Asked by ${item.byMe ? 'you' : item.author}, ${timeAgo(item.createdAt)}`),
      item.body ? h('p', { class: 'kit-detail-body' }, item.body) : null),
    h('section', { class: 'kit-section' },
      h('h3', { class: 'section-label' }, closed ? 'Result' : 'Your vote'),
      stripFor(t, true),
      voteBox(item, t, closed)),
    h('section', { class: 'kit-section' },
      countLabel,
      commentsBox));

  // A More button on every comment that is not the viewer's own.
  for (const li of commentsBox.querySelectorAll('.kit-comment[data-id]')) {
    const c = comments.find((x) => String(x.id) === String(li.dataset.id));
    if (c && !c.byMe) li.append(commentMore(c, li, countLabel));
  }

  box.append(article);
}

function voteBox(item, t, closed) {
  const box = h('div', {});
  if (closed) {
    renderReport(box,
      [...t.options].sort((a, b) => b.count - a.count).map((o) => ({ label: o.label, count: o.count })),
      { label: 'Result', unit: ['vote', 'votes'], total: true });
    if (t.mine != null) {
      const chosen = t.options.find((o) => String(o.id) === String(t.mine));
      if (chosen) box.append(h('p', { class: 'kit-vote-summary' }, `You voted ${chosen.label}.`));
    }
    return box;
  }
  renderVotes(box, {
    ...item.votes,
    layout: item.votes.options.length === 2 ? 'row' : 'stack',
    onVote: async (option) => {
      try {
        const out = await api('POST', `/api/questions/${item.id}/vote`, { option });
        return out.item.votes;
      } catch (err) {
        if (err && err.status === 409) setTimeout(() => loadDetail(item.id), 300);
        throw err;
      }
    },
  });
  return box;
}

function commentMore(c, li, countLabel) {
  return h('button', {
    type: 'button', class: 'kit-icon-button', 'aria-label': 'More for this comment',
    on: { click: async (e) => {
      const items = [{ label: 'Report', destructive: true, run: async () => {
        try {
          await api('POST', '/api/reports', { kind: 'comment', targetId: c.id });
          toast('Report sent');
          li.remove();
          commentTotal = Math.max(0, commentTotal - 1);
          countLabel.textContent = `Comments, ${commentTotal}`;
        } catch (err) { toast(err.message); }
      } }];
      openMenu(e.currentTarget, items);
    } },
  }, dotsSvg());
}

function loadingRows(n) {
  return h('div', { class: 'kit-content' },
    ...Array.from({ length: n }, () => h('div', { class: 'skeleton h-16' })));
}

// ── Menus, confirms and the question's actions ─────────────────────────────

function openMenu(anchor, items) {
  const un = native();
  if (un && typeof un.menu === 'function') {
    un.menu({ anchorEl: anchor, items: items.map((it) => ({ label: it.label, handler: it.run })) });
    return;
  }
  for (const it of items) {
    if (window.confirm(`${it.label}?`)) { it.run(); return; }
  }
}

function confirmBox({ title, message, okLabel, danger }) {
  const un = native();
  if (un && typeof un.alert === 'function') {
    let done;
    const p = new Promise((resolve) => { done = resolve; });
    const buttons = [
      { label: 'Cancel', style: 'neutral', handler: () => done(false) },
      { label: okLabel, style: danger ? 'destructive' : 'primary', handler: () => done(true) },
    ];
    const out = un.alert({ title, message, buttons });
    return out && typeof out.then === 'function' ? Promise.resolve(out) : p;
  }
  return Promise.resolve(window.confirm(`${title} ${message}`));
}

function questionMenu(anchor, item) {
  const items = [];
  if (item.byMe) {
    if (!item.closedAt) items.push({ label: 'Close voting', run: () => closeQuestion(item) });
    items.push({ label: 'Delete question', destructive: true, run: () => deleteQuestion(item) });
  } else {
    items.push({ label: 'Report', destructive: true, run: () => reportQuestion(item) });
  }
  openMenu(anchor, items);
}

async function closeQuestion(item) {
  const ok = await confirmBox({
    title: 'Close voting?',
    message: 'Everyone will see the result. This cannot be undone.',
    okLabel: 'Close voting',
  });
  if (!ok) return;
  try {
    await api('POST', `/api/questions/${item.id}/close`);
    toast('Voting closed');
    loadDetail(item.id);
    quietRefreshFeed();
  } catch (err) { toast(err.message); }
}

async function deleteQuestion(item) {
  const ok = await confirmBox({
    title: 'Delete this question?',
    message: 'Its votes and comments go too. This cannot be undone.',
    okLabel: 'Delete', danger: true,
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/questions/${item.id}`);
    toast('Question deleted');
    goBack();
    quietRefreshFeed();
  } catch (err) { toast(err.message); }
}

async function reportQuestion(item) {
  try {
    await api('POST', '/api/reports', { kind: 'question', targetId: item.id });
    toast('Report sent');
    goBack();
    quietRefreshFeed();
  } catch (err) { toast(err.message); }
}

// ── The ask sheet ──────────────────────────────────────────────────────────

function openAsk() {
  openFormSheet({
    title: 'Ask the club',
    submitLabel: 'Post question',
    cancelLabel: 'Cancel',
    savedMessage: 'Question posted',
    returnFocus: askBtn,
    fields: [
      { name: 'title', label: 'Question', required: true, max: 120, placeholder: 'e.g. Where should we hold the summer picnic?' },
      { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'e.g. Anything people should know before they vote' },
      { name: 'options', label: 'Options', type: 'choices', min: 0, max: 6, placeholder: ['e.g. Yes', 'e.g. No', 'e.g. Maybe'] },
    ],
    values: { options: ['', ''] },
    onSubmit: async (v) => {
      const options = (v.options || []).map((s) => String(s).trim()).filter(Boolean);
      await api('POST', '/api/questions', { title: v.title, body: v.body || '', options });
      quietRefreshFeed();
    },
  });
}

// ── Hash routing: feed ⇄ question ──────────────────────────────────────────

function swapScreens(showDetail, type) {
  const un = native();
  const swap = () => {
    detailScreen.hidden = !showDetail;
    listScreen.hidden = showDetail;
  };
  if (un && typeof un.transition === 'function') un.transition(swap, { type });
  else swap();
}

function route() {
  const m = /^#q-(\d+)$/.exec(location.hash || '');
  const id = m ? Number(m[1]) : null;
  if (id) {
    if (id === currentId) return;
    currentId = id;
    swapScreens(true, 'push');
    loadDetail(id);
  } else if (currentId != null) {
    currentId = null;
    detailDrawn = false;
    swapScreens(false, 'pop');
  }
}

window.addEventListener('hashchange', route);

function goBack() {
  if (location.hash) location.hash = '';
  else route();
}

// ── Quiet refreshes: every 20 s while the screen is visible ────────────────

setInterval(() => { if (document.visibilityState === 'visible') quietRefresh(); }, 20000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') quietRefresh();
});

async function quietRefresh() {
  if (currentId != null) {
    if (!detailDrawn) return;
    // Never wipe the composer while someone is typing.
    const area = detailMain.querySelector('textarea');
    if (area && (area.value || detailMain.contains(document.activeElement))) return;
    try {
      const data = await api('GET', `/api/questions/${currentId}`);
      if (currentId == null || !detailDrawn) return;
      clear(detailMain);
      drawDetail(detailMain, data.item, data.comments);
    } catch { /* quiet */ }
  } else {
    quietRefreshFeed();
  }
}

async function quietRefreshFeed() {
  if (!feedShown) return;
  try {
    await fetchFeed(feedView.content);
  } catch { /* quiet */ }
}

route();

// ── Small SVG helpers (the kit's icon() has no dots, bubble or ballot box) ──

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function dotsSvg() {
  const s = svgEl('svg', { viewBox: '0 0 24 24', fill: 'currentColor' });
  for (const cx of [5, 12, 19]) s.append(svgEl('circle', { cx, cy: 12, r: 1.8 }));
  return s;
}

function bubbleSvg() {
  const s = svgEl('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linejoin': 'round',
  });
  s.append(svgEl('path', { d: 'M4 5h16v11H9l-5 4z' }));
  return s;
}

// The stub's ballot box; ticked once the viewer has voted. The stroke follows
// the tokens, so it reads right in both looks.
function stubSvg(voted) {
  const s = svgEl('svg', {
    viewBox: '0 0 24 24', fill: 'none', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  });
  s.style.stroke = voted ? 'rgb(var(--accent))' : 'rgb(var(--muted))';
  s.append(svgEl('rect', { x: 3, y: 3, width: 18, height: 18, rx: 3 }));
  if (voted) s.append(svgEl('path', { d: 'M7.5 12.5l3 3 6-7' }));
  return s;
}

function tickSvg(cls) {
  const s = svgEl('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', class: cls,
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  });
  s.append(svgEl('circle', { cx: 12, cy: 12, r: 9 }));
  s.append(svgEl('path', { d: 'M8 12.5l2.5 2.5 5.5-6' }));
  return s;
}

function chevronSvg(cls) {
  const s = svgEl('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', class: cls,
    'stroke-width': '2', 'stroke-linecap': 'round',
  });
  s.append(svgEl('path', { d: 'M9 6l6 6-6 6' }));
  return s;
}