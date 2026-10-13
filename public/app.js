// Club Votes: the club's open questions, a vote on each one, and the talk
// under it. Home is a list in two sections — waiting for your vote, and the
// ones you already voted on; each opens the same detail screen with the
// tally, the vote buttons and the comments.
import { api, h, plural, timeAgo, clear } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { renderDetail } from '/kit/list.js';
import { renderVotes } from '/kit/votes.js';
import { tally } from '/kit/tally.js';
import { renderComments } from '/kit/comments.js';
import { openFormSheet } from '/kit/sheet.js';
import { showDemoLabel } from '/kit/demo.js';
import { loadNative, native, toast } from '/kit/native.js';

const listScreen = document.getElementById('list-screen');
const appMain = document.getElementById('app');
const detailScreen = document.getElementById('detail-main');
const countLine = document.getElementById('question-count');
const askButton = document.getElementById('ask');

let items = []; // the cache: the list screen renders from this, no refetch
let currentRow = null; // the row a detail was opened from, for the focus back
let current = null; // the open detail: { item, votesCtl, drawBar }

// ── The icons the screens drew ───────────────────────────────────────────
function svgMark(inner, sw = 2) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', String(sw));
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = inner;
  return el;
}
const BALLOT = '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>';
const BUBBLE = '<path d="M5 5h14v10H10l-4 4v-4H5z"/>';
const TICK = '<path d="M5 12.5l4.5 4.5L19 7.5"/>';
const FLAG = '<path d="M6 21V4M6 4h11l-2 4 2 4H6"/>';
const ballotIcon = () => svgMark(BALLOT);
const bubbleIcon = () => svgMark(BUBBLE);
const tickIcon = () => svgMark(TICK, 2.5);
const flagIcon = () => svgMark(FLAG);

// ── The tally bar: one slim segment per choice with votes ────────────────
function tallyBar(votes) {
  const t = tally(votes);
  const segs = t.options.filter((o) => o.count > 0).sort((a, b) => b.count - a.count);
  const bar = h('span', { class: 'tally', 'aria-hidden': 'true' });
  segs.forEach((o, i) => {
    bar.append(h('span', { class: i === 0 ? 't1' : i === 1 ? 't2' : 't3', style: `width:${o.percent}%` }));
  });
  return bar;
}

// "Riverside café leads, 58%", "Tied: A and B", "Tied 3 ways", "No votes
// yet" — and, when you voted, the violet "You picked X" line.
function leadLine(item) {
  const t = tally(item.votes);
  const lead = h('span', { class: item.votes.mine != null ? 'q-lead mine' : 'q-lead' });
  if (item.votes.mine != null) {
    const mine = t.options.find((o) => o.id === item.votes.mine);
    lead.append(tickIcon(), `You picked ${mine ? mine.label : 'something'}`);
    if (t.leaders.length === 1 && t.leaders[0] === item.votes.mine) lead.append(', it leads');
    return lead;
  }
  if (!t.total) {
    lead.append('No votes yet');
    return lead;
  }
  if (t.leaders.length === 1) {
    const top = t.options.find((o) => o.leading);
    lead.append(h('strong', null, top.label), ` leads, ${top.percent}%`);
  } else if (t.leaders.length === 2) {
    const [a, b] = t.options.filter((o) => o.leading);
    lead.append(h('strong', null, 'Tied:'), ` ${a.label} and ${b.label}`);
  } else {
    lead.append(`Tied ${t.leaders.length} ways`);
  }
  return lead;
}

function counts(item) {
  const t = tally(item.votes);
  const votes = t.total;
  return h('span', { class: 'counts' },
    h('span', null, ballotIcon(), String(votes)),
    h('span', null, bubbleIcon(), String(item.commentCount)),
    h('span', { class: 'sr-only' }, `${votes} ${votes === 1 ? 'vote' : 'votes'}, ${plural(item.commentCount, 'comment')}`));
}

// ── Home: the list ───────────────────────────────────────────────────────
const listStates = createStates(document.getElementById('states'), {
  rows: 5,
  empty: {
    title: 'No questions yet',
    text: 'Ask the club something it needs to decide, like where to meet next.',
    action: { label: 'Ask the first question', onClick: () => openAsk() },
  },
  error: { title: 'Questions did not load', text: 'Your votes and comments are saved. Try again in a moment.' },
});

