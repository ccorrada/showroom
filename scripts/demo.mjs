// ShowRoom — demo with fictional projects, so you can try it (and take screenshots) without your own data.
// Usage: npm run demo            → builds the demo in ./demo and starts a server on http://localhost:4848
//        npm run demo -- --build → only (re)builds the demo folder
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makePng } from './png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = path.join(ROOT, 'demo');
const dirs = { projects: path.join(DEMO, 'projects'), home: path.join(DEMO, 'home'), claude: path.join(DEMO, 'claude') };
const DAY = 86400000;

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// Sets every file's mtime so the project shows the activity date we want.
function age(dir, days) {
  const t = new Date(Date.now() - days * DAY);
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    fs.utimesSync(path.join(e.parentPath, e.name), t, t);
  }
}

// ---------- images ----------

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function appIcon(from, to, glyph) {
  return makePng(256, 256, (x, y) => {
    const base = mix(from, to, (x + y) / 512);
    const dx = x - 128, dy = y - 128;
    const r = Math.hypot(dx, dy);
    if (glyph === 'ring' && r > 52 && r < 78) return [255, 255, 255];
    if (glyph === 'wave' && Math.abs(y - (150 + 18 * Math.sin(x / 20))) < 9) return [255, 255, 255];
    if (glyph === 'leaf' && Math.abs(dx) + Math.abs(dy) < 70 && dx * dy > -400) return mix([255, 255, 255], base, 0.15);
    if (glyph === 'coin' && r < 64) return mix([255, 236, 170], [242, 180, 60], r / 64);
    return base;
  });
}

// A fake "landing page" screenshot: sky, mountains and a header bar.
function landingShot() {
  return makePng(800, 450, (x, y) => {
    if (y < 44) return x > 640 && x < 760 && y > 12 && y < 32 ? [38, 99, 235] : [250, 250, 249];
    const ridge = 260 + 60 * Math.sin(x / 90) + 25 * Math.sin(x / 31);
    if (y > ridge + 70) return mix([34, 87, 60], [21, 52, 37], (y - ridge) / 300);
    if (y > ridge) return mix([71, 105, 120], [46, 76, 92], (y - ridge) / 70);
    if (x > 80 && x < 420 && y > 120 && y < 150) return [255, 255, 255];
    if (x > 80 && x < 300 && y > 170 && y < 184) return [236, 242, 247];
    return mix([253, 186, 116], [125, 172, 230], y / 300);
  });
}

// ---------- fictional projects ----------

const projects = [
  {
    name: 'Tide Tables', days: 0.2,
    files: {
      'Tide Tables.xcodeproj/project.pbxproj': '// demo',
      'Tide Tables/ContentView.swift': 'import SwiftUI\n',
      'README.md': '# Tide Tables\n\n## Overview\n\nA SwiftUI app that shows today\'s tides and sunrise for your favorite beaches, with a home-screen widget.\n',
    },
    icon: ['Tide Tables/Assets.xcassets/AppIcon.appiconset/AppIcon.png', appIcon([56, 189, 248], [29, 78, 216], 'wave')],
    session: ['5d2e1c4a-9b7f-4e21-8c3d-2a6f0e9b1c77', 'Widget timeline refresh'],
  },
  {
    name: 'trailhead-web', days: 1,
    files: {
      'package.json': '{ "name": "trailhead-web", "scripts": { "dev": "vite" } }',
      'src/main.jsx': 'import React from "react";\n',
      'index.html': '<div id="root"></div>',
    },
    image: ['docs/screenshot-home.png', landingShot()],
    session: ['7c1a3e9d-2f4b-4a6c-9e8d-1b2c3d4e5f60', 'Trail map filters'],
  },
  {
    name: 'Habit Garden', days: 3,
    files: {
      'Habit Garden.xcodeproj/project.pbxproj': '// demo',
      'Habit Garden/HabitStore.swift': 'import Foundation\n',
      'README.md': '# Habit Garden\n\nGrow a little garden by keeping your daily habits: each streak waters a plant.\n',
    },
    icon: ['Habit Garden/Assets.xcassets/AppIcon.appiconset/Icon-1024.png', appIcon([134, 239, 172], [22, 101, 52], 'leaf')],
  },
  {
    name: 'recipe-ocr', days: 6,
    files: {
      'requirements.txt': 'pytesseract\npillow\n',
      'ocr.py': 'import pytesseract\n',
      'README.md': '# recipe-ocr\n\nTurns photos of handwritten family recipes into searchable Markdown cards.\n',
    },
  },
  {
    name: 'Pocket Budget', days: 12,
    files: {
      'pubspec.yaml': 'name: pocket_budget\n',
      'lib/main.dart': 'void main() {}\n',
    },
    icon: ['ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-1024x1024@1x.png', appIcon([250, 204, 21], [234, 88, 12], 'coin')],
  },
  {
    name: 'design-tokens', days: 20,
    files: {
      'tokens.json': '{ "color": {} }',
      'build.js': 'console.log("tokens");\n',
      'package.json': '{ "name": "design-tokens" }',
      'README.md': '# design-tokens\n\nColor, type and spacing tokens shared by the iOS app and the website, exported to Swift and CSS.\n',
    },
  },
  {
    name: 'Focus Ring', days: 45,
    files: {
      'Focus Ring.xcodeproj/project.pbxproj': '// demo',
      'Focus Ring/TimerModel.swift': 'import Foundation\n',
    },
    icon: ['Focus Ring/Assets.xcassets/AppIcon.appiconset/AppIcon.png', appIcon([196, 181, 253], [91, 33, 182], 'ring')],
  },
  {
    name: 'SwiftUI Playground 2021', days: 1200,
    files: {
      'Shapes.playground/Contents.swift': 'import SwiftUI\n',
      'Shapes.playground/contents.xcplayground': '<playground/>',
    },
  },
];

