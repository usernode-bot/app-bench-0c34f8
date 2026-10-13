// Club Votes, one page. Screen 1 (the list) and screen 2 (a question) were
// drawn by the plan and are carried in index.html; this file renders real
// data into that markup rather than rebuilding it (see kit/fill.js). The
// list loads with kit/states.js (skeleton, empty, error with Try again);
// rows open the question view, where the ballot comes from kit/votes.js and
// the thread from kit/comments.js. Reporting asks first and hides the post;
// #q/<id> in the address bar opens that question.
import { api, h, clear, plural, timeAgo } from './kit/dom.js';
import { createStates } from './kit/states.js';
import { renderVotes } from './kit/votes.js';
import { renderComments } from './kit/comments.js';
import { openFormSheet } from './kit/sheet.js';
import { tally, percents, voteSummary } from './kit/tally.js';
import { showDemoLabel } from './kit/demo.js';
import { rowsFrom, fillIn, screen } from './kit/fill.js';
import { loadNative, toast } from './kit/native.js';

const app = document.getElementById('app');
const listScreen = document.querySelector('[data-spec-screen="1"]');
const questionEl = document.getElementById('question');
const questionsEl = document.getElementById('questions');
const qCount = document.getElementById('q-count');
const newButton = document.getElementById('new-question');
const DEMO_TEXT = 'Staging demo: the people and questions here are made up.';
const REPORT_MESSAGE = 'It will be hidden for you, and for everyone once a few people report it.';

// ── The list ──────────────────────────────────────────────────────────────

const listEl = questionsEl.querySelector('ul.list');
const rowMake = rowsFrom(listEl); // keeps one drawn row to copy, drops the samples

let items = [];

// One list row, the drawn markup filled from a question: title, the tally
// bar split by percents(), counts, the comment bubble, and a status —
// "You voted Yes", "Asked by you", "Tied", or "No votes yet".
function questionRow(q) {
  const t = tally(q.votes);
  const [yes, no] = q.votes.options;
  const li = rowMake();
  const button = li.querySelector('button.list-row');
  const textEl = li.querySelector('.kit-row-text');
  const titleEl = li.querySelector('.kit-row-title');
  const tallyEl = li.querySelector('.tally');
  const metaEl = li.querySelector('.meta');
  const icEl = li.querySelector('.ic');
  const mineEl = li.querySelector('.mine');
  li.dataset.id = q.id;
  titleEl.textContent = q.title;

  let bar;
  if (t.total) {
    const [py, pn] = percents([yes.count, no.count]);
    bar = h('span', { class: 'tally', role: 'img', 'aria-label': `Yes ${yes.count}, No ${no.count}` },
      h('span', { class: 'tally-yes', style: `flex:${py}` }),
      h('span', { class: 'tally-no', style: `flex:${pn}` }));
  } else {
    bar = h('span', { class: 'tally-empty' });
  }

  const kids = [];
  if (t.total) {
    kids.push(h('span', {},
      h('span', { class: 'yes' }, 'Yes ', h('span', { class: 'n' }, String(yes.count))),
      ' · ',
      h('span', { class: 'no' }, 'No ', h('span', { class: 'n' }, String(no.count)))));
  } else {
    kids.push(h('span', {}, 'No votes yet'));
  }
  icEl.setAttribute('role', 'img');
  icEl.setAttribute('aria-label', plural(q.commentCount, 'comment'));
  icEl.querySelector('.n').textContent = String(q.commentCount);
  kids.push(icEl);
  if (q.votes.mine != null) {
    const label = `You voted ${q.votes.options.find((o) => o.id === q.votes.mine).label}`;
    [...mineEl.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).forEach((n) => n.remove());
    mineEl.append(label);
    kids.push(mineEl);
  } else if (q.byMe) {
    kids.push(h('span', {}, 'Asked by you'));
  } else if (t.total && t.leaders.length === 2) {
    kids.push(h('span', {}, 'Tied'));
  }
  clear(metaEl).append(...kids);
  clear(textEl).append(titleEl, bar, metaEl);
  button.addEventListener('click', () => openQuestion(q.id, button));
  return li;
}

function renderRows() {
  clear(listEl).append(...items.map(questionRow));
}

const view = createStates(questionsEl, {
  rows: 5,
  empty: {
    title: 'No questions yet',
    text: 'Ask the first thing the club needs to decide.',
    action: { label: 'New question', onClick: () => openNew() },
  },
  error: {
    title: 'Questions did not load',
    text: 'Nothing you posted is lost. Try again in a moment.',
  },
});

async function load() {
  return view.run(async (content) => {
    const data = await api('GET', '/api/questions');
    items = data.questions;
    if (data.demo) showDemoLabel(app, DEMO_TEXT);
    qCount.textContent = String(items.length);
    if (!items.length) return false;
    renderRows();
    content.append(listEl);
    return true;
  });
}

