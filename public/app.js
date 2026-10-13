// Club Votes: the club's decision board. One list of open decisions, split
// by whether the viewer has voted yet; a decision opens onto its tallies,
// the viewer's own vote and the discussion. Everything hangs off the hash
// route (#d/<id>), so back and deep links both go through route().
import { h, icon, api, clear, plural, timeAgo } from './kit/dom.js';
import { createStates } from './kit/states.js';
import { renderDetail } from './kit/list.js';
import { renderVotes } from './kit/votes.js';
import { applyVote } from './kit/tally.js';
import { renderComments } from './kit/comments.js';
import { openFormSheet, openSheet } from './kit/sheet.js';
import { loadNative, native, toast } from './kit/native.js';
import { showDemoLabel } from './kit/demo.js';
import { renderTallyBar } from './tally-bar.js';

const app = document.getElementById('app');
const DEMO_LINE = 'Staging demo: these decisions and people are made up.';

// Icons the kit does not ship, drawn here once: the comment bubble on the
// list rows' key line, and the three dots of a More button.
function svgIcon(paths, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: cls, 'aria-hidden': 'true' })) {
    svg.setAttribute(k, v);
  }
  for (const [tag, attrs] of paths) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  }
  return svg;
}
const bubbleIcon = () => svgIcon([['path', { d: 'M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z' }]], 'h-4 w-4');
const dotsIcon = () => svgIcon([[3, 12], [12, 12], [21, 12]].map(([x, y]) => ['circle', { cx: x, cy: y, r: '1' }]), 'h-5 w-5');

// ── The two screens ────────────────────────────────────────────────────────
// The list screen keeps its header while createStates swaps loading, empty,
// error and content below it; createStates clears the element it is given,
// so it gets a box of its own.
const listSummary = h('p', { class: 'text-small text-muted' }, '');
const listScreen = h('section', { class: 'flex flex-col gap-6' },
  h('header', { class: 'flex items-start justify-between gap-3' },
    h('div', { class: 'min-w-0' },
      h('h1', { class: 'text-heading' }, 'Club Votes'),
      listSummary),
    h('button', { type: 'button', class: 'btn-primary shrink-0', on: { click: () => openNewDecision() } },
      icon('plus', 'h-5 w-5'), 'New decision')));
const boardBox = h('div');
listScreen.append(boardBox);

const detailScreen = h('section', { class: 'flex flex-col gap-6', hidden: true });
app.append(listScreen, detailScreen);

const board = createStates(boardBox, {
  rows: 5,
  empty: {
    title: 'No decisions yet',
    text: 'Post the first thing the club needs to decide.',
    action: { label: 'New decision', onClick: () => openNewDecision() },
  },
  error: {
    title: 'Decisions did not load',
    text: 'Nothing you posted is lost. Try again in a moment.',
  },
});
const detail = createStates(detailScreen, {
  rows: 4,
  error: {
    title: 'This did not load',
    text: 'The decision is still there. Try again in a moment.',
  },
});

let items = [];
let currentId = null; // the decision on screen, or null for the list
let currentRow = null; // the list row to hand focus back to on pop
let detailGen = 0; // ignores a decision load that an older navigation raced

