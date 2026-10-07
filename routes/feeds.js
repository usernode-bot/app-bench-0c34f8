'use strict';

/* The reader's API: feeds and posts, scoped to the signed-in person.
 *
 * register(app, pool, { IS_STAGING }) mounts the endpoints on /api/*.
 * Read routes must not assume req.user (a guest may read), so every route
 * resolves an "effective user": the signed-in user, or — only in staging
 * and only with ?demo=1 on the two GET routes — the fake staging demo
 * user, whose seeded feeds the preview shows view-only.
 *
 * Tone (the feed dot's colour) is computed server-side: feeds are ranked
 * by id within the user, and rank mod 4 picks tone-1…tone-4, so the
 * client only ever writes whole-literal class names.
 */

const { fetchFeed, normalizeFeedUrl } = require('../lib/feed-fetch');
const { parseFeed } = require('../lib/feed-parser');

const DEMO_USER_ID = 'staging-demo-user';
const MAX_FEEDS = 100;
const MAX_POSTS_ON_ADD = 50;
const MAX_LIST_POSTS = 200;
const REFRESH_MIN_AGE_MS = 60_000; // skip feeds fetched in the last minute
const REFRESH_CONCURRENCY = 4;

function register(app, pool, { IS_STAGING }) {

  /* ── Shared helpers ──────────────────────────────────────────────────── */

  function isDemo(req) {
    return Boolean(IS_STAGING && req.query.demo === '1');
  }

  // The signed-in user's id, or null for a guest.
  function userIdOf(req) {
    return req.user ? String(req.user.id) : null;
  }

  // Whose posts a route answers for: the signed-in user, or the demo user
  // when the staging preview asked for it. Guests get null.
  function readerIdOf(req) {
    if (isDemo(req)) return DEMO_USER_ID;
    return userIdOf(req);
  }

  function accountRequired(res) {
    return res.status(401).json({ error: 'account_required' });
  }

  const TONE_FROM_RANK = '(rn - 1) % 4 + 1';

  // Ranked feeds (for the tone) as a CTE other queries join against.
  const FEED_RANK_CTE = `
    WITH ranked_feeds AS (
      SELECT id, title, feed_url, last_error, fetched_at,
             ROW_NUMBER() OVER (ORDER BY id) AS rn
      FROM feeds WHERE user_id = $1
    )`;

  /* ── Reads ───────────────────────────────────────────────────────────── */

  app.get('/api/posts', async (req, res) => {
    const userId = readerIdOf(req);
    const demo = isDemo(req);
    if (!userId) {
      return res.json({
        posts: [], feedCount: 0, unreadCount: 0,
        signedIn: false, demo, failedFeeds: [],
      });
    }
    try {
      const posts = await pool.query(
        `${FEED_RANK_CTE}
         SELECT p.id, p.title, p.published_at, p.feed_id,
                f.title AS feed_title, ((${TONE_FROM_RANK}))::int AS tone
         FROM posts p
         JOIN ranked_feeds f ON f.id = p.feed_id
         WHERE p.user_id = $1 AND p.read = false
         ORDER BY p.published_at DESC, p.id DESC
         LIMIT $2`,
        [userId, MAX_LIST_POSTS]);

      const counts = await pool.query(
        `${FEED_RANK_CTE}
         SELECT
           (SELECT count(*) FROM feeds WHERE user_id = $1)::int AS feed_count,
           (SELECT count(*) FROM posts WHERE user_id = $1 AND read = false)::int AS unread_count`,
        [userId]);

      const failures = await pool.query(
        `SELECT title FROM feeds WHERE user_id = $1 AND last_error IS NOT NULL
         ORDER BY id`,
        [userId]);

      return res.json({
        posts: posts.rows,
        feedCount: counts.rows[0].feed_count,
        unreadCount: counts.rows[0].unread_count,
        signedIn: Boolean(req.user),
        demo,
        failedFeeds: failures.rows.map((row) => ({ title: row.title })),
      });
    } catch (err) {
      console.error('GET /api/posts failed: ' + err.message);
      return res.status(500).json({ error: 'load_failed' });
    }
  });

  app.get('/api/posts/:id', async (req, res) => {
    const userId = readerIdOf(req);
    if (!userId) return res.status(404).json({ error: 'not_found' });
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    try {
      const result = await pool.query(
        `${FEED_RANK_CTE}
         SELECT p.id, p.title, p.link, p.summary, p.published_at, p.read,
                p.feed_id, f.title AS feed_title,
                ((${TONE_FROM_RANK}))::int AS tone
         FROM posts p
         JOIN ranked_feeds f ON f.id = p.feed_id
         WHERE p.id = $2 AND p.user_id = $1`,
        [userId, id]);
      if (!result.rows.length) return res.status(404).json({ error: 'not_found' });
      return res.json(result.rows[0]);
    } catch (err) {
      console.error('GET /api/posts/:id failed: ' + err.message);
      return res.status(500).json({ error: 'load_failed' });
    }
  });

  /* ── Writes ──────────────────────────────────────────────────────────── */

  // Adding a feed: normalise the address, fetch and parse it right away,
  // and only save it once it is proven to be a feed.
  app.post('/api/feeds', async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return accountRequired(res);
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';

    let url;
    try {
      url = normalizeFeedUrl(body.url);
    } catch (err) {
      return res.status(400).json({ error: 'invalid_url' });
    }
    const feedUrl = url.toString();

    const client = await pool.connect();
    try {
      const existing = await client.query(
        `SELECT id FROM feeds WHERE user_id = $1 AND feed_url = $2`,
        [userId, feedUrl]);
      if (existing.rows.length) {
        return res.status(409).json({ error: 'already_following' });
      }
      const count = await client.query(
        `SELECT count(*)::int AS n FROM feeds WHERE user_id = $1`, [userId]);
      if (count.rows[0].n >= MAX_FEEDS) {
        return res.status(400).json({ error: 'too_many_feeds' });
      }

      let xml;
      try {
        ({ xml } = await fetchFeed(feedUrl));
      } catch (err) {
        return res.status(400).json({ error: err.code === 'invalid_url' ? 'invalid_url' : 'unreachable' });
      }

      let parsed;
      try {
        parsed = parseFeed(xml, { url: feedUrl, fallbackDate: req.now });
      } catch (err) {
        return res.status(400).json({ error: err.code === 'not_a_feed' ? 'not_a_feed' : 'unreachable' });
      }

      const title = name || parsed.title || url.hostname;
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO feeds (user_id, feed_url, title, site_url, fetched_at, last_error)
         VALUES ($1, $2, $3, $4, $5, NULL)
         ON CONFLICT (user_id, feed_url) DO NOTHING
         RETURNING id, title, feed_url, site_url`,
        [userId, feedUrl, title, parsed.siteUrl, req.now]);
      if (!inserted.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'already_following' });
      }
      const feed = inserted.rows[0];

      // Its newest items arrive with it, all unread.
      const newest = parsed.items.slice(0, MAX_POSTS_ON_ADD);
      let added = 0;
      for (const item of newest) {
        const row = await client.query(
          `INSERT INTO posts (feed_id, user_id, guid, title, link, summary,
                              published_at, read, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)
           ON CONFLICT (feed_id, guid) DO NOTHING`,
          [feed.id, userId, item.guid, item.title, item.link,
           item.summary, item.publishedAt, req.now]);
        added += row.rowCount;
      }
      await client.query('COMMIT');

      return res.status(201).json({ feed, added });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* no transaction */ }
      console.error('POST /api/feeds failed: ' + err.message);
      return res.status(500).json({ error: 'save_failed' });
    } finally {
      client.release();
    }
  });

  // Refresh: fetch each of the user's own feeds, 4 at a time, skipping
  // ones fetched in the last minute unless force is set. New items are
  // inserted by their unique key, so read state survives a refresh.
  app.post('/api/refresh', async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return accountRequired(res);
    const force = Boolean((req.body || {}).force);

    let feeds;
    try {
      feeds = await pool.query(
        `SELECT id, feed_url, title, fetched_at FROM feeds
         WHERE user_id = $1 ORDER BY id`, [userId]);
    } catch (err) {
      console.error('POST /api/refresh (list) failed: ' + err.message);
      return res.status(500).json({ error: 'refresh_failed' });
    }

    let newPosts = 0;
    let refreshed = 0;
    const failed = [];

    const due = feeds.rows.filter((feed) =>
      force || !feed.fetched_at ||
      (req.now.getTime() - new Date(feed.fetched_at).getTime()) >= REFRESH_MIN_AGE_MS);

    for (let i = 0; i < due.length; i += REFRESH_CONCURRENCY) {
      const batch = due.slice(i, i + REFRESH_CONCURRENCY);
      const results = await Promise.all(batch.map(async (feed) => {
        try {
          const { xml } = await fetchFeed(feed.feed_url);
          const parsed = parseFeed(xml, { url: feed.feed_url, fallbackDate: req.now });
          let added = 0;
          for (const item of parsed.items) {
            const row = await pool.query(
              `INSERT INTO posts (feed_id, user_id, guid, title, link, summary,
                                  published_at, read, fetched_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)
               ON CONFLICT (feed_id, guid) DO NOTHING`,
              [feed.id, userId, item.guid, item.title, item.link,
               item.summary, item.publishedAt, req.now]);
            added += row.rowCount;
          }
          await pool.query(
            `UPDATE feeds SET fetched_at = $2, last_error = NULL WHERE id = $1`,
            [feed.id, req.now]);
          return { ok: true, added };
        } catch (err) {
          const message = err && err.code ? err.code : 'unreachable';
          await pool.query(
            `UPDATE feeds SET fetched_at = $2, last_error = $3 WHERE id = $1`,
            [feed.id, req.now, message]).catch(() => {});
          return { ok: false, message };
        }
      }));
      for (let j = 0; j < results.length; j++) {
        const feed = batch[j];
        const result = results[j];
        if (result.ok) {
          refreshed += 1;
          newPosts += result.added;
        } else {
          failed.push({ feedId: feed.id, title: feed.title });
        }
      }
    }

    return res.json({ refreshed, newPosts, failed });
  });

  app.post('/api/posts/:id/read', async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return accountRequired(res);
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(404).json({ error: 'not_found' });
    }
    try {
      await pool.query(
        `UPDATE posts SET read = true WHERE id = $2 AND user_id = $1`,
        [userId, id]);
      return res.status(204).end();
    } catch (err) {
      console.error('POST /api/posts/:id/read failed: ' + err.message);
      return res.status(500).json({ error: 'save_failed' });
    }
  });

  // Mark all read covers the posts currently shown, so only the ids the
  // client renders are sent; posts that arrived in between stay unread.
  app.post('/api/posts/read-all', async (req, res) => {
    const userId = userIdOf(req);
    if (!userId) return accountRequired(res);
    const raw = (req.body || {}).ids;
    if (!Array.isArray(raw)) {
      return res.status(400).json({ error: 'bad_request' });
    }
    const ids = [...new Set(raw)]
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, MAX_LIST_POSTS);
    try {
      if (!ids.length) return res.json({ marked: 0 });
      const result = await pool.query(
        `UPDATE posts SET read = true
         WHERE user_id = $1 AND id = ANY($2) AND read = false`,
        [userId, ids]);
      return res.json({ marked: result.rowCount });
    } catch (err) {
      console.error('POST /api/posts/read-all failed: ' + err.message);
      return res.status(500).json({ error: 'save_failed' });
    }
  });
}

module.exports = { register };