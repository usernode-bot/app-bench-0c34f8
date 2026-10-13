// The Unread screen: the viewer's feeds' unread posts, newest first.
// The drawn rows and the drawn preview are filled with data, not rebuilt.
import { api, h, now, plural } from '/kit/dom.js';
import { createStates } from '/kit/states.js';
import { openFormSheet, openSheet } from '/kit/sheet.js';
import { rowsFrom, fillIn, screen } from '/kit/fill.js';
import { showDemoLabel } from '/kit/demo.js';
import { toast } from '/kit/native.js';

const appEl = document.querySelector('.app');
const countEl = document.getElementById('count');
const failuresEl = document.getElementById('feed-failures');
const addBtn = document.getElementById('add-feed');

// The drawn row is the row to repeat: keep it as the template, drop the samples.
const postRow = rowsFrom(document.querySelector('.list'));
// The drawn preview moves where it belongs (inside the kit sheet) and the
// inert template goes away.
const previewTpl = screen(2);
document.querySelector('template[data-spec-screen="2"]').remove();

const view = createStates(document.getElementById('list-area'), {
  rows: 5,
  empty: {
    title: 'Add your first feed',
    text: 'Add an RSS or Atom feed and its unread posts will show up here.',
    action: { label: 'Add feed', onClick: openAddSheet, primary: true },
  },
  error: {
    title: 'Posts did not load',
    text: 'Your feeds are safe. Nothing was lost, try again.',
  },
});

let feedCount = 0;

// The drawn "when" values are the short kind: "12 min", "1 hr", "Yesterday".
function whenLabel(post) {
  const at = new Date(post.published_at || post.fetched_at).getTime();
  const n = new Date(now()).getTime();
  if (!Number.isFinite(at)) return '';
  const minutes = Math.floor(Math.max(0, n - at) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function updateCount() {
  const rows = view.content.querySelectorAll('.list > li').length;
  countEl.textContent = rows || feedCount
    ? `${plural(rows, 'post')} from ${plural(feedCount, 'feed')}`
    : '';
}

function rowFor(post) {
  const li = postRow();
  // The row is one button (li > button.list-row), like the kit's tappable rows.
  const button = h('button', { type: 'button', class: 'list-row kit-row', 'data-post': String(post.id) });
  while (li.firstChild) button.appendChild(li.firstChild);
  li.removeAttribute('class');
  li.append(button);
  fillIn(button, {
    '.feed-tag': post.feed_title,
    '.when': whenLabel(post),
    '.title': post.title,
    '.summary': post.summary || 'This feed gave no summary for this post.',
    '': { on: { click: () => openPreview(post, li) } },
  });
  return li;
}

// The drawn preview, filled from the post: the feed tag up top, then the
// meta line, the body in the serif, and the link to the full article.
function previewFor(post) {
  const sheet = previewTpl.querySelector('.sheet').cloneNode(true);
  sheet.classList.add('kit-preview');
  sheet.querySelector('.grab').remove();
  const bar = sheet.querySelector('.sheet-bar');
  bar.querySelector('.close').remove();
  // The post's own title names the dialog, so it shows in the sheet's head.
  sheet.querySelector('.title').remove();
  const paras = [...sheet.querySelectorAll('.body')];
  const paraTpl = paras[0].cloneNode(true);
  for (const p of paras.slice(1)) p.remove();

  // The drawn sample feed tag and meta line stand in for the post's own.
  const label = whenLabel(post);
  const when = !label ? '' : label === 'now' ? 'Just now' : / min$| hr$/.test(label) ? `${label} ago` : label;
  const meta = when && post.author ? `${when}, by ${post.author}` : when || (post.author ? `By ${post.author}` : '');
  fillIn(sheet, { '.feed-tag': post.feed_title || '', '.text-small': meta });
  if (!meta) sheet.querySelector('.text-small').remove();

  const link = sheet.querySelector('.btn-primary');
  if (post.link) {
    fillIn(link, { '': { attr: { href: post.link, target: '_blank', rel: 'noopener noreferrer' } } });
  } else {
    link.remove();
  }
  const parts = String(post.summary || '').split(/\n\n+/).filter(Boolean);
  sheet.querySelector('.body').textContent = parts.length ? parts[0] : 'This feed gave no summary for this post.';
  for (const part of parts.slice(1)) {
    const p = paraTpl.cloneNode(true);
    p.textContent = part;
    sheet.insertBefore(p, link.isConnected ? link : null);
  }
  if (!post.link) {
    sheet.append(h('p', { class: 'text-small muted' }, 'This post has no link to open.'));
  }
  return sheet;
}

// Tapping a post marks it read right away (the creator chose this) and opens
// the preview. On close the post leaves the list. If marking fails, the
// post stays in the list.
async function openPreview(post, li) {
  let read = false;
  try {
    await api('POST', `/api/posts/${post.id}/read`);
    read = true;
  } catch {
    toast('Could not mark this read. The post stays in the list.');
  }
  openSheet({
    title: post.title || 'Post preview',
    content: (body) => body.append(previewFor(post)),
    onClose: () => {
      if (read) {
        li.remove();
        updateCount();
      }
    },
  });
}

function openAddSheet() {
  openFormSheet({
    title: 'Add feed',
    returnFocus: addBtn,
    fields: [{
      name: 'url',
      label: 'Feed address',
      required: true,
      max: 500,
      placeholder: 'e.g. example.com/feed.xml',
      hint: 'The address of the RSS or Atom feed.',
    }],
    submitLabel: 'Add feed',
    savedMessage: 'Feed added',
    onSubmit: async (values) => {
      await api('POST', '/api/feeds', { url: values.url });
      await load();
    },
  });
}

async function load() {
  return view.run(async (box) => {
    const data = await api('GET', '/api/posts');
    feedCount = data.feedCount || 0;
    if (data.demo) showDemoLabel(appEl, 'Staging demo: these feeds and posts are made up.');
    const failed = data.failedFeeds || [];
    failuresEl.replaceChildren(...failed.map((name) =>
      h('p', { class: 'text-small muted' }, `${name} could not be updated just now. Its saved posts are still here.`)));
    failuresEl.hidden = !failed.length;
    if (!data.feedCount) return false;
    if (!data.posts.length) {
      updateCount();
      box.append(h('div', { class: 'state-empty' },
        h('h2', { class: 'text-heading' }, "You're all caught up"),
        h('p', { class: 'text-body text-muted' }, 'New posts appear here when your feeds update.')));
      return true;
    }
    box.append(h('ul', { class: 'list' }, data.posts.map(rowFor)));
    updateCount();
    return true;
  });
}

addBtn.addEventListener('click', openAddSheet);
load();