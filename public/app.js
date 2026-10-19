// Block World — a shared 3D voxel world.
//
// The page is the screen the spec drew: the world fills it, and the palette
// of little 3D cubes, the tools and the move pad sit on top. This module
// draws the world with three.js and keeps it in step with everyone else
// through /api/world and the /api/stream Server-Sent Events.

import * as THREE from '/vendor/three.module.js';

const params = new URLSearchParams(location.search);
const DEMO = params.get('demo') === '1';

// The platform's iframe injects the identity token as ?token=; later calls
// (and a reload that dropped the query) forward it themselves.
let token = params.get('token') || '';
try {
  if (token) sessionStorage.setItem('bw-token', token);
  else token = sessionStorage.getItem('bw-token') || '';
} catch {}

const TYPES = ['grass', 'stone', 'wood', 'glass', 'brick', 'sand'];
const NAMES = {
  grass: 'Grass',
  stone: 'Stone',
  wood: 'Wood',
  glass: 'Glass',
  brick: 'Brick',
  sand: 'Sand',
};
// The materials, from the spec. They do not change between looks: a cube in
// the palette is the block it places.
const MATERIALS = {
  grass: 0x54963e,
  stone: 0x828286,
  wood: 0x966438,
  glass: 0xa0d2e6,
  brick: 0xa64634,
  sand: 0xd8be78,
};
const MAX_BLOCKS = 8192;

const MIN_XZ = -32;
const MAX_XZ = 31;
const MIN_Y = 1;
const MAX_Y = 32;

const el = {
  app: document.getElementById('app'),
  canvas: document.getElementById('world'),
  presence: document.getElementById('presence'),
  presencePill: document.getElementById('presence-pill'),
  tools: document.querySelector('.tools'),
  demoNote: document.getElementById('demo-note'),
  activity: document.getElementById('activity'),
  toolPlace: document.getElementById('tool-place'),
  toolBreak: document.getElementById('tool-break'),
  flyUp: document.getElementById('fly-up'),
  flyDown: document.getElementById('fly-down'),
  stick: document.getElementById('stick'),
  knob: document.getElementById('knob'),
  palette: document.getElementById('palette'),
  palName: document.getElementById('pal-name'),
  palMode: document.getElementById('pal-mode'),
  loadNote: document.getElementById('load-note'),
  emptyNote: document.getElementById('empty-note'),
  conn: document.getElementById('conn'),
  toast: document.getElementById('toast'),
  errorPanel: document.getElementById('error-panel'),
  retry: document.getElementById('retry'),
  noglPanel: document.getElementById('nogl-panel'),
};

const swatches = [...document.querySelectorAll('.sw')];

const blocks = new Map(); // "x,y,z" -> type
let loaded = false;
let failed = false;
let canBuild = false;
let myName = null;
let selected = 'grass';
let tool = 'place';

// ── Small UI helpers ─────────────────────────────────────────────────────
let toastTimer = null;
function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 4000);
}

let tagTimer = null;
function showActivity(message) {
  el.activity.textContent = message;
  el.activity.hidden = false;
  clearTimeout(tagTimer);
  tagTimer = setTimeout(() => { el.activity.hidden = true; }, 4000);
}

function presenceText(names) {
  const list = names.filter(Boolean);
  if (!list.length) return 'Just you';
  if (list.length === 1) return list[0] === myName ? 'Just you' : list[0];
  if (list.length === 2) return list[0] + ' and ' + list[1];
  return list[0] + ', ' + list[1] + ' and ' + (list.length - 2) + ' more';
}

function setPaletteEnabled(on) {
  el.palette.setAttribute('aria-disabled', on ? 'false' : 'true');
  for (const swatch of swatches) swatch.disabled = !on;
}

