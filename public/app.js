// The reader: one list of unread posts from every feed, a preview sheet, and
// the sheets for adding feeds and managing the ones you follow. The drawn
// screen (data-spec-screen="1") is kept and filled; its sample rows are
// taken out the moment the first load starts.
import { api, h, now, timeAgo } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { openFormSheet, openSheet } from '/kit/sheet.js';
import { fillIn, rowsFrom, groupsFrom, screen } from '/kit/fill.js';
import { toast, native } from '/kit/native.js';
import { showDemoLabel } from '/kit/demo.js';

const root = document.querySelector('[data-spec-screen="1"]');
const main = root.querySelector('main');
const bar = root.querySelector('.bar');
const barCount = bar.querySelector('.bar-text .muted');
const addFeedButton = bar.querySelector('.btn-primary');
const feedsButton = bar.querySelector('.btn-secondary');

// The drawn row and day-group templates, captured before the first render
// takes the samples out.
const postRow = rowsFrom(root.querySelector('.list'));
const dayGroup = groupsFrom(root, '.section-label', '.list');

const DOT_CLASSES = { f1: false, f2: false, f3: false, f4: false, f5: false, f6: false };
const dotClasses = (color) => ({ ...DOT_CLASSES, ['f' + (color || 1)]: true });

let feeds = [];
let unreadCount = 0;

function countLine(nPosts, nFeeds) {
  return `${nPosts === 1 ? '1 post' : pluralWord(nPosts, 'posts')} from ${nFeeds === 1 ? '1 feed' : nFeeds + ' feeds'}`;
}
function pluralWord(n, word) {
  return n === 1 ? '1 ' + word.slice(0, -1) : n + ' ' + word;
}

function updateBar(nUnread) {
  unreadCount = nUnread;
  barCount.textContent = countLine(nUnread, feeds.length);
  // With no feeds the empty state carries the one Add feed button.
  addFeedButton.hidden = feeds.length === 0;
}

// A line above the list naming the feeds that failed this load, with Retry.
const failLine = h('div', { class: 'kit-demo-label flex items-center justify-between gap-3', hidden: true },
  h('span', { class: 'text-small text-muted' }),
  h('button', { type: 'button', class: 'btn-secondary', on: { click: () => load() } }, 'Retry'));

function showFailed(failed) {
  failLine.hidden = !failed.length;
  if (failed.length) {
    failLine.firstChild.textContent = 'Could not load ' + failed.map((f) => f.title).join(', ') + '.';
  }
}

function renderEmpty({ title, text, withAction }) {
  const el = main.querySelector('.state-empty');
  el.replaceChildren(
    h('h2', { class: 'text-heading' }, title),
    h('p', { class: 'text-body text-muted' }, text),
    withAction ? h('button', { type: 'button', class: 'btn-primary mt-2', on: { click: openAddFeed } }, 'Add feed') : null);
}

function load() {
  const view = createStates(main, {
    rows: 6,
    empty: { title: '', text: '' }, // written over before it is shown, below
    error: {
      title: 'Your posts did not load',
      text: 'Your feeds and what you have read are safe. Check the connection and try again.',
    },
  });
  view.content.prepend(failLine);
  view.run(async (box) => {
    const data = await api('GET', '/api/posts');
    if (data.demo) showDemoLabel(main, 'Staging demo: these feeds and posts are made up.');
    feeds = data.feeds || [];
    showFailed(data.failed || []);
    updateBar((data.posts || []).length);
    if (!feeds.length) {
      renderEmpty({
        title: 'No feeds yet',
        text: 'Paste the address of a site or a feed, and its new posts will join this list.',
        withAction: true,
      });
      return false;
    }
    if (!data.posts.length) {
      renderEmpty({ title: "You're all caught up", text: 'New posts from your feeds will appear here as they are published.' });
      return false;
    }
    renderPosts(box, data.posts);
  });
}

function dayKey(when) {
  const date = new Date(when);
  return date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate();
}

function groupByDay(posts) {
  const at = new Date(now());
  const yesterday = new Date(at);
  yesterday.setDate(at.getDate() - 1);
  const todayKey = dayKey(at);
  const yesterdayKey = dayKey(yesterday);
  const groups = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Earlier', items: [] },
  ];
  for (const post of posts) { // newest first from the server
    if (!post.publishedAt) groups[2].items.push(post);
    else if (dayKey(post.publishedAt) === todayKey) groups[0].items.push(post);
    else if (dayKey(post.publishedAt) === yesterdayKey) groups[1].items.push(post);
    else groups[2].items.push(post);
  }
  return groups.filter((group) => group.items.length);
}

function renderPosts(box, posts) {
  for (const group of groupByDay(posts)) {
    const g = dayGroup(group.label);
    g.list.append(...group.items.map((post) => {
      const row = postRow();
      fillIn(row, {
        '': { class: { unread: true, read: false } },
        '.dot': { class: dotClasses(post.color) },
        '.src': post.feedTitle,
        '.when': post.publishedAt ? timeAgo(post.publishedAt) : '',
        '.post-title': post.title,
      });
      row.setAttribute('data-post-row', '');
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.addEventListener('click', () => openPost(post, row));
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPost(post, row); }
      });
      return row;
    }));
    box.append(g.heading, g.list);
  }
}

