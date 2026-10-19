(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var DEMO = params.get('demo') === '1';
  var TOKEN = params.get('token') || (window.usernode && window.usernode.token) || '';

  function now() {
    try {
      if (window.usernode && typeof window.usernode.now === 'function') {
        var value = window.usernode.now();
        return value instanceof Date ? value : new Date(value);
      }
    } catch (e) { /* fall through */ }
    return new Date();
  }

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    status: $('status-line'),
    demoNote: $('demo-note'),
    addFeed: $('add-feed-btn'),
    feedsBtn: $('feeds-btn'),
    chips: $('feed-chips'),
    tabs: Array.prototype.slice.call(document.querySelectorAll('.tab')),
    countUnread: $('count-unread'),
    countSaved: $('count-saved'),
    loading: $('loading-state'),
    list: $('post-list'),
    emptyFeeds: document.querySelector('[data-state="empty-feeds"]'),
    caughtUp: document.querySelector('[data-state="caught-up"]'),
    nothingSaved: document.querySelector('[data-state="nothing-saved"]'),
    noPosts: document.querySelector('[data-state="no-posts"]'),
    error: document.querySelector('[data-state="error"]'),
    emptyAdd: $('empty-add'),
    caughtUpAll: $('caught-up-all'),
    retry: $('retry-btn'),
    scrim: $('scrim'),
    previewSheet: $('preview-sheet'),
    previewDot: $('preview-dot'),
    previewMeta: $('preview-meta'),
    previewClose: $('preview-close'),
    previewTitle: $('preview-title'),
    previewExcerpt: $('preview-excerpt'),
    previewNote: $('preview-note'),
    previewOpen: $('preview-open'),
    previewSave: $('preview-save'),
    previewSaveLabel: $('preview-save-label'),
    previewUnread: $('preview-unread'),
    addSheet: $('add-sheet'),
    addForm: $('add-sheet'),
    addCancel: $('add-cancel'),
    addSubmit: $('add-submit'),
    feedUrl: $('feed-url'),
    addError: $('add-error'),
    feedsSheet: $('feeds-sheet'),
    feedsList: $('feeds-list'),
    feedsClose: $('feeds-close'),
    feedsEmpty: $('feeds-empty'),
    feedsError: $('feeds-error'),
    feedsRetry: $('feeds-retry')
  };

  var state = {
    tab: 'unread',
    feeds: [],
    posts: [],
    unread: 0,
    saved: 0,
    loading: true,
    failed: false,
    current: null,
    sheet: null,
    lastTrigger: null
  };

  function apiUrl(path) {
    if (!DEMO) return path;
    return path + (path.indexOf('?') === -1 ? '?' : '&') + 'demo=1';
  }

  function api(path, options) {
    options = options || {};
    var headers = {
      'x-usernode-token': TOKEN,
      'x-usernode-now': now().toISOString()
    };
    if (options.body) headers['content-type'] = 'application/json';
    return fetch(apiUrl(path), {
      method: options.method || 'GET',
      headers: headers,
      body: options.body
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && data.error) || 'Something went wrong.');
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function colorOf(feed) {
    var n = ((Number(feed && feed.color) || 1) - 1) % 8;
    if (n < 0) n = 0;
    return 'rgb(var(--f' + (n + 1) + '))';
  }

  function clock(date) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  }

  function shortDate(date) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function dayLabel(date, reference) {
    if (date.toDateString() === reference.toDateString()) return 'Today';
    var yesterday = new Date(reference);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return shortDate(date);
  }

  function timeLabel(date, reference) {
    var diff = reference - date;
    if (diff < 60 * 60 * 1000) {
      var minutes = Math.max(1, Math.round(diff / 60000));
      return minutes + ' min ago';
    }
    if (date.toDateString() === reference.toDateString()) {
      var hours = Math.round(diff / 3600000);
      return hours + ' hr ago';
    }
    var yesterday = new Date(reference);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return 'yesterday ' + clock(date);
    }
    return shortDate(date) + ', ' + clock(date);
  }

  function hide(node) { if (node) node.hidden = true; }
  function show(node) { if (node) node.hidden = false; }

  function setStatus(text) {
    el.status.textContent = text || '';
  }

  function setCounts() {
    el.countUnread.textContent = String(state.unread);
    el.countSaved.textContent = String(state.saved);
  }

  function hideStates() {
    hide(el.loading);
    hide(el.list);
    hide(el.emptyFeeds);
    hide(el.caughtUp);
    hide(el.nothingSaved);
    hide(el.noPosts);
    hide(el.error);
  }

  function showLoading() {
    hideStates();
    show(el.loading);
    state.loading = true;
  }

  function showError() {
    hideStates();
    show(el.error);
    state.loading = false;
    state.failed = true;
  }

  function renderChips() {
    el.chips.innerHTML = '';
    el.chips.hidden = state.feeds.length === 0;
    state.feeds.forEach(function (feed) {
      var span = document.createElement('span');
      var dot = document.createElement('i');
      dot.className = 'dot';
      dot.style.background = colorOf(feed);
      span.appendChild(dot);
      span.appendChild(document.createTextNode(feed.title));
      el.chips.appendChild(span);
    });
    el.addFeed.classList.toggle('btn-primary', state.feeds.length !== 0);
    el.addFeed.classList.toggle('btn-secondary', state.feeds.length === 0);
  }

  function buildRow(post) {
    var reference = now();
    var li = document.createElement('li');
    li.className = 'list-row';
    li.setAttribute('data-post-id', String(post.id));
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    if (!post.read_at) {
      var unread = document.createElement('i');
      unread.className = 'un';
      li.appendChild(unread);
    }
    var dot = document.createElement('i');
    dot.className = 'dot';
    dot.style.background = colorOf({ color: post.color });
    li.appendChild(dot);
    var body = document.createElement('div');
    body.className = 'body';
    var title = document.createElement('div');
    title.className = 't';
    title.textContent = post.title;
    var meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = post.feed_title + ', ' + timeLabel(new Date(post.published_at), reference);
    body.appendChild(title);
    body.appendChild(meta);
    li.appendChild(body);
    if (post.read_at) li.classList.add('read');
    return li;
  }

  function renderPosts() {
    hideStates();
    var reference = now();
    if (!state.feeds.length) {
      show(el.emptyFeeds);
      el.emptyAdd.hidden = state.sheet === 'add';
      state.loading = false;
      return;
    }
    if (!state.posts.length) {
      if (state.tab === 'unread') show(el.caughtUp);
      else if (state.tab === 'saved') show(el.nothingSaved);
      else show(el.noPosts);
      state.loading = false;
      return;
    }
    show(el.list);
    el.list.innerHTML = '';
    var previousDay = null;
    var group = null;
    state.posts.forEach(function (post) {
      var date = new Date(post.published_at);
      var key = date.toDateString();
      if (key !== previousDay) {
        var label = document.createElement('div');
        label.className = 'section-label' + (previousDay === null ? '' : ' mt-5');
        label.textContent = dayLabel(date, reference);
        el.list.appendChild(label);
        group = document.createElement('ul');
        group.className = 'list';
        el.list.appendChild(group);
        previousDay = key;
      }
      group.appendChild(buildRow(post));
    });
    state.loading = false;
  }

  function renderAll() {
    renderChips();
    setCounts();
    renderPosts();
    el.addFeed.classList.toggle('btn-primary', state.feeds.length !== 0);
    el.addFeed.classList.toggle('btn-secondary', state.feeds.length === 0);
  }

  function setTab(tab) {
    state.tab = tab;
    el.tabs.forEach(function (button) {
      var on = button.getAttribute('data-tab') === tab;
      button.classList.toggle('on', on);
      button.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function loadPosts(quiet) {
    if (!quiet) showLoading();
    return api('/api/posts?view=' + encodeURIComponent(state.tab)).then(function (data) {
      state.posts = data.posts || [];
      state.unread = data.unread || 0;
      state.saved = data.saved || 0;
      el.demoNote.hidden = !data.demo;
      state.failed = false;
      setCounts();
      renderPosts();
    }).catch(function () {
      showError();
    });
  }

  function loadFeeds() {
    return api('/api/feeds').then(function (data) {
      state.feeds = data.feeds || [];
      renderChips();
      return state.feeds;
    });
  }

  function reloadAll() {
    showLoading();
    return Promise.all([loadFeeds(), api('/api/posts?view=' + encodeURIComponent(state.tab))])
      .then(function (results) {
        var data = results[1];
        state.posts = data.posts || [];
        state.unread = data.unread || 0;
        state.saved = data.saved || 0;
        el.demoNote.hidden = !data.demo;
        state.failed = false;
        renderAll();
      })
      .catch(function () {
        showError();
      });
  }

  function refreshFeeds() {
    if (!state.feeds.length) {
      setStatus('Updated just now');
      return Promise.resolve();
    }
    setStatus('Updating…');
    return api('/api/refresh', { method: 'POST' })
      .catch(function () { return null; })
      .then(function () {
        return Promise.all([loadFeeds(), api('/api/posts?view=' + encodeURIComponent(state.tab))]);
      })
      .then(function (results) {
        var data = results[1];
        state.posts = data.posts || [];
        state.unread = data.unread || 0;
        state.saved = data.saved || 0;
        el.demoNote.hidden = !data.demo;
        state.failed = false;
        renderAll();
        setStatus('Updated just now');
      })
      .catch(function () {
        setStatus('Updated just now');
      });
  }

  // ── Sheets ─────────────────────────────────────────────────────────────
  function openSheet(name, trigger) {
    closeSheet();
    state.sheet = name;
    state.lastTrigger = trigger || document.activeElement;
    show(el.scrim);
    if (name === 'preview') {
      show(el.previewSheet);
      el.previewClose.focus();
    } else if (name === 'add') {
      show(el.addSheet);
      el.emptyAdd.hidden = true;
      el.feedUrl.focus();
    } else if (name === 'feeds') {
      show(el.feedsSheet);
      el.feedsClose.focus();
    }
  }

  function closeSheet() {
    var was = state.sheet;
    state.sheet = null;
    hide(el.scrim);
    hide(el.previewSheet);
    hide(el.addSheet);
    hide(el.feedsSheet);
    if (was === 'add' && !state.feeds.length) el.emptyAdd.hidden = false;
    if (state.lastTrigger && document.contains(state.lastTrigger)) {
      state.lastTrigger.focus();
    }
    // A row read or unsaved while the sheet was open moves only now that
    // the person is back on the list.
    if (was === 'preview') loadPosts(true);
  }

  function showPreview(post, trigger) {
    state.current = post;
    var reference = now();
    var published = new Date(post.published_at);
    el.previewDot.style.background = colorOf({ color: post.color });
    el.previewMeta.textContent = post.feed_title + ', ' + timeLabel(published, reference);
    el.previewTitle.textContent = post.title;
    el.previewExcerpt.textContent = post.excerpt || "This feed didn't include an excerpt.";
    var link = post.link && /^https?:\/\//i.test(post.link) ? post.link : '';
    if (link) {
      el.previewOpen.href = link;
      show(el.previewOpen);
    } else {
      el.previewOpen.removeAttribute('href');
      hide(el.previewOpen);
    }
    el.previewSaveLabel.textContent = post.saved_at ? 'Saved' : 'Save';
    el.previewNote.textContent = 'Marked as read';
    openSheet('preview', trigger);
    if (!post.read_at) markRead(post, true);
  }

  function markRead(post, read) {
    if (read && !post.read_at) state.unread = Math.max(0, state.unread - 1);
    if (!read && post.read_at) state.unread += 1;
    setCounts();
    post.read_at = read ? new Date().toISOString() : null;
    el.previewNote.textContent = read ? 'Marked as read' : 'Marked as unread';
    api('/api/posts/' + post.id, {
      method: 'PATCH',
      body: JSON.stringify({ read: read })
    }).then(function (data) {
      if (data && data.post) {
        post.read_at = data.post.read_at;
        post.saved_at = data.post.saved_at;
      }
    }).catch(function () {
      el.previewNote.textContent = "Couldn't mark that post. Try again.";
    });
  }

  function toggleSave(post) {
    var save = !post.saved_at;
    el.previewSaveLabel.textContent = save ? 'Saved' : 'Save';
    api('/api/posts/' + post.id, {
      method: 'PATCH',
      body: JSON.stringify({ saved: save })
    }).then(function (data) {
      post.saved_at = save ? (data.post && data.post.saved_at) || new Date().toISOString() : null;
      state.saved += save ? 1 : -1;
      if (state.saved < 0) state.saved = 0;
      setCounts();
    }).catch(function () {
      el.previewSaveLabel.textContent = save ? 'Save' : 'Saved';
      el.previewNote.textContent = "Couldn't save that post. Try again.";
    });
  }

  function feedRow(feed) {
    var li = document.createElement('li');
    li.className = 'list-row';
    li.setAttribute('data-feed-id', String(feed.id));
    var dot = document.createElement('i');
    dot.className = 'dot';
    dot.style.background = colorOf(feed);
    li.appendChild(dot);
    var body = document.createElement('div');
    body.className = 'body';
    var title = document.createElement('div');
    title.className = 't';
    title.textContent = feed.title;
    var url = document.createElement('div');
    url.className = 'meta';
    url.textContent = feed.url;
    body.appendChild(title);
    body.appendChild(url);
    if (feed.last_error) {
      var failed = document.createElement('div');
      failed.className = 'meta';
      failed.textContent = "Couldn't update";
      body.appendChild(failed);
    }
    li.appendChild(body);
    var actions = document.createElement('div');
    actions.className = 'feed-actions';
    var remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'ghost';
    remove.setAttribute('data-remove', '');
    remove.textContent = 'Remove';
    actions.appendChild(remove);
    li.appendChild(actions);
    return li;
  }

  function renderFeedsSheet() {
    el.feedsList.innerHTML = '';
    hide(el.feedsEmpty);
    hide(el.feedsError);
    state.feeds.forEach(function (feed) {
      el.feedsList.appendChild(feedRow(feed));
    });
    if (!state.feeds.length) show(el.feedsEmpty);
  }

  function loadFeedsSheet() {
    el.feedsList.innerHTML = '';
    hide(el.feedsEmpty);
    hide(el.feedsError);
    api('/api/feeds').then(function (data) {
      state.feeds = data.feeds || [];
      renderFeedsSheet();
      renderChips();
    }).catch(function () {
      show(el.feedsError);
    });
  }

  // ── Events ─────────────────────────────────────────────────────────────
  function openAdd(trigger) {
    el.addError.hidden = true;
    el.addError.textContent = '';
    el.feedUrl.value = '';
    el.addSubmit.disabled = false;
    el.addSubmit.textContent = 'Add';
    openSheet('add', trigger);
  }

  function openFeeds(trigger) {
    openSheet('feeds', trigger);
    loadFeedsSheet();
  }

  el.addFeed.addEventListener('click', function () { openAdd(el.addFeed); });
  el.emptyAdd.addEventListener('click', function () { openAdd(el.emptyAdd); });
  el.feedsBtn.addEventListener('click', function () { openFeeds(el.feedsBtn); });

  el.tabs.forEach(function (button) {
    button.addEventListener('click', function () {
      if (state.tab === button.getAttribute('data-tab')) return;
      setTab(button.getAttribute('data-tab'));
      loadPosts();
    });
  });

  el.caughtUpAll.addEventListener('click', function () {
    setTab('all');
    loadPosts();
  });

  el.retry.addEventListener('click', function () {
    reloadAll().then(function () { refreshFeeds(); });
  });

  el.previewClose.addEventListener('click', closeSheet);
  el.feedsClose.addEventListener('click', closeSheet);
  el.addCancel.addEventListener('click', closeSheet);
  el.scrim.addEventListener('click', closeSheet);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.sheet) closeSheet();
  });

  el.list.addEventListener('click', function (event) {
    var row = event.target.closest('.list-row[data-post-id]');
    if (!row) return;
    var post = state.posts.find(function (p) { return String(p.id) === row.getAttribute('data-post-id'); });
    if (post) showPreview(post, row);
  });

  el.list.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var row = event.target.closest('.list-row[data-post-id]');
    if (!row) return;
    event.preventDefault();
    var post = state.posts.find(function (p) { return String(p.id) === row.getAttribute('data-post-id'); });
    if (post) showPreview(post, row);
  });

  el.previewSave.addEventListener('click', function () {
    if (state.current) toggleSave(state.current);
  });

  el.previewUnread.addEventListener('click', function () {
    if (state.current) markRead(state.current, false);
  });

  el.addForm.addEventListener('submit', function (event) {
    event.preventDefault();
    if (el.addSubmit.disabled) return;
    var url = el.feedUrl.value.trim();
    if (!url) return;
    el.addError.hidden = true;
    el.addSubmit.disabled = true;
    el.addSubmit.textContent = 'Adding…';
    api('/api/feeds', {
      method: 'POST',
      body: JSON.stringify({ url: url })
    }).then(function () {
      closeSheet();
      setTab('unread');
      return reloadAll().then(function () { refreshFeeds(); });
    }).catch(function (err) {
      if (err.status === 401) {
        el.addError.textContent = 'Make an account to add feeds.';
      } else {
        el.addError.textContent = err.message || 'That address could not be added.';
      }
      el.addError.hidden = false;
      el.addError.classList.add('error');
      el.feedUrl.focus();
      el.feedUrl.select();
    }).then(function () {
      el.addSubmit.disabled = false;
      el.addSubmit.textContent = 'Add';
    });
  });

  el.feedsList.addEventListener('click', function (event) {
    var row = event.target.closest('[data-feed-id]');
    if (!row) return;
    var id = row.getAttribute('data-feed-id');
    var remove = event.target.closest('[data-remove]');
    if (remove) {
      if (row.getAttribute('data-confirm') !== '1') {
        row.setAttribute('data-confirm', '1');
        remove.textContent = 'Remove feed?';
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'ghost';
        cancel.textContent = 'Cancel';
        cancel.setAttribute('data-cancel-remove', '');
        row.querySelector('.feed-actions').appendChild(cancel);
        return;
      }
      api('/api/feeds/' + id, { method: 'DELETE' }).then(function () {
        state.feeds = state.feeds.filter(function (f) { return String(f.id) !== id; });
        renderFeedsSheet();
        renderChips();
        setTab('unread');
        return loadPosts();
      }).catch(function () {
        row.setAttribute('data-confirm', '');
        remove.textContent = 'Remove';
        var cancelBtn = row.querySelector('[data-cancel-remove]');
        if (cancelBtn) cancelBtn.remove();
      });
      return;
    }
    var cancelButton = event.target.closest('[data-cancel-remove]');
    if (cancelButton) {
      row.removeAttribute('data-confirm');
      var removeBtn = row.querySelector('[data-remove]');
      removeBtn.textContent = 'Remove';
      cancelButton.remove();
    }
  });

  el.feedsRetry.addEventListener('click', loadFeedsSheet);

  // ── Start ──────────────────────────────────────────────────────────────
  setStatus('');
  showLoading();
  setTab('unread');
  Promise.all([loadFeeds(), api('/api/posts?view=unread')])
    .then(function (results) {
      var data = results[1];
      state.posts = data.posts || [];
      state.unread = data.unread || 0;
      state.saved = data.saved || 0;
      el.demoNote.hidden = !data.demo;
      renderAll();
      refreshFeeds();
    })
    .catch(function () {
      showError();
    });
})();
