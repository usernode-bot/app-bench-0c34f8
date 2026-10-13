// Club Votes' screens. Screen 1 (the list) is drawn in index.html and filled
// in place — rows are reused between renders, so the ballot bars slide when a
// refresh changes the tally. Screen 2 (a decision) is cloned from the drawn
// template for each decision and filled with the kit's votes and comments.

import { api, h, plural, timeAgo } from '/kit/dom.js';
import { percents } from '/kit/tally.js';
import { rowsFrom, fillIn, screen } from '/kit/fill.js';
import { createStates } from '/kit/states.js';
import { renderVotes } from '/kit/votes.js';
import { renderComments } from '/kit/comments.js';
import { openFormSheet } from '/kit/sheet.js';
import { loadNative, native, toast } from '/kit/native.js';
import { showDemoLabel } from '/kit/demo.js';

const CHOICE = { agree: 'Agree', disagree: 'Disagree', abstain: 'Abstain' };
const OUTCOME = { agreed: 'Agreed', turned_down: 'Turned down', tied: 'Tied', no_votes: 'No votes' };

// ── Native confirm dialogs and menus ───────────────────────────────────────

// A confirm from unNative.alert; falls back to confirm() only when the
// native kit is missing entirely (outside the platform).
function ask(title, message, confirmLabel, danger = true) {
  const un = native();
  if (un && typeof un.alert === 'function') {
    const result = un.alert({
      title,
      message,
      buttons: [
        { label: 'Cancel', style: 'neutral' },
        { label: confirmLabel, style: danger ? 'danger' : 'primary' },
      ],
    });
    if (result && typeof result.then === 'function') {
      return result.then((picked) => {
        if (picked === false || picked === 'Cancel') return false;
        const label = picked && typeof picked === 'object' ? picked.label : picked;
        return label !== 'Cancel' && label !== false;
      });
    }
  }
  return Promise.resolve(globalThis.confirm(`${title}\n\n${message}`));
}

function openMenu(anchorEl, items) {
  const un = native();
  if (un && typeof un.menu === 'function') return un.menu({ anchorEl, items });
  const first = items[0];
  if (first) globalThis.confirm(first.label) && first.handler();
}

// ── Shared bits ────────────────────────────────────────────────────────────

// The ballot bar's three segments, in percents that add to 100 (0 when a
// choice has no votes, so an empty start is all track).
function setBallot(el, t) {
  const total = t.agree + t.disagree + t.abstain;
  const p = percents([t.agree, t.disagree, t.abstain]);
  el.querySelector('.b-agree').style.width = `${t.agree ? p[0] : 0}%`;
  el.querySelector('.b-disagree').style.width = `${t.disagree ? p[1] : 0}%`;
  el.querySelector('.b-abstain').style.width = `${t.abstain ? p[2] : 0}%`;
  el.setAttribute('aria-label', total
    ? `${plural(t.agree, 'vote')} Agree, ${t.disagree} Disagree, ${t.abstain} Abstain`
    : 'No votes yet');
}

// Who leads, for the summary line: "8 votes, Agree leads".
function leadWord(t) {
  if (t.agree > t.disagree) return 'Agree leads';
  if (t.disagree > t.agree) return 'Disagree leads';
  return 'it is tied';
}

function resultPhrase(t) {
  const total = t.agree + t.disagree + t.abstain;
  if (!total) return 'No votes';
  if (t.agree === t.disagree) return `Tied (${t.agree} to ${t.disagree})`;
  return t.agree > t.disagree ? `Agreed (${t.agree} to ${t.disagree})` : `Turned down (${t.disagree} to ${t.agree})`;
}

const optionsOf = (t) => ['agree', 'disagree', 'abstain'].map((id) => ({ id, label: CHOICE[id], count: t[id] }));

function dotsIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'h-5 w-5');
  for (const cx of [5, 12, 19]) {
    const c = document.createElementNS(svg.namespaceURI, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', '12');
    c.setAttribute('r', '1.8');
    svg.append(c);
  }
  return svg;
}

// ── Screen 1: the list ─────────────────────────────────────────────────────

const appEl = document.getElementById('app');
const countLine = document.querySelector('[data-count-line]');
const newBtn = document.querySelector('[data-new]');
const guestNote = document.querySelector('[data-guest]');
const openList = document.getElementById('open-list');
const decidedList = document.getElementById('decided-list');
const openSection = document.getElementById('open-section');
const decidedSection = document.getElementById('decided-section');
const openNone = document.getElementById('open-none');
const openRow = rowsFrom(openList, 'li');
const decidedRow = rowsFrom(decidedList, 'li');
const rowCache = new Map(); // decision id -> its li, kept between renders so the bars slide

