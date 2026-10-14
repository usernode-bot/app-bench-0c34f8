// RSS Reader: one screen, one job — read every unread post from your feeds
// in one list. The screen the spec drew is in index.html; this script fills
// it with real data and wires the actions (kit pieces, never hand-made).
import { api, h, plural, timeAgo, now } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { openSheet, openFormSheet } from '/kit/sheet.js';
import { loadNative, toast } from '/kit/native.js';
import { rowsFrom, fillIn } from '/kit/fill.js';
import { showDemoLabel } from '/kit/demo.js';

const appRoot = document.getElementById('app');
const area = document.getElementById('feed-area');
const countEl = appRoot.querySelector('.head-text .count');
const refreshBtn = document.getElementById('refresh-btn');
const feedsBtn = document.getElementById('feeds-btn');
const addBtn = document.getElementById('add-btn');

// The drawn pieces: one sample row kept as the template, the rest removed
// before the first request goes out.
const noteEl = area.querySelector('.note');
const noteText = noteEl.querySelector('#note-text');
const noteRetry = noteEl.querySelector('button');
const listEl = area.querySelector('.list');
const footEl = area.querySelector('.foot');
const postRow = rowsFrom(listEl);

const view = createStates(area, {
  rows: 4,
  empty: {
    title: 'No feeds yet',
    text: 'Add a feed and its unread posts will gather here.',
    action: { label: 'Add feed', onClick: () => openAddFeed(), primary: true },
  },
  error: {
    title: 'Your posts did not load',
    text: 'Your feeds are safe. Try again in a moment.',
  },
});
const emptyEl = area.querySelector('.state-empty');
const emptyTitle = emptyEl.querySelector('h2');
const emptyText = emptyEl.querySelector('p');
const emptyAction = emptyEl.querySelector('button');

// Posts read in the ten minutes before this page opened stay in the list
// dimmed, so a reload does not fling the reader back to what they were just
// reading (the server takes `since`).
const sinceISO = new Date(now().getTime() - 10 * 60000).toISOString();

let feeds = [];
let postsNow = [];

/* ── The Unread list ──────────────────────────────────────────────────── */

async function load() {
  await view.run(async (box) => {
    const data = await api('GET', '/api/posts?since=' + encodeURIComponent(sinceISO));
    if (data.demo) showDemoLabel(area, 'Staging demo: made-up feeds and posts.');
    feeds = data.feeds || [];
    postsNow = data.posts || [];
    setCount();
    addBtn.hidden = feeds.length === 0;
    if (!postsNow.length) {
      emptyTitle.textContent = feeds.length ? 'All caught up' : 'No feeds yet';
      emptyText.textContent = feeds.length
        ? 'You have read everything your feeds posted. New posts appear here when they update.'
        : 'Add a feed and its unread posts will gather here.';
      emptyAction.hidden = feeds.length > 0;
      return false;
    }
    renderPosts(box, postsNow);
  });
}

function setCount() {
  const unread = postsNow.filter((p) => !p.read_at).length;
  if (!feeds.length) {
    countEl.textContent = '';
    countEl.hidden = true;
  } else if (unread) {
    countEl.textContent = `${plural(unread, 'post')} from ${plural(feeds.length, 'feed')}`;
    countEl.hidden = false;
  } else {
    countEl.textContent = plural(feeds.length, 'feed');
    countEl.hidden = false;
  }
}

function renderPosts(box, posts) {
  const byFeed = new Map(feeds.map((f) => [f.id, f]));
  // A line above the list names each feed that did not update, with a Retry.
  const failing = feeds.filter((f) => f.last_error);
  noteEl.hidden = failing.length === 0;
  if (failing.length) {
    const names = failing.map((f) => f.title)
      .reduce((text, name, i, all) => (i === 0 ? name : i === all.length - 1 ? `${text} and ${name}` : `${text}, ${name}`), '');
    noteText.textContent = `${names} did not update: ${failing[0].last_error}.`;
    noteRetry.onclick = () => retryFeeds(failing);
  }

  box.append(noteEl, listEl, footEl);
  listEl.replaceChildren(); // a re-render starts from the empty drawn list
  for (const post of posts) {
    const feed = byFeed.get(post.feed_id) || { title: '', tone: 0, id: 0 };
    listEl.append(makeRow(post, feed));
  }
}