function selectType(type) {
  selected = type;
  for (const swatch of swatches) {
    const on = swatch.dataset.type === type;
    swatch.classList.toggle('sel', on);
    swatch.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  if (tool === 'place') updatePaletteHeading();
}

function setTool(next) {
  tool = next;
  const placing = next === 'place';
  el.toolPlace.classList.toggle('on', placing);
  el.toolPlace.setAttribute('aria-pressed', placing ? 'true' : 'false');
  el.toolBreak.classList.toggle('on', !placing);
  el.toolBreak.setAttribute('aria-pressed', placing ? 'false' : 'true');
  updatePaletteHeading();
}

function updatePaletteHeading() {
  if (tool === 'place') {
    el.palName.textContent = NAMES[selected];
    el.palMode.textContent = 'Placing';
  } else {
    el.palName.textContent = 'Break';
    el.palMode.textContent = 'Tap a block to remove it';
  }
}

function updateEmptyNote() {
  el.emptyNote.hidden = !(loaded && !failed && blocks.size === 0);
}

// ── The 3D world ─────────────────────────────────────────────────────────
let renderer = null;
let scene = null;
let camera = null;
let ground = null;
let hemi = null;
let sun = null;
const meshes = new Map(); // type -> { mesh, cells }
const meshInfo = new WeakMap();
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const matrix = new THREE.Matrix4();
const clock = new THREE.Clock();

let yaw = 0;
let pitch = -0.22;

function dark() {
  return document.documentElement.classList.contains('dark');
}

function applyLook() {
  if (!hemi || !sun) return;
  hemi.intensity = dark() ? 0.55 : 1.05;
  sun.intensity = dark() ? 0.7 : 1.5;
}

function initWorld() {
  try {
    renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true, alpha: true });
  } catch (err) {
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.setClearColor(0x000000, 0);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 400);
  camera.position.set(6.5, 14, 33);
  camera.rotation.order = 'YXZ';

  hemi = new THREE.HemisphereLight(0xffffff, 0x5a6b4a, 1.05);
  scene.add(hemi);
  sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(30, 55, 20);
  scene.add(sun);

  // The grass plain: 64 by 64, at y = 0. It is always there and cannot be
  // broken.
  // Drawn wider than the 64 by 64 buildable plain so the horizon never shows
  // the plain's edge; placing outside the bounds is refused below.
  ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshLambertMaterial({ color: MATERIALS.grass })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  for (const type of TYPES) {
    const material = new THREE.MeshLambertMaterial({
      color: MATERIALS[type],
      transparent: type === 'glass',
      opacity: type === 'glass' ? 0.45 : 1,
      depthWrite: type !== 'glass',
    });
    const mesh = new THREE.InstancedMesh(geometry, material, MAX_BLOCKS);
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const info = { mesh, cells: [] };
    meshes.set(type, info);
    meshInfo.set(mesh, info);
    scene.add(mesh);
  }

  applyLook();
  new MutationObserver(applyLook).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
  window.addEventListener('usernode:theme-changed', applyLook);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  });

  requestAnimationFrame(tick);
  return true;
}

function keyOf(x, y, z) {
  return x + ',' + y + ',' + z;
}

function renderBlocks() {
  const typed = new Map(TYPES.map((type) => [type, []]));
  for (const [key, type] of blocks) {
    const list = typed.get(type);
    if (list) list.push(key);
  }
  for (const type of TYPES) {
    const info = meshes.get(type);
    const cells = typed.get(type);
    info.cells = cells;
    info.mesh.count = Math.min(cells.length, MAX_BLOCKS);
    for (let i = 0; i < info.mesh.count; i++) {
      const [x, y, z] = cells[i].split(',').map(Number);
      matrix.makeTranslation(x + 0.5, y - 0.5, z + 0.5);
      info.mesh.setMatrixAt(i, matrix);
    }
    info.mesh.instanceMatrix.needsUpdate = true;
    info.mesh.computeBoundingSphere();
  }
}

function inBounds(x, y, z) {
  return x >= MIN_XZ && x <= MAX_XZ && z >= MIN_XZ && z <= MAX_XZ && y >= MIN_Y && y <= MAX_Y;
}

