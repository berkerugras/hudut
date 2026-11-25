// Points earned on this device, across games. Unlocks cosmetics (see UNLOCKS in shared/constants.js).
import { UNLOCKS } from '/shared/constants.js';

const KEY = 'hudut.career';
const NAMES = { shirt: { 8: 'Gold uniform' }, hat: { 4: 'Beret', 5: 'Top hat', 6: 'Crown' } };

function load() {
  try { return Object.assign({ score: 0 }, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { return { score: 0 }; }
}
let career = load();
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(career)); } catch { /* ignore */ } }, 500);
}

export const careerScore = () => career.score;

export function unlockNeeded(key, index) {
  const need = UNLOCKS[key] && UNLOCKS[key][index];
  return need && career.score < need ? need : 0;
}

// Adds points; returns the names of cosmetics this just unlocked.
export function addCareerScore(points) {
  if (!(points > 0)) return [];
  const before = career.score;
  career.score += points;
  save();
  const unlocked = [];
  for (const [key, items] of Object.entries(UNLOCKS)) {
    for (const [index, need] of Object.entries(items)) {
      if (before < need && career.score >= need) unlocked.push(NAMES[key][index] || 'New item');
    }
  }
  return unlocked;
}
