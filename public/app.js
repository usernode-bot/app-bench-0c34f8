/* Ear Trainer's one screen, rendered from data in the markup the spec drew
 * (public/screens.css styles it). Loads progress, picks questions, plays the
 * sounds and keeps streaks and mastery on the server. */
'use strict';
(function () {
  // CATALOGUE and LEVEL_SIZES are the top-level bindings public/catalogue.js
  // sets when the browser loads it with a script tag.
  const KINDS = ['notes', 'chords', 'progressions'];
  const MASTER_STREAK = 3;
  const DEMO = new URLSearchParams(location.search).get('demo') === '1';
  const API_QS = DEMO ? '?demo=1' : '';
  const TOKEN = new URLSearchParams(location.search).get('token');
  const app = document.getElementById('app');

  const state = {
    loaded: false,
    loadError: false,
    guest: false,
    progress: {},   // kind -> { itemId -> { streak, mastered } }
    latest: {},     // kind -> last answer time
    kind: 'notes',
    level: 1,
    question: null, // { kind, itemId, options, picked, correct }
    qNumber: 0,
    saveError: false,
    soundError: false,
    playedOnce: false, // the current question's sound has played at least once
    playing: false,    // a sound is sounding right now
    playTimer: null,
    resetArmed: false,
    resetTimer: null,
  };

  // ── Catalogue helpers ──────────────────────────────────────────────────

  function kindData(kind) { return CATALOGUE[kind]; }
  function itemById(kind, id) {
    return CATALOGUE[kind].items.find(function (it) { return it.id === id; });
  }
  function levelSize(level) { return LEVEL_SIZES[level - 1]; }
  // A level's set is the first levelSize(level) items, so a new level starts
  // with everything the levels before it taught.
  function levelSet(kind, level) {
    return CATALOGUE[kind].items.slice(0, levelSize(level)).map(function (it) { return it.id; });
  }

  // ── Progress ───────────────────────────────────────────────────────────

  function rowsToState(rows) {
    const p = {};
    const latest = {};
    KINDS.forEach(function (k) { p[k] = {}; });
    (rows || []).forEach(function (r) {
      if (!CATALOGUE[r.kind] || !itemById(r.kind, r.item_id)) return;
      p[r.kind][r.item_id] = { streak: r.streak | 0, mastered: !!r.mastered };
      const t = r.updated_at ? Date.parse(r.updated_at) : 0;
      if (!latest[r.kind] || t > latest[r.kind]) latest[r.kind] = t;
    });
    state.progress = p;
    state.latest = latest;
  }

  function masteredCount(kind, level) {
    const p = state.progress[kind] || {};
    return levelSet(kind, level).filter(function (id) {
      return p[id] && p[id].mastered;
    }).length;
  }

  function firstOpenLevel(kind) {
    for (let l = 1; l <= 5; l++) {
      if (masteredCount(kind, l) < levelSize(l)) return l;
    }
    return 5;
  }

  // Open on the kind practised most recently, at its first level not done.
  function pickStart() {
    let best = null;
    KINDS.forEach(function (k) {
      if (state.latest[k] && (!best || state.latest[k] > state.latest[best])) best = k;
    });
    state.kind = best || 'notes';
    state.level = firstOpenLevel(state.kind);
  }

  // ── Questions ──────────────────────────────────────────────────────────

  function newQuestion() {
    const set = levelSet(state.kind, state.level);
    const p = state.progress[state.kind] || {};
    const pool = [];
    set.forEach(function (id) {
      // Unmastered items come up twice as often as mastered ones.
      const weight = p[id] && p[id].mastered ? 1 : 2;
      for (let i = 0; i < weight; i++) pool.push(id);
    });
    let id = pool[Math.floor(Math.random() * pool.length)];
    if (set.length > 1 && state.question && state.question.kind === state.kind) {
      let guard = 0;
      while (id === state.question.itemId && guard++ < 20) {
        id = pool[Math.floor(Math.random() * pool.length)];
      }
    }
    const item = itemById(state.kind, id);
    const opts = [id];
    // Wrong options: the closest-sounding items in this level, then fill from
    // the rest of the set, up to four.
    (item.near || []).forEach(function (n) {
      if (opts.length < 4 && set.indexOf(n) !== -1 && opts.indexOf(n) === -1) opts.push(n);
    });
    set.forEach(function (other) {
      if (opts.length < Math.min(4, set.length) && opts.indexOf(other) === -1) opts.push(other);
    });
    shuffle(opts);
    state.qNumber += 1;
    state.playedOnce = false; // the new sound has not been heard yet
    state.question = { kind: state.kind, itemId: id, options: opts, picked: null, correct: null };
  }

  function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }
  }

  function answer(id) {
    const q = state.question;
    if (!q || q.picked !== null) return;
    q.picked = id;
    q.correct = id === q.itemId;
    const p = state.progress[state.kind];
    const row = p[q.itemId] || (p[q.itemId] = { streak: 0, mastered: false });
    if (q.correct) {
      row.streak += 1;
      if (row.streak >= MASTER_STREAK) row.mastered = true;
    } else {
      row.streak = 0; // mastery is not undone
    }
    state.saveError = false;
    render();
    saveAnswer(state.kind, q.itemId, q.correct);
  }

  // ── Sound ──────────────────────────────────────────────────────────────

  let audioCtx = null;
  function ensureAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function midiFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // A piano-like tone: a triangle wave with two soft overtones and a decay.
  function playTone(ctx, t, midi, dur, gain) {
    const partials = [1, 0.35, 0.15];
    partials.forEach(function (amp, i) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = midiFreq(midi) * (i + 1);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.linearRampToValueAtTime(gain * amp, t + 0.02);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(env);
      env.connect(ctx.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
    });
  }

  // "i bVII bVI V" → chord semitone offsets from the key's root; a lowercase
  // numeral is a minor chord.
  function numeralChord(num) {
    const MAP = { i: 0, ii: 2, iii: 4, iv: 5, v: 7, vi: 9, vii: 11 };
    const flat = num.charAt(0) === 'b';
    const m = flat ? num.slice(1).toLowerCase() : num.toLowerCase();
    const root = MAP[m] - (flat ? 1 : 0);
    const minor = num === num.toLowerCase();
    return [root, root + (minor ? 3 : 4), root + 7];
  }

  function playCurrent() {
    const q = state.question;
    if (!q) return;
    const ctx = ensureAudio();
    if (!ctx) {
      state.soundError = true;
      render();
      return;
    }
    state.soundError = false;
    const recipe = itemById(state.kind, q.itemId).recipe;
    const t = ctx.currentTime + 0.05;
    // A different key each time, so the ear learns the shape, not the pitch.
    const root = 48 + Math.floor(Math.random() * 12);
    let seconds;
    if (recipe.type === 'notes') {
      seconds = 1.5;
      playTone(ctx, t, root, 0.7, 0.22);
      playTone(ctx, t + 0.75, root + recipe.semitones, 0.7, 0.22);
    } else if (recipe.type === 'chords') {
      seconds = 0.95;
      const g = 0.17 / Math.sqrt(recipe.intervals.length / 3);
      recipe.intervals.forEach(function (s) { playTone(ctx, t, root + s, 0.9, g); });
    } else {
      seconds = 0.05 + recipe.numerals.length * 0.9;
      recipe.numerals.forEach(function (num, i) {
        numeralChord(num).forEach(function (s) {
          playTone(ctx, t + i * 0.9, root + s, 0.9, 0.1);
        });
      });
    }
    // Update only the play button and the hint in place: the options and the
    // ladder must stay as they are while the same question sounds again.
    if (!state.playedOnce) {
      state.playedOnce = true;
      const hint = app.querySelector('#hint-line');
      if (hint) hint.textContent = hintText();
    }
    setPlaying(true);
    clearTimeout(state.playTimer);
    state.playTimer = setTimeout(function () { setPlaying(false); }, seconds * 1000);
  }

  // The play button's playing state: the bars stand in for the triangle and a
  // soft pulse rings in the accent colour, back to the triangle when it ends.
  function setPlaying(on) {
    state.playing = on;
    const btn = app.querySelector('#play-btn');
    if (!btn) return;
    btn.classList.toggle('playing', on);
    btn.setAttribute('aria-label', on ? 'Playing' : playAriaLabel());
    btn.innerHTML = on ? PLAYING_SVG : PLAY_SVG;
  }

  // ── API ────────────────────────────────────────────────────────────────

  // The shell signs the page in with ?token=; the bridge forwards it inside
  // the frame, and these calls carry it themselves everywhere else.
  function apiFetch(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, opts.headers,
      TOKEN ? { 'x-usernode-token': TOKEN } : {});
    return fetch(url, opts);
  }

  function loadProgress() {
    return apiFetch('/api/progress' + API_QS)
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then(function (data) {
        state.guest = !!data.guest;
        rowsToState(data.rows);
        state.loaded = true;
        state.loadError = false;
        pickStart();
        newQuestion();
        render();
      })
      .catch(function () {
        state.loaded = true;
        state.loadError = true;
        state.guest = false;
        rowsToState([]);
        state.kind = 'notes';
        state.level = 1;
        newQuestion();
        render();
      });
  }

  function saveAnswer(kind, itemId, correct) {
    if (state.guest) return;
    apiFetch('/api/answers' + API_QS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: kind, itemId: itemId, correct: correct }),
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (row) {
      if (row && row.item_id) {
        state.progress[row.kind][row.item_id] = { streak: row.streak, mastered: row.mastered };
        state.latest[row.kind] = Date.parse(row.updated_at) || Date.now();
        state.saveError = false;
        render();
      }
    }).catch(function () {
      state.saveError = true;
      render();
    });
  }

  // ── Markup ─────────────────────────────────────────────────────────────

  const PLAY_SVG = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M7 4l13 8-13 8z"/></svg>';
  // Three bars, animated by .play.playing's CSS while the sound plays.
  const PLAYING_SVG = '<svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true"><g class="eq"><rect x="4.5" y="8" width="3.5" height="8" rx="1.5" fill="currentColor"/><rect x="10.25" y="5" width="3.5" height="14" rx="1.5" fill="currentColor"/><rect x="16" y="9" width="3.5" height="6" rx="1.5" fill="currentColor"/></g></svg>';
  const NEXT_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function topLine() {
    if (state.guest) return 'Make an account to keep your progress';
    if (DEMO) return 'Staging demo: made-up progress for you';
    return 'Hear it, then tap what it was';
  }

  function levelName(kind, level) {
    const words = ['Two', 'Four', 'Six', 'Nine'];
    const name = level === 5 ? 'Full set' : words[level - 1] + ' ' + kindData(kind).noun;
    return 'Level ' + level + ': ' + name;
  }

  // "Tap play to hear it. Which gap is it?" before the first play of this
  // question, "…hear it again." once it has played.
  function hintText() {
    return 'Tap play to hear it' + (state.playedOnce ? ' again' : '') + '. ' + kindData(state.kind).ask;
  }

  function playAriaLabel() {
    return state.playedOnce ? 'Play it again' : 'Play';
  }

  function skeleton(width, height, radius) {
    return '<div class="skeleton" style="width:' + width + ';height:' + height + ';' +
      (radius ? 'border-radius:' + radius + ';' : '') + '"></div>';
  }

  function renderLoading() {
    const rows = [1, 2, 3, 4, 5].map(function () {
      return '<li class="list-row"><div class="g">' + skeleton('150px', '16px') +
        '<div style="margin-top:8px">' + skeleton('120px', '6px', '3px') + '</div></div>' +
        skeleton('70px', '24px', '99px') + '</li>';
    }).join('');
    app.innerHTML =
      '<div class="top"><h1 class="title">Ear Trainer</h1><div class="small">&nbsp;</div></div>' +
      '<div class="tabs"><div class="tab on">Notes</div><div class="tab">Chords</div><div class="tab">Progressions</div></div>' +
      '<div class="card">' +
        '<div class="lesson"><div style="flex:1">' + skeleton('150px', '22px') + '<div style="margin-top:6px">' + skeleton('180px', '14px') + '</div></div>' + skeleton('88px', '44px', '8px') + '</div>' +
        '<div class="stage">' + '<div class="skeleton" style="width:96px;height:96px;flex:none;border-radius:50%"></div>' +
          '<div style="flex:1">' + skeleton('110px', '22px') + '<div style="margin-top:6px">' + skeleton('230px', '14px') + '</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="section-label">Pick what you heard</div>' +
      '<div class="opts">' + [1, 2, 3, 4].map(function () { return skeleton('100%', '64px', '10px'); }).join('') + '</div>' +
      '<div class="section-label">Chord ladder</div>' +
      '<div class="card" style="display:flex;gap:16px;align-items:center">' + skeleton('120px', '96px', '5px') + skeleton('100%', '14px') + '</div>' +
      '<div class="section-label">Lessons</div>' +
      '<ul class="list" data-lesson-list>' + rows + '</ul>';
  }

  function tabsHtml() {
    return KINDS.map(function (k) {
      return '<button class="tab' + (state.kind === k ? ' on' : '') + '" data-kind="' + k + '">' +
        kindData(k).label + '</button>';
    }).join('');
  }

  function optionsHtml() {
    const q = state.question;
    return q.options.map(function (id) {
      const it = itemById(state.kind, id);
      let cls = 'opt';
      if (q.picked !== null && id === q.itemId) cls += ' ok';
      const yourPick = (q.picked === id && !q.correct) ? '<span>Your pick</span>' : '';
      return '<button class="' + cls + '" data-opt="' + id + '"' + (q.picked !== null ? ' disabled' : '') + '>' +
        esc(it.label) + '<span>' + esc(it.sub || it.song || '') + '</span>' + yourPick + '</button>';
    }).join('');
  }

  function feedbackHtml() {
    const q = state.question;
    if (q.picked === null) {
      if (state.soundError) {
        return '<div class="fb no" style="margin-bottom:12px"><div>Your browser cannot play sound, so the lesson runs silent. Everything else works.</div></div>';
      }
      return '';
    }
    const it = itemById(state.kind, q.itemId);
    const row = state.progress[state.kind][q.itemId] || { streak: 0, mastered: false };
    const songBit = it.song ? ', the shape of ' + it.song : '';
    let text;
    if (q.correct) {
      text = 'Right. ' + it.label + songBit + '. ' + row.streak + ' in a row.';
      if (row.mastered && row.streak === MASTER_STREAK) text += ' Mastered.';
    } else {
      text = 'It was ' + it.label + (it.song ? ', ' + it.song : '') + '. ' + row.streak + ' in a row.';
    }
    let html = '<div class="fb' + (q.correct ? '' : ' no') + '"><div>' + esc(text) + '</div>' +
      '<button class="btn-secondary" id="next-btn">Next' + NEXT_SVG + '</button></div>';
    if (state.saveError) {
      html += '<div class="small" style="margin:8px 4px;display:flex;align-items:center;gap:8px">' +
        'Could not save that answer.' +
        '<button class="btn-secondary" id="retry-save">Retry</button></div>';
    }
    return html;
  }

  function ladderHtml() {
    const set = levelSet(state.kind, state.level);
    const p = state.progress[state.kind] || {};
    const asked = state.question ? state.question.itemId : null;
    const mastered = set.filter(function (id) { return p[id] && p[id].mastered; }).length;
    // .rung's column-reverse shows the first rung in the DOM at the bottom,
    // so the order here is bottom to top: the mastered rungs fill from the
    // bottom, then one amber rung for the item being asked, then the
    // unmastered ones at the top — the same order on every render.
    const rungs = [];
    set.forEach(function (id) {
      if (id !== asked && p[id] && p[id].mastered) rungs.push('<div class="rung f"></div>');
    });
    if (asked) rungs.push('<div class="rung n"></div>');
    set.forEach(function (id) {
      if (id !== asked && !(p[id] && p[id].mastered)) rungs.push('<div class="rung"></div>');
    });
    return '<div class="section-label" id="ladder-label">Chord ladder, ' + mastered + ' of ' + set.length + ' mastered</div>' +
      '<div class="card" style="display:flex;gap:16px;align-items:center">' +
        '<div class="ladder" style="height:' + (set.length * 16) + 'px">' + rungs.join('') + '</div>' +
        '<div style="flex:1" class="small">A rung fills when you get that ' + kindData(state.kind).nounSingular +
        ' right three times in a row. Amber is the one you are on now.</div>' +
      '</div>';
  }

  function lessonRowsHtml() {
    return [1, 2, 3, 4, 5].map(function (l) {
      const size = levelSize(l);
      const m = masteredCount(state.kind, l);
      const cur = l === state.level ? ' cur' : '';
      const name = levelName(state.kind, l);
      let body;
      if (m > 0) {
        body = '<div class="bar"><i style="width:' + Math.round((m / size) * 100) + '%"></i></div>';
      } else {
        const small = l === 5 ? 'All 12 ' + kindData(state.kind).noun
          : l === 1 ? 'Starts with two very different ones' : 'Adds closer sounding ones';
        body = '<div class="small">' + small + '</div>';
      }
      const pill = m >= size ? 'Done' : (m > 0 ? m + ' of ' + size : 'Not started');
      return '<li class="list-row click' + cur + '" data-level="' + l + '" role="button" tabindex="0">' +
        '<div class="g"><div style="font-weight:600">' + name + '</div>' + body + '</div>' +
        '<span class="pill">' + pill + '</span></li>';
    }).join('');
  }

  function render() {
    if (!state.loaded) return renderLoading();
    const k = kindData(state.kind);
    const topAttrs = (DEMO && !state.guest) ? ' data-usernode-demo-note' : '';
    app.innerHTML =
      '<div class="top"><h1 class="title">Ear Trainer</h1><div class="small"' + topAttrs + '>' + esc(topLine()) + '</div></div>' +
      (state.loadError ? loadErrorBanner() : '') +
      '<div class="tabs">' + tabsHtml() + '</div>' +
      '<div class="card">' +
        '<div class="lesson"><div><div class="heading">' + levelName(state.kind, state.level) + '</div>' +
          '<div class="small">' + k.tagline + '</div></div>' +
          '<button class="btn-secondary" id="change-btn">Change</button></div>' +
        '<div class="stage">' +
          '<button class="play" id="play-btn" aria-label="' + playAriaLabel() + '">' + PLAY_SVG + '</button>' +
          '<div style="flex:1"><div class="heading">Question ' + state.qNumber + '</div>' +
          '<div class="small" id="hint-line">' + esc(hintText()) + '</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="section-label">Pick what you heard</div>' +
      '<div class="opts">' + optionsHtml() + '</div>' +
      feedbackHtml() +
      ladderHtml() +
      '<div class="section-label">Lessons in ' + state.kind + '</div>' +
      '<ul class="list" data-lesson-list id="lesson-list">' + lessonRowsHtml() + '</ul>' +
      '<div style="margin-top:12px"><button class="btn-secondary" id="reset-btn">' +
        (state.resetArmed ? 'Tap again to confirm' : 'Reset progress in ' + k.label) + '</button></div>';
    wire();
  }

  function loadErrorBanner() {
    return '<div class="fb no" style="margin-bottom:12px"><div>Could not load your progress. The lessons still play, but answers are not saved until it loads.</div>' +
      '<button class="btn-secondary" id="retry-load">Retry</button></div>';
  }

  // ── Events ─────────────────────────────────────────────────────────────

  function wire() {
    app.querySelectorAll('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const k = btn.dataset.kind;
        if (k === state.kind) return;
        state.kind = k;
        state.level = firstOpenLevel(k);
        state.resetArmed = false;
        newQuestion();
        render();
      });
    });
    const play = app.querySelector('#play-btn');
    if (play) play.addEventListener('click', playCurrent);
    app.querySelectorAll('[data-opt]').forEach(function (btn) {
      btn.addEventListener('click', function () { answer(btn.dataset.opt); });
    });
    const next = app.querySelector('#next-btn');
    if (next) next.addEventListener('click', function () { newQuestion(); render(); });
    const change = app.querySelector('#change-btn');
    if (change) change.addEventListener('click', function () {
      const list = app.querySelector('#lesson-list');
      if (list) list.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    });
    app.querySelectorAll('[data-level]').forEach(function (row) {
      const pick = function () {
        const l = Number(row.dataset.level);
        if (l === state.level) return;
        state.level = l;
        state.resetArmed = false;
        newQuestion();
        render();
      };
      row.addEventListener('click', pick);
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });
    const reset = app.querySelector('#reset-btn');
    if (reset) reset.addEventListener('click', resetProgress);
    const retryLoad = app.querySelector('#retry-load');
    if (retryLoad) retryLoad.addEventListener('click', loadProgress);
    const retrySave = app.querySelector('#retry-save');
    if (retrySave) retrySave.addEventListener('click', function () {
      const q = state.question;
      state.saveError = false;
      render();
      saveAnswer(state.kind, q.itemId, q.correct);
    });
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // Two taps: the first arms it, the second clears this kind only.
  function resetProgress() {
    if (!state.resetArmed) {
      state.resetArmed = true;
      render();
      clearTimeout(state.resetTimer);
      state.resetTimer = setTimeout(function () {
        state.resetArmed = false;
        render();
      }, 4000);
      return;
    }
    clearTimeout(state.resetTimer);
    state.resetArmed = false;
    if (state.guest) { render(); return; }
    apiFetch('/api/progress/reset' + API_QS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: state.kind }),
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.progress[state.kind] = {};
      delete state.latest[state.kind];
      state.level = 1;
      newQuestion();
      render();
    }).catch(function () {
      // Leave everything as it is; the button reverts and they can try again.
      render();
    });
  }

  // ── Start ──────────────────────────────────────────────────────────────

  renderLoading();
  loadProgress();
})();