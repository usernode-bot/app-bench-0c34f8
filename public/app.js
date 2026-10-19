/* RSS Reader frontend: fetches with x-usernode-token, renders the unread
 * list grouped by day, and drives the tabs and the three sheets. */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('token') || '';
  var DEMO_PARAM = params.get('demo') === '1';

  function nowIso() {
    if (window.usernode && typeof window.usernode.now === 'function') {
      try { return window.usernode.now(); } catch (e) {}
    }
    return new Date().toISOString();
  }

  function request(path, opts) {
    opts = opts || {};
    var headers = { 'x-usernode-token': TOKEN };
    if (opts.body) headers['content-type'] = 'application/json';
    var now = nowIso();
    if (now) headers['x-usernode-now'] = now;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || ('Request failed (' + res.status + ')'));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function api(path, opts) {
    return request(path, opts).catch(function (err) {
      // Some environments strip request headers from same-origin fetches;
      // the server also accepts the token as a query parameter, so retry
      // once that way before giving up.
      if (err.status === 401 && TOKEN && !/(^|[?&])token=/.test(path)) {
        return request(path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN), opts);
      }
      throw err;
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var el = {};
  ['status', 'demo-note', 'count-unread', 'count-saved', 'feeds-chips', 'content',
    'add-btn', 'feeds-btn', 'add-scrim', 'add-sheet', 'add-cancel', 'add-submit',
    'add-url', 'add-error', 'add-title', 'feeds-scrim', 'feeds-sheet', 'feeds-close',
    'feeds-list', 'preview-scrim', 'preview-sheet', 'pv-close', 'pv-dot', 'pv-meta',
    'pv-title', 'pv-excerpt', 'pv-note', 'pv-open', 'pv-save', 'pv-save-label',
    'pv-unread'].forEach(function (id) { el[id] = document.getElementById(id); });

  var state = { view: 'unread', feeds: [], posts: [], counts: { unread: 0, saved: 0 }, demo: false, loading: false, failed: false, post: null };

  function timeLabel(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hours = Math.round(mins / 60);
    if (hours < 24) return hours + ' hr ago';
    var day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    var time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return day + ', ' + time;
  }

  function dayGroup(iso) {
    var d = new Date(iso);
    var now = new Date(nowIso());
    function key(x) { return x.getFullYear() + '-' + x.getMonth() + '-' + x.getDate(); }
    if (key(d) === key(now)) return 'Today';
    var yest = new Date(now.getTime() - 86400000);
    if (key(d) === key(yest)) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function safeLink(url) { return /^https?:\/\//i.test(String(url || '')) ? url : ''; }

  /* ── Rendering ── */

  function rowHtml(p) {
    var read = !!p.read_at;
    return '<li class="list-row' + (read ? ' is-read' : '') + '" data-post-id="' + esc(p.id) + '">' +
      (read ? '' : '<i class="un"></i>') +
      '<i class="dot" style="background:rgb(var(--f' + Number(p.feed_color) + '))"></i>' +
      '<div class="body"><div class="t">' + esc(p.title) + '</div>' +
      '<div class="meta">' + esc(p.feed_title) + ', ' + esc(timeLabel(p.published_at)) + '</div></div></li>';
  }

  function skeletonHtml() {
    var row = '<li class="list-row"><div class="body"><div class="skeleton" style="height:16px;width:82%"></div>' +
      '<div class="skeleton" style="height:14px;width:45%;margin-top:8px"></div></div></li>';
    return '<div data-state="loading">' +
      '<div class="section-label">Today</div><ul class="list">' + row + row + row + row + row + '</ul>' +
      '<div class="section-label" style="margin-top:20px">Yesterday</div><ul class="list">' + row + row + row + '</ul></div>';
  }

  function renderList() {
    var posts = state.posts;
    var html = '';
    if (posts.length) {
      var last = null;
      posts.forEach(function (p) {
        var g = dayGroup(p.published_at);
        if (g !== last) {
          if (last !== null) html += '</ul>';
          html += '<div class="section-label"' + (last !== null ? ' style="margin-top:20px"' : '') + '>' + esc(g) + '</div><ul class="list">';
          last = g;
        }
        html += rowHtml(p);
      });
      html += '</ul>';
      html = '<div data-state="list">' + html + '</div>';
    } else if (!state.feeds.length) {
      el['add-btn'].className = 'btn-secondary';
      html = '<div class="state-empty" data-state="empty-feeds">' +
        '<div class="t">No feeds yet</div>' +
        '<div class="meta">Add the address of an RSS or Atom feed and its posts show up here.</div>' +
        '<button class="btn-primary" id="empty-add">Add your first feed</button></div>';
    } else if (state.view === 'unread') {
      html = '<div class="state-empty" data-state="caught-up">' +
        '<div class="t">All caught up</div>' +
        '<div class="meta">Every post has been read. The All tab shows everything, read and unread.</div>' +
        '<button class="btn-secondary" id="caught-all">Go to All</button></div>';
    } else if (state.view === 'saved') {
      html = '<div class="state-empty" data-state="empty-saved">' +
        '<div class="t">Nothing saved yet</div>' +
        '<div class="meta">Posts you save keep their place here.</div></div>';
    } else {
      html = '<div class="state-empty" data-state="empty-all">' +
        '<div class="t">Nothing here yet</div>' +
        '<div class="meta">Your feeds have no posts yet. Try Add feed to check a new one.</div></div>';
    }
    el.content.innerHTML = html;
    var emptyAdd = document.getElementById('empty-add');
    if (emptyAdd) emptyAdd.addEventListener('click', openAddSheet);
    var caught = document.getElementById('caught-all');
    if (caught) caught.addEventListener('click', function () { setView('all'); });
  }

  function renderError() {
    el['add-btn'].className = 'btn-secondary';
    el.content.innerHTML = '<div class="state-error" data-state="error">' +
      '<div class="t">Couldn\'t load your posts</div>' +
      '<div class="meta">Your feeds are safe. Check your connection and try again.</div>' +
      '<button class="btn-secondary" id="retry">Retry</button></div>';
    document.getElementById('retry').addEventListener('click', load);
  }

  function renderChips() {
    if (!state.feeds.length) { el['feeds-chips'].hidden = true; return; }
    el['feeds-chips'].hidden = false;
    el['feeds-chips'].innerHTML = state.feeds.map(function (f) {
      return '<span><i class="dot" style="background:rgb(var(--f' + Number(f.color) + '))"></i>' + esc(f.title) + '</span>';
    }).join('');
  }

  function renderTabs() {
    el['count-unread'].textContent = state.counts.unread ? String(state.counts.unread) : '';
    el['count-saved'].textContent = state.counts.saved ? String(state.counts.saved) : '';
    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('on', t.getAttribute('data-view') === state.view);
    });
  }

  function renderDemoNote() {
    el['demo-note'].hidden = !(state.demo && DEMO_PARAM);
  }

  function restoreAddButton() {
    el['add-btn'].className = 'btn-primary';
  }

  /* ── Sheets ── */

  function show(name) {
    el[name + '-scrim'].hidden = false;
    el[name + '-sheet'].hidden = false;
  }
  function hide(name) {
    el[name + '-scrim'].hidden = true;
    el[name + '-sheet'].hidden = true;
  }

  function openAddSheet() {
    el['add-url'].value = '';
    el['add-error'].hidden = true;
    show('add');
    el['add-url'].focus();
  }
  el['add-btn'].addEventListener('click', openAddSheet);
  el['add-cancel'].addEventListener('click', function () { hide('add'); });
  el['add-scrim'].addEventListener('click', function () { hide('add'); });

  el['add-submit'].addEventListener('click', function () {
    var url = el['add-url'].value.trim();
    el['add-error'].hidden = true;
    if (!url) {
      el['add-error'].textContent = 'Enter the address of a feed, for example https://example.com/feed.xml.';
      el['add-error'].hidden = false;
      return;
    }
    el['add-submit'].disabled = true;
    el['add-submit'].textContent = 'Adding…';
    api('/api/feeds', { method: 'POST', body: { url: url } }).then(function () {
      el['add-submit'].disabled = false;
      el['add-submit'].textContent = 'Add';
      hide('add');
      return load();
    }).catch(function (err) {
      el['add-submit'].disabled = false;
      el['add-submit'].textContent = 'Add';
      el['add-error'].textContent = err.status === 401
        ? 'Make an account to add feeds.'
        : (err.message || 'That address could not be added.');
      el['add-error'].hidden = false;
    });
  });

  function renderFeedsSheet() {
    var q = DEMO_PARAM && state.demo ? '?demo=1' : '';
    api('/api/feeds' + q).then(function (data) {
      state.feeds = data.feeds || [];
      el['feeds-list'].innerHTML = state.feeds.length ? state.feeds.map(function (f) {
        return '<li class="list-row" data-feed-id="' + esc(f.id) + '">' +
          '<i class="dot" style="background:rgb(var(--f' + Number(f.color) + '));margin-top:7px"></i>' +
          '<div class="body"><div class="t">' + esc(f.title) + '</div>' +
          '<div class="meta">' + esc(f.url) + '</div>' +
          (f.last_error ? '<div class="meta">Couldn\'t update</div>' : '') + '</div>' +
          '<div class="actions"><button class="ghost" data-act="remove">Remove</button></div></li>';
      }).join('') : '<li class="list-row"><div class="body"><div class="meta">No feeds yet.</div></div></li>';
    }).catch(function () {
      el['feeds-list'].innerHTML = '<li class="list-row"><div class="body"><div class="meta">Couldn\'t load your feeds.</div></div></li>';
    });
  }

  el['feeds-btn'].addEventListener('click', function () { renderFeedsSheet(); show('feeds'); });
  el['feeds-close'].addEventListener('click', function () { hide('feeds'); });
  el['feeds-scrim'].addEventListener('click', function () { hide('feeds'); });

  // Remove asks once more before taking the feed and its posts away.
  el['feeds-list'].addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-act]');
    var row = ev.target.closest('li[data-feed-id]');
    if (!row) return;
    var id = row.getAttribute('data-feed-id');
    var actions = row.querySelector('.actions');
    if (!btn) {
      row.querySelectorAll('.actions .confirm').forEach(function (c) { c.remove(); });
      return;
    }
    if (btn.getAttribute('data-act') === 'remove') {
      actions.innerHTML = '<button class="ghost confirm" data-act="yes">Remove it</button>' +
        '<button class="ghost confirm" data-act="no">Keep</button>';
    } else if (btn.getAttribute('data-act') === 'no') {
      actions.innerHTML = '<button class="ghost" data-act="remove">Remove</button>';
    } else if (btn.getAttribute('data-act') === 'yes') {
      api('/api/feeds/' + id, { method: 'DELETE' }).then(function () {
        renderFeedsSheet();
        return load();
      }).catch(function () {
        row.querySelector('.meta:last-child');
      });
    }
  });

  /* ── Preview sheet ── */

  function openPreview(id) {
    var p = null;
    state.posts.forEach(function (x) { if (String(x.id) === String(id)) p = x; });
    if (!p) return;
    state.post = p;
    var wasUnread = !p.read_at;
    el['pv-dot'].style.background = 'rgb(var(--f' + Number(p.feed_color) + '))';
    el['pv-meta'].textContent = p.feed_title + ', ' + timeLabel(p.published_at);
    el['pv-title'].textContent = p.title;
    var excerpt = p.excerpt && String(p.excerpt).trim();
    el['pv-excerpt'].textContent = excerpt || 'This feed doesn\'t include a preview. Open the full article to read it.';
    el['pv-note'].hidden = !wasUnread;
    var link = safeLink(p.link);
    el['pv-open'].href = link;
    el['pv-open'].hidden = !link;
    setSaveLabel(p.saved_at);
    show('preview');
    if (wasUnread) {
      patchPost(p.id, { read: true }).then(function (post) {
        if (post) applyPatch(post);
        el['pv-note'].hidden = false;
      }).catch(function () { el['pv-note'].hidden = true; });
    }
  }

  function setSaveLabel(saved) {
    el['pv-save-label'].textContent = saved ? 'Saved' : 'Save';
  }

  function patchPost(id, body) {
    return api('/api/posts/' + id, { method: 'PATCH', body: body }).then(function (data) {
      return data.post;
    });
  }

  function applyPatch(post) {
    for (var i = 0; i < state.posts.length; i++) {
      if (String(state.posts[i].id) === String(post.id)) { state.posts[i] = post; break; }
    }
    var row = el.content.querySelector('li[data-post-id="' + post.id + '"]');
    if (row) {
      row.classList.toggle('is-read', !!post.read_at);
      var un = row.querySelector('.un');
      if (!!post.read_at && un) un.remove();
      else if (!post.read_at && !un) row.insertAdjacentHTML('afterbegin', '<i class="un"></i>');
      var meta = row.querySelector('.meta');
      if (meta) meta.textContent = post.feed_title + ', ' + timeLabel(post.published_at);
    }
    refreshCounts();
  }

  function refreshCounts() {
    // Counts come from the server (the list itself is one view only, so
    // counting it locally would be wrong).
    var q = '?view=' + encodeURIComponent(state.view) + (DEMO_PARAM ? '&demo=1' : '');
    api('/api/posts' + q).then(function (data) {
      state.counts.unread = data.unread || 0;
      state.counts.saved = data.saved || 0;
      renderTabs();
    }).catch(function () {});
  }

  el['pv-close'].addEventListener('click', function () { hide('preview'); });
  el['preview-scrim'].addEventListener('click', function () { hide('preview'); });
  el['pv-save'].addEventListener('click', function () {
    if (!state.post) return;
    var next = !state.post.saved_at;
    patchPost(state.post.id, { saved: next }).then(function (post) {
      if (post) { applyPatch(post); setSaveLabel(post.saved_at); }
    }).catch(function () {});
  });
  el['pv-unread'].addEventListener('click', function () {
    if (!state.post) return;
    patchPost(state.post.id, { read: false }).then(function (post) {
      if (post) applyPatch(post);
      hide('preview');
    }).catch(function () { hide('preview'); });
  });

  /* ── Tabs and list events ── */

  function setView(view) {
    state.view = view;
    renderTabs();
    return loadPosts(view);
  }

  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () { setView(t.getAttribute('data-view')); });
  });

  el.content.addEventListener('click', function (ev) {
    var row = ev.target.closest('li[data-post-id]');
    if (row) openPreview(row.getAttribute('data-post-id'));
  });

  /* ── Loading ── */

  function loadPosts(view) {
    var q = '?view=' + encodeURIComponent(view) + (DEMO_PARAM ? '&demo=1' : '');
    return api('/api/posts' + q).then(function (data) {
      state.posts = data.posts || [];
      state.counts.unread = data.unread || 0;
      state.counts.saved = data.saved || 0;
      state.demo = !!data.demo;
      renderList();
      renderTabs();
      renderDemoNote();
    });
  }

  function loadFeeds() {
    var q = DEMO_PARAM ? '?demo=1' : '';
    return api('/api/feeds' + q).then(function (data) {
      state.feeds = data.feeds || [];
      renderChips();
    });
  }

  function load() {
    state.loading = true;
    state.failed = false;
    restoreAddButton();
    el.content.innerHTML = skeletonHtml();
    el.status.textContent = '';
    el.status.hidden = true;
    renderDemoNote();
    return Promise.all([loadFeeds(), loadPosts(state.view)]).then(function () {
      renderList();
      renderTabs();
      el.status.textContent = 'Updating…';
      el.status.hidden = false;
      return api('/api/refresh', { method: 'POST', body: {} }).then(function (r) {
        var changed = (r.results || []).filter(function (x) { return x.ok; }).length;
        return loadPosts(state.view).then(function () {
          el.status.textContent = 'Updated just now';
          el.status.hidden = false;
        });
      }).catch(function () {
        // A failed feed keeps its older posts; the feeds list marks it.
        el.status.textContent = 'Updated just now';
        el.status.hidden = false;
      });
    }).catch(function (err) {
      if (err && err.status === 401) {
        // Not signed in with an account: the empty screen is the honest one.
        state.feeds = [];
        state.posts = [];
        renderList();
        return;
      }
      state.failed = true;
      renderError();
    }).then(function () { state.loading = false; });
  }

  load();
})();