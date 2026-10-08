// Records the README GIF from the running demo: headless Chrome (driven over the DevTools protocol) captures frames,
// ffmpeg turns them into docs/demo-<scheme>.gif. Needs Google Chrome and ffmpeg (`brew install ffmpeg`).
// Usage: npm run demo   (in another terminal), then   node scripts/record-demo.mjs [light|dark]
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEME = process.argv[2] === 'dark' ? 'dark' : 'light';
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'showroom-rec-'));
const W = 1200, H = 760, PORT = 9333;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
fs.mkdirSync(path.join(OUT, 'f'));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/profile`,
  `--window-size=${W},${H}`, '--hide-scrollbars', '--force-color-profile=srgb', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
for (let i = 0; i < 50 && !targets; i++) {
  await sleep(200);
  try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch {}
}
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pending = new Map(); const waiters = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) waiters.filter((w) => w.method === m.method).forEach((w) => { w.resolve(m.params); waiters.splice(waiters.indexOf(w), 1); });
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const once = (method) => new Promise((resolve) => waiters.push({ method, resolve }));
const js = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: SCHEME }] });
const loaded = once('Page.loadEventFired');
await send('Page.navigate', { url: 'http://localhost:4848/' });
await loaded;
await sleep(1500);

// Fake cursor + stubbed "open" (the GIF shows the UI; nothing really launches while recording).
await js(`(() => {
  const c = document.createElement('div');
  c.id = '__cursor';
  c.innerHTML = '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 22 L7.5 17 L11 25.5 L14.5 24 L11 15.8 L18.5 15.8 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 99999, pointerEvents: 'none',
    transform: 'translate(${W + 30}px, ${H * 0.55}px)', transition: 'transform 0.7s cubic-bezier(.45,.05,.3,1)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.35))' });
  document.body.append(c);
  const real = window.fetch;
  window.fetch = (u, o) => String(u).includes('/api/open')
    ? new Promise((r) => setTimeout(() => r(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })), 700))
    : real(u, o);
})()`);

const times = [];
let frame = 0, last = Date.now();
async function shot() {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const now = Date.now();
  if (frame) times.push(now - last);
  last = now;
  fs.writeFileSync(path.join(OUT, 'f', `${String(frame++).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
}
async function hold(ms) { const end = Date.now() + ms; do { await shot(); } while (Date.now() < end); }
let cx = W + 30, cy = H * 0.55;
async function move(x, y, ms = 700) {
  await js(`(() => { const c = document.getElementById('__cursor'); c.style.transitionDuration = '${ms}ms'; c.style.transform = 'translate(${x}px, ${y}px)'; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  cx = x; cy = y;
  await hold(ms + 80);
}
async function click() {
  await js(`document.getElementById('__cursor').animate([{scale:1},{scale:.82},{scale:1}],{duration:220})`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
}
const center = (sel) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
async function type(text) { for (const ch of text) { await send('Input.insertText', { text: ch }); await hold(110); } }

// --- Scene ---
await hold(1400);                                         // the overview
let [x, y] = await center('#q');
await move(x - 60, y + 4, 900);
await click(); await hold(200);
await type('swift');
await hold(1300);                                         // filtered to the Swift projects
[x, y] = await center('.grid .card .open .cover');
await move(x + 20, y + 10, 800);
await hold(500);                                          // hover
await click();
await hold(2600);                                         // toast: Open in Claude · … ✓
// Clear the search and filter by a chip instead.
await js(`(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await hold(600);
const chip = await js(`(() => { const b = [...document.querySelectorAll('#chips .chip')].find((b) => /web/i.test(b.textContent)) || document.querySelectorAll('#chips .chip')[2]; const r = b.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
await move(chip[0], chip[1], 800);
await click();
await hold(1500);
const all = await js(`(() => { const b = document.querySelector('#chips .chip'); const r = b.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
await move(all[0], all[1], 700);
await click();
await hold(700);
await move(W + 30, H * 0.6, 900);
await hold(900);
times.push(80);

fs.writeFileSync(path.join(OUT, 'list.txt'), times.map((t, i) => `file 'f/${String(i).padStart(4, '0')}.png'\nduration ${(t / 1000).toFixed(3)}`).join('\n') + `\nfile 'f/${String(times.length - 1).padStart(4, '0')}.png'\n`);
ws.close(); chrome.kill('SIGKILL');

const gif = path.join(ROOT, 'docs', `demo-${SCHEME}.gif`);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-i', path.join(OUT, 'list.txt'), '-vf',
  'fps=15,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
  '-loop', '0', gif], { cwd: OUT });
fs.rmSync(OUT, { recursive: true, force: true });
console.log(`${frame} frames, ${(times.reduce((a, b) => a + b, 0) / 1000).toFixed(1)} s → ${path.relative(ROOT, gif)}`);
process.exit(0);
