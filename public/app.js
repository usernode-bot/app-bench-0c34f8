// Club Votes: the board (screen 1, drawn in index.html) and the question
// screen (screen 2, drawn in the template), filled with real data and wired
// to the routes in kit/server.js. The drawn markup is kept; sample values
// are emptied and set from the data.
import { h, api, timeAgo, plural, isDemo } from './kit/dom.js';
import { createStates } from './kit/states.js';
import { rowsFrom, fillIn, screen } from './kit/fill.js';
import { tally } from './kit/tally.js';
import { renderVotes } from './kit/votes.js';
import { openFormSheet, openSheet } from './kit/sheet.js';
import { loadNative, native, toast } from './kit/native.js';
import { showDemoLabel } from './kit/demo.js';

const DEMO_LINE = 'Staging demo: made-up questions and people.';

// ── The board (screen 1) ──────────────────────────────────────────────────

const listApp = document.querySelector('[data-spec-screen="1"] .app');

// One drawn row of each list becomes the row to repeat; the samples go.
const stack = listApp.querySelector('.stack');
const cardRow = rowsFrom(stack, 'button.card');
const decidedList = listApp.querySelector('.list');
const decidedRow = rowsFrom(decidedList, 'li.list-row');
const openLabelTpl = listApp.querySelector('.stack').previousElementSibling;
const decidedLabelTpl = decidedList.previousElementSibling;

// The labels and lists go; the states box takes their place. The header,
// with the Post a question button, stays.
for (const el of listApp.querySelectorAll('.section-label')) el.remove();
stack.remove();
decidedList.remove();
const board = h('div');
listApp.append(board);

// Loading shows card placeholders shaped like the loaded cards, so the
// screen does not jump when the data arrives.
const boardSkeleton = () => h('div', { class: 'board-skeleton', 'aria-busy': 'true' },
  h('p', { class: 'sr-only', role: 'status' }, 'Loading'),
  Array.from({ length: 4 }, () => h('div', { class: 'card', 'aria-hidden': 'true' },
    h('p', { class: 'q-title' }, h('span', { class: 'skeleton bar-title' })),
    h('div', { class: 'tally' }, h('span', { class: 'skeleton bar-tally' })),
    h('p', { class: 'meta' }, h('span', { class: 'skeleton bar-meta' })))));

const listStates = createStates(board, {
  skeleton: boardSkeleton,
  empty: {
    title: 'No questions yet',
    text: 'Post the first thing for the club to decide.',
    action: { label: 'Post a question', onClick: () => openPost(), primary: true },
  },
  error: { title: 'Questions did not load', text: 'Nothing is lost. Try again in a moment.' },
});

// The one filled button on the main screen. While the board is empty the
// empty state's own button leads, so the header's steps aside.
const postBtn = listApp.querySelector('.head .btn-primary');
postBtn.addEventListener('click', () => openPost());

const iconSvg = (d, width) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': String(width),
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(k, v);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  return svg;
};
const speechSvg = () => iconSvg('M4 5h16v11H9l-5 4z', 2);

// The ballot tally bar: one slip per vote, grouped by option, gaps between
// the groups. Above 24 votes the slips merge into one solid block per
// option, as wide as its share.
function tallySlips(t) {
  const big = t.total > 24;
  const slips = [];
  let any = false;
  for (const o of t.options) {
    if (!o.count) continue;
    if (any) slips.push(h('i', { class: 'gap' }));
    any = true;
    if (big) slips.push(h('i', { class: o.leading ? 'lead' : null, style: `flex:${o.count}` }));
    else for (let k = 0; k < o.count; k += 1) slips.push(h('i', { class: o.leading ? 'lead' : null }));
  }
  return slips;
}

// The standing line: who leads, in the drawn words.
function standingNodes(t, item) {
  if (item.decided) return [`Decided: ${item.decided.choice || '—'}, ${plural(t.total, 'vote')}`];
  if (!t.total) return ['No votes yet'];
  if (t.tied) {
    const leads = t.options.filter((o) => o.leading);
    const nodes = [];
    leads.forEach((o, i) => {
      if (i) nodes.push(i < leads.length - 1 ? ', ' : leads.length > 2 ? ', and ' : ' and ');
      nodes.push(h('b', null, o.label));
    });
    nodes.push(' are tied ', h('span', null, `with ${leads[0].count} each`));
    return nodes;
  }
  const lead = t.options.find((o) => o.leading);
  return [h('b', null, lead.label), ' leads ',
    h('span', null, `with ${lead.count} of ${t.total} ${t.total === 1 ? 'vote' : 'votes'}`)];
}

