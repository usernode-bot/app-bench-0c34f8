// Club Votes: the club's question board.
//
// Screen 1 (the board) is the markup the spec drew in public/index.html:
// rowsFrom keeps one drawn row as the row to copy, and every row is filled
// from the API with real data. Screen 2 (a question) is rendered here with
// the structure the spec drew — back link, "Your vote", "Comments" — using
// the kit's vote and comment pieces, so a vote is one tap and changeable,
// and every post shows who voted and who said what.

import { api, h, clear, icon, plural, timeAgo } from '/kit/dom.js';
import { native } from '/kit/native.js';
import { createStates } from '/kit/states.js';
import { rowsFrom, groupsFrom } from '/kit/fill.js';
import { tally } from '/kit/tally.js';
import { renderVotes } from '/kit/votes.js';
import { renderComments } from '/kit/comments.js';
import { openFormSheet } from '/kit/sheet.js';
import { showDemoLabel } from '/kit/demo.js';

const app = document.getElementById('app');
const listView = document.getElementById('list-view');
const headCount = document.getElementById('head-count');
const board = document.getElementById('board');

// The drawn row and the drawn heading+list, taken before anything renders.
const row = rowsFrom(document.getElementById('list'));
const group = groupsFrom(board, '.section-label', '#list');

// ── The question screen ───────────────────────────────────────────────────
// Built once, from the drawn structure; filled in for each question.
const detailBoard = h('div');
const detailView = h('div', { id: 'detail-view', hidden: true },
  h('button', { type: 'button', class: 'back', on: { click: closeQuestion } }, icon('back'), 'Questions'),
  detailBoard,
);
app.append(detailView);

const detailStates = createStates(detailBoard, {
  rows: 3,
  error: { title: 'Question did not load', text: 'Nothing you posted is lost. Try again in a moment.' },
});

let lastRow = null;

// ── The board ─────────────────────────────────────────────────────────────
const view = createStates(board, {
  rows: 4,
  empty: {
    title: 'No questions yet',
    text: 'Ask the club the first thing it needs to decide.',
    // A secondary button here: the header keeps the one filled New question.
    action: { label: 'New question', onClick: openNewQuestion },
  },
  error: { title: 'Questions did not load', text: 'Nothing you posted is lost. Try again in a moment.' },
});

async function load() {
  await view.run(async (box) => {
    clear(box);
    const data = await api('GET', '/api/questions');
    if (data.demo) showDemoLabel(app);
    headCount.textContent = plural(data.items.length, 'open question');
    if (!data.items.length) return false;
    const g = group('Open questions, newest first');
    g.list.append(...data.items.map(questionRow));
    box.append(g.heading, g.list);
  });
}

function questionRow(q) {
  const t = tally(q.votes);
  const li = row();
  const title = li.querySelector('.kit-row-title');
  const lead = li.querySelector('.lead');
  const tallyBox = li.querySelector('.tally');
  const mine = li.querySelector('.mine');
  title.textContent = q.title;
  if (t.total) {
    lead.hidden = false;
    lead.replaceChildren(...leadLine(t));
    li.querySelector('.tally-marks').replaceChildren(...tallyMarks(t.total));
    li.querySelector('.tally-count').textContent = plural(t.total, 'vote');
  } else {
    lead.hidden = true;
    // The You-voted tick lives in the tally line; keep it when it is replaced.
    tallyBox.replaceChildren(h('span', { class: 'tally-none' }, 'No votes yet'), mine);
  }
  mine.hidden = q.votes.mine == null;
  li.querySelector('.author').textContent = `${q.author}, ${timeAgo(q.createdAt)}`;
  const comments = li.querySelector('.comments');
  comments.replaceChildren(
    comments.querySelector('svg'),
    q.commentCount ? plural(q.commentCount, 'comment') : 'No comments',
  );
  li.querySelector('button').addEventListener('click', () => openQuestion(q.id, li));
  return li;
}

// "Leading: Library back room, 7 of 12", or the tie it says it is.
function leadLine(t) {
  const leaders = t.options.filter((o) => o.leading);
  if (t.tied) {
    const parts = ['Tied: '];
    leaders.forEach((o, i) => {
      if (i) parts.push(i === leaders.length - 1 ? ' and ' : ', ');
      parts.push(h('b', {}, o.label));
    });
    parts.push(`, ${leaders[0].count} each`);
    return parts;
  }
  return ['Leading: ', h('b', {}, leaders[0].label), `, ${leaders[0].count} of ${t.total}`];
}

// ── The tally: votes drawn as hand-counted ballot marks ───────────────────
// Each group of five is one SVG, four upright strokes crossed by a fifth;
// the rest are single strokes. At most six groups are drawn (the count is
// always shown beside them), so a busy question stays a row, not a poster.
const GROUP_OF_FIVE = 'M3 2v12M7.5 2v12M12 2v12M16.5 2v12M1 12L20 4';
const SINGLE_STROKES = ['M3 2v12', 'M7.5 2v12', 'M12 2v12', 'M16.5 2v12'];

function tallyMarks(total) {
  const marks = [];
  const groups = Math.min(Math.floor(total / 5), 6);
  for (let i = 0; i < groups; i += 1) marks.push(markSvg(GROUP_OF_FIVE));
  const singles = total - groups * 5;
  if (groups < 6 && singles > 0) marks.push(markSvg(SINGLE_STROKES.slice(0, singles).join('')));
  return marks;
}

