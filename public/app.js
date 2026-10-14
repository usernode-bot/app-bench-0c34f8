// RSS Reader: the one screen, filled with the viewer's feeds. The markup is
// the drawn spec screen (public/index.html) and its styles (screens.css);
// this file only fills it with real data. Everything is set as text, never
// HTML — feed content arrives as plain text from the server already.

import { h, api, plural, isDemo } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { rowsFrom, fillIn } from '/kit/fill.js';
import { openFormSheet, openSheet } from '/kit/sheet.js';
import { loadNative, native, toast } from '/kit/native.js';
import { showDemoLabel } from '/kit/demo.js';

const screenEl = document.querySelector('[data-spec-screen="1"]');
const main = screenEl.querySelector('main');
const headEl = main.querySelector('.head');
const countEl = main.querySelector('.count');
const refreshBtn = headEl.querySelector('.icon-btn');
const feedsBtn = headEl.querySelector('.btn-secondary:not(.icon-btn)');
const addBtn = headEl.querySelector('.btn-primary');

// The drawn list's rows: the first drawn row is the expanded shape (it has
// the .preview), the second a closed one. Keep a copy of each as the
// template for that shape, then let rowsFrom clear the samples.
const drawn = main.querySelector('.list');
const drawnRows = [...drawn.children];
const openTpl = drawnRows[0].cloneNode(true);
const closedTpl = (drawnRows[1] || drawnRows[0]).cloneNode(true);
const openBtnTpl = openTpl.querySelector('.open button');
if (openBtnTpl) {
  // "Open article" opens the real article: an anchor, not a button, so it
  // behaves like a link (middle-click, long-press, target=_blank).
  const anchor = document.createElement('a');
  anchor.className = openBtnTpl.className;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  while (openBtnTpl.firstChild) anchor.appendChild(openBtnTpl.firstChild);
  openBtnTpl.replaceWith(anchor);
}
rowsFrom(drawn);
const listEl = drawn; // the drawn .list itself is the live container

// Where the data states live: a section of the drawn screen under the
// header, holding the skeleton, the empty state, the error and the drawn
// list (moved in here, so exactly one state shows at a time).
const statesHost = h('section', { class: 'feed-states' });
main.insertBefore(statesHost, countEl.nextSibling);

const states = createStates(statesHost, {
  rows: 5,
  empty: {
    title: 'No feeds yet',
    text: 'Add the address of a site\'s RSS feed to see its new posts here.',
    action: { label: 'Add your first feed', primary: true, onClick: openAddFeed },
  },
  error: {
    title: 'Your posts did not load',
    text: 'Your feeds are saved. Check the connection and try again.',
  },
});
states.content.appendChild(drawn); // the drawn .list, its samples cleared

// The empty state is reused for "no feeds" and "all caught up"; set it from
// the data each time instead of trusting the last render. The kit keeps the
// empty element private, but it is the one .state-empty in the host.
function setEmptyState(feeds, failedCount) {
  const emptyEl = statesHost.querySelector('.state-empty');
  if (!emptyEl) return;
  const title = emptyEl.querySelector('h2');
  const text = emptyEl.querySelector('p');
  const button = emptyEl.querySelector('button');
  if (!feeds.length) {
    title.textContent = 'No feeds yet';
    text.textContent = 'Add the address of a site\'s RSS feed to see its new posts here.';
    button.hidden = false;
  } else if (failedCount && failedCount === feeds.length) {
    title.textContent = 'Your feeds did not load';
    text.textContent = 'None of your feeds answered just now. Your feeds are saved.';
    button.hidden = true;
  } else {
    title.textContent = 'You\'re all caught up';
    text.textContent = 'Every post in your feeds is read. New posts appear here.';
    button.hidden = true;
  }
}

// A line under the header for feeds that failed this load: "1 feed did not
// load: Example Garden Notes", with a Retry link.
let errorLine = null;
function showErrorLine(feeds) {
  const failed = feeds.filter((f) => f.error);
  if (errorLine) errorLine.remove();
  errorLine = null;
  if (!failed.length) return;
  const names = failed.map((f) => f.title || f.url).join(', ');
  errorLine = h('p', { class: 'feed-errors px-1 text-small text-danger' },
    `${plural(failed.length, 'feed')} did not load: ${names}. `,
    h('button', { type: 'button', class: 'text-danger underline font-medium', on: { click: load } }, 'Retry'));
  main.insertBefore(errorLine, statesHost);
}

// ── Data ──────────────────────────────────────────────────────────────────

let posts = [];
let feeds = [];
let expanded = new Set(); // guids shown open
let markedRead = new Set(); // guids whose read mark was sent this visit

async function load() {
  return states.run(async (box) => {
    // The count line waits for real data: hidden while the list loads (and it
    // stays hidden if the load fails), shown once the posts have arrived.
    countEl.hidden = true;
    const data = await api('GET', '/api/posts');
    posts = data.posts || [];
    feeds = data.feeds || [];
    expanded = new Set();
    showErrorLine(feeds);
    const failed = feeds.filter((f) => f.error).length;
    const ok = feeds.length - failed;
    countEl.textContent = feeds.length
      ? `${plural(posts.length, 'unread post')} from ${plural(ok, 'feed')}`
      : 'No feeds yet';
    countEl.hidden = false;
    // On the empty screen the header's Add feed is outlined too, so "Add
    // your first feed" is the only filled button.
    const isBlank = !feeds.length || (!posts.length && !failed);
    addBtn.classList.toggle('btn-primary', !isBlank);
    addBtn.classList.toggle('btn-secondary', isBlank);
    if (isDemo() && !main.querySelector('.kit-demo-label')) {
      showDemoLabel(main, 'Staging demo: made-up feeds and posts, everything here works.');
    }
    if (!posts.length) {
      setEmptyState(feeds, failed);
      return false;
    }
    renderRows();
    return true;
  });
}

function shortAgo(when) {
  const minutes = Math.floor(Math.max(0, Date.now() - new Date(when).getTime()) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  if (hours < 48) return 'Yesterday';
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(when).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function fullDate(when) {
  const d = new Date(when);
  const day = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function makeRow(post, open) {
  const li = open ? openTpl.cloneNode(true) : closedTpl.cloneNode(true);
  li.setAttribute('data-post', post.guid);
  const postEl = li.querySelector('.post');
  postEl.setAttribute('role', 'button');
  postEl.setAttribute('tabindex', '0');
  postEl.setAttribute('aria-expanded', String(open));
  const dot = li.querySelector('.dot');
  dot.classList.toggle('read', markedRead.has(post.guid));
  const map = {
    '.feed': post.feedTitle,
    '.meta span:last-child': shortAgo(post.publishedAt),
    '.title': post.title,
  };
  if (open) {
    map['.when'] = fullDate(post.publishedAt);
    map['.open a'] = {
      attr: { href: post.link || null },
      on: { click: (e) => e.stopPropagation() },
    };
    map['.host'] = post.link ? hostOf(post.link) : '';
    // The drawn preview paragraphs: fill the first, add the rest, drop any
    // spares. Paragraph text, server-cleaned.
    const paras = post.preview && post.preview.length ? post.preview : [post.excerpt];
    const drawnParas = [...li.querySelectorAll('.preview p:not(.when)')];
    let lastPara = drawnParas[0];
    paras.forEach((text, i) => {
      if (i < drawnParas.length) { drawnParas[i].textContent = text; lastPara = drawnParas[i]; }
      else {
        const p = h('p', {}, text);
        lastPara.parentNode.insertBefore(p, lastPara.nextSibling);
        lastPara = p;
      }
    });
    for (const spare of drawnParas.slice(paras.length)) spare.remove();
    if (!post.link) fillIn(li, { '.open a': { text: 'Open article', attr: { 'aria-disabled': 'true' } } });
  } else {
    map['.excerpt'] = post.excerpt;
  }
  fillIn(li, map);
  const toggle = () => toggleRow(post);
  postEl.addEventListener('click', toggle);
  postEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });
  return li;
}

function renderRows() {
  listEl.replaceChildren(...posts.map((p) => makeRow(p, expanded.has(p.guid))));
}

async function toggleRow(post) {
  if (expanded.has(post.guid)) {
    expanded.delete(post.guid);
    renderRows();
    return;
  }
  expanded.add(post.guid);
  if (!markedRead.has(post.guid)) {
    // Read as soon as it is tapped: the dot turns to a ring at once, the
    // mark is sent after, and the post leaves the list on the next load.
    markedRead.add(post.guid);
    api('POST', '/api/read', { feedId: post.feedId, guid: post.guid })
      .catch((err) => { markedRead.delete(post.guid); toast(err.message); });
  }
  renderRows();
  // Keep the opened post in view: its top should stay where it was.
  const row = listEl.querySelector(`[data-post="${cssEscape(post.guid)}"] .post`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function cssEscape(text) {
  return (window.CSS && CSS.escape) ? CSS.escape(text) : String(text).replace(/"/g, '\\"');
}

// ── Sheets ────────────────────────────────────────────────────────────────

function openAddFeed() {
  return openFormSheet({
    title: 'Add feed',
    fields: [{
      name: 'url',
      label: 'Feed address',
      type: 'text',
      required: true,
      max: 500,
      placeholder: 'e.g. https://example.com/feed.xml',
    }],
    submitLabel: 'Add feed',
    savedMessage: 'Feed added',
    onSubmit: async ({ url }) => {
      await api('POST', '/api/feeds', { url });
      await load();
    },
  });
}

async function openFeedsSheet() {
  const handle = await openSheet({
    title: 'Feeds',
    returnFocus: feedsBtn,
    content: (body, close) => renderFeedList(body, close),
  });
  return handle;
}

function renderFeedList(body, close) {
  body.replaceChildren(); // re-render after a removal starts from empty
  const note = h('p', { class: 'text-small text-muted' },
    feeds.length ? `${plural(feeds.length, 'feed')}, yours alone: nobody else sees these.` : 'No feeds yet.');
  body.append(note);
  if (!feeds.length) return;
  const list = h('ul', { class: 'list' });
  body.append(list);
  for (const feed of feeds) {
    list.append(h('li', { class: 'list-row' },
      h('div', { class: 'kit-row-text' },
        h('span', { class: 'kit-row-title' }, feed.title || hostOf(feed.url)),
        h('span', { class: 'kit-row-sub' }, feed.url),
        feed.error ? h('span', { class: 'kit-row-sub text-danger' }, 'Did not load') : null),
      h('button', {
        type: 'button', class: 'btn-secondary',
        on: { click: () => removeFeed(feed, body, close) },
      }, 'Remove')));
  }
}

async function removeFeed(feed, body, close) {
  const un = native();
  if (un && typeof un.alert === 'function') {
    const choice = await un.alert({
      title: 'Remove feed?',
      message: `Remove "${feed.title || feed.url}" and its read marks?`,
      buttons: [{ label: 'Remove', style: 'destructive' }, { label: 'Cancel', style: 'cancel' }],
    });
    // The kit resolves with the pressed button object as `choice.button`
    // ({ label, style }). Only a clear Cancel keeps the feed; anything
    // else — including a shape the kit later changes — removes it.
    const picked = choice && typeof choice === 'object'
      ? (choice.button && choice.button.label) || choice.label
      : choice;
    if (picked && String(picked).toLowerCase() === 'cancel') return;
  }
  try {
    await api('DELETE', `/api/feeds/${feed.id}`);
    toast('Feed removed');
  } catch (err) {
    toast(err.message);
    return;
  }
  const at = feeds.indexOf(feed);
  if (at >= 0) feeds.splice(at, 1);
  if (feeds.length) renderFeedList(body, close);
  else close();
  await load();
}

// ── Wiring ────────────────────────────────────────────────────────────────

addBtn.addEventListener('click', openAddFeed);
feedsBtn.addEventListener('click', openFeedsSheet);
refreshBtn.addEventListener('click', async () => {
  refreshBtn.setAttribute('aria-busy', 'true');
  try {
    await load();
    // states.run reports failures through the error state, not a throw.
    if (statesHost.dataset.state === 'error') return;
    const failed = feeds.filter((f) => f.error).length;
    toast(failed ? `${plural(failed.length, 'feed')} did not load` : 'Feeds refreshed');
  } finally {
    refreshBtn.removeAttribute('aria-busy');
  }
});

// The list also refreshes when the app is opened or comes back to the front.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});

(async () => {
  await loadNative();
  const un = native();
  if (un && typeof un.attachPullToRefresh === 'function') {
    un.attachPullToRefresh(window, () => load());
  }
  load();
})();
