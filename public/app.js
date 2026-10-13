// Club Votes — the list of questions, the ballots on them, and the question
// page. The drawn screens in public/index.html stay the shape of the markup:
// this file fills them (kit fill.js), wires the kit's ballot arithmetic
// (kit tally.js) to POST /api/questions/:id/vote, and moves the drawn
// question page (screen 2) into #detail when the hash points at one.
import { api, h, plural, timeAgo } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { rowsFrom, screen } from '/kit/fill.js';
import { tally, applyVote } from '/kit/tally.js';
import { openFormSheet } from '/kit/sheet.js';
import { loadNative, toast } from '/kit/native.js';
import { showDemoLabel } from '/kit/demo.js';

loadNative(); // the native sheet, alert and toasts arrive when they arrive

const listScreen = document.querySelector('[data-spec-screen="1"]');
const app = document.getElementById('app');
const sectionLabel = app.querySelector('.section-label');
const questionsHolder = document.getElementById('questions');
const detailHolder = document.getElementById('detail');

// The drawn sample rows become the template for every card the app builds;
// rowsFrom strips the samples and hands back a make(). Do this before the
// states kit takes #questions over.
const drawnList = app.querySelector('.qs');
const rowMake = rowsFrom(drawnList, '.card.q');
const listTemplate = drawnList.cloneNode(false); // an empty ul.qs to fill per render

// Thin line icons, drawn the way the drawn screens draw theirs.
const svgPath = (d, width) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(width));
  svg.setAttribute('stroke-linecap', 'round');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
};

// The list's loading shape: a bar where the section label sits, then three
// question cards 12 px apart, each with title, meta and two ballot rows.
function listSkeleton() {
  const bar = (cls) => h('span', { class: `skeleton block ${cls}` });
  const rowSkel = () => h('div', { class: 'kit-vote' },
    h('span', { class: 'skeleton h-6 w-6 rounded-[4px]' }),
    h('span', { class: 'skeleton h-4 w-20' }));
  const cardSkel = () => h('div', { class: 'card q', 'aria-hidden': 'true' },
    bar('h-6 w-3/4'),
    bar('mt-1 h-4 w-1/3'),
    h('div', { class: 'ballot' }, rowSkel(), rowSkel()));
  return h('div', { 'aria-busy': 'true' },
    h('p', { class: 'sr-only', role: 'status' }, 'Loading'),
    bar('h-4 w-44 mb-2 ml-1'),
    h('div', { class: 'qs' }, cardSkel(), cardSkel(), cardSkel()));
}

// Hand-tally marks: gates of five (four strokes plus the slash), then the
// number stands alone past 30.
const MARK = '0 0 22 20';
const GATE = 'M4 3v14M8 3v14M12 3v14M16 3v14M1.5 14L19.5 5';
const STROKES = ['M4 3v14', 'M8 3v14', 'M12 3v14', 'M16 3v14'];
const TALLY_CAP = 30;

function tallyMarks(count) {
  const n = Math.min(Math.max(0, Math.floor(Number(count) || 0)), TALLY_CAP);
  const gates = Math.floor(n / 5);
  const svgs = [];
  const mark = (d) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', MARK);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  };
  for (let g = 0; g < gates; g += 1) svgs.push(mark(GATE));
  const rest = n % 5;
  if (rest) svgs.push(mark(STROKES.slice(0, rest).join('')));
  return svgs;
}

// One ballot: two drawn .kit-vote buttons, optimistic counting through the
// kit's applyVote, one vote per person (tap the chosen box again to take it
// back). onDraw runs after every draw with the tally's view.
function wireBallot(ballotEl, itemId, onDraw) {
  const buttons = [...ballotEl.querySelectorAll('.kit-vote')];
  let state = null;
  let saving = false;

  const draw = () => {
    const t = tally(state);
    t.options.forEach((o, i) => {
      const btn = buttons[i];
      btn.setAttribute('aria-pressed', String(o.chosen));
      btn.setAttribute('aria-label', `${o.label}, ${plural(o.count, 'vote')}`);
      btn.disabled = saving;
      btn.querySelector('.kit-vote-count').textContent = String(o.count);
      btn.querySelector('.tally').replaceChildren(...tallyMarks(o.count));
    });
    onDraw(t);
  };

  buttons.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      if (saving || !state) return;
      saving = true;
      votesInFlight += 1;
      const prev = state;
      state = applyVote(state, i);
      draw();
      api('POST', `/api/questions/${itemId}/vote`, { option: state.mine })
        .then((data) => { state = data.item.votes; })
        .catch((err) => {
          state = prev;
          if (err.status !== 401) toast('Vote did not save. Try again.'); // the bridge prompts on 401 itself
        })
        .finally(() => {
          saving = false;
          votesInFlight -= 1;
          draw();
        });
    });
  });

  return {
    set(next) { state = next.votes; draw(); },
  };
}

