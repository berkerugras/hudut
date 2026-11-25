// Draws the live world map into a PNG for link previews (WhatsApp, Discord, X ...), with no
// image library: a tiny PNG encoder on top of zlib.
import zlib from 'node:zlib';
import { GRID_W, GRID_H, OCEAN, ICE } from '../shared/constants.js';

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePNG(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const hex = (h) => { const n = parseInt(String(h).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

// 1200 x 630 (the size link previews expect): the 2:1 map, letterboxed on the game's dark background.
export function renderMapPNG(grid, countries) {
  const W = 1200, H = 630, MAP_H = 600, TOP = 15;
  const pal = new Uint8Array(256 * 3);
  for (const c of countries) pal.set(hex(c.color), c.id * 3);
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = 14; rgb[i * 3 + 1] = 23; rgb[i * 3 + 2] = 28; }
  for (let py = 0; py < MAP_H; py++) {
    const gy = Math.floor((py / MAP_H) * GRID_H);
    for (let px = 0; px < W; px++) {
      const gx = Math.floor((px / W) * GRID_W);
      const i = gy * GRID_W + gx;
      const o = grid[i];
      let r, g, b;
      if (o === OCEAN) { r = 22; g = 50; b = 66; }
      else if (o === ICE) { r = 196; g = 208; b = 214; }
      else {
        r = pal[o * 3]; g = pal[o * 3 + 1]; b = pal[o * 3 + 2];
        const right = grid[gy * GRID_W + ((gx + 1) % GRID_W)];
        const down = gy + 1 < GRID_H ? grid[i + GRID_W] : o;
        if ((right !== o && right !== OCEAN) || (down !== o && down !== OCEAN)) { r *= 0.62; g *= 0.62; b *= 0.62; }
      }
      const k = ((py + TOP) * W + px) * 3;
      rgb[k] = r; rgb[k + 1] = g; rgb[k + 2] = b;
    }
  }
  return encodePNG(W, H, rgb);
}
