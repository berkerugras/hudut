// AI soldiers, so nobody is ever alone on the map.
//
// Who gets bots (re-checked every 2 s):
// - A country with human players gets allies until it has 3 fighters (1 human -> 2 bots, 3+ -> none).
// - Its main neighbour (the "rival") gets a few enemy bots so there is someone to fight and push against.
// - With no humans online, all bots leave. Bots never exceed the configured maximum.
//
// What a bot does: walk (along a path over its own land) to a border cell, preferring cells a human
// teammate is pushing, cells its country is already pushing, and its own cells under attack; then push.
// If it has a weapon and an enemy is in range, it shoots (a bit inaccurately).
import { WEAPONS, LOOK, cellAt, cellXY, cellOffset, wrapDelta, stepMovement, isLand } from '../shared/constants.js';

const NAMES = ['Atlas', 'Nova', 'Rook', 'Falcon', 'Ember', 'Granite', 'Viper', 'Echo', 'Saber', 'Onyx', 'Comet', 'Bolt',
  'Maverick', 'Rogue', 'Titan', 'Raven', 'Jaguar', 'Ghost', 'Hunter', 'Storm', 'Blaze', 'Frost', 'Orbit', 'Pike'];
const ALLY_TARGET = 3;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const randInt = (n) => Math.floor(Math.random() * n);

export class Bots {
  constructor(game, { max = 0 } = {}) {
    this.game = game;
    this.max = max;
    this.rivals = new Map(); // human country -> neighbour country its enemy bots come from
    this.balanceAt = 0;
    this.seq = 0;
  }

  update(now, dt) {
    if (now >= this.balanceAt) { this.balanceAt = now + 2000; this.balance(); }
    for (const p of this.game.players.values()) if (p.bot) this.drive(p, now, dt);
  }

  balance() {
    const g = this.game;
    const humans = [];
    const bots = [];
    for (const p of g.players.values()) (p.bot ? bots : humans).push(p);
    if (!humans.length || this.max <= 0) { for (const b of bots) g.leave(b.id); return; }
    const humanCount = new Map();
    for (const h of humans) humanCount.set(h.country, (humanCount.get(h.country) || 0) + 1);
    const want = new Map();
    const add = (c, n) => { if (n > 0 && (g.cellCount.get(c) || 0) > 0) want.set(c, (want.get(c) || 0) + n); };
    for (const [c, n] of humanCount) {
      add(c, ALLY_TARGET - n);
      const rival = this.rivalFor(c, humans);
      if (rival) add(rival, Math.min(4, n + 1));
    }
    let total = 0;
    for (const n of want.values()) total += n;
    while (total > this.max) {
      let bc = 0, bn = 0;
      for (const [c, n] of want) if (n > bn) { bc = c; bn = n; }
      want.set(bc, bn - 1);
      total--;
    }
    const have = new Map();
    for (const b of bots) {
      const n = have.get(b.country) || 0;
      if (n >= (want.get(b.country) || 0)) { g.leave(b.id); continue; }
      have.set(b.country, n + 1);
    }
    for (const [c, n] of want) for (let i = have.get(c) || 0; i < n; i++) this.spawn(c, humans);
  }

  borders(a, b) {
    const g = this.game;
    for (const c of g.frontier(a)) {
      for (const [dx, dy] of N4) { const n = cellOffset(c, dx, dy); if (n >= 0 && g.grid[n] === b) return true; }
    }
    return false;
  }

  // The neighbour that shares the most border with this country near its human players.
  rivalFor(country, humans) {
    const g = this.game;
    const cur = this.rivals.get(country);
    if (cur && (g.cellCount.get(cur) || 0) > 0 && this.borders(country, cur)) return cur;
    const tally = new Map();
    const count = (cells) => {
      for (const c of cells) {
        for (const [dx, dy] of N4) {
          const n = cellOffset(c, dx, dy);
          const o = n >= 0 ? g.grid[n] : 0;
          if (o !== country && isLand(o)) tally.set(o, (tally.get(o) || 0) + 1);
        }
      }
    };
    for (const h of humans) if (h.country === country) count(g.frontierNear(country, h.x, h.y, 15));
    if (!tally.size) count(g.frontier(country));
    let best = 0, bn = 0;
    for (const [o, n] of tally) if (n > bn) { best = o; bn = n; }
    if (best) this.rivals.set(country, best);
    else this.rivals.delete(country);
    return best;
  }

  spawn(country, humans) {
    const g = this.game;
    let name;
    do {
      const base = NAMES[this.seq % NAMES.length];
      const lap = Math.floor(this.seq / NAMES.length);
      name = `AI-${base}${lap ? lap + 1 : ''}`;
      this.seq++;
    } while (g.byName.has(name.toLowerCase()));
    const look = { skin: randInt(LOOK.skin.length), shirt: randInt(8), pants: randInt(LOOK.pants.length), head: randInt(2), hat: randInt(4) };
    const p = g.addBot(country, name, look);
    if (!p) return;
    // Enemy bots start on their side of the border, facing the humans they are there for.
    if (!humans.some((h) => h.country === country)) {
      const foes = humans.filter((h) => h.alive);
      if (foes.length) {
        const h = pick(foes);
        const cells = g.frontierNear(country, h.x, h.y, 14);
        if (cells.length) { const [cx, cy] = cellXY(pick(cells)); g.teleport(p, cx + 0.5, cy + 0.5); }
      }
    }
  }

