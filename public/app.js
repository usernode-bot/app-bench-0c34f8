// The unread list: one scrolling list of unread posts, newest first, each
// row tap-to-preview. Built on the drawn screens: screen 1 is in the page
// and screen 2 (a row opened, article inline) supplies the actions bar. The
// states come from the kit, the Add feed panel is a form sheet.
import { api, h, clear, timeAgo } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { openFormSheet } from '/kit/sheet.js';
import { toast } from '/kit/native.js';
import { rowsFrom, fillIn } from '/kit/fill.js';
import { showDemoLabel } from '/kit/demo.js';

const app = document.querySelector('[data-spec-screen="1"] .app');
const countLine = app.querySelector('.count');
const endLine = app.querySelector('.end');
const addBtn = app.querySelector('.top .btn-primary');
const drawnList = app.querySelector('.list');
const drawnScreen2 = document.querySelector('template[data-spec-screen="2"]');
const actionsTpl = drawnScreen2 && drawnScreen2.content.querySelector('.actions');

// The row to repeat, from the drawn samples. Each row becomes
// <li><button class="list-row kit-row" data-post="…">…</button></li>: the
// button carries the row (a row is one tap target), the li keeps it in the
// drawn ul so screens.css styles it as before.
const drawnRow = rowsFrom(drawnList);
const rowProto = drawnRow();
rowProto.className = 'un-group-row';
const rowButton = document.createElement('button');
rowButton.type = 'button';
rowButton.className = 'list-row kit-row';
rowButton.setAttribute('aria-expanded', 'false');
rowButton.append(...rowProto.childNodes);
rowProto.replaceChildren(rowButton);
const listProto = drawnList.cloneNode(false);
drawnList.remove();

// The per-feed refresh failure line sits above the list, with a Retry of
// its own (the rest of the list loaded fine).
const retryBtn = h('button', { type: 'button', class: 'btn-secondary', on: { click: () => load() } }, 'Retry');
const failedText = h('span');
const failedLine = h('p', { class: 'text-small text-danger flex flex-wrap items-center gap-2', hidden: true }, failedText, retryBtn);
const statesEl = h('div');
countLine.after(failedLine, statesEl);

const view = createStates(statesEl, {
  rows: 5,
  empty: {
    title: 'Add your first feed',
    text: 'New posts from the sites you add appear here, newest first.',
    action: { label: 'Add feed', onClick: () => openAddSheet(), primary: true },
  },
  error: {
    title: "Couldn't load your posts.",
    text: 'Your feeds are still saved and nothing was lost. Try again in a moment.',
  },
});
const emptyEl = statesEl.querySelector('.state-empty');

let feedCount = 0;
let expanded = null; // the row that is open, if any

function setCount(unread) {
  clear(countLine).append(
    h('b', null, `${unread} unread`),
    ` from ${feedCount} ${feedCount === 1 ? 'feed' : 'feeds'}`);
}

// Two empty states, one element: no feeds yet invites the first feed;
// feeds with nothing unread says you are caught up (and hides the button).
function setEmpty(data) {
  const hasFeeds = data.feedCount > 0;
  emptyEl.querySelector('h2').textContent = hasFeeds ? 'All caught up' : 'Add your first feed';
  const p = emptyEl.querySelector('p');
  if (p) p.textContent = hasFeeds
    ? `No unread posts from your ${feedCount} ${feedCount === 1 ? 'feed' : 'feeds'}.`
    : 'New posts from the sites you add appear here, newest first.';
  const btn = emptyEl.querySelector('button');
  if (btn) btn.hidden = hasFeeds;
}

function makeRow(p) {
  const li = rowProto.cloneNode(true);
  li.querySelector('button').dataset.post = p.id;
  fillIn(li, {
    '.badge': (p.feedTitle || '?').charAt(0).toUpperCase(),
    '.srcname': p.feedTitle || 'Feed',
    '.time': timeAgo(p.publishedAt),
    '.title': p.title || 'Untitled post',
    '.snip': p.snippet || '',
    '.dot': { class: { dot: true, read: false } },
    'button': { on: { click: () => toggleRow(p, li) } },
  });
  return li;
}

