// Club Votes: one list of the club's decisions, filled into the drawn screen
// (public/index.html, styled by public/screens.css). Open ones first, each
// with its ballot bars and its own comment thread in a sheet; decided ones
// keep their result in green. The kit's pieces do the rendering.
import { api, h, icon, plural, timeAgo } from './kit/dom.js';
import { native, toast } from './kit/native.js';
import { createStates } from './kit/states.js';
import { renderVotes } from './kit/votes.js';
import { tally } from './kit/tally.js';
import { renderComments } from './kit/comments.js';
import { openFormSheet, openSheet } from './kit/sheet.js';
import { rowsFrom, groupsFrom, fillIn } from './kit/fill.js';
import { showDemoLabel } from './kit/demo.js';

const app = document.querySelector('.app');
const container = document.getElementById('decisions');
const newButton = document.querySelector('.head .btn-primary');
const openSection = document.getElementById('open-section');
const decidedSection = document.getElementById('decided-section');

// The drawn rows are the samples: keep one of each to copy, then the drawn
// headings and stacks as the section group to repeat.
const openCardRow = rowsFrom(openSection.querySelector('.stack'));
const decidedCardRow = rowsFrom(decidedSection.querySelector('.stack'));
const section = groupsFrom(container, '.section-label', '.stack');

let signedIn = true;

const view = createStates(container, {
  rows: 4,
  // Stand-ins shaped like the decision cards that will load: three separate
  // cards with the card's padding and gap, a title bar, a meta bar and 44 px
  // option bars — no dividers.
  skeleton: () => h('div', { 'aria-busy': 'true' },
    h('p', { class: 'sr-only', role: 'status' }, 'Loading'),
    h('div', { class: 'stack', 'aria-hidden': 'true' },
      Array.from({ length: 3 }, (_, i) => h('div', { class: 'card' },
        h('span', { class: 'skeleton h-5 w-3/4' }),
        h('span', { class: 'skeleton h-3 w-1/3' }),
        h('span', { class: 'skeleton h-11 w-full' }),
        h('span', { class: 'skeleton h-11 w-full' }),
        i % 2 ? h('span', { class: 'skeleton h-11 w-2/3' }) : null)))),
  empty: {
    title: 'No decisions yet',
    text: 'Post the first thing the club needs to decide.',
    action: { label: 'New decision', onClick: openNew, primary: true },
  },
  error: {
    title: 'Decisions did not load',
    text: 'Nothing you posted is lost. Try again in a moment.',
  },
});

const load = async () => {
  await view.run(loadTask);
  // In the empty state the header's New decision button is plain.
  const plain = container.dataset.state === 'empty';
  newButton.classList.toggle('btn-primary', !plain);
  newButton.classList.toggle('btn-secondary', plain);
};

async function loadTask(content) {
  content.replaceChildren(); // run() appends; each load starts from nothing
  const data = await api('GET', '/api/decisions');
  if (data.demo) showDemoLabel(app, 'Staging demo: the people and decisions here are made up.');
  signedIn = data.signedIn !== false;
  if (!data.decisions.length) return false;
  const open = data.decisions.filter((d) => !d.decided);
  const decided = data.decisions.filter((d) => d.decided);
  if (open.length) {
    const g = section(`Open, ${plural(open.length, 'decision')}`);
    for (const d of open) g.list.append(openCard(d));
    // A section apiece, as drawn: the label's own 8 px sits between it and
    // its first card, not the content box's 24 px gap.
    content.append(h('section', null, g.heading, g.list));
  }
  if (decided.length) {
    const g = section('Decided');
    for (const d of decided) g.list.append(decidedCard(d));
    content.append(h('section', null, g.heading, g.list));
  }
}

// ── A card ───────────────────────────────────────────────────────────────────

function askedBy(d) {
  return `Asked by ${d.byMe ? 'you' : d.author}, ${timeAgo(d.createdAt)}`;
}

function openCard(d) {
  const card = fillIn(openCardRow(), {
    '.q': d.title,
    '.by': askedBy(d),
  });
  renderVotes(card.querySelector('.kit-votes'), {
    ...d.votes,
    label: `Vote on: ${d.title}`,
    // The vote summary lives in the card's footer; only guests need a line
    // under the bars, to be told they cannot vote.
    summary: !signedIn,
    onVote: async (option) => (await api('POST', `/api/decisions/${d.id}/vote`, { option })).decision.votes,
  });
  if (!signedIn) {
    for (const b of card.querySelectorAll('.kit-vote')) b.disabled = true;
    const line = card.querySelector('.kit-vote-summary');
    if (line) line.textContent = 'Sign in to vote';
  }
  foot(card, d);
  return card;
}

