// ShowRoom — cover images.
// pickImage chooses the best image for a project; generateThumbs makes thumbnails with built-in macOS tools
// (sips for images, qlmanage for SVG/PDF/Office), cached by (path, mtime, size).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { CONFIG } from './config.mjs';

export const THUMBS_DIR = path.join(CONFIG.outDir, 'thumbs');
export const IMAGES_DIR = path.join(CONFIG.outDir, 'images'); // images the user pasted or uploaded
const INDEX_FILE = path.join(THUMBS_DIR, 'index.json');
const THUMB_VERSION = 2; // bump when the way thumbnails are made (or labeled) changes
const SIZE = { icon: 256, cover: 720, document: 720 };

export const THUMB_NAME = /^[a-z0-9-]+\.(png|jpg)$/;
export const MANUAL_NAME = /^[a-z0-9-]+\.(png|jpg|webp|gif)$/;

const RASTER = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const SKIP_ICON_PATH = /(^|\/)(\w*Tests?|integration_tests|[^/]*\.tmpl|examples?|Pods)\//i;
const SHOT_NAME = /(screen[-_ ]?shot|captura|preview|portada|cover|hero|banner|og[-_]?image|social)/i;
const LOGO_NAME = /^(logo|app[-_]?icon|icon|favicon|apple-touch-icon)[\w.@-]*\.(png|svg|jpe?g|webp)$/i;

// ---------- choosing the image ----------

function pngWidth(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    return buf.toString('ascii', 12, 16) === 'IHDR' ? buf.readUInt32BE(16) : 0;
  } catch {
    return 0;
  }
}

// Inside the project even after resolving symlinks (a link could point anywhere on disk).
function inside(dir, file) {
  try {
    const real = fs.realpathSync(file);
    const base = fs.realpathSync(dir);
    return real === base || real.startsWith(base + path.sep);
  } catch {
    return false;
  }
}

