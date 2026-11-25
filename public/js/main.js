// Screens: one-click Play (with optional character and country screens) -> game.
// Invite links like /#tr open the game with that country already chosen.
import { io } from '/socket.io/socket.io.esm.min.js';
import { LOOK, GRID_W, GRID_H, sanitizeLook } from '/shared/constants.js';
import { MapPainter } from './mapview.js';
import { createPreview } from './character.js';
import { createGame } from './game.js';
import { unlockAudio } from './sfx.js';
import { unlockNeeded } from './career.js';
import { copyText } from './share.js';

const $ = (id) => document.getElementById(id);
const NAME_RE = /^[\p{L}\p{N}_.-]{3,16}$/u;
const fmt = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const randomLook = () => ({
  skin: Math.floor(Math.random() * LOOK.skin.length), shirt: Math.floor(Math.random() * 8),
  pants: Math.floor(Math.random() * LOOK.pants.length), head: Math.floor(Math.random() * 2), hat: Math.floor(Math.random() * 4),
});

const saved = store.get('hudut.profile', null);
const profile = Object.assign({ name: '', look: randomLook(), country: 0 }, saved || {});
profile.look = sanitizeLook(profile.look);
const saveProfile = () => store.set('hudut.profile', profile);
if (!saved) saveProfile();

const state = {
  screen: 'login',
  countries: [],
  byId: new Map(),
  byCode: new Map(),
  grid: null,
  selected: profile.country || 0, // 0 = let the server pick the busiest country
  hover: 0,
  joining: false,
  game: null,
  refreshTimer: 0,
};
const painter = new MapPainter();
const socket = io();
const inviteUrl = (code) => `${location.origin}/#${code}`;

// ---------------- data ----------------
function intervalText(ms) {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return sec === 1 ? 'second' : `${sec} seconds`;
  const min = Math.round(sec / 60);
  if (min >= 60 && min % 60 === 0) return min === 60 ? 'hour' : `${min / 60} hours`;
  return min === 1 ? 'minute' : `${min} minutes`;
}
async function refreshWorld() {
  try {
    const [cRes, tRes] = await Promise.all([fetch('/api/countries'), fetch('/api/territory')]);
    const data = await cRes.json();
    const buf = await tRes.arrayBuffer();
    applyCountries(data.countries);
    state.grid = new Uint8Array(buf);
    painter.setGrid(state.grid);
    $('onlineText').textContent = data.players
      ? `${plural(data.players, 'player', 'players')} in the game right now`
      : 'Nobody is playing yet. Be the first.';
    $('ruleInterval').textContent = intervalText(data.weaponIntervalMs);
    applyHash();
    drawBackground();
    updatePlayWhere();
    if (state.screen === 'country') { renderList(); drawPickMap(); updatePickInfo(); }
  } catch {
    $('onlineText').textContent = "Can't reach the server. Make sure it is running.";
  }
}
function applyCountries(list) {
  state.countries = list;
  state.byId = new Map(list.map((c) => [c.id, c]));
  state.byCode = new Map(list.map((c) => [c.code, c]));
  painter.setCountries(list);
}
// /#tr -> Türkiye is preselected.
function applyHash() {
  const code = decodeURIComponent(location.hash.slice(1)).toLowerCase();
  const c = code && state.byCode.get(code);
  if (c && c.cells > 0) state.selected = c.id;
}
window.addEventListener('hashchange', () => { applyHash(); updatePlayWhere(); });

function drawBackground() {
  if (!state.grid) return;
  const c = $('bgMap');
  const w = window.innerWidth;
  const h = window.innerHeight;
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const src = painter.paint({ mine: state.selected || -1 });
  const scale = Math.max(w / GRID_W, h / GRID_H);
  ctx.drawImage(src, (w - GRID_W * scale) / 2, (h - GRID_H * scale) / 2, GRID_W * scale, GRID_H * scale);
}

// ---------------- screens ----------------
function show(screen) {
  state.screen = screen;
  $('scrLogin').hidden = screen !== 'login';
  $('scrChar').hidden = screen !== 'char';
  $('scrCountry').hidden = screen !== 'country';
  $('bgMap').hidden = screen === 'game';
  if (screen === 'char') openChar(); else if (preview) preview.stop();
  if (screen === 'country') openCountry(); else clearInterval(state.refreshTimer);
  if (screen === 'login') { updatePlayWhere(); drawBackground(); }
}

