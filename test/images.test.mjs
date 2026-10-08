import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupFixture, write, makePng } from './helpers.mjs';

const fx = setupFixture();

// Flutter-style project: stock icon under macos/, the real one under ios/.
const flutter = path.join(fx.root, 'flutter_app');
write(path.join(flutter, 'pubspec.yaml'), 'name: flutter_app');
write(path.join(flutter, 'lib', 'main.dart'), 'void main() {}');
write(path.join(flutter, 'macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_1024.png'), makePng(1024, 1024));
write(path.join(flutter, 'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-180.png'), makePng(180, 180));

// README image that is a symlink pointing outside the project: must be ignored.
const outside = write(path.join(fx.base, 'outside.png'), makePng(400, 300));
const linked = path.join(fx.root, 'linked');
write(path.join(linked, 'index.js'), '1');
write(path.join(linked, 'README.md'), '# Linked\n\n![shot](docs/shot.png)\n');
fs.mkdirSync(path.join(linked, 'docs'));
fs.symlinkSync(outside, path.join(linked, 'docs', 'shot.png'));

// A web project with a real screenshot.
const web = path.join(fx.root, 'site');
write(path.join(web, 'package.json'), '{}');
write(path.join(web, 'docs', 'screenshot-home.png'), makePng(400, 225, undefined, { noise: true }));

const { scan } = await import('../src/scan.mjs');
const { generateThumbs, withImages, THUMBS_DIR } = await import('../src/images.mjs');
const { projects } = scan();
const byName = (n) => projects.find((p) => p.name === n);

test('prefers the iOS app icon over the stock macOS one', () => {
  const c = byName('flutter_app').imageCandidate;
  assert.equal(c.fit, 'icon');
  assert.equal(c.source, 'app icon');
  assert.match(c.file, /ios\/Runner/);
});

test('ignores README images that resolve outside the project', () => {
  assert.equal(byName('linked').imageCandidate, null);
});

// Screenshots under 10 KB are ignored on purpose (they are usually icons), so the fixture is noisy.
test('uses screenshots as covers', () => {
  const c = byName('site').imageCandidate;
  assert.equal(c.fit, 'cover');
  assert.equal(c.source, 'screenshot');
});

test('generates thumbnails with sips and exposes them', { skip: process.platform !== 'darwin' && 'needs macOS (sips)' }, async () => {
  await generateThumbs(projects);
  const withImgs = withImages({ projects }).projects;
  const site = withImgs.find((p) => p.name === 'site');
  assert.match(site.image, /^thumbs\/site-[0-9a-f]{8}\.png$/);
  assert.ok(fs.existsSync(path.join(THUMBS_DIR, path.basename(site.image))));
  assert.equal(withImgs.find((p) => p.name === 'linked').image, null);
  assert.ok(!('imageCandidate' in site), 'absolute source paths are not exposed');
});