function makeRow(post, feed) {
  const tone = ((Number(feed.tone) || 0) % 6) + 1;
  const toneClass = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => ['f' + n, n === tone]));
  return fillIn(postRow(), {
    'button': {
      class: { 'is-read': !!post.read_at },
      attr: { 'data-post-row': String(post.id) },
      on: { click: () => openPost(post, feed) },
    },
    '.dot': { text: initialOf(feed.title), class: toneClass },
    '.src b': feed.title,
    '.src time': timeAgo(post.published_at),
    '.title': post.title || 'Untitled post',
    '.snip': post.snippet || '',
  });
}

function initialOf(title) {
  const first = String(title || '').trim().charAt(0);
  return first ? first.toLocaleUpperCase() : '?';
}

/* ── Reading a post: mark read, then the preview ──────────────────────── */

function openPost(post, feed) {
  openPreview(post, feed);
  markRead(post);
}

async function markRead(post) {
  if (post.read_at) return;
  post.read_at = new Date().toISOString();
  const row = area.querySelector(`[data-post-row="${post.id}"]`);
  if (row) row.classList.add('is-read');
  setCount();
  try {
    await api('POST', `/api/posts/${post.id}/read`);
  } catch {
    toast('Your read mark did not save.');
  }
}

/* ── The preview sheet (the spec's screen 2, rebuilt on the kit sheet) ── */

async function openPreview(post, feed) {
  const handle = await openSheet({
    title: post.title || 'Untitled post',
    content: (body) => {
      body.append(
        h('div', { class: 'flex items-center gap-3 border-b border-line pb-3' },
          feedBadge(feed),
          h('b', { class: 'min-w-0 flex-1 truncate text-small text-fg' }, feed.title)),
        h('p', { class: 'text-small text-muted' },
          [post.author ? `By ${post.author}` : null, timeAgo(post.published_at)].filter(Boolean).join(', ')),
        articleEl(post.content_html, post.snippet),
        h('div', { class: 'sticky bottom-0 -mx-1 mt-2 flex flex-col gap-1 border-t border-line bg-surface px-4 pb-4 pt-3' },
          post.link
            ? h('a', {
                class: 'btn-primary', href: post.link, target: '_blank', rel: 'noopener noreferrer',
              },
              'Open full story', externalIcon())
            : null,
          post.link ? h('p', { class: 'text-center text-small text-muted' }, hostOf(post.link)) : null));
    },
  });
  // The preview's headline is part of the reading face, per the design.
  const headline = handle.el && handle.el.querySelector('.kit-sheet-head h2');
  if (headline) headline.classList.add('font-reading');
}

/** The round badge with the feed's initial in that feed's tone. */
function feedBadge(feed, cls = 'dot') {
  const tone = ((Number(feed.tone) || 0) % 6) + 1;
  const badge = h('span', { class: `${cls} f${tone}`, 'aria-hidden': 'true' }, initialOf(feed.title));
  return badge;
}

/** The article's own text and images, rebuilt from an allowlist: everything
 * else in the feed's HTML becomes plain text, so nothing untrusted runs. */
