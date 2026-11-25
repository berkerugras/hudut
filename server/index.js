import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { loadBaseMap, DATA_DIR } from './mapdata.js';
import { Game, cleanChat } from './game.js';
import { CAPITALS } from './capitals.js';
import { renderMapPNG } from './png.js';
import { TICK_HZ, sanitizeLook } from '../shared/constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = Number(process.env.PORT) || 3000;
// Every player gets a new random weapon this often.
const intervalSec = Number(process.env.WEAPON_INTERVAL_SEC) || 30;
const weaponIntervalMs = Math.round(intervalSec * 1000);
// The map goes back to the real world and a winner is announced this often.
const roundMinutes = Number(process.env.ROUND_MINUTES) || 24 * 60;
const MAX_BOTS = process.env.MAX_BOTS === undefined ? 20 : Number(process.env.MAX_BOTS) || 0;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 100;

// ---- territory: base map + saved borders + saved round ----
const { grid: baseGrid, countries } = loadBaseMap();
const TERRITORY_FILE = path.join(DATA_DIR, 'territory.bin');
const ROUND_FILE = path.join(DATA_DIR, 'round.json');
let grid = new Uint8Array(baseGrid);
try {
  const saved = fs.readFileSync(TERRITORY_FILE);
  if (saved.length === grid.length) {
    grid = new Uint8Array(saved);
    console.log('[harita] Kayıtlı sınırlar yüklendi.');
  }
} catch { /* first run */ }
let savedRound = null;
try { savedRound = JSON.parse(fs.readFileSync(ROUND_FILE, 'utf8')); } catch { /* first run */ }

// ---- web server ----
const app = express();
app.set('trust proxy', true); // behind Render/ngrok: so req.protocol is https
const server = http.createServer(app);
// Clients only send tiny messages (join, input, chat); refuse anything big.
const io = new Server(server, { perMessageDeflate: { threshold: 1024 }, maxHttpBufferSize: 16 * 1024 });

const game = new Game({
  grid,
  baseGrid: new Uint8Array(baseGrid),
  countries,
  capitals: CAPITALS,
  weaponIntervalMs,
  roundMs: roundMinutes * 60 * 1000,
  round: savedRound,
  maxBots: MAX_BOTS,
  crates: true,
  emit: (event, payload) => io.to('game').emit(event, payload),
});

app.disable('x-powered-by');

// The page, with absolute URLs filled in for link previews.
const INDEX_FILE = path.join(root, 'public', 'index.html');
function sendIndex(req, res) {
  const origin = `${req.protocol}://${req.get('host')}`;
  const html = fs.readFileSync(INDEX_FILE, 'utf8').replaceAll('__ORIGIN__', origin);
  res.set('Cache-Control', 'no-cache').type('html').send(html);
}
app.get(['/', '/index.html'], sendIndex);

// Live map picture for link previews; redrawn at most once a minute.
let og = { at: 0, png: null };
app.get('/og.png', (req, res) => {
  if (!og.png || Date.now() - og.at > 60000) og = { at: Date.now(), png: renderMapPNG(game.grid, countries) };
  res.set('Cache-Control', 'public, max-age=300').type('png').send(og.png);
});

app.use(express.static(path.join(root, 'public'), { index: false }));
app.use('/shared', express.static(path.join(root, 'shared')));
app.use('/vendor/three/build', express.static(path.join(root, 'node_modules', 'three', 'build')));
app.use('/vendor/three/addons', express.static(path.join(root, 'node_modules', 'three', 'examples', 'jsm')));

// Render (and other hosts) ping this to know the server is up.
app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

app.get('/api/countries', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    countries: game.countryList(),
    players: game.humanCount(),
    nextDropAt: game.nextDropAt,
    now: Date.now(),
    weaponIntervalMs,
    round: game.roundInfo(),
  });
});
app.get('/api/territory', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/octet-stream').send(Buffer.from(game.grid));
});

