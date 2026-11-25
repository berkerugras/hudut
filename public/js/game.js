// The 3D game: map shader, characters, bullets, own-player prediction and the HUD.
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  GRID_W, GRID_H, MAX_HP, WEAPONS, WEAPON_IDS,
  stepMovement, cellAt, cellXY, wrapX, wrapDelta,
} from '/shared/constants.js';
import { buildCharacter } from './character.js';
import { MapPainter, hexRgb } from './mapview.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
const pushBonus = (w) => `${Math.round((w.push - 1) * 100)}%`;
const vec3 = (hex) => { const [r, g, b] = hexRgb(hex); return new THREE.Vector3(r / 255, g / 255, b / 255); };
const BULLET_COLOR = { tabanca: '#ffd27a', tufek: '#fff0b8', pompali: '#ffb36b', keskin: '#bfeaff', roket: '#ff7a4d' };

const VERT = /* glsl */ `
varying vec2 vCell;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vCell = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// Each cell: owner color. Borders drawn from the 4 neighbours. Contested cells show the attacker's
// color pushing in from the side it is being pushed, as deep as the current pressure.
const FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uOwner;
uniform sampler2D uPal;
uniform sampler2D uPress;
uniform float uMine;
uniform float uTime;
uniform vec3 uOcean;
uniform vec3 uOceanDeep;
uniform vec3 uIce;
varying vec2 vCell;
const vec2 G = vec2(${GRID_W}.0, ${GRID_H}.0);

float ownerAt(vec2 cell) {
  cell.x = mod(cell.x, G.x);
  if (cell.y < 0.0 || cell.y >= G.y) return 255.0;
  return floor(texture2D(uOwner, (cell + 0.5) / G).r * 255.0 + 0.5);
}
vec3 colorOf(float id) { return texture2D(uPal, vec2((id + 0.5) / 256.0, 0.5)).rgb; }
bool isLand(float id) { return id > 0.5 && id < 254.5; }
bool same(float a, float b) { return abs(a - b) < 0.5; }

void edgeSide(float id, float n, float d, inout float border, inout float coast, inout float mine) {
  if (same(n, id)) return;
  if (isLand(id) && isLand(n)) {
    float w = 1.0 - smoothstep(0.035, 0.085, d);
    border = max(border, w);
    if (same(id, uMine) || same(n, uMine)) mine = max(mine, w);
  } else if (isLand(id) || isLand(n)) {
    coast = max(coast, 1.0 - smoothstep(0.02, 0.07, d));
  }
}

void main() {
  vec2 c = vec2(mod(vCell.x, G.x), vCell.y);
  vec2 cell = floor(c);
  vec2 f = c - cell;
  float id = ownerAt(cell);
  float nL = ownerAt(cell + vec2(-1.0, 0.0));
  float nR = ownerAt(cell + vec2(1.0, 0.0));
  float nU = ownerAt(cell + vec2(0.0, -1.0));
  float nD = ownerAt(cell + vec2(0.0, 1.0));
  vec3 col;
  if (id < 0.5) {
    float w = sin(c.x * 0.9 + uTime * 0.7) * sin(c.y * 1.1 - uTime * 0.5);
    col = mix(uOceanDeep, uOcean, 0.6 + 0.18 * w);
  } else if (id > 254.5) {
    col = uIce;
  } else {
    col = colorOf(id);
    col *= 0.95 + 0.05 * mod(cell.x + cell.y, 2.0);
    if (same(id, uMine)) col = mix(col, vec3(1.0), 0.12);
    vec2 pr = texture2D(uPress, (cell + 0.5) / G).rg;
    if (pr.r > 0.004) {
      float att = floor(pr.g * 255.0 + 0.5);
      vec3 ac = colorOf(att);
      float p = pr.r;
      float depth = 99.0;
      if (same(nL, att)) depth = min(depth, f.x);
      if (same(nR, att)) depth = min(depth, 1.0 - f.x);
      if (same(nU, att)) depth = min(depth, f.y);
      if (same(nD, att)) depth = min(depth, 1.0 - f.y);
      float stripe = step(0.5, fract((c.x - c.y) * 2.0 + uTime * 1.2));
      if (depth > 50.0) {
        col = mix(col, ac, p * 0.45 * stripe);
      } else {
        float inside = 1.0 - smoothstep(p - 0.02, p + 0.02, depth);
        col = mix(col, ac, inside * (0.78 + 0.12 * stripe));
        float front = 1.0 - smoothstep(0.0, 0.045, abs(depth - p));
        col = mix(col, vec3(1.0, 0.93, 0.75), front * 0.85);
      }
    }
  }
  float border = 0.0, coast = 0.0, mine = 0.0;
  edgeSide(id, nL, f.x, border, coast, mine);
  edgeSide(id, nR, 1.0 - f.x, border, coast, mine);
  edgeSide(id, nU, f.y, border, coast, mine);
  edgeSide(id, nD, 1.0 - f.y, border, coast, mine);
  col = mix(col, vec3(0.06, 0.08, 0.09), border * 0.8);
  col = mix(col, vec3(1.0, 0.78, 0.35), mine * (0.75 + 0.25 * sin(uTime * 3.0)));
  col = mix(col, vec3(0.9, 0.95, 0.97), coast * 0.4);
  gl_FragColor = vec4(col, 1.0);
}`;