const states = createStates(document.getElementById('lists'), {
  rows: 3,
  empty: { title: 'No decisions yet.', text: 'Post the first thing the club needs to settle.' },
  error: { title: 'Decisions did not load', text: 'Your votes and comments are safe. Check your connection and try again.' },
});

let data = { me: null, decisions: [], demo: false };

const load = () => states.run(async (box) => {
  data = await api('GET', '/api/decisions');
  renderChrome();
  if (!data.decisions.length) return false;
  box.append(openSection, decidedSection);
  renderRows();
});

function renderChrome() {
  const open = data.decisions.filter((d) => !d.decidedAt).length;
  countLine.textContent = `${open} open, ${data.decisions.length - open} decided`;
  newBtn.hidden = !data.me;
  guestNote.hidden = !!data.me;
  if (data.demo) showDemoLabel(appEl, 'Staging demo');
}

function renderRows() {
  const open = data.decisions.filter((d) => !d.decidedAt);
  const decided = data.decisions.filter((d) => d.decidedAt);
  decidedSection.hidden = decided.length === 0;
  openNone.hidden = open.length !== 0;
  fillRows(openList, openRow, open, 'open');
  fillRows(decidedList, decidedRow, decided, 'decided');
}

function fillRows(list, make, items, groupName) {
  const keep = new Set(items.map((d) => String(d.id)));
  for (const [id, li] of [...rowCache]) {
    // Only this group's rows are up for removal here — the other list
    // manages its own.
    if (li.dataset.list !== groupName || keep.has(id)) continue;
    li.remove();
    rowCache.delete(id);
  }
  for (const d of items) {
    const id = String(d.id);
    let li = rowCache.get(id);
    if (!li) {
      li = make();
      li.dataset.list = groupName;
      rowCache.set(id, li);
      li.querySelector('.decision').addEventListener('click', () => openDetail(String(d.id), li.querySelector('.decision')));
    }
    list.append(li); // moves it into the wanted order
    fillRow(li.querySelector('.decision'), d);
  }
}

function fillRow(btn, d) {
  const open = !d.decidedAt;
  const t = d.tally;
  const total = t.agree + t.disagree + t.abstain;
  const who = d.byMe ? 'You' : d.author;
  setBallot(btn.querySelector('[data-ballot]'), t);
  const chip = btn.querySelector('[data-outcome]');
  if (open) {
    chip.hidden = true;
  } else {
    fillIn(chip, {
      // The icons are SVG, where el.hidden does nothing: hide them with
      // the attribute instead.
      '.o-check': { attr: { hidden: d.outcome !== 'agreed' } },
      '.o-cross': { attr: { hidden: d.outcome !== 'turned_down' } },
      '.outcome-text': OUTCOME[d.outcome] || 'Tied',
      '': { class: {
        'outcome-agree': d.outcome === 'agreed',
        'outcome-disagree': d.outcome === 'turned_down',
        'outcome-neutral': !(d.outcome === 'agreed' || d.outcome === 'turned_down'),
      } },
    });
    chip.hidden = false;
  }
  fillIn(btn, {
    '.decision-title': d.title,
    '.decision-sub': open ? `${who}, ${timeAgo(d.createdAt)}` : `${who}, decided ${timeAgo(d.decidedAt)}`,
    '[data-badge]': { hidden: !(open && data.me && !d.mine) },
    '[data-c-agree]': t.agree,
    '[data-c-disagree]': t.disagree,
    '[data-c-abstain]': t.abstain,
    '[data-k-agree]': { hidden: total === 0 },
    '[data-k-disagree]': { hidden: total === 0 },
    '[data-k-abstain]': { hidden: total === 0 },
    '[data-novotes]': { hidden: total !== 0 },
    '[data-mine]': d.mine ? { hidden: false, text: `You: ${CHOICE[d.mine]}` } : { hidden: true },
    '[data-c-comments]': d.commentCount,
  });
}

// ── Screen 2: a decision ───────────────────────────────────────────────────

const detailScreen = screen(2);
document.body.append(detailScreen);
const detailBody = detailScreen.querySelector('#detail-body');
// screen() Numbers its argument, so "2-detail" is out of its reach: the
// prototype is lifted straight from the template instead.
const detailProto = document
  .querySelector('template[data-spec-screen="2-detail"]').content
  .firstElementChild.cloneNode(true);
const detailStates = createStates(detailBody, {
  rows: 4,
  error: { title: 'This decision did not load', text: 'The list is still there. Try again in a moment.' },
});
let currentRowBtn = null;

detailScreen.querySelector('[data-back]').addEventListener('click', goBack);

function goBack() {
  detailScreen.hidden = true;
  appEl.hidden = false;
  if (currentRowBtn && currentRowBtn.isConnected) currentRowBtn.focus();
  currentRowBtn = null;
  if (listsEl.dataset.state === 'ready') renderRows();
}

