// Quick play, front-line spawns, bots, scoring, crates, rounds, capitals, chat filter, previews.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBaseMap } from '../server/mapdata.js';
import { Game } from '../server/game.js';
import { CAPITALS } from '../server/capitals.js';
import { maskProfanity } from '../server/chatfilter.js';
import { renderMapPNG } from '../server/png.js';
import { TICK_HZ, SCORE, BOUNTY_STREAK, CAPITAL_SLOWDOWN, cellAt, cellXY, cellOffset, isLand, underdogFactor } from '../shared/constants.js';

const base = loadBaseMap();
const TR = base.countries.find((c) => c.code === 'tr').id;
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function newGame(opts = {}) {
  const events = [];
  const game = new Game({
    grid: new Uint8Array(base.grid), countries: base.countries, capitals: CAPITALS,
    weaponIntervalMs: 1e12, emit: (ev, payload) => events.push([ev, payload]), ...opts,
  });
  return { game, events };
}
const run = (g, s) => { for (let i = 0; i < s * TICK_HZ; i++) g.tick(); };
const isFront = (g, c, country) => g.grid[c] === country && N4.some(([dx, dy]) => {
  const n = cellOffset(c, dx, dy);
  return n >= 0 && g.grid[n] !== country && isLand(g.grid[n]);
});

test('Play without choosing puts newcomers in the busiest country', () => {
  const { game } = newGame();
  const a = game.join({ name: 'ilk', country: TR, look: {} }).player;
  const b = game.join({ name: 'ikinci', country: 'auto', look: {} }).player;
  assert.equal(b.country, a.country);
  const { game: empty } = newGame();
  const c = empty.join({ name: 'yalniz', country: 'auto', look: {} }).player;
  assert.ok(empty.cellCount.get(c.country) > 0);
});

test('a lone player spawns on the front line, a second one next to them', () => {
  const { game } = newGame();
  const a = game.join({ name: 'cephe', country: TR, look: {} }).player;
  assert.ok(isFront(game, cellAt(a.x, a.y), TR), 'first player starts on a border cell');
  a.pushCell = 1; // pretend to be pushing
  const b = game.join({ name: 'yanina', country: TR, look: {} }).player;
  assert.ok(Math.hypot(b.x - a.x, b.y - a.y) <= 3.2);
});

test('bots join a lonely human, bring enemies from a neighbour, and leave with the human', () => {
  const { game } = newGame({ maxBots: 10 });
  const h = game.join({ name: 'insan', country: TR, look: {} }).player;
  game.tick();
  const bots = [...game.players.values()].filter((p) => p.bot);
  const allies = bots.filter((p) => p.country === TR);
  const enemies = bots.filter((p) => p.country !== TR);
  assert.equal(allies.length, 2, 'two allies for one human');
  assert.ok(enemies.length >= 2, 'enemy bots from a neighbour');
  assert.ok(game.bots.borders(TR, enemies[0].country), 'enemies come from a bordering country');
  run(game, 12);
  const atFront = allies.filter((b) => isFront(game, cellAt(b.x, b.y), TR) || b.pushCell >= 0);
  assert.ok(atFront.length >= 1, 'allies walk to the border');
  game.leave(h.id);
  game.bots.balanceAt = 0;
  game.tick();
  assert.equal([...game.players.values()].filter((p) => p.bot).length, 0);
});

test('kills score points, five in a row put a bounty on you, and the bounty pays out', () => {
  const { game, events } = newGame();
  const killer = game.join({ name: 'avci', country: TR, look: {} }).player;
  const enemyCountry = base.countries.find((c) => c.code === 'gr').id;
  for (let i = 0; i < BOUNTY_STREAK; i++) {
    const v = game.join({ name: `hedef${i}`, country: enemyCountry, look: {} }).player;
    game.damage(v, 999, killer, 'tabanca');
  }
  assert.equal(killer.score, SCORE.kill * BOUNTY_STREAK);
  assert.ok(events.some(([ev, p]) => ev === 'bounty' && p.id === killer.id));
  const hunter = game.join({ name: 'odulcu', country: enemyCountry, look: {} }).player;
  game.damage(killer, 999, hunter, 'keskin');
  assert.equal(hunter.score, SCORE.kill + SCORE.bounty);
  const kill = events.filter(([ev]) => ev === 'kill').pop()[1];
  assert.equal(kill.bounty, true);
  assert.equal(kill.life.kills, BOUNTY_STREAK, 'the death summary carries what you did this life');
});

