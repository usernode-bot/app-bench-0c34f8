// Club Votes: the two drawn screens, filled with live data. Screen 1 (the
// decision list) is in index.html; screen 2 (a decision, its votes and its
// comments) is the <template data-spec-screen="2">, moved where the view
// belongs and filled per decision. No view is rebuilt: fill.js fills the
// drawn markup, rowsFrom repeats its rows.
import { api, h, icon, timeAgo, plural } from '/kit/dom.js';
import { fillIn, rowsFrom, screen } from '/kit/fill.js';
import { createStates } from '/kit/states.js';
import { openFormSheet } from '/kit/sheet.js';
import { tally, applyVote, voteSummary } from '/kit/tally.js';
import { showDemoLabel } from '/kit/demo.js';
import { toast, loadNative } from '/kit/native.js';

const main = document.getElementById('app');
const listView = main.querySelector('[data-spec-screen="1"]');
const cv = listView.querySelector('.cv');
const hd = cv.querySelector('.hd');
const subtitle = hd.querySelector('p');
const newButton = hd.querySelector('.btn-primary');
const [openList, decidedList] = cv.querySelectorAll('.list');
const [openLabel, decidedLabel] = cv.querySelectorAll('.section-label');
const openRow = rowsFrom(openList);
const decidedRow = rowsFrom(decidedList);

// createStates owns the element it is given (it clears it and puts the
// loading, empty, error and content parts there), so the screens live inside
// its content, and each screen gets its own root to be shown and hidden in.
const listRoot = h('div');
const detailRoot = h('div', { hidden: true });
main.append(listRoot, detailRoot);

const listStates = createStates(listRoot, {
  empty: {
    title: 'No decisions yet',
    text: 'Post the first thing the club needs to decide.',
    action: { label: 'Post a decision', primary: true, onClick: newDecision },
  },
  error: {
    title: 'Decisions did not load',
    text: 'Nothing you posted is lost.',
  },
});
listStates.content.append(listView);
// The header stays above the states, so the app's name and the New decision
// button are there while loading, empty or failed too (the button hides when
// the list is empty, as the spec drew).
listRoot.prepend(h('div', { style: 'padding:0 16px' }, hd));
newButton.addEventListener('click', newDecision);

let closures = new Map(); // decision id -> closedAt
let demoOn = false;

// ── Screen 1: the list ──────────────────────────────────────────────────────

async function loadList() {
  const [list, closed] = await Promise.all([
    api('GET', '/api/decisions'),
    api('GET', '/api/decision-closures').catch(() => ({ closures: [] })),
  ]);
  closures = new Map(closed.closures.map((c) => [Number(c.id), c.closedAt]));
  demoOn = !!list.demo;
  const open = list.items.filter((i) => !closures.has(Number(i.id)));
  const decided = list.items.filter((i) => closures.has(Number(i.id)));
  subtitle.textContent = `${open.length} open ${open.length === 1 ? 'decision' : 'decisions'}`;
  newButton.hidden = list.items.length === 0;
  openLabel.hidden = decidedLabel.hidden = list.items.length === 0;
  openList.hidden = open.length === 0;
  decidedList.hidden = decided.length === 0;
  if (!list.items.length) return false;
  openList.replaceChildren(...open.map((i) => listRow(i, openRow(), false)));
  decidedList.replaceChildren(...decided.map((i) => listRow(i, decidedRow(), true)));
  if (demoOn) showDemoLabel(cv);
  return true;
}

function listRow(item, row, isClosed) {
  const closedAt = isClosed ? closures.get(Number(item.id)) || null : null;
  const t = tally(item.votes);
  const fillMap = {
    '': {
      attr: { tabindex: '0', role: 'button', 'aria-label': `Open: ${item.title}` },
      on: { click: () => openDetail(item.id), keydown: activate(() => openDetail(item.id)) },
    },
    '.t h2': item.title,
    '.by': byLine(item, closedAt),
    '.bar': {
      class: { done: isClosed },
      attr: { 'aria-label': barLabel(t) },
      children: barSpans(t),
    },
  };
  fillIn(row, fillMap);
  // The two lean lines are filled by hand: fillIn's selector would match
  // both of them, and the same nodes cannot be placed in two elements.
  const [lean1, lean2] = row.querySelectorAll('.lean');
  if (isClosed) {
    // The drawn decided row keeps its Decided badge: take it out before the
    // lean line's children are replaced, and put it back beside the winner.
    const badge = lean1.querySelector('.badge');
    lean1.replaceChildren(winnerLine(t, true), badge);
  } else {
    const mine = item.votes.mine != null
      ? h('span', { class: 'mine' }, icon('check', 'h-[15px] w-[15px]'), 'You voted')
      : h('span', {}, 'Not voted yet');
    const counts = item.commentCount;
    lean1.replaceChildren(winnerLine(t, false), mine);
    lean2.replaceChildren(
      h('span', { class: 'cc' }, commentMark(), counts ? plural(counts, 'comment') : 'No comments'));
  }
  return row;
}