  rivalOf(country) {
    if (this.rivals.has(country)) return this.rivals.get(country);
    for (const [k, v] of this.rivals) if (v === country) return k;
    return 0;
  }

  // Breadth-first search over own land to the most useful border cell.
  plan(p, b, now) {
    const g = this.game;
    b.planAt = now + 2500 + Math.random() * 2000;
    b.goal = null;
    b.path = [];
    const start = cellAt(p.x, p.y);
    if (start < 0 || g.grid[start] !== p.country) return;
    const humanTargets = new Set();
    for (const q of g.players.values()) if (!q.bot && q.alive && q.country === p.country && q.pushCell >= 0) humanTargets.add(q.pushCell);
    const rival = this.rivalOf(p.country);
    const parent = new Map([[start, -1]]);
    const depth = new Map([[start, 0]]);
    const queue = [start];
    let best = null;
    let bestScore = Infinity;
    for (let qi = 0; qi < queue.length && qi < 5000; qi++) {
      const c = queue[qi];
      const d = depth.get(c);
      if (d > 70) break;
      for (const [dx, dy] of N4) {
        const n = cellOffset(c, dx, dy);
        if (n < 0) continue;
        const o = g.grid[n];
        if (o === p.country) {
          if (!parent.has(n)) { parent.set(n, c); depth.set(n, d + 1); queue.push(n); }
          continue;
        }
        if (!isLand(o)) continue;
        let score = d + Math.random() * 6; // a little randomness spreads bots along the front
        if (humanTargets.has(n)) score -= 60;
        const st = g.pressure.get(n);
        if (st && st.attacker === p.country) score -= 35;
        const under = g.pressure.get(c);
        if (under && under.attacker === o) score -= 45; // our cell is being pushed: push back
        if (o === rival) score -= 10;
        if (score < bestScore) { bestScore = score; best = { stand: c, target: n }; }
      }
    }
    if (!best) return;
    b.goal = best;
    const path = [];
    for (let c = best.stand; c !== -1 && c !== undefined; c = parent.get(c)) path.push(c);
    b.path = path.reverse();
  }

  nearCrate(p) {
    let best = null, bd = 5;
    for (const k of this.game.crates.values()) {
      if (k.country !== p.country) continue;
      const d = Math.hypot(wrapDelta(k.x - p.x), k.y - p.y);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }

  drive(p, now, dt) {
    const g = this.game;
    if (!p.alive) { p.brain = null; return; }
    const b = p.brain || (p.brain = { goal: null, path: [], planAt: 0, lastX: p.x, lastY: p.y, checkAt: now + 1500 });
    const goalBad = !b.goal || g.grid[b.goal.stand] !== p.country || g.grid[b.goal.target] === p.country || !isLand(g.grid[b.goal.target]);
    if (goalBad || now >= b.planAt) this.plan(p, b, now);

    const here = cellAt(p.x, p.y);
    let dx = 0, dy = 0;
    const crate = this.nearCrate(p);
    if (crate) {
      dx = wrapDelta(crate.x - p.x);
      dy = crate.y - p.y;
    } else if (b.goal) {
      if (here === b.goal.stand) {
        const [sx, sy] = cellXY(b.goal.stand);
        const [tx, ty] = cellXY(b.goal.target);
        dx = wrapDelta(tx - sx);
        dy = ty - sy;
      } else {
        while (b.path.length && b.path[0] === here) b.path.shift();
        const [nx, ny] = cellXY(b.path.length ? b.path[0] : b.goal.stand);
        dx = wrapDelta(nx + 0.5 - p.x);
        dy = ny + 0.5 - p.y;
      }
    }
    const len = Math.hypot(dx, dy);
    if (len > 0.05) { dx /= len; dy /= len; } else { dx = 0; dy = 0; }
    p.input.dx = dx;
    p.input.dy = dy;
    const r = stepMovement(g.grid, p.country, p.x, p.y, dx, dy, dt);
    if (r.x !== p.x || r.y !== p.y) { p.x = r.x; p.y = r.y; p.movedAt = now; }

    // Stuck somewhere on the way: plan again.
    if (now >= b.checkAt) {
      const moved = Math.hypot(wrapDelta(p.x - b.lastX), p.y - b.lastY);
      if (b.goal && here !== b.goal.stand && moved < 0.3) b.planAt = 0;
      b.lastX = p.x;
      b.lastY = p.y;
      b.checkAt = now + 1500;
    }
    this.fight(p, dx, dy);
  }

  fight(p, dx, dy) {
    const w = p.weapon ? WEAPONS[p.weapon] : null;
    let target = null, td = Infinity;
    for (const q of this.game.players.values()) {
      if (!q.alive || q.country === p.country) continue;
      const d = Math.hypot(wrapDelta(q.x - p.x), q.y - p.y);
      if (d < td) { td = d; target = q; }
    }
    if (w && target && td <= w.range * 0.85) {
      p.input.aim = Math.atan2(target.y - p.y, wrapDelta(target.x - p.x)) + (Math.random() - 0.5) * 0.25;
      p.input.fire = Math.random() < 0.6;
    } else {
      p.input.fire = false;
      if (dx || dy) p.input.aim = Math.atan2(dy, dx);
    }
  }
}
