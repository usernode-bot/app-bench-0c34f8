// The page: load posts, render the unread list, filter chips, the preview
// sheet, and the Your feeds sheet. Feed text is always set as text (via h),
// never HTML.
import { loadNative, native, toast } from '/kit/native.js';
import { api, h, clear, now } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { openSheet, renderForm } from '/kit/sheet.js';
import { showDemoLabel } from '/kit/demo.js';

const main = document.querySelector('.app');
const postsEl = document.getElementById('posts');
const chipsEl = document.getElementById('chips');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const refreshBtn = document.getElementById('refresh-btn');
const addBtn = document.getElementById('add-btn');

const view = createStates(postsEl, {
  rows: 6,
  error: { title: 'Your posts did not load', text: 'Your feeds are saved. Try again in a moment.' },
});

let data = { feeds: [], posts: [], demo: false, guest: false };
let selected = null; // feed id the chips filter to, or null for all
let readNow = new Set(); // posts marked read since this load; they stay, faded
let lastCheck = null; // { at: Date, failures: number }
let checking = false;

await loadNative();

// ── Time helpers ──────────────────────────────────────────────────────────

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Whole days between two moments on the local calendar. */
function daysApart(a, b) {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / 86_400_000);
}

/** "5m" or "2h" today, the weekday within a week, else "Oct 9". */
function rowTime(iso, at) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const mins = Math.max(0, Math.floor((at.getTime() - t.getTime()) / 60_000));
  if (dayKey(t) === dayKey(at)) return mins < 1 ? 'now' : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h`;
  const days = daysApart(t, at);
  if (days === 1) return 'Yst';
  if (days < 6) return t.toLocaleDateString(undefined, { weekday: 'short' });
  return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "today at 10:14" for the preview's byline. */
function bylineWhen(iso, at) {
  const t = new Date(iso);
  const clock = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = daysApart(t, at);
  const day = days === 0 ? 'today' : days === 1 ? 'yesterday'
    : `on ${t.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}`;
  return `${day} at ${clock}`;
}

// ── Icons ─────────────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** The empty state's drawing: the waves over a folded page, in line and accent. */
function emptyDrawing() {
  const svg = svgEl('svg', { viewBox: '0 0 120 96', 'aria-hidden': 'true', class: 'mb-1 h-24 w-auto', width: '120' });
  const ink = 'rgb(var(--line))';
  const page = svgEl('g', { fill: 'none', stroke: ink, 'stroke-width': '2.5', 'stroke-linejoin': 'round' });
  page.append(
    svgEl('path', { d: 'M22 14h52l24 24v44H22z' }),        // the page, one folded corner
    svgEl('path', { d: 'M74 14v24h24' }),                  // the fold
    svgEl('path', { d: 'M32 52h30M32 62h44M32 72h20', 'stroke-linecap': 'round', 'stroke-width': '2', opacity: '0.8' }),
  );
  const mark = svgEl('g', { fill: 'none', stroke: 'rgb(var(--accent))', 'stroke-width': '2.75', 'stroke-linecap': 'round' });
  mark.append(
    svgEl('circle', { cx: '40', cy: '78', r: '3.5', fill: 'rgb(var(--accent))', stroke: 'none' }),
    svgEl('path', { d: 'M36 60a20 20 0 0 1 20 20' }),
    svgEl('path', { d: 'M36 46a34 34 0 0 1 34 34', opacity: '0.55' }),
  );
  svg.append(page, mark);
  return svg;
}

// ── Derived data ──────────────────────────────────────────────────────────

const unreadOf = (post) => !readNow.has(post.id);
const visibleUnread = () => data.posts.filter(unreadOf);

function feedById(id) {
  return data.feeds.find((f) => f.id === id) || null;
}

function feedName(post) {
  const feed = feedById(post.feedId);
  return (feed && feed.title) || post.feedTitle || 'Feed';
}

function checkableFeeds() {
  return data.feeds.filter((f) => !f.isDemo).length;
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderHeader() {
  const unread = visibleUnread().length;
  countEl.textContent = String(unread);
  refreshBtn.disabled = checking;
  refreshBtn.querySelector('svg')?.classList.toggle('motion-safe:animate-spin', checking);
}

function renderChips() {
  clear(chipsEl);
  const unreadPerFeed = new Map();
  for (const post of data.posts) {
    if (!unreadOf(post)) continue;
    unreadPerFeed.set(post.feedId, (unreadPerFeed.get(post.feedId) || 0) + 1);
  }
  const chips = [{ id: null, title: 'All', count: visibleUnread().length }];
  for (const feed of data.feeds) {
    const count = unreadPerFeed.get(feed.id) || 0;
    if (count > 0 || selected === feed.id) chips.push({ id: feed.id, title: feed.title, count });
  }
  for (const chip of chips) {
    chipsEl.append(h('button', {
      type: 'button', class: 'chip',
      'aria-pressed': String(chip.id === selected),
      on: { click: () => { selected = chip.id; renderChips(); renderList(); } },
    }, chip.title, h('b', null, String(chip.count))));
  }
}

function setStatus(node) {
  clear(statusEl);
  if (node == null) { statusEl.hidden = true; return; }
  statusEl.hidden = false;
  statusEl.append(node);
}

function statusText(text) {
  setStatus(document.createTextNode(text));
}

function renderStatus() {
  if (checking) {
    const n = checkableFeeds();
    statusText(n ? `Checking your ${n} ${n === 1 ? 'feed' : 'feeds'}` : 'Checking your feeds');
    return;
  }
  if (!lastCheck) { setStatus(null); return; }
  if (lastCheck.failures > 0) {
    const n = lastCheck.failures;
    setStatus(h('button', {
      type: 'button', class: 'foot-link', on: { click: () => openFeeds(statusEl) },
    }, `${n} ${n === 1 ? 'feed could not be checked. See' : 'feeds could not be checked. See'} your feeds`));
    return;
  }
  const n = checkableFeeds();
  const when = lastCheck.at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  statusText(n ? `Checked your ${n} ${n === 1 ? 'feed' : 'feeds'} at ${when}` : `Checked at ${when}`);
}

function groupPosts(posts, at) {
  const groups = [];
  const byDay = new Map();
  for (const post of posts) {
    const key = dayKey(new Date(post.publishedAt));
    if (!byDay.has(key)) {
      byDay.set(key, []);
      const days = daysApart(new Date(post.publishedAt), at);
      groups.push({ days, key, posts: byDay.get(key) });
    }
    byDay.get(key).push(post);
  }
  // Everything older than yesterday is one "Earlier" group, not one per day.
  const merged = { days: 2, key: 'earlier', label: 'Earlier', posts: [] };
  const out = [];
  for (const g of groups) {
    g.label = g.days <= 0 ? 'Today' : g.days === 1 ? 'Yesterday' : 'Earlier';
    if (g.days < 2) out.push(g);
    else merged.posts.push(...g.posts);
  }
  if (merged.posts.length) out.push(merged);
  return out;
}

function postRow(post) {
  const read = readNow.has(post.id);
  const row = h('button', {
    type: 'button', class: `list-row kit-row post-row${read ? ' read' : ''}`,
    'aria-label': post.title,
    on: { click: () => openPreview(post, row) },
  },
  h('span', { class: 'dot unread-dot', 'aria-hidden': 'true' }),
  h('div', { class: 'post' },
    h('span', { class: 'post-title' }, post.title),
    h('span', { class: 'post-meta' },
      h('span', { class: 'feed' }, feedName(post)),
      h('time', { datetime: post.publishedAt }, rowTime(post.publishedAt, now())))));
  return h('li', null, row);
}

function renderList() {
  const box = view.content;
  const scrollY = window.scrollY;
  clear(box);
  const posts = selected == null ? data.posts : data.posts.filter((p) => p.feedId === selected);
  if (!posts.length) {
    box.append(data.feeds.length ? caughtUp() : firstFeed());
  } else {
    const groups = groupPosts(posts, now());
    for (const g of groups) {
      box.append(h('section', null,
        h('h2', { class: 'section-label' }, g.label),
        h('ul', { class: 'list' }, g.posts.map(postRow))));
    }
  }
  renderStatus();
  window.scrollTo({ top: scrollY });
}

// ── States ────────────────────────────────────────────────────────────────

function caughtUp() {
  const n = data.feeds.length;
  return h('div', { class: 'state-empty' },
    emptyDrawing(),
    h('h2', { class: 'text-heading' }, 'You\'re all caught up'),
    h('p', { class: 'text-body text-muted' },
      `New posts from your ${n} ${n === 1 ? 'feed' : 'feeds'} show up here as they're published.`),
    h('button', { type: 'button', class: 'btn-secondary mt-2', on: { click: () => refresh() } }, 'Refresh'));
}

