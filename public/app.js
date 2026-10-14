// Club Votes: one feed of club decision questions. Post a question with 2 to
// 6 options, everyone picks one, names show next to each vote, the poster can
// close, and every decision and comment has a More menu (report, delete own).
import { api, h, clear, plural, timeAgo } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { rowsFrom, fillIn } from '/kit/fill.js';
import { renderVotes } from '/kit/votes.js';
import { renderComments } from '/kit/comments.js';
import { renderDetail } from '/kit/list.js';
import { openFormSheet } from '/kit/sheet.js';
import { loadNative, native, toast } from '/kit/native.js';
import { showDemoLabel } from '/kit/demo.js';

loadNative();

// The drawn screen: header, two section labels, sample cards to fill.
const screen = document.querySelector('[data-spec-screen="1"] .s');
const appEl = document.getElementById('app');
const header = screen.querySelector('.hd');
const newButton = header.querySelector('button');
const wrap = screen.querySelector('.wrap');
const [openLabel, decidedLabel] = [...wrap.querySelectorAll('.section-label')];

// Feed cards and their option rows: clones of the screen's own samples.
const makeCard = rowsFrom(wrap, 'a.card');
const CARD_SAMPLE = makeCard();

// The detail screen, hidden until a decision is opened.
const detailScreen = h('div', { class: 'wrap', hidden: true, 'data-detail': '' });
screen.append(detailScreen);
const detailView = createStates(detailScreen, { rows: 4, error: { title: 'This decision did not load', text: 'Nothing is lost. Try again in a moment.' } });

// ── Feed ────────────────────────────────────────────────────────────────────

const feedView = createStates(wrap, {
  rows: 4,
  empty: {
    title: 'Nothing to decide yet',
    text: 'Post the first question for the club to vote on.',
    action: { label: 'New decision', onClick: openNew, primary: true },
  },
  error: { title: 'Decisions did not load', text: 'Nothing you posted is lost. Try again in a moment.' },
});

async function load() {
  return feedView.run(async (box) => {
    const [data, meta] = await Promise.all([
      api('GET', '/api/decisions'),
      api('GET', '/api/decision-meta').catch(() => null),
    ]);
    if (data.demo) showDemoLabel(appEl);
    const voters = meta ? meta.voters : {};
    const states = meta ? meta.states : {};
    const open = [];
    const decided = [];
    for (const item of data.items) (states[item.id] ? decided : open).push(item);
    newButton.hidden = data.items.length === 0;
    // The states kit leaves the last render in place; a fresh feed starts empty.
    clear(box);
    if (!data.items.length) return false;
    box.classList.add('kit-content');
    box.append(openLabel);
    for (const item of open) box.append(feedCard(item, voters[item.id] || {}));
    if (decided.length) {
      box.append(decidedLabel);
      for (const item of decided) box.append(feedCard(item, voters[item.id] || {}, states[item.id]));
    }
  });
}

// The closed line as the spec words it: "Chosen: X, N of M votes", or "Tied".
function resultLine(chosen) {
  const res = h('p', { class: 'res' });
  if (chosen.tied && chosen.labels.length) res.append('Tied between ', h('b', {}, joinAnd(chosen.labels)));
  else if (chosen.tied) res.append('Tied');
  else res.append('Chosen: ', h('b', {}, chosen.labels.join(', ')), `, ${chosen.count} of ${chosen.total} votes`);
  return res;
}

// List in sentence form: "A and B", or "A, B and C" for three or more.
const joinAnd = (list) => list.length < 3
  ? list.join(' and ')
  : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;

