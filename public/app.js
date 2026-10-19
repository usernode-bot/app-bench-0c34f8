/* Tier List: the ladder, the crowd view, dragging and the sheets. */
(function () {
  var params = new URLSearchParams(location.search);
  var URL_TOKEN = params.get('token') || '';
  var DEMO = params.get('demo') === '1';
  var TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];
  var VALUE = { S: 6, A: 5, B: 4, C: 3, D: 2, F: 1 };
  var CLS = { S: 's', A: 'a', B: 'b', C: 'c', D: 'd', F: 'f' };
  var DRAG_HOLD = 200;

  var state = {
    lists: [],
    viewer: null,
    list: null,
    view: 'mine',
    loading: true,
    error: null,
    openItem: null,
  };

  var $ = function (id) { return document.getElementById(id); };
  var ladder = $('ladder');
  var tray = $('tray');
  var trayLabel = $('tray-label');
  var listName = $('list-name');
  var listStat = $('list-stat');
  var pick = $('list-pick');
  var mainView = $('main-view');
  var emptyState = $('state-empty');
  var errorState = $('state-error');
  var overlay = $('overlay');
  var toastEl = $('toast');
  var hint = $('hint');

  function token() {
    return (window.usernode && window.usernode.token) || URL_TOKEN;
  }

  function api(path, options) {
    options = options || {};
    var url = new URL(path, location.origin);
    if (DEMO) url.searchParams.set('demo', '1');
    var headers = {};
    if (options.body) headers['Content-Type'] = 'application/json';
    if (token()) headers['x-usernode-token'] = token();
    if (options.headers) Object.assign(headers, options.headers);
    return fetch(url.toString(), {
      method: options.method || 'GET',
      headers: headers,
      body: options.body,
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          var err = new Error(body.error || 'Could not reach the server');
          err.status = res.status;
          throw err;
        });
      }
      if (res.status === 204) return null;
      return res.json();
    });
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function viewerName() {
    return state.viewer ? state.viewer.username : null;
  }

  function voterCount(items) {
    var seen = {};
    items.forEach(function (item) {
      (item.votes || []).forEach(function (v) { seen[v.username] = true; });
    });
    return Object.keys(seen).length;
  }

  function crowdTier(item) {
    var votes = item.votes || [];
    if (!votes.length) return null;
    var sum = votes.reduce(function (n, v) { return n + (VALUE[v.tier] || 0); }, 0);
    var index = 6 - Math.round(sum / votes.length);
    return TIERS[Math.max(0, Math.min(5, index))];
  }

  function stackedBar(item, mini) {
    var wrap = el(mini ? 'span' : 'div', mini ? 'minibar' : 'bar');
    var votes = item.votes || [];
    if (!mini) wrap.setAttribute('aria-label', 'How everyone voted');
    TIERS.forEach(function (t) {
      var n = votes.filter(function (v) { return v.tier === t; }).length;
      if (!n) return;
      var seg = el('span', CLS[t]);
      seg.style.flex = n + ' 1 0';
      if (!mini) seg.textContent = t;
      seg.title = t + ': ' + n;
      wrap.appendChild(seg);
    });
    return wrap;
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { toastEl.hidden = true; }, 4000);
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  function setSkeleton() {
    ladder.innerHTML = '';
    TIERS.forEach(function (t) {
      var tier = el('div', 'tier');
      tier.dataset.tier = t;
      tier.appendChild(el('div', 'lab ' + CLS[t], t));
      var items = el('div', 'items');
      items.appendChild(el('span', 'skeleton skit'));
      items.appendChild(el('span', 'skeleton skit'));
      tier.appendChild(items);
      ladder.appendChild(tier);
    });
    tray.innerHTML = '';
    trayLabel.hidden = true;
    tray.hidden = true;
    hint.hidden = true;
    $('view-toggle').hidden = false;
    setToggleDisabled(true);
    listName.textContent = '';
    listName.appendChild(el('span', 'skeleton sk-name'));
    listStat.textContent = '';
    listStat.appendChild(el('span', 'skeleton sk-stat'));
    pick.disabled = true;
    mainView.hidden = false;
    emptyState.hidden = true;
    errorState.hidden = true;
  }

  function render() {
    var list = state.list;
    if (!list) return;
    pick.disabled = false;
    $('view-toggle').hidden = false;
    setToggleDisabled(false);
    trayLabel.hidden = false;
    tray.hidden = false;
    hint.hidden = false;
    mainView.hidden = false;
    emptyState.hidden = true;
    errorState.hidden = true;
    $('add-item-btn').hidden = false;

    listName.textContent = list.name;
    if (list.demo) {
      listName.appendChild(document.createTextNode(' '));
      var note = el('span', null, '(Staging demo)');
      note.setAttribute('data-usernode-demo-note', '');
      listName.appendChild(note);
    }
    var items = list.items || [];
    var voters = voterCount(items);
    listStat.textContent = items.length + (items.length === 1 ? ' thing' : ' things') +
      ', ranked by ' + voters + (voters === 1 ? ' person' : ' people');

    var toggle = $('view-toggle');
    Array.prototype.forEach.call(toggle.children, function (span) {
      span.classList.toggle('on', span.dataset.view === state.view);
      span.setAttribute('aria-pressed', span.dataset.view === state.view ? 'true' : 'false');
    });

    ladder.innerHTML = '';
    var groups = {};
    TIERS.forEach(function (t) { groups[t] = []; });
    var unplaced = [];
    items.forEach(function (item) {
      if (state.view === 'crowd') {
        var ct = crowdTier(item);
        if (ct) groups[ct].push(item);
        else unplaced.push(item);
      } else if (item.your_tier) {
        groups[item.your_tier].push(item);
      } else {
        unplaced.push(item);
      }
    });

    TIERS.forEach(function (t) {
      var tier = el('div', 'tier');
      tier.dataset.tier = t;
      tier.appendChild(el('div', 'lab ' + CLS[t], t));
      var band = el('div', 'items');
      if (groups[t].length) {
        groups[t].forEach(function (item) { band.appendChild(itemEl(item)); });
      } else {
        band.appendChild(el('p', 'empty', state.view === 'crowd' ? 'Nothing here yet' : 'Drag an item here'));
      }
      tier.appendChild(band);
      ladder.appendChild(tier);
    });

    trayLabel.textContent = state.view === 'crowd' ? 'No votes yet' : 'Not ranked by you yet';
    tray.innerHTML = '';
    if (unplaced.length) {
      unplaced.forEach(function (item) { tray.appendChild(itemEl(item)); });
    } else {
      tray.appendChild(el('p', 'empty',
        items.length === 0 ? 'Add the first thing to rank'
          : state.view === 'crowd' ? 'Everyone has voted' : 'Everything is ranked'));
    }
    hint.textContent = state.view === 'crowd'
      ? 'Tap an item to see how everyone voted.'
      : 'Drag an item into a tier to vote. Drag again to change it. Tap an item to see how everyone voted.';
  }

  function itemEl(item) {
    var box = el('div', 'it');
    box.dataset.item = item.id;
    box.tabIndex = 0;
    box.setAttribute('role', 'button');
    box.setAttribute('aria-label', item.name + ', open how everyone voted');
    box.appendChild(el('span', null, item.name));
    var line = el('i');
    if (state.view === 'crowd') {
      var ct = crowdTier(item);
      var n = (item.votes || []).length;
      if (ct) {
        line.appendChild(stackedBar(item, true));
        line.appendChild(document.createTextNode(' ' + n + (n === 1 ? ' vote' : ' votes')));
      } else {
        line.textContent = 'No votes yet';
      }
    } else if (item.your_tier) {
      var other = crowdTier(item);
      line.textContent = other ? 'Crowd: ' + other : '';
    } else {
      line.textContent = item.added_by === viewerName() ? 'Added by you' : 'Added by ' + item.added_by;
    }
    if (line.childNodes.length || line.textContent) box.appendChild(line);

    box.addEventListener('click', function () {
      if (box.dataset.dragged === '1') return;
      openItem(item.id);
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openItem(item.id);
      }
    });
    if (state.view === 'mine') attachDrag(box, item);
    return box;
  }

  // ── Dragging ───────────────────────────────────────────────────────────

  function attachDrag(box, item) {
    box.addEventListener('pointerdown', function (e) {
      if (e.button && e.button !== 0) return;
      var startX = e.clientX;
      var startY = e.clientY;
      var active = false;
      var ghost = null;
      var overEl = null;
      var holdTimer = null;
      var suppressClick = false;

      function start() {
        if (active) return;
        active = true;
        suppressClick = true;
        box.classList.add('dragging');
        ghost = box.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.style.width = box.offsetWidth + 'px';
        document.body.appendChild(ghost);
        move(e);
      }

      function targetAt(x, y) {
        var node = document.elementFromPoint(x, y);
        if (!node || !node.closest) return null;
        return node.closest('[data-tier]') || node.closest('#tray');
      }

      function move(ev) {
        if (!active) return;
        ghost.style.left = ev.clientX + 'px';
        ghost.style.top = ev.clientY + 'px';
        var next = targetAt(ev.clientX, ev.clientY);
        if (overEl && overEl !== next) overEl.classList.remove('drop-over');
        overEl = next;
        if (overEl) overEl.classList.add('drop-over');
      }

      function cleanup() {
        active = false;
        clearTimeout(holdTimer);
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', cleanup);
        box.classList.remove('dragging');
        if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost);
        if (overEl) overEl.classList.remove('drop-over');
        if (suppressClick) {
          box.dataset.dragged = '1';
          setTimeout(function () { delete box.dataset.dragged; }, 50);
        }
      }

      function onMove(ev) {
        var distance = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (!active) {
          if (distance > (e.pointerType === 'mouse' ? 5 : 10)) {
            clearTimeout(holdTimer);
            if (e.pointerType === 'mouse') start();
            else cleanup();
          }
          return;
        }
        ev.preventDefault();
        move(ev);
      }

      function onUp(ev) {
        var wasActive = active;
        var dropTarget = wasActive ? targetAt(ev.clientX, ev.clientY) : null;
        cleanup();
        if (!wasActive) return;
        var tier = dropTarget && dropTarget.dataset ? dropTarget.dataset.tier : null;
        if (tier) vote(item.id, tier);
        else if (dropTarget && dropTarget.id === 'tray' && item.your_tier) unvote(item.id);
      }

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', cleanup);
      holdTimer = setTimeout(start, DRAG_HOLD);
    });
  }

  // ── Voting ─────────────────────────────────────────────────────────────

  function findItem(id) {
    if (!state.list) return null;
    return state.list.items.filter(function (i) { return String(i.id) === String(id); })[0] || null;
  }

  function upsertLocalVote(item, tier) {
    var name = viewerName();
    item.votes = (item.votes || []).filter(function (v) { return v.username !== name; });
    if (tier) item.votes.push({ username: name, tier: tier });
    item.your_tier = tier || null;
  }

  function vote(itemId, tier) {
    var item = findItem(itemId);
    if (!item || item.your_tier === tier) return;
    var before = { tier: item.your_tier, votes: item.votes.slice() };
    upsertLocalVote(item, tier);
    render();
    if (state.openItem === itemId) renderItemSheet();
    api('/api/items/' + itemId + '/vote', {
      method: 'PUT',
      body: JSON.stringify({ tier: tier }),
    }).catch(function () {
      item.your_tier = before.tier;
      item.votes = before.votes;
      render();
      if (state.openItem === itemId) renderItemSheet();
      toast("Couldn't save your vote. Try again.");
    });
  }

  function unvote(itemId) {
    var item = findItem(itemId);
    if (!item) return;
    var before = { tier: item.your_tier, votes: item.votes.slice() };
    upsertLocalVote(item, null);
    render();
    if (state.openItem === itemId) renderItemSheet();
    api('/api/items/' + itemId + '/vote', { method: 'DELETE' }).catch(function () {
      item.your_tier = before.tier;
      item.votes = before.votes;
      render();
      if (state.openItem === itemId) renderItemSheet();
      toast("Couldn't take your vote away. Try again.");
    });
  }

  // ── The item sheet ─────────────────────────────────────────────────────

  function renderItemSheet() {
    var item = findItem(state.openItem);
    if (!item) { closeOverlay(); return; }
    $('item-title').textContent = item.name;
    $('item-by').textContent = item.added_by === viewerName() ? 'Added by you' : 'Added by ' + item.added_by;
    var n = (item.votes || []).length;
    $('item-crowd-label').textContent = 'Crowd, ' + n + (n === 1 ? ' vote' : ' votes');
    var bar = $('item-bar');
    bar.innerHTML = '';
    if (n) {
      var pieces = stackedBar(item, false);
      while (pieces.firstChild) bar.appendChild(pieces.firstChild);
    }
    var ct = crowdTier(item);
    $('item-crowd-tier').textContent = ct ? 'Crowd tier: ' + ct : 'No votes yet';

    var voteBox = $('item-vote');
    voteBox.innerHTML = '';
    TIERS.forEach(function (t) {
      var b = el('button', item.your_tier === t ? 'on ' + CLS[t] : '', t);
      b.type = 'button';
      b.setAttribute('aria-pressed', item.your_tier === t ? 'true' : 'false');
      b.addEventListener('click', function () { vote(item.id, t); });
      voteBox.appendChild(b);
    });

    var voters = $('item-voters');
    voters.innerHTML = '';
    var rows = (item.votes || []).slice().sort(function (a, b) {
      if (a.username === viewerName()) return -1;
      if (b.username === viewerName()) return 1;
      return a.username.localeCompare(b.username);
    });
    if (!rows.length) {
      voters.appendChild(el('div', 'list-row', 'No votes yet'));
    }
    rows.forEach(function (v) {
      var row = el('div', 'list-row');
      row.appendChild(el('span', null, v.username === viewerName() ? 'You' : v.username));
      row.appendChild(el('span', 'chip ' + CLS[v.tier], v.tier));
      voters.appendChild(row);
    });
    $('item-remove').hidden = item.added_by !== viewerName();
    $('item-report-note').hidden = true;
  }

  function openItem(id) {
    state.openItem = id;
    renderItemSheet();
    openSheet('item');
  }

  // ── Sheets ─────────────────────────────────────────────────────────────

  function openSheet(name) {
    overlay.hidden = false;
    Array.prototype.forEach.call(overlay.querySelectorAll('[data-sheet]'), function (sheet) {
      sheet.hidden = sheet.dataset.sheet !== name;
    });
    var first = overlay.querySelector('[data-sheet="' + name + '"] input');
    if (first) setTimeout(function () { first.focus(); }, 30);
  }

  function closeOverlay() {
    overlay.hidden = true;
    state.openItem = null;
  }

  function renderListsSheet() {
    var rows = $('lists-rows');
    rows.innerHTML = '';
    if (!state.lists.length) {
      rows.appendChild(el('div', 'list-row', 'No lists yet'));
      return;
    }
    state.lists.forEach(function (list) {
      var row = el('div', 'list-row');
      var pickBtn = el('button', 'pick');
      pickBtn.type = 'button';
      pickBtn.style.flex = '1';
      pickBtn.appendChild(el('span', null, list.name));
      if (list.demo) {
        pickBtn.appendChild(document.createTextNode(' '));
        var note = el('span', null, '(Staging demo)');
        note.setAttribute('data-usernode-demo-note', '');
        pickBtn.appendChild(note);
      }
      pickBtn.addEventListener('click', function () { selectList(list.id); closeOverlay(); });
      row.appendChild(pickBtn);
      if (state.viewer && list.created_by === state.viewer.username) {
        var del = el('button', 'x');
        del.type = 'button';
        del.setAttribute('aria-label', 'Delete ' + list.name);
        del.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
        del.addEventListener('click', function () { deleteList(list); });
        row.appendChild(del);
      }
      rows.appendChild(row);
    });
  }

  // ── Loading the lists ──────────────────────────────────────────────────

  function loadLists(selectId) {
    state.loading = true;
    setSkeleton();
    return api('/api/lists').then(function (data) {
      state.lists = data.lists || [];
      state.viewer = data.viewer || null;
      state.loading = false;
      if (!state.lists.length) {
        mainView.hidden = true;
        emptyState.hidden = false;
        errorState.hidden = true;
        $('add-item-btn').hidden = true;
        return null;
      }
      var chosen = null;
      if (selectId) {
        chosen = state.lists.filter(function (l) { return String(l.id) === String(selectId); })[0];
      }
      if (!chosen && DEMO) {
        chosen = state.lists.filter(function (l) {
          return l.demo && l.name === 'Bay Area restaurants';
        })[0] || state.lists.filter(function (l) { return l.demo; })[0];
      }
      if (!chosen) chosen = state.lists[0];
      return selectList(chosen.id, true);
    }).catch(function () {
      state.loading = false;
      mainView.hidden = true;
      emptyState.hidden = true;
      errorState.hidden = false;
      $('add-item-btn').hidden = true;
      overlay.hidden = true;
    });
  }

  function selectList(id, fromLoad) {
    state.openItem = null;
    if (!fromLoad) setSkeleton();
    return api('/api/lists/' + id).then(function (data) {
      state.list = data.list;
      state.viewer = data.viewer || state.viewer;
      render();
    }).catch(function () {
      state.list = null;
      mainView.hidden = true;
      emptyState.hidden = true;
      errorState.hidden = false;
      $('add-item-btn').hidden = true;
    });
  }

  // ── Actions ────────────────────────────────────────────────────────────

  function deleteList(list) {
    if (!window.confirm('Delete "' + list.name + '" and its votes?')) return;
    api('/api/lists/' + list.id, { method: 'DELETE' }).then(function () {
      state.lists = state.lists.filter(function (l) { return l.id !== list.id; });
      renderListsSheet();
      if (state.list && state.list.id === list.id) {
        state.list = null;
        if (state.lists.length) selectList(state.lists[0].id);
        else {
          mainView.hidden = true;
          emptyState.hidden = false;
        }
      }
    }).catch(function (err) {
      toast(err.status === 403 ? 'Only whoever started this list can delete it.' : "Couldn't delete the list. Try again.");
    });
  }

  function addItem(name) {
    if (!state.list) return Promise.reject(new Error('No list'));
    return api('/api/lists/' + state.list.id + '/items', {
      method: 'POST',
      body: JSON.stringify({ name: name }),
    }).then(function (data) {
      state.list.items.push(data.item);
      closeOverlay();
      render();
    });
  }

  function createList(name) {
    return api('/api/lists', {
      method: 'POST',
      body: JSON.stringify({ name: name }),
    }).then(function (data) {
      closeOverlay();
      return loadLists(data && data.list ? data.list.id : null);
    });
  }

  // ── Wiring ─────────────────────────────────────────────────────────────

  $('add-item-btn').addEventListener('click', function () {
    if (!state.list) {
      openSheet('new-list');
      return;
    }
    $('add-item-name').value = '';
    openSheet('add-item');
  });
  $('start-list').addEventListener('click', function () {
    $('new-list-name').value = '';
    openSheet('new-list');
  });
  $('list-pick').addEventListener('click', function () {
    renderListsSheet();
    openSheet('lists');
  });
  $('retry').addEventListener('click', function () {
    loadLists(state.list ? state.list.id : null);
  });

  var toggle = $('view-toggle');
  function setToggleDisabled(disabled) {
    toggle.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    Array.prototype.forEach.call(toggle.children, function (span) {
      span.tabIndex = disabled ? -1 : 0;
    });
  }
  function setView(view) {
    if (toggle.getAttribute('aria-disabled') === 'true') return;
    state.view = view;
    if (state.list) render();
  }
  Array.prototype.forEach.call(toggle.children, function (span) {
    span.addEventListener('click', function () { setView(span.dataset.view); });
    span.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setView(span.dataset.view);
      }
    });
  });

  overlay.addEventListener('click', function (e) {
    if (e.target === overlay || e.target.classList.contains('app')) closeOverlay();
  });
  Array.prototype.forEach.call(overlay.querySelectorAll('[data-close]'), function (btn) {
    btn.addEventListener('click', closeOverlay);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !overlay.hidden) closeOverlay();
  });
  overlay.addEventListener('click', function (e) {
    var open = e.target.closest ? e.target.closest('[data-open]') : null;
    if (!open) return;
    var name = open.dataset.open;
    if (name === 'new-list') {
      $('new-list-name').value = '';
      openSheet('new-list');
    }
  });

  $('add-item-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('add-item-name');
    var name = input.value.trim();
    if (!name) return;
    var btn = e.target.querySelector('[type="submit"]');
    btn.disabled = true;
    addItem(name).catch(function (err) {
      toast(err.status === 401 ? 'Make an account to add items.' : "Couldn't add the item. Try again.");
    }).then(function () { btn.disabled = false; });
  });

  $('new-list-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('new-list-name');
    var name = input.value.trim();
    if (!name) return;
    var btn = e.target.querySelector('[type="submit"]');
    btn.disabled = true;
    createList(name).catch(function (err) {
      toast(err.status === 401 ? 'Make an account to start a list.' : "Couldn't start the list. Try again.");
      btn.disabled = false;
    });
  });

  $('item-remove').addEventListener('click', function () {
    var item = findItem(state.openItem);
    if (!item) return;
    api('/api/items/' + item.id, { method: 'DELETE' }).then(function () {
      state.list.items = state.list.items.filter(function (i) { return i.id !== item.id; });
      closeOverlay();
      render();
    }).catch(function () {
      toast("Couldn't remove the item. Try again.");
    });
  });

  $('item-report').addEventListener('click', function () {
    var item = findItem(state.openItem);
    if (!item) return;
    api('/api/items/' + item.id + '/report', { method: 'POST' }).then(function () {
      $('item-report-note').hidden = false;
    }).catch(function () {
      toast("Couldn't send the report. Try again.");
    });
  });

  loadLists();
})();
