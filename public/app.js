// RSS Reader's screen. The Unread list comes from GET /api/posts; a post
// opens at #post/<id>, marks itself read, and Back returns to the list where
// it left off. Sheets handle Add feed and Your feeds; all the pieces come
// from the platform kit.
import { h, clear, api, plural, timeAgo, now, isDemo } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { openFormSheet, openSheet } from '/kit/sheet.js';
import { toast, loadNative, native } from '/kit/native.js';
import { showDemoLabel } from '/kit/demo.js';

const $ = (id) => document.getElementById(id);
const mainScreen = $('app');
const postsEl = $('posts');
const postScreen = $('post-screen');
const postStatesEl = $('post-states');
const countText = $('count-text');
const refreshBtn = $('refresh-btn');
const failingLine = $('failing-line');
const readallFoot = $('readall-foot');
const readallBtn = $('readall-btn');
const postBack = $('post-back');
const postToggle = $('post-toggle');

// The feed mark: a dot and two arcs, the app's signature.
const MARK = '<circle cx="6" cy="18" r="2" fill="currentColor" stroke="none"/><path d="M5 11a8 8 0 0 1 8 8"/><path d="M5 5a14 14 0 0 1 14 14"/>';
function markSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = MARK;
  return svg;
}

// Posts marked read during this visit stay greyed until the app is opened again.
const readInSession = new Set();
let data = null;            // the payload on screen
let checking = false;       // a refresh is running
let listScroll = 0;         // where the list was when a post opened
let pushedPost = false;     // the current #post/<id> was pushed by a tap
let lastPostId = null;      // the post the list should scroll back and focus to
let feedsChanged = false;   // the Your feeds sheet changed something