io.on('connection', (socket) => {
  let playerId = 0;
  let teamRoom = '';
  let lastJoin = 0;
  let inputWindow = 0;
  let inputCount = 0;
  let chatTimes = [];
  const leaveGame = () => {
    if (!playerId) return;
    game.leave(playerId);
    playerId = 0;
    socket.leave('game');
    if (teamRoom) socket.leave(teamRoom);
    teamRoom = '';
  };

  socket.on('join', (data, ack) => {
    if (typeof ack !== 'function') return;
    const now = Date.now();
    if (now - lastJoin < 1000) return ack({ error: 'Too many tries. Wait a second and try again.', code: 'busy' });
    lastJoin = now;
    if (!playerId && game.humanCount() >= MAX_PLAYERS) return ack({ error: 'The server is full right now. Try again later.', code: 'busy' });
    leaveGame();
    const r = game.join({ name: data && data.name, country: data && data.country, look: sanitizeLook(data && data.look) });
    if (r.error) return ack({ error: r.error, code: r.code });
    playerId = r.player.id;
    teamRoom = `country:${r.player.country}`;
    socket.join('game');
    socket.join(teamRoom);
    ack({
      ok: true,
      you: playerId,
      country: r.player.country,
      x: r.player.x,
      y: r.player.y,
      tp: r.player.tp,
      players: [...game.players.values()].map((p) => game.publicPlayer(p)),
      countries: game.countryList(),
      capitals: game.capitalList(),
      crates: game.crateList(),
      round: game.roundInfo(),
      grid: Buffer.from(game.grid),
      nextDropAt: game.nextDropAt,
      now: Date.now(),
      weaponIntervalMs,
    });
  });

  socket.on('input', (input) => {
    // The client sends 20 inputs a second. Allow bursts (networks deliver them bunched up)
    // but cap the rate, and never drop the newest one just because it arrived close to the last.
    const now = Date.now();
    if (now - inputWindow > 1000) { inputWindow = now; inputCount = 0; }
    if (!playerId || ++inputCount > 60) return;
    game.setInput(playerId, input);
  });

  socket.on('toFront', (ack) => {
    if (typeof ack !== 'function') return;
    ack(game.toFront(game.players.get(playerId)));
  });

  socket.on('chat', (msg) => {
    if (!playerId) return;
    const now = Date.now();
    // At most 5 messages per 5 seconds.
    chatTimes = chatTimes.filter((t) => now - t < 5000);
    if (chatTimes.length >= 5) return socket.emit('chatRefused', { reason: 'Slow down: wait a few seconds before sending more.' });
    const text = cleanChat(msg && msg.text);
    if (!text) return;
    chatTimes.push(now);
    const p = game.players.get(playerId);
    if (!p) return;
    const team = !!(msg && msg.team);
    io.to(team ? teamRoom : 'game').emit('chat', { id: p.id, name: p.name, country: p.country, text, team });
  });

  socket.on('leave', leaveGame);
  socket.on('disconnect', leaveGame);
});

setInterval(() => game.tick(), 1000 / TICK_HZ);

// ---- save borders and the round so a restart keeps them ----
function save() {
  try {
    fs.writeFileSync(ROUND_FILE, JSON.stringify(game.round));
    if (!game.dirty) return;
    game.dirty = false;
    const tmp = TERRITORY_FILE + '.tmp';
    fs.writeFileSync(tmp, game.grid);
    fs.renameSync(tmp, TERRITORY_FILE);
  } catch (err) {
    console.error('[kayıt] Yazılamadı:', err.message);
  }
}
setInterval(save, 15000);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { save(); } finally { process.exit(0); } });
}

server.listen(PORT, () => {
  console.log(`Hudut çalışıyor: http://localhost:${PORT}  (silah: ${intervalSec} sn, tur: ${roundMinutes} dk, en fazla ${MAX_BOTS} bot)`);
});
