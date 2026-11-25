// Border rules: one player bends a border but never takes it; a group takes it; defenders push back equally.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBaseMap } from '../server/mapdata.js';
import { Game } from '../server/game.js';
import { TICK_HZ, cellOffset, cellXY, isLand } from '../shared/constants.js';

const base = loadBaseMap();
const TR = base.countries.find((c) => c.iso === '792').id; // Türkiye

function newGame() {
  return new Game({ grid: new Uint8Array(base.grid), countries: base.countries, weaponIntervalMs: 1e12, emit: () => {} });
}

// A Turkish cell whose east neighbour is foreign land, with Turkish land behind it (west).
function findFront(grid) {
  for (let c = 0; c < grid.length; c++) {
    if (grid[c] !== TR) continue;
    const east = cellOffset(c, 1, 0);
    const west = cellOffset(c, -1, 0);
    if (east >= 0 && west >= 0 && grid[west] === TR && isLand(grid[east]) && grid[east] !== TR) {
      const east2 = cellOffset(east, 1, 0);
      if (grid[east2] === grid[east]) return { from: c, target: east, enemy: grid[east] };
    }
  }
  throw new Error('no front found');
}

function place(game, name, country, cell, dx) {
  const r = game.join({ name, country, look: {} });
  assert.ok(r.player, r.error);
  const [x, y] = cellXY(cell);
  r.player.x = x + 0.5;
  r.player.y = y + 0.5;
  game.setInput(r.player.id, { dx, dy: 0, aim: 0, fire: false });
  return r.player;
}

function run(game, seconds) {
  for (let i = 0; i < seconds * TICK_HZ; i++) game.tick();
}

test('a single player bends the border to 50% but cannot take the cell', () => {
  const g = newGame();
  const f = findFront(g.grid);
  place(g, 'yalniz', TR, f.from, 1);
  run(g, 15);
  assert.equal(g.grid[f.target], f.enemy);
  const st = g.pressure.get(f.target);
  assert.ok(st && st.attacker === TR, 'cell should be under Turkish pressure');
  assert.ok(st.p > 0.45 && st.p <= 0.5 + 1e-9, `pressure ${st.p}`);
});

test('two players pushing together take the cell', () => {
  const g = newGame();
  const f = findFront(g.grid);
  place(g, 'birinci', TR, f.from, 1);
  place(g, 'ikinci', TR, f.from, 1);
  run(g, 6);
  assert.equal(g.grid[f.target], TR);
});

test('one defender cancels one attacker of two: the border holds', () => {
  const g = newGame();
  const f = findFront(g.grid);
  place(g, 'saldiran1', TR, f.from, 1);
  place(g, 'saldiran2', TR, f.from, 1);
  place(g, 'savunan', f.enemy, f.target, -1);
  run(g, 15);
  assert.equal(g.grid[f.target], f.enemy);
  const st = g.pressure.get(f.target);
  assert.ok(!st || st.p <= 0.5 + 1e-9, `pressure ${st && st.p}`);
});

test('weapons make pushing faster, not stronger', () => {
  const slow = newGame();
  const fast = newGame();
  const f = findFront(slow.grid);
  place(slow, 'eli-bos', TR, f.from, 1);
  place(fast, 'silahli', TR, f.from, 1).weapon = 'roket';
  run(slow, 1.5);
  run(fast, 1.5);
  assert.ok(fast.pressure.get(f.target).p > slow.pressure.get(f.target).p);
  run(fast, 15);
  assert.equal(fast.grid[f.target], f.enemy, 'an armed player alone still cannot take a cell');
});
