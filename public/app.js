// Club Votes: the feed of the club's decisions and an opened decision's
// vote and comment screen. Rendered into the screens the spec drew
// (public/index.html, styled by public/screens.css) with the kit's pieces:
// the drawn rows are taken as the row to copy and filled with real data.
import { api, h, plural, timeAgo } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { rowsFrom } from '/kit/fill.js';
import { tally } from '/kit/tally.js';
import { renderVotes } from '/kit/votes.js';
import { renderComments } from '/kit/comments.js';
import { renderReport } from '/kit/report.js';
import { openFormSheet } from '/kit/sheet.js';
import { loadNative, toast } from '/kit/native.js';
import { showDemoLabel } from '/kit/demo.js';

const root = document.querySelector('[data-spec-screen="1"] .app');
const header = root.querySelector('.top');
const newButton = document.getElementById('new-decision');
const feedStates = document.getElementById('app');
const openSection = document.getElementById('open-section');
const doneSection = document.getElementById('decided-section');
const openStack = openSection.querySelector('.stack');
const doneStack = doneSection.querySelector('.stack');
const detailTpl = document.getElementById('tpl-detail');

// The drawn rows are the rows to repeat: take them out before the first
// request goes out, and capture their inline icons to reuse in fresh rows.
const openRow = rowsFrom(openStack);
const doneRow = rowsFrom(doneStack);
const CHECK_SVG = openRow().querySelector('.foot .mine svg').cloneNode(true);
const BUBBLE_SVG = openRow().querySelector('.foot span:last-child svg').cloneNode(true);
const STAMP_SVG = doneRow().querySelector('.stamp svg').cloneNode(true);

const closuresByDecision = new Map();
const DEMO_NOTE = 'Staging demo: made-up people and decisions';
let feedDirty = false;
let lastRow = null;
let detailBox = null;

// ── The feed ───────────────────────────────────────────────────────────────

const view = createStates(feedStates, {
  empty: {
    title: 'No decisions yet',
    text: 'Post the first thing the club needs to decide.',
    action: { label: 'New decision', onClick: () => openNew(), primary: true },
  },
  error: {
    title: 'Decisions did not load',
    text: 'Nothing you posted is lost. Try again in a moment.',
  },
});

const load = () => view.run(async (box) => {
  newButton.hidden = false;
  openSection.remove();
  doneSection.remove();
  const feed = await api('GET', '/api/decisions');
  const closedData = await api('GET', '/api/closures');
  for (const c of closedData.closures || []) closuresByDecision.set(c.decisionId, c);
  if (feed.demo) showDemoLabel(feedStates, DEMO_NOTE);
  const closed = feed.items.filter((d) => closuresByDecision.has(d.id))
    .sort((a, b) => String(closuresByDecision.get(b.id).closedAt)
      .localeCompare(String(closuresByDecision.get(a.id).closedAt)));
  const open = feed.items.filter((d) => !closuresByDecision.has(d.id));
  if (!open.length && !closed.length) {
    newButton.hidden = true; // the empty state carries the one New decision button
    return false;
  }
  openStack.replaceChildren(...open.map((d) => fillCard(openRow(), d, null)));
  openSection.hidden = false;
  box.append(openSection);
  if (closed.length) {
    doneStack.replaceChildren(...closed.map((d) => fillCard(doneRow(), d, closuresByDecision.get(d.id))));
    doneSection.hidden = false;
    box.append(doneSection);
  }
});

// ── A card in the feed ─────────────────────────────────────────────────────

function fillCard(el, d, closure) {
  const t = tally(d.votes);
  el.querySelector('.q').textContent = d.title;
  el.querySelector('.by').textContent = closure
    ? `Closed by ${closure.closedBy}, ${timeAgo(closure.closedAt)}`
    : `Posted by ${d.byMe ? 'you' : d.author}, ${timeAgo(d.createdAt)}`;
  if (closure) {
    const stamp = el.querySelector('.stamp');
    const chosen = t.options.find((o) => o.id === closure.choice);
    stamp.replaceChildren(stamp.querySelector('svg'), `Decided: ${chosen ? chosen.label : 'the result'}`);
  }
  // The tally bar: one segment per option with votes, leader first, the
  // leader solid and the rest lighter (a tie keeps the drawn two-tone).
  const bar = el.querySelector('.tally');
  const segs = t.options.filter((o) => o.count > 0)
    .sort((a, b) => b.count - a.count || a.id - b.id);
  bar.replaceChildren(...segs.map((o, i) => {
    const s = document.createElement('i');
    s.className = ['s1', 's2', 's3'][Math.min(i, 2)];
    s.style.width = `${o.percent}%`;
    return s;
  }));
  const lead = el.querySelector('.lead');
  if (lead) {
    let text = 'No votes yet';
    if (t.total) {
      text = t.tied
        ? (t.leaders.length <= 2
          ? `${t.options.filter((o) => o.leading).map((o) => o.label).join(' and ')} are tied`
          : 'Several options are tied')
        : `${t.options.find((o) => o.leading).label} leads`;
    }
    lead.replaceChildren(h('b', {}, text), h('span', {}, plural(t.total, 'vote')));
  }
  const foot = el.querySelector('.foot');
  if (foot) {
    const talk = h('span', {}, BUBBLE_SVG.cloneNode(true),
      d.commentCount ? plural(d.commentCount, 'comment') : 'No comments');
    if (closure) {
      foot.replaceChildren(h('span', {}, plural(t.total, 'vote')), talk);
    } else {
      const mine = d.votes.mine != null;
      foot.replaceChildren(
        h('span', { class: mine ? 'mine' : null },
          mine ? [CHECK_SVG.cloneNode(true), 'You voted'] : 'Not voted yet'),
        talk);
    }
  }
  el.setAttribute('data-decision', d.id);
  el.addEventListener('click', () => openDecision(d.id, el));
  return el;
}

