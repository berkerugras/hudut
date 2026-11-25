// Paints the ownership grid into a 720x360 canvas (1 pixel per cell) for the pick map, background and minimap.
import { GRID_W, GRID_H, OCEAN, ICE } from '/shared/constants.js';

export function hexRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class MapPainter {
  constructor(countries) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = GRID_W;
    this.canvas.height = GRID_H;
    this.ctx = this.canvas.getContext('2d');
    this.img = this.ctx.createImageData(GRID_W, GRID_H);
    this.pal = new Uint8Array(256 * 3);
    this.grid = null;
    if (countries) this.setCountries(countries);
  }
  setCountries(list) {
    for (const c of list) this.pal.set(hexRgb(c.color), c.id * 3);
  }
  setGrid(grid) {
    this.grid = grid;
  }
  // Color of one cell. A cell is darkened when its right or lower neighbour is another country.
  pixel(i, highlight, mine) {
    const g = this.grid;
    const pal = this.pal;
    const d = this.img.data;
    const x = i % GRID_W;
    const y = (i - x) / GRID_W;
    const o = g[i];
    let r, gg, b;
    if (o === OCEAN) { r = 22; gg = 50; b = 66; }
    else if (o === ICE) { r = 196; gg = 208; b = 214; }
    else {
      r = pal[o * 3]; gg = pal[o * 3 + 1]; b = pal[o * 3 + 2];
      if (o === highlight || o === mine) { r += (255 - r) * 0.45; gg += (255 - gg) * 0.45; b += (255 - b) * 0.45; }
      const right = g[y * GRID_W + ((x + 1) % GRID_W)];
      const down = y + 1 < GRID_H ? g[i + GRID_W] : o;
      if ((right !== o && right !== OCEAN) || (down !== o && down !== OCEAN)) { r *= 0.62; gg *= 0.62; b *= 0.62; }
    }
    const k = i * 4;
    d[k] = r; d[k + 1] = gg; d[k + 2] = b; d[k + 3] = 255;
  }
  paint({ highlight = -1, mine = -1 } = {}) {
    if (!this.grid) return this.canvas;
    for (let i = 0; i < GRID_W * GRID_H; i++) this.pixel(i, highlight, mine);
    this.ctx.putImageData(this.img, 0, 0);
    return this.canvas;
  }
  // Repaint only changed cells, plus their left and upper neighbours whose border shading depends on them.
  update(cells, { highlight = -1, mine = -1 } = {}) {
    if (!this.grid) return this.canvas;
    for (const i of cells) {
      const x = i % GRID_W;
      this.pixel(i, highlight, mine);
      this.pixel(i - x + ((x - 1 + GRID_W) % GRID_W), highlight, mine);
      if (i >= GRID_W) this.pixel(i - GRID_W, highlight, mine);
    }
    this.ctx.putImageData(this.img, 0, 0);
    return this.canvas;
  }
}
