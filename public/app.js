// Club Votes: a club decision board. Anyone posts something to decide,
// everyone votes (one vote per person, changeable), comments go under each
// decision, and the poster closes it; the winner then stays visible.
// The list screen is the drawn markup in public/index.html, filled in here.
import { h, clear, api, timeAgo, isDemo } from './kit/dom.js';
import { rowsFrom, fillIn } from './kit/fill.js';
import { createStates } from './kit/states.js';
import { renderDetail } from './kit/list.js';
import { renderVotes } from './kit/votes.js';
import { renderComments } from './kit/comments.js';
import { openFormSheet, openSheet } from './kit/sheet.js';
import { tally } from './kit/tally.js';
import { toast, loadNative } from './kit/native.js';
import { showDemoLabel } from './kit/demo.js';

const listScreen = document.getElementById('list-screen');
const detailScreen = document.getElementById('detail-screen');
const listEl = document.getElementById('decision-list');
const makeRow = rowsFrom(listEl);

let items = [];
let signedIn = false;
let currentId = null;

// ── The list ────────────────────────────────────────────────────────────────

const states = createStates(document.getElementById('decisions'), {
  rows: 4,
  empty: {
    title: 'No decisions yet',
    text: 'Post the first thing for the club to decide.',
    action: { label: 'Post a decision', primary: true, onClick: newDecision },
  },
  error: {
    title: 'Decisions did not load',
    text: 'Nothing is lost. Check the connection and try again.',
  },
});

const load = () => states.run(async (box) => {
  mountList(box);
  const data = await api('GET', '/api/decisions');
  setViewer(data.user);
  if (data.demo) showDemoLabel(box);
  items = data.items;
  drawList();
  headerActionAsFilled(items.length > 0);
  return items.length > 0;
});

/** The drawn list screen lives inside the states' content once loaded. */
function mountList(box) {
  if (listScreen.parentElement !== box) box.append(listScreen);
}

/** In the empty state, "Post a decision" is the only filled button, so the
 * header's New decision steps down to secondary until there is content. */
function headerActionAsFilled(filled) {
  const btn = document.getElementById('new-decision');
  btn.classList.toggle('btn-primary', filled);
  btn.classList.toggle('btn-secondary', !filled);
}

function drawList() {
  clear(listEl);
  for (const it of items) listEl.append(rowEl(it));
}

function rowEl(it) {
  const t = tally(it.votes);
  const mine = t.options.find((o) => o.id === t.mine);
  const closed = !!it.closedAt;
  const li = makeRow();
  fillIn(li, {
    '.cv-q': it.title,
    '.lead': { hidden: closed, text: leadLine(t) },
    '.won': { hidden: !closed },
    '.cv-won': wonLine(t),
    '.bar': { children: barSegs(t) },
    '.cv-when': timeAgo(it.createdAt),
    '.cv-count': String(it.commentCount),
    '.cv-by': it.author,
    '.you': { hidden: !mine, children: ['You voted ', h('b', { class: 'cv-your' }, mine ? mine.label : '')] },
    '.tag': { hidden: !closed },
    '.cv-more': { hidden: !signedIn },
    '': {
      class: { closed },
      on: { click: (e) => { if (!e.target.closest('button')) openDetail(it.id); } },
    },
  });
  li.querySelector('.cv-more').addEventListener('click', (e) => {
    e.stopPropagation();
    decisionMenu(it, e.currentTarget);
  });
  return li;
}

/** "Salsa leads with 7 of 12 votes", "Tied at 4", "No votes yet". */
function leadLine(t) {
  if (!t.total) return 'No votes yet';
  if (t.tied) return `Tied at ${t.options[0].count}`;
  const lead = t.options.find((o) => o.leading);
  return `${lead.label} leads with ${lead.count} of ${t.total} votes`;
}

/** A closed row's winner line, in place of the lead. */
function wonLine(t) {
  if (!t.total) return 'Closed with no votes';
  if (t.tied) return 'Closed in a tie';
  const lead = t.options.find((o) => o.leading);
  return `${lead.label} won with ${lead.count} of ${t.total} votes`;
}

/** The tally bar's segments: one per option with votes, largest first so the
 * leader starts at the left, the leader in accent. */
