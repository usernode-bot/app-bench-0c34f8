'use strict';

/* The reader's page script. Vanilla JS, no build step.
 *
 * Auth: the platform mints a token per person per app and injects it as
 * ?token= on the iframe load; every fetch forwards it as x-usernode-token.
 * Guests (no Homeroom account) read an empty list; writes answer 401
 * account_required, which the platform bridge turns into a
 * "Make an account to continue" sheet.
 */

(function () {
  // ── Setup ──────────────────────────────────────────────────────────────
  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('token') || '';
  var demoParam = params.get('demo') === '1';

  var state = {
    signedIn: false,
    demo: false,
    posts: [],
    feedCount: 0,
    unreadCount: 0,
    failedFeeds: [],
  };

  var els = {};
  ['demo-note', 'count-line', 'refresh-btn', 'mark-all-btn', 'failed-note',
   'skeleton-list', 'state-empty', 'state-caught-up', 'state-error',
   'post-list', 'add-feed-btn', 'empty-add-btn', 'caught-up-refresh-btn',
   'retry-btn'].forEach(function (id) {
    els[id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] =
      document.getElementById(id);
  });

  function un() {
    return window.unNative || null;
  }

  function toast(message) {
    var kit = un();
    if (kit && kit.toast) kit.toast(message);
  }

  // ── API helper ─────────────────────────────────────────────────────────
  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (TOKEN) headers['x-usernode-token'] = TOKEN;
    try {
      var now = window.usernode && window.usernode.now && window.usernode.now();
      if (now instanceof Date && !isNaN(now)) headers['x-usernode-now'] = now.toISOString();
    } catch (_) { /* the server then reads its own clock */ }
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.headers = headers;
      opts.body = JSON.stringify(opts.body);
    } else {
      opts.headers = headers;
    }
    return fetch(path, opts).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || 'request failed');
          err.code = data && data.error;
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  // ── Dates, read through usernode.now() so previews stay honest ────────
  function nowDate() {
    try {
      var now = window.usernode && window.usernode.now && window.usernode.now();
      if (now instanceof Date && !isNaN(now)) return now;
    } catch (_) { /* fall through */ }
    return new Date();
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function formatDate(iso) {
    var then = new Date(iso);
    if (isNaN(then.getTime())) return '';
    var now = nowDate();
    var minutes = Math.floor((now.getTime() - then.getTime()) / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return minutes + 'm ago';
    if (minutes < 24 * 60) return Math.floor(minutes / 60) + 'h ago';
    var dayThen = new Date(then.getFullYear(), then.getMonth(), then.getDate());
    var dayNow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (Math.round((dayNow - dayThen) / 86400000) === 1) return 'Yesterday';
    return MONTHS[then.getMonth()] + ' ' + then.getDate();
  }

  // The feed dot's letter: what follows the feed's last "Label: name"
  // prefix, else the first letter of the name.
  function feedInitial(title) {
    var text = String(title || '').trim();
    if (!text) return '•';
    var colon = text.lastIndexOf(':');
    var source = colon !== -1 ? text.slice(colon + 1).trim() : text;
    var match = source.match(/[^\s]/);
    return match ? match[0].toUpperCase() : '•';
  }

  function isHttpLink(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  // ── Rendering ──────────────────────────────────────────────────────────
  function show(only) {
    ['skeletonList', 'stateEmpty', 'stateCaughtUp', 'stateError', 'postList']
      .forEach(function (key) {
        els[key].hidden = key !== only;
      });
  }

  function updateCountLine() {
    var feeds = state.feedCount === 1 ? 'feed' : 'feeds';
    els.countLine.textContent =
      state.unreadCount + ' unread from ' + state.feedCount + ' ' + feeds;
  }

  function updateToolbar() {
    // Demo posts are view-only; guests have nothing to refresh or mark.
    var actions = state.signedIn && !state.demo;
    els.refreshBtn.hidden = !actions;
    els.markAllBtn.hidden = !actions;
    els.demoNote.hidden = !state.demo;
  }

  function renderFailedNote() {
    var feeds = state.failedFeeds || [];
    if (!feeds.length) {
      els.failedNote.hidden = true;
      els.failedNote.replaceChildren();
      return;
    }
    var items = feeds.slice(0, 3).map(function (feed) {
      var p = document.createElement('p');
      p.textContent = 'Couldn’t refresh ' + feed.title +
        '. Its saved posts still show.';
      return p;
    });
    if (feeds.length > 3) {
      var more = document.createElement('p');
      more.textContent = 'And ' + (feeds.length - 3) + ' more feed' +
        (feeds.length - 3 === 1 ? '' : 's') + ' could not be refreshed.';
      items.push(more);
    }
    els.failedNote.replaceChildren.apply(els.failedNote, items);
    els.failedNote.hidden = false;
  }

  function renderList() {
    var list = els.postList;
    list.replaceChildren();
    state.posts.forEach(function (post) {
      var li = document.createElement('li');
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'post-row list-row w-full items-start text-left';
      row.dataset.postId = String(post.id);

      var dot = document.createElement('span');
      dot.className = 'feed-dot tone-' + (post.tone || 1);
      dot.setAttribute('aria-hidden', 'true');
      dot.textContent = feedInitial(post.feed_title);

      var col = document.createElement('div');
      col.className = 'min-w-0 flex-1';
      var title = document.createElement('p');
      title.className = 'font-serif text-body font-semibold leading-snug line-clamp-2';
      title.textContent = post.title;
      var meta = document.createElement('p');
      meta.className = 'mt-1 text-small text-muted';
      meta.textContent = post.feed_title + ', ' + formatDate(post.published_at);
      col.appendChild(title);
      col.appendChild(meta);

      row.appendChild(dot);
      row.appendChild(col);
      row.addEventListener('click', function () { openPreview(post); });
      li.appendChild(row);
      list.appendChild(li);
    });
  }

  function markRowRead(postId) {
    var row = els.postList.querySelector(
      '.post-row[data-post-id="' + postId + '"]');
    if (row) row.classList.add('opacity-60');
  }

  function render() {
    updateCountLine();
    updateToolbar();
    renderFailedNote();
    if (state.feedCount === 0) {
      show('stateEmpty');
      return;
    }
    if (state.posts.length === 0) {
      show('stateCaughtUp');
      return;
    }
    renderList();
    show('postList');
  }

  // ── Loading ────────────────────────────────────────────────────────────
  function loadPosts() {
    show('skeletonList');
    // The server decides demo mode: it only honours ?demo=1 inside staging,
    // so the response, not the URL, is the truth.
    return api('/api/posts' + (demoParam ? '?demo=1' : '')).then(function (data) {
      state.signedIn = data.signedIn;
      state.demo = data.demo;
      state.posts = data.posts;
      state.feedCount = data.feedCount;
      state.unreadCount = data.unreadCount;
      state.failedFeeds = data.failedFeeds || [];
      render();
    }, function () {
      show('stateError');
    });
  }

  // ── Preview panel ──────────────────────────────────────────────────────
  function feedDotEl(tone, letter) {
    var dot = document.createElement('span');
    dot.className = 'feed-dot tone-' + (tone || 1);
    dot.setAttribute('aria-hidden', 'true');
    dot.textContent = letter;
    return dot;
  }

  function openPreview(post) {
    // The list omits summaries; the panel is filled from the one-post
    // endpoint, falling back to the list's data if that fetch fails.
    api('/api/posts/' + post.id + (demoParam ? '?demo=1' : ''))
      .then(function (full) { render(full || post); })
      .catch(function () { render(post); });

    function render(full) {
      var letter = feedInitial(full.feed_title);
      var root = document.createElement('div');
      root.className = 'flex h-full flex-col bg-surface';

      var bar = document.createElement('div');
      bar.className = 'flex justify-end px-4 py-3';
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'btn-secondary';
      closeBtn.textContent = 'Close';
      bar.appendChild(closeBtn);

      var scroll = document.createElement('div');
      scroll.className = 'flex-1 overflow-y-auto px-5 pb-6';

      var source = document.createElement('div');
      source.className = 'flex items-center gap-2';
      var sourceDot = feedDotEl(full.tone, letter);
      sourceDot.classList.add('h-6', 'w-6');
      var sourceText = document.createElement('span');
      sourceText.className = 'text-small text-muted';
      sourceText.textContent = full.feed_title + ', ' + formatDate(full.published_at);
      source.appendChild(sourceDot);
      source.appendChild(sourceText);

      var heading = document.createElement('h2');
      heading.className = 'text-heading font-serif mt-4';
      heading.textContent = full.title;

      var body = document.createElement('div');
      body.className = 'article-body mt-3';
      var paragraphs = String(full.summary || '')
        .split(/\n{2,}/).filter(function (p) { return p.trim(); });
      if (!paragraphs.length) {
        var note = document.createElement('p');
        note.className = 'text-muted';
        note.textContent = 'This feed did not include preview text for this post.';
        body.appendChild(note);
      } else {
        // textContent, never innerHTML: feed content is untrusted.
        paragraphs.forEach(function (text) {
          var p = document.createElement('p');
          p.textContent = text.trim();
          body.appendChild(p);
        });
      }

      scroll.appendChild(source);
      scroll.appendChild(heading);
      scroll.appendChild(body);

      var foot = document.createElement('div');
      foot.className = 'border-t border-line px-5 py-4';
      if (isHttpLink(full.link)) {
        var link = document.createElement('a');
        link.href = full.link;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'btn-primary w-full';
        link.textContent = 'Open in browser';
        foot.appendChild(link);
      }

      root.appendChild(bar);
      root.appendChild(scroll);
      root.appendChild(foot);

      var panel = null;
      closeBtn.addEventListener('click', function () {
        if (panel) panel.dismiss();
      });
      if (un() && un().presentPanel) {
        panel = un().presentPanel({
          side: 'right',
          width: 'min(36rem, 100vw)',
          contentEl: root,
        });
      } else {
        // The kit failed to load: a plain sheet keeps the feature working.
        root.className = 'fixed inset-0 z-50 bg-surface';
        document.body.appendChild(root);
        panel = { dismiss: function () { root.remove(); } };
      }
    }

    // A post counts as read once it is opened. It stays in the list,
    // dimmed, until the list next loads. Demo posts are view-only.
    if (state.signedIn && !state.demo) {
      api('/api/posts/' + post.id + '/read', { method: 'POST' })
        .then(function () {
          markRowRead(post.id);
          state.unreadCount = Math.max(0, state.unreadCount - 1);
          updateCountLine();
        })
        .catch(function () { /* the list reload will settle the state */ });
    }
  }

  // ── Add feed ───────────────────────────────────────────────────────────
  var ADD_FEED_ERRORS = {
    invalid_url: 'That address doesn’t look right. Check it and try again.',
    unreachable: 'Couldn’t reach that address. Check it and try again.',
    not_a_feed: 'That address answered, but it doesn’t look like an RSS or Atom feed.',
    already_following: 'You already follow this feed.',
    too_many_feeds: 'You can follow up to 100 feeds.',
    account_required: 'Make an account to add feeds.',
  };

  function openAddFeed() {
    var form = document.createElement('form');
    form.className = 'flex flex-col gap-3 p-5';
    form.noValidate = true;

    var heading = document.createElement('h2');
    heading.className = 'text-heading font-serif';
    heading.textContent = 'Add feed';

    function labelled(text, input) {
      var label = document.createElement('label');
      label.className = 'text-small font-medium';
      label.textContent = text;
      label.appendChild(input);
      return label;
    }

    var urlInput = document.createElement('input');
    urlInput.className = 'field';
    urlInput.type = 'text';
    urlInput.inputMode = 'url';
    urlInput.autocomplete = 'off';
    urlInput.placeholder = 'e.g. https://example.com/feed.xml';
    urlInput.required = true;

    var nameInput = document.createElement('input');
    nameInput.className = 'field';
    nameInput.type = 'text';
    nameInput.autocomplete = 'off';
    nameInput.placeholder = 'e.g. Garden notes';

    var hint = document.createElement('p');
    hint.className = 'text-small text-muted';
    hint.textContent = 'Leave the name blank to use the feed’s own.';

    var errorLine = document.createElement('p');
    errorLine.className = 'text-small text-danger';
    errorLine.hidden = true;

    var actions = document.createElement('div');
    actions.className = 'mt-1 flex justify-end gap-2';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Cancel';
    var submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn-primary';
    submitBtn.textContent = 'Add feed';
    actions.appendChild(cancelBtn);
    actions.appendChild(submitBtn);

    form.appendChild(heading);
    form.appendChild(labelled('Feed address', urlInput));
    form.appendChild(labelled('Name (optional)', nameInput));
    form.appendChild(hint);
    form.appendChild(errorLine);
    form.appendChild(actions);

    var panel = null;
    cancelBtn.addEventListener('click', function () {
      if (panel) panel.dismiss();
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var url = urlInput.value.trim();
      if (!url) {
        errorLine.textContent = ADD_FEED_ERRORS.invalid_url;
        errorLine.hidden = false;
        return;
      }
      errorLine.hidden = true;
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding…';
      api('/api/feeds', { method: 'POST', body: { url: url, name: nameInput.value.trim() } })
        .then(function () {
          if (panel) panel.dismiss();
          toast('Feed added');
          if (state.demo) {
            // The demo list is view-only; the new feed belongs to the
            // visitor, so show their own list.
            location.assign('/');
          } else {
            loadPosts();
          }
        })
        .catch(function (err) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Add feed';
          errorLine.textContent = ADD_FEED_ERRORS[err.code] ||
            'Couldn’t add that feed. Check the address and try again.';
          errorLine.hidden = false;
        });
    });

    if (un() && un().presentModal) {
      panel = un().presentModal({ contentEl: form });
    } else {
      form.className = 'fixed inset-x-4 top-24 z-50 flex flex-col gap-3 rounded-xl bg-surface p-5';
      document.body.appendChild(form);
      panel = { dismiss: function () { form.remove(); } };
    }
  }

  // ── Mark all read ──────────────────────────────────────────────────────
  function markAllRead() {
    var ids = state.posts.map(function (post) { return post.id; });
    if (!ids.length) return;
    var confirmed = false;
    var ask = un() && un().alert
      ? un().alert({
          title: 'Mark ' + ids.length + ' posts as read?',
          buttons: [
            { label: 'Cancel', style: 'cancel' },
            { label: 'Mark all read', handler: function () { confirmed = true; } },
          ],
        })
      : Promise.resolve(window.confirm('Mark ' + ids.length + ' posts as read?') &&
          (confirmed = true));

    Promise.resolve(ask).then(function () {
      if (!confirmed) return;
      api('/api/posts/read-all', { method: 'POST', body: { ids: ids } })
        .then(function (result) {
          var marked = (result && result.marked) || 0;
          toast('Marked ' + marked + ' post' + (marked === 1 ? '' : 's') + ' as read');
          ids.forEach(markRowRead);
          state.unreadCount = 0;
          updateCountLine();
        })
        .catch(function () {
          toast('Couldn’t mark posts as read');
        });
    });
  }

  // ── Refresh ────────────────────────────────────────────────────────────
  function refresh(force) {
    els.refreshBtn.disabled = true;
    els.caughtUpRefreshBtn.disabled = true;
    api('/api/refresh', { method: 'POST', body: { force: Boolean(force) } })
      .then(function (result) {
        return loadPosts().then(function () {
          var added = (result && result.newPosts) || 0;
          if (added > 0) {
            toast(added + ' new post' + (added === 1 ? '' : 's'));
          }
        });
      })
      .catch(function () {
        toast('Couldn’t refresh right now');
      })
      .then(function () {
        els.refreshBtn.disabled = false;
        els.caughtUpRefreshBtn.disabled = false;
      });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────
  els.addFeedBtn.addEventListener('click', openAddFeed);
  els.emptyAddBtn.addEventListener('click', openAddFeed);
  els.markAllBtn.addEventListener('click', markAllRead);
  els.refreshBtn.addEventListener('click', function () { refresh(true); });
  els.caughtUpRefreshBtn.addEventListener('click', function () { refresh(true); });
  els.retryBtn.addEventListener('click', function () { loadPosts(); });

  // New posts are fetched when the app opens: one background refresh after
  // the first list, so the screen is never held up by the network. A
  // failed background refresh never replaces the loaded list.
  loadPosts().then(function () {
    if (demoParam || !state.signedIn) return;
    return api('/api/refresh', { method: 'POST', body: {} })
      .then(function () { return loadPosts(); })
      .catch(function () { /* the list already shows; Refresh exists */ });
  });
})();