// ── The question view ─────────────────────────────────────────────────────

questionEl.append(screen(2)); // a copy of the drawn detail screen
document.querySelector('template[data-spec-screen="2"]').remove();
const detail = questionEl.querySelector('.kit-detail');
const dBack = detail.querySelector('.kit-detail-head .btn-secondary');
const dTitle = detail.querySelector('h2.text-title');
const dBy = detail.querySelector('.byline');
const dByline = dBy.querySelector('span');
const dReport = dBy.querySelector('button.report');
const dBody = detail.querySelector('.kit-detail-body');
const voteSection = detail.querySelectorAll(':scope > section')[0];
const commentsSection = detail.querySelectorAll(':scope > section')[1];
const ballot = voteSection.querySelector('.ballot');
const commentsBox = h('div');
let commentsHead = commentsSection.querySelector('h3.section-label');
clear(commentsSection).append(commentsHead, commentsBox);

const loadingBlock = () => h('ul', { class: 'un-group kit-group', 'aria-busy': 'true' },
  h('li', { class: 'un-group-row kit-skeleton-row' },
    h('span', { class: 'skeleton h-4 w-3/4' }), h('span', { class: 'skeleton h-3 w-1/2' })),
  h('li', { class: 'un-group-row kit-skeleton-row' },
    h('span', { class: 'skeleton h-4 w-1/2' }), h('span', { class: 'skeleton h-3 w-1/3' })));

let currentId = null;
let currentQ = null;
let lastRow = null;

function summaryLine(q) {
  const t = tally(q.votes);
  if (t.mine == null) return voteSummary(t);
  const mine = q.votes.options.find((o) => o.id === t.mine).label;
  const other = q.votes.options.find((o) => o.id !== t.mine).label;
  return `${voteSummary(t)}. You voted ${mine}: tap ${other} to change it, or ${mine} again to take it back.`;
}

// The ballot: the big tally bar, its Yes/No key with percents, the two vote
// buttons (kit/votes.js), and the summary line. Rebuilt on every vote.
function drawBallot(q) {
  const t = tally(q.votes);
  const [yes, no] = q.votes.options;
  clear(ballot);
  const controls = renderVotes(ballot, {
    options: q.votes.options,
    mine: q.votes.mine,
    layout: 'row',
    summary: false,
    label: `Vote Yes or No on ${q.title}`,
    onVote: async (option) => {
      const res = await api('POST', `/api/questions/${q.id}/vote`, { option });
      const nq = res.question;
      const i = items.findIndex((x) => x.id === nq.id);
      if (i >= 0) items[i] = nq;
      renderRows();
      drawBallot(nq);
      return nq.votes;
    },
  });
  if (t.total) {
    const [py, pn] = percents([yes.count, no.count]);
    ballot.prepend(
      h('div', { class: 'tally-big', role: 'img', 'aria-label': `Yes ${yes.count}, No ${no.count}` },
        h('span', { class: 'tally-yes', style: `flex:${py}` }),
        h('span', { class: 'tally-no', style: `flex:${pn}` })),
      h('div', { class: 'tally-key' },
        h('span', { class: 'yes' }, 'Yes ', h('span', { class: 'n' }, String(yes.count)), ` · ${py}%`),
        h('span', { class: 'no' }, 'No ', h('span', { class: 'n' }, String(no.count)), ` · ${pn}%`)));
  } else {
    ballot.prepend(h('div', { class: 'tally-big' }, h('span', { class: 'tally-empty', style: 'flex:1' })));
  }
  ballot.append(h('p', { class: 'kit-vote-summary' }, summaryLine(q)));
  return controls;
}

function drawQuestion(data) {
  const q = data.question;
  currentQ = q;
  const i = items.findIndex((x) => x.id === q.id);
  if (i >= 0) items[i] = q;
  dTitle.textContent = q.title;
  dBy.hidden = false;
  dByline.textContent = q.byMe ? 'Asked by you' : `Asked by ${q.author}, ${timeAgo(q.createdAt)}`;
  dReport.hidden = !!q.byMe;
  dBody.hidden = !q.body;
  dBody.textContent = q.body;
  voteSection.hidden = false;
  commentsSection.hidden = false;
  drawBallot(q);
  const visible = data.comments.map((c) => ({ ...c, author: c.byMe ? 'You' : c.author }));
  renderComments(commentsBox, {
    comments: visible,
    max: 1000,
    label: 'Add a comment',
    postLabel: 'Post comment',
    emptyText: 'No comments yet. Start the thread.',
    onAdd: async (text) => {
      const res = await api('POST', `/api/questions/${q.id}/comments`, { body: text });
      bumpComments(q.id, 1);
      return { ...res.comment, author: 'You' };
    },
  });
  // A Report link on every comment that is not the viewer's own.
  for (const li of commentsBox.querySelectorAll('li[data-id]')) {
    const c = data.comments.find((x) => String(x.id) === li.dataset.id);
    if (!c || c.byMe) continue;
    li.querySelector('.kit-comment-meta').append(
      h('button', { type: 'button', class: 'report', on: { click: () => reportComment(c) } }, 'Report'));
  }
}

