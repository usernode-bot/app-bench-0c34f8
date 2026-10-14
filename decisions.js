'use strict';
// Club Votes' API: decisions people post, one vote per person per decision
// (changeable or taken back while it is open), a comment thread under each,
// and reports to the club's moderators. Adapted from kit/server.js with the
// same Item and Comment shapes so the kit's client pieces work; kit/server.js
// itself stays unmounted and unedited.
//
// Reads may come from a guest (no req.user), writes need req.user, "now" is
// req.now. Nothing in app code sets hidden_at: that is where the platform's
// moderation hides a row, and every read excludes rows where it is set.
// Staging with ?demo=1 only: rows for the made-up demo club, written once
// (ids from 900001), and the viewer's own votes and decision, once per viewer.

const path = require('path');
const { pathToFileURL } = require('url');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const DEMO_ID = 900001;
const VIEWER_DECISION_ID = 900021;
const GONE = 'This was removed, or the link is wrong.';
const CLOSED = 'Voting on this has closed.';
const loadDemo = () => import(pathToFileURL(path.join(__dirname, 'public', 'kit', 'demo.js')).href);

// The demo club's decisions: this app's own made-up lines about meeting
// places, projects, dues and the like, voted on by the kit's made-up people.
const DEMO_TITLES = [
  { title: 'Where should we meet in November?', options: ['Library meeting room', "Back room at Dot's Cafe", "Someone's garden"] },
  { title: 'Spring trip: coast walk or museum day?', options: ['Coast walk', 'Museum day'] },
  { title: 'What should the October project be?', options: ['Park clean-up', 'Book swap', 'Quiz night'] },
  { title: 'Should we raise yearly dues to 15?', options: ['Yes', 'No'] },
  { title: 'A name for the club newsletter', options: ['The Noticeboard', 'Club Signals', 'The Minute'] },
  { title: 'Weekly meeting night: Tuesday or Thursday?', options: ['Tuesday', 'Thursday'] },
  { title: 'Buy a secondhand projector for talks?', options: ['Yes', 'No'] },
  { title: 'What do we do at the winter social?', options: ['Potluck supper', 'Games night', 'Films and cocoa'] },
  { title: 'Allow guests at monthly talks: two or four per member?', options: ['Two as now', 'Four'] },
  { title: 'Where do the club books live now the shelf is full?', options: ['A crate in the hall', 'Members take turns', 'Donate the oldest'] },
  { title: 'Start a tool lending shelf?', options: ['Yes', 'No', 'Ask again next year'] },
  { title: 'Swap the club noticeboard for a bigger one?', options: ['Yes', 'No'] },
];
const DEMO_BODIES = ['A few notes on this one are in the club minutes.', 'Please read this before you vote.', ''];
const DEMO_COMMENTS = [
  'Happy to help with this one.',
  'Can we do both?',
  'I would come on Thursday.',
  'The room was a bit noisy last time.',
  'Either works for me.',
  'Good idea, count me in.',
];
// Which demo rows sit in the Decided section (all have votes), with the rest
// left open so the open rows still vary (a lead, a tie, few votes).
const DEMO_DECIDED = [2, 7, 9];
// The viewer's demo votes land on two OPEN demo rows (the kit's own picks).
const VIEWER_VOTE_IDS = [DEMO_ID + 1, DEMO_ID + 4];

const line = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const text = (v, max) => (typeof v === 'string'
  ? v.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '');

/**
 * Mount the routes on `app` and return { migrate }, to await before listen.
 * Tables: decisions and its votes and comments are public; reports are
 * staging:private (no foreign key to the public tables); demo_viewers marks
 * which viewer a ?demo=1 request has already been given its own rows.
 */
