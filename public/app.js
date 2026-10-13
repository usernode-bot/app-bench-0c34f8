// Club Votes: the club's open questions, everyone's votes, and the talk
// under each one. The screens the spec drew fill with real data (fill.js);
// votes, comments, sheets and toasts come from the platform's kit; the tally
// bar is this app's signature, and it fills against everyone who has voted
// on any question here, never against the whole club.
import { h, api, plural, timeAgo, clear } from '/kit/dom.js';
import { loadNative, native, toast } from '/kit/native.js';
import { createStates } from '/kit/states.js';
import { fillIn, rowsFrom } from '/kit/fill.js';
import { renderVotes } from '/kit/votes.js';
import { tally } from '/kit/tally.js';
import { renderComments } from '/kit/comments.js';
import { openFormSheet } from '/kit/sheet.js';
import { showDemoLabel } from '/kit/demo.js';

const listRoot = document.querySelector('[data-spec-screen="1"]');
const listS = listRoot.querySelector('.s');
const listEl = document.querySelector('#questions .list');
const detailRoot = document.getElementById('detail');
const detailS = detailRoot.querySelector('.s');
const detailBody = document.getElementById('detail-body');
const detailView = detailBody.querySelector('.detail-view');
// Captured before createStates clears the detail body: these live inside the
// .detail-view node, which is kept detached until a load re-appends it.
const thread = detailView.querySelector('#thread');
const reportQuestion = detailView.querySelector('#report-question');

// One line icon, drawn like the screens': a stroked path, no fill.
const ICONS = { check: 'M5 12l5 5 9-10', bubble: 'M4 5h16v11H9l-5 4z', flag: 'M5 21V4h11l-2 4 2 4H5' };

function lineIcon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

// How many people have voted on anything here. Every bar and every "have had
// their say" line fills against this, so a full-length bar always means the
// same thing: everyone who has voted on any question.
let voters = 0;

async function refreshVoters() {
  voters = (await api('GET', '/api/voters')).voters || 0;
}

const denomFor = (t) => Math.max(voters, t.total);

// The tally bar: green from the left for Yes, orange follows for No, a small
// gap between. No votes yet: an empty bar.
function barChildren(t) {
  if (!t.total) return [];
  const denom = denomFor(t);
  const width = (n) => `${+((n / denom) * 100).toFixed(2)}%`;
  return [
    h('div', { class: 'y', style: `width:${width(t.options[0].count)}` }),
    h('div', { class: 'n', style: `width:${width(t.options[1].count)}` }),
  ];
}

// ── The list ──────────────────────────────────────────────────────────────

// One sample row to repeat, taken before anything clears the screen.
const questionRow = rowsFrom(listEl);

const listView = createStates(document.getElementById('questions'), {
  empty: {
    title: 'No questions yet',
    text: 'Ask the club the first thing it needs to decide.',
    action: { label: 'New question', onClick: () => openNew() },
  },
  error: { title: 'Questions did not load', text: 'Nothing you posted is lost.' },
});

function rowFor(item) {
  const t = tally(item.votes);
  const meta = [
    t.mine != null
      ? h('span', { class: 'mine' }, lineIcon(ICONS.check), `You voted ${optionLabel(t, t.mine)}`)
      : (!t.total ? h('span', null, 'No votes yet, be the first') : null),
    h('span', null, lineIcon(ICONS.bubble), plural(item.commentCount, 'comment')),
    h('span', null, timeAgo(item.createdAt)),
  ].filter(Boolean);
  return fillIn(questionRow(), {
    'h3': item.title,
    '.tally': { children: barChildren(t) },
    '.cy': `Yes ${t.options[0].count}`,
    '.cn': `No ${t.options[1].count}`,
    '.meta': { children: meta },
    '': {
      attr: { role: 'button', tabindex: '0' },
      on: {
        click: () => openDetail(item),
        keydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openDetail(item);
          }
        },
      },
    },
  });
}

function optionLabel(state, id) {
  const found = state.options.find((o) => o.id === id);
  return found ? found.label : '';
}

function loadList() {
  return listView.run(async (box) => {
    const data = await api('GET', '/api/questions');
    if (data.demo) showDemoLabel(listS);
    await refreshVoters();
    if (!data.items.length) return false;
    listEl.replaceChildren(...data.items.map(rowFor));
    clear(box).append(listEl);
    return true;
  });
}

// ── The detail ────────────────────────────────────────────────────────────

const detailStates = createStates(detailBody, {
  rows: 3,
  error: { title: 'This question did not load', text: 'Nothing you posted is lost.' },
});

let current = null; // the open question, and the row it was opened from

// Push and pop between the screens, through the native transition when the
// platform's kit is loaded, plainly when it is not.
function swap(hide, show, type) {
  const fn = () => {
    hide.hidden = true;
    show.hidden = false;
    window.scrollTo(0, 0);
  };
  const un = native();
  if (un && typeof un.transition === 'function') un.transition(fn, { type });
  else fn();
}