function openDetail(id, btn) {
  currentRowBtn = btn;
  appEl.hidden = true;
  detailScreen.hidden = false;
  scrollTo({ top: 0 });
  loadDetail(id);
}

function loadDetail(id) {
  return detailStates.run(async (box) => {
    const res = await api('GET', `/api/decisions/${id}`);
    box.replaceChildren(renderDetail(res));
  });
}

function renderDetail(res) {
  const d = res.decision;
  const me = res.me;
  const open = !d.decidedAt;
  const who = d.byMe ? 'You' : d.author;
  const el = detailProto.cloneNode(true);
  fillIn(el, {
    '[data-title]': d.title,
    '[data-meta]': open ? `${who}, ${timeAgo(d.createdAt)}` : `${who}, decided ${timeAgo(d.decidedAt)}`,
    '[data-body]': d.body ? { hidden: false, text: d.body } : { hidden: true },
    '[data-poster]': { hidden: !(d.byMe && open) },
    '[data-more]': { hidden: !me },
    '[data-comments-label]': `Comments ${d.commentCount}`,
  });

  const ballotEl = el.querySelector('[data-ballot]');
  const summary = el.querySelector('[data-summary]');
  const voteEl = el.querySelector('[data-votes]');
  setBallot(ballotEl, d.tally);

  const votes = renderVotes(voteEl, {
    options: optionsOf(d.tally),
    mine: d.mine,
    label: `Vote on ${d.title}`,
    summary: false,
    onVote: async (choice) => {
      const r = await api('POST', `/api/decisions/${d.id}/vote`, { choice });
      Object.assign(d, r.decision);
      updateCached(r.decision);
      setBallot(ballotEl, r.decision.tally);
      setVoters(voteEl, r.voters);
      setSummary(summary, r.decision, me);
      return { options: optionsOf(r.decision.tally), mine: r.decision.mine };
    },
  });
  void votes;
  setVoters(voteEl, res.voters);
  setSummary(summary, d, me);
  if (!me || !open) voteEl.querySelectorAll('.kit-vote').forEach((b) => { b.disabled = true; });

  const more = el.querySelector('[data-more]');
  if (me) {
    more.addEventListener('click', () => {
      const items = [{ label: 'Report', handler: () => reportDecision(d) }];
      if (d.byMe) items.push({ label: 'Delete decision', handler: () => deleteDecision(d) });
      openMenu(more, items);
    });
  }

  if (d.byMe && open) {
    el.querySelector('[data-decide]').addEventListener('click', async () => {
      const ok = await ask('Close voting on this?', `Votes lock and the result is ${resultPhrase(d.tally)}. Comments stay open.`, 'Mark decided', false);
      if (!ok) return;
      try {
        const r = await api('POST', `/api/decisions/${d.id}/decide`);
        Object.assign(d, r.decision);
        updateCached(r.decision);
        toast('Voting is closed');
        loadDetail(d.id);
      } catch (err) {
        toast(err.message || 'That did not save. Try again.');
      }
    });
  }

  const commentsEl = el.querySelector('[data-comments]');
  const commentInfo = new Map(res.comments.map((c) => [String(c.id), { byMe: !!c.byMe, author: c.author }]));
  renderComments(commentsEl, {
    comments: res.comments.map((c) => ({ id: c.id, author: c.byMe ? 'You' : c.author, body: c.body, createdAt: c.createdAt })),
    emptyText: 'No comments yet. Say what you think.',
    placeholder: 'e.g. I can bring the picnic blankets',
    max: 1000,
    onAdd: async (body) => {
      const r = await api('POST', `/api/decisions/${d.id}/comments`, { body });
      d.commentCount += 1;
      el.querySelector('[data-comments-label]').textContent = `Comments ${d.commentCount}`;
      updateCached(d);
      return { id: r.comment.id, author: 'You', body: r.comment.body, createdAt: r.comment.createdAt };
    },
  });
  if (!me) {
    const composer = commentsEl.querySelector('.kit-composer');
    if (composer) composer.hidden = true;
  } else {
    attachCommentMore(commentsEl, commentInfo, () => {
      d.commentCount = Math.max(0, d.commentCount - 1);
      el.querySelector('[data-comments-label]').textContent = `Comments ${d.commentCount}`;
      updateCached(d);
    });
  }

  return el;
}

// The three-dots More button on other people's comments, added as rows
// appear (renderComments draws them on load and after each post).
function attachCommentMore(commentsEl, commentInfo, onHidden) {
  const scan = () => {
    for (const li of commentsEl.querySelectorAll('li[data-id]')) {
      if (li.querySelector('.kit-comment-more')) continue;
      const info = commentInfo.get(li.dataset.id);
      if (!info || info.byMe) continue;
      li.append(h('button', {
        type: 'button',
        class: 'kit-icon-button kit-comment-more',
        'aria-label': `More for ${info.author}'s comment`,
        on: { click: () => reportComment(li, Number(li.dataset.id), onHidden) },
      }, dotsIcon()));
    }
  };
  scan();
  new MutationObserver(scan).observe(commentsEl, { childList: true });
}