const askedBy = (item) =>
  `Asked by ${item.byMe ? 'You' : item.author} · ${timeAgo(item.createdAt)}`;

const leadWord = (t) => {
  if (!t.total) return '';
  if (t.tied) return 'a tie so far';
  const lead = t.options.find((o) => o.leading);
  return lead ? `${lead.label} leads` : '';
};

// ── The list ───────────────────────────────────────────────────────────────

let returnFocusId = null;
let firstListRun = true;
let votesInFlight = 0; // a silent refresh must not clobber a saving ballot

function cardFor(item) {
  const li = rowMake();
  li.setAttribute('data-qid', String(item.id));
  const openBtn = li.querySelector('.q-open');
  openBtn.querySelector('.q-title').textContent = item.title;
  openBtn.querySelector('.q-meta').textContent = askedBy(item);
  openBtn.addEventListener('click', () => openQuestion(item.id));

  const ballot = li.querySelector('.ballot');
  ballot.setAttribute('aria-label', `Vote on ${item.title}`);
  const foot = li.querySelector('.q-foot');
  const footSpan = foot.querySelector(':scope > span');
  const lead = foot.querySelector('.lead');
  const talk = li.querySelector('.q-talk');
  const chevron = talk.querySelector('svg');
  talk.replaceChildren(item.commentCount ? plural(item.commentCount, 'comment') : 'Talk it through', chevron);
  talk.addEventListener('click', () => openQuestion(item.id));

  const ballotCtl = wireBallot(ballot, item.id, (t) => {
    if (!t.total) {
      footSpan.replaceChildren('No votes yet'); // the drawn foot with no votes has no .lead in it
    } else {
      footSpan.replaceChildren(`${plural(t.total, 'vote')}, `, lead);
      lead.textContent = leadWord(t);
    }
  });
  ballotCtl.set(item);
  return li;
}

const list = createStates(questionsHolder, {
  rows: 3,
  skeleton: listSkeleton,
  empty: {
    title: 'No questions yet',
    text: 'Ask the club the first thing you need to decide.',
    action: { label: 'New question', primary: true, onClick: openNewQuestion },
  },
  error: {
    title: 'Questions did not load',
    text: 'Nothing you posted is lost. Try again in a moment.',
  },
});

// The empty state's New question button carries the header's plus too.
const emptyAction = questionsHolder.querySelector('.state-empty .btn-primary');
if (emptyAction) emptyAction.prepend(svgPath('M12 5v14M5 12h14', 2));

async function loadListTask(box) {
  const data = await api('GET', '/api/questions');
  if (data.demo) showDemoLabel(app, 'Staging demo: the people and questions here are made up.');
  sectionLabel.textContent = `${plural(data.items.length, 'question')}, newest first`;
  sectionLabel.hidden = !data.items.length;
  if (!data.items.length) return false;
  const ul = listTemplate.cloneNode(false);
  for (const item of data.items) ul.append(cardFor(item));
  box.replaceChildren(ul);
  return true;
}

async function refreshList() {
  if (firstListRun) {
    firstListRun = false;
    await list.run(loadListTask);
  } else {
    // Silent refresh: keep what is on screen on failure, never a skeleton
    // flash over a settled list.
    try {
      const found = await loadListTask(list.content);
      if (found === false) list.empty();
      else list.ready();
    } catch (err) {
      console.warn('List refresh failed:', err && err.message);
    }
  }
  if (returnFocusId) {
    const card = list.content.querySelector(`li[data-qid="${returnFocusId}"] .q-open`);
    if (card) card.focus();
    returnFocusId = null;
  }
}

function showList() {
  detailHolder.hidden = true;
  listScreen.hidden = false;
  refreshList();
}

function openQuestion(id) {
  returnFocusId = String(id);
  location.hash = `#/q/${id}`;
}

function goList() {
  location.hash = '';
}

