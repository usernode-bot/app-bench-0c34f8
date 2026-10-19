// Block World — the 3D island and its controls.
//
// Loads the shared world once, then polls for everyone else's changes every
// three seconds. Writes are optimistic: the block appears at once, and goes
// back if the server refuses it.
import * as THREE from '/lib/three.module.js';

const BLOCKS = [
  { id: 'grass', name: 'Grass', rgb: [92, 160, 64] },
  { id: 'dirt', name: 'Dirt', rgb: [134, 96, 60] },
  { id: 'stone', name: 'Stone', rgb: [140, 140, 138] },
  { id: 'oak', name: 'Oak planks', rgb: [176, 128, 72] },
  { id: 'leaves', name: 'Leaves', rgb: [58, 122, 48] },
  { id: 'water', name: 'Water', rgb: [70, 140, 200] },
  { id: 'sand', name: 'Sand', rgb: [225, 205, 140] },
  { id: 'brick', name: 'Brick', rgb: [170, 74, 58] },
];
const BOUND_XZ = 64;
const BOUND_Y = 48;
const POLL_MS = 3000;

const params = new URLSearchParams(location.search);
const TOKEN = params.get('token');
const DEMO = params.get('demo') === '1';

const app = document.querySelector('.app');
const canvas = document.getElementById('world-canvas');
const hotbar = document.getElementById('hotbar');
const blockName = document.getElementById('block-name');
const placedText = document.getElementById('placed-count');
const actionBtn = document.getElementById('action-btn');
const modePlace = document.getElementById('mode-place');
const modeBreak = document.getElementById('mode-break');
const flyUp = document.getElementById('fly-up');
const flyDown = document.getElementById('fly-down');
const buildersText = document.getElementById('builders-text');
const activity = document.getElementById('activity');
const activityText = document.getElementById('activity-text');
const liveLabel = document.getElementById('live-label');
const liveDot = document.getElementById('live-dot');
const demoNote = document.getElementById('demo-note');
const stateEl = document.getElementById('world-state');
const stateTitle = document.getElementById('state-title');
const stateText = document.getElementById('state-text');
const stateRetry = document.getElementById('state-retry');
const statePlace = document.getElementById('state-place');
const saveNote = document.getElementById('save-note');

// ── Three.js scene ───────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 600);
camera.rotation.order = 'YXZ';

let yaw = 0.67;
let pitch = -0.45;
const position = new THREE.Vector3(14, 11, 17);

const hemi = new THREE.HemisphereLight(0xffffff, 0x6b6b6b, 0.7);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(18, 30, 14);
scene.add(sun);

// A box with its top face brightest, so blocks read without textures.
const geometry = new THREE.BoxGeometry(1, 1, 1);
const shades = [0.82, 0.82, 1, 0.62, 0.82, 0.82]; // +x -x +y -y +z -z
const colors = new Float32Array(24 * 3);
for (let face = 0; face < 6; face++) {
  for (let v = 0; v < 4; v++) {
    const i = (face * 4 + v) * 3;
    colors[i] = shades[face];
    colors[i + 1] = shades[face];
    colors[i + 2] = shades[face];
  }
}
geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

const CAPACITY = 4096;
const meshes = BLOCKS.map(b => {
  const material = new THREE.MeshLambertMaterial({
    color: new THREE.Color().setRGB(b.rgb[0] / 255, b.rgb[1] / 255, b.rgb[2] / 255, THREE.SRGBColorSpace),
    vertexColors: true,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, CAPACITY);
  mesh.count = 0;
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
});
// instanceId -> block key, per mesh, rebuilt with the matrices.
const instanceKeys = BLOCKS.map(() => []);
const matrix = new THREE.Matrix4();

function setSky() {
  const [r, g, b] = getComputedStyle(document.documentElement).getPropertyValue('--sky').trim().split(/\s+/).map(Number);
  const color = new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  scene.background = color;
  scene.fog = new THREE.Fog(color, 70, 180);
}
setSky();
window.addEventListener('usernode:theme-changed', setSky);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setSky);

// ── World state ──────────────────────────────────────────────────────────
// Map "x,y,z" -> type index. Everyone in the group shares this world.
const blocks = new Map();
const keyOf = (x, y, z) => `${x},${y},${z}`;