function firstFeed() {
  return h('div', { class: 'state-empty' },
    emptyDrawing(),
    h('h2', { class: 'text-heading' }, 'Add your first feed'),
    h('p', { class: 'text-body text-muted' }, 'Paste the address of any RSS or Atom feed and its new posts show up here.'),
    h('button', { type: 'button', class: 'btn-primary mt-2', on: { click: () => openFeeds(null) } }, 'Add feed'));
}

async function load() {
  data = await api('GET', '/api/posts');
  readNow = new Set();
  if (data.demo) showDemoLabel(main, 'Staging demo: these feeds and posts are made up.');
  renderHeader();
  renderChips();
  renderList();
  return true;
}

// After the first load succeeds, check the feeds once in the background so
// the list is current; a slow feed never blocks the first paint.
async function loadAndCheck() {
  await view.run(load);
  if (!data.guest && checkableFeeds() > 0) await refresh();
}

// ── Refresh ───────────────────────────────────────────────────────────────

async function refresh() {
  if (checking) return;
  checking = true;
  refreshBtn.disabled = true;
  refreshBtn.querySelector('svg')?.classList.add('motion-safe:animate-spin');
  renderStatus();
  try {
    const fresh = await api('POST', '/api/refresh');
    data = fresh;
    readNow = new Set();
    lastCheck = { at: new Date(fresh.checkedAt), failures: (fresh.failures || []).length };
    renderHeader();
    renderChips();
    renderList();
  } catch {
    renderHeader();
    statusText('Feeds could not be checked. Try Refresh in a moment.');
  } finally {
    checking = false;
    refreshBtn.disabled = false;
    refreshBtn.querySelector('svg')?.classList.remove('motion-safe:animate-spin');
    if (lastCheck) renderStatus();
  }
}

