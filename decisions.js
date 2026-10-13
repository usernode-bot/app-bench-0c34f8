'use strict';

// Club Votes' data and API: decisions, one vote per person (Agree, Disagree
// or Abstain), comments and reports. Mounted from server.js behind the auth
// middleware; tables are created idempotently on boot.
//
// Names are stored at write time from the platform token and shown on
// purpose: who voted what is part of a club decision. decision_reports is
// private (no foreign keys point at it, COMMENT says staging:private).

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

module.exports = { mount };

function mount(app, pool) {
  const q = (text, params) => pool.query(text, params);
  const bad = (res, code, error) => res.status(code).json({ error });
  const wrap = (fn) => (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.warn('decisions: ' + err.message);
      bad(res, 500, 'Something went wrong on our side. Try again in a moment.');
    });
  };

  // SQL that keeps reported content out of every answer: a row the viewer
  // reported is gone for them, and one reported by three different people is
  // gone for everyone. $1 is the viewer id (null for a guest), $2 the demo flag.
  const DECISION_WHERE = `
    (NOT d.demo OR $2::boolean)
    AND NOT EXISTS (SELECT 1 FROM decision_reports r WHERE r.kind = 'decision'
      AND r.target_id = d.id AND r.reporter_id = $1::int)
    AND (SELECT count(DISTINCT r.reporter_id) FROM decision_reports r
      WHERE r.kind = 'decision' AND r.target_id = d.id) < 3`;
  const COMMENT_WHERE = `
    NOT EXISTS (SELECT 1 FROM decision_reports r WHERE r.kind = 'comment'
      AND r.target_id = c.id AND r.reporter_id = $1::int)
    AND (SELECT count(DISTINCT r.reporter_id) FROM decision_reports r
      WHERE r.kind = 'comment' AND r.target_id = c.id) < 3`;

  const DECISION_SELECT = `
    SELECT d.id, d.title, d.body, d.author_id, d.author_name, d.created_at,
      d.decided_at, d.outcome,
      (SELECT count(*) FROM decision_comments c WHERE c.decision_id = d.id AND ${COMMENT_WHERE}) AS comment_count,
      (SELECT count(*) FROM decision_votes v WHERE v.decision_id = d.id AND v.choice = 'agree') AS agree_count,
      (SELECT count(*) FROM decision_votes v WHERE v.decision_id = d.id AND v.choice = 'disagree') AS disagree_count,
      (SELECT count(*) FROM decision_votes v WHERE v.decision_id = d.id AND v.choice = 'abstain') AS abstain_count,
      (SELECT v.choice FROM decision_votes v WHERE v.decision_id = d.id AND v.user_id = $1::int) AS mine
    FROM decisions d
    WHERE ${DECISION_WHERE}`;

  function decisionJSON(row, meId) {
    return {
      id: row.id,
      title: row.title,
      body: row.body || '',
      author: row.author_name,
      byMe: meId != null && row.author_id === meId,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
      outcome: row.outcome || null,
      commentCount: Number(row.comment_count) || 0,
      tally: {
        agree: Number(row.agree_count) || 0,
        disagree: Number(row.disagree_count) || 0,
        abstain: Number(row.abstain_count) || 0,
      },
      mine: row.mine || null,
    };
  }

  function commentJSON(row, meId) {
    return {
      id: row.id,
      author: row.author_name || 'Someone',
      body: row.body,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      byMe: meId != null && row.author_id === meId,
    };
  }

  const voterName = (v, meId) => (meId != null && v.user_id === meId ? 'You' : v.user_name);

  async function loadDecision(id, req) {
    const meId = req.user ? req.user.id : null;
    const r = await q(`${DECISION_SELECT} AND d.id = $3`, [meId, req.demoMode === true, id]);
    return r.rows[0] || null;
  }

  async function loadVoters(id, meId) {
    const r = await q(
      `SELECT user_id, user_name, choice FROM decision_votes WHERE decision_id = $1
       ORDER BY created_at ASC NULLS LAST, user_name ASC`,
      [id]);
    return r.rows.map((v) => ({ name: voterName(v, meId), choice: v.choice, byMe: meId != null && v.user_id === meId }));
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  const gate = (req, res, next) => {
    req.demoMode = IS_STAGING && req.query.demo === '1';
    if (!req.demoMode) return next();
    seedDemo(req).then(() => next(), (err) => { console.warn('demo seed failed: ' + err.message); next(); });
  };

  // Writes need a real account. server.js has already refused guests and
  // tokenless requests; this guards the app itself against anything that
  // reaches it with a req.user but no id.
  const needAccount = (req, res, next) => {
    if (!req.user || req.user.id == null) return res.status(401).json({ error: 'account_required' });
    next();
  };

  app.get('/api/decisions', gate, wrap(async (req, res) => {
    const meId = req.user ? req.user.id : null;
    const r = await q(`${DECISION_SELECT}
      ORDER BY (d.decided_at IS NULL) DESC,
        CASE WHEN d.decided_at IS NULL THEN d.created_at END DESC,
        d.decided_at DESC
      LIMIT 200`, [meId, req.demoMode === true]);
    res.json({
      me: req.user ? { id: req.user.id, username: req.user.username } : null,
      decisions: r.rows.map((row) => decisionJSON(row, meId)),
      demo: req.demoMode === true,
    });
  }));

  app.post('/api/decisions', gate, needAccount, wrap(async (req, res) => {
    const me = req.user;
    const body = req.body || {};
    const title = String(body.title == null ? '' : body.title).replace(/[\r\n]+/g, ' ').trim();
    const details = String(body.body == null ? '' : body.body).trim();
    if (!title) return bad(res, 400, 'Add a title.');
    if (title.length > 120) return bad(res, 400, 'Keep the title under 120 characters.');
    if (details.length > 2000) return bad(res, 400, 'Keep the details under 2000 characters.');
    const r = await q(
      `INSERT INTO decisions (title, body, author_id, author_name, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [title, details, me.id, me.username, req.now]);
    res.status(201).json({ decision: decisionJSON(r.rows[0], me.id) });
  }));

  app.get('/api/decisions/:id', gate, wrap(async (req, res) => {
    const meId = req.user ? req.user.id : null;
    const row = await loadDecision(Number(req.params.id), req);
    if (!row) return bad(res, 404, 'This decision was removed, or the link is wrong.');
    const comments = await q(
      `SELECT c.id, c.author_id, c.author_name, c.body, c.created_at
       FROM decision_comments c WHERE c.decision_id = $2 AND ${COMMENT_WHERE}
       ORDER BY c.created_at ASC, c.id ASC`,
      // COMMENT_WHERE's $1 is the viewer; the decision id rides as $2.
      [meId, row.id]);
    res.json({
      me: req.user ? { id: req.user.id, username: req.user.username } : null,
      decision: decisionJSON(row, meId),
      voters: await loadVoters(row.id, meId),
      comments: comments.rows.map((c) => commentJSON(c, meId)),
      demo: req.demoMode === true,
    });
  }));

  app.post('/api/decisions/:id/vote', gate, needAccount, wrap(async (req, res) => {
    const me = req.user;
    const choice = req.body ? req.body.choice : undefined;
    if (choice !== null && !['agree', 'disagree', 'abstain'].includes(choice)) {
      return bad(res, 400, 'Pick Agree, Disagree or Abstain.');
    }
    const row = await loadDecision(Number(req.params.id), req);
    if (!row) return bad(res, 404, 'This decision was removed, or the link is wrong.');
    if (row.decided_at) return bad(res, 409, 'Voting on this has closed.');
    if (choice === null) {
      await q('DELETE FROM decision_votes WHERE decision_id = $1 AND user_id = $2', [row.id, me.id]);
    } else {
      await q(
        `INSERT INTO decision_votes (decision_id, user_id, user_name, choice, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (decision_id, user_id)
         DO UPDATE SET choice = EXCLUDED.choice, user_name = EXCLUDED.user_name, created_at = EXCLUDED.created_at`,
        [row.id, me.id, me.username, choice, req.now]);
    }
    const fresh = await loadDecision(row.id, req);
    res.json({ decision: decisionJSON(fresh, me.id), voters: await loadVoters(row.id, me.id) });
  }));

  app.post('/api/decisions/:id/decide', gate, needAccount, wrap(async (req, res) => {
    const me = req.user;
    const row = await loadDecision(Number(req.params.id), req);
    if (!row) return bad(res, 404, 'This decision was removed, or the link is wrong.');
    if (row.author_id !== me.id) return bad(res, 403, 'Only the person who posted this can mark it decided.');
    if (row.decided_at) return bad(res, 409, 'This has already been decided.');
    const counts = await q(
      `SELECT choice, count(*) AS n FROM decision_votes WHERE decision_id = $1 GROUP BY choice`,
      [row.id]);
    const n = (choice) => Number((counts.rows.find((r) => r.choice === choice) || {}).n) || 0;
    const agree = n('agree');
    const disagree = n('disagree');
    const abstain = n('abstain');
    const outcome = agree + disagree + abstain === 0 ? 'no_votes'
      : agree > disagree ? 'agreed'
      : disagree > agree ? 'turned_down'
      : 'tied';
    // The WHERE guards the race with a double tap or a close at the same
    // moment as a vote: only the first close wins.
    const r = await q(
      `UPDATE decisions SET decided_at = $2, outcome = $3
       WHERE id = $1 AND decided_at IS NULL RETURNING *`,
      [row.id, req.now, outcome]);
    if (!r.rows.length) return bad(res, 409, 'Voting on this has closed.');
    // RETURNING * lacks the tally, comment and mine columns: refetch the
    // full row so the response can fill a list row in place.
    res.json({ decision: decisionJSON(await loadDecision(row.id, req), me.id) });
  }));

  app.post('/api/decisions/:id/comments', gate, needAccount, wrap(async (req, res) => {
    const me = req.user;
    const raw = req.body && req.body.body != null ? String(req.body.body) : '';
    const text = raw.trim();
    if (!text) return bad(res, 400, 'Write something first.');
    if (text.length > 1000) return bad(res, 400, 'Keep the comment under 1000 characters.');
    const row = await loadDecision(Number(req.params.id), req);
    if (!row) return bad(res, 404, 'This decision was removed, or the link is wrong.');
    const r = await q(
      `INSERT INTO decision_comments (decision_id, author_id, author_name, body, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, author_id, author_name, body, created_at`,
      [row.id, me.id, me.username, text, req.now]);
    res.status(201).json({ comment: commentJSON(r.rows[0], me.id) });
  }));

  app.post('/api/reports', needAccount, wrap(async (req, res) => {
    const me = req.user;
    const kind = req.body ? req.body.kind : null;
    const id = Number(req.body && req.body.id);
    if (!['decision', 'comment'].includes(kind) || !Number.isInteger(id) || id <= 0) {
      return bad(res, 400, 'That report could not be sent.');
    }
    if (kind === 'decision') {
      const r = await q('SELECT author_id FROM decisions WHERE id = $1', [id]);
      if (!r.rows.length) return bad(res, 404, 'That decision is not here.');
      if (r.rows[0].author_id === me.id) return bad(res, 400, "You can't report your own decision.");
    } else {
      const r = await q('SELECT author_id FROM decision_comments WHERE id = $1', [id]);
      if (!r.rows.length) return bad(res, 404, 'That comment is not here.');
      if (r.rows[0].author_id === me.id) return bad(res, 400, "You can't report your own comment.");
    }
    await q(
      `INSERT INTO decision_reports (kind, target_id, reporter_id, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [kind, id, me.id, req.now]);
    res.json({ ok: true });
  }));

  app.delete('/api/decisions/:id', gate, needAccount, wrap(async (req, res) => {
    const me = req.user;
    const row = await loadDecision(Number(req.params.id), req);
    if (!row) return bad(res, 404, 'This decision was removed, or the link is wrong.');
    if (row.author_id !== me.id) return bad(res, 403, 'Only the person who posted this can delete it.');
    await q('DELETE FROM decisions WHERE id = $1', [row.id]);
    res.json({ ok: true });
  }));

  // ── Staging demo (?demo=1 on staging only) ────────────────────────────────
  // Five fixed made-up rows shared by every viewer, then, once per viewer,
  // their own "Spring outing" decision, votes and comment, and their votes on
  // two of the fixed rows. Nothing is written without ?demo=1, and nothing at
  // all outside staging; a reload changes nothing.

  let peoplePromise = null;
  const demoPeople = async () => {
    if (!peoplePromise) peoplePromise = import('./public/kit/demo.js').then((m) => m.DEMO_PEOPLE);
    return peoplePromise;
  };

  const FIXED = [
    {
      id: 900001, author: 'Chioma', ago: 2 * HOUR, decidedAgo: null,
      title: 'Move Thursday meetups to the library annex',
      body: 'The café we meet in has been standing room only. The library annex is free on Thursdays until 9, seats 20, and there is parking behind.',
      agree: ['Ana', 'Dev', 'Hana', 'Ivo', 'Lucia'], disagree: ['Gus', 'Kemal'], abstain: ['Jules'],
      comments: [
        ['Gus', 'Good idea, the café has been standing room only lately.'],
        ['Ana', 'Does the annex have a whiteboard? We use one most weeks.'],
        ['Chioma', 'It does, and there are sockets by the back tables.'],
        ['Kemal', 'Parking behind is much easier for me than the multi-storey.'],
        ['Lucia', 'Thursdays still work for me either way.'],
        ['Dev', 'Happy with whichever, the tea is on me next time.'],
      ],
    },
    {
      id: 900003, author: 'Ben', ago: 2 * DAY, decidedAgo: null,
      title: 'Raise yearly dues from 20 to 25',
      body: "The treasurer's numbers are pinned in the chat. The extra 5 keeps us level through next year.",
      agree: ['Chioma', 'Hana'], disagree: ['Dev', 'Gus', 'Ivo', 'Kemal', 'Lucia'], abstain: ['Elif', 'Jules'],
      comments: [
        ['Chioma', 'Twenty has covered us so far, what is the extra five for?'],
        ['Ben', 'The hall deposit went up in September, and we replaced two board games.'],
        ['Hana', 'I would rather pay five more than cancel a meetup.'],
        ['Gus', 'Could we do 22 and keep a small buffer instead?'],
        ['Ben', 'The treasurer worked it out, 25 keeps us level through next year.'],
        ['Ivo', 'Fine by me, it is still less than a cinema ticket a month.'],
        ['Kemal', 'Agreed, as long as it stays flat after that.'],
        ['Lucia', 'Can we put the breakdown in the newsletter first?'],
        ['Elif', 'Abstaining this one, I am away most of next term.'],
      ],
    },
    {
      id: 900004, author: 'Elif', ago: 3 * DAY, decidedAgo: null,
      title: 'Start a shared snack rota for meetups',
      body: 'A simple list of who brings what to each meetup. Add your name to a week and swap when you need to.',
      agree: [], disagree: [], abstain: [],
      comments: [
        ['Dev', 'I will take the first week, biscuits are my speciality.'],
      ],
    },
    {
      id: 900005, author: 'Hana', ago: 9 * DAY, decidedAgo: 5 * DAY, outcome: 'agreed',
      title: 'Pick the new club logo from the sketch contest',
      body: 'Three entries made it to the shortlist. Pick the one the club should use on badges, banners and the newsletter.',
      agree: ['Ana', 'Ben', 'Chioma', 'Dev', 'Elif', 'Farah', 'Ivo', 'Lucia'], disagree: ['Gus'], abstain: ['Kemal'],
      comments: [
        ['Ana', 'Entry 3 is my favourite, the letters stay readable small.'],
        ['Chioma', 'Entry 3 for me too, it looks good on a badge.'],
        ['Gus', 'I liked entry 1, but happy to go with the room.'],
        ['Hana', 'We can use entry 1 on the stickers either way.'],
        ['Farah', 'Entry 3, it prints well in one colour.'],
        ['Ivo', 'Glad that is settled, the banner can go to the printers.'],
      ],
    },
    {
      id: 900006, author: 'Ivo', ago: 21 * DAY, decidedAgo: 14 * DAY, outcome: 'turned_down',
      title: 'Switch the monthly quiz night to Fridays',
      body: 'Same hall, same time, one evening later. Fridays have the room free until later, but it costs a little more.',
      agree: ['Ana', 'Farah', 'Jules'], disagree: ['Ben', 'Chioma', 'Dev', 'Elif', 'Gus', 'Hana', 'Kemal'], abstain: [],
      comments: [
        ['Ben', 'Fridays are hard for me, I run the late shift.'],
        ['Chioma', 'Same, and the hall costs more on Fridays.'],
        ['Ana', 'Thursdays suit most of us, keep it as it is.'],
        ['Jules', 'One more year of Thursday quizzes then.'],
      ],
    },
  ];

  const VIEWER_ROW = {
    id: 900002,
    ago: DAY,
    title: 'Spring outing to the botanical garden',
    body: 'Saturday 12 April, meeting at the main gate at 10. Tickets are 6 each and the café inside does a group lunch. If it rains we move it a week.',
    agree: ['Ana', 'Dev', 'Lucia'], disagree: ['Ben', 'Gus', 'Kemal'], abstain: ['Farah'],
    comments: [
      ['Ben', 'Saturday clashes with the bake sale for some of us. Could Sunday work?', 20 * HOUR],
      ['Ana', 'The garden is free before 11 on the first Saturday. Worth checking.', 18 * HOUR],
      ['me', 'Good find, Ana. If it is free I think Saturday still wins.', 15 * HOUR],
      ['Farah', 'Abstaining, I am away that week, but have fun.', 4 * HOUR],
    ],
  };

  async function seedDemo(req) {
    const P = await demoPeople();
    const byName = Object.fromEntries(P.map((p) => [p.name, p]));
    const now = req.now.getTime();
    const at = (ms) => new Date(ms);
    const seen = await q('SELECT 1 FROM decisions WHERE id = 900001');

    if (!seen.rows.length) {
      for (const row of FIXED) {
        const created = now - row.ago;
        const author = byName[row.author];
        await q(
          `INSERT INTO decisions (id, title, body, author_id, author_name, created_at, decided_at, outcome, demo)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) ON CONFLICT (id) DO NOTHING`,
          [row.id, row.title, row.body, author.id, author.name, at(created),
            row.decidedAgo != null ? at(now - row.decidedAgo) : null, row.outcome || null]);
        let k = 0;
        for (const choice of ['agree', 'disagree', 'abstain']) {
          for (const name of row[choice]) {
            const voter = byName[name];
            await q(
              `INSERT INTO decision_votes (decision_id, user_id, user_name, choice, created_at)
               VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
              [row.id, voter.id, voter.name, choice, at(created + (12 + 18 * k++) * 60 * 1000)]);
          }
        }
        for (let i = 0; i < row.comments.length; i += 1) {
          const [name, text] = row.comments[i];
          const who = byName[name];
          await q(
            `INSERT INTO decision_comments (decision_id, author_id, author_name, body, created_at, demo)
             VALUES ($1, $2, $3, $4, $5, true)`,
            [row.id, who.id, who.name, text, at(created + (25 + 40 * i) * 60 * 1000)]);
        }
      }
    }

    if (!req.user) return;
    // Once per viewer: their own demo rows, keyed in decision_demo_viewers.
    const first = await q(
      'INSERT INTO decision_demo_viewers (user_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING user_id',
      [req.user.id]);
    if (!first.rows.length) return;

    const me = { id: req.user.id, name: req.user.username };
    const created = now - VIEWER_ROW.ago;
    await q(
      `INSERT INTO decisions (id, title, body, author_id, author_name, created_at, decided_at, outcome, demo)
       VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, true) ON CONFLICT (id) DO NOTHING`,
      [VIEWER_ROW.id, VIEWER_ROW.title, VIEWER_ROW.body, me.id, me.name, at(created)]);
    let k = 0;
    await q(
      `INSERT INTO decision_votes (decision_id, user_id, user_name, choice, created_at)
       VALUES ($1, $2, $3, 'agree', $4) ON CONFLICT DO NOTHING`,
      [VIEWER_ROW.id, me.id, me.name, at(created + (60 + 18 * k++) * 60 * 1000)]);
    for (const choice of ['agree', 'disagree', 'abstain']) {
      for (const name of VIEWER_ROW[choice]) {
        const voter = byName[name];
        await q(
          `INSERT INTO decision_votes (decision_id, user_id, user_name, choice, created_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
          [VIEWER_ROW.id, voter.id, voter.name, choice, at(created + (60 + 18 * k++) * 60 * 1000)]);
      }
    }
    for (const [who, text, ago] of VIEWER_ROW.comments) {
      const isMe = who === 'me';
      await q(
        `INSERT INTO decision_comments (decision_id, author_id, author_name, body, created_at, demo)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [VIEWER_ROW.id, isMe ? me.id : byName[who].id, isMe ? me.name : who, text, at(now - ago)]);
    }
    // The viewer's own votes on two of the fixed rows, once.
    await q(
      `INSERT INTO decision_votes (decision_id, user_id, user_name, choice, created_at)
       VALUES (900003, $1, $2, 'disagree', $3) ON CONFLICT DO NOTHING`,
      [me.id, me.name, at(now - 20 * HOUR)]);
    await q(
      `INSERT INTO decision_votes (decision_id, user_id, user_name, choice, created_at)
       VALUES (900005, $1, $2, 'agree', $3) ON CONFLICT DO NOTHING`,
      [me.id, me.name, at(now - 6 * DAY)]);
  }

  return { migrate };

  async function migrate() {
    await q(`CREATE TABLE IF NOT EXISTS decisions (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      author_id INT NOT NULL,
      author_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      decided_at TIMESTAMPTZ,
      outcome TEXT,
      demo BOOLEAN NOT NULL DEFAULT false
    )`);
    await q(`CREATE TABLE IF NOT EXISTS decision_votes (
      decision_id INT NOT NULL REFERENCES decisions ON DELETE CASCADE,
      user_id INT,
      user_name TEXT NOT NULL,
      choice TEXT NOT NULL CHECK (choice IN ('agree', 'disagree', 'abstain')),
      created_at TIMESTAMPTZ,
      PRIMARY KEY (decision_id, user_id)
    )`);
    await q(`CREATE TABLE IF NOT EXISTS decision_comments (
      id SERIAL PRIMARY KEY,
      decision_id INT NOT NULL REFERENCES decisions ON DELETE CASCADE,
      author_id INT,
      author_name TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ,
      demo BOOLEAN NOT NULL DEFAULT false
    )`);
    await q(`CREATE INDEX IF NOT EXISTS decision_comments_decision_idx ON decision_comments (decision_id, created_at)`);
    await q(`CREATE TABLE IF NOT EXISTS decision_reports (
      id SERIAL PRIMARY KEY,
      kind TEXT CHECK (kind IN ('decision', 'comment')),
      target_id INT,
      reporter_id INT,
      created_at TIMESTAMPTZ,
      UNIQUE (kind, target_id, reporter_id)
    )`);
    await q(`CREATE TABLE IF NOT EXISTS decision_demo_viewers (user_id INT PRIMARY KEY)`);
    await q(`COMMENT ON TABLE decision_reports IS 'staging:private'`);
  }
}