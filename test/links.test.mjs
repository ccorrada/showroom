import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setupFixture, write } from './helpers.mjs';

const fx = setupFixture();
const { linkKind, validateLink, readLinks, withLinks } = await import('../src/links.mjs');

test('linkKind recognizes services from the URL', () => {
  assert.deepEqual(linkKind('https://claude.ai/chat/abc'), { service: 'claude', label: 'Claude chat' });
  assert.deepEqual(linkKind('https://claude.ai/project/abc'), { service: 'claude', label: 'Claude project' });
  assert.deepEqual(linkKind('https://claude.ai/artifact/abc'), { service: 'claude', label: 'Claude artifact' });
  assert.equal(linkKind('https://docs.google.com/spreadsheets/d/x/edit').label, 'Google Sheets');
  assert.equal(linkKind('https://drive.google.com/drive/folders/x').service, 'drive');
  assert.equal(linkKind('https://www.figma.com/file/x').service, 'figma');
  assert.equal(linkKind('https://example.com/a').label, 'example.com');
});

test('validateLink only accepts http(s) URLs', () => {
  const opts = { projectIds: new Set() };
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'not a url']) {
    assert.ok(validateLink({ url, title: 'x' }, opts).error, url);
  }
  assert.ok(validateLink({ url: 'https://claude.ai/chat/1', title: 'ok' }, opts).link);
});

test('validateLink checks the name and the attached project', () => {
  const opts = { projectIds: new Set(['my-app']) };
  assert.match(validateLink({ url: 'https://a.com', title: '  ' }, opts).error, /name/);
  assert.match(validateLink({ url: 'https://a.com', title: 'x', attachTo: 'nope' }, opts).error, /does not exist/);
  const { link } = validateLink({ url: 'https://a.com', title: ' Spec ', attachTo: 'my-app' }, opts);
  assert.equal(link.title, 'Spec');
  assert.equal(link.attachTo, 'my-app');
  assert.match(link.id, /^link-[0-9a-f]{8}$/);
});

test('readLinks drops hand-edited entries that are unsafe', () => {
  write(path.join(fx.home, 'links.json'), JSON.stringify([
    { id: 'link-ok', title: 'Good', url: 'https://example.com' },
    { id: 'link-js', title: 'Bad', url: 'javascript:alert(1)' },
    { id: '../escape', title: 'Bad id', url: 'https://example.com' },
    { title: 'No id', url: 'https://example.com' },
  ]));
  assert.deepEqual(readLinks().map((l) => l.id), ['link-ok']);
});

test('withLinks turns standalone links into cards and attached ones into buttons', () => {
  const raw = { projects: [{ id: 'my-app', name: 'My App', actions: [{ id: 'xcode', label: 'Open in Xcode' }, { id: 'finder', label: 'Finder' }] }] };
  const links = [
    { id: 'link-a', title: 'Design chat', url: 'https://claude.ai/chat/1', attachTo: 'my-app' },
    { id: 'link-b', title: 'Roadmap', url: 'https://docs.google.com/document/d/1', createdAt: '2026-01-01T00:00:00Z' },
  ];
  const { projects } = withLinks(raw, links);
  const app = projects.find((p) => p.id === 'my-app');
  assert.deepEqual(app.actions.map((a) => a.label), ['Open in Xcode', 'Design chat', 'Finder']);
  const card = projects.find((p) => p.id === 'link-b');
  assert.equal(card.kind, 'link');
  assert.equal(card.kindLabel, 'Google Drive');
  assert.equal(card.subLabel, 'Google Docs');
});
