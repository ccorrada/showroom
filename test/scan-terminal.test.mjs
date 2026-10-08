import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupFixture, write, writeSession, writeDesktopSession } from './helpers.mjs';

process.env.SHOWROOM_CLAUDE_OPEN = 'terminal';
const fx = setupFixture();
const ID = '9a7b3c2d-1e4f-4a5b-8c6d-7e8f9a0b1c2d';
const dir = path.join(fx.root, "it's mine");
write(path.join(dir, 'main.go'), 'package main');
writeSession(fx.claude, ID, dir, 'Refactor');
writeDesktopSession(fx.desktop, { localId: 'local_x1', cliId: ID, cwd: dir, title: 'Refactor in app' });

const { scan } = await import('../src/scan.mjs');
const [p] = scan().projects;

test('in terminal mode the main action resumes the CLI session in Terminal, safely quoted', () => {
  assert.equal(p.actions[0].id, 'claude-terminal');
  assert.equal(p.actions[0].label, 'Resume Claude');
  assert.equal(p.actions[0].exec.terminal, `cd '${fx.root}/it'\\''s mine' && claude --resume ${ID}`);
  assert.ok(!p.actions.some((a) => a.url?.startsWith('claude://')));
});