function byLine(item, closedAt) {
  const who = item.byMe ? 'you' : item.author;
  return `Posted by ${who}, ${closedAt ? `closed ${timeAgo(closedAt)}` : timeAgo(item.createdAt)}`;
}

function barLabel(t) {
  if (!t.total) return 'No votes yet';
  return [...t.options].filter((o) => o.count)
    .sort((a, b) => b.count - a.count)
    .map((o) => `${o.label} ${o.count}`).join(', ');
}

/** The bar's spans: the leading option at full strength, the rest fading. */
function barSpans(t) {
  return [...t.options].filter((o) => o.count)
    .sort((a, b) => b.count - a.count)
    .map((o, i) => h('span', {
      class: i === 1 ? 's2' : i > 1 ? 's3' : null,
      style: `width:${o.percent}%`,
    }));
}

/** "<b>X</b> leads, N votes" while open; "X, N votes" (or "A and B tied") once closed. */
function winnerLine(t, closed) {
  if (!t.total) return h('span', {}, 'No votes yet');
  const names = t.options.filter((o) => o.leading);
  const parts = [];
  names.forEach((o, i) => {
    if (i) parts.push(i === names.length - 1 ? ' and ' : ', ');
    parts.push(h('b', {}, o.label));
  });
  if (closed) {
    if (t.tied) parts.push(' tied');
    parts.push(`, ${plural(t.total, 'vote')}`);
  } else if (t.tied) {
    parts.push(` tied, ${plural(t.total, 'vote')}`);
  } else {
    parts.push(` leads, ${plural(t.total, 'vote')}`);
  }
  return h('span', {}, ...parts);
}

function commentMark() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linejoin': 'round', class: 'h-[15px] w-[15px]', 'aria-hidden': 'true',
  })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M4 5h16v11H9l-5 4z');
  svg.append(path);
  return svg;
}

function activate(fn) {
  return (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
  };
}

// ── Screen 2: a decision ────────────────────────────────────────────────────