// ---- Play ----
function loginError(msg) {
  const el = $('loginError');
  el.textContent = msg || '';
  el.hidden = !msg;
}
function updatePlayWhere() {
  const el = $('playWhere');
  const c = state.byId.get(state.selected);
  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'linkish';
  change.textContent = 'Change';
  change.addEventListener('click', () => show('country'));
  const b = document.createElement('b');
  if (c && c.cells > 0) {
    b.textContent = c.name;
    el.replaceChildren("You'll fight for ", b, c.online ? ` (${fmt(c.online)} playing). ` : '. ', change);
    return;
  }
  let best = null;
  for (const x of state.countries) if (x.online && x.cells > 0 && (!best || x.online > best.online)) best = x;
  if (best) {
    b.textContent = best.name;
    el.replaceChildren("You'll join ", b, `, where ${plural(best.online, 'person is', 'people are')} playing. `, change);
  } else {
    el.replaceChildren('You\'ll join a country at war. AI soldiers fight beside you until friends arrive. ', change);
  }
}
function doPlay() {
  unlockAudio(); // sound may only start after a click
  let name = $('nameInput').value.trim();
  if (!name) {
    name = profile.name || `Soldier${Math.floor(1000 + Math.random() * 9000)}`;
    $('nameInput').value = name;
  }
  if (!NAME_RE.test(name)) {
    show('login');
    loginError('Names are 3–16 characters: letters, numbers, _ . -');
    return;
  }
  loginError('');
  profile.name = name;
  saveProfile();
  const c = state.byId.get(state.selected);
  join(c && c.cells > 0 ? c.id : 'auto');
}
$('nameInput').value = profile.name;
$('loginForm').addEventListener('submit', (e) => { e.preventDefault(); doPlay(); });
$('openChar').addEventListener('click', () => show('char'));
$('openCountry').addEventListener('click', () => show('country'));

// ---- character ----
let preview = null;
const SWATCH_LABEL = { skin: 'Skin tone', shirt: 'Top color', pants: 'Bottom color' };
const CHIP_LABEL = { head: ['Round', 'Square'], hat: ['None', 'Cap', 'Helmet', 'Beanie', 'Beret', 'Top hat', 'Crown'] };
function openChar() {
  if (!preview) preview = createPreview($('charCanvas'));
  preview.start();
  preview.setLook(profile.look);
  renderOptions();
}
function renderOptions() {
  document.querySelectorAll('#scrChar [data-key]').forEach((wrap) => {
    const key = wrap.dataset.key;
    const swatch = wrap.classList.contains('swatches');
    wrap.replaceChildren(...LOOK[key].map((val, i) => {
      const b = document.createElement('button');
      const need = unlockNeeded(key, i);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(profile.look[key] === i));
      if (swatch) {
        b.className = 'swatch-btn';
        b.style.background = val;
        b.setAttribute('aria-label', `${SWATCH_LABEL[key]} ${i + 1}${need ? `, unlocks at ${fmt(need)} points` : ''}`);
      } else {
        b.className = 'chip';
        b.textContent = CHIP_LABEL[key][i];
      }
      if (need) {
        b.disabled = true;
        b.classList.add('locked');
        b.title = `Unlocks at ${fmt(need)} points`;
        if (!swatch) b.textContent += ` · ${fmt(need)}`;
      }
      b.addEventListener('click', () => setLook(key, i));
      return b;
    }));
  });
}
function setLook(key, i) {
  if (unlockNeeded(key, i)) return;
  profile.look[key] = i;
  saveProfile();
  preview.setLook(profile.look);
  renderOptions();
}
$('charBack').addEventListener('click', () => show('login'));
$('charRandom').addEventListener('click', () => {
  profile.look = randomLook();
  saveProfile();
  preview.setLook(profile.look);
  renderOptions();
});
$('charPlay').addEventListener('click', doPlay);

