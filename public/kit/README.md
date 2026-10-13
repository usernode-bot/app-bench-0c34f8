# public/kit: tested pieces to build with

ES modules, no build step. Each renders into a container you own, sets all
text as text (never HTML), and is styled only by the tokens and the `kit-*`
components at the end of `styles/tailwind-input.css`: restyle a piece there,
never by copying its markup. `package.json` marks these as ES modules.

Importing any piece loads the platform's native UI kit
(`/usernode-native/v1/native.css` and `native.js`, by relative path; never
copy them). Sheets, toasts and grouped lists are its, with its `--un-*`
colours pointed at this app's tokens. If it has not loaded within 4 s, the
pieces use their own sheet and toast, with only a console.warn.

Load your page script as a module, after the bridge script:

```html
<main id="app" class="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6"></main>
<script type="module" src="/app.js"></script>
```

The pieces assume one `.btn-primary` per screen, data loaded through
`createStates`, and placeholders that are examples ("e.g. ...").

## native.js: the native UI kit, and toasts

```js
import { loadNative, native, toast } from '/kit/native.js';
loadNative()            // resolves window.unNative, or null when it did not load
toast(message, opts)    // unNative.toast when loaded, else the kit's own
```

Take these straight from `unNative` (after `loadNative()`), never hand-made:

