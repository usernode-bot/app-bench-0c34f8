// The Unread screen: one list of unread posts from the viewer's feeds, a
// preview sheet for a post, and a Feeds sheet that adds and removes feeds.
// The drawn screen in index.html stays the skeleton: its row and day group
// are cloned as templates, and every value comes from the API.
import { api, h, icon, plural, timeAgo, now, clear } from './kit/dom.js';
import { createStates } from './kit/states.js';
import { openSheet, renderForm } from './kit/sheet.js';
import { toast, loadNative } from './kit/native.js';
import { showDemoLabel } from './kit/demo.js';

const screenEl = document.querySelector('[data-spec-screen="1"]');
const appEl = screenEl.querySelector('main.app');
const postsEl = document.getElementById('posts');
const statusEl = document.getElementById('status');
const failedEl = document.getElementById('failed');
const endEl = document.getElementById('end');
const refreshBtn = document.getElementById('refresh');
const feedsBtn = document.getElementById('feeds');

// Templates captured before the kit replaces #posts with its states.
const rowSource = postsEl.querySelector('.list-row').cloneNode(true);
const daySource = postsEl.querySelector('.day').cloneNode(false);

const current = { posts: [], feedCount: 0, failedCount: 0, checkedAt: null };

const view = createStates(postsEl, {
  rows: 6,
  empty: {
    title: 'No feeds yet',
    text: 'Add the address of a feed or a site and its new posts appear here.',
    action: { label: 'Add a feed', onClick: () => openFeeds(), primary: true },
  },
  error: {
    title: 'Your posts did not load',
    text: 'Your feeds are saved. Try again in a moment.',
  },
});

// ── The unread list ──────────────────────────────────────────────────────

async function reload({ quiet = false } = {}) {
  const data = await api('GET', '/api/posts');
  current.posts = data.posts;
  current.feedCount = data.feedCount;
  current.failedCount = data.failedCount;
  current.checkedAt = data.checkedAt;
  if (data.demo) showDemoLabel(appEl, 'Staging demo: these feeds and posts are made up.');
  renderHeader();
  if (quiet) view.ready();
  if (!current.posts.length) {
    if (!current.feedCount) return false;
    renderCaughtUp();
  } else {
    renderList();
  }
  return true;
}

function renderHeader(checking) {
  statusEl.textContent = checking
    ? checking
    : `${plural(current.posts.length, 'post')} from ${plural(current.feedCount, 'feed')}`
      + (current.checkedAt ? `, checked ${timeAgo(current.checkedAt)}` : '');
  failedEl.hidden = !current.failedCount;
  if (current.failedCount) {
    failedEl.textContent = `${current.failedCount} ${current.failedCount === 1 ? 'feed' : 'feeds'} could not be checked`;
  }
}

function renderList() {
  clear(view.content);
  for (const [label, group] of groups()) {
    const day = daySource.cloneNode(false);
    day.append(h('h2', { class: 'section-label' }, label));
    const list = h('ul', { class: 'list' });
    for (const post of group) list.append(rowFor(post));
    day.append(list);
    view.content.append(day);
  }
  endEl.hidden = false;
}

function renderCaughtUp() {
  clear(view.content).append(
    h('div', { class: 'state-empty' },
      h('h2', { class: 'text-heading' }, "You're all caught up"),
      h('p', { class: 'text-body text-muted' },
        `No unread posts from your ${plural(current.feedCount, 'feed')}. Refresh to check for new ones.`),
      h('button', { type: 'button', class: 'btn-secondary mt-2', on: { click: () => refresh({ explicit: true }) } }, 'Refresh')));
  endEl.hidden = true;
}

function groups() {
  const out = [];
  const byLabel = new Map();
  for (const post of current.posts) {
    const label = dayLabel(post.publishedAt);
    if (!byLabel.has(label)) {
      byLabel.set(label, []);
      out.push([label, byLabel.get(label)]);
    }
    byLabel.get(label).push(post);
  }
  return out;
}