function openDetail(item, row = null) {
  current = { id: item.id, row };
  swap(listRoot, detailRoot, 'push');
  detailStates.run(async (box) => {
    const data = await api('GET', `/api/questions/${current.id}`);
    if (data.demo) showDemoLabel(detailS);
    await refreshVoters();
    current.item = data.item;
    drawDetail(data.item, data.comments || []);
    clear(box).append(detailView);
    return true;
  });
}

function turnLine(item) {
  const t = tally(item.votes);
  if (!t.total) return 'No votes yet, be the first';
  const denom = denomFor(t);
  return `${t.total} of the ${denom} ${denom === 1 ? 'person' : 'people'} voting here `
    + `${t.total === 1 ? 'has' : 'have'} had their say`;
}

function hintLine(item) {
  const mine = item.votes.mine;
  if (mine == null) return 'Tap Yes or No to vote.';
  return `You voted ${optionLabel(item.votes, mine)}. Tap it again to take your vote back.`;
}

function drawDetail(item, comments) {
  fillIn(detailView, {
    'h1': item.title,
    '.by': `Asked by ${item.author}, ${timeAgo(item.createdAt)}`,
    '.body': { text: item.body || '', hidden: !item.body },
    '.tally': { children: barChildren(tally(item.votes)) },
    '.turn': turnLine(item),
    '.hint': hintLine(item),
  });
  renderVotes(detailView.querySelector('.kit-votes-row'), {
    options: item.votes.options,
    mine: item.votes.mine,
    label: `Vote on ${item.title}`,
    layout: 'row',
    summary: false,
    onVote: async (choice) => {
      const saved = await api('POST', `/api/questions/${item.id}/vote`, { option: choice });
      await refreshVoters();
      current.item = saved.item;
      const t = tally(saved.item.votes);
      fillIn(detailView, {
        '.tally': { children: barChildren(t) },
        '.turn': turnLine(saved.item),
        '.hint': hintLine(saved.item),
      });
      return saved.item.votes;
    },
  });
  drawThread(item, comments);
}

// The comments, then a Report link on each one. Counts only, never names, so
// the thread re-renders after a post to hang the link on the new row too.
function drawThread(item, comments) {
  renderComments(thread, {
    comments,
    emptyText: 'No comments yet. Say what you think.',
    placeholder: 'e.g. I can bring the projector',
    label: 'Add a comment',
    onAdd: async (text) => {
      const saved = await api('POST', `/api/questions/${item.id}/comments`, { body: text });
      item.commentCount = (item.commentCount || 0) + 1;
      drawThread(item, [...comments, saved.comment]);
      return saved.comment;
    },
  });
  for (const li of thread.querySelectorAll('.kit-comment')) {
    if (li.querySelector('.row-foot')) continue;
    const id = Number(li.dataset.id);
    li.append(h('div', { class: 'row-foot' },
      h('button', { type: 'button', class: 'quiet', on: { click: () => report('comment', id) } },
        lineIcon(ICONS.flag), 'Report')));
  }
}

// ── Report ────────────────────────────────────────────────────────────────

function report(kind, id) {
  const what = kind === 'question' ? 'this question' : 'this comment';
  const message = `Report ${what} to the club? Nothing is hidden straight away; a person will look at it.`;
  const un = native();
  const ask = un && typeof un.alert === 'function'
    ? un.alert({ title: 'Report', message, buttons: [{ label: 'Report', style: 'danger' }, { label: 'Cancel' }] })
      .then((pick) => {
        if (pick === true || pick === 0) return true;
        const label = typeof pick === 'string' ? pick : pick && pick.label;
        return label === 'Report';
      })
      .catch(() => false)
    : Promise.resolve(window.confirm(message));
  ask.then((yes) => {
    if (!yes) return;
    api('POST', '/api/reports', { kind, id })
      .then(() => toast('Thanks. Your report is with the club.'))
      .catch((err) => toast(err && err.status === 404
        ? 'That was already gone.'
        : 'The report did not go through. Try again in a moment.'));
  });
}

// ── New question ──────────────────────────────────────────────────────────

function openNew() {
  openFormSheet({
    title: 'New question',
    submitLabel: 'Post question',
    savedMessage: 'Question posted',
    fields: [
      { name: 'title', label: 'Question', required: true, max: 120, placeholder: 'e.g. Where should we meet in December?' },
      { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'e.g. Anything people should know before they vote' },
    ],
    onSubmit: async (values) => {
      await api('POST', '/api/questions', values);
      loadList();
    },
  });
}

// ── Wire the drawn controls ───────────────────────────────────────────────

document.getElementById('new-question').addEventListener('click', () => openNew());

document.getElementById('back').addEventListener('click', () => {
  swap(detailRoot, listRoot, 'pop');
  loadList();
  const row = current && current.row;
  if (row && row.isConnected) row.focus();
});

reportQuestion.addEventListener('click', () => {
  if (current && current.item) report('question', current.item.id);
});

loadNative().catch(() => {});
loadList();