// ── Screens: the feed and the opened decision ──────────────────────────────

function showScreen(which) {
  const detail = which === 'detail';
  header.hidden = detail;
  feedStates.hidden = detail;
  if (detailBox) detailBox.hidden = !detail;
}

function showFeed() {
  showScreen('feed');
  if (feedDirty) {
    feedDirty = false;
    load();
  }
  if (lastRow && lastRow.isConnected) lastRow.focus({ preventScroll: true });
}

// ── The opened decision ────────────────────────────────────────────────────

function openDecision(id, rowEl) {
  lastRow = rowEl || lastRow;
  if (!detailBox) {
    detailBox = h('div', { class: 'states-cards' });
    root.append(detailBox);
  }
  showScreen('detail');
  const dview = createStates(detailBox, {
    rows: 3,
    error: {
      title: 'This decision did not load',
      text: 'Nothing you posted is lost. Try again in a moment.',
    },
  });
  // A way back to the feed from the error state too.
  detailBox.querySelector('.state-error').append(
    h('button', { type: 'button', class: 'btn-secondary mt-2', on: { click: showFeed } }, 'All decisions'));

  dview.run(async (box) => {
    const data = await api('GET', `/api/decisions/${id}`);
    const item = data.item;
    if (data.demo) showDemoLabel(detailBox, DEMO_NOTE);
    const closure = closuresByDecision.get(item.id) || null;
    const card = detailTpl.content.firstElementChild.cloneNode(true);

    card.querySelector('.kit-detail-title').textContent = item.title;
    card.querySelector('.meta').textContent =
      `Posted by ${item.byMe ? 'you' : item.author}, ${timeAgo(item.createdAt)}`;
    const bodyEl = card.querySelector('.kit-detail-body');
    if (item.body) bodyEl.textContent = item.body;
    else bodyEl.remove();
    card.querySelector('[data-back]').addEventListener('click', showFeed);

    const head = card.querySelector('.kit-detail-head');
    if (closure) {
      // The Decided mark sits above the question, as on a closed feed card.
      const t = tally(item.votes);
      const chosen = t.options.find((o) => o.id === closure.choice);
      head.insertBefore(h('p', { class: 'stamp' }, STAMP_SVG.cloneNode(true),
        `Decided: ${chosen ? chosen.label : 'the result'}`), head.querySelector('.kit-detail-title'));
    }

    // The vote, or, on a closed decision, the final counts.
    const votesSection = card.querySelector('[data-votes]');
    const votesLabel = votesSection.querySelector('h3');
    const votesHost = votesSection.querySelector('.kit-votes');
    const owner = votesSection.querySelector('.owner');
    if (closure) {
      votesLabel.textContent = 'The result';
      const rows = tally(item.votes).options
        .slice().sort((a, b) => b.count - a.count || a.id - b.id)
        .map((o) => ({ label: o.label, count: o.count }));
      renderReport(votesHost, rows, { label: 'Final counts', unit: ['vote', 'votes'] });
    } else {
      renderVotes(votesHost, {
        options: item.votes.options,
        mine: item.votes.mine,
        label: `Vote on ${item.title}`,
        layout: 'stack',
        onVote: async (option) => {
          const saved = await api('POST', `/api/decisions/${item.id}/vote`, { option });
          feedDirty = true;
          return saved.item.votes;
        },
      });
    }

    // Close decision and Delete for the person who posted it, Report for
    // everyone else.
    if (item.byMe) {
      if (!closure) {
        owner.append(h('button', { type: 'button', class: 'btn-secondary', on: { click: () => closeDecision(item) } }, 'Close decision'));
      }
      owner.append(h('button', { type: 'button', class: 'btn-secondary', on: { click: () => deleteDecision(item) } }, 'Delete'));
    } else {
      owner.append(h('button', { type: 'button', class: 'rep', on: { click: () => report('decision', item.id) } }, 'Report'));
    }

    // The discussion, oldest first, with Report or Delete on every row.
    const commentsSection = card.querySelector('[data-comments]');
    const commentsLabel = commentsSection.querySelector('h3');
    const thread = h('div');
    commentsSection.replaceChildren(commentsLabel, thread);
    const known = new Map((data.comments || []).map((c) => [c.id, c]));
    renderComments(thread, {
      comments: data.comments || [],
      emptyText: 'No comments yet. Say what you think.',
      placeholder: 'e.g. The hall has better parking',
      onAdd: async (text) => {
        const saved = await api('POST', `/api/decisions/${item.id}/comments`, { body: text });
        feedDirty = true;
        known.set(saved.comment.id, saved.comment);
        setTimeout(() => decorateComments(thread, known, item.id), 0);
        return saved.comment;
      },
    });
    decorateComments(thread, known, item.id);

    box.append(card);
    card.querySelector('[data-back]').focus({ preventScroll: true });
  });
}

