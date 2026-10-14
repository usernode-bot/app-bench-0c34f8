// RSS Reader: one screen, one job — scroll every unread post. Tapping a row
// opens the preview the spec drew (screen 2, kept in index.html) and marks
// the post read; back returns to the list without it.
import { h, api, timeAgo, plural, icon } from './kit/dom.js';
import { createStates } from './kit/states.js';
import { rowsFrom, fillIn } from './kit/fill.js';
import { openSheet } from './kit/sheet.js';
import { toast, native } from './kit/native.js';

const $ = (sel, el = document) => el.querySelector(sel);

const listScreen = document.getElementById('screen-list');
const previewScreen = document.getElementById('screen-preview');
const countEl = document.getElementById('count');
const failedEl = document.getElementById('failed');
const listEl = $('#main-states .list');

// The feed colours: feed N's unread dot is drawn in --feed-N.
const feedDot = (colorIndex) => `background:rgb(var(--feed-${(colorIndex % 6) + 1}))`;

// A real screen navigation gets the native push/pop; an instant cut where
// the kit did not load.
function swap(mutate, type) {
  const un = native();
  if (un && typeof un.transition === 'function') un.transition(mutate, { type });
  else mutate();
}

// Grab the drawn count and list before createStates takes #main-states over:
// on every successful load they move into its content and fill with data.
const postRow = rowsFrom(listEl);

// The loading rows mirror the real ones — a dot, a feed line, a title bar, a
// snippet bar, a thumbnail square in some rows, under a short bar for the
// count line — so the layout does not jump when the posts arrive.
function drawSkeleton(rows) {
  return h('div', { class: 'list-block', 'aria-busy': 'true' },
    h('p', { class: 'sr-only', role: 'status' }, 'Loading'),
    h('p', { class: 'section-label', 'aria-hidden': 'true' }, h('span', { class: 'skeleton h-3 w-40 inline-block' })),
    h('ul', { class: 'list', 'aria-hidden': 'true' },
      Array.from({ length: rows }, (_, i) => h('li', { class: 'list-row' },
        h('span', { class: 'dot skeleton' }),
        h('div', { class: 'txt' },
          h('span', { class: 'skeleton h-3 w-1/4' }),
          h('span', { class: 'skeleton h-4 w-3/4' }),
          h('span', { class: 'skeleton h-3 w-full' })),
        i % 2 ? null : h('span', { class: 'skeleton h-16 w-16' })))));
}

const listBlock = h('div', { class: 'list-block' }, countEl, failedEl, listEl);

const states = createStates(document.getElementById('main-states'), {
  rows: 5,
  skeleton: drawSkeleton,
  empty: {
    title: 'Add your first feed',
    text: 'Paste the address of a site\'s RSS feed above. Its new posts show up here as they are published.',
  },
  error: {
    title: 'The unread list could not be loaded',
    text: 'Your feeds are still saved. Check your connection and try again.',
  },
});

let data = null; // the latest /api/posts response

// ── The unread list ────────────────────────────────────────────────────────

async function load() {
  await states.run(async (content) => {
    data = await api('GET', '/api/posts');
    if (!data.feeds.length && !data.posts.length) return false; // the empty state
    content.append(listBlock);
    render();
    return true;
  });
}

function render() {
  if (!data) return;
  countEl.textContent = (data.demo ? 'Staging demo: ' : '') + (data.posts.length
    ? `${data.posts.length} unread from ${plural(data.feeds.length, 'feed')}`
    : 'You are all caught up');
  listEl.hidden = !data.posts.length;
  if (data.errors.length) {
    failedEl.textContent = `${plural(data.errors.length, 'feed')} could not be reached just now: ${data.errors.join(', ')}. Showing the posts saved earlier.`;
    failedEl.hidden = false;
  } else {
    failedEl.hidden = true;
  }
  listEl.replaceChildren(...data.posts.map((post) => {
    const row = fillIn(postRow(), {
      '.dot': { attr: { style: feedDot(post.colorIndex) } },
      '.src b': post.feedTitle,
      '.src span': post.publishedAt ? `· ${timeAgo(post.publishedAt)}` : '',
      '.title': post.title,
      '.snip': { text: post.snippet || '', hidden: !post.snippet },
      '.thumb': { hidden: !post.imageUrl },
    });
    if (post.imageUrl) {
      const thumb = $('.thumb', row);
      thumb.replaceChildren(h('img', { src: post.imageUrl, alt: '', style: 'width:100%;height:100%;object-fit:cover;border-radius:8px' }));
    }
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.addEventListener('click', () => openPost(post));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPost(post);
      }
    });
    return row;
  }));
}

