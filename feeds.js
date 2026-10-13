// The RSS Reader's own data: feeds and posts, per user, in private tables.
// CommonJS, like server.js. All displayed time comes from req.now — never
// NOW() or new Date() on the request path.
'use strict';

const express = require('express');
const {
  NotAFeed,
  normalizeUrl,
  safeFetch,
  parseFeed,
  htmlToParagraphs,
  findFeedLink,
} = require('./lib/rss');

const IS_STAGING = process.env.USERNODE_ENV !== 'production';

const MAX_POSTS_AT_ADD = 50;
const KEEP_PER_FEED = 200;
const MAX_BODY_PARAGRAPHS = 20;
const MAX_BODY_CHARS = 20_000;
const SNIPPET_CHARS = 160;
const REFRESH_STALE_MINUTES = 15;
const REFRESH_FORCE_MINUTES = 1;
const REFRESH_BATCH = 4;

const NOT_A_FEED_MESSAGE = "That page isn't a feed. Paste the feed's own address, often ending in /feed or .xml";
const NO_ANSWER_MESSAGE = "That address didn't answer. Check it and try again";
const SERVER_MESSAGE = 'Something went wrong on our side. Try again in a moment.';

/** The user's sentence for an error from lib/rss.js. */
function fetchErrorSentence(err) {
  const msg = err && typeof err.message === 'string' ? err.message : '';
  if (err instanceof NotAFeed || /isn't a feed/i.test(msg)) return NOT_A_FEED_MESSAGE;
  if (/didn't answer/i.test(msg) || err.name === 'TimeoutError' || err.name === 'AbortError') return NO_ANSWER_MESSAGE;
  if (/Only public web addresses/i.test(msg) || /doesn't look like a web address/i.test(msg)) return msg;
  return NO_ANSWER_MESSAGE;
}

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rss_feeds (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      url text NOT NULL,
      title text NOT NULL,
      site_url text,
      color smallint NOT NULL,
      is_demo boolean NOT NULL DEFAULT false,
      last_fetched_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL,
      UNIQUE (user_id, url)
    )`);
  await pool.query(`COMMENT ON TABLE rss_feeds IS 'staging:private'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rss_posts (
      id serial PRIMARY KEY,
      feed_id int NOT NULL REFERENCES rss_feeds ON DELETE CASCADE,
      guid text NOT NULL,
      title text NOT NULL,
      link text,
      author text,
      snippet text,
      body jsonb,
      published_at timestamptz NOT NULL,
      read_at timestamptz,
      UNIQUE (feed_id, guid)
    )`);
  await pool.query(`COMMENT ON TABLE rss_posts IS 'staging:private'`);
  await pool.query('CREATE INDEX IF NOT EXISTS rss_posts_feed_published ON rss_posts (feed_id, read_at, published_at DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rss_demo_seeds (
      user_id text PRIMARY KEY,
      seeded_at timestamptz NOT NULL
    )`);
  await pool.query(`COMMENT ON TABLE rss_demo_seeds IS 'staging:private'`);
}

// ── Shaping ────────────────────────────────────────────────────────────────

function initialOf(title) {
  const m = /[a-z0-9]/i.exec(String(title || ''));
  return m ? m[0].toUpperCase() : '#';
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || '';
  }
}

function feedOut(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    siteUrl: row.site_url,
    color: row.color,
    initial: initialOf(row.title),
    unread: row.unread == null ? undefined : Number(row.unread),
    lastError: row.last_error || null,
  };
}

function postOut(row) {
  return {
    id: row.id,
    feedId: row.feed_id,
    title: row.title,
    snippet: row.snippet || '',
    link: row.link,
    publishedAt: row.published_at,
  };
}

/** The whole list payload the page renders from. Demo rows belong to the
 * ?demo=1 screen (request-time demo seeding): a plain load stays empty even
 * once the demo has been seeded for the viewer, so the demo screen and the
 * real one can be open at the same time (two checks do exactly that). */
