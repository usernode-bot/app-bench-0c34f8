// RSS Reader, the app half: one unread list, a preview, and the feeds sheet.
// The drawn screens in index.html stay as they are; this fills them with real
// data (fill.js), never rebuilds them, and never renders a post as HTML.
import { h, api, timeAgo, plural } from '/kit/dom.js';
import { rowsFrom, fillIn } from '/kit/fill.js';
import { createStates } from '/kit/states.js';
import { openSheet, renderForm } from '/kit/sheet.js';
import { showDemoLabel } from '/kit/demo.js';
import { loadNative, native, toast } from '/kit/native.js';

const screen1 = document.querySelector('[data-spec-screen="1"]');
const listMain = screen1.querySelector('main');
const listEl = screen1.querySelector('.list');
const footEl = screen1.querySelector('.foot');
const countLine = document.getElementById('count-line');
const countSkeleton = document.getElementById('count-skeleton');
const feedErrors = document.getElementById('feed-errors');
const previewEl = document.getElementById('post-preview');
const addBtn = screen1.querySelector('header .btn-primary');

// The row the spec drew, to repeat; the samples come out of the list.
const postRow = rowsFrom(listEl);
const FEED_CLASSES = ['f1', 'f2', 'f3', 'f4', 'f5'];
const feedClass = (id) => FEED_CLASSES[id % 5 === 0 ? 4 : (id % 5) - 1];
const feedLetter = (feed) => ((feed.title || '?').trim().charAt(0).toUpperCase() || '?');

let feeds = [];
let posts = []; // unread only; a tapped post stays in the list, dimmed
let previewPost = null;
let previewFeed = null;

/* ── Head: the count line and per-feed failure notes ────────────────────── */

function renderMeta() {
  countSkeleton.hidden = true;
  const unread = posts.filter((p) => !p.read).length;
  countLine.hidden = unread === 0;
  if (unread) {
    const feedPart = feeds.length === 1 ? '1 feed' : `${feeds.length} feeds`;
    countLine.textContent = `${plural(unread, 'new post')} from ${feedPart}`;
  }
  const failed = feeds.filter((f) => f.lastError);
  feedErrors.replaceChildren(...failed.map((f) => h('p', { class: 'feed-note' },
    `${f.title} did not update, so its newest posts may be missing`)));
  feedErrors.hidden = failed.length === 0;
}

/* ── The unread list ────────────────────────────────────────────────────── */

function makeRow(post, feed) {
  const row = postRow();
  const badge = row.querySelector('.badge');
  badge.firstChild.nodeValue = feedLetter(feed);
  for (const c of FEED_CLASSES) badge.classList.remove(c);
  badge.classList.add(feedClass(feed.id));
  fillIn(row, {
    '.feed': feed.title,
    'time': timeAgo(post.publishedAt),
    '.title': post.title,
    '.sum': post.summary || '',
    '.dot': { hidden: !!post.read },
    '': { attr: { 'data-post-row': true }, class: { read: !!post.read } },
  });
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  const open = () => openPost(post, feed, row);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  return row;
}

function renderList(content) {
  // createStates cleared #states, which detached the drawn list; put it back
  // inside the kit's content (a move, so later loads are a no-op).
  content.append(listEl, footEl);
  const byFeed = new Map(feeds.map((f) => [f.id, f]));
  listEl.replaceChildren(...posts
    .filter((p) => byFeed.has(p.feedId))
    .map((p) => makeRow(p, byFeed.get(p.feedId))));
}

// Mark read on tap, Feedly-style: dim the row at once, undo it if the
// request fails, and keep it in the list until the next refresh.
function openPost(post, feed, row) {
  if (!post.read) {
    post.read = true;
    row.classList.add('read');
    row.querySelector('.dot').hidden = true;
    renderMeta();
    api('POST', `/api/posts/${post.id}/read`).catch(() => {
      post.read = false;
      row.classList.remove('read');
      row.querySelector('.dot').hidden = false;
      renderMeta();
      toast('That post is still unread.');
    });
  }
  showPreview(post, feed);
}

/* ── The preview (screen 2) ─────────────────────────────────────────────── */

const previewBadge = previewEl.querySelector('.source .badge');
const openArticleBtn = previewEl.querySelector('.btn-primary');
const backBtn = previewEl.querySelector('.back');

function fillPreview(post, feed) {
  previewBadge.firstChild.nodeValue = feedLetter(feed);
  for (const c of FEED_CLASSES) previewBadge.classList.remove(c);
  previewBadge.classList.add(feedClass(feed.id));
  const paras = String(post.summary || '').split('\n')
    .map((s) => s.trim()).filter(Boolean).map((s) => h('p', null, s));
  let hostText = '';
  try {
    const host = new URL(post.link || feed.siteUrl || '', location.href).hostname;
    if (host) hostText = `Opens ${host} in your browser`;
  } catch {}
  fillIn(previewEl, {
    '.source .feed': feed.title,
    '.source .source-text .text-small': timeAgo(post.publishedAt) || 'just now',
    'h1.text-title': post.title,
    '.summary': { children: paras.length ? paras : [h('p', null, 'No summary came with this post. Open the full article to read it.')] },
    '.host': { text: hostText, hidden: !hostText },
    '.btn-primary': { hidden: !post.link },
  });
}