function articleEl(html, snippet) {
  const art = h('div', { class: 'kit-article' });
  if (!html) {
    art.append(h('p', {}, snippet || 'This feed did not carry the article text. Open the full story to read it.'));
    return art;
  }
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  const ALLOWED = new Set(['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'strong', 'em', 'br', 'a', 'img']);
  const render = (node, parent) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.append(node.textContent);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (!ALLOWED.has(tag)) {
      for (const child of [...node.childNodes]) render(child, parent);
      return;
    }
    if (tag === 'br') { parent.append(h('br')); return; }
    if (tag === 'img') {
      const src = node.getAttribute('src') || '';
      if (!/^https:\/\//i.test(src)) return;
      parent.append(h('img', { src, alt: node.getAttribute('alt') || '', loading: 'lazy' }));
      return;
    }
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      if (!/^https:\/\//i.test(href)) {
        for (const child of [...node.childNodes]) render(child, parent);
        return;
      }
      const a = h('a', { href, target: '_blank', rel: 'noopener noreferrer' });
      for (const child of [...node.childNodes]) render(child, a);
      parent.append(a);
      return;
    }
    const el = document.createElement(tag);
    for (const child of [...node.childNodes]) render(child, el);
    parent.append(el);
  };
  for (const node of [...doc.body.childNodes]) render(node, art);
  return art;
}

function externalIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function hostOf(link) {
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/* ── Adding and removing feeds ────────────────────────────────────────── */

function openAddFeed() {
  openFormSheet({
    title: 'Add feed',
    submitLabel: 'Add feed',
    savedMessage: 'Feed added',
    fields: [{
      name: 'url',
      label: 'Feed address',
      required: true,
      max: 500,
      placeholder: 'e.g. https://example.com/feed.xml',
      hint: 'The address of the site’s RSS or Atom feed.',
    }],
    onSubmit: async (values) => {
      await api('POST', '/api/feeds', { url: values.url });
      await load();
    },
  });
}

async function openFeedsSheet() {
  let current = [...feeds];
  await openSheet({
    title: 'Your feeds',
    content: (body) => {
      const box = h('div', { class: 'flex flex-col gap-3' });
      body.append(box);
      render();
      function render() {
        box.replaceChildren();
        if (!current.length) {
          box.append(h('p', { class: 'text-small text-muted' }, 'You have not added any feeds yet.'));
          return;
        }
        const list = h('ul', { class: 'list' });
        for (const feed of current) {
          const remove = h('button', {
            type: 'button', class: 'btn-secondary text-danger',
            on: { click: () => removeFeed(feed) },
          }, 'Remove');
          list.append(h('li', { class: 'list-row' },
            feedBadge(feed),
            h('span', { class: 'kit-row-text' },
              h('span', { class: 'kit-row-title' }, feed.title),
              h('span', { class: 'kit-row-sub' }, hostOf(feed.url))),
            remove));
        }
        box.append(list);
      }
      async function removeFeed(feed) {
        if (!(await confirmRemove(feed))) return;
        try {
          await api('DELETE', `/api/feeds/${feed.id}`);
          current = current.filter((f) => f.id !== feed.id);
          feeds = feeds.filter((f) => f.id !== feed.id);
          render();
          toast('Feed removed');
          await load();
        } catch (err) {
          toast(err instanceof Error && err.message ? err.message : 'The feed was not removed.');
        }
      }
    },
  });
}

/** Ask before it takes the feed and its posts away: the native alert when
 * the platform kit is there, plain agreement when it is not (local dev). */
async function confirmRemove(feed) {
  const un = await loadNative();
  if (un && typeof un.alert === 'function') {
    const answer = await un.alert({
      title: `Remove ${feed.title}?`,
      message: 'This removes the feed and its posts.',
      buttons: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Remove', style: 'destructive' },
      ],
    });
    const picked = answer && typeof answer === 'object' && answer.button ? answer.button.label : answer;
    return String(picked || '').toLowerCase() === 'remove';
  }
  return true;
}

/* ── Refresh ──────────────────────────────────────────────────────────── */

async function refreshAll() {
  refreshBtn.disabled = true;
  try {
    await api('POST', '/api/refresh', {});
    await load();
  } catch (err) {
    toast(err instanceof Error && err.message ? err.message : 'Feeds did not update.');
  } finally {
    refreshBtn.disabled = false;
  }
}

async function retryFeeds(list) {
  noteRetry.disabled = true;
  try {
    if (list.length === 1) await api('POST', '/api/refresh', { feedId: list[0].id });
    else await api('POST', '/api/refresh', {});
    await load();
  } catch (err) {
    toast(err instanceof Error && err.message ? err.message : 'Feeds did not update.');
  } finally {
    noteRetry.disabled = false;
  }
}

refreshBtn.addEventListener('click', refreshAll);
feedsBtn.addEventListener('click', openFeedsSheet);
addBtn.addEventListener('click', openAddFeed);

load();
