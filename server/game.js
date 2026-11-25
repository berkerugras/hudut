// Server side of the game: border pressure, weapons, bullets, and checking player movement.
//
// Movement: each client moves its own character (so walking is smooth whatever the ping) and sends
// its position. The server accepts a position only if it is reachable at walking speed over the
// player's own land; otherwise it keeps its own position and bumps `tp` ("teleport count"), which
// tells that client to jump back. `tp` also goes up when the server moves a player itself
// (spawn, respawn, losing the cell they stand on).
import {
  GRID_W, GRID_H, TICK_HZ, MAX_HP, RESPAWN_MS, HIT_RADIUS, PLAYER_SPEED,
  PUSH_BASE_RATE, SOLO_CAP, PRESSURE_DECAY, SIDE_FORCE,
  WEAPONS, WEAPON_IDS, stepMovement, cellAt, cellXY, cellOffset, wrapX, wrapDelta, isLand,
} from '../shared/constants.js';

const NAME_RE = /^[\p{L}\p{N}_.-]{3,16}$/u;
const round2 = (v) => Math.round(v * 100) / 100;
const MOVE_SLACK = 0.35; // cells of jitter allowed on top of walking speed
const POSE_HOLD_MS = 150; // keep "pushing"/"moving" on briefly so animations don't flicker