async function openDetail(id) {
  if (!detailRoot.hidden) return;
  const el = screen(2);
  const cv2 = el.querySelector('.cv');
  const states = createStates(el, {
    error: { title: 'This decision did not load', text: 'Nothing you posted is lost.' },
  });
  states.content.append(cv2);
  detailRoot.replaceChildren(el);

  // One option button to repeat: the drawn first one, emptied of its sample.
  const opts = cv2.querySelector('.opts');
  const optTpl = opts.querySelector('.opt').cloneNode(true);
  const checkSvg = optTpl.querySelector('.chk svg');
  for (const o of [...opts.querySelectorAll('.opt')]) o.remove();

  const commentsList = cv2.querySelector('.list');
  const commentRow = rowsFrom(commentsList);
  const commentsLabel = cv2.querySelectorAll('.section-label')[1];
  const noneEl = h('p', { class: 'kit-comments-none' }, 'No comments yet. Be the first to reply.');
  commentsLabel.after(noneEl);
  const sum = cv2.querySelector('.sum');
  const closeButton = cv2.querySelector('.btn-secondary');
  const compose = cv2.querySelector('.compose');
  // The drawn composer's field is a div (a drawn shape, not a control): swap
  // it for a real textarea that keeps the placeholder.
  const drawnField = compose.querySelector('.field');
  const textarea = h('textarea', {
    class: 'field', rows: '1', maxlength: '1000',
    placeholder: drawnField.textContent.trim(), 'aria-label': 'Add a comment',
  });
  drawnField.replaceWith(textarea);
  const postButton = compose.querySelector('.btn-primary');

  let item = null;
  let closedAt = null;
  let comments = [];

  cv2.querySelector('.back').addEventListener('click', closeDetail);

  async function run() {
    await states.run(async () => {
      const [got, closed] = await Promise.all([
        api('GET', `/api/decisions/${Number(id)}`),
        api('GET', '/api/decision-closures').catch(() => ({ closures: [] })),
      ]);
      item = got.item;
      comments = got.comments;
      closedAt = new Map(closed.closures.map((c) => [Number(c.id), c.closedAt])).get(Number(item.id)) || null;
      if (got.demo) showDemoLabel(cv2);
      fill();
      return true;
    });
  }

  function fill() {
    const t = tally(item.votes);
    fillIn(cv2, {
      'h1': item.title,
      '.by': byLine(item, closedAt),
      '.body': { text: item.body || '', hidden: !item.body },
    });
    opts.replaceChildren(...t.options.map((o) => optButton(o, t)));
    sum.textContent = summaryText(t);
    // Close as decided: the author only, and only while it is open.
    closeButton.hidden = !(item.byMe && !closedAt);
    if (!closeButton.hidden) closeButton.onclick = () => confirmClose();
    // Comments, oldest first, into the drawn list.
    commentsList.replaceChildren(...comments.map((c) => commentRowEl(c)));
    commentsList.hidden = comments.length === 0;
    noneEl.hidden = comments.length !== 0;
    postButton.disabled = !textarea.value.trim();
  }

  function optButton(o, t) {
    const btn = optTpl.cloneNode(true);
    const marked = !!o.chosen; // the check is your vote, never the leader
    btn.classList.toggle('on', !!marked);
    btn.setAttribute('aria-pressed', marked ? 'true' : 'false');
    btn.setAttribute('aria-label', `${o.label}: ${plural(o.count, 'vote')}`);
    const i = document.createElement('i');
    if (marked) {
      i.className = 'chk';
      i.append(checkSvg.cloneNode(true));
    } else {
      i.className = 'ring';
    }
    btn.querySelector('span:not(.n)').replaceChildren(i, o.label);
    btn.querySelector('.fill').style.width = `${o.percent}%`;
    btn.querySelector('.n').textContent = o.count ? plural(o.count, 'vote') : 'No votes';
    if (closedAt) btn.disabled = true;
    else btn.addEventListener('click', () => vote(o.id));
    return btn;
  }

  function summaryText(t) {
    if (closedAt) {
      if (t.tied) return `Closed. It was a tie, ${plural(t.total, 'vote')}.`;
      return `Closed. ${t.options.find((o) => o.leading).label} stands as the decision, ${plural(t.total, 'vote')}.`;
    }
    const line = voteSummary(t);
    return t.mine != null ? `${line}. Tap your choice again to take it back.` : `${line}.`;
  }

  async function vote(optionId) {
    const before = tally(item.votes);
    const next = applyVote(before, optionId);
    paint(next);
    try {
      const { item: saved } = await api('POST', `/api/decisions/${Number(item.id)}/vote`, { option: next.mine });
      item = saved;
      paint(tally(saved.votes));
    } catch (err) {
      toast(err.message);
      if (err.status === 409) { await run(); return; } // closed meanwhile: show it closed
      paint(before);
    }
  }

  function paint(t) {
    opts.replaceChildren(...t.options.map((o) => optButton(o, t)));
    sum.textContent = summaryText(t);
  }

  function commentRowEl(c) {
    const row = commentRow();
    fillIn(row, {
      '.c b': c.byMe ? 'You' : c.author,
      '.c small': timeAgo(c.createdAt),
      '.c p': c.body,
    });
    const more = row.querySelector('.more');
    more.setAttribute('aria-label', c.byMe ? 'More: delete your comment' : 'More: report this comment');
    more.addEventListener('click', () => {
      showMenu(more, c.byMe
        ? [{ label: 'Delete comment', destructive: true, handler: () => removeComment(c, row) }]
        : [{ label: 'Report', handler: () => report('comment', c.id) }]);
    });
    return row;
  }

  async function removeComment(c, row) {
    if (!(await confirm('Delete this comment?', 'This cannot be undone.', 'Delete comment'))) return;
    try {
      await api('DELETE', `/api/decisions/${Number(item.id)}/comments/${Number(c.id)}`);
      row.remove();
      comments = comments.filter((x) => x.id !== c.id);
      commentsList.hidden = comments.length === 0;
      noneEl.hidden = comments.length !== 0;
      toast('Comment deleted');
    } catch (err) {
      toast(err.message);
    }
  }

  async function confirmClose() {
    if (!(await confirm('Close as decided?',
      'Voting stops and the leading option stands as the decision.', 'Close as decided'))) return;
    try {
      const { closedAt: at } = await api('POST', `/api/decisions/${Number(item.id)}/close`, {});
      closedAt = at;
      closures.set(Number(item.id), at);
      fill();
      toast('Closed as decided');
    } catch (err) {
      toast(err.message);
    }
  }

  // The decision's ⋯ menu: the author can delete it, anyone can report it.
  cv2.querySelector('.nav .more').addEventListener('click', (e) => {
    showMenu(e.currentTarget, item.byMe
      ? [{ label: 'Delete decision', destructive: true, handler: () => removeDecision() }]
      : [{ label: 'Report', handler: () => report('decision', item.id) }]);
  });

  async function removeDecision() {
    if (!(await confirm('Delete this decision?', 'Its votes and comments go with it.', 'Delete decision'))) return;
    try {
      await api('DELETE', `/api/decisions/${Number(item.id)}`);
      toast('Decision deleted');
      await closeDetail();
    } catch (err) {
      toast(err.message);
    }
  }

  // The composer: Post shares the drawn button; Ctrl or Cmd + Enter posts too.
  textarea.addEventListener('input', () => { postButton.disabled = !textarea.value.trim(); });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); postComment(); }
  });
  postButton.addEventListener('click', postComment);

  async function postComment() {
    const body = textarea.value.trim();
    if (!body) return;
    postButton.disabled = true;
    try {
      const { comment } = await api('POST', `/api/decisions/${Number(item.id)}/comments`, { body });
      comments.push(comment);
      commentsList.append(commentRowEl(comment));
      commentsList.hidden = false;
      noneEl.hidden = true;
      textarea.value = '';
    } catch (err) {
      toast(err.message);
    } finally {
      postButton.disabled = !textarea.value.trim();
    }
  }

  await swap(() => { listRoot.hidden = true; detailRoot.hidden = false; }, 'push');
  await run();
}