function decorateComments(thread, known, decisionId) {
  for (const li of thread.querySelectorAll('li[data-id]')) {
    if (li.querySelector('.kit-comment-meta button')) continue;
    const c = known.get(Number(li.dataset.id));
    if (!c) continue;
    const meta = li.querySelector('.kit-comment-meta');
    if (c.byMe) {
      meta.querySelector('.kit-comment-author').textContent = 'You';
      meta.append(h('button', { type: 'button', class: 'rep', on: { click: () => deleteComment(thread, known, decisionId, c, li) } }, 'Delete'));
    } else {
      meta.append(h('button', { type: 'button', class: 'rep', on: { click: () => report('comment', c.id) } }, 'Report'));
    }
  }
}

async function deleteComment(thread, known, decisionId, c, li) {
  if (!(await confirmDialog({
    title: 'Delete your comment?',
    message: 'This cannot be undone.',
    confirmLabel: 'Delete',
    destructive: true,
  }))) return;
  try {
    await api('DELETE', `/api/decisions/${decisionId}/comments/${c.id}`);
    known.delete(c.id);
    li.remove();
    feedDirty = true;
    toast('Comment deleted');
  } catch (err) {
    toast(err.message);
  }
}

// ── Close, delete, report ──────────────────────────────────────────────────

function closeDecision(item) {
  const t = tally(item.votes);
  const start = t.leaders.length ? t.leaders[0] : (item.votes.options[0] || { id: 0 }).id;
  openFormSheet({
    title: 'Close decision',
    submitLabel: 'Close decision',
    savedMessage: 'Decision closed',
    fields: [{
      name: 'choice',
      label: 'Which option was decided?',
      type: 'select',
      required: true,
      options: item.votes.options.map((o) => ({ value: o.id, label: o.label })),
    }],
    values: { choice: String(start) }, // starts on the leading option
    onSubmit: async (v) => {
      const saved = await api('POST', `/api/decisions/${item.id}/close`, { choice: Number(v.choice) });
      closuresByDecision.set(item.id, saved.closure);
      feedDirty = true;
      openDecision(item.id); // re-render as closed, with its result
    },
  });
}

async function deleteDecision(item) {
  if (!(await confirmDialog({
    title: 'Delete this decision?',
    message: 'Its votes and comments go with it. This cannot be undone.',
    confirmLabel: 'Delete',
    destructive: true,
  }))) return;
  try {
    await api('DELETE', `/api/decisions/${item.id}`);
    closuresByDecision.delete(item.id);
    feedDirty = true;
    showFeed();
    load();
    toast('Decision deleted');
  } catch (err) {
    toast(err.message);
  }
}

async function report(kind, id) {
  if (!(await confirmDialog({
    title: kind === 'decision' ? 'Report this decision?' : 'Report this comment?',
    message: 'A report goes to the club\'s admins. Nothing is hidden automatically.',
    confirmLabel: 'Report',
  }))) return;
  try {
    await api('POST', '/api/reports', { kind, id });
    toast('Reported. Thank you.');
  } catch (err) {
    toast(err.message);
  }
}

/** A confirm or alert: unNative.alert when the native kit loaded, else confirm(). */
async function confirmDialog({ title, message, confirmLabel, destructive = false }) {
  const un = await loadNative();
  if (un && typeof un.alert === 'function') {
    const answer = await un.alert({
      title,
      message,
      buttons: [
        { label: 'Cancel', style: 'cancel' },
        { label: confirmLabel, style: destructive ? 'destructive' : 'default' },
      ],
    });
    const chosen = answer && answer.button;
    const label = chosen && typeof chosen === 'object' ? chosen.label : chosen;
    return label === confirmLabel;
  }
  return globalThis.confirm(message ? `${title}\n\n${message}` : title);
}

// ── New decision ───────────────────────────────────────────────────────────

function openNew() {
  openFormSheet({
    title: 'New decision',
    submitLabel: 'Post decision',
    savedMessage: 'Decision posted',
    fields: [
      { name: 'title', label: 'Question', required: true, max: 120, placeholder: 'e.g. Where should we meet next month?' },
      { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'e.g. Add anything people should know before voting' },
      { name: 'options', label: 'Options', type: 'choices', required: true, placeholder: ['e.g. Community hall', 'e.g. The café'] },
    ],
    onSubmit: async (v) => {
      await api('POST', '/api/decisions', { title: v.title, body: v.body, options: v.options });
      feedDirty = false;
      load();
    },
  });
}

newButton.addEventListener('click', openNew);
load();
