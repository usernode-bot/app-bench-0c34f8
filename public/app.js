/* Ear Trainer's one screen: play a note, chord or progression, tap what you
 * heard, and keep a streak per item. The catalogue (public/catalogue.js)
 * decides what the lessons contain; progress comes from /api/progress.
 */
(function () {
  'use strict';

  var C = window.EAR_CATALOGUE;
  var LEVEL_COUNT = C.levelSizes.length;
  var LADDER_NOUN = { notes: 'gap', chords: 'chord', progressions: 'progression' };

  var params = new URLSearchParams(location.search);
  var DEMO_PARAM = params.get('demo') === '1';
  var TOKEN = params.get('token') || '';
  if (!TOKEN && window.usernode && window.usernode.token) TOKEN = window.usernode.token;

  var els = {
    tabs: document.querySelectorAll('[data-kind]'),
    lessonTitle: document.getElementById('lesson-title'),
    lessonSub: document.getElementById('lesson-sub'),
    changeLevel: document.getElementById('change-level'),
    play: document.getElementById('play'),
    questionTitle: document.getElementById('question-title'),
    questionHint: document.getElementById('question-hint'),
    options: document.getElementById('options'),
    feedback: document.getElementById('feedback'),
    feedbackText: document.getElementById('feedback-text'),
    next: document.getElementById('next'),
    saveError: document.getElementById('save-error'),
    retrySave: document.getElementById('retry-save'),
    ladderLabel: document.getElementById('ladder-label'),
    ladderCard: document.getElementById('ladder-card'),
    ladder: document.getElementById('ladder'),
    ladderNote: document.getElementById('ladder-note'),
    lessonsLabel: document.getElementById('lessons-label'),
    lessonList: document.getElementById('lesson-list'),
    resetArea: document.getElementById('reset-area'),
    resetBtn: document.getElementById('reset-btn'),
    resetConfirm: document.getElementById('reset-confirm'),
    resetQuestion: document.getElementById('reset-question'),
    resetDo: document.getElementById('reset-do'),
    resetCancel: document.getElementById('reset-cancel'),
    guestNote: document.getElementById('guest-note'),
    demoNote: document.getElementById('demo-note'),
    audioNote: document.getElementById('audio-note')
  };

  var state = {
    kind: 'notes',
    level: 1,
    questionNo: 1,
    question: null,
    rows: {},          // "kind|itemId" -> { streak, mastered, updatedAt }
    loading: true,
    loaded: false,
    error: false,
    guest: false,
    demo: false,
    saveError: false,
    lastAnswer: null,
    confirmingReset: false,
    lastItemId: null
  };

  // ── Helpers ──────────────────────────────────────────────────────────────

  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function api(method, path, body) {
    var url = path;
    if (DEMO_PARAM) url += (url.indexOf('?') === -1 ? '?' : '&') + 'demo=1';
    // The iframe token goes on every call. The header is what Homeroom's edge
    // forwards; the query copy is what the server already accepts and keeps
    // calls working where a proxy drops custom headers.
    if (TOKEN) url += (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(TOKEN);
    var opts = { method: method, headers: {} };
    if (TOKEN) opts.headers['x-usernode-token'] = TOKEN;
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts);
  }

  function rowKey(kind, itemId) { return kind + '|' + itemId; }

  function rowFor(kind, itemId) {
    return state.rows[rowKey(kind, itemId)] || { streak: 0, mastered: false, updatedAt: null };
  }

  function masteredCount(kind, items) {
    return items.filter(function (item) { return rowFor(kind, item.id).mastered; }).length;
  }

  function firstLevelNotDone(kind) {
    for (var level = 1; level <= LEVEL_COUNT; level++) {
      var items = C.itemsForLevel(kind, level);
      if (masteredCount(kind, items) < items.length) return level;
    }
    return LEVEL_COUNT;
  }

  function mostRecentKind() {
    var best = null;
    var bestTime = -Infinity;
    Object.keys(state.rows).forEach(function (key) {
      var kind = key.split('|')[0];
      var time = Date.parse(state.rows[key].updatedAt) || 0;
      if (time > bestTime) { bestTime = time; best = kind; }
    });
    return best || 'notes';
  }

  function skel(width, height) {
    return '<span class="skeleton" style="display:inline-block;height:' + height + 'px;width:' + width + ';vertical-align:middle"></span>';
  }

  // ── Questions ────────────────────────────────────────────────────────────

  function pickQuestion() {
    var items = C.itemsForLevel(state.kind, state.level);
    if (!items.length) return null;
    var pool = [];
    items.forEach(function (item) {
      // Unmastered items are twice as likely as mastered ones.
      var weight = rowFor(state.kind, item.id).mastered ? 1 : 2;
      for (var i = 0; i < weight; i++) pool.push(item.id);
    });
    var id = pool[Math.floor(Math.random() * pool.length)];
    if (items.length > 1 && id === state.lastItemId) {
      var others = items.filter(function (item) { return item.id !== id; });
      id = others[Math.floor(Math.random() * others.length)].id;
    }
    state.lastItemId = id;
    // Fixed once per question, so answering does not move the options.
    return { itemId: id, options: optionIds(id), played: false, answered: false, picked: null, correct: null };
  }

  // The answer plus its closest-sounding items within the level, up to four:
  // always min(4, level size), padded with other items in the set when there
  // are fewer than three close ones.
  function optionIds(answerId) {
    var items = C.itemsForLevel(state.kind, state.level);
    var byId = {};
    items.forEach(function (item) { byId[item.id] = item; });
    var answer = byId[answerId];
    var target = Math.min(4, items.length);
    if (!answer) return items.slice(0, target).map(function (item) { return item.id; });
    var ids = [answer.id];
    (answer.close || []).forEach(function (id) {
      if (ids.length < target && byId[id] && ids.indexOf(id) === -1) ids.push(id);
    });
    items.forEach(function (item) {
      if (ids.length < target && ids.indexOf(item.id) === -1) ids.push(item.id);
    });
    for (var i = ids.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var swap = ids[i];
      ids[i] = ids[j];
      ids[j] = swap;
    }
    return ids;
  }

  // ── Sound ────────────────────────────────────────────────────────────────

  var audio = { ctx: null, sources: [] };

  function ensureAudio() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { els.audioNote.hidden = false; return null; }
    if (!audio.ctx) {
      try { audio.ctx = new AC(); } catch (err) { els.audioNote.hidden = false; return null; }
    }
    if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(function () {});
    return audio.ctx;
  }

  function stopSounds() {
    audio.sources.forEach(function (source) {
      try { source.stop(); } catch (err) { /* already stopped */ }
    });
    audio.sources = [];
  }

  function tone(ctx, midi, at, duration) {
    var freq = 440 * Math.pow(2, (midi - 69) / 12);
    var level = ctx.createGain();
    level.gain.setValueAtTime(0.0001, at);
    level.gain.exponentialRampToValueAtTime(0.13, at + 0.015);
    level.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    level.connect(ctx.destination);
    [[1, 'triangle', 1], [2, 'sine', 0.35], [3, 'sine', 0.12]].forEach(function (partial) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = partial[1];
      osc.frequency.setValueAtTime(freq * partial[0], at);
      gain.gain.value = partial[2];
      osc.connect(gain);
      gain.connect(level);
      osc.start(at);
      osc.stop(at + duration + 0.02);
      audio.sources.push(osc);
    });
  }

  // "bVII" -> the major-scale degree lowered a semitone; "ii" -> minor.
  function parseRoman(numeral) {
    var rest = numeral;
    var offset = 0;
    while (rest.charAt(0) === 'b') { offset -= 1; rest = rest.slice(1); }
    while (rest.charAt(0) === '#') { offset += 1; rest = rest.slice(1); }
    var degrees = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
    var index = degrees.indexOf(rest.toUpperCase());
    return {
      semis: [0, 2, 4, 5, 7, 9, 11][index] + offset,
      quality: rest === rest.toUpperCase() ? 'major' : 'minor'
    };
  }

  function playQuestion(kind, itemId) {
    var ctx = ensureAudio();
    if (!ctx) return;
    stopSounds();
    var item = C.getItem(kind, itemId);
    if (!item) return;
    var start = ctx.currentTime + 0.05;
    var root;

    if (kind === 'notes') {
      root = 57 + Math.floor(Math.random() * 12);
      tone(ctx, root, start, 0.7);
      tone(ctx, root + item.semitones, start + 0.75, 0.7);
      return 1520;
    }

    root = 48 + Math.floor(Math.random() * 12);

    if (kind === 'chords') {
      item.intervals.forEach(function (semis) { tone(ctx, root + semis, start, 0.9); });
      return 970;
    }

    var at = start;
    var numerals = item.roman.split(' ');
    numerals.forEach(function (numeral) {
      var chord = parseRoman(numeral);
      var intervals = chord.quality === 'major' ? [0, 4, 7] : [0, 3, 7];
      intervals.forEach(function (semis) { tone(ctx, root + chord.semis + semis, at, 0.85); });
      at += 0.95;
    });
    return Math.round((0.05 + 0.95 * (numerals.length - 1) + 0.87) * 1000);
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function questionHint() {
    var heard = state.question && state.question.played
      ? 'Tap play to hear it again.'
      : 'Tap play to hear it.';
    return heard + ' ' + C.lessons[state.kind].question;
  }

  function setChangeButton(label, className, disabled) {
    els.changeLevel.textContent = label;
    els.changeLevel.className = className;
    els.changeLevel.disabled = disabled;
  }

  function renderTabs() {
    els.tabs.forEach(function (tab) {
      var on = tab.getAttribute('data-kind') === state.kind;
      tab.classList.toggle('on', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.disabled = state.loading;
    });
  }

  function renderNotes() {
    els.guestNote.hidden = !state.guest;
    els.demoNote.hidden = !state.demo;
  }

  function renderCard() {
    var lesson = C.lessons[state.kind];

    if (state.loading) {
      els.lessonTitle.innerHTML = skel('55%', 20);
      els.lessonSub.innerHTML = skel('40%', 14);
      setChangeButton('Change', 'btn-secondary', true);
      els.play.disabled = true;
      els.play.classList.remove('is-quiet');
      els.play.setAttribute('aria-label', 'Play');
      els.questionTitle.innerHTML = skel('30%', 20);
      els.questionHint.innerHTML = skel('70%', 14);
      return;
    }

    els.play.disabled = false;

    if (state.error) {
      els.lessonTitle.textContent = 'Could not load your progress';
      els.lessonSub.textContent = 'The lessons still play, but answers will not be saved until it loads.';
      setChangeButton('Retry', 'btn-primary', false);
      els.play.classList.add('is-quiet');
    } else {
      els.lessonTitle.textContent = 'Level ' + state.level + ': ' + C.levelName(state.kind, state.level);
      els.lessonSub.textContent = lesson.subtitle;
      setChangeButton('Change', 'btn-secondary', false);
      els.play.classList.remove('is-quiet');
    }

    els.play.setAttribute('aria-label', playLabel());
    els.questionTitle.textContent = 'Question ' + state.questionNo;
    els.questionHint.textContent = questionHint();
  }

  function optionSkeleton() {
    return '<div class="opt" aria-hidden="true" style="gap:6px">' + skel('50%', 16) + skel('70%', 14) + '</div>';
  }

  function renderOptions() {
    if (state.loading) {
      els.options.innerHTML = optionSkeleton() + optionSkeleton();
      return;
    }
    var q = state.question;
    if (!q) { els.options.innerHTML = ''; return; }
    var itemsById = {};
    C.itemsForLevel(state.kind, state.level).forEach(function (item) { itemsById[item.id] = item; });
    els.options.innerHTML = q.options.map(function (id) { return itemsById[id]; }).filter(Boolean).map(function (item) {
      var cls = 'opt';
      if (q.answered && item.id === q.itemId) cls += ' ok';
      if (q.answered && !q.correct && item.id === q.picked) cls += ' bad';
      var label = state.kind === 'progressions' ? esc(item.roman) : esc(item.label);
      var sub = state.kind === 'progressions' ? '<span>' + esc(item.song) + '</span>' : '';
      var you = q.answered && !q.correct && item.id === q.picked
        ? '<span class="you">Your pick</span>' : '';
      return '<button type="button" class="' + cls + '" data-option="' + item.id + '"' +
        (q.answered ? ' disabled' : '') + '>' + label + sub + you + '</button>';
    }).join('');
  }

  function renderFeedback() {
    var q = state.question;
    var show = !state.loading && q && q.answered;
    els.feedback.hidden = !show;
    els.saveError.hidden = !show || !state.saveError;
    if (!show) return;

    var item = C.getItem(state.kind, q.itemId);
    var what = state.kind === 'progressions'
      ? item.roman + ', ' + item.described
      : item.label;
    var streak = rowFor(state.kind, item.id).streak;
    els.feedbackText.textContent = q.correct
      ? 'Right. ' + what + '. ' + streak + ' in a row.'
      : 'Not quite. It was ' + what + '. Your streak on it starts again.';
  }

  function renderLadder() {
    var show = state.loaded && !state.error;
    els.ladderLabel.hidden = !show;
    els.ladderCard.hidden = !show;
    if (!show) return;

    var items = C.itemsForLevel(state.kind, state.level);
    var kind = state.kind;
    var currentId = state.question ? state.question.itemId : null;

    els.ladderLabel.textContent =
      'Chord ladder, ' + masteredCount(kind, items) + ' of ' + items.length + ' mastered';

    // One rung per item, filling from the bottom: mastered first, then the
    // item being asked, then grey ones.
    // The item being asked is always the amber rung, mastered or not.
    var current = items.filter(function (item) { return item.id === currentId; });
    var mastered = items.filter(function (item) {
      return rowFor(kind, item.id).mastered && item.id !== currentId;
    });
    var rest = items.filter(function (item) {
      return !rowFor(kind, item.id).mastered && item.id !== currentId;
    });
    els.ladder.innerHTML = mastered.map(function () { return '<div class="rung f"></div>'; })
      .concat(current.map(function () { return '<div class="rung n"></div>'; }))
      .concat(rest.map(function () { return '<div class="rung"></div>'; }))
      .join('');

    els.ladderNote.textContent = 'A rung fills when you get that ' + LADDER_NOUN[kind] +
      ' right three times in a row. Amber is the one you are on now.';
  }

  function lessonRowSkeleton() {
    return '<li class="list-row"><div class="g">' + skel('60%', 16) +
      '<div style="margin-top:8px">' + skel('100%', 6) + '</div></div>' +
      '<span class="pill">' + skel('48px', 14) + '</span></li>';
  }

  function renderLessons() {
    if (state.loading) {
      els.lessonsLabel.hidden = false;
      els.lessonList.hidden = false;
      els.lessonsLabel.innerHTML = skel('40%', 14);
      els.lessonList.innerHTML = lessonRowSkeleton().repeat(5);
      return;
    }

    var show = state.loaded && !state.error;
    els.lessonsLabel.hidden = !show;
    els.lessonList.hidden = !show;
    if (!show) { els.lessonList.innerHTML = ''; return; }

    var kind = state.kind;
    els.lessonsLabel.textContent = 'Lessons in ' + C.lessons[kind].title.toLowerCase();
    var html = '';
    for (var level = 1; level <= LEVEL_COUNT; level++) {
      var items = C.itemsForLevel(kind, level);
      var mastered = masteredCount(kind, items);
      var done = mastered === items.length;
      var current = level === state.level;
      var pill = done ? 'Done' : (mastered > 0 ? mastered + ' of ' + items.length : 'Not started');
      var body = done || mastered > 0
        ? '<div class="bar"><i style="width:' + Math.round((mastered / items.length) * 100) + '%"></i></div>'
        : '<div class="small">' + esc(C.levelSubtitle(kind, level)) + '</div>';
      html += '<li class="list-row' + (current ? ' cur' : '') + '">' +
        '<button type="button" class="row-btn" data-level="' + level + '"' +
        (current ? ' aria-current="true"' : '') + '>' +
        '<div class="g"><div style="font-weight:600">Level ' + level + ': ' +
        esc(C.levelName(kind, level)) + '</div>' + body + '</div>' +
        '<span class="pill">' + pill + '</span></button></li>';
    }
    els.lessonList.innerHTML = html;
  }

  function renderReset() {
    var show = state.loaded && !state.error && !state.guest;
    els.resetArea.hidden = !show;
    if (!show) { els.resetConfirm.hidden = true; return; }
    var title = C.lessons[state.kind].title;
    els.resetBtn.textContent = 'Reset progress in ' + title;
    els.resetConfirm.hidden = !state.confirmingReset;
    els.resetQuestion.textContent = 'Reset your ' + title +
      ' progress? Every mastered item in this lesson type is cleared.';
  }

  function render() {
    renderTabs();
    renderNotes();
    renderCard();
    renderOptions();
    renderFeedback();
    renderLadder();
    renderLessons();
    renderReset();
  }

  // ── Loading progress ─────────────────────────────────────────────────────

  function load() {
    state.loading = true;
    state.error = false;
    state.confirmingReset = false;
    state.saveError = false;
    render();

    api('GET', '/api/progress').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      state.guest = !!data.guest;
      state.demo = !!data.demo;
      state.rows = {};
      (data.rows || []).forEach(function (row) {
        state.rows[rowKey(row.kind, row.item_id)] = {
          streak: row.streak,
          mastered: !!row.mastered,
          updatedAt: row.updated_at
        };
      });
      state.loaded = true;
      state.loading = false;
      state.error = false;
      state.kind = mostRecentKind();
      state.level = firstLevelNotDone(state.kind);
      state.questionNo = 1;
      state.lastItemId = null;
      state.question = pickQuestion();
      render();
    }).catch(function (err) {
      console.warn('Could not load progress: ' + err.message);
      state.loading = false;
      state.loaded = false;
      state.error = true;
      state.rows = {};
      state.kind = 'notes';
      state.level = 1;
      state.questionNo = 1;
      state.lastItemId = null;
      state.question = pickQuestion();
      render();
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  function selectKind(kind) {
    if (state.loading || kind === state.kind) return;
    state.kind = kind;
    state.level = state.loaded ? firstLevelNotDone(kind) : 1;
    state.questionNo = 1;
    state.saveError = false;
    state.confirmingReset = false;
    state.lastItemId = null;
    state.question = pickQuestion();
    render();
  }

  function selectLevel(level) {
    if (state.loading || !state.loaded) return;
    state.level = level;
    state.questionNo = 1;
    state.saveError = false;
    state.confirmingReset = false;
    state.lastItemId = null;
    state.question = pickQuestion();
    render();
  }

  function applyResult(kind, itemId, correct) {
    var key = rowKey(kind, itemId);
    var row = state.rows[key] || { streak: 0, mastered: false, updatedAt: null };
    row = { streak: row.streak, mastered: row.mastered, updatedAt: row.updatedAt };
    if (correct) {
      row.streak += 1;
      if (row.streak >= 3) row.mastered = true;
    } else {
      row.streak = 0;
    }
    row.updatedAt = new Date().toISOString();
    state.rows[key] = row;
  }

  function saveAnswer(kind, itemId, correct) {
    api('POST', '/api/answers', { kind: kind, itemId: itemId, correct: correct })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        state.saveError = false;
        renderFeedback();
      })
      .catch(function (err) {
        console.warn('Could not save answer: ' + err.message);
        // Only the question still on screen may show the failure line.
        var q = state.question;
        if (q && q.itemId === itemId) {
          state.saveError = true;
          renderFeedback();
        }
      });
  }

  function choose(optionId) {
    var q = state.question;
    if (state.loading || !q || q.answered) return;
    var correct = optionId === q.itemId;
    q.answered = true;
    q.picked = optionId;
    q.correct = correct;
    applyResult(state.kind, q.itemId, correct);
    state.saveError = false;
    state.lastAnswer = { kind: state.kind, itemId: q.itemId, correct: correct };
    if (state.loaded && !state.guest) saveAnswer(state.kind, q.itemId, correct);
    render();
  }

  function nextQuestion() {
    var q = state.question;
    if (!q || !q.answered) return;
    state.questionNo += 1;
    state.saveError = false;
    state.question = pickQuestion();
    render();
  }

  var playTimer = null;

  function playLabel() {
    if (state.loading) return 'Play';
    return 'Play the ' + C.lessons[state.kind].soundNoun + ' again';
  }

  // While the sound plays the triangle becomes a sound wave and the label
  // reads "Playing"; both go back to the play state when playback ends.
  function setPlaying(on) {
    els.play.classList.toggle('is-playing', on);
    els.play.setAttribute('aria-label', on ? 'Playing' : playLabel());
  }

  function play() {
    var q = state.question;
    if (state.loading || !q) return;
    if (playTimer) { clearTimeout(playTimer); playTimer = null; }
    var ms = playQuestion(state.kind, q.itemId);
    q.played = true;
    els.questionHint.textContent = questionHint();
    if (!ms) { setPlaying(false); return; }
    setPlaying(true);
    playTimer = setTimeout(function () {
      playTimer = null;
      setPlaying(false);
    }, ms);
  }

  function confirmReset() {
    var kind = state.kind;
    els.resetDo.disabled = true;
    api('POST', '/api/progress/reset', { kind: kind }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      Object.keys(state.rows).forEach(function (key) {
        if (key.indexOf(kind + '|') === 0) delete state.rows[key];
      });
      state.confirmingReset = false;
      state.level = 1;
      state.questionNo = 1;
      state.lastItemId = null;
      state.question = pickQuestion();
      els.resetDo.disabled = false;
      render();
    }).catch(function (err) {
      console.warn('Could not reset progress: ' + err.message);
      els.resetDo.disabled = false;
      els.resetQuestion.textContent = 'Could not reset your progress. Try again.';
    });
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  els.tabs.forEach(function (tab) {
    tab.addEventListener('click', function () { selectKind(tab.getAttribute('data-kind')); });
  });

  els.changeLevel.addEventListener('click', function () {
    if (state.error) { load(); return; }
    if (els.lessonList.hidden) return;
    els.lessonList.scrollIntoView({ block: 'center' });
    var current = els.lessonList.querySelector('[aria-current="true"]');
    if (current) current.focus();
  });

  els.play.addEventListener('click', play);

  els.options.addEventListener('click', function (event) {
    var button = event.target.closest('[data-option]');
    if (button) choose(button.getAttribute('data-option'));
  });

  els.next.addEventListener('click', nextQuestion);

  els.retrySave.addEventListener('click', function () {
    if (!state.lastAnswer) return;
    state.saveError = false;
    renderFeedback();
    saveAnswer(state.lastAnswer.kind, state.lastAnswer.itemId, state.lastAnswer.correct);
  });

  els.lessonList.addEventListener('click', function (event) {
    var button = event.target.closest('[data-level]');
    if (button) selectLevel(parseInt(button.getAttribute('data-level'), 10));
  });

  els.resetBtn.addEventListener('click', function () {
    state.confirmingReset = true;
    renderReset();
  });

  els.resetCancel.addEventListener('click', function () {
    state.confirmingReset = false;
    renderReset();
  });

  els.resetDo.addEventListener('click', confirmReset);

  render();
  load();
})();