function sectionLabel(tpl, name, count) {
  const el = tpl.cloneNode(true);
  const spans = el.querySelectorAll('span');
  spans[0].textContent = name;
  spans[1].textContent = String(count);
  return el;
}

function questionCard(item) {
  const t = tally(item.votes);
  const card = cardRow();
  fillIn(card, {
    '.q-title': item.title,
    '.tally': { children: tallySlips(t), hidden: !t.total },
    '.standing': { children: standingNodes(t, item) },
    '.meta .by': `${item.byMe ? 'You' : item.author || 'Someone'}, ${timeAgo(item.createdAt)}`,
    '.meta .ic:not(.mine)': {
      hidden: !item.commentCount,
      children: [speechSvg(), String(item.commentCount)],
    },
    '.meta .ic.mine': { hidden: item.votes.mine == null },
    '': { on: { click: () => openItem(item) } },
  });
  return card;
}

function decidedEntry(item) {
  const count = item.votes.options.find((o) => o.label === item.decided.choice)?.count ?? tally(item.votes).total;
  const li = decidedRow();
  fillIn(li, {
    '.rt .t': item.title,
    '.rt .s': `Decided: ${item.decided.choice}, ${plural(count, 'vote')}`,
    '': {
      attr: { role: 'button', tabindex: '0' },
      on: {
        click: () => openItem(item),
        keydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItem(item); }
        },
      },
    },
  });
  return li;
}

async function loadBoard() {
  postBtn.hidden = false;
  const data = await api('GET', '/api/questions');
  if (isDemo() && data.demo) showDemoLabel(listApp, DEMO_LINE);
  const items = data.items || [];
  const open = items.filter((i) => !i.decided);
  const decided = items.filter((i) => i.decided)
    .sort((a, b) => new Date(b.decided.at) - new Date(a.decided.at));
  if (!open.length && !decided.length) {
    postBtn.hidden = true; // the empty state's own button leads
    return false;
  }
  const box = listStates.content;
  box.replaceChildren();
  if (open.length) {
    box.append(sectionLabel(openLabelTpl, 'Open', open.length));
    const stackEl = h('div', { class: 'stack' });
    for (const item of open) stackEl.append(questionCard(item));
    box.append(stackEl);
  }
  if (decided.length) {
    box.append(sectionLabel(decidedLabelTpl, 'Decided', decided.length));
    const ul = h('ul', { class: 'list' });
    for (const item of decided) ul.append(decidedEntry(item));
    box.append(ul);
  }
  return true;
}

listStates.run(loadBoard);

// ── The question screen (screen 2) ────────────────────────────────────────

const detailRoot = screen(2);
document.body.append(detailRoot);
detailRoot.hidden = true;
document.querySelector('template[data-spec-screen="2"]').remove();

const detailApp = detailRoot.querySelector('.app');
const bar = detailApp.querySelector('.bar');
const backBtn = bar.querySelector('.btn-secondary');
const moreBtn = bar.querySelector('.kit-icon-button');

// The drawn pieces become templates; the states box takes their place.
const detailTpls = {};
for (const name of ['kit-detail-title', 'meta', 'kit-detail-body', 'tally', 'standing']) {
  const el = detailApp.querySelector(name === 'meta' ? '.meta' : `.${name}`);
  detailTpls[name] = el.cloneNode(true);
  el.remove();
}
const [votesLabelTpl, commentsLabelTpl] = [...detailApp.querySelectorAll('h3.section-label')]
  .map((el) => { const copy = el.cloneNode(true); el.remove(); return copy; });
const commentsUl = detailApp.querySelector('ul.list');
const commentRow = rowsFrom(commentsUl, 'li.list-row');
const composerTpl = detailApp.querySelector('form.kit-composer').cloneNode(true);
commentsUl.remove();
detailApp.querySelector('.kit-votes').remove();
detailApp.querySelector('form.kit-composer').remove();
for (const el of [...detailApp.querySelectorAll('h3.section-label')]) el.remove();
const detailBox = h('div');
detailApp.append(detailBox);
const detailStates = createStates(detailBox, {
  rows: 3,
  error: { title: 'The question did not load', text: 'Nothing is lost. Go back and try again in a moment.' },
});

let detail = null; // { item, comments } — what the screen shows now
let opener = null; // the element to focus again when going back
let votes = null; // the vote buttons, so Mark decided starts on the live leader

