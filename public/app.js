// RSS Reader's screen: the unread list, the filter pills, the preview sheet
// and the "Your feeds" sheet. All data comes from /api/*; times and demo
// seeds follow the platform's "now".
import { h, api, now, plural, timeAgo } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { openSheet } from '/kit/sheet.js';
import { showDemoLabel } from '/kit/demo.js';
import { rowsFrom, fillIn } from '/kit/fill.js';
import { toast } from '/kit/native.js';

const els = {
  app: document.getElementById('app'),
  unreadLine: document.getElementById('unread-line'),
  check: document.getElementById('check-btn'),
  feedsBtn: document.getElementById('feeds-btn'),
  form: document.getElementById('add-form'),
  input: document.getElementById('add-feed'),
  addBtn: document.getElementById('add-btn'),
  addLabel: document.getElementById('add-label'),
  addError: document.getElementById('add-error'),
  pills: document.getElementById('pills'),
  markRead: document.getElementById('mark-read'),
  failed: document.getElementById('failed-line'),
  end: document.getElementById('end-line'),
  states: document.getElementById('states'),
};

// ── State ─────────────────────────────────────────────────────────────────
// posts: the unread posts the server sent (newest first). readPosts: posts
// marked read this session — they stay in the list, greyed, until the app is
// opened again. filter: null for "All", else a feed id.
const state = { feeds: [], posts: [], readPosts: new Map(), failed: [], filter: null };

const feedById = (id) => state.feeds.find((f) => f.id === id) || null;
const hostOf = (url) => {
  try { return new URL(url).host; } catch { return ''; }
};
const initialOf = (name) => {
  const ch = String(name || '').trim()[0] || '';
  return /[a-z0-9]/i.test(ch) ? ch.toUpperCase() : '#';
};