let selected = 3; // Oak planks
let mode = 'place';
let state = 'loading'; // loading | ready | empty | error
let lastSeq = 0;
let myPlaced = 0;
let writeQueue = Promise.resolve();
let pollFailed = false;

function renderWorld() {
  const counts = BLOCKS.map(() => 0);
  for (const [key, type] of blocks) {
    const [x, y, z] = key.split(',').map(Number);
    const index = counts[type]++;
    matrix.makeTranslation(x, y, z);
    meshes[type].setMatrixAt(index, matrix);
    instanceKeys[type][index] = key;
  }
  meshes.forEach((mesh, i) => {
    mesh.count = counts[i];
    mesh.instanceMatrix.needsUpdate = true;
    // The raycast against the blocks uses this to skip the whole mesh.
    mesh.computeBoundingSphere();
  });
}

function applyBlock(x, y, z, type) {
  const key = keyOf(x, y, z);
  if (type === -1) blocks.delete(key);
  else blocks.set(key, type);
  return key;
}

// ── The screen's states ──────────────────────────────────────────────────
function setState(next, message) {
  state = next;
  app.dataset.state = next;
  stateEl.hidden = next === 'ready';
  stateRetry.hidden = next !== 'error';
  statePlace.hidden = next !== 'empty';
  actionBtn.hidden = next !== 'ready';
  stateTitle.hidden = next !== 'empty';
  if (next === 'empty') stateTitle.textContent = 'The island is empty';
  stateText.hidden = next === 'empty';
  stateText.textContent = next === 'loading' ? 'Loading the island' : (message || '');
}

function setPlaced(n) {
  myPlaced = n;
  placedText.textContent = `You have placed ${n} block${n === 1 ? '' : 's'}`;
}

function setCounts(counts) {
  if (!counts) return;
  const n = counts.builders || 0;
  buildersText.textContent = `Starter island, ${n} builder${n === 1 ? '' : 's'}`;
  const names = (counts.active || []).filter(Boolean);
  activity.hidden = names.length === 0;
  activityText.textContent = names.length ? describeActive(names) : '';
  setPlaced(counts.placed || 0);
}

function describeActive(names) {
  if (names.length === 1) return `${names[0]} is building now`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are building now`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are building now`;
}

function setLive(ok) {
  if (ok === !pollFailed) return;
  pollFailed = !ok;
  liveLabel.textContent = ok ? 'Live' : 'Reconnecting';
  liveDot.classList.toggle('dot-warn', !ok);
}

let saveTimer = null;
function noteSaveFailed() {
  saveNote.hidden = false;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNote.hidden = true; }, 5000);
}

// ── Server calls ─────────────────────────────────────────────────────────
function headers(extra) {
  const h = Object.assign({}, extra);
  if (TOKEN) h['x-usernode-token'] = TOKEN;
  try {
    const now = window.usernode && window.usernode.now && window.usernode.now();
    if (now) h['x-usernode-now'] = now instanceof Date ? now.toISOString() : String(now);
  } catch (_) {}
  return h;
}

function apiPath(path) {
  if (!DEMO) return path;
  return path + (path.includes('?') ? '&' : '?') + 'demo=1';
}

async function loadWorld() {
  setState('loading');
  hotbar.innerHTML = BLOCKS.map(() => '<button class="slot" disabled><div class="sw skeleton"></div></button>').join('');
  try {
    const res = await fetch(apiPath('/api/world'), { headers: headers() });
    if (!res.ok) throw new Error(`world ${res.status}`);
    const data = await res.json();
    blocks.clear();
    for (const [x, y, z, type] of data.blocks) {
      if (type >= 0) blocks.set(keyOf(x, y, z), type);
    }
    lastSeq = data.seq || 0;
    setCounts(data);
    demoNote.hidden = !data.demo;
    renderWorld();
    renderHotbar();
    resize();
    setState(blocks.size ? 'ready' : 'empty');
    setLive(true);
  } catch (err) {
    console.error(err);
    renderHotbar();
    setState('error', 'Could not load the world. Check your connection and try again.');
  }
}

