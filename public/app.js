// Club Votes. Screen 1 lists the club's open questions; screen 2 is one
// question: vote with a show of hands (tally marks and voter names), and
// talk it through in comments. The drawn screens in index.html are filled
// from the data; the kit does the votes, comments, form sheet and states.

import { h, api, plural, timeAgo } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { rowsFrom, fillIn } from '/kit/fill.js';
import { renderVotes } from '/kit/votes.js';
import { tally, voteSummary } from '/kit/tally.js';
import { renderComments } from '/kit/comments.js';
import { openFormSheet } from '/kit/sheet.js';
import { showDemoLabel } from '/kit/demo.js';
import { toast, loadNative } from '/kit/native.js';
import { tallySvg, decorateVotes, checkIcon, bubbleIcon, flagIcon } from '/ballot.js';

const listScreen = document.querySelector('[data-spec-screen="1"]');
const main = listScreen.querySelector('main.app');
const postButton = main.querySelector('.btn-primary');
const detailScreen = document.querySelector('div[data-spec-screen="2"]');
const detailMain = detailScreen.querySelector('main.app');
const backBtn = detailMain.querySelector('.back');
const reportBtn = detailMain.querySelector('[data-report]');

let currentId = null;
let lastRow = null;
let listDirty = false;

// ── The list (screen 1) ───────────────────────────────────────────────────

const qRow = rowsFrom(main.querySelector('ul.list'));
const listBox = document.getElementById('questions');
const list = createStates(listBox, {
  rows: 4,
  empty: {
    title: 'No questions yet',
    text: 'Post the first thing the club should decide.',
    action: { label: 'Post a question', onClick: openPostSheet, primary: true },
  },
  error: {
    title: 'Questions could not be loaded',
    text: 'Nothing you posted or voted is lost. Check the connection and try again.',
  },
});

function listRow(item) {
  const t = tally(item.votes);
  const chosen = item.votes.mine == null ? null : item.votes.options[item.votes.mine];
  const li = fillIn(qRow(), {
    '.q-title': item.title,
    '.q > .text-small': `Asked by ${item.author}, ${timeAgo(item.createdAt)}`,
    '.lead': { text: voteSummary(t), class: { muted: !t.total } },
    '.mine': {
      hidden: item.votes.mine == null,
      children: chosen ? [checkIcon(), `You voted ${chosen.label}`] : null,
    },
    '.chip': {
      children: [bubbleIcon(), item.commentCount ? plural(item.commentCount, 'comment') : 'No comments'],
    },
    'button': { on: { click: () => openDetail(item, li) } },
  });
  const marks = tallySvg(t.total);
  const drawn = li.querySelector('.q-foot .tally');
  if (drawn) drawn.replaceWith(marks || document.createComment(''));
  return li;
}

async function loadList(content) {
  content.replaceChildren();
  const data = await api('GET', '/api/questions');
  if (data.demo) showDemoLabel(main);
  if (!data.items.length) return false;
  const ul = h('ul', { class: 'list' });
  for (const item of data.items) ul.append(listRow(item));
  content.append(ul);
  return true;
}

// ── Posting a question ────────────────────────────────────────────────────

function openPostSheet() {
  openFormSheet({
    title: 'Post a question',
    submitLabel: 'Post question',
    savedMessage: 'Question posted',
    fields: [
      { name: 'title', label: 'Question', type: 'text', required: true, max: 120, placeholder: 'e.g. Where should we meet in November?' },
      { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'e.g. The café is closing, so say which place suits you and why.' },
      { name: 'options', label: 'Answers', type: 'choices', min: 0, max: 6, placeholder: ['e.g. Library room', 'e.g. Community hall'], hint: 'Leave empty for Agree and Disagree.' },
    ],
    onSubmit: async (v) => {
      await api('POST', '/api/questions', { title: v.title, body: v.body, options: v.options });
      listDirty = false;
      await list.run(loadList);
    },
  });
}

// ── The detail view (screen 2) ────────────────────────────────────────────

const detailBox = document.getElementById('detail');
const detailParts = [...detailBox.children].map((n) => n.cloneNode(true));
const detail = createStates(detailBox, {
  rows: 3,
  empty: { title: 'This question is gone', text: 'Back to the list of questions.' },
  error: {
    title: 'This question could not be loaded',
    text: 'Nothing you posted or voted is lost. Check the connection and try again.',
  },
});