const timeOf = (when) => new Date(when).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function dayKey(d) {
  const start = (x) => { const c = new Date(x); c.setHours(0, 0, 0, 0); return c; };
  return Math.round((start(now()) - start(d)) / 86400000);
}
function dayLabel(d) {
  const k = dayKey(d);
  if (k <= 0) return 'Today';
  if (k === 1) return 'Yesterday';
  return new Date(d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

// ── The Unread list ───────────────────────────────────────────────────────

const states = createStates(postsEl, {
  rows: 6,
  empty: {
    title: 'No feeds yet',
    text: 'No feeds yet. Paste the address of a feed or a website, and its new posts show up here.',
    action: { label: 'Add feed', onClick: () => openAddFeed() },
  },
  error: {
    title: 'Posts did not load',
    text: 'Your posts did not load. Your feeds are safe. Try again in a moment.',
  },
});

function setCount() {
  if (!data || !data.feedCount) { $('count-line').hidden = true; return; }
  $('count-line').hidden = false;
  if (checking) {
    countText.textContent = 'Checking your feeds for new posts';
    refreshBtn.disabled = true;
    return;
  }
  refreshBtn.disabled = false;
  const n = readNow().length;
  const feedsWord = data.feedCount === 1 ? 'feed' : 'feeds';
  const updated = data.checkedAt ? `, updated ${timeAgo(data.checkedAt, now())}` : '';
  countText.textContent = n === 0
    ? `All caught up from ${data.feedCount} ${feedsWord}${updated}`
    : `${plural(n, 'unread post')} from ${data.feedCount} ${feedsWord}${updated}`;
  readallFoot.hidden = n === 0;
}

function isRead(p) { return readInSession.has(p.id); }
function readNow() {
  return (data ? data.posts : []).filter((p) => !isRead(p));
}

function setFailing() {
  const failing = (data && data.failing) || [];
  clear(failingLine);
  if (!failing.length) { failingLine.hidden = true; return; }
  failingLine.hidden = false;
  const n = failing.length;
  failingLine.append(
    `${n} ${n === 1 ? 'feed' : 'feeds'} could not be checked`,
    h('button', { class: 'link-btn', type: 'button', on: { click: () => openFeeds() } }, 'See feeds'));
}

function rowFor(p) {
  const read = isRead(p);
  const d = new Date(p.publishedAt);
  return h('li', read ? { class: 'is-read' } : {},
    h('button', {
      class: 'post', type: 'button', 'data-id': String(p.id),
      'aria-label': `${read ? 'Read' : 'Unread'}, ${p.title} from ${p.feedTitle}`,
      on: { click: () => openPost(p.id) },
    },
      h('span', { class: 'mark' }, markSvg()),
      h('span', { class: 'post-text' },
        h('span', { class: 'post-meta' },
          h('span', { class: 'post-feed' }, p.feedTitle),
          h('span', { class: 'post-time' }, timeOf(d))),
        h('span', { class: 'post-title' }, p.title),
        p.snippet ? h('span', { class: 'post-sum' }, p.snippet) : null)));
}

function renderPosts(payload) {
  data = payload;
  clear(states.content);
  setFailing();
  const posts = payload.posts.filter((p) => !isRead(p));
  if (!posts.length) {
    if (!payload.feedCount) setEmptyState('nofeeds');
    else setEmptyState('caughtup');
    setCount();
    return false;
  }
  let lastKey = null;
  let list = null;
  for (const p of posts) {
    const k = dayKey(new Date(p.publishedAt));
    if (k !== lastKey) {
      lastKey = k;
      list = h('ul', { class: 'list' });
      states.content.append(h('h2', { class: 'section-label' }, dayLabel(new Date(p.publishedAt))), list);
    }
    list.append(rowFor(p));
  }
  states.content.append(readallFoot);
  setCount();
  return true;
}

// The empty state is one element with two voices: no feeds yet, or all caught up.
function setEmptyState(which) {
  const emptyEl = postsEl.querySelector('.state-empty');
  if (!emptyEl) return;
  const head = emptyEl.querySelector('h2');
  const text = emptyEl.querySelector('p');
  const btn = emptyEl.querySelector('button');
  if (which === 'nofeeds') {
    head.textContent = 'No feeds yet';
    text.textContent = 'No feeds yet. Paste the address of a feed or a website, and its new posts show up here.';
    btn.textContent = 'Add feed';
    btn.onclick = () => openAddFeed();
  } else {
    head.textContent = 'All caught up';
    const feedsWord = data.feedCount === 1 ? 'feed' : 'feeds';
    text.textContent = `You're all caught up. New posts from your ${data.feedCount} ${feedsWord} show up here.`;
    btn.textContent = 'Refresh';
    btn.onclick = () => refreshAll();
  }
  readallFoot.hidden = true;
}

async function loadList() {
  const keep = window.scrollY;
  const ok = await states.run(async () => renderPosts(await api('GET', '/api/posts')));
  window.scrollTo(0, keep);
  if (ok !== false && data && data.stale && !checking) refreshSoon();
  return ok;
}

// ── Refresh ───────────────────────────────────────────────────────────────

async function refreshSoon() {
  await runRefresh(false, true);
}
async function refreshAll() {
  await runRefresh(true, false);
}

async function runRefresh(force, quiet) {
  if (checking) return;
  checking = true;
  const keep = window.scrollY;
  setCount();
  try {
    const payload = await api('POST', '/api/refresh', { force });
    renderPosts(payload);
    window.scrollTo(0, keep);
  } catch (err) {
    if (!quiet) toast('Could not check for new posts. Refresh to try again.');
    else countText.textContent = 'Could not check for new posts. Refresh to try again.';
  } finally {
    checking = false;
    setCount();
  }
}

refreshBtn.addEventListener('click', refreshAll);

// ── Mark all as read ──────────────────────────────────────────────────────

readallBtn.addEventListener('click', async () => {
  const posts = data ? data.posts.filter((p) => !isRead(p)) : [];
  if (!posts.length) return;
  const ok = await ask(`Mark ${posts.length} ${posts.length === 1 ? 'post' : 'posts'} as read?`, { confirmLabel: 'Mark as read' });
  if (!ok) return;
  try {
    await api('POST', '/api/read', { ids: posts.map((p) => p.id) });
    posts.forEach((p) => readInSession.add(p.id));
    toast(`Marked ${posts.length} ${posts.length === 1 ? 'post' : 'posts'} as read`);
    await loadList();
  } catch (err) {
    toast(err.message);
  }
});

// ── Confirm dialog (native when it is up, window.confirm otherwise) ───────

async function ask(message, { title = 'RSS Reader', confirmLabel = 'OK', danger = false } = {}) {
  const un = await loadNative();
  if (un && typeof un.alert === 'function') {
    try {
      const out = await un.alert({
        title, message,
        buttons: [{ label: 'Cancel' }, { label: confirmLabel, style: danger ? 'destructive' : 'default' }],
      });
      if (out == null) return false;
      if (typeof out === 'string') return out !== 'Cancel';
      if (typeof out === 'object') {
        if (typeof out.label === 'string') return out.label !== 'Cancel';
        if (out.index != null) return out.index !== 0;
        return out.confirmed !== false;
      }
      return true;
    } catch { /* fall through to window.confirm */ }
  }
  return window.confirm(message);
}

// ── Add feed ──────────────────────────────────────────────────────────────

function openAddFeed() {
  openFormSheet({
    title: 'Add feed',
    savedMessage: null,
    fields: [{
      name: 'url', label: 'Feed or website address', type: 'text',
      placeholder: 'e.g. example.com/feed', required: true, max: 2000,
    }],
    submitLabel: 'Add feed',
    returnFocus: $('add-btn'),
    onSubmit: async (v) => {
      const r = await api('POST', '/api/feeds', { url: v.url });
      const newPosts = r.added > 0 ? `, ${plural(r.added, 'new post')}` : ', no new posts';
      toast(`Added ${r.feed.title}${newPosts}`);
      feedsChanged = true;
      await loadList();
    },
  }).catch(() => {});
}

$('add-btn').addEventListener('click', openAddFeed);

// ── Your feeds ────────────────────────────────────────────────────────────

function feedRow(f, rerender) {
  const row = h('li', { class: 'un-group-row feeds-row' },
    h('div', { class: 'feeds-row-text' },
      h('p', { class: 'feeds-row-title' }, f.title),
      h('p', { class: 'feeds-row-sub' }, f.unread > 0
        ? `${plural(f.unread, 'unread post')}${f.siteHost ? ` · ${f.siteHost}` : ''}`
        : f.siteHost || 'No unread posts'),
      f.lastError ? h('p', { class: 'text-small text-danger' },
        `Could not be checked: ${f.lastError}`) : null),
    h('div', { class: 'feeds-row-actions' },
      f.lastError ? h('button', {
        class: 'link-btn', type: 'button',
        on: { click: async () => {
          try {
            const r = await api('POST', `/api/feeds/${f.id}/refresh`);
            toast(r.feed.lastError ? 'Still could not check it. Try again later.' : 'Checked, and it answered.');
            rerender();
          } catch (err) { toast(err.message); }
        } },
      }, 'Try again') : null,
      h('button', {
        class: 'link-btn text-danger', type: 'button',
        on: { click: async () => {
          const ok = await ask(`Remove ${f.title}? Its posts leave your list.`, { confirmLabel: 'Remove', danger: true });
          if (!ok) return;
          try {
            await api('DELETE', `/api/feeds/${f.id}`);
            feedsChanged = true;
            toast(`Removed ${f.title}`);
            rerender();
            await loadList();
          } catch (err) { toast(err.message); }
        } },
      }, 'Remove')));
  return row;
}

function openFeeds() {
  feedsChanged = false;
  openSheet({
    title: 'Your feeds',
    returnFocus: $('feeds-btn'),
    onClose: () => { if (feedsChanged) loadList(); },
    content: (body, close) => {
      const render = async () => {
        clear(body).append(h('p', { class: 'text-small text-muted' }, 'Checking your feeds'));
        try {
          const { feeds } = await api('GET', '/api/feeds');
          clear(body);
          if (!feeds.length) {
            body.append(h('p', { class: 'text-body text-muted' }, 'No feeds yet. Paste the address of a feed or a website, and its new posts show up here.'));
          } else {
            body.append(h('ul', { class: 'un-group kit-group' }, feeds.map((f) => feedRow(f, rerender))));
          }
          body.append(h('div', { class: 'kit-form-actions' },
            h('button', { class: 'btn-secondary', type: 'button', on: { click: () => { close(); openAddFeed(); } } }, 'Add feed')));
        } catch (err) {
          clear(body).append(
            h('p', { class: 'text-body text-muted' }, 'Your feeds did not load. They are safe. Try again in a moment.'),
            h('div', { class: 'kit-form-actions' },
              h('button', { class: 'btn-secondary', type: 'button', on: { click: () => render() } }, 'Try again')));
        }
      };
      const rerender = () => render();
      render();
    },
  }).catch(() => {});
}

$('feeds-btn').addEventListener('click', openFeeds);

// ── The post screen ───────────────────────────────────────────────────────

const postStates = createStates(postStatesEl, { rows: 3 });

function setScreens(showPost, type) {
  const apply = () => {
    postScreen.hidden = !showPost;
    mainScreen.hidden = showPost;
  };
  const un = native();
  if (un && typeof un.transition === 'function') un.transition(apply, { type });
  else apply();
}

function route(hash, animate) {
  const m = /^#post\/(\d+)$/.exec(hash || '');
  const showPost = !!m;
  if (showPost) {
    if (animate) setScreens(true, 'push');
    else setScreens(true);
    openPostView(Number(m[1]));
  } else {
    if (animate) setScreens(false, 'pop');
    else setScreens(false);
    // Back to the list where it was, on the row that opened.
    window.scrollTo(0, listScroll);
    const btn = lastPostId != null && states.content.querySelector(`button.post[data-id="${lastPostId}"]`);
    if (btn) btn.focus({ preventScroll: true });
  }
}

window.addEventListener('hashchange', () => route(location.hash, true));

function openPost(id) {
  listScroll = window.scrollY;
  pushedPost = true;
  location.hash = `post/${id}`;
}

postBack.addEventListener('click', () => {
  if (pushedPost) {
    pushedPost = false;
    history.back();
  } else {
    history.replaceState(null, '', location.pathname + location.search);
    route('', true);
  }
});

function renderPost(post, demo) {
  clear(postStates.content);
  const d = new Date(post.publishedAt);
  const k = dayKey(d);
  const day = k <= 0 ? 'today' : k === 1 ? 'yesterday'
    : new Date(d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const meta = [post.author ? `By ${post.author}, ` : '', `${day} at ${timeOf(d)}`].join('');
  const paragraphs = String(post.summary || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);

  postStates.content.append(
    h('header', { class: 'kit-detail-head' },
      h('p', { class: 'feed' }, markSvg(), post.feedTitle),
      h('h1', { class: 'kit-detail-title' }, post.title),
      h('p', { class: 'meta' }, meta)),
    h('hr', { class: 'rule' }),
    h('div', { class: 'kit-detail-body' },
      paragraphs.length
        ? paragraphs.map((text) => h('p', {}, text))
        : h('p', {}, 'This feed sends titles only. Open the full article to read it.')),
    h('div', { class: 'open' },
      post.link
        ? [
            h('a', { class: 'btn-primary', href: post.link, target: '_blank', rel: 'noopener noreferrer' },
              'Open full article',
              h('span', { class: 'open-icon', 'aria-hidden': 'true' }, (() => {
                const ns = 'http://www.w3.org/2000/svg';
                const svg = document.createElementNS(ns, 'svg');
                svg.setAttribute('viewBox', '0 0 24 24');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('stroke-width', '2');
                svg.setAttribute('stroke-linecap', 'round');
                svg.setAttribute('stroke-linejoin', 'round');
                svg.innerHTML = '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>';
                return svg;
              })())),
            post.siteHost ? h('p', { class: 'note' }, `Opens ${post.siteHost} in your browser`) : null,
          ]
        : h('p', { class: 'note' }, 'This post has no link to the full article.')));

  // Mark as unread: only there once the post has been marked read.
  postToggle.hidden = !post.read;
  postToggle.onclick = async () => {
    try {
      await api('DELETE', `/api/posts/${post.id}/read`);
      readInSession.delete(post.id);
      postToggle.hidden = true;
      toast('Marked as unread');
      refreshRow(post.id);
      setCount();
    } catch (err) { toast(err.message); }
  };
  return demo;
}

function refreshRow(id) {
  const btn = states.content.querySelector(`button.post[data-id="${id}"]`);
  if (!btn) return;
  btn.closest('li').classList.toggle('is-read', isRead({ id }));
  const label = btn.getAttribute('aria-label') || '';
  btn.setAttribute('aria-label', isRead({ id }) ? label.replace(/^Unread,/, 'Read,') : label.replace(/^Read,/, 'Unread,'));
}

async function openPostView(id) {
  lastPostId = id;
  postStates.loading();
  try {
    const { post, demo } = await api('GET', `/api/posts/${id}`);
    renderPost(post, demo);
    postStates.ready();
    if (!post.read) {
      try {
        await api('PUT', `/api/posts/${id}/read`);
        readInSession.add(id);
        postToggle.hidden = false;
        refreshRow(id);
        setCount();
      } catch {
        toast('Could not mark this post as read');
      }
    }
  } catch (err) {
    postStates.error();
    const errEl = postStatesEl.querySelector('.state-error p');
    if (errEl) errEl.textContent = err.status === 404
      ? 'This post is no longer in your feeds.'
      : 'The post did not load. Try again in a moment.';
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────

(async function boot() {
  await loadNative().catch(() => {});
  if (isDemo()) showDemoLabel(mainScreen, 'Staging demo: these feeds and posts are made up.');
  const first = location.hash;
  if (first && first !== '#' && /^#post\//.test(first)) {
    route(first, false);
    await loadList();
  } else {
    await loadList();
    if (first) route(first, false);
  }
})();