// Reading a post marks it read: the rail goes and the title dims. It stays
// in the list until the app is opened again.
function markRead(post, row) {
  if (row && row.classList.contains('read')) return;
  if (row) { row.classList.remove('unread'); row.classList.add('read'); }
  updateBar(unreadCount - 1);
  api('POST', '/api/posts/read', { key: post.key }).catch(() => { /* it will not be in the next load then */ });
}

function fullDate(when) {
  const date = new Date(when);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }) + ', ' +
    date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// The summary is one plain-text block; break it into short paragraphs.
function paragraphs(text) {
  const sentences = (text || '').split(/(?<=[.!?])\s+/).filter(Boolean);
  if (!sentences.length) return [h('p', {}, '')];
  const out = [];
  for (let i = 0; i < sentences.length; i += 2) {
    out.push(h('p', {}, sentences.slice(i, i + 2).join(' ')));
  }
  return out;
}

function openPost(post, row) {
  const drawn = screen(2);
  const body = drawn.querySelector('.body');
  const foot = drawn.querySelector('.foot');
  fillIn(body, {
    '.dot': { class: dotClasses(post.color) },
    '.src': post.feedTitle,
    '.text-heading': post.title,
    '.date': post.publishedAt ? fullDate(post.publishedAt) : '',
  });
  body.querySelector('.summary').replaceChildren(...paragraphs(post.summary));
  const openLink = foot.querySelector('a.btn-primary');
  const host = foot.querySelector('.host');
  const link = /^https?:\/\//i.test(post.link || '') ? post.link : null;
  openLink.hidden = !link;
  if (link) {
    openLink.setAttribute('href', link);
    openLink.setAttribute('target', '_blank');
    openLink.setAttribute('rel', 'noopener');
    host.textContent = 'Opens ' + new URL(link).hostname + ' in your browser';
  } else {
    host.textContent = 'This post has no link to open.';
  }
  markRead(post, row);
  openSheet({
    title: 'Post preview',
    returnFocus: row,
    content: (sheetBody) => sheetBody.append(body, foot),
  });
}

function openAddFeed() {
  openFormSheet({
    title: 'Add feed',
    submitLabel: 'Add feed',
    savedMessage: 'Feed added',
    returnFocus: addFeedButton,
    fields: [
      { name: 'url', label: 'Feed address', required: true, placeholder: 'e.g. https://example.com/feed' },
    ],
    onSubmit: async (values) => {
      await api('POST', '/api/feeds', { url: values.url });
      load();
    },
  });
}

function openFeeds() {
  openSheet({
    title: 'Your feeds',
    returnFocus: feedsButton,
    content: (body) => {
      if (!feeds.length) {
        body.append(h('p', { class: 'text-body text-muted' }, 'You have no feeds yet. Add one and its posts will appear in your list.'));
        return;
      }
      const list = h('ul', { class: 'list' });
      for (const feed of feeds) {
        list.append(h('li', { class: 'list-row' },
          h('div', { class: 'flex items-center gap-2' },
            h('span', { class: 'dot ' + 'f' + (feed.color || 1) }),
            h('span', { class: 'src flex-1 min-w-0' }, feed.title),
            h('button', { type: 'button', class: 'btn-secondary', on: { click: () => confirmRemove(feed) } }, 'Remove')),
          h('p', { class: 'text-small text-muted break-all' }, feed.url)));
      }
      body.append(list);
    },
  });
}

// Confirming a Remove: the native alert when it is loaded, else a small sheet.
function confirmRemove(feed) {
  const un = native();
  const remove = async () => {
    await api('DELETE', '/api/feeds/' + feed.id);
    feeds = feeds.filter((f) => f.id !== feed.id);
    updateBar(unreadCount);
    toast('Feed removed');
    openFeeds();
    load();
  };
  const message = 'Remove ' + feed.title + ' and its unread posts from this list?';
  if (un && typeof un.alert === 'function') {
    let done = false;
    const run = () => { if (done) return; done = true; remove().catch((err) => toast(err.message)); };
    un.alert({
      title: 'Remove feed',
      message,
      buttons: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Remove', style: 'destructive', handler: run },
      ],
    }).then((result) => {
      const button = result && result.button;
      if (button && (button.style === 'destructive' || button.label === 'Remove')) run();
    }).catch(() => {});
  } else {
    openSheet({
      title: 'Remove feed',
      content: (body, close) => {
        body.append(
          h('p', { class: 'text-body text-muted' }, message),
          h('div', { class: 'flex gap-2 pt-2' },
            h('button', { type: 'button', class: 'btn-secondary flex-1', on: { click: close } }, 'Cancel'),
            h('button', { type: 'button', class: 'btn-secondary flex-1 text-danger', on: { click: () => { close(); remove().catch((err) => toast(err.message)); } } }, 'Remove')));
      },
    });
  }
}

feedsButton.addEventListener('click', openFeeds);
addFeedButton.addEventListener('click', openAddFeed);
load();