function plainLabel(tpl, text) {
  const el = tpl.cloneNode(true);
  el.textContent = text;
  return el;
}

function commentEntry(c, item) {
  const li = commentRow();
  fillIn(li, {
    '.kit-comment-meta': {
      children: [
        h('span', { class: 'kit-comment-author' }, c.byMe ? 'You' : c.author || 'Someone'),
        c.createdAt ? timeAgo(c.createdAt) : null,
      ],
    },
    '.kit-comment-body': c.body,
    '.kit-icon-button': { on: { click: (e) => reportMenu(e.currentTarget, { item, comment: c }) } },
  });
  return li;
}

function renderDetail(data) {
  detail = data;
  const { item, comments = [] } = data;
  const box = detailStates.content;
  box.replaceChildren();
  const t = tally(item.votes);

  box.append(fillIn(detailTpls['kit-detail-title'].cloneNode(true), { '': item.title }));
  box.append(fillIn(detailTpls.meta.cloneNode(true),
    { '': `Asked by ${item.byMe ? 'You' : item.author || 'Someone'}, ${timeAgo(item.createdAt)}` }));
  if (item.body) box.append(fillIn(detailTpls['kit-detail-body'].cloneNode(true), { '': item.body }));
  const tallyEl = fillIn(detailTpls.tally.cloneNode(true), { '': { children: tallySlips(t) } });
  const standingEl = fillIn(detailTpls.standing.cloneNode(true), { '': { children: standingNodes(t, item) } });
  box.append(tallyEl, standingEl);

  box.append(plainLabel(votesLabelTpl, 'Your vote'));
  const votesEl = h('div');
  box.append(votesEl);
  votes = renderVotes(votesEl, {
    ...item.votes,
    label: `Vote on ${item.title}`,
    summary: false,
    disabled: !!item.decided,
    onVote: async (mine) => {
      const fresh = (await api('POST', `/api/questions/${item.id}/vote`, { option: mine })).item.votes;
      const t2 = tally(fresh);
      fillIn(tallyEl, { '': { children: tallySlips(t2) } });
      fillIn(standingEl, { '': { children: standingNodes(t2, item) } });
      return fresh;
    },
  });

  if (item.byMe && !item.decided) {
    box.append(h('button', {
      type: 'button', class: 'btn-secondary',
      on: { click: () => markDecided(item, votes.state()) },
    }, 'Mark decided'));
  }

  let count = comments.length;
  const commentsLabel = plainLabel(commentsLabelTpl, `Comments${count ? `, ${count}` : ''}`);
  box.append(commentsLabel);
  const ul = h('ul', { class: 'list' });
  const none = h('p', { class: 'kit-comments-none' }, 'No comments yet. Say what you think.');
  ul.hidden = !count;
  none.hidden = !!count;
  for (const c of comments) ul.append(commentEntry(c, item));
  box.append(ul, none);

  const form = composerTpl.cloneNode(true);
  const field = form.querySelector('textarea');
  const send = form.querySelector('button');
  const err = h('p', { class: 'kit-error', role: 'alert', hidden: true });
  form.append(err);
  field.value = '';
  field.setAttribute('placeholder', 'e.g. Thursday works better for me');
  send.disabled = true;
  field.addEventListener('input', () => { send.disabled = !field.value.trim(); });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = field.value.trim();
    if (!text) return;
    send.disabled = true;
    send.textContent = 'Posting';
    err.hidden = true;
    try {
      const saved = await api('POST', `/api/questions/${item.id}/comments`, { body: text });
      count += 1;
      commentsLabel.textContent = `Comments, ${count}`;
      ul.hidden = false;
      none.hidden = true;
      ul.append(commentEntry(saved.comment, item));
      field.value = '';
    } catch (ex) {
      if (ex && ex.status >= 400 && ex.status < 500) {
        err.textContent = ex.message;
        err.hidden = false;
      } else {
        toast('Your comment was not posted. Try again in a moment.');
      }
    } finally {
      send.textContent = 'Post comment';
      send.disabled = !field.value.trim();
      field.focus();
    }
  });
  box.append(form);
}

async function openItem(ref) {
  opener = document.activeElement;
  const go = async () => {
    detailRoot.hidden = false;
    await detailStates.run(async () => {
      const id = typeof ref === 'object' ? ref.id : ref;
      const data = await api('GET', `/api/questions/${id}`);
      if (isDemo() && data.demo) showDemoLabel(detailApp, DEMO_LINE);
      renderDetail(data);
    });
  };
  const un = native();
  if (un && typeof un.transition === 'function') un.transition(go, { type: 'push' });
  else await go();
}

