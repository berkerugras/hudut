// Puts every border back to the real-world map. Run with the server stopped: npm run reset-map
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './mapdata.js';

const file = path.join(DATA_DIR, 'territory.bin');
if (fs.existsSync(file)) {
  fs.unlinkSync(file);
  console.log('Sınırlar sıfırlandı. Sunucuyu yeniden başlatınca gerçek dünya haritasıyla açılır.');
} else {
  console.log('Kayıtlı sınır yok; harita zaten başlangıç halinde.');
}
