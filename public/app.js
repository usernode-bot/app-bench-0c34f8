// RSS Reader: one scrolling list of unread posts, newest first, grouped by
// day. Tapping a post opens a preview and marks it read; feeds are private
// per user. Fill the screen the spec drew; never feed content as HTML.
import { api, h, plural, timeAgo, now } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { openSheet, renderForm } from '/kit/sheet.js';
import { toast } from '/kit/native.js';
import { showDemoLabel } from '/kit/demo.js';
import { rowsFrom, groupsFrom, fillIn } from '/kit/fill.js';

const main = document.querySelector('[data-spec-screen="1"] main');
const postsBox = document.getElementById('posts');
const statusEl = document.getElementById('status');
const refreshBtn = document.getElementById('refresh');
const addFeedBtn = document.getElementById('add-feed');
const markReadBtn = document.getElementById('mark-read');
const doneBox = main.querySelector('.done');

const letter = (title) => (String(title || '?').trim().match(/[a-zA-Z0-9]/) || ['?'])[0].toUpperCase();

const data = { posts: [], feedCount: 0, checkedAt: null, failed: [], demo: false };
const sessionRead = new Map(); // read this session: dimmed on a quiet reload, gone on the next load
let refreshing = false;
let demoShown = false;

// ── Time in words for a post row ───────────────────────────────────────────

