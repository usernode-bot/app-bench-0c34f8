// Club Votes: fills the drawn screen (public/index.html screen 1) with real
// data. Anyone posts a decision with choices, members vote (one vote each,
// changeable), talk it over in comments, and the poster closes it with the
// winning choice into the Decided list.
import { h, clear, api, isDemo, now, timeAgo, icon } from './kit/dom.js';
import { createStates } from './kit/states.js';
import { renderVotes } from './kit/votes.js';
import { renderComments } from './kit/comments.js';
import { openFormSheet, openSheet } from './kit/sheet.js';
import { toast } from './kit/native.js';
import { showDemoLabel } from './kit/demo.js';
import { rowsFrom, fillIn } from './kit/fill.js';

const screen = document.querySelector('[data-spec-screen="1"]');
const appEl = screen.querySelector('.app');
const header = appEl.querySelector('header.top');
const newBtn = header.querySelector('button.btn-primary');
newBtn.addEventListener('click', openNew);

// The drawn rows are the prototypes: keep one of each, then take the samples
// out before the first request.
const makeSlip = rowsFrom(appEl.querySelector('.stack'), '.card.slip');
const makeRow = rowsFrom(appEl.querySelector('.list'), '.list-row');

const board = h('main');
clear(appEl).append(header, board);

const states = createStates(board, {
  rows: 3,
  empty: {
    title: 'Nothing to decide yet',
    text: 'Post the first question for the club, like where to meet or what to do next.',
    action: { label: 'New decision', primary: true, onClick: openNew },
  },
  error: {
    title: 'Decisions did not load',
    text: 'Nothing you posted is lost. Try again in a moment.',
  },
});

let signedIn = false;
let openCount = 0;

// Tally strokes: groups of five (four strokes and a slash), drawn like the
// spec's slips. Five strokes or fewer also stand alone.
const STROKES = ['',
  'M5 4v16', 'M5 4v16M10 4v16', 'M5 4v16M10 4v16M15 4v16', 'M5 4v16M10 4v16M15 4v16M20 4v16',
  'M5 4v16M10 4v16M15 4v16M20 4v16M2 17L23 7'];
const tallyMarks = (count) => {
  const groups = [];
  for (let left = Math.max(0, count); left > 0; left -= 5) groups.push(STROKES[Math.min(left, 5)]);
  return groups.map((d) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  });
};

const CHECK_CIRCLE = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>';
const shortDate = (when) => new Date(when).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

states.run(load);

async function load(content) {
  const data = await api('GET', '/api/decisions');
  signedIn = data.signedIn;
  // createStates shows the empty state only when the task returns false.
  if (!data.open.length && !data.decided.length) return false;
  clear(content);
  if (isDemo() || data.demo) showDemoLabel(content);
  const open = h('section',
    h('h2', { class: 'section-label' }, 'Open decisions'),
    h('div', { class: 'stack' }));
  const decided = h('section',
    h('h2', { class: 'section-label' }, 'Decided'),
    h('ul', { class: 'list' }));
  openCount = data.open.length;
  for (const d of data.open) open.lastElementChild.append(slip(d));
  for (const d of data.decided) decided.lastElementChild.append(decidedRow(d));
  if (!data.decided.length) decided.hidden = true;
  content.append(open, decided);
  if (!data.open.length) {
    open.replaceChildren(h('p', { class: 'section-label' },
      signedIn ? 'Nothing open. Post the next question for the club.' : 'Nothing open right now.'));
  }
  newBtn.hidden = !signedIn || data.open.length + data.decided.length === 0;
}

function slip(d) {
  const sl = makeSlip();
  const footSpan = sl.querySelector('.foot span');
  fillIn(sl, {
    'h3': d.title,
    '.by': `${d.byMe ? 'You' : d.author} asked, ${timeAgo(d.createdAt, now())}`,
  });
  const drawSummary = () => footSpan.replaceChildren(...summaryNodes(d));
  drawSummary();
  const comments = h('button', {
    type: 'button',
    style: 'display:flex;align-items:center;gap:4px;background:none;border:0;color:inherit;font:inherit;cursor:pointer;padding:0',
    on: { click: (e) => { e.stopPropagation(); openDetail(d.id); } },
  }, d.commentCount ? `${d.commentCount} comment${d.commentCount === 1 ? '' : 's'}` : 'Comment', icon('chevron', 'ic'));
  footSpan.nextElementSibling.replaceWith(comments);

  const votesBox = sl.querySelector('.kit-votes');
  renderVotes(votesBox, {
    options: d.votes.options,
    mine: d.votes.mine,
    mark: tallyMarks,
    label: `Vote on ${d.title}`,
    summary: false, // the drawn foot span below is the summary
    onVote: async (mine) => {
      const saved = await api('POST', `/api/decisions/${d.id}/vote`, { option: mine });
      d.votes = saved.decision.votes;
      drawSummary();
      return saved.decision.votes;
    },
  });

  const openIt = (e) => { if (!e.target.closest('.kit-vote')) openDetail(d.id); };
  sl.style.cursor = 'pointer';
  sl.addEventListener('click', openIt);
  return sl;
}