function barSegs(t) {
  return t.options.filter((o) => o.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((o) => h('i', { class: o.leading ? 'top' : null, style: `flex-grow:${o.count}` }));
}

function setViewer(user) {
  signedIn = !!(user && user.id != null);
  for (const el of document.querySelectorAll('[data-guest]')) {
    el.hidden = (el.dataset.guest === 'show') === signedIn;
  }
}

/** Put an updated decision back in the list and redraw it. */
function replaceItem(saved) {
  const at = items.findIndex((x) => x.id === saved.id);
  if (at >= 0) items[at] = saved;
  else items.unshift(saved);
  drawList();
}

// ── The detail screen ───────────────────────────────────────────────────────

const detailStates = createStates(detailScreen, {
  rows: 3,
  error: {
    title: 'This decision did not load',
    text: 'Nothing is lost. Check the connection and try again.',
  },
});

function openDetail(id) {
  currentId = id;
  listScreen.hidden = true;
  detailScreen.hidden = false;
  detailStates.run(async (box) => {
    const data = await api('GET', `/api/decisions/${id}`);
    setViewer(data.user);
    renderDetailInto(box, data);
    return true;
  });
}

function showList() {
  detailScreen.hidden = true;
  detailStates.loading(); // the next open starts fresh
  listScreen.hidden = false;
}

function renderDetailInto(box, data) {
  const it = data.item;
  const detail = renderDetail(box, {
    title: it.title,
    meta: `Posted by ${it.author}, ${timeAgo(it.createdAt)}`,
    body: it.body || null,
    onBack: showList,
  });

  // Votes. A closed decision shows its final counts, untouchable.
  const votesBox = detail.section('Votes');
  const locked = !!it.closedAt || !signedIn;
  if (!signedIn) votesBox.append(h('p', { class: 'text-small text-muted' }, 'Sign in to vote or comment.'));
  const votesHolder = h('div');
  votesBox.append(votesHolder);
  renderVotes(votesHolder, {
    ...it.votes,
    label: 'Vote on this decision',
    layout: it.votes.options.length === 2 ? 'row' : 'stack',
    onVote: locked ? undefined : (mine) => saveVote(it, mine),
  });
  if (locked) for (const b of votesHolder.querySelectorAll('.kit-vote')) b.disabled = true;
  if (it.byMe && !it.closedAt) {
    votesBox.append(h('button', { type: 'button', class: 'btn-secondary self-start', on: { click: () => closeDecision(it) } }, 'Close decision'));
  }

  // Comments, oldest first, with a More menu on each row.
  const commentsBox = detail.section('Comments');
  const thread = renderComments(commentsBox, {
    comments: data.comments,
    onAdd: signedIn ? (body) => saveComment(it, body) : undefined,
    menu: signedIn ? (c, anchorEl) => commentMenu(it, c, anchorEl, thread) : undefined,
    label: 'Add a comment',
    placeholder: 'e.g. I can bring the projector',
    emptyText: 'No comments yet. Say what you think.',
  });
  detail.focus();
}

/** onVote hands us the viewer's new choice (the option id, or null to take it back). */
async function saveVote(it, mine) {
  const saved = (await api('POST', `/api/decisions/${it.id}/vote`, { option: mine })).item;
  replaceItem(saved);
  return saved.votes;
}

async function saveComment(it, body) {
  const saved = (await api('POST', `/api/decisions/${it.id}/comments`, { body })).comment;
  replaceItem({ ...it, commentCount: it.commentCount + 1 });
  return saved;
}

async function closeDecision(it) {
  try {
    const saved = (await api('POST', `/api/decisions/${it.id}/close`)).item;
    replaceItem(saved);
    toast('Decision closed');
    openDetail(saved.id);
  } catch (err) {
    toast(err.message);
  }
}

// ── New decision ────────────────────────────────────────────────────────────

function newDecision() {
  openFormSheet({
    title: 'New decision',
    submitLabel: 'Post',
    savedMessage: 'Decision posted',
    fields: [
      { name: 'title', label: 'Question', type: 'text', required: true, max: 120, placeholder: 'e.g. Where should we meet in November?' },
      // No `max` here: in the kit's choices field it would also cap each
      // option's characters (it reads f.max as an input maxlength). Six
      // options is the kit's own default, and the server rejects more.
      { name: 'options', label: 'Options', type: 'choices', min: 0, hint: 'Leave empty for a plain Yes or No.', placeholder: ['e.g. The community hall', 'e.g. Online'] },
      { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'Anything people should know before voting' },
    ],
    onSubmit: async (v) => {
      const saved = (await api('POST', '/api/decisions', {
        title: v.title,
        options: v.options.length ? v.options : null,
        body: v.body,
      })).item;
      items.unshift(saved);
      mountList(states.content);
      drawList();
      headerActionAsFilled(true);
      states.ready(); // also lifts the empty state if this was the first
    },
  });
}

// ── More menus: report, delete ──────────────────────────────────────────────

async function decisionMenu(it, anchorEl) {
  const menuItems = [{ label: 'Report', handler: () => report('decision', it.id) }];
  if (it.byMe) menuItems.push({ label: 'Delete', handler: () => deleteDecision(it) });
  openMenu({ title: it.title, anchorEl, items: menuItems });
}

async function commentMenu(it, c, anchorEl, thread) {
  const menuItems = [{ label: 'Report', handler: () => report('comment', c.id) }];
  if (c.byMe) menuItems.push({ label: 'Delete', handler: () => deleteComment(it, c, thread) });
  openMenu({ title: 'This comment', anchorEl, items: menuItems });
}

/** unNative.menu when it loaded, else the same choices in a sheet. */
async function openMenu({ title, anchorEl, items: menuItems }) {
  const un = await loadNative();
  if (un && typeof un.menu === 'function') {
    un.menu({ anchorEl, title, items: menuItems });
    return;
  }
  openSheet({
    title: 'More',
    returnFocus: anchorEl,
    content: (body, close) => {
      for (const item of menuItems) {
        body.append(h('button', { type: 'button', class: 'btn-secondary w-full', on: { click: () => { close(); item.handler(); } } }, item.label));
      }
    },
  });
}

async function report(kind, id) {
  try {
    await api('POST', '/api/reports', { kind, id });
    toast('Reported');
  } catch (err) {
    toast(err.message);
  }
}

async function deleteDecision(it) {
  const sure = await confirmAction({
    title: 'Delete this decision?',
    message: 'Its votes and comments go with it. This cannot be undone.',
    confirmLabel: 'Delete',
  });
  if (!sure) return;
  try {
    await api('DELETE', `/api/decisions/${it.id}`);
    items = items.filter((x) => x.id !== it.id);
    toast('Deleted');
    if (!detailScreen.hidden && currentId === it.id) showList();
    if (!items.length) { states.empty(); headerActionAsFilled(false); } else { drawList(); }
  } catch (err) {
    toast(err.message);
  }
}

async function deleteComment(it, c, thread) {
  const sure = await confirmAction({
    title: 'Delete this comment?',
    message: 'This cannot be undone.',
    confirmLabel: 'Delete',
  });
  if (!sure) return;
  try {
    await api('DELETE', `/api/decisions/${it.id}/comments/${c.id}`);
    thread.remove(c.id);
    replaceItem({ ...it, commentCount: Math.max(0, it.commentCount - 1) });
    toast('Deleted');
  } catch (err) {
    toast(err.message);
  }
}

/** unNative.alert with Cancel and one destructive button; true when chosen. */
async function confirmAction({ title, message, confirmLabel }) {
  const un = await loadNative();
  if (un && typeof un.alert === 'function') {
    const r = await un.alert({
      title, message,
      buttons: [
        { label: 'Cancel', style: 'cancel' },
        { label: confirmLabel, style: 'destructive' },
      ],
    });
    const chosen = r && (typeof r.button === 'string' ? r.button : r.value);
    return chosen === confirmLabel || (r && r.button === 1) || false;
  }
  // The native kit is missing: the same two buttons in a sheet.
  let ok = false;
  await openSheet({
    title,
    content: (body, close) => {
      if (message) body.append(h('p', { class: 'text-body text-muted' }, message));
      body.append(h('div', { class: 'kit-form-actions' },
        h('button', { type: 'button', class: 'btn-secondary', on: { click: close } }, 'Cancel'),
        h('button', { type: 'button', class: 'btn-primary', on: { click: () => { ok = true; close(); } } }, confirmLabel)));
    },
  });
  return ok;
}

// ── Go ──────────────────────────────────────────────────────────────────────

document.getElementById('new-decision').addEventListener('click', newDecision);
load();