function questionSection(label, list, waiting) {
  const ul = h('ul', { class: 'list' });
  for (const item of list) {
    const row = h('button', { type: 'button', class: 'list-row q-row', on: { click: () => openQuestion(item, row) } },
      h('span', { class: 'q-title line-clamp-2' },
        waiting ? h('span', { class: 'new-dot', 'aria-hidden': 'true' }) : null, item.title),
      tallyBar(item.votes),
      h('span', { class: 'q-foot' }, leadLine(item), counts(item)));
    ul.append(h('li', null, row));
  }
  return h('section', null, h('h2', { class: 'section-label' }, label), ul);
}

function renderListScreen() {
  clear(listStates.content);
  const sorted = items.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const waiting = sorted.filter((it) => it.votes.mine == null);
  const voted = sorted.filter((it) => it.votes.mine != null);
  if (waiting.length) listStates.content.append(questionSection('Waiting for your vote', waiting, true));
  if (voted.length) listStates.content.append(questionSection('You voted', voted, false));
}

function load() {
  return listStates.run(async () => {
    const data = await api('GET', '/api/questions');
    items = data.items;
    if (data.demo) showDemoLabel(appMain, 'Staging demo: the people and questions here are made up.');
    countLine.hidden = false;
    countLine.textContent = plural(items.length, 'open question');
    if (!items.length) return false;
    renderListScreen();
  });
}

// ── The detail screen ────────────────────────────────────────────────────
const detailStates = createStates(detailScreen, {
  rows: 3,
  error: { title: 'This question did not load', text: 'Nothing you saved is lost. Try again in a moment.' },
});

function openQuestion(item, row) {
  currentRow = row;
  const show = () => {
    let loadErr = null;
    listScreen.hidden = true;
    detailScreen.hidden = false;
    detailStates.run(async (box) => {
      try {
        const data = await api('GET', `/api/questions/${item.id}`);
        renderDetailScreen(box, data.item, data.comments);
      } catch (err) {
        loadErr = err;
        throw err;
      }
    }).then(() => {
      // A removed question answers 404 with its own words; show those.
      if (loadErr && loadErr.status === 404) {
        const text = detailScreen.querySelector('.state-error p');
        if (text) text.textContent = loadErr.message;
      }
    });
  };
  const un = native();
  if (un && typeof un.transition === 'function') un.transition(show, { type: 'push' });
  else show();
}

function renderDetailScreen(box, item, comments) {
  const detail = renderDetail(box, {
    title: item.title,
    meta: `Asked by ${item.author}, ${timeAgo(item.createdAt)}`,
    body: item.body || null,
    backLabel: 'Questions',
    onBack: goBack,
  });
  const back = box.querySelector('.kit-detail .btn-secondary');
  if (back) back.classList.add('back');

  // Your vote: the bar, then the buttons. The bar moves the moment a vote
  // is tapped; the kit rolls the buttons back itself if the save fails.
  const voteSection = detail.section('Your vote');
  const barBox = h('div');
  const votesBox = h('div');
  voteSection.append(barBox, votesBox);
  let votesCtl = null;
  votesCtl = renderVotes(votesBox, {
    ...item.votes,
    label: 'Vote on ' + item.title,
    layout: 'stack',
    onVote: (option) => saveVote(option),
  });
  current = {
    item,
    votesCtl,
    drawBar() { clear(barBox); barBox.append(tallyBar(votesCtl.state())); },
  };
  current.drawBar();
  voteSection.append(h('p', { class: 'vote-hint' },
    'Tap another choice to change your vote, or tap yours again to take it back.'));

  // Comments, oldest first, with a Report on everyone else's.
  const commentsSection = detail.section('Comments');
  renderComments(commentsSection, {
    comments,
    placeholder: 'e.g. The café works for me on Thursdays',
    emptyText: 'No comments yet. Say what you think.',
    onAdd: async (body) => {
      const data = await api('POST', `/api/questions/${item.id}/comments`, { body });
      const cached = items.find((x) => x.id === item.id);
      if (cached) cached.commentCount += 1;
      return data.comment;
    },
  });
  for (const li of commentsSection.querySelectorAll('li.kit-comment[data-id]')) {
    const c = comments.find((x) => String(x.id) === li.dataset.id);
    if (!c || c.byMe) continue;
    const meta = li.querySelector('.kit-comment-meta');
    if (meta) meta.append(h('button', { type: 'button', class: 'c-report', on: { click: () => reportComment(c, li) } }, 'Report'));
  }

  const holder = box.querySelector('.kit-detail') || box;
  holder.append(item.byMe
    ? h('button', { type: 'button', class: 'q-report', on: { click: () => deleteQuestion() } }, flagIcon(), 'Delete question')
    : h('button', { type: 'button', class: 'q-report', on: { click: () => reportQuestion() } }, flagIcon(), 'Report this question'));

  detail.focus();
}

