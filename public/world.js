// Block World: a shared voxel island you fly through and build on.
// three.js draws one InstancedMesh per block type; blocks live on the server
// and every client follows the change log with a 3 s poll.
import * as THREE from '/lib/three.module.js';

const TYPES = ['grass', 'dirt', 'stone', 'oak', 'leaves', 'water', 'sand', 'brick'];
// The kit's tokens: oak planks' colour is named --wood.
const TOKENS = ['grass', 'dirt', 'stone', 'wood', 'leaves', 'water', 'sand', 'brick'];
const NAMES = ['Grass', 'Dirt', 'Stone', 'Oak planks', 'Leaves', 'Water', 'Sand', 'Brick'];
const BOUNDS = { xy: 64, yLow: -48, yHigh: 48 };
const POLL_MS = 3000;

const $ = (id) => document.getElementById(id);
const app = $('app');

// ── colours ────────────────────────────────────────────────────────────────
// Block colours come from the kit's tokens (they are the materials, and stay
// the same in both looks); the sky follows the viewer's theme and is re-read
// when the theme changes.
function cssToken(name) {
  return getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim();
}
function tokenColor(name) {
  const v = cssToken(name).split(/\s+/).join(',');
  return new THREE.Color('rgb(' + v + ')');
}
const typeColors = TOKENS.map(t => tokenColor(t));
let skyColor = tokenColor('sky');

// ── scene ──────────────────────────────────────────────────────────────────
const canvas = $('world-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
scene.background = skyColor;
scene.fog = new THREE.Fog(skyColor, 80, 220);
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 500);
camera.rotation.order = 'YXZ';
camera.position.set(0, 18, 30);
let yaw = 0, pitch = -0.45;
const raycaster = new THREE.Raycaster();

function resize() {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// Block geometry: one box whose faces are shaded by vertex colour (top
// brightest, sides a little darker, bottom darkest) so the shapes read
// without textures.
const shade = [0.82, 0.82, 1.0, 0.55, 0.72, 0.72]; // +x -x +y -y +z -z
const geo = new THREE.BoxGeometry(1, 1, 1);
{
  const colors = new Float32Array(24 * 3);
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = (f * 4 + v) * 3;
      colors[i] = colors[i + 1] = colors[i + 2] = shade[f];
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
const material = new THREE.MeshBasicMaterial({ vertexColors: true });
const group = new THREE.Group();
scene.add(group);

// The highlight that shows where a block would be placed or broken.
const highlight = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 1.04, 1.04)),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
);
highlight.visible = false;
scene.add(highlight);

// ── the world ──────────────────────────────────────────────────────────────
const world = new Map(); // "x,y,z" -> type index
const byType = TYPES.map(() => new Map());
const meshes = new Array(TYPES.length).fill(null);

const cellKey = (x, y, z) => x + ',' + y + ',' + z;
const inBounds = (x, y, z) =>
  Math.abs(x) <= BOUNDS.xy && Math.abs(z) <= BOUNDS.xy && y >= BOUNDS.yLow && y <= BOUNDS.yHigh;

