/* Ear Trainer: one practice screen. Pick a lesson, play a sound, tap what
   you heard. State lives here; the lesson catalogue lives in lessons.js. */
(function () {
  'use strict';

  var CATALOGUE = window.EAR_LESSONS;
  var BY_ID = {};
  CATALOGUE.forEach(function (l) { BY_ID[l.id] = l; });
  var QUESTIONS = 10;

  var params = new URLSearchParams(location.search);
  var DEMO = params.get('demo') === '1';
  var TOKEN = params.get('token') || '';

  function $(id) { return document.getElementById(id); }

  var els = {
    title: $('lesson-title'),
    sub: $('lesson-sub'),
    bar: $('progress-bar'),
    metaQ: $('meta-question'),
    metaC: $('meta-correct'),
    playRow: $('play-row'),
    play: $('play-btn'),
    q: $('question-text'),
    hint: $('question-hint'),
    kb: $('keyboard'),
    answersSection: $('answers-section'),
    answers: $('answers'),
    fb: $('feedback'),
    fbText: $('feedback-text'),
    streak: $('streak'),
    next: $('next-btn'),
    result: $('result'),
    resultScore: $('result-score'),
    resultBest: $('result-best'),
    retry: $('retry-btn'),
    nextLesson: $('next-lesson-btn'),
    saveFail: $('save-fail'),
    saveRetry: $('save-retry-btn'),
    progressDemo: $('progress-demo-note'),
    progressLoading: $('progress-loading'),
    progressList: $('progress-list'),
    progressEmpty: $('progress-empty'),
    progressError: $('progress-error'),
    progressRetry: $('progress-retry-btn'),
    sheet: $('lessons-sheet'),
    sheetBody: $('sheet-body'),
    sheetBtn: $('lessons-btn'),
    sheetClose: $('sheet-close-btn'),
    sheetBackdrop: $('sheet-backdrop')
  };

  // Session state
  var lesson = null;
  var qIndex = 0;
  var correct = 0;
  var streak = 0;
  var current = null;
  var previous = null;
  var answered = false;
  var finished = false;
  var touched = false; // the person answered or chose a lesson themselves
  var progressRows = [];

  function authHeaders(extra) {
    var h = extra || {};
    if (TOKEN) h['x-usernode-token'] = TOKEN;
    return h;
  }

  // ── Sound ───────────────────────────────────────────────────────────────
  var audioCtx = null;
  function getCtx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }
  function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  // A soft synthesised piano tone: a triangle fundamental with a quiet
  // sine an octave up, quick attack and a long decay. No recordings.
  function tone(ctx, midi, t, dur) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(ctx.destination);
    [[1, 'triangle', 1], [2, 'sine', 0.3]].forEach(function (part) {
      var o = ctx.createOscillator();
      o.type = part[1];
      o.frequency.value = midiToFreq(midi) * part[0];
      var og = ctx.createGain();
      og.gain.value = part[2];
      o.connect(og);
      og.connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
    });
  }

  function play() {
    if (!current) return;
    var ctx = getCtx();
    var t0 = ctx.currentTime + 0.05;
    var item = current;
    if (item.kind === 'interval') {
      tone(ctx, item.notes[0], t0, 0.7);
      tone(ctx, item.notes[1], t0 + 0.65, 1.1);
    } else if (item.kind === 'chord') {
      item.notes.forEach(function (m) { tone(ctx, m, t0, 1.8); });
    } else {
      item.chords.forEach(function (ch, i) {
        ch.forEach(function (m) { tone(ctx, m, t0 + i * 0.8, 0.85); });
      });
    }
    // Keys light only once the question is answered, so playing never
    // gives the answer away. A replayed progression lights each chord
    // in turn.
    if (answered) {
      if (item.kind === 'progression') {
        item.chords.forEach(function (ch, i) {
          setTimeout(function () { lightKeys(ch); }, i * 800);
        });
      } else {
        lightKeys(item.notes);
      }
    }
  }

  // ── Piano strip ─────────────────────────────────────────────────────────
  var WHITE = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 9: 5, 11: 6 };
  var BLACK_GAP = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
  function buildKeyboard() {
    ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C'].forEach(function (n) {
      var d = document.createElement('div');
      d.className = 'w';
      d.textContent = n;
      els.kb.appendChild(d);
    });
    [0, 1, 3, 4, 5].forEach(function (gi) {
      var b = document.createElement('div');
      b.className = 'b';
      b.style.left = 'calc(' + ((gi + 1) * 12.5) + '% - 10px)';
      els.kb.appendChild(b);
    });
  }
  function lightKeys(midis) {
    els.kb.querySelectorAll('.on').forEach(function (n) { n.classList.remove('on'); });
    (midis || []).forEach(function (m) {
      var rel = ((m - 60) % 12 + 12) % 12;
      if (m % 12 === 0 && m !== 60) rel = 12; // the top C lights the 8th white key
      var key;
      if (rel === 12) key = els.kb.children[7];
      else if (WHITE[rel] !== undefined) key = els.kb.children[WHITE[rel]];
      else key = els.kb.children[8 + BLACK_GAP[rel]];
      if (key) key.classList.add('on');
    });
  }

  // ── Session ─────────────────────────────────────────────────────────────
  function pickQuestion() {
    var item;
    do {
      item = lesson.items[Math.floor(Math.random() * lesson.items.length)];
    } while (lesson.items.length > 1 && previous && item === previous);
    previous = item;
    return item;
  }

  function questionText(kind) {
    if (kind === 'interval') return 'What interval is this?';
    if (kind === 'chord') return 'What chord is this?';
    return 'Which song is this?';
  }
  function hintText(kind) {
    return kind === 'progression'
      ? 'Four chords from C, one after another. Replay as needed.'
      : 'Played from C. Replay as needed.';
  }

  function startSession(id) {
    lesson = BY_ID[id] || CATALOGUE[0];
    finished = false;
    qIndex = 1;
    correct = 0;
    streak = 0;
    previous = null;
    els.result.hidden = true;
    els.playRow.hidden = false;
    els.answersSection.hidden = false;
    nextQuestion();
    renderList();
  }

  function nextQuestion() {
    current = pickQuestion();
    answered = false;
    els.q.textContent = questionText(current.kind);
    els.hint.textContent = hintText(current.kind);
    renderAnswers();
    lightKeys(null);
    els.fb.hidden = true;
    els.streak.textContent = 'Streak: ' + streak;
    els.next.disabled = true;
    renderLessonHead();
    updateMeta();
  }

  function renderLessonHead() {
    els.title.textContent = lesson.name;
    els.sub.textContent = lesson.items.map(function (i) { return i.label; }).join(', ')
      + ': ' + lesson.items.length + ' of ' + lesson.total + ' ' + lesson.unit;
  }

  function renderAnswers() {
    els.answers.innerHTML = '';
    lesson.items.forEach(function (item) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'a';
      b._item = item;
      b.appendChild(document.createTextNode(item.label));
      var s = document.createElement('small');
      s.textContent = item.small;
      s.hidden = true;
      b.appendChild(s);
      b.addEventListener('click', function () { answer(item); });
      els.answers.appendChild(b);
    });
  }

  function updateMeta() {
    els.metaQ.textContent = finished
      ? 'Session done'
      : 'Question ' + qIndex + ' of ' + QUESTIONS;
    els.metaC.textContent = correct + ' correct';
    els.bar.innerHTML = '';
    for (var i = 1; i <= QUESTIONS; i++) {
      var seg = document.createElement('i');
      if (finished || i < qIndex) seg.className = 'd';
      else if (i === qIndex && answered) seg.className = 'm';
      els.bar.appendChild(seg);
    }
  }

  function answer(item) {
    if (answered || finished) return;
    answered = true;
    touched = true;
    var right = item === current;
    if (right) { correct++; streak++; } else { streak = 0; }
    els.answers.querySelectorAll('.a').forEach(function (b) {
      if (b._item === current) {
        b.classList.add('ok');
        b.querySelector('small').hidden = false;
      } else if (b._item === item) {
        b.classList.add('no');
        b.querySelector('small').hidden = false;
      }
    });
    els.fbText.textContent = current.label + ': ' + current.desc;
    els.fb.hidden = false;
    lightKeys(current.kind === 'progression' ? current.chords[0] : current.notes);
    els.streak.textContent = 'Streak: ' + streak;
    els.next.disabled = false;
    if (qIndex >= QUESTIONS) {
      finishSession();
    } else {
      updateMeta();
    }
  }

  function next() {
    if (!answered || finished) return;
    qIndex++;
    nextQuestion();
  }

  function nextLessonId() {
    var i = CATALOGUE.indexOf(lesson);
    return i >= 0 && i < CATALOGUE.length - 1 ? CATALOGUE[i + 1].id : null;
  }

  function bestFor(id) {
    for (var i = 0; i < progressRows.length; i++) {
      if (progressRows[i].lessonId === id && progressRows[i].best != null) {
        return progressRows[i].best;
      }
    }
    return null;
  }

  function finishSession() {
    finished = true;
    els.playRow.hidden = true;
    els.answersSection.hidden = true;
    els.result.hidden = false;
    els.resultScore.textContent = 'You got ' + correct + ' of 10';
    var best = bestFor(lesson.id);
    els.resultBest.textContent = best == null
      ? 'First score for this lesson.'
      : 'Best for this lesson: ' + Math.max(best, correct) + ' of 10';
    els.nextLesson.hidden = nextLessonId() === null;
    els.saveFail.hidden = true;
    updateMeta();
    saveScore();
  }

  // ── Saving ──────────────────────────────────────────────────────────────
  function saveScore() {
    var body = JSON.stringify({ lessonId: lesson.id, correct: correct });
    var query = DEMO ? '?demo=1' : '';
    fetch('/api/progress' + query, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: body
    }).then(function (r) {
      if (!r.ok) throw new Error('save failed');
      return r.json();
    }).then(function () {
      els.saveFail.hidden = true;
      var row = null;
      progressRows.forEach(function (r) { if (r.lessonId === lesson.id) row = r; });
      if (row) {
        row.best = Math.max(row.best || 0, correct);
        row.last = correct;
      } else {
        progressRows.push({ lessonId: lesson.id, best: correct, last: correct });
      }
      els.resultBest.textContent = 'Best for this lesson: '
        + (bestFor(lesson.id) == null ? correct : Math.max(bestFor(lesson.id), correct)) + ' of 10';
      renderList();
      renderSheet();
    }).catch(function () {
      els.saveFail.hidden = false;
    });
  }

  // ── Progress list ───────────────────────────────────────────────────────
  function showProgressState(name) {
    els.progressLoading.hidden = name !== 'loading';
    els.progressList.hidden = name !== 'list';
    els.progressEmpty.hidden = name !== 'empty';
    els.progressError.hidden = name !== 'error';
  }

  function renderList() {
    var map = {};
    progressRows.forEach(function (r) { if (r.best != null) map[r.lessonId] = r; });
    if (lesson && !finished) map[lesson.id] = { live: true };
    els.progressList.innerHTML = '';
    var shown = 0;
    CATALOGUE.forEach(function (l) {
      var r = map[l.id];
      if (!r) return;
      shown++;
      var li = document.createElement('li');
      li.className = 'list-row';
      var b = document.createElement('b');
      b.textContent = l.name;
      var sp = document.createElement('span');
      sp.textContent = r.live ? correct + ' so far' : r.best + ' of 10';
      li.appendChild(b);
      li.appendChild(sp);
      els.progressList.appendChild(li);
    });
    if (shown === 0 && els.progressList.hidden === false) showProgressState('empty');
  }

  function loadProgress() {
    showProgressState('loading');
    fetch('/api/progress' + (DEMO ? '?demo=1' : ''), { headers: authHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('load failed'); return r.json(); })
      .then(function (rows) {
        progressRows = rows;
        renderSheet();
        if (rows.length === 0) {
          showProgressState('empty');
          // The opening lesson is the newest progress row, or Notes 1.
          if (!DEMO && !touched) startSession('notes-1');
        } else {
          showProgressState('list');
          if (!DEMO && !touched) startSession(rows[0].lessonId);
        }
        renderList();
      })
      .catch(function () {
        showProgressState('error');
        if (!touched) startSession('notes-1');
      });
  }

  // ── Lessons sheet ───────────────────────────────────────────────────────
  function renderSheet() {
    els.sheetBody.innerHTML = '';
    [['notes', 'Notes'], ['chords', 'Chords'], ['progressions', 'Progressions']]
      .forEach(function (group) {
        var lab = document.createElement('div');
        lab.className = 'section-label';
        lab.style.marginTop = '4px';
        lab.textContent = group[1];
        els.sheetBody.appendChild(lab);
        var ul = document.createElement('ul');
        ul.className = 'list';
        CATALOGUE.filter(function (l) { return l.type === group[0]; })
          .forEach(function (l) {
            var li = document.createElement('li');
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'list-row w-full cursor-pointer border-0 bg-transparent text-left';
            b._lesson = l;
            var name = document.createElement('b');
            name.textContent = l.name;
            var right = document.createElement('span');
            right.className = 'flex items-center gap-3';
            var count = document.createElement('span');
            count.textContent = l.items.length + ' sounds';
            var score = document.createElement('span');
            var best = bestFor(l.id);
            score.textContent = best == null ? 'Not started' : best + ' of 10';
            right.appendChild(count);
            right.appendChild(score);
            b.appendChild(name);
            b.appendChild(right);
            b.addEventListener('click', function () {
              closeSheet();
              startSession(l.id);
              showProgressState(progressRows.length ? 'list' : 'empty');
            });
            li.appendChild(b);
            ul.appendChild(li);
          });
        els.sheetBody.appendChild(ul);
      });
  }

  function openSheet() { renderSheet(); els.sheet.hidden = false; }
  function closeSheet() { els.sheet.hidden = true; }

  // ── Demo state ──────────────────────────────────────────────────────────
  function startDemo() {
    startSession('chords-2');
    qIndex = 7;
    correct = 6;
    streak = 4;
    touched = true;
    current = pickQuestion();
    answered = true;
    els.answers.querySelectorAll('.a').forEach(function (b) {
      if (b._item === current) {
        b.classList.add('ok');
        b.querySelector('small').hidden = false;
      }
    });
    els.fbText.textContent = current.label + ': ' + current.desc;
    els.fb.hidden = false;
    lightKeys(current.notes);
    els.streak.textContent = 'Streak: ' + streak;
    els.next.disabled = false;
    renderLessonHead();
    updateMeta();
  }

  // ── Wire up ─────────────────────────────────────────────────────────────
  buildKeyboard();
  els.play.addEventListener('click', play);
  els.next.addEventListener('click', next);
  els.retry.addEventListener('click', function () { startSession(lesson.id); });
  els.nextLesson.addEventListener('click', function () {
    var id = nextLessonId();
    if (id) startSession(id);
  });
  els.saveRetry.addEventListener('click', saveScore);
  els.progressRetry.addEventListener('click', loadProgress);
  els.sheetBtn.addEventListener('click', openSheet);
  els.sheetClose.addEventListener('click', closeSheet);
  els.sheetBackdrop.addEventListener('click', closeSheet);
  els.progressDemo.hidden = !DEMO;

  if (DEMO) {
    startDemo();
    loadProgress();
  } else {
    startSession('notes-1');
    loadProgress();
  }
})();