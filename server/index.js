import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { loadBaseMap, DATA_DIR } from './mapdata.js';
import { Game } from './game.js';
import { TICK_HZ, sanitizeLook } from '../shared/constants.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const PORT = Number(process.env.PORT) || 3000;
const DEV = process.argv.includes('--dev');
// Weapons arrive every 30 minutes; `npm run dev` uses 1 minute so you can test quickly.
const intervalMin = Number(process.env.WEAPON_INTERVAL_MIN) || (DEV ? 1 : 30);
const weaponIntervalMs = Math.round(intervalMin * 60 * 1000);

// ---- territory: base map + saved borders ----
const { grid: baseGrid, countries } = loadBaseMap();
const TERRITORY_FILE = path.join(DATA_DIR, 'territory.bin');
let grid = new Uint8Array(baseGrid);
try {
  const saved = fs.readFileSync(TERRITORY_FILE);
  if (saved.length === grid.length) {
    grid = new Uint8Array(saved);
    console.log('[harita] Kayıtlı sınırlar yüklendi.');
  }
} catch { /* first run */ }

// ---- web server ----
const app = express();
const server = http.createServer(app);
// Clients only send tiny messages (join, input); refuse anything big.
const io = new Server(server, { perMessageDeflate: { threshold: 1024 }, maxHttpBufferSize: 16 * 1024 });
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 100;

const game = new Game({
  grid,
  countries,
  weaponIntervalMs,
  emit: (event, payload) => io.to('game').emit(event, payload),
});

app.disable('x-powered-by');
app.use(express.static(path.join(root, 'public')));
app.use('/shared', express.static(path.join(root, 'shared')));
app.use('/vendor/three/build', express.static(path.join(root, 'node_modules', 'three', 'build')));
app.use('/vendor/three/addons', express.static(path.join(root, 'node_modules', 'three', 'examples', 'jsm')));

// Render (and other hosts) ping this to know the server is up.
app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

app.get('/api/countries', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ countries: game.countryList(), players: game.players.size, nextDropAt: game.nextDropAt, now: Date.now(), weaponIntervalMs });
});
app.get('/api/territory', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('application/octet-stream').send(Buffer.from(game.grid));
});

io.on('connection', (socket) => {
  let playerId = 0;
  let lastJoin = 0;
  let lastInput = 0;
  const leaveGame = () => {
    if (!playerId) return;
    game.leave(playerId);
    playerId = 0;
    socket.leave('game');
  };

  socket.on('join', (data, ack) => {
    if (typeof ack !== 'function') return;
    const now = Date.now();
    if (now - lastJoin < 1000) return ack({ error: 'Çok hızlı denedin. Bir saniye bekleyip tekrar dene.' });
    lastJoin = now;
    if (!playerId && game.players.size >= MAX_PLAYERS) return ack({ error: 'Sunucu şu an dolu. Biraz sonra tekrar dene.' });
    leaveGame();
    const r = game.join({ name: data && data.name, country: data && data.country, look: sanitizeLook(data && data.look) });
    if (r.error) return ack({ error: r.error });
    playerId = r.player.id;
    socket.join('game');
    ack({
      ok: true,
      you: playerId,
      x: r.player.x,
      y: r.player.y,
      players: [...game.players.values()].map((p) => game.publicPlayer(p)),
      countries: game.countryList(),
      grid: Buffer.from(game.grid),
      nextDropAt: game.nextDropAt,
      now: Date.now(),
      weaponIntervalMs,
    });
  });
  socket.on('input', (input) => {
    // The client sends 20 inputs a second; ignore anything much faster than that.
    const now = Date.now();
    if (!playerId || now - lastInput < 15) return;
    lastInput = now;
    game.setInput(playerId, input);
  });
  socket.on('leave', leaveGame);
  socket.on('disconnect', leaveGame);
});

setInterval(() => game.tick(), 1000 / TICK_HZ);

// ---- save borders so a restart keeps them ----
function save() {
  if (!game.dirty) return;
  game.dirty = false;
  const tmp = TERRITORY_FILE + '.tmp';
  fs.writeFileSync(tmp, game.grid);
  fs.renameSync(tmp, TERRITORY_FILE);
}
setInterval(save, 15000);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { save(); } finally { process.exit(0); } });
}

server.listen(PORT, () => {
  console.log(`Hudut çalışıyor: http://localhost:${PORT}  (silah aralığı: ${intervalMin} dk${DEV ? ', geliştirme modu' : ''})`);
});
