'use strict';
// Club questions with one yes/no vote per person and a comment thread, on
// Postgres: the JSON public/app.js renders. Reads may come from a guest (no
// req.user), writes need req.user, "now" is req.now. Every read leaves out
// rows moderation has hidden (hidden_at) and rows this viewer reported.
// Reporting your own post is refused; three different reporters hide a post
// for everyone. Staging with ?demo=1 only: rows from public/kit/demo.js,
// written once (ids from 900001, made-up people), and the viewer's own
// votes, one question and one comment, once per viewer.

const path = require('path');
const { pathToFileURL } = require('url');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const DEMO_ID = 900001;
const GONE = 'This question was removed, or the link is wrong.';
const loadDemo = () => import(pathToFileURL(path.join(__dirname, 'public', 'kit', 'demo.js')).href);

const line = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const text = (v, max) => (typeof v === 'string'
  ? v.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '');

const TITLES = [
  'Move our monthly meetup to the library on Thursdays?',
  'Raise yearly dues from 10 to 15 to cover the room hire?',
  'Start a second book group on weeknights?',
  'Make the June meeting a potluck?',
  'Volunteer together at the river clean-up on 8 November?',
  'Order club t-shirts in forest green?',
  'Keep the 7pm start time for winter meetings?',
  'Invite the community garden group to our autumn meeting?',
  "Move our group chat to a members' noticeboard?",
  'Hold a quiz night for new members in January?',
  'Rotate who chairs the monthly meeting?',
  'Put a suggestions box at the library desk?',
];
const BODIES = [
  'The hall has put its rate up to 40 a month. At 10 each we fall about 60 short over the year. Raising dues covers it, with a little left for the summer outing.',
  'The library room fits 24 and the projector works. We would just need to book a fortnight ahead.',
  'The community centre quoted half that for Thursday evenings. Worth asking before we decide?',
  'Last year the potluck filled three tables. Bring a plate and the club provides the drinks.',
];
const COMMENTS = [
  'The room went up in September, so something has to give. 15 still seems fair for a whole year.',
  'Could we do 12 and pass a jar round at the summer event for the rest?',
  "I'd rather keep it at 10 and look for a cheaper room first.",
  'The community centre quoted half that for Thursday evenings. Worth asking before we decide?',
  'Works for me, evenings are easier than weekends anyway.',
  'Happy to help set up if we do it.',
  'Forest green is fine by me, as long as the print stays small.',
  'A box at the desk might fill up with flyers. Someone would need to empty it weekly.',
];