// Chat text: one line, no control characters, at most 140 characters.
export function cleanChat(text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

export class Game {
  constructor({ grid, countries, weaponIntervalMs, emit }) {
    this.grid = grid; // Uint8Array, owner per cell
    this.countries = new Map(countries.map((c) => [c.id, c]));
    this.weaponIntervalMs = weaponIntervalMs;
    this.emit = emit; // (event, payload) => broadcast
    this.players = new Map(); // id -> player
    this.byName = new Map(); // lowercased name -> id
    this.nextId = 1;
    this.bullets = [];
    this.nextBullet = 1;
    this.pressure = new Map(); // cell -> { attacker, p }
    this.flips = [];
    this.shots = [];
    this.impacts = [];
    this.dirty = false;
    this.nextDropAt = Date.now() + weaponIntervalMs;
    this.cellCount = new Map();
    for (let i = 0; i < grid.length; i++) {
      const o = grid[i];
      if (isLand(o)) this.cellCount.set(o, (this.cellCount.get(o) || 0) + 1);
    }
  }

  // ---------- public info ----------
  countryList() {
    const online = new Map();
    for (const p of this.players.values()) online.set(p.country, (online.get(p.country) || 0) + 1);
    return [...this.countries.values()].map((c) => ({
      id: c.id, name: c.name, color: c.color, cells: this.cellCount.get(c.id) || 0, online: online.get(c.id) || 0,
    }));
  }
  publicPlayer(p) {
    return { id: p.id, name: p.name, country: p.country, look: p.look, weapon: p.weapon, kills: p.kills, deaths: p.deaths };
  }

  // ---------- join / leave ----------
  join({ name, country, look }) {
    // `code` tells the client which screen should show the error.
    name = String(name || '').trim();
    if (!NAME_RE.test(name)) return { error: 'Usernames are 3–16 characters: letters, numbers, _ . -', code: 'name' };
    if (this.byName.has(name.toLowerCase())) return { error: 'That username is in the game right now. Pick another one.', code: 'name' };
    country = Number(country);
    if (!this.countries.has(country)) return { error: "That country doesn't exist.", code: 'country' };
    if (!this.cellCount.get(country)) return { error: 'That country has no land left. Pick another one.', code: 'country' };
    const p = {
      id: this.nextId++, name, country, look,
      x: 0, y: 0, aim: 0, hp: MAX_HP, alive: true, respawnAt: 0,
      weapon: null, lastShot: 0, kills: 0, deaths: 0,
      input: { dx: 0, dy: 0, aim: 0, fire: false }, pushCell: -1,
      tp: 0, lastMoveAt: Date.now(), movedAt: 0, pushUntil: 0,
    };
    this.placeAtSpawn(p);
    this.players.set(p.id, p);
    this.byName.set(name.toLowerCase(), p.id);
    this.emit('playerJoined', this.publicPlayer(p));
    return { player: p };
  }
  leave(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.byName.delete(p.name.toLowerCase());
    this.emit('playerLeft', id);
  }
  setInput(id, input) {
    const p = this.players.get(id);
    if (!p || !input) return;
    const dx = Number(input.dx) || 0;
    const dy = Number(input.dy) || 0;
    const len = Math.hypot(dx, dy);
    p.input.dx = len > 1 ? dx / len : dx;
    p.input.dy = len > 1 ? dy / len : dy;
    const aim = Number(input.aim);
    if (Number.isFinite(aim)) p.input.aim = aim;
    p.input.fire = !!input.fire;
    const x = Number(input.x);
    const y = Number(input.y);
    // A position sent before the client saw our last teleport is out of date: skip it quietly
    // instead of refusing it (which would make the client jump a second time).
    const stale = input.tp !== undefined && Number(input.tp) !== p.tp;
    if (p.alive && !stale && Number.isFinite(x) && Number.isFinite(y)) this.acceptPosition(p, x, y);
  }

  // A client says "I am at (x, y)". Accept it only if walking there was possible.
  acceptPosition(p, x, y) {
    const now = Date.now();
    x = wrapX(x);
    const dx = wrapDelta(x - p.x);
    const dy = y - p.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-4) return true;
    const elapsed = Math.min(1, Math.max(0, now - p.lastMoveAt) / 1000);
    const allowed = PLAYER_SPEED * elapsed * 1.3 + MOVE_SLACK;
    let ok = y >= 0 && y < GRID_H && dist <= allowed;
    // Every point along the way must be the player's own land.
    const steps = Math.max(1, Math.ceil(dist / 0.4));
    for (let i = 1; ok && i <= steps; i++) {
      const c = cellAt(p.x + (dx * i) / steps, p.y + (dy * i) / steps);
      if (c < 0 || this.grid[c] !== p.country) ok = false;
    }
    if (!ok) { p.tp++; return false; }
    p.x = x;
    p.y = y;
    p.lastMoveAt = now;
    p.movedAt = now;
    return true;
  }
  // The server moves a player itself; the client must jump to the new spot.
  teleport(p, x, y) {
    p.x = x;
    p.y = y;
    p.tp++;
    p.lastMoveAt = Date.now();
  }

  // ---------- spawning ----------
  isInterior(c, country) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = cellOffset(c, dx, dy);
      if (n < 0 || this.grid[n] !== country) return false;
    }
    return true;
  }
  randomCellOf(country) {
    const cells = [];
    const interior = [];
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] !== country) continue;
      cells.push(i);
      if (this.isInterior(i, country)) interior.push(i);
    }
    const pool = interior.length ? interior : cells;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : -1;
  }
  cellNear(x, y, country, radius) {
    for (let tries = 0; tries < 30; tries++) {
      const c = cellAt(x + (Math.random() - 0.5) * 2 * radius, y + (Math.random() - 0.5) * 2 * radius);
      if (c >= 0 && this.grid[c] === country) return c;
    }
    return -1;
  }
  placeAtSpawn(p) {
    // Spawn next to a living teammate when there is one, so groups form quickly.
    const mates = [...this.players.values()].filter((q) => q !== p && q.country === p.country && q.alive);
    let c = -1;
    if (mates.length) {
      const m = mates[Math.floor(Math.random() * mates.length)];
      c = this.cellNear(m.x, m.y, p.country, 3);
    }
    if (c < 0) c = this.randomCellOf(p.country);
    if (c < 0) return false;
    const [cx, cy] = cellXY(c);
    this.teleport(p, cx + 0.5, cy + 0.5);
    p.hp = MAX_HP; p.alive = true; p.pushCell = -1;
    return true;
  }

  // ---------- weapons ----------
  dropWeapons(now) {
    const given = [];
    for (const p of this.players.values()) {
      const options = WEAPON_IDS.filter((w) => w !== p.weapon);
      p.weapon = options[Math.floor(Math.random() * options.length)];
      given.push([p.id, p.weapon]);
    }
    this.nextDropAt = now + this.weaponIntervalMs;
    this.emit('weaponDrop', { given, nextDropAt: this.nextDropAt });
  }
  tryFire(p, now) {
    const w = WEAPONS[p.weapon];
    if (!w || now - p.lastShot < w.cooldown) return;
    p.lastShot = now;
    for (let i = 0; i < w.pellets; i++) {
      const a = p.aim + (Math.random() * 2 - 1) * w.spread;
      const b = {
        id: this.nextBullet++, owner: p.id, country: p.country, weapon: p.weapon,
        x: p.x + Math.cos(a) * 0.45, y: p.y + Math.sin(a) * 0.45,
        vx: Math.cos(a) * w.speed, vy: Math.sin(a) * w.speed, left: w.range,
      };
      this.bullets.push(b);
      this.shots.push([b.id, p.id, round2(b.x), round2(b.y), round2(a), WEAPON_IDS.indexOf(p.weapon)]);
    }
  }
  damage(victim, amount, attacker, weapon) {
    if (!victim.alive) return;
    victim.hp -= amount;
    if (victim.hp > 0) return;
    victim.hp = 0;
    victim.alive = false;
    victim.respawnAt = Date.now() + RESPAWN_MS;
    victim.pushCell = -1;
    victim.deaths++;
    if (attacker) attacker.kills++;
    this.emit('kill', { killer: attacker ? attacker.id : 0, victim: victim.id, weapon, respawnAt: victim.respawnAt });
  }
  updateBullets(dt) {
    const keep = [];
    for (const b of this.bullets) {
      const step = Math.hypot(b.vx, b.vy) * dt;
      const travel = Math.min(step, b.left);
      const k = travel / step;
      const sx = b.vx * dt * k;
      const sy = b.vy * dt * k;
      // Nearest enemy along this tick's segment
      let hit = null;
      let hitT = 2;
      for (const p of this.players.values()) {
        if (!p.alive || p.country === b.country) continue;
        const px = wrapDelta(p.x - b.x);
        const py = p.y - b.y;
        const len2 = sx * sx + sy * sy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, (px * sx + py * sy) / len2)) : 0;
        const ddx = px - sx * t;
        const ddy = py - sy * t;
        if (ddx * ddx + ddy * ddy < HIT_RADIUS * HIT_RADIUS && t < hitT) { hit = p; hitT = t; }
      }
      const w = WEAPONS[b.weapon];
      const shooter = this.players.get(b.owner);
      if (hit) {
        const ix = wrapX(b.x + sx * hitT);
        const iy = b.y + sy * hitT;
        this.explode(b, w, shooter, ix, iy, hit);
        continue;
      }
      b.x = wrapX(b.x + sx);
      b.y += sy;
      b.left -= travel;
      if (b.left <= 0.001 || b.y < 0 || b.y > GRID_H) {
        if (w.splash) this.explode(b, w, shooter, b.x, b.y, null);
        else this.impacts.push([b.id, round2(b.x), round2(b.y), 0]);
        continue;
      }
      keep.push(b);
    }
    this.bullets = keep;
  }
  explode(b, w, shooter, x, y, direct) {
    if (w.splash) {
      for (const p of this.players.values()) {
        if (!p.alive || p.country === b.country) continue;
        const d = Math.hypot(wrapDelta(p.x - x), p.y - y);
        if (d < w.splash) this.damage(p, Math.round(w.damage * (1 - (d / w.splash) * 0.6)), shooter, b.weapon);
      }
      this.impacts.push([b.id, round2(x), round2(y), 1]);
    } else {
      if (direct) this.damage(direct, w.damage, shooter, b.weapon);
      this.impacts.push([b.id, round2(x), round2(y), 0]);
    }
  }

  // ---------- borders ----------
  addForce(map, cell, country, force, rate) {
    if (cell < 0) return;
    let m = map.get(cell);
    if (!m) map.set(cell, (m = new Map()));
    const e = m.get(country) || { n: 0, rate: 0 };
    e.n += force;
    e.rate += rate * force;
    m.set(country, e);
  }
  updatePressure(dt) {
    const attack = new Map();
    const defend = new Map();
    for (const p of this.players.values()) {
      if (!p.alive || p.pushCell < 0) continue;
      const mult = p.weapon ? WEAPONS[p.weapon].push : 1;
      const from = cellAt(p.x, p.y);
      const [fx, fy] = cellXY(from);
      const [tx, ty] = cellXY(p.pushCell);
      const horizontal = Math.abs(wrapDelta(tx - fx)) >= Math.abs(ty - fy);
      const side = horizontal ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
      const target = this.grid[p.pushCell];
      // Push on the enemy cell in front, and half as hard on the two beside it.
      this.addForce(attack, p.pushCell, p.country, 1, mult);
      for (const [dx, dy] of side) {
        const n = cellOffset(p.pushCell, dx, dy);
        if (n >= 0 && this.grid[n] === target) this.addForce(attack, n, p.country, SIDE_FORCE, mult);
      }
      // Pushing out also holds the cells you stand on, with the same numbers.
      this.addForce(defend, from, p.country, 1, mult);
      for (const [dx, dy] of side) {
        const n = cellOffset(from, dx, dy);
        if (n >= 0 && this.grid[n] === p.country) this.addForce(defend, n, p.country, SIDE_FORCE, mult);
      }
    }

    const cells = new Set([...this.pressure.keys(), ...attack.keys()]);
    for (const c of cells) {
      const owner = this.grid[c];
      let st = this.pressure.get(c);
      const m = attack.get(c);
      let A = null;
      let X = 0;
      if (m) {
        for (const [k, e] of m) {
          if (k === owner) continue;
          if (!A || e.n > A.n || (e.n === A.n && e.rate > A.rate)) { A = e; X = k; }
        }
      }
      const dm = defend.get(c);
      const D = (dm && dm.get(owner)) || { n: 0, rate: 0 };
      if (A) {
        if (!st || st.attacker !== X) st = { attacker: X, p: 0 };
        const net = A.n - D.n;
        if (net > 0.001) {
          const cap = Math.min(1, SOLO_CAP * net);
          const rate = PUSH_BASE_RATE * Math.max(0.3, A.rate - D.rate);
          if (st.p < cap) st.p = Math.min(cap, st.p + rate * dt);
          else st.p = Math.max(cap, st.p - PRESSURE_DECAY * dt);
          if (st.p >= 0.999) { this.flip(c, X); this.pressure.delete(c); continue; }
        } else if (net < -0.001) {
          st.p -= PUSH_BASE_RATE * Math.max(0.3, D.rate - A.rate) * dt;
        }
      } else if (st) {
        st.p -= (D.n > 0 ? PUSH_BASE_RATE * Math.max(0.3, D.rate) : PRESSURE_DECAY) * dt;
      }
      if (!st || st.p <= 0) this.pressure.delete(c);
      else this.pressure.set(c, st);
    }
  }
  flip(c, newOwner) {
    const old = this.grid[c];
    this.grid[c] = newOwner;
    this.cellCount.set(old, (this.cellCount.get(old) || 1) - 1);
    this.cellCount.set(newOwner, (this.cellCount.get(newOwner) || 0) + 1);
    this.flips.push([c, newOwner]);
    this.dirty = true;
    // Players of the old owner standing here get pushed back into their own land.
    for (const p of this.players.values()) {
      if (p.country !== old || !p.alive || cellAt(p.x, p.y) !== c) continue;
      const back = this.nearestOwnCell(c, old);
      if (back >= 0) { const [bx, by] = cellXY(back); this.teleport(p, bx + 0.5, by + 0.5); }
      else this.placeAtSpawn(p);
    }
    if ((this.cellCount.get(old) || 0) <= 0) {
      for (const p of this.players.values()) if (p.country === old) this.emit('eliminated', { id: p.id, country: old });
    }
  }
  nearestOwnCell(c, country) {
    for (let r = 1; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const n = cellOffset(c, dx, dy);
          if (n >= 0 && this.grid[n] === country) return n;
        }
      }
    }
    return -1;
  }

  // ---------- main loop ----------
  tick() {
    const now = Date.now();
    const dt = 1 / TICK_HZ;
    if (now >= this.nextDropAt) this.dropWeapons(now);
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (now >= p.respawnAt) { if (!this.placeAtSpawn(p)) p.respawnAt = now + RESPAWN_MS; }
        continue;
      }
      // Clients move themselves (see acceptPosition). Here we only work out whether the player is
      // walking into a border, and hold that briefly so a jittery key or packet doesn't flicker it.
      const r = stepMovement(this.grid, p.country, p.x, p.y, p.input.dx, p.input.dy, dt);
      if (r.pushCell >= 0) { p.pushCell = r.pushCell; p.pushUntil = now + POSE_HOLD_MS; }
      else if (now >= p.pushUntil) p.pushCell = -1;
      p.aim = p.input.aim;
      if (p.input.fire && p.weapon) this.tryFire(p, now);
    }
    this.updateBullets(dt);
    this.updatePressure(dt);

    const players = [];
    for (const p of this.players.values()) {
      const moving = now - p.movedAt < POSE_HOLD_MS;
      const flags = (p.alive ? 1 : 0) | (p.pushCell >= 0 ? 2 : 0) | (moving ? 4 : 0);
      players.push([p.id, round2(p.x), round2(p.y), round2(p.aim), Math.max(0, Math.round(p.hp)), flags, p.tp]);
    }
    const contested = [];
    for (const [c, st] of this.pressure) contested.push([c, st.attacker, Math.round(st.p * 255)]);
    this.emit('snap', { t: now, p: players, c: contested, f: this.flips, s: this.shots, i: this.impacts });
    this.flips = [];
    this.shots = [];
    this.impacts = [];
  }
}
