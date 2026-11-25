// Server side of the game: border pressure, weapons, bullets, crates, rounds, scores, and
// checking player movement.
//
// Movement: each client moves its own character (so walking is smooth whatever the ping) and sends
// its position. The server accepts a position only if it is reachable at walking speed over the
// player's own land; otherwise it keeps its own position and bumps `tp` ("teleport count"), which
// tells that client to jump back. `tp` also goes up when the server moves a player itself
// (spawn, respawn, "to the front", losing the cell they stand on, a new round).
import {
  GRID_W, GRID_H, CELL_DEG, TICK_HZ, MAX_HP, RESPAWN_MS, HIT_RADIUS, PLAYER_SPEED,
  PUSH_BASE_RATE, SOLO_CAP, PRESSURE_DECAY, SIDE_FORCE,
  SCORE, BOUNTY_STREAK, MORALE_MS, MORALE_MULT, MORALE_RADIUS, BOOST_MS, BOOST_MULT,
  FRONT_COOLDOWN_MS, CAPITAL_SLOWDOWN, CRATES, underdogFactor,
  WEAPONS, WEAPON_IDS, stepMovement, cellAt, cellXY, cellOffset, wrapX, wrapDelta, isLand,
} from '../shared/constants.js';
import { maskProfanity } from './chatfilter.js';
import { Bots } from './bots.js';

const NAME_RE = /^[\p{L}\p{N}_.-]{3,16}$/u;
const round2 = (v) => Math.round(v * 100) / 100;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const MOVE_SLACK = 0.35; // cells of jitter allowed on top of walking speed
const POSE_HOLD_MS = 150; // keep "pushing"/"moving" on briefly so animations don't flicker
const CRATE_EVERY_MS = 6000;
const CRATE_LIFE_MS = 45000;
const HEAVY = ['roket', 'keskin', 'pompali'];

// Chat text: one line, no control characters, at most 140 characters, swear words masked.
export function cleanChat(text) {
  const line = String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  return maskProfanity(line);
}

export class Game {
  constructor({
    grid, baseGrid, countries, capitals = {}, weaponIntervalMs,
    roundMs = 24 * 3600 * 1000, round = null, maxBots = 0, crates = false, emit,
  }) {
    this.grid = grid; // Uint8Array, owner per cell
    this.baseGrid = baseGrid || new Uint8Array(grid); // the real-world map, restored every round
    this.countries = new Map(countries.map((c) => [c.id, c]));
    this.weaponIntervalMs = weaponIntervalMs;
    this.emit = emit; // (event, payload) => broadcast to everyone in the game
    this.players = new Map(); // id -> player
    this.byName = new Map(); // lowercased name -> id
    this.nextId = 1;
    this.bullets = [];
    this.nextBullet = 1;
    this.pressure = new Map(); // cell -> { attacker, p, peak }
    this.flips = [];
    this.shots = [];
    this.impacts = [];
    this.dirty = false;
    this.version = 0; // bumps whenever territory changes
    this.frontierCache = new Map();
    this.nextDropAt = Date.now() + weaponIntervalMs;
    this.recount();
    this.capitals = this.resolveCapitals(capitals); // cell -> { name, home }
    this.cratesOn = crates;
    this.crates = new Map();
    this.nextCrate = 1;
    this.nextCrateAt = Date.now() + 3000;
    this.crateAdds = [];
    this.crateRemoves = [];
    this.roundMs = roundMs;
    this.round = round && round.n && round.endsAt > Date.now() && round.start ? round : this.newRound(Date.now(), round && round.n ? round.n + 1 : 1);
    this.bots = new Bots(this, { max: maxBots });
  }