async function poll() {
  if (state === 'loading' || state === 'error') return;
  try {
    const res = await fetch(apiPath(`/api/changes?since=${lastSeq}`), { headers: headers() });
    if (!res.ok) throw new Error(`changes ${res.status}`);
    const data = await res.json();
    if (data.more) return loadWorld();
    for (const [x, y, z, type] of data.changes) applyBlock(x, y, z, type);
    lastSeq = data.seq;
    setCounts(data);
    renderWorld();
    if (state === 'empty' && blocks.size) setState('ready');
    if (state === 'ready' && !blocks.size) setState('empty');
    setLive(true);
  } catch (_) {
    setLive(false);
  }
}

function write(method, body) {
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    try {
      const res = await fetch(apiPath('/api/blocks'), {
        method,
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${method} ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error(err);
      throw err;
    }
  });
  return writeQueue;
}

function placeAt(x, y, z) {
  if (Math.abs(x) > BOUND_XZ || Math.abs(z) > BOUND_XZ || Math.abs(y) > BOUND_Y) return;
  const key = keyOf(x, y, z);
  const previous = blocks.has(key) ? blocks.get(key) : null;
  blocks.set(key, selected);
  renderWorld();
  if (state === 'empty') setState('ready');
  write('PUT', { x, y, z, type: BLOCKS[selected].id }).then(() => {
    setPlaced(myPlaced + 1);
  }).catch(() => {
    if (previous === null) blocks.delete(key); else blocks.set(key, previous);
    renderWorld();
    if (!blocks.size) setState('empty');
    noteSaveFailed();
  });
}

function breakAt(x, y, z) {
  const key = keyOf(x, y, z);
  if (!blocks.has(key)) return;
  const previous = blocks.get(key);
  blocks.delete(key);
  renderWorld();
  if (!blocks.size) setState('empty');
  write('DELETE', { x, y, z }).then(() => {
    setPlaced(Math.max(0, myPlaced - 1));
  }).catch(() => {
    blocks.set(key, previous);
    renderWorld();
    if (state === 'empty') setState('ready');
    noteSaveFailed();
  });
}

function useAt(hit) {
  if (!hit) return;
  const { x, y, z, nx, ny, nz } = hit;
  if (mode === 'place') placeAt(x + nx, y + ny, z + nz);
  else breakAt(x, y, z);
}

// ── Aiming and raycasting ────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function pick(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(meshes, false);
  for (const hit of hits) {
    const type = meshes.indexOf(hit.object);
    const key = instanceKeys[type][hit.instanceId];
    if (!key) continue;
    const [x, y, z] = key.split(',').map(Number);
    const n = hit.face ? hit.face.normal : { x: 0, y: 1, z: 0 };
    return { x, y, z, nx: Math.round(n.x), ny: Math.round(n.y), nz: Math.round(n.z) };
  }
  return null;
}

function pickCentre() {
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  const hits = raycaster.intersectObjects(meshes, false);
  for (const hit of hits) {
    const type = meshes.indexOf(hit.object);
    const key = instanceKeys[type][hit.instanceId];
    if (!key) continue;
    const [x, y, z] = key.split(',').map(Number);
    const n = hit.face ? hit.face.normal : { x: 0, y: 1, z: 0 };
    return { x, y, z, nx: Math.round(n.x), ny: Math.round(n.y), nz: Math.round(n.z) };
  }
  return null;
}

// ── Flying and looking ───────────────────────────────────────────────────
const keys = new Set();
let lookPointer = null;
let pinchStart = 0;
const pointers = new Map();
let downAt = null;

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  downAt = { x: e.clientX, y: e.clientY, moved: 0, pointers: pointers.size };
  if (pointers.size === 1) lookPointer = e.pointerId;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
  }
});

canvas.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (downAt) downAt.moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
  if (state !== 'ready' && state !== 'empty') return;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchStart) moveForward((dist - pinchStart) * 0.06);
    pinchStart = dist;
  } else if (lookPointer === e.pointerId) {
    yaw -= (e.clientX - prev.x) * 0.005;
    pitch -= (e.clientY - prev.y) * 0.005;
    pitch = Math.max(-1.45, Math.min(1.45, pitch));
  }
});

function endPointer(e, tap) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinchStart = 0;
  if (lookPointer === e.pointerId) lookPointer = pointers.size ? [...pointers.keys()][0] : null;
  if (tap && downAt && downAt.pointers === 1 && downAt.moved < 8 && (state === 'ready' || state === 'empty')) {
    useAt(pick(e.clientX, e.clientY));
  }
  if (!pointers.size) downAt = null;
}

