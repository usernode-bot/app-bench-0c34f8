'use strict';

/* RSS Reader page logic. Vanilla JS: renders with textContent only, so no
 * feed HTML ever reaches the DOM. Class names are written as whole literals
 * (s1–s8, is-read, is-open) so the Tailwind compiler sees them. */
(function () {
  const params = new URLSearchParams(location.search);
  const TOKEN = params.get('token');
  const DEMO = params.get('demo') === '1';
  const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

  const els = {
    summary: document.getElementById('summary'),
    refreshBtn: document.getElementById('refresh-btn'),
    addForm: document.getElementById('add-form'),
    urlInput: document.getElementById('feed-url'),
    addBtn: document.getElementById('add-btn'),
    addError: document.getElementById('add-error'),
    chips: document.getElementById('chips'),
    posts: document.getElementById('posts'),
    end: document.getElementById('end'),
    markAllBtn: document.getElementById('mark-all-btn'),
    loading: document.getElementById('loading'),
    stateEmpty: document.getElementById('state-empty'),
    stateError: document.getElementById('state-error'),
    retryBtn: document.getElementById('retry-btn'),
  };

  const state = {
    guest: false,
    feeds: [],
    posts: [],
    truncated: false,
    openId: null,
    loading: true,
    loadError: false,
    checking: 0,
    refreshing: false,
    cleared: null, // posts hidden by Mark all as read, waiting on Undo
  };

  /* ── helpers ──────────────────────────────────────────────────────────── */

  function native() {
    return window.unNative || null;
  }

  function nowMs() {
    try {
      if (window.usernode && typeof window.usernode.now === 'function') {
        const t = new Date(window.usernode.now()).getTime();
        if (Number.isFinite(t)) return t;
      }
    } catch {}
    return Date.now();
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers);
    if (opts.body) headers['content-type'] = 'application/json';
    if (TOKEN) headers['x-usernode-token'] = TOKEN;
    try {
      if (window.usernode && typeof window.usernode.now === 'function') {
        headers['x-usernode-now'] = window.usernode.now();
      }
    } catch {}
    let url = path;
    if (DEMO) url += (url.includes('?') ? '&' : '?') + 'demo=1';
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    let data = null;
    try {
      data = await res.json();
    } catch {}
    if (!res.ok) {
      const err = new Error((data && data.error) || 'HTTP ' + res.status);
      err.code = data && data.error;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(message, opts) {
    const un = native();
    if (un && typeof un.toast === 'function') {
      un.toast(message, opts);
      return;
    }
    // Fallback outside the platform frame: a quiet transient line.
    let host = document.getElementById('fallback-toast');
    if (!host) {
      host = document.createElement('div');
      host.id = 'fallback-toast';
      host.className = 'pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4';
      document.body.appendChild(host);
    }
    host.replaceChildren();
    const pill = document.createElement('div');
    pill.className = 'rounded-full bg-fg px-4 py-2 text-small text-ground';
    pill.textContent = message;
    host.appendChild(pill);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => pill.remove(), 2500);
  }

  function icon(paths, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.setAttribute('class', cls);
    for (const d of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }
  const WARNING_PATHS = [
    'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
    'M12 9v4',
    'M12 17h.01',
  ];
  const OPEN_IN_NEW_PATHS = ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'];

  /* ── time words ───────────────────────────────────────────────────────── */

  const DAY_MS = 86400000;
  function startOfDay(ms) {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /* "12 min", "3 h", "Yesterday", "Mon", then "2 Oct" (with the year when
     it is not this year), in the viewer's own time zone. */
  function relTime(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const now = nowMs();
    const min = Math.floor((now - t) / 60000);
    if (min < 1) return 'Just now';
    if (min < 60) return min + ' min';
    if (min < 1440) return Math.floor(min / 60) + ' h';
    const d = new Date(t);
    const n = new Date(now);
    if (startOfDay(t) === startOfDay(now) - DAY_MS) return 'Yesterday';
    const days = Math.round((startOfDay(now) - startOfDay(t)) / DAY_MS);
    if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
    const year = d.getFullYear() === n.getFullYear() ? '' : ' ' + d.getFullYear();
    return d.getDate() + ' ' + d.toLocaleDateString(undefined, { month: 'short' }) + year;
  }

  /* The opened post's exact moment: "today at 13:22", "yesterday at 08:10",
     or "Mon 5 Oct at 10:00". */
  function bylineWhen(iso) {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const now = nowMs();
    const d = new Date(t);
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    if (startOfDay(t) === startOfDay(now)) return 'today at ' + time;
    if (startOfDay(t) === startOfDay(now) - DAY_MS) return 'yesterday at ' + time;
    const n = new Date(now);
    const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
    const year = d.getFullYear() === n.getFullYear() ? '' : ' ' + d.getFullYear();
    return weekday + ' ' + d.getDate() + ' ' + d.toLocaleDateString(undefined, { month: 'short' }) + year + ' at ' + time;
  }

  /* ── lookups ──────────────────────────────────────────────────────────── */

  function feedOf(post) {
    return state.feeds.find((f) => f.id === post.feedId) || null;
  }

  function dotClass(feed) {
    const index = feed && feed.colorIndex >= 1 && feed.colorIndex <= 8 ? feed.colorIndex : 1;
    return 's' + index;
  }

  function adjustFeedCount(feedId, delta) {
    const feed = state.feeds.find((f) => f.id === feedId);
    if (feed) feed.unreadCount = Math.max(0, (feed.unreadCount || 0) + delta);
  }

  function sortPosts(posts) {
    return posts.slice().sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }

  /* ── rendering ────────────────────────────────────────────────────────── */

  function render() {
    renderChips();
    renderSummary();
    renderPosts();
    renderStates();
  }

  function renderSummary() {
    if (state.loading) {
      els.summary.textContent = ' ';
      return;
    }
    if (state.checking > 0) {
      els.summary.textContent = 'Checking ' + state.checking + (state.checking === 1 ? ' feed' : ' feeds') + '…';
      return;
    }
    if (!state.feeds.length) {
      els.summary.textContent = ' ';
      return;
    }
    const total = state.feeds.reduce((n, f) => n + (f.unreadCount || 0), 0);
    let line = total + ' unread from ' + state.feeds.length + (state.feeds.length === 1 ? ' feed' : ' feeds');
    const failed = state.feeds.filter((f) => f.lastError).length;
    if (failed) {
      line += '. ' + failed + (failed === 1 ? " feed couldn't be checked" : " feeds couldn't be checked");
    }
    if (state.truncated) line += '. Showing the newest 500';
    els.summary.textContent = line;
  }

  function renderChips() {
    els.chips.replaceChildren();
    for (const feed of state.feeds) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      const dot = document.createElement('span');
      dot.className = 'feed-dot ' + dotClass(feed);
      dot.setAttribute('aria-hidden', 'true');
      const count = document.createElement('span');
      count.className = 'chip-count';
      count.textContent = String(feed.unreadCount || 0);
      chip.append(dot, document.createTextNode(feed.title), count);
      if (feed.lastError) {
        const warn = icon(WARNING_PATHS, 'chip-warn h-4 w-4');
        warn.setAttribute('role', 'img');
        warn.setAttribute('aria-label', 'This feed could not be checked');
        chip.appendChild(warn);
      }
      chip.addEventListener('click', () => openFeedMenu(chip, feed));
      els.chips.appendChild(chip);
    }
    els.chips.hidden = state.feeds.length === 0;
  }

  function rowEl(postId) {
    return els.posts.querySelector('li[data-post-id="' + postId + '"]');
  }

  function renderPosts() {
    els.posts.replaceChildren();
    for (const post of state.posts) els.posts.appendChild(buildRow(post));
    els.posts.hidden = state.posts.length === 0;
    els.end.hidden = state.posts.length === 0;
  }

  function buildRow(post) {
    const feed = feedOf(post);
    const isOpen = post.id === state.openId;

    const li = document.createElement('li');
    li.className = 'list-row post-row' + (post.readAt ? ' is-read' : '') + (isOpen ? ' is-open' : '');
    li.dataset.postId = String(post.id);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'post';
    btn.setAttribute('aria-expanded', String(isOpen));
    btn.setAttribute('aria-controls', 'preview-' + post.id);

    const dot = document.createElement('span');
    dot.className = 'feed-dot ' + dotClass(feed);
    dot.setAttribute('aria-hidden', 'true');

    const body = document.createElement('span');
    body.className = 'pbody';
    const title = document.createElement('span');
    title.className = 'post-title';
    title.textContent = post.title;
    const meta = document.createElement('span');
    meta.className = 'post-meta';
    const name = document.createElement('span');
    name.className = 'post-feedname';
    name.textContent = feed ? feed.title : '';
    const time = document.createElement('span');
    time.className = 'post-time';
    time.textContent = relTime(post.publishedAt);
    meta.append(name, time);
    body.append(title, meta);
    btn.append(dot, body);

    const preview = document.createElement('div');
    preview.className = 'post-preview';
    preview.id = 'preview-' + post.id;
    const inner = document.createElement('div');
    inner.className = 'post-preview-inner';
    const pvBody = document.createElement('div');
    pvBody.className = 'post-preview-body';
    fillPreviewBody(pvBody, post);
    inner.appendChild(pvBody);
    preview.appendChild(inner);

    btn.addEventListener('click', () => togglePost(post.id));
    li.append(btn, preview);
    return li;
  }

  function fillPreviewBody(pvBody, post) {
    pvBody.replaceChildren();

    const byline = document.createElement('p');
    byline.className = 'post-byline';
    const when = bylineWhen(post.publishedAt);
    byline.textContent = post.author ? 'By ' + post.author + ', ' + when : when;

    const text = document.createElement('div');
    text.className = 'post-text';
    const summary = (post.summary || '').trim();
    if (!summary) {
      const none = document.createElement('p');
      none.textContent = 'This feed gives no preview for this post.';
      text.appendChild(none);
    } else {
      for (const para of summary.split(/\n{2,}/)) {
        if (!para.trim()) continue;
        const p = document.createElement('p');
        p.textContent = para.trim();
        text.appendChild(p);
      }
      if (post.summaryTruncated) {
        const note = document.createElement('p');
        note.className = 'post-note';
        note.textContent = 'Preview shortened. Open the full post to read the rest.';
        text.appendChild(note);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'post-actions';
    // Only web links are offered; a post without one has no button.
    if (post.link) {
      const open = document.createElement('a');
      open.className = 'btn-primary';
      open.href = post.link;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.append(icon(OPEN_IN_NEW_PATHS, 'flex-none'), document.createTextNode('Open full post'));
      actions.appendChild(open);
    }
    if (post.readAt) {
      const markUnread = document.createElement('button');
      markUnread.type = 'button';
      markUnread.className = 'btn-secondary';
      markUnread.textContent = 'Mark unread';
      markUnread.addEventListener('click', () => setRead(post, false));
      actions.appendChild(markUnread);
    }

    pvBody.append(byline, text, actions);
  }

  function togglePost(postId) {
    const post = state.posts.find((p) => p.id === postId);
    if (!post) return;
    const closing = state.openId === postId;
    const previous = state.openId;
    state.openId = closing ? null : postId;
    if (previous !== null && previous !== postId) refreshOpenState(previous);
    refreshOpenState(postId);
    if (!closing) {
      const btn = rowEl(postId) && rowEl(postId).querySelector('.post');
      if (btn) {
        const top = btn.getBoundingClientRect().top;
        if (top < 0) {
          btn.scrollIntoView({ block: 'start', behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth' });
        }
      }
      if (!post.readAt) setRead(post, true);
    }
  }

  function refreshOpenState(postId) {
    const li = rowEl(postId);
    if (!li) return;
    const isOpen = state.openId === postId;
    li.classList.toggle('is-open', isOpen);
    const btn = li.querySelector('.post');
    if (btn) btn.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) {
      const pvBody = li.querySelector('.post-preview-body');
      const post = state.posts.find((p) => p.id === postId);
      if (pvBody && post) fillPreviewBody(pvBody, post);
    }
  }

  function applyReadState(post) {
    const li = rowEl(post.id);
    if (!li) return;
    li.classList.toggle('is-read', !!post.readAt);
    const pvBody = li.querySelector('.post-preview-body');
    if (pvBody && state.openId === post.id) fillPreviewBody(pvBody, post);
  }

  async function setRead(post, read) {
    if (!!post.readAt === read) return;
    const previous = post.readAt || null;
    post.readAt = read ? new Date(nowMs()).toISOString() : null;
    applyReadState(post);
    adjustFeedCount(post.feedId, read ? -1 : 1);
    renderSummary();
    renderChips();
    try {
      await api('/api/posts/read', { method: 'POST', body: JSON.stringify({ ids: [post.id], read }) });
    } catch (err) {
      post.readAt = previous;
      applyReadState(post);
      adjustFeedCount(post.feedId, read ? 1 : -1);
      renderSummary();
      renderChips();
      toast("Couldn't mark that post read");
    }
  }

  /* ── states ───────────────────────────────────────────────────────────── */

  function renderStates() {
    els.loading.hidden = !state.loading;
    els.stateError.hidden = !state.loadError;
    const noFeeds = !state.loading && !state.loadError && state.feeds.length === 0;
    const caughtUp = !state.loading && !state.loadError && state.feeds.length > 0 && state.posts.length === 0;
    els.stateEmpty.hidden = !noFeeds && !caughtUp;
    if (els.stateEmpty.hidden) return;
    els.stateEmpty.replaceChildren();

    const title = document.createElement('p');
    title.className = 'text-body font-medium';
    const sub = document.createElement('p');
    sub.className = 'text-small text-muted';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn-secondary mt-2';

    if (noFeeds) {
      title.textContent = 'No feeds yet';
      if (state.guest) {
        sub.textContent = 'Make a Homeroom account to follow your own feeds.';
        els.stateEmpty.append(title, sub);
        return;
      }
      sub.textContent = 'Paste a site or feed address above to start reading, or try the sample feed to see how it works.';
      action.textContent = 'Try the sample feed';
      action.addEventListener('click', addSample);
      els.stateEmpty.append(title, sub, action);
      return;
    }
    title.textContent = "You're all caught up";
    sub.textContent =
      'New posts from your ' + state.feeds.length + (state.feeds.length === 1 ? ' feed' : ' feeds') + ' show up here.';
    action.textContent = 'Check for new posts';
    action.addEventListener('click', () => refresh());
    els.stateEmpty.append(title, sub, action);
  }

  /* ── data loads ───────────────────────────────────────────────────────── */

  function applyData(data, merge) {
    state.guest = !!data.guest;
    state.feeds = data.feeds || [];
    state.truncated = !!data.truncated;
    const incoming = data.posts || [];
    if (!merge) {
      state.posts = incoming;
    } else {
      // Merge a refresh in: new rows take their date position, rows already
      // on screen (read, open) keep their state.
      const byId = new Map(state.posts.map((p) => [p.id, p]));
      const merged = incoming.map((p) => byId.get(p.id) || p);
      const present = new Set(merged.map((p) => p.id));
      const feedIds = new Set(state.feeds.map((f) => f.id));
      for (const p of state.posts) {
        if (!present.has(p.id) && feedIds.has(p.feedId)) {
          merged.push(p);
          present.add(p.id);
        }
      }
      state.posts = sortPosts(merged);
    }
    if (state.openId !== null && !state.posts.some((p) => p.id === state.openId)) {
      state.openId = null;
    }
  }

  async function boot() {
    state.loading = true;
    state.loadError = false;
    renderStates();
    try {
      const data = await api('/api/posts');
      applyData(data, false);
      state.loading = false;
      render();
      autoRefresh();
    } catch (err) {
      state.loading = false;
      state.loadError = true;
      render();
    }
  }

  /* New posts arrive when the app opens: any feed not checked in the last
     ten minutes is checked now. */
  async function autoRefresh() {
    const rssFeeds = state.feeds.filter((f) => f.kind === 'rss');
    if (!rssFeeds.length || state.refreshing) return;
    state.checking = rssFeeds.length;
    renderSummary();
    try {
      const result = await api('/api/refresh', { method: 'POST', body: JSON.stringify({ force: false }) });
      const data = await api('/api/posts');
      applyData(data, true);
      if (result.newPosts > 0) toast(result.newPosts + (result.newPosts === 1 ? ' new post' : ' new posts'));
    } catch (err) {
      // Leave the list as it is; only the first load gets the error state.
    }
    state.checking = 0;
    render();
  }

  /* Refresh button and pull-to-refresh: always check every feed, then a
     full reload of the list, which drops rows read in this session. */
  async function refresh() {
    if (state.refreshing) return;
    state.refreshing = true;
    els.refreshBtn.disabled = true;
    const rssFeeds = state.feeds.filter((f) => f.kind === 'rss');
    if (rssFeeds.length) {
      state.checking = rssFeeds.length;
      renderSummary();
    }
    try {
      const result = await api('/api/refresh', { method: 'POST', body: JSON.stringify({ force: true }) });
      const data = await api('/api/posts');
      applyData(data, false);
      if (result.newPosts > 0) toast(result.newPosts + (result.newPosts === 1 ? ' new post' : ' new posts'));
    } catch (err) {
      toast("Couldn't check for new posts");
    }
    state.checking = 0;
    state.refreshing = false;
    els.refreshBtn.disabled = false;
    render();
  }

  /* ── actions ──────────────────────────────────────────────────────────── */

  const ADD_ERROR_COPY = {
    invalid_url: "That doesn't look like a web address.",
    no_feed_found: "No feed found at that address. Try the site's home page or its feed link.",
    unreachable: "That site didn't answer. Check the address and try again.",
    already_following: 'You already follow this feed.',
    too_many_feeds: 'You can follow up to 100 feeds.',
  };

  function showAddError(message) {
    els.addError.textContent = message;
    els.addError.hidden = false;
  }

  async function addFeed(event) {
    event.preventDefault();
    const url = els.urlInput.value.trim();
    if (!url) {
      showAddError("Type an address first, then tap Add feed.");
      return;
    }
    els.addBtn.disabled = true;
    els.addBtn.textContent = 'Adding…';
    els.addError.hidden = true;
    try {
      const result = await api('/api/feeds', { method: 'POST', body: JSON.stringify({ url }) });
      els.urlInput.value = '';
      const data = await api('/api/posts');
      applyData(data, true);
      render();
      const n = result.newPosts || 0;
      toast('Added ' + result.feed.title + ', ' + (n > 0 ? n + (n === 1 ? ' new post' : ' new posts') : 'no posts yet'));
    } catch (err) {
      showAddError(ADD_ERROR_COPY[err.code] || "Couldn't add that feed. Check the address and try again.");
    } finally {
      els.addBtn.disabled = false;
      els.addBtn.textContent = 'Add feed';
    }
  }

  async function addSample(event) {
    const btn = event && event.currentTarget;
    if (btn) btn.disabled = true;
    try {
      await api('/api/feeds/sample', { method: 'POST', body: JSON.stringify({}) });
      const data = await api('/api/posts');
      applyData(data, false);
      render();
    } catch (err) {
      toast("Couldn't add the sample feed");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function removeFeed(feed) {
    const un = native();
    let confirmed;
    if (un && typeof un.alert === 'function') {
      const answer = await un.alert({
        title: 'Remove ' + feed.title + '?',
        message: 'Its posts leave your list.',
        buttons: [
          { label: 'Cancel', style: 'cancel' },
          { label: 'Remove', style: 'destructive' },
        ],
      });
      confirmed = !!(answer && answer.button && answer.button.label === 'Remove');
    } else {
      confirmed = window.confirm('Remove ' + feed.title + '? Its posts leave your list.');
    }
    if (!confirmed) return;
    try {
      await api('/api/feeds/' + feed.id, { method: 'DELETE' });
      state.feeds = state.feeds.filter((f) => f.id !== feed.id);
      state.posts = state.posts.filter((p) => p.feedId !== feed.id);
      if (state.openId !== null && !state.posts.some((p) => p.id === state.openId)) state.openId = null;
      render();
      toast('Removed ' + feed.title);
    } catch (err) {
      toast("Couldn't remove that feed");
    }
  }

  function copyFeedAddress(feed) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      toast("Couldn't copy the address");
      return;
    }
    navigator.clipboard
      .writeText(feed.url)
      .then(() => toast('Copied'))
      .catch(() => toast("Couldn't copy the address"));
  }

  async function openFeedMenu(chip, feed) {
    const un = native();
    if (un && typeof un.menu === 'function') {
      const title = feed.lastError
        ? feed.title + ". Couldn't be reached at the last check."
        : feed.title;
      const items = [{ label: 'Copy feed address' }];
      if (feed.siteUrl) items.push({ label: 'Open site' });
      items.push({ label: 'Remove feed', destructive: true });
      const chosen = await un.menu({ anchorEl: chip, title, items });
      if (!chosen) return;
      if (chosen.label === 'Copy feed address') copyFeedAddress(feed);
      else if (chosen.label === 'Open site') window.open(feed.siteUrl, '_blank', 'noopener');
      else if (chosen.label === 'Remove feed') removeFeed(feed);
      return;
    }
    // Fallback outside the platform frame: confirm and remove.
    removeFeed(feed);
  }

  async function markAllRead() {
    const unread = state.posts.filter((p) => !p.readAt);
    if (!unread.length) return;
    const ids = unread.map((p) => p.id);
    try {
      await api('/api/posts/read', { method: 'POST', body: JSON.stringify({ ids, read: true }) });
    } catch (err) {
      toast("Couldn't mark posts as read");
      return;
    }
    const nowIso = new Date(nowMs()).toISOString();
    // Keep the cleared rows for Undo; only the toast's close discards them.
    state.cleared = unread.map((p) => {
      const copy = Object.assign({}, p, { readAt: null });
      p.readAt = nowIso;
      adjustFeedCount(p.feedId, -1);
      return copy;
    });
    const clearedIds = new Set(unread.map((p) => p.id));
    state.posts = state.posts.filter((p) => !clearedIds.has(p.id));
    state.openId = null;
    render();
    const un = native();
    const message = 'Marked ' + ids.length + (ids.length === 1 ? ' post as read' : ' posts as read');
    if (un && typeof un.toast === 'function') {
      un.toast(message, {
        priority: true,
        duration: 6000,
        action: { label: 'Undo', handler: undoMarkAll },
        onClose: (reason) => {
          if (reason !== 'action') state.cleared = null;
        },
      });
    } else {
      state.cleared = null;
      toast(message);
    }
  }

  async function undoMarkAll() {
    const restored = state.cleared;
    if (!restored || !restored.length) return;
    state.cleared = null;
    try {
      await api('/api/posts/read', { method: 'POST', body: JSON.stringify({ ids: restored.map((p) => p.id), read: false }) });
    } catch (err) {
      toast("Couldn't undo that");
      return;
    }
    for (const p of restored) adjustFeedCount(p.feedId, 1);
    state.posts = sortPosts(state.posts.concat(restored));
    render();
  }

  /* ── wiring ───────────────────────────────────────────────────────────── */

  els.addForm.addEventListener('submit', addFeed);
  els.refreshBtn.addEventListener('click', () => refresh());
  els.markAllBtn.addEventListener('click', markAllRead);
  els.retryBtn.addEventListener('click', () => location.reload());

  const un = native();
  if (un && typeof un.attachPullToRefresh === 'function') {
    try {
      un.attachPullToRefresh(window, () => refresh());
    } catch {}
  }

  boot();
})();