function build() {
  fs.rmSync(DEMO, { recursive: true, force: true });
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

  for (const p of projects) {
    const dir = path.join(dirs.projects, p.name);
    for (const [rel, content] of Object.entries(p.files)) write(path.join(dir, rel), content);
    if (p.icon) write(path.join(dir, p.icon[0]), p.icon[1]);
    if (p.image) write(path.join(dir, p.image[0]), p.image[1]);
    age(dir, p.days);
    if (p.session) {
      const [id, title] = p.session;
      const lines = [{ type: 'custom-title', customTitle: title, sessionId: id }, { type: 'user', cwd: dir, sessionId: id }];
      const file = path.join(dirs.claude, dir.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
      write(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const t = new Date(Date.now() - p.days * DAY);
      fs.utimesSync(file, t, t);
    }
  }

  const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
  write(path.join(dirs.home, 'links.json'), JSON.stringify([
    { id: 'link-onboarding', title: 'Onboarding flow', url: 'https://claude.ai/artifact/demo-onboarding', description: 'Interactive prototype of the first-run screens.', attachTo: null, createdAt: ago(2), updatedAt: ago(2) },
    { id: 'link-roadmap', title: 'Q3 roadmap', url: 'https://docs.google.com/document/d/demo-roadmap/edit', description: '', attachTo: null, createdAt: ago(9), updatedAt: ago(9) },
    { id: 'link-tide-chat', title: 'Widget design chat', url: 'https://claude.ai/chat/demo-widget', description: '', attachTo: 'tide-tables', createdAt: ago(1), updatedAt: ago(1) },
  ], null, 2));
  write(path.join(dirs.home, 'curation.json'), JSON.stringify({ 'habit-garden': { pinned: true } }, null, 2));
  write(path.join(dirs.home, 'ai-descriptions.json'), JSON.stringify({
    'trailhead-web': { description: 'React site for a hiking club: trail maps, difficulty filters and weekend meetups.', preferred: false, model: 'demo' },
    'pocket-budget': { description: 'Flutter app that splits each paycheck into envelopes and warns before you overspend.', preferred: false, model: 'demo' },
    'focus-ring': { description: 'Pomodoro timer for iOS with a progress ring and Focus-mode integration.', preferred: false, model: 'demo' },
  }, null, 2));
  write(path.join(dirs.home, 'config.json'), JSON.stringify({ roots: [dirs.projects] }, null, 2));
  console.log(`Demo built in ${DEMO}`);
}

build();
if (!process.argv.includes('--build')) {
  const port = process.env.SHOWROOM_PORT || '4848';
  console.log(`Starting the demo on http://localhost:${port} (Ctrl-C to stop)…`);
  spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, SHOWROOM_HOME: dirs.home, SHOWROOM_CLAUDE_DIR: dirs.claude, SHOWROOM_PORT: port, SHOWROOM_ROOTS: '' },
  });
}
