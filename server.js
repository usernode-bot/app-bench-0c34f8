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

// ── Saved recipes ─────────────────────────────────────────────────────────
// A saved recipe is just the four settings plus a name; the formula itself
// is never stored, it is recomputed from them every time it is shown. The
// table carries the five breads by key (public/formulas.js is the source of
// truth for the labels and ranges; the map below is kept in sync by hand).
const BREAD_KEYS = new Set(['sourdough', 'bagels', 'sourdoughBagels', 'rye', 'sandwich']);
const BREAD_LABELS = {
  sourdough: 'Sourdough',
  bagels: 'Bagels',
  sourdoughBagels: 'Sourdough bagels',
  rye: 'Rye',
  sandwich: 'Sandwich loaf',
};
const UNITS = {
  sourdough: ['loaf', 'loaves'],
  bagels: ['bagel', 'bagels'],
  sourdoughBagels: ['bagel', 'bagels'],
  rye: ['loaf', 'loaves'],
  sandwich: ['loaf', 'loaves'],
};
// Flour per piece: loaves 200–1500 by 50, bagels 50–200 by 10.
function flourOk(bread, v) {
  if (!Number.isInteger(v)) return false;
  if (bread === 'bagels' || bread === 'sourdoughBagels') {
    return v >= 50 && v <= 200 && (v - 50) % 10 === 0;
  }
  return v >= 200 && v <= 1500 && (v - 200) % 50 === 0;
}

// Recipes are staging:private: real user data in production, and nothing
// leaves staging. In staging the demo flag fills the list with six
// viewer-owned example rows so the populated screen can be seen.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_recipes (
      id serial PRIMARY KEY,
      user_id text NOT NULL,
      name text NOT NULL,
      bread text NOT NULL,
      hydration integer NOT NULL,
      count integer NOT NULL,
      flour_per_piece integer NOT NULL,
      is_demo boolean NOT NULL DEFAULT false,
      demo_key text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS saved_recipes_user_demo_key ON saved_recipes (user_id, demo_key)');
  await pool.query('CREATE INDEX IF NOT EXISTS saved_recipes_user_created ON saved_recipes (user_id, created_at)');
  await pool.query("COMMENT ON TABLE saved_recipes IS 'staging:private'");
}

// Six example rows, idempotent per viewer, newest last so the offsets below
// land them in a stable order.
const DEMO_RECIPES = [
  { demo_key: 'demo-big-batch-sourdough', name: 'Big batch sourdough', bread: 'sourdough', hydration: 72, count: 4, flour_per_piece: 500, daysAgo: 1 },
  { demo_key: 'demo-sunday-bagels', name: 'Sunday bagels', bread: 'bagels', hydration: 58, count: 8, flour_per_piece: 100, daysAgo: 2 },
  { demo_key: 'demo-weekend-rye', name: 'Weekend rye', bread: 'rye', hydration: 78, count: 2, flour_per_piece: 500, daysAgo: 3 },
  { demo_key: 'demo-overnight-bagels', name: 'Overnight sourdough bagels', bread: 'sourdoughBagels', hydration: 58, count: 6, flour_per_piece: 75, daysAgo: 5 },
  { demo_key: 'demo-school-lunch-loaf', name: 'School lunch loaf', bread: 'sandwich', hydration: 65, count: 2, flour_per_piece: 500, daysAgo: 7 },
  { demo_key: 'demo-rye-freezer', name: 'Rye for the freezer', bread: 'rye', hydration: 78, count: 3, flour_per_piece: 500, daysAgo: 12 },
];

async function ensureDemoRecipes(req) {
  for (const d of DEMO_RECIPES) {
    await pool.query(
      `INSERT INTO saved_recipes (user_id, name, bread, hydration, count, flour_per_piece, is_demo, demo_key, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
       ON CONFLICT (user_id, demo_key) DO NOTHING`,
      [req.user.id, d.name, d.bread, d.hydration, d.count, d.flour_per_piece, d.demo_key,
        new Date(req.now.getTime() - d.daysAgo * 86400000)]
    );
  }
}

const LIST_COLUMNS = 'id, name, bread, hydration, count, flour_per_piece, is_demo, created_at';

// Guests may look at the calculator but have nothing saved (nothing can be,
// writes need an account): an empty list, not an error.
app.get('/api/recipes', async (req, res) => {
  if (!req.user) return res.json([]);
  try {
    const withDemo = IS_STAGING && req.query.demo === '1';
    if (withDemo) await ensureDemoRecipes(req);
    const rows = await pool.query(
      `SELECT ${LIST_COLUMNS} FROM saved_recipes
       WHERE user_id = $1 AND ($2::boolean OR NOT is_demo)
       ORDER BY created_at DESC, id DESC`,
      [req.user.id, withDemo]
    );
    res.json(rows.rows);
  } catch (err) {
    console.error('GET /api/recipes failed: ' + err.message);
    res.status(500).json({ error: 'Could not load saved recipes' });
  }
});

app.post('/api/recipes', async (req, res) => {
  const b = req.body || {};
  const bread = b.bread;
  const hydration = b.hydration;
  const count = b.count;
  const flour = b.flour_per_piece;
  if (typeof bread !== 'string' || !BREAD_KEYS.has(bread)) {
    return res.status(400).json({ error: 'Unknown bread' });
  }
  if (!Number.isInteger(hydration) || hydration < 50 || hydration > 85) {
    return res.status(400).json({ error: 'Hydration must be between 50 and 85' });
  }
  if (!Number.isInteger(count) || count < 1 || count > 24) {
    return res.status(400).json({ error: 'Count must be between 1 and 24' });
  }
  if (!flourOk(bread, flour)) {
    return res.status(400).json({ error: 'Flour per piece is out of range' });
  }
  let name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) {
    // "Sourdough, 2 loaves" — the same auto-name the page would show.
    const unit = UNITS[bread];
    name = BREAD_LABELS[bread] + ', ' + count + ' ' + (count === 1 ? unit[0] : unit[1]);
  }
  name = name.slice(0, 60);
  try {
    const row = await pool.query(
      `INSERT INTO saved_recipes (user_id, name, bread, hydration, count, flour_per_piece, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${LIST_COLUMNS}`,
      [req.user.id, name, bread, hydration, count, flour, req.now]
    );
    res.status(201).json(row.rows[0]);
  } catch (err) {
    console.error('POST /api/recipes failed: ' + err.message);
    res.status(500).json({ error: 'Could not save the recipe' });
  }
});

app.delete('/api/recipes/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const out = await pool.query('DELETE FROM saved_recipes WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (out.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/recipes failed: ' + err.message);
    res.status(500).json({ error: 'Could not delete the recipe' });
  }
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

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
      return res.redirect(302, PLATFORM_ORIGIN + '/app/bread-bot/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/bread-bot/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await migrate();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
  // Finish in-flight requests and release the pool before the container
  // goes, instead of leaving the platform to kill the process mid-request.
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => { console.error(err); process.exit(1); });