/** Nodes for the slip's foot summary (an array, so it can hold the <b> lead). */
function summaryNodes(d) {
  const total = d.votes.options.reduce((n, o) => n + o.count, 0);
  if (!total) return ['No votes yet'];
  const top = Math.max(...d.votes.options.map((o) => o.count));
  const leaders = d.votes.options.filter((o) => o.count === top);
  if (leaders.length > 1) return [`${total} vote${total === 1 ? '' : 's'}, tied`];
  return [`${total} vote${total === 1 ? '' : 's'}, `, h('b', null, leaders[0].label), ' leads'];
}

function decidedRow(d) {
  const li = makeRow();
  const won = li.querySelector('.won');
  fillIn(li, { '.row-title': d.title, '.meta': shortDate(d.closedAt) });
  won.replaceChildren();
  won.insertAdjacentHTML('afterbegin', CHECK_CIRCLE);
  won.append(`Decided: ${d.outcome ? d.outcome.label : ''}`);
  const openIt = () => openDetail(d.id);
  li.style.cursor = 'pointer';
  li.setAttribute('tabindex', '0');
  li.setAttribute('role', 'button');
  li.addEventListener('click', openIt);
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openIt(); } });
  return li;
}

function openNew() {
  openFormSheet({
    title: 'New decision',
    savedMessage: 'Posted.',
    submitLabel: 'Post decision',
    returnFocus: newBtn,
    fields: [
      { name: 'title', label: 'What is the decision?', type: 'text', required: true, max: 120, placeholder: 'e.g. Where to meet in December' },
      { name: 'body', label: 'Tell the club more', type: 'textarea', max: 2000, placeholder: 'Anything people should know before voting (optional)' },
      // No `max` here: the kit reuses it as each choice's maxlength. It
      // caps the count at 6 on its own; the server enforces that too.
      { name: 'options', label: 'Choices', type: 'choices', min: 2, required: true, placeholder: ['e.g. Library back room', 'e.g. Corner cafe'] },
    ],
    onSubmit: async (v) => {
      const saved = await api('POST', '/api/decisions', v);
      await states.run(load);
      return saved;
    },
  });
}

async function openDetail(id) {
  let data;
  try {
    data = await api('GET', `/api/decisions/${id}`);
  } catch (err) {
    toast(err.status === 404 ? 'This was removed, or the link is wrong.' : 'It did not load. Try again in a moment.');
    return;
  }
  renderDetail(data.decision, data.comments);
}

function renderDetail(d, comments) {
  clear(states.content);
  states.ready();
  const back = h('button', { type: 'button', class: 'btn-secondary self-start', on: { click: () => states.run(load) } },
    icon('back', 'ic'), 'Back');
  const votesBox = h('div');
  const actions = h('div', { class: 'flex flex-wrap gap-2' });
  detailActions = actions;
  const commentsBox = h('div');

  states.content.append(
    back,
    h('div', { class: 'kit-detail-head' },
      h('h2', { class: 'text-title serif', tabindex: '-1' }, d.title),
      h('p', { class: 'by text-small muted' },
        `${d.byMe ? 'You' : d.author} asked, ${timeAgo(d.createdAt, now())}`),
      d.body ? h('p', { class: 'kit-detail-body' }, d.body) : null),
    h('section', h('h3', { class: 'section-label' }, d.closedAt ? 'Final count' : 'Votes'), votesBox),
    actions,
    h('section', h('h3', { class: 'section-label' }, 'Comments'), commentsBox));

  if (d.closedAt) {
    finalBars(votesBox, d);
    const stamp = h('p', { class: 'won' });
    stamp.insertAdjacentHTML('afterbegin', CHECK_CIRCLE);
    stamp.append(`Decided: ${d.outcome ? d.outcome.label : ''} · ${shortDate(d.closedAt)}`);
    votesBox.before(h('div', null, stamp));
  } else {
    const votes = renderVotes(votesBox, {
      options: d.votes.options,
      mine: d.votes.mine,
      mark: tallyMarks,
      label: `Vote on ${d.title}`,
      onVote: async (mine) => {
        const saved = await api('POST', `/api/decisions/${d.id}/vote`, { option: mine });
        d.votes = saved.decision.votes;
        syncActions(d);
        return saved.decision.votes;
      },
    });
    votesBox._votes = votes;
  }
  syncActions(d);

  const talk = renderComments(commentsBox, {
    comments,
    onAdd: async (text) => {
      const saved = await api('POST', `/api/decisions/${d.id}/comments`, { body: text });
      comments.push(saved.comment);
      // The kit adds the row once this resolves; give it that beat, then
      // give the row its action.
      setTimeout(() => addCommentMenus(commentsBox, comments), 0);
      return saved.comment;
    },
    placeholder: 'e.g. Count me in for the cafe',
  });
  addCommentMenus(commentsBox, comments);
}