async function closeDetail() {
  await swap(() => { detailRoot.hidden = true; listRoot.hidden = false; }, 'pop');
  listStates.run(loadList);
}

// ── Sheets, menus, confirmations ────────────────────────────────────────────

function newDecision() {
  openFormSheet({
    title: 'New decision',
    values: { choices: ['', ''] },
    fields: [
      { name: 'title', label: 'Question', type: 'text', required: true, max: 120, placeholder: 'e.g. Where should we meet in November?' },
      { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'Anything people need to know before they vote (optional)' },
      {
        // No `max` here: the sheet's choices rows would also take it as an
        // input maxlength and cut the option names to six characters. The
        // sheet itself stops at six options (its own default), and the
        // server's answer is the backstop beyond that.
        name: 'choices', label: 'Options', type: 'choices', min: 0,
        placeholder: ['e.g. Library room B', 'e.g. Cafe Ostra'],
        hint: 'Leave the options empty for a plain Yes or No vote.',
      },
    ],
    submitLabel: 'Post decision',
    savedMessage: 'Decision posted',
    onSubmit: async ({ title, body, choices }) => {
      await api('POST', '/api/decisions', { title, body, options: choices.length ? choices : undefined });
      listStates.run(loadList);
    },
  });
}

/** The ⋯ action sheet: unNative.menu when it is loaded, the kit's sheet otherwise. */
async function showMenu(anchor, items) {
  const un = await loadNative();
  if (un && typeof un.menu === 'function') {
    await un.menu({ anchorEl: anchor, items });
    return;
  }
  const { openSheet } = await import('/kit/sheet.js');
  await openSheet({
    title: 'More',
    content: (body, close) => {
      for (const it of items) {
        body.append(h('button', {
          type: 'button',
          class: `btn-secondary ${it.destructive ? 'text-danger' : ''}`,
          style: 'justify-content:flex-start;margin-bottom:8px',
          on: { click: () => { close(); if (it.handler) it.handler(); } },
        }, it.label));
      }
    },
  });
}

/** A confirmation: unNative.alert when it is loaded, the kit's sheet otherwise. Resolves true on confirm. */
async function confirm(title, message, actionLabel) {
  const un = await loadNative();
  if (un && typeof un.alert === 'function') {
    const out = await un.alert({
      title, message,
      buttons: [{ label: 'Cancel', style: 'cancel' }, { label: actionLabel, style: 'destructive' }],
    });
    const picked = out && out.button;
    return (picked && typeof picked === 'object' ? picked.label : picked) === actionLabel;
  }
  const { openSheet } = await import('/kit/sheet.js');
  return new Promise((resolve) => {
    openSheet({
      title,
      content: (body, close) => {
        if (message) body.append(h('p', { class: 'text-body text-muted' }, message));
        body.append(h('div', { class: 'kit-form-actions', style: 'margin-top:8px' },
          h('button', { type: 'button', class: 'btn-secondary', on: { click: () => { close(); resolve(false); } } }, 'Cancel'),
          h('button', { type: 'button', class: 'btn-primary', on: { click: () => { close(); resolve(true); } } }, actionLabel)));
      },
      onClose: () => resolve(false),
    });
  });
}

/** Tell the platform someone reported a decision or comment. */
async function report(kind, id) {
  try {
    await api('POST', '/api/reports', { kind, id });
    toast('Thanks, this was reported.');
  } catch (err) {
    toast(err.message);
  }
}

/** The screen change: unNative.transition (push/pop) when it is loaded. */
async function swap(fn, type) {
  const un = await loadNative();
  if (un && typeof un.transition === 'function') return un.transition(fn, { type });
  fn();
}

listStates.run(loadList);
