// RSS Reader: unread posts from every feed in one list.
// The drawn screens in index.html are filled with real data: one drawn row
// (the <template id="row">) repeats for each post, the preview fills in
// place, and the states (loading, empty, error) come from the kit.
import { api, h, clear, timeAgo } from '/kit/dom.js';
import { fillIn } from '/kit/fill.js';
import { createStates } from '/kit/states.js';
import { openFormSheet, openSheet } from '/kit/sheet.js';
import { loadNative, toast } from '/kit/native.js';
import { showDemoLabel } from '/kit/demo.js';

const listView = document.getElementById('list-view');
const detail = document.getElementById('detail');
const app = listView.querySelector('.app');
const countEl = document.getElementById('count');
const feedsLink = document.getElementById('feeds-link');

// The drawn row, repeated. A row is one button, so the whole row is the tap
// target; the unread dot and the is-read dimming stay as drawn.
const rowMake = () => document.getElementById('row').content.firstElementChild.cloneNode(true);

const statesEl = document.getElementById('view');
const view = createStates(statesEl, {
  rows: 4,
  empty: {
    title: 'Add your first feed',
    text: 'Paste the address of an RSS or Atom feed. Its new posts show up here.',
    action: { label: 'Add a feed', onClick: () => openAddFeed(), primary: true },
  },
  error: { title: 'Your posts did not load', text: 'Your feeds are saved. Try again in a moment.' },
});
// The empty state carries the app's mark, in the accent orange.
statesEl.querySelector('.state-empty').prepend(waveMark());
statesEl.querySelector('.state-error button').textContent = 'Retry';

const emptyEl = statesEl.querySelector('.state-empty');
function setEmpty({ title, text, button, primary, onClick }) {
  fillIn(emptyEl, { h2: title, p: text });
  const btn = emptyEl.querySelector('button');
  btn.textContent = button;
  btn.classList.toggle('btn-primary', !!primary);
  btn.classList.toggle('btn-secondary', !primary);
  btn.onclick = onClick;
}

// The RSS wave, drawn here so it can lead the empty states.
function waveMark() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('class', 'h-10 w-10 text-accent');
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', '5.5');
  dot.setAttribute('cy', '18.5');
  dot.setAttribute('r', '1.6');
  dot.setAttribute('fill', 'currentColor');
  dot.setAttribute('stroke', 'none');
  for (const d of ['M4 11a9 9 0 0 1 9 9', 'M4 4a16 16 0 0 1 16 16']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  svg.prepend(dot);
  return svg;
}

let current = null; // { posts, feeds, demo } from the last load
let unreadCount = 0;
let lastRow = null;

const load = () => view.run(async (box) => {
  const data = await api('GET', '/api/posts');
  current = data;
  unreadCount = data.posts.length;
  if (data.demo) showDemoLabel(app, 'Staging demo: these feeds and posts are made up.');
  renderCount();
  feedsLink.hidden = !data.feeds.length;
  feedsLink.textContent = `Your feeds (${data.feeds.length})`;
  if (!data.feeds.length) {
    setEmpty({
      title: 'Add your first feed',
      text: 'Paste the address of an RSS or Atom feed. Its new posts show up here.',
      button: 'Add a feed', primary: true, onClick: openAddFeed,
    });
    return false;
  }
  if (!data.posts.length) {
    const n = data.feeds.length;
    setEmpty({
      title: "You're all caught up",
      text: `New posts from your ${n} ${n === 1 ? 'feed' : 'feeds'} show up here.`,
      button: 'Refresh', primary: false, onClick: load,
    });
    return false;
  }
  renderPosts(box, data);
});

function renderCount() {
  const n = current ? current.feeds.length : 0;
  if (!n) { countEl.replaceChildren(); return; }
  countEl.replaceChildren(h('b', {}, `${unreadCount} unread`), ` from ${n} ${n === 1 ? 'feed' : 'feeds'}`);
}

function renderPosts(box, data) {
  const failed = data.feeds.filter((f) => f.error);
  const ul = h('ul', { class: 'list kit-group' });
  for (const post of data.posts) {
    const li = rowMake();
    fillIn(li, {
      '.site': post.feedTitle,
      '.time': timeAgo(post.publishedAt),
      '.title': post.title,
      '.sum': { text: post.summary || '', hidden: !post.summary },
      button: { on: { click: () => openPost(post, li) } },
    });
    ul.append(li);
  }
  box.replaceChildren(...(failed.length ? [feedErrorLine(failed)] : []), ul);
}

// A feed that failed this refresh says so above the list; the rest of the
// posts are still there, and Retry asks the feeds again.
function feedErrorLine(failed) {
  const names = failed.map((f) => f.title);
  const who = names.length === 1 ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return h('p', { class: 'text-small text-muted flex items-center gap-1 px-1' },
    `${who} could not load. The rest of your posts are here.`,
    h('button', { type: 'button', class: 'icon-btn', on: { click: load } }, 'Retry'));
}

