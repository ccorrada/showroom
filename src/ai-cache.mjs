// ShowRoom — cache of descriptions written by Claude (~/.showroom/ai-descriptions.json).
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config.mjs';

export const AI_FILE = () => path.join(CONFIG.outDir, 'ai-descriptions.json');

export function readAiCache() {
  try { return JSON.parse(fs.readFileSync(AI_FILE(), 'utf8')); } catch { return {}; }
}

export function writeAiCache(cache) {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
  const file = AI_FILE();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, file);
}