// One feed card: status pill, author and time, question, each option with its
// count, notched tally bar and the names of who voted for it, footer counts.
function feedCard(item, voters, state) {
  const card = makeCard();
  fillIn(card, {
    '.st': { text: state ? 'Decided' : 'Open', class: { done: !!state } },
    '.by': `${item.byMe ? 'You' : item.author} · ${timeAgo(item.createdAt)}`,
    '.q': item.title,
    '.vc': plural(totalVotes(item), 'vote'),
    '.cc': item.commentCount ? plural(item.commentCount, 'comment') : 'No comments',
  });
  for (const opt of [...card.querySelectorAll('.opt')]) opt.remove();
  if (state) {
    card.append(resultLine(state.chosen || { tied: true, labels: [], count: 0, total: 0 }));
  } else {
    card.append(...item.votes.options.map((o) => optionRow(o, item, voters, false)));
  }
  card.append(moreButton('decision', item, state));
  card.querySelector('.meta').append(card.querySelector('[data-more]'));
  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-more]')) return;
    openDecision(item.id, card);
  });
  card.setAttribute('role', 'button');
  card.tabIndex = 0;
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDecision(item.id, card); }
  });
  return card;
}

// One option block as the screen drew it: label, count, notched bar, names.
function optionRow(option, item, voters, detailed) {
  const row = CARD_SAMPLE.querySelector('.opt').cloneNode(true);
  const mine = item.votes.mine === option.id;
  row.classList.toggle('mine', mine);
  const label = row.querySelector('.ol b');
  const check = label.querySelector('.ck');
  if (!mine && check) check.remove();
  label.childNodes[label.childNodes.length - 1].textContent = option.label;
  fillIn(row, { '.ol span': String(option.count) });
  drawBar(row.querySelector('.bar'), option.count, totalVotes(item));
  fillIn(row, { '.who': namesLine(voters[option.id] || []) });
  return row;
}

// The signature tally bar: one notch per vote, each 1/(max(total, 10)) of the
// bar wide, so small counts still read. Over 30 votes it becomes a solid fill
// of the option's share.
function drawBar(bar, count, total) {
  clear(bar);
  if (!count) return;
  const width = total > 30 ? (count / total) * 100 : 100 / Math.max(total, 10);
  const notches = total > 30 ? 1 : count;
  for (let k = 0; k < notches; k++) {
    const i = h('i');
    i.style.width = `${width}%`;
    bar.append(i);
  }
}

const totalVotes = (item) => item.votes.options.reduce((sum, o) => sum + o.count, 0);

// Voter names, own name reads "You".
const namesLine = (voters) => (voters.length
  ? voters.map((v) => (v.me ? 'You' : v.name)).join(', ')
  : 'No votes yet');

// ── Detail: vote, comment, More menu ────────────────────────────────────────

let openId = null;
let returnFocus = null;

function openDecision(id, row) {
  openId = id;
  returnFocus = row;
  header.hidden = true;
  wrap.hidden = true;
  detailScreen.hidden = false;
  const un = native();
  const show = () => { renderOpen(id); };
  if (un && un.transition) un.transition(show, { type: 'push' });
  else show();
}

function back() {
  const un = native();
  const hide = () => {
    detailScreen.hidden = true;
    header.hidden = false;
    wrap.hidden = false;
    openId = null;
    if (returnFocus) { returnFocus.focus(); returnFocus = null; }
    load();
  };
  if (un && un.transition) un.transition(hide, { type: 'pop' });
  else hide();
}