function timeText(iso) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const n = now();
  const minutes = Math.floor(Math.max(0, n - t) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} hr ago`;
  const yesterday = new Date(n);
  yesterday.setDate(yesterday.getDate() - 1);
  if (t.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function groupOf(iso) {
  const t = new Date(iso);
  const n = now();
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const local = day(t);
  if (local >= day(n)) return 'Today';
  if (local >= day(n) - 86400000) return 'Yesterday';
  return 'Earlier';
}

// ── The drawn screen's row and day groups, ready to fill ───────────────────

const postRow = rowsFrom(postsBox.querySelector('.list'));
const group = groupsFrom(postsBox, '.section-label', '.list');

const states = createStates(postsBox, {
  rows: 6,
  empty: {
    title: 'Add your first feed',
    text: 'Paste the address of a blog or news site’s feed and its new posts land here.',
    action: { label: 'Add a feed', primary: true, onClick: openFeeds },
  },
  error: {
    title: 'Your posts did not load',
    text: 'Your feeds are still saved. Try again in a moment.',
  },
});

function rowEl(post) {
  const row = postRow();
  fillIn(row, {
    '.chip': { text: letter(post.source), class: { [`f${post.color}`]: true } },
    '.src': post.source,
    '.muted': timeText(post.publishedAt),
    '.ttl': post.title,
    '.sum': { text: post.summary, hidden: !post.summary },
    '': {
      class: { 'post-row': true, 'is-read': sessionRead.has(post.id) },
      attr: { 'data-post-row': '', tabindex: '0', role: 'button', 'aria-label': `${post.title}, from ${post.source}` },
      on: {
        click: () => openPost(post, row),
        keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPost(post, row); } },
      },
    },
  });
  return row;
}

function render() {
  const shown = [...data.posts, ...sessionRead.values()]
    .filter((p, i, all) => all.findIndex((x) => x.id === p.id) === i)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  const order = ['Today', 'Yesterday', 'Earlier'];
  const parts = [];
  for (const name of order) {
    const inGroup = shown.filter((p) => groupOf(p.publishedAt) === name);
    if (!inGroup.length) continue;
    const g = group(name);
    g.list.append(...inGroup.map(rowEl));
    parts.push(g.heading, g.list);
  }
  states.content.replaceChildren(...parts);
  doneBox.hidden = !data.posts.length;
}

function updateStatus() {
  if (refreshing) { statusEl.textContent = 'Checking your feeds'; return; }
  if (!data.feedCount && !data.posts.length) { statusEl.textContent = ''; return; }
  const bits = [`${plural(data.posts.length, 'post')} from ${plural(data.feedCount, 'feed')}`];
  if (data.checkedAt) bits.push(`checked ${timeAgo(data.checkedAt)}`);
  if (data.failed.length) bits.push(`${plural(data.failed.length, 'feed')} did not answer: ${data.failed.map((f) => f.title).join(', ')}`);
  statusEl.textContent = bits.join(', ');
}

// ── Loading ────────────────────────────────────────────────────────────────

async function task(content) {
  const res = await api('GET', '/api/posts');
  data.posts = res.posts || [];
  data.feedCount = res.feedCount || 0;
  data.checkedAt = res.checkedAt || null;
  data.failed = res.failed || [];
  if (res.demo && !demoShown) {
    demoShown = true;
    showDemoLabel(main, 'Staging demo: these feeds and posts are made up.');
  }
  if (!data.posts.length && data.feedCount) {
    // The kit's states take one empty config, so the caught-up variant is
    // rendered here, inside the content box. The server just confirmed
    // everything unread is gone, so this session's dimmed rows go too.
    sessionRead.clear();
    content.replaceChildren(h('div', { class: 'state-empty' },
      h('h2', { class: 'text-heading' }, 'You are all caught up'),
      h('p', { class: 'text-body text-muted' }, `New posts from your ${plural(data.feedCount, 'feed')} show up here.`),
      h('button', { type: 'button', class: 'btn-secondary mt-2', on: { click: refresh } }, 'Check again')));
    doneBox.hidden = true;
    updateStatus();
    return true;
  }
  render();
  updateStatus();
  return data.posts.length > 0;
}

async function load({ quiet = false } = {}) {
  if (quiet) return task(states.content); // no skeleton on a quiet reload
  await states.run(task);
}

// ── Reading a post ─────────────────────────────────────────────────────────

function svgEl(paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
    svg.setAttribute(k, v);
  }
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

const EXTERNAL = ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'];

function previewEl(post) {
  const host = post.link ? new URL(post.link).hostname : null;
  const paras = String(post.summary || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return h('div', { class: 'flex flex-col' },
    h('div', { class: 'bar' },
      h('span', { class: `chip f${post.color}` }, letter(post.source)),
      h('div', { class: 'who' },
        h('p', { class: 'src' }, post.source),
        h('p', { class: 'text-small muted' }, timeAgo(post.publishedAt)))),
    post.author ? h('p', { class: 'text-small muted by' }, `By ${post.author}`) : null,
    h('div', { class: 'text' },
      paras.length
        ? paras.map((t) => h('p', {}, t))
        : h('p', {}, 'This feed sends titles only. Open the full article to read it.')),
    h('div', { class: 'foot' },
      post.link
        ? h('a', { class: 'btn-primary', href: post.link, target: '_blank', rel: 'noopener noreferrer' }, 'Open full article', svgEl(EXTERNAL))
        : null,
      post.link ? h('p', { class: 'text-small muted' }, `Opens ${host} in your browser`) : null));
}

async function openPost(post, row) {
  if (!sessionRead.has(post.id)) {
    sessionRead.set(post.id, post);
    const at = data.posts.findIndex((x) => x.id === post.id);
    if (at >= 0) data.posts.splice(at, 1);
    row.classList.add('is-read');
    updateStatus();
    try {
      await api('POST', `/api/posts/${post.id}/read`);
    } catch (err) {
      sessionRead.delete(post.id);
      if (at >= 0) data.posts.splice(Math.min(at, data.posts.length), 0, post);
      row.classList.remove('is-read');
      updateStatus();
      toast(err.message || 'Could not mark that post as read');
      return;
    }
  }
  await openSheet({ title: post.title, returnFocus: row, content: (body) => body.append(previewEl(post)) });
}

// ── Feeds: add, list, remove ───────────────────────────────────────────────

function removeButton(feed, after) {
  const btn = h('button', { type: 'button', class: 'btn-secondary' }, 'Remove');
  let armed = false;
  let timer = null;
  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.textContent = 'Really remove?';
      timer = setTimeout(() => { armed = false; btn.textContent = 'Remove'; }, 6000);
      return;
    }
    clearTimeout(timer);
    btn.disabled = true;
    try {
      await api('DELETE', `/api/feeds/${feed.id}`);
      toast(`Removed ${feed.title}. Its posts leave your list.`);
      await load({ quiet: true }).catch(() => {});
      await after();
    } catch (err) {
      armed = false;
      btn.disabled = false;
      btn.textContent = 'Remove';
      toast(err.message || 'Could not remove that feed');
    }
  });
  return btn;
}

async function fillFeedList(box) {
  const res = await api('GET', '/api/feeds');
  const feeds = res.feeds || [];
  const rows = feeds.map((f) => {
    const sub = h('p', { class: 'text-small muted' },
      f.lastError ? 'Did not answer last time' : f.unread ? `${plural(f.unread, 'unread post')}` : 'No unread posts');
    const btn = removeButton(f, () => fillFeedList(box));
    const row = h('li', { class: 'list-row' },
      h('span', { class: `chip f${f.color}` }, letter(f.title)),
      h('div', { class: 'body' },
        h('p', { class: 'src' }, f.title),
        sub), btn);
    // The confirm: the row says what removal does before the second tap.
    btn.addEventListener('click', () => { if (btn.textContent === 'Really remove?') sub.textContent = `Remove ${f.title}? Its posts leave your list.`; });
    return row;
  });
  box.replaceChildren(
    h('h3', { class: 'section-label' }, feeds.length ? `Following ${plural(feeds.length, 'feed')}` : 'Not following any yet'),
    h('ul', { class: 'list' }, rows.length ? rows : h('li', { class: 'list-row text-small muted' }, 'Paste an address above to follow your first feed.')));
}

async function openFeeds() {
  await openSheet({
    title: 'Your feeds',
    returnFocus: addFeedBtn,
    content: (body) => {
      const formBox = h('div');
      const listBox = h('div', { class: 'mt-6' });
      body.append(formBox, listBox);
      renderForm(formBox, {
        fields: [{ name: 'url', label: 'Feed address', placeholder: 'e.g. https://example.com/feed', required: true, max: 500 }],
        submitLabel: 'Add feed',
        onSubmit: async (v) => {
          const res = await api('POST', '/api/feeds', { url: v.url });
          toast(`Added ${res.feed.title}, ${plural(res.added, 'new post')}`);
          await load({ quiet: true }).catch(() => {});
          await fillFeedList(listBox);
        },
      });
      fillFeedList(listBox).catch(() => {});
    },
  });
}

// ── Refresh and mark all ───────────────────────────────────────────────────

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  refreshBtn.disabled = true;
  const iconSvg = refreshBtn.querySelector('svg');
  if (iconSvg) iconSvg.classList.add('spin');
  updateStatus();
  try {
    await api('POST', '/api/refresh');
  } catch {
    toast('Could not check your feeds. Your saved posts are still here.');
  }
  try {
    await load({ quiet: true });
  } catch (err) {
    toast(err.message || 'Your posts did not load. Try again in a moment.');
  }
  refreshing = false;
  refreshBtn.disabled = false;
  if (iconSvg) iconSvg.classList.remove('spin');
  updateStatus();
}

markReadBtn.addEventListener('click', async () => {
  markReadBtn.disabled = true;
  const ids = data.posts.map((p) => p.id).filter((id) => id > 0);
  try {
    await api('POST', '/api/posts/read', { ids });
    for (const p of data.posts) sessionRead.set(p.id, p);
    data.posts = [];
    render();
    updateStatus();
    await load({ quiet: true });
  } catch (err) {
    toast(err.message || 'Could not mark those posts as read');
  }
  markReadBtn.disabled = false;
});

refreshBtn.addEventListener('click', refresh);
addFeedBtn.addEventListener('click', openFeeds);

load().catch(() => {}); // createStates shows the error state on its own