function mount(app, pool) {
  const T = 'decisions';
  const V = 'decisions_votes';
  const C = 'decisions_comments';
  const base = '/api/decisions';
  const max = { title: 120, body: 2000, option: 60, comment: 1000 };
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

  const DECISION = `SELECT i.*,
      COALESCE((SELECT json_object_agg(choice, n) FROM (SELECT choice, COUNT(*)::int AS n FROM ${V} v WHERE v.decision_id = i.id GROUP BY choice) c), '{}') AS counts,
      (SELECT choice FROM ${V} v WHERE v.decision_id = i.id AND v.user_id = $1::int) AS my_vote,
      (SELECT COUNT(*)::int FROM ${C} c WHERE c.decision_id = i.id AND c.hidden_at IS NULL) AS comment_count
    FROM ${T} i`;
  const decisionOut = (r, uid) => {
    const labels = Array.isArray(r.options) && r.options.length ? r.options : ['Yes', 'No'];
    return {
      id: r.id, title: r.title, body: r.body, author: r.author_name,
      byMe: uid != null && r.author_id === uid, createdAt: r.created_at, commentCount: r.comment_count,
      votes: { options: labels.map((label, k) => ({ id: k, label, count: Number(r.counts[k]) || 0 })), mine: r.my_vote ?? null },
      decided: r.decided_option == null ? null : { option: r.decided_option, at: r.decided_at },
    };
  };
  const commentOut = (c, uid) => ({ id: c.id, author: c.author_name, body: c.body, createdAt: c.created_at, byMe: uid != null && c.author_id === uid });
  async function one(id, uid) {
    const { rows } = await pool.query(`${DECISION} WHERE i.id = $2 AND i.hidden_at IS NULL`, [uid, id]);
    return rows[0] ? decisionOut(rows[0], uid) : null;
  }

  async function migrate() {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${T} (
      id SERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', options JSONB NOT NULL,
      author_id INTEGER NOT NULL, author_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
      decided_option INTEGER, decided_at TIMESTAMPTZ, hidden_at TIMESTAMPTZ, is_demo BOOLEAN NOT NULL DEFAULT false)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${V} (
      decision_id INTEGER NOT NULL REFERENCES ${T}(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
      choice INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (decision_id, user_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${C} (
      id SERIAL PRIMARY KEY, decision_id INTEGER NOT NULL REFERENCES ${T}(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL, author_name TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, hidden_at TIMESTAMPTZ)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS ${C}_decision_idx ON ${C} (decision_id, created_at)`);
    // Reports go to the club's moderators: recorded, never shown in the app.
    // No foreign key, so a hidden or deleted target's report still stands.
    await pool.query(`CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY, kind TEXT NOT NULL, target_id INTEGER NOT NULL, reporter_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL)`);
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS reports_unique_idx ON reports (kind, target_id, reporter_id)');
    await pool.query("COMMENT ON TABLE reports IS 'staging:private'");
    // The viewer's own demo rows are written once, on their first ?demo=1 call.
    await pool.query('CREATE TABLE IF NOT EXISTS demo_viewers (user_id INTEGER PRIMARY KEY)');
  }

  // Each table's rows in one query: `cols` names and types them, as
  // json_to_recordset reads them (the kit's own trick).
  const put = (table, cols, list) => pool.query(`INSERT INTO ${table} (${cols.replace(/ \w+(,|$)/g, '$1')})
    SELECT * FROM json_to_recordset($1::json) AS x(${cols}) ON CONFLICT DO NOTHING`, [JSON.stringify(list)]);

  async function seedDemo(req) {
    if (!(IS_STAGING && req.query.demo === '1')) return false;
    const { rows } = await pool.query(`SELECT 1 FROM ${T} WHERE id = $1`, [DEMO_ID]);
    if (!rows.length) {
      const { demoItems } = await loadDemo();
      const rowsIn = demoItems({
        seed: 7, titles: DEMO_TITLES, bodies: DEMO_BODIES, comments: DEMO_COMMENTS, now: req.now, firstId: DEMO_ID,
      });
      await put(T, 'id int, title text, body text, options jsonb, author_id int, author_name text, created_at timestamptz, is_demo bool',
        rowsIn.map((r) => ({ id: r.id, title: r.title, body: r.body, options: r.options.map((o) => o.label), author_id: r.authorId, author_name: r.author, created_at: r.createdAt, is_demo: true })));
      await put(V, 'decision_id int, user_id int, choice int, created_at timestamptz',
        rowsIn.flatMap((r) => r.votes.map((v) => ({ decision_id: r.id, user_id: v.userId, choice: v.optionId, created_at: v.createdAt }))));
      await put(C, 'id int, decision_id int, author_id int, author_name text, body text, created_at timestamptz',
        rowsIn.flatMap((r) => r.comments.map((c) => ({ id: c.id, decision_id: r.id, author_id: c.authorId, author_name: c.author, body: c.body, created_at: c.createdAt }))));
      // Three of the demo club's decisions are settled on their leader.
      for (const i of DEMO_DECIDED) {
        const r = rowsIn[i];
        const counts = r.options.map(() => 0);
        for (const v of r.votes) counts[v.optionId] += 1;
        const won = counts.indexOf(Math.max(...counts));
        const at = new Date(new Date(r.createdAt).getTime()
          + (new Date(req.now).getTime() - new Date(r.createdAt).getTime()) * 0.6);
        await pool.query(`UPDATE ${T} SET decided_option = $2, decided_at = $3 WHERE id = $1`, [r.id, won, at]);
      }
    }
    if (req.user) {
      const first = await pool.query('INSERT INTO demo_viewers (user_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING user_id', [viewer(req)]);
      if (first.rows.length) {
        // The viewer's own votes on two open demo decisions...
        await pool.query(`INSERT INTO ${V} (decision_id, user_id, choice, created_at)
          SELECT d.id, $1, x.choice, $2 FROM (VALUES ($3::int, 0), ($4::int, 1)) AS x(id, choice)
          JOIN ${T} d ON d.id = x.id WHERE d.is_demo AND d.decided_at IS NULL
          ON CONFLICT DO NOTHING`, [viewer(req), req.now, VIEWER_VOTE_IDS[0], VIEWER_VOTE_IDS[1]]);
        // ...and one open decision asked by the viewer, so Mark decided and
        // Delete can be tried on it.
        await pool.query(`INSERT INTO ${T} (id, title, body, options, author_id, author_name, created_at, is_demo)
          VALUES ($1, $2, '', $3::jsonb, $4, $5, $6, true) ON CONFLICT DO NOTHING`,
          [VIEWER_DECISION_ID, 'Should the club buy a secondhand projector?',
            JSON.stringify(['Yes', 'No']), viewer(req), String(req.user.username || 'Someone'),
            new Date(new Date(req.now).getTime() - 2 * 3600000)]);
      }
    }
    return true;
  }

  // Open first, newest first, then decided ones by when they were decided.
  const ORDER = `ORDER BY (i.decided_at IS NULL) DESC,
    CASE WHEN i.decided_at IS NULL THEN i.created_at END DESC,
    i.decided_at DESC, i.id DESC LIMIT 200`;

  app.get(base, route(false, async (req, res) => {
    const demo = await seedDemo(req);
    const { rows } = await pool.query(
      `${DECISION} WHERE i.hidden_at IS NULL AND (i.is_demo = false OR $2::boolean) ${ORDER}`,
      [viewer(req), demo]);
    res.json({ decisions: rows.map((r) => decisionOut(r, viewer(req))), demo, signedIn: !!req.user });
  }));

  app.get(`${base}/:id`, route(false, async (req, res) => {
    const id = idOf(req);
    const demo = await seedDemo(req);
    const decision = id && await one(id, viewer(req));
    if (!decision) return bad(res, 404, GONE);
    const { rows } = await pool.query(
      `SELECT * FROM ${C} WHERE decision_id = $1 AND hidden_at IS NULL ORDER BY created_at, id LIMIT 500`, [id]);
    return res.json({ decision, comments: rows.map((c) => commentOut(c, viewer(req))), demo });
  }));

  app.post(base, route(true, async (req, res) => {
    const b = req.body || {};
    const title = line(b.title, max.title);
    if (!title) return bad(res, 400, 'Add a question.');
    const labels = [];
    const seen = new Set();
    if (Array.isArray(b.options)) {
      for (const o of b.options) {
        const t = line(o, max.option);
        if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); labels.push(t); }
      }
    }
    if (labels.length < 2) return bad(res, 400, 'Give at least two different options.');
    if (labels.length > 6) return bad(res, 400, 'Give at most six options.');
    const { rows } = await pool.query(`INSERT INTO ${T} (title, body, options, author_id, author_name, created_at)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id`,
      [title, text(b.body, max.body), JSON.stringify(labels), viewer(req), String(req.user.username || 'Someone'), req.now]);
    return res.status(201).json({ decision: await one(rows[0].id, viewer(req)) });
  }));

  app.post(`${base}/:id/vote`, route(true, async (req, res) => {
    const id = idOf(req);
    const decision = id && await one(id, viewer(req));
    if (!decision) return bad(res, 404, GONE);
    if (decision.decided) return bad(res, 409, CLOSED);
    const choice = (req.body || {}).option;
    if (choice === null) {
      await pool.query(`DELETE FROM ${V} WHERE decision_id = $1 AND user_id = $2`, [id, viewer(req)]);
    } else if (Number.isInteger(choice) && choice >= 0 && choice < decision.votes.options.length) {
      await pool.query(`INSERT INTO ${V} (decision_id, user_id, choice, created_at) VALUES ($1, $2, $3, $4)
        ON CONFLICT (decision_id, user_id) DO UPDATE SET choice = EXCLUDED.choice, created_at = EXCLUDED.created_at`,
        [id, viewer(req), choice, req.now]);
    } else {
      return bad(res, 400, 'Pick one of the options.');
    }
    return res.json({ decision: await one(id, viewer(req)) });
  }));

  app.post(`${base}/:id/decide`, route(true, async (req, res) => {
    const id = idOf(req);
    const decision = id && await one(id, viewer(req));
    if (!decision) return bad(res, 404, GONE);
    if (!decision.byMe) return bad(res, 403, 'Only the person who asked can mark this decided.');
    const choice = (req.body || {}).option;
    if (choice === null || choice === undefined) {
      await pool.query(`UPDATE ${T} SET decided_option = NULL, decided_at = NULL WHERE id = $1`, [id]);
    } else if (Number.isInteger(choice) && choice >= 0 && choice < decision.votes.options.length) {
      await pool.query(`UPDATE ${T} SET decided_option = $2, decided_at = $3 WHERE id = $1`, [id, choice, req.now]);
    } else {
      return bad(res, 400, 'Pick one of the options.');
    }
    return res.json({ decision: await one(id, viewer(req)) });
  }));

  app.delete(`${base}/:id`, route(true, async (req, res) => {
    const { rows } = await pool.query(`DELETE FROM ${T} WHERE id = $1 AND author_id = $2 RETURNING id`,
      [idOf(req), viewer(req)]);
    if (!rows.length) return bad(res, 403, 'Only the person who asked can delete this.');
    return res.json({ ok: true });
  }));

  app.post(`${base}/:id/comments`, route(true, async (req, res) => {
    const id = idOf(req);
    const body = text((req.body || {}).body, max.comment);
    if (!body) return bad(res, 400, 'Write something first.');
    if (!id || !(await one(id, viewer(req)))) return bad(res, 404, GONE);
    const { rows } = await pool.query(`INSERT INTO ${C} (decision_id, author_id, author_name, body, created_at)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, viewer(req), String(req.user.username || 'Someone'), body, req.now]);
    return res.status(201).json({ comment: commentOut(rows[0], viewer(req)) });
  }));

  app.delete('/api/comments/:id', route(true, async (req, res) => {
    const { rows } = await pool.query(`DELETE FROM ${C} WHERE id = $1 AND author_id = $2 RETURNING id`,
      [idOf(req), viewer(req)]);
    if (!rows.length) return bad(res, 403, 'Only the person who wrote this can delete it.');
    return res.json({ ok: true });
  }));

  app.post('/api/reports', route(true, async (req, res) => {
    const b = req.body || {};
    const targetId = Number(b.targetId);
    if (!['decision', 'comment'].includes(b.kind) || !Number.isInteger(targetId)) {
      return bad(res, 400, 'That report could not be sent.');
    }
    await pool.query(`INSERT INTO reports (kind, target_id, reporter_id, created_at)
      VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [b.kind, targetId, viewer(req), req.now]);
    return res.json({ ok: true });
  }));

  return { migrate };
}

module.exports = { mount };