function renderOpen(id) {
  detailView.run(async (box) => {
    const [{ item, comments }, meta] = await Promise.all([
      api('GET', `/api/decisions/${id}`),
      api('GET', `/api/decision-meta/${id}`).catch(() => null),
    ]);
    const closed = meta ? meta.states[id] : null;
    const voters = meta ? (meta.voters[id] || {}) : {};
    rememberMine(comments);
    const detail = renderDetail(box, {
      title: item.title,
      meta: `${item.byMe ? 'You' : item.author} · ${timeAgo(item.createdAt)}`,
      body: item.body || null,
      onBack: back,
    });
    const head = box.querySelector('.kit-detail-head');
    head.append(moreButton('decision', item, closed));

    if (closed) {
      const sec = detail.section('Result');
      sec.append(resultLine(closed.chosen || { tied: true, labels: [], count: 0, total: 0 }));
      // The final spread, read-only: each option, its count and its voters.
      const finalCounts = countByChoice(item, voters);
      for (const option of item.votes.options) {
        sec.append(optionRow({ ...option, count: finalCounts[option.id] || 0 }, { votes: { mine: null, options: item.votes.options } }, voters, true));
      }
    } else {
      const sec = detail.section('Vote');
      const votes = renderVotes(sec, {
        ...item.votes,
        label: `Vote on ${item.title}`,
        onVote: async (option) => {
          const saved = await api('POST', `/api/decisions/${id}/vote`, { option });
          refreshNames(id).then((fresh) => { if (fresh) syncNames(sec, item.votes.options, fresh); });
          return saved.item.votes;
        },
      });
      syncNames(sec, item.votes.options, voters);
    }

    const commentsSec = detail.section('Comments');
    const thread = renderComments(commentsSec, {
      // The kit shows c.author; the viewer's own comments read "You".
      comments: comments.map((c) => (c.byMe ? { ...c, author: 'You' } : c)),
      emptyText: 'No comments yet. Say what you think.',
      placeholder: 'e.g. Count me in for whatever wins',
      onAdd: async (body) => {
        const saved = await api('POST', `/api/decisions/${id}/comments`, { body });
        commentMine.add(saved.comment.id);
        // The kit appends the row after this resolves, so the More button goes
        // on one tick later.
        setTimeout(() => augmentCommentRows(commentsSec, id));
        return { ...saved.comment, author: 'You' };
      },
    });
    augmentCommentRows(commentsSec, id);
    detail.focus();
  });
}

// The kit's votes redraw their buttons when a vote changes, so the names go
// back in after each change.
function syncNames(sec, options, voters) {
  for (const button of sec.querySelectorAll('.kit-vote[data-option]')) {
    const id = Number(button.dataset.option);
    let line = button.nextElementSibling;
    if (!line || !line.classList.contains('who-line')) {
      line = h('p', { class: 'who who-line' });
      button.insertAdjacentElement('afterend', line);
    }
    line.textContent = namesLine(voters[id] || []);
  }
}

async function refreshNames(id) {
  try {
    const meta = await api('GET', `/api/decision-meta/${id}`);
    return meta.voters[id] || {};
  } catch { return null; }
}

// The kit's comment rows carry data-id; add a More button to each.
function augmentCommentRows(sec, id) {
  for (const row of sec.querySelectorAll('.kit-comment[data-id]')) {
    if (row.querySelector('[data-more]')) continue;
    const cid = Number(row.dataset.id);
    const item = { commentId: cid };
    const button = moreButton('comment', item, null, id);
    row.append(button);
    button.classList.add('ml-auto');
  }
}

const countByChoice = (item, voters) => {
  const counts = {};
  for (const key of Object.keys(voters)) counts[key] = voters[key].length;
  return counts;
};

// ── More menus, confirms and reports ────────────────────────────────────────

// One More menu on every decision and comment: report, and delete or close
// when it is the viewer's own. All rows carry icons, or none do (the native
// kit's rule), so these carry none.
function moreButton(kind, item, state, decisionId) {
  const label = kind === 'decision' ? 'More options for this decision' : 'More options for this comment';
  return h('button', {
    class: 'kit-icon-button',
    'data-more': kind,
    'aria-label': label,
    on: { click: (e) => { e.stopPropagation(); decisionMenu(kind, item, state, decisionId, e.currentTarget); } },
  }, moreIcon());
}

function moreIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('class', 'h-5 w-5');
  for (const y of [6, 12, 18]) {
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', '12');
    c.setAttribute('cy', String(y));
    c.setAttribute('r', '1.6');
    svg.append(c);
  }
  return svg;
}

async function menu(anchorEl, items) {
  const un = native();
  if (un && un.menu) return un.menu({ anchorEl, items });
  // Fallback when the native kit did not load: pick one at a time.
  for (const item of items) {
    if (window.confirm(item.label)) { await item.handler(); break; }
  }
}

