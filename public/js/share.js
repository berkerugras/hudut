// Builds a 1200x630 picture (world map + your country + a line of stats) and shares it:
// the phone's share sheet when available, otherwise a download plus the link copied.
import { GRID_W, GRID_H } from '/shared/constants.js';

const FONT_D = '"Saira Condensed", "Arial Narrow", sans-serif';
const FONT_B = '"IBM Plex Sans", "Segoe UI", sans-serif';

export function drawShareCard({ painter, countryId, title, subtitle, url }) {
  const c = document.createElement('canvas');
  c.width = 1200;
  c.height = 630;
  const g = c.getContext('2d');
  g.fillStyle = '#0e171c';
  g.fillRect(0, 0, 1200, 630);
  g.imageSmoothingEnabled = false;
  g.drawImage(painter.paint({ mine: countryId }), 0, 0, GRID_W, GRID_H, 0, 0, 1200, 600);
  const fade = g.createLinearGradient(0, 330, 0, 630);
  fade.addColorStop(0, 'rgba(14,23,28,0)');
  fade.addColorStop(1, 'rgba(14,23,28,0.96)');
  g.fillStyle = fade;
  g.fillRect(0, 330, 1200, 300);
  g.fillStyle = '#f0b44c';
  g.font = `700 26px ${FONT_D}`;
  g.fillText('HUDUT', 48, 520);
  g.fillStyle = '#e9f0f2';
  g.font = `700 54px ${FONT_D}`;
  g.fillText(title, 48, 572, 1104);
  g.fillStyle = '#93a6ad';
  g.font = `500 24px ${FONT_B}`;
  g.fillText(`${subtitle}  ·  ${url.replace(/^https?:\/\//, '')}`, 48, 606, 1104);
  return c;
}

// Returns a short message saying what happened.
export async function shareCard(canvas, { text, url }) {
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  const file = blob ? new File([blob], 'hudut.png', { type: 'image/png' }) : null;
  try {
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text: `${text} ${url}` });
      return 'Shared.';
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return '';
  }
  if (blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hudut.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    return 'Picture saved and the invite text copied. Paste it anywhere.';
  } catch {
    return `Picture saved. Your invite link: ${url}`;
  }
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
