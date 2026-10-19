// Tier List — page logic. One board per list; a vote is your own placement
// of an item in a tier row. Rendering uses the drawn screen's markup in
// public/index.html and its styles in public/screens.css, on the design
// kit's tokens.
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var TOKEN = params.get('token') || '';
  var DEMO = params.get('demo') === '1';

  var TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];
  var TIER_VAR = { S: '--tier-s', A: '--tier-a', B: '--tier-b', C: '--tier-c', D: '--tier-d', F: '--tier-f' };

  var state = {
    me: null,
    lists: [],
    listId: null,
    list: null,
    items: [],
    view: 'my', // 'my' | 'crowd'
    openItemId: null,
    loading: true,
    loadError: false,
  };

  function $(id) { return document.getElementById(id); }

  var els = {};
  ['app', 'listPickerBtn', 'listName', 'listSub', 'pickerPanel', 'pickerList', 'newListBtn',
    'newListForm', 'newListName', 'newListNoun', 'newListCancel', 'viewToggle', 'viewMy',
    'viewCrowd', 'board', 'trayLabel', 'tray', 'emptyState', 'emptyAddBtn', 'addForm',
    'addLabel', 'addInput', 'addCancel', 'addSubmit', 'addBtn', 'status', 'errorState', 'retryBtn',
    'detailWrap', 'detailLabel', 'detailTitle', 'detailMeta', 'detailPick', 'detailVotes',
    'detailQuiet'].forEach(function (id) { els[id] = $(id); });

  // ── API ─────────────────────────────────────────────────────────────────
  // The iframe token comes from the URL on load and is forwarded on every
  // fetch; at the app's own address the platform's edge adds the same
  // identity header itself, so a missing token is fine. ?demo=1 is
  // forwarded to every API call so the staging demo follows the viewer.
  function api(path, opts) {
    opts = opts || {};
    var url = path + (DEMO ? (path.indexOf('?') === -1 ? '?' : '&') + 'demo=1' : '');
    var headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['x-usernode-token'] = TOKEN;
    return fetch(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Request failed');
          err.status = res.status;
          err.code = data.error;
          throw err;
        }
        return data;
      });
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function tierColor(t) { return 'rgb(var(' + TIER_VAR[t] + '))'; }

  function findItem(id) {
    return state.items.find(function (i) { return i.id === id; }) || null;
  }

  function myTier(item) {
    if (!state.me) return null;
    var v = item.votes.find(function (v) { return v.user_id === state.me.id; });
    return v ? v.tier : null;
  }

  // Crowd average: S=0 … F=5, mean, rounded to the nearest tier, ties to
  // the better one.
  function crowdTier(item) {
    if (!item.votes.length) return null;
    var sum = 0;
    item.votes.forEach(function (v) { sum += TIERS.indexOf(v.tier); });
    var idx = Math.ceil(sum / item.votes.length - 0.5);
    return TIERS[Math.min(TIERS.length - 1, Math.max(0, idx))];
  }

  function displayName(userId, username) {
    return state.me && userId === state.me.id ? 'You' : username;
  }

  // Names on a card: everyone who put it in this tier (or everyone at all).
  function voterNames(item, tier) {
    var voters = item.votes;
    if (voters.length) {
      // You first, then the others in vote order.
      voters = voters.slice().sort(function (a, b) {
        var aMine = state.me && a.user_id === state.me.id ? 0 : 1;
        var bMine = state.me && b.user_id === state.me.id ? 0 : 1;
        return aMine - bMine;
      });
    }
    if (tier) voters = voters.filter(function (v) { return v.tier === tier; });
    return voters.map(function (v) { return displayName(v.user_id, v.username); }).join(', ');
  }

  var statusTimer = null;
  function showStatus(message) {
    els.status.textContent = message;
    els.status.hidden = false;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { els.status.hidden = true; }, 3000);
  }

  // The chevron is an <svg>, whose `hidden` property does not reflect to
  // the attribute, so the header renders it in the name's own flow: after
  // the last word, glued with a non-breaking space so it never wraps to a
  // line of its own, and absent until the name is known.
  var CHEVRON = '<span style="white-space:nowrap">&nbsp;<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>';

  // ── Rendering ───────────────────────────────────────────────────────────

  // "a restaurant", "an item" — the article follows the noun's first letter.
  function articleFor(noun) {
    return /^[aeiou]/i.test(noun) ? 'an' : 'a';
  }

  // The placeholder is an example name that says it is an example, not a
  // bare value or "e.g. a restaurant", which says nothing.
  function exampleFor(noun) {
    var known = { restaurant: 'Tartine Bakery', movie: 'The Godfather' };
    var example = known[noun.toLowerCase()];
    if (!example) example = noun.charAt(0).toUpperCase() + noun.slice(1);
    return 'e.g. ' + example;
  }

  function setNounWords() {
    var noun = (state.list && state.list.noun) || 'item';
    els.addBtn.lastChild.textContent = 'Add ' + articleFor(noun) + ' ' + noun;
    els.emptyAddBtn.textContent = 'Add ' + articleFor(noun) + ' ' + noun;
    els.addLabel.textContent = 'New ' + noun;
    els.addInput.placeholder = exampleFor(noun);
    els.addSubmit.textContent = 'Add';
  }

  function chipHtml(item, tier, names, addedBy) {
    var border = tier ? ' style="border-left-color:' + tierColor(tier) + '"' : '';
    var small = '';
    if (names) small = '<small>' + esc(names) + '</small>';
    else if (addedBy) small = '<small>Added by ' + esc(displayName(item.added_by_id, item.added_by_name)) + '</small>';
    var sel = item.id === state.openItemId ? ' sel' : '';
    return '<div class="chip' + sel + '" data-item-id="' + item.id + '" role="button" tabindex="0"' + border + '>'
      + esc(item.name) + small + '</div>';
  }

  function skeletonChip() {
    return '<div class="chip"><span class="skeleton" style="display:block;width:110px;height:14px"></span></div>';
  }

  function renderBoard() {
    var my = state.view === 'my';
    TIERS.forEach(function (t) {
      var box = els.board.querySelector('[data-tier-items="' + t + '"]');
      var row = box.closest('.row');
      var old = row.querySelector('.hint');
      if (old) old.remove();
      var placed = [];
      var chips = '';
      state.items.forEach(function (item) {
        var tier = my ? myTier(item) : crowdTier(item);
        if (tier === t) {
          placed.push(item);
          chips += chipHtml(item, t, my || item.votes.length ? voterNames(item, my ? t : null) : '');
        }
      });
      if (state.loading) {
        chips = skeletonChip();
      } else if (!placed.length && my && state.items.length) {
        chips = '<span class="hint">Drag here</span>';
      }
      box.innerHTML = chips;
      if (state.loading && placed.length) { /* skeleton replaced drawn rows */ }
    });
  }

  function renderTray() {
    var my = state.view === 'my';
    var waiting = [];
    state.items.forEach(function (item) {
      var has = my ? myTier(item) : item.votes.length > 0;
      if (!has) waiting.push(item);
    });
    if (state.loading) {
      els.trayLabel.hidden = false;
      els.trayLabel.textContent = 'Loading the board…';
      els.tray.hidden = false;
      els.tray.innerHTML = skeletonChip() + skeletonChip();
      return;
    }
    if (!waiting.length || !state.items.length) {
      els.trayLabel.hidden = true;
      els.tray.hidden = true;
      els.tray.innerHTML = '';
      return;
    }
    els.trayLabel.hidden = false;
    els.trayLabel.textContent = my
      ? 'Not placed by you yet (' + waiting.length + ')'
      : 'Not voted on by anyone yet (' + waiting.length + ')';
    els.tray.hidden = false;
    els.tray.innerHTML = waiting.map(function (item) {
      return chipHtml(item, null, null, true);
    }).join('');
  }

  function renderHeader() {
    setNounWords();
    if (!state.list) {
      // The list's name is not known yet (loading, or the load failed): a
      // grey bar where the title goes, and no chevron to hint at a picker.
      els.listName.innerHTML = '<span class="skeleton" style="display:inline-block;width:180px;height:30px;border-radius:8px"></span>';
      return;
    }
    var name = esc(state.list.name);
    if (state.list.is_demo) {
      name += ' <span data-usernode-demo-note>(Staging demo)</span>';
    }
    els.listName.innerHTML = name + CHEVRON;
    var people = {};
    var voters = 0;
    state.items.forEach(function (item) {
      item.votes.forEach(function (v) {
        if (!people[v.user_id]) { people[v.user_id] = true; voters++; }
      });
    });
    var noun = state.list.noun;
    els.listSub.textContent = voters + ' voting · ' + state.items.length + ' ' + noun + (state.items.length === 1 ? '' : 's');
  }

  function renderDetail() {
    var item = state.openItemId != null ? findItem(state.openItemId) : null;
    if (!item) {
      els.detailWrap.hidden = true;
      return;
    }
    els.detailWrap.hidden = false;
    els.detailLabel.textContent = item.name;
    els.detailTitle.textContent = item.name;
    var n = item.votes.length;
    els.detailMeta.textContent = 'Added by ' + displayName(item.added_by_id, item.added_by_name)
      + ' · ' + n + (n === 1 ? ' vote' : ' votes');
    // Tap-to-set row.
    var mine = myTier(item);
    els.detailPick.innerHTML = TIERS.map(function (t) {
      return '<div data-tier="' + t + '" role="button" tabindex="0"'
        + (t === mine ? ' class="on"' : '') + '>' + t + '</div>';
    }).join('');
    // Everyone's vote.
    var rowsHtml = '';
    if (!item.votes.length) {
      rowsHtml = '<div class="cs">Nobody has voted on this yet. Drag it or tap a tier to be first.</div>';
    } else {
      rowsHtml = item.votes.slice().sort(function (a, b) {
        var aMine = state.me && a.user_id === state.me.id ? 0 : 1;
        var bMine = state.me && b.user_id === state.me.id ? 0 : 1;
        return aMine - bMine;
      }).map(function (v) {
        return '<div class="vote"><span>' + esc(displayName(v.user_id, v.username)) + '</span>'
          + '<span class="badge" style="background:' + tierColor(v.tier) + '">' + v.tier + '</span></div>';
      }).join('');
      var avg = crowdTier(item);
      rowsHtml += '<div class="vote tot"><span>Crowd average</span>'
        + (avg ? '<span class="badge" style="background:' + tierColor(avg) + '">' + avg + '</span>' : '');
      rowsHtml += '</div>';
    }
    els.detailVotes.innerHTML = rowsHtml;
    // Quiet actions.
    var actions = '';
    if (mine) {
      actions += '<div data-action="clear" role="button" tabindex="0"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>Clear my vote</div>';
    }
    if (state.me && item.added_by_id === state.me.id) {
      actions += '<div data-action="remove" role="button" tabindex="0"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>Remove</div>';
    } else {
      actions += '<div data-action="report" role="button" tabindex="0"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>Report</div>';
    }
    els.detailQuiet.innerHTML = actions;
  }

  function renderStates() {
    var empty = !state.loading && !state.loadError && state.list && !state.items.length;
    els.emptyState.hidden = !empty;
    els.errorState.hidden = !state.loadError;
    // An empty list speaks in the board's place: no blank tier rows under it.
    els.board.hidden = state.loadError || empty;
    els.addBtn.hidden = !!state.loadError || empty || !els.addForm.hidden;
    els.emptyAddBtn.hidden = !els.addForm.hidden;
    if (empty) {
      els.tray.hidden = true;
      els.trayLabel.hidden = true;
    }
  }

  function renderAll() {
    renderHeader();
    renderBoard();
    renderTray();
    renderStates();
    renderDetail();
  }

  // ── Data ────────────────────────────────────────────────────────────────

  function loadLists() {
    return api('/api/lists').then(function (data) {
      state.lists = data.lists || [];
      // With the staging demo, the viewer's own demo list leads; otherwise
      // the first list (the boot list) opens.
      var pick = state.lists[0];
      state.listId = pick ? pick.id : null;
    });
  }

  function loadList() {
    if (!state.listId) {
      state.list = null;
      state.items = [];
      state.loading = false;
      state.loadError = false;
      renderAll();
      return Promise.resolve();
    }
    state.loading = true;
    state.loadError = false;
    renderAll();
    return api('/api/lists/' + state.listId).then(function (data) {
      state.list = data.list;
      state.items = data.items;
      state.loading = false;
      state.openItemId = findItem(state.openItemId) ? state.openItemId : null;
      renderAll();
    }).catch(function () {
      state.loading = false;
      state.loadError = true;
      renderAll();
    });
  }

  // Optimistic vote writes: apply locally, roll back with a short message
  // if the save fails.
  function withRollback(item, apply, request, message) {
    var snapshot = JSON.stringify(item.votes);
    apply();
    renderAll();
    request().catch(function (err) {
      item.votes = JSON.parse(snapshot);
      renderAll();
      showStatus(message || 'Could not save that. Your board is back as it was.');
    });
  }

  function setVote(itemId, tier) {
    var item = findItem(itemId);
    if (!item) return;
    if (!state.me) {
      // Guests: let the platform's account_required answer bring the sheet.
      api('/api/items/' + itemId + '/vote', { method: 'PUT', body: { tier: tier } })
        .catch(function () { showStatus('Make an account to vote'); });
      return;
    }
    withRollback(item, function () {
      var existing = item.votes.find(function (v) { return v.user_id === state.me.id; });
      if (existing) existing.tier = tier;
      else item.votes.push({ user_id: state.me.id, username: state.me.username, tier: tier });
    }, function () {
      return api('/api/items/' + itemId + '/vote', { method: 'PUT', body: { tier: tier } });
    });
  }

  function clearVote(itemId) {
    var item = findItem(itemId);
    if (!item || !state.me) return;
    withRollback(item, function () {
      item.votes = item.votes.filter(function (v) { return v.user_id !== state.me.id; });
    }, function () {
      return api('/api/items/' + itemId + '/vote', { method: 'DELETE' });
    }, 'Could not clear your vote. Your board is back as it was.');
  }

  function removeItem(itemId) {
    var item = findItem(itemId);
    if (!item) return;
    state.items = state.items.filter(function (i) { return i.id !== itemId; });
    if (state.openItemId === itemId) state.openItemId = null;
    renderAll();
    api('/api/items/' + itemId, { method: 'DELETE' }).catch(function (err) {
      state.items.push(item);
      state.items.sort(function (a, b) { return a.id - b.id; });
      renderAll();
      showStatus(err.code === 'account_required' ? 'Make an account to do that'
        : 'Could not remove it. Your board is back as it was.');
    });
  }

  function report(kind, id) {
    var body = kind === 'item' ? { itemId: id } : { listId: id };
    api('/api/reports', { method: 'POST', body: body }).then(function () {
      showStatus('Reported. Thank you.');
    }).catch(function (err) {
      showStatus(err.code === 'account_required' ? 'Make an account to report it' : 'Could not send the report');
    });
  }

  // ── Drag ────────────────────────────────────────────────────────────────
  // Pointer events, so the same gesture works with a mouse, a pen and a
  // finger. Dragging is a My-view action; in Crowd view a tap opens the
  // detail and tiers are set from its buttons.

  var drag = null;

  function dragAllowed(chip) {
    if (state.view !== 'my' || state.loading) return false;
    return !!chip.closest('#board') || !!chip.closest('#tray');
  }

  function dropTarget(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return null;
    var row = el.closest('.row');
    if (row && els.board.contains(row)) return row;
    if (el === els.tray || els.tray.contains(el)) return els.tray;
    return null;
  }

  var highlighted = null;
  function highlight(el) {
    if (highlighted === el) return;
    if (highlighted) highlighted.style.outline = '';
    highlighted = el;
    if (el) el.style.outline = '2px solid rgb(var(--accent))';
  }

  document.addEventListener('pointerdown', function (e) {
    if (e.button !== undefined && e.button !== 0) return;
    var chip = e.target.closest('.chip[data-item-id]');
    if (!chip) return;
    if (els.pickerPanel.contains(chip)) return;
    drag = {
      id: Number(chip.getAttribute('data-item-id')),
      chip: chip,
      x: e.clientX,
      y: e.clientY,
      dx: e.clientX - chip.getBoundingClientRect().left,
      dy: e.clientY - chip.getBoundingClientRect().top,
      started: false,
      ghost: null,
    };
  });

  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 8) return;
      if (!dragAllowed(drag.chip)) { drag = null; return; }
      drag.started = true;
      var r = drag.chip.getBoundingClientRect();
      var ghost = drag.chip.cloneNode(true);
      ghost.style.cssText = 'position:fixed;z-index:50;left:0;top:0;margin:0;width:' + r.width
        + 'px;pointer-events:none;opacity:.92;box-shadow:0 4px 14px rgba(0,0,0,.28);background:rgb(var(--surface))';
      document.body.appendChild(ghost);
      drag.ghost = ghost;
      drag.chip.style.opacity = '.35';
      highlight(dropTarget(e));
    }
    drag.ghost.style.transform = 'translate(' + (e.clientX - drag.dx) + 'px,' + (e.clientY - drag.dy) + 'px)';
    highlight(dropTarget(e));
  });

  function endDrag(e) {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (d.ghost) d.ghost.remove();
    d.chip.style.opacity = '';
    highlight(null);
    if (!d.started) {
      // A tap, not a drag: open the detail.
      openItem(d.id);
      return;
    }
    var target = dropTarget(e);
    if (!target) return;
    if (target === els.tray) {
      var item = findItem(d.id);
      if (item && myTier(item)) clearVote(d.id);
      else showStatus('You have not placed that one yet');
    } else {
      setVote(d.id, target.getAttribute('data-tier'));
    }
  }
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', function () {
    if (!drag) return;
    if (drag.ghost) drag.ghost.remove();
    drag.chip.style.opacity = '';
    highlight(null);
    drag = null;
  });

  // ── Events ──────────────────────────────────────────────────────────────

  function openItem(id) {
    state.openItemId = state.openItemId === id ? null : id;
    renderBoard();
    renderDetail();
    if (state.openItemId != null && els.detailWrap.hidden === false) {
      els.detailWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function setView(view) {
    if (state.view === view) return;
    state.view = view;
    els.viewMy.classList.toggle('on', view === 'my');
    els.viewCrowd.classList.toggle('on', view === 'crowd');
    els.viewMy.setAttribute('aria-selected', view === 'my');
    els.viewCrowd.setAttribute('aria-selected', view === 'crowd');
    renderBoard();
    renderTray();
  }

  els.viewToggle.addEventListener('click', function (e) {
    if (e.target === els.viewCrowd) setView('crowd');
    else if (e.target === els.viewMy) setView('my');
  });

  // The add form. While it is open, the board's own add button and the
  // empty state's button stand down.
  function openAddForm() {
    els.addForm.hidden = false;
    els.addBtn.hidden = true;
    els.emptyAddBtn.hidden = true;
    // Bring the whole form — field and its buttons — into view, then put
    // the cursor in the field without scrolling over the smooth scroll.
    els.addForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    els.addInput.focus({ preventScroll: true });
  }
  function closeAddForm() {
    els.addForm.hidden = true;
    els.addForm.reset();
    renderStates();
  }
  els.addBtn.addEventListener('click', openAddForm);
  els.emptyAddBtn.addEventListener('click', openAddForm);
  els.addCancel.addEventListener('click', closeAddForm);
  els.addForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = els.addInput.value.trim();
    if (!name) { els.addInput.focus(); return; }
    api('/api/lists/' + state.listId + '/items', { method: 'POST', body: { name: name } })
      .then(function (data) {
        state.items.push(data.item);
        closeAddForm();
        renderAll();
        showStatus('Added. Drag it where you think it goes.');
      })
      .catch(function (err) {
        showStatus(err.code === 'account_required' ? 'Make an account to add things'
          : err.message || 'Could not add it');
      });
  });

  // List picker.
  function renderPicker() {
    els.pickerList.innerHTML = state.lists.map(function (l) {
      var name = esc(l.name) + (l.is_demo ? ' <span data-usernode-demo-note>(Staging demo)</span>' : '');
      var current = l.id === state.listId;
      var actions = '';
      if (state.me && l.created_by_id === state.me.id) {
        actions += '<button type="button" class="btn-secondary" style="min-height:32px;padding:2px 10px" data-remove-list="' + l.id + '">Remove</button>';
      }
      actions += '<button type="button" class="btn-secondary" style="min-height:32px;padding:2px 10px" data-report-list="' + l.id + '">Report</button>';
      return '<li class="list-row" data-pick-list="' + l.id + '" role="button" tabindex="0"'
        + (current ? ' style="background:rgb(var(--raised))"' : '') + '>'
        + '<span style="flex:1;font-weight:' + (current ? '600' : '400') + '">' + name + '</span>' + actions + '</li>';
    }).join('');
  }

  els.listPickerBtn.addEventListener('click', function () {
    if (els.pickerPanel.hidden) {
      renderPicker();
      els.pickerPanel.hidden = false;
      els.listPickerBtn.setAttribute('aria-expanded', 'true');
    } else {
      els.pickerPanel.hidden = true;
      els.newListForm.hidden = true;
      els.listPickerBtn.setAttribute('aria-expanded', 'false');
    }
  });

  els.pickerPanel.addEventListener('click', function (e) {
    var remove = e.target.closest('[data-remove-list]');
    if (remove) {
      e.stopPropagation();
      var rid = Number(remove.getAttribute('data-remove-list'));
      api('/api/lists/' + rid, { method: 'DELETE' }).then(function () {
        state.lists = state.lists.filter(function (l) { return l.id !== rid; });
        if (state.listId === rid) {
          var next = state.lists[0];
          state.listId = next ? next.id : null;
          state.list = null;
          state.items = [];
          renderHeader();
          loadList();
        }
        renderPicker();
        showStatus('List removed');
      }).catch(function (err) {
        showStatus(err.code === 'account_required' ? 'Make an account to do that' : err.message);
      });
      return;
    }
    var reportBtn = e.target.closest('[data-report-list]');
    if (reportBtn) {
      e.stopPropagation();
      report('list', Number(reportBtn.getAttribute('data-report-list')));
      return;
    }
    var pick = e.target.closest('[data-pick-list]');
    if (pick) {
      var id = Number(pick.getAttribute('data-pick-list'));
      if (id !== state.listId) {
        state.listId = id;
        state.openItemId = null;
        els.pickerPanel.hidden = true;
        loadList();
      }
    }
  });

  els.newListBtn.addEventListener('click', function () {
    els.newListForm.hidden = false;
    els.newListName.focus();
  });
  els.newListCancel.addEventListener('click', function () {
    els.newListForm.hidden = true;
    els.newListForm.reset();
  });
  els.newListForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var name = els.newListName.value.trim();
    if (!name) { els.newListName.focus(); return; }
    api('/api/lists', { method: 'POST', body: { name: name, noun: els.newListNoun.value.trim() } })
      .then(function (data) {
        state.lists.unshift(data.list);
        state.listId = data.list.id;
        els.newListForm.hidden = true;
        els.newListForm.reset();
        els.pickerPanel.hidden = true;
        renderHeader();
        loadList();
      })
      .catch(function (err) {
        showStatus(err.code === 'account_required' ? 'Make an account to start a list' : err.message);
      });
  });

  // Detail card actions.
  els.detailPick.addEventListener('click', function (e) {
    var t = e.target.closest('[data-tier]');
    if (t && state.openItemId != null) setVote(state.openItemId, t.getAttribute('data-tier'));
  });
  els.detailQuiet.addEventListener('click', function (e) {
    var a = e.target.closest('[data-action]');
    if (!a || state.openItemId == null) return;
    var action = a.getAttribute('data-action');
    if (action === 'clear') clearVote(state.openItemId);
    else if (action === 'remove') removeItem(state.openItemId);
    else if (action === 'report') report('item', state.openItemId);
  });

  els.retryBtn.addEventListener('click', loadList);

  // Keyboard: Enter or Space activates the drawn role="button" elements.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var el = e.target;
    if (el.matches && el.matches('[role="button"], #viewMy, #viewCrowd')) {
      e.preventDefault();
      el.click();
    }
  });

  // ── Boot ────────────────────────────────────────────────────────────────

  renderBoard(); // skeleton rows until the first answer arrives
  renderTray();
  renderHeader(); // a grey bar where the list name goes, no chevron yet
  Promise.all([api('/api/me'), loadLists()])
    .then(function (results) {
      state.me = results[0];
      renderHeader();
      return loadList();
    })
    .catch(function () {
      state.loading = false;
      state.loadError = true;
      renderAll();
    });
})();