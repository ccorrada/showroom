// Test helpers: a throwaway ShowRoom home, project roots and Claude sessions folder.
// Call setupFixture() BEFORE importing anything from src/ (config is read at import time).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { makePng as png } from '../scripts/png.mjs';

export function setupFixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'showroom-test-')));
  const fx = {
    base,
    home: path.join(base, 'home'),
    root: path.join(base, 'projects'),
    claude: path.join(base, 'claude-projects'),
    desktop: path.join(base, 'claude-desktop-sessions'),
  };
  for (const d of [fx.home, fx.root, fx.claude, fx.desktop]) fs.mkdirSync(d, { recursive: true });
  process.env.SHOWROOM_HOME = fx.home;
  process.env.SHOWROOM_ROOTS = fx.root;
  process.env.SHOWROOM_CLAUDE_DIR = fx.claude;
  process.env.SHOWROOM_CLAUDE_DESKTOP_DIR = fx.desktop;
  process.env.SHOWROOM_CLAUDE_OPEN ??= 'app';
  process.on('exit', () => fs.rmSync(base, { recursive: true, force: true }));
  return fx;
}

export function write(file, content = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// A solid-color PNG; with `noise`, random pixels so it stays large after compression (like a real screenshot).
export function makePng(width, height, [r, g, b] = [200, 80, 40], { noise = false } = {}) {
  const rand = () => Math.floor(Math.random() * 256);
  return png(width, height, noise ? () => [rand(), rand(), rand()] : () => [r, g, b]);
}

// A Claude Code session file as the CLI writes it (only the fields ShowRoom reads).
export function writeSession(claudeDir, id, cwd, title) {
  const dir = path.join(claudeDir, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const lines = [
    { type: 'custom-title', customTitle: title, sessionId: id },
    { type: 'user', cwd, sessionId: id, message: { role: 'user', content: 'hi' } },
  ];
  return write(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

// A session as the Claude desktop app stores it (only the fields ShowRoom reads).
export function writeDesktopSession(desktopDir, { localId, cliId, cwd, title, at = Date.now(), archived = false }) {
  const data = { sessionId: localId, cliSessionId: cliId, cwd, originCwd: cwd, title, lastActivityAt: at, isArchived: archived };
  return write(path.join(desktopDir, 'account', 'org', `${localId}.json`), JSON.stringify(data));
}
