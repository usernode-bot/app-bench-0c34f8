const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── Club Votes ──────────────────────────────────────────────────────────────
// The decisions board: anyone posts something to decide, everyone votes
// (one vote per person, changeable), comments go under each decision, and
// the poster closes it; the winner then stays visible. Tables decisions,
// decisions_votes and decisions_comments are public; reports (who reported
// what) is not, so nothing is hidden by it and nobody's report is exposed.
const { resource } = require('./kit/server');

const decisions = resource(app, pool, {
  name: 'decisions',
  demo: {
    titles: [
      { title: 'Where should we meet in November?', body: 'The hall is booked for both weeks we tried. Somewhere with parking would help the evening crowd.', options: ['The community hall', "Rowan's place", 'The library room', 'Online'] },
      { title: 'Pick the winter reading list', body: 'Three picks fit between November and February. We read one a month and talk about it at game night.', options: ['The Long Winter', 'Snow Country', 'A Field Guide to Getting Lost'] },
      { title: 'December outing: skating or bowling?', options: ['Skating at the rink', 'Bowling at Rollway Lanes'] },
      { title: 'Move game night to Fridays?', body: 'Thursdays keep clashing with choir practice. Fridays look free for almost everyone who answered last month.', options: ['Yes', 'No'] },
      { title: 'A shorter name for the club?', body: 'The Wednesday Evening Society is a mouthful on posters.', options: ['The Wednesday Club', 'Midweek Society', 'Keep it as it is'] },
      { title: 'June picnic at the meadow again?', body: 'Same spot as last year, or by the pond where the shade is better after lunch.', options: ['Yes', 'No'] },
      { title: 'Snacks rota for the autumn meetings', body: 'One of us brings something each week. Say which week suits you.', options: ['Week 1, November 4', 'Week 2, November 11', 'Week 3, November 18', 'Week 4, November 25'] },
      { title: 'Start meetings at 7 instead of 7:30?', body: 'The room is ours until 9 either way. Starting earlier leaves time for announcements.', options: ['Yes', 'No'] },
      { title: 'What should the winter quiz theme be?', options: ['Films of the nineties', 'Local history', 'Food and drink', 'Sport'] },
      { title: 'A second coffee urn for big nights', body: 'The queue at the last break ran ten minutes. A second urn costs about two weeks of the tea tin.', options: ['Yes', 'No'] },
      { title: 'Who fancies running the February quiz?', body: 'Kemal did the last one brilliantly and has earned a break.', options: ['I will do it', 'I will co-run it', 'Not this time'] },
      { title: 'Keep the noticeboard by the entrance?', body: 'It blocks the light in that corner. The wall by the kitchen is free and more people pass it.', options: ['Yes', 'No'] },
    ],
    bodies: ['Shout if any of this clashes with something you already do that night.', 'Numbers and fine print at the next meeting if you want them.'],
    comments: [
      'I can bring the projector if we end up online.',
      'Parking at the hall is free after six.',
      'The library room shuts at eight, mind.',
      'Skating for me, the lanes booked out on us last time.',
      'Fridays suit me much better.',
      'Happy to host, we have chairs for twelve.',
      'The pond side gets wasps in June, just saying.',
      'I can do week 2, no problem.',
      'A shorter name is overdue, honestly.',
      'Second urn gets my vote, that queue was silly.',
      'Local history, please.',
      'I will co-run the quiz with whoever fancies it.',
    ],
  },
});

// A report records that somebody flagged a decision or a comment. It never
// hides anything and it is not shown to anyone; the club's people look at
// them. No foreign keys: a decision or comment may be gone by the time the
// row is written.
async function migrateReports() {
  await pool.query(`CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY, kind TEXT NOT NULL, target_id INTEGER NOT NULL,
    reporter_id INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL)`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS reports_once_idx ON reports (kind, target_id, reporter_id)');
  await pool.query("COMMENT ON TABLE reports IS 'staging:private'");
}

const NOT_FOUND = 'This was removed, or the link is wrong.';

app.post('/api/reports', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const kind = (req.body || {}).kind;
  const target = Number((req.body || {}).id);
  if ((kind !== 'decision' && kind !== 'comment') || !Number.isInteger(target) || target <= 0) {
    return res.status(400).json({ error: 'Say what you are reporting.' });
  }
  try {
    await pool.query('INSERT INTO reports (kind, target_id, reporter_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [kind, target, req.user.id, req.now]);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'That did not work. Try again in a moment.' });
  }
  return res.status(201).json({ ok: true });
});

// The poster closes a decision. Final: no reopening, and the winning
// option's tally bar segment stays on screen in ink.
app.post('/api/decisions/:id/close', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: NOT_FOUND });
  const { rows } = await pool.query('UPDATE decisions SET closed_at = $3 WHERE id = $1 AND author_id = $2 AND closed_at IS NULL RETURNING id',
    [id, req.user.id, req.now]);
  if (!rows.length) {
    const { rows: existing } = await pool.query('SELECT author_id, closed_at FROM decisions WHERE id = $1', [id]);
    if (!existing.length) return res.status(404).json({ error: NOT_FOUND });
    if (existing[0].author_id !== req.user.id) {
      return res.status(403).json({ error: 'Only the person who posted this can close it.' });
    }
    return res.json({ item: await decisions.one(id, req.user.id) });
  }
  return res.json({ item: await decisions.one(id, req.user.id) });
});

// A comment's own writer may delete it; nobody else can.
app.delete('/api/decisions/:id/comments/:cid', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'account_required' });
  const id = Number(req.params.id);
  const cid = Number(req.params.cid);
  if (!Number.isInteger(id) || !Number.isInteger(cid)) return res.status(404).json({ error: NOT_FOUND });
  const { rows } = await pool.query('SELECT author_id FROM decisions_comments WHERE id = $1 AND item_id = $2', [cid, id]);
  if (!rows.length) return res.status(404).json({ error: NOT_FOUND });
  if (rows[0].author_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the person who wrote a comment can delete it.' });
  }
  await pool.query('DELETE FROM decisions_comments WHERE id = $1', [cid]);
  return res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/club-votes/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/club-votes/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await decisions.migrate();
  await migrateReports();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;

  // The platform stops this container kindly: stop accepting, let the
  // requests already in flight finish (at most a few seconds), close the
  // database pool, and go. A second signal is still answered at once.
  let stopping = false;
  const stop = (signal) => {
    if (stopping) process.exit(0);
    stopping = true;
    console.log(`${signal}: stopping`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
