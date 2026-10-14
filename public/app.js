/* Club Votes frontend. Hash routes: #/ (the list), #/new (post a
 * decision), #/d/:id (a decision and its comments). The markup reproduces
 * the two screens the spec drew, rendered from data. */
(function () {
  'use strict';

  // The iframe arrives with ?token=...; forward it on every API call.
  // Stash it in sessionStorage so reloads and hash changes keep it.
  var query = new URLSearchParams(location.search);
  var TOKEN = query.get('token') || '';
  try {
    if (TOKEN) sessionStorage.setItem('cv_token', TOKEN);
    else TOKEN = sessionStorage.getItem('cv_token') || '';
  } catch (_) {}
  var DEMO = query.get('demo') === '1';

  var list = { tab: 'open', loading: true, error: null, data: null };
  var detail = { id: null, loading: true, error: null, data: null };
  var notice = ''; // a transient line above the list, e.g. a vote that failed

  function api(path, opts) {
    opts = opts || {};
    if (DEMO) path += (path.indexOf('?') === -1 ? '?' : '&') + 'demo=1';
    var headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['x-usernode-token'] = TOKEN;
    return fetch('/api' + path, Object.assign({}, opts, {
      headers: Object.assign(headers, opts.headers || {}),
    })).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) {
          var err = new Error(body && body.error ? body.error : 'HTTP ' + res.status);
          err.status = res.status;
          throw err;
        }
        return body;
      });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ago(iso) {
    if (!iso) return '';
    var d = new Date(iso), now = new Date();
    var day = 24 * 60 * 60 * 1000;
    var days = Math.floor((now - d) / day);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return days + ' days ago';
  }

  var SPEECH_SVG = '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.5A8 8 0 1 1 21 12z"/></svg>';
  var FLAG_SVG = '<svg viewBox="0 0 24 24"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>';
  var TRASH_SVG = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

  function resultPhrase(d) {
    if (d.result === 'passed') return 'Passed ' + d.yes + ' to ' + d.no;
    if (d.result === 'not_passed') return 'Not passed ' + d.no + ' to ' + d.yes;
    return 'Tied ' + d.yes + ' to ' + d.no + ', not passed';
  }

  function resultColor(d) {
    if (d.result === 'passed') return 'rgb(var(--accent))';
    if (d.result === 'not_passed') return 'rgb(var(--no))';
    return 'rgb(var(--muted))';
  }

  function statusLine(d) {
    if (d.status === 'closed') return 'Comments stay open.';
    var lead;
    if (d.yes === 0 && d.no === 0 && d.abstain === 0) lead = 'No votes yet.';
    else if (d.yes === d.no) lead = 'Tied at ' + d.yes + ' each.';
    else lead = (d.yes > d.no ? 'Yes' : 'No') + ' leads ' + Math.max(d.yes, d.no) + ' to ' + Math.min(d.yes, d.no) + '.';
    return lead + (d.my_vote ? ' You voted ' + { yes: 'Yes', no: 'No', abstain: 'Abstain' }[d.my_vote] + '.' : " You haven't voted yet.");
  }

  function barHtml(d) {
    var total = d.yes + d.no + d.abstain;
    if (!total) return '<div class="bar"><span class="y" style="width:0"></span></div>';
    var w = function (n) { return Math.round((n / total) * 100) + '%'; };
    return '<div class="bar"><span class="y" style="width:' + w(d.yes) + '"></span>' +
      '<span class="n" style="width:' + w(d.no) + '"></span>' +
      '<span class="a" style="width:' + w(d.abstain) + '"></span></div>';
  }

  function tallyHtml(d) {
    if (!d.yes && !d.no && !d.abstain) return '<div class="tally"><span>No votes yet</span></div>';
    return '<div class="tally"><span><i class="y"></i>Yes ' + d.yes + '</span>' +
      '<span><i class="n"></i>No ' + d.no + '</span>' +
      '<span><i class="a"></i>Abstain ' + d.abstain + '</span></div>';
  }

  function voteButtonsHtml(d) {
    return ['yes', 'no', 'abstain'].map(function (choice) {
      var label = { yes: 'Yes', no: 'No', abstain: 'Abstain' }[choice];
      return '<button type="button" class="btn-secondary' + (d.my_vote === choice ? ' mine' : '') +
        '" data-vote="' + choice + '">' + label + '</button>';
    }).join('');
  }

  function cardHtml(d, opened) {
    // Closed cards show the result line in place of the vote buttons.
    var votesHtml;
    if (d.status === 'closed') {
      votesHtml = '<div class="foot"><span style="font-weight:600;color:' + resultColor(d) + '">' +
        esc(resultPhrase(d)) + '</span><span class="meta">' + SPEECH_SVG + d.comment_count + '</span></div>';
    } else if (opened) {
      votesHtml = '<div class="votes">' + voteButtonsHtml(d) + '</div>' +
        (d.is_mine
          ? '<div class="row"><span class="small">Closed votes stay closed.</span><button type="button" class="btn-secondary" data-close>Close vote</button></div>'
          : '');
    } else {
      votesHtml = '<div class="foot"><div class="votes">' + voteButtonsHtml(d) +
        '</div><span class="meta">' + SPEECH_SVG + d.comment_count + '</span></div>';
    }
    return '<div class="card" data-decision data-id="' + d.id + '"' + (opened ? '' : ' data-openable') + '>' +
      '<div class="q">' + esc(d.question) + '</div>' +
      '<div class="small" style="margin-top:4px">Posted by ' + (d.is_mine ? 'you' : esc(d.author_name)) +
      ' · ' + ago(d.created_at) + (d.status === 'closed' ? ' · Closed' : '') + '</div>' +
      (opened && d.details ? '<p class="body">' + esc(d.details) + '</p>' : '') +
      barHtml(d) + tallyHtml(d) +
      (opened ? '<div class="small" style="margin-top:6px">' + esc(statusLine(d)) + '</div>' : '') +
      votesHtml +
      '</div>';
  }

  function skeletonCards() {
    var one = '<div class="card"><div class="skeleton" style="height:24px;width:82%"></div>' +
      '<div class="skeleton" style="height:16px;width:45%;margin-top:8px"></div>' +
      '<div class="skeleton" style="height:10px;margin:14px 0 8px"></div>' +
      '<div class="skeleton" style="height:16px;width:60%"></div>' +
      '<div class="skeleton" style="height:44px;margin-top:12px"></div></div>';
    return one + one + one;
  }

  function noticeHtml() {
    return notice ? '<div class="label" id="notice" style="color:rgb(var(--danger))">' + esc(notice) + '</div>' : '';
  }

  // ── List screen ──────────────────────────────────────────────────────────

  function renderList() {
    var area = document.getElementById('list-area');
    var fab = document.getElementById('fab');
    var seg = document.getElementById('seg');
    document.getElementById('chip-open').textContent = 'Open' + (list.counts ? ' · ' + list.counts.open : '');
    document.getElementById('chip-closed').textContent = 'Closed' + (list.counts ? ' · ' + list.counts.closed : '');
    document.getElementById('chip-open').classList.toggle('on', list.tab === 'open');
    document.getElementById('chip-closed').classList.toggle('on', list.tab === 'closed');

    var html = noticeHtml();
    if (list.loading) {
      html += skeletonCards();
      fab.hidden = false;
    } else if (list.error) {
      html += '<div class="state-error"><p class="text-body">The decisions couldn’t load.</p>' +
        '<p class="small">Your votes are safe. Nothing else in the app is affected.</p>' +
        '<button type="button" class="btn-secondary" data-retry>Retry</button></div>';
      fab.hidden = false;
    } else if (!list.data || !list.data.decisions.length) {
      if (list.tab === 'open') {
        html += '<div class="state-empty"><p class="text-body">No open decisions yet. Post the first thing the club needs to decide.</p>' +
          '<button type="button" class="btn-primary" data-new>Post a decision</button></div>';
        fab.hidden = true; // the empty state's own button is the one filled button
      } else {
        html += '<div class="state-empty"><p class="text-body">No closed decisions yet.</p>' +
          '<p class="small">When the person who posted one closes it, it shows up here with its result.</p></div>';
        fab.hidden = false;
      }
    } else {
      html += list.data.decisions.map(function (d) { return cardHtml(d, false); }).join('');
      fab.hidden = false;
    }
    seg.style.visibility = list.loading ? 'hidden' : 'visible';
    area.innerHTML = html;
  }

  function loadList() {
    list.loading = true;
    list.error = null;
    renderList();
    api('/decisions?status=' + list.tab).then(function (data) {
      list.loading = false;
      list.data = data;
      list.counts = { open: data.open_count, closed: data.closed_count };
      renderList();
    }).catch(function (err) {
      list.loading = false;
      list.error = err;
      renderList();
    });
  }

  // ── Detail screen ────────────────────────────────────────────────────────

  function renderDetail() {
    var area = document.getElementById('detail-area');
    if (detail.loading) {
      area.innerHTML = '<div class="nav"><button type="button" class="ghost" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Decisions</button></div>' + skeletonCards();
      return;
    }
    if (detail.error) {
      area.innerHTML = '<div class="nav"><button type="button" class="ghost" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Decisions</button></div>' +
        '<div class="state-error"><p class="text-body">The decision couldn’t load.</p>' +
        '<p class="small">Your votes are safe. You can go back to the list.</p>' +
        '<button type="button" class="btn-secondary" data-retry>Retry</button></div>';
      return;
    }
    var d = detail.data.decision;
    var comments = detail.data.comments;
    var nav = '<div class="nav"><button type="button" class="ghost" data-back><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Decisions</button>' +
      (d.is_mine
        ? '<button type="button" class="ghost" data-delete>' + TRASH_SVG + 'Delete</button>'
        : '<button type="button" class="ghost" data-report-decision' + (detail.reportedDecision ? ' disabled' : '') + '>' + FLAG_SVG + (detail.reportedDecision ? 'Reported' : 'Report') + '</button>') +
      '</div>';
    var rows = comments.map(function (c) {
      return '<div class="list-row"><div class="who"><b>' + (c.is_mine ? 'You' : esc(c.author_name)) + '</b>' +
        '<span class="small">' + ago(c.created_at) + '</span></div>' +
        '<p>' + esc(c.body) + '</p>' +
        '<div class="act">' + (c.is_mine
          ? '<button type="button" class="ghost" data-del-comment="' + c.id + '">' + TRASH_SVG + 'Delete</button>'
          : '<button type="button" class="ghost" data-report-comment="' + c.id + '"' + (c.reported ? ' disabled' : '') + '>' + FLAG_SVG + (c.reported ? 'Reported' : 'Report') + '</button>') +
        '</div></div>';
    }).join('');
    area.innerHTML = nav +
      cardHtml(d, true) +
      '<div class="section-label">Comments · ' + comments.length + '</div>' +
      (comments.length ? '<div class="list">' + rows + '</div>'
        : '<div class="state-empty"><p class="small">No comments yet. Start the discussion below.</p></div>') +
      '<div class="compose"><label class="lab" for="comment-body">Add a comment</label>' +
      '<textarea class="field" id="comment-body" maxlength="1000" style="color:rgb(var(--fg));opacity:1" placeholder="e.g. I can pick them up on Saturday"></textarea>' +
      '<div class="small" id="comment-error" hidden></div>' +
      '<button type="button" class="btn-primary" data-comment>Post comment</button></div>';
  }

  function loadDetail(id) {
    detail.id = id;
    detail.loading = true;
    detail.error = null;
    detail.reportedDecision = false;
    renderDetail();
    api('/decisions/' + id).then(function (data) {
      detail.loading = false;
      detail.data = data;
      renderDetail();
    }).catch(function (err) {
      detail.loading = false;
      detail.error = err;
      renderDetail();
    });
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  function findInList(id) {
    return list.data && list.data.decisions.find(function (d) { return d.id === Number(id); });
  }

  function vote(d, choice) {
    var next = choice === d.my_vote ? null : choice;
    var prev = { yes: d.yes, no: d.no, abstain: d.abstain, my_vote: d.my_vote };
    // Optimistic: apply the vote, send it, roll back with a message if it fails.
    if (d.my_vote === 'yes') d.yes--;
    if (d.my_vote === 'no') d.no--;
    if (d.my_vote === 'abstain') d.abstain--;
    if (next === 'yes') d.yes++;
    if (next === 'no') d.no++;
    if (next === 'abstain') d.abstain++;
    d.my_vote = next;
    notice = '';
    api('/decisions/' + d.id + '/vote', { method: 'PUT', body: JSON.stringify({ choice: next }) })
      .then(function (res) {
        d.yes = res.yes; d.no = res.no; d.abstain = res.abstain; d.my_vote = res.my_vote;
        renderCurrent();
      })
      .catch(function (err) {
        d.yes = prev.yes; d.no = prev.no; d.abstain = prev.abstain; d.my_vote = prev.my_vote;
        notice = err.status === 409 ? 'That vote just closed, so yours didn’t count.' :
          'Your vote didn’t save. It was put back the way it was.';
        renderCurrent();
      });
  }

  function renderCurrent() {
    if (current.view === 'detail') renderDetail();
    else renderList();
  }

  // ── New-decision screen ──────────────────────────────────────────────────

  function wireNew() {
    document.getElementById('new-back').addEventListener('click', function () { location.hash = '#/'; });
    document.getElementById('new-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var question = document.getElementById('new-question').value.trim();
      var details = document.getElementById('new-details').value.trim();
      var errBox = document.getElementById('new-error');
      errBox.hidden = true;
      if (!question || question.length > 200) {
        errBox.textContent = 'A question is needed, up to 200 characters.';
        errBox.hidden = false;
        return;
      }
      api('/decisions', { method: 'POST', body: JSON.stringify({ question: question, details: details }) })
        .then(function () { location.hash = '#/'; })
        .catch(function (err) {
          errBox.textContent = err.status === 401
            ? 'Make an account to post.'
            : 'The decision didn’t post. Try again.';
          errBox.hidden = false;
        });
    });
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  function wire() {
    document.getElementById('fab').addEventListener('click', function () { location.hash = '#/new'; });
    document.getElementById('chip-open').addEventListener('click', function () {
      if (list.tab !== 'open') { list.tab = 'open'; loadList(); }
    });
    document.getElementById('chip-closed').addEventListener('click', function () {
      if (list.tab !== 'closed') { list.tab = 'closed'; loadList(); }
    });

    document.getElementById('list-area').addEventListener('click', function (e) {
      var voteBtn = e.target.closest('[data-vote]');
      var card = e.target.closest('[data-decision]');
      if (voteBtn && card) {
        e.stopPropagation();
        var d = findInList(card.getAttribute('data-id'));
        if (d) vote(d, voteBtn.getAttribute('data-vote'));
        return;
      }
      if (e.target.closest('[data-retry]')) { loadList(); return; }
      if (e.target.closest('[data-new]')) { location.hash = '#/new'; return; }
      if (card && card.hasAttribute('data-openable')) {
        location.hash = '#/d/' + card.getAttribute('data-id');
      }
    });

    document.getElementById('detail-area').addEventListener('click', function (e) {
      if (e.target.closest('[data-back]')) { location.hash = '#/'; return; }
      var d = detail.data && detail.data.decision;
      if (!d) return;
      var voteBtn = e.target.closest('[data-vote]');
      if (voteBtn) { vote(d, voteBtn.getAttribute('data-vote')); return; }
      if (e.target.closest('[data-retry]')) { loadDetail(detail.id); return; }
      if (e.target.closest('[data-close]')) {
        if (window.confirm('Close this vote? Closed votes stay closed.')) {
          api('/decisions/' + d.id + '/close', { method: 'POST' })
            .then(function (res) { Object.assign(d, res.decision); renderDetail(); })
            .catch(function () { alert('The vote couldn’t be closed. Try again.'); });
        }
        return;
      }
      if (e.target.closest('[data-delete]')) {
        if (window.confirm('Delete this decision? Its votes and comments go too.')) {
          api('/decisions/' + d.id, { method: 'DELETE' })
            .then(function () { list.loaded = false; location.hash = '#/'; })
            .catch(function () { alert('The decision couldn’t be deleted. Try again.'); });
        }
        return;
      }
      if (e.target.closest('[data-report-decision]')) {
        api('/reports', { method: 'POST', body: JSON.stringify({ kind: 'decision', id: d.id }) })
          .then(function () { detail.reportedDecision = true; renderDetail(); })
          .catch(function () { alert('The report couldn’t be sent. Try again.'); });
        return;
      }
      var repComment = e.target.closest('[data-report-comment]');
      if (repComment) {
        api('/reports', { method: 'POST', body: JSON.stringify({ kind: 'comment', id: Number(repComment.getAttribute('data-report-comment')) }) })
          .then(function () {
            var c = detail.data.comments.find(function (c) { return c.id === Number(repComment.getAttribute('data-report-comment')); });
            if (c) c.reported = true;
            renderDetail();
          })
          .catch(function () { alert('The report couldn’t be sent. Try again.'); });
        return;
      }
      var delComment = e.target.closest('[data-del-comment]');
      if (delComment) {
        var cid = Number(delComment.getAttribute('data-del-comment'));
        if (window.confirm('Delete your comment?')) {
          api('/comments/' + cid, { method: 'DELETE' })
            .then(function () { loadDetail(detail.id); })
            .catch(function () { alert('The comment couldn’t be deleted. Try again.'); });
        }
        return;
      }
      if (e.target.closest('[data-comment]')) {
        var box = document.getElementById('comment-body');
        var errBox = document.getElementById('comment-error');
        errBox.hidden = true;
        var body = box.value.trim();
        if (!body) {
          errBox.textContent = 'Write a comment first.';
          errBox.hidden = false;
          return;
        }
        api('/decisions/' + d.id + '/comments', { method: 'POST', body: JSON.stringify({ body: body }) })
          .then(function () { loadDetail(detail.id); })
          .catch(function (err) {
            errBox.textContent = err.status === 401 ? 'Make an account to comment.' : 'The comment didn’t post. Try again.';
            errBox.hidden = false;
          });
      }
    });
  }

  // ── Router ───────────────────────────────────────────────────────────────

  var current = { view: 'list' };

  function route() {
    var h = location.hash || '#/';
    var m = h.match(/^#\/d\/(\d+)/);
    if (m) return { view: 'detail', id: Number(m[1]) };
    if (h === '#/new') return { view: 'new' };
    return { view: 'list' };
  }

  function render() {
    current = route();
    document.getElementById('screen-list').hidden = current.view !== 'list';
    document.getElementById('screen-detail').hidden = current.view !== 'detail';
    document.getElementById('screen-new').hidden = current.view !== 'new';
    if (current.view === 'detail') loadDetail(current.id);
    else if (current.view === 'list') loadList();
  }

  document.getElementById('top-line').textContent = DEMO
    ? 'Staging demo: a made-up club’s decisions'
    : 'Decide things together';

  wireNew();
  wire();
  window.addEventListener('hashchange', render);
  render();
})();
