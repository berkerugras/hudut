// Simple low-poly character built from primitives. Faces +X; the game rotates it to face where it aims.
import * as THREE from 'three';
import { LOOK, WEAPONS } from '/shared/constants.js';

const geo = {
  leg: new THREE.BoxGeometry(0.17, 0.44, 0.19).translate(0, -0.22, 0),
  torso: new THREE.BoxGeometry(0.27, 0.48, 0.46),
  arm: new THREE.BoxGeometry(0.13, 0.4, 0.13).translate(0, -0.18, 0),
  hand: new THREE.BoxGeometry(0.12, 0.1, 0.12),
  headRound: new THREE.SphereGeometry(0.21, 18, 14),
  headBox: new THREE.BoxGeometry(0.38, 0.38, 0.38),
  eye: new THREE.BoxGeometry(0.03, 0.065, 0.05),
  dome: new THREE.SphereGeometry(0.225, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2),
  brim: new THREE.BoxGeometry(0.2, 0.03, 0.3),
  helmet: new THREE.SphereGeometry(0.255, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2.1),
  beanie: new THREE.CylinderGeometry(0.19, 0.225, 0.2, 18),
  pompom: new THREE.SphereGeometry(0.065, 10, 8),
  shadow: new THREE.CircleGeometry(0.36, 24).rotateX(-Math.PI / 2),
  gunGrip: new THREE.BoxGeometry(0.07, 0.07, 0.14),
};
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false });

function mat(hex) {
  return new THREE.MeshStandardMaterial({ color: hex, roughness: 0.85, metalness: 0, flatShading: true });
}

