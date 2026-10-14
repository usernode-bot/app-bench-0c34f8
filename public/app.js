/* Club Votes front end.
 *
 * Hash routes: #/ the list, #/new the post form, #/d/<id> one decision.
 * The screens' markup is the drawn one (public/screens.css styles it); the
 * drawn sample rows were emptied out and this script renders the same shape
 * from the API instead. In staging with ?demo=1 the app shows the seeded
 * demo and passes demo=1 on every API call; without it the app shows the
 * club's real, empty-at-first data.
 */
(function () {
  'use strict';

  var DEMO = new URLSearchParams(location.search).get('demo') === '1';
  // The shell mints the viewer's token and injects it as ?token= on load; the
  // iframe's own contract (see server.js) is to forward it on every fetch
  // through x-usernode-token. Keep it in sessionStorage so a reload after the
  // shell navigated us away from the signed URL still has it.
  var TOKEN = null;
  try {
    TOKEN = new URLSearchParams(location.search).get('token')
      || sessionStorage.getItem('club-votes-token');
    if (TOKEN) sessionStorage.setItem('club-votes-token', TOKEN);
  } catch (e) { TOKEN = null; }
  var $app = document.getElementById('app');
  var route = null;          // current parsed route
  var list = null;           // {open_count, closed_count, decisions} | null
  var listTab = 'open';      // 'open' | 'closed'
  var listError = null;
  var detail = null;         // {decision, comments} | null
  var detailError = null;
  var message = '';          // transient note (failed vote, report sent, ...)
  var messageTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function api(path, opts) {
    opts = opts || {};
    if (DEMO) {
      path += (path.indexOf('?') >= 0 ? '&' : '?') + 'demo=1';
    }
    if (TOKEN) {
      opts.headers = Object.assign({ 'x-usernode-token': TOKEN }, opts.headers);
    }
    if (opts.body) {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Something went wrong.');
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function loadList() {
    listError = null;
    if (!list) list = null;
    return api('/api/decisions').then(function (data) {
      list = data;
    }).catch(function (err) {
      listError = err.message;
    });
  }

  function loadDetail(id) {
    detailError = null;
    return api('/api/decisions/' + id).then(function (data) {
      detail = data;
    }).catch(function (err) {
      detailError = err.message;
    });
  }

  function parseRoute() {
    var h = location.hash || '#/';
    var m;
    if (h === '#/new') return { view: 'new' };
    if ((m = h.match(/^#\/d\/(\d+)$/))) return { view: 'detail', id: m[1] };
    return { view: 'list' };
  }

  function render() {
    route = parseRoute();
    if (messageTimer) { clearTimeout(messageTimer); messageTimer = null; }
    if (message) {
      messageTimer = setTimeout(function () { message = ''; render(); }, 5000);
    }
    if (route.view === 'list') {
      document.title = 'Club Votes';
      renderList();
    } else if (route.view === 'new') {
      document.title = 'Post a decision · Club Votes';
      renderNew();
    } else {
      document.title = 'Decision · Club Votes';
      renderDetail();
    }
  }

  // ── Screen 1: the list ───────────────────────────────────────────────────
  function renderList() {
    var chips =
      '<button class="chip' + (listTab === 'open' ? ' on' : '') + '" data-action="tab" data-tab="open">Open' +
      (list ? ' · ' + list.open_count : '') + '</button>' +
      '<button class="chip' + (listTab === 'closed' ? ' on' : '') + '" data-action="tab" data-tab="closed">Closed' +
      (list ? ' · ' + list.closed_count : '') + '</button>';

    var body;
    if (listError) {
      body = '<div class="state-error"><div class="q" style="font-size:18px;line-height:26px">Couldn\'t load the decisions.</div>' +
        '<div class="small">Loading failed, so nothing here has changed: your votes are safe. Check your connection and try again.</div>' +
        '<button class="btn-primary" data-action="retry">Retry</button></div>';
    } else if (!list) {
      body = skeletonCards(3);
    } else {
      var rows = list.decisions.filter(function (d) {
        return listTab === 'open' ? d.status === 'open' : d.status === 'closed';
      });
      if (!rows.length) {
        body = listTab === 'open'
          ? '<div class="state-empty"><div class="q" style="font-size:18px;line-height:26px">No open decisions yet.</div>' +
            '<div class="small">Post the first thing the club needs to decide.</div>' +
            '<button class="btn-primary" data-action="new">Post a decision</button></div>'
          : '<div class="state-empty"><div class="q" style="font-size:18px;line-height:26px">Nothing closed yet.</div>' +
            '<div class="small">When a poster closes a vote it moves here with its result.</div></div>';
      } else {
        body = rows.map(cardHtml).join('');
      }
    }

    var emptyOpen = !listError && list && listTab === 'open' &&
      list.decisions.every(function (d) { return d.status !== 'open'; });

    $app.innerHTML =
      '<div data-spec-screen="1"><div class="app">' +
      '<div class="top"><div class="title">Club Votes</div><div class="small">Decide things together</div></div>' +
      (DEMO ? '<div class="small" style="padding:0 4px">Staging demo: this data is fake, for looking only.</div>' : '') +
      (message ? '<div class="small" role="status" style="padding:4px 4px 0;color:rgb(var(--accent))">' + esc(message) + '</div>' : '') +
      '<div class="seg">' + chips + '</div>' +
      body +
      '<div class="label">Decided by simple majority of votes cast. Abstain counts as taking part, not as a vote.</div>' +
      // Hidden in the error state too, so Retry is the only filled button
      // while nothing has loaded.
      ((listError || emptyOpen) ? '' : '<button class="btn-primary fab" data-action="new"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Post a decision</button>') +
      '</div></div>';
  }

  function skeletonCards(n) {
    var one =
      '<div class="card">' +
      '<div class="skeleton" style="height:24px;width:75%"></div>' +
      '<div class="skeleton" style="height:16px;width:45%;margin-top:10px"></div>' +
      '<div class="bar"></div>' +
      '<div class="tally"><span class="skeleton" style="width:52px;height:16px"></span>' +
      '<span class="skeleton" style="width:44px;height:16px"></span>' +
      '<span class="skeleton" style="width:66px;height:16px"></span></div>' +
      '<div class="foot"><div class="votes">' +
      '<span class="skeleton" style="width:64px;height:44px;border-radius:8px"></span>' +
      '<span class="skeleton" style="width:52px;height:44px;border-radius:8px"></span>' +
      '<span class="skeleton" style="width:74px;height:44px;border-radius:8px"></span>' +
      '</div><span class="meta"><span class="skeleton" style="width:20px;height:20px"></span></span></div></div>';
    var out = '';
    for (var i = 0; i < n; i++) out += one;
    return out;
  }

  var COMMENT_SVG = '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.5A8 8 0 1 1 21 12z"/></svg>';
  var FLAG_SVG = '<svg viewBox="0 0 24 24"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>';
  var TRASH_SVG = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

  function timeAgo(iso) {
    var then = new Date(iso).getTime();
    if (isNaN(then)) return '';
    var mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    var days = Math.round(hrs / 24);
    if (days === 1) return 'yesterday';
    if (days < 30) return days + ' days ago';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // The tally bar and its three counts, shared by list and detail.
  function tallyHtml(d) {
    var total = d.yes + d.no + d.abstain;
    var pct = function (v) { return total ? Math.round((v / total) * 100) : 0; };
    var bar = total
      ? '<span class="y" style="width:' + pct(d.yes) + '%"></span>' +
        '<span class="n" style="width:' + pct(d.no) + '%"></span>' +
        '<span class="a" style="width:' + pct(d.abstain) + '%"></span>'
      : '';
    var counts = total
      ? '<span><i class="y"></i>Yes ' + d.yes + '</span>' +
        '<span><i class="n"></i>No ' + d.no + '</span>' +
        '<span><i class="a"></i>Abstain ' + d.abstain + '</span>'
      : '<span>No votes yet</span>';
    return '<div class="bar">' + bar + '</div><div class="tally">' + counts + '</div>';
  }

  function byline(d) {
    return 'Posted by ' + (d.is_mine ? 'you' : esc(d.author_name)) + ' · ' + timeAgo(d.created_at) +
      (d.status === 'closed' ? ' · Closed' : '');
  }

  function cardHtml(d) {
    var voteButtons = '<div class="votes">' +
      ['yes', 'no', 'abstain'].map(function (c) {
        var label = c === 'yes' ? 'Yes' : c === 'no' ? 'No' : 'Abstain';
        return '<button class="btn-secondary" data-action="vote" data-id="' + d.id +
          '" data-choice="' + c + '">' + label + '</button>';
      }).join('') + '</div>';
    var foot;
    if (d.status === 'open') {
      foot = '<div class="foot">' + voteButtons +
        '<span class="meta">' + COMMENT_SVG + d.comment_count + '</span></div>';
    } else {
      foot = '<div class="foot"><span class="small">' + esc(resultLine(d)) + '</span>' +
        '<span class="meta">' + COMMENT_SVG + d.comment_count + '</span></div>';
    }
    return '<div class="card" data-decision="' + d.id + '" data-action="open" data-id="' + d.id + '" style="cursor:pointer">' +
      '<div class="q">' + esc(d.question) + '</div>' +
      '<div class="small" style="margin-top:4px">' + byline(d) + '</div>' +
      tallyHtml(d) +
      foot +
      '</div>';
  }

  function resultLine(d) {
    if (d.result === 'passed') return 'Passed ' + d.yes + ' to ' + d.no;
    if (d.result === 'not_passed') return 'Not passed ' + d.yes + ' to ' + d.no;
    return 'Tied ' + d.yes + ' to ' + d.no + ', not passed';
  }

  function leadsLine(d) {
    var total = d.yes + d.no + d.abstain;
    var lead;
    if (!total) lead = 'No votes yet';
    else if (d.yes > d.no) lead = 'Yes leads ' + d.yes + ' to ' + d.no;
    else if (d.no > d.yes) lead = 'No leads ' + d.no + ' to ' + d.yes;
    else lead = 'Tied ' + d.yes + ' to ' + d.no;
    var own = d.my_vote ? ' You voted ' + (d.my_vote === 'yes' ? 'Yes' : d.my_vote === 'no' ? 'No' : 'Abstain') + '.' : '';
    return lead + '.' + own;
  }

  // ── Screen 2: one decision ───────────────────────────────────────────────
  function renderDetail() {
    var d = detail && detail.decision;
    var body;
    if (detailError) {
      body = '<div class="app"><div class="nav"><button class="ghost" style="color:rgb(var(--fg));font-size:16px" data-action="back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Decisions</button></div>' +
        '<div class="state-error"><div class="q" style="font-size:18px;line-height:26px">Couldn\'t load this decision.</div>' +
        '<div class="small">Loading failed, so nothing here has changed: your votes are safe.</div>' +
        '<button class="btn-primary" data-action="retry">Retry</button></div></div>';
    } else if (!d) {
      body = '<div class="app"><div class="nav"><button class="ghost" style="color:rgb(var(--fg));font-size:16px" data-action="back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Decisions</button></div>' +
        skeletonCards(1) +
        '<div class="skeleton" style="height:16px;width:30%;margin:24px 4px 8px"></div>' +
        '<div class="skeleton" style="height:64px;border-radius:12px"></div></div>';
    } else {
      var isMine = d.is_mine;
      var navRight = isMine
        ? '<button class="ghost" data-action="delete-decision" data-id="' + d.id + '">' + TRASH_SVG + 'Delete</button>'
        : '<button class="ghost" data-action="report" data-kind="decision" data-id="' + d.id + '">' + FLAG_SVG + 'Report</button>';
      var voteRow = d.status === 'open'
        ? '<div class="votes">' + ['yes', 'no', 'abstain'].map(function (c) {
            var label = c === 'yes' ? 'Yes' : c === 'no' ? 'No' : 'Abstain';
            return '<button class="btn-secondary' + (d.my_vote === c ? ' mine' : '') +
              '" data-action="vote" data-id="' + d.id + '" data-choice="' + c + '">' + label + '</button>';
          }).join('') + '</div>' +
          (isMine
            ? '<div class="row"><span class="small">Closed votes stay closed.</span>' +
              '<button class="btn-secondary" data-action="close" data-id="' + d.id + '">Close vote</button></div>'
            : '')
        : '<div class="small" style="margin-top:8px">Closed votes stay closed.</div>';

      var commentRows = detail.comments.map(function (c) {
        var act = c.is_mine
          ? '<button class="ghost" data-action="delete-comment" data-id="' + c.id + '">' + TRASH_SVG + 'Delete</button>'
          : '<button class="ghost" data-action="report" data-kind="comment" data-id="' + c.id + '">' + FLAG_SVG + 'Report</button>';
        return '<div class="list-row"><div class="who"><b>' +
          (c.is_mine ? 'You' : esc(c.author_name)) + '</b><span class="small">' + timeAgo(c.created_at) +
          '</span></div><p>' + esc(c.body) + '</p><div class="act">' + act + '</div></div>';
      }).join('');

      var commentList = detail.comments.length
        ? '<div class="list">' + commentRows + '</div>'
        : '<div class="state-empty" style="border:1px dashed rgb(var(--line));border-radius:12px">' +
          '<div class="small">No comments yet. Say what you think below.</div></div>';

      body = '<div class="app">' +
        '<div class="nav"><button class="ghost" style="color:rgb(var(--fg));font-size:16px" data-action="back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Decisions</button>' +
        navRight + '</div>' +
        (message ? '<div class="small" role="status" style="padding:0 4px 8px;color:rgb(var(--accent))">' + esc(message) + '</div>' : '') +
        '<div class="card">' +
        '<div class="q">' + esc(d.question) + '</div>' +
        '<div class="small" style="margin-top:6px">' + byline(d) + '</div>' +
        (d.details ? '<p class="body">' + esc(d.details) + '</p>' : '') +
        tallyHtml(d) +
        '<div class="small" style="margin-top:6px">' + (d.status === 'open' ? esc(leadsLine(d)) : esc(resultLine(d))) + '</div>' +
        voteRow +
        '</div>' +
        '<div class="section-label">Comments · ' + detail.comments.length + '</div>' +
        commentList +
        '<div class="compose"><label class="lab" for="compose-body">Add a comment</label>' +
        '<textarea id="compose-body" class="field" maxlength="1000" placeholder="e.g. I can pick them up on Saturday"></textarea>' +
        '<button class="btn-primary" data-action="post-comment" data-id="' + d.id + '">Post comment</button></div>' +
        '</div>';
    }
    $app.innerHTML = '<div data-spec-screen="2">' + body + '</div>';
  }

  // ── Screen 3: post a decision (the kit's own look) ───────────────────────
  function renderNew() {
    $app.innerHTML =
      '<div data-spec-screen><main class="page-column" style="padding:28px 16px 40px;max-width:390px;margin-inline:auto">' +
      '<button class="ghost" style="color:rgb(var(--fg));font-size:16px" data-action="back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>Decisions</button>' +
      '<div class="top" style="padding-left:0;padding-right:0"><div class="title">New decision</div>' +
      '<div class="small">One question for the club to vote on.</div></div>' +
      (message ? '<div class="small" role="status" style="padding:0 0 8px;color:rgb(var(--danger))">' + esc(message) + '</div>' : '') +
      '<label class="section-label" for="new-question" style="padding-left:0">Question</label>' +
      '<input id="new-question" class="field" maxlength="200" placeholder="e.g. Should we meet at the library?">' +
      '<label class="section-label" for="new-details" style="padding:16px 0 8px">Details (optional)</label>' +
      '<textarea id="new-details" class="field" maxlength="2000" style="min-height:88px" placeholder="e.g. Anything the club should know before voting"></textarea>' +
      '<button class="btn-primary" data-action="post-decision" style="margin-top:16px;width:100%">Post decision</button>' +
      '</main></div>';
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  // Votes are optimistic: the tally moves at once, the request follows, and a
  // failure puts the numbers back and says so. Clicking your own choice takes
  // the vote back, which the server reads as a null choice.
  var votePending = {};
  function vote(id, choice) {
    if (votePending[id]) return;
    var snapshot = route.view === 'detail' && detail ? JSON.stringify(detail) : null;
    var d = findDecision(id);
    var send;
    if (d) {
      var prev = d.my_vote;
      send = prev === choice ? null : choice;
      if (prev === 'yes') d.yes--;
      if (prev === 'no') d.no--;
      if (prev === 'abstain') d.abstain--;
      if (send === 'yes') d.yes++;
      if (send === 'no') d.no++;
      if (send === 'abstain') d.abstain++;
      d.my_vote = send;
      render();
    } else {
      send = choice;
    }
    votePending[id] = true;
    api('/api/decisions/' + id + '/vote', { method: 'PUT', body: { choice: send } })
      .then(function (tally) {
        delete votePending[id];
        if (d) {
          d.my_vote = tally.my_vote;
          d.yes = tally.yes; d.no = tally.no; d.abstain = tally.abstain;
        }
        render();
      })
      .catch(function (err) {
        delete votePending[id];
        if (snapshot) detail = JSON.parse(snapshot);   // put the numbers back
        if (route.view === 'list' && list) loadList().then(render);
        message = err.status === 409
          ? 'That vote just closed, so your click was not counted. Your other votes are safe.'
          : 'Your vote did not save: ' + err.message + ' Nothing was changed, and your other votes are safe.';
        render();
      });
  }

  function findDecision(id) {
    if (route.view === 'detail') return detail && detail.decision && String(detail.decision.id) === String(id) ? detail.decision : null;
    var hit = null;
    if (list) list.decisions.forEach(function (d) { if (String(d.id) === String(id)) hit = d; });
    return hit;
  }

  function postComment(id) {
    var box = document.getElementById('compose-body');
    var body = box ? box.value.trim() : '';
    if (!body) { message = 'Write a comment first.'; render(); return; }
    api('/api/decisions/' + id + '/comments', { method: 'POST', body: { body: body } })
      .then(function () {
        // Empty the box before the re-render: the render wrapper copies the
        // textarea's current value back into composeKeep, so an unemptied box
        // would keep showing the comment that just posted.
        var b = document.getElementById('compose-body');
        if (b) b.value = '';
        composeKeep = '';
        return loadDetail(id);
      })
      .then(function () { message = ''; render(); })
      .catch(function (err) {
        message = 'Your comment did not save: ' + err.message + ' It is still in the box, so you can try again.';
        render();
        box = document.getElementById('compose-body');
        if (box) box.value = body;
      });
  }

  function postDecision() {
    var q = (document.getElementById('new-question') || {}).value || '';
    var det = (document.getElementById('new-details') || {}).value || '';
    q = q.trim();
    det = det.trim();
    if (!q) { message = 'Write the question first.'; render(); return; }
    if (q.length > 200) { message = 'The question is over 200 characters. Shorten it a little.'; render(); return; }
    if (det.length > 2000) { message = 'The details are over 2000 characters. Shorten them a little.'; render(); return; }
    api('/api/decisions', { method: 'POST', body: { question: q, details: det || undefined } })
      .then(function (out) {
        list = null;                        // the list has a new card waiting
        location.hash = '#/d/' + out.id;
      })
      .catch(function (err) {
        message = 'It did not post: ' + err.message + ' Your text is still in the fields.';
        render();
      });
  }

  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');
    var id = el.getAttribute('data-id');
    if (el.tagName === 'A' && action !== 'vote') return; // card links navigate

    if (action === 'open') {
      location.hash = '#/d/' + id;
    } else if (action === 'tab') {
      listTab = el.getAttribute('data-tab');
      message = '';
      render();
    } else if (action === 'new') {
      location.hash = '#/new';
    } else if (action === 'back') {
      location.hash = '#/';
    } else if (action === 'retry') {
      message = '';
      if (route.view === 'detail') { detail = null; loadDetail(route.id).then(render); }
      else { list = null; loadList().then(render); render(); }
    } else if (action === 'vote') {
      ev.preventDefault();
      vote(id, el.getAttribute('data-choice'));
    } else if (action === 'close') {
      if (confirm('Close this vote? Closed votes stay closed.')) {
        api('/api/decisions/' + id + '/close', { method: 'POST' })
          .then(function () { return loadDetail(id); })
          .then(function () { message = ''; render(); })
          .catch(function (err) {
            message = 'It did not close: ' + err.message + ' The vote is still open and your counts are safe.';
            render();
          });
      }
    } else if (action === 'delete-decision') {
      if (confirm('Delete this decision, its votes and its comments?')) {
        api('/api/decisions/' + id, { method: 'DELETE' })
          .then(function () { list = null; location.hash = '#/'; })
          .catch(function (err) {
            message = 'It did not delete: ' + err.message;
            render();
          });
      }
    } else if (action === 'delete-comment') {
      if (confirm('Delete this comment?')) {
        api('/api/comments/' + id, { method: 'DELETE' })
          .then(function () { return loadDetail(route.id); })
          .then(function () { message = ''; render(); })
          .catch(function (err) {
            message = 'It did not delete: ' + err.message;
            render();
          });
      }
    } else if (action === 'report') {
      api('/api/reports', { method: 'POST', body: { kind: el.getAttribute('data-kind'), id: Number(id) } })
        .then(function () {
          message = 'Reported. Someone keeping the club safe can look at it.';
          render();
        })
        .catch(function (err) {
          message = err.status === 400 ? 'You cannot report your own post.' :
            'It did not report: ' + err.message + ' You can try again.';
          render();
        });
    } else if (action === 'post-comment') {
      postComment(id);
    } else if (action === 'post-decision') {
      postDecision();
    }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    if (ev.target.id === 'new-question' || ev.target.id === 'new-details') {
      if (ev.target.id === 'new-details' && !ev.ctrlKey && !ev.metaKey) return;
      postDecision();
    } else if (ev.target.id === 'compose-body' && ev.ctrlKey) {
      postComment(route.id);
    }
  });

  // Typing in the compose box must survive a re-render (a vote elsewhere on
  // the screen re-renders everything).
  var composeKeep = '';
  $app.addEventListener('input', function (ev) {
    if (ev.target.id === 'compose-body') composeKeep = ev.target.value;
  });
  var innerRender = render;
  render = function () {
    var box = document.getElementById('compose-body');
    if (box && detail) composeKeep = box.value;
    innerRender();
    var fresh = document.getElementById('compose-body');
    if (fresh && composeKeep) fresh.value = composeKeep;
  };

  // Move to a route: draw the loading shape at once, then fill it when the
  // data lands. A list or detail already in memory is shown straight away.
  function go(next) {
    route = next;
    message = '';
    composeKeep = '';
    if (next.view === 'detail') {
      if (!detail || String(detail.decision.id) !== String(next.id)) {
        detail = null;
        render();
        loadDetail(next.id).then(render);
        return;
      }
    } else {
      detail = null;
      if (next.view === 'list') {
        // A cached list is shown straight away, then refreshed in the
        // background: a vote or a close on a detail screen has moved the
        // tallies and the Open/Closed counts since it was drawn.
        render();
        if (!listError) loadList().then(render);
        return;
      }
    }
    render();
  }

  window.addEventListener('hashchange', function () {
    go(parseRoute());
  });

  go(parseRoute());
})();