function bumpComments(id, by) {
  const item = items.find((x) => x.id === id);
  if (item) item.commentCount += by;
  renderRows();
}

async function openQuestion(id, focusRow) {
  currentId = id;
  currentQ = null;
  lastRow = focusRow || null;
  location.hash = `q/${id}`;
  listScreen.hidden = true;
  questionEl.hidden = false;
  window.scrollTo(0, 0);
  dTitle.textContent = 'Loading';
  dBy.hidden = true;
  dBody.hidden = true;
  voteSection.hidden = true;
  commentsSection.hidden = true;
  clear(ballot).append(loadingBlock());
  clear(commentsBox).append(loadingBlock());
  try {
    const data = await api('GET', `/api/questions/${id}`);
    if (currentId !== id) return;
    drawQuestion(data);
  } catch (err) {
    if (currentId !== id) return;
    dTitle.textContent = 'This question did not load';
    clear(ballot).append(h('div', { class: 'state-error', role: 'alert' },
      h('h2', { class: 'text-heading' },
        err.status === 404 ? 'This question was removed, or the link is wrong.' : 'This question did not load'),
      h('p', { class: 'text-body text-muted' }, 'Nothing you posted is lost, and All questions still works.'),
      h('button', { type: 'button', class: 'btn-secondary mt-2', on: { click: () => openQuestion(id) } }, 'Try again')));
  }
}

function goBack() {
  currentId = null;
  currentQ = null;
  questionEl.hidden = true;
  listScreen.hidden = false;
  if (location.hash) location.hash = '';
  if (lastRow) lastRow.focus();
}

dBack.addEventListener('click', goBack);

// Report this question: asks first, then hides it for the reporter and takes
// them back to the list (kit/un-native alert when the native kit loaded).
dReport.addEventListener('click', async () => {
  if (!currentQ) return;
  const q = currentQ;
  if (!await confirmReport('Report this question?')) return;
  try {
    await api('POST', `/api/questions/${q.id}/report`);
    items = items.filter((x) => x.id !== q.id);
    qCount.textContent = String(items.length);
    renderRows();
    toast('Reported. Thanks for flagging it.');
    goBack();
  } catch (err) {
    toast(err.message);
  }
});

async function reportComment(c) {
  if (!await confirmReport('Report this comment?')) return;
  try {
    await api('POST', `/api/comments/${c.id}/report`);
    const li = commentsBox.querySelector(`li[data-id="${c.id}"]`);
    if (li) li.remove();
    bumpComments(currentId, -1);
    toast('Reported. Thanks for flagging it.');
  } catch (err) {
    toast(err.message);
  }
}

let nativeKit = null;
async function confirmReport(title) {
  if (!nativeKit) nativeKit = await loadNative();
  if (nativeKit && typeof nativeKit.alert === 'function') {
    try {
      const choice = await nativeKit.alert({
        title, message: REPORT_MESSAGE,
        buttons: [{ label: 'Cancel' }, { label: 'Report', style: 'destructive' }],
      });
      return !!choice && !(choice && choice.label === 'Cancel');
    } catch {}
  }
  return window.confirm(`${title} ${REPORT_MESSAGE}`);
}

// ── New question (the one primary action) ─────────────────────────────────

function openNew() {
  return openFormSheet({
    title: 'New question',
    submitLabel: 'Post question',
    savedMessage: 'Question posted',
    returnFocus: newButton,
    fields: [
      { name: 'title', label: 'Question', required: true, max: 120, placeholder: 'e.g. Should we meet at the library on Thursdays?' },
      { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'e.g. The hall is raising its rate in January' },
    ],
    onSubmit: async (values) => {
      const res = await api('POST', '/api/questions', { title: values.title, body: values.body });
      items.unshift(res.question);
      qCount.textContent = String(items.length);
      renderRows();
    },
  });
}

newButton.addEventListener('click', openNew);

// ── The address bar: #q/<id> opens that question ──────────────────────────

const HASH = /^#q\/(\d+)$/;
window.addEventListener('hashchange', () => {
  const m = location.hash.match(HASH);
  if (m) {
    if (currentId !== Number(m[1])) openQuestion(Number(m[1]));
  } else if (currentId) {
    goBack();
  }
});

load().then(() => {
  const m = location.hash.match(HASH);
  if (m) openQuestion(Number(m[1]));
});