// Tapping a post marks it read right away and opens the preview. The row
// stays dimmed with an empty dot until the list next loads.
async function openPost(post, li) {
  lastRow = li;
  if (!post.read) {
    post.read = true;
    unreadCount = Math.max(0, unreadCount - 1);
    renderCount();
    li.classList.add('is-read');
    li.querySelector('.dot').classList.add('read');
    api('POST', `/api/posts/${post.id}/read`).catch(() => {});
  }
  fillDetail(post);
  const un = await loadNative();
  const show = () => { listView.hidden = true; detail.hidden = false; window.scrollTo(0, 0); };
  if (un && typeof un.transition === 'function') un.transition(show, { type: 'push' });
  else show();
}

async function closePost() {
  const un = await loadNative();
  const hide = () => {
    detail.hidden = true;
    listView.hidden = false;
    const btn = lastRow && lastRow.querySelector('button');
    if (btn) btn.focus({ preventScroll: true });
  };
  if (un && typeof un.transition === 'function') un.transition(hide, { type: 'pop' });
  else hide();
}

function fillDetail(post) {
  const paragraphs = String(post.summary || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
    .map((t) => h('p', {}, t));
  const open = !!post.link && /^https?:\/\//i.test(post.link);
  let host = '';
  if (open) { try { host = new URL(post.link).hostname; } catch { /* no note then */ } }
  fillIn(detail, {
    '.meta .site': post.feedTitle,
    '.meta .time': timeAgo(post.publishedAt),
    h1: post.title,
    '.byline': { text: post.author ? `By ${post.author}` : '', hidden: !post.author },
    '.kit-detail-body': { children: paragraphs },
    'a.btn-primary': { attr: { href: open ? post.link : null }, hidden: !open },
    '.note': { text: host ? `Opens the full article on ${host}` : '', hidden: !host },
    '.back': { on: { click: closePost } },
  });
}

// Add feed: paste the address, tap Add feed. A feed that will not load says
// so in the form, and what was typed stays.
function openAddFeed() {
  openFormSheet({
    title: 'Add feed',
    submitLabel: 'Add feed',
    savedMessage: 'Feed added',
    fields: [{
      name: 'url', label: 'Feed address', required: true, max: 500,
      placeholder: 'e.g. https://example.com/feed.xml', hint: 'An RSS or Atom feed address.',
    }],
    onSubmit: async (values) => {
      await api('POST', '/api/feeds', { url: values.url });
      load();
    },
  });
}

// Your feeds: each one's address, and Remove, which asks first.
function openFeeds() {
  openSheet({ title: 'Your feeds', content: (body) => renderFeeds(body) });
}

function renderFeeds(body) {
  const feeds = (current && current.feeds) || [];
  if (!feeds.length) {
    clear(body).append(h('p', { class: 'text-small text-muted px-1' }, 'No feeds yet. Add one with Add feed.'));
    return;
  }
  const ul = h('ul', { class: 'kit-group' });
  for (const feed of feeds) {
    ul.append(h('li', { class: 'un-group-row list-row' },
      h('span', { class: 'kit-row-text' },
        h('span', { class: 'kit-row-title' }, feed.title),
        h('span', { class: 'kit-row-sub' }, feed.url)),
      h('button', { type: 'button', class: 'btn-secondary shrink-0', on: { click: () => removeFeed(feed, body) } }, 'Remove')));
  }
  clear(body).append(ul);
}

async function removeFeed(feed, body) {
  if (!(await confirmRemove(feed))) return;
  try {
    await api('DELETE', `/api/feeds/${feed.id}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  toast('Feed removed');
  load();
  renderFeeds(body);
}

async function confirmRemove(feed) {
  const un = await loadNative();
  const message = `Remove ${feed.title}? Its posts leave your list.`;
  if (un && typeof un.alert === 'function') {
    const picked = await un.alert({
      title: 'Remove feed',
      message,
      buttons: [{ label: 'Cancel', style: 'cancel' }, { label: 'Remove', style: 'destructive' }],
    });
    // unNative.alert resolves { button, value }; no answer means it was dismissed.
    const button = picked && typeof picked === 'object' ? picked.button : null;
    return !!button && (button.label === 'Remove' || button.style === 'destructive');
  }
  return window.confirm(message);
}

document.getElementById('add-feed').addEventListener('click', openAddFeed);
document.getElementById('refresh').addEventListener('click', load);
feedsLink.addEventListener('click', (e) => { e.preventDefault(); openFeeds(); });
loadNative().then((un) => {
  if (un && typeof un.attachPullToRefresh === 'function') un.attachPullToRefresh(window, load);
});
load();