function dayLabel(iso) {
  const day = (t) => Math.floor(new Date(t).getTime() / 86_400_000);
  const ago = day(now()) - day(iso);
  if (ago <= 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  return 'Earlier';
}

function rowFor(post) {
  const li = h('li');
  const row = rowSource.cloneNode(true);
  row.setAttribute('data-post-row', '');
  row.classList.add('kit-row');
  const tile = row.querySelector('.src');
  tile.textContent = tileLetter(post.feedTitle);
  for (let n = 1; n <= 6; n += 1) tile.classList.toggle(`src-${n}`, post.color === n);
  row.querySelector('.post-source').textContent = post.feedTitle;
  const time = row.querySelector('.post-time');
  time.textContent = shortTime(post.publishedAt);
  time.setAttribute('datetime', post.publishedAt);
  time.setAttribute('title', new Date(post.publishedAt).toLocaleString());
  row.querySelector('.post-title').textContent = post.title;
  row.querySelector('.post-excerpt').textContent = firstParagraph(post.summary);
  row.addEventListener('click', () => openPreview(post, li));
  li.append(row);
  return li;
}

function tileLetter(title) {
  const word = String(title || '').replace(/^the\s+/i, '').trim();
  const ch = word.charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

// "18 min" under an hour, "3 h" under a day, the weekday under a week, then
// a short date; the full date sits on the row's time span.
function shortTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.floor(Math.max(0, now().getTime() - then) / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)} min`;
  if (mins < 1440) return `${Math.floor(mins / 60)} h`;
  const date = new Date(then);
  if (mins < 7 * 1440) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function firstParagraph(summary) {
  const text = String(summary || '');
  if (!text.trim()) return '';
  return text.split(/\n{2,}/)[0];
}

// ── The post preview ─────────────────────────────────────────────────────

async function openPreview(post, li) {
  let kept = false;
  let readFailed = false;
  const marked = api('POST', `/api/posts/${post.id}/read`, { read: true })
    .catch(() => { readFailed = true; });

  const sheet = await openSheet({
    title: post.feedTitle,
    returnFocus: li,
    content: (body) => {
      body.append(
        h('p', { class: 'byline' }, post.author ? `${post.author}, ${timeAgo(post.publishedAt)}` : timeAgo(post.publishedAt)),
        h('h3', { class: 'text-heading serif' }, post.title),
        h('div', { class: 'summary serif' }, summaryParagraphs(post.summary)),
        h('div', { class: 'actions' },
          post.link
            ? h('a', { class: 'btn-primary', href: post.link, target: '_blank', rel: 'noopener noreferrer' },
              'Open full article', openInBrowserIcon())
            : null,
          h('p', { class: 'host' }, post.link
            ? `Opens ${hostOf(post.link)} in your browser`
            : 'This post has no link to open.'),
          h('button', {
            type: 'button',
            class: 'btn-secondary',
            on: { click: () => { kept = true; api('POST', `/api/posts/${post.id}/read`, { read: false }).catch(() => {}); toast('Kept unread'); sheet.close(); } },
          }, 'Keep unread')));
    },
    onClose: () => {
      marked.then(() => {
        if (kept) return;
        if (readFailed) { toast('Could not mark it read'); return; }
        removePost(post, li);
      });
    },
  });
  // The drawn head puts the feed's tile beside its name.
  const head = sheet.el.querySelector('.kit-sheet-head');
  if (head) {
    const tile = h('span', { class: `src src-${post.color}`, 'aria-hidden': 'true' }, tileLetter(post.feedTitle));
    head.insertBefore(tile, head.firstChild);
  }
}

function summaryParagraphs(summary) {
  const paras = String(summary || '').split(/\n{2,}/).filter((p) => p.trim());
  if (!paras.length) return [h('p', { class: 'text-muted' }, 'This post has no summary.')];
  return paras.map((text) => h('p', {}, text));
}

// The drawn screen's open-in-browser glyph, as a fragment so it parses as SVG.
function openInBrowserIcon() {
  const holder = h('span');
  holder.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
  return holder.firstChild;
}

function hostOf(link) {
  try { return new URL(link).hostname; } catch { return 'the site'; }
}

function removePost(post, li) {
  const at = [...view.content.querySelectorAll('[data-post-row]')].indexOf(li.querySelector('[data-post-row]'));
  current.posts = current.posts.filter((p) => p.id !== post.id);
  li.style.maxHeight = `${li.scrollHeight}px`;
  requestAnimationFrame(() => li.classList.add('post-leaving'));
  setTimeout(() => {
    li.remove();
    for (const day of [...view.content.querySelectorAll('.day')]) {
      if (!day.querySelector('[data-post-row]')) day.remove();
    }
    renderHeader();
    endEl.hidden = current.posts.length === 0;
    if (!current.posts.length) {
      if (current.feedCount) renderCaughtUp();
      else reload({ quiet: true });
      return;
    }
    const rows = [...view.content.querySelectorAll('[data-post-row]')];
    (rows[Math.min(at, rows.length - 1)] || refreshBtn).focus({ preventScroll: true });
  }, 320);
}

// ── Refresh ──────────────────────────────────────────────────────────────

let checking = false;

async function refresh({ explicit = false } = {}) {
  if (checking) return;
  checking = true;
  refreshBtn.disabled = true;
  refreshBtn.setAttribute('aria-busy', 'true');
  refreshBtn.querySelector('svg').classList.add('spin');
  renderHeader(`Checking ${plural(current.feedCount, 'feed')}…`);
  try {
    const result = await api('POST', '/api/refresh');
    await reload({ quiet: true });
    if (explicit) toast(result.added ? plural(result.added, 'new post') : 'No new posts');
  } catch (err) {
    renderHeader();
    toast(err.message || 'Could not check for new posts');
  } finally {
    checking = false;
    refreshBtn.disabled = false;
    refreshBtn.removeAttribute('aria-busy');
    refreshBtn.querySelector('svg').classList.remove('spin');
  }
}

// The quiet check after loading: it never toasts, and a first feed's posts
// land without the viewer doing anything.
async function backgroundCheck() {
  try {
    const result = await api('POST', '/api/refresh');
    if (result.added) await reload({ quiet: true });
  } catch { /* the next explicit Refresh retries */ }
}

// ── The Feeds sheet ──────────────────────────────────────────────────────

function openFeeds() {
  openSheet({
    title: 'Your feeds',
    returnFocus: feedsBtn,
    content: (body) => {
      const listBox = h('div');
      body.append(h('div', { class: 'kit-form' }, h('div', { class: 'card' }), h('div', { class: 'section-label' }, 'Added feeds'), listBox));
      renderForm(body.querySelector('.card'), {
        fields: [{ name: 'url', label: 'Feed or site address', required: true, max: 500, placeholder: 'e.g. https://example.com/feed.xml' }],
        submitLabel: 'Add feed',
        onSubmit: async (values) => {
          const result = await api('POST', '/api/feeds', { url: values.url });
          toast(`Added ${result.feed.title}, ${plural(result.added, 'post')}`);
          form.reset();
          await Promise.all([run(), reload({ quiet: true })]);
        },
      });
      const form = body.querySelector('form');
      const feedsView = createStates(listBox, {
        rows: 3,
        empty: { title: 'No feeds yet', text: 'Add an address above to start following a site.' },
        error: { title: 'Your feeds did not load', text: 'Try again in a moment.' },
      });
      async function run() {
        await feedsView.run(async (content) => {
          const data = await api('GET', '/api/feeds');
          clear(content).append(h('ul', { class: 'list' }, data.feeds.map(feedRow)));
          return data.feeds.length ? true : false;
        });
      }

      // Removing a feed redraws the sheet's list and the unread list together.
      function feedRow(feed) {
        const rerun = () => Promise.all([run(), reload({ quiet: true })]);
        return h('li', { class: 'list-row items-start' },
          h('span', { class: `src src-${feed.color}`, 'aria-hidden': 'true' }, tileLetter(feed.title)),
          h('div', { class: 'kit-row-text' },
            h('p', { class: 'kit-row-title' }, feed.title),
            feed.lastError
              ? h('p', { class: 'kit-error' }, `Could not be read: ${feed.lastError}`)
              : h('p', { class: 'kit-row-sub' }, `${feed.unread} unread`)),
          h('button', {
            type: 'button',
            class: 'kit-icon-button',
            'aria-label': `Remove ${feed.title}`,
            on: { click: () => removeFeed(feed, rerun) },
          }, icon('close')));
      }

      run();
    },
  });
}

async function removeFeed(feed, rerun) {
  const un = await loadNative();
  let remove = false;
  if (un && typeof un.alert === 'function') {
    const answer = await un.alert({
      title: `Remove ${feed.title}?`,
      message: 'Its posts leave your list.',
      buttons: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Remove', style: 'destructive' },
      ],
    });
    remove = !!(answer && answer.button && answer.button.label === 'Remove');
  } else {
    remove = globalThis.confirm(`Remove ${feed.title}? Its posts leave your list.`);
  }
  if (!remove) return;
  try {
    await api('DELETE', `/api/feeds/${feed.id}`);
    toast(`Removed ${feed.title}`);
    await rerun();
  } catch (err) {
    toast(err.message || 'Could not remove the feed');
  }
}

// ── Start ────────────────────────────────────────────────────────────────

refreshBtn.addEventListener('click', () => refresh({ explicit: true }));
feedsBtn.addEventListener('click', () => openFeeds());
failedEl.addEventListener('click', () => openFeeds());

loadNative().then((un) => {
  if (un && typeof un.attachPullToRefresh === 'function') {
    un.attachPullToRefresh(document.scrollingElement, () => refresh());
  }
});

view.run(() => reload()).then((found) => { if (found) backgroundCheck(); });