  // ---------- territory bookkeeping ----------
  recount() {
    this.cellCount = new Map();
    for (let i = 0; i < this.grid.length; i++) {
      const o = this.grid[i];
      if (isLand(o)) this.cellCount.set(o, (this.cellCount.get(o) || 0) + 1);
    }
  }
  resolveCapitals(caps) {
    const out = new Map();
    for (const c of this.countries.values()) {
      const cap = caps[c.code];
      if (!cap) continue;
      const [name, lat, lon] = cap;
      const cx = Math.floor((lon + 180) / CELL_DEG);
      const cy = Math.floor((90 - lat) / CELL_DEG);
      // Snap to the nearest cell this country owns on the real map (coasts, small rounding errors).
      let found = -1;
      for (let r = 0; r <= 3 && found < 0; r++) {
        for (let dy = -r; dy <= r && found < 0; dy++) {
          for (let dx = -r; dx <= r && found < 0; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const y = cy + dy;
            if (y < 0 || y >= GRID_H) continue;
            const cell = y * GRID_W + (((cx + dx) % GRID_W) + GRID_W) % GRID_W;
            if (this.baseGrid[cell] === c.id && !out.has(cell)) found = cell;
          }
        }
      }
      if (found >= 0) out.set(found, { name, home: c.id });
    }
    return out;
  }
  capitalList() {
    return [...this.capitals].map(([cell, c]) => [cell, c.name, c.home]);
  }
  // Own cells that touch another country's land.
  frontier(country) {
    const cached = this.frontierCache.get(country);
    if (cached && cached.v === this.version) return cached.cells;
    const cells = [];
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] !== country) continue;
      for (const [dx, dy] of N4) {
        const n = cellOffset(i, dx, dy);
        if (n >= 0 && this.grid[n] !== country && isLand(this.grid[n])) { cells.push(i); break; }
      }
    }
    this.frontierCache.set(country, { v: this.version, cells });
    return cells;
  }
  frontierNear(country, x, y, r) {
    const out = [];
    const x0 = Math.floor(x), y0 = Math.floor(y);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const c = cellAt(x0 + dx + 0.5, y0 + dy + 0.5);
        if (c < 0 || this.grid[c] !== country) continue;
        for (const [ex, ey] of N4) {
          const n = cellOffset(c, ex, ey);
          if (n >= 0 && this.grid[n] !== country && isLand(this.grid[n])) { out.push(c); break; }
        }
      }
    }
    return out;
  }

  // ---------- rounds ----------
  newRound(now, n) {
    const start = {};
    for (const [id, cells] of this.cellCount) start[id] = cells;
    return { n, startedAt: now, endsAt: now + this.roundMs, start };
  }
  roundInfo() {
    return { n: this.round.n, startedAt: this.round.startedAt, endsAt: this.round.endsAt, start: this.round.start };
  }
  gained(id) {
    return (this.cellCount.get(id) || 0) - (this.round.start[id] || 0);
  }
  endRound(now) {
    let land = 0;
    for (const n of this.cellCount.values()) land += n;
    const standings = [...this.countries.values()]
      .map((c) => ({ id: c.id, gained: this.gained(c.id), cells: this.cellCount.get(c.id) || 0 }))
      .filter((c) => c.gained > 0)
      .sort((a, b) => b.gained - a.gained)
      .slice(0, 5);
    const players = [...this.players.values()]
      .filter((p) => !p.bot && p.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((p) => ({ name: p.name, country: p.country, score: p.score }));
    const winner = standings[0] ? { ...standings[0], share: standings[0].cells / Math.max(1, land) } : null;
    this.emit('roundEnd', { n: this.round.n, winner, standings, players });

    // Back to the real-world map.
    this.grid.set(this.baseGrid);
    this.recount();
    this.version++;
    this.pressure.clear();
    this.bullets = [];
    for (const id of this.crates.keys()) this.crateRemoves.push(id);
    this.crates.clear();
    this.dirty = true;
    this.round = this.newRound(now, this.round.n + 1);
    for (const p of this.players.values()) {
      p.score = 0;
      p.streak = 0;
      p.life = { captures: 0, kills: 0, score: 0 };
      if (!this.placeAtSpawn(p)) this.leave(p.id);
    }
    this.emit('roundStart', { round: this.roundInfo(), grid: Buffer.from(this.grid) });
  }

  // ---------- public info ----------
  countryList() {
    const online = new Map();
    for (const p of this.players.values()) if (!p.bot) online.set(p.country, (online.get(p.country) || 0) + 1);
    return [...this.countries.values()].map((c) => ({
      id: c.id, name: c.name, code: c.code, color: c.color,
      cells: this.cellCount.get(c.id) || 0, online: online.get(c.id) || 0,
    }));
  }
  publicPlayer(p) {
    return { id: p.id, name: p.name, country: p.country, look: p.look, weapon: p.weapon, bot: !!p.bot, score: p.score };
  }
  humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.bot) n++;
    return n;
  }

  // ---------- join / leave ----------
  makePlayer({ name, country, look, bot }) {
    return {
      id: this.nextId++, name, country, look, bot,
      x: 0, y: 0, aim: 0, hp: MAX_HP, alive: true, respawnAt: 0,
      weapon: null, lastShot: 0, kills: 0, deaths: 0,
      score: 0, streak: 0, life: { captures: 0, kills: 0, score: 0 },
      input: { dx: 0, dy: 0, aim: 0, fire: false }, pushCell: -1,
      tp: 0, lastMoveAt: Date.now(), movedAt: 0, pushUntil: 0,
      moraleUntil: 0, boostUntil: 0, frontAt: 0,
    };
  }
  join({ name, country, look }) {
    // `code` tells the client which screen should show the error.
    name = String(name || '').trim();
    if (!NAME_RE.test(name) || /^ai-/i.test(name)) return { error: 'Usernames are 3–16 characters: letters, numbers, _ . -', code: 'name' };
    if (this.byName.has(name.toLowerCase())) return { error: 'That username is in the game right now. Pick another one.', code: 'name' };
    country = country === 'auto' || !country ? this.pickAutoCountry() : Number(country);
    if (!this.countries.has(country)) return { error: "That country doesn't exist.", code: 'country' };
    if (!this.cellCount.get(country)) return { error: 'That country has no land left. Pick another one.', code: 'country' };
    const p = this.makePlayer({ name, country, look, bot: false });
    this.placeAtSpawn(p);
    this.players.set(p.id, p);
    this.byName.set(name.toLowerCase(), p.id);
    this.emit('playerJoined', this.publicPlayer(p));
    return { player: p };
  }
  addBot(country, name, look) {
    if (!this.cellCount.get(country)) return null;
    const p = this.makePlayer({ name, country, look, bot: true });
    if (!this.placeAtSpawn(p)) return null;
    this.players.set(p.id, p);
    this.byName.set(name.toLowerCase(), p.id);
    this.emit('playerJoined', this.publicPlayer(p));
    return p;
  }
  leave(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    this.byName.delete(p.name.toLowerCase());
    this.emit('playerLeft', id);
  }
  // "Play" without choosing: the country most people are playing, so newcomers land among friends.
  pickAutoCountry() {
    const online = new Map();
    for (const p of this.players.values()) if (!p.bot) online.set(p.country, (online.get(p.country) || 0) + 1);
    let best = 0, bestN = 0;
    for (const [c, n] of online) if (n > bestN && this.cellCount.get(c)) { best = c; bestN = n; }
    if (best) return best;
    // Nobody online: a mid-sized country with land neighbours to fight.
    const pool = [...this.countries.values()].filter((c) => {
      const n = this.cellCount.get(c.id) || 0;
      return n >= 150 && n <= 3000;
    });
    for (let tries = 0; tries < 12 && pool.length; tries++) {
      const c = pick(pool);
      if (this.frontier(c.id).length) return c.id;
    }
    return pool.length ? pool[0].id : [...this.countries.keys()][0];
  }
  setInput(id, input) {
    const p = this.players.get(id);
    if (!p || !input || p.bot) return;
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
    for (const [dx, dy] of N4) {
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
    return pool.length ? pick(pool) : -1;
  }
  cellNear(x, y, country, radius) {
    for (let tries = 0; tries < 30; tries++) {
      const c = cellAt(x + (Math.random() - 0.5) * 2 * radius, y + (Math.random() - 0.5) * 2 * radius);
      if (c >= 0 && this.grid[c] === country) return c;
    }
    return -1;
  }
  // Spawn where the action is: next to a teammate who is pushing, else next to any teammate,
  // else on the country's front line, else anywhere in the country.
  placeAtSpawn(p) {
    const mates = [];
    for (const q of this.players.values()) if (q !== p && q.country === p.country && q.alive) mates.push(q);
    let c = -1;
    const pushing = mates.filter((q) => q.pushCell >= 0 && !q.bot);
    if (pushing.length) { const m = pick(pushing); c = this.cellNear(m.x, m.y, p.country, 2); }
    if (c < 0 && mates.length) {
      const humans = mates.filter((q) => !q.bot);
      const m = pick(humans.length ? humans : mates);
      c = this.cellNear(m.x, m.y, p.country, 3);
    }
    if (c < 0) { const f = this.frontier(p.country); if (f.length) c = pick(f); }
    if (c < 0) c = this.randomCellOf(p.country);
    if (c < 0) return false;
    const [cx, cy] = cellXY(c);
    this.teleport(p, cx + 0.5, cy + 0.5);
    p.hp = MAX_HP; p.alive = true; p.pushCell = -1;
    return true;
  }
  // "To the front": jump next to teammates who are pushing, or to a contested part of the border.
  toFront(p) {
    if (!p || !p.alive) return { error: 'You can do that when you are alive.' };
    const now = Date.now();
    const wait = FRONT_COOLDOWN_MS - (now - p.frontAt);
    if (wait > 0) return { error: `Wait ${Math.ceil(wait / 1000)} s.` };
    let cells = [];
    for (const q of this.players.values()) {
      if (q !== p && q.alive && q.country === p.country && q.pushCell >= 0) cells.push(cellAt(q.x, q.y));
    }
    if (!cells.length) {
      for (const [c, st] of this.pressure) {
        if (this.grid[c] === p.country) cells.push(c); // our cell under attack
        else if (st.attacker === p.country) {
          for (const [dx, dy] of N4) { const n = cellOffset(c, dx, dy); if (n >= 0 && this.grid[n] === p.country) cells.push(n); }
        }
      }
    }
    if (!cells.length) cells = this.frontier(p.country);
    cells = cells.filter((c) => c >= 0 && this.grid[c] === p.country);
    if (!cells.length) return { error: 'Your country has no land border.' };
    const [cx, cy] = cellXY(pick(cells));
    this.teleport(p, cx + 0.5, cy + 0.5);
    p.frontAt = now;
    return { ok: true };
  }

  // ---------- weapons ----------
  dropWeapons(now) {
    const given = [];
    for (const p of this.players.values()) {
      const options = WEAPON_IDS.filter((w) => w !== p.weapon);
      p.weapon = pick(options);
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
  addScore(p, n) {
    p.score += n;
    p.life.score += n;
  }
  damage(victim, amount, attacker, weapon) {
    if (!victim.alive) return;
    victim.hp -= amount;
    if (victim.hp > 0) return;
    const now = Date.now();
    victim.hp = 0;
    victim.alive = false;
    victim.respawnAt = now + RESPAWN_MS;
    victim.pushCell = -1;
    victim.deaths++;
    const hadBounty = victim.streak >= BOUNTY_STREAK;
    const life = victim.life;
    victim.streak = 0;
    victim.life = { captures: 0, kills: 0, score: 0 };
    if (attacker && attacker !== victim) {
      this.addScore(attacker, SCORE.kill + (hadBounty ? SCORE.bounty : 0));
      attacker.kills++;
      attacker.life.kills++;
      attacker.streak++;
      if (attacker.streak === BOUNTY_STREAK) this.emit('bounty', { id: attacker.id });
      // Morale: the killer's teammates close by push faster for a while.
      for (const q of this.players.values()) {
        if (q.alive && q.country === attacker.country && Math.hypot(wrapDelta(q.x - victim.x), q.y - victim.y) <= MORALE_RADIUS) {
          q.moraleUntil = now + MORALE_MS;
        }
      }
    }
    this.emit('kill', { killer: attacker ? attacker.id : 0, victim: victim.id, weapon, respawnAt: victim.respawnAt, bounty: hadBounty, life });
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
        this.explode(b, w, shooter, wrapX(b.x + sx * hitT), b.y + sy * hitT, hit);
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

  // ---------- supply crates ----------
  crateList() {
    return [...this.crates.values()].map((k) => [k.id, round2(k.x), round2(k.y), CRATES.indexOf(k.type)]);
  }
  updateCrates(now) {
    for (const k of this.crates.values()) {
      if (now > k.until) { this.crates.delete(k.id); this.crateRemoves.push(k.id); }
    }
    // Pick-ups
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      for (const k of this.crates.values()) {
        if (k.country !== p.country || Math.hypot(wrapDelta(k.x - p.x), k.y - p.y) > 0.8) continue;
        this.crates.delete(k.id);
        this.crateRemoves.push(k.id);
        let weapon = null;
        if (k.type === 'medkit') p.hp = MAX_HP;
        else if (k.type === 'boost') p.boostUntil = now + BOOST_MS;
        else { weapon = pick(HEAVY.filter((w) => w !== p.weapon)); p.weapon = weapon; }
        this.emit('crate', { id: k.id, by: p.id, type: k.type, weapon });
        break;
      }
    }
    if (!this.cratesOn || now < this.nextCrateAt) return;
    this.nextCrateAt = now + CRATE_EVERY_MS;
    const humans = [];
    for (const p of this.players.values()) if (!p.bot && p.alive) humans.push(p);
    if (!humans.length || this.crates.size >= Math.min(24, 4 + humans.length * 3)) return;
    // Drop on the front line near a random player, on their side, so both sides race for crates.
    for (const anchor of [pick(humans), pick(humans)]) {
      const cells = this.frontierNear(anchor.country, anchor.x, anchor.y, 10);
      if (!cells.length) continue;
      const c = pick(cells);
      const [cx, cy] = cellXY(c);
      const r = Math.random();
      const type = r < 0.35 ? 'medkit' : r < 0.8 ? 'boost' : 'arsenal';
      const k = { id: this.nextCrate++, x: cx + 0.5, y: cy + 0.5, type, country: this.grid[c], until: now + CRATE_LIFE_MS };
      this.crates.set(k.id, k);
      this.crateAdds.push([k.id, round2(k.x), round2(k.y), CRATES.indexOf(type)]);
    }
  }

  // ---------- borders ----------
  pushMult(p, now) {
    let m = p.weapon ? WEAPONS[p.weapon].push : 1;
    if (now < p.moraleUntil) m *= MORALE_MULT;
    if (now < p.boostUntil) m *= BOOST_MULT;
    return m * underdogFactor(this.cellCount.get(p.country) || 1);
  }
  addForce(map, cell, country, force, rate, id) {
    if (cell < 0) return;
    let m = map.get(cell);
    if (!m) map.set(cell, (m = new Map()));
    const e = m.get(country) || { n: 0, rate: 0, ids: [] };
    e.n += force;
    e.rate += rate * force;
    if (!e.ids.includes(id)) e.ids.push(id);
    m.set(country, e);
  }
  updatePressure(dt, now) {
    const attack = new Map();
    const defend = new Map();
    for (const p of this.players.values()) {
      if (!p.alive || p.pushCell < 0) continue;
      const mult = this.pushMult(p, now);
      const from = cellAt(p.x, p.y);
      const [fx, fy] = cellXY(from);
      const [tx, ty] = cellXY(p.pushCell);
      const horizontal = Math.abs(wrapDelta(tx - fx)) >= Math.abs(ty - fy);
      const side = horizontal ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
      const target = this.grid[p.pushCell];
      // Push on the enemy cell in front, and half as hard on the two beside it.
      this.addForce(attack, p.pushCell, p.country, 1, mult, p.id);
      for (const [dx, dy] of side) {
        const n = cellOffset(p.pushCell, dx, dy);
        if (n >= 0 && this.grid[n] === target) this.addForce(attack, n, p.country, SIDE_FORCE, mult, p.id);
      }
      // Pushing out also holds the cells you stand on, with the same numbers.
      this.addForce(defend, from, p.country, 1, mult, p.id);
      for (const [dx, dy] of side) {
        const n = cellOffset(from, dx, dy);
        if (n >= 0 && this.grid[n] === p.country) this.addForce(defend, n, p.country, SIDE_FORCE, mult, p.id);
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
      const D = (dm && dm.get(owner)) || { n: 0, rate: 0, ids: [] };
      const slow = this.capitals.has(c) ? CAPITAL_SLOWDOWN : 1;
      if (A) {
        if (!st || st.attacker !== X) st = { attacker: X, p: 0, peak: 0 };
        const net = A.n - D.n;
        if (net > 0.001) {
          const cap = Math.min(1, SOLO_CAP * net);
          const rate = PUSH_BASE_RATE * Math.max(0.3, A.rate - D.rate) * slow;
          if (st.p < cap) st.p = Math.min(cap, st.p + rate * dt);
          else st.p = Math.max(cap, st.p - PRESSURE_DECAY * dt);
          if (st.p >= 0.999) { this.flip(c, X, A.ids); this.pressure.delete(c); continue; }
        } else if (net < -0.001) {
          st.p -= PUSH_BASE_RATE * Math.max(0.3, D.rate - A.rate) * dt;
        }
      } else if (st) {
        st.p -= (D.n > 0 ? PUSH_BASE_RATE * Math.max(0.3, D.rate) : PRESSURE_DECAY) * dt;
      }
      if (st) st.peak = Math.max(st.peak || 0, st.p);
      if (!st || st.p <= 0) {
        // A real push (a quarter of the way or more) beaten back by defenders earns them points.
        if (st && st.peak >= 0.25 && D.ids.length) {
          for (const id of D.ids) { const p = this.players.get(id); if (p) this.addScore(p, SCORE.defend); }
        }
        this.pressure.delete(c);
      } else {
        this.pressure.set(c, st);
      }
    }
  }
  flip(c, newOwner, contributors = []) {
    const old = this.grid[c];
    this.grid[c] = newOwner;
    this.cellCount.set(old, (this.cellCount.get(old) || 1) - 1);
    this.cellCount.set(newOwner, (this.cellCount.get(newOwner) || 0) + 1);
    this.flips.push([c, newOwner]);
    this.dirty = true;
    this.version++;
    const capital = this.capitals.get(c);
    for (const id of contributors) {
      const p = this.players.get(id);
      if (!p || p.country !== newOwner) continue;
      this.addScore(p, capital ? SCORE.capital : SCORE.capture);
      p.life.captures++;
    }
    if (capital) this.emit('capital', { cell: c, name: capital.name, home: capital.home, from: old, to: newOwner });
    // Players of the old owner standing here get pushed back into their own land.
    for (const p of this.players.values()) {
      if (p.country !== old || !p.alive || cellAt(p.x, p.y) !== c) continue;
      const back = this.nearestOwnCell(c, old);
      if (back >= 0) { const [bx, by] = cellXY(back); this.teleport(p, bx + 0.5, by + 0.5); }
      else this.placeAtSpawn(p);
    }
    if ((this.cellCount.get(old) || 0) <= 0) {
      for (const p of [...this.players.values()]) {
        if (p.country !== old) continue;
        if (p.bot) this.leave(p.id);
        else this.emit('eliminated', { id: p.id, country: old });
      }
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
    if (now >= this.round.endsAt) this.endRound(now);
    if (now >= this.nextDropAt) this.dropWeapons(now);
    this.bots.update(now, dt); // fills quiet countries with AI soldiers and moves them
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (now >= p.respawnAt) { if (!this.placeAtSpawn(p)) p.respawnAt = now + RESPAWN_MS; }
        continue;
      }
      // Humans move themselves (see acceptPosition). Here we only work out whether the player is
      // walking into a border, and hold that briefly so a jittery key or packet doesn't flicker it.
      const r = stepMovement(this.grid, p.country, p.x, p.y, p.input.dx, p.input.dy, dt);
      if (r.pushCell >= 0) { p.pushCell = r.pushCell; p.pushUntil = now + POSE_HOLD_MS; }
      else if (now >= p.pushUntil) p.pushCell = -1;
      p.aim = p.input.aim;
      if (p.input.fire && p.weapon) this.tryFire(p, now);
    }
    this.updateBullets(dt);
    this.updatePressure(dt, now);
    this.updateCrates(now);

    const players = [];
    for (const p of this.players.values()) {
      const flags = (p.alive ? 1 : 0)
        | (p.pushCell >= 0 ? 2 : 0)
        | (now - p.movedAt < POSE_HOLD_MS ? 4 : 0)
        | (p.streak >= BOUNTY_STREAK ? 8 : 0)
        | (now < p.moraleUntil ? 16 : 0)
        | (now < p.boostUntil ? 32 : 0);
      players.push([p.id, round2(p.x), round2(p.y), round2(p.aim), Math.max(0, Math.round(p.hp)), flags, p.tp, p.score]);
    }
    const contested = [];
    for (const [c, st] of this.pressure) contested.push([c, st.attacker, Math.round(st.p * 255)]);
    this.emit('snap', { t: now, p: players, c: contested, f: this.flips, s: this.shots, i: this.impacts, ka: this.crateAdds, kr: this.crateRemoves });
    this.flips = [];
    this.shots = [];
    this.impacts = [];
    this.crateAdds = [];
    this.crateRemoves = [];
  }
}