async function listPayload(pool, userId, withDemo) {
  const feeds = (await pool.query(
    `SELECT f.id, f.title, f.url, f.site_url, f.color, f.is_demo, f.last_error,
       (SELECT count(*) FROM rss_posts p WHERE p.feed_id = f.id AND p.read_at IS NULL) AS unread
     FROM rss_feeds f
     WHERE f.user_id = $1 AND ($2 OR NOT f.is_demo)
     ORDER BY f.created_at, f.id`,
    [userId, Boolean(withDemo)],
  )).rows;
  const posts = (await pool.query(
    `SELECT p.id, p.feed_id, p.title, p.snippet, p.link, p.published_at
     FROM rss_posts p
     JOIN rss_feeds f ON f.id = p.feed_id
     WHERE f.user_id = $1 AND ($2 OR NOT f.is_demo) AND p.read_at IS NULL
     ORDER BY p.published_at DESC
     LIMIT 300`,
    [userId, Boolean(withDemo)],
  )).rows;
  return {
    feeds: feeds.map(feedOut),
    posts: posts.map(postOut),
    demo: feeds.some((f) => f.is_demo),
  };
}

// ── Storing posts ──────────────────────────────────────────────────────────

function paragraphsOf(item) {
  const paras = htmlToParagraphs(item.text).slice(0, MAX_BODY_PARAGRAPHS);
  const kept = [];
  let total = 0;
  for (const p of paras) {
    if (total + p.length > MAX_BODY_CHARS) break;
    kept.push(p);
    total += p.length;
  }
  return kept;
}