canvas.addEventListener('pointerup', e => endPointer(e, true));
canvas.addEventListener('pointercancel', e => endPointer(e, false));

function moveForward(distance) {
  const dir = new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation);
  position.addScaledVector(dir, distance);
}

window.addEventListener('keydown', e => {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'a' || k === 's' || k === 'd') { keys.add(k); e.preventDefault(); }
  if (k === ' ') { keys.add('up'); e.preventDefault(); }
  if (k === 'shift') keys.add('down');
  if (k >= '1' && k <= '8') selectBlock(Number(k) - 1);
  if (k === 'enter' && (state === 'ready' || state === 'empty')) useAt(pickCentre());
});
window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (k === 'w' || k === 'a' || k === 's' || k === 'd') keys.delete(k);
  if (k === ' ') keys.delete('up');
  if (k === 'shift') keys.delete('down');
});

function hold(button, on, off) {
  const start = e => { e.preventDefault(); on(); };
  const end = () => off();
  button.addEventListener('pointerdown', start);
  button.addEventListener('pointerup', end);
  button.addEventListener('pointerleave', end);
  button.addEventListener('pointercancel', end);
}

let flying = 0; // -1 down, 0 still, 1 up
hold(flyUp, () => { flying = 1; }, () => { if (flying === 1) flying = 0; });
hold(flyDown, () => { flying = -1; }, () => { if (flying === -1) flying = 0; });

// ── The hotbar and controls ──────────────────────────────────────────────
function renderHotbar() {
  hotbar.innerHTML = BLOCKS.map((b, i) => (
    `<button class="slot${i === selected ? ' sel' : ''}" data-type="${i}" aria-label="${b.name}" aria-pressed="${i === selected}">` +
    `<div class="sw" style="background:rgb(var(--${b.id === 'oak' ? 'wood' : b.id}))"></div></button>`
  )).join('');
  for (const slot of hotbar.querySelectorAll('.slot')) {
    slot.addEventListener('click', () => selectBlock(Number(slot.dataset.type)));
  }
  blockName.textContent = BLOCKS[selected].name;
}

function selectBlock(index) {
  if (index < 0 || index >= BLOCKS.length) return;
  selected = index;
  for (const slot of hotbar.querySelectorAll('.slot')) {
    const on = Number(slot.dataset.type) === index;
    slot.classList.toggle('sel', on);
    slot.setAttribute('aria-pressed', String(on));
  }
  blockName.textContent = BLOCKS[selected].name;
}

function setMode(next) {
  mode = next;
  const place = mode === 'place';
  modePlace.classList.toggle('on', place);
  modeBreak.classList.toggle('on', !place);
  modePlace.setAttribute('aria-pressed', String(place));
  modeBreak.setAttribute('aria-pressed', String(!place));
  actionBtn.textContent = place ? 'Place block' : 'Break block';
}

modePlace.addEventListener('click', () => setMode('place'));
modeBreak.addEventListener('click', () => setMode('break'));
actionBtn.addEventListener('click', () => useAt(pickCentre()));
stateRetry.addEventListener('click', () => { loadWorld(); });
statePlace.addEventListener('click', () => {
  placeAt(0, 0, 0);
  setState('ready');
});

// ── Resize and the frame loop ────────────────────────────────────────────
function resize() {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
window.addEventListener('resize', resize);

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const speed = 14 * dt;
  const forward = new THREE.Vector3(0, 0, -1).applyEuler(camera.rotation);
  const right = new THREE.Vector3(1, 0, 0).applyEuler(camera.rotation);
  const move = new THREE.Vector3();
  if (keys.has('w')) move.add(forward);
  if (keys.has('s')) move.sub(forward);
  if (keys.has('d')) move.add(right);
  if (keys.has('a')) move.sub(right);
  if (keys.has('up')) move.y += 1;
  if (keys.has('down')) move.y -= 1;
  move.addScaledVector(new THREE.Vector3(0, 1, 0), flying);
  if (move.lengthSq()) position.addScaledVector(move.normalize(), speed);
  position.y = Math.max(-60, Math.min(90, position.y));
  camera.position.copy(position);
  camera.rotation.set(pitch, yaw, 0);
  resize();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

renderHotbar();
setMode('place');
setPlaced(0);
requestAnimationFrame(frame);
loadWorld();
setInterval(poll, POLL_MS);
