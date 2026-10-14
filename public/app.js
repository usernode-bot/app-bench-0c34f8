// RSS Reader: one screen, filled from the data. The drawn screen stays as the
// markup; this module fills it and wires it: the unread list, the preview
// sheet, Add feed, the feeds list with Remove, refresh and pull to refresh.
import { api, h, plural, timeAgo, isDemo } from './kit/dom.js';
import { rowsFrom, fillIn, screen } from './kit/fill.js';
import { createStates } from './kit/states.js';
import { openSheet, openFormSheet } from './kit/sheet.js';
import { loadNative, toast } from './kit/native.js';
import { showDemoLabel } from './kit/demo.js';

const screen1 = document.querySelector('[data-spec-screen="1"]');
const barAdd = screen1.querySelector('.bar .btn-primary');
const barRefresh = screen1.querySelector('.bar .icon-btn');
const sum = screen1.querySelector('.sum');
const countEl = screen1.querySelector('.sum .count');
const feedsLink = screen1.querySelector('.sum .feeds');

// The drawn row becomes the row we repeat; the drawn list becomes the list
// we fill. The drawn <li> wraps one <button data-post-row>: a tappable post.
const listEl = screen1.querySelector('.list');
const postRow = rowsFrom(listEl, 'li');
const drawnList = listEl.cloneNode(false);
listEl.remove();

const statesBox = document.getElementById('states');
const states = createStates(statesBox, {
  rows: 4,
  empty: {
    title: 'No feeds yet',
    text: 'Paste a feed link from a site you follow and its new posts show up here.',
    action: { label: 'Add feed', primary: true, onClick: () => addFeed() },
  },
  error: {
    title: 'Couldn’t load your posts',
    text: 'Couldn’t load your posts. Your feeds are saved. Check your connection and try again.',
  },
});
// The kit's wording is "Try again"; this screen says "Retry".
statesBox.querySelector('.state-error button').textContent = 'Retry';
const emptyEl = statesBox.querySelector('.state-empty');

let unreadCount = 0;
let feedCount = 0;
let feeds = [];

load();

async function load() {
  await states.run(async (content) => {
    const data = await api('GET', '/api/posts');
    feeds = data.feeds || [];
    const posts = data.posts || [];
    unreadCount = posts.length;
    feedCount = feeds.length;

    // One filled Add feed at a time: the empty state's button when there are
    // no feeds (top bar goes plain), the top bar's otherwise.
    barAdd.classList.toggle('btn-primary', feedCount > 0);
    barAdd.classList.toggle('btn-secondary', feedCount === 0);
    sum.hidden = feedCount === 0;
    countEl.textContent = plural(unreadCount, 'unread post');
    feedsLink.textContent = plural(feedCount, 'feed');

    if (feedCount === 0 && unreadCount === 0) {
      emptyEl.querySelector('h2').textContent = 'No feeds yet';
      emptyEl.querySelector('p').textContent =
        'Paste a feed link from a site you follow and its new posts show up here.';
      emptyEl.querySelector('button').hidden = false;
      return false;
    }
    if (unreadCount === 0) {
      emptyEl.querySelector('h2').textContent = 'You’re all caught up';
      emptyEl.querySelector('p').textContent =
        `You’re all caught up. New posts from your ${plural(feedCount, 'feed')} will show up here.`;
      emptyEl.querySelector('button').hidden = true;
      return false;
    }

    content.replaceChildren();
    if (isDemo() || data.demo) showDemoLabel(content, 'Staging demo: made-up feeds and posts');
    for (const f of feeds) {
      if (f.error) {
        content.append(h('p', { class: 'fail' },
          `${f.title} didn’t update. Its saved posts are still here.`));
      }
    }
    const list = drawnList.cloneNode(false);
    for (const post of posts) list.append(fillIn(postRow(), {
      'button': { on: { click: (e) => openPreview(post, post.feed_title, e.currentTarget) } },
      '.dot': { hidden: false },
      '.feed': post.feed_title || '',
      '.time': timeAgo(post.published_at),
      '.title': post.title,
      '.ex': post.summary || '',
      '': { class: { 'is-read': false } },
    }));
    content.append(list);
  });
}

// ── Reading a post ─────────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