function finalBars(box, d) {
  const total = d.votes.options.reduce((n, o) => n + o.count, 0);
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const rep = h('div', { class: 'kit-report' });
  for (const o of d.votes.options) {
    rep.append(
      h('div', null,
        h('p', { class: 'kit-report-line' },
          h('span', { class: 'kit-report-label' }, o.label),
          h('span', { class: 'kit-report-count' }, `${o.count} · ${pct(o.count)}%`)),
        h('span', { class: 'kit-bar' }, h('span', { class: 'kit-bar-fill', style: `width:${pct(o.count)}%` }))));
  }
  rep.append(h('p', { class: 'kit-report-total' }, total ? `${total} vote${total === 1 ? '' : 's'} in all` : 'No votes were cast'));
  box.append(rep);
}

let detailActions = null;

function syncActions(d) {
  const actions = detailActions;
  if (!actions) return;
  clear(actions);
  if (!d.closedAt && d.byMe) {
    const total = d.votes.options.reduce((n, o) => n + o.count, 0);
    const close = h('button', {
      type: 'button', class: 'btn-secondary', disabled: !total,
      on: { click: () => confirmClose(d) },
    }, 'Close it');
    // Native append stringifies null, so build the row before appending.
    actions.append(...[close, total ? null : h('p', { class: 'text-small muted self-center' },
      'Close once someone has voted.')].filter(Boolean));
  }
  if (d.byMe) {
    actions.append(h('button', { type: 'button', class: 'btn-secondary', on: { click: () => confirmDelete(d) } }, 'Delete'));
  }
  if (!d.byMe) {
    actions.append(h('button', {
      type: 'button', class: 'text-small muted',
      style: 'background:none;border:0;padding:6px 2px;cursor:pointer;text-decoration:underline',
      on: { click: () => report('decision', d.id) },
    }, 'Report'));
  }
}

function confirmClose(d) {
  const top = Math.max(...d.votes.options.map((o) => o.count));
  const leaders = d.votes.options.filter((o) => o.count === top);
  openSheet({
    title: 'Close this decision?',
    content: (body, close) => {
      const tied = leaders.length > 1;
      body.append(h('p', { class: 'text-body' }, tied
        ? `${leaders.length} choices are tied. Pick the one to close with:`
        : `Close with ${leaders[0].label} as the decision?`));
      const row = h('div', { class: 'flex flex-col gap-2 pt-2' });
      for (const o of leaders) {
        row.append(h('button', {
          type: 'button', class: 'btn-secondary', on: { click: async () => {
            await doClose(d, o.id);
            close();
          } },
        }, o.label));
      }
      body.append(row);
    },
    returnFocus: states.content.querySelector('button'),
  });
}

async function doClose(d, option) {
  try {
    const saved = await api('POST', `/api/decisions/${d.id}/close`, option == null ? {} : { option });
    toast('Closed.');
    await states.run(load);
    renderDetail(saved.decision, (await api('GET', `/api/decisions/${d.id}`)).comments);
  } catch (err) {
    toast(err.status >= 400 && err.status < 500 ? err.message : 'It did not close. Try again in a moment.');
  }
}

function confirmDelete(d) {
  openSheet({
    title: 'Delete this decision?',
    content: (body, close) => {
      body.append(h('p', { class: 'text-body' }, 'Its votes and comments go with it. This cannot be undone.'));
      body.append(h('div', { class: 'flex gap-2 pt-2' },
        h('button', { type: 'button', class: 'btn-secondary', on: { click: close } }, 'Keep it'),
        h('button', { type: 'button', class: 'btn-primary', on: { click: async () => {
          try {
            await api('DELETE', `/api/decisions/${d.id}`);
            close();
            toast('Deleted.');
            await states.run(load);
          } catch (err) {
            toast(err.status >= 400 && err.status < 500 ? err.message : 'It did not delete. Try again in a moment.');
          }
        } } }, 'Delete')));
    },
  });
}

async function report(kind, id) {
  try {
    await api('POST', '/api/reports', { kind, id });
    toast('Reported. Thanks for letting us know.');
  } catch (err) {
    toast(err.status >= 400 && err.status < 500 ? err.message : 'It was not reported. Try again in a moment.');
  }
}

// A small action on each comment row: Delete on your own, Report on the
// rest. A deleted row goes; a reported one stays put for the platform.
function addCommentMenus(box, comments) {
  for (const li of box.querySelectorAll('.kit-comment')) attachCommentAction(li, comments);
}

function attachCommentAction(li, comments) {
  if (li.querySelector('.kit-comment-action')) return; // this row has one already
  const c = comments.find((x) => String(x.id) === li.dataset.id);
  if (!c) return;
  const act = h('button', {
    type: 'button',
    class: 'text-small muted kit-comment-action',
    style: 'background:none;border:0;padding:6px 2px;cursor:pointer;text-decoration:underline',
    on: { click: c.byMe ? async () => {
      try {
        await api('DELETE', `/api/comments/${c.id}`);
        li.remove();
        toast('Comment deleted.');
      } catch (err) {
        toast(err.status >= 400 && err.status < 500 ? err.message : 'It was not deleted. Try again in a moment.');
      }
    } : () => report('comment', c.id) },
  }, c.byMe ? 'Delete' : 'Report');
  li.querySelector('.kit-comment-meta').append(act);
}