export function buildCharacter(look) {
  const L = {
    skin: LOOK.skin[look.skin] || LOOK.skin[0],
    shirt: LOOK.shirt[look.shirt] || LOOK.shirt[0],
    pants: LOOK.pants[look.pants] || LOOK.pants[0],
    head: LOOK.head[look.head] || 'round',
    hat: LOOK.hat[look.hat] || 'none',
  };
  const mats = [];
  const m = (hex) => { const x = mat(hex); mats.push(x); return x; };
  const skin = m(L.skin);
  const shirt = m(L.shirt);
  const pants = m(L.pants);
  const dark = m('#1c2127');

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const shadow = new THREE.Mesh(geo.shadow, shadowMat);
  shadow.position.y = 0.02;
  shadow.renderOrder = 1;
  root.add(shadow);

  const legL = new THREE.Mesh(geo.leg, pants); legL.position.set(0, 0.46, 0.11);
  const legR = new THREE.Mesh(geo.leg, pants); legR.position.set(0, 0.46, -0.11);
  const torso = new THREE.Mesh(geo.torso, shirt); torso.position.y = 0.7;
  body.add(legL, legR, torso);

  const makeArm = (z) => {
    const arm = new THREE.Group();
    arm.position.set(0, 0.9, z);
    const a = new THREE.Mesh(geo.arm, shirt);
    const h = new THREE.Mesh(geo.hand, skin); h.position.y = -0.41;
    arm.add(a, h);
    body.add(arm);
    return arm;
  };
  const armL = makeArm(0.3);
  const armR = makeArm(-0.3);

  const headY = 1.13;
  const head = new THREE.Mesh(L.head === 'box' ? geo.headBox : geo.headRound, skin);
  head.position.y = headY;
  body.add(head);
  const faceX = L.head === 'box' ? 0.195 : 0.19;
  for (const z of [0.075, -0.075]) {
    const e = new THREE.Mesh(geo.eye, dark);
    e.position.set(faceX, headY + 0.03, z);
    body.add(e);
  }

  const hatScale = L.head === 'box' ? 1.12 : 1;
  const hatY = headY + (L.head === 'box' ? 0.12 : 0.05);
  if (L.hat === 'cap') {
    const capMat = m(L.shirt);
    const top = new THREE.Mesh(geo.dome, capMat); top.position.y = hatY; top.scale.setScalar(hatScale);
    const brim = new THREE.Mesh(geo.brim, capMat); brim.position.set(0.2 * hatScale, hatY + 0.01, 0);
    body.add(top, brim);
  } else if (L.hat === 'helmet') {
    const hm = m('#56653a');
    const top = new THREE.Mesh(geo.helmet, hm); top.position.y = hatY - 0.03; top.scale.setScalar(hatScale);
    body.add(top);
  } else if (L.hat === 'beanie') {
    const bm = m(L.shirt);
    const top = new THREE.Mesh(geo.beanie, bm); top.position.y = hatY + 0.06; top.scale.setScalar(hatScale);
    const pom = new THREE.Mesh(geo.pompom, m('#f2f2f2')); pom.position.y = hatY + 0.2 * hatScale;
    body.add(top, pom);
  }

  // Weapon sits in the right hand and points along the arm.
  const gunHolder = new THREE.Group();
  gunHolder.position.y = -0.42;
  armR.add(gunHolder);
  let gunGeo = null;
  let weaponId = null;
  function setWeapon(id) {
    if (id === weaponId) return;
    weaponId = id;
    gunHolder.clear();
    if (gunGeo) { gunGeo.dispose(); gunGeo = null; }
    const w = id && WEAPONS[id];
    if (!w) return;
    const thick = w.splash ? 0.12 : 0.07;
    gunGeo = new THREE.BoxGeometry(thick, w.len, thick).translate(0, -w.len / 2 + 0.06, 0);
    const barrel = new THREE.Mesh(gunGeo, w.splash ? m('#4f5a36') : dark);
    const grip = new THREE.Mesh(geo.gunGrip, dark); grip.position.set(-0.05, 0, 0);
    gunHolder.add(barrel, grip);
  }

  const ease = (cur, target, k) => cur + (target - cur) * k;
  function animate(t, dt, { moving = false, pushing = false } = {}) {
    const k = Math.min(1, dt * 12);
    const swing = moving || pushing ? Math.sin(t * (pushing ? 8 : 11)) * (pushing ? 0.35 : 0.55) : 0;
    legL.rotation.z = ease(legL.rotation.z, swing, k);
    legR.rotation.z = ease(legR.rotation.z, -swing, k);
    body.rotation.z = ease(body.rotation.z, pushing ? -0.36 : 0, k);
    const armed = !!weaponId;
    const reach = 1.35;
    armL.rotation.z = ease(armL.rotation.z, pushing ? reach : -swing * 0.8, k);
    armR.rotation.z = ease(armR.rotation.z, pushing ? reach : armed ? 1.45 : swing * 0.8, k);
    if (!moving && !pushing) body.position.y = Math.sin(t * 2.2) * 0.012;
  }

  function dispose() {
    for (const x of mats) x.dispose();
    if (gunGeo) gunGeo.dispose();
  }

  return { root, setWeapon, animate, dispose };
}

// Turntable preview for the character screen.
export function createPreview(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xf0f6ff, 0x2a3a44, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(3.7, 1.7, 1.35);
  camera.lookAt(0, 0.72, 0);

  const ped = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.68, 0.08, 48),
    new THREE.MeshStandardMaterial({ color: '#2a3a44', roughness: 0.9 }),
  );
  ped.position.y = -0.04;
  scene.add(ped);

  let ch = null;
  let angle = 0.5;
  let dragging = false;
  let lastX = 0;
  let raf = 0;
  let lastT = performance.now();
  let t = 0;

  function setLook(look) {
    if (ch) { scene.remove(ch.root); ch.dispose(); }
    ch = buildCharacter(look);
    scene.add(ch.root);
  }
  function resize() {
    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 300;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  const down = (e) => { dragging = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); };
  const move = (e) => { if (!dragging) return; angle += (e.clientX - lastX) * 0.012; lastX = e.clientX; };
  const up = () => { dragging = false; };
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  function frame(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    t += dt;
    if (!dragging) angle += dt * 0.5;
    if (ch) {
      ch.root.rotation.y = angle;
      ch.animate(t, dt, {});
    }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (raf) return;
    resize();
    lastT = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  start();

  return {
    setLook,
    start,
    stop,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      if (ch) ch.dispose();
      renderer.dispose();
    },
  };
}
