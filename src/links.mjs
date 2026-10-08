// ShowRoom — links to work that doesn't live on disk (claude.ai, Google Drive, Figma…).
// A link is either its own card or, with `attachTo`, an extra button on a local project's card.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG } from './config.mjs';

export const LINKS_FILE = () => path.join(CONFIG.outDir, 'links.json');
const MAX_LINKS = 500;

const isWebUrl = (url) => {
  try { return ['https:', 'http:'].includes(new URL(url).protocol); } catch { return false; }
};

// Hand-edited files are re-checked too: anything that isn't a well-formed http(s) link with a safe id is dropped
// (ids end up in file names for manual images and thumbnails).
export function readLinks() {
  try {
    const data = JSON.parse(fs.readFileSync(LINKS_FILE(), 'utf8'));
    return Array.isArray(data)
      ? data.filter((l) => l && typeof l.id === 'string' && /^[a-z0-9][a-z0-9-]{0,200}$/.test(l.id) && typeof l.title === 'string' && isWebUrl(l.url))
      : [];
  } catch {
    return [];
  }
}

export function writeLinks(links) {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
  const file = LINKS_FILE();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(links, null, 2));
  fs.renameSync(tmp, file);
}

// Link type from the URL: label for the card and the button.
export function linkKind(url) {
  let u;
  try { u = new URL(url); } catch { return { service: 'web', label: 'Link' }; }
  const host = u.hostname.replace(/^www\./, '');
  const p = u.pathname;
  if (host === 'claude.ai' || host.endsWith('.claude.ai') || host === 'claude.com' || host.endsWith('.claude.com')) {
    if (p.startsWith('/project/')) return { service: 'claude', label: 'Claude project' };
    if (/artifact/.test(p)) return { service: 'claude', label: 'Claude artifact' };
    if (p.startsWith('/chat/') || p.startsWith('/share/')) return { service: 'claude', label: 'Claude chat' };
    return { service: 'claude', label: 'Claude' };
  }
  if (host === 'docs.google.com') {
    if (p.startsWith('/document/')) return { service: 'drive', label: 'Google Docs' };
    if (p.startsWith('/spreadsheets/')) return { service: 'drive', label: 'Google Sheets' };
    if (p.startsWith('/presentation/')) return { service: 'drive', label: 'Google Slides' };
    if (p.startsWith('/forms/')) return { service: 'drive', label: 'Google Forms' };
    return { service: 'drive', label: 'Google Drive' };
  }
  if (host === 'drive.google.com') return { service: 'drive', label: 'Google Drive' };
  if (host === 'figma.com' || host.endsWith('.figma.com')) return { service: 'figma', label: 'Figma' };
  if (host === 'github.com') return { service: 'github', label: 'GitHub' };
  if (host === 'notion.so' || host.endsWith('.notion.site')) return { service: 'notion', label: 'Notion' };
  return { service: 'web', label: host };
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Validates what comes from the browser. Returns { link } or { error }.
export function validateLink(input, { projectIds, existing = null, count = 0 }) {
  const url = str(input.url, 2000);
  let parsed;
  try { parsed = new URL(url); } catch { return { error: 'That URL is not valid' }; }
  // Web links only: no javascript:, file:, data:… (they would end up in an href).
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { error: 'Only http(s) links are allowed' };
  const title = str(input.title, 120);
  if (!title) return { error: 'The name is missing' };
  const attachTo = input.attachTo ? str(input.attachTo, 200) : null;
  if (attachTo && !projectIds.has(attachTo)) return { error: 'That project does not exist' };
  if (!existing && count >= MAX_LINKS) return { error: `At most ${MAX_LINKS} links` };
  const now = new Date().toISOString();
  return {
    link: {
      id: existing?.id || `link-${crypto.randomBytes(4).toString('hex')}`,
      url: parsed.href,
      title,
      description: str(input.description, 500),
      attachTo,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    },
  };
}

// Group name per service (filters and archive).
const SERVICE_GROUP = { claude: 'Claude', drive: 'Google Drive', figma: 'Figma', github: 'GitHub', notion: 'Notion', web: 'Link' };

// Projects on disk + links: standalone links become cards; attached ones become buttons.
export function withLinks(raw, links) {
  const attached = new Map();
  const cards = [];
  for (const l of links) {
    const kind = linkKind(l.url);
    if (l.attachTo) {
      if (!attached.has(l.attachTo)) attached.set(l.attachTo, []);
      attached.get(l.attachTo).push({ id: `link:${l.id}`, linkId: l.id, label: l.title, detail: kind.label, url: l.url });
      continue;
    }
    cards.push({
      id: l.id,
      name: l.title,
      path: null,
      url: l.url,
      kind: 'link',
      kindLabel: SERVICE_GROUP[kind.service],
      subLabel: kind.label, // e.g. "Claude chat", "Google Sheets"
      service: kind.service,
      description: l.description || '', // no description: the type is already on the cover
      descriptionSource: l.description ? 'link' : 'auto',
      image: null,
      lastActivity: l.updatedAt || l.createdAt,
      languages: [],
      files: 0,
      git: null,
      sessions: [],
      sessionCount: 0,
      tags: [],
      pinned: false,
      hidden: false,
      archived: false,
      actions: [{ id: 'open-link', label: 'Open', detail: kind.label, url: l.url }],
    });
  }
  const projects = raw.projects.map((p) => {
    const extra = attached.get(p.id);
    if (!extra) return p;
    // Links go after the primary action: clicking the card still opens the local environment.
    return { ...p, actions: [p.actions[0], ...extra, ...p.actions.slice(1)] };
  });
  const all = [...projects, ...cards].sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  return { ...raw, projects: all };
}