async function storePosts(pool, feedId, parsed, now, limit) {
  const items = parsed.items.slice(0, limit);
  for (const item of items) {
    const body = paragraphsOf(item);
    const snippet = (body[0] || '').slice(0, SNIPPET_CHARS);
    await pool.query(
      `INSERT INTO rss_posts (feed_id, guid, title, link, author, snippet, body, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [
        feedId,
        item.guid.slice(0, 512),
        item.title,
        item.link,
        item.author || null,
        snippet || null,
        body.length ? JSON.stringify(body) : null,
        item.date || now,
      ],
    );
  }
}

/** Read posts beyond the newest 200 per feed are pruned. */
async function pruneReadPosts(pool, userId) {
  await pool.query(
    `DELETE FROM rss_posts
     WHERE read_at IS NOT NULL
       AND feed_id IN (SELECT id FROM rss_feeds WHERE user_id = $1)
       AND id IN (
         SELECT id FROM (
           SELECT p.id, row_number() OVER (PARTITION BY p.feed_id ORDER BY p.published_at DESC) AS rank
           FROM rss_posts p
           WHERE p.feed_id IN (SELECT id FROM rss_feeds WHERE user_id = $1) AND p.read_at IS NOT NULL
         ) ranked WHERE rank > $2)`,
    [userId, KEEP_PER_FEED],
  );
}

// ── Demo seeding (staging only) ────────────────────────────────────────────

const DEMO_FEEDS = [
  { key: 'pocketgardens', title: 'Pocket Gardens Weekly', color: 1 },
  { key: 'tinykitchen', title: 'Tiny Kitchen Notes', color: 2 },
  { key: 'orbitdiary', title: 'Orbit Diary', color: 3 },
  { key: 'bicycleshed', title: 'The Bicycle Shed', color: 4 },
  { key: 'papermaps', title: 'Paper Maps Club', color: 5 },
];

const DEMO_POSTS = [
  {
    feed: 'Pocket Gardens Weekly', guid: 'demo-1', minutes: 12, author: 'Fern Example',
    title: 'Growing basil on a windowsill that only gets morning sun',
    link: 'https://pocketgardens.example/posts/basil-morning-sun',
    body: [
      'Three pots, one east window and a lot of patience. Basil wants six hours of light, and an east window gives you about four, so the trick is to make every one of those hours count.',
      'Turn the pots a quarter turn each morning so the stems grow straight. Pinch the top leaves once the plant has three pairs, and it will branch out instead of up.',
      'By week five we had enough for one small, very proud bowl of pesto.',
    ],
  },
  {
    feed: 'Tiny Kitchen Notes', guid: 'demo-2', minutes: 48, author: 'Mira Example',
    title: 'A one-pan lentil soup for small stoves',
    link: 'https://tinykitchen.example/posts/one-pan-lentil-soup',
    body: [
      'Everything happens in a single pot, and it keeps for four days. An onion, two carrots, a cup of red lentils, and whatever spice jar is nearest.',
      'Simmer it for twenty minutes and it thickens on its own. A squeeze of lemon at the end wakes the whole pot up.',
    ],
  },
  {
    feed: 'Orbit Diary', guid: 'demo-3', minutes: 2 * 60, author: 'Sol Example',
    title: 'What a pretend rover would see on a pretend Tuesday',
    link: 'https://orbitdiary.example/posts/pretend-rover-tuesday',
    body: [
      'A made-up log from a made-up planet, written for fun. The dust today was the colour of weak tea, and the hills did their usual trick of looking closer than they are.',
      'The rover would have photographed the same rock three times, because its instructions said so, and we would have called it science.',
    ],
  },
  {
    feed: 'The Bicycle Shed', guid: 'demo-4', minutes: 3 * 60, author: 'Ada Example',
    title: 'Five minutes a week keeps a chain quiet',
    link: 'https://bicycleshed.example/posts/chain-five-minutes',
    body: [
      'Wipe, drip, wait, wipe again. The whole routine fits on a sticky note.',
      'Do it after the Sunday ride, not before the Monday commute, and the chain forgives a lot. Skip three weeks and every pedal click starts to sound like an apology.',
    ],
  },
  {
    feed: 'Pocket Gardens Weekly', guid: 'demo-5', minutes: 5 * 60, author: 'Fern Example',
    title: 'Seed swap letters from readers',
    link: 'https://pocketgardens.example/posts/seed-swap-letters',
    body: [
      'Tomatoes from a balcony, beans from a fire escape, peas from a mailbox.',
      'This month a reader in a flat with one north window grew an entire salad out of stubbornness, and sent seeds to prove it.',
    ],
  },
  {
    feed: 'Paper Maps Club', guid: 'demo-6', minutes: 8 * 60, author: 'Nia Example',
    title: 'Folding a big map back the way it came',
    link: 'https://papermaps.example/posts/folding-big-map',
    body: [
      'The trick is to find the first crease and trust it. Every map folds itself back if you start where the factory started.',
      'Fight the fold and you get a square of paper that refuses every shape. Follow the first crease and it closes like a book.',
    ],
  },
  {
    feed: 'Tiny Kitchen Notes', guid: 'demo-7', minutes: 24 * 60, author: 'Mira Example',
    title: 'Toast, ranked by how loud it crunches',
    link: 'https://tinykitchen.example/posts/toast-ranked',
    body: [
      'An entirely unscientific test with six kinds of bread. Sourdough snapped, rye crackled, and the supermarket white loaf barely whispered.',
      'Loudness is not quality, but it is honest: a loud crunch tells you the bread was alive once.',
    ],
  },
  {
    feed: 'Orbit Diary', guid: 'demo-8', minutes: 27 * 60, author: 'Sol Example',
    title: 'Naming every crater after a sandwich',
    link: 'https://orbitdiary.example/posts/craters-sandwiches',
    body: [
      'The committee could not agree, so we did it ourselves. The big one at the north pole is now the Club Sandwich Crater, and the twin pair are Ham and Cheese.',
      'A future generation of mapmakers will be extremely confused, which we consider part of the fun.',
    ],
  },
  {
    feed: 'The Bicycle Shed', guid: 'demo-9', minutes: 48 * 60, author: 'Ada Example',
    title: 'Picking a bell that sounds friendly, not cross',
    link: 'https://bicycleshed.example/posts/friendly-bell',
    body: [
      'We rang eleven bells at the shop and wrote down how each one felt. Some sound like a polite hello, some like a scolding.',
      'The friendly ones sit in the middle: bright enough to hear over traffic, round enough not to startle the dog on the towpath.',
    ],
  },
  {
    feed: 'Paper Maps Club', guid: 'demo-10', minutes: 72 * 60, author: 'Nia Example',
    title: 'Drawing a map of your own street from memory',
    link: 'https://papermaps.example/posts/street-from-memory',
    body: [
      'Then walk it and see what you forgot. Most people miss the trees.',
      'Everyone remembers the shops and forgets where the pavement ends. The exercise is not about accuracy; it is about noticing what the eye skips.',
    ],
  },
];

/** Seed the staging demo once per user, in one transaction, then report
 * whether this call did the seeding. */
async function seedDemoFor(pool, userId, now) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO rss_demo_seeds (user_id, seeded_at) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING user_id`,
      [userId, now],
    );
    if (!claim.rows.length) {
      await client.query('COMMIT');
      return false;
    }
    const feedIds = {};
    for (const feed of DEMO_FEEDS) {
      const row = await client.query(
        `INSERT INTO rss_feeds (user_id, url, title, site_url, color, is_demo, last_fetched_at, created_at)
         VALUES ($1, $2, $3, $4, $5, true, $6, $6)
         RETURNING id`,
        [userId, `https://${feed.key}.example/feed.xml`, feed.title, `https://${feed.key}.example`, feed.color, now],
      );
      feedIds[feed.title] = row.rows[0].id;
    }
    for (const post of DEMO_POSTS) {
      await client.query(
        `INSERT INTO rss_posts (feed_id, guid, title, link, author, snippet, body, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          feedIds[post.feed],
          post.guid,
          post.title,
          post.link,
          post.author,
          post.body[0].slice(0, SNIPPET_CHARS),
          JSON.stringify(post.body),
          new Date(now.getTime() - post.minutes * 60_000),
        ],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already ended */ }
    throw err;
  } finally {
    client.release();
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

/** The lowest colour of 1 to 6 the user does not use yet, else (count % 6) + 1. */
async function nextColor(pool, userId) {
  const { rows } = await pool.query('SELECT color FROM rss_feeds WHERE user_id = $1', [userId]);
  const used = new Set(rows.map((r) => r.color));
  for (let color = 1; color <= 6; color += 1) {
    if (!used.has(color)) return color;
  }
  return (rows.length % 6) + 1;
}

function mountFeeds(app, pool) {
  app.get('/api/posts', async (req, res, next) => {
    try {
      if (!req.user) {
        res.json({ feeds: [], posts: [], demo: false });
        return;
      }
      const userId = String(req.user.id);
      // Demo rows belong to the ?demo=1 screen only: seed there, and keep
      // them out of every other load of the same viewer's list.
      const withDemo = IS_STAGING && req.query.demo === '1';
      if (withDemo) {
        await seedDemoFor(pool, userId, req.now);
      }
      res.json(await listPayload(pool, userId, withDemo));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/refresh', async (req, res, next) => {
    try {
      if (!req.user) {
        res.json({ feeds: [], posts: [], demo: false, failed: [] });
        return;
      }
      const userId = String(req.user.id);
      const force = Boolean(req.body && req.body.force);
      const staleMinutes = force ? REFRESH_FORCE_MINUTES : REFRESH_STALE_MINUTES;
      const stale = (await pool.query(
        `SELECT id, url, title FROM rss_feeds
         WHERE user_id = $1 AND NOT is_demo
           AND (last_fetched_at IS NULL OR last_fetched_at < $2)
         ORDER BY last_fetched_at NULLS FIRST, id
         LIMIT 40`,
        [userId, new Date(req.now.getTime() - staleMinutes * 60_000)],
      )).rows;
      const failed = [];
      for (let i = 0; i < stale.length; i += REFRESH_BATCH) {
        await Promise.all(stale.slice(i, i + REFRESH_BATCH).map(async (feed) => {
          try {
            const fetched = await safeFetch(feed.url);
            const parsed = parseFeed(fetched.body, fetched.url, req.now);
            await storePosts(pool, feed.id, parsed, req.now, Infinity);
            await pool.query('UPDATE rss_feeds SET last_fetched_at = $2, last_error = NULL WHERE id = $1', [feed.id, req.now]);
          } catch (err) {
            failed.push(feed.title);
            await pool.query('UPDATE rss_feeds SET last_fetched_at = $2, last_error = $3 WHERE id = $1', [feed.id, req.now, fetchErrorSentence(err)]);
          }
        }));
      }
      await pruneReadPosts(pool, userId);
      // The demo screen refreshes in place: pass the demo flag through so
      // its feeds stay in the list (the page's api() adds demo=1 there).
      res.json({
        ...(await listPayload(pool, userId, IS_STAGING && req.query.demo === '1')),
        failed: [...new Set(failed)],
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/feeds', async (req, res, next) => {
    try {
      const userId = String(req.user.id);
      const input = req.body && typeof req.body.url === 'string' ? req.body.url : '';
      let url;
      try {
        url = normalizeUrl(input);
      } catch (err) {
        res.status(400).json({ error: fetchErrorSentence(err) });
        return;
      }
      let fetched;
      let parsed;
      try {
        fetched = await safeFetch(url);
        const contentType = fetched.contentType || '';
        const looksHtml = /text\/html/i.test(contentType) || /^\s*<(?:!doctype|html)\b/i.test(fetched.body);
        if (looksHtml) {
          const found = findFeedLink(fetched.body, fetched.url);
          if (found) fetched = await safeFetch(found);
        }
        parsed = parseFeed(fetched.body, fetched.url, req.now);
      } catch (err) {
        res.status(400).json({ error: fetchErrorSentence(err) });
        return;
      }
      const duplicate = await pool.query('SELECT id FROM rss_feeds WHERE user_id = $1 AND url = $2', [userId, fetched.url]);
      if (duplicate.rows.length) {
        res.status(409).json({ error: 'You already follow this feed' });
        return;
      }
      const color = await nextColor(pool, userId);
      const title = parsed.title || hostOf(fetched.url);
      const feed = (await pool.query(
        `INSERT INTO rss_feeds (user_id, url, title, site_url, color, last_fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, title, url, site_url, color`,
        [userId, fetched.url, title, parsed.siteUrl, color, req.now],
      )).rows[0];
      await storePosts(pool, feed.id, parsed, req.now, MAX_POSTS_AT_ADD);
      const added = (await pool.query('SELECT count(*) FROM rss_posts WHERE feed_id = $1', [feed.id])).rows[0].count;
      res.status(201).json({ feed: feedOut({ ...feed, last_error: null }), added: Number(added) });
    } catch (err) {
      next(err);
    }
  });

  app.delete('/api/feeds/:id', async (req, res, next) => {
    try {
      const removed = await pool.query(
        'DELETE FROM rss_feeds WHERE id = $1 AND user_id = $2 RETURNING id',
        [Number(req.params.id), String(req.user.id)],
      );
      if (!removed.rows.length) {
        res.status(404).json({ error: 'That feed is not in your list.' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/posts/:id', async (req, res, next) => {
    try {
      const row = (await pool.query(
        `SELECT p.id, p.title, p.link, p.author, p.body, p.published_at,
                f.title AS feed_title, f.color, f.site_url
         FROM rss_posts p
         JOIN rss_feeds f ON f.id = p.feed_id
         WHERE p.id = $1 AND f.user_id = $2`,
        [Number(req.params.id), String(req.user.id)],
      )).rows[0];
      if (!row) {
        res.status(404).json({ error: 'That post is not in your list.' });
        return;
      }
      const body = Array.isArray(row.body) ? row.body.filter((p) => typeof p === 'string') : [];
      const link = row.link && /^https?:\/\//i.test(row.link) ? row.link : null;
      const siteHost = hostOf(row.site_url || row.link || '');
      res.json({
        post: {
          id: row.id,
          title: row.title,
          link,
          author: row.author || '',
          body,
          publishedAt: row.published_at,
          feedTitle: row.feed_title,
          color: row.color,
          siteHost,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/posts/read', async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
      if (!ids.length || ids.length > 300) {
        res.status(400).json({ error: 'No posts were named.' });
        return;
      }
      await pool.query(
        `UPDATE rss_posts SET read_at = $3
         WHERE read_at IS NULL AND id = ANY($1::int[])
           AND feed_id IN (SELECT id FROM rss_feeds WHERE user_id = $2)`,
        [ids, String(req.user.id), req.now],
      );
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Unexpected errors: logged, never a stack trace to the user.
  app.use('/api', (err, req, res, next) => {
    console.error(err);
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: SERVER_MESSAGE });
  });
}

module.exports = { migrate, mountFeeds, seedDemoFor };