function pickAt(clientX, clientY) {
  const rect = el.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  ndc.set(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const objects = [ground];
  for (const info of meshes.values()) if (info.mesh.count > 0) objects.push(info.mesh);
  const hits = raycaster.intersectObjects(objects, false);
  if (!hits.length) return null;
  const hit = hits[0];

  if (hit.object === ground) {
    const x = Math.floor(hit.point.x);
    const z = Math.floor(hit.point.z);
    return { ground: true, target: { x, y: 1, z } };
  }

  const info = meshInfo.get(hit.object);
  const key = info && info.cells[hit.instanceId];
  if (!key) return null;
  const [x, y, z] = key.split(',').map(Number);
  const normal = hit.face ? hit.face.normal : new THREE.Vector3(0, 1, 0);
  return {
    ground: false,
    hit: { x, y, z },
    target: {
      x: x + Math.round(normal.x),
      y: y + Math.round(normal.y),
      z: z + Math.round(normal.z),
    },
  };
}

async function api(url, options) {
  const headers = Object.assign({}, options && options.headers);
  if (token) headers['x-usernode-token'] = token;
  return fetch(url, Object.assign({}, options, { headers }));
}

function worldUrl() {
  return '/api/world' + (DEMO ? '?demo=1' : '');
}

async function placeAt(x, y, z) {
  if (!canBuild) {
    toast('Sign in to Homeroom to build');
    return;
  }
  if (!inBounds(x, y, z)) return;
  const key = keyOf(x, y, z);
  const previous = blocks.get(key);
  blocks.set(key, selected);
  renderBlocks();
  updateEmptyNote();
  try {
    const res = await api('/api/blocks', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y, z, type: selected }),
    });
    if (!res.ok) throw new Error('not saved');
  } catch {
    if (previous) blocks.set(key, previous);
    else blocks.delete(key);
    renderBlocks();
    updateEmptyNote();
    toast("Couldn't place that block. Try again.");
  }
}

async function breakAt(x, y, z) {
  if (!canBuild) {
    toast('Sign in to Homeroom to build');
    return;
  }
  const key = keyOf(x, y, z);
  const previous = blocks.get(key);
  if (!previous) return;
  blocks.delete(key);
  renderBlocks();
  updateEmptyNote();
  try {
    const res = await api(
      '/api/blocks?x=' + x + '&y=' + y + '&z=' + z,
      { method: 'DELETE' }
    );
    // 404 means it was already gone: the outcome the person asked for.
    if (!res.ok && res.status !== 404) throw new Error('not saved');
  } catch {
    blocks.set(key, previous);
    renderBlocks();
    updateEmptyNote();
    toast("Couldn't break that block. Try again.");
  }
}

function handleTap(clientX, clientY) {
  if (!loaded || failed) return;
  const pick = pickAt(clientX, clientY);
  if (!pick) return;
  if (tool === 'break') {
    if (pick.ground) return;
    breakAt(pick.hit.x, pick.hit.y, pick.hit.z);
  } else {
    placeAt(pick.target.x, pick.target.y, pick.target.z);
  }
}

// ── Look, move, fly ──────────────────────────────────────────────────────
let drag = null;

el.canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== undefined && e.button !== 0) return;
  drag = {
    id: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    lastX: e.clientX,
    lastY: e.clientY,
    moved: false,
    at: performance.now(),
  };
  try { el.canvas.setPointerCapture(e.pointerId); } catch {}
});

el.canvas.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.lastX;
  const dy = e.clientY - drag.lastY;
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 6) drag.moved = true;
  if (!drag.moved) return;
  yaw -= dx * 0.005;
  pitch -= dy * 0.005;
  pitch = Math.max(-1.35, Math.min(1.35, pitch));
});

function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.id)) return;
  const wasTap = !drag.moved && performance.now() - drag.at < 700;
  drag = null;
  if (wasTap && e) handleTap(e.clientX, e.clientY);
}
el.canvas.addEventListener('pointerup', endDrag);
el.canvas.addEventListener('pointercancel', () => { drag = null; });

const keys = new Set();
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', ' ', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);

