'use strict';
// The feed API. Registers all /api routes (before server.js's static files),
// applies the schema, and serves the staging demo. Every table here is
// per-person (staging:private) except feeds/feed_items, the shared cache.

const { loadFeed, normalizeUrl, shortReason, FeedError } = require('./feed-fetch');
const DEMO = require('./demo-feeds');

const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const REFRESH_AFTER = 15 * MINUTE; // a feed older than this is stale
const FORCE_SKIP = MINUTE;         // a forced refresh skips feeds fetched this recently
const POST_WINDOW = 30 * DAY;      // the unread list covers the last 30 days
const MAX_POSTS = 300;
const MAX_FEEDS = 100;
const KEEP_ITEMS = 200;            // newest items kept per feed

// A demo item's real timestamp is the request's "now" minus its offset, so
// the same rows land in the viewer's today and yesterday on every open.
const PUBLISHED = (nowParam) =>
  `COALESCE(${nowParam}::timestamptz - make_interval(mins => i.demo_offset_min), i.published_at)`;

function siteHost(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch { return null; }
}

function snippet(text, cap = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > cap ? s.slice(0, cap).replace(/\s+\S*$/, '') : s;
}

async function mountFeeds(app, pool) {
  const wrap = (fn) => (req, res) => {
    fn(req, res).catch((err) => {
      console.error(`${req.method} ${req.path}:`, err);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Try again in a moment.' });
    });
  };
  const needUser = (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'account_required' });
      return false;
    }
    return true;
  };
  const demoGate = (req) => IS_STAGING && req.query.demo === '1' && !!req.user;

  // ── Schema ────────────────────────────────────────────────────────────
  const migrate = async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS feeds (
        id SERIAL PRIMARY KEY,
        url TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        site_url TEXT,
        last_fetched_at TIMESTAMPTZ,
        last_ok_at TIMESTAMPTZ,
        last_error TEXT,
        is_demo BOOLEAN NOT NULL DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS feed_items (
        id SERIAL PRIMARY KEY,
        feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        guid TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        link TEXT,
        author TEXT,
        summary TEXT NOT NULL DEFAULT '',
        published_at TIMESTAMPTZ,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        demo_offset_min INTEGER,
        UNIQUE (feed_id, guid)
      );
      CREATE INDEX IF NOT EXISTS feed_items_feed_published_idx
        ON feed_items (feed_id, published_at DESC);
      CREATE TABLE IF NOT EXISTS subscriptions (
        user_id TEXT NOT NULL,
        feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, feed_id)
      );
      CREATE TABLE IF NOT EXISTS item_reads (
        user_id TEXT NOT NULL,
        item_id INTEGER NOT NULL REFERENCES feed_items(id) ON DELETE CASCADE,
        read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, item_id)
      );
      CREATE TABLE IF NOT EXISTS demo_seeded (
        user_id TEXT PRIMARY KEY
      );
      COMMENT ON TABLE feeds IS 'staging:private';
      COMMENT ON TABLE feed_items IS 'staging:private';
      COMMENT ON TABLE subscriptions IS 'staging:private';
      COMMENT ON TABLE item_reads IS 'staging:private';
      COMMENT ON TABLE demo_seeded IS 'staging:private';
    `);
  };

  // ── The shared feed cache ─────────────────────────────────────────────
  const inFlight = new Map(); // feed id → refresh in progress, so concurrent callers share it

  async function upsertFeed(parsed, now) {
    const { rows } = await pool.query(
      `INSERT INTO feeds (url, title, site_url, last_fetched_at, last_ok_at, last_error)
       VALUES ($1, $2, $3, $4, $4, NULL)
       ON CONFLICT (url) DO UPDATE SET
         title = EXCLUDED.title, site_url = EXCLUDED.site_url,
         last_fetched_at = EXCLUDED.last_fetched_at, last_ok_at = EXCLUDED.last_ok_at, last_error = NULL
       RETURNING id`,
      [parsed.url, parsed.title || '', parsed.siteUrl || null, now]);
    const feedId = rows[0].id;
    const items = parsed.items.slice(0, KEEP_ITEMS);
    for (const item of items) {
      await pool.query(
        `INSERT INTO feed_items (feed_id, guid, title, link, author, summary, published_at, first_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (feed_id, guid) DO UPDATE SET
           title = EXCLUDED.title, link = EXCLUDED.link,
           author = EXCLUDED.author, summary = EXCLUDED.summary`,
        [feedId, item.guid, item.title || '', item.link, item.author, item.summary || '', item.publishedAt || now]);
    }
    // Keep the newest 200 per feed.
    await pool.query(
      `DELETE FROM feed_items
       WHERE feed_id = $1 AND id NOT IN (
         SELECT id FROM feed_items WHERE feed_id = $1
         ORDER BY published_at DESC NULLS LAST, id DESC LIMIT $2)`,
      [feedId, KEEP_ITEMS]);
    return feedId;
  }

  async function doRefresh(feed, now) {
    try {
      const parsed = await loadFeed(feed.url, { now });
      await upsertFeed(parsed, now);
    } catch (err) {
      await pool.query('UPDATE feeds SET last_fetched_at = $2, last_error = $3 WHERE id = $1',
        [feed.id, now, shortReason(err)]);
    }
  }

  function refreshFeed(feed, now) {
    const going = inFlight.get(feed.id);
    if (going) return going;
    const p = doRefresh(feed, now).finally(() => inFlight.delete(feed.id));
    inFlight.set(feed.id, p);
    return p;
  }

  async function runRefresh(feeds, now) {
    const queue = [...feeds];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (;;) {
        const feed = queue.shift();
        if (!feed) return;
        await refreshFeed(feed, now);
      }
    }));
  }

  // ── Staging demo ──────────────────────────────────────────────────────
  let demoReady = null;
  async function seedDemo() {
    for (const df of DEMO.feeds) {
      const { rows } = await pool.query(
        `INSERT INTO feeds (url, title, site_url, is_demo, last_fetched_at, last_ok_at)
         VALUES ($1, $2, $3, true, now() - interval '2 minutes', now() - interval '2 minutes')
         ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title
         RETURNING id`, [df.url, df.title, df.siteUrl]);
      const feedId = rows[0].id;
      for (const it of df.items) {
        await pool.query(
          `INSERT INTO feed_items (feed_id, guid, title, link, author, summary, published_at, demo_offset_min)
           VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(mins => $7), $7)
           ON CONFLICT (feed_id, guid) DO NOTHING`,
          [feedId, it.guid, it.title, it.link, it.author || null, it.summary || '', it.offsetMin]);
      }
    }
  }

  async function ensureDemoFeeds(req) {
    if (!demoReady) demoReady = seedDemo().catch((err) => { demoReady = null; throw err; });
    await demoReady;
    const uid = req.user.id;
    // First viewer: subscribe them to the demo feeds and mark the two oldest
    // posts read. Later viewers keep whatever state they already have.
    const first = await pool.query(
      'INSERT INTO demo_seeded (user_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING user_id', [uid]);
    if (!first.rows.length) return;
    await pool.query(
      `INSERT INTO subscriptions (user_id, feed_id, created_at)
       SELECT $1, f.id, $2 FROM feeds f WHERE f.is_demo
       ON CONFLICT DO NOTHING`, [uid, req.now]);
    await pool.query(
      `INSERT INTO item_reads (user_id, item_id, read_at)
       SELECT $1, i.id, $2 FROM feed_items i JOIN feeds f ON f.id = i.feed_id
       WHERE f.is_demo AND i.guid = ANY($3)
       ON CONFLICT DO NOTHING`, [uid, req.now, DEMO.READ_GUIDS]);
  }

  // ── GET /api/posts ────────────────────────────────────────────────────
  async function postsPayload(req, demo) {
    const uid = req.user.id;
    const now = req.now;
    const cutoff = new Date(now.getTime() - POST_WINDOW);
    const noDemo = demo ? '' : 'AND NOT f.is_demo';
    const { rows } = await pool.query(
      `SELECT i.id, i.feed_id, f.title AS feed_title, i.title, i.summary,
              ${PUBLISHED('$2')} AS published_at
         FROM feed_items i
         JOIN feeds f ON f.id = i.feed_id
         JOIN subscriptions s ON s.feed_id = f.id AND s.user_id = $1
         LEFT JOIN item_reads r ON r.item_id = i.id AND r.user_id = $1
        WHERE r.item_id IS NULL ${noDemo}
          AND ${PUBLISHED('$2')} > $3 AND ${PUBLISHED('$2')} <= $2
        ORDER BY published_at DESC
        LIMIT ${MAX_POSTS}`, [uid, now, cutoff]);
    const posts = rows.map((r) => ({
      id: r.id,
      feedId: r.feed_id,
      feedTitle: r.feed_title || 'Feed',
      title: r.title || 'Untitled post',
      snippet: snippet(r.summary),
      publishedAt: r.published_at,
    }));
    const [{ n: feedCount }] = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM subscriptions s JOIN feeds f ON f.id = s.feed_id
       WHERE s.user_id = $1 ${noDemo}`, [uid])).rows;
    const failing = (await pool.query(
      `SELECT f.id, f.title FROM feeds f JOIN subscriptions s ON s.feed_id = f.id
       WHERE s.user_id = $1 AND f.last_error IS NOT NULL ${noDemo}
       ORDER BY f.title`, [uid])).rows.map((r) => ({ id: r.id, title: r.title }));
    const [{ checked: oldest }] = (await pool.query(
      `SELECT MIN(f.last_fetched_at) AS checked FROM feeds f JOIN subscriptions s ON s.feed_id = f.id
       WHERE s.user_id = $1 ${noDemo}`, [uid])).rows;
    const [{ stale }] = (await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM feeds f JOIN subscriptions s ON s.feed_id = f.id
         WHERE s.user_id = $1 AND NOT f.is_demo
           AND (f.last_fetched_at IS NULL OR f.last_fetched_at < $2::timestamptz - interval '15 minutes')
       ) AS stale`, [uid, now])).rows;
    return {
      posts,
      feedCount,
      failing,
      checkedAt: demo ? new Date(now.getTime() - 2 * MINUTE) : oldest,
      stale: !!stale,
      demo,
    };
  }

  app.get('/api/posts', wrap(async (req, res) => {
    const demo = demoGate(req);
    if (!req.user) return res.json({ posts: [], feedCount: 0, failing: [], checkedAt: null, stale: false, demo });
    if (demo) await ensureDemoFeeds(req);
    res.json(await postsPayload(req, demo));
  }));

  // ── POST /api/refresh ─────────────────────────────────────────────────
  app.post('/api/refresh', wrap(async (req, res) => {
    if (!needUser(req, res)) return;
    const force = !!(req.body || {}).force;
    const { rows } = await pool.query(
      `SELECT f.* FROM feeds f JOIN subscriptions s ON s.feed_id = f.id
       WHERE s.user_id = $1 AND NOT f.is_demo`, [req.user.id]);
    const now = req.now;
    const due = force
      ? rows.filter((f) => !f.last_fetched_at || now - f.last_fetched_at > FORCE_SKIP)
      : rows.filter((f) => !f.last_fetched_at || now - f.last_fetched_at > REFRESH_AFTER);
    await runRefresh(due, now);
    res.json(await postsPayload(req, false));
  }));

  // ── GET /api/posts/:id ────────────────────────────────────────────────
  app.get('/api/posts/:id', wrap(async (req, res) => {
    if (!req.user) return res.status(404).json({ error: 'This post is no longer in your feeds.' });
    const { rows } = await pool.query(
      `SELECT i.id, i.feed_id, f.title AS feed_title, f.site_url, i.title, i.summary, i.link, i.author,
              i.demo_offset_min, (r.item_id IS NOT NULL) AS read,
              ${PUBLISHED('$3')} AS published_at
         FROM feed_items i
         JOIN feeds f ON f.id = i.feed_id
         JOIN subscriptions s ON s.feed_id = f.id AND s.user_id = $1
         LEFT JOIN item_reads r ON r.item_id = i.id AND r.user_id = $1
        WHERE i.id = $2`, [req.user.id, Number(req.params.id), req.now]);
    if (!rows.length) return res.status(404).json({ error: 'This post is no longer in your feeds.' });
    const r = rows[0];
    res.json({
      post: {
        id: r.id,
        feedId: r.feed_id,
        feedTitle: r.feed_title || '',
        title: r.title || 'Untitled post',
        summary: r.summary || '',
        author: r.author,
        link: r.link,
        siteHost: siteHost(r.site_url),
        read: !!r.read,
        publishedAt: r.published_at,
      },
      demo: r.demo_offset_min != null,
    });
  }));

  // ── PUT/DELETE /api/posts/:id/read ────────────────────────────────────
  app.put('/api/posts/:id/read', wrap(async (req, res) => {
    if (!needUser(req, res)) return;
    const itemId = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT 1 FROM subscriptions s JOIN feed_items i ON i.feed_id = s.feed_id
       WHERE s.user_id = $1 AND i.id = $2`, [req.user.id, itemId]);
    if (!rows.length) return res.status(404).json({ error: 'This post is no longer in your feeds.' });
    await pool.query(
      'INSERT INTO item_reads (user_id, item_id, read_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [req.user.id, itemId, req.now]);
    res.json({ ok: true });
  }));

  app.delete('/api/posts/:id/read', wrap(async (req, res) => {
    if (!needUser(req, res)) return;
    const itemId = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT 1 FROM subscriptions s JOIN feed_items i ON i.feed_id = s.feed_id
       WHERE s.user_id = $1 AND i.id = $2`, [req.user.id, itemId]);
    if (!rows.length) return res.status(404).json({ error: 'This post is no longer in your feeds.' });
    await pool.query('DELETE FROM item_reads WHERE user_id = $1 AND item_id = $2', [req.user.id, itemId]);
    res.json({ ok: true });
  }));

  // ── POST /api/read (mark all shown posts as read) ─────────────────────
  app.post('/api/read', wrap(async (req, res) => {
    if (!needUser(req, res)) return;
    const ids = Array.isArray((req.body || {}).ids)
      ? req.body.ids.slice(0, 500).filter((n) => Number.isInteger(n)) : [];
    if (ids.length) {
      await pool.query(
        `INSERT INTO item_reads (user_id, item_id, read_at)
         SELECT $1, i.id, $2 FROM feed_items i
         JOIN subscriptions s ON s.feed_id = i.feed_id AND s.user_id = $1
         WHERE i.id = ANY($3)
         ON CONFLICT DO NOTHING`, [req.user.id, req.now, ids]);
    }
    res.json({ ok: true });
  }));

  // ── GET /api/feeds ────────────────────────────────────────────────────
  app.get('/api/feeds', wrap(async (req, res) => {
    const demo = demoGate(req);
    if (!req.user) return res.json({ feeds: [], demo });
    if (demo) await ensureDemoFeeds(req);
    const now = req.now;
    const cutoff = new Date(now.getTime() - POST_WINDOW);
    const noDemo = demo ? '' : 'AND NOT f.is_demo';
    const { rows } = await pool.query(
      `SELECT f.id, f.title, f.site_url, f.last_error, f.last_fetched_at,
              COUNT(i.id) FILTER (
                WHERE r.item_id IS NULL
                  AND ${PUBLISHED('$2')} > $3 AND ${PUBLISHED('$2')} <= $2
              )::int AS unread
         FROM feeds f
         JOIN subscriptions s ON s.feed_id = f.id AND s.user_id = $1
         LEFT JOIN feed_items i ON i.feed_id = f.id
         LEFT JOIN item_reads r ON r.item_id = i.id AND r.user_id = $1
        WHERE true ${noDemo}
        GROUP BY f.id
        ORDER BY f.title`, [req.user.id, now, cutoff]);
    res.json({
      feeds: rows.map((r) => ({
        id: r.id,
        title: r.title || siteHost(r.site_url) || 'Untitled feed',
        siteHost: siteHost(r.site_url),
        unread: r.unread,
        lastError: r.last_error,
        lastFetchedAt: r.last_fetched_at,
      })),
      demo,
    });
  }));

  // ── POST /api/feeds (Add feed) ────────────────────────────────────────
  app.post('/api/feeds', wrap(async (req, res) => {
    if (!needUser(req, res)) return;
    const uid = req.user.id;
    const [{ n: count }] = (await pool.query(
      'SELECT COUNT(*)::int AS n FROM subscriptions WHERE user_id = $1', [uid])).rows;
    if (count >= MAX_FEEDS) return res.status(400).json({ error: 'You can follow up to 100 feeds.' });

    const pre = normalizeUrl((req.body || {}).url).href;
    // A recently fetched feed row is reused instead of fetched again.
    const existing = await pool.query(
      'SELECT * FROM feeds WHERE url = $1', [pre]);
    const cached = existing.rows.find((f) => f.last_fetched_at && req.now - f.last_fetched_at < REFRESH_AFTER);
    let parsed;
    let feedId;
    if (cached) {
      feedId = cached.id;
      parsed = { url: cached.url, title: cached.title, siteUrl: cached.site_url, items: [] };
    } else {
      try {
        parsed = await loadFeed((req.body || {}).url, { now: req.now });
      } catch (err) {
        if (err instanceof FeedError) return res.status(400).json({ error: err.message });
        throw err;
      }
      feedId = await upsertFeed(parsed, req.now);
    }
    const dup = await pool.query(
      'SELECT 1 FROM subscriptions WHERE user_id = $1 AND feed_id = $2', [uid, feedId]);
    if (dup.rows.length) return res.status(409).json({ error: 'That feed is already in your feeds.' });
    await pool.query(
      'INSERT INTO subscriptions (user_id, feed_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [uid, feedId, req.now]);
    const { rows: frows } = await pool.query('SELECT * FROM feeds WHERE id = $1', [feedId]);
    const feed = frows[0];
    const cutoff = new Date(req.now.getTime() - POST_WINDOW);
    const [{ n: added }] = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM feed_items i
       LEFT JOIN item_reads r ON r.item_id = i.id AND r.user_id = $2
       WHERE i.feed_id = $1 AND r.item_id IS NULL AND i.published_at > $3 AND i.published_at <= $4`,
      [feedId, uid, cutoff, req.now])).rows;
    res.json({ feed: { id: feed.id, title: feed.title || siteHost(feed.site_url) || siteHost(feed.url) }, added });
  }));

  // ── DELETE /api/feeds/:id (Remove) ────────────────────────────────────
  app.delete('/api/feeds/:id', wrap(async (req, res) => {
    if (!needUser(req, res)) return;
    const { rowCount } = await pool.query(
      'DELETE FROM subscriptions WHERE user_id = $1 AND feed_id = $2',
      [req.user.id, Number(req.params.id)]);
    if (!rowCount) return res.status(404).json({ error: 'That feed is not in your feeds.' });
    res.json({ ok: true });
  }));

  // ── POST /api/feeds/:id/refresh (Try again) ───────────────────────────
  app.post('/api/feeds/:id/refresh', wrap(async (req, res) => {
    if (!needUser(req, res)) return;
    const { rows } = await pool.query(
      `SELECT f.* FROM feeds f JOIN subscriptions s ON s.feed_id = f.id
       WHERE s.user_id = $1 AND f.id = $2`, [req.user.id, Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'That feed is not in your feeds.' });
    const feed = rows[0];
    if (!feed.is_demo) await refreshFeed(feed, req.now); // demo feeds are never fetched
    const { rows: after } = await pool.query('SELECT * FROM feeds WHERE id = $1', [feed.id]);
    const f = after[0];
    res.json({
      feed: {
        id: f.id,
        title: f.title || siteHost(f.site_url) || 'Untitled feed',
        siteHost: siteHost(f.site_url),
        lastError: f.last_error,
        lastFetchedAt: f.last_fetched_at,
      },
    });
  }));

  return { migrate };
}

module.exports = { mountFeeds };