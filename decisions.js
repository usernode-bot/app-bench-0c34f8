'use strict';
// Decisions people post, each with options to vote on (one vote per member,
// changeable or taken back), a comment thread, and closing by the poster into
// the Decided list. Same shapes and idioms as kit/server.js (that file is
// reference only; this one is mounted). Reads may come from a guest (no
// req.user), writes need req.user, "now" is req.now. Staging with ?demo=1
// only: rows from public/kit/demo.js, written once (ids from 900001,
// made-up people), plus the viewer's votes on two slips and one tied
// decision of their own, once each.
//
// The `reports` table is marked 'staging:private': what members reported
// stays between the app and the platform.

const path = require('path');
const { pathToFileURL } = require('url');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const DEMO_ID = 900001;
const GONE = 'This was removed, or the link is wrong.';
const CLOSED = 'This decision is closed.';
const loadDemo = () => import(pathToFileURL(path.join(__dirname, 'public', 'kit', 'demo.js')).href);

const line = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const text = (v, max) => (typeof v === 'string'
  ? v.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '');

const MAX = { title: 120, body: 2000, option: 60, options: 6, comment: 1000 };

module.exports = function decisions(app, pool) {
  const viewer = (req) => (req.user ? Number(req.user.id) : null);
  const idOf = (req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : null; };
  const bad = (res, status, error) => res.status(status).json({ error });
  const route = (write, fn) => async (req, res) => {
    if (write && !req.user) return bad(res, 401, 'account_required');
    try { return await fn(req, res); } catch (err) {
      console.error(err);
      return bad(res, 500, 'Something went wrong on our side. Try again in a moment.');
    }
  };

  // One decision with its counts, the viewer's choice and its comment count.
  // Hidden rows are never served; demo rows only when the read asked for them.
  const ONE = `SELECT d.*,
      COALESCE((SELECT json_object_agg(choice, n) FROM (SELECT choice, COUNT(*)::int AS n
        FROM decision_votes v WHERE v.decision_id = d.id GROUP BY choice) c), '{}') AS counts,
      (SELECT choice FROM decision_votes v WHERE v.decision_id = d.id AND v.user_id = $1::int) AS my_vote,
      (SELECT COUNT(*)::int FROM decision_comments c WHERE c.decision_id = d.id AND NOT c.hidden) AS comment_count
    FROM decisions d
    WHERE NOT d.hidden`;
  const demoOk = (req) => IS_STAGING && req.query.demo === '1';

  const decisionOut = (r, uid) => {
    const labels = Array.isArray(r.options) && r.options.length ? r.options : [];
    const outcome = r.outcome != null && r.closed_at != null ? { id: r.outcome, label: labels[r.outcome] || '' } : null;
    return {
      id: r.id, title: r.title, body: r.body, author: r.author_name,
      byMe: uid != null && r.author_id === uid, createdAt: r.created_at,
      commentCount: Number(r.comment_count) || 0, closedAt: r.closed_at, outcome,
      votes: {
        options: labels.map((label, k) => ({ id: k, label, count: Number(r.counts[k]) || 0 })),
        mine: r.my_vote ?? null,
      },
    };
  };
  const commentOut = (c, uid) => ({ id: c.id, author: c.author_name, body: c.body, createdAt: c.created_at, byMe: uid != null && c.author_id === uid });

  async function one(id, uid, req) {
    const { rows } = await pool.query(`${ONE}${where(req)} AND d.id = $2`, [uid, id]);
    return rows[0] ? decisionOut(rows[0], uid) : null;
  }
  // Demo rows are part of the app's data, just fake: shown only on staging
  // with ?demo=1, hidden otherwise (the same rule as hidden content).
  function where(req) { return demoOk(req) ? '' : ' AND NOT d.demo'; }

  async function migrate() {
    await pool.query(`CREATE TABLE IF NOT EXISTS decisions (
      id SERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', options JSONB,
      author_id INTEGER NOT NULL, author_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
      closed_at TIMESTAMPTZ, outcome INTEGER, hidden BOOLEAN NOT NULL DEFAULT FALSE, demo BOOLEAN NOT NULL DEFAULT FALSE)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS decision_votes (
      decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
      choice INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (decision_id, user_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS decision_comments (
      id SERIAL PRIMARY KEY, decision_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL, author_name TEXT NOT NULL, body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL, hidden BOOLEAN NOT NULL DEFAULT FALSE, demo BOOLEAN NOT NULL DEFAULT FALSE)`);
    await pool.query('CREATE INDEX IF NOT EXISTS decision_comments_decision_idx ON decision_comments (decision_id, created_at)');
    await pool.query(`CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY, kind TEXT NOT NULL, target_id INTEGER NOT NULL,
      reporter_id INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT report_kind CHECK (kind IN ('decision', 'comment')))`);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS reports_once_idx ON reports (kind, target_id, reporter_id)');
    await pool.query('CREATE TABLE IF NOT EXISTS decision_demo_viewers (user_id INTEGER PRIMARY KEY)');
    // What members reported is nobody's business but the platform's.
    await pool.query("COMMENT ON TABLE reports IS 'staging:private'");
  }

  async function seedDemo(req) {
    if (!(IS_STAGING && req.query.demo === '1')) return false;
    const { rows } = await pool.query('SELECT 1 FROM decisions WHERE id = $1', [DEMO_ID]);
    if (!rows.length) {
      const { demoItems } = await loadDemo();
      const rowsIn = demoItems({
        seed: 7,
        titles: [
          { title: 'Where should we meet in November?', body: 'The usual room is booked for renovations.', options: ['Library back room', 'Corner cafe', 'Community hall'] },
          { title: "Next month's activity", body: 'Pick what we do at the second meeting.', options: ['Board game night', 'Riverside walk', 'Pottery class'] },
          { title: 'Move meetings to Thursdays?', body: 'Tuesdays clash with two members now.', options: ['Yes, Thursdays', 'Keep Tuesdays'] },
          { title: 'Snack rota for November', body: 'Two names per week, one brings sweet, one savoury.', options: ['Take turns bringing', 'Club buys snacks', 'Nobody brings anything'] },
          { title: 'Day for the winter trip', body: 'The coach books out fast, so pick the day.', options: ['First Saturday', 'Second Saturday', 'Midweek'] },
          { title: 'Name for the newsletter', body: 'Going out monthly from December.', options: ['The Monthly Tally', 'Club Notes', 'The Ledger'] },
          { title: 'How long should meetings run?', body: 'We have the room until nine.', options: ['One hour', 'Ninety minutes', 'No fixed end'] },
          { title: 'Guest speakers this winter', body: 'Who could we invite to talk for ten minutes?', options: ['Yes, invite some', 'Keep it to ourselves'] },
          { title: 'Fix the shared kettle fund', body: 'It keeps coming up short by a few coins.', options: ['Round up each week', 'Top up once a term', 'Leave it'] },
          { title: 'Where to keep the voting slips', body: 'The shoebox is falling apart.', options: ['Blue folder', 'Drawer upstairs'] },
        ],
        comments: [
          'Good idea, count me in for that one.',
          'Could we split it across two weeks instead?',
          'Either works for me, I will come either way.',
          'Can we note the cost before deciding?',
          'I would rather keep it simple.',
          'Happy to help organise whichever wins.',
        ],
        now: req.now,
        firstId: DEMO_ID,
      });
      // Four of the ten are already decided, with the winner recorded.
      const decided = [
        { at: DEMO_ID + 3, winner: 0 }, { at: DEMO_ID + 5, winner: 1 },
        { at: DEMO_ID + 7, winner: 0 }, { at: DEMO_ID + 9, winner: 0 },
      ];
      const when = (row, pick) => new Date(new Date(row.createdAt).getTime() + (pick + 1) * 60 * 60000).toISOString();
      // Each table's rows in one query: `cols` names and types them, as
      // json_to_recordset reads them.
      const put = (table, cols, list) => pool.query(`INSERT INTO ${table} (${cols.replace(/ \w+(,|$)/g, '$1')})
        SELECT * FROM json_to_recordset($1::json) AS x(${cols}) ON CONFLICT DO NOTHING`, [JSON.stringify(list)]);
      await put('decisions', 'id int, title text, body text, options jsonb, author_id int, author_name text, created_at timestamptz, closed_at timestamptz, outcome int, demo bool',
        rowsIn.map((r) => {
          const done = decided.find((d) => d.at === r.id);
          return { id: r.id, title: r.title, body: r.body, options: r.options.map((o) => o.label),
            author_id: r.authorId, author_name: r.author, created_at: r.createdAt,
            closed_at: done ? when(r, done.winner) : null, outcome: done ? done.winner : null, demo: true };
        }));
      await put('decision_votes', 'decision_id int, user_id int, choice int, created_at timestamptz',
        rowsIn.flatMap((r) => r.votes.map((v) => ({ decision_id: r.id, user_id: v.userId, choice: v.optionId, created_at: v.createdAt }))));
      await put('decision_comments', 'id int, decision_id int, author_id int, author_name text, body text, created_at timestamptz, demo bool',
        rowsIn.flatMap((r) => r.comments.map((c) => ({ id: c.id, decision_id: r.id, author_id: c.authorId, author_name: c.author, body: c.body, created_at: c.createdAt, demo: true }))));
    }
    // First demo visit as a signed-in viewer: their vote on two slips, and
    // one tied decision of their own to try closing, all fake and once.
    if (req.user) {
      const first = await pool.query('INSERT INTO decision_demo_viewers (user_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING user_id', [viewer(req)]);
      if (first.rows.length) {
        const uid = viewer(req);
        await pool.query(`INSERT INTO decision_votes (decision_id, user_id, choice, created_at)
          SELECT id, $1, 0, $2 FROM decisions WHERE id IN ($3, $4) ON CONFLICT DO NOTHING`, [uid, req.now, DEMO_ID, DEMO_ID + 1]);
        // A tie the viewer posted, closeable by picking one of the leaders.
        await pool.query(`INSERT INTO decisions (title, body, options, author_id, author_name, created_at, demo)
          VALUES ($1, $2, $3::jsonb, $4, $5, $6, TRUE) RETURNING id`, [
          'Saturday workshop topic', 'One hour, we all vote on the day.',
          JSON.stringify(['Photography basics', 'Simple bookbinding']), uid, String(req.user.username || 'Someone'), req.now,
        ]);
        const mine = await pool.query(`SELECT id FROM decisions WHERE author_id = $1 AND demo AND title = $2`, [uid, 'Saturday workshop topic']);
        if (mine.rows.length) {
          const tie = mine.rows[0].id;
          const votes = [];
          DEMO_VOTERS.forEach((v, k) => votes.push({ decision_id: tie, user_id: v, choice: k % 2, created_at: req.now }));
          await pool.query(`INSERT INTO decision_votes (decision_id, user_id, choice, created_at)
            SELECT * FROM json_to_recordset($1::json) AS x(decision_id int, user_id int, choice int, created_at timestamptz)
            ON CONFLICT DO NOTHING`, [JSON.stringify(votes)]);
          await pool.query(`INSERT INTO decision_comments (decision_id, author_id, author_name, body, created_at, demo)
            VALUES ($1, $2, $3, $4, $5, TRUE)`, [tie, -3, 'Chioma', 'Both sound good, tough call.', req.now]);
        }
      }
    }
    return true;
  }

  app.get('/api/decisions', route(false, async (req, res) => {
    const demo = await seedDemo(req);
    const uid = viewer(req);
    const w = where(req);
    const { rows } = await pool.query(
      `${ONE}${w} ORDER BY d.created_at DESC, d.id DESC LIMIT 200`, [uid]);
    const all = rows.map((r) => decisionOut(r, uid));
    return res.json({
      open: all.filter((d) => !d.closedAt),
      decided: all.filter((d) => d.closedAt)
        .sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt)),
      signedIn: !!req.user, demo,
    });
  }));

  app.get('/api/decisions/:id', route(false, async (req, res) => {
    const id = idOf(req);
    const demo = await seedDemo(req);
    const decision = id && await one(id, viewer(req), req);
    if (!decision) return bad(res, 404, GONE);
    const { rows } = await pool.query(`SELECT * FROM decision_comments
      WHERE decision_id = $1 AND NOT hidden ORDER BY created_at, id LIMIT 500`, [id]);
    return res.json({ decision, comments: rows.map((c) => commentOut(c, viewer(req))), demo });
  }));

  app.post('/api/decisions', route(true, async (req, res) => {
    const b = req.body || {};
    const title = line(b.title, MAX.title);
    if (!title) return bad(res, 400, 'Add a title.');
    const seen = new Map();
    for (const o of Array.isArray(b.options) ? b.options : []) {
      const t = line(o, MAX.option);
      if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
    }
    const options = [...seen.values()];
    if (options.length < 2) return bad(res, 400, 'Give at least two different options.');
    if (options.length > MAX.options) return bad(res, 400, `Give at most ${MAX.options} options.`);
    const { rows } = await pool.query(`INSERT INTO decisions (title, body, options, author_id, author_name, created_at)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id`,
      [title, text(b.body, MAX.body), JSON.stringify(options), viewer(req), String(req.user.username || 'Someone'), req.now]);
    return res.status(201).json({ decision: await one(rows[0].id, viewer(req), req) });
  }));

  app.post('/api/decisions/:id/vote', route(true, async (req, res) => {
    const id = idOf(req);
    const decision = id && await one(id, viewer(req), req);
    if (!decision) return bad(res, 404, GONE);
    if (decision.closedAt) return bad(res, 409, CLOSED);
    const choice = (req.body || {}).option;
    if (choice === null) {
      await pool.query('DELETE FROM decision_votes WHERE decision_id = $1 AND user_id = $2', [id, viewer(req)]);
    } else if (Number.isInteger(choice) && choice >= 0 && choice < decision.votes.options.length) {
      await pool.query(`INSERT INTO decision_votes (decision_id, user_id, choice, created_at) VALUES ($1, $2, $3, $4)
        ON CONFLICT (decision_id, user_id) DO UPDATE SET choice = EXCLUDED.choice, created_at = EXCLUDED.created_at`,
        [id, viewer(req), choice, req.now]);
    } else {
      return bad(res, 400, 'Pick one of the options.');
    }
    return res.json({ decision: await one(id, viewer(req), req) });
  }));

  app.post('/api/decisions/:id/close', route(true, async (req, res) => {
    const id = idOf(req);
    const decision = id && await one(id, viewer(req), req);
    if (!decision) return bad(res, 404, GONE);
    if (!decision.byMe) {
      return bad(res, 403, 'Only the person who asked can close it.');
    }
    if (decision.closedAt) return bad(res, 409, 'This decision is already closed.');
    const total = decision.votes.options.reduce((n, o) => n + o.count, 0);
    if (!total) return bad(res, 409, 'Someone needs to vote before it can close.');
    const top = Math.max(...decision.votes.options.map((o) => o.count));
    const leaders = decision.votes.options.filter((o) => o.count === top);
    const pick = (req.body || {}).option;
    if (leaders.length > 1) {
      if (!Number.isInteger(pick) || !leaders.some((o) => o.id === pick)) {
        return bad(res, 409, 'Two choices are tied. Pick one to close with.');
      }
    }
    const outcome = leaders.length > 1 ? pick : leaders[0].id;
    await pool.query('UPDATE decisions SET closed_at = $2, outcome = $3 WHERE id = $1', [id, req.now, outcome]);
    return res.json({ decision: await one(id, viewer(req), req) });
  }));

  app.delete('/api/decisions/:id', route(true, async (req, res) => {
    const { rows } = await pool.query('DELETE FROM decisions WHERE id = $1 AND author_id = $2 RETURNING id', [idOf(req), viewer(req)]);
    if (!rows.length) return bad(res, 403, 'Only the person who posted this can delete it.');
    return res.json({ ok: true });
  }));

  app.post('/api/decisions/:id/comments', route(true, async (req, res) => {
    const id = idOf(req);
    const body = text((req.body || {}).body, MAX.comment);
    if (!body) return bad(res, 400, 'Write something first.');
    if (!id || !(await one(id, viewer(req), req))) return bad(res, 404, GONE);
    const { rows } = await pool.query(`INSERT INTO decision_comments (decision_id, author_id, author_name, body, created_at)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`, [id, viewer(req), String(req.user.username || 'Someone'), body, req.now]);
    return res.status(201).json({ comment: commentOut(rows[0], viewer(req)) });
  }));

  app.delete('/api/comments/:id', route(true, async (req, res) => {
    const id = idOf(req);
    if (!id) return bad(res, 404, GONE);
    const { rows } = await pool.query('DELETE FROM decision_comments WHERE id = $1 AND author_id = $2 RETURNING id', [id, viewer(req)]);
    if (!rows.length) return bad(res, 403, 'Only the person who wrote this can delete it.');
    return res.json({ ok: true });
  }));

  app.post('/api/reports', route(true, async (req, res) => {
    const b = req.body || {};
    const kind = b.kind === 'comment' ? 'comment' : b.kind === 'decision' ? 'decision' : null;
    const target = Number(b.id);
    if (!kind || !(Number.isInteger(target) && target > 0)) return bad(res, 400, 'Say what you are reporting.');
    const exists = kind === 'comment'
      ? await pool.query('SELECT 1 FROM decision_comments WHERE id = $1 AND NOT hidden', [target])
      : await pool.query('SELECT 1 FROM decisions WHERE id = $1 AND NOT hidden', [target]);
    if (!exists.rows.length) return bad(res, 404, GONE);
    // Reporting twice changes nothing: the first report is the one that counts.
    await pool.query(`INSERT INTO reports (kind, target_id, reporter_id, created_at) VALUES ($1, $2, $3, $4)
      ON CONFLICT (kind, target_id, reporter_id) DO NOTHING`, [kind, target, viewer(req), req.now]);
    return res.status(201).json({ ok: true });
  }));

  return { migrate };
};

// Made-up demo voters, below the real id range.
const DEMO_VOTERS = [-1, -2, -4, -5, -6, -8];
