/* Ear Trainer: one practice screen.
 *
 * State: the chosen lesson, where we are in its ten questions, how many are
 * right and the current streak. Sounds are synthesised with Web Audio: an
 * AudioContext is created inside the first tap, because browsers block sound
 * until a person acts.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var DEMO = params.get('demo') === '1';
  var TOKEN = params.get('token') || (window.usernode && window.usernode.token) || '';
  var LESSONS = window.LESSONS || [];
  var byId = {};
  LESSONS.forEach(function (l) { byId[l.id] = l; });

  var TOTAL_QUESTIONS = 10;

  var el = {
    title: document.getElementById('lesson-title'),
    sub: document.getElementById('lesson-sub'),
    bar: document.getElementById('progress-bar'),
    metaQuestion: document.getElementById('meta-question'),
    metaCorrect: document.getElementById('meta-correct'),
    play: document.getElementById('play'),
    question: document.getElementById('question'),
    keyboard: document.getElementById('keyboard'),
    answers: document.getElementById('answers'),
    answersWrap: document.getElementById('answers-wrap'),
    feedback: document.getElementById('feedback'),
    feedbackText: document.getElementById('feedback-text'),
    streak: document.getElementById('streak'),
    next: document.getElementById('next'),
    sessionRow: document.getElementById('session-row'),
    questionView: document.getElementById('question-view'),
    results: document.getElementById('results'),
    resultScore: document.getElementById('result-score'),
    resultBest: document.getElementById('result-best'),
    saveStatus: document.getElementById('save-status'),
    saveRetry: document.getElementById('save-retry'),
    tryAgain: document.getElementById('try-again'),
    nextLesson: document.getElementById('next-lesson'),
    progressLabel: document.getElementById('progress-label'),
    progressList: document.getElementById('progress-list'),
    progressLoading: document.getElementById('progress-loading'),
    progressEmpty: document.getElementById('progress-empty'),
    progressError: document.getElementById('progress-error'),
    progressRetry: document.getElementById('progress-retry'),
    sheet: document.getElementById('sheet'),
    sheetBody: document.getElementById('sheet-body'),
    sheetOpen: document.getElementById('lessons-open'),
    sheetClose: document.getElementById('sheet-close'),
  };

  // Session state.
  var lesson = null;
  var answersOrder = [];
  var qIndex = 0;
  var correct = 0;
  var streak = 0;
  var currentItem = null;
  var previousItemId = null;
  var answered = false;
  var chosenId = null;
  var log = [];
  var sessionActive = false;
  var finished = false;
  var interacted = false;

  // Saved progress, newest first as the server returns it.
  var progress = [];
  var progressReady = false;

  // ---- data ----------------------------------------------------------

  function lessonName(id) {
    return byId[id] ? byId[id].name : id;
  }

  function headers(json) {
    var h = {};
    if (TOKEN) h['x-usernode-token'] = TOKEN;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  function withDemo(path) {
    if (!DEMO) return path;
    return path + (path.indexOf('?') === -1 ? '?' : '&') + 'demo=1';
  }

  function loadProgress() {
    el.progressLoading.hidden = false;
    el.progressList.hidden = true;
    el.progressEmpty.hidden = true;
    el.progressError.hidden = true;
    fetch(withDemo('/api/progress'), { headers: headers(false) })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (rows) {
        progress = Array.isArray(rows) ? rows : [];
        progressReady = true;
        renderProgress();
        maybeOpenLatest();
        if (!el.sheet.hidden) renderSheet();
      })
      .catch(function () {
        progressReady = false;
        el.progressLoading.hidden = true;
        el.progressList.hidden = true;
        el.progressEmpty.hidden = true;
        el.progressError.hidden = false;
        if (!el.sheet.hidden) renderSheet();
      });
  }

  // Opening lesson: the newest progress row, or Notes 1. Never swap the
  // lesson under someone who has already started answering.
  function maybeOpenLatest() {
    if (DEMO || interacted || !progress.length) return;
    var newest = progress[0];
    if (byId[newest.lessonId] && (!lesson || lesson.id !== newest.lessonId)) {
      startSession(newest.lessonId, true);
    }
  }

  function bestFor(lessonId) {
    for (var i = 0; i < progress.length; i++) {
      if (progress[i].lessonId === lessonId) return progress[i];
    }
    return null;
  }

  // ---- session -------------------------------------------------------

  function shuffle(items) {
    var copy = items.slice();
    for (var i = copy.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = copy[i];
      copy[i] = copy[j];
      copy[j] = t;
    }
    return copy;
  }

  function pickItem() {
    var pool = lesson.items.filter(function (item) { return item.id !== previousItemId; });
    if (!pool.length) pool = lesson.items;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function questionFor(type) {
    if (type === 'notes') return 'What interval is this?';
    if (type === 'progressions') return 'What progression is this?';
    return 'What chord is this?';
  }

  function lowerFirst(text) {
    return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
  }

  function upperFirst(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
  }

  function subtitleFor(l) {
    var labels = l.items.map(function (item) {
      return item.kind === 'progression' ? item.label : lowerFirst(item.label);
    });
    var last = labels.pop();
    var joined = labels.length ? labels.join(', ') + ' and ' + last : last;
    return upperFirst(joined) + ': ' + l.items.length + ' of ' + l.total + ' ' + l.unit;
  }

  function startSession(lessonId, doShuffle) {
    lesson = byId[lessonId] || byId['notes-1'];
    if (!lesson) return;
    answersOrder = doShuffle ? shuffle(lesson.items) : lesson.items.slice();
    qIndex = 0;
    correct = 0;
    streak = 0;
    log = [];
    previousItemId = null;
    currentItem = pickItem();
    answered = false;
    chosenId = null;
    finished = false;
    sessionActive = true;

    el.results.hidden = true;
    el.questionView.hidden = false;
    el.answersWrap.hidden = false;
    el.sessionRow.hidden = false;

    el.title.textContent = lesson.name;
    el.sub.textContent = subtitleFor(lesson);
    el.question.textContent = questionFor(lesson.type);
    el.feedback.hidden = true;
    el.next.hidden = true;
    clearKeys();
    renderStreak();
    renderMeta();
    renderBar();
    renderAnswers();
  }

  function nextQuestion() {
    if (!sessionActive || !answered) return;
    qIndex += 1;
    if (qIndex >= TOTAL_QUESTIONS) {
      finishSession();
      return;
    }
    previousItemId = currentItem.id;
    currentItem = pickItem();
    answered = false;
    chosenId = null;
    el.feedback.hidden = true;
    el.next.hidden = true;
    clearKeys();
    renderMeta();
    renderBar();
    renderAnswers();
    renderStreak();
  }

  function finishSession() {
    sessionActive = false;
    finished = true;
    answered = false;
    el.questionView.hidden = true;
    el.answersWrap.hidden = true;
    el.sessionRow.hidden = true;
    el.results.hidden = false;
    el.resultScore.textContent = 'You scored ' + correct + ' of ' + TOTAL_QUESTIONS;
    renderBest();
    var next = nextLesson();
    el.nextLesson.hidden = !next;
    saveScore();
  }

  function nextLesson() {
    var idx = LESSONS.indexOf(lesson);
    return idx >= 0 && idx < LESSONS.length - 1 ? LESSONS[idx + 1] : null;
  }

  function renderBest() {
    var row = bestFor(lesson.id);
    if (row) {
      el.resultBest.textContent = 'Your best: ' + row.bestCorrect + ' of ' + TOTAL_QUESTIONS;
    } else {
      el.resultBest.textContent = 'This is your first score for this lesson.';
    }
    el.resultBest.hidden = false;
  }

  function saveScore() {
    el.saveRetry.hidden = true;
    el.saveStatus.textContent = 'Saving your score.';
    fetch(withDemo('/api/progress'), {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({ lessonId: lesson.id, correct: correct }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function () {
        el.saveStatus.textContent = 'Your score was saved.';
        refreshProgress();
      })
      .catch(function () {
        el.saveStatus.textContent = 'Your score was not saved.';
        el.saveRetry.hidden = false;
      });
  }

  function refreshProgress() {
    fetch(withDemo('/api/progress'), { headers: headers(false) })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (rows) {
        if (!Array.isArray(rows)) return;
        progress = rows;
        progressReady = true;
        renderProgress();
        renderBest();
        if (!el.sheet.hidden) renderSheet();
      })
      .catch(function () { /* the list keeps what it had */ });
  }

  function onAnswer(item) {
    if (!sessionActive || answered) return;
    interacted = true;
    answered = true;
    chosenId = item.id;
    var isCorrect = item.id === currentItem.id;
    log[qIndex] = isCorrect;
    if (isCorrect) {
      correct += 1;
      streak += 1;
    } else {
      streak = 0;
    }
    markAnswers();
    renderMeta();
    renderBar();
    renderStreak();
    showFeedback(isCorrect);
    el.next.hidden = false;
    visualise(currentItem);
  }

  function showFeedback(isCorrect) {
    var line = currentItem.label + ': ' + lowerFirst(currentItem.description);
    if (!isCorrect) line = 'It was ' + line;
    el.feedbackText.textContent = line;
    el.feedback.hidden = false;
  }

  // ---- rendering -----------------------------------------------------

  function renderMeta() {
    el.metaQuestion.textContent = 'Question ' + Math.min(qIndex + 1, TOTAL_QUESTIONS) + ' of ' + TOTAL_QUESTIONS;
    el.metaCorrect.textContent = correct + ' correct';
  }

  function renderBar() {
    var segs = el.bar.children;
    for (var i = 0; i < segs.length; i++) {
      var cls = '';
      if (i === qIndex && answered) cls = 'm';
      else if (log[i] === true) cls = 'd';
      segs[i].className = cls;
    }
  }

  function renderStreak() {
    el.streak.textContent = 'Streak: ' + streak;
  }

  function renderAnswers() {
    el.answers.replaceChildren();
    answersOrder.forEach(function (item) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'a' + (item.kind === 'progression' ? ' prog' : '');
      b.dataset.answer = item.id;
      var name = document.createElement('span');
      name.textContent = item.label;
      b.appendChild(name);
      b.addEventListener('click', function () { onAnswer(item); });
      el.answers.appendChild(b);
    });
  }

  function markAnswers() {
    Array.prototype.forEach.call(el.answers.children, function (b) {
      var item = answersOrder.find(function (i) { return i.id === b.dataset.answer; });
      var isRight = item.id === currentItem.id;
      b.classList.remove('ok', 'no');
      if (isRight) b.classList.add('ok');
      else if (item.id === chosenId) b.classList.add('no');
      b.disabled = true;
      if (isRight || item.id === chosenId) {
        var small = document.createElement('small');
        small.textContent = item.answerNotes;
        b.appendChild(small);
      }
    });
  }

  function clearKeys() {
    Array.prototype.forEach.call(el.keyboard.querySelectorAll('.on'), function (k) {
      k.classList.remove('on');
    });
  }

  function lightKeys(notes) {
    clearKeys();
    notes.forEach(function (midi) {
      var key = el.keyboard.querySelector('[data-midi="' + midi + '"]');
      if (key) key.classList.add('on');
    });
  }

  // A chord or interval lights all at once. A progression lights each chord
  // in turn while it plays again, so the shape of the change is visible.
  function visualise(item) {
    if (item.kind !== 'progression') {
      lightKeys(item.notes);
      return;
    }
    clearKeys();
    playItem(item);
    item.chords.forEach(function (chord, i) {
      setTimeout(function () {
        if (currentItem === item) lightKeys(chord);
      }, i * 800);
    });
  }

  function renderProgress() {
    el.progressLoading.hidden = true;
    el.progressError.hidden = true;
    el.progressEmpty.hidden = true;
    el.progressList.replaceChildren();

    var rows = [];
    if (DEMO) {
      // The demo list holds the fixed demo scores plus the session in hand.
      LESSONS.forEach(function (l) {
        var p = bestFor(l.id);
        if (p) rows.push({ lesson: l, text: p.bestCorrect + ' of ' + TOTAL_QUESTIONS });
        else if (lesson && l.id === lesson.id) rows.push({ lesson: l, text: correct + ' so far' });
      });
    } else {
      progress.forEach(function (p) {
        if (!byId[p.lessonId]) return;
        rows.push({ lesson: byId[p.lessonId], text: p.bestCorrect + ' of ' + TOTAL_QUESTIONS });
      });
    }

    if (!rows.length) {
      el.progressList.hidden = true;
      el.progressEmpty.hidden = false;
      return;
    }

    rows.forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'list-row';
      var b = document.createElement('b');
      b.textContent = r.lesson.name;
      var span = document.createElement('span');
      span.textContent = r.text;
      li.appendChild(b);
      li.appendChild(span);
      el.progressList.appendChild(li);
    });
    el.progressList.hidden = false;
  }

  function renderSheet() {
    el.sheetBody.replaceChildren();
    var groups = [
      { type: 'notes', label: 'Notes' },
      { type: 'chords', label: 'Chords' },
      { type: 'progressions', label: 'Progressions' },
    ];
    groups.forEach(function (g) {
      var label = document.createElement('div');
      label.className = 'section-label';
      label.textContent = g.label;
      el.sheetBody.appendChild(label);

      var list = document.createElement('ul');
      list.className = 'list';
      LESSONS.filter(function (l) { return l.type === g.type; }).forEach(function (l) {
        var li = document.createElement('li');
        li.className = 'list-row lesson-row';
        li.dataset.lesson = l.id;
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'lesson-pick';

        var name = document.createElement('b');
        name.textContent = l.name;
        var meta = document.createElement('span');
        meta.className = 'lesson-meta';
        meta.textContent = l.items.length + (l.items.length === 1 ? ' sound' : ' sounds');
        var score = document.createElement('span');
        score.className = 'lesson-score';
        var saved = bestFor(l.id);
        score.textContent = saved ? saved.bestCorrect + ' of ' + TOTAL_QUESTIONS : 'Not started';

        b.appendChild(name);
        b.appendChild(meta);
        b.appendChild(score);
        b.addEventListener('click', function () {
          interacted = true;
          closeSheet();
          startSession(l.id, true);
        });
        li.appendChild(b);
        list.appendChild(li);
      });
      el.sheetBody.appendChild(list);
    });
  }

  function openSheet() {
    renderSheet();
    el.sheet.hidden = false;
    document.body.classList.add('sheet-open');
    el.sheetClose.focus();
  }

  function closeSheet() {
    el.sheet.hidden = true;
    document.body.classList.remove('sheet-open');
    el.sheetOpen.focus();
  }

  // ---- sound ---------------------------------------------------------

  var audio = null;

  function ensureAudio() {
    if (!audio) {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audio = new Ctx();
    }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }

  // A soft synthesised piano: a triangle wave with a short attack and a
  // gentle decay.
  function playTone(midi, when, duration, level) {
    if (!audio) return;
    var freq = 440 * Math.pow(2, (midi - 69) / 12);
    var osc = audio.createOscillator();
    var gain = audio.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(level, when + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(when);
    osc.stop(when + duration + 0.05);
  }

  function playItem(item) {
    if (!audio || !item) return;
    var t = audio.currentTime + 0.05;
    if (item.kind === 'interval') {
      playTone(item.notes[0], t, 1.0, 0.22);
      playTone(item.notes[1], t + 0.55, 1.1, 0.22);
    } else if (item.kind === 'chord') {
      item.notes.forEach(function (n) { playTone(n, t, 1.7, 0.16); });
    } else {
      item.chords.forEach(function (chord, i) {
        chord.forEach(function (n) { playTone(n, t + i * 0.8, 0.8, 0.15); });
      });
    }
  }

  // ---- demo ----------------------------------------------------------

  function startDemoSession() {
    lesson = byId['chords-2'];
    if (!lesson) { startSession('notes-1', true); return; }
    var fixed = ['minor', 'major', 'diminished', 'suspended'];
    answersOrder = fixed.map(function (id) {
      return lesson.items.find(function (i) { return i.id === id; });
    }).filter(Boolean);
    qIndex = 6;
    correct = 6;
    streak = 4;
    log = [true, true, true, true, true, true];
    previousItemId = 'minor';
    currentItem = lesson.items.find(function (i) { return i.id === 'major'; });
    answered = true;
    chosenId = 'minor';
    sessionActive = true;
    finished = false;

    el.results.hidden = true;
    el.questionView.hidden = false;
    el.answersWrap.hidden = false;
    el.sessionRow.hidden = false;
    el.title.textContent = lesson.name;
    el.sub.textContent = subtitleFor(lesson);
    el.question.textContent = questionFor(lesson.type);
    renderAnswers();
    markAnswers();
    renderMeta();
    renderBar();
    renderStreak();
    showFeedback(true);
    el.next.hidden = false;
    lightKeys(currentItem.notes);
  }

  // ---- wiring --------------------------------------------------------

  el.play.addEventListener('click', function () {
    interacted = true;
    ensureAudio();
    playItem(currentItem);
  });

  el.next.addEventListener('click', function () {
    interacted = true;
    nextQuestion();
  });

  el.tryAgain.addEventListener('click', function () {
    interacted = true;
    startSession(lesson.id, true);
  });

  el.nextLesson.addEventListener('click', function () {
    var next = nextLesson();
    if (!next) return;
    interacted = true;
    startSession(next.id, true);
  });

  el.saveRetry.addEventListener('click', saveScore);
  el.progressRetry.addEventListener('click', loadProgress);

  el.sheetOpen.addEventListener('click', openSheet);
  el.sheetClose.addEventListener('click', closeSheet);
  el.sheet.addEventListener('click', function (e) {
    if (e.target === el.sheet) closeSheet();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el.sheet.hidden) closeSheet();
  });

  // On a demo, say once, plainly, that the scores are made up.
  if (DEMO) {
    el.progressLabel.replaceChildren();
    el.progressLabel.appendChild(document.createTextNode('Your progress ('));
    var note = document.createElement('span');
    note.setAttribute('data-usernode-demo-note', '');
    note.textContent = 'Staging demo';
    el.progressLabel.appendChild(note);
    el.progressLabel.appendChild(document.createTextNode(')'));
  }

  if (DEMO) startDemoSession();
  else startSession('notes-1', true);
  loadProgress();
})();