- switch: `<input type="checkbox" class="un-switch" role="switch">` (or a form's `switch` field);
- swipe actions on a row: `unNative.attachSwipeActions(rowEl, { actions: [{ label, destructive, handler }] })`;
- a menu or action sheet: `unNative.menu({ anchorEl, items: [{ label, handler }] })`;
- a confirm or alert: `unNative.alert({ title, message, buttons: [{ label, style }] })`;
- pull to refresh: `unNative.attachPullToRefresh(window, onRefresh)`;
- list to detail: `unNative.transition(fn, { type: 'push' })`, `'pop'` for Back.

## dom.js: API calls, elements, time

```js
import { api, h, icon, plural, timeAgo, isDemo } from '/kit/dom.js';
```

- `api(method, path, body?)` resolves the JSON, sending the token, the
  preview's "now" and `?demo=1`; it throws an Error fit to show (and `status`).
- `h(tag, attrs, ...children)`: attrs `class`, `on: { click }`, `hidden`, any
  other attribute. Strings become text nodes, so user text is safe.
- `icon(name, cls?)`: `check`, `chevron`, `back`, `close`, `plus` as line SVGs.
- `timeAgo(date)`: "5 minutes ago". `plural(3, 'vote')`: "3 votes".

```js
el.append(h('p', { class: 'text-small text-muted' }, `Posted ${timeAgo(item.createdAt)}`));
```

## states.js: loading, empty and error

```js
import { createStates } from '/kit/states.js';
createStates(el, { rows, empty: { title, text, action: { label, onClick, primary } }, error: { title, text } })
// returns { content, run(task), loading(), empty(), error(), ready() }
```

It starts on the skeleton. `run(task)` calls `task(content)`: return `false`
for empty, throw for the error state (its Try again reruns the task).

```js
const view = createStates(document.getElementById('items'), {
  empty: { title: 'No entries yet', text: 'Add the first one for everyone to see.', action: { label: 'Add an entry', onClick: openNew } },
  error: { title: 'Entries did not load', text: 'Nothing you saved is lost. Try again in a moment.' },
});
const load = () => view.run(async (box) => {
  const data = await api('GET', '/api/items');
  if (data.demo) showDemoLabel(document.getElementById('app'));
  if (!data.items.length) return false;
  renderList(box, data.items, { /* see list.js */ });
});
load();
```

## list.js: list and detail

```js
import { renderList, renderDetail } from '/kit/list.js';
renderList(el, items, { title, subtitle, meta, onOpen, label })   // a native un-group list; each returns text, an element or null
renderDetail(el, { title, meta, body, onBack, backLabel })        // returns { section(label), focus() }
```

```js
renderList(box, data.items, {
  label: 'Entries',
  subtitle: (item) => voteSummary(item.votes),
  meta: (item) => (item.commentCount ? plural(item.commentCount, 'comment') : null),
  onOpen: (item, row) => openItem(item.id, row),
});

function openItem(id, row) {
  listScreen.hidden = true; detailScreen.hidden = false;
  createStates(detailScreen, { rows: 3 }).run(async (box) => {
    const { item, comments } = await api('GET', `/api/items/${id}`);
    const detail = renderDetail(box, { title: item.title, meta: `${item.author}, ${timeAgo(item.createdAt)}`, body: item.body,
      onBack: () => { detailScreen.hidden = true; listScreen.hidden = false; row.focus(); } });
    renderVotes(detail.section('Your vote'), { ...item.votes, onVote: (option) => saveVote(item.id, option) });
    renderComments(detail.section('Comments'), { comments, onAdd: (body) => saveComment(item.id, body) });
    detail.focus();
  });
}
```

To vote from the list itself, give each item a `.card` with `renderVotes`
in it (a row is a button and cannot hold buttons).

## tally.js and votes.js: votes

```js
import { renderVotes } from '/kit/votes.js';
import { tally, voteSummary, applyVote, fromVotes, percents } from '/kit/tally.js';
renderVotes(el, { options: [{ id, label, count }], mine, onVote, label, layout: 'stack' | 'row', summary })
```

Real buttons with `aria-pressed`: the chosen one has the accent edge and a
filled check; each shows its count and a bar; tapping the chosen one again
takes the vote back. If `onVote(id or null)` throws, the vote goes back and
a toast says so.
`tally(state)` gives `{ options: [{ ...o, count, percent, share, chosen,
leading }], total, mine, leaders, tied }`, percents adding to 100;
`voteSummary(state)` says "6 votes, Yes leads". `layout: 'row'` suits two
short options.

```js
renderVotes(detail.section('Your vote'), {
  ...item.votes,                      // { options, mine }
  label: `Vote on ${item.title}`,
  layout: 'row',
  onVote: async (option) => (await api('POST', `/api/items/${item.id}/vote`, { option })).item.votes,
});
```

## comments.js: a thread with a composer

```js
import { renderComments } from '/kit/comments.js';
renderComments(el, { comments: [{ id, author, body, createdAt }], onAdd, label, placeholder, max, emptyText, postLabel })
// returns { add(comment) }
```

A failed post keeps the text: a 4xx message shows under the field, anything
else in a toast.

```js
renderComments(detail.section('Comments'), {
  comments,
  emptyText: 'No comments yet. Say what you think.',
  onAdd: async (body) => (await api('POST', `/api/items/${id}/comments`, { body })).comment,
});
```

## sheet.js: a form in a sheet

```js
import { openFormSheet, openSheet, renderForm } from '/kit/sheet.js';
openFormSheet({ title, fields, values, submitLabel, cancelLabel, savedMessage, onSubmit, onClose, returnFocus })
openSheet({ title, content(body, close), onClose, returnFocus })   // resolves { el, body, close() }
```

`unNative.presentSheet` below 640 px, `presentModal` from 640 px: a dialog
named by its title that keeps Tab inside, closes on Escape, Close or a tap
outside, and gives focus back. Field types: `text`, `textarea`, `number`,
`date`, `select` (`options`; optional starts on "None"), `switch` (an
un-switch, a boolean) and `choices` (2 to 6 vote options, `min: 0` for none;
`placeholder` may be a list). Empty `required` fields say "X is needed."
When `onSubmit` resolves the sheet closes and toasts `savedMessage` (null
for none); a throw shows its message in the form. `renderForm(el, ...)` is
the form without a sheet.

```js
newButton.addEventListener('click', () => openFormSheet({
  title: 'New entry',
  submitLabel: 'Post entry',
  savedMessage: 'Entry posted',
  fields: [
    { name: 'title', label: 'Title', required: true, max: 120, placeholder: 'e.g. ...' },
    { name: 'body', label: 'Details', type: 'textarea', max: 2000 },
    { name: 'options', label: 'Options', type: 'choices', placeholder: 'e.g. ...' },
  ],
  onSubmit: async (values) => { await api('POST', '/api/items', values); load(); },
}));
```

## report.js: counts and bars

```js
import { renderReport, countBy } from '/kit/report.js';
renderReport(el, rows, { label, unit: ['vote', 'votes'], total })   // rows: [{ label, count }]
countBy(items, 'category')                                          // [{ label, count }], most first
```

```js
renderReport(byKind, countBy(items, 'category'), { label: 'By category', unit: ['entry', 'entries'] });
```

## demo.js: staging demo data

```js
import { demoItems, showDemoLabel, DEMO_PEOPLE, rng } from '/kit/demo.js';
demoItems({ titles, bodies, categories, options, comments, seed, now, firstId })
```

Only for a staging preview opened with `?demo=1`. Give it this app's own
made-up lines (a title, or `{ title, body, category, options }`); it varies
authors (12 made-up people, negative ids), times, vote shapes (a few, a
lead, close, none, a tie) and threads, the same rows for the same seed. A
row: `{ id, title, body, category, author, authorId, createdAt, options,
votes: [{ userId, optionId }], comments }`. When a response says
`demo: true`, call `showDemoLabel(main)`: "Staging demo" once, not on every
row. kit/server.js uses it; elsewhere `await import('./public/kit/demo.js')`.

## kit/server.js: the API behind these pieces (optional)

Items with votes and comments on Postgres. In `server.js`, after the
sign-in middleware, before `express.static`:

```js
const items = require('./kit/server').resource(app, pool, {
  name: 'items',                 // tables items, items_votes, items_comments; routes /api/items
  options: ['Yes', 'No'],        // when an item gives none of its own
  categories: null,              // or a list the category must be one of
  demo: { titles: [/* 10 to 16 made-up entries */], bodies: [], comments: [], categories: [] },
});
// in start(), before app.listen:
await items.migrate();
```

Its JSON (guests read; writes need an account):

- `GET /api/items` gives `{ items: [Item], demo }`, newest first.
- `GET /api/items/:id` gives `{ item: Item, comments: [Comment], demo }`.
- `POST /api/items` with `{ title, body?, category?, options?: [text] }` gives `201 { item }`.
- `POST /api/items/:id/vote` with `{ option: id }` or `{ option: null }` (take it back) gives `{ item }`.
- `POST /api/items/:id/comments` with `{ body }` gives `201 { comment: Comment }`.
- `DELETE /api/items/:id` (its author only) gives `{ ok: true }`.
- `Item`: `{ id, title, body, category, author, byMe, createdAt, commentCount, votes: { options: [{ id, label, count }], mine } }`.
- `Comment`: `{ id, author, body, createdAt, byMe }`. Errors: `{ error }` in plain words.

On staging with `?demo=1` it writes the demo rows once (ids from 900001,
made-up people) and the viewer's own votes on two, once, and answers
`demo: true`. Add your own routes beside it rather than editing it.