function closeDetail() {
  const go = () => {
    detailRoot.hidden = true;
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
  };
  const un = native();
  if (un && typeof un.transition === 'function') un.transition(go, { type: 'pop' });
  else go();
}
backBtn.addEventListener('click', closeDetail);
moreBtn.addEventListener('click', (e) => {
  if (detail) reportMenu(e.currentTarget, { item: detail.item });
});

// ── Report ────────────────────────────────────────────────────────────────

// The More menu of a question or comment: Report, then a confirm. The
// platform's own menu and alert when they are loaded, the kit's sheet
// otherwise. One report per person per target; a repeat does nothing.
function reportMenu(anchor, target) {
  const what = target.comment ? 'this comment' : 'this question';
  const send = async () => {
    try {
      await api('POST', `/api/questions/${target.item.id}/report`,
        target.comment ? { commentId: target.comment.id } : {});
      toast('Reported');
    } catch (err) {
      toast(err && err.status >= 400 && err.status < 500 ? err.message : 'That did not work. Try again in a moment.');
    }
  };
  const confirm = () => {
    const un = native();
    if (un && typeof un.alert === 'function') {
      un.alert({
        title: 'Report',
        message: `Flag ${what} for the people who look after the space? They will check it.`,
        buttons: [
          { label: 'Cancel', style: 'cancel' },
          { label: 'Report', style: 'destructive', handler: send },
        ],
      });
    } else {
      openSheet({
        title: 'Report',
        returnFocus: anchor,
        content: (body, close) => {
          body.append(h('p', { class: 'text-body text-muted' }, `Flag ${what} for the people who look after the space? They will check it.`));
          body.append(h('div', { class: 'kit-form-actions' },
            h('button', {
              type: 'button', class: 'btn-primary',
              on: { click: async () => { close(); await send(); } },
            }, 'Report')));
        },
      });
    }
  };
  const un = native();
  if (un && typeof un.menu === 'function') {
    un.menu({ anchorEl: anchor, items: [{ label: 'Report', handler: confirm }] });
  } else {
    confirm();
  }
}

// ── Mark decided ──────────────────────────────────────────────────────────

async function markDecided(item, t) {
  const leader = t.options.find((o) => o.leading) || t.options[0];
  await openFormSheet({
    title: 'Mark decided',
    submitLabel: 'Mark decided',
    savedMessage: 'Marked decided',
    fields: [{
      name: 'choice',
      label: 'What did the club decide?',
      type: 'select',
      required: true,
      options: t.options.map((o) => ({ value: String(o.id), label: o.label })),
    }],
    values: { choice: String(leader.id) },
    onSubmit: async (v) => {
      const saved = await api('POST', `/api/questions/${item.id}/decide`, { choice: Number(v.choice) });
      if (saved.item) renderDetail({ item: saved.item, comments: detail ? detail.comments : [] });
      listStates.run(loadBoard);
    },
  });
}

// ── Post a question ───────────────────────────────────────────────────────

function openPost() {
  openFormSheet({
    title: 'Post a question',
    submitLabel: 'Post question',
    savedMessage: 'Question posted',
    fields: [
      { name: 'title', label: 'Question', required: true, max: 120, placeholder: 'e.g. Where should we meet in November?' },
      { name: 'body', label: 'Details', type: 'textarea', max: 2000, placeholder: 'e.g. Add anything people should know before voting' },
      {
        name: 'options', label: 'Options', type: 'choices', min: 0, max: 6,
        placeholder: ['e.g. Riverside hall', 'e.g. Café Lindo, back room'],
        hint: 'Leave the options out and people vote Agree or Disagree.',
      },
    ],
    values: { options: ['', ''] },
    onSubmit: async (v) => {
      const options = (v.options || []).map((s) => String(s).trim()).filter(Boolean);
      await api('POST', '/api/questions', {
        title: v.title,
        body: v.body || undefined,
        options: options.length >= 2 ? options : undefined,
      });
      listStates.run(loadBoard);
    },
  });
}

// ── Pull to refresh, when the platform offers it ──────────────────────────

loadNative().then((un) => {
  if (un && typeof un.attachPullToRefresh === 'function') {
    un.attachPullToRefresh(window, () => listStates.run(loadBoard));
  }
});