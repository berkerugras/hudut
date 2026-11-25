// Shared by the server (Node) and the browser. Plain ES module, no dependencies.

// ---- World grid: equirectangular, 0.5 degree cells ----
export const CELL_DEG = 0.5;
export const GRID_W = 720; // 360 / 0.5
export const GRID_H = 360; // 180 / 0.5
export const OCEAN = 0;
export const ICE = 255; // Antarctica: nobody can own it

// ---- Players ----
export const PLAYER_SPEED = 5; // cells per second
export const PLAYER_RADIUS = 0.3;
export const HIT_RADIUS = 0.45;
export const MAX_HP = 100;
export const RESPAWN_MS = 5000;
export const TICK_HZ = 20;

// ---- Border pressure ----
// Each pushing player adds 1 force to the cell in front of them and 0.5 to the two cells beside it.
// Defenders push back with exactly the same numbers from their side.
// One player's net force can bend a cell only up to SOLO_CAP; a cell flips at 1.0, so it takes a group.
export const PUSH_BASE_RATE = 0.12; // pressure per second per unit of net push speed
export const SOLO_CAP = 0.5; // max pressure per 1.0 of net force
export const PRESSURE_DECAY = 0.08; // per second, when nobody pushes
export const SIDE_FORCE = 0.5;

// ---- Weapons ----
// push: multiplier on how fast the holder moves a border (never on how far one player can push it)
export const WEAPONS = {
  tabanca: { name: 'Tabanca', damage: 20, cooldown: 420, speed: 28, range: 11, pellets: 1, spread: 0.03, push: 1.3, splash: 0, len: 0.22 },
  tufek: { name: 'Piyade tüfeği', damage: 11, cooldown: 130, speed: 34, range: 13, pellets: 1, spread: 0.06, push: 1.5, splash: 0, len: 0.42 },
  pompali: { name: 'Pompalı', damage: 10, cooldown: 900, speed: 26, range: 6.5, pellets: 6, spread: 0.3, push: 1.7, splash: 0, len: 0.38 },
  keskin: { name: 'Keskin nişancı', damage: 75, cooldown: 1600, speed: 60, range: 26, pellets: 1, spread: 0, push: 1.4, splash: 0, len: 0.55 },
  roket: { name: 'Roketatar', damage: 60, cooldown: 2200, speed: 16, range: 18, pellets: 1, spread: 0, push: 2.0, splash: 2.2, len: 0.5 },
};
export const WEAPON_IDS = Object.keys(WEAPONS);

// ---- Character customisation (indices into these lists) ----
export const LOOK = {
  skin: ['#f3d2b3', '#e0ac85', '#c68863', '#8d5a3c', '#5b3a29'],
  shirt: ['#d64545', '#e8873a', '#e3c34a', '#4caf6e', '#3a8fd6', '#6a5acd', '#2f3a4a', '#efefef'],
  pants: ['#2b3442', '#4a5568', '#6b4f3a', '#3d5a40', '#1f2a5a'],
  head: ['round', 'box'],
  hat: ['none', 'cap', 'helmet', 'beanie'],
};
export function sanitizeLook(look) {
  const pick = (key) => {
    const n = Number(look && look[key]);
    return Number.isInteger(n) && n >= 0 && n < LOOK[key].length ? n : 0;
  };
  return { skin: pick('skin'), shirt: pick('shirt'), pants: pick('pants'), head: pick('head'), hat: pick('hat') };
}

// ---- Grid helpers ----
export const wrapX = (x) => ((x % GRID_W) + GRID_W) % GRID_W;
export function wrapDelta(dx) {
  if (dx > GRID_W / 2) return dx - GRID_W;
  if (dx < -GRID_W / 2) return dx + GRID_W;
  return dx;
}
export function cellAt(x, y) {
  const cy = Math.floor(y);
  if (cy < 0 || cy >= GRID_H) return -1;
  return cy * GRID_W + Math.floor(wrapX(x));
}
export function cellXY(c) {
  return [c % GRID_W, Math.floor(c / GRID_W)];
}
export function cellOffset(c, dx, dy) {
  const [x, y] = cellXY(c);
  const ny = y + dy;
  if (ny < 0 || ny >= GRID_H) return -1;
  return ny * GRID_W + (((x + dx) % GRID_W) + GRID_W) % GRID_W;
}
export const isLand = (owner) => owner !== OCEAN && owner !== ICE;

/**
 * Moves a player one step. Players can only walk on their own country's cells.
 * Walking into a foreign land cell is "pushing" it: we report that cell as pushCell.
 */
export function stepMovement(grid, country, x, y, dx, dy, dt) {
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return { x, y, pushCell: -1 };
  const ux = dx / len;
  const uy = dy / len;
  const step = PLAYER_SPEED * dt;
  const own = (c) => c >= 0 && grid[c] === country;
  const foreign = (c) => c >= 0 && grid[c] !== country && isLand(grid[c]);
  const ox = x;
  const oy = y;
  let pushCell = -1;
  let pushWeight = 0;

  if (Math.abs(ux) > 0.001) {
    const tx = x + ux * step;
    const c = cellAt(tx + Math.sign(ux) * PLAYER_RADIUS, y);
    if (own(c)) x = tx;
    else if (foreign(c) && Math.abs(ux) > pushWeight) { pushCell = c; pushWeight = Math.abs(ux); }
  }
  if (Math.abs(uy) > 0.001) {
    const ty = y + uy * step;
    const c = cellAt(x, ty + Math.sign(uy) * PLAYER_RADIUS);
    if (own(c)) y = ty;
    else if (foreign(c) && Math.abs(uy) > pushWeight) { pushCell = c; pushWeight = Math.abs(uy); }
  }
  if (!own(cellAt(x, y))) { x = ox; y = oy; }
  if (pushWeight < 0.4) pushCell = -1;
  return { x: wrapX(x), y, pushCell };
}
