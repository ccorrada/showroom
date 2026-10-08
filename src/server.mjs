// ShowRoom — local server. Serves the page and runs the "open" actions.
// Listens on 127.0.0.1 only and requires a token that changes on every start.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { scan, applyCuration, readCuration, writeCuration, CURABLE, CONFIG } from './scan.mjs';
import { renderPage, publicCatalog } from './page.mjs';
import { generateThumbs, withImages, THUMBS_DIR, IMAGES_DIR, THUMB_NAME, MANUAL_NAME } from './images.mjs';
import { describeProject, AuthError, MissingCliError } from './describe.mjs';
import { readLinks, writeLinks, validateLink, withLinks } from './links.mjs';

const PORT = CONFIG.port;
const HOST = '127.0.0.1';
const RESCAN_EVERY_MS = 60 * 60 * 1000;
const MAX_UPLOAD = 8 * 1024 * 1024;
const TOKEN = crypto.randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,200}$/;

let raw = { projects: [] };
let curation = readCuration();
let links = readLinks();
let scanning = null;

function rescan() {
  // scan() is synchronous (~3 s for ~150 projects); defer it so the current response isn't blocked.
  scanning ??= new Promise((resolve) => setImmediate(async () => {
    const t0 = Date.now();
    try {
      raw = scan();
      links = readLinks(); // in case links.json was edited by hand
      await generateThumbs(composed().projects);
      console.log(`[showroom] scanned ${raw.projects.length} projects in ${Date.now() - t0} ms`);
    } catch (err) {
      console.error('[showroom] scan failed:', err);
    }
    scanning = null;
    resolve();
  }));
  return scanning;
}

// Disk + links → curation → images.
const composed = () => applyCuration(withLinks(raw, links), curation);
const catalog = () => withImages(composed());
const findProject = (id) => (typeof id === 'string' && SAFE_ID.test(id) ? catalog().projects.find((p) => p.id === id) : undefined);
const curatedProject = (id) => composed().projects.find((p) => p.id === id);
const publicProject = (id) => publicCatalog({ projects: [findProject(id)] }).projects[0];

function saveCuration(next) {
  writeCuration(next);
  curation = next;
}

// Deletes the previous manual image (if any) when it is replaced or removed.
function dropManualImage(name) {
  if (name && MANUAL_NAME.test(name)) fs.rmSync(path.join(IMAGES_DIR, name), { force: true });
}

// The target must sit inside a configured root (extra defense: actions come from the scan, not the client).
const insideRoots = (p) => typeof p === 'string' && CONFIG.roots.some((r) => p === r || p.startsWith(r + path.sep));

// Terminal opens `.command` files without asking for Automation permission (osascript does ask).
// The script deletes itself and leaves a shell open in the folder when Claude exits.
const RUN_DIR = path.join(CONFIG.outDir, 'run');
function terminalExec(command) {
  fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(RUN_DIR, `${crypto.randomUUID()}.command`);
  fs.writeFileSync(file, `#!/bin/zsh -l\nrm -f -- "$0"\n${command}\nexec zsh -l\n`, { mode: 0o700 });
  return { cmd: 'open', args: ['-a', 'Terminal', file] };
}

function runAction(project, index) {
  const action = project.actions[index];
  if (!action?.exec) return { status: 400, body: { error: 'That action does not run on the server' } };
  if (!insideRoots(project.path)) return { status: 403, body: { error: 'Path is outside the configured roots' } };
  const { cmd, args } = action.exec.terminal ? terminalExec(action.exec.terminal) : action.exec;
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000 }, (err, _out, stderr) => {
      if (err) {
        console.error(`[showroom] ${action.id} ${project.id}:`, stderr || err.message);
        resolve({ status: 500, body: { error: (stderr || err.message).trim().slice(0, 300) } });
      } else {
        console.log(`[showroom] ${action.id} → ${project.name}`);
        resolve({ status: 200, body: { ok: true, label: action.label } });
      }
    });
  });
}