function openPreview(post, feedTitle, row) {
  markRead(post, row);
  const drawn = screen(2);
  const section = drawn.querySelector('.sheet');
  const grab = section.querySelector('.grab');
  const top = section.querySelector('.top');
  if (grab) grab.remove();
  if (top) top.remove();
  const paragraphs = String(post.summary || '').split('\n').filter(Boolean)
    .map((line) => h('p', {}, line));
  let host = '';
  let safeLink = '';
  if (/^https?:\/\//i.test(post.link || '')) {
    safeLink = post.link;
    try { host = new URL(post.link).hostname.replace(/^www\./, ''); } catch {}
  }
  fillIn(section, {
    '.feed': feedTitle || '',
    'h2': post.title,
    '.date': longDate(post.published_at),
    '.body': { hidden: !paragraphs.length, children: paragraphs },
    '.more': { hidden: !safeLink },
    '.actions a': { attr: { href: safeLink || null }, hidden: !safeLink },
    '.host': { hidden: !safeLink, text: host },
  });
  const link = section.querySelector('.actions a');
  if (link) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  openSheet({ title: 'Post preview', content: section, returnFocus: row });
}

// A post counts read as soon as it is tapped: it loses its dot and fades now,
// and it is gone from the list on the next load. The record is marked even if
// the sheet never opens.
function markRead(post, row) {
  if (!post || !row || row.classList.contains('is-read')) return;
  row.classList.add('is-read');
  unreadCount = Math.max(0, unreadCount - 1);
  countEl.textContent = plural(unreadCount, 'unread post');
  api('POST', `/api/posts/${post.id}/read`).catch(() => {});
}

function longDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${d.getHours()}:${pad(d.getMinutes())}`;
}

// ── Adding and removing feeds ──────────────────────────────────────────────

function addFeed() {
  openFormSheet({
    title: 'Add feed',
    fields: [{ name: 'url', label: 'Feed link', required: true, max: 2000,
      placeholder: 'e.g. https://example.com/feed.xml' }],
    submitLabel: 'Add feed',
    savedMessage: 'Feed added',
    onSubmit: async (values) => {
      await api('POST', '/api/feeds', { url: values.url });
      await load();
    },
  });
}

function openFeeds() {
  openSheet({
    title: 'Your feeds',
    content: (body, close) => {
      body.replaceChildren();
      if (!feeds.length) {
        body.append(h('p', { class: 'text-body text-muted' },
          'No feeds yet. Paste a feed link to add your first one.'));
        return;
      }
      const list = h('ul', { class: 'kit-group' }, feeds.map((f) =>
        h('li', { class: 'un-group-row' },
          h('div', { class: 'list-row', style: 'align-items:center' },
            h('div', { class: 'kit-row-text' },
              h('span', { class: 'kit-row-title' }, f.title || f.url),
              h('span', { class: 'kit-row-sub' }, f.error || f.url)),
            h('button', { type: 'button', class: 'btn-secondary', style: 'min-height:36px;padding:0 12px;font-size:14px',
              on: { click: () => removeFeed(f, () => { close(); load(); }) } }, 'Remove')))));
      body.append(list);
    },
    returnFocus: feedsLink,
  });
}

async function removeFeed(feed, done) {
  const un = await loadNative();
  const ask = un && typeof un.alert === 'function'
    ? un.alert({
      title: 'Remove feed?',
      message: `Remove “${feed.title || feed.url}” and its posts from your list.`,
      buttons: [{ label: 'Remove', style: 'danger' }, { label: 'Cancel' }],
    })
    : Promise.resolve({ index: 0 });
  const picked = await ask.catch(() => null);
  if (!confirmRemove(picked)) return;
  try {
    await api('DELETE', `/api/feeds/${feed.id}`);
    toast('Feed removed');
    done();
  } catch (err) {
    toast(err.message);
  }
}

// Whatever shape the native alert resolves with, "Remove" is the first
// button and a dismissal means no.
function confirmRemove(picked) {
  if (picked == null || picked === false) return false;
  if (picked === true) return true;
  if (typeof picked === 'number') return picked === 0;
  if (typeof picked === 'string') return picked !== 'Cancel';
  if (picked.label) return picked.label !== 'Cancel';
  return picked.index === undefined ? true : picked.index === 0;
}

// ── Refresh ────────────────────────────────────────────────────────────────

barAdd.addEventListener('click', addFeed);
barRefresh.addEventListener('click', () => { load(); });
feedsLink.addEventListener('click', (e) => { e.preventDefault(); openFeeds(); });

loadNative().then((un) => {
  if (un && typeof un.attachPullToRefresh === 'function') {
    un.attachPullToRefresh(window, () => load());
  }
});
