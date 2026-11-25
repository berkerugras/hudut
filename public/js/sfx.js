// Small synthesized sound effects (no audio files). Audio can only start after a click or key press,
// so unlockAudio() is called from the Play button.
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let ctx = null;
let master = null;
let noiseBuf = null;
let rumble = null;
let muted = !!store.get('hudut.soundOff', false);

export function unlockAudio() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.45;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
  } catch { ctx = null; }
}
export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  store.set('hudut.soundOff', m);
  if (master) master.gain.value = m ? 0 : 0.45;
}

function tone(freq, dur, { type = 'sine', vol = 0.2, to = 0, delay = 0 } = {}) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(Math.max(30, to), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}
function burst(dur, { vol = 0.2, freq = 1200, q = 0.8, delay = 0 } = {}) {
  if (!ctx || muted) return;
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t, Math.random());
  src.stop(t + dur + 0.05);
}

export const sfx = {
  // near: 1 next to you, 0 far away
  shot(weapon, near = 1) {
    const v = 0.05 + 0.2 * near;
    if (weapon === 'roket') { burst(0.35, { vol: v, freq: 300 }); tone(160, 0.3, { type: 'sawtooth', vol: v * 0.4, to: 60 }); }
    else if (weapon === 'pompali') burst(0.22, { vol: v * 1.2, freq: 700 });
    else if (weapon === 'keskin') { burst(0.16, { vol: v, freq: 2200, q: 1.5 }); tone(900, 0.12, { type: 'square', vol: v * 0.2, to: 300 }); }
    else burst(0.09, { vol: v, freq: weapon === 'tufek' ? 1700 : 1300 });
  },
  explosion(near = 1) { burst(0.6, { vol: 0.1 + 0.3 * near, freq: 180, q: 0.5 }); },
  hurt() { tone(220, 0.15, { type: 'square', vol: 0.12, to: 120 }); },
  death() { tone(330, 0.6, { type: 'triangle', vol: 0.2, to: 70 }); },
  capture() { tone(660, 0.12, { type: 'triangle', vol: 0.16 }); tone(990, 0.18, { type: 'triangle', vol: 0.14, delay: 0.08 }); },
  lost() { tone(300, 0.25, { type: 'sawtooth', vol: 0.08, to: 180 }); },
  breakthrough() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, { type: 'triangle', vol: 0.18, delay: i * 0.08 })); },
  crate() { tone(880, 0.1, { vol: 0.15 }); tone(1320, 0.16, { vol: 0.13, delay: 0.07 }); },
  alert() { tone(740, 0.14, { type: 'square', vol: 0.1 }); tone(740, 0.14, { type: 'square', vol: 0.1, delay: 0.2 }); },
  // Low rumble while pushing a border.
  rumble(on) {
    if (!ctx) return;
    if (on && !rumble && !muted) {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 140;
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      g.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 0.2);
      src.connect(f).connect(g).connect(master);
      src.start();
      rumble = { src, g };
    } else if ((!on || muted) && rumble) {
      const r = rumble;
      rumble = null;
      r.g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
      r.src.stop(ctx.currentTime + 0.2);
    }
  },
};