// ── Confirm dialogs ────────────────────────────────────────────────────────
// unNative.alert resolves { button, value }; the button is the one tapped.
// window.confirm stands in outside the native kit.
async function confirmDialog(title, message, confirmLabel, destructive = false) {
  const un = await loadNative();
  if (un && typeof un.alert === 'function') {
    try {
      const r = await un.alert({
        title,
        message,
        buttons: [
          { label: confirmLabel, style: destructive ? 'destructive' : 'default' },
          { label: 'Cancel', style: 'cancel' },
        ],
      });
      return Boolean(r && r.button && r.button.label === confirmLabel);
    } catch (err) {
      console.warn('native alert failed:', err && err.message);
    }
  }
  return window.confirm(message ? `${title}\n\n${message}` : title);
}

// ── Reports and deletes ────────────────────────────────────────────────────
const HIDDEN_NOTE = 'It is hidden for you now, and for everyone once three people report it.';

async function report(kind, id, confirmTitle) {
  const ok = await confirmDialog(confirmTitle, HIDDEN_NOTE, 'Report');
  if (!ok) return;
  try {
    await api('POST', '/api/reports', { kind, id });
    toast('Reported. It is hidden for you now.');
    return true;
  } catch (err) {
    if (err.status !== 401) toast(err.message); // 401: the bridge prompts for an account
    return false;
  }
}

const reportQuestion = (id) => report('question', id, 'Report this question?');
const reportComment = (id) => report('comment', id, 'Report this comment?');

async function removeQuestion(id) {
  const ok = await confirmDialog('Delete your question?', 'Its votes and comments go too.', 'Delete', true);
  if (!ok) return;
  try {
    await api('DELETE', `/api/questions/${id}`);
    toast('Question deleted');
    goList();
  } catch (err) {
    if (err.status !== 401) toast(err.message);
  }
}

// ── New question ───────────────────────────────────────────────────────────

function openNewQuestion() {
  openFormSheet({
    title: 'New question',
    submitLabel: 'Post question',
    savedMessage: 'Question posted',
    fields: [
      {
        name: 'title',
        label: 'Question',
        type: 'text',
        required: true,
        max: 140,
        placeholder: 'e.g. Should we meet on Thursdays?',
      },
      {
        name: 'body',
        label: 'Details',
        type: 'textarea',
        max: 2000,
        placeholder: 'e.g. Why it matters, dates, costs',
      },
    ],
    onSubmit: async (values) => {
      await api('POST', '/api/questions', { title: values.title, body: values.body });
      // The post itself saved; a failed refresh must not tell the person it
      // did not. The next silent refresh picks it up.
      try {
        await refreshList();
      } catch (err) {
        console.warn('List refresh after posting failed:', err && err.message);
      }
    },
  });
}

app.querySelector('.head .btn-primary').addEventListener('click', openNewQuestion);

// ── The question page ──────────────────────────────────────────────────────

let detailView = null;

function commentRow(c, make) {
  const row = make();
  const reportBtn = row.querySelector('.kit-comment-meta .report');
  if (c.byMe && reportBtn) reportBtn.remove();
  row.querySelector('.kit-comment-author').textContent = c.byMe ? 'You' : c.author;
  row.querySelector('.kit-comment-meta span:nth-child(2)').textContent = timeAgo(c.createdAt);
  if (reportBtn && !c.byMe) {
    reportBtn.addEventListener('click', async () => {
      if (await reportComment(c.id)) row.remove(); // hidden for the reporter at once
    });
  }
  row.querySelector('p:not(.kit-comment-meta)').textContent = c.body;
  return row;
}

const summaryText = (t) => {
  const base = t.total
    ? `${plural(t.total, 'vote')}, ${leadWord(t)}`
    : 'No votes yet';
  if (t.mine === null) return base;
  const chosen = t.options.find((o) => o.chosen);
  const other = t.options.find((o) => !o.chosen);
  return `${base}. You voted ${chosen.label}: tap ${other.label} to change it, or ${chosen.label} again to take it back.`;
};

