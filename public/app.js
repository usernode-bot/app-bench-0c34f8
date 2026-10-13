// RSS Reader: one screen, "Unread". All unread posts from the viewer's
// feeds, newest first, grouped under Today / Yesterday / Earlier. Tapping a
// post opens its preview and marks it read on the spot.

import { api, h, icon, plural } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { openFormSheet, openSheet } from '/kit/sheet.js';
import { loadNative, toast } from '/kit/native.js';
import { showDemoLabel } from '/kit/demo.js';

// Whole-literal class names: Tailwind's extractor reads this file as text.
const DOT = ['bg-feed-1', 'bg-feed-2', 'bg-feed-3', 'bg-feed-4', 'bg-feed-5', 'bg-feed-6'];
const RING = ['ring-feed-1', 'ring-feed-2', 'ring-feed-3', 'ring-feed-4', 'ring-feed-5', 'ring-feed-6'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 24 * 60 * 60 * 1000;

// ── State ────────────────────────────────────────────────────────────────────

let feeds = [];
let posts = [];
const readIds = new Set(); // read optimistically this session; the server only returns unread
let listBox = null;        // the states content, once the list is shown

const feedById = (id) => feeds.find((f) => f.id === id);

// ── Small helpers ────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "12 min", "09:48", "Yesterday", "Oct 11". */
function age(post) {
  const d = new Date(post.publishedAt);
  const diff = Date.now() - d.getTime();
  if (diff < 60 * 1000) return 'Just now';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} min`;
  if (startOfDay(d.getTime()) === startOfDay(Date.now())) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (startOfDay(d.getTime()) === startOfDay(Date.now()) - DAY_MS) return 'Yesterday';
  if (d.getFullYear() === new Date().getFullYear()) return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "Tuesday 13 October, 09:48" — the full date under an opened post. */
function fullDate(post) {
  const d = new Date(post.publishedAt);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "example.com" out of a link, for the line under "Open full post". */
function hostName(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function dotFor(feed, isRead) {
  const n = ((feed && feed.color) || 1) - 1;
  return `post-dot ${isRead ? `ring-2 ring-inset ${RING[n]}` : DOT[n]}`;
}

function rssIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" class="h-5 w-5" aria-hidden="true">'
    + '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/>'
    + '<circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none"/></svg>';
}

// ── Read state ───────────────────────────────────────────────────────────────

function updateCount() {
  const total = feeds.reduce((sum, f) => sum + (f.unread || 0), 0);
  countEl.textContent = String(total);
  countEl.hidden = total === 0;
}

async function markRead(post, row, dot) {
  if (readIds.has(post.id)) return;
  const feed = feedById(post.feedId);
  readIds.add(post.id);
  row.classList.add('post-read');
  dot.className = dotFor(feed, true);
  if (feed) feed.unread = Math.max(0, (feed.unread || 0) - 1);
  updateCount();
  try {
    await api('POST', `/api/posts/${post.id}/read`);
  } catch (err) {
    readIds.delete(post.id);
    row.classList.remove('post-read');
    dot.className = dotFor(feed, false);
    if (feed) feed.unread = (feed.unread || 0) + 1;
    updateCount();
    toast(err.message || 'Could not mark that post as read.');
  }
}

// ── Merging (after adding a feed or retrying one) ────────────────────────────

function mergePosts(newPosts) {
  const known = new Set(posts.map((p) => p.id));
  for (const p of newPosts || []) {
    if (!known.has(p.id)) { posts.push(p); known.add(p.id); }
  }
  posts.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

function mergeFeeds(feed) {
  const at = feeds.findIndex((f) => f.id === feed.id);
  if (at >= 0) feeds[at] = feed; else feeds.push(feed);
}

function refreshScreen() {
  renderNotes();
  updateCount();
  if (listBox) renderList(listBox);
  else load();
}

// ── Feed error notices ───────────────────────────────────────────────────────

function renderNotes() {
  const bad = feeds.filter((f) => f.error);
  notesEl.replaceChildren();
  notesEl.hidden = !bad.length;
  for (const feed of bad) {
    const retry = h('button', { class: 'btn-secondary shrink-0', type: 'button' }, 'Retry');
    retry.addEventListener('click', () => retryFeed(feed, retry));
    notesEl.append(h('div', { class: 'feed-note' },
      h('span', { class: dotFor(feed, false), 'aria-hidden': 'true' }),
      h('p', {},
        h('strong', {}, feed.title),
        ` did not update: ${feed.error}`),
      retry));
  }
}

async function retryFeed(feed, btn) {
  btn.disabled = true;
  btn.textContent = 'Retrying…';
  try {
    const res = await api('POST', `/api/feeds/${feed.id}/refresh`);
    mergeFeeds(res.feed);
    mergePosts(res.posts);
    refreshScreen();
  } catch (err) {
    toast(err.message || `Could not refresh ${feed.title}.`);
    btn.disabled = false;
    btn.textContent = 'Retry';
  }
}

// ── The list ─────────────────────────────────────────────────────────────────

function postRow(post) {
  const feed = feedById(post.feedId) || { title: 'Unknown feed', color: 1 };
  const isRead = readIds.has(post.id);
  const dot = h('span', { class: dotFor(feed, isRead), 'aria-hidden': 'true' });
  const title = h('h3', { class: 'post-title' }, post.title);
  const button = h('button', {
    class: 'post-row', type: 'button',
    'aria-expanded': 'false',
  },
    dot,
    h('div', { class: 'min-w-0 flex-1' },
      h('p', { class: 'post-meta' },
        h('span', { class: 'post-feed' }, feed.title),
        h('span', {}, age(post))),
      title));
  const row = h('li', { class: isRead ? 'post-read' : '', 'data-post': String(post.id) });

  const preview = h('div', { class: 'post-preview', hidden: true },
    h('p', { class: 'post-when' }, fullDate(post)),
    h('p', { class: 'post-excerpt' }, post.excerpt || 'No preview in this feed.'),
    h('div', { class: 'post-actions' },
      ...(post.link
        ? [h('a', {
            class: 'btn-primary', href: post.link, target: '_blank', rel: 'noopener noreferrer',
          }, 'Open full post'),
           h('span', { class: 'post-host' }, hostName(post.link))]
        : [h('span', { class: 'post-host' }, 'This post has no link.')])));

  let open = false;
  button.addEventListener('click', () => {
    open = !open;
    preview.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) markRead(post, row, dot);
  });

  row.append(button, preview);
  return row;
}

function renderList(box) {
  listBox = box;
  box.replaceChildren();

  const groups = [
    ['Today', []],
    ['Yesterday', []],
    ['Earlier', []],
  ];
  const today = startOfDay(Date.now());
  for (const post of posts) {
    const day = startOfDay(new Date(post.publishedAt).getTime());
    const at = day >= today ? 0 : day >= today - DAY_MS ? 1 : 2;
    groups[at][1].push(post);
  }

  let shown = 0;
  for (const [name, items] of groups) {
    if (!items.length) continue;
    shown += items.length;
    box.append(
      h('h2', { class: 'section-label' }, name),
      h('ul', { class: 'list' }, ...items.map(postRow)));
  }

  if (!shown && feeds.length) {
    box.append(h('div', { class: 'state-empty' },
      h('p', { class: 'text-body font-medium text-fg' }, 'You are all caught up.'),
      h('p', { class: 'text-small text-muted' },
        `New posts from ${plural(feeds.length, 'feed')} show up here.`)));
  }
}

// ── Sheets ───────────────────────────────────────────────────────────────────

function openAddSheet() {
  openFormSheet({
    title: 'Add a feed',
    submitLabel: 'Add feed',
    savedMessage: null,
    returnFocus: addBtn,
    fields: [{
      name: 'url',
      label: 'Feed address',
      required: true,
      max: 500,
      placeholder: 'e.g. https://example.com/feed.xml',
    }],
    onSubmit: async (values) => {
      const res = await api('POST', '/api/feeds', { url: values.url });
      mergeFeeds(res.feed);
      mergePosts(res.posts);
      refreshScreen();
      toast(res.posts && res.posts.length
        ? `Added ${res.feed.title}: ${plural(res.posts.length, 'new post')}`
        : `Added ${res.feed.title}. No posts yet.`);
    },
  }).then((sheet) => {
    const input = sheet.body.querySelector('input[name="url"]');
    if (input) {
      input.inputMode = 'url';
      input.autocapitalize = 'off';
      input.spellcheck = false;
    }
  }).catch(() => { /* the sheet was dismissed */ });
}

/** Ask before removing; true when there is no way to ask, or "Remove" won. */
async function confirmRemove(title) {
  await loadNative();
  const un = window.unNative;
  if (!un || !un.alert) return true; // no way to ask: let it go
  const answer = await un.alert({
    title: `Remove ${title}?`,
    message: 'Its posts leave your list.',
    buttons: [
      { label: 'Cancel' },
      { label: 'Remove', style: 'destructive' },
    ],
  });
  if (answer == null) return false;
  if (answer === true) return true;
  if (typeof answer === 'number') return answer === 1;
  if (typeof answer === 'object') {
    const label = answer.label || (answer.button && answer.button.label) || answer.value || answer.title;
    if (label != null) return /remove/i.test(String(label));
  }
  return false;
}

function openFeedsSheet() {
  openSheet({
    title: 'Your feeds',
    returnFocus: feedsBtn,
    content(body) {
      if (!feeds.length) {
        body.append(h('p', { class: 'state-empty' },
          h('p', { class: 'text-small text-muted' }, 'You do not follow any feeds yet.')));
        return;
      }
      const listEl = h('ul', { class: 'list' });
      for (const feed of feeds) {
        const remove = h('button', { class: 'btn-secondary shrink-0', type: 'button' }, 'Remove');
        const row = h('li', { class: 'list-row' },
          h('span', { class: dotFor(feed, false), 'aria-hidden': 'true' }),
          h('div', { class: 'min-w-0 flex-1' },
            h('p', { class: 'text-body font-medium text-fg' }, feed.title),
            feed.siteUrl ? h('p', { class: 'text-small text-muted' }, hostName(feed.siteUrl)) : null,
            feed.error ? h('p', { class: 'text-small text-danger' }, `Did not update: ${feed.error}`) : null,
            h('p', { class: 'text-small text-muted' }, plural(feed.unread || 0, 'unread post'))),
          remove);
        remove.addEventListener('click', async () => {
          if (!(await confirmRemove(feed.title))) return;
          remove.disabled = true;
          try {
            await api('DELETE', `/api/feeds/${feed.id}`);
            feeds = feeds.filter((f) => f.id !== feed.id);
            posts = posts.filter((p) => p.feedId !== feed.id);
            toast(`Removed ${feed.title}`);
            row.remove();
            if (!feeds.length) {
              body.replaceChildren(h('p', { class: 'state-empty' },
                h('p', { class: 'text-small text-muted' }, 'You do not follow any feeds yet.')));
            }
            refreshScreen();
          } catch (err) {
            remove.disabled = false;
            toast(err.message || `Could not remove ${feed.title}.`);
          }
        });
        listEl.append(row);
      }
      body.append(listEl);
    },
  }).catch(() => { /* the sheet was dismissed */ });
}

// ── Screen ───────────────────────────────────────────────────────────────────

const app = document.getElementById('app');
const demoSlot = h('div');
const notesEl = h('div', { class: 'flex flex-col gap-2', hidden: true });
const listEl = h('div', { class: 'flex flex-col gap-4' });
const countEl = h('span', {
  class: 'rounded-full bg-raised px-2 py-0.5 text-small font-medium tabular-nums text-muted',
  hidden: true,
});
const feedsBtn = h('button', { class: 'kit-icon-button', type: 'button', 'aria-label': 'Your feeds' });
feedsBtn.innerHTML = rssIcon();
const addBtn = h('button', { class: 'kit-icon-button', type: 'button', 'aria-label': 'Add a feed' });
addBtn.append(icon('plus'));

const header = h('header', { class: 'flex items-center justify-between gap-3 py-2' },
  h('div', { class: 'flex items-center gap-3' },
    h('h1', { class: 'text-title' }, 'Unread'),
    countEl),
  h('div', { class: 'flex items-center gap-1' }, feedsBtn, addBtn));

app.append(header, demoSlot, notesEl, listEl);
feedsBtn.addEventListener('click', openFeedsSheet);
addBtn.addEventListener('click', openAddSheet);

const view = createStates(listEl, {
  rows: 7,
  empty: {
    title: 'No feeds yet',
    text: 'Add an RSS or Atom feed and its unread posts show up here.',
    action: { label: 'Add your first feed', onClick: openAddSheet, primary: true },
  },
  error: {
    title: 'Your posts did not load',
    text: 'Your feeds are saved. Check your connection and try again.',
  },
});

function load() {
  return view.run(async (box) => {
    const data = await api('GET', '/api/posts');
    feeds = data.feeds || [];
    posts = data.posts || [];
    if (data.demo) showDemoLabel(demoSlot, 'Staging demo: these feeds and posts are made up.');
    if (!feeds.length) return false; // the empty state; posts are irrelevant without feeds
    renderNotes();
    updateCount();
    renderList(box);
  });
}

load();
loadNative().then((un) => {
  if (un && un.attachPullToRefresh) un.attachPullToRefresh(window, () => load());
});