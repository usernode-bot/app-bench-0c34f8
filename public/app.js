// RSS Reader: the Unread list, the add-feed form, the preview and the Feeds
// sheet, filling the screens the spec drew (public/index.html + screens.css).
import { api, h, now, plural } from '/kit/dom.js';
import { rowsFrom, fillIn, screen } from '/kit/fill.js';
import { createStates } from '/kit/states.js';
import { openSheet } from '/kit/sheet.js';
import { toast } from '/kit/native.js';
import { showDemoLabel } from '/kit/demo.js';

const readerView = document.getElementById('reader-view');
const viewHost = readerView.parentElement;
const statesEl = document.getElementById('states');
const listEl = document.getElementById('post-list');
const metaEl = document.getElementById('unread-meta');
const addForm = document.getElementById('add-form');
const addInput = document.getElementById('feed-address');
const addButton = document.getElementById('add-button');
const addError = document.getElementById('add-error');
const feedsButton = document.getElementById('feeds-button');

// The drawn list row, to repeat; the samples were emptied out of the markup.
const postRow = rowsFrom(listEl);

let state = { feeds: [], posts: [], demo: false };
let listScroll = 0;

// ── Small helpers ────────────────────────────────────────────────────────

/** The site's two-letter monogram, as server.js computes it for the list. */
function monogram(title) {
  const words = String(title || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '??';
  const [first, second] = words;
  return ((first[0] || '') + (words.length > 1 ? second[0] : first[1] || '')).toUpperCase();
}

/** The feed's badge tint, by its id, same rule on both screens. */
const tintClass = (feedId) => 'b' + ((Number(feedId) % 4) + 1);

/** Compact age for the row: 2h, Yesterday, Oct 12 (the drawn screen's words). */
function when(createdAt, at = now()) {
  const t = new Date(createdAt);
  const n = new Date(at);
  if (!Number.isFinite(t.getTime())) return '';
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(n) - day(t)) / 86_400_000);
  if (days === 0) {
    const mins = Math.floor((n - t) / 60_000);
    if (mins < 1) return 'now';
    if (mins < 60) return mins + 'm';
    return Math.floor(mins / 60) + 'h';
  }
  if (days === 1) return 'Yesterday';
  if (days < 0) return 'now';
  return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** The host of a post's link, for "Read the full article on example.com". */
function hostOf(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ── The unread list ─────────────────────────────────────────────────────

const states = createStates(statesEl, {
  rows: 5,
  empty: {
    title: 'No feeds yet',
    text: 'Add an RSS feed and its unread posts will show up here.',
    action: { label: 'Add feed', primary: true, onClick: () => addInput.focus() },
  },
  error: {
    title: 'Your posts did not load',
    text: 'Your feeds are still saved.',
  },
});

function renderPosts() {
  const { feeds, posts, demo } = state;
  metaEl.hidden = !(posts.length && feeds.length);
  if (posts.length && feeds.length) {
    metaEl.textContent = `${plural(posts.length, 'unread')} from ${plural(feeds.length, 'feed')}`;
  }
  if (!feeds.length) return false;
  const byFeed = new Map(feeds.map((f) => [f.id, f]));
  if (!posts.length) {
    states.content.replaceChildren(
      h('div', { class: 'state-empty' },
        h('h2', { class: 'text-heading' }, 'All caught up'),
        h('p', { class: 'text-body text-muted' },
          'You have read everything your feeds have published so far.')));
    return true;
  }
  listEl.replaceChildren(...posts.map((post) => fillIn(postRow(), {
    '': {
      hidden: false,
      class: { read: !!post.read_at },
      attr: { role: 'button', tabindex: '0' },
      on: {
        click: () => openPreview(post, byFeed.get(post.feed_id)),
        keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPreview(post, byFeed.get(post.feed_id)); } },
      },
    },
    '.badge': { text: monogram(byFeed.get(post.feed_id)?.title), class: { b1: false, b2: false, b3: false, b4: false, [tintClass(post.feed_id)]: true } },
    '.src b': byFeed.get(post.feed_id)?.title || 'Unknown feed',
    '.src span': when(post.published_at),
    '.ttl': post.title,
    '.snip': post.snippet,
  })));
  listEl.hidden = false;
  return true;
}

async function loadPosts() {
  const data = await api('GET', '/api/posts');
  state = data;
  if (data.demo) showDemoLabel(statesEl);
  return renderPosts();
}
states.run(loadPosts);

// ── Adding a feed ───────────────────────────────────────────────────────

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  addError.hidden = true;
  addInput.removeAttribute('aria-invalid');
  addButton.disabled = true;
  try {
    await api('POST', '/api/feeds', { url: addInput.value });
    addInput.value = '';
    toast('Feed added');
    await states.run(loadPosts);
  } catch (err) {
    // The address stays in the field so it can be fixed, not retyped.
    addError.textContent = err.message;
    addError.hidden = false;
    addInput.setAttribute('aria-invalid', 'true');
  } finally {
    addButton.disabled = false;
  }
});