// Row time in words, compact: "12 min", "2 h", "Yesterday", "Wed", "12 Sep".
function shortAgo(when) {
  const t = new Date(when);
  const n = new Date(now());
  if (Number.isNaN(t.getTime())) return '';
  const mins = Math.floor(Math.max(0, n - t) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  if (hours < 48) return 'Yesterday';
  if (hours < 24 * 7) return t.toLocaleDateString(undefined, { weekday: 'short' });
  const text = t.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return t.getFullYear() === n.getFullYear() ? text : `${text} ${t.getFullYear()}`;
}

// ── The states holder ─────────────────────────────────────────────────────
// Take the sample row out of the list BEFORE createStates clears the holder.
const makeRow = rowsFrom(document.getElementById('post-list'));
const view = createStates(els.states, {
  rows: 5,
  error: {
    title: "Your posts didn't load",
    text: 'Your feeds are saved. Check your connection and try again.',
  },
});

// The one empty element wears two looks: "No feeds yet" and "All caught up".
const emptyEl = els.states.querySelector('.state-empty');
const emptyTitle = emptyEl.querySelector('h2');
const emptyText = emptyEl.querySelector('p');
let emptyAction = null;
function setEmpty(kind) {
  if (kind === 'none') {
    emptyTitle.textContent = 'No feeds yet';
    emptyText.textContent = "Paste a feed's address above to start your list. Most blogs and news sites have one, often ending in /feed or .xml.";
  } else {
    const n = state.filter == null ? state.feeds.length : 1;
    emptyTitle.textContent = "You're all caught up";
    emptyText.textContent = `Nothing new from your ${plural(n, 'feed')}.`;
  }
  if (kind === 'caught') {
    if (!emptyAction) {
      emptyAction = h('button', { type: 'button', class: 'btn-secondary mt-2', on: { click: () => refresh(true) } }, 'Check again');
      emptyEl.append(emptyAction);
    }
    emptyAction.hidden = false;
  } else if (emptyAction) {
    emptyAction.hidden = true;
  }
}

// ── Data ──────────────────────────────────────────────────────────────────
// Merge the server's unread posts with what this session already marked read,
// and drop posts whose feed has gone.
function mergePosts(serverPosts) {
  const feedIds = new Set(state.feeds.map((f) => f.id));
  for (const [id, post] of [...state.readPosts]) {
    if (!feedIds.has(post.feedId)) state.readPosts.delete(id);
  }
  if (state.filter != null && !feedIds.has(state.filter)) state.filter = null;
  const read = new Set(state.readPosts.keys());
  state.posts = serverPosts.filter((p) => !read.has(p.id));
}

// GET /api/posts — also seeds the staging demo when ?demo=1. Shows the one
// demo line at the top of the screen when the list is demo data.
async function fetchList() {
  const data = await api('GET', '/api/posts');
  state.feeds = data.feeds || [];
  state.failed = data.failed || [];
  mergePosts(data.posts || []);
  if (data.demo) showDemoLabel(els.app, 'Staging demo: these feeds and posts are made up.');
}

function visiblePosts() {
  return [...state.posts, ...state.readPosts.values()]
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
}

// ── Rendering ─────────────────────────────────────────────────────────────
function renderHeader() {
  const m = state.feeds.length;
  els.unreadLine.textContent = m === 0
    ? 'No feeds yet'
    : `${state.posts.length} unread from ${plural(m, 'feed')}`;
}

function renderPills() {
  els.pills.hidden = state.feeds.length === 0;
  const row = h('div', { class: 'pill-row' });
  row.append(h('button', {
    type: 'button', class: 'feed-pill',
    'aria-pressed': state.filter == null ? 'true' : 'false',
    on: { click: () => { state.filter = null; syncView(); } },
  }, 'All', h('b', {}, String(state.posts.length))));
  for (const feed of state.feeds) {
    const n = state.posts.filter((p) => p.feedId === feed.id).length;
    row.append(h('button', {
      type: 'button', class: 'feed-pill',
      'aria-pressed': String(state.filter === feed.id),
      on: { click: () => { state.filter = feed.id; syncView(); } },
    },
    h('span', { class: `feed-chip chip-mini feed-${feed.color}`, 'aria-hidden': 'true' }, feed.initial),
    h('span', { class: 'min-w-0 max-w-[12rem] truncate' }, feed.title),
    h('b', {}, String(n))));
  }
  els.pills.replaceChildren(row);
}

function renderFailed() {
  const n = state.failed.length;
  els.failed.hidden = n === 0;
  els.failed.textContent = n === 0 ? ''
    : n === 1
      ? `Couldn't reach ${state.failed[0]} just now. Showing the posts you already had.`
      : `Couldn't reach ${n} feeds just now. Showing the posts you already had.`;
}

function unreadInView() {
  return state.filter == null
    ? state.posts.length
    : state.posts.filter((p) => p.feedId === state.filter).length;
}

// Renders everything; returns true when the list shows, false when the
// screen's empty state should.
function renderAll() {
  renderHeader();
  renderPills();
  renderFailed();
  els.markRead.hidden = unreadInView() === 0;
  const rows = visiblePosts().filter((p) => {
    if (state.filter == null) return true;
    const feed = feedById(p.feedId);
    return feed && feed.id === state.filter;
  });
  if (rows.length === 0) {
    setEmpty(state.feeds.length === 0 && state.filter == null ? 'none' : 'caught');
    els.end.hidden = true;
    return false;
  }
  const list = h('ul', { class: 'list' });
  for (const post of rows) {
    const feed = feedById(post.feedId);
    if (!feed) continue;
    const li = makeRow();
    const btn = li.querySelector('.post-row');
    const isRead = state.readPosts.has(post.id);
    const when = shortAgo(post.publishedAt);
    fillIn(btn, {
      '.feed-chip': {
        class: { 'feed-1': feed.color === 1, [`feed-${feed.color}`]: true },
        text: feed.initial,
      },
      '.post-feed': feed.title,
      '.post-time': { text: when, attr: { title: new Date(post.publishedAt).toLocaleString() } },
      '.post-title': post.title,
      '.post-snip': post.snippet || '',
      '': {
        class: { 'is-read': isRead },
        attr: { 'data-post-id': String(post.id), 'aria-label': `${post.title}. From ${feed.title}. ${when}. ${isRead ? 'Read' : 'Unread'}.` },
        on: { click: () => onRowClick(post) },
      },
    });
    list.append(li);
  }
  view.content.replaceChildren(list);
  els.end.hidden = false;
  return true;
}

// Show whichever of the list / the empty state fits, outside of a load.
function syncView() {
  const ok = renderAll();
  (ok ? view.ready : view.empty)();
}

// ── Reading a post ────────────────────────────────────────────────────────
function onRowClick(post) {
  const fresh = !state.readPosts.has(post.id);
  if (fresh) {
    state.posts = state.posts.filter((p) => p.id !== post.id);
    state.readPosts.set(post.id, post);
    renderAll(); // header, pills and the greyed row, without touching the sheet
    api('POST', '/api/posts/read', { ids: [post.id] }).catch(() => {
      // Un-read it again and say so.
      state.readPosts.delete(post.id);
      state.posts.push(post);
      syncView();
      toast("Couldn't mark that as read.");
    });
  }
  const btn = view.content.querySelector(`button[data-post-id="${post.id}"]`);
  openPreview(post, btn);
}

function openPreview(post, returnFocus) {
  openSheet({
    title: (feedById(post.feedId) || {}).title || 'Preview',
    returnFocus,
    content: (body) => {
      body.replaceChildren(
        h('div', { class: 'flex flex-col gap-3 py-2', 'aria-busy': 'true' },
          h('span', { class: 'skeleton h-4 w-1/3' }),
          h('span', { class: 'skeleton h-4 w-2/3' }),
          h('span', { class: 'skeleton h-4 w-full' })));
      api('GET', `/api/posts/${post.id}`).then((full) => {
        body.replaceChildren(previewBody(full.post || full));
      }).catch(() => {
        body.replaceChildren(
          h('p', { class: 'text-body text-muted' }, "The preview didn't load. You can still open the full post below."),
          openBlock(post.link, hostOf(post.link)));
      });
    },
  });
}

function openBlock(link, host) {
  const ok = /^https?:\/\//i.test(link || '');
  return h('div', { class: 'sticky bottom-0 -mx-1 mt-4 border-t border-line bg-surface px-1 pb-1 pt-3' },
    ok
      ? h('a', { class: 'btn-primary w-full', href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Open full post')
      : h('span', { class: 'btn-secondary w-full opacity-50', 'aria-disabled': 'true' }, 'No link in this post'),
    ok && host ? h('p', { class: 'mt-1 text-center text-small text-muted' }, host) : null);
}

function previewBody(post) {
  const byline = [post.author, timeAgo(post.publishedAt, now())].filter(Boolean).join(' · ');
  const paragraphs = (post.body || []).filter((p) => typeof p === 'string');
  return h('div', { class: 'flex flex-col gap-4 pt-1' },
    h('div', { class: 'flex items-center gap-2' },
      h('span', { class: `feed-chip chip-mini feed-${post.color}`, 'aria-hidden': 'true' }, initialOf(post.feedTitle)),
      h('span', { class: 'min-w-0 truncate text-small font-medium text-muted' }, post.feedTitle)),
    h('h3', { class: 'break-words font-serif text-title' }, post.title),
    byline ? h('p', { class: 'text-small text-muted' }, byline) : null,
    paragraphs.length
      ? h('div', { class: 'article pb-2' }, paragraphs.map((p) => h('p', {}, p)))
      : h('p', { class: 'text-body text-muted' }, 'This feed shares only the headline. Open the full post to read it.'),
    h('p', { class: 'text-small text-muted' }, 'This is the preview the feed shares. The full post may have more.'),
    openBlock(post.link, post.siteHost || hostOf(post.link)));
}

// ── Mark all read ─────────────────────────────────────────────────────────
els.markRead.addEventListener('click', async () => {
  const ids = (state.filter == null
    ? state.posts
    : state.posts.filter((p) => p.feedId === state.filter)).map((p) => p.id);
  if (!ids.length) return;
  els.markRead.disabled = true;
  try {
    await api('POST', '/api/posts/read', { ids });
    for (const post of state.posts.filter((p) => ids.includes(p.id))) {
      state.readPosts.set(post.id, post);
    }
    state.posts = state.posts.filter((p) => !ids.includes(p.id));
    syncView();
  } catch {
    toast("Couldn't mark those as read. Try again in a moment.");
  } finally {
    els.markRead.disabled = false;
  }
});

// ── Add a feed ────────────────────────────────────────────────────────────
els.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = els.input.value.trim();
  els.addError.hidden = true;
  els.input.removeAttribute('aria-invalid');
  if (!url) {
    els.addError.textContent = "Paste a feed's address first, then tap Add.";
    els.addError.hidden = false;
    els.input.focus();
    return;
  }
  els.addBtn.disabled = true;
  els.addLabel.textContent = 'Adding…';
  try {
    const data = await api('POST', '/api/feeds', { url });
    els.input.value = '';
    toast(`Added ${data.feed.title}, ${plural(data.added, 'post')}`);
    await fetchList();
    syncView();
  } catch (err) {
    // The field keeps what was typed; the sentence says what to do instead.
    els.addError.textContent = err.message;
    els.addError.hidden = false;
    els.input.setAttribute('aria-invalid', 'true');
  } finally {
    els.addBtn.disabled = false;
    els.addLabel.textContent = 'Add';
  }
});
els.input.addEventListener('input', () => {
  els.addError.hidden = true;
  els.input.removeAttribute('aria-invalid');
});

// ── Check again ───────────────────────────────────────────────────────────
let checking = false;
async function refresh(force) {
  if (checking) return;
  checking = true;
  els.check.disabled = true;
  els.check.setAttribute('aria-busy', 'true');
  const svg = els.check.querySelector('svg');
  if (svg) svg.classList.add('motion-safe:animate-spin');
  try {
    const data = await api('POST', '/api/refresh', force ? { force: true } : {});
    state.feeds = data.feeds || [];
    state.failed = data.failed || [];
    mergePosts(data.posts || []);
    syncView();
  } catch {
    toast("Couldn't check just now. Try again in a moment.");
  } finally {
    checking = false;
    els.check.disabled = false;
    els.check.removeAttribute('aria-busy');
    if (svg) svg.classList.remove('motion-safe:animate-spin');
  }
}
els.check.addEventListener('click', () => refresh(true));

// ── Your feeds ────────────────────────────────────────────────────────────
// The native alert's callback shape is not promised, so accept the common
// shapes and fall back to confirm() where the frame allows it. A timer keeps
// a silent dialog from wedging the Remove button forever.
function confirmRemove(title) {
  return new Promise((resolve) => {
    const message = `Remove ${title}? Its posts leave your list.`;
    const un = typeof window !== 'undefined' ? window.unNative : null;
    if (!un || typeof un.alert !== 'function') {
      resolve(window.confirm(message));
      return;
    }
    let settled = false;
    const done = (answer) => {
      if (settled) return;
      settled = true;
      const label = typeof answer === 'object' && answer
        ? (answer.label ?? answer.action ?? answer.style ?? answer.index)
        : answer;
      resolve(label === 1 || label === '1' || label === 'Remove' || label === 'destructive' || label === true);
    };
    try {
      const shown = un.alert({
        title: `Remove ${title}?`,
        message,
        buttons: [
          { label: 'Cancel', style: 'cancel' },
          { label: 'Remove', style: 'destructive' },
        ],
      }, done);
      if (shown && typeof shown.then === 'function') shown.then(done, () => done(false));
      setTimeout(() => done(false), 60_000);
    } catch {
      resolve(window.confirm(message));
    }
  });
}

function openFeedsSheet() {
  openSheet({
    title: 'Your feeds',
    content: (body) => {
      const render = () => {
        if (state.feeds.length === 0) {
          body.replaceChildren(h('p', { class: 'text-body text-muted py-4' }, "You don't follow any feeds yet."));
          return;
        }
        body.replaceChildren(h('ul', { class: 'list' }, state.feeds.map((feed) => h('li', { class: 'list-row' },
          h('span', { class: `feed-chip feed-${feed.color}`, 'aria-hidden': 'true' }, feed.initial),
          h('div', { class: 'min-w-0 flex-1' },
            h('p', { class: 'truncate text-body font-medium text-fg' }, feed.title),
            h('p', { class: 'truncate text-small text-muted' }, hostOf(feed.url)),
            feed.lastError ? h('p', { class: 'mt-0.5 text-small text-danger' }, feed.lastError) : null),
          h('button', {
            type: 'button', class: 'btn-secondary shrink-0 px-3',
            on: { click: () => removeFeed(feed, render) },
          }, 'Remove')))));
      };
      render();
    },
  });
}

async function removeFeed(feed, rerender) {
  if (!(await confirmRemove(feed.title))) return;
  try {
    await api('DELETE', `/api/feeds/${feed.id}`);
    toast(`Removed ${feed.title}`);
    await fetchList();
    syncView();
    rerender();
  } catch (err) {
    toast((err && err.message) || "Couldn't remove that feed. Try again in a moment.");
  }
}
els.feedsBtn.addEventListener('click', () => openFeedsSheet());

// ── Boot ──────────────────────────────────────────────────────────────────
async function loadInitial() {
  await fetchList();
  return renderAll(); // false → the kit shows the empty state
}

view.run(loadInitial).then(() => {
  // The first load shows saved posts at once; then quietly check the feeds
  // that have not been checked in a while.
  if (els.states.dataset.state !== 'error') refresh(false);
});