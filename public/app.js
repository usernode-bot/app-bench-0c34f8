/* RSS Reader client: the Unread list (screen 1 as drawn), the post preview
 * (screen 2 as drawn), the Feeds view and the Add feed sheet.
 * Views are hash routes: '' = Unread, '#feeds', '#post/<id>'.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('token') || '';
  var DEMO = params.get('demo') === '1';

  function api(path, opts) {
    opts = opts || {};
    var url = '/api/' + path;
    if (DEMO) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'demo=1';
    var headers = { 'x-usernode-token': TOKEN };
    if (opts.body) headers['Content-Type'] = 'application/json';
    return fetch(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error(body.error || 'HTTP ' + res.status);
          err.code = body.error;
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  // ── Relative times: "12 min ago", "Today, 09:30", "Yesterday, 18:40",
  // "Mon, 16:02", then "12 Mar". ──
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function hhmm(d) {
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var mins = Math.round((now.getTime() - d.getTime()) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + ' min ago';
    var startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var startOfYesterday = new Date(startOfDay.getTime() - 86400000);
    if (d >= startOfDay) return 'Today, ' + hhmm(d);
    if (d >= startOfYesterday) return 'Yesterday, ' + hhmm(d);
    if (now.getTime() - d.getTime() < 6 * 86400000) return DAYS[d.getDay()] + ', ' + hhmm(d);
    return d.getDate() + ' ' + MONTHS[d.getMonth()];
  }

  // ── Elements ──
  var $ = function (id) { return document.getElementById(id); };
  var topBar = $('top-bar');
  var countLine = $('count-line');
  var postList = $('post-list');
  var caughtUp = $('caught-up');
  var refreshNote = $('refresh-note');
  var newestLabel = $('newest-label');
  var stateLoading = $('state-loading');
  var stateEmpty = $('state-empty');
  var stateError = $('state-error');
  var viewPost = $('view-post');
  var viewFeeds = $('view-feeds');
  var feedList = $('feeds-list');
  var rowTpl = $('post-row-tpl');
  var sheet = $('sheet-backdrop');
  var sheetError = $('sheet-error');
  var feedUrl = $('feed-url');

  // ── State ──
  var state = {
    posts: [],
    unreadCount: 0,
    feedCount: 0,
    failedFeeds: [],
    staging: false,
    loaded: false,
    readInVisit: {}, // posts read during this visit, kept in place and faded
  };

  function text(el, s) {
    if (el) el.textContent = s;
  }

  // ── Views ──
  function currentRoute() {
    var h = location.hash;
    if (h.indexOf('#post/') === 0) return { view: 'post', id: Number(h.slice(6)) };
    if (h === '#feeds') return { view: 'feeds' };
    return { view: 'unread' };
  }

  function showUnread() {
    viewPost.hidden = true;
    viewFeeds.hidden = true;
    $('view-unread').hidden = false;
    renderList();
  }

  function renderList() {
    var unreadView = $('view-unread');
    if (!state.loaded) return; // loading, empty or error state owns the screen
    postList.textContent = '';
    state.posts.forEach(function (p) {
      var li = rowTpl.content.firstElementChild.cloneNode(true);
      var a = li.firstElementChild;
      a.className = 'card post-card' + (state.readInVisit[p.id] ? ' opacity-60' : '');
      a.href = '#post/' + p.id;
      a.style.setProperty('--c', 'var(--feed-' + (p.hue || 1) + ')');
      a.querySelector('b').textContent = p.feed_title;
      a.querySelector('.meta span').textContent = when(p.published_at);
      a.querySelector('.t').textContent = p.title;
      a.querySelector('.ex').textContent = p.summary || '';
      postList.appendChild(li);
    });
    var nothingUnread = state.posts.length === 0 && state.unreadCount === 0 && state.feedCount > 0;
    caughtUp.hidden = !nothingUnread;
    stateEmpty.hidden = true;
    stateError.hidden = true;
    stateLoading.hidden = true;
    topBar.hidden = false;
    newestLabel.hidden = false;
  }

  function renderStates() {
    // One of loading / empty / error owns the screen until data is loaded.
    if (!state.loaded) {
      stateLoading.hidden = false;
      stateEmpty.hidden = true;
      stateError.hidden = true;
      newestLabel.hidden = true;
      postList.textContent = '';
      caughtUp.hidden = true;
      return;
    }
    if (state.feedCount === 0) {
      stateLoading.hidden = true;
      stateError.hidden = true;
      stateEmpty.hidden = false;
      topBar.hidden = true; // the empty screen's own button is the only action
      newestLabel.hidden = true;
      postList.textContent = '';
      caughtUp.hidden = true;
      return;
    }
    renderList();
  }

  function renderCount() {
    var parts = [];
    if (DEMO && state.staging) {
      parts.push('Staging demo: ' + state.unreadCount + ' new from ' + state.feedCount + ' feed' + (state.feedCount === 1 ? '' : 's'));
    } else {
      parts.push(state.unreadCount + ' unread from ' + state.feedCount + ' feed' + (state.feedCount === 1 ? '' : 's'));
    }
    if (state.failedFeeds.length > 0) {
      parts.push(state.failedFeeds.length + ' feed' + (state.failedFeeds.length === 1 ? '' : 's') + " couldn't be checked");
    }
    text(countLine, parts.join(' · '));
  }

  function showError(message) {
    state.loaded = false;
    stateLoading.hidden = true;
    stateEmpty.hidden = true;
    stateError.hidden = false;
    topBar.hidden = false;
    newestLabel.hidden = true;
    postList.textContent = '';
    caughtUp.hidden = true;
    var msg = $('error-message');
    if (msg) msg.textContent = message;
  }

  function load() {
    return api('posts')
      .then(function (data) {
        state.posts = data.posts || [];
        state.unreadCount = data.unreadCount || 0;
        state.feedCount = data.feedCount || 0;
        state.failedFeeds = data.failedFeeds || [];
        state.staging = !!data.staging;
        state.loaded = true;
        renderStates();
        renderCount();
      })
      .catch(function () {
        showError("Your posts couldn't be loaded. Your feeds are still saved.");
      });
  }

  function refreshThenReload() {
    if (state.loaded && state.feedCount === 0) return Promise.resolve();
    return api('refresh', { method: 'POST' })
      .then(function () {
        refreshNote.hidden = true;
        return load();
      })
      .catch(function () {
        // The stored list stays on screen with a quiet note.
        refreshNote.hidden = false;
      });
  }

  // ── Post preview (screen 2 as drawn) ──
  function openPost(id) {
    var p = null;
    for (var i = 0; i < state.posts.length; i++) {
      if (state.posts[i].id === id) p = state.posts[i];
    }
    if (!p) {
      location.hash = '';
      return;
    }
    $('view-unread').hidden = true;
    viewFeeds.hidden = true;
    viewPost.hidden = false;
    var art = $('post-art');
    art.style.setProperty('--c', 'var(--feed-' + (p.hue || 1) + ')');
    text($('post-src'), p.feed_title);
    text($('post-title'), p.title);
    text($('post-when'), when(p.published_at));
    var body = $('post-body');
    body.textContent = '';
    var para = document.createElement('p');
    para.textContent = p.summary || '';
    body.appendChild(para);
    var host = '';
    try {
      if (p.site_url) host = new URL(p.site_url).hostname;
    } catch (e) { /* no site url: leave the host out */ }
    text($('post-note'), host
      ? 'This is the summary the feed sends. The full article is on ' + host + '.'
      : "This is the summary the feed sends. The full article is on the feed's own site.");
    var link = $('post-link');
    if (p.link) {
      link.hidden = false;
      link.href = p.link;
    } else {
      link.hidden = true;
    }
    // Counts as read from then on. If marking fails, the preview still
    // opens and the post stays unread.
    state.readInVisit[p.id] = true;
    api('posts/' + p.id + '/read', { method: 'POST' })
      .then(function () { renderList(); })
      .catch(function () {
        delete state.readInVisit[p.id];
        renderList();
      });
  }

  // ── Feeds view ──
  function renderFeeds(feeds) {
    feedList.textContent = '';
    feeds.forEach(function (f) {
      var li = document.createElement('li');
      var card = document.createElement('div');
      card.className = 'card';
      card.style.setProperty('--c', 'var(--feed-' + (f.hue || 1) + ')');
      var meta = document.createElement('div');
      meta.className = 'meta';
      var b = document.createElement('b');
      b.textContent = f.title;
      var span = document.createElement('span');
      span.textContent = f.unread_count + ' unread';
      meta.appendChild(b);
      meta.appendChild(span);
      card.appendChild(meta);
      var t = document.createElement('p');
      t.className = 't';
      t.textContent = f.site_url || f.url;
      card.appendChild(t);
      if (f.last_error) {
        var err = document.createElement('p');
        err.className = 'ex';
        err.style.color = 'rgb(var(--danger))';
        err.textContent = "Couldn't be checked last time. Its posts are still here.";
        card.appendChild(err);
      }
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-secondary';
      remove.textContent = 'Remove';
      remove.addEventListener('click', function () {
        if (!window.confirm('Remove ' + f.title + ' and its posts?')) return;
        api('feeds/' + f.id, { method: 'DELETE' }).then(loadFeeds).catch(function () {});
      });
      var row = document.createElement('div');
      row.className = 'mt-3';
      row.appendChild(remove);
      card.appendChild(row);
      li.appendChild(card);
      feedList.appendChild(li);
    });
  }

  function loadFeeds() {
    return api('feeds')
      .then(function (data) {
        renderFeeds(data.feeds || []);
      })
      .catch(function () {
        feedList.textContent = '';
        var li = document.createElement('li');
        var p = document.createElement('p');
        p.className = 'ex';
        p.textContent = "Your feeds couldn't be loaded. Try Unread and come back.";
        li.appendChild(p);
        feedList.appendChild(li);
      });
  }

  // ── Add feed sheet ──
  var ERROR_WORDS = {
    not_a_feed: "That address isn't a feed. Check it and try again.",
    web_page: "That's a web page, not a feed. Paste the feed's own address.",
    unreachable: "That address couldn't be reached. Check it and try again.",
    blocked_address: "That address isn't allowed here.",
    duplicate: 'You already have that feed.',
  };

  function openSheet() {
    sheet.hidden = false;
    sheetError.hidden = true;
    feedUrl.focus();
  }

  function closeSheet() {
    sheet.hidden = true;
    feedUrl.value = '';
    sheetError.hidden = true;
  }

  function addFeed() {
    sheetError.hidden = true;
    api('feeds', { method: 'POST', body: { url: feedUrl.value } })
      .then(function () {
        closeSheet();
        return load();
      })
      .then(refreshThenReload)
      .catch(function (e) {
        text(sheetError, ERROR_WORDS[e.code] || "That address couldn't be added. Check it and try again.");
        sheetError.hidden = false;
      });
  }

  // ── Routing ──
  function route() {
    var r = currentRoute();
    if (r.view === 'post') return openPost(r.id);
    if (r.view === 'feeds') {
      $('view-unread').hidden = true;
      viewPost.hidden = true;
      viewFeeds.hidden = false;
      loadFeeds();
      return;
    }
    showUnread();
  }

  window.addEventListener('hashchange', route);
  $('btn-feeds').addEventListener('click', function () { location.hash = '#feeds'; });
  $('feeds-back').addEventListener('click', function () { location.hash = ''; });
  $('post-back').addEventListener('click', function () { location.hash = ''; });
  $('btn-add').addEventListener('click', openSheet);
  $('empty-add').addEventListener('click', openSheet);
  $('feeds-add').addEventListener('click', openSheet);
  $('sheet-cancel').addEventListener('click', closeSheet);
  $('sheet-backdrop').addEventListener('click', function (e) {
    if (e.target === sheet) closeSheet();
  });
  $('sheet-add').addEventListener('click', addFeed);
  feedUrl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') addFeed();
  });
  $('btn-retry').addEventListener('click', function () {
    state.loaded = false;
    renderStates();
    load().then(refreshThenReload);
  });

  // On open: render straight away, then check every feed, then merge in the
  // new posts at the top.
  renderStates();
  route();
  load().then(refreshThenReload);
})();
