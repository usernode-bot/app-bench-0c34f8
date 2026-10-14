'use strict';
// Items people post, each with options to vote on (one vote per person,
// changeable or taken back) and a comment thread, on Postgres: the JSON
// public/kit/ renders. Mounting, routes and shapes: public/kit/README.md.
// Reads may come from a guest (no req.user), writes need req.user, "now" is
// req.now. Staging with ?demo=1 only: rows from public/kit/demo.js, written
// once (ids from 900001, made-up people), and the viewer's votes on two, once.

const path = require('path');
const { pathToFileURL } = require('url');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const DEMO_ID = 900001;
const GONE = 'This was removed, or the link is wrong.';
const loadDemo = () => import(pathToFileURL(path.join(__dirname, '..', 'public', 'kit', 'demo.js')).href);

const line = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const text = (v, max) => (typeof v === 'string'
  ? v.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '');

function resource(app, pool, opts = {}) {
  const name = opts.name || 'items';
  if (!/^[a-z][a-z0-9_]{0,40}$/.test(name)) throw new Error('kit resource name: lower case letters, digits and _');
  const T = name;
  const V = `${name}_votes`;
  const C = `${name}_comments`;
  const base = `/api/${name.replace(/_/g, '-')}`;
  const max = { title: 120, body: 2000, category: 40, option: 60, options: 6, comment: 1000, ...opts.max };
  const defaults = (opts.options || ['Yes', 'No']).map(String);
  const categories = Array.isArray(opts.categories) && opts.categories.length ? opts.categories.map(String) : null;
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

  const ITEM = `SELECT i.*,
      COALESCE((SELECT json_object_agg(choice, n) FROM (SELECT choice, COUNT(*)::int AS n FROM ${V} v WHERE v.item_id = i.id GROUP BY choice) c), '{}') AS counts,
      (SELECT choice FROM ${V} v WHERE v.item_id = i.id AND v.user_id = $1::int) AS my_vote,
      (SELECT COUNT(*)::int FROM ${C} c WHERE c.item_id = i.id) AS comment_count
    FROM ${T} i`;
  const itemOut = (r, uid) => {
    const labels = Array.isArray(r.options) && r.options.length ? r.options : defaults;
    return {
      id: r.id, title: r.title, body: r.body, category: r.category, author: r.author_name,
      byMe: uid != null && r.author_id === uid, createdAt: r.created_at, commentCount: r.comment_count,
      votes: { options: labels.map((label, k) => ({ id: k, label, count: Number(r.counts[k]) || 0 })), mine: r.my_vote ?? null },
    };
  };
  const commentOut = (c, uid) => ({ id: c.id, author: c.author_name, body: c.body, createdAt: c.created_at, byMe: uid != null && c.author_id === uid });
  async function one(id, uid) {
    const { rows } = await pool.query(`${ITEM} WHERE i.id = $2`, [uid, id]);
    return rows[0] ? itemOut(rows[0], uid) : null;
  }

  async function migrate() {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${T} (
      id SERIAL PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', category TEXT, options JSONB,
      author_id INTEGER NOT NULL, author_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${V} (
      item_id INTEGER NOT NULL REFERENCES ${T}(id) ON DELETE CASCADE, user_id INTEGER NOT NULL,
      choice INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (item_id, user_id))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${C} (
      id SERIAL PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES ${T}(id) ON DELETE CASCADE,
      author_id INTEGER NOT NULL, author_name TEXT NOT NULL, body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS ${C}_item_idx ON ${C} (item_id, created_at)`);
    await pool.query('CREATE TABLE IF NOT EXISTS kit_demo_viewers (resource TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (resource, user_id))');
  }

  async function seedDemo(req) {
    if (!(IS_STAGING && req.query.demo === '1' && opts.demo)) return false;
    const { rows } = await pool.query(`SELECT 1 FROM ${T} WHERE id = $1`, [DEMO_ID]);
    if (!rows.length) {
      const { demoItems } = await loadDemo();
      const rowsIn = demoItems({ seed: 7, options: defaults, ...opts.demo, now: req.now, firstId: DEMO_ID });
      // Each table's rows in one query: `cols` names and types them, as json_to_recordset reads them.
      const put = (table, cols, list) => pool.query(`INSERT INTO ${table} (${cols.replace(/ \w+(,|$)/g, '$1')})
        SELECT * FROM json_to_recordset($1::json) AS x(${cols}) ON CONFLICT DO NOTHING`, [JSON.stringify(list)]);
      await put(T, 'id int, title text, body text, category text, options jsonb, author_id int, author_name text, created_at timestamptz',
        rowsIn.map((r) => ({ id: r.id, title: r.title, body: r.body, category: r.category, options: r.options.map((o) => o.label), author_id: r.authorId, author_name: r.author, created_at: r.createdAt })));
      await put(V, 'item_id int, user_id int, choice int, created_at timestamptz',
        rowsIn.flatMap((r) => r.votes.map((v) => ({ item_id: r.id, user_id: v.userId, choice: v.optionId, created_at: v.createdAt }))));
      await put(C, 'id int, item_id int, author_id int, author_name text, body text, created_at timestamptz',
        rowsIn.flatMap((r) => r.comments.map((c) => ({ id: c.id, item_id: r.id, author_id: c.authorId, author_name: c.author, body: c.body, created_at: c.createdAt }))));
    }
    if (req.user) {
      const first = await pool.query('INSERT INTO kit_demo_viewers (resource, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING user_id', [T, viewer(req)]);
      if (first.rows.length) {
        await pool.query(`INSERT INTO ${V} (item_id, user_id, choice, created_at)
          SELECT id, $1, 0, $2 FROM ${T} WHERE id IN ($3, $4) ON CONFLICT DO NOTHING`, [viewer(req), req.now, DEMO_ID + 1, DEMO_ID + 4]);
      }
    }
    return true;
  }

  app.get(base, route(false, async (req, res) => {
    const demo = await seedDemo(req);
    const { rows } = await pool.query(`${ITEM} ORDER BY i.created_at DESC, i.id DESC LIMIT 200`, [viewer(req)]);
    res.json({ items: rows.map((r) => itemOut(r, viewer(req))), demo });
  }));

  app.get(`${base}/:id`, route(false, async (req, res) => {
    const id = idOf(req);
    const demo = await seedDemo(req);
    const item = id && await one(id, viewer(req));
    if (!item) return bad(res, 404, GONE);
    const { rows } = await pool.query(`SELECT * FROM ${C} WHERE item_id = $1 ORDER BY created_at, id LIMIT 500`, [id]);
    return res.json({ item, comments: rows.map((c) => commentOut(c, viewer(req))), demo });
  }));

  app.post(base, route(true, async (req, res) => {
    const b = req.body || {};
    const title = line(b.title, max.title);
    if (!title) return bad(res, 400, 'Add a title.');
    const category = line(b.category, max.category) || null;
    if (categories && category && !categories.includes(category)) return bad(res, 400, 'Pick one of the listed categories.');
    let options = null;
    if (Array.isArray(b.options) && b.options.length) {
      const seen = new Map();
      for (const o of b.options) { const t = line(o, max.option); if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); }
      options = [...seen.values()];
      if (options.length < 2) return bad(res, 400, 'Give at least two different options.');
      if (options.length > max.options) return bad(res, 400, `Give at most ${max.options} options.`);
    }
    const { rows } = await pool.query(`INSERT INTO ${T} (title, body, category, options, author_id, author_name, created_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING id`,
    [title, text(b.body, max.body), category, options && JSON.stringify(options), viewer(req), String(req.user.username || 'Someone'), req.now]);
    return res.status(201).json({ item: await one(rows[0].id, viewer(req)) });
  }));

  app.post(`${base}/:id/vote`, route(true, async (req, res) => {
    const id = idOf(req);
    const item = id && await one(id, viewer(req));
    if (!item) return bad(res, 404, GONE);
    const choice = (req.body || {}).option;
    if (choice === null) {
      await pool.query(`DELETE FROM ${V} WHERE item_id = $1 AND user_id = $2`, [id, viewer(req)]);
    } else if (Number.isInteger(choice) && choice >= 0 && choice < item.votes.options.length) {
      await pool.query(`INSERT INTO ${V} (item_id, user_id, choice, created_at) VALUES ($1, $2, $3, $4)
        ON CONFLICT (item_id, user_id) DO UPDATE SET choice = EXCLUDED.choice, created_at = EXCLUDED.created_at`, [id, viewer(req), choice, req.now]);
    } else {
      return bad(res, 400, 'Pick one of the options.');
    }
    return res.json({ item: await one(id, viewer(req)) });
  }));

  app.post(`${base}/:id/comments`, route(true, async (req, res) => {
    const id = idOf(req);
    const body = text((req.body || {}).body, max.comment);
    if (!body) return bad(res, 400, 'Write something first.');
    if (!id || !(await one(id, viewer(req)))) return bad(res, 404, GONE);
    const { rows } = await pool.query(`INSERT INTO ${C} (item_id, author_id, author_name, body, created_at)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`, [id, viewer(req), String(req.user.username || 'Someone'), body, req.now]);
    return res.status(201).json({ comment: commentOut(rows[0], viewer(req)) });
  }));

  app.delete(`${base}/:id`, route(true, async (req, res) => {
    const { rows } = await pool.query(`DELETE FROM ${T} WHERE id = $1 AND author_id = $2 RETURNING id`, [idOf(req), viewer(req)]);
    if (!rows.length) return bad(res, 403, 'Only the person who posted this can delete it.');
    return res.json({ ok: true });
  }));

  return { migrate, base };
}

module.exports = { resource };