function refreshMesh(t) {
  const list = byType[t];
  let mesh = meshes[t];
  const cap = mesh ? mesh.userData.cap : 0;
  if (!mesh || list.size > cap) {
    if (mesh) {
      group.remove(mesh);
      mesh.dispose();
    }
    const newCap = Math.max(256, list.size * 2);
    mesh = new THREE.InstancedMesh(geo, material, newCap);
    mesh.userData.cap = newCap;
    mesh.frustumCulled = false;
    group.add(mesh);
    meshes[t] = mesh;
  }
  const m4 = new THREE.Matrix4();
  let i = 0;
  for (const [key, p] of list) {
    m4.setPosition(p.x + 0.5, p.y + 0.5, p.z + 0.5);
    mesh.setMatrixAt(i, m4);
    mesh.setColorAt(i, typeColors[t]);
    i++;
  }
  mesh.count = i;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

function setBlock(x, y, z, type, defer) {
  const t = TYPES.indexOf(type);
  if (t < 0) return;
  const key = cellKey(x, y, z);
  const prev = world.get(key);
  if (prev === t) return;
  if (prev !== undefined) byType[prev].delete(key);
  world.set(key, t);
  byType[t].set(key, { x, y, z });
  if (!defer) refreshMesh(t);
}
function removeBlock(x, y, z, defer) {
  const key = cellKey(x, y, z);
  const prev = world.get(key);
  if (prev === undefined) return;
  world.delete(key);
  byType[prev].delete(key);
  if (!defer) refreshMesh(prev);
}

// ── API ────────────────────────────────────────────────────────────────────
const pageDemo = new URLSearchParams(location.search).get('demo') === '1';
function apiToken() {
  if (window.usernode && window.usernode.token) return window.usernode.token;
  return new URLSearchParams(location.search).get('token') || '';
}
function api(path, opts = {}) {
  const url = path + (pageDemo ? (path.includes('?') ? '&' : '?') + 'demo=1' : '');
  const headers = { 'content-type': 'application/json', 'x-usernode-token': apiToken() };
  try {
    if (window.usernode && typeof window.usernode.now === 'function') {
      const now = window.usernode.now();
      if (now) headers['x-usernode-now'] = now;
    }
  } catch {}
  return fetch(url, { ...opts, headers }).then(async (r) => {
    if (!r.ok) {
      let body = null;
      try { body = await r.json(); } catch {}
      const err = new Error('HTTP ' + r.status);
      err.status = r.status;
      err.body = body;
      throw err;
    }
    return r.json();
  });
}

// ── UI wiring ──────────────────────────────────────────────────────────────
let selected = 0;
let mode = 'place';
let placed = 0;
let seq = 0;
let loaded = false;

const slots = Array.from(document.querySelectorAll('#hotbar .slot'));
slots.forEach((slot, i) => {
  slot.addEventListener('click', () => selectSlot(i));
});
function selectSlot(i) {
  selected = i;
  slots.forEach((s, j) => s.classList.toggle('sel', j === i));
  $('block-name').textContent = NAMES[i];
}
selectSlot(3); // Oak planks, as the spec's screen draws it

$('mode-place').addEventListener('click', () => setMode('place'));
$('mode-break').addEventListener('click', () => setMode('break'));
function setMode(m) {
  mode = m;
  $('mode-place').classList.toggle('on', m === 'place');
  $('mode-break').classList.toggle('on', m === 'break');
  $('action-btn').textContent = m === 'place' ? 'Place block' : 'Break block';
}

function updatePlaced() {
  $('placed-line').textContent = 'You have placed ' + placed + ' block' + (placed === 1 ? '' : 's');
}
function updateCounts(data) {
  $('builders-line').textContent = 'Starter island, ' + data.builders + ' builder' + (data.builders === 1 ? '' : 's');
  placed = data.me.placed;
  updatePlaced();
  $('demo-line').hidden = !data.demo;
  const names = data.active;
  const near = $('near-pill');
  if (names.length) {
    near.hidden = false;
    $('near-text').textContent =
      names.length === 1 ? names[0] + ' is building now'
        : names.length === 2 ? names[0] + ' and ' + names[1] + ' are building now'
          : names.slice(0, 2).join(', ') + ' and ' + (names.length - 2) + ' more are building now';
  } else {
    near.hidden = true;
  }
}
function setLive(ok) {
  $('live-text').textContent = ok ? 'Live' : 'Reconnecting';
}
let noteTimer = null;
function showNote() {
  $('save-note').hidden = false;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { $('save-note').hidden = true; }, 3000);
}
function showEmpty() {
  app.classList.toggle('is-empty', loaded && world.size === 0);
}