// ── The preview (screen 2, pushed over the list) ────────────────────────

function swapView(put, type) {
  const un = window.unNative;
  const change = () => put();
  if (un && typeof un.transition === 'function') {
    try {
      un.transition(change, { type });
      return;
    } catch {}
  }
  change();
}

function openPreview(post, feed) {
  const feedTitle = feed ? feed.title : post.feed_title;
  const link = post.link || '';
  const host = hostOf(link);
  const view = screen(2);
  fillIn(view, {
    '.badge': { text: monogram(feedTitle), class: { b1: false, b2: false, b3: false, b4: false, [tintClass(post.feed_id)]: true } },
    '.feed-name': feedTitle || 'Unknown feed',
    '.when': when(post.published_at),
    '.art-title': post.title,
    '.body': h('p', { class: 'snip' }, post.snippet),
    '.foot': { hidden: !host },
    '.foot-link': {
      text: `Read the full article on ${host}`,
      attr: { href: link || null },
    },
    '.open-link': {
      hidden: !link,
      on: { click: () => window.open(link, '_blank', 'noopener') },
    },
    '.back': {
      on: { click: () => closePreview(view) },
    },
  });

  listScroll = window.scrollY;
  swapView(() => {
    readerView.hidden = true;
    viewHost.append(view);
    window.scrollTo(0, 0);
  }, 'push');

  // Tapped to read: fade it out of the list straight away, then tell the
  // server. Done on the tap, not when the preview loads — the push
  // transition appends the view a frame later, and a fast answer would
  // otherwise arrive before it and be dropped.
  if (!post.read_at) markRead(post);

  // The feed carries the article text; the server has already sanitized it.
  // Written even if the person has closed the preview: a detached node
  // takes the update harmlessly.
  api('GET', `/api/posts/${post.id}`).then((full) => {
    const body = view.querySelector('.body');
    body.innerHTML = full.content_html || '';
    if (!full.content_html && full.snippet) {
      body.append(h('p', { class: 'snip' }, full.snippet));
    }
  }).catch(() => {
    // The snippet the list carried stays; say what did not load.
    view.querySelector('.body').append(
      h('p', { class: 'snip text-muted' }, 'The full preview did not load — the link below still opens the article.'),
    );
  });
}

function closePreview(view) {
  swapView(() => {
    view.remove();
    readerView.hidden = false;
  }, 'pop');
  window.scrollTo(0, listScroll);
}

async function markRead(post) {
  post.read_at = new Date().toISOString();
  state.posts = state.posts.filter((p) => p.id !== post.id);
  renderPosts();
  try {
    await api('POST', `/api/posts/${post.id}/read`);
  } catch {}
}

// ── The Feeds sheet ─────────────────────────────────────────────────────

feedsButton.addEventListener('click', () => openSheet({
  title: 'Your feeds',
  content: (body, close) => {
    const render = () => {
      body.replaceChildren(...state.feeds.map((feed) => h('div', { class: 'card mb-2' },
        h('div', { class: 'flex items-start gap-3' },
          h('span', { class: `badge ${tintClass(feed.id)}` }, monogram(feed.title)),
          h('div', { class: 'min-w-0 flex-1' },
            h('p', { class: 'font-medium text-fg break-words' }, feed.title),
            h('p', { class: 'text-small text-muted break-all' }, feed.url),
            feed.last_error
              ? h('p', { class: 'text-small text-danger mt-1' },
                'Could not refresh this feed. Its older posts are still here.')
              : null,
            h('button', {
              type: 'button',
              class: 'btn-secondary mt-2',
              'data-remove': String(feed.id),
              on: { click: (e) => removeFeed(feed, e.currentTarget, render, close) },
            }, 'Remove'))))));
    };
    if (!state.feeds.length) {
      body.replaceChildren(h('p', { class: 'text-body text-muted px-1 py-2' },
        'You have not added any feeds yet.'));
    } else {
      render();
    }
  },
}));

async function removeFeed(feed, button, rerender, close) {
  // Confirm before removing: the native kit's alert when it is loaded,
  // otherwise the button asks for a second tap.
  const un = window.unNative;
  if (un && typeof un.alert === 'function') {
    try {
      un.alert({
        title: 'Remove this feed?',
        message: `${feed.title} and its posts will be removed from your list.`,
        buttons: [
          { label: 'Cancel', style: 'cancel' },
          { label: 'Remove', style: 'destructive', handler: () => reallyRemove() },
        ],
      });
      return;
    } catch {}
  }
  if (button.dataset.armed) return reallyRemove();
  button.dataset.armed = 'true';
  button.textContent = 'Tap again to remove';
  setTimeout(() => {
    if (button.isConnected) {
      delete button.dataset.armed;
      button.textContent = 'Remove';
    }
  }, 4000);

  async function reallyRemove() {
    try {
      await api('DELETE', `/api/feeds/${feed.id}`);
      close();
      toast('Feed removed');
      await states.run(loadPosts);
    } catch (err) {
      toast(err.message);
    }
  }
}
