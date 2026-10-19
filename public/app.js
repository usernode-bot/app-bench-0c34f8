/* Tier List — the board's page logic.
 *
 * One screen with one job: ranking. Drag a card into a tier row in My view
 * (or tap it and use the S to F buttons), see the crowd's average in Crowd
 * view, and open any card to see how everyone voted.
 */
(function () {
  'use strict';

  var TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];
  var params = new URLSearchParams(window.location.search);
  var DEMO = params.get('demo') === '1';
  var TOKEN = params.get('token') || (window.usernode && window.usernode.token) || '';

  var el = {
    listName: document.getElementById('listName'),
    pickerBtn: document.getElementById('listPickerBtn'),
    boardSub: document.getElementById('boardSub'),
    viewMine: document.getElementById('viewMine'),
    viewCrowd: document.getElementById('viewCrowd'),
    listPanel: document.getElementById('listPanel'),
    listsBox: document.getElementById('listsBox'),
    newListForm: document.getElementById('newListForm'),
    newListName: document.getElementById('newListName'),
    newNoun: document.getElementById('newNoun'),
    newListCancel: document.getElementById('newListCancel'),
    board: document.getElementById('board'),
    boardState: document.getElementById('boardState'),
    trayLabel: document.getElementById('trayLabel'),
    tray: document.getElementById('tray'),
    addForm: document.getElementById('addForm'),
    addFormTitle: document.querySelector('#addForm .ct'),
    addName: document.getElementById('addName'),
    addSubmit: document.getElementById('addSubmit'),
    addCancel: document.getElementById('addCancel'),
    addBtn: document.getElementById('addBtn'),
    addBtnLabel: document.getElementById('addBtnLabel'),
    detail: document.getElementById('detail'),
    toast: document.getElementById('toast')
  };

  var state = {
    status: 'loading', // loading | ready | error
    lists: [],
    listId: null,
    data: null, // { list, items, viewerId, viewerName }
    view: 'mine',
    openId: null,
    addOpen: false,
    panelOpen: false
  };

  var drag = null;
  var suppressClick = false;
  var toastTimer = null;

  // ── Requests ───────────────────────────────────────────────────────────

  function withDemo(url) {
    if (!DEMO) return url;
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'demo=1';
  }

  function api(url, options) {
    options = options || {};
    var headers = { 'x-usernode-token': TOKEN };
    if (options.body) headers['Content-Type'] = 'application/json';
    return fetch(withDemo(url), {
      method: options.method || 'GET',
      headers: headers,
      body: options.body
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && data.error) || 'HTTP ' + res.status);
          err.status = res.status;
          err.code = data && data.error;
          throw err;
        }
        return data;
      });
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function displayName(username) {
    if (!username) return 'Someone';
    var name = String(username);
    if (name.indexOf('staging-demo-') === 0) {
      name = name.slice('staging-demo-'.length);
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
    return name;
  }

  function currentList() {
    if (!state.data) return null;
    return state.data.list;
  }

  function noun() {
    var list = currentList();
    return (list && list.noun) || 'item';
  }

  function plural(word) {
    return /s$/.test(word) ? word : word + 's';
  }

  function tierToken(tier) {
    return 'rgb(var(--tier-' + String(tier).toLowerCase() + '))';
  }

  function crowdTier(item) {
    if (!item.votes || !item.votes.length) return null;
    var sum = 0;
    for (var i = 0; i < item.votes.length; i++) {
      var idx = TIERS.indexOf(item.votes[i].tier);
      if (idx < 0) return null;
      sum += idx;
    }
    // Rounded to the nearest tier, a tie going to the better one.
    var mean = sum / item.votes.length;
    return TIERS[Math.min(TIERS.length - 1, Math.floor(mean + 0.5 - 1e-9))];
  }

  function voterName(vote) {
    var viewerId = state.data && state.data.viewerId;
    if (viewerId != null && String(vote.userId) === String(viewerId)) return 'You';
    return displayName(vote.username);
  }

  function sortedVotes(item) {
    return item.votes.slice().sort(function (a, b) {
      var av = voterName(a) === 'You' ? '' : voterName(a).toLowerCase();
      var bv = voterName(b) === 'You' ? '' : voterName(b).toLowerCase();
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
  }

  function addedByLabel(item) {
    var viewerId = state.data && state.data.viewerId;
    if (viewerId != null && String(item.addedById) === String(viewerId)) return 'You';
    return displayName(item.addedByName);
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 4000);
  }

  // ── Loading ────────────────────────────────────────────────────────────

  function loadAll() {
    state.status = 'loading';
    state.data = null;
    state.openId = null;
    render();
    api('/api/lists')
      .then(function (res) {
        state.lists = res.lists || [];
        var preferred = null;
        if (DEMO) {
          var demoList = state.lists.filter(function (l) { return l.isDemo; })[0];
          if (demoList) preferred = demoList.id;
        }
        if (preferred == null && state.lists.length) preferred = state.lists[0].id;
        state.listId = preferred;
        if (preferred == null) {
          state.status = 'ready';
          render();
          return null;
        }
        return loadList(preferred, true);
      })
      .catch(function () {
        state.status = 'error';
        render();
      });
  }

  function loadList(id, keepStatus) {
    if (!keepStatus) {
      state.status = 'loading';
      state.openId = null;
      render();
    }
    return api('/api/lists/' + id)
      .then(function (res) {
        state.listId = res.list.id;
        state.data = res;
        state.status = 'ready';
        render();
      })
      .catch(function () {
        state.status = 'error';
        render();
      });
  }

  function retry() {
    loadAll();
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  function render() {
    renderHeader();
    renderBoard();
    renderAdd();
    renderDetail();
    renderPanel();
  }

  function renderHeader() {
    var list = currentList();
    var name = list ? list.name : 'Tier List';
    el.listName.innerHTML = esc(name) + (list && list.isDemo
      ? ' (<span data-usernode-demo-note>Staging demo</span>)'
      : '');
    el.pickerBtn.setAttribute('aria-expanded', String(state.panelOpen));

    if (state.status === 'loading') {
      el.boardSub.innerHTML = '<span class="skeleton" style="display:inline-block;width:150px;height:12px"></span>';
    } else if (state.status === 'error') {
      el.boardSub.textContent = '';
    } else if (!list || !state.data) {
      el.boardSub.textContent = '';
    } else {
      var items = state.data.items;
      var voters = {};
      items.forEach(function (item) {
        item.votes.forEach(function (v) { voters[String(v.userId)] = true; });
      });
      var count = Object.keys(voters).length;
      el.boardSub.textContent = items.length
        ? count + ' ' + (count === 1 ? 'person' : 'people') + ' voting · ' +
          items.length + ' ' + plural(list.noun)
        : '0 ' + plural(list.noun);
    }

    el.viewMine.classList.toggle('on', state.view === 'mine');
    el.viewCrowd.classList.toggle('on', state.view === 'crowd');
    el.viewMine.setAttribute('aria-selected', String(state.view === 'mine'));
    el.viewCrowd.setAttribute('aria-selected', String(state.view === 'crowd'));
  }

  function skeletonChip() {
    return '<span class="skel-chip">' +
      '<span class="skeleton" style="display:block;width:66%;height:10px"></span>' +
      '<span class="skeleton" style="display:block;width:42%;height:8px"></span></span>';
  }

  function rowItems(tier) {
    var items = (state.data && state.data.items) || [];
    if (state.view === 'mine') {
      return items.filter(function (i) { return i.myTier === tier; });
    }
    return items.filter(function (i) {
      return i.votes.length && crowdTier(i) === tier;
    });
  }

  function chipNames(item, tier) {
    if (state.view === 'mine') {
      var voters = item.votes.filter(function (v) { return v.tier === tier; });
      var names = sortedVotes({ votes: voters }).map(voterName);
      return names.join(', ');
    }
    return sortedVotes(item).map(voterName).join(', ');
  }

  function chipHtml(item, tier) {
    var selected = state.openId === item.id ? ' sel' : '';
    var names = chipNames(item, tier);
    return '<button type="button" class="chip' + selected + '" data-item-id="' + item.id +
      '" style="border-left-color:' + tierToken(tier) + '"' +
      ' aria-label="' + esc(item.name + (names ? ', ' + names : '')) + '">' +
      '<span>' + esc(item.name) + '</span>' +
      (names ? '<small>' + esc(names) + '</small>' : '') +
      '</button>';
  }

  function trayItems() {
    var items = (state.data && state.data.items) || [];
    if (state.view === 'mine') {
      return items.filter(function (i) { return !i.myTier; });
    }
    return items.filter(function (i) { return !i.votes.length; });
  }

  function trayChipHtml(item) {
    var selected = state.openId === item.id ? ' sel' : '';
    return '<button type="button" class="chip' + selected + '" data-item-id="' + item.id + '"' +
      ' aria-label="' + esc(item.name + ', added by ' + addedByLabel(item)) + '">' +
      '<span>' + esc(item.name) + '</span>' +
      '<small>Added by ' + esc(addedByLabel(item)) + '</small></button>';
  }

  function renderBoard() {
    var loading = state.status === 'loading';
    var failed = state.status === 'error';
    var empty = !loading && !failed && state.data && state.data.items.length === 0;

    el.board.hidden = failed;
    el.trayLabel.hidden = failed || empty;
    el.tray.hidden = failed || empty;
    el.detail.hidden = failed;

    TIERS.forEach(function (tier) {
      var box = document.getElementById('row-' + tier);
      if (loading) {
        box.innerHTML = skeletonChip() + skeletonChip();
        return;
      }
      if (failed || !state.data) { box.innerHTML = ''; return; }
      var items = rowItems(tier);
      if (!items.length) {
        box.innerHTML = state.data.items.length
          ? (state.view === 'mine' ? '<span class="hint">Drag here</span>' : '')
          : '';
        return;
      }
      box.innerHTML = items.map(function (item) { return chipHtml(item, tier); }).join('');
    });

    if (loading) {
      el.tray.innerHTML = skeletonChip() + skeletonChip();
      el.trayLabel.textContent = 'Not placed by you yet';
    } else if (failed) {
      el.tray.innerHTML = '';
    } else {
      var waiting = trayItems();
      el.trayLabel.textContent = (state.view === 'mine' ? 'Not placed by you yet' : 'Nobody has voted yet') +
        (waiting.length ? ' (' + waiting.length + ')' : '');
      el.tray.innerHTML = waiting.length
        ? waiting.map(trayChipHtml).join('')
        : '<span class="hint">' + (state.view === 'mine'
            ? 'Everything here has your tier'
            : 'Everything here has a vote') + '</span>';
    }

    renderBoardState(loading, failed, empty);
  }

  function renderBoardState(loading, failed, empty) {
    if (failed) {
      el.boardState.innerHTML =
        '<div class="state-error" role="alert">' +
        '<div class="ct">Could not load the board</div>' +
        '<div class="cs">The tier board did not load. Your lists and votes are still saved; check your connection and try again.</div>' +
        '<button type="button" class="btn-secondary" data-act="retry">Retry</button>' +
        '</div>';
      return;
    }
    if (empty) {
      var word = noun();
      el.boardState.innerHTML =
        '<div class="state-empty">' +
        '<div class="ct">Nothing to rank yet</div>' +
        '<div class="cs">Add the first ' + esc(word) + ' to this list, then drag it into a tier.</div>' +
        (state.addOpen ? '' :
          '<button type="button" class="btn-primary" data-act="open-add">Add a ' + esc(word) + '</button>') +
        '</div>';
      return;
    }
    el.boardState.innerHTML = '';
  }

  function renderAdd() {
    var ready = state.status === 'ready' && state.data;
    var empty = ready && state.data.items.length === 0;
    var word = noun();
    el.addFormTitle.textContent = 'Add a ' + word;
    el.addBtnLabel.textContent = 'Add a ' + word;
    el.addForm.hidden = !state.addOpen;
    el.addBtn.hidden = !ready || state.addOpen || empty;
  }

  function renderDetail() {
    var item = null;
    if (state.status === 'ready' && state.data && state.openId != null) {
      item = state.data.items.filter(function (i) { return i.id === state.openId; })[0];
    }
    if (!item) {
      state.openId = null;
      el.detail.innerHTML = '';
      return;
    }

    var crowd = crowdTier(item);
    var votes = sortedVotes(item);
    var voteRows = votes.map(function (v) {
      return '<div class="vote"><span>' + esc(voterName(v)) + '</span>' +
        '<span class="badge" style="background:' + tierToken(v.tier) + '">' + esc(v.tier) + '</span></div>';
    }).join('');
    if (!votes.length) {
      voteRows = '<div class="vote"><span>No votes yet</span><span></span></div>';
    }
    var totalRow = '<div class="vote tot"><span>Crowd average</span>' +
      (crowd
        ? '<span class="badge" style="background:' + tierToken(crowd) + '">' + crowd + '</span>'
        : '<span class="cs">No votes yet</span>') +
      '</div>';

    var pick = TIERS.map(function (t) {
      var on = item.myTier === t;
      return '<div role="button" tabindex="0" data-act="pick" data-tier="' + t + '"' +
        ' class="' + (on ? 'on' : '') + '"' + (on ? ' style="background:' + tierToken(t) + '"' : '') +
        ' aria-pressed="' + on + '"' +
        ' aria-label="Put ' + esc(item.name) + ' in tier ' + t + '">' + t + '</div>';
    }).join('');

    var quiet = '';
    if (item.myTier) {
      quiet += '<button type="button" data-act="clear">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>' +
        'Clear my vote</button>';
    }
    if (item.canRemove) {
      quiet += '<button type="button" data-act="remove">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>' +
        'Remove</button>';
    } else {
      quiet += '<button type="button" data-act="report">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>' +
        'Report</button>';
    }

    el.detail.innerHTML =
      '<div class="section-label">' + esc(item.name) + '</div>' +
      '<div class="card">' +
      '<div class="ct">' + esc(item.name) + '</div>' +
      '<div class="cs">Added by ' + esc(addedByLabel(item)) + ' · ' +
        votes.length + ' ' + (votes.length === 1 ? 'vote' : 'votes') + '</div>' +
      '<div class="pick" role="group" aria-label="Your tier">' + pick + '</div>' +
      '<div class="cs">Your tier. Tap one, or drag the card on the board.</div>' +
      '<div style="margin-top:12px">' + voteRows + totalRow + '</div>' +
      '<div class="quiet">' + quiet + '</div>' +
      '</div>';
  }

  function renderPanel() {
    el.listPanel.hidden = !state.panelOpen;
    el.pickerBtn.setAttribute('aria-expanded', String(state.panelOpen));
    if (!state.panelOpen) return;

    var viewerId = state.data && state.data.viewerId;
    var rows = state.lists.map(function (l) {
      var isCurrent = l.id === state.listId;
      return '<button type="button" class="listline" data-act="switch-list" data-list-id="' + l.id + '">' +
        '<span class="' + (isCurrent ? 'on' : '') + '">' + esc(l.name) + (l.isDemo
          ? ' (<span data-usernode-demo-note>Staging demo</span>)' : '') + '</span>' +
        '<span class="cs">' + (l.itemCount || 0) + ' ' + plural(l.noun) + '</span>' +
        '</button>';
    }).join('');

    var list = currentList();
    var actions = '';
    if (list && viewerId != null) {
      if (String(list.createdById) === String(viewerId)) {
        actions = '<button type="button" class="textbtn" data-act="remove-list">' +
          'Remove this list</button>';
      } else {
        actions = '<button type="button" class="textbtn" data-act="report-list">' +
          'Report this list</button>';
      }
    }

    el.listsBox.innerHTML = rows + (actions ? '<div style="margin-top:8px">' + actions + '</div>' : '');
  }

  // ── Actions ────────────────────────────────────────────────────────────

  function setVote(itemId, tier) {
    if (!state.data) return;
    var item = state.data.items.filter(function (i) { return i.id === Number(itemId); })[0];
    if (!item) return;
    if (!state.data.viewerId) {
      toast('Make an account to add your tier.');
      return;
    }
    if (item.myTier === tier) return;

    var beforeTier = item.myTier;
    var beforeVotes = item.votes.slice();
    var viewerId = state.data.viewerId;

    item.myTier = tier;
    item.votes = item.votes.filter(function (v) {
      return String(v.userId) !== String(viewerId);
    });
    if (tier) {
      item.votes.push({ userId: viewerId, username: state.data.viewerName, tier: tier });
    }
    render();

    var request = tier
      ? api('/api/items/' + item.id + '/vote', {
          method: 'PUT',
          body: JSON.stringify({ tier: tier })
        })
      : api('/api/items/' + item.id + '/vote', { method: 'DELETE' });

    request.catch(function () {
      item.myTier = beforeTier;
      item.votes = beforeVotes;
      render();
      toast('Could not save your tier. Tap the card and try again.');
    });
  }

  function bumpListCount(delta) {
    state.lists.forEach(function (l) {
      if (l.id === state.listId) l.itemCount = Math.max(0, (l.itemCount || 0) + delta);
    });
  }

  function removeItem(item) {
    if (!window.confirm('Remove "' + item.name + '" from this list for everyone?')) return;
    api('/api/items/' + item.id, { method: 'DELETE' })
      .then(function () {
        state.data.items = state.data.items.filter(function (i) { return i.id !== item.id; });
        bumpListCount(-1);
        if (state.openId === item.id) state.openId = null;
        render();
        toast('Removed "' + item.name + '".');
      })
      .catch(function () {
        toast('Could not remove it. Try again.');
      });
  }

  function openAdd() {
    if (state.status !== 'ready') return;
    state.addOpen = true;
    render();
    el.addName.value = '';
    setTimeout(function () { el.addName.focus(); }, 0);
  }

  function closeAdd() {
    state.addOpen = false;
    el.addName.value = '';
    render();
  }

  function submitAdd(event) {
    event.preventDefault();
    var name = el.addName.value.trim();
    if (!name) return;
    el.addSubmit.disabled = true;
    api('/api/lists/' + state.listId + '/items', {
      method: 'POST',
      body: JSON.stringify({ name: name })
    })
      .then(function (res) {
        state.data.items.push(res.item);
        bumpListCount(1);
        state.addOpen = false;
        el.addName.value = '';
        el.addSubmit.disabled = false;
        state.openId = null;
        render();
        toast('Added "' + res.item.name + '" to your tray.');
      })
      .catch(function (err) {
        el.addSubmit.disabled = false;
        if (err.code === 'duplicate_name') {
          toast('This list already has a ' + noun() + ' with that name.');
        } else {
          toast('Could not add it. Try again.');
        }
      });
  }

  function submitNewList(event) {
    event.preventDefault();
    var name = el.newListName.value.trim();
    var word = el.newNoun.value.trim() || 'item';
    if (!name) return;
    api('/api/lists', {
      method: 'POST',
      body: JSON.stringify({ name: name, noun: word })
    })
      .then(function (res) {
        res.list.itemCount = 0;
        state.lists.push(res.list);
        el.newListName.value = '';
        el.newNoun.value = '';
        state.panelOpen = false;
        return loadList(res.list.id);
      })
      .catch(function () {
        toast('Could not start the list. Try again.');
      });
  }

  function removeCurrentList() {
    var list = currentList();
    if (!list) return;
    if (!window.confirm('Remove "' + list.name + '" and everything on it for everyone?')) return;
    api('/api/lists/' + list.id, { method: 'DELETE' })
      .then(function () {
        state.lists = state.lists.filter(function (l) { return l.id !== list.id; });
        state.panelOpen = false;
        if (state.lists.length) {
          loadList(state.lists[0].id);
        } else {
          state.listId = null;
          state.data = null;
          render();
        }
      })
      .catch(function () {
        toast('Could not remove the list. Try again.');
      });
  }

  function reportItem(item) {
    api('/api/reports', { method: 'POST', body: JSON.stringify({ itemId: item.id }) })
      .then(function () { toast('Thanks, your report is recorded.'); })
      .catch(function () { toast('Could not send the report. Try again.'); });
  }

  function reportList(list) {
    api('/api/reports', { method: 'POST', body: JSON.stringify({ listId: list.id }) })
      .then(function () { toast('Thanks, your report is recorded.'); })
      .catch(function () { toast('Could not send the report. Try again.'); });
  }

  // ── Events ─────────────────────────────────────────────────────────────

  el.pickerBtn.addEventListener('click', function () {
    state.panelOpen = !state.panelOpen;
    renderPanel();
  });

  el.newListCancel.addEventListener('click', function () {
    state.panelOpen = false;
    el.newListName.value = '';
    el.newNoun.value = '';
    renderPanel();
  });

  el.newListForm.addEventListener('submit', submitNewList);

  function setView(view) {
    state.view = view;
    render();
  }
  el.viewMine.addEventListener('click', function () { setView('mine'); });
  el.viewCrowd.addEventListener('click', function () { setView('crowd'); });
  [el.viewMine, el.viewCrowd].forEach(function (tab) {
    tab.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setView(tab === el.viewMine ? 'mine' : 'crowd');
      }
    });
  });

  el.addBtn.addEventListener('click', openAdd);
  el.addCancel.addEventListener('click', closeAdd);
  el.addForm.addEventListener('submit', submitAdd);

  document.addEventListener('click', function (e) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    var chip = e.target.closest('.chip[data-item-id]');
    if (chip) {
      var id = Number(chip.getAttribute('data-item-id'));
      state.openId = state.openId === id ? null : id;
      render();
      return;
    }
    var action = e.target.closest('[data-act]');
    if (!action) return;
    var act = action.getAttribute('data-act');
    var item = state.data && state.openId != null
      ? state.data.items.filter(function (i) { return i.id === state.openId; })[0]
      : null;
    var list = currentList();

    if (act === 'retry') return retry();
    if (act === 'open-add') return openAdd();
    if (!item) {
      if (act === 'switch-list') {
        var listId = Number(action.getAttribute('data-list-id'));
        state.panelOpen = false;
        state.view = 'mine';
        loadList(listId);
      } else if (act === 'remove-list' && list) {
        removeCurrentList();
      } else if (act === 'report-list' && list) {
        reportList(list);
      }
      return;
    }
    if (act === 'pick') {
      setVote(item.id, action.getAttribute('data-tier'));
    } else if (act === 'clear') {
      setVote(item.id, null);
    } else if (act === 'remove') {
      removeItem(item);
    } else if (act === 'report') {
      reportItem(item);
    }
  });

  // Keyboard access to the tier buttons in the opened card.
  el.detail.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var pick = e.target.closest('[data-act="pick"]');
    if (!pick) return;
    e.preventDefault();
    var item = state.data && state.openId != null
      ? state.data.items.filter(function (i) { return i.id === state.openId; })[0]
      : null;
    if (item) setVote(item.id, pick.getAttribute('data-tier'));
  });

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (state.panelOpen) {
      state.panelOpen = false;
      renderPanel();
    } else if (state.addOpen) {
      closeAdd();
    } else if (state.openId != null) {
      state.openId = null;
      render();
    }
  });

  // ── Dragging ───────────────────────────────────────────────────────────
  // Pointer events, so it works on touch as well as with a mouse. A card
  // that is dropped on a tier row gets that tier; dropped on the tray, its
  // vote is cleared. A press that does not move is a tap, and opens the card.

  function dropTargetAt(x, y) {
    var under = document.elementFromPoint(x, y);
    return under ? under.closest('[data-drop]') : null;
  }

  document.addEventListener('pointerdown', function (e) {
    if (state.view !== 'mine' || state.status !== 'ready') return;
    var chip = e.target.closest('.chip[data-item-id]');
    if (!chip || e.button !== 0) return;
    drag = {
      id: Number(chip.getAttribute('data-item-id')),
      el: chip,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      ghost: null,
      offsetX: 0,
      offsetY: 0
    };
  });

  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (!drag.active) {
      if (Math.sqrt(Math.pow(e.clientX - drag.startX, 2) + Math.pow(e.clientY - drag.startY, 2)) < 8) return;
      drag.active = true;
      var rect = drag.el.getBoundingClientRect();
      var ghost = drag.el.cloneNode(true);
      ghost.classList.add('tier-ghost');
      ghost.style.width = rect.width + 'px';
      ghost.style.left = rect.left + 'px';
      ghost.style.top = rect.top + 'px';
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      drag.offsetX = e.clientX - rect.left;
      drag.offsetY = e.clientY - rect.top;
      drag.el.classList.add('dragging');
    }
    e.preventDefault();
    drag.ghost.style.left = (e.clientX - drag.offsetX) + 'px';
    drag.ghost.style.top = (e.clientY - drag.offsetY) + 'px';
    document.querySelectorAll('.drag-over').forEach(function (n) {
      n.classList.remove('drag-over');
    });
    var target = dropTargetAt(e.clientX, e.clientY);
    if (target) target.classList.add('drag-over');
  }, { passive: false });

  function endDrag(e) {
    if (!drag) return;
    var finished = drag;
    drag = null;
    document.querySelectorAll('.drag-over').forEach(function (n) {
      n.classList.remove('drag-over');
    });
    if (finished.ghost) finished.ghost.remove();
    finished.el.classList.remove('dragging');
    if (!finished.active) return; // a tap: let the click open the card

    suppressClick = true;
    var target = dropTargetAt(e.clientX, e.clientY);
    if (!target) return;
    var tier = target.getAttribute('data-drop') === 'tray' ? null : target.getAttribute('data-tier');
    setVote(finished.id, tier);
  }

  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', function (e) {
    if (!drag) return;
    document.querySelectorAll('.drag-over').forEach(function (n) {
      n.classList.remove('drag-over');
    });
    if (drag.ghost) drag.ghost.remove();
    drag.el.classList.remove('dragging');
    drag = null;
  });

  loadAll();
})();