// ── actions ────────────────────────────────────────────────────────────────
function doPlace(x, y, z) {
  if (!inBounds(x, y, z) || world.has(cellKey(x, y, z))) return;
  const type = TYPES[selected];
  setBlock(x, y, z, type);
  api('/api/blocks', { method: 'PUT', body: JSON.stringify({ x, y, z, type }) })
    .then(() => { placed += 1; updatePlaced(); showEmpty(); })
    .catch(() => {
      removeBlock(x, y, z);
      showNote();
    });
}
function doBreak(x, y, z) {
  const key = cellKey(x, y, z);
  if (!world.has(key)) return;
  const prev = world.get(key);
  removeBlock(x, y, z);
  api('/api/blocks', { method: 'DELETE', body: JSON.stringify({ x, y, z }) })
    .catch(() => {
      setBlock(x, y, z, TYPES[prev]);
      showNote();
    });
}
function act(cell) {
  if (mode === 'place') doPlace(cell.x, cell.y, cell.z);
  else doBreak(cell.x, cell.y, cell.z);
}

$('action-btn').addEventListener('click', () => {
  const cell = aim();
  if (cell) act(cell);
});
$('empty-place').addEventListener('click', () => doPlace(0, 0, 0));
$('retry-btn').addEventListener('click', loadWorld);

// ── flying ─────────────────────────────────────────────────────────────────
const keys = {};
window.addEventListener('keydown', (e) => {
  if (e.key >= '1' && e.key <= '8') selectSlot(Number(e.key) - 1);
  keys[e.code] = true;
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

const fly = { up: false, down: false };
function bindHold(id, on, off) {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); on(); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
    el.addEventListener(ev, off));
}
bindHold('fly-up', () => { fly.up = true; }, () => { fly.up = false; });
bindHold('fly-down', () => { fly.down = true; }, () => { fly.down = false; });

const pointers = new Map();
let pinchDist = 0;
function pointerNdc(e) {
  const r = canvas.getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1,
  );
}
canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  pointers.set(e.pointerId, {
    x: e.clientX, y: e.clientY,
    sx: e.clientX, sy: e.clientY,
    t: performance.now(),
  });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
  }
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  if (pointers.size === 1) {
    yaw -= (e.clientX - p.x) * 0.005;
    pitch = Math.max(-1.5, Math.min(1.5, pitch - (e.clientY - p.y) * 0.005));
  } else if (pointers.size === 2) {
    p.x = e.clientX; p.y = e.clientY;
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist) {
      const dir = camera.getWorldDirection(new THREE.Vector3());
      camera.position.addScaledVector(dir, (d - pinchDist) * 0.06);
    }
    pinchDist = d;
    return;
  }
  p.x = e.clientX; p.y = e.clientY;
});
canvas.addEventListener('pointerup', (e) => {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (!p || pointers.size) return;
  const moved = Math.hypot(e.clientX - p.sx, e.clientY - p.sy);
  const held = performance.now() - p.t;
  if (moved < 8 && held < 400) {
    raycaster.setFromCamera(pointerNdc(e), camera);
    const hit = firstHit();
    if (hit) act(mode === 'place' ? hit.target : hit.cell);
  }
});
['pointercancel', 'pointerleave'].forEach(ev =>
  canvas.addEventListener(ev, (e) => pointers.delete(e.pointerId)));

// ── aiming ─────────────────────────────────────────────────────────────────
function firstHit(ndc) {
  if (ndc) raycaster.setFromCamera(ndc, camera);
  else raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hits = raycaster.intersectObjects(group.children, false);
  for (const h of hits) {
    if (h.instanceId === undefined || !h.face) continue;
    const n = h.face.normal; // translation-only instance matrices: world == local
    const p = h.point;
    const cell = {
      x: Math.floor(p.x - n.x * 0.5),
      y: Math.floor(p.y - n.y * 0.5),
      z: Math.floor(p.z - n.z * 0.5),
    };
    // place-mode target: the face's neighbour
    const target = {
      x: cell.x + Math.round(n.x),
      y: cell.y + Math.round(n.y),
      z: cell.z + Math.round(n.z),
    };
    return { cell, target, type: meshes.indexOf(h.object) };
  }
  return null;
}
function aim() {
  const hit = firstHit();
  if (!hit) return null;
  return mode === 'place' ? hit.target : hit.cell;
}