function renderDetail(data) {
  const detail = screen(2);
  if (!detail) throw new Error('the question page is missing');
  const item = data.item;

  detail.querySelector('.kit-detail-title').textContent = item.title;
  detail.querySelector('.meta-line > span').textContent = askedBy(item);
  const actionBtn = detail.querySelector('.meta-line .report');
  if (item.byMe) {
    actionBtn.textContent = 'Delete';
    actionBtn.addEventListener('click', () => removeQuestion(item.id));
  } else {
    actionBtn.addEventListener('click', async () => {
      // Reported once means hidden for the reporter: back to the list, which
      // no longer shows the question.
      if (await reportQuestion(item.id)) goList();
    });
  }
  const bodyEl = detail.querySelector('.kit-detail-body');
  bodyEl.textContent = item.body || '';
  bodyEl.hidden = !item.body;

  detail.querySelector('.back').addEventListener('click', goList);

  const [voteSection, talkSection] = detail.querySelectorAll('.kit-detail > section');
  const summary = voteSection.querySelector('.kit-vote-summary');
  const ballotEl = voteSection.querySelector('.ballot');
  ballotEl.setAttribute('aria-label', `Vote on ${item.title}`); // the drawn screen carries a sample title
  const ballotCtl = wireBallot(ballotEl, item.id, (t) => {
    summary.textContent = summaryText(t);
  });
  ballotCtl.set(item);

  // Comments, oldest first as the server sends them.
  const talkLabel = talkSection.querySelector('.section-label');
  const listEl = talkSection.querySelector('.list');
  const rowMake = rowsFrom(listEl, '.list-row');
  const none = h('p', { class: 'kit-comments-none' }, 'No comments yet. Say what you think.');
  none.hidden = true;
  listEl.after(none);
  let count = item.commentCount;
  talkLabel.textContent = plural(count, 'comment');
  for (const c of data.comments || []) listEl.append(commentRow(c, rowMake));
  if (!count) {
    listEl.hidden = true;
    none.hidden = false;
  }

  const composer = talkSection.querySelector('.kit-composer');
  const textarea = composer.querySelector('textarea');
  const postBtn = composer.querySelector('.btn-primary');
  const errorLine = h('p', { class: 'kit-error', role: 'alert', hidden: true });
  composer.insertBefore(errorLine, composer.querySelector('.kit-composer-actions'));

  postBtn.addEventListener('click', async () => {
    if (postBtn.disabled) return;
    const text = textarea.value.trim();
    if (!text) {
      errorLine.textContent = 'Write something first.';
      errorLine.hidden = false;
      return;
    }
    errorLine.hidden = true;
    postBtn.disabled = true;
    try {
      const saved = await api('POST', `/api/questions/${item.id}/comments`, { body: text });
      textarea.value = '';
      count += 1;
      talkLabel.textContent = plural(count, 'comment');
      if (!none.hidden) {
        none.hidden = true;
        listEl.hidden = false;
      }
      listEl.append(commentRow(saved.comment, rowMake));
    } catch (err) {
      if (err.status === 401) {
        // The bridge prompts for an account; keep what they wrote.
      } else if (err.status >= 400 && err.status < 500) {
        errorLine.textContent = err.message;
        errorLine.hidden = false;
      } else {
        toast(err.message);
      }
    } finally {
      postBtn.disabled = false;
    }
  });

  return detail;
}

function openDetail(id) {
  listScreen.hidden = true;
  detailHolder.hidden = false;
  if (!detailView) {
    detailView = createStates(detailHolder, {
      rows: 3,
      error: {
        title: 'The question did not load',
        text: 'Nothing you posted is lost. Try again in a moment.',
      },
    });
  }
  detailView.run(async (box) => {
    let data;
    try {
      data = await api('GET', `/api/questions/${id}`);
    } catch (err) {
      if (err.status !== 404) throw err;
      box.replaceChildren(h('div', { class: 'state-empty' },
        h('h2', { class: 'text-heading' }, 'That question is no longer here.'),
        h('p', { class: 'text-body text-muted' },
          'It may have been deleted by the person who asked it, or hidden after reports.'),
        h('button', { type: 'button', class: 'btn-secondary mt-2', on: { click: goList } },
          'Back to questions')));
      return true;
    }
    box.replaceChildren(renderDetail(data));
    return true;
  });
}

// ── Routing and freshness ──────────────────────────────────────────────────

function route() {
  const m = location.hash.match(/^#\/q\/(\d+)$/);
  if (m) openDetail(Number(m[1]));
  else showList();
}

window.addEventListener('hashchange', route);
route();

// Fresh while open: on coming back to the tab and every half minute, quietly
// reload the list when it is what is showing.
const listIsShowing = () => !document.hidden && !listScreen.hidden;
document.addEventListener('visibilitychange', () => {
  if (listIsShowing() && !votesInFlight) refreshList();
});
setInterval(() => {
  if (listIsShowing() && !votesInFlight) refreshList();
}, 30000);

// Pull down to refresh, where the native kit offers it.
loadNative().then((un) => {
  if (!un || typeof un.attachPullToRefresh !== 'function') return;
  try {
    un.attachPullToRefresh(window, () => {
      if (listIsShowing() && !votesInFlight) refreshList();
    });
  } catch (err) {
    console.warn('pull to refresh failed:', err && err.message);
  }
});