/* Tier List: rendering, voting, drag with pointer events, and the sheets.
   The screen markup is the spec's drawn screen (public/index.html +
   public/screens.css); this script fills it from the API. */
(function () {
  'use strict';

  var TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];
  var TIER_VALUE = { S: 6, A: 5, B: 4, C: 3, D: 2, F: 1 };
  var TIER_BY_VALUE = ['F', 'D', 'C', 'B', 'A', 'S'];
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('token') || '';
  var DEMO = params.has('demo');

  var me = null;
  var state = {
    lists: [], listId: null, list: null, items: [],
    view: 'you',
    phase: 'loading', // loading | error | nolists | ready
  };

  // ── Small helpers ──────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function show(id, yes) { $(id).hidden = !yes; }

  var SVG = {
    x: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    trash: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    flag: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
    chevron: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  };

  // The token the shell injected on load, forwarded on every fetch; demo
  // reads carry ?demo=1 on so the demo lists answer.
  function api(path, opts) {
    opts = opts || {};
    var get = !opts.method || opts.method === 'GET';
    if (DEMO && get) path += (path.indexOf('?') >= 0 ? '&' : '?') + 'demo=1';
    var headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['x-usernode-token'] = TOKEN;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          var err = new Error(body.error || 'HTTP ' + res.status);
          err.status = res.status;
          throw err;
        });
      }
      return res.json();
    });
  }

  function crowdTier(votes) {
    if (!votes || !votes.length) return null;
    var sum = 0;
    for (var i = 0; i < votes.length; i++) sum += TIER_VALUE[votes[i].tier];
    return TIER_BY_VALUE[Math.round(sum / votes.length) - 1];
  }
  function countTier(item, tier) {
    var n = 0;
    for (var i = 0; i < item.votes.length; i++) if (item.votes[i].tier === tier) n++;
    return n;
  }
  function votesYouFirst(item) {
    return item.votes.slice().sort(function (a, b) {
      return (a.username === me.username ? 0 : 1) - (b.username === me.username ? 0 : 1);
    });
  }

  // ── Boot, load, states ─────────────────────────────────────────────────
  function boot() {
    state.phase = 'loading';
    render();
    Promise.all([api('/api/me'), api('/api/lists')]).then(function (results) {
      me = results[0];
      state.lists = results[1].lists;
      if (!state.lists.length) { state.phase = 'nolists'; render(); return; }
      state.listId = state.lists[0].id; // newest first; the demo list is seeded newest
      loadList();
    }).catch(function () { state.phase = 'error'; render(); });
  }

  function loadList() {
    state.phase = 'loading';
    render();
    api('/api/lists/' + state.listId).then(function (d) {
      state.list = d.list;
      state.items = d.items;
      state.phase = 'ready';
      render();
    }).catch(function () { state.phase = 'error'; render(); });
  }

  function renderLoading() {
    var ladder = $('ladder');
    ladder.textContent = '';
    TIERS.forEach(function (t) {
      var tier = el('div', 'tier');
      tier.dataset.tier = t;
      tier.appendChild(el('div', 'lab ' + t.toLowerCase(), t));
      var items = el('div', 'items');
      var sk = el('span', 'skeleton');
      sk.style.cssText = 'display:block;width:' + (90 + t.length * 40) + 'px;height:34px';
      items.appendChild(sk);
      tier.appendChild(items);
      ladder.appendChild(tier);
    });
    var tray = $('tray');
    tray.textContent = '';
    for (var i = 0; i < 2; i++) {
      var sk2 = el('span', 'skeleton');
      sk2.style.cssText = 'display:block;width:' + (110 + i * 60) + 'px;height:34px';
      tray.appendChild(sk2);
    }
  }

  function renderState() {
    var box = $('state');
    box.textContent = '';
    if (state.phase === 'error') {
      var err = el('div', 'state-error');
      err.appendChild(el('p', null, 'This list could not be loaded.'));
      err.appendChild(el('p', 'sub', 'Nothing you did was lost. Your votes are still saved.'));
      var retry = el('button', 'btn-primary', 'Retry');
      retry.addEventListener('click', boot);
      err.appendChild(retry);
      box.appendChild(err);
    } else if (state.phase === 'nolists') {
      var empty = el('div', 'state-empty');
      empty.appendChild(el('p', null, 'No lists yet'));
      empty.appendChild(el('p', 'sub', 'Start a list of things to rank together, then drag each one into a tier.'));
      var start = el('button', 'btn-primary', 'Start a list');
      start.addEventListener('click', openNewListSheet);
      empty.appendChild(start);
      box.appendChild(empty);
    } else if (state.phase === 'ready' && state.items.length === 0) {
      var none = el('div', 'state-empty');
      none.appendChild(el('p', null, 'Add the first thing to rank'));
      var add = el('button', 'btn-primary', 'Add item');
      add.addEventListener('click', openAddSheet);
      none.appendChild(add);
      box.appendChild(none);
    }
  }

  function render() {
    var ready = state.phase === 'ready';
    var loading = state.phase === 'loading';
    var hasItems = ready && state.items.length > 0;
    show('addItemBtn', ready && hasItems);
    show('listPick', ready);
    show('viewSeg', ready);
    show('ladder', loading || ready);
    show('trayLabel', ready && hasItems);
    show('tray', loading || hasItems);
    $('listSub').textContent = ready ? listSubText() : '';
    $('listName').textContent = '';
    if (ready) {
      $('listName').appendChild(document.createTextNode(state.list.name));
      if (state.list.demo) {
        var note = el('span', null, ' (Staging demo)');
        note.setAttribute('data-usernode-demo-note', '');
        $('listName').appendChild(note);
      }
    }
    if (ready) {
      var seg = $('viewSeg');
      ['you', 'crowd'].forEach(function (v) {
        var span = seg.querySelector('[data-view="' + v + '"]');
        span.classList.toggle('on', state.view === v);
        span.setAttribute('aria-selected', state.view === v ? 'true' : 'false');
      });
    }
    if (loading) renderLoading();
    if (ready) renderMain();
    renderState();
    setHint();
  }

  function listSubText() {
    var n = state.items.length;
    var voters = {};
    state.items.forEach(function (item) {
      item.votes.forEach(function (v) { voters[v.username] = true; });
    });
    var count = Object.keys(voters).length;
    return n + (n === 1 ? ' thing' : ' things') + ', ranked by ' + count +
      (count === 1 ? ' person' : ' people');
  }

  function setHint() {
    if (state.phase !== 'ready') { $('hint').textContent = ''; return; }
    $('hint').textContent = state.view === 'you'
      ? 'Drag an item into a tier to vote. Drag again to change it, or back to the tray to take your vote away. Tap an item to see how everyone voted.'
      : 'The crowd’s tier is the average of everyone’s votes, rounded to the nearest tier. You cannot drag here; tap an item to see how everyone voted.';
  }

  // ── Main screen: the ladder and the tray ───────────────────────────────
  function itemsWhere(test) {
    return state.items.filter(test);
  }

  function renderMain() {
    $('listSub').textContent = listSubText();
    var ladder = $('ladder');
    ladder.textContent = '';
    TIERS.forEach(function (t) {
      var tier = el('div', 'tier');
      tier.dataset.tier = t;
      tier.appendChild(el('div', 'lab ' + t.toLowerCase(), t));
      var items = el('div', 'items');
      items.dataset.drop = t;
      var here = itemsWhere(function (item) {
        return state.view === 'you'
          ? item.my_tier === t
          : crowdTier(item.votes) === t;
      });
      here.forEach(function (item) { items.appendChild(itemCard(item)); });
      if (!here.length) items.appendChild(el('p', 'empty', 'Drag an item here'));
      tier.appendChild(items);
      ladder.appendChild(tier);
    });

    var tray = $('tray');
    tray.textContent = '';
    $('trayLabel').textContent = state.view === 'you' ? 'Not ranked by you yet' : 'No votes yet';
    var unranked = itemsWhere(function (item) {
      return state.view === 'you' ? !item.my_tier : !item.votes.length;
    });
    unranked.forEach(function (item) { tray.appendChild(itemCard(item)); });
    if (!unranked.length) tray.appendChild(el('p', 'empty', state.view === 'you' ? 'Nothing waiting' : 'Every item has votes'));
  }

  function itemCard(item) {
    var card = el('div', 'it');
    card.dataset.item = item.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.appendChild(document.createTextNode(item.name));
    var sub = el('i');
    if (state.view === 'crowd') {
      if (item.votes.length) {
        var bar = el('span', 'minibar');
        TIERS.forEach(function (t) {
          var n = countTier(item, t);
          if (!n) return;
          var seg = el('b', t.toLowerCase());
          seg.style.flex = String(n);
          bar.appendChild(seg);
        });
        sub.appendChild(bar);
        sub.appendChild(document.createTextNode(
          item.votes.length + (item.votes.length === 1 ? ' vote' : ' votes')));
      } else {
        sub.textContent = 'No votes yet';
      }
    } else if (item.my_tier) {
      var ct = crowdTier(item.votes);
      sub.textContent = ct ? 'Crowd: ' + ct : '';
    } else {
      sub.textContent = 'Added by ' + (item.added_by === me.username ? 'you' : item.added_by);
    }
    card.appendChild(sub);
    card.addEventListener('pointerdown', function (e) { pointerDown(e, item, card); });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItemSheet(item); }
    });
    return card;
  }

  // ── Voting ─────────────────────────────────────────────────────────────
  function setVote(item, tier, done) {
    var prev = item.my_tier;
    item.my_tier = tier;
    renderMain();
    api('/api/items/' + item.id + '/vote', { method: 'PUT', body: { tier: tier } })
      .then(function () { if (done) done(); })
      .catch(function () {
        item.my_tier = prev;
        renderMain();
        flash('Could not save that vote. Try again.');
        if (done) done();
      });
  }

  function clearVote(item, done) {
    var prev = item.my_tier;
    item.my_tier = null;
    renderMain();
    api('/api/items/' + item.id + '/vote', { method: 'DELETE' })
      .then(function () { if (done) done(); })
      .catch(function () {
        item.my_tier = prev;
        renderMain();
        flash('Could not save that vote. Try again.');
        if (done) done();
      });
  }

  var flashTimer = null;
  function flash(msg) {
    var hint = $('hint');
    hint.textContent = msg;
    hint.style.color = 'rgb(var(--danger))';
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      hint.style.color = '';
      setHint();
    }, 4000);
  }

  // ── Dragging ───────────────────────────────────────────────────────────
  // Mouse drags at once; touch picks an item up after a 200 ms hold so the
  // page still scrolls. Drop targets are the six bands and the tray.
  var drag = null;

  function pointerDown(e, item, card) {
    if (state.view !== 'you') return;
    if (e.button != null && e.button !== 0) return;
    drag = { item: item, card: card, x: e.clientX, y: e.clientY, active: false, timer: null, touch: e.pointerType !== 'mouse' };
    if (drag.touch) {
      drag.timer = setTimeout(function () { activateDrag(); }, 200);
      document.addEventListener('touchmove', blockTouchScroll, { passive: false });
    }
  }

  function blockTouchScroll(e) {
    if (drag && drag.active) e.preventDefault();
  }

  function activateDrag() {
    if (!drag || drag.active) return;
    drag.active = true;
    var r = drag.card.getBoundingClientRect();
    drag.ox = drag.x - r.left;
    drag.oy = drag.y - r.top;
    var ghost = drag.card.cloneNode(true);
    ghost.classList.add('drag-ghost');
    ghost.classList.remove('dragging');
    ghost.style.cssText = 'position:fixed;pointer-events:none;z-index:60;margin:0;opacity:.92;' +
      'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.card.classList.add('dragging');
    document.body.classList.add('dragging-item');
    if (!REDUCED) {
      ghost.style.transition = 'left 80ms linear, top 80ms linear';
    }
  }

  function moveGhost(x, y) {
    if (!drag || !drag.ghost) return;
    drag.ghost.style.left = (x - drag.ox) + 'px';
    drag.ghost.style.top = (y - drag.oy) + 'px';
  }

  function dropTargetAt(x, y) {
    var t = document.elementFromPoint(x, y);
    while (t && !(t.dataset && t.dataset.drop != null)) t = t.parentElement;
    return t;
  }

  function hoverTarget(x, y) {
    document.querySelectorAll('.drop-hover').forEach(function (n) { n.classList.remove('drop-hover'); });
    var t = dropTargetAt(x, y);
    if (t) t.classList.add('drop-hover');
  }

  function endDrag(e) {
    if (!drag) return;
    var d = drag;
    drag = null;
    document.removeEventListener('touchmove', blockTouchScroll);
    if (d.timer) clearTimeout(d.timer);
    if (!d.active) {
      if (e && e.type === 'pointerup') openItemSheet(d.item); // a tap, not a drag
      return;
    }
    if (d.ghost) d.ghost.remove();
    d.card.classList.remove('dragging');
    document.body.classList.remove('dragging-item');
    document.querySelectorAll('.drop-hover').forEach(function (n) { n.classList.remove('drop-hover'); });
    var x = e ? e.clientX : d.x;
    var y = e ? e.clientY : d.y;
    var target = dropTargetAt(x, y);
    if (!target) return; // put-back: nothing changed
    var drop = target.dataset.drop;
    if (drop === 'tray') {
      if (d.item.my_tier) clearVote(d.item);
    } else if (TIERS.indexOf(drop) >= 0) {
      setVote(d.item, drop);
    }
  }

  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (!drag.active) {
      if (drag.touch) return; // waiting out the hold; the page may scroll
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 3) activateDrag();
      else return;
    }
    drag.x = e.clientX; drag.y = e.clientY;
    moveGhost(e.clientX, e.clientY);
    hoverTarget(e.clientX, e.clientY);
  });
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  // ── Sheets ─────────────────────────────────────────────────────────────
  var sheetEl = null;

  function closeSheet() {
    if (sheetEl) { sheetEl.remove(); sheetEl = null; }
  }

  function sheetShell(compact) {
    closeSheet();
    var wrap = el('div');
    wrap.setAttribute('data-spec-screen', '2');
    var app = el('div', 'app');
    var sheet = el('div', compact ? 'sheet compact' : 'sheet');
    sheet.appendChild(el('div', 'grab'));
    wrap.addEventListener('pointerdown', function (e) {
      if (e.target === wrap || e.target === app) closeSheet();
    });
    app.appendChild(sheet);
    wrap.appendChild(app);
    document.body.appendChild(wrap);
    sheetEl = wrap;
    return sheet;
  }

  function sheetHeader(sheet, title, sub, onClose) {
    var hd = el('div', 'hd');
    var left = el('div');
    left.appendChild(el('h2', 'h', title));
    if (sub) left.appendChild(el('p', 'sub', sub));
    var x = el('button', 'x');
    x.setAttribute('aria-label', 'Close');
    x.innerHTML = SVG.x;
    x.addEventListener('click', onClose);
    hd.appendChild(left);
    hd.appendChild(x);
    sheet.appendChild(hd);
  }

  // Screen 2, as the spec drew it: the opened item.
  function openItemSheet(item) {
    var sheet = sheetShell(false);
    sheetHeader(sheet, item.name,
      item.added_by === me.username ? 'Added by you' : 'Added by ' + item.added_by, closeSheet);

    var ct = crowdTier(item.votes);
    sheet.appendChild(el('p', 'section-label',
      item.votes.length ? 'Crowd, ' + item.votes.length + (item.votes.length === 1 ? ' vote' : ' votes') : 'Crowd'));
    if (item.votes.length) {
      var bar = el('div', 'bar');
      TIERS.forEach(function (t) {
        var n = countTier(item, t);
        if (!n) return;
        var span = el('span', t.toLowerCase(), t);
        span.style.flex = String(n);
        bar.appendChild(span);
      });
      sheet.appendChild(bar);
      sheet.appendChild(el('p', 'sub under', 'Crowd tier: ' + ct));
    } else {
      sheet.appendChild(el('p', 'sub', 'No votes yet'));
    }

    sheet.appendChild(el('p', 'section-label', 'Your vote'));
    var vote = el('div', 'vote');
    TIERS.forEach(function (t) {
      var b = el('button', item.my_tier === t ? 'on ' + t.toLowerCase() : '', t);
      b.addEventListener('click', function () {
        var change = item.my_tier === t ? clearVote(item) : setVote(item, t);
        Promise.resolve(change).then(function () {
          closeSheet();
          openItemSheet(item);
        });
      });
      vote.appendChild(b);
    });
    sheet.appendChild(vote);

    sheet.appendChild(el('p', 'section-label', 'How everyone voted'));
    var list = el('div', 'list');
    var voters = votesYouFirst(item);
    if (!voters.length) {
      var row0 = el('div', 'list-row');
      row0.appendChild(el('span', null, 'No votes yet'));
      list.appendChild(row0);
    }
    voters.forEach(function (v) {
      var row = el('div', 'list-row');
      row.appendChild(el('span', null, v.username === me.username ? 'You' : v.username));
      row.appendChild(el('span', 'chip ' + v.tier.toLowerCase(), v.tier));
      list.appendChild(row);
    });
    sheet.appendChild(list);

    var foot = el('div', 'foot');
    if (item.added_by === me.username) {
      var del = el('button', 'btn-secondary del');
      del.innerHTML = SVG.trash + 'Remove item';
      del.addEventListener('click', function () {
        var prev = state.items;
        state.items = state.items.filter(function (i) { return i.id !== item.id; });
        renderMain();
        closeSheet();
        api('/api/items/' + item.id, { method: 'DELETE' }).catch(function () {
          state.items = prev;
          renderMain();
          flash('Could not remove that item. Try again.');
        });
      });
      foot.appendChild(del);
    }
    var report = el('button', 'btn-secondary');
    report.innerHTML = SVG.flag + 'Report';
    report.addEventListener('click', function () {
      closeSheet();
      api('/api/items/' + item.id + '/report', { method: 'POST' })
        .then(function () { flash('Report sent to the group’s admins.'); })
        .catch(function () { flash('Could not send that report. Try again.'); });
    });
    foot.appendChild(report);
    sheet.appendChild(foot);
  }

  // A small form sheet: Cancel, the title and the primary action stay at
  // the top, above the keyboard.
  function formSheet(title, actionLabel, placeholder, submit) {
    var sheet = sheetShell(true);
    var hd = el('div', 'hd');
    var cancel = el('button', 'x', 'Cancel');
    cancel.addEventListener('click', closeSheet);
    var titleEl = el('h2', 'h', title);
    var go = el('button', 'btn-primary', actionLabel);
    hd.appendChild(cancel);
    hd.appendChild(titleEl);
    hd.appendChild(go);
    sheet.appendChild(hd);

    sheet.appendChild(el('p', 'section-label', 'Name'));
    var input = el('input', 'field');
    input.type = 'text';
    input.placeholder = placeholder;
    input.maxLength = title === 'Add item' ? 80 : 60;
    sheet.appendChild(input);
    var problem = el('p', 'sub');
    problem.style.marginTop = '8px';
    sheet.appendChild(problem);

    function run() {
      var name = input.value.trim();
      if (!name) { problem.textContent = 'Give it a name first.'; input.focus(); return; }
      go.disabled = true;
      submit(name).then(function () {
        closeSheet();
      }).catch(function (err) {
        go.disabled = false;
        problem.textContent = err.status === 401
          ? 'Make an account to do that.'
          : 'That did not work. Try again.';
      });
    }
    go.addEventListener('click', run);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
    setTimeout(function () { input.focus(); }, 50);
    return sheet;
  }

  function openAddSheet() {
    if (!state.listId) return;
    formSheet('Add item', 'Add', 'e.g. Zuni Cafe', function (name) {
      return api('/api/lists/' + state.listId + '/items', { method: 'POST', body: { name: name } })
        .then(function (d) {
          state.items.push(d.item);
          renderMain();
        });
    });
  }

  function openNewListSheet() {
    formSheet('New list', 'Create', 'e.g. Bay Area restaurants', function (name) {
      return api('/api/lists', { method: 'POST', body: { name: name } })
        .then(function (d) {
          state.lists.unshift(d.list);
          state.listId = d.list.id;
          loadList();
        });
    });
  }

  function openPickerSheet() {
    var sheet = sheetShell(true);
    sheetHeader(sheet, 'Lists', null, closeSheet);
    var list = el('div', 'list');
    state.lists.forEach(function (l) {
      var row = el('div', 'list-row');
      row.style.cursor = 'pointer';
      var name = el('span', null, l.name);
      row.appendChild(name);
      if (l.demo) {
        var note = el('span', null, ' (Staging demo)');
        note.setAttribute('data-usernode-demo-note', '');
        note.style.color = 'rgb(var(--muted))';
        row.appendChild(note);
      }
      var right = el('span');
      right.style.cssText = 'display:flex;align-items:center;gap:4px;margin-left:auto';
      if (me && l.created_by === me.username) {
        var del = el('button', 'x');
        del.setAttribute('aria-label', 'Delete list');
        del.innerHTML = SVG.trash;
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!window.confirm('Delete the list "' + l.name + '"? Its items and votes go with it.')) return;
          api('/api/lists/' + l.id, { method: 'DELETE' }).then(function () {
            closeSheet();
            state.lists = state.lists.filter(function (x) { return x.id !== l.id; });
            if (state.listId === l.id) {
              if (state.lists.length) { state.listId = state.lists[0].id; loadList(); }
              else { state.phase = 'nolists'; state.items = []; state.list = null; render(); }
            } else {
              render();
            }
          }).catch(function () { flash('Could not delete that list. Try again.'); });
        });
        right.appendChild(del);
      }
      right.insertAdjacentHTML('beforeend', SVG.chevron);
      row.appendChild(right);
      row.addEventListener('click', function () {
        closeSheet();
        if (l.id !== state.listId) { state.listId = l.id; loadList(); }
      });
      list.appendChild(row);
    });
    sheet.appendChild(list);

    var newBtn = el('button', 'btn-secondary', 'New list');
    newBtn.style.cssText = 'width:100%;margin-top:12px';
    newBtn.addEventListener('click', openNewListSheet);
    sheet.appendChild(newBtn);
  }

  // ── Wire up the static screen ──────────────────────────────────────────
  $('addItemBtn').addEventListener('click', openAddSheet);
  $('listPick').addEventListener('click', openPickerSheet);
  Array.prototype.forEach.call($('viewSeg').children, function (span) {
    span.addEventListener('click', function () {
      if (state.view === span.dataset.view) return;
      state.view = span.dataset.view;
      renderMain();
      setHint();
      var seg = $('viewSeg');
      Array.prototype.forEach.call(seg.children, function (s) {
        s.classList.toggle('on', s === span);
        s.setAttribute('aria-selected', s === span ? 'true' : 'false');
      });
    });
    span.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); span.click(); }
    });
  });

  boot();
})();