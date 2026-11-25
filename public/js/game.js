// The 3D game: map, characters, crates, capitals, bullets, own-player prediction, HUD and effects.
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  GRID_W, GRID_H, MAX_HP, WEAPONS, WEAPON_IDS, CRATES, CRATE_INFO, BOUNTY_STREAK, MORALE_MULT, BOOST_MULT,
  underdogFactor, stepMovement, cellAt, cellXY, wrapX, wrapDelta,
} from '/shared/constants.js';
import { buildCharacter } from './character.js';
import { MapPainter, hexRgb } from './mapview.js';
import { VERT, FRAG, dataTex } from './mapshader.js';
import { sfx, isMuted, setMuted } from './sfx.js';
import { addCareerScore } from './career.js';
import { drawShareCard, shareCard, copyText } from './share.js';
import { createTouchControls, isTouchDevice } from './controls.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
const pushBonus = (w) => `${Math.round((w.push - 1) * 100)}%`;
// Other players are drawn this far in the past, between two server snapshots, so they move
// smoothly even when packets arrive unevenly.
const INTERP_MS = 130;
const POSE_HOLD_S = 0.15;
const NEAR = 14; // cells: how close a captured cell must be for the flash and sound
function lerpAngle(a, b, f) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}
const vec3 = (hex) => { const [r, g, b] = hexRgb(hex); return new THREE.Vector3(r / 255, g / 255, b / 255); };
const BULLET_COLOR = { tabanca: '#ffd27a', tufek: '#fff0b8', pompali: '#ffb36b', keskin: '#bfeaff', roket: '#ff7a4d' };
const CRATE_COLOR = { medkit: '#eef3f4', boost: '#f0b44c', arsenal: '#7f9f4f' };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
function duration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}

