'use strict';

/* RSS Reader — the Unread list, the post preview and the Feeds view.
 * Hash routing: '' = Unread, #feeds = Feeds, #post/<id> = preview.
 * Every text node is built with textContent; the summary the feed sends is
 * never interpreted as HTML.
 */

(function () {
  const $ = (id) => document.getElementById(id);

  // The iframe carries the platform token as ?token=; forward it on every
  // API call as a header, and pass ?demo=1 on when the page URL has it.
  const params = new URLSearchParams(location.search);
  const TOKEN = params.get('token') || '';
  const DEMO = params.get('demo') === '1';
  if (TOKEN) {
    params.delete('token');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }

  function api(path, opts) {
    opts = opts || {};
    const sep = path.indexOf('?') === -1 ? '?' : '&';
    return fetch('/api/' + path + (DEMO ? sep + 'demo=1' : ''), Object.assign({}, opts, {
      headers: Object.assign({ 'x-usernode-token': TOKEN }, opts.headers || {}),
    }));
  }

  const state = {
    posts: [],        // unread posts, as the server has them
    read: new Map(),  // posts read during this visit: kept in place, faded
    staging: false,
    loaded: false,
    refreshNote: false,
  };

  /* ── Times ────────────────────────────────────────────────────────────
   * "12 min ago", "1 hr ago", "Yesterday, 18:40", "Mon, 16:02", "12 Mar". */

  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  function relTime(iso, now) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diff = now - d.getTime();
    const today = new Date(now);
    const yesterday = new Date(now - 24 * 60 * 60e3);
    if (sameDay(d, today) && diff < 60 * 60e3) return Math.max(1, Math.round(diff / 60e3)) + ' min ago';
    if (sameDay(d, today)) return Math.round(diff / (60 * 60e3)) + ' hr ago';
    if (sameDay(d, yesterday)) return 'Yesterday, ' + hhmm(d);
    if (diff < 7 * 24 * 60 * 60e3) return WEEKDAYS[d.getDay()] + ', ' + hhmm(d);
    return d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  // The preview shows the fuller form: "Today, 09:30" up, then the day.
  function fullTime(iso, now) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    if (sameDay(d, new Date(now))) return 'Today, ' + hhmm(d);
    if (sameDay(d, new Date(now - 24 * 60 * 60e3))) return 'Yesterday, ' + hhmm(d);
    if (now - d.getTime() < 7 * 24 * 60 * 60e3) return WEEKDAYS[d.getDay()] + ', ' + hhmm(d);
    return d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  /* ── Views ── */

  const VIEWS = ['view-list', 'view-preview', 'view-feeds'];
  function showView(id) {
    for (const v of VIEWS) $(v).hidden = v !== id;
    window.scrollTo(0, 0);
  }

  function skel(parent, w, h) {
    const s = document.createElement('span');
    s.className = 'skeleton ' + w + ' ' + h;
    s.style.display = 'inline-block';
    parent.appendChild(s);
    return s;
  }

  function showState(name) {
    if (name === 'ready' && state.loaded && totalFeedsCount === 0) name = 'empty';
    const empty = name === 'empty';
    const caughtUp = name === 'ready' && state.loaded && totalFeedsCount > 0 && state.posts.length === 0;
    $('list-empty').hidden = name !== 'empty';
    $('list-error').hidden = name !== 'error';
    $('caught-up').hidden = !caughtUp;
    let end = "You're all caught up";
    if (state.failedFeeds > 0) {
      end += ' · ' + state.failedFeeds + (state.failedFeeds === 1 ? ' feed couldn' : ' feeds couldn') + 't be checked';
    }
    $('caught-up').textContent = end;
    $('newest-label').hidden = name === 'empty' || name === 'error';
    // On the empty screen the top bar's add button steps aside for the
    // empty state's own button (unless the sheet is open above it).
    $('add-button').hidden = empty && $('add-sheet').hidden;
    $('add-button-empty').hidden = empty && !$('add-sheet').hidden;
    $('refresh-note').hidden = !state.refreshNote || name !== 'ready';
    const list = $('post-list');
    if (name === 'loading') {
      list.textContent = '';
      for (let i = 0; i < 5; i++) {
        const li = $('row-template').cloneNode(true);
        li.hidden = false;
        li.removeAttribute('id');
        const a = li.firstElementChild;
        a.removeAttribute('href');
        a.style.setProperty('--c', 'var(--line)');
        a.textContent = '';
        const meta = document.createElement('div');
        meta.className = 'meta';
        skel(meta, 'w-20', 'h-3.5');
        const right = document.createElement('span');
        skel(right, 'w-12', 'h-3.5');
        meta.appendChild(right);
        const t = document.createElement('p');
        t.className = 't';
        skel(t, 'w-3/4', 'h-4');
        const ex = document.createElement('p');
        ex.className = 'ex';
        skel(ex, 'w-full', 'h-3.5');
        a.append(meta, t, ex);
        list.appendChild(li);
      }
    } else if (name === 'empty' || name === 'error') {
      list.textContent = '';
    }
    $('count-line').textContent =
      name === 'loading' || name === 'error' ? '' : countLine();
  }

  function countLine() {
    const n = state.posts.length;
    if (n === 0) return '';
    const f = feedsWithUnread();
    let text = n + ' new from ' + f + (f === 1 ? ' feed' : ' feeds');
    if (state.failedFeeds > 0) {
      text += ' · ' + state.failedFeeds + (state.failedFeeds === 1 ? ' feed couldn' : ' feeds couldn') + 't be checked';
    }
    return (DEMO && state.staging ? 'Staging demo: ' : '') + text;
  }

  // The server counts every feed the viewer has; the unread ones are what
  // the heading line names.
  let totalFeedsCount = 0;
  function totalFeeds() { return totalFeedsCount; }
  function feedsWithUnread() {
    const seen = new Set();
    for (const p of state.posts) seen.add(p.feed_title);
    return seen.size;
  }

  function renderList() {
    const list = $('post-list');
    const scrollY = window.scrollY;
    list.textContent = '';
    const all = state.posts.concat(Array.from(state.read.values()))
      .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    const now = Date.now();
    for (const p of all) {
      const li = $('row-template').cloneNode(true);
      li.hidden = false;
      li.removeAttribute('id');
      const a = li.firstElementChild;
      a.style.setProperty('--c', 'var(--feed-' + p.hue + ')');
      a.href = '#post/' + p.id;
      if (state.read.has(p.id)) a.classList.add('read');
      a.querySelector('.meta b').textContent = p.feed_title;
      a.querySelector('.meta span').textContent = relTime(p.published_at, now);
      a.querySelector('.t').textContent = p.title;
      a.querySelector('.ex').textContent = p.summary || '';
      list.appendChild(li);
    }
    showState('ready');
    window.scrollTo(0, scrollY);
  }

  /* ── Loading ── */

  async function load() {
    showState('loading');
    try {
      const data = await (await api('posts')).json();
      applyPosts(data);
      state.loaded = true;
      renderList();
    } catch (err) {
      showState('error');
      return;
    }
    // The stored posts are on screen; now check the feeds for new ones.
    try {
      await api('refresh', { method: 'POST' });
      const data = await (await api('posts')).json();
      state.refreshNote = false;
      applyPosts(data);
      renderList();
    } catch (err) {
      // The stored list stays on screen with a quiet note.
      state.refreshNote = true;
      showState('ready');
    }
  }

  function applyPosts(data) {
    state.posts = data.posts || [];
    state.staging = !!data.staging;
    totalFeedsCount = data.feedCount || 0;
    state.failedFeeds = data.failedFeeds || 0;
  }

  /* ── Preview ── */

  let returnHash = '';
  async function openPreview(id) {
    showView('view-preview');
    let p = state.posts.find((x) => x.id === id) || state.read.get(id);
    if (!p) {
      // A deep link straight to a post: fetch the list first.
      try {
        applyPosts(await (await api('posts')).json());
        state.loaded = true;
        p = state.posts.find((x) => x.id === id);
      } catch (err) { /* the note stays empty below */ }
    }
    if (!p) { location.hash = returnHash || ''; return; }
    const art = $('preview-art');
    art.style.setProperty('--c', 'var(--feed-' + p.hue + ')');
    $('preview-source').textContent = p.feed_title;
    $('preview-title').textContent = p.title;
    $('preview-when').textContent = fullTime(p.published_at, Date.now());
    const body = $('preview-body');
    body.textContent = '';
    for (const para of splitParagraphs(p.summary || '')) {
      const el = document.createElement('p');
      el.textContent = para;
      body.appendChild(el);
    }
    const host = p.link ? hostOf(p.link) : '';
    $('preview-note').textContent = host
      ? 'This is the summary the feed sends. The full article is on ' + host + '.'
      : 'This is the summary the feed sends.';
    const link = $('preview-link');
    if (p.link) {
      link.href = p.link;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
    // Tapping to preview counts as read. If this fails, the post stays
    // unread and the preview is open all the same.
    try {
      await api('posts/' + p.id + '/read', { method: 'POST' });
      state.posts = state.posts.filter((x) => x.id !== p.id);
      state.read.set(p.id, p);
      const row = document.querySelector('#post-list a[href="#post/' + p.id + '"]');
      if (row) row.classList.add('read');
      $('count-line').textContent = countLine();
    } catch (err) { /* stays unread */ }
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  function splitParagraphs(text) {
    const parts = String(text).split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts : [String(text)];
  }

  /* ── Feeds ── */

  async function renderFeeds() {
    const ul = $('feeds-list');
    ul.textContent = '';
    $('feeds-end').hidden = true;
    $('feeds-count').textContent = '';
    for (let i = 0; i < 3; i++) {
      const li = document.createElement('li');
      li.className = 'feed-row';
      const left = document.createElement('div');
      skel(left, 'w-28', 'h-4');
      const btn = document.createElement('span');
      skel(btn, 'w-16', 'h-8');
      li.append(left, btn);
      ul.appendChild(li);
    }
    let data;
    try {
      data = await (await api('feeds')).json();
    } catch (err) {
      ul.textContent = '';
      $('feeds-end').textContent = "Your feeds couldn't be loaded. Your posts are still here.";
      $('feeds-end').hidden = false;
      return;
    }
    const feeds = data.feeds || [];
    ul.textContent = '';
    $('feeds-count').textContent = feeds.length
      ? feeds.length + (feeds.length === 1 ? ' feed' : ' feeds') : '';
    if (!feeds.length) {
      $('feeds-end').textContent = 'No feeds yet';
      $('feeds-end').hidden = false;
      return;
    }
    for (const f of feeds) ul.appendChild(feedRow(f));
  }

  function feedRow(f) {
    const li = document.createElement('li');
    li.className = 'feed-row';
    li.style.setProperty('--c', 'var(--feed-' + f.hue + ')');
    const left = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'fr-name';
    name.textContent = f.title;
    const site = document.createElement('p');
    site.className = 'fr-site';
    site.textContent = f.site_url ? hostOf(f.site_url) : hostOf(f.url);
    const unread = document.createElement('p');
    unread.className = 'fr-unread';
    unread.textContent = f.unread + (f.unread === 1 ? ' unread post' : ' unread posts');
    left.append(name, site, unread);
    if (f.last_error) {
      const err = document.createElement('p');
      err.className = 'fr-error';
      err.textContent = "Couldn't be checked last time."
      left.appendChild(err);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn-secondary fr-remove';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeFeed(f, remove));
    li.append(left, remove);
    return li;
  }

  async function removeFeed(f, button) {
    if (!window.confirm('Remove ' + f.title + ' and its posts?')) return;
    button.disabled = true;
    try {
      await api('feeds/' + f.id, { method: 'DELETE' });
      state.read.clear();
      await renderFeeds();
      await refreshPostsQuietly();
    } catch (err) {
      button.disabled = false;
      $('feeds-end').textContent = "The feed couldn't be removed. Try again.";
      $('feeds-end').hidden = false;
    }
  }

  async function refreshPostsQuietly() {
    try {
      applyPosts(await (await api('posts')).json());
      renderList();
    } catch (err) { /* the list stays as it is */ }
  }

  /* ── Add feed sheet ── */

  const ERROR_COPY = {
    web_page: "That's a web page, not a feed. Paste the feed's own address.",
    duplicate: 'You already have this feed.',
    unreachable: "The feed couldn't be reached. Check the address and try again.",
    blocked_address: "That address isn't allowed.",
    not_a_feed: "That address doesn't look like a feed.",
    account_required: 'Make an account to add a feed.',
  };

  function openSheet() {
    $('add-sheet').hidden = false;
    $('sheet-backdrop').hidden = false;
    $('sheet-error').hidden = true;
    $('feed-url').value = '';
    // The empty state's own button hides while the sheet is open.
    $('add-button-empty').hidden = !$('list-empty').hidden;
    $('add-button').hidden = true;
    $('feed-url').focus();
  }

  function closeSheet() {
    $('add-sheet').hidden = true;
    $('sheet-backdrop').hidden = true;
    if (!$('view-list').hidden) showState(state.loaded ? 'ready' : 'loading');
  }

  function showSheetError(text) {
    const el = $('sheet-error');
    el.textContent = text;
    el.hidden = false;
  }

  async function submitFeed() {
    const input = $('feed-url');
    const url = input.value.trim();
    if (!url) {
      showSheetError("Paste the feed's address first.");
      return;
    }
    $('sheet-error').hidden = true;
    $('sheet-add').disabled = true;
    try {
      const res = await api('feeds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // What was typed stays, so it can be fixed.
        showSheetError(ERROR_COPY[data.error] || "The feed couldn't be added. Check the address and try again.");
        return;
      }
      input.value = '';
      closeSheet();
      await refreshPostsQuietly();
    } catch (err) {
      showSheetError("The feed couldn't be added. Check the address and try again.");
    } finally {
      $('sheet-add').disabled = false;
    }
  }

  /* ── Routing ── */

  function route() {
    const h = location.hash;
    const m = h.match(/^#post\/(\d+)$/);
    if (h !== '#feeds' && !m) returnHash = h;
    if (m) {
      openPreview(Number(m[1]));
    } else if (h === '#feeds') {
      showView('view-feeds');
      renderFeeds();
    } else {
      showView('view-list');
    }
  }

  $('feeds-button').addEventListener('click', () => { location.hash = '#feeds'; });
  $('feeds-back').addEventListener('click', () => { location.hash = ''; });
  $('preview-back').addEventListener('click', () => { location.hash = returnHash || ''; });
  $('add-button').addEventListener('click', openSheet);
  $('add-button-empty').addEventListener('click', openSheet);
  $('add-button-feeds').addEventListener('click', openSheet);
  $('sheet-cancel').addEventListener('click', closeSheet);
  $('sheet-backdrop').addEventListener('click', closeSheet);
  $('sheet-add').addEventListener('click', submitFeed);
  $('feed-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitFeed(); });
  $('retry-button').addEventListener('click', load);

  window.addEventListener('hashchange', route);
  route();
  load();
})();