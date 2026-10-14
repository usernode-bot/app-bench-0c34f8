// RSS Reader: the Unread screen. Loads the viewer's feeds and unread posts
// (GET /api/posts), fills the screen the spec drew with fill.js (rowsFrom and
// groupsFrom take the drawn row and day groups; nothing is rebuilt), and adds
// the actions: add a feed, tap to open the preview (marking the post read),
// Open in browser, Manage feeds with Remove.
import { h, clear, api, isDemo, now, plural } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { fillIn, rowsFrom, groupsFrom } from '/kit/fill.js';
import { openSheet } from '/kit/sheet.js';
import { toast, native } from '/kit/native.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const app = document.querySelector('#app');
const addForm = document.querySelector('.add');
const addInput = document.querySelector('#feed-url');
const addError = document.querySelector('#add-error');
const addBtn = addForm.querySelector('button');
const feedsLine = document.querySelector('.feeds');
const following = document.querySelector('#following');
const count = document.querySelector('.count');
const demoLabel = document.querySelector('#demo-label');

let currentFeeds = [];

// The drawn row and day groups, to repeat. Call once, before any render.
const postRow = rowsFrom(document.querySelector('.list'));
const dayGroup = groupsFrom(app, '.section-label', '.list');

const states = createStates(document.querySelector('#posts'), {
  rows: 4,
  empty: {
    title: 'Add your first feed',
    text: 'Paste a feed or site address and its new posts appear here.',
  },
  error: {
    title: 'Your posts did not load',
    text: 'Your feeds are still saved.',
  },
});

demoLabel.hidden = !isDemo();

// ── Load ───────────────────────────────────────────────────────────────────

async function load(content) {
  const data = await api('GET', '/api/posts');
  clear(content);

  if (data.signedOut) {
    addForm.hidden = true;
    feedsLine.hidden = true;
    content.append(h('div', { class: 'state-empty' },
      h('h2', { class: 'text-heading' }, 'You are not signed in'),
      h('p', { class: 'text-body text-muted' }, 'Open RSS Reader from Homeroom to see your unread posts.')));
    return true;
  }
  addForm.hidden = false;

  currentFeeds = data.feeds;
  count.textContent = data.unreadCount ? plural(data.unreadCount, 'new post') : '';

  // "Following 4 feeds" + the link into the sheet. With no feeds the empty
  // state above carries the message, so the line hides.
  feedsLine.hidden = !data.feeds.length;
  following.textContent = data.feeds.length ? `Following ${plural(data.feeds.length, 'feed')}` : '';

  // A feed that could not be read just now: its line sits above the list and
  // its earlier posts are still here. It is a notice, not a caption: a block
  // on the raised surface, with the feed symbol in grey before the words.
  for (const name of data.failed) {
    content.append(h('p', { class: 'feed-fail' }, failSig(),
      h('span', null, `${name} could not be read just now. Its earlier posts are still here.`)));
  }

  if (!data.feeds.length) return false; // the drawn empty state

  if (!data.posts.length) {
    content.append(h('div', { class: 'state-empty' },
      h('h2', { class: 'text-heading' }, "You're all caught up"),
      h('p', { class: 'text-body text-muted' },
        data.feeds.length === 1
          ? 'New posts from your feed show up here.'
          : `New posts from your ${data.feeds.length} feeds show up here.`)));
    return true;
  }

  // Day groups: Today, Yesterday, then dates. Posts arrive newest first, so
  // each day is one run of equal day keys.
  const at = now();
  const days = [];
  for (const post of data.posts) {
    const key = dayKey(post.date);
    const last = days[days.length - 1];
    if (last && last.key === key) last.posts.push(post);
    else days.push({ key, label: dayLabel(post.date, at), posts: [post] });
  }
  for (const day of days) {
    const g = dayGroup(day.label);
    g.list.append(...day.posts.map((post) => row(post, at)));
    // Each heading and its card in one section, as the spec drew it: the
    // 8 px heading margin stays inside, the 20 px gap sits between groups.
    content.append(h('section', null, g.heading, g.list));
  }
  return true;
}

// The feeds row shows a placeholder while the first load runs and no place
// in the error state ('Manage feeds' alone would read as half-rendered).
states.run(async (content) => {
  try {
    return await load(content);
  } catch (err) {
    feedsLine.hidden = true;
    throw err;
  }
});

// ── A post row ─────────────────────────────────────────────────────────────

function row(post, at) {
  const when = new Date(post.date);
  const time = timeText(when, at);
  const li = postRow();
  fillIn(li, {
    'button': {
      on: { click: () => toggle(li, post) },
      attr: { 'aria-expanded': 'false' },
    },
    '.meta b': post.feed,
    '.meta span': time,
    '.ttl': post.title,
    '.prev .date': `${when.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}, ${time}`,
    '.prev p': post.snippet || 'No preview text for this post.',
    '.prev a': { attr: { href: post.link } },
  });
  return li;
}