function decidedCard(d) {
  const card = fillIn(decidedCardRow(), {
    '.q': d.title,
    '.by': askedBy(d),
  });
  const t = tally({ options: d.votes.options, mine: null });
  card.querySelector('.kit-votes').replaceChildren(...t.options.map((o) => decidedRow(o, d.decided.option)));
  foot(card, d);
  return card;
}

// A decided card's result: the winner in green with a check, the rest dimmed.
function decidedRow(o, winner) {
  const win = o.id === winner;
  const fill = h('span', { class: 'kit-vote-fill', 'aria-hidden': 'true' });
  fill.style.width = `${o.percent}%`;
  const row = h('div', { class: win ? 'kit-vote win' : 'kit-vote' },
    fill,
    h('span', { class: 'kit-vote-mark', 'aria-hidden': 'true' }, win ? icon('check', '') : null),
    h('span', { class: 'kit-vote-label' }, o.label),
    h('span', { class: 'kit-vote-count' }, String(o.count)));
  return row;
}

function foot(card, d) {
  const link = card.querySelector('.foot .link');
  const mark = link.querySelector('svg');
  while (link.lastChild && link.lastChild !== mark) link.lastChild.remove();
  link.append(d.commentCount ? plural(d.commentCount, 'comment') : 'Comment');
  link.addEventListener('click', () => openComments(d));
  card.querySelector('.foot .sum').textContent = sumWords(d);
  card.querySelector('.foot .icon').addEventListener('click', (e) => moreMenu(e.currentTarget, d));
}

// The footer's summary, the spec's form: "3 votes", "8 votes, tied".
function sumWords(d) {
  const t = tally(d.votes);
  if (!t.total) return 'No votes yet';
  const n = plural(t.total, 'vote');
  return t.tied ? `${n}, tied` : n;
}

// ── The card's More menu ─────────────────────────────────────────────────────

function moreMenu(anchor, d) {
  const items = [];
  if (d.byMe && !d.decided) items.push({ label: 'Mark decided', handler: () => markDecided(d) });
  if (d.byMe && d.decided) items.push({ label: 'Reopen voting', handler: () => reopen(d) });
  items.push({ label: 'Report', handler: () => report('decision', d.id) });
  if (d.byMe) items.push({ label: 'Delete', handler: () => deleteDecision(d) });
  menu(anchor, items);
}

function markDecided(d) {
  const t = tally(d.votes);
  // The select starts on the option that is ahead (the first of a tie).
  const ahead = t.leaders.length ? d.votes.options[t.leaders[0]].label : null;
  openFormSheet({
    title: 'Mark decided',
    submitLabel: 'Mark decided',
    savedMessage: 'Marked decided',
    fields: [{
      name: 'option', label: 'Which option won?', type: 'select', required: true,
      options: d.votes.options.map((o) => o.label), value: ahead,
    }],
    onSubmit: async (v) => {
      const won = d.votes.options.findIndex((o) => o.label === v.option);
      await api('POST', `/api/decisions/${d.id}/decide`, { option: won });
      load();
    },
  });
}

async function reopen(d) {
  try {
    await api('POST', `/api/decisions/${d.id}/decide`, { option: null });
    toast('Voting is open again');
    load();
  } catch (err) {
    toast(err.message || 'That did not work. Try again in a moment.');
  }
}

async function deleteDecision(d) {
  if (!(await confirm({ title: 'Delete this decision?', message: 'Its votes and comments go too.', confirmLabel: 'Delete' }))) return;
  try {
    await api('DELETE', `/api/decisions/${d.id}`);
    toast('Decision deleted');
    load();
  } catch (err) {
    toast(err.message || 'That did not work. Try again in a moment.');
  }
}

async function report(kind, targetId) {
  try {
    await api('POST', '/api/reports', { kind, targetId });
    toast('Reported, thanks for telling us.');
  } catch (err) {
    toast(err.message || 'That did not work. Try again in a moment.');
  }
}

// ── Comments ────────────────────────────────────────────────────────────────