async function curate(id, patch) {
  if (!findProject(id)) return { status: 404, body: { error: 'Unknown project' } };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { status: 400, body: { error: 'Missing change' } };
  const entry = { ...(curation[id] || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (!Object.hasOwn(CURABLE, k)) return { status: 400, body: { error: `Field can't be edited: ${k}` } };
    // null, an empty description or a default value = back to what was detected (keeps curation.json tidy).
    // `archived: false` is kept: it un-archives a project the scanner would archive.
    const isDefault = v === null || (k === 'description' && typeof v === 'string' && v.trim() === '') ||
      ((k === 'pinned' || k === 'hidden') && v === false) || (k === 'tags' && Array.isArray(v) && v.length === 0);
    if (isDefault) { delete entry[k]; continue; }
    if (!CURABLE[k](v)) return { status: 400, body: { error: `Invalid value for ${k}` } };
    entry[k] = k === 'description' ? v.trim() : v;
  }
  const next = { ...curation };
  if (Object.keys(entry).length) next[id] = entry; else delete next[id];
  const removedImage = 'imageFile' in patch ? curation[id]?.imageFile : null;
  saveCuration(next);
  if (removedImage) {
    dropManualImage(removedImage);
    await generateThumbs([curatedProject(id)], { full: false });
  }
  return { status: 200, body: { project: publicProject(id) } };
}

// Description written by Claude on request: wins over the one from docs and replaces a hand-written one.
const describing = new Set();
async function describeWithAi(id) {
  const project = findProject(id);
  if (!project) return { status: 404, body: { error: 'Unknown project' } };
  if (!project.path) return { status: 400, body: { error: 'Links have no files to read: write the description yourself' } };
  if (describing.has(id)) return { status: 409, body: { error: 'Already writing one' } };
  describing.add(id);
  try {
    const { description } = await describeProject(project, { preferred: true });
    const rawProject = raw.projects.find((p) => p.id === id);
    Object.assign(rawProject, { description, descriptionSource: 'ai' });
    if (curation[id]?.description) {
      const { description: _, ...rest } = curation[id];
      const next = { ...curation };
      if (Object.keys(rest).length) next[id] = rest; else delete next[id];
      saveCuration(next);
    }
    return { status: 200, body: { project: publicProject(id) } };
  } catch (err) {
    const status = err instanceof AuthError ? 401 : err instanceof MissingCliError ? 501 : 502;
    return { status, body: { error: err.message } };
  } finally {
    describing.delete(id);
  }
}

// ---------- links ----------

function saveLink(body) {
  const existing = body.id ? links.find((l) => l.id === body.id) : null;
  if (body.id && !existing) return { status: 404, body: { error: 'Unknown link' } };
  const localIds = new Set(raw.projects.map((p) => p.id));
  const { link, error } = validateLink(body, { projectIds: localIds, existing, count: links.length });
  if (error) return { status: 400, body: { error } };
  const next = existing ? links.map((l) => (l.id === link.id ? link : l)) : [...links, link];
  writeLinks(next);
  links = next;
  return { status: 200, body: { id: link.id, catalog: publicCatalog(catalog()) } };
}

async function deleteLink(id) {
  if (!links.some((l) => l.id === id)) return { status: 404, body: { error: 'Unknown link' } };
  const next = links.filter((l) => l.id !== id);
  writeLinks(next);
  links = next;
  if (curation[id]) {
    dropManualImage(curation[id].imageFile);
    const { [id]: _, ...rest } = curation;
    saveCuration(rest);
  }
  await generateThumbs(composed().projects); // removes its thumbnail, if it had one
  return { status: 200, body: { catalog: publicCatalog(catalog()) } };
}

// Image pasted / dropped / picked by the user. Type, size and file signature are checked.
const MAGIC = [
  ['png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['jpg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['webp', (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'],
  ['gif', (b) => b.toString('ascii', 0, 4) === 'GIF8'],
];

async function uploadImage(id, buf) {
  if (!findProject(id)) return { status: 404, body: { error: 'Unknown project' } };
  const ext = MAGIC.find(([, test]) => buf.length > 12 && test(buf))?.[0];
  if (!ext) return { status: 415, body: { error: 'Unsupported format (use PNG, JPG, WebP or GIF)' } };
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const name = `${id}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(IMAGES_DIR, name), buf);
  const previous = curation[id]?.imageFile;
  saveCuration({ ...curation, [id]: { ...(curation[id] || {}), imageFile: name } });
  dropManualImage(previous);
  await generateThumbs([curatedProject(id)], { full: false });
  return { status: 200, body: { project: publicProject(id) } };
}

// ---------- HTTP ----------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // Never framed by another site: a hidden iframe could trick you into clicking "open".
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readBody(req) {
  const data = (await readRaw(req, 10000)).toString('utf8');
  try {
    const body = data ? JSON.parse(data) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new Error('Invalid JSON');
  }
}

const server = http.createServer(async (req, res) => {
  // Fixed Host: blocks DNS rebinding (another site pointing its domain at 127.0.0.1).
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 421, { error: 'Host not allowed' });
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      await scanning;
      return send(res, 200, renderPage(catalog(), TOKEN), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/thumbs/')) {
      const name = url.pathname.slice('/thumbs/'.length);
      if (!THUMB_NAME.test(name)) return send(res, 404, { error: 'Not found' });
      fs.readFile(path.join(THUMBS_DIR, name), (err, buf) => {
        if (err) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, {
          'Content-Type': name.endsWith('.png') ? 'image/png' : 'image/jpeg',
          'Cache-Control': 'public, max-age=31536000, immutable', // the name changes when the image does
          ...SECURITY_HEADERS,
        });
        res.end(buf);
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      await scanning;
      return send(res, 200, publicCatalog(catalog()));
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      // Anything that changes state needs the token (only the page served here has it) and our own Origin.
      const origin = req.headers.origin;
      if (req.headers['x-showroom-token'] !== TOKEN || (origin && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, '')))) {
        return send(res, 403, { error: 'Invalid token: reload the page' });
      }
      if (url.pathname === '/api/image') {
        const buf = await readRaw(req, MAX_UPLOAD);
        await scanning;
        const r = await uploadImage(url.searchParams.get('id'), buf);
        return send(res, r.status, r.body);
      }
      const body = await readBody(req);
      await scanning;

      if (url.pathname === '/api/open') {
        const project = findProject(body.id);
        if (!project || !Number.isInteger(body.action)) return send(res, 400, { error: 'Invalid project or action' });
        const r = await runAction(project, body.action);
        return send(res, r.status, r.body);
      }
      if (url.pathname === '/api/curate') {
        const r = await curate(body.id, body.patch);
        return send(res, r.status, r.body);
      }
      if (url.pathname === '/api/links') {
        const r = saveLink(body);
        return send(res, r.status, r.body);
      }
      if (url.pathname === '/api/links/delete') {
        const r = await deleteLink(body.id);
        return send(res, r.status, r.body);
      }
      if (url.pathname === '/api/describe') {
        const r = await describeWithAi(body.id);
        return send(res, r.status, r.body);
      }
      if (url.pathname === '/api/rescan') {
        await rescan();
        return send(res, 200, publicCatalog(catalog()));
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, 400, { error: err.message });
  }
});

if (!CONFIG.roots.length) {
  console.error(`[showroom] no project folders found; set "roots" in ${CONFIG.configFile} or SHOWROOM_ROOTS`);
}
await rescan();
setInterval(rescan, RESCAN_EVERY_MS).unref();
server.on('error', (err) => {
  // Port in use = another ShowRoom is already running: exit "cleanly" so launchd doesn't retry in a loop.
  if (err.code === 'EADDRINUSE') {
    console.error(`[showroom] port ${PORT} is already in use (another ShowRoom running?)`);
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});
server.listen(PORT, HOST, () => console.log(`[showroom] ${new Date().toISOString()} http://localhost:${PORT}`));
