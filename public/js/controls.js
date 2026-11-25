// Touch controls for phones and tablets: drag anywhere on the left half to walk (a joystick appears
// under your thumb), hold FIRE on the right to shoot (it aims at the nearest enemy by itself).
export const isTouchDevice = () =>
  (window.matchMedia && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;

export function createTouchControls({ root, onFront, onChat }) {
  const ui = document.createElement('div');
  ui.className = 'touch-ui';
  ui.innerHTML = `
    <div class="stick" hidden><i></i></div>
    <div class="touch-buttons">
      <button type="button" class="tbtn small" data-act="chat">Chat</button>
      <button type="button" class="tbtn small" data-act="front">Front</button>
      <button type="button" class="tbtn fire" data-act="fire">FIRE</button>
    </div>`;
  root.appendChild(ui);
  const stick = ui.querySelector('.stick');
  const knob = stick.querySelector('i');
  const state = { dx: 0, dy: 0, fire: false };
  let stickId = null;
  let ox = 0, oy = 0;
  const R = 56;

  const onDown = (e) => {
    if (e.pointerType !== 'touch' || stickId !== null || e.clientX > window.innerWidth * 0.55) return;
    if (e.target.closest('.touch-buttons, .chat, .panel, button, input')) return;
    stickId = e.pointerId;
    ox = e.clientX; oy = e.clientY;
    stick.style.left = `${ox}px`;
    stick.style.top = `${oy}px`;
    knob.style.transform = 'translate(-50%, -50%)';
    stick.hidden = false;
  };
  const onMove = (e) => {
    if (e.pointerId !== stickId) return;
    let dx = e.clientX - ox, dy = e.clientY - oy;
    const len = Math.hypot(dx, dy);
    if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    // Screen up is north on the map, so screen x/y map straight onto map x/y.
    state.dx = len > 8 ? dx / R : 0;
    state.dy = len > 8 ? dy / R : 0;
  };
  const onUp = (e) => {
    if (e.pointerId !== stickId) return;
    stickId = null;
    state.dx = 0; state.dy = 0;
    stick.hidden = true;
  };
  window.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  const fireBtn = ui.querySelector('[data-act="fire"]');
  const setFire = (v) => { state.fire = v; fireBtn.classList.toggle('on', v); };
  fireBtn.addEventListener('pointerdown', (e) => { e.preventDefault(); setFire(true); });
  fireBtn.addEventListener('pointerup', () => setFire(false));
  fireBtn.addEventListener('pointercancel', () => setFire(false));
  fireBtn.addEventListener('pointerleave', () => setFire(false));
  ui.querySelector('[data-act="front"]').addEventListener('click', onFront);
  ui.querySelector('[data-act="chat"]').addEventListener('click', onChat);

  return {
    state,
    destroy() {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      ui.remove();
    },
  };
}