export function createGame({ socket, init, countries, onExit, inviteUrl }) {
  const ac = new AbortController();
  const on = (target, type, fn, opts = {}) => target.addEventListener(type, fn, { ...opts, signal: ac.signal });
  const root = $('gameRoot');
  const hud = $('hud');
  root.hidden = false;
  hud.hidden = false;

  const myId = init.you;
  const countryById = new Map(countries.map((c) => [c.id, c]));
  const nameOf = (id) => countryById.get(id)?.name || 'Unknown';
  const colorOf = (id) => countryById.get(id)?.color || '#888';
  const grid = new Uint8Array(init.grid);
  const clockOffset = init.now - Date.now();
  const serverNow = () => Date.now() + clockOffset;
  let nextDropAt = init.nextDropAt;
  let round = init.round;
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
  // tp: how many times the server has moved us itself; when it changes we jump to its position.
  const me = { x: init.x, y: init.y, alive: true, pushCell: -1, country: init.country, tp: Number.isInteger(init.tp) ? init.tp : -1 };
  const myCountry = countryById.get(me.country);
  const mapMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uOwner: { value: ownerTex },
      uPal: { value: palTex },
      uPress: { value: pressTex },
      uMine: { value: me.country },
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

  let camX = init.x; // own x without wrapping, so the camera never jumps at the date line
  const rx = (x) => camX + wrapDelta(x - wrapX(camX));
  const distToMe = (x, y) => Math.hypot(wrapDelta(x - me.x), y - me.y);

  // ---------- players ----------
  const players = new Map();
  function addPlayer(info) {
    if (players.has(info.id)) return;
    const ch = buildCharacter(info.look);
    ch.setWeapon(info.weapon);
    ch.root.visible = info.id === myId;
    scene.add(ch.root);
    const mate = info.country === me.country;
    const el = document.createElement('div');
    el.className = 'plate ' + (info.id === myId ? 'me mate' : mate ? 'mate' : 'foe');
    const row = document.createElement('div'); row.className = 'plate-row';
    const sw = document.createElement('i'); sw.style.background = colorOf(info.country);
    const nm = document.createElement('span'); nm.textContent = info.name;
    row.append(sw, nm);
    if (info.bot) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'AI'; row.append(tag); }
    const hp = document.createElement('b'); hp.className = 'plate-hp';
    const hpi = document.createElement('i'); hp.appendChild(hpi);
    el.append(row, hp);
    const label = new CSS2DObject(el);
    label.position.set(0, 1.8, 0);
    ch.root.add(label);
    players.set(info.id, {
      info, ch, label, el, hpi,
      x: info.id === myId ? init.x : 0, y: info.id === myId ? init.y : 0,
      buf: [], tp: -1, flags: 0, score: info.score || 0,
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
  addPlayer(init.players.find((p) => p.id === myId));
  for (const info of init.players) if (info.id !== myId) addPlayer(info);

  // ---------- capitals: a flag in the owner's color ----------
  const capitals = new Map();
  const poleGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.7, 6).translate(0, 0.85, 0);
  const flagGeo = new THREE.BoxGeometry(0.03, 0.42, 0.62).translate(0, 1.45, 0.31);
  const baseGeo = new THREE.CylinderGeometry(0.3, 0.38, 0.14, 12).translate(0, 0.07, 0);
  const poleMat = new THREE.MeshStandardMaterial({ color: '#d9d4c7', roughness: 0.5 });
  for (const [cell, name, home] of init.capitals || []) {
    const group = new THREE.Group();
    const flagMat = new THREE.MeshStandardMaterial({ color: '#888888', roughness: 0.7 });
    group.add(new THREE.Mesh(baseGeo, poleMat), new THREE.Mesh(poleGeo, poleMat), new THREE.Mesh(flagGeo, flagMat));
    const el = document.createElement('div');
    el.className = 'cap-label';
    const label = new CSS2DObject(el);
    label.position.set(0, 2.1, 0);
    group.add(label);
    scene.add(group);
    const cap = { cell, name, home, group, flagMat, label, el };
    capitals.set(cell, cap);
    refreshCapital(cap);
  }
  function refreshCapital(cap) {
    const owner = grid[cap.cell];
    cap.flagMat.color.set(colorOf(owner));
    cap.el.textContent = owner === cap.home ? `★ ${cap.name}` : `★ ${cap.name} · held by ${nameOf(owner)}`;
  }

  // ---------- crates ----------
  const crateGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const crateMats = CRATES.map((t) => new THREE.MeshStandardMaterial({ color: CRATE_COLOR[t], roughness: 0.55, emissive: CRATE_COLOR[t], emissiveIntensity: 0.3 }));
  const crates = new Map();
  function addCrate([id, x, y, ti]) {
    if (crates.has(id) || !crateMats[ti]) return;
    const mesh = new THREE.Mesh(crateGeo, crateMats[ti]);
    scene.add(mesh);
    crates.set(id, { mesh, x, y, type: CRATES[ti], phase: Math.random() * 6 });
  }
  function removeCrate(id) {
    const k = crates.get(id);
    if (!k) return;
    scene.remove(k.mesh);
    crates.delete(id);
  }
  for (const k of init.crates || []) addCrate(k);

  // ---------- bullets & effects ----------
  const bulletGeo = new THREE.BoxGeometry(0.3, 0.06, 0.06);
  const rocketGeo = new THREE.BoxGeometry(0.42, 0.14, 0.14);
  const bulletMats = WEAPON_IDS.map((id) => new THREE.MeshBasicMaterial({ color: BULLET_COLOR[id] }));
  const bullets = new Map();
  const ringGeo = new THREE.RingGeometry(0.55, 1, 32).rotateX(-Math.PI / 2);
  const effects = [];
  let shake = 0;
  function spawnRing(x, y, color, size, life, height = 0.08) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(ringGeo, mat);
    m.position.set(rx(x), height, y);
    scene.add(m);
    effects.push({ kind: 'ring', obj: m, x, y, size, life, age: 0 });
  }
  function spawnPopup(x, y, text, bad = false) {
    const el = document.createElement('div');
    el.className = 'popup' + (bad ? ' bad' : '');
    el.textContent = text;
    const obj = new CSS2DObject(el);
    obj.position.set(rx(x), 2.2, y);
    scene.add(obj);
    effects.push({ kind: 'popup', obj, x, y, life: 1.1, age: 0 });
  }
  function spawnBullet([id, owner, x, y, a, wi]) {
    const w = WEAPONS[WEAPON_IDS[wi]];
    if (!w) return;
    const mesh = new THREE.Mesh(w.splash ? rocketGeo : bulletGeo, bulletMats[wi]);
    mesh.rotation.y = -a;
    scene.add(mesh);
    bullets.set(id, { mesh, x, y, vx: Math.cos(a) * w.speed, vy: Math.sin(a) * w.speed, left: w.range, speed: w.speed });
    const d = distToMe(x, y);
    if (d < 25) sfx.shot(WEAPON_IDS[wi], owner === myId ? 1 : Math.max(0, 1 - d / 25) * 0.7);
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
    spawnRing(x, y, big ? '#ff8a4d' : '#fff2c4', big ? 2.2 : 0.35, big ? 0.45 : 0.25);
    if (big) {
      const d = distToMe(x, y);
      if (d < 25) { sfx.explosion(1 - d / 25); shake = Math.max(shake, 0.35 * (1 - d / 25)); }
    }
  }

  // ---------- input ----------
  const keys = new Set();
  const ndc = new THREE.Vector2(0, 0);
  let mouseFiring = false;
  let pointerInside = false;
  let zoom = isTouchDevice() ? 1 : 0.85;
  let aim = 0;
  let aimDist = 0;
  let moveMode = store.get('hudut.move', 'keys');
  const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  on(window, 'keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); openChat(); return; }
    if (e.code === 'KeyF' && !e.repeat) { goFront(); return; }
    if (e.code === 'KeyM' && !e.repeat) { toggleSound(); return; }
    if (MOVE_KEYS.has(e.code)) { keys.add(e.code); e.preventDefault(); }
  });
  on(window, 'keyup', (e) => keys.delete(e.code));
  on(window, 'blur', () => { keys.clear(); mouseFiring = false; });
  on(canvas, 'pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    pointerInside = true;
    ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
  });
  on(canvas, 'pointerleave', () => { pointerInside = false; });
  on(canvas, 'pointerdown', (e) => {
    if (chatOpen) closeChat();
    if (e.pointerType !== 'touch' && e.button === 0) mouseFiring = true;
  });
  on(window, 'pointerup', () => { mouseFiring = false; });
  on(canvas, 'contextmenu', (e) => e.preventDefault());
  on(canvas, 'wheel', (e) => {
    e.preventDefault();
    zoom = Math.min(2.4, Math.max(0.5, zoom * (e.deltaY > 0 ? 1.1 : 0.9)));
  }, { passive: false });
  const touch = isTouchDevice() ? createTouchControls({ root: document.body, onFront: () => goFront(), onChat: () => openChat() }) : null;

  function moveDir() {
    let dx = 0, dy = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) dy -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) dy += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) dx -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) dx += 1;
    if (!dx && !dy && touch && (touch.state.dx || touch.state.dy)) { dx = touch.state.dx; dy = touch.state.dy; }
    // "Move: mouse": walk toward the cursor (slither-style), click to shoot.
    if (!dx && !dy && moveMode === 'mouse' && pointerInside && aimDist > 1.2) { dx = Math.cos(aim); dy = Math.sin(aim); }
    return [dx, dy];
  }

  // ---------- HUD helpers ----------
  let toastTimer = 0;
  let bannerTimer = 0;
  function toast(text, ms = 3200) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  function banner(text, bad = false, ms = 3800) {
    const el = $('banner');
    el.textContent = text;
    el.classList.toggle('bad', bad);
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth; // restart the pop animation
    el.style.animation = '';
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  function feed(parts) {
    const li = document.createElement('li');
    for (const part of parts) {
      if (typeof part === 'string') li.append(part);
      else if (Array.isArray(part)) {
        const b = document.createElement('b');
        b.textContent = part[0];
        b.style.color = colorOf(part[1]);
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
  function humansByScore() {
    return [...players.values()].filter((p) => !p.info.bot).sort((a, b) => b.score - a.score);
  }
  function myRank() {
    return humansByScore().findIndex((p) => p.info.id === myId) + 1;
  }
  $('hudCountry').textContent = myCountry?.name || '';
  $('hudSwatch').style.background = colorOf(me.country);
  $('deathBox').hidden = true;
  $('roundBox').hidden = true;
  $('feed').replaceChildren();
  updateWeaponHud();
  toast(`You're fighting for ${myCountry?.name || 'your country'}. Walk into the border to push it.`, 4500);

  // ---------- network ----------
  const pressure = new Map(); // cell -> { attacker, p }
  const miniChanged = []; // cells that changed owner since the minimap was last painted
  let serverOffset = null; // server clock minus ours, smoothed
  let lastMyScore = players.get(myId)?.score || 0;
  let myFlags = 0;
  let deathUntil = 0;
  let lastLife = { captures: 0, kills: 0, score: 0 };
  const captureTimes = [];
  let lastBreakthrough = -10;
  let lastCaptureSound = 0;
  let t = 0;
  function snapMe(x, y) {
    camX += wrapDelta(x - me.x);
    me.x = x;
    me.y = y;
  }
  function setPlateFlags(p, flags) {
    p.flags = flags;
    p.el.classList.toggle('bounty', (flags & 8) === 8);
    p.el.classList.toggle('boosted', (flags & 48) !== 0);
  }
  function onMyScore(score) {
    if (score > lastMyScore) {
      const delta = score - lastMyScore;
      if (me.alive) spawnPopup(me.x, me.y, `+${delta}`);
      for (const item of addCareerScore(delta)) banner(`Unlocked: ${item}! Put it on under Customize character.`, false, 5000);
    }
    lastMyScore = score;
  }
  function onMyFlags(flags) {
    const rose = (bit) => (flags & bit) && !(myFlags & bit);
    if (rose(8)) { banner(`${BOUNTY_STREAK} kills in a row: there's a bounty on your head!`, true); sfx.alert(); }
    if (rose(16)) toast(`Morale boost! You push ${Math.round((MORALE_MULT - 1) * 100)}% faster for a few seconds.`);
    if (rose(32)) toast(`Push boost! You push ${BOOST_MULT}× as fast for 12 s.`);
    myFlags = flags;
  }
  function onFlip(c, o) {
    const old = grid[c];
    counts[old]--;
    grid[c] = o;
    counts[o]++;
    miniChanged.push(c);
    const cap = capitals.get(c);
    if (cap) refreshCapital(cap);
    const [cx, cy] = cellXY(c);
    if (distToMe(cx + 0.5, cy + 0.5) > NEAR) return;
    if (o === me.country) {
      spawnRing(cx + 0.5, cy + 0.5, colorOf(o), 1.3, 0.6, 0.1);
      if (t - lastCaptureSound > 0.12) { sfx.capture(); lastCaptureSound = t; }
      captureTimes.push(t);
    } else if (old === me.country) {
      spawnRing(cx + 0.5, cy + 0.5, '#ef6461', 1.3, 0.6, 0.1);
      if (t - lastCaptureSound > 0.12) { sfx.lost(); lastCaptureSound = t; }
    }
  }
  const handlers = {
    snap(s) {
      // Track the server clock. Late packets make the sample smaller, so follow increases fast
      // and decreases slowly.
      const sample = s.t - Date.now();
      if (serverOffset === null) serverOffset = sample;
      else serverOffset += (sample - serverOffset) * (sample > serverOffset ? 0.3 : 0.02);

      for (const [id, x, y, a, hp, flags, tp, score] of s.p) {
        const p = players.get(id);
        if (!p) continue;
        const alive = (flags & 1) === 1;
        p.score = score || 0;
        setPlateFlags(p, flags);
        if (id === myId) {
          // We walk on our own; the server only moves us when it has to (spawn, respawn,
          // "to the front", losing the ground we stand on, a refused move, a new round).
          const standingWrong = alive && grid[cellAt(me.x, me.y)] !== me.country;
          if (tp !== me.tp || standingWrong || (alive && !me.alive)) snapMe(x, y);
          me.tp = tp;
          if (alive && hp < p.hp && p.alive) { shake = Math.max(shake, 0.2); sfx.hurt(); }
          me.alive = alive;
          p.hp = hp;
          p.alive = alive;
          onMyScore(p.score);
          onMyFlags(flags);
          continue;
        }
        const jumped = !p.seen || tp !== p.tp || (alive && !p.alive);
        if (jumped) { p.buf.length = 0; p.x = x; p.y = y; p.aim = a; }
        p.buf.push({ t: s.t, x, y, a });
        while (p.buf.length > 2 && s.t - p.buf[1].t > 1000) p.buf.shift();
        p.seen = true;
        p.tp = tp;
        p.hp = hp;
        p.alive = alive;
        p.pushing = (flags & 2) === 2;
        p.moving = (flags & 4) === 4;
      }
      const changed = pressure.size > 0 || s.c.length > 0;
      for (const c of pressure.keys()) { pressData[c * 2] = 0; pressData[c * 2 + 1] = 0; }
      pressure.clear();
      for (const [c, att, p] of s.c) {
        pressure.set(c, { attacker: att, p: p / 255 });
        pressData[c * 2] = p;
        pressData[c * 2 + 1] = att;
      }
      if (changed) pressTex.needsUpdate = true;
      if (s.f.length) {
        for (const [c, o] of s.f) onFlip(c, o);
        ownerTex.needsUpdate = true;
        // Three cells taken near you within 4 seconds: a breakthrough.
        while (captureTimes.length && t - captureTimes[0] > 4) captureTimes.shift();
        if (captureTimes.length >= 3 && t - lastBreakthrough > 6) {
          lastBreakthrough = t;
          const el = $('breakthrough');
          el.hidden = false;
          setTimeout(() => { el.hidden = true; }, 1600);
          sfx.breakthrough();
          shake = Math.max(shake, 0.3);
        }
      }
      for (const shot of s.s) spawnBullet(shot);
      for (const imp of s.i) impact(imp);
      for (const k of s.ka || []) addCrate(k);
      for (const id of s.kr || []) removeCrate(id);
    },
    playerJoined(info) {
      addPlayer(info);
      if (!info.bot) feed([[info.name, info.country], ` joined for ${nameOf(info.country)}`]);
    },
    playerLeft(id) { removePlayer(id); },
    weaponDrop({ given, nextDropAt: next }) {
      nextDropAt = next;
      for (const [id, w] of given) {
        const p = players.get(id);
        if (!p) continue;
        p.info.weapon = w;
        p.ch.setWeapon(w);
        if (id === myId) toast(`New weapon: ${WEAPONS[w].name}. You push borders ${pushBonus(WEAPONS[w])} faster.`);
      }
      updateWeaponHud();
    },
    kill({ killer, victim, weapon, respawnAt, bounty, life }) {
      const k = players.get(killer);
      const v = players.get(victim);
      if (!v) return;
      const wName = WEAPONS[weapon]?.name || '';
      feed([
        k ? [k.info.name, k.info.country] : ['?', 0],
        bounty ? ' claimed the bounty on ' : ' shot ',
        [v.info.name, v.info.country],
        { w: wName },
      ]);
      if (killer === myId && bounty) banner(`Bounty claimed on ${v.info.name}!`);
      const d = distToMe(v.x, v.y);
      if (victim !== myId && d < 10 && v.info.country !== me.country) spawnRing(v.x, v.y, '#ef6461', 0.8, 0.4);
      if (victim === myId) {
        me.alive = false;
        sfx.death();
        shake = Math.max(shake, 0.4);
        showDeath({ k, wName, respawnAt, life, bounty });
      }
    },
    bounty({ id }) {
      const p = players.get(id);
      if (!p) return;
      feed([[p.info.name, p.info.country], ` is on a ${BOUNTY_STREAK}-kill streak: bounty is on!`]);
    },
    capital({ name, home, from, to }) {
      if (to === me.country) { banner(`${nameOf(to)} took ${name}!`); sfx.breakthrough(); }
      else if (home === me.country || from === me.country) { banner(`${nameOf(to)} took our capital ${name}!`, true); sfx.alert(); }
      else feed([[nameOf(to), to], ` took ${name}`]);
    },
    crate({ id, by, type, weapon }) {
      removeCrate(id);
      const p = players.get(by);
      if (weapon && p) { p.info.weapon = weapon; p.ch.setWeapon(weapon); }
      if (by === myId) {
        sfx.crate();
        toast(weapon ? `${CRATE_INFO[type].text}: ${WEAPONS[weapon].name}.` : `${CRATE_INFO[type].name}! ${CRATE_INFO[type].text}.`);
        updateWeaponHud();
      }
    },
    roundEnd(r) { showRoundEnd(r); },
    roundStart({ round: next, grid: buf }) {
      round = next;
      grid.set(new Uint8Array(buf));
      counts.fill(0);
      for (let i = 0; i < grid.length; i++) counts[grid[i]]++;
      ownerTex.needsUpdate = true;
      for (const c of pressure.keys()) { pressData[c * 2] = 0; pressData[c * 2 + 1] = 0; }
      pressure.clear();
      pressTex.needsUpdate = true;
      for (const cap of capitals.values()) refreshCapital(cap);
      painter.paint({ mine: me.country });
      miniChanged.length = 0;
      lastMyScore = 0;
      toast(`Round ${round.n} has begun. The map is back to the real world.`, 5000);
    },
    eliminated({ id }) { if (id === myId) onExit('eliminated'); },
    chat(m) { addChatLine(m); },
    chatRefused({ reason }) { addChatLine({ system: true, text: reason }); },
  };
  for (const [ev, fn] of Object.entries(handlers)) socket.on(ev, fn);

  // ---------- death summary ----------
  function showDeath({ k, wName, respawnAt, life, bounty }) {
    deathUntil = respawnAt;
    lastLife = life || lastLife;
    $('deathText').textContent = k
      ? `${k.info.name} shot you${wName ? ` with a ${wName.toLowerCase()}` : ''}.${bounty ? ' They claimed the bounty on you.' : ''}`
      : 'You were shot.';
    const stats = [['Cells taken', lastLife.captures], ['Kills', lastLife.kills], ['Points', lastLife.score], ['Rank', `#${myRank() || '-'}`]];
    $('deathStats').replaceChildren(...stats.map(([dt, dd]) => {
      const div = document.createElement('div');
      const a = document.createElement('dt'); a.textContent = dt;
      const b = document.createElement('dd'); b.textContent = typeof dd === 'number' ? fmt(dd) : dd;
      div.append(a, b);
      return div;
    }));
    $('deathBox').hidden = false;
  }
  async function shareMoment(title, subtitle) {
    const url = inviteUrl(myCountry?.code || '');
    const card = drawShareCard({ painter, countryId: me.country, title, subtitle, url });
    const msg = await shareCard(card, { text: `Join me on Hudut and push ${myCountry?.name || 'our'} borders!`, url });
    if (msg) toast(msg, 5000);
  }
  on($('deathShare'), 'click', () => shareMoment(
    `I fought for ${myCountry?.name || 'my country'}`,
    `${plural(lastLife.captures, 'cell', 'cells')} taken · ${plural(lastLife.kills, 'kill', 'kills')} · ${fmt(lastLife.score)} points`,
  ));
  on($('deathChange'), 'click', () => onExit('change'));

  // ---------- round results ----------
  let roundShare = null;
  function showRoundEnd({ n, winner, standings, players: best }) {
    $('roundEyebrow').textContent = `Round ${n} is over`;
    $('roundTitle').textContent = winner
      ? `${nameOf(winner.id)} wins! +${fmt(winner.gained)} cells, ${(winner.share * 100).toFixed(1)}% of the world`
      : 'Nobody gained ground this round.';
    $('roundCountries').replaceChildren(...(standings || []).map((c) => {
      const li = document.createElement('li');
      const b = document.createElement('b'); b.textContent = nameOf(c.id); b.style.color = colorOf(c.id);
      li.append(b, ` +${fmt(c.gained)}`);
      return li;
    }));
    $('roundPlayers').replaceChildren(...(best || []).map((p) => {
      const li = document.createElement('li');
      const b = document.createElement('b'); b.textContent = p.name; b.style.color = colorOf(p.country);
      li.append(b, ` ${fmt(p.score)} pts`);
      return li;
    }));
    roundShare = winner ? [`${nameOf(winner.id)} won round ${n} on Hudut`, `+${fmt(winner.gained)} cells · ${(winner.share * 100).toFixed(1)}% of the world`] : null;
    $('roundShare').hidden = !roundShare;
    $('roundBox').hidden = false;
    setTimeout(() => { $('roundBox').hidden = true; }, 15000);
  }
  on($('roundShare'), 'click', () => { if (roundShare) shareMoment(...roundShare); });
  on($('roundClose'), 'click', () => { $('roundBox').hidden = true; });

  // ---------- buttons ----------
  function goFront() {
    socket.timeout(5000).emit('toFront', (err, res) => {
      if (err || !res) toast("The server didn't answer. Try again.");
      else if (res.error) toast(res.error);
      else toast('To the front!', 1500);
    });
  }
  function toggleSound() {
    setMuted(!isMuted());
    $('btnSound').textContent = isMuted() ? 'Sound: off' : 'Sound: on';
    if (isMuted()) sfx.rumble(false);
  }
  function setMoveMode(m) {
    moveMode = m;
    store.set('hudut.move', m);
    $('btnMove').textContent = m === 'mouse' ? 'Move: mouse' : 'Move: keys';
  }
  $('btnSound').textContent = isMuted() ? 'Sound: off' : 'Sound: on';
  setMoveMode(moveMode);
  on($('btnFront'), 'click', goFront);
  on($('btnSound'), 'click', toggleSound);
  on($('btnMove'), 'click', () => {
    setMoveMode(moveMode === 'mouse' ? 'keys' : 'mouse');
    toast(moveMode === 'mouse' ? 'Your soldier now walks toward the mouse. Click to shoot.' : 'Walk with W A S D or the arrow keys.');
  });
  on($('btnInvite'), 'click', async () => {
    const url = inviteUrl(myCountry?.code || '');
    toast((await copyText(url)) ? `Invite link copied. Send it to friends: ${url}` : `Your invite link: ${url}`, 6000);
  });
  on($('btnChangeCountry'), 'click', () => onExit('change'));

  // ---------- chat ----------
  // Enter opens the box, Enter sends, Esc closes, Tab switches between everyone and your team.
  // Clicking a name in chat mutes (or unmutes) that player on this device.
  const chatBox = $('chat');
  const chatForm = $('chatForm');
  const chatInput = $('chatInput');
  const chatScope = $('chatScope');
  const chatLog = $('chatLog');
  const muted = new Set(store.get('hudut.mutedNames', []));
  let chatOpen = false;
  let chatTeam = false;
  chatLog.replaceChildren();
  function setChatScope(team) {
    chatTeam = team;
    chatScope.textContent = team ? 'Team' : 'All';
    chatScope.classList.toggle('team', team);
    chatScope.setAttribute('aria-pressed', String(team));
    chatInput.placeholder = team ? `Message ${myCountry?.name || 'your team'}…` : 'Message everyone…';
  }
  function openChat() {
    if (chatOpen) return;
    chatOpen = true;
    keys.clear();
    mouseFiring = false;
    chatBox.classList.add('open');
    chatForm.hidden = false;
    $('chatHint').hidden = true;
    chatInput.focus({ preventScroll: true });
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function closeChat() {
    chatOpen = false;
    chatBox.classList.remove('open');
    chatForm.hidden = true;
    $('chatHint').hidden = false;
    chatInput.value = '';
    chatInput.blur();
  }
  function toggleMute(name) {
    const key = name.toLowerCase();
    if (muted.has(key)) { muted.delete(key); addChatLine({ system: true, text: `Unmuted ${name}.` }); }
    else { muted.add(key); addChatLine({ system: true, text: `Muted ${name}. Click their name again to unmute.` }); }
    store.set('hudut.mutedNames', [...muted]);
  }
  function addChatLine({ id, name, country, text, team, system }) {
    if (!system && muted.has(String(name).toLowerCase())) return;
    const li = document.createElement('li');
    if (system) {
      li.className = 'system';
      li.textContent = text;
    } else {
      if (team) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'Team';
        li.append(tag, ' ');
      }
      const b = document.createElement('b');
      b.textContent = name;
      b.style.color = colorOf(country);
      if (id !== myId) {
        b.style.cursor = 'pointer';
        b.title = 'Click to mute';
        b.addEventListener('click', () => toggleMute(name));
      }
      li.append(b, ': ', text);
    }
    chatLog.append(li);
    while (chatLog.children.length > 60) chatLog.firstChild.remove();
    chatLog.scrollTop = chatLog.scrollHeight;
    setTimeout(() => li.classList.add('faded'), 15000);
  }
  setChatScope(false);
  on(chatForm, 'submit', (e) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (text) socket.emit('chat', { text, team: chatTeam });
    closeChat();
  });
  on(chatInput, 'keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
    else if (e.key === 'Tab') { e.preventDefault(); setChatScope(!chatTeam); }
  });
  on(chatScope, 'click', () => { setChatScope(!chatTeam); chatInput.focus({ preventScroll: true }); });

  // ---------- HUD refresh ----------
  let lastPush = 0;
  let lastPushCell = -1;
  function updateHud() {
    const cells = counts[me.country];
    $('hudCells').textContent = fmt(cells);
    let online = 0;
    for (const p of players.values()) if (p.info.country === me.country) online++;
    $('hudOnline').textContent = online;
    const gained = cells - (round.start?.[me.country] || 0);
    $('hudRound').textContent = `Round ${round.n} · ${duration(round.endsAt - serverNow())} left · ${gained >= 0 ? '+' : ''}${fmt(gained)} cells`;
    const f = underdogFactor(cells);
    const ud = $('hudUnderdog');
    ud.hidden = Math.abs(f - 1) < 0.03;
    ud.textContent = f > 1 ? `Underdog bonus: push ${Math.round((f - 1) * 100)}% faster` : `Big country: push ${Math.round((1 - f) * 100)}% slower`;
    const left = Math.max(0, nextDropAt - serverNow());
    $('hudDrop').textContent = `${String(Math.floor(left / 60000)).padStart(2, '0')}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
    const myP = players.get(myId);
    const hp = myP ? myP.hp : MAX_HP;
    $('hpBar').style.width = `${hp}%`;
    $('hpBar').style.background = hp > 50 ? 'var(--ok)' : hp > 25 ? 'var(--accent)' : 'var(--danger)';
    $('hpText').textContent = me.alive ? hp : 0;
    $('scoreChip').textContent = `${fmt(myP ? myP.score : 0)} pts`;
    if (deathUntil) {
      $('deathTimer').textContent = Math.max(0, Math.ceil((deathUntil - serverNow()) / 1000));
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
    const boosts = [];
    if (myFlags & 16) boosts.push('morale');
    if (myFlags & 32) boosts.push('push boost');
    $('pushTitle').textContent = capitals.has(me.pushCell)
      ? `Pushing on ${capitals.get(me.pushCell).name} (capital: slower)`
      : boosts.length ? `Pushing the border · ${boosts.join(' + ')}` : 'Pushing the border';
    let mates = 0;
    let foesNear = 0;
    for (const p of players.values()) {
      if (p.info.id === myId || !p.alive) continue;
      const d = distToMe(p.x, p.y);
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
  function updateBoard() {
    const ranked = humansByScore();
    const rows = ranked.slice(0, 5).map((p) => {
      const li = document.createElement('li');
      if (p.info.id === myId) li.className = 'me';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = p.info.name; nm.style.color = p.info.id === myId ? '' : colorOf(p.info.country);
      const pt = document.createElement('span'); pt.className = 'pt'; pt.textContent = fmt(p.score);
      li.append(nm, pt);
      return li;
    });
    $('boardPlayers').replaceChildren(...rows);
    const rank = ranked.findIndex((p) => p.info.id === myId) + 1;
    $('boardMe').textContent = rank > 5 ? `You: #${rank} · ${fmt(ranked[rank - 1].score)} pts` : '';
    const growth = [];
    for (const c of countries) {
      const g = counts[c.id] - (round.start?.[c.id] || 0);
      if (g > 0) growth.push([c.id, g]);
    }
    growth.sort((a, b) => b[1] - a[1]);
    $('boardCountries').replaceChildren(...growth.slice(0, 3).map(([id, g]) => {
      const li = document.createElement('li');
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = nameOf(id); nm.style.color = colorOf(id);
      const pt = document.createElement('span'); pt.className = 'pt'; pt.textContent = `+${fmt(g)}`;
      li.append(nm, pt);
      return li;
    }));
  }

  // ---------- minimap ----------
  const mini = $('minimap');
  const miniCtx = mini.getContext('2d');
  const painter = new MapPainter(countries);
  painter.setGrid(grid);
  const miniSrc = painter.paint({ mine: me.country });
  let miniAt = 0;
  function drawMinimap(now) {
    // Repaint only the cells that changed hands (a full repaint walks 259,200 cells).
    if (miniChanged.length && now - miniAt > 500) {
      painter.update(miniChanged, { mine: me.country });
      miniChanged.length = 0;
      miniAt = now;
    }
    const W = mini.width, H = mini.height;
    const sx = W / GRID_W, sy = H / GRID_H;
    miniCtx.imageSmoothingEnabled = false;
    miniCtx.drawImage(miniSrc, 0, 0, W, H);
    // Our fronts pulse: gold where we push, red where we are pushed.
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    for (const [c, st] of pressure) {
      const ours = st.attacker === me.country;
      if (!ours && grid[c] !== me.country) continue;
      const [cx, cy] = cellXY(c);
      miniCtx.fillStyle = ours ? `rgba(240,180,76,${0.5 + 0.5 * pulse})` : `rgba(239,100,97,${0.5 + 0.5 * pulse})`;
      miniCtx.fillRect(cx * sx - 2, cy * sy - 2, 4, 4);
    }
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
  let sendAcc = 0;
  let hudAcc = 0;
  let boardAcc = 0;
  let pushHoldUntil = 0;
  let moveAngle = 0;
  let facing = 0;
  camera.position.set(camX, 0, me.y).addScaledVector(camOffset, zoom);
  camera.lookAt(camX, 0.6, me.y);

  // Position of another player at render time `rt`, between the two snapshots around it.
  function sampleRemote(p, rt) {
    const b = p.buf;
    if (!b.length) return;
    let i = 0;
    while (i < b.length - 1 && b[i + 1].t <= rt) i++;
    const A = b[i];
    const B = b[i + 1];
    if (!B || rt <= A.t) { p.x = A.x; p.y = A.y; p.aim = A.a; return; }
    const f = (rt - A.t) / Math.max(1, B.t - A.t);
    p.x = wrapX(A.x + wrapDelta(B.x - A.x) * f);
    p.y = A.y + (B.y - A.y) * f;
    p.aim = lerpAngle(A.a, B.a, f);
  }
  function nearestEnemy(range) {
    let best = null, bd = range;
    for (const p of players.values()) {
      if (!p.alive || p.info.country === me.country || !p.seen) continue;
      const d = distToMe(p.x, p.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;

    // Aim from the mouse (using last frame's camera).
    ray.setFromCamera(ndc, camera);
    if (ray.ray.intersectPlane(aimPlane, hit)) {
      aim = Math.atan2(hit.z - me.y, hit.x - camX);
      aimDist = Math.hypot(hit.x - camX, hit.z - me.y);
    }
    const [dx, dy] = moveDir();
    if (dx || dy) moveAngle = Math.atan2(dy, dx);

    // We move ourselves with the same rules the server checks against. "Pushing" is held for a
    // moment so that sliding along a border doesn't flip the pose every frame.
    if (me.alive) {
      const r = stepMovement(grid, me.country, me.x, me.y, dx, dy, dt);
      camX += wrapDelta(r.x - me.x);
      me.x = r.x;
      me.y = r.y;
      if (r.pushCell >= 0) { me.pushCell = r.pushCell; pushHoldUntil = t + POSE_HOLD_S; }
      else if (t > pushHoldUntil) me.pushCell = -1;
    } else {
      me.pushCell = -1;
    }
    const pushing = me.pushCell >= 0;
    sfx.rumble(pushing && me.alive);

    const myP = players.get(myId);
    const weapon = myP && WEAPONS[myP.info.weapon];
    let shooting = false;
    let shootAim = aim;
    if (weapon && me.alive) {
      if (touch && touch.state.fire) {
        // Touch: aim at the nearest enemy in range by itself.
        const target = nearestEnemy(weapon.range);
        shooting = true;
        shootAim = target ? Math.atan2(target.y - me.y, wrapDelta(target.x - me.x)) : facing;
      } else if (mouseFiring) {
        shooting = true;
      }
    }
    // Face the border while pushing, otherwise the mouse (or the way we walk on touch); turn smoothly.
    const idleFacing = touch && !pointerInside ? moveAngle : aim;
    const wantFacing = shooting ? shootAim : pushing ? moveAngle : idleFacing;
    facing = lerpAngle(facing, wantFacing, 1 - Math.exp(-16 * dt));

    sendAcc += dt;
    if (sendAcc >= 0.05) {
      sendAcc = 0;
      socket.emit('input', {
        dx, dy,
        aim: shooting ? shootAim : facing,
        fire: shooting,
        x: Math.round(me.x * 1000) / 1000,
        y: Math.round(me.y * 1000) / 1000,
        tp: me.tp,
      });
    }

    shake = Math.max(0, shake - dt * 1.5);
    const sh = shake * shake * 1.2;
    camera.position.set(camX + (Math.random() - 0.5) * sh, 0, me.y + (Math.random() - 0.5) * sh).addScaledVector(camOffset, zoom);
    camera.lookAt(camX, 0.6, me.y);
    camera.updateMatrixWorld();

    // Map tiles follow the camera so the world wraps east-west.
    const base = Math.floor(camX / GRID_W) * GRID_W;
    mapMeshes.forEach((m, i) => m.position.set(base + (i - 1) * GRID_W + GRID_W / 2, 0, GRID_H / 2));
    mapMat.uniforms.uTime.value = t;

    // Characters
    const renderT = Date.now() + (serverOffset ?? 0) - INTERP_MS;
    for (const p of players.values()) {
      if (p.info.id === myId) {
        p.ch.root.visible = me.alive;
        p.ch.root.position.set(camX, 0, me.y);
        p.ch.root.rotation.y = -facing;
        p.ch.animate(t, dt, { moving: !!(dx || dy) && !pushing, pushing });
      } else {
        if (!p.seen) continue;
        sampleRemote(p, renderT);
        p.ch.root.visible = p.alive;
        p.ch.root.position.set(rx(p.x), 0, p.y);
        p.ch.root.rotation.y = -p.aim;
        p.ch.animate(t, dt, { moving: p.moving, pushing: p.pushing });
      }
      p.hpi.style.width = `${Math.max(0, p.hp)}%`;
    }

    // Capital flags (only the ones near the camera, so labels don't clutter the screen)
    for (const cap of capitals.values()) {
      const [cx, cy] = cellXY(cap.cell);
      const near = Math.abs(wrapDelta(cx + 0.5 - wrapX(camX))) < 30 && Math.abs(cy + 0.5 - me.y) < 22;
      cap.group.visible = near;
      if (near) cap.group.position.set(rx(cx + 0.5), 0, cy + 0.5);
    }
    // Crates bob and spin
    for (const k of crates.values()) {
      k.mesh.position.set(rx(k.x), 0.45 + Math.sin(t * 2.5 + k.phase) * 0.08, k.y);
      k.mesh.rotation.y += dt * 1.2;
    }

    // Bullets & effects
    for (const [id, b] of bullets) {
      b.x = wrapX(b.x + b.vx * dt);
      b.y += b.vy * dt;
      b.left -= b.speed * dt;
      if (b.left <= 0) { removeBullet(id); continue; }
      b.mesh.position.set(rx(b.x), 0.8, b.y);
    }
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      e.age += dt;
      const q = e.age / e.life;
      if (q >= 1) {
        scene.remove(e.obj);
        if (e.kind === 'ring') e.obj.material.dispose();
        effects.splice(i, 1);
        continue;
      }
      if (e.kind === 'ring') {
        e.obj.position.x = rx(e.x);
        e.obj.scale.setScalar(e.size * (0.3 + q));
        e.obj.material.opacity = 0.9 * (1 - q);
      } else {
        e.obj.position.set(rx(e.x), 2.2 + q * 1.4, e.y);
        e.obj.element.style.opacity = String(1 - q * q);
      }
    }

    renderer.render(scene, camera);
    labels.render(scene, camera);

    hudAcc += dt;
    boardAcc += dt;
    if (hudAcc > 0.1) { hudAcc = 0; updateHud(); drawMinimap(now); }
    if (boardAcc > 0.5) { boardAcc = 0; updateBoard(); }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);
  updateHud();
  updateBoard();

  // ---------- teardown ----------
  function stop() {
    cancelAnimationFrame(raf);
    ac.abort();
    for (const [ev, fn] of Object.entries(handlers)) socket.off(ev, fn);
    clearTimeout(toastTimer);
    clearTimeout(bannerTimer);
    sfx.rumble(false);
    if (touch) touch.destroy();
    closeChat();
    chatLog.replaceChildren();
    for (const id of [...players.keys()]) removePlayer(id);
    for (const id of [...bullets.keys()]) removeBullet(id);
    for (const id of [...crates.keys()]) removeCrate(id);
    for (const cap of capitals.values()) { cap.group.remove(cap.label); scene.remove(cap.group); cap.flagMat.dispose(); }
    for (const e of effects) { scene.remove(e.obj); if (e.kind === 'ring') e.obj.material.dispose(); }
    [ownerTex, palTex, pressTex].forEach((x) => x.dispose());
    [mapGeo, bulletGeo, rocketGeo, ringGeo, crateGeo, poleGeo, flagGeo, baseGeo].forEach((x) => x.dispose());
    [...bulletMats, ...crateMats, poleMat].forEach((x) => x.dispose());
    mapMat.dispose();
    renderer.dispose();
    canvas.remove();
    labels.domElement.remove();
    root.hidden = true;
    hud.hidden = true;
    for (const id of ['toast', 'banner', 'breakthrough', 'deathBox', 'roundBox', 'pushBox']) $(id).hidden = true;
  }
  return { stop };
}