// ── loading and polling ────────────────────────────────────────────────────
async function loadWorld() {
  app.classList.add('is-loading');
  app.classList.remove('is-error');
  $('error').hidden = true;
  $('loading').hidden = false;
  try {
    const data = await api('/api/world');
    world.clear();
    byType.forEach(m => m.clear());
    for (const [x, y, z, t] of data.blocks) {
      if (t >= 0 && t < TYPES.length) setBlock(x, y, z, TYPES[t], true);
    }
    TYPES.forEach((_, t) => refreshMesh(t));
    seq = data.seq;
    loaded = true;
    updateCounts(data);
    $('loading').hidden = true;
    app.classList.remove('is-loading');
  } catch (err) {
    app.classList.remove('is-loading');
    app.classList.add('is-error');
    $('loading').hidden = true;
    $('error').hidden = false;
  }
  showEmpty();
}

function applyChange(c) {
  if (c.type === null || c.type < 0) removeBlock(c.x, c.y, c.z);
  else setBlock(c.x, c.y, c.z, TYPES[c.type]);
}

let polling = false;
async function poll() {
  if (polling || !loaded) return;
  polling = true;
  try {
    const data = await api('/api/changes?since=' + seq);
    if (data.full) {
      await loadWorld();
    } else {
      for (const c of data.changes) applyChange(c);
      seq = data.seq;
      updateCounts(data);
    }
    setLive(true);
  } catch {
    setLive(false); // building still works; the pill says Reconnecting
  } finally {
    polling = false;
  }
}
setInterval(poll, POLL_MS);

// ── theme and frame loop ───────────────────────────────────────────────────
function applySky() {
  skyColor = tokenColor('sky');
  scene.background = skyColor;
  scene.fog.color.set(skyColor);
}
window.addEventListener('usernode:theme-changed', applySky);

const clock = new THREE.Clock();
const SPEED = 14;
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  camera.rotation.set(pitch, yaw, 0);
  const move = new THREE.Vector3();
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  if (keys.KeyW || keys.ArrowUp) move.addScaledVector(fwd, 1);
  if (keys.KeyS || keys.ArrowDown) move.addScaledVector(fwd, -1);
  if (keys.KeyA || keys.ArrowLeft) move.addScaledVector(right, -1);
  if (keys.KeyD || keys.ArrowRight) move.addScaledVector(right, 1);
  if (keys.Space || fly.up) move.y += 1;
  if (keys.ShiftLeft || keys.ShiftRight || fly.down) move.y -= 1;
  if (move.lengthSq() > 0) {
    move.normalize().multiplyScalar(SPEED * dt);
    camera.position.add(move);
    camera.position.x = Math.max(-BOUNDS.xy - 1, Math.min(BOUNDS.xy + 1, camera.position.x));
    camera.position.z = Math.max(-BOUNDS.xy - 1, Math.min(BOUNDS.xy + 1, camera.position.z));
    camera.position.y = Math.max(BOUNDS.yLow + 1, Math.min(BOUNDS.yHigh, camera.position.y));
  }
  const hit = firstHit();
  let mark = null;
  if (hit) {
    const t = mode === 'place' ? hit.target : hit.cell;
    if (inBounds(t.x, t.y, t.z) && (mode === 'break' ? world.has(cellKey(t.x, t.y, t.z)) : !world.has(cellKey(t.x, t.y, t.z)))) {
      mark = t;
    }
  }
  if (mark) {
    highlight.visible = true;
    highlight.position.set(mark.x + 0.5, mark.y + 0.5, mark.z + 0.5);
  } else {
    highlight.visible = false;
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

loadWorld().then(() => tick());