function mount(app, pool) {
  const T = 'questions';
  const V = 'questions_votes';
  const C = 'questions_comments';
  const R = 'questions_reports';
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

  // One row of `questions` as the page sees it: counts, the viewer's vote,
  // and a comment count over visible comments only. Every read leaves out
  // hidden rows and rows this viewer reported ($1 is the viewer id, null ok).
  const QUESTION = `SELECT i.*,
      COALESCE((SELECT json_object_agg(choice, n) FROM (SELECT choice, COUNT(*)::int AS n FROM ${V} v WHERE v.question_id = i.id GROUP BY choice) c), '{}') AS counts,
      (SELECT choice FROM ${V} v WHERE v.question_id = i.id AND v.user_id = $1::int) AS my_vote,
      (SELECT COUNT(*)::int FROM ${C} c WHERE c.question_id = i.id AND c.hidden_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM ${R} r WHERE r.kind = 'comment' AND r.target_id = c.id AND r.user_id = $1::int)) AS comment_count
    FROM ${T} i
    WHERE i.hidden_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${R} r WHERE r.kind = 'question' AND r.target_id = i.id AND r.user_id = $1::int)`;

  const itemOut = (r, uid) => ({
    id: r.id, title: r.title, body: r.body, author: r.author_name,
    byMe: uid != null && r.author_id === uid, createdAt: r.created_at,
    commentCount: Number(r.comment_count) || 0,
    votes: {
      options: [
        { id: 0, label: 'Yes', count: Number(r.counts[0]) || 0 },
        { id: 1, label: 'No', count: Number(r.counts[1]) || 0 },
      ],
      mine: r.my_vote ?? null,
    },
  });
  const commentOut = (c, uid) => ({ id: c.id, author: c.author_name, body: c.body, createdAt: c.created_at, byMe: uid != null && c.author_id === uid });
  async function one(id, uid) {
    const { rows } = await pool.query(`${QUESTION} AND i.id = $2`, [uid, id]);
    return rows[0] ? itemOut(rows[0], uid) : null;
  }

  async function migrate() {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${T} (
      id SERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
      author_id INT NOT NULL, author_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`);
    await pool.query(`ALTER TABLE ${T} ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${V} (
      question_id INT NOT NULL REFERENCES ${T}(id) ON DELETE CASCADE, user_id INT,
      choice SMALLINT NOT NULL CHECK (choice IN (0, 1)), created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (question_id, user_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${C} (
      id SERIAL PRIMARY KEY, question_id INT NOT NULL REFERENCES ${T}(id) ON DELETE CASCADE,
      author_id INT, author_name TEXT, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`);
    await pool.query(`ALTER TABLE ${C} ADD COLUMN IF NOT EXISTS hidden_at TIMESTAMPTZ`);
    await pool.query(`CREATE INDEX IF NOT EXISTS ${C}_question_idx ON ${C} (question_id, created_at)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${R} (
      kind TEXT NOT NULL CHECK (kind IN ('question', 'comment')), target_id INT NOT NULL,
      user_id INT NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (kind, target_id, user_id))`);
    // Who reported what is private even on staging.
    await pool.query(`COMMENT ON TABLE ${R} IS 'staging:private'`);
    await pool.query(`CREATE TABLE IF NOT EXISTS questions_demo_viewers (user_id INT PRIMARY KEY)`);
  }

  // Staging previews opened with ?demo=1 only. Fake rows once (ids from
  // 900001), then the viewer's own rows once per viewer. Plain routes never
  // write, and nothing in production writes.
  async function seedDemo(req) {
    if (!(IS_STAGING && req.query.demo === '1')) return false;
    const { rows } = await pool.query(`SELECT 1 FROM ${T} WHERE id = $1`, [DEMO_ID]);
    if (!rows.length) {
      const { demoItems } = await loadDemo();
      const rowsIn = demoItems({ seed: 7, titles: TITLES, bodies: BODIES, comments: COMMENTS, now: req.now, firstId: DEMO_ID });
      const put = (table, cols, list) => pool.query(`INSERT INTO ${table} (${cols.replace(/ \w+(,|$)/g, '$1')})
        SELECT * FROM json_to_recordset($1::json) AS x(${cols}) ON CONFLICT DO NOTHING`, [JSON.stringify(list)]);
      await put(T, 'id int, title text, body text, author_id int, author_name text, created_at timestamptz',
        rowsIn.map((r) => ({ id: r.id, title: r.title, body: r.body, author_id: r.authorId, author_name: r.author, created_at: r.createdAt })));
      await put(V, 'question_id int, user_id int, choice smallint, created_at timestamptz',
        rowsIn.flatMap((r) => r.votes.map((v) => ({ question_id: r.id, user_id: v.userId, choice: v.optionId, created_at: v.createdAt }))));
      await put(C, 'id int, question_id int, author_id int, author_name text, body text, created_at timestamptz',
        rowsIn.flatMap((r) => r.comments.map((c) => ({ id: c.id, question_id: r.id, author_id: c.authorId, author_name: c.author, body: c.body, created_at: c.createdAt }))));
    }
    if (req.user) {
      const first = await pool.query(`INSERT INTO questions_demo_viewers (user_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING user_id`, [viewer(req)]);
      if (first.rows.length) {
        // The viewer's own votes: Yes on the first demo question, No on the second.
        await pool.query(`INSERT INTO ${V} (question_id, user_id, choice, created_at)
          VALUES ($1, $2, 0, $3), ($4, $2, 1, $3) ON CONFLICT DO NOTHING`,
          [DEMO_ID, viewer(req), req.now, DEMO_ID + 1]);
        // One question asked by them, two days old, with votes and a short thread.
        const asked = await pool.query(`INSERT INTO ${T} (title, body, author_id, author_name, created_at)
          VALUES ('Should the spring outing be a picnic by the canal?', '', $1, $2, $3) RETURNING id`,
          [viewer(req), String(req.user.username || 'Someone'), new Date(req.now.getTime() - 2 * 86400000)]);
        const qid = asked.rows[0].id;
        await pool.query(`INSERT INTO ${V} (question_id, user_id, choice, created_at)
          SELECT $1, u, c, $2 FROM (VALUES (-1, 0), (-2, 0), (-3, 0), (-4, 0), (-5, 1)) t(u, c)`,
          [qid, req.now]);
        await pool.query(`INSERT INTO ${C} (question_id, author_id, author_name, body, created_at)
          VALUES ($1, -6, 'Elif', 'By the canal sounds lovely. There are tables near the bridge.', $2),
                 ($1, -7, 'Jules', 'Only if we can shelter somewhere if it rains. The pavilion books out fast.', $3)`,
          [qid, req.now, new Date(req.now.getTime() - 86400000)]);
        // And one comment of theirs on the second demo question, a day old
        // so the thread reads like it has been going a while.
        await pool.query(`INSERT INTO ${C} (question_id, author_id, author_name, body, created_at)
          VALUES ($1, $2, $3, $4, $5)`,
          [DEMO_ID + 1, viewer(req), String(req.user.username || 'Someone'),
            "I'd rather keep it at 10 and look for a cheaper room first.",
            new Date(req.now.getTime() - 86400000)]);
      }
    }
    return true;
  }

  app.get('/api/questions', route(false, async (req, res) => {
    const demo = await seedDemo(req);
    const { rows } = await pool.query(`${QUESTION} ORDER BY i.created_at DESC, i.id DESC LIMIT 200`, [viewer(req)]);
    return res.json({ questions: rows.map((r) => itemOut(r, viewer(req))), demo });
  }));

  app.get('/api/questions/:id', route(false, async (req, res) => {
    const id = idOf(req);
    const demo = await seedDemo(req);
    const question = id && await one(id, viewer(req));
    if (!question) return bad(res, 404, GONE);
    const { rows } = await pool.query(`SELECT * FROM ${C}
      WHERE question_id = $2 AND hidden_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM ${R} r WHERE r.kind = 'comment' AND r.target_id = ${C}.id AND r.user_id = $1::int)
      ORDER BY created_at, id LIMIT 500`, [viewer(req), id]);
    return res.json({ question, comments: rows.map((c) => commentOut(c, viewer(req))), demo });
  }));

  app.post('/api/questions', route(true, async (req, res) => {
    const b = req.body || {};
    const title = line(b.title, 120);
    if (!title) return bad(res, 400, 'Write the question first.');
    const { rows } = await pool.query(`INSERT INTO ${T} (title, body, author_id, author_name, created_at)
      VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [title, text(b.body, 2000), viewer(req), String(req.user.username || 'Someone'), req.now]);
    return res.status(201).json({ question: await one(rows[0].id, viewer(req)) });
  }));

  app.post('/api/questions/:id/vote', route(true, async (req, res) => {
    const id = idOf(req);
    const question = id && await one(id, viewer(req));
    if (!question) return bad(res, 404, GONE);
    const choice = (req.body || {}).option;
    if (choice === null) {
      await pool.query(`DELETE FROM ${V} WHERE question_id = $1 AND user_id = $2`, [id, viewer(req)]);
    } else if (choice === 0 || choice === 1) {
      await pool.query(`INSERT INTO ${V} (question_id, user_id, choice, created_at) VALUES ($1, $2, $3, $4)
        ON CONFLICT (question_id, user_id) DO UPDATE SET choice = EXCLUDED.choice, created_at = EXCLUDED.created_at`,
        [id, viewer(req), choice, req.now]);
    } else {
      return bad(res, 400, 'Pick Yes or No.');
    }
    return res.json({ question: await one(id, viewer(req)) });
  }));

  app.post('/api/questions/:id/comments', route(true, async (req, res) => {
    const id = idOf(req);
    const body = text((req.body || {}).body, 1000);
    if (!body) return bad(res, 400, 'Write something first.');
    if (!id || !(await one(id, viewer(req)))) return bad(res, 404, GONE);
    const { rows } = await pool.query(`INSERT INTO ${C} (question_id, author_id, author_name, body, created_at)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`, [id, viewer(req), String(req.user.username || 'Someone'), body, req.now]);
    return res.status(201).json({ comment: commentOut(rows[0], viewer(req)) });
  }));

  // Report a question or a comment. Hidden at once for the reporter (their
  // own report is filtered out of their reads); hidden for everyone once
  // three different people have reported it.
  const reportRoute = (kind) => route(true, async (req, res) => {
    const id = idOf(req);
    if (!id) return bad(res, 404, GONE);
    const table = kind === 'question' ? T : C;
    const { rows } = await pool.query(`SELECT author_id, hidden_at FROM ${table} WHERE id = $1`, [id]);
    const target = rows[0];
    if (!target || target.hidden_at) return bad(res, 404, GONE);
    if (viewer(req) != null && target.author_id === viewer(req)) return bad(res, 400, 'You can delete your own post instead.');
    await pool.query(`INSERT INTO ${R} (kind, target_id, user_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [kind, id, viewer(req), req.now]);
    const counted = await pool.query(`SELECT COUNT(DISTINCT user_id)::int AS n FROM ${R} WHERE kind = $1 AND target_id = $2`, [kind, id]);
    if (counted.rows[0].n >= 3) await pool.query(`UPDATE ${table} SET hidden_at = $2 WHERE id = $1`, [id, req.now]);
    return res.json({ ok: true });
  });
  app.post('/api/questions/:id/report', reportRoute('question'));
  app.post('/api/comments/:id/report', reportRoute('comment'));

  // Delete your own question or comment.
  app.delete('/api/questions/:id', route(true, async (req, res) => {
    const { rows } = await pool.query(`DELETE FROM ${T} WHERE id = $1 AND author_id = $2 RETURNING id`, [idOf(req), viewer(req)]);
    if (!rows.length) return bad(res, 403, 'Only the person who asked this can delete it.');
    return res.json({ ok: true });
  }));
  app.delete('/api/comments/:id', route(true, async (req, res) => {
    const { rows } = await pool.query(`DELETE FROM ${C} WHERE id = $1 AND author_id = $2 RETURNING id`, [idOf(req), viewer(req)]);
    if (!rows.length) return bad(res, 403, 'Only the person who wrote this can delete it.');
    return res.json({ ok: true });
  }));

  return { migrate, base: '/api/questions' };
}

module.exports = { mount };