async function confirmAlert({ title, message, confirmLabel, destructive, onConfirm }) {
  const un = native();
  if (un && un.alert) {
    // The native alert resolves with the button object that was tapped.
    const answer = await un.alert({
      title,
      message,
      buttons: [
        { label: 'Cancel', style: 'cancel' },
        { label: confirmLabel, style: destructive ? 'destructive' : 'default' },
      ],
    });
    if (answer.button && answer.button.label === confirmLabel) await onConfirm();
  } else if (window.confirm(`${title}. ${message || ''}`.trim())) {
    await onConfirm();
  }
}

function decisionMenu(kind, item, state, decisionId, anchor) {
  if (kind === 'comment') {
    const items = [{ label: 'Report comment', handler: () => report('comment', item.commentId) }];
    if (isMine(commentMine, item.commentId)) {
      items.push({
        label: 'Delete comment',
        destructive: true,
        handler: () => confirmAlert({
          title: 'Delete this comment?',
          message: 'It disappears for everyone.',
          confirmLabel: 'Delete',
          destructive: true,
          onConfirm: () => deleteComment(decisionId, item.commentId),
        }),
      });
    }
    return menu(anchor, items);
  }
  const items = [];
  if (!state && item.byMe) {
    items.push({
      label: 'Close decision',
      handler: () => confirmAlert({
        title: 'Close this decision?',
        message: 'Voting stops and the leading options are recorded. Comments stay open.',
        confirmLabel: 'Close decision',
        destructive: true,
        onConfirm: () => closeDecision(item.id),
      }),
    });
  }
  items.push({ label: 'Report decision', handler: () => report('decision', item.id) });
  if (item.byMe) {
    items.push({
      label: 'Delete decision',
      destructive: true,
      handler: () => confirmAlert({
        title: 'Delete this decision?',
        message: 'Its votes and comments go with it.',
        confirmLabel: 'Delete',
        destructive: true,
        onConfirm: () => deleteDecision(item.id),
      }),
    });
  }
  return menu(anchor, items);
}

// Which comments are the viewer's: the feed's meta does not carry them, so
// the detail's own data does. Kept per open decision.
let commentMine = new Set();

const isMine = (set, id) => set.has(id);
const rememberMine = (comments) => {
  commentMine = new Set(comments.filter((c) => c.byMe).map((c) => c.id));
};

async function report(kind, id) {
  try {
    await api('POST', '/api/reports', { kind, id });
    toast('Thanks, the moderators will take a look.');
  } catch (err) {
    toast(err.message || 'The report did not send. Try again in a moment.');
  }
}

async function closeDecision(id) {
  try {
    await api('POST', `/api/decisions/${id}/close`);
    toast('Decision closed. Voting has stopped.');
    if (openId === id) renderOpen(id);
    else load();
  } catch (err) {
    toast(err.message || 'The decision did not close. Try again in a moment.');
  }
}

async function deleteDecision(id) {
  try {
    await api('DELETE', `/api/decisions/${id}`);
    toast('Decision deleted.');
    back();
  } catch (err) {
    toast(err.message || 'The decision was not deleted. Try again in a moment.');
  }
}

async function deleteComment(id, cid) {
  try {
    await api('DELETE', `/api/decisions/${id}/comments/${cid}`);
    toast('Comment deleted.');
    if (openId === id) renderOpen(id);
  } catch (err) {
    toast(err.message || 'The comment was not deleted. Try again in a moment.');
  }
}

// ── New decision ────────────────────────────────────────────────────────────

function openNew() {
  openFormSheet({
    title: 'New decision',
    submitLabel: 'Post decision',
    savedMessage: 'Decision posted',
    fields: [
      { name: 'title', label: 'Question', required: true, max: 120, placeholder: 'e.g. Where should we meet next month?' },
      { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'Anything the club should know (optional)' },
      // No max here: the kit would read it as a per-option character limit,
      // and it already stops at 6 options on its own.
      { name: 'options', label: 'Options', type: 'choices', min: 2, required: true, placeholder: 'e.g. Library back room' },
    ],
    onSubmit: async (values) => {
      await api('POST', '/api/decisions', { title: values.title, body: values.body, options: values.options });
      load();
    },
  });
}

newButton.addEventListener('click', openNew);
load();