async function showPreview(post, feed) {
  previewPost = post;
  previewFeed = feed;
  fillPreview(post, feed);
  const show = () => {
    listMain.hidden = true;
    previewEl.hidden = false;
    window.scrollTo(0, 0);
  };
  const un = native();
  if (un && typeof un.transition === 'function') {
    try { await un.transition(show, { type: 'push' }); return; } catch {}
  }
  show();
}

function closePreview() {
  const hide = () => {
    previewEl.hidden = true;
    listMain.hidden = false;
  };
  const un = native();
  if (un && typeof un.transition === 'function') {
    try { un.transition(hide, { type: 'pop' }); return; } catch {}
  }
  hide();
}

backBtn.addEventListener('click', closePreview);
openArticleBtn.addEventListener('click', () => {
  if (previewPost && previewPost.link) window.open(previewPost.link, '_blank', 'noopener');
});

/* ── Your feeds: add one, remove one ────────────────────────────────────── */

// Just the host, so the line under the name fits instead of being cut off.
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function sheetRow(feed, rerender) {
  const removeBtn = h('button', {
    type: 'button', class: 'btn-secondary',
    on: { click: () => removeFeed(feed, rerender) },
  }, 'Remove');
  return h('li', { class: 'un-group-row flex min-h-11 items-center gap-3 px-4 py-3' },
    h('div', { class: 'kit-row-text' },
      h('span', { class: 'kit-row-title' }, feed.title),
      h('span', { class: 'kit-row-sub' }, hostOf(feed.url))),
    removeBtn);
}

async function removeFeed(feed, rerender) {
  const doRemove = async () => {
    try {
      await api('DELETE', `/api/feeds/${feed.id}`);
      await load();
      rerender();
      toast('Feed removed');
    } catch (err) {
      toast(err.message);
    }
  };
  const un = native();
  if (un && typeof un.alert === 'function') {
    un.alert({
      title: 'Remove feed',
      message: `Remove ${feed.title} and its posts from your list?`,
      buttons: [
        { label: 'Remove', style: 'destructive', handler: doRemove },
        { label: 'Cancel' },
      ],
    });
  } else {
    doRemove();
  }
}

async function openFeedsSheet() {
  await openSheet({
    title: 'Add feed',
    returnFocus: addBtn,
    content: (body) => {
      let listWrap;
      const renderSheetList = () => {
        listWrap.replaceChildren(...(feeds.length
          ? feeds.map((f) => sheetRow(f, renderSheetList))
          : [h('li', { class: 'un-group-row px-4 py-3 text-small text-muted' }, 'No feeds yet.')]));
      };
      const form = renderForm(body, {
        fields: [{
          name: 'url', label: 'Feed link', type: 'text',
          required: true, max: 2048,
          placeholder: 'e.g. https://example.com/feed.xml',
        }],
        submitLabel: 'Add feed',
        savedMessage: null,
        onSubmit: async (values) => {
          await api('POST', '/api/feeds', { url: values.url });
          await load();
          renderSheetList();
          const input = form.querySelector('input');
          if (input) input.value = '';
          toast('Feed added');
        },
      });
      listWrap = h('ul', { class: 'un-group kit-group mt-2' });
      body.append(h('p', { class: 'section-label mt-6 px-0' }, 'Your feeds'), listWrap);
      renderSheetList();
    },
  });
}

addBtn.addEventListener('click', () => { openFeedsSheet().catch(() => {}); });

/* ── Loading, empty, error ──────────────────────────────────────────────── */

const states = createStates(document.getElementById('states'), {
  rows: 5,
  empty: {
    title: 'No feeds yet',
    text: "Paste the link to a site's RSS feed to see its new posts here.",
    action: { label: 'Add feed', primary: true, onClick: () => { openFeedsSheet().catch(() => {}); } },
  },
  error: {
    title: 'Your posts did not load',
    text: 'Your feeds are saved. Try again in a moment.',
  },
});

function setEmpty(title, text, withAction) {
  const box = states.content.parentElement.querySelector('.state-empty');
  const heading = box.querySelector('h2');
  const line = box.querySelector('p');
  const action = box.querySelector('button');
  heading.textContent = title;
  line.textContent = text;
  line.hidden = !text;
  action.hidden = !withAction;
}

async function loadTask(content) {
  // The count line waits for the posts it counts: a skeleton bar takes its
  // place while loading, and nothing there if the load fails.
  countSkeleton.hidden = false;
  let data;
  try {
    data = await api('GET', '/api/posts');
  } catch (err) {
    countSkeleton.hidden = true;
    throw err;
  }
  feeds = data.feeds;
  posts = data.posts;
  // No feeds yet: the empty state's own Add feed is the one primary action.
  addBtn.hidden = feeds.length === 0;
  renderMeta();
  if (data.demo) showDemoLabel(screen1, 'Staging demo: these feeds and posts are made up.');
  if (!feeds.length) {
    setEmpty('No feeds yet', "Paste the link to a site's RSS feed to see its new posts here.", true);
    return false;
  }
  if (!posts.length) {
    const feedPart = feeds.length === 1 ? 'your 1 feed' : `your ${feeds.length} feeds`;
    setEmpty('All caught up', `New posts from ${feedPart} show up here.`, false);
    return false;
  }
  renderList(content);
  return true;
}

const load = () => states.run(loadTask);

load();

loadNative().then((un) => {
  if (un && typeof un.attachPullToRefresh === 'function') {
    un.attachPullToRefresh(window, () => load());
  }
});