test('pushing a cell over gives both pushers capture points', () => {
  const { game } = newGame();
  let front = -1, target = -1;
  for (let c = 0; c < game.grid.length && front < 0; c++) {
    if (game.grid[c] !== TR) continue;
    const e = cellOffset(c, 1, 0), w = cellOffset(c, -1, 0);
    if (game.grid[w] === TR && isLand(game.grid[e]) && game.grid[e] !== TR && !game.capitals.has(e)) { front = c; target = e; }
  }
  const ps = ['bir', 'iki'].map((n) => {
    const p = game.join({ name: n, country: TR, look: {} }).player;
    const [x, y] = cellXY(front);
    p.x = x + 0.5; p.y = y + 0.5;
    game.setInput(p.id, { dx: 1, dy: 0, aim: 0 });
    return p;
  });
  run(game, 7);
  assert.equal(game.grid[target], TR);
  for (const p of ps) { assert.ok(p.score >= SCORE.capture); assert.ok(p.life.captures >= 1); }
});

test('capitals sit on their own country and take twice as long to push', () => {
  const { game } = newGame();
  const ankara = [...game.capitals].find(([, c]) => c.name === 'Ankara');
  assert.ok(ankara, 'Ankara found');
  assert.equal(game.baseGrid[ankara[0]], TR);
  assert.equal(CAPITAL_SLOWDOWN, 0.5);
  assert.ok(game.capitalList().length > 80, 'most capitals resolve to a cell');
});

test('crates drop near players on the front and can be picked up', () => {
  const { game, events } = newGame({ crates: true });
  const p = game.join({ name: 'toplayici', country: TR, look: {} }).player;
  game.nextCrateAt = 0; // crates run on the wall clock; don't wait 3 real seconds
  game.tick();
  assert.ok(game.crates.size >= 1, 'a crate dropped');
  const k = [...game.crates.values()][0];
  assert.equal(game.grid[cellAt(k.x, k.y)], k.country);
  p.country = k.country; p.x = k.x; p.y = k.y;
  game.tick();
  assert.ok(events.some(([ev, e]) => ev === 'crate' && e.by === p.id));
});

test('a round ends with a winner and the map goes back to the real world', () => {
  const { game, events } = newGame();
  game.join({ name: 'turcu', country: TR, look: {} });
  const c = game.frontier(TR)[0];
  const victim = [...N4].map(([dx, dy]) => cellOffset(c, dx, dy)).find((n) => n >= 0 && isLand(game.grid[n]) && game.grid[n] !== TR);
  game.flip(victim, TR, []);
  game.round.endsAt = Date.now() - 1;
  game.tick();
  const end = events.find(([ev]) => ev === 'roundEnd');
  assert.ok(end && end[1].winner && end[1].winner.id === TR);
  assert.equal(game.grid[victim], base.grid[victim]);
  assert.equal(game.round.n, 2);
  assert.ok(events.some(([ev]) => ev === 'roundStart'));
});

test('"To the front" jumps to the border once, then asks you to wait', () => {
  const { game } = newGame();
  const p = game.join({ name: 'kosucu', country: TR, look: {} }).player;
  p.frontAt = 0;
  assert.ok(game.toFront(p).ok);
  assert.ok(isFront(game, cellAt(p.x, p.y), TR));
  assert.match(game.toFront(p).error, /Wait/);
});

test('small countries push faster than huge ones', () => {
  assert.ok(underdogFactor(20) > underdogFactor(300));
  assert.ok(underdogFactor(10000) < 1);
  assert.equal(underdogFactor(1), 1.5);
});

test('chat filter masks swear words but not innocent ones', () => {
  assert.equal(maskProfanity('you fuuuck off'), 'you ****** off');
  assert.equal(maskProfanity('amk ya'), '*** ya');
  assert.equal(maskProfanity('Niger and Nigeria'), 'Niger and Nigeria');
  assert.equal(maskProfanity('şunu götür lütfen'), 'şunu götür lütfen');
});

test('the link preview image is a 1200x630 PNG', () => {
  const png = renderMapPNG(base.grid, base.countries);
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});
