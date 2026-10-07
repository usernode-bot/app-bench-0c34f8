/*
 * Bread Bot's screen: the calculator and the saved-recipe list.
 *
 * State is {bread, hydration, count, size}. The result renders only when
 * Calculate is tapped (or a saved recipe is opened); until then a changed
 * result is marked stale, never silently rewritten.
 */
(function () {
  'use strict';

  var Bread = window.Bread;

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  var state = { bread: 'sourdough', hydration: 75, count: 2, size: 800 };
  var calculated = null;  // the inputs the shown result was computed from
  var openedName = null;  // name of the saved recipe the result came from
  var savedInputs = null; // the inputs last saved
  var recipes = [];
  var canSave = false;
  var listState = 'loading'; // loading | ok | error

  var TOKEN = new URLSearchParams(location.search).get('token') || '';
  var DEMO = new URLSearchParams(location.search).has('demo');

  var locale;
  try {
    locale = window.usernode && typeof window.usernode.getUserLocale === 'function'
      ? window.usernode.getUserLocale() : null;
  } catch (_) { locale = null; }
  if (typeof locale !== 'string' || !locale) locale = undefined;

  // ── API ────────────────────────────────────────────────────────────────

  function api(path, opts) {
    opts = opts || {};
    var url = new URL(path, location.origin);
    if (DEMO) url.searchParams.set('demo', '1');
    var headers = { 'x-usernode-token': TOKEN };
    if (opts.body) headers['content-type'] = 'application/json';
    return fetch(url.toString(), {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) {
          var err = new Error('API ' + res.status);
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  function toast(msg, opts) {
    if (window.unNative && window.unNative.toast) window.unNative.toast(msg, opts);
  }

  var dateFmt = null;
  function formatDate(iso) {
    if (!dateFmt) {
      try { dateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }); }
      catch (_) { dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }); }
    }
    try { return dateFmt.format(new Date(iso)); }
    catch (_) { return ''; }
  }

  function motionOk() {
    return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // ── The form ───────────────────────────────────────────────────────────

  var chips = [];
  var segments = [];

  function renderChips() {
    var wrap = $('bread-chips');
    wrap.textContent = '';
    chips = [];
    Object.keys(Bread.BREADS).forEach(function (key) {
      var b = Bread.BREADS[key];
      var btn = el('button', 'chip', b.label);
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', state.bread === key ? 'true' : 'false');
      btn.addEventListener('click', function () {
        if (state.bread === key) return;
        state.bread = key;
        state.hydration = b.def;
        renderForm();
        onChange();
      });
      wrap.appendChild(btn);
      chips.push({ key: key, btn: btn });
    });
  }

  function updateChips() {
    chips.forEach(function (c) {
      c.btn.setAttribute('aria-checked', state.bread === c.key ? 'true' : 'false');
    });
  }

  function renderSegments() {
    var wrap = $('size-segments');
    wrap.textContent = '';
    segments = [];
    Bread.SIZES.forEach(function (s) {
      var btn = el('button', '', s === 1000 ? '1 kg' : s + ' g');
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', state.size === s ? 'true' : 'false');
      btn.addEventListener('click', function () {
        if (state.size === s) return;
        state.size = s;
        updateSegments();
        onChange();
      });
      wrap.appendChild(btn);
      segments.push({ size: s, btn: btn });
    });
  }

  function updateSegments() {
    segments.forEach(function (s) {
      s.btn.setAttribute('aria-checked', state.size === s.size ? 'true' : 'false');
    });
  }

  // The crumb slice's ten air holes: base radius, grown or shrunk live
  // while the slider moves.
  var HOLES = [
    [34, 40, 5.2], [58, 30, 6], [84, 42, 5.2], [26, 64, 4.3], [48, 56, 6],
    [72, 62, 5.2], [95, 66, 4.3], [62, 76, 3.4], [38, 76, 2.6], [86, 22, 2.6]
  ];

  function buildHoles() {
    var g = $('crumb-holes');
    g.textContent = '';
    HOLES.forEach(function (h) {
      var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', h[0]);
      c.setAttribute('cy', h[1]);
      c.setAttribute('r', h[2]);
      g.appendChild(c);
    });
  }

  function renderCrumb() {
    var f = 0.35 + 1.3 * (state.hydration - 50) / 40;
    var circles = $('crumb-holes').querySelectorAll('circle');
    for (var i = 0; i < circles.length; i++) {
      circles[i].setAttribute('r', (HOLES[i][2] * f).toFixed(2));
    }
    $('crumb-title').textContent = 'Crumb at ' + state.hydration + '% hydration';
  }

  function renderHydration() {
    var b = Bread.BREADS[state.bread];
    var slider = $('hydration');
    slider.value = String(state.hydration);
    slider.setAttribute('aria-valuetext', state.hydration + ' percent');
    $('hydration-value').textContent = state.hydration + '%';
    $('hydration-hint').textContent = 'Suggested for ' + b.label.toLowerCase() +
      ': ' + b.range[0] + ' to ' + b.range[1] + '%';
    var band = $('range-band');
    band.style.left = ((b.range[0] - 50) / 40 * 100) + '%';
    band.style.width = ((b.range[1] - b.range[0]) / 40 * 100) + '%';
    renderCrumb();
  }

  function renderForm() {
    var batch = Bread.BREADS[state.bread].batch;
    $('count-label').textContent = batch ? 'Batches' : 'Loaves';
    $('size-label').textContent = batch ? 'Dough per batch' : 'Loaf size';
    $('count-value').textContent = String(state.count);
    updateChips();
    updateSegments();
    renderHydration();
  }

  // ── Stale state and the Save button ────────────────────────────────────

  function sameInputs(a, b) {
    return !!a && !!b && a.bread === b.bread && a.hydration === b.hydration &&
      a.count === b.count && a.size === b.size;
  }

  function updateStale() {
    var stale = !!calculated && !sameInputs(state, calculated);
    $('stale-note').hidden = !stale;
    $('result-body').classList.toggle('opacity-60', stale);
    return stale;
  }

  function updateSaveButton() {
    var stale = updateStale();
    var justSaved = canSave && sameInputs(state, savedInputs);
    $('save').disabled = !calculated || stale || justSaved;
    $('save-label').textContent = justSaved ? 'Saved' : 'Save recipe';
  }

  function onChange() {
    openedName = null;
    updateSaveButton();
  }

  // ── The result ─────────────────────────────────────────────────────────

  function focusResult() {
    var title = $('result-title');
    if (!title) return;
    title.scrollIntoView({ block: 'start', behavior: motionOk() ? 'smooth' : 'auto' });
    title.focus({ preventScroll: true });
  }

  function renderResult() {
    var r = Bread.calculate(calculated);
    var body = $('result-body');
    body.textContent = '';

    var head = el('div');
    var title = el('h2', 'text-title', openedName || r.title);
    title.id = 'result-title';
    title.tabIndex = -1;
    head.appendChild(title);
    head.appendChild(el('p', 'text-body text-muted', r.line));
    body.appendChild(head);

    var ing = el('div');
    ing.appendChild(el('p', 'section-label', 'Ingredients'));
    var ul = el('ul', 'list');
    r.ingredients.forEach(function (i) {
      var li = el('li', 'list-row');
      var grow = el('div', 'grow min-w-0');
      grow.appendChild(el('p', null, i.name));
      grow.appendChild(el('p', 'text-small text-muted', i.detail));
      li.appendChild(grow);
      li.appendChild(el('span', 'num', Bread.formatGrams(i.grams)));
      ul.appendChild(li);
    });
    ing.appendChild(ul);
    if (r.flourLine) ing.appendChild(el('p', 'mt-2 px-1 text-small text-muted', r.flourLine));
    body.appendChild(ing);

    var rise = el('div');
    rise.appendChild(el('p', 'section-label',
      'Rise, about ' + Bread.formatMinutes(Math.round(r.riseTotal / 10) * 10) + ' before baking'));
    var ulR = el('ul', 'list');
    r.riseSteps.forEach(function (s, ix) {
      var li = el('li', 'list-row');
      li.appendChild(el('span',
        'flex h-7 w-7 flex-none items-center justify-center rounded-full border border-line text-small font-semibold',
        String(ix + 1)));
      var grow = el('div', 'grow min-w-0');
      grow.appendChild(el('p', null, s.name));
      grow.appendChild(el('p', 'text-small text-muted', s.cue));
      li.appendChild(grow);
      li.appendChild(el('span', 'num', Bread.formatMinutes(s.minutes)));
      ulR.appendChild(li);
    });
    rise.appendChild(ulR);
    body.appendChild(rise);

    var bake = el('div');
    bake.appendChild(el('p', 'section-label', 'Bake'));
    var tempRow = el('div', 'mb-3 flex items-baseline gap-2 px-1');
    tempRow.appendChild(el('span', 'text-title tabular-nums', r.bake.mainC + '°C'));
    var fParts = [Bread.toF(r.bake.mainC) + '°F'];
    if (r.bake.secondC) fParts.push('then ' + r.bake.secondC + '°C (' + Bread.toF(r.bake.secondC) + '°F)');
    tempRow.appendChild(el('span', 'text-small text-muted', fParts.join(', ')));
    bake.appendChild(tempRow);
    var ulB = el('ul', 'list');
    r.bake.steps.forEach(function (s) {
      var li = el('li', 'list-row');
      var grow = el('div', 'grow min-w-0');
      grow.appendChild(el('p', null, s.name));
      grow.appendChild(el('p', 'text-small text-muted', s.detail));
      li.appendChild(grow);
      li.appendChild(el('span', 'num', Bread.formatMinutes(s.minutes)));
      ulB.appendChild(li);
    });
    bake.appendChild(ulB);
    var noteParts = [];
    if (r.bake.doneC) noteParts.push('Done at ' + r.bake.doneC + '°C (' + Bread.toF(r.bake.doneC) + '°F) inside.');
    if (r.bake.note) noteParts.push(r.bake.note);
    if (noteParts.length) bake.appendChild(el('p', 'mt-2 px-1 text-small text-muted', noteParts.join(' ')));
    body.appendChild(bake);
  }

  function calculateNow() {
    calculated = {
      bread: state.bread, hydration: state.hydration,
      count: state.count, size: state.size
    };
    renderResult();
    updateSaveButton();
    focusResult();
  }

  // ── Saved recipes ──────────────────────────────────────────────────────

  var BIN_SVG = '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

  var swipeHandles = [];

  function setSavedView(which) {
    $('saved-list').hidden = which !== 'list';
    $('saved-skeleton').hidden = which !== 'loading';
    $('saved-empty').hidden = which !== 'empty';
    $('saved-error').hidden = which !== 'error';
  }

  function setSavedCount() {
    var label = 'Saved';
    if (listState === 'ok' && recipes.length) label = 'Saved (' + recipes.length + ')';
    $('saved-jump-label').textContent = label;
  }

  function renderSaved() {
    swipeHandles.forEach(function (h) { try { h.detach(); } catch (_) { /* row is gone */ } });
    swipeHandles = [];
    var ul = $('saved-list');
    ul.textContent = '';
    recipes.forEach(function (r, ix) {
      var li = el('li', 'list-row gap-2 pr-1');
      var open = el('button', 'grow min-w-0 text-left');
      open.type = 'button';
      open.appendChild(el('p', null, r.name));
      open.appendChild(el('p', 'text-small text-muted', Bread.autoName(r)));
      open.addEventListener('click', function () { openRecipe(r); });
      li.appendChild(open);
      li.appendChild(el('span', 'whitespace-nowrap text-small text-muted', formatDate(r.createdAt)));
      var bin = el('button', 'icon-btn');
      bin.type = 'button';
      bin.setAttribute('aria-label', 'Delete ' + r.name);
      bin.innerHTML = BIN_SVG; // a constant, never user content
      bin.addEventListener('click', function () { deleteRecipe(ix); });
      li.appendChild(bin);
      ul.appendChild(li);
      if (window.unNative && window.unNative.attachSwipeActions) {
        try {
          swipeHandles.push(window.unNative.attachSwipeActions(li, {
            actions: [{ label: 'Delete', destructive: true, handler: function () { deleteRecipe(ix); } }]
          }));
        } catch (_) { /* swipe is polish; the bin still works */ }
      }
    });
    setSavedView(recipes.length ? 'list' : 'empty');
    setSavedCount();
  }

  function loadSaved() {
    listState = 'loading';
    setSavedView('loading');
    setSavedCount();
    api('/api/recipes').then(function (data) {
      recipes = (data && data.recipes) || [];
      canSave = !!(data && data.canSave);
      listState = 'ok';
      renderSaved();
      updateSaveButton();
    }).catch(function () {
      recipes = [];
      listState = 'error';
      setSavedView('error');
      setSavedCount();
    });
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function openRecipe(r) {
    // A saved recipe from an older formula version may no longer be valid:
    // clamp to the nearest values rather than fail.
    state.bread = Bread.BREADS[r.bread] ? r.bread : 'sourdough';
    state.hydration = clamp(Math.round(Number(r.hydration) || 0), 50, 90);
    state.count = clamp(Math.round(Number(r.count) || 0), 1, 12);
    state.size = Bread.SIZES.indexOf(Number(r.size)) !== -1 ? Number(r.size) : 800;
    openedName = r.name;
    calculated = {
      bread: state.bread, hydration: state.hydration,
      count: state.count, size: state.size
    };
    renderForm();
    renderResult();
    updateSaveButton();
    focusResult();
  }

  function saveRecipe() {
    if (!calculated) return;
    var inputs = calculated;
    var name = Bread.autoName(inputs);
    var askName = window.unNative && window.unNative.alert
      ? window.unNative.alert({
        title: 'Save recipe',
        field: { value: name, submitOnEnter: true },
        buttons: [
          { label: 'Cancel', style: 'cancel' },
          { label: 'Save' }
        ]
      }).then(function (res) {
        if (!res || !res.button || res.button.style === 'cancel') return null;
        var typed = res.value == null ? '' : String(res.value).trim();
        return typed ? typed.slice(0, 60) : name;
      })
      : Promise.resolve(name);
    askName.then(function (finalName) {
      if (finalName === null) return;
      return api('/api/recipes', {
        method: 'POST',
        body: {
          name: finalName, bread: inputs.bread,
          hydration: inputs.hydration, count: inputs.count, size: inputs.size
        }
      }).then(function (row) {
        savedInputs = {
          bread: inputs.bread, hydration: inputs.hydration,
          count: inputs.count, size: inputs.size
        };
        if (listState === 'ok') {
          if (row && row.id) recipes.unshift(row);
          renderSaved();
        } else {
          loadSaved(); // the list had failed: reload it with the new row in
        }
        updateSaveButton();
        toast('Recipe saved');
      }).catch(function (err) {
        if (err && err.status === 401 && err.body && err.body.error === 'account_required') {
          // A guest: the bridge asks them to make an account.
          if (window.usernode && typeof window.usernode.askForAccount === 'function') {
            window.usernode.askForAccount();
          }
          return;
        }
        toast("Couldn't save the recipe. Check your connection and try again.");
      });
    });
  }

  function deleteRecipe(ix) {
    var removed = recipes[ix];
    if (!removed) return;
    var at = ix;
    recipes.splice(at, 1);
    renderSaved();

    function restore() {
      recipes.splice(Math.min(at, recipes.length), 0, removed);
      renderSaved();
    }
    function commit() {
      api('/api/recipes/' + encodeURIComponent(removed.id), { method: 'DELETE' }).catch(function () {
        restore();
        toast("Couldn't delete the recipe.");
      });
    }

    if (window.unNative && window.unNative.toast) {
      // Deleting takes effect once the Undo message goes away, so Undo
      // needs no second request.
      window.unNative.toast('Recipe deleted', {
        priority: true,
        action: { label: 'Undo' },
        onClose: function (reason) {
          if (reason === 'action') restore();
          else commit();
        }
      });
    } else {
      commit();
    }
  }

  // ── Wiring ─────────────────────────────────────────────────────────────

  $('calculate').addEventListener('click', calculateNow);
  $('save').addEventListener('click', saveRecipe);
  $('saved-jump').addEventListener('click', function () {
    $('saved').scrollIntoView({ block: 'start', behavior: motionOk() ? 'smooth' : 'auto' });
  });
  $('saved-retry').addEventListener('click', loadSaved);

  $('hydration').addEventListener('input', function () {
    state.hydration = Number(this.value);
    renderHydration();
    onChange();
  });

  $('count-minus').addEventListener('click', function () {
    if (state.count <= 1) return;
    state.count -= 1;
    $('count-value').textContent = String(state.count);
    onChange();
  });
  $('count-plus').addEventListener('click', function () {
    if (state.count >= 12) return;
    state.count += 1;
    $('count-value').textContent = String(state.count);
    onChange();
  });

  buildHoles();
  renderChips();
  renderSegments();
  renderForm();

  // The starting calculation is shown at once, so the screen never opens
  // empty: 2 sourdough loaves of 800 g at 75%.
  calculated = { bread: state.bread, hydration: state.hydration, count: state.count, size: state.size };
  renderResult();
  updateSaveButton();
  loadSaved();
})();