/* RSS Reader — the reader screen, the preview sheet, the Add feed and
 * Feeds sheets. Renders the spec's drawn markup from real data; feed text
 * reaches the page only through textContent, so nothing from a feed can
 * run here.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('token');
  var DEMO = params.get('demo') === '1';

  function $(id) { return document.getElementById(id); }
  var titleEl = $('unread-title'), appNameEl = $('app-name'),
      addBtn = $('add-feed-btn'), chipsEl = $('chips'),
      feedsChip = $('feeds-chip'), feedsCount = $('feeds-count'), refreshTime = $('refresh-time'),
      failedChip = $('failed-chip'), listLabel = $('list-label'), postList = $('post-list'),
      stateEl = $('state'), previewEl = $('preview');

  var state = {
    phase: 'loading', // loading | error | empty | caught-up | list
    posts: [],
    feedCount: 0,
    unread: 0,
    refreshedAt: null,
    failed: 0,
    demo: false,
    preview: null,
  };

  // ── API ────────────────────────────────────────────────────────────────
  function usernodeNow() {
    try {
      if (window.usernode && typeof window.usernode.now === 'function') {
        var d = window.usernode.now();
        if (d instanceof Date && !isNaN(d.getTime())) return d;
      }
    } catch (e) { /* fall through to the real time */ }
    return new Date();
  }

  function api(method, path, body) {
    var headers = {};
    if (TOKEN) headers['x-usernode-token'] = TOKEN;
    // A staging preview may be shown as of a chosen moment; pass it on.
    headers['x-usernode-now'] = usernodeNow().toISOString();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: method,
      headers: headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        data.__status = res.status;
        return data;
      });
    });
  }

  // ── Times, relative, from usernode.now() ───────────────────────────────
  function relTime(t) {
    if (!t) return '';
    var d = new Date(t);
    var mins = (usernodeNow().getTime() - d.getTime()) / 60000;
    if (mins < 1) return 'just now';
    if (mins < 60) return Math.round(mins) + ' min ago';
    if (mins < 24 * 60) return Math.round(mins / 60) + ' hr ago';
    if (mins < 48 * 60) return 'Yesterday';
    if (mins < 7 * 24 * 60) {
      return d.toLocaleDateString(undefined, { weekday: 'short' });
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function clockTime(t) {
    return new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  // ── Loading ────────────────────────────────────────────────────────────
  function load() {
    state.phase = 'loading';
    state.preview = null;
    render();
    var q = DEMO ? '?demo=1' : '';
    api('POST', '/api/refresh' + q)
      .catch(function () { return null; }) // a failed refresh still loads posts
      .then(function () { return api('GET', '/api/posts' + q); })
      .then(function (data) {
        if (data.__status !== 200) throw new Error('load failed');
        state.posts = data.posts || [];
        state.feedCount = data.feed_count || 0;
        state.unread = data.unread_count || 0;
        state.refreshedAt = data.last_refreshed_at;
        state.failed = data.failed_feeds || 0;
        state.demo = !!data.demo;
        state.phase = state.feedCount === 0 ? 'empty'
          : (state.unread === 0 ? 'caught-up' : 'list');
        render();
      })
      .catch(function () {
        state.phase = 'error';
        render();
      });
  }

  // ── Rendering ──────────────────────────────────────────────────────────
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  // A post row, in the spec's drawn markup: spine, meta with dot, title,
  // excerpt.
  function postRow(p) {
    var li = el('li', 'list-row' + (p.read_at ? ' read' : ''));
    li.style.setProperty('--c', 'var(--f' + p.feed_color + ')');
    li.dataset.id = p.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');

    li.appendChild(el('div', 'spine'));
    var body = el('div', 'body');
    var meta = el('div', 'meta');
    if (!p.read_at) meta.appendChild(el('i', 'dot'));
    meta.appendChild(document.createTextNode(
      p.feed_title + ', ' + relTime(p.published_at)));
    body.appendChild(meta);
    body.appendChild(el('p', 'pt', p.title));
    if (p.excerpt) body.appendChild(el('p', 'ex', p.excerpt));
    li.appendChild(body);
    return li;
  }

  // A loading row: its spine and three skeleton bars where the text goes.
  function skeletonRow(colorIndex) {
    var li = el('li', 'list-row');
    li.style.setProperty('--c', 'var(--f' + colorIndex + ')');
    li.appendChild(el('div', 'spine'));
    var body = el('div', 'body');
    var meta = el('div', 'meta');
    meta.appendChild(el('span', 'skeleton inline-block h-4 w-28'));
    body.appendChild(meta);
    body.appendChild(el('p', 'pt skeleton mt-1 inline-block h-5 w-full'));
    body.appendChild(el('p', 'ex skeleton mt-2 inline-block h-4 w-3/4'));
    li.appendChild(body);
    return li;
  }

  function setLabel() {
    listLabel.textContent = '';
    if (state.demo) {
      var span = el('span', null, 'Staging demo');
      span.setAttribute('data-usernode-demo-note', '');
      listLabel.appendChild(span);
      listLabel.appendChild(document.createTextNode(', newest first'));
    } else {
      listLabel.appendChild(document.createTextNode('Newest first'));
    }
  }

  function emptyState(heading, sentence, withAction) {
    var wrap = el('div', 'state-empty');
    wrap.appendChild(el('h2', 'text-heading font-display', heading));
    wrap.appendChild(el('p', 'text-small text-muted', sentence));
    if (withAction) {
      var btn = el('button', 'btn-primary mt-2', 'Add feed');
      btn.type = 'button';
      btn.addEventListener('click', openAddSheet);
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function errorState() {
    var wrap = el('div', 'state-error');
    wrap.appendChild(el('h2', 'text-heading font-display', 'Couldn’t load your posts.'));
    wrap.appendChild(el('p', 'text-small text-muted', 'Your feeds are saved. Try again in a moment.'));
    var btn = el('button', 'btn-primary mt-2', 'Retry');
    btn.type = 'button';
    btn.addEventListener('click', function () { load(); });
    wrap.appendChild(btn);
    return wrap;
  }

  function render() {
    var s = state;
    titleEl.textContent = '';
    appNameEl.hidden = false;
    postList.hidden = false;
    refreshTime.textContent = '';
    failedChip.hidden = true;
    stateEl.textContent = '';
    stateEl.hidden = true;
    postList.textContent = '';
    feedsChip.hidden = false;
    addBtn.hidden = false;
    chipsEl.style.display = '';

    if (s.phase === 'loading') {
      // The header with grey bars in place of the count, and four
      // skeleton rows.
      titleEl.appendChild(el('span', 'skeleton inline-block h-9 w-44 align-middle'));
      refreshTime.appendChild(el('span', 'skeleton inline-block h-5 w-32 align-middle'));
      feedsChip.hidden = true;
      addBtn.hidden = true;
      listLabel.hidden = true;
      for (var i = 0; i < 4; i++) postList.appendChild(skeletonRow((i % 5) + 1));
      return;
    }

    listLabel.hidden = false;
    setLabel();
    titleEl.textContent = s.unread + ' unread';

    if (s.phase === 'error') {
      // No data: the header is just the app's name, with no zero count and
      // no empty list drawing a rule under it.
      titleEl.textContent = 'RSS Reader';
      appNameEl.hidden = true;
      postList.hidden = true;
      chipsEl.style.display = 'none';
      listLabel.hidden = true;
      stateEl.appendChild(errorState());
      stateEl.hidden = false;
      return;
    }

    if (s.phase === 'empty') {
      // No feeds yet: the header's own add button is hidden, the filled
      // Add feed button lives in the empty state. Same header as the error
      // state: the app's name, no zero count, no rule under it.
      titleEl.textContent = 'RSS Reader';
      appNameEl.hidden = true;
      postList.hidden = true;
      chipsEl.style.display = 'none';
      addBtn.hidden = true;
      listLabel.hidden = true;
      stateEl.appendChild(emptyState('Add your first feed',
        'Paste the address of any RSS or Atom feed and its new posts show up here.',
        true));
      stateEl.hidden = false;
      return;
    }

    feedsCount.textContent = s.feedCount + ' feeds';
    if (s.refreshedAt) refreshTime.textContent = 'Refreshed ' + clockTime(s.refreshedAt);
    if (s.failed > 0) {
      failedChip.textContent = s.failed + (s.failed === 1
        ? ' feed couldn’t refresh' : ' feeds couldn’t refresh');
      failedChip.hidden = false;
    }

    if (s.phase === 'caught-up') {
      listLabel.hidden = true;
      stateEl.appendChild(emptyState('All caught up',
        'No unread posts in your ' + s.feedCount + ' feeds.', false));
      stateEl.hidden = false;
      return;
    }

    for (var j = 0; j < s.posts.length; j++) postList.appendChild(postRow(s.posts[j]));
  }

  // ── Preview (screen 2, live) ───────────────────────────────────────────
  function openPreview(p) {
    state.preview = p;
    $('preview-tick').style.background = 'rgb(var(--f' + p.feed_color + '))';
    $('preview-meta').textContent = p.feed_title + ', ' + relTime(p.published_at);
    $('preview-title').textContent = p.title;
    var by = $('preview-by');
    if (p.author) {
      by.textContent = 'By ' + p.author;
      by.hidden = false;
    } else {
      by.hidden = true;
    }
    var prose = $('preview-body');
    prose.textContent = '';
    var paragraphs = (p.body ? p.body.split('\n\n') : (p.excerpt ? [p.excerpt] : []));
    for (var i = 0; i < paragraphs.length; i++) {
      prose.appendChild(el('p', null, paragraphs[i]));
    }
    var openBtn = $('preview-open');
    var note = $('preview-note');
    note.textContent = '';
    if (p.link) {
      openBtn.disabled = false;
      try { note.textContent = 'Opens on ' + new URL(p.link).hostname; } catch (e) {}
    } else {
      openBtn.disabled = true;
    }
    previewEl.hidden = false;
    previewEl.setAttribute('data-open', '');
    prose.scrollTop = 0;
    markRead(p);
  }

  function closePreview() {
    previewEl.hidden = true;
    previewEl.removeAttribute('data-open');
    state.preview = null;
  }

  // Marked read as soon as the preview opens: the dot goes away, the title
  // dims, the unread count goes down. It stays in the list, dimmed, until
  // the next time the app opens.
  function markRead(p) {
    if (p.read_at) return;
    p.read_at = new Date().toISOString();
    api('POST', '/api/posts/' + p.id + '/read').catch(function () { });
    if (state.unread > 0) {
      state.unread -= 1;
      titleEl.textContent = state.unread + ' unread';
    }
    var li = postList.querySelector('li[data-id="' + p.id + '"]');
    if (li) {
      var fresh = postRow(p);
      li.replaceWith(fresh);
    }
  }

  $('preview-open').addEventListener('click', function () {
    var p = state.preview;
    if (!p || !p.link) return;
    window.open(p.link, '_blank', 'noopener');
  });
  $('preview-close').addEventListener('click', closePreview);
  previewEl.querySelector('[data-close-preview]').addEventListener('click', closePreview);

  // ── Feeds sheet ────────────────────────────────────────────────────────
  function feedRow(f) {
    var li = el('li', 'list-row');
    li.style.setProperty('--c', 'var(--f' + f.color + ')');
    li.appendChild(el('div', 'spine'));
    var body = el('div', 'body');
    body.appendChild(el('p', 'feed-name', f.title));
    body.appendChild(el('p', 'feed-url', f.url));
    if (f.last_error) body.appendChild(el('p', 'feed-err', f.last_error));
    li.appendChild(body);
    var remove = el('button', 'btn-secondary remove-btn', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', function () {
      remove.disabled = true;
      api('DELETE', '/api/feeds/' + f.id).then(function (data) {
        if (data.__status !== 200) throw new Error(data.error || 'remove failed');
        closePreview();
        load();
        openFeeds();
      }).catch(function () {
        remove.disabled = false;
      });
    });
    li.appendChild(remove);
    return li;
  }

  function renderFeeds(feeds) {
    var list = $('feeds-list');
    list.textContent = '';
    $('feeds-empty').hidden = feeds.length !== 0;
    for (var i = 0; i < feeds.length; i++) list.appendChild(feedRow(feeds[i]));
  }

  function openFeeds() {
    $('feeds-sheet').hidden = false;
    $('feeds-error').hidden = true;
    renderFeeds([]); // clear the previous list while it loads
    api('GET', '/api/feeds').then(function (data) {
      if (data.__status !== 200) throw new Error('feeds failed');
      renderFeeds(data.feeds || []);
    }).catch(function () {
      var err = $('feeds-error');
      err.textContent = 'Couldn’t load your feeds. Try again in a moment.';
      err.hidden = false;
    });
  }

  feedsChip.addEventListener('click', openFeeds);
  failedChip.addEventListener('click', openFeeds);
  $('feeds-close').addEventListener('click', closeSheet);
  $('feeds-sheet').querySelector('[data-close-sheet]').addEventListener('click', closeSheet);

  // ── Add feed sheet ─────────────────────────────────────────────────────
  function openAddSheet() {
    $('add-sheet').hidden = false;
    var err = $('add-error');
    err.hidden = true;
    err.textContent = '';
    var input = $('feed-url');
    input.value = '';
    input.disabled = false;
    $('add-submit').disabled = false;
    input.focus();
  }

  function closeSheet() {
    $('add-sheet').hidden = true;
    $('feeds-sheet').hidden = true;
  }

  addBtn.addEventListener('click', openAddSheet);
  $('add-close').addEventListener('click', closeSheet);
  $('add-cancel').addEventListener('click', closeSheet);
  $('add-sheet').querySelector('[data-close-sheet]').addEventListener('click', closeSheet);

  var ADD_ERRORS = {
    not_a_feed: 'That address is not an RSS or Atom feed.',
    unreachable: 'The site did not answer.',
    already_following: 'You already follow that feed.',
    account_required: 'Make an account to add feeds.',
  };

  $('add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('feed-url');
    var err = $('add-error');
    var url = input.value.trim();
    err.hidden = true;
    err.textContent = '';
    if (!url) {
      err.textContent = 'Paste the address of the feed.';
      err.hidden = false;
      return;
    }
    $('add-submit').disabled = true;
    input.disabled = true;
    api('POST', '/api/feeds', { url: url }).then(function (data) {
      if (data.__status === 201) {
        closeSheet();
        load();
        return;
      }
      if (data.__status === 409) throw new Error('already_following');
      if (data.__status === 401) throw new Error('account_required');
      if (data.__status === 422 && data.error === 'unreachable' && data.detail) {
        throw new Error(data.detail);
      }
      throw new Error(data.error === 'unreachable' ? 'unreachable' : 'not_a_feed');
    }).catch(function (e2) {
      err.textContent = ADD_ERRORS[e2.message] || 'That address is not an RSS or Atom feed.';
      err.hidden = false;
      $('add-submit').disabled = false;
      input.disabled = false;
    });
  });

  // ── Keyboard and list taps ─────────────────────────────────────────────
  postList.addEventListener('click', function (e) {
    var li = e.target.closest('li[data-id]');
    if (!li) return;
    var p = findPost(Number(li.dataset.id));
    if (p) openPreview(p);
  });
  postList.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var li = e.target.closest('li[data-id]');
    if (!li) return;
    e.preventDefault();
    var p = findPost(Number(li.dataset.id));
    if (p) openPreview(p);
  });

  function findPost(id) {
    for (var i = 0; i < state.posts.length; i++) {
      if (Number(state.posts[i].id) === id) return state.posts[i];
    }
    return null;
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeSheet();
      closePreview();
    }
  });

  load();
})();