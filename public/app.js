/* Tier List client: state, fetching, rendering, drag, sheet, menu, polling.
 *
 * Class names are written as whole literals everywhere — Tailwind compiles
 * this file's strings, and a class assembled from fragments is invisible to
 * the compiler.
 */
(function () {
  'use strict';

  var TC = window.TierCrowd;
  var TIERS = TC.TIERS;

  // Class names as whole literals — Tailwind compiles this file's strings,
  // and a class assembled from fragments is invisible to the compiler.
  var MARK_CLASS = { S: 'mark mark-s', A: 'mark mark-a', B: 'mark mark-b',
    C: 'mark mark-c', D: 'mark mark-d' };
  var PICK_CLASS = { S: 'tier-pick tier-pick-s', A: 'tier-pick tier-pick-a',
    B: 'tier-pick tier-pick-b', C: 'tier-pick tier-pick-c',
    D: 'tier-pick tier-pick-d' };
  var FILL_CLASS = { S: 'tally-fill tally-fill-s', A: 'tally-fill tally-fill-a',
    B: 'tally-fill tally-fill-b', C: 'tally-fill tally-fill-c',
    D: 'tally-fill tally-fill-d' };

  // ── Tokens and the demo gate ─────────────────────────────────────────────
  // The iframe load carries ?token=; later fetches forward it as
  // x-usernode-token. The demo query (?demo=1) is the page's own and is
  // passed through to every API call, so demo data only ever shows behind
  // the same gate that showed the page.
  var params = new URLSearchParams(location.search);
  var TOKEN = params.get('token') || (window.usernode && window.usernode.token) || '';
  if (!TOKEN) {
    try { TOKEN = sessionStorage.getItem('tierlist:token') || ''; } catch (e) {}
  }
  if (TOKEN) { try { sessionStorage.setItem('tierlist:token', TOKEN); } catch (e) {} }
  var DEMO = params.get('demo') === '1';

  function api(path, opts) {
    opts = opts || {};
    var url = path + (path.indexOf('?') >= 0 ? '&' : '?') + 'r=' + encodeURIComponent(String(reqSeq));
    if (DEMO) url += '&demo=1';
    reqSeq++;
    var headers = opts.headers || {};
    if (TOKEN) headers['x-usernode-token'] = TOKEN;
    return fetch(url, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }
  var reqSeq = 1;

  // ── State ────────────────────────────────────────────────────────────────
  var state = {
    phase: 'loading', // loading | empty | error | ready
    lists: [],
    detail: null, // { list, viewerId, items }
    view: 'your', // 'your' | 'crowd'
    writeInFlight: false,
    dragging: false,
  };
  var sheet = null; // the open unNative sheet, with its item id

  var el = function (id) { return document.getElementById(id); };
  var blocks = { loading: el('block-loading'), empty: el('block-empty'),
    error: el('block-error'), app: el('block-app') };

  function showPhase(phase) {
    state.phase = phase;
    Object.keys(blocks).forEach(function (k) {
      blocks[k].hidden = k !== phase;
    });
  }

  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Derived helpers ──────────────────────────────────────────────────────
  function viewerTier(item) {
    var viewerId = state.detail && state.detail.viewerId;
    if (!viewerId) return null;
    for (var i = 0; i < item.votes.length; i++) {
      if (item.votes[i].user_id === viewerId) return item.votes[i].tier;
    }
    return null;
  }

  function voteCount(item) { return item.votes.length; }

  function markClass(tier) {
    return tier ? MARK_CLASS[tier] : 'mark mark-none';
  }

  function chipNote(item, listIsDemo) {
    if (listIsDemo) return 'Staging demo';
    if (state.view === 'crowd') {
      var n = voteCount(item);
      return n === 1 ? '1 vote' : n + ' votes';
    }
    return null;
  }

  function sortChips(a, b) {
    if (state.view === 'your') return 0; // order is set by the caller
    var d = voteCount(b) - voteCount(a);
    return d !== 0 ? d : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  function makeChip(item, listIsDemo) {
    var markTier = state.view === 'your' ? TC.crowdTier(item.votes) : viewerTier(item);
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.setAttribute('data-item', String(item.id));
    var label = item.name + ', ' + (state.view === 'your' ? 'crowd' : 'your') + ' tier ';
    label += markTier ? markTier : 'not decided';
    chip.setAttribute('aria-label', label);

    var mark = document.createElement('span');
    mark.className = markClass(markTier);
    mark.textContent = markTier || '';
    chip.appendChild(mark);

    var text = document.createElement('span');
    text.className = 'flex min-w-0 flex-col';
    var name = document.createElement('span');
    name.className = 'chip-name';
    name.textContent = item.name;
    text.appendChild(name);
    var note = chipNote(item, listIsDemo);
    if (note) {
      var noteEl = document.createElement('span');
      noteEl.className = 'chip-note';
      noteEl.textContent = note;
      text.appendChild(noteEl);
    }
    chip.appendChild(text);
    return chip;
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function placeChips(container, chips) {
    clearChildren(container);
    chips.forEach(function (c) { container.appendChild(c.el); });
  }

  function render() {
    if (state.phase !== 'app' || !state.detail) return;
    var detail = state.detail;
    var list = detail.list;
    var isDemo = !!list.is_demo;
    var items = detail.items;

    el('list-title').textContent = list.title;

    // Meta line: items, and how many distinct people have voted.
    var voters = {};
    items.forEach(function (it) {
      it.votes.forEach(function (v) { voters[v.username] = true; });
    });
    var voterCount = Object.keys(voters).length;
    el('list-meta').textContent = items.length + ' items, ' +
      voterCount + (voterCount === 1 ? ' person ranking' : ' people ranking');

    // The view switch and its legend line.
    el('view-your').setAttribute('aria-pressed', state.view === 'your' ? 'true' : 'false');
    el('view-crowd').setAttribute('aria-pressed', state.view === 'crowd' ? 'true' : 'false');
    el('legend-text').textContent = state.view === 'your'
      ? "beside an item is the crowd's tier"
      : 'beside an item is your tier';

    // The ladder: bucket the items per view, then place them.
    var buckets = {};
    TIERS.forEach(function (t) { buckets[t] = []; });
    var trayItems = [];
    var trayLabel = el('tray-label');
    if (state.view === 'your') {
      items.forEach(function (item) {
        var mine = viewerTier(item);
        if (mine) buckets[mine].push(item);
        else trayItems.push(item);
      });
      trayLabel.textContent = 'Not ranked yet';
      // Within a tier, the order I placed them; the tray, the order added.
      TIERS.forEach(function (t) {
        buckets[t].sort(function (a, b) {
          var ta = placedAtOf(a), tb = placedAtOf(b);
          return new Date(ta) - new Date(tb);
        });
      });
      trayItems.sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
    } else {
      items.forEach(function (item) {
        var ct = TC.crowdTier(item.votes);
        if (ct) buckets[ct].push(item);
        else trayItems.push(item);
      });
      trayLabel.textContent = 'No votes yet';
      TIERS.forEach(function (t) { buckets[t].sort(sortChips); });
      trayItems.sort(function (a, b) {
        return new Date(a.created_at) - new Date(b.created_at);
      });
    }

    TIERS.forEach(function (t) {
      var container = document.querySelector('.tier-items[data-tier="' + t + '"]');
      var chips = buckets[t].map(function (item) {
        return { item: item, el: makeChip(item, isDemo) };
      });
      chips.sort(function (a, b) { return sortChips(a.item, b.item); });
      placeChips(container, chips);
    });

    var tray = el('tray');
    var trayChips = trayItems.map(function (item) {
      return { item: item, el: makeChip(item, isDemo) };
    });
    placeChips(tray, trayChips);

    // A list with no items yet points at the add form instead.
    var hint = document.querySelector('#block-app section[aria-label="Not ranked yet"] p');
    hint.textContent = items.length === 0
      ? 'Add the first item below.'
      : 'Drag an item into a tier. Tap it to see who put it where.';

    if (sheet) renderSheet();
  }

  function placedAtOf(item) {
    var viewerId = state.detail && state.detail.viewerId;
    for (var i = 0; i < item.votes.length; i++) {
      if (item.votes[i].user_id === viewerId) return item.votes[i].placed_at;
    }
    return item.created_at;
  }
  // ── Data loading ─────────────────────────────────────────────────────────
  var LAST_KEY = 'tierlist:last';

  function findItem(id) {
    if (!state.detail) return null;
    for (var i = 0; i < state.detail.items.length; i++) {
      if (state.detail.items[i].id === id) return state.detail.items[i];
    }
    return null;
  }

  function loadDetail(id) {
    try { localStorage.setItem(LAST_KEY, String(id)); } catch (e) {}
    return api('/api/lists/' + id).then(function (res) {
      if (!res.ok) throw new Error('load list');
      state.detail = res.data;
      showPhase('app');
      render();
    });
  }

  function boot() {
    if (sheet) { sheet.handle.dismiss(); sheet = null; }
    showPhase('loading');
    return api('/api/lists').then(function (res) {
      if (!res.ok) throw new Error('load lists');
      state.lists = res.data.lists || [];
      if (state.lists.length === 0) { showPhase('empty'); return null; }
      // The id from last time, when it is still offered; a demo list id on a
      // plain request is not, and falls back to the first list.
      var saved = 0;
      try { saved = Number(localStorage.getItem(LAST_KEY)); } catch (e) {}
      var chosen = state.lists.filter(function (l) { return l.id === saved; })[0] || state.lists[0];
      return loadDetail(chosen.id).catch(function (err) {
        // The saved list vanished under us: fall back to the first list.
        if (chosen.id !== state.lists[0].id) return loadDetail(state.lists[0].id);
        throw err;
      });
    }).catch(function () { showPhase('error'); });
  }

  // Other people's changes: polled while visible, on return, and on pull.
  function refresh() {
    if (!state.detail || state.dragging || state.writeInFlight) return Promise.resolve();
    if (document.visibilityState !== 'visible') return Promise.resolve();
    return api('/api/lists/' + state.detail.list.id).then(function (res) {
      if (!res.ok) return; // keep what we have; the next poll tries again
      state.detail = res.data;
      render();
    }).catch(function () {});
  }

  // ── Optimistic writes ────────────────────────────────────────────────────
  function setViewerVote(item, tier) {
    var viewerId = state.detail.viewerId;
    for (var i = 0; i < item.votes.length; i++) {
      if (item.votes[i].user_id === viewerId) {
        item.votes[i].tier = tier;
        item.votes[i].placed_at = new Date().toISOString();
        return;
      }
    }
    item.votes.push({ user_id: viewerId, username: 'You', tier: tier,
      placed_at: new Date().toISOString() });
  }

  function clearViewerVote(item) {
    var viewerId = state.detail.viewerId;
    item.votes = item.votes.filter(function (v) { return v.user_id !== viewerId; });
  }

  function revertVote(item, before) {
    state.detail.items = state.detail.items.map(function (it) {
      return it.id === item.id ? before : it;
    });
  }

  // ── The item sheet ───────────────────────────────────────────────────────
  function openSheet(itemId) {
    if (sheet) return;
    var item = findItem(itemId);
    if (!item) return;
    var inner = document.createElement('div');
    sheet = { id: itemId, inner: inner };
    sheet.handle = window.unNative.presentSheet({
      contentEl: inner,
      onDismiss: function () { sheet = null; },
    });
    renderSheet();
  }

  function renderSheet() {
    if (!sheet) return;
    var item = findItem(sheet.id);
    if (!item) { // removed by its adder while it was open
      var handle = sheet.handle; sheet = null;
      handle.dismiss();
      refresh();
      return;
    }
    var detail = state.detail;
    var isDemo = !!detail.list.is_demo;
    var viewerId = detail.viewerId;
    var mine = viewerTier(item);

    clearChildren(sheet.inner);
    var wrap = document.createElement('div');
    wrap.className = 'flex flex-col px-4 pb-8 pt-1';

    var name = document.createElement('h2');
    name.className = 'm-0 font-rounded text-heading';
    name.textContent = item.name;
    wrap.appendChild(name);

    var sub = document.createElement('p');
    sub.className = 'm-0 mt-0.5 text-small text-muted';
    sub.textContent = (isDemo ? 'Staging demo, ' : '') + 'added by ' + item.added_by_name;
    wrap.appendChild(sub);

    var tierRow = document.createElement('div');
    tierRow.className = 'mt-4 flex items-center justify-between';
    var tierLabel = document.createElement('span');
    tierLabel.className = 'section-label mb-0';
    tierLabel.textContent = 'Your tier';
    tierRow.appendChild(tierLabel);
    if (viewerId && mine) {
      var unrank = document.createElement('button');
      unrank.type = 'button';
      unrank.className = 'flex min-h-11 items-center text-small font-medium text-accent';
      unrank.textContent = 'Move to Not ranked';
      unrank.addEventListener('click', function () {
        var before = JSON.parse(JSON.stringify(item));
        state.writeInFlight = true;
        clearViewerVote(item);
        render();
        api('/api/items/' + item.id + '/placement', { method: 'DELETE' })
          .then(function (res) {
            if (!res.ok) { revertVote(item, before); toastFailure(res, item); }
          })
          .catch(function () { revertVote(item, before); })
          .finally(function () { state.writeInFlight = false; render(); });
      });
      tierRow.appendChild(unrank);
    }
    wrap.appendChild(tierRow);

    var picks = document.createElement('div');
    picks.className = 'flex gap-2';
    picks.setAttribute('role', 'group');
    picks.setAttribute('aria-label', 'Pick a tier');
    TIERS.forEach(function (t) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = PICK_CLASS[t];
      b.textContent = t;
      b.setAttribute('aria-pressed', mine === t ? 'true' : 'false');
      b.setAttribute('aria-label', 'Move to tier ' + t);
      b.addEventListener('click', function () {
        if (mine === t) return;
        if (!viewerId) { // a guest: let the bridge ask for an account
          api('/api/items/' + item.id + '/placement', { method: 'PUT', body: { tier: t } });
          return;
        }
        var before = JSON.parse(JSON.stringify(item));
        state.writeInFlight = true;
        setViewerVote(item, t);
        render();
        api('/api/items/' + item.id + '/placement', { method: 'PUT', body: { tier: t } })
          .then(function (res) {
            if (!res.ok) { revertVote(item, before); toastFailure(res, item); }
          })
          .catch(function () { revertVote(item, before); })
          .finally(function () { state.writeInFlight = false; render(); });
      });
      picks.appendChild(b);
    });
    wrap.appendChild(picks);

    var whoLabel = document.createElement('span');
    whoLabel.className = 'section-label mt-5';
    whoLabel.textContent = 'Who put it where';
    wrap.appendChild(whoLabel);

    var total = voteCount(item);
    var crowd = TC.crowdTier(item.votes);
    var crowdLine = document.createElement('p');
    crowdLine.className = 'm-0 text-body';
    if (crowd) {
      var counts = TC.tally(item.votes);
      var top = 0;
      counts.forEach(function (c) { if (c.count > top) top = c.count; });
      crowdLine.innerHTML = '';
      var strong = document.createElement('strong');
      strong.textContent = crowd;
      crowdLine.appendChild(document.createTextNode('Crowd says '));
      crowdLine.appendChild(strong);
      crowdLine.appendChild(document.createTextNode(', with ' + top + ' of ' + total +
        (total === 1 ? ' vote' : ' votes')));
    } else {
      crowdLine.textContent = 'No votes yet';
    }
    wrap.appendChild(crowdLine);

    var tally = document.createElement('ul');
    tally.className = 'm-0 mt-2.5 flex list-none flex-col gap-2.5 p-0';
    TC.tally(item.votes).forEach(function (row) {
      var li = document.createElement('li');
      li.className = 'tally-row';
      var mark = document.createElement('span');
      mark.className = MARK_CLASS[row.tier];
      mark.textContent = row.tier;
      li.appendChild(mark);
      var track = document.createElement('span');
      track.className = 'tally-track';
      var fill = document.createElement('span');
      fill.className = FILL_CLASS[row.tier];
      fill.style.width = (total > 0 ? Math.round(row.count / total * 100) : 0) + '%';
      track.appendChild(fill);
      li.appendChild(track);
      var count = document.createElement('span');
      count.className = 'text-right text-small font-semibold';
      count.textContent = String(row.count);
      li.appendChild(count);
      var who = document.createElement('span');
      who.className = 'tally-who';
      // The viewer reads as "You", listed first in their own tier.
      var names = row.voters.map(function (v) {
        return v.user_id === viewerId ? 'You' : v.username;
      });
      if (viewerId) {
        names.sort(function (a, b) { return (a === 'You' ? -1 : 0) - (b === 'You' ? -1 : 0) || 0; });
      }
      who.textContent = names.length ? names.join(', ') : 'No one yet';
      li.appendChild(who);
      tally.appendChild(li);
    });
    wrap.appendChild(tally);

    // Only the person who added it can remove it, after a confirm.
    if (viewerId && item.added_by === viewerId) {
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-secondary mt-6 w-full text-danger';
      remove.textContent = 'Remove item';
      remove.addEventListener('click', function () {
        window.unNative.alert({
          title: 'Remove ' + item.name + '?',
          message: "Everyone's votes on it go too.",
          buttons: [
            { label: 'Cancel', style: 'cancel' },
            { label: 'Remove', style: 'destructive', handler: function () {
              state.writeInFlight = true;
              api('/api/items/' + item.id, { method: 'DELETE' })
                .then(function (res) {
                  if (res.ok) {
                    sheet.handle.dismiss(); sheet = null;
                    state.writeInFlight = false; // refresh() skips while a write is in flight
                    refresh();
                  }
                  else { window.unNative.toast(res.status === 404
                    ? 'That item was removed.' : "Couldn't remove " + item.name + '. Try again.'); }
                })
                .catch(function () {})
                .finally(function () { state.writeInFlight = false; });
            } },
          ],
        });
      });
      wrap.appendChild(remove);
    }

    sheet.inner.appendChild(wrap);
  }

  function toastFailure(res, item) {
    if (res && res.status === 401) return; // the bridge asks for an account
    if (res && res.status === 404) {
      window.unNative.toast('That item was removed.');
      refresh();
      return;
    }
    window.unNative.toast("Couldn't move " + item.name + '. Try again.');
  }

  // ── Drag ─────────────────────────────────────────────────────────────────
  // Pointer events. A mouse or pen lifts after 4 px of movement; touch lifts
  // after a 300 ms long press that has not moved more than 8 px, and joins
  // the gesture arbiter so page scroll and pull-to-refresh keep working when
  // a finger just scrolls. A press without a drag opens the sheet.
  var drag = null;

  function attachDrag(container) {
    container.addEventListener('pointerdown', function (e) {
      if (state.view !== 'your' || drag) return;
      if (!e.isPrimary) return;
      var chipEl = e.target && e.target.closest ? e.target.closest('.chip') : null;
      if (!chipEl || !container.contains(chipEl)) return;
      drag = {
        container: container, chipEl: chipEl,
        itemId: Number(chipEl.getAttribute('data-item')),
        startX: e.clientX, startY: e.clientY,
        pointerType: e.pointerType, pointerId: e.pointerId,
        active: false, claimed: false, longTimer: null, clone: null,
        target: null, grabX: 0, grabY: 0, lastX: e.clientX, lastY: e.clientY,
      };
      if (drag.pointerType === 'touch') {
        drag.longTimer = setTimeout(function () {
          if (drag && !drag.active) beginDrag();
        }, 300);
      }
    });

    // A tap (a press that never became a drag) opens the sheet.
    container.addEventListener('click', function (e) {
      if (suppressClick) { suppressClick = false; return; }
      var chipEl = e.target && e.target.closest ? e.target.closest('.chip') : null;
      if (!chipEl || !container.contains(chipEl)) return;
      openSheet(Number(chipEl.getAttribute('data-item')));
    });
  }

  function cancelPress() {
    if (!drag) return;
    if (drag.longTimer) clearTimeout(drag.longTimer);
    drag = null;
  }

  function beginDrag() {
    if (!drag) return;
    if (drag.pointerType === 'touch') {
      // One intent lock: if the kit's own recognizers hold it, back off.
      var token = {};
      if (!window.unNative.gestures.claim('touch', token)) { cancelPress(); return; }
      drag.claimed = true; drag.token = token;
    }
    var rect = drag.chipEl.getBoundingClientRect();
    drag.grabX = drag.lastX - rect.left;
    drag.grabY = drag.lastY - rect.top;
    var clone = drag.chipEl.cloneNode(true);
    clone.className = 'chip chip-lifted';
    clone.style.width = rect.width + 'px';
    clone.style.left = '0px';
    clone.style.top = '0px';
    if (!REDUCED) clone.style.transform = 'scale(1.05)';
    document.body.appendChild(clone);
    drag.clone = clone;
    drag.chipEl.style.opacity = '0.4';
    drag.active = true;
    state.dragging = true;
    moveClone(drag.lastX, drag.lastY);
    updateDropTarget(drag.lastX, drag.lastY);
    if (!REDUCED) requestAnimationFrame(autoScroll);
  }

  function moveClone(x, y) {
    if (!drag || !drag.clone) return;
    drag.clone.style.left = (x - drag.grabX) + 'px';
    drag.clone.style.top = (y - drag.grabY) + 'px';
    drag.lastX = x; drag.lastY = y;
  }

  function dropKeyAt(x, y) {
    var under = document.elementFromPoint(x, y);
    var zone = under && under.closest ? under.closest('[data-drop]') : null;
    return zone ? zone.getAttribute('data-drop') : null;
  }

  function updateDropTarget(x, y) {
    var key = dropKeyAt(x, y);
    if (key === drag.target) return;
    if (drag.target !== null) {
      var prev = document.querySelector('[data-drop="' + drag.target + '"]');
      if (prev) prev.classList.remove('drop-target');
    }
    drag.target = key;
    if (key !== null) {
      var next = document.querySelector('[data-drop="' + key + '"]');
      if (next) next.classList.add('drop-target');
    }
  }

  // Nudge the window while the pointer rides an edge.
  function autoScroll() {
    if (!drag || !drag.active) return;
    var margin = 60;
    var speed = 12;
    if (drag.lastY < margin) window.scrollBy(0, -speed);
    else if (drag.lastY > window.innerHeight - margin) window.scrollBy(0, speed);
    requestAnimationFrame(autoScroll);
  }

  function endDrag(commit) {
    if (!drag) return;
    if (drag.longTimer) clearTimeout(drag.longTimer);
    if (drag.target !== null) {
      var prev = document.querySelector('[data-drop="' + drag.target + '"]');
      if (prev) prev.classList.remove('drop-target');
    }
    if (drag.clone) drag.clone.remove();
    if (drag.chipEl) drag.chipEl.style.opacity = '';
    if (drag.claimed) window.unNative.gestures.release('touch');
    var d = drag;
    drag = null;
    state.dragging = false;
    suppressClick = true;
    setTimeout(function () { suppressClick = false; }, 0);
    if (!commit || !d.active) { render(); return; }

    var item = findItem(d.itemId);
    if (!item) { refresh(); return; }
    var key = d.target;
    var mine = viewerTier(item);
    if (key === null || key === mine || (key === 'none' && !mine)) {
      render(); // dropped where it already was, or nowhere: nothing to save
      return;
    }
    var before = JSON.parse(JSON.stringify(item));
    state.writeInFlight = true;
    if (key === 'none') {
      clearViewerVote(item);
      render();
      api('/api/items/' + item.id + '/placement', { method: 'DELETE' })
        .then(function (res) { if (!res.ok) { revertVote(item, before); toastFailure(res, item); render(); } })
        .catch(function () { revertVote(item, before); render(); })
        .finally(function () { state.writeInFlight = false; });
    } else {
      setViewerVote(item, key);
      render();
      api('/api/items/' + item.id + '/placement', { method: 'PUT', body: { tier: key } })
        .then(function (res) { if (!res.ok) { revertVote(item, before); toastFailure(res, item); render(); } })
        .catch(function () { revertVote(item, before); render(); })
        .finally(function () { state.writeInFlight = false; });
    }
  }

  var suppressClick = false;

  window.addEventListener('pointermove', function (e) {
    if (!drag) return;
    if (e.pointerId !== drag.pointerId) return;
    var dx = e.clientX - drag.startX;
    var dy = e.clientY - drag.startY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (!drag.active) {
      if (drag.pointerType === 'touch') {
        if (dist > 8) cancelPress(); // the finger is scrolling, not dragging
      } else if (dist > 4) {
        beginDrag();
      }
      return;
    }
    moveClone(e.clientX, e.clientY);
    updateDropTarget(e.clientX, e.clientY);
  });
  window.addEventListener('pointerup', function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.active) endDrag(true); else cancelPress();
  });
  window.addEventListener('pointercancel', function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (drag.active) endDrag(false); else cancelPress();
  });
  // Once lifted, a touch drag must not scroll the page under the finger.
  document.addEventListener('touchmove', function (e) {
    if (drag && drag.active && drag.pointerType === 'touch') e.preventDefault();
  }, { passive: false });

  // ── The list menu ────────────────────────────────────────────────────────
  el('list-picker').addEventListener('click', function () {
    if (!state.detail) return;
    var items = state.lists.map(function (l) {
      return { label: l.title, disabled: l.id === state.detail.list.id, listId: l.id };
    });
    items.push({ label: 'New list' });
    window.unNative.menu({ anchorEl: el('list-picker'), title: 'Lists', items: items })
      .then(function (choice) {
        if (!choice) return;
        if (choice.listId) {
          if (choice.listId !== state.detail.list.id) loadDetail(choice.listId).catch(function () {});
        } else if (choice.label === 'New list') {
          newListDialog();
        }
      });
  });

  function newListDialog() {
    window.unNative.alert({
      title: 'New list',
      field: { placeholder: 'e.g. Best burritos' },
      buttons: [
        { label: 'Cancel', style: 'cancel' },
        { label: 'Create list', handler: function () {} },
      ],
    }).then(function (r) {
      if (!r || !r.button || r.button.label !== 'Create list') return;
      var title = (r.value || '').replace(/\s+/g, ' ').trim();
      if (!title) { window.unNative.toast('Give the list a name.'); return; }
      api('/api/lists', { method: 'POST', body: { title: title } }).then(function (res) {
        if (res.ok && res.data.list) {
          state.writeInFlight = false;
          loadDetail(res.data.list.id).catch(function () {});
        } else if (res.status === 401) {
          // the bridge asks for an account
        } else if (res.status === 400) {
          window.unNative.toast('List names are 1 to 60 characters.');
        } else {
          window.unNative.toast("Couldn't create the list. Try again.");
        }
      }).catch(function () {});
    });
  }

  // ── Add an item ──────────────────────────────────────────────────────────
  el('add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = el('add-name');
    var name = input.value.replace(/\s+/g, ' ').trim();
    var err = el('add-error');
    err.hidden = true;
    if (!name) return;
    state.writeInFlight = true;
    api('/api/lists/' + state.detail.list.id + '/items', { method: 'POST', body: { name: name } })
      .then(function (res) {
        if (res.ok) {
          input.value = '';
          state.detail.items.push(Object.assign({ votes: [] }, res.data.item));
          render();
        } else if (res.status === 409) {
          err.textContent = name + ' is already on this list.';
          err.hidden = false;
        } else if (res.status === 400) {
          err.textContent = 'Item names are 1 to 60 characters.';
          err.hidden = false;
        } else if (res.status !== 401) {
          err.textContent = "Couldn't add " + name + '. Try again.';
          err.hidden = false;
        }
      })
      .catch(function () {})
      .finally(function () { state.writeInFlight = false; });
  });

  // ── The first list (empty state) ─────────────────────────────────────────
  el('create-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = el('create-name');
    var title = input.value.replace(/\s+/g, ' ').trim();
    if (!title) return;
    api('/api/lists', { method: 'POST', body: { title: title } }).then(function (res) {
      if (res.ok && res.data.list) {
        input.value = '';
        loadDetail(res.data.list.id).catch(function () {});
      } else if (res.status === 400) {
        window.unNative.toast('List names are 1 to 60 characters.');
      }
    }).catch(function () {});
  });

  el('retry-btn').addEventListener('click', function () { boot(); });
  el('view-your').addEventListener('click', function () {
    if (state.view !== 'your') { state.view = 'your'; render(); }
  });
  el('view-crowd').addEventListener('click', function () {
    if (state.view !== 'crowd') { state.view = 'crowd'; render(); }
  });

  // ── Polling and pull to refresh ──────────────────────────────────────────
  setInterval(function () {
    if (document.visibilityState === 'visible') refresh();
  }, 20000);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refresh();
  });
  if (window.unNative && window.unNative.attachPullToRefresh) {
    window.unNative.attachPullToRefresh(window, function () { return refresh(); });
  }

  // ── Go ───────────────────────────────────────────────────────────────────
  document.querySelectorAll('[data-drop]').forEach(function (c) { attachDrag(c); });
  boot();
})();