refreshBtn.addEventListener('click', refresh);
addBtn.addEventListener('click', () => openFeeds(addBtn));

// ── The preview ───────────────────────────────────────────────────────────

/** Opening a preview marks the post read: the row fades at once, the server
 * is told, and a failure puts the row back and says so. */
async function markRead(post, row) {
  if (readNow.has(post.id)) return true;
  readNow.add(post.id);
  row.classList.add('read');
  renderHeader();
  renderChips();
  try {
    await api('POST', `/api/posts/${post.id}/read`);
    return true;
  } catch {
    readNow.delete(post.id);
    row.classList.remove('read');
    renderHeader();
    renderChips();
    toast('Could not mark that post read. Try again.');
    return false;
  }
}

function openPreview(post, row) {
  markRead(post, row);
  openSheet({
    title: feedName(post),
    returnFocus: row,
    content: (body) => {
      const at = now();
      const paragraphs = String(post.summary || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
      body.append(
        h('h2', { class: 'title' }, post.title),
        h('p', { class: 'byline' },
          post.author ? `By ${post.author}, ${bylineWhen(post.publishedAt, at)}` : bylineWhen(post.publishedAt, at)),
        h('div', { class: 'summary' },
          paragraphs.length ? paragraphs.map((p) => h('p', null, p)) : h('p', null, 'This feed shares no summary for this post.')),
        h('p', { class: 'note' }, post.link
          ? 'This is the summary the feed shares. The full article is on the publisher\'s site.'
          : 'This is the summary the feed shares. The feed gave no link to the full article.'),
        post.link ? h('div', { class: 'actions' },
          h('a', {
            class: 'btn-primary', href: post.link, target: '_blank', rel: 'noopener noreferrer',
          },
          svgEl('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', style: 'width:20px;height:20px' },
            svgEl('path', { d: 'M14 4h6v6' }),
            svgEl('path', { d: 'M20 4l-9 9' }),
            svgEl('path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' })),
          'Open in browser'),
          h('p', { class: 'host' }, hostOf(post.link))) : null,
      );
    },
  });
}

