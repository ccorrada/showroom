import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupFixture, write, writeSession, writeDesktopSession } from './helpers.mjs';

const fx = setupFixture();
const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';

// An iOS app with docs and a Claude session.
const app = path.join(fx.root, 'Water Tracker');
write(path.join(app, 'Water Tracker.xcodeproj', 'project.pbxproj'), '// fake');
write(path.join(app, 'Water Tracker', 'AppDelegate.swift'), 'import UIKit\n');
write(path.join(app, 'README.md'), '# Water Tracker\n\n![badge](https://x/y.svg)\n\n## Overview\n\nA tiny iOS app that reminds you to drink water every hour.\n');
writeSession(fx.claude, SESSION, app, 'Add reminders');
// A session whose file name is not a UUID must be ignored (it would end up in a shell command).
writeSession(fx.claude, 'evil; rm -rf ~', app, 'Injected');

// A web app whose README is a template: falls back to a stack summary.
// It was worked on in the Claude desktop app (desktop record + CLI transcript share the CLI id).
const DESKTOP_CLI = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const ARCHIVED_CLI = '6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b';
const web = path.join(fx.root, 'landing');
writeSession(fx.claude, DESKTOP_CLI, web, 'cli title');
writeDesktopSession(fx.desktop, { localId: 'local_abc-123', cliId: DESKTOP_CLI, cwd: web, title: 'Hero section' });
// An archived desktop session hides its transcript too.
writeSession(fx.claude, ARCHIVED_CLI, web, 'old');
writeDesktopSession(fx.desktop, { localId: 'local_old-1', cliId: ARCHIVED_CLI, cwd: web, title: 'Old', archived: true, at: Date.now() + 1000 });
write(path.join(web, 'package.json'), '{"name":"landing"}');
write(path.join(web, 'src', 'main.jsx'), 'console.log(1)');
write(path.join(web, 'README.md'), '# Getting Started with Create React App\n\nThis project was bootstrapped with Create React App and has lots of words.\n');

// An empty folder (only Finder junk).
write(path.join(fx.root, 'Old Stuff', '.DS_Store'), 'x');

// A project trying to override fields it shouldn't via .showroom.json.
const sneaky = path.join(fx.root, 'sneaky');
write(path.join(sneaky, 'main.py'), 'print(1)');
write(path.join(sneaky, '.showroom.json'), JSON.stringify({ path: '/etc', actions: [], description: 'Custom text', pinned: true }));

const { scan, firstParagraph, clip, applyCuration } = await import('../src/scan.mjs');
const { projects } = scan();
const byName = (n) => projects.find((p) => p.name === n);

test('detects kinds', () => {
  assert.equal(byName('Water Tracker').kind, 'ios');
  assert.equal(byName('landing').kind, 'web');
  assert.equal(byName('Old Stuff').kind, 'empty');
  assert.equal(byName('Old Stuff').archived, true);
  assert.equal(byName('sneaky').kind, 'python');
});

test('takes the description from the Overview section of the README', () => {
  const p = byName('Water Tracker');
  assert.equal(p.description, 'A tiny iOS app that reminds you to drink water every hour.');
  assert.equal(p.descriptionSource, 'README.md');
});

test('skips template READMEs and falls back to a stack summary', () => {
  const p = byName('landing');
  assert.equal(p.descriptionSource, 'auto');
  assert.match(p.description, /^Web · JavaScript · \d+ files$/);
});

test('a terminal session opens in the Claude app via claude://resume, with Terminal as an alternative', () => {
  const p = byName('Water Tracker');
  assert.equal(p.sessionCount, 1); // the non-UUID "evil" file is ignored
  const [openInApp, terminal] = p.actions;
  assert.equal(openInApp.id, 'claude-app');
  assert.equal(openInApp.url, `claude://resume?session=${SESSION}`);
  assert.deepEqual(openInApp.exec, { cmd: 'open', args: [openInApp.url] });
  assert.equal(openInApp.detail, 'Add reminders');
  assert.equal(terminal.exec.terminal, `cd '${app}' && claude --resume ${SESSION}`);
  assert.deepEqual(p.actions.map((a) => a.id), ['claude-app', 'claude-terminal', 'xcode', 'vscode', 'finder']);
});

test('a desktop-app session reopens as itself and takes the app title', () => {
  const p = byName('landing');
  assert.equal(p.sessionCount, 1); // CLI transcript + desktop record count once; archived one is hidden
  assert.equal(p.actions[0].url, 'claude://code/continue?session=local_abc-123');
  assert.equal(p.actions[0].detail, 'Hero section');
});

test('projects without sessions offer a new Claude session in that folder', () => {
  const p = byName('sneaky');
  const fresh = p.actions.find((a) => a.id === 'claude-new');
  assert.equal(fresh.url, `claude://code/new?folder=${encodeURIComponent(sneaky)}`);
  assert.notEqual(p.actions[0].id, 'claude-new'); // the main click still opens the editor
  assert.equal(byName('Old Stuff').actions.find((a) => a.id === 'claude-new'), undefined);
});

test('.showroom.json can only set curated fields', () => {
  const p = byName('sneaky');
  assert.equal(p.path, sneaky);
  assert.equal(p.description, 'Custom text');
  assert.equal(p.pinned, true);
  assert.ok(p.actions.length > 0);
});

test('applyCuration wins over the scan and keeps the automatic description', () => {
  const raw = { projects: [{ id: 'a', description: 'auto text', pinned: false }] };
  const [p] = applyCuration(raw, { a: { description: 'mine', pinned: true } }).projects;
  assert.equal(p.description, 'mine');
  assert.equal(p.descriptionSource, 'manual');
  assert.equal(p.autoDescription, 'auto text');
  assert.equal(raw.projects[0].description, 'auto text'); // not mutated
});

test('firstParagraph skips headings, lists, code and boilerplate', () => {
  const md = '# Title\n\n```js\nconst a = 1;\n```\n\n- a list item that is long enough to count\n\nThe real paragraph with **bold** and a [link](https://x).\n';
  assert.equal(firstParagraph(md), 'The real paragraph with bold and a link.');
  assert.equal(firstParagraph('# T\n\nThis file provides guidance to Claude Code when working here.\n'), null);
});

test('clip cuts at a sentence boundary when it can', () => {
  const first = 'The first sentence is deliberately long so that it goes past the eighty character mark.';
  const text = `${first} The second one goes on and on and on and on and on and on and on and on and on.`;
  assert.equal(clip(text, 120), first);
  assert.equal(clip('short', 120), 'short');
  // Without a sentence boundary late enough, it cuts at a word and adds an ellipsis.
  assert.equal(clip('word '.repeat(40).trim(), 22), 'word word word word…');
});