async function openComments(d) {
  const sheet = await openSheet({
    title: 'Comments',
    content: (body) => {
      body.append(
        h('h3', { class: 'text-heading' }, d.title),
        d.body ? h('p', { class: 'text-body text-muted' }, d.body) : null,
        h('p', { class: 'text-small text-muted' }, askedBy(d)),
        h('div', { class: 'skeleton h-20 mt-6' }));
    },
    returnFocus: null,
  });
  try {
    const data = await api('GET', `/api/decisions/${d.id}`);
    if (!data.decision) throw Object.assign(new Error('This was removed, or the link is wrong.'), { status: 404 });
    const commentById = new Map(data.comments.map((c) => [c.id, c]));
    const thread = h('div', { class: 'mt-6' });
    renderComments(thread, {
      comments: data.comments,
      emptyText: 'No comments yet. Say what you think.',
      onAdd: async (text) => {
        const saved = (await api('POST', `/api/decisions/${d.id}/comments`, { body: text })).comment;
        commentById.set(saved.id, saved);
        // The composer appends the row after this resolves; give it its More
        // button (report, delete) too, and bring the count on the card behind
        // up to date.
        setTimeout(() => {
          decorateComments(thread.querySelector('ul.kit-group'), commentById, () => load());
          load();
        }, 0);
        return saved;
      },
    });
    sheet.body.replaceChildren(
      h('h3', { class: 'text-heading' }, data.decision.title),
      data.decision.body ? h('p', { class: 'text-body text-muted' }, data.decision.body) : null,
      h('p', { class: 'text-small text-muted' }, askedBy(data.decision)),
      thread);
    decorateComments(thread.querySelector('ul.kit-group'), commentById, () => load());
  } catch (err) {
    sheet.body.replaceChildren(h('p', { class: 'text-body text-muted' },
      err.message || 'Comments did not load. Close this and try again.'));
  }
}

// The three-dot mark the drawn screen uses for More.
function dots() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cx, cy] of [[5, 12], [12, 12], [19, 12]]) {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', String(cy));
    c.setAttribute('r', '1.8');
    svg.append(c);
  }
  return svg;
}

// Every comment has a More button (report; delete its own author's).
function decorateComments(list, commentById, refresh) {
  if (!list) return;
  for (const li of list.children) {
    if (li.querySelector('.kit-comment-more')) continue;
    const c = commentById.get(Number(li.dataset.id));
    if (!c) continue;
    li.append(h('button', {
      type: 'button', class: 'kit-icon-button kit-comment-more', 'aria-label': 'More',
      on: { click: (e) => {
        const items = [{ label: 'Report', handler: () => report('comment', c.id) }];
        if (c.byMe) items.push({ label: 'Delete', handler: () => deleteComment(list, c, refresh) });
        menu(e.currentTarget, items);
      } },
    }, dots()));
  }
}

async function deleteComment(list, c, refresh) {
  if (!(await confirm({ title: 'Delete this comment?', message: 'It will be removed for everyone.', confirmLabel: 'Delete' }))) return;
  try {
    await api('DELETE', `/api/comments/${c.id}`);
    const row = list.querySelector(`li[data-id="${c.id}"]`);
    if (row) row.remove();
    toast('Comment deleted');
    refresh();
  } catch (err) {
    toast(err.message || 'That did not work. Try again in a moment.');
  }
}

// ── New decision ────────────────────────────────────────────────────────────

function openNew() {
  openFormSheet({
    title: 'New decision',
    submitLabel: 'Post decision',
    savedMessage: 'Decision posted',
    fields: [
      { name: 'title', label: 'Question', required: true, max: 120, placeholder: 'e.g. Where should we meet in November?' },
      { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'e.g. Anything people should know before voting.' },
      // No max here: on a choices field it would be each option's character
      // limit, not the number of options (the kit stops at six by itself).
      { name: 'options', label: 'Options', type: 'choices', required: true, min: 2, placeholder: ['e.g. Yes', 'e.g. No', 'e.g. Another idea'] },
    ],
    onSubmit: async (v) => {
      await api('POST', '/api/decisions', v);
      load();
    },
  });
}

newButton.addEventListener('click', openNew);

// ── Menus and confirms, with the kit's sheet as the fallback ────────────────

function menu(anchorEl, items) {
  const un = native();
  if (un && typeof un.menu === 'function') return un.menu({ anchorEl, items });
  return openSheet({
    title: 'More',
    content: (body, close) => {
      body.append(h('ul', { class: 'un-group kit-group' }, items.map((it) =>
        h('li', { class: 'un-group-row' }, h('button', {
          type: 'button', class: 'list-row kit-row w-full',
          on: { click: () => { close(); setTimeout(it.handler, 0); } },
        }, it.label)))));
    },
  });
}

function confirm({ title, message, confirmLabel = 'Delete' }) {
  const un = native();
  if (un && typeof un.alert === 'function') {
    return new Promise((resolve) => un.alert({
      title, message,
      buttons: [
        { label: 'Cancel', style: 'cancel', handler: () => resolve(false) },
        { label: confirmLabel, style: 'destructive', handler: () => resolve(true) },
      ],
    }));
  }
  return new Promise((resolve) => {
    openSheet({
      title,
      content: (body, close) => {
        body.append(
          h('p', { class: 'text-body text-muted' }, message),
          h('div', { class: 'kit-form-actions' },
            h('button', { type: 'button', class: 'btn-secondary', on: { click: () => { close(); resolve(false); } } }, 'Cancel'),
            h('button', { type: 'button', class: 'btn-primary', on: { click: () => { close(); resolve(true); } } }, confirmLabel)));
      },
    });
  });
}

load();