function dataTex(data, w, h, format) {
  const t = new THREE.DataTexture(data, w, h, format, THREE.UnsignedByteType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export function createGame({ socket, init, countries, onExit }) {
  const ac = new AbortController();
  const on = (target, type, fn, opts = {}) => target.addEventListener(type, fn, { ...opts, signal: ac.signal });
  const root = $('gameRoot');
  const hud = $('hud');
  root.hidden = false;
  hud.hidden = false;

  const myId = init.you;
  const countryById = new Map(countries.map((c) => [c.id, c]));
  const grid = new Uint8Array(init.grid);
  const clockOffset = init.now - Date.now();
  const serverNow = () => Date.now() + clockOffset;
  let nextDropAt = init.nextDropAt;
  const counts = new Int32Array(256);
  for (let i = 0; i < grid.length; i++) counts[grid[i]]++;

  // ---------- renderer ----------
  const canvas = document.createElement('canvas');
  root.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const labels = new CSS2DRenderer();
  labels.domElement.className = 'labels';
  root.appendChild(labels.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0f2633');
  const camera = new THREE.PerspectiveCamera(46, 1, 0.1, 500);
  scene.add(new THREE.HemisphereLight(0xe8f4ff, 0x31434c, 1.3));
  const sun = new THREE.DirectionalLight(0xfff3df, 1.5);
  sun.position.set(-6, 14, 5);
  scene.add(sun);

  // ---------- map ----------
  const ownerTex = dataTex(grid, GRID_W, GRID_H, THREE.RedFormat);
  const palData = new Uint8Array(256 * 4);
  for (const c of countries) { const [r, g, b] = hexRgb(c.color); palData.set([r, g, b, 255], c.id * 4); }
  const palTex = dataTex(palData, 256, 1, THREE.RGBAFormat);
  const pressData = new Uint8Array(GRID_W * GRID_H * 2);
  const pressTex = dataTex(pressData, GRID_W, GRID_H, THREE.RGFormat);
  const me = { x: init.x, y: init.y, alive: true, pushCell: -1, country: 0 };
  const mapMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uOwner: { value: ownerTex },
      uPal: { value: palTex },
      uPress: { value: pressTex },
      uMine: { value: 0 },
      uTime: { value: 0 },
      uOcean: { value: vec3('#1f4a60') },
      uOceanDeep: { value: vec3('#14303f') },
      uIce: { value: vec3('#d9e3e8') },
    },
  });
  const mapGeo = new THREE.PlaneGeometry(GRID_W, GRID_H).rotateX(-Math.PI / 2);
  const mapMeshes = [-1, 0, 1].map(() => {
    const m = new THREE.Mesh(mapGeo, mapMat);
    m.frustumCulled = false;
    scene.add(m);
    return m;
  });

  // ---------- players ----------
  const players = new Map();
  let camX = init.x; // own x without wrapping, so the camera never jumps at the date line
  const rx = (x) => camX + wrapDelta(x - wrapX(camX));

  function addPlayer(info) {
    if (players.has(info.id)) return;
    const ch = buildCharacter(info.look);
    ch.setWeapon(info.weapon);
    ch.root.visible = info.id === myId;
    scene.add(ch.root);
    const mine = info.country === players.get(myId)?.info.country || info.id === myId;
    const el = document.createElement('div');
    el.className = 'plate ' + (info.id === myId ? 'me mate' : mine ? 'mate' : 'foe');
    const row = document.createElement('div'); row.className = 'plate-row';
    const sw = document.createElement('i'); sw.style.background = countryById.get(info.country)?.color || '#888';
    const nm = document.createElement('span'); nm.textContent = info.name;
    row.append(sw, nm);
    const hp = document.createElement('b'); hp.className = 'plate-hp';
    const hpi = document.createElement('i'); hp.appendChild(hpi);
    el.append(row, hp);
    const label = new CSS2DObject(el);
    label.position.set(0, 1.8, 0);
    ch.root.add(label);
    players.set(info.id, {
      info, ch, label, el, hpi,
      x: info.id === myId ? init.x : 0, y: info.id === myId ? init.y : 0, sx: 0, sy: 0,
      aim: 0, hp: MAX_HP, alive: true, pushing: false, moving: false, seen: info.id === myId,
    });
  }
  function removePlayer(id) {
    const p = players.get(id);
    if (!p) return;
    p.ch.root.remove(p.label); // fires CSS2DObject's 'removed' so its DOM node goes too
    scene.remove(p.ch.root);
    p.ch.dispose();
    players.delete(id);
  }
  const meInfo = init.players.find((p) => p.id === myId);
  me.country = meInfo.country;
  mapMat.uniforms.uMine.value = me.country;
  addPlayer(meInfo);
  for (const info of init.players) if (info.id !== myId) addPlayer(info);
  const myCountry = countryById.get(me.country);

  // ---------- bullets & effects ----------
  const bulletGeo = new THREE.BoxGeometry(0.3, 0.06, 0.06);
  const rocketGeo = new THREE.BoxGeometry(0.42, 0.14, 0.14);
  const bulletMats = WEAPON_IDS.map((id) => new THREE.MeshBasicMaterial({ color: BULLET_COLOR[id] }));
  const bullets = new Map();
  const ringGeo = new THREE.RingGeometry(0.55, 1, 32).rotateX(-Math.PI / 2);
  const effects = [];
  function spawnBullet([id, , x, y, a, wi]) {
    const w = WEAPONS[WEAPON_IDS[wi]];
    if (!w) return;
    const mesh = new THREE.Mesh(w.splash ? rocketGeo : bulletGeo, bulletMats[wi]);
    mesh.rotation.y = -a;
    scene.add(mesh);
    bullets.set(id, { mesh, x, y, vx: Math.cos(a) * w.speed, vy: Math.sin(a) * w.speed, left: w.range, speed: w.speed });
  }
  function removeBullet(id) {
    const b = bullets.get(id);
    if (!b) return;
    scene.remove(b.mesh);
    bullets.delete(id);
  }
  function impact([id, x, y, splash]) {
    removeBullet(id);
    const big = splash === 1;
    const mat = new THREE.MeshBasicMaterial({ color: big ? '#ff8a4d' : '#fff2c4', transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(ringGeo, mat);
    m.position.set(x, 0.08, y);
    m.userData = { x, size: big ? 2.2 : 0.35, life: big ? 0.45 : 0.25, age: 0 };
    scene.add(m);
    effects.push(m);
  }

  // ---------- input ----------
  const keys = new Set();
  const ndc = new THREE.Vector2(0, 0);
  let firing = false;
  let zoom = 0.85;
  let aim = 0;
  const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  on(window, 'keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (MOVE_KEYS.has(e.code)) { keys.add(e.code); e.preventDefault(); }
  });
  on(window, 'keyup', (e) => keys.delete(e.code));
  on(window, 'blur', () => { keys.clear(); firing = false; });
  on(canvas, 'pointermove', (e) => {
    ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
  });
  on(canvas, 'pointerdown', (e) => { if (e.button === 0) firing = true; });
  on(window, 'pointerup', () => { firing = false; });
  on(canvas, 'contextmenu', (e) => e.preventDefault());
  on(canvas, 'wheel', (e) => {
    e.preventDefault();
    zoom = Math.min(2.4, Math.max(0.5, zoom * (e.deltaY > 0 ? 1.1 : 0.9)));
  }, { passive: false });
  on($('btnChangeCountry'), 'click', () => onExit('change'));
  function moveDir() {
    let dx = 0, dy = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) dy -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) dy += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) dx -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) dx += 1;
    return [dx, dy];
  }

  // ---------- network ----------
  const pressure = new Map(); // cell -> { attacker, p }
  let minimapDirty = true;
  function snapMe(x, y) {
    camX += wrapDelta(x - me.x);
    me.x = x;
    me.y = y;
  }
  const handlers = {
    snap(s) {
      const [mdx, mdy] = moveDir();
      for (const [id, x, y, a, hp, flags] of s.p) {
        const p = players.get(id);
        if (!p) continue;
        const alive = (flags & 1) === 1;
        if (id === myId) {
          if (alive && !me.alive) snapMe(x, y);
          else if (alive) {
            const ex = wrapDelta(x - me.x);
            const ey = y - me.y;
            const err = Math.hypot(ex, ey);
            const standingWrong = grid[cellAt(me.x, me.y)] !== me.country;
            if (err > 1.5 || standingWrong) snapMe(x, y);
            else if (!mdx && !mdy && err > 0.02) snapMe(me.x + ex * 0.35, me.y + ey * 0.35);
          }
          me.alive = alive;
          p.hp = hp;
          p.alive = alive;
          continue;
        }
        if (!p.seen || (alive && !p.alive)) { p.x = x; p.y = y; p.seen = true; }
        p.sx = x; p.sy = y; p.aim = a; p.hp = hp; p.alive = alive;
        p.pushing = (flags & 2) === 2;
        p.moving = (flags & 4) === 4;
      }
      let changed = pressure.size > 0 || s.c.length > 0;
      for (const c of pressure.keys()) { pressData[c * 2] = 0; pressData[c * 2 + 1] = 0; }
      pressure.clear();
      for (const [c, att, p] of s.c) {
        pressure.set(c, { attacker: att, p: p / 255 });
        pressData[c * 2] = p;
        pressData[c * 2 + 1] = att;
      }
      if (changed) pressTex.needsUpdate = true;
      if (s.f.length) {
        for (const [c, o] of s.f) { counts[grid[c]]--; grid[c] = o; counts[o]++; }
        ownerTex.needsUpdate = true;
        minimapDirty = true;
      }
      for (const shot of s.s) spawnBullet(shot);
      for (const imp of s.i) impact(imp);
    },
    playerJoined(info) {
      addPlayer(info);
      feed([[info.name, info.country], ` joined for ${countryById.get(info.country)?.name || 'their country'}`]);
    },
    playerLeft(id) { removePlayer(id); },
    weaponDrop({ given, nextDropAt: next }) {
      nextDropAt = next;
      for (const [id, w] of given) {
        const p = players.get(id);
        if (!p) continue;
        p.info.weapon = w;
        p.ch.setWeapon(w);
        if (id === myId) {
          const W = WEAPONS[w];
          toast(`New weapon: ${W.name}. You push borders ${pushBonus(W)} faster.`);
        }
      }
      updateWeaponHud();
    },
    kill({ killer, victim, weapon, respawnAt }) {
      const k = players.get(killer);
      const v = players.get(victim);
      if (!v) return;
      if (k) k.info.kills++;
      v.info.deaths++;
      feed([
        k ? [k.info.name, k.info.country] : ['?', 0],
        ' shot ',
        [v.info.name, v.info.country],
        { w: WEAPONS[weapon]?.name || '' },
      ]);
      if (victim === myId) {
        me.alive = false;
        deathUntil = respawnAt;
        $('deathText').textContent = k
          ? `${k.info.name} shot you with a ${(WEAPONS[weapon]?.name || 'weapon').toLowerCase()}.`
          : 'You were shot.';
        $('deathBox').hidden = false;
      }
    },
    eliminated({ id }) { if (id === myId) onExit('eliminated'); },
  };
  for (const [ev, fn] of Object.entries(handlers)) socket.on(ev, fn);

  // ---------- HUD ----------
  let deathUntil = 0;
  let toastTimer = 0;
  $('hudCountry').textContent = myCountry?.name || '';
  $('hudSwatch').style.background = myCountry?.color || '#888';
  $('deathBox').hidden = true;
  $('feed').replaceChildren();
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
  }
  function feed(parts) {
    const li = document.createElement('li');
    for (const part of parts) {
      if (typeof part === 'string') li.append(part);
      else if (Array.isArray(part)) {
        const b = document.createElement('b');
        b.textContent = part[0];
        b.style.color = countryById.get(part[1])?.color || 'inherit';
        li.append(b);
      } else if (part && part.w) {
        const s = document.createElement('span');
        s.className = 'w';
        s.textContent = ` · ${part.w}`;
        li.append(s);
      }
    }
    const list = $('feed');
    list.prepend(li);
    while (list.children.length > 5) list.lastChild.remove();
    setTimeout(() => li.classList.add('old'), 7000);
    setTimeout(() => li.remove(), 7700);
  }
  function updateWeaponHud() {
    const w = WEAPONS[players.get(myId)?.info.weapon];
    $('hudWeapon').textContent = w ? w.name : 'No weapon';
    $('hudWeaponSub').textContent = w ? `Pushes borders ${pushBonus(w)} faster` : 'Wait for the next drop';
  }
  updateWeaponHud();
  if (!players.get(myId)?.info.weapon) {
    toast(`You're fighting for ${myCountry?.name || 'your country'}. Walk to the border and push.`);
  }

  let lastPush = 0;
  let lastPushCell = -1;
  function updateHud() {
    $('hudCells').textContent = fmt(counts[me.country]);
    let online = 0;
    for (const p of players.values()) if (p.info.country === me.country) online++;
    $('hudOnline').textContent = online;
    const left = Math.max(0, nextDropAt - serverNow());
    const mm = Math.floor(left / 60000);
    const ss = Math.floor((left % 60000) / 1000);
    $('hudDrop').textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    const myP = players.get(myId);
    const hp = myP ? myP.hp : MAX_HP;
    $('hpBar').style.width = `${hp}%`;
    $('hpBar').style.background = hp > 50 ? 'var(--ok)' : hp > 25 ? 'var(--accent)' : 'var(--danger)';
    $('hpText').textContent = me.alive ? hp : 0;
    if (deathUntil) {
      const s = Math.ceil((deathUntil - serverNow()) / 1000);
      $('deathTimer').textContent = Math.max(0, s);
      if (me.alive) { deathUntil = 0; $('deathBox').hidden = true; }
    }
    // Push meter
    const box = $('pushBox');
    if (!me.alive || me.pushCell < 0) { box.hidden = true; return; }
    box.hidden = false;
    const st = pressure.get(me.pushCell);
    const pct = st && st.attacker === me.country ? st.p : 0;
    $('pushPct').textContent = `${Math.round(pct * 100)}%`;
    $('pushBar').style.width = `${pct * 100}%`;
    let mates = 0;
    let foesNear = 0;
    for (const p of players.values()) {
      if (p.info.id === myId || !p.alive) continue;
      const d = Math.hypot(wrapDelta(p.x - me.x), p.y - me.y);
      if (p.info.country === me.country) { if (p.pushing && d < 2.5) mates++; }
      else if (p.pushing && d < 3) foesNear++;
    }
    const sameCell = me.pushCell === lastPushCell;
    let hint;
    if (st && st.attacker !== me.country) hint = 'Another country is pushing this cell too.';
    else if (foesNear > 0 && sameCell && pct + 0.005 < lastPush) hint = "They're defending. Bring more people.";
    else if (mates > 0) hint = `${mates} ${mates === 1 ? 'teammate is' : 'teammates are'} pushing with you.`;
    else if (pct >= 0.45) hint = 'Alone you can push a border 50% at most. A teammate has to push the same spot to break through.';
    else hint = 'Keep pushing.';
    $('pushHint').textContent = hint;
    lastPush = pct;
    lastPushCell = me.pushCell;
  }

  // ---------- minimap ----------
  const mini = $('minimap');
  const miniCtx = mini.getContext('2d');
  const painter = new MapPainter(countries);
  painter.setGrid(grid);
  let miniSrc = null;
  let miniAt = 0;
  function drawMinimap(now) {
    if (minimapDirty && now - miniAt > 1000) {
      miniSrc = painter.paint({ mine: me.country });
      minimapDirty = false;
      miniAt = now;
    }
    if (!miniSrc) return;
    const W = mini.width, H = mini.height;
    miniCtx.imageSmoothingEnabled = false;
    miniCtx.drawImage(miniSrc, 0, 0, W, H);
    const sx = W / GRID_W, sy = H / GRID_H;
    miniCtx.fillStyle = '#f0b44c';
    for (const p of players.values()) {
      if (p.info.id === myId || p.info.country !== me.country || !p.alive) continue;
      miniCtx.fillRect(p.x * sx - 1.5, p.y * sy - 1.5, 3, 3);
    }
    miniCtx.strokeStyle = '#ffffff';
    miniCtx.lineWidth = 1.5;
    miniCtx.beginPath();
    miniCtx.arc(wrapX(me.x) * sx, me.y * sy, 4, 0, Math.PI * 2);
    miniCtx.stroke();
    miniCtx.fillStyle = '#ffffff';
    miniCtx.fillRect(wrapX(me.x) * sx - 1, me.y * sy - 1, 2, 2);
  }

  // ---------- resize ----------
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    labels.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  on(window, 'resize', resize);
  resize();

  // ---------- frame loop ----------
  const ray = new THREE.Raycaster();
  const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.78);
  const hit = new THREE.Vector3();
  const camOffset = new THREE.Vector3(0, 12.5, 8.5);
  let raf = 0;
  let last = performance.now();
  let t = 0;
  let sendAcc = 0;
  let hudAcc = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    const [dx, dy] = moveDir();

    // Own movement, predicted locally with the same rules the server uses.
    if (me.alive) {
      const r = stepMovement(grid, me.country, me.x, me.y, dx, dy, dt);
      camX += wrapDelta(r.x - me.x);
      me.x = r.x;
      me.y = r.y;
      me.pushCell = r.pushCell;
    } else {
      me.pushCell = -1;
    }

    camera.position.set(camX, 0, me.y).addScaledVector(camOffset, zoom);
    camera.lookAt(camX, 0.6, me.y);
    camera.updateMatrixWorld();
    ray.setFromCamera(ndc, camera);
    if (ray.ray.intersectPlane(aimPlane, hit)) aim = Math.atan2(hit.z - me.y, hit.x - camX);
    const myP = players.get(myId);
    const armed = !!(myP && myP.info.weapon);
    // While pushing (and not shooting) face the border instead of the mouse.
    const facing = me.pushCell >= 0 && !(firing && armed) ? Math.atan2(dy, dx) : aim;

    sendAcc += dt;
    if (sendAcc >= 0.05) {
      sendAcc = 0;
      socket.emit('input', { dx, dy, aim: facing, fire: firing && armed && me.alive });
    }

    // Map tiles follow the camera so the world wraps east-west.
    const base = Math.floor(camX / GRID_W) * GRID_W;
    mapMeshes.forEach((m, i) => m.position.set(base + (i - 1) * GRID_W + GRID_W / 2, 0, GRID_H / 2));
    mapMat.uniforms.uTime.value = t;

    // Characters
    const k = 1 - Math.exp(-14 * dt);
    for (const p of players.values()) {
      if (p.info.id === myId) {
        p.ch.root.visible = me.alive;
        p.ch.root.position.set(camX, 0, me.y);
        p.ch.root.rotation.y = -facing;
        p.ch.animate(t, dt, { moving: !!(dx || dy) && me.pushCell < 0, pushing: me.pushCell >= 0 });
      } else {
        if (!p.seen) continue;
        p.x = wrapX(p.x + wrapDelta(p.sx - p.x) * k);
        p.y += (p.sy - p.y) * k;
        p.ch.root.visible = p.alive;
        p.ch.root.position.set(rx(p.x), 0, p.y);
        p.ch.root.rotation.y = -p.aim;
        p.ch.animate(t, dt, { moving: p.moving, pushing: p.pushing });
      }
      p.hpi.style.width = `${Math.max(0, p.hp)}%`;
    }

    // Bullets & effects
    for (const [id, b] of bullets) {
      const step = b.speed * dt;
      b.x = wrapX(b.x + b.vx * dt);
      b.y += b.vy * dt;
      b.left -= step;
      if (b.left <= 0) { removeBullet(id); continue; }
      b.mesh.position.set(rx(b.x), 0.8, b.y);
    }
    for (let i = effects.length - 1; i >= 0; i--) {
      const m = effects[i];
      const u = m.userData;
      u.age += dt;
      const q = u.age / u.life;
      if (q >= 1) { scene.remove(m); m.material.dispose(); effects.splice(i, 1); continue; }
      m.position.x = rx(u.x);
      m.scale.setScalar(u.size * (0.3 + q));
      m.material.opacity = 0.9 * (1 - q);
    }

    renderer.render(scene, camera);
    labels.render(scene, camera);

    hudAcc += dt;
    if (hudAcc > 0.1) { hudAcc = 0; updateHud(); drawMinimap(now); }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  // ---------- teardown ----------
  function stop() {
    cancelAnimationFrame(raf);
    ac.abort();
    for (const [ev, fn] of Object.entries(handlers)) socket.off(ev, fn);
    clearTimeout(toastTimer);
    for (const id of [...players.keys()]) removePlayer(id);
    for (const id of [...bullets.keys()]) removeBullet(id);
    for (const m of effects) { scene.remove(m); m.material.dispose(); }
    [ownerTex, palTex, pressTex].forEach((x) => x.dispose());
    [mapGeo, bulletGeo, rocketGeo, ringGeo].forEach((x) => x.dispose());
    bulletMats.forEach((x) => x.dispose());
    mapMat.dispose();
    renderer.dispose();
    canvas.remove();
    labels.domElement.remove();
    root.hidden = true;
    hud.hidden = true;
    $('toast').hidden = true;
    $('deathBox').hidden = true;
    $('pushBox').hidden = true;
  }
  return { stop };
}