// ── Routing ────────────────────────────────────────────────────────────────
function route() {
  const m = location.hash.match(/^#d\/(\d+)$/);
  const id = m ? Number(m[1]) : null;
  if (id === currentId) return;
  if (id != null) {
    currentId = id;
    openDecision(id);
  } else {
    currentId = null;
    showScreens(false);
    refreshBoard();
    if (currentRow && currentRow.isConnected) currentRow.focus({ preventScroll: true });
    currentRow = null;
  }
}

function showScreens(toDetail) {
  const flip = () => {
    listScreen.hidden = toDetail;
    detailScreen.hidden = !toDetail;
  };
  const un = native();
  if (un && typeof un.transition === 'function') {
    un.transition(flip, { type: toDetail ? 'push' : 'pop' });
  } else {
    flip();
  }
  if (toDetail) window.scrollTo(0, 0);
}

// ── The list ───────────────────────────────────────────────────────────────
board.run(async () => {
  const data = await api('GET', '/api/decisions');
  if (data.demo) showDemoLabel(app, DEMO_LINE);
  items = data.items;
  if (!items.length) return false;
  renderBoard();
  return true;
});

// A quiet refresh redraws the list in place; a failed one leaves the last
// good screen up rather than shouting over it.
async function refreshBoard({ force = false } = {}) {
  if (!force && boardBox.dataset.state !== 'ready') return;
  try {
    const data = await api('GET', '/api/decisions');
    if (data.demo) showDemoLabel(app, DEMO_LINE);
    items = data.items;
    if (!items.length) {
      board.empty();
      return;
    }
    renderBoard();
    board.ready();
  } catch (err) {
    if (force) board.error();
  }
}

const CHIP_DOTS = { 0: 'tally-dot-for', 1: 'tally-dot-against', 2: 'tally-dot-abstain' };
const CHIP_TEXT = { 0: 'You voted For', 1: 'You voted Against', 2: 'You abstained' };

function renderBoard() {
  const waiting = items.filter((d) => d.votes.mine == null);
  const voted = items.filter((d) => d.votes.mine != null);
  listSummary.textContent = `${items.length} open${waiting.length ? `, ${waiting.length} waiting for you` : ''}`;

  const box = board.content;
  clear(box);
  box.append(h('h2', { class: 'section-label' }, 'Waiting for your vote'));
  if (waiting.length) {
    box.append(h('ul', { class: 'un-group kit-group', 'aria-label': 'Decisions waiting for your vote' },
      waiting.map(rowEl)));
  } else {
    box.append(h('p', { class: 'px-1 text-small text-muted' },
      "You're up to date: you've voted on every open decision."));
  }
  if (voted.length) {
    box.append(
      h('h2', { class: 'section-label mt-2' }, 'You voted'),
      h('ul', { class: 'un-group kit-group', 'aria-label': 'Decisions you voted on' },
        voted.map(rowEl)));
  }
}

function rowEl(item) {
  const barBox = h('div');
  renderTallyBar(barBox, item.votes.options);
  barBox.querySelector('.tally-key').append(
    h('span', { class: 'ml-auto inline-flex items-center gap-1.5' },
      bubbleIcon(), plural(item.commentCount, 'comment')));

  const row = h('button', {
    type: 'button', class: 'list-row kit-row decision-row',
    'aria-label': `${item.title}. ${item.votes.mine == null ? 'Waiting for your vote.' : 'You voted.'} Comments: ${item.commentCount}.`,
    on: { click: (e) => { currentRow = e.currentTarget; location.hash = `d/${item.id}`; } },
  },
    h('div', { class: 'flex items-start gap-2' },
      h('span', { class: 'kit-row-text' }, h('span', { class: 'kit-row-title' }, item.title)),
      icon('chevron', 'kit-row-chevron mt-0.5')),
    h('p', { class: 'text-small text-muted' }, `${item.author}, ${timeAgo(item.createdAt)}`),
    barBox,
    chip(item));
  return h('li', { class: 'un-group-row', 'data-id': item.id }, row);
}

function chip(item) {
  const mine = item.votes.mine;
  if (mine == null) return null;
  return h('span', { class: 'vote-chip' },
    h('i', { class: CHIP_DOTS[mine] || 'tally-dot', 'aria-hidden': 'true' }),
    CHIP_TEXT[mine] || 'You voted');
}

// ── The decision screen ────────────────────────────────────────────────────
async function openDecision(id) {
  showScreens(true);
  const gen = ++detailGen;
  detail.run(async (box) => {
    let data;
    try {
      data = await api('GET', `/api/decisions/${id}`);
    } catch (err) {
      if (err && err.status === 404) {
        box.append(h('div', { class: 'state-error' },
          h('h2', { class: 'text-heading' }, 'This decision was deleted.'),
          h('p', { class: 'text-body text-muted' }, 'It is gone from the board. Everything else still works.'),
          h('button', { type: 'button', class: 'btn-secondary mt-2', on: { click: () => { location.hash = ''; } } }, 'Back to decisions')));
        return true;
      }
      throw err;
    }
    if (gen !== detailGen) return true; // another decision took over meanwhile
    if (data.demo) showDemoLabel(app, DEMO_LINE);
    renderDecision(box, data);
    return true;
  });
}

function renderDecision(box, data) {
  const item = data.item;
  const view = renderDetail(box, {
    title: item.title,
    meta: `${item.author}, ${timeAgo(item.createdAt)}`,
    body: item.body || null,
    onBack: () => { location.hash = ''; },
    backLabel: 'Decisions',
  });

  // More sits on the same line as Back, at the other end.
  const head = box.querySelector('.kit-detail-head');
  const back = head.querySelector('button');
  const row = h('div', { class: 'flex w-full items-center justify-between' });
  head.insertBefore(row, back);
  row.append(back,
    h('button', { type: 'button', class: 'kit-icon-button', 'aria-label': 'More for this decision',
      on: { click: (e) => decisionMenu(e.currentTarget, item) } }, dotsIcon()));

  // Where it stands: the big bar, redrawn live as votes save or revert.
  const stands = h('div');
  const drawBar = () => renderTallyBar(stands, item.votes.options, { size: 'lg' });
  drawBar();
  view.section('Where it stands').append(stands);

  // Your vote: the kit's buttons; the vote also moves the big bar.
  renderVotes(view.section('Your vote'), {
    ...item.votes,
    label: 'Your vote',
    layout: 'row',
    summary: true,
    onVote: (mine) => saveVote(item, mine, drawBar),
  });

  // Comments.
  const loaded = data.comments || [];
  const commentsBox = view.section('Comments');
  renderComments(commentsBox, {
    comments: loaded,
    label: 'Add a comment',
    placeholder: 'e.g. Thursdays suit me better',
    emptyText: 'No comments yet. Say what you think.',
    postLabel: 'Post comment',
    onAdd: async (text) => {
      const res = await api('POST', `/api/decisions/${item.id}/comments`, { body: text });
      const cached = items.find((d) => d.id === item.id);
      if (cached) cached.commentCount += 1;
      return res.comment;
    },
  });
  addCommentMenus(commentsBox, loaded);

  view.focus();
}

// The kit's pick() moves its own buttons optimistically; this moves the big
// bar the same way and hands the saved state back for the kit to draw. A
// failure puts both back; the kit then toasts what went wrong.
function saveVote(item, mine, drawBar) {
  const before = { options: item.votes.options, mine: item.votes.mine };
  item.votes = applyVote(before, mine);
  drawBar();
  return api('POST', `/api/decisions/${item.id}/vote`, { option: mine }).then(
    (res) => {
      item.votes = { options: res.item.votes.options, mine: res.item.votes.mine };
      drawBar();
      return item.votes;
    },
    (err) => {
      item.votes = before;
      drawBar();
      throw err;
    });
}

// Report on comments the viewer did not write; a comment posted just now is
// the viewer's own, so it gets no menu.
function addCommentMenus(commentsBox, loaded) {
  const list = commentsBox.querySelector('.kit-group');
  if (!list) return;
  const reportable = new Set(loaded.filter((c) => !c.byMe).map((c) => String(c.id)));
  const decorate = (li) => {
    if (!reportable.has(li.dataset.id)) return;
    const meta = li.querySelector('.kit-comment-meta');
    if (meta && !meta.querySelector('button')) {
      meta.append(h('button', { type: 'button', class: 'kit-icon-button ml-auto',
        'aria-label': 'More for this comment',
        on: { click: (e) => commentMenu(e.currentTarget, Number(li.dataset.id)) } }, dotsIcon()));
    }
  };
  new MutationObserver(() => list.querySelectorAll('li[data-id]').forEach(decorate))
    .observe(list, { childList: true });
  list.querySelectorAll('li[data-id]').forEach(decorate);
}

// ── Posting, reporting, deleting ───────────────────────────────────────────
function openNewDecision() {
  openFormSheet({
    title: 'New decision',
    submitLabel: 'Post decision',
    savedMessage: 'Decision posted',
    fields: [
      { name: 'title', label: 'Title', required: true, max: 120, placeholder: 'e.g. Move club nights to Thursday' },
      { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'e.g. Why it matters, dates, costs' },
    ],
    onSubmit: async (v) => {
      await api('POST', '/api/decisions', { title: v.title, body: v.body || '' });
      refreshBoard({ force: true });
    },
  });
}

function decisionMenu(anchor, item) {
  openMenu(anchor, item.title, [item.byMe
    ? { label: 'Delete decision', destructive: true, handler: () => deleteDecision(item) }
    : { label: 'Report', handler: () => reportSomething('decision', item.id,
        'Report this decision?', 'It goes to the people running the club, not to the member who posted it.') }]);
}

function commentMenu(anchor, commentId) {
  openMenu(anchor, 'This comment', [{ label: 'Report', handler: () => reportSomething('comment', commentId,
    'Report this comment?', 'It goes to the people running the club, not to the member who wrote it.') }]);
}

// unNative.menu presents the action sheet (touch) or popover (desktop); the
// kit's own sheet shows the same choices without it.
async function openMenu(anchor, title, entries) {
  const un = await loadNative();
  if (un && typeof un.menu === 'function') {
    await un.menu({ anchorEl: anchor, title, items: entries });
    return;
  }
  await openSheet({
    title,
    returnFocus: anchor,
    content: (body, close) => {
      for (const entry of entries) {
        body.append(h('button', {
          type: 'button',
          class: entry.destructive ? 'btn-secondary w-full text-danger' : 'btn-secondary w-full',
          on: { click: () => { close(); if (entry.handler) entry.handler(); } },
        }, entry.label));
      }
    },
  });
}

// unNative.alert asks before acting; the kit's own sheet asks the same
// question without it. Resolves true only when the confirm label was picked.
async function confirm({ title, message, confirmLabel, destructive = false }) {
  const un = await loadNative();
  if (un && typeof un.alert === 'function') {
    const { button } = await un.alert({
      title,
      message,
      buttons: [
        { label: 'Cancel', style: 'cancel' },
        { label: confirmLabel, style: destructive ? 'destructive' : 'default' },
      ],
    });
    return !!(button && button.label === confirmLabel);
  }
  return new Promise((resolve) => {
    let done = false;
    const answer = (v) => { if (!done) { done = true; resolve(v); } };
    openSheet({
      title,
      onClose: () => answer(false),
      content: (body, close) => {
        if (message) body.append(h('p', { class: 'text-body text-muted' }, message));
        body.append(h('div', { class: 'kit-form-actions' },
          h('button', { type: 'button', class: 'btn-secondary', on: { click: () => { answer(false); close(); } } }, 'Cancel'),
          h('button', { type: 'button', class: 'btn-primary', on: { click: () => { answer(true); close(); } } }, confirmLabel)));
      },
    });
  });
}

async function reportSomething(kind, id, title, message) {
  if (!(await confirm({ title, message, confirmLabel: 'Report', destructive: true }))) return;
  try {
    await api('POST', '/api/reports', { kind, id });
    toast('Thanks, the report was sent.');
  } catch (err) {
    toast(err.message);
  }
}

async function deleteDecision(item) {
  const sure = await confirm({
    title: 'Delete this decision?',
    message: 'The decision, its votes and its comments go for good.',
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!sure) return;
  try {
    await api('DELETE', `/api/decisions/${item.id}`);
    toast('Decision deleted');
    if (currentId === item.id) location.hash = '';
    refreshBoard({ force: true });
  } catch (err) {
    toast(err.message);
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
route();
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshBoard();
});
loadNative().then((un) => {
  if (un && typeof un.attachPullToRefresh === 'function') {
    un.attachPullToRefresh(window, () => refreshBoard({ force: true }));
  }
});