// Article text, inline where the post sits: server-sanitized HTML rendered
// by the DOM parser, with scripts and frames stripped again here for good
// measure. Pictures load lazily.
function articleEl(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  for (const n of doc.querySelectorAll('script, style, iframe, frame, object, embed, link, meta, form, base')) n.remove();
  for (const img of doc.querySelectorAll('img')) {
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
  }
  const el = document.createElement('div');
  el.className = 'article';
  el.append(...doc.body.childNodes);
  return el;
}

function openRow(p, li) {
  const post = li.querySelector('.post');
  const article = articleEl(p.contentHtml);
  const actions = actionsTpl ? actionsTpl.cloneNode(true) : null;
  // Clicks inside the opened article (Close, the link, the text itself) must
  // not bubble to the row button, whose handler would toggle the row again.
  const swallow = (ev) => ev.stopPropagation();
  article.addEventListener('click', swallow);
  if (actions) actions.addEventListener('click', swallow);
  if (actions) {
    const link = actions.querySelector('a');
    if (p.link) link.href = p.link;
    else link.remove();
    actions.querySelector('button').addEventListener('click', () => {
      if (expanded === li) expanded = null;
      closeRow(li);
      loadIfDrained();
    });
  }
  li.querySelector('.snip').hidden = true;
  post.append(article, actions);
  li.classList.add('open');
  li.querySelector('button').setAttribute('aria-expanded', 'true');
}

function closeRow(li) {
  li.querySelector('.article')?.remove();
  li.querySelector('.actions')?.remove();
  li.querySelector('.snip').hidden = false;
  li.classList.remove('open');
  li.querySelector('button').setAttribute('aria-expanded', 'false');
}

// When the open post is closed with its Close button, nothing unread may be
// left on screen — refetch so what "gone next time you open" promised is kept.
function loadIfDrained() {
  if (document.querySelectorAll('[data-post]').length <= 1) load();
}

function toggleRow(p, li) {
  if (expanded === li) {
    expanded = null;
    closeRow(li);
    return;
  }
  if (expanded) closeRow(expanded);
  expanded = li;
  if (!p.read) {
    p.read = true;
    fillIn(li, { '.dot': { class: { dot: false, read: true } } });
    setCount(Math.max(0, countNow() - 1));
    api('POST', `/api/posts/${p.id}/read`).catch(() => {
      toast("Could not save that you read this. It will count as unread next time.");
    });
  }
  openRow(p, li);
}

function countNow() {
  const b = countLine.querySelector('b');
  return b ? parseInt(b.textContent, 10) || 0 : 0;
}

async function load() {
  failedLine.hidden = true;
  endLine.hidden = true;
  await view.run(async (box) => {
    const data = await api('GET', '/api/posts');
    if (data.demo) showDemoLabel(app, 'Staging demo: the feeds and posts here are made up.');
    feedCount = data.feedCount || 0;
    setCount(data.posts.length);
    if (data.failed && data.failed.length) {
      failedText.textContent = `Couldn't refresh ${data.failed.join(', ')}. Showing what was already loaded.`;
      failedLine.hidden = false;
    }
    if (!data.posts.length) {
      setEmpty(data);
      return false;
    }
    expanded = null;
    const ul = listProto.cloneNode(false);
    ul.append(...data.posts.map(makeRow));
    clear(box).append(ul);
    endLine.hidden = false;
    return true;
  });
}

function openAddSheet() {
  openFormSheet({
    title: 'Add feed',
    submitLabel: 'Add feed',
    savedMessage: null,
    fields: [
      { name: 'url', label: 'Feed address', type: 'text', required: true, max: 500,
        placeholder: 'e.g. https://example.com/feed.xml' },
    ],
    onSubmit: async (values) => {
      const r = await api('POST', '/api/feeds', { url: values.url });
      toast(`Added ${r.feed.title}`);
      await load();
      return r;
    },
  });
}

addBtn.addEventListener('click', openAddSheet);
load();