// Tap to open the preview and mark the post read; tap again to close. Read
// rows stay until the app is opened again.
function toggle(li, post) {
  const btn = li.querySelector('button');
  const prev = li.querySelector('.prev');
  const open = btn.getAttribute('aria-expanded') !== 'true';
  btn.setAttribute('aria-expanded', String(open));
  prev.hidden = !open;
  if (!open) return;
  if (li.classList.contains('read-row')) return;
  li.classList.add('read-row');
  li.querySelector('.sig').classList.add('read');
  api('POST', `/api/posts/${post.id}/read`).catch((err) => {
    console.warn('Mark read failed:', err.message);
  });
}

// ── Add feed ───────────────────────────────────────────────────────────────

let adding = false;
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (adding) return;
  const url = addInput.value.trim();
  addError.hidden = true;
  if (!url) {
    showAddError('Paste a feed or site address first.');
    addInput.focus();
    return;
  }
  adding = true;
  addBtn.disabled = true;
  addBtn.textContent = 'Adding';
  try {
    const done = await api('POST', '/api/feeds', { url });
    addInput.value = '';
    toast(`Added ${done.added}`);
    await states.run(load);
  } catch (err) {
    showAddError(err.message);
  } finally {
    adding = false;
    addBtn.disabled = false;
    addBtn.textContent = 'Add feed';
  }
});

function showAddError(message) {
  addError.textContent = message;
  addError.hidden = false;
}

// The feed symbol, small and grey, before the failure notice's words.
function failSig() {
  return h('svg', {
    class: 'sig', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linecap': 'round', 'aria-hidden': 'true',
  },
  h('circle', { cx: '6', cy: '18', r: '2', fill: 'currentColor' }),
  h('path', { d: 'M4 11a9 9 0 0 1 9 9' }),
  h('path', { d: 'M4 4a16 16 0 0 1 16 16' }));
}

// ── Manage feeds ───────────────────────────────────────────────────────────

// The open sheet's body, so a removal can redraw the list in place.
let manageBody = null;

document.querySelector('#manage').addEventListener('click', (e) => {
  e.preventDefault();
  if (!currentFeeds.length) return;
  openSheet({ title: 'Manage feeds', content: renderManage });
});

function renderManage(body) {
  manageBody = body;
  if (!currentFeeds.length) {
    body.append(h('p', { class: 'text-body text-muted' }, 'You are not following any feeds.'));
    return;
  }
  body.append(h('ul', { class: 'list' }, currentFeeds.map((feed) =>
    h('li', { class: 'list-row' },
      h('span', { class: 'txt' }, h('span', { class: 'ttl' }, feed.title)),
      h('button', {
        type: 'button',
        class: 'btn-secondary',
        on: { click: () => removeFeed(feed) },
      }, 'Remove')))));
}

async function removeFeed(feed) {
  if (await confirmRemove(feed.title)) {
    try {
      await api('DELETE', `/api/feeds/${feed.id}`);
      toast(`Removed ${feed.title}`);
      await states.run(load);
      if (manageBody && manageBody.isConnected) {
        clear(manageBody);
        renderManage(manageBody);
      }
    } catch (err) {
      toast(err.message);
    }
  }
}

// A destructive confirm: the native alert when the kit is there, else a sheet.
function confirmRemove(title) {
  const un = native();
  if (un && typeof un.alert === 'function') {
    return un.alert({
      title: `Remove ${title}?`,
      message: 'Its unread posts leave this list. You can add the feed back.',
      buttons: [{ label: 'Keep', style: 'cancel' }, { label: 'Remove', style: 'destructive' }],
    }).then((r) => !!(r && r.button && r.button.label === 'Remove'));
  }
  return new Promise((resolve) => {
    openSheet({
      title: `Remove ${title}?`,
      onClose: () => resolve(false),
      content: (body, close) => body.append(
        h('p', { class: 'text-body text-muted' }, 'Its unread posts leave this list. You can add the feed back.'),
        h('div', { class: 'kit-form-actions' },
          h('button', { type: 'button', class: 'btn-secondary', on: { click: close } }, 'Keep'),
          h('button', {
            type: 'button',
            class: 'btn-primary',
            on: { click: () => { close(); resolve(true); } },
          }, 'Remove'))),
    });
  });
}

// ── Day wording ────────────────────────────────────────────────────────────

function dayKey(date) {
  return new Date(date).setHours(0, 0, 0, 0);
}

function dayLabel(date, at) {
  const t = dayKey(at);
  const k = dayKey(date);
  const diff = Math.round((t - k) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(k).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function timeText(when, at) {
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (dayKey(when) === dayKey(at)) return time;
  return `${new Date(dayKey(when)).toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}
