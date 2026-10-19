/* Block World client: three.js scene, fly controls, optimistic edits,
   Server-Sent Events for other people's blocks. */
import * as THREE from '/vendor/three.module.js';

const params = new URLSearchParams(location.search);
const TOKEN = params.get('token') || '';
const DEMO = params.get('demo') === '1';
const authHeaders = TOKEN ? { 'x-usernode-token': TOKEN } : {};

const TYPES = ['grass', 'stone', 'wood', 'glass', 'brick', 'sand'];
const NAMES = { grass: 'Grass', stone: 'Stone', wood: 'Wood', glass: 'Glass', brick: 'Brick', sand: 'Sand' };
// The materials never change between looks (CLAUDE.md "Design").
const COLORS = {
  grass: 0x54963e, stone: 0x828286, wood: 0x966438,
  glass: 0xa0d2e6, brick: 0xa64634, sand: 0xd8be78,
};

const inBounds = (x, y, z) => x >= -32 && x <= 31 && z >= -32 && z <= 31 && y >= 1 && y <= 32;
const key3 = (x, y, z) => x + ',' + y + ',' + z;

const $ = (id) => document.getElementById(id);
const el = {
  touch: $('touch'), canvas: $('world'), here: $('here'),
  loading: $('loading'), empty: $('empty'), error: $('state-error'),
  webgl: $('state-webgl'), retry: $('retry'), editFail: $('edit-fail'),
  guest: $('guest-note'), builder: $('builder-note'), reconnect: $('reconnect-note'),
  toolPlace: $('tool-place'), toolBreak: $('tool-break'),
  palName: $('pal-name'), palMode: $('pal-mode'), palette: $('palette'),
  stick: $('stick'), knob: $('knob'),
};
const show = (e) => { e.hidden = false; };
const hide = (e) => { e.hidden = true; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// Pointer capture can refuse a synthetic pointer (an automated check, a
// test dispatch); a failed capture never means anything to a real drag.
const capture = (e, target) => { try { target.setPointerCapture(e.pointerId); } catch {} };

// ── State ────────────────────────────────────────────────────────────────
const blocks = new Map(); // "x,y,z" -> type
let myName = null;        // from /api/world (`you`); null when signed out
let loaded = false;
let mode = 'place';
let selected = 'grass';
let meshes = {};          // type -> InstancedMesh
let cellsByType = {};     // type -> ["x,y,z", ...] in instance order

const signedIn = () => !!myName;

// ── World data ───────────────────────────────────────────────────────────
async function loadWorld() {
  hide(el.error);
  show(el.loading);
  try {
    const r = await fetch('/api/world' + (DEMO ? '?demo=1' : ''), { headers: authHeaders });
    if (!r.ok) throw new Error('world failed');
    const data = await r.json();
    myName = data.you || null;
    blocks.clear();
    for (const [x, y, z, type] of data.blocks || []) blocks.set(key3(x, y, z), type);
    setHere(data.here || []);
    rebuild();
    loaded = true;
    hide(el.loading);
    el.palette.querySelectorAll('.sw').forEach((b) => (b.disabled = false));
    updateEmpty();
  } catch {
    loaded = false;
    hide(el.loading);
    show(el.error);
  }
}
el.retry.addEventListener('click', loadWorld);

function updateEmpty() {
  if (loaded && blocks.size === 0) show(el.empty);
  else hide(el.empty);
}

// ── 3D scene ─────────────────────────────────────────────────────────────
const gl = el.canvas.getContext('webgl2') || el.canvas.getContext('webgl');
let renderer = null;
let scene, camera, ground, hemi, sun;
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const materials = {};
for (const t of TYPES) {
  materials[t] = new THREE.MeshLambertMaterial({
    color: COLORS[t],
    transparent: t === 'glass',
    opacity: t === 'glass' ? 0.6 : 1,
  });
}

if (!gl) {
  hide(el.loading);
  show(el.webgl);
} else {
  renderer = new THREE.WebGLRenderer({ canvas: el.canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0); // the sky is the page's own gradient
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, 1, 0.1, 400);
  camera.rotation.order = 'YXZ';

  hemi = new THREE.HemisphereLight(0xffffff, 0x9c8f80, 1.5);
  sun = new THREE.DirectionalLight(0xffffff, 2.4);
  sun.position.set(25, 50, 35); // from behind the camera, so faces you see are lit
  scene.add(hemi, sun);

  ground = new THREE.Mesh(
    new THREE.PlaneGeometry(64, 64),
    new THREE.MeshLambertMaterial({ color: COLORS.grass })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.userData.ground = true;
  scene.add(ground);

  // The dark look dims the sunlight on the blocks; the sky itself is CSS.
  // three.js r155+ uses physical light units: a Lambert face's brightness is
  // intensity/π, so these are the old values ×π — enough that a lit block's
  // colour matches its palette swatch.
  const applyLook = () => {
    const dark = document.documentElement.classList.contains('dark');
    sun.intensity = dark ? 1.1 : 2.4;
    hemi.intensity = dark ? 0.7 : 1.5;
  };
  new MutationObserver(applyLook).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  applyLook();

  function resize() {
    const w = el.touch.clientWidth || window.innerWidth;
    const h = el.touch.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();
}

function rebuild() {
  if (!renderer) return;
  const m = new THREE.Matrix4();
  for (const t of TYPES) {
    if (meshes[t]) {
      scene.remove(meshes[t]);
      meshes[t].dispose();
    }
    const list = [];
    for (const [k, type] of blocks) if (type === t) list.push(k);
    cellsByType[t] = list;
    const mesh = new THREE.InstancedMesh(boxGeo, materials[t], Math.max(list.length, 1));
    mesh.count = list.length;
    mesh.userData.type = t;
    list.forEach((k, i) => {
      const [x, y, z] = k.split(',').map(Number);
      m.setPosition(x + 0.5, y - 0.5, z + 0.5); // cell y=1 sits on the plain
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    meshes[t] = mesh;
    scene.add(mesh);
  }
}

// ── Look and move ────────────────────────────────────────────────────────
const pos = new THREE.Vector3(2, 8, 44); // back and above the path, the builds in view, the viewer's wall in the foreground
let yaw = 0, pitch = -0.22;

let lookLast = null, dragged = false;
el.touch.addEventListener('pointerdown', (e) => {
  if (!loaded) return;
  lookLast = { x: e.clientX, y: e.clientY };
  dragged = false;
  capture(e, el.touch);
});
el.touch.addEventListener('pointermove', (e) => {
  if (!lookLast) return;
  const dx = e.clientX - lookLast.x, dy = e.clientY - lookLast.y;
  if (!dragged && Math.abs(dx) + Math.abs(dy) > 6) dragged = true;
  if (dragged) {
    yaw -= dx * 0.006;
    pitch = clamp(pitch - dy * 0.006, -1.4, 1.4);
    lookLast = { x: e.clientX, y: e.clientY };
  }
});
const endLook = (e) => {
  if (lookLast && !dragged) tap(e);
  lookLast = null;
};
el.touch.addEventListener('pointerup', endLook);
el.touch.addEventListener('pointercancel', () => { lookLast = null; });

// On a pointer device with a keyboard (a computer) WASD moves you, so the
// pad would only cover the world: hide it. A touch screen keeps the pad.
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const applyPad = () => { el.stick.hidden = finePointer.matches; };
applyPad();
if (finePointer.addEventListener) finePointer.addEventListener('change', applyPad);

// Move pad: a small joystick, drag the knob.
let moveVec = { x: 0, y: 0 };
let stickId = null;
el.stick.addEventListener('pointerdown', (e) => {
  stickId = e.pointerId;
  capture(e, el.stick);
  moveStick(e);
});
el.stick.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) moveStick(e); });
const endStick = () => { stickId = null; moveVec = { x: 0, y: 0 }; el.knob.style.transform = ''; };
el.stick.addEventListener('pointerup', endStick);
el.stick.addEventListener('pointercancel', endStick);
function moveStick(e) {
  const r = el.stick.getBoundingClientRect();
  let dx = e.clientX - (r.left + r.width / 2);
  let dy = e.clientY - (r.top + r.height / 2);
  const max = r.width / 2 - 24;
  const len = Math.hypot(dx, dy);
  if (len > max) { dx = (dx / len) * max; dy = (dy / len) * max; }
  el.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  moveVec = { x: dx / max, y: dy / max };
}

// Fly up / down: hold the button.
let flyHold = null;
function hold(elBtn, dir) {
  elBtn.addEventListener('pointerdown', (e) => {
    flyHold = dir;
    capture(e, elBtn);
  });
  elBtn.addEventListener('pointerup', () => { flyHold = null; });
  elBtn.addEventListener('pointercancel', () => { flyHold = null; });
}
hold($('fly-up'), 'up');
hold($('fly-down'), 'down');

const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

let last = performance.now();
function tick(now) {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (renderer) {
    let f = 0, s = 0;
    if (keys.KeyW || keys.ArrowUp) f += 1;
    if (keys.KeyS || keys.ArrowDown) f -= 1;
    if (keys.KeyA || keys.ArrowLeft) s -= 1;
    if (keys.KeyD || keys.ArrowRight) s += 1;
    f += -moveVec.y;
    s += moveVec.x;
    const len = Math.hypot(f, s);
    if (len > 1) { f /= len; s /= len; }
    const sp = 8 * dt;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    pos.x = clamp(pos.x + (fx * f + rx * s) * sp, -48, 48);
    pos.z = clamp(pos.z + (fz * f + rz * s) * sp, -48, 48);
    let vy = 0;
    if (keys.Space || flyHold === 'up') vy += 1;
    if (keys.ShiftLeft || keys.ShiftRight || flyHold === 'down') vy -= 1;
    pos.y = clamp(pos.y + vy * 6 * dt, 1, 48);
    camera.position.copy(pos);
    camera.rotation.set(pitch, yaw, 0);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ── Place and break ──────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let noteTimer = null, guestTimer = null;

function note(e, text, ms) {
  e.textContent = text;
  show(e);
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => hide(e), ms);
}

function tap(e) {
  if (!loaded || !renderer) return;
  const r = el.touch.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const pickables = [ground, ...TYPES.map((t) => meshes[t]).filter(Boolean)];
  const hits = raycaster.intersectObjects(pickables, false);
  if (!hits.length) return;
  if (!signedIn()) {
    clearTimeout(guestTimer);
    show(el.guest);
    guestTimer = setTimeout(() => hide(el.guest), 3000);
    return;
  }
  const h = hits[0];
  if (mode === 'break') {
    if (h.object === ground) return; // the plain itself stays
    breakCell(cellsByType[h.object.userData.type][h.instanceId]);
    return;
  }
  let x, y, z;
  if (h.object === ground) {
    x = Math.floor(h.point.x); y = 1; z = Math.floor(h.point.z);
  } else {
    const [bx, by, bz] = cellsByType[h.object.userData.type][h.instanceId].split(',').map(Number);
    const n = h.face.normal;
    x = bx + Math.round(n.x); y = by + Math.round(n.y); z = bz + Math.round(n.z);
  }
  if (!inBounds(x, y, z)) return;
  if (blocks.get(key3(x, y, z)) === selected) return;
  placeCell(x, y, z);
}

function placeCell(x, y, z) {
  const k = key3(x, y, z);
  const prev = blocks.has(k) ? blocks.get(k) : null;
  blocks.set(k, selected);
  rebuild();
  updateEmpty();
  fetch('/api/blocks' + (DEMO ? '?demo=1' : ''), {
    method: 'PUT',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ x, y, z, type: selected }),
  }).then(async (r) => {
    if (!r.ok) throw new Error('save failed');
  }).catch(() => {
    if (prev === null) blocks.delete(k); else blocks.set(k, prev);
    rebuild();
    updateEmpty();
    note(el.editFail, "Couldn't place that block. Try again.", 3000);
  });
}

function breakCell(k) {
  const [x, y, z] = k.split(',').map(Number);
  const prev = blocks.get(k);
  blocks.delete(k);
  rebuild();
  updateEmpty();
  const q = 'x=' + x + '&y=' + y + '&z=' + z + (DEMO ? '&demo=1' : '');
  fetch('/api/blocks?' + q, { method: 'DELETE', headers: authHeaders })
    .then(async (r) => {
      if (!r.ok) throw new Error('break failed');
    }).catch(() => {
      blocks.set(k, prev);
      rebuild();
      updateEmpty();
      note(el.editFail, "Couldn't break that block. Try again.", 3000);
    });
}

// ── Tools and palette ────────────────────────────────────────────────────
function setMode(m) {
  mode = m;
  el.toolPlace.classList.toggle('on', m === 'place');
  el.toolBreak.classList.toggle('on', m === 'break');
  el.toolPlace.setAttribute('aria-pressed', m === 'place');
  el.toolBreak.setAttribute('aria-pressed', m === 'break');
  if (m === 'break') {
    el.palName.textContent = 'Break';
    el.palMode.textContent = 'Tap a block to remove it';
  } else {
    el.palName.textContent = NAMES[selected];
    el.palMode.textContent = 'Placing';
  }
}
el.toolPlace.addEventListener('click', () => setMode('place'));
el.toolBreak.addEventListener('click', () => setMode('break'));

el.palette.querySelectorAll('.sw').forEach((b) => {
  b.disabled = true; // until the world is loaded
  b.addEventListener('click', () => {
    selected = b.dataset.type;
    el.palette.querySelectorAll('.sw').forEach((x) => x.classList.toggle('sel', x === b));
    setMode('place');
  });
});

// ── Other people, and who is here ────────────────────────────────────────
function setHere(list) {
  const others = [...new Set(list)].filter((n) => n && n !== myName);
  let text;
  if (others.length === 0) text = 'Just you';
  else if (others.length === 1) text = others[0];
  else if (others.length === 2) text = others[0] + ' and ' + others[1];
  else if (others.length === 3) text = others[0] + ', ' + others[1] + ' and ' + others[2];
  else text = others[0] + ', ' + others[1] + ' and ' + (others.length - 2) + ' more';
  el.here.textContent = text;
}

function builderNote(text) {
  note(el.builder, text, 4000);
}

let es = null, everOpen = false;
function connect() {
  es = new EventSource('/api/stream?token=' + encodeURIComponent(TOKEN) + (DEMO ? '&demo=1' : ''));
  es.onopen = () => {
    hide(el.reconnect);
    if (everOpen && loaded) loadWorld(); // refresh so nothing is missed
    everOpen = true;
  };
  es.onerror = () => { if (loaded) show(el.reconnect); };
  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.kind === 'set' && Array.isArray(msg.cell)) {
      const [x, y, z, type] = msg.cell;
      blocks.set(key3(x, y, z), type);
      rebuild();
      updateEmpty();
      if (msg.by && msg.by !== myName) builderNote(msg.by + ' placed ' + NAMES[type].toLowerCase());
    } else if (msg.kind === 'clear' && Array.isArray(msg.cell)) {
      const [x, y, z] = msg.cell;
      blocks.delete(key3(x, y, z));
      rebuild();
      updateEmpty();
      if (msg.by && msg.by !== myName) builderNote(msg.by + ' broke a block');
    } else if (msg.kind === 'presence' && Array.isArray(msg.here)) {
      setHere(msg.here);
    }
  };
}

if (DEMO) show(document.querySelector('[data-usernode-demo-note]'));
loadWorld();
connect();