window.addEventListener('keydown', (e) => {
  const target = e.target;
  if (target && target.closest && target.closest('input,textarea,select')) return;
  const key = e.key.toLowerCase();
  if (MOVE_KEYS.has(key)) {
    keys.add(key);
    if (key === ' ' || key.startsWith('arrow')) e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.key.toLowerCase());
});
window.addEventListener('blur', () => keys.clear());

let flyUpHeld = false;
let flyDownHeld = false;
let flyUpAt = 0;
let flyDownAt = 0;

function holdButton(button, set) {
  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    set(true);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    button.addEventListener(type, () => set(false));
  }
  button.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') set(true);
  });
  button.addEventListener('keyup', () => set(false));
}

holdButton(el.flyUp, (on) => {
  if (on) flyUpAt = performance.now();
  else if (flyUpHeld && performance.now() - flyUpAt < 150) camera.position.y += 1.5;
  flyUpHeld = on;
});
holdButton(el.flyDown, (on) => {
  if (on) flyDownAt = performance.now();
  else if (flyDownHeld && performance.now() - flyDownAt < 150) camera.position.y -= 1.5;
  flyDownHeld = on;
});

// The move pad: the knob follows the finger, and its offset is forward and
// sideways movement.
const stick = { x: 0, y: 0 };
let stickPointer = null;

function moveStick(e) {
  const rect = el.stick.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const radius = rect.width / 2 - 24;
  let dx = e.clientX - cx;
  let dy = e.clientY - cy;
  const length = Math.hypot(dx, dy);
  if (length > radius) {
    dx = (dx / length) * radius;
    dy = (dy / length) * radius;
  }
  el.knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
  stick.x = dx / radius;
  stick.y = -dy / radius;
}

el.stick.addEventListener('pointerdown', (e) => {
  stickPointer = e.pointerId;
  try { el.stick.setPointerCapture(e.pointerId); } catch {}
  moveStick(e);
});
el.stick.addEventListener('pointermove', (e) => {
  if (e.pointerId === stickPointer) moveStick(e);
});
function releaseStick(e) {
  if (e && e.pointerId !== stickPointer) return;
  stickPointer = null;
  stick.x = 0;
  stick.y = 0;
  el.knob.style.transform = '';
}
el.stick.addEventListener('pointerup', releaseStick);
el.stick.addEventListener('pointercancel', releaseStick);

function tick() {
  requestAnimationFrame(tick);
  if (!renderer) return;
  const dt = Math.min(clock.getDelta(), 0.05);

  let forward = 0;
  let right = 0;
  if (keys.has('w') || keys.has('arrowup')) forward += 1;
  if (keys.has('s') || keys.has('arrowdown')) forward -= 1;
  if (keys.has('d') || keys.has('arrowright')) right += 1;
  if (keys.has('a') || keys.has('arrowleft')) right -= 1;
  forward += stick.y;
  right += stick.x;
  const length = Math.hypot(forward, right);
  if (length > 1) {
    forward /= length;
    right /= length;
  }

  const speed = 13;
  camera.position.x += (-Math.sin(yaw) * forward + Math.cos(yaw) * right) * speed * dt;
  camera.position.z += (-Math.cos(yaw) * forward - Math.sin(yaw) * right) * speed * dt;

  let up = 0;
  if (keys.has(' ')) up += 1;
  if (keys.has('shift')) up -= 1;
  if (flyUpHeld) up += 1;
  if (flyDownHeld) up -= 1;
  camera.position.y += up * 9 * dt;

  camera.position.x = Math.max(-40, Math.min(40, camera.position.x));
  camera.position.z = Math.max(-40, Math.min(40, camera.position.z));
  camera.position.y = Math.max(1.6, Math.min(40, camera.position.y));

  camera.rotation.set(pitch, yaw, 0);
  renderer.render(scene, camera);
}