async function saveVote(option) {
  const cur = current;
  if (!cur) throw new Error('This question is closed.');
  cur.drawBar();
  try {
    const data = await api('POST', `/api/questions/${cur.item.id}/vote`, { option });
    cur.votesCtl.update(data.item.votes);
    const cached = items.find((x) => x.id === data.item.id);
    if (cached) items[items.indexOf(cached)] = data.item;
    cur.item = data.item;
    cur.drawBar();
    return data.item.votes;
  } catch (err) {
    setTimeout(() => { if (current === cur) cur.drawBar(); }, 0); // after the kit's rollback
    throw err;
  }
}

function goBack() {
  const swap = () => {
    detailScreen.hidden = true;
    current = null;
    listScreen.hidden = false;
    renderListScreen(); // from the cache — no refetch flash
    if (currentRow && currentRow.isConnected) currentRow.focus();
  };
  const un = native();
  if (un && typeof un.transition === 'function') un.transition(swap, { type: 'pop' });
  else swap();
}

// ── Reporting and deleting ───────────────────────────────────────────────
// Take a question out of the cache and keep the header count honest.
function dropItem(id) {
  items = items.filter((x) => x.id !== id);
  countLine.textContent = plural(items.length, 'open question');
}
// The native alert where the kit loaded; a window.confirm fallback outside it.
async function confirmDialog({ title, message, action }) {
  const un = await loadNative();
  if (un && typeof un.alert === 'function') {
    const picked = await un.alert({
      title, message,
      buttons: [{ label: 'Cancel' }, { label: action, style: 'destructive' }],
    });
    if (picked == null || picked === false) return false;
    if (picked === true) return true;
    if (typeof picked === 'number') return picked === 1;
    if (typeof picked === 'object') {
      const b = picked.button || picked;
      return b.style === 'destructive' || b.label === action;
    }
    return String(picked) === action;
  }
  return window.confirm(`${title}\n\n${message}`);
}

async function reportComment(c, li) {
  const ok = await confirmDialog({
    title: 'Report this comment?',
    message: 'It will be hidden for you. If others report it too, it is hidden for everyone.',
    action: 'Report',
  });
  if (!ok) return;
  try {
    await api('POST', '/api/reports', { kind: 'comment', id: c.id });
    toast("Reported. It's hidden for you now.");
    li.remove();
  } catch (err) { toast(err.message); }
}

async function reportQuestion() {
  const cur = current;
  if (!cur) return;
  const ok = await confirmDialog({
    title: 'Report this question?',
    message: 'It will be hidden for you. If others report it too, it is hidden for everyone.',
    action: 'Report',
  });
  if (!ok) return;
  try {
    await api('POST', '/api/reports', { kind: 'question', id: cur.item.id });
    toast("Reported. It's hidden for you now.");
    dropItem(cur.item.id);
    goBack();
  } catch (err) { toast(err.message); }
}

async function deleteQuestion() {
  const cur = current;
  if (!cur) return;
  const ok = await confirmDialog({
    title: 'Delete this question?',
    message: 'Its votes and comments go too.',
    action: 'Delete',
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/questions/${cur.item.id}`);
    toast('Question deleted');
    dropItem(cur.item.id);
    goBack();
  } catch (err) { toast(err.message); }
}

// ── Ask the club ─────────────────────────────────────────────────────────
function openAsk() {
  openFormSheet({
    title: 'Ask the club',
    submitLabel: 'Post question',
    savedMessage: 'Question posted',
    returnFocus: askButton,
    fields: [
      { name: 'title', label: 'Question', required: true, max: 120, placeholder: 'e.g. Where should we meet in March?' },
      { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'e.g. We need room for about 15 people' },
      { name: 'options', label: 'Choices', type: 'choices',
        placeholder: ['e.g. Riverside café', 'e.g. Library room B'], hint: 'Two to six. Everyone picks one.' },
    ],
    onSubmit: async (v) => {
      await api('POST', '/api/questions', { title: v.title, body: v.body, options: v.options });
      load();
    },
  });
}

askButton.addEventListener('click', openAsk);
loadNative().then((un) => {
  if (un && typeof un.attachPullToRefresh === 'function') un.attachPullToRefresh(window, () => load());
}).catch(() => {});
load();