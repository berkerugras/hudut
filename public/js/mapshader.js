// The map shader: owner colors per cell, borders, coasts, and contested cells being pushed.
import * as THREE from 'three';
import { GRID_W, GRID_H } from '/shared/constants.js';

export const VERT = /* glsl */ `
varying vec2 vCell;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vCell = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

// Each cell: owner color. Borders drawn from the 4 neighbours. Contested cells show the attacker's
// color pushing in from the side it is being pushed, as deep as the current pressure.
export const FRAG = /* glsl */ `
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

export function dataTex(data, w, h, format) {
  const t = new THREE.DataTexture(data, w, h, format, THREE.UnsignedByteType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