async function loadDetail(content) {
  content.replaceChildren();
  const data = await api('GET', `/api/questions/${currentId}`);
  const item = data.item;
  const [head, votesSection, commentsSection] = detailParts.map((n) => n.cloneNode(true));

  fillIn(head, {
    '.text-title': item.title,
    '.text-small': `Asked by ${item.author}, ${timeAgo(item.createdAt)}`,
    '.text-body': { text: item.body || '', hidden: !item.body },
  });

  // Votes: the kit's buttons, dressed with tally marks and voter names.
  const votesBox = votesSection.querySelector('.votes');
  const summaryLine = votesSection.querySelector('.kit-vote-summary');
  const namesError = h('p', { class: 'kit-vote-summary', hidden: true },
    'The names could not be loaded just now. The tallies are still right.');
  const setSummary = (v) => {
    summaryLine.textContent = voteSummary(v) + (tally(v).total ? '. Tap your choice again to take it back.' : '');
  };
  const refreshNames = async (v) => {
    let voters = null;
    try {
      voters = (await api('GET', `/api/questions/${item.id}/voters`)).voters;
    } catch (_) { /* tallies stay; the muted line says why there are no names */ }
    if (currentId !== item.id) return;
    namesError.hidden = !!voters;
    decorateVotes(votesBox, v, voters);
  };
  renderVotes(votesBox, {
    options: item.votes.options,
    mine: item.votes.mine,
    summary: false,
    label: `Vote on ${item.title}`,
    onVote: async (option) => {
      let saved;
      try {
        saved = await api('POST', `/api/questions/${item.id}/vote`, { option });
      } catch (err) {
        if (err.status === 401) throw Object.assign(new Error('Sign in to Homeroom to vote.'), { status: 401 });
        throw err;
      }
      listDirty = true;
      setSummary(saved.item.votes);
      refreshNames(saved.item.votes);
      return saved.item.votes;
    },
  });
  votesBox.append(namesError);
  setSummary(item.votes);
  refreshNames(item.votes);

  // Comments: the kit's thread and composer, plus Report on others' comments.
  const threadBox = commentsSection.querySelector('.thread');
  renderComments(threadBox, {
    comments: data.comments,
    onAdd: async (text) => {
      const r = await api('POST', `/api/questions/${item.id}/comments`, { body: text });
      listDirty = true;
      return r.comment;
    },
    label: 'Add a comment',
    placeholder: 'e.g. I can bring the snacks',
    postLabel: 'Post comment',
    emptyText: 'No comments yet. Start the thread.',
  });
  for (const li of threadBox.querySelectorAll('li[data-id]')) {
    const c = data.comments.find((x) => String(x.id) === li.dataset.id);
    if (c && !c.byMe) {
      li.append(h('div', { class: 'c-act' },
        h('button', { type: 'button', class: 'ghost', on: { click: () => report('comment', c.id) } }, flagIcon(), 'Report')));
    }
  }

  // Report on the question itself, unless the viewer asked it.
  reportBtn.hidden = !!item.byMe;
  reportBtn.onclick = () => report('question', item.id);

  content.append(head, votesSection, commentsSection);
  return true;
}

async function report(kind, id) {
  try {
    await api('POST', '/api/reports', { kind, id });
    toast('Thanks, we have noted your report');
  } catch (err) {
    if (err.status === 401) toast('Sign in to Homeroom to report this.');
    else toast(err.message || 'That did not work. Try again in a moment.');
  }
}

// ── Moving between the two screens ────────────────────────────────────────

const un = await loadNative();
const goDetail = () => {
  listScreen.hidden = true;
  detailScreen.hidden = false;
  window.scrollTo(0, 0);
  backBtn.focus({ preventScroll: true });
};
const goBack = () => {
  detailScreen.hidden = true;
  listScreen.hidden = false;
  if (lastRow) lastRow.focus({ preventScroll: true });
  if (listDirty) {
    listDirty = false;
    list.run(loadList);
  }
};

function openDetail(item, row) {
  currentId = item.id;
  lastRow = row;
  reportBtn.hidden = true;
  reportBtn.onclick = null;
  detail.run(loadDetail);
  if (un && typeof un.transition === 'function') un.transition(goDetail, { type: 'push' });
  else goDetail();
}

backBtn.addEventListener('click', () => {
  currentId = null;
  if (un && typeof un.transition === 'function') un.transition(goBack, { type: 'pop' });
  else goBack();
});

// ── Start ─────────────────────────────────────────────────────────────────

postButton.addEventListener('click', openPostSheet);
list.run(loadList);