// ---- country ----
const pickMap = $('pickMap');
pickMap.width = GRID_W;
pickMap.height = GRID_H;
function openCountry() {
  joinError('');
  renderList();
  sizePickMap();
  drawPickMap();
  updatePickInfo();
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(refreshWorld, 5000);
}
function sizePickMap() {
  const wrap = $('mapWrap');
  const w = wrap.clientWidth - 2;
  const h = wrap.clientHeight - 2;
  if (w <= 0) return;
  const width = Math.min(w, h > 40 ? h * 2 : w);
  pickMap.style.width = `${Math.floor(width)}px`;
  pickMap.style.height = `${Math.floor(width / 2)}px`;
}
new ResizeObserver(() => { if (state.screen === 'country') sizePickMap(); }).observe($('mapWrap'));
function drawPickMap() {
  if (!state.grid) return;
  pickMap.getContext('2d').drawImage(painter.paint({ highlight: state.hover || -1, mine: state.selected || -1 }), 0, 0);
}
function ownerAtEvent(e) {
  const r = pickMap.getBoundingClientRect();
  const cx = Math.floor(((e.clientX - r.left) / r.width) * GRID_W);
  const cy = Math.floor(((e.clientY - r.top) / r.height) * GRID_H);
  if (!state.grid || cx < 0 || cy < 0 || cx >= GRID_W || cy >= GRID_H) return 0;
  const o = state.grid[cy * GRID_W + cx];
  return state.byId.has(o) ? o : 0;
}
pickMap.addEventListener('mousemove', (e) => {
  const o = ownerAtEvent(e);
  const tip = $('mapTip');
  if (o !== state.hover) { state.hover = o; drawPickMap(); }
  if (!o) { tip.hidden = true; return; }
  const c = state.byId.get(o);
  const b = document.createElement('b'); b.textContent = c.name;
  tip.replaceChildren(b, ` · ${plural(c.cells, 'cell', 'cells')} · ${c.online ? `${fmt(c.online)} playing` : 'nobody playing'}`);
  tip.hidden = false;
  const wr = $('mapWrap').getBoundingClientRect();
  const x = Math.min(e.clientX - wr.left + 14, wr.width - tip.offsetWidth - 8);
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${e.clientY - wr.top + 14}px`;
});
pickMap.addEventListener('mouseleave', () => { state.hover = 0; $('mapTip').hidden = true; drawPickMap(); });
pickMap.addEventListener('click', (e) => { const o = ownerAtEvent(e); if (o) select(o); });
$('countrySearch').addEventListener('input', renderList);

let listKey = '';
function renderList() {
  // Accent-insensitive search, so "turkiye" finds "Türkiye" and "cote" finds "Côte d’Ivoire".
  const q = fold($('countrySearch').value.trim());
  const list = state.countries
    .filter((c) => c.cells > 0 && (!q || fold(c.name).includes(q)))
    .sort((a, b) => b.online - a.online || a.name.localeCompare(b.name, 'en'));
  // Rebuild only when something visible changed, so rows don't vanish under the pointer.
  const key = list.map((c) => `${c.id}:${c.online}:${c.cells}`).join(',');
  if (key === listKey && $('countryList').children.length) return;
  listKey = key;
  $('countryList').replaceChildren(...list.map((c) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(c.id === state.selected));
    li.dataset.id = c.id;
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = c.color;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = c.name;
    const meta = document.createElement('span');
    meta.className = 'meta' + (c.online ? ' live' : '');
    meta.textContent = c.online ? `${fmt(c.online)} playing` : plural(c.cells, 'cell', 'cells');
    li.append(sw, nm, meta);
    li.addEventListener('click', () => select(c.id));
    return li;
  }));
}
function select(id) {
  state.selected = id;
  joinError('');
  for (const li of $('countryList').children) li.setAttribute('aria-selected', String(Number(li.dataset.id) === id));
  drawPickMap();
  updatePickInfo();
}
function updatePickInfo() {
  const c = state.byId.get(state.selected);
  const btn = $('joinBtn');
  $('copyInvite').hidden = !(c && c.cells > 0);
  if (!c || c.cells <= 0) {
    $('pickInfo').textContent = 'Pick a country on the map or in the list.';
    btn.textContent = 'Choose a country';
    btn.disabled = true;
    return;
  }
  const b = document.createElement('b'); b.textContent = c.name;
  $('pickInfo').replaceChildren(b, document.createElement('br'),
    `${plural(c.cells, 'cell', 'cells')} · ${c.online ? `${fmt(c.online)} playing now` : 'nobody here yet'}`);
  btn.textContent = `Fight for ${c.name}`;
  btn.disabled = state.joining;
}
function joinError(msg) {
  const el = $('joinError');
  el.textContent = msg || '';
  el.hidden = !msg;
}
$('joinBtn').addEventListener('click', () => { if (state.selected) doPlay(); });
$('copyInvite').addEventListener('click', async () => {
  const c = state.byId.get(state.selected);
  if (!c) return;
  const url = inviteUrl(c.code);
  joinError('');
  $('pickInfo').append(document.createElement('br'), (await copyText(url)) ? `Invite link copied: ${url}` : `Invite link: ${url}`);
});
$('countryBack').addEventListener('click', () => show('login'));

// ---------------- game ----------------
function join(country) {
  if (state.joining) return;
  state.joining = true;
  $('joinBtn').disabled = true;
  $('playBtn').disabled = true;
  socket.timeout(8000).emit('join', { name: profile.name, country, look: profile.look }, (err, res) => {
    state.joining = false;
    $('playBtn').disabled = false;
    updatePickInfo();
    if (err || !res) return failJoin("The server didn't answer. Check your connection and try again.");
    if (res.error) return failJoin(res.error, res.code);
    profile.country = res.country;
    state.selected = res.country;
    saveProfile();
    applyCountries(res.countries);
    show('game');
    state.game = createGame({ socket, init: res, countries: res.countries, onExit: exitGame, inviteUrl });
  });
}
function failJoin(msg, code) {
  if (code === 'name' || state.screen === 'login') { show('login'); loginError(msg); return; }
  show('country');
  joinError(msg);
}
function exitGame(reason) {
  if (state.game) { state.game.stop(); state.game = null; }
  socket.emit('leave');
  show('country');
  refreshWorld();
  if (reason === 'eliminated') joinError('Your country has no land left. Pick a new one.');
}

socket.on('disconnect', () => { if (state.game) $('netBox').hidden = false; });
socket.on('connect', () => {
  $('netBox').hidden = true;
  if (state.game) {
    // The server forgot us when the connection dropped: join the same country again.
    state.game.stop();
    state.game = null;
    join(profile.country || 'auto');
  }
});
socket.on('connect_error', () => {
  if (!state.game) $('onlineText').textContent = "Can't connect to the server. Retrying…";
});

window.addEventListener('resize', () => { if (state.screen !== 'game') drawBackground(); });

show('login');
refreshWorld();