// Voters' names under each vote button, You first.
function setVoters(voteEl, voters) {
  const groups = { agree: [], disagree: [], abstain: [] };
  for (const v of voters) if (groups[v.choice]) groups[v.choice].push(v);
  for (const [choice, list] of Object.entries(groups)) {
    // The server sends vote order; the viewer's own name leads.
    const names = [...list].sort((a, b) => (b.byMe ? 1 : 0) - (a.byMe ? 1 : 0)).map((v) => v.name);
    const b = voteEl.querySelector(`.kit-vote[data-option="${choice}"]`);
    if (!b) continue;
    const label = b.querySelector('.kit-vote-label');
    let span = label.querySelector('.voters');
    if (!span) {
      span = h('span', { class: 'voters' });
      label.append(span);
    }
    span.textContent = names.join(', ');
    span.hidden = !names.length;
  }
}

function setSummary(summary, d, me) {
  summary.hidden = false;
  const t = d.tally;
  const total = t.agree + t.disagree + t.abstain;
  if (!d.decidedAt) {
    summary.textContent = !total ? 'No votes yet'
      : me ? `${plural(total, 'vote')}, ${leadWord(t)}. Tap your choice again to take it back.`
      : `${plural(total, 'vote')}, ${leadWord(t)}.`;
  } else {
    summary.textContent = `Decided ${timeAgo(d.decidedAt)}: ${OUTCOME[d.outcome] || 'Tied'}. Voting is closed, comments stay open.`;
  }
}

// ── Reports and deletes ────────────────────────────────────────────────────

async function reportDecision(d) {
  const ok = await ask('Report this decision?', 'It will be hidden for you. Three reports hide it for everyone.', 'Report');
  if (!ok) return;
  try {
    await api('POST', '/api/reports', { kind: 'decision', id: d.id });
  } catch (err) {
    toast(err.message || 'That did not send. Try again.');
    return;
  }
  toast("Reported. You won't see it any more.");
  removeDecision(d.id);
  goBack();
}

async function deleteDecision(d) {
  const ok = await ask('Delete this decision?', 'Its votes and comments go with it. This cannot be undone.', 'Delete');
  if (!ok) return;
  try {
    await api('DELETE', `/api/decisions/${d.id}`);
  } catch (err) {
    toast(err.message || 'That did not save. Try again.');
    return;
  }
  toast('Decision deleted');
  removeDecision(d.id);
  goBack();
}

function removeDecision(id) {
  data.decisions = data.decisions.filter((x) => x.id !== id);
  const li = rowCache.get(String(id));
  if (li) {
    li.remove();
    rowCache.delete(String(id));
  }
}

async function reportComment(li, id, onHidden) {
  const ok = await ask('Report this comment?', 'It will be hidden for you. Three reports hide it for everyone.', 'Report');
  if (!ok) return;
  try {
    await api('POST', '/api/reports', { kind: 'comment', id });
  } catch (err) {
    toast(err.message || 'That did not send. Try again.');
    return;
  }
  toast("Reported. You won't see it any more.");
  li.remove();
  if (onHidden) onHidden();
}

// ── Posting, and the quiet refresh ─────────────────────────────────────────

newBtn.addEventListener('click', () => openFormSheet({
  title: 'New decision',
  submitLabel: 'Post decision',
  savedMessage: 'Decision posted',
  fields: [
    { name: 'title', label: 'Title', required: true, max: 120, placeholder: 'e.g. Move meetups to Wednesdays' },
    { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'e.g. Why, when, and what it costs' },
  ],
  onSubmit: async (v) => {
    await api('POST', '/api/decisions', { title: v.title, body: v.body || '' });
    load();
  },
}));

// A failed refresh keeps the rows on screen, without an error.
const listsEl = document.getElementById('lists');
function refresh() {
  if (listsEl.dataset.state !== 'ready') return load();
  api('GET', '/api/decisions').then((fresh) => {
    data = fresh;
    renderChrome();
    if (!fresh.decisions.length) {
      for (const [, li] of rowCache) li.remove();
      rowCache.clear();
      states.empty();
      return;
    }
    renderRows();
  }).catch(() => {});
}

setInterval(() => {
  if (document.visibilityState === 'visible' && !appEl.hidden) refresh();
}, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !appEl.hidden) refresh();
});

function updateCached(d) {
  const i = data.decisions.findIndex((x) => x.id === d.id);
  if (i >= 0) data.decisions[i] = d;
}

// ── Boot ───────────────────────────────────────────────────────────────────

await loadNative();
load();