// ── The preview ────────────────────────────────────────────────────────────

// The drawn preview line: "14 Oct, 09:40".
function dateLine(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ', ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function fillPreview(post) {
  const img = document.getElementById('preview-img');
  const body = document.getElementById('preview-body');
  const open = document.getElementById('open-article');
  const note = document.getElementById('preview-note');
  let host = '';
  try {
    host = post.link ? new URL(post.link).hostname : '';
  } catch { host = ''; }

  document.getElementById('preview-dot').style.cssText = feedDot(post.colorIndex);
  document.getElementById('preview-src').textContent =
    post.feedTitle + (post.publishedAt ? ' · ' + dateLine(post.publishedAt) : '');
  document.getElementById('preview-title').textContent = post.title;

  img.hidden = !post.imageUrl;
  if (post.imageUrl) {
    img.replaceChildren(h('img', { src: post.imageUrl, alt: '' }));
  } else {
    img.replaceChildren();
  }

  body.hidden = !post.snippet;
  fillIn(body, { p: post.snippet || '' });

  open.hidden = !post.link;
  if (post.link) open.href = post.link;
  note.hidden = !host;
  if (host) note.textContent = `Opens ${host} in your browser.`;
}

function openPost(post) {
  fillPreview(post);
  swap(() => {
    previewScreen.hidden = false;
    listScreen.hidden = true;
    window.scrollTo(0, 0);
  }, 'push');
  // Tapping a post is reading it: off the unread list it goes, whether or
  // not the write lands the preview stays open.
  api('POST', `/api/posts/${post.id}/read`).then(() => {
    data.posts = data.posts.filter((p) => p.id !== post.id);
    data.errors = data.errors || [];
    render();
  }).catch(() => {});
}

$('.back', previewScreen).addEventListener('click', () => swap(() => {
  previewScreen.hidden = true;
  listScreen.hidden = false;
}, 'pop'));

// ── Feeds sheet ────────────────────────────────────────────────────────────

$('#feeds-button').addEventListener('click', () => {
  if (!data) return;
  openSheet({
    title: 'Feeds',
    content: (body, close) => {
      body.append(h('p', { class: 'kit-hint' }, 'Every feed is your own, and gets its own dot colour. Removing a feed removes its posts.'));
      for (const feed of data.feeds) {
        body.append(h('div', { class: 'kit-group' },
          h('div', { class: 'un-group-row list-row' },
            h('span', { class: 'dot', style: feedDot(feed.colorIndex) }),
            h('div', { class: 'kit-row-text' },
              h('span', { class: 'kit-row-title' }, feed.title),
              h('span', { class: 'kit-row-sub' }, feed.url),
              feed.error ? h('span', { class: 'kit-error' }, feed.error) : null),
            h('button', {
              type: 'button',
              class: 'kit-icon-button',
              'aria-label': `Remove ${feed.title}`,
              on: { click: () => removeFeed(feed, close) },
            }, icon('close')))));
      }
    },
  });
});

async function removeFeed(feed, close) {
  const un = native();
  let confirmed = false;
  if (un && typeof un.alert === 'function') {
    await un.alert({
      title: `Remove ${feed.title}?`,
      message: 'Its posts leave the unread list too. This cannot be undone.',
      buttons: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Remove', style: 'destructive', handler: () => { confirmed = true; } },
      ],
    });
  } else {
    confirmed = window.confirm(`Remove ${feed.title}? Its posts leave the unread list too.`);
  }
  if (!confirmed) return;
  try {
    await api('DELETE', `/api/feeds/${feed.id}`);
    if (close) close();
    toast(`${feed.title} removed`);
    await load();
  } catch (err) {
    toast(err.message);
  }
}

// ── Add a feed ─────────────────────────────────────────────────────────────

const form = document.getElementById('add-form');
const urlInput = document.getElementById('add-url');
const addError = document.getElementById('add-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  addError.hidden = true;
  const url = urlInput.value.trim();
  if (!url) {
    addError.textContent = 'Type the address of the feed to add first.';
    addError.hidden = false;
    urlInput.focus();
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const feed = await api('POST', '/api/feeds', { url });
    urlInput.value = '';
    toast(`${feed.title} added`);
    await load();
  } catch (err) {
    addError.textContent = err.message;
    addError.hidden = false;
  } finally {
    button.disabled = false;
  }
});

load();
