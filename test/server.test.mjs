import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setupFixture, write } from './helpers.mjs';

const fx = setupFixture();
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;

write(path.join(fx.root, 'my-app', 'index.js'), 'console.log(1)');
write(path.join(fx.root, 'my-app', 'package.json'), '{}');
// A fake `claude` CLI that answers like `claude -p --output-format json`.
const fakeClaude = write(path.join(fx.base, 'fake-claude'),
  '#!/bin/sh\ncat > /dev/null\nprintf \'%s\\n\' \'{"type":"result","is_error":false,"result":"\\"Small Node script that prints a number.\\"","total_cost_usd":0.001}\'\n');
fs.chmodSync(fakeClaude, 0o755);

let server;
let token;

before(async () => {
  server = spawn(process.execPath, ['src/server.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, SHOWROOM_PORT: String(PORT), SHOWROOM_CLAUDE_BIN: fakeClaude },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try {
      const html = await (await fetch(`${BASE}/`)).text();
      token = html.match(/"token":"([0-9a-f]+)"/)?.[1];
      if (token) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => server?.kill());

const post = (p, body, headers = {}) => fetch(`${BASE}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-ShowRoom-Token': token, ...headers },
  body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body),
});

test('serves the page with anti-framing headers', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('rejects foreign Host headers (DNS rebinding)', async () => {
  // fetch() won't let us set Host, so use a raw request.
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/projects', headers: { Host: `evil.example:${PORT}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 421);
});

test('requires the token and a same-origin request for changes', async () => {
  assert.equal((await post('/api/rescan', {}, { 'X-ShowRoom-Token': 'nope' })).status, 403);
  assert.equal((await post('/api/rescan', {}, { Origin: 'http://evil.example' })).status, 403);
});

test('never sends executable commands to the browser', async () => {
  const data = await (await fetch(`${BASE}/api/projects`)).json();
  const app = data.projects.find((p) => p.id === 'my-app');
  assert.ok(app);
  assert.ok(app.actions.every((a) => !('exec' in a)));
  assert.ok(app.actions.some((a) => a.runnable));
});

test('links: rejects javascript: URLs, creates and deletes valid ones', async () => {
  assert.equal((await post('/api/links', { url: 'javascript:alert(1)', title: 'x' })).status, 400);
  const res = await post('/api/links', { url: 'https://claude.ai/chat/123', title: 'Design chat', attachTo: 'my-app' });
  assert.equal(res.status, 200);
  const { id, catalog } = await res.json();
  const app = catalog.projects.find((p) => p.id === 'my-app');
  assert.ok(app.actions.some((a) => a.linkId === id && a.url === 'https://claude.ai/chat/123'));
  assert.equal((await post('/api/links/delete', { id })).status, 200);
});

test('curate: only whitelisted fields, and no actions for link cards', async () => {
  assert.equal((await post('/api/curate', { id: 'my-app', patch: { path: '/etc' } })).status, 400);
  assert.equal((await post('/api/curate', { id: 'my-app', patch: { __proto__: { x: 1 }, pinned: 'yes' } })).status, 400);
  const ok = await post('/api/curate', { id: 'my-app', patch: { pinned: true, tags: ['demo'] } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).project.pinned, true);
  assert.equal((await post('/api/open', { id: '../../etc', action: 0 })).status, 400);
});

test('image upload checks the file signature, not the Content-Type', async () => {
  const res = await post('/api/image?id=my-app', 'definitely not a png', { 'Content-Type': 'image/png' });
  assert.equal(res.status, 415);
});

test('describe writes a description with the Claude CLI and caches it', async () => {
  const res = await post('/api/describe', { id: 'my-app' });
  assert.equal(res.status, 200);
  const { project } = await res.json();
  assert.equal(project.description, 'Small Node script that prints a number.');
  assert.equal(project.descriptionSource, 'ai');
  const cache = JSON.parse(fs.readFileSync(path.join(fx.home, 'ai-descriptions.json'), 'utf8'));
  assert.equal(cache['my-app'].preferred, true);
});