function hostOf(link) {
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return link; }
}

// ── Your feeds ────────────────────────────────────────────────────────────

/** The Add feed sheet: a form on top, the viewer's feeds with Remove below. */
function openFeeds(returnFocus) {
  openSheet({
    title: 'Your feeds',
    returnFocus,
    content: (body) => {
      renderForm(body, {
        submitLabel: 'Add',
        savedMessage: null,
        fields: [{
          name: 'url', label: 'Feed address', required: true, max: 500,
          placeholder: 'e.g. https://example.com/feed.xml',
        }],
        onSubmit: async (values) => {
          const added = await api('POST', '/api/feeds', { url: values.url });
          form.querySelector('input')?.removeAttribute('aria-invalid');
          renderFeedList();
          toast('Feed added');
          await reloadInPlace();
          return added;
        },
      });
      const form = body.querySelector('form');
      const listWrap = h('div', { class: 'mt-5' });
      body.append(listWrap);
      const renderFeedList = () => {
        clear(listWrap);
        listWrap.append(h('p', { class: 'section-label' }, 'Your feeds'));
        if (!data.feeds.length) {
          listWrap.append(h('p', { class: 'text-small text-muted px-1' }, 'No feeds yet. Paste an address above.'));
          return;
        }
        listWrap.append(h('ul', { class: 'list' }, data.feeds.map((feed) => {
          const status = feed.isDemo ? 'Staging demo feed'
            : feed.lastError ? feed.lastError
            : feed.lastCheckedAt ? `Checked ${whenShort(feed.lastCheckedAt)}`
            : 'Not checked yet';
          return h('li', { class: 'list-row' },
            h('div', { class: 'post' },
              h('span', { class: 'post-title text-body font-medium' }, feed.title),
              h('span', { class: 'post-meta' }, h('span', { class: 'feed' }, feed.url)),
              h('span', { class: `text-small ${feed.lastError && !feed.isDemo ? 'text-danger' : 'text-muted'}` }, status)),
            h('button', {
              type: 'button', class: 'btn-secondary self-center',
              on: { click: () => removeFeed(feed, renderFeedList) },
            }, 'Remove'));
        })));
      };
      renderFeedList();
    },
  });
}

function whenShort(iso) {
  const t = new Date(iso);
  const at = now();
  const mins = Math.max(0, Math.floor((at.getTime() - t.getTime()) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

async function removeFeed(feed, rerender) {
  const un = native();
  if (un && typeof un.alert === 'function') {
    const picked = await un.alert({
      title: `Remove ${feed.title}?`,
      message: 'Its posts leave your list.',
      buttons: [{ label: 'Remove', style: 'destructive' }, { label: 'Cancel', style: 'cancel' }],
    });
    // The kit resolves { button, value }: anything but an explicit Remove
    // (Cancel, Escape, a dismissed alert) leaves the feed alone.
    const label = picked && picked.button && picked.button.label;
    if (!label || !/remove/i.test(String(label))) return;
  }
  try {
    await api('DELETE', `/api/feeds/${feed.id}`);
    toast('Feed removed');
    if (selected === feed.id) selected = null;
    await reloadInPlace();
    rerender();
  } catch {
    toast('The feed could not be removed. Try again.');
  }
}

// Reload the data without dropping the page into a loading state: the list
// stays where it is and is redrawn in place.
async function reloadInPlace() {
  const fresh = await api('GET', '/api/posts');
  data = fresh;
  readNow = new Set();
  renderHeader();
  renderChips();
  if (!data.posts.length && view.content.children.length === 0) {
    await view.run(load);
    return;
  }
  renderList();
}

loadAndCheck();