function markSvg(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 22 16', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.8', 'stroke-linecap': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

// ── Sheets: the new question, and a report ────────────────────────────────
document.getElementById('new-question').addEventListener('click', openNewQuestion);

function openNewQuestion() {
  openFormSheet({
    title: 'New question',
    submitLabel: 'Post question',
    savedMessage: 'Question posted',
    fields: [
      { name: 'title', label: 'Question', required: true, max: 140, placeholder: 'e.g. Where should we meet in November?' },
      { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'e.g. Anything the club should know before voting.' },
      {
        name: 'options', label: 'Choices', type: 'choices', min: 0, max: 6,
        placeholder: ['e.g. Library back room', 'e.g. Cafe on Elm Street'],
        hint: 'Leave these empty and the question gets a Yes and a No.',
      },
    ],
    onSubmit: async (values) => {
      await api('POST', '/api/questions', { title: values.title, body: values.body, options: values.options });
      load();
    },
  });
}

function reportLink(kind, targetId) {
  return h('button', {
    type: 'button', class: 'report',
    on: { click: () => openReport(kind, targetId) },
  }, flagSvg(), 'Report');
}

function openReport(kind, targetId) {
  openFormSheet({
    title: 'Report',
    submitLabel: 'Send report',
    savedMessage: 'Report sent',
    fields: [
      { name: 'reason', label: 'Reason', type: 'textarea', max: 500, placeholder: 'e.g. Say what is wrong with this post.' },
    ],
    onSubmit: async (values) => {
      await api('POST', '/api/reports', { kind, targetId, reason: values.reason });
    },
  });
}

function flagSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M5 21V4h11l-2 4 2 4H5');
  svg.append(path);
  return svg;
}

// ── Opening a question ────────────────────────────────────────────────────
function openQuestion(id, rowEl) {
  lastRow = rowEl || null;
  swap('push');
  detailStates.run(async (box) => {
    const data = await api('GET', `/api/questions/${id}`);
    if (data.demo) showDemoLabel(app);
    renderQuestion(box, data.item, data.comments);
  });
}

function closeQuestion() {
  swap('pop');
}

// List to question and back, with the platform's push and pop transitions
// when the native kit is there, plain showing and hiding when it is not.
function swap(type) {
  const un = native();
  const go = () => {
    listView.hidden = type === 'push';
    detailView.hidden = type !== 'push';
    if (type !== 'push' && lastRow) {
      lastRow.querySelector('button').focus();
      lastRow = null;
    }
  };
  if (un && typeof un.transition === 'function') {
    try {
      un.transition(go, { type });
      return;
    } catch { /* fall back to the plain swap below */ }
  }
  go();
}

function renderQuestion(box, item, comments) {
  clear(box);
  const votesBox = h('div');
  const commentsBox = h('div');
  box.append(
    h('div', { class: 'kit-detail-head' },
      h('h1', { class: 'text-heading' }, item.title),
      h('div', { class: 'headrow' },
        h('p', { class: 'text-small muted' }, `Asked by ${item.author}, ${timeAgo(item.createdAt)}`),
        reportLink('question', item.id),
      ),
      item.body ? h('p', { class: 'kit-detail-body' }, item.body) : null,
    ),
    h('section', {}, h('h2', { class: 'section-label' }, 'Your vote'), votesBox),
    h('section', {}, h('h2', { class: 'section-label' }, 'Comments'), commentsBox),
  );

  renderVotes(votesBox, {
    ...item.votes,
    label: `Vote on ${item.title}`,
    layout: 'stack',
    onVote: async (option) => {
      const saved = await api('POST', `/api/questions/${item.id}/vote`, { option });
      drawVoters(votesBox.querySelector('.kit-votes'), item.id);
      return saved.item.votes;
    },
  });
  drawVoters(votesBox.querySelector('.kit-votes'), item.id);

  renderComments(commentsBox, {
    comments,
    placeholder: 'e.g. The library works for me on weekends',
    emptyText: 'No comments yet. Say what you think.',
    onAdd: async (body) => (await api('POST', `/api/questions/${item.id}/comments`, { body })).comment,
  });
  decorateReports(commentsBox);
  // A comment posted here joins the thread; its row needs its Report link
  // too, so watch for new rows rather than decorating once.
  new MutationObserver(() => decorateReports(commentsBox))
    .observe(commentsBox, { childList: true, subtree: true });
}

// Under each choice, the names of the people who picked it: "You" first,
// then up to four names, and "and N more" when there are more.
async function drawVoters(votesGroup, id) {
  if (!votesGroup) return;
  let voters;
  try {
    voters = (await api('GET', `/api/questions/${id}/voters`)).voters;
  } catch { return; }
  for (const p of [...votesGroup.querySelectorAll(':scope > p.voters')]) p.remove();
  const byOption = new Map();
  for (const v of voters) {
    if (!byOption.has(v.optionId)) byOption.set(v.optionId, []);
    byOption.get(v.optionId).push(v);
  }
  for (const [optionId, names] of byOption) {
    names.sort((a, b) => (b.isMe ? 1 : 0) - (a.isMe ? 1 : 0));
    const shown = names.slice(0, 4).map((v) => (v.isMe ? 'You' : v.name));
    const more = names.length - shown.length;
    let text = shown.join(', ');
    if (more > 0) text += ` and ${plural(more, 'other')}`;
    const button = votesGroup.querySelector(`button[data-option="${optionId}"]`);
    if (button) button.after(h('p', { class: 'voters' }, text));
  }
}

function decorateReports(commentsBox) {
  for (const li of commentsBox.querySelectorAll('li[data-id]')) {
    if (li.querySelector('.report')) continue;
    const meta = li.querySelector('.kit-comment-meta');
    if (meta) meta.append(reportLink('comment', Number(li.dataset.id)));
  }
}

load();