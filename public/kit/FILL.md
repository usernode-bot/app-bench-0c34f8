# public/kit/fill.js: the screens the plan drew, filled in place

The platform puts the plan's drawn screens in `public/index.html` before
you start (screen 1 in place, screen 2 and on as `<template
data-spec-screen="N">`), styled by `public/screens.css`. Their lists hold
sample rows. Keep that markup and fill it: do not rebuild the same rows
with `h()`, and do not swap a drawn list for `renderList`.

```js
import { rowsFrom, groupsFrom, fillIn, screen } from '/kit/fill.js';
rowsFrom(listEl, rowSelector?)     // keeps the first drawn row, removes the samples; returns make() for a fresh copy
groupsFrom(container, headingSel, listSel)  // drawn day groups: returns make(heading) => { heading, list }
fillIn(el, { selector: value })    // '' is el itself; value: text, a Node, or { text, hidden, class, attr, on, children }
screen(n)                          // a copy of drawn screen n, or null
```

Every value is set as text or as a checked attribute: `href` and `src`
take only http(s), mailto, tel or a relative path, and events go in `on`,
never an `on*` attribute. A selector that matches nothing throws, so a
renamed class fails loudly. Take the row first (rowsFrom), then the groups
(groupsFrom), then render into createStates' box:

```js
const app = document.querySelector('.app');
const postRow = rowsFrom(app.querySelector('.list'));
const dayGroup = groupsFrom(app, '.section-label', '.list');
const view = createStates(document.getElementById('posts'), { /* empty, error */ });
view.run(async (box) => {
  const { posts } = await api('GET', '/api/posts');
  if (!posts.length) return false;
  for (const [day, list] of byDay(posts)) {
    const g = dayGroup(day);
    g.list.append(...list.map((p) => fillIn(postRow(), {
      '.post-feed': p.feedTitle,
      '.post-title': p.title,
      '.post-time': timeAgo(p.publishedAt),
      '': { class: { 'is-read': p.read } },
      'button.post': { on: { click: () => openPost(p) } },
    })));
    box.append(g.heading, g.list);
  }
});
// The screen a post opens to, as the plan drew it:
const detail = screen(2);
fillIn(detail, { '.kit-detail-title': post.title, '.meta': `By ${post.author}` });
```
