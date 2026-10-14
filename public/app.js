// RSS Reader: one screen, one job — read all the unread posts from the
// viewer's own feeds, newest first. The drawn screen stays: its rows and
// chips are cloned and filled with real data (fill.js), and its preview
// sheet is the kit's openSheet around the drawn screen-2 pieces.
import { h, isDemo, api, plural, timeAgo } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { rowsFrom, fillIn, screen } from '/kit/fill.js';
import { openSheet } from '/kit/sheet.js';
import { showDemoLabel } from '/kit/demo.js';

const appEl = document.getElementById('app');
const addField = document.getElementById('feed-url');
const addBtn = document.getElementById('add-feed');
const addError = document.getElementById('add-error');
const refreshBtn = appEl.querySelector('.head .ico');
const heading = appEl.querySelector('.ttl p');

// The drawn rows and chips, cloned once, before anything clears the screen.
const postRow = rowsFrom(appEl.querySelector('.list'));
const chipRow = rowsFrom(appEl.querySelector('.chips'), '.chip');

const states = createStates(document.getElementById('feeds-area'), {
  rows: 5,
  empty: {
    title: 'No feeds yet',
    text: 'Add a feed above and its unread posts appear here.',
    action: { label: 'Add a feed', primary: true, onClick: () => addField.focus() },
  },
  error: {
    title: 'The unread list did not load',
    text: 'Your feeds and what you have read are safe. Check the connection and try again.',
  },
});

if (isDemo()) showDemoLabel(appEl.querySelector('.app'), 'Staging demo: these feeds and posts are made up.');

let data = { feeds: [], posts: [] };

// ── Rendering ─────────────────────────────────────────────────────────────

function render() {
  const content = states.content;
  content.replaceChildren();

  // Chips: one per feed — name, unread count, a warning mark when its last
  // fetch failed, and a × that asks before it removes. One scrollable row.
  if (data.feeds.length) {
    content.append(h('div', { class: 'chips' }, data.feeds.map((feed) => fillIn(chipRow(), {
      ':scope': { class: { 'chip-warn': !!feed.last_error } },
      '.name': feed.title || feed.url,
      '.n': String(feed.unread),
      '.warn': { hidden: !feed.last_error },
      '.x': {
        attr: { 'aria-label': `Remove feed ${feed.title || feed.url}` },
        on: { click: (e) => { e.stopPropagation(); confirmRemove(feed); } },
      },
    }))));
  }

  // A feed whose last refresh failed says so above the list, with a Retry.
  for (const feed of data.feeds.filter((f) => f.last_error)) {
    content.append(h('div', { class: 'feed-error', role: 'status' },
      h('p', { class: 'why' }, h('b', {}, (feed.title || feed.url) + ' '), feed.last_error),
      h('button', { type: 'button', class: 'btn-secondary', on: { click: () => retryFeed(feed) } }, 'Retry')));
  }

  if (!data.posts.length) {
    if (data.feeds.length) content.append(h('p', { class: 'caught-up' }, 'You’re all caught up'));
    heading.textContent = data.feeds.length
      ? `0 posts from ${plural(data.feeds.length, 'feed')}`
      : 'No feeds yet';
    return;
  }

  content.append(h('p', { class: 'section-label' }, 'Newest first'));
  content.append(h('ul', { class: 'list' }, data.posts.map((post) => fillIn(postRow(), {
    '.meta b': post.feed_title || '',
    '.meta .when': timeAgo(post.published_at || post.created_at),
    '.pt': post.title || '(no title)',
    '.sum': post.summary || '',
    ':scope': {
      on: {
        click: (e) => openPreview(post, e.currentTarget),
        keydown: (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          openPreview(post, e.currentTarget);
        },
      },
    },
  }))));
  heading.textContent =
    `${plural(data.posts.length, 'post')} from ${plural(data.feeds.length, 'feed')}`;
}

// Show what we have: the content when there are feeds, the drawn empty
// state only when there is genuinely nothing (no feeds at all).
function sync() {
  render();
  if (data.feeds.length) states.ready(); else states.empty();
}

// The first paint, with skeletons: check the feeds (the app does this when
// it opens), then read the list. A refresh that itself fails is not a failed
// load — the per-feed error lines say what happened once the list arrives.
async function task() {
  try { await refreshAll(); } catch { /* shown per feed below */ }
  data = await api('GET', '/api/reader');
  render();
  return data.feeds.length > 0;
}

function load() { states.run(task); }

// A quiet refill where the screen stands: what the preview closing, the
// refresh button and the retry use, so nothing flashes back to skeletons.
function reload() {
  api('GET', '/api/reader').then((d) => {
    data = d;
    sync();
  }).catch(() => { /* the screen keeps what it has */ });
}

// ── Refresh ───────────────────────────────────────────────────────────────

const refreshAll = () => api('POST', '/api/refresh', {});

async function withBusy(button, fn) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try { await fn(); } finally { button.disabled = false; button.removeAttribute('aria-busy'); }
}

refreshBtn.addEventListener('click', () => withBusy(refreshBtn, async () => {
  await refreshAll();
  reload();
}));

async function retryFeed(feed) {
  await withBusy(refreshBtn, () => api('POST', '/api/refresh', { feedId: feed.id }));
  reload();
}

// ── Add a feed ────────────────────────────────────────────────────────────

async function addFeed() {
  const url = addField.value.trim();
  addError.hidden = true;
  if (!url) {
    addError.textContent = 'Type the address of the feed to add, like example.com/feed.xml.';
    addError.hidden = false;
    addField.focus();
    return;
  }
  await withBusy(addBtn, async () => {
    try {
      await api('POST', '/api/feeds', { url });
      addField.value = '';
      reload();
    } catch (err) {
      // 400s carry a plain `reason` sentence from the server; the kit puts
      // the short error code in the message, so the reason wins.
      addError.textContent = (err && err.data && err.data.reason) || (err && err.message) || 'The feed could not be added.';
      addError.hidden = false;
    }
  });
  if (addError.hidden) addField.focus();
}

addBtn.addEventListener('click', addFeed);
addField.addEventListener('keydown', (e) => { if (e.key === 'Enter') addFeed(); });
addField.addEventListener('input', () => { addError.hidden = true; });

// ── Remove a feed (with a confirm) ────────────────────────────────────────

function confirmRemove(feed) {
  const name = feed.title || feed.url;
  openSheet({
    title: `Remove ${name}?`,
    closeLabel: 'Cancel',
    content: (body, close) => h('div', { class: 'kit-form' },
      h('p', { class: 'text-body text-muted' },
        'Its unread posts leave your list too. You can add the feed again later.'),
      h('div', { class: 'kit-form-actions' },
        h('button', { type: 'button', class: 'btn-secondary', on: { click: close } }, 'Cancel'),
        h('button', {
          type: 'button',
          class: 'btn-secondary text-danger',
          on: { click: async () => {
            try { await api('DELETE', `/api/feeds/${feed.id}`); } catch { /* keep the feed */ }
            close();
          } },
        }, 'Remove'))),
    onClose: reload,
  });
}

// ── The preview sheet ─────────────────────────────────────────────────────

function openPreview(post, row) {
  // Opening the preview marks the post read: its dot goes hollow at once,
  // and when the sheet closes the post leaves the list.
  api('POST', `/api/posts/${post.id}/read`, {}).catch(() => { /* refilled on close */ });
  const feed = data.feeds.find((f) => f.id === post.feed_id);
  if (feed && feed.unread > 0) feed.unread -= 1;

  const preview = screen(2);
  if (!preview) return;
  // Only a web link gets the button; a post with none shows no button.
  const link = /^https?:\/\//i.test(post.link || '') ? post.link : '';
  let host = '';
  try { host = link ? new URL(link).hostname : ''; } catch { host = ''; }
  const fill = {
    '.feed b': (feed && feed.title) || post.feed_title || '',
    '.feed .when': timeAgo(post.published_at || post.created_at),
    '.by': { text: post.author ? `By ${post.author}` : '', hidden: !post.author },
    '.body': {
      children: String(post.summary || '').split(/\n{2,}/)
        .filter(Boolean)
        .map((para) => h('p', {}, para)),
    },
  };
  if (link) {
    fill['.acts a'] = { attr: { href: link } };
    fill['.host'] = host;
  } else {
    fill['.acts'] = { hidden: true };
  }
  fillIn(preview, fill);
  if (row) row.querySelector('.dot').classList.add('is-read');
  openSheet({
    title: post.title || '(no title)',
    closeLabel: 'Close preview',
    content: preview,
    onClose: reload,
  });
}

load();