// ── Loading the world ────────────────────────────────────────────────────
function applyWorld(data) {
  blocks.clear();
  if (Array.isArray(data.blocks)) {
    for (const entry of data.blocks) {
      if (!Array.isArray(entry) || entry.length < 4) continue;
      const [x, y, z, type] = entry;
      if (!TYPES.includes(type) || !inBounds(x, y, z)) continue;
      blocks.set(keyOf(x, y, z), type);
    }
  }
  myName = data.you && data.you.name ? data.you.name : null;
  canBuild = Boolean(data.you && data.you.canBuild);
  if (Array.isArray(data.names)) el.presence.textContent = presenceText(data.names);
  if (data.demo === false) {
    el.demoNote.hidden = true;
    el.app.classList.remove('demo');
  }
  renderBlocks();
  updateEmptyNote();
}

function showError() {
  failed = true;
  loaded = false;
  el.loadNote.hidden = true;
  el.emptyNote.hidden = true;
  el.errorPanel.hidden = false;
  el.conn.hidden = true;
  // Nothing else is filled after a failed load.
  el.tools.hidden = true;
  el.stick.hidden = true;
  el.palette.hidden = true;
  el.presencePill.hidden = true;
  setPaletteEnabled(false);
}

async function load() {
  failed = false;
  el.errorPanel.hidden = true;
  el.emptyNote.hidden = true;
  el.loadNote.hidden = false;
  el.tools.hidden = false;
  el.stick.hidden = false;
  el.palette.hidden = false;
  setPaletteEnabled(false);
  try {
    const res = await api(worldUrl());
    if (!res.ok) throw new Error('world read failed');
    const data = await res.json();
    applyWorld(data);
    loaded = true;
    el.loadNote.hidden = true;
    updateEmptyNote();
    setPaletteEnabled(true);
    if (el.presence.textContent) el.presencePill.hidden = false;
  } catch {
    showError();
  }
}

el.retry.addEventListener('click', load);

// ── Everyone else's edits ────────────────────────────────────────────────
let stream = null;
let streamDropped = false;

function connectStream() {
  const query = new URLSearchParams();
  if (token) query.set('token', token);
  if (DEMO) query.set('demo', '1');
  stream = new EventSource('/api/stream?' + query.toString());

  stream.addEventListener('open', () => {
    el.conn.hidden = true;
    const wasDropped = streamDropped;
    streamDropped = false;
    // Back from a drop: refetch the world so nothing built meanwhile is missed.
    if (wasDropped && loaded) load();
  });

  stream.addEventListener('error', () => {
    streamDropped = true;
    if (loaded) el.conn.hidden = false;
  });

  stream.addEventListener('presence', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (Array.isArray(data.names)) {
        el.presence.textContent = presenceText(data.names);
        el.presencePill.hidden = !loaded;
      }
    } catch {}
  });

  stream.addEventListener('set', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    const { x, y, z, type, by } = data;
    if (!TYPES.includes(type) || !inBounds(x, y, z)) return;
    blocks.set(keyOf(x, y, z), type);
    renderBlocks();
    updateEmptyNote();
    if (by && by !== myName) showActivity(by + ' placed ' + NAMES[type].toLowerCase());
  });

  stream.addEventListener('clear', (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    const { x, y, z, type, by } = data;
    const removed = blocks.get(keyOf(x, y, z)) || type;
    blocks.delete(keyOf(x, y, z));
    renderBlocks();
    updateEmptyNote();
    if (by && by !== myName && removed && NAMES[removed]) {
      showActivity(by + ' broke ' + NAMES[removed].toLowerCase());
    }
  });
}

// ── Start ────────────────────────────────────────────────────────────────
for (const swatch of swatches) {
  swatch.addEventListener('click', () => {
    if (swatch.disabled) return;
    selectType(swatch.dataset.type);
    setTool('place');
  });
}
el.toolPlace.addEventListener('click', () => {
  setTool('place');
  toast('Placing ' + NAMES[selected]);
});
el.toolBreak.addEventListener('click', () => setTool('break'));

updatePaletteHeading();

if (!initWorld()) {
  el.noglPanel.hidden = false;
  el.loadNote.hidden = true;
  el.palette.style.display = 'none';
  document.querySelector('.tools').style.display = 'none';
  el.stick.style.display = 'none';
  document.querySelector('.top').hidden = true;
} else {
  load();
  connectStream();
}