function readmeImage(dir, entries) {
  const name = entries.find((n) => /^readme\.md$/i.test(n));
  if (!name) return null;
  let md;
  try { md = fs.readFileSync(path.join(dir, name), 'utf8').slice(0, 50000); } catch { return null; }
  const re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)|<img[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(md))) {
    const src = decodeURI(m[1] || m[2]);
    if (/^(https?:|data:|\/\/)/i.test(src)) continue; // local images only: never the network
    const file = path.resolve(dir, src.replace(/[?#].*$/, ''));
    if (inside(dir, file) && RASTER.has(path.extname(file).toLowerCase()) && fs.existsSync(file)) return file;
  }
  return null;
}

// Returns { file, fit: 'icon'|'cover'|'document', source } or null.
export function pickImage(dir, entries, stats, override = {}) {
  if (typeof override.image === 'string') {
    const file = path.resolve(dir, override.image);
    if (inside(dir, file) && fs.existsSync(file)) return { file, fit: override.imageFit === 'icon' ? 'icon' : 'cover', source: 'manual' };
  }
  const imgs = stats.images;
  const ext = (i) => path.extname(i.rel).toLowerCase();

  // 1. App icon (iOS/macOS); otherwise the Android launcher icon.
  const icons = imgs
    .filter((i) => ext(i) === '.png' && i.rel.includes('.appiconset/') && !SKIP_ICON_PATH.test(i.rel))
    .map((i) => ({
      ...i,
      width: pngWidth(path.join(dir, i.rel)),
      watch: /watch/i.test(i.rel),
      // In Flutter, macos/ and friends ship the stock icon; the one under ios/ is usually the real one.
      desktop: /(^|\/)(macos|windows|linux|web)\//.test(i.rel),
    }))
    .filter((i) => i.width >= 60)
    .sort((a, b) => a.desktop - b.desktop || a.watch - b.watch || b.width - a.width);
  if (icons[0]) return { file: path.join(dir, icons[0].rel), fit: 'icon', source: 'app icon' };
  const launcher = imgs
    .filter((i) => /mipmap-[a-z]+\/ic_launcher\.png$/.test(i.rel) && !SKIP_ICON_PATH.test(i.rel))
    .sort((a, b) => b.size - a.size)[0];

  // 2. Screenshots, banners, covers (the largest wins).
  const shot = imgs
    .filter((i) => RASTER.has(ext(i)) && SHOT_NAME.test(path.basename(i.rel)) && !/icon/i.test(i.rel) && i.size > 10000)
    .sort((a, b) => b.size - a.size)[0];
  if (shot) return { file: path.join(dir, shot.rel), fit: 'cover', source: 'screenshot' };

  // 3. First local image in the README.
  const fromReadme = readmeImage(dir, entries);
  if (fromReadme) return { file: fromReadme, fit: 'cover', source: 'README' };

  if (launcher) return { file: path.join(dir, launcher.rel), fit: 'icon', source: 'app icon' };

  // 4. Logo or favicon (SVG first: it scales better).
  const logo = imgs
    .filter((i) => LOGO_NAME.test(path.basename(i.rel)) && !SKIP_ICON_PATH.test(i.rel))
    .sort((a, b) => (ext(b) === '.svg') - (ext(a) === '.svg') || b.size - a.size)[0];
  if (logo) return { file: path.join(dir, logo.rel), fit: 'icon', source: 'logo' };

  // 5. First page of the most recent top-level document (PDF, Word, PowerPoint…).
  const doc = [...stats.rootDocs].sort((a, b) => b.mtime - a.mtime)[0];
  if (doc) return { file: path.join(dir, doc.rel), fit: 'document', source: `document: ${doc.rel}` };

  return null;
}

// ---------- thumbnails ----------

let index = null;
function loadIndex() {
  if (!index) {
    try { index = new Map(Object.entries(JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')))); } catch { index = new Map(); }
  }
  return index;
}
function saveIndex() {
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  const tmp = `${INDEX_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(index), null, 2));
  fs.renameSync(tmp, INDEX_FILE);
}

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 20000 }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
});

// A manual image (from curation) wins over the detected one.
function candidateFor(p) {
  if (typeof p.imageFile === 'string' && MANUAL_NAME.test(p.imageFile)) {
    return { file: path.join(IMAGES_DIR, p.imageFile), fit: 'cover', source: 'manual' };
  }
  return p.imageCandidate || null;
}

async function render(src, dst, fit) {
  const format = dst.endsWith('.png') ? 'png' : 'jpeg';
  const size = String(SIZE[fit]);
  let input = src;
  let tmp = null;
  if (!RASTER.has(path.extname(src).toLowerCase())) {
    // SVG, PDF, Office, Keynote…: QuickLook renders a PNG.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'showroom-'));
    await run('qlmanage', ['-t', '-s', size, '-o', tmp, src]);
    input = path.join(tmp, `${path.basename(src)}.png`);
    if (!fs.existsSync(input)) throw new Error('QuickLook produced no thumbnail');
  }
  try {
    const args = ['-s', 'format', format, '-Z', size];
    if (format === 'jpeg') args.push('-s', 'formatOptions', '82');
    await run('sips', [...args, input, '--out', dst]);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function forget(id) {
  const prev = index.get(id);
  if (prev?.name) fs.rmSync(path.join(THUMBS_DIR, prev.name), { force: true });
  index.delete(id);
}

async function ensureThumb(p) {
  const idx = loadIndex();
  const cand = candidateFor(p);
  if (!cand) { forget(p.id); return; }
  let st;
  try { st = fs.statSync(cand.file); } catch { forget(p.id); return; }
  const key = `${THUMB_VERSION}|${cand.file}|${st.mtimeMs}|${st.size}|${cand.fit}`;
  const prev = idx.get(p.id);
  if (prev?.key === key && (!prev.name || fs.existsSync(path.join(THUMBS_DIR, prev.name)))) return;

  const keepAlpha = cand.fit === 'icon' || ['.png', '.gif', '.svg'].includes(path.extname(cand.file).toLowerCase());
  const name = `${p.id}-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)}.${keepAlpha && cand.fit !== 'document' ? 'png' : 'jpg'}`;
  try {
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
    await render(cand.file, path.join(THUMBS_DIR, name), cand.fit);
    if (prev?.name && prev.name !== name) forget(p.id);
    idx.set(p.id, { key, name, fit: cand.fit, source: cand.source });
  } catch (err) {
    console.error(`[showroom] no thumbnail for ${p.id}: ${err.message.trim().split('\n')[0]}`);
    idx.set(p.id, { key, name: null }); // remember the failure so it isn't retried on every scan
  }
}

// Makes whatever is missing. With `full`, also deletes thumbnails of projects that no longer exist.
export async function generateThumbs(projects, { full = true } = {}) {
  if (full) index = null; // re-read from disk: `npm run build` and the server share the folder
  const idx = loadIndex();
  const queue = [...projects];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) await ensureThumb(queue.shift());
  });
  await Promise.all(workers);
  if (full) {
    const ids = new Set(projects.map((p) => p.id));
    for (const id of idx.keys()) if (!ids.has(id)) idx.delete(id);
    const used = new Set([...idx.values()].map((e) => e.name).filter(Boolean));
    fs.mkdirSync(THUMBS_DIR, { recursive: true });
    for (const f of fs.readdirSync(THUMBS_DIR)) {
      if (THUMB_NAME.test(f) && !used.has(f)) fs.rmSync(path.join(THUMBS_DIR, f), { force: true });
    }
  }
  saveIndex();
}

// Adds image/imageFit/imageSource to each project from the thumbnails generated so far.
export function withImages(catalog) {
  const idx = loadIndex();
  return {
    ...catalog,
    projects: catalog.projects.map(({ imageCandidate, ...p }) => {
      const e = idx.get(p.id);
      return e?.name
        ? { ...p, image: `thumbs/${e.name}`, imageFit: e.fit, imageSource: e.source }
        : { ...p, image: null, imageFit: null, imageSource: null };
    }),
  };
}
