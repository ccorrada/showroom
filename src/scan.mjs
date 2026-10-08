// ShowRoom — scanner.
// Walks the configured roots, detects each project and builds the raw catalog.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONFIG } from './config.mjs';
import { pickImage } from './images.mjs';
import { readAiCache } from './ai-cache.mjs';

export { CONFIG };

export const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'Pods', 'build', 'Build', 'DerivedData', '.dart_tool',
  '.venv', 'venv', '__pycache__', '.next', 'dist', '.idea', '.gradle', '__MACOSX', '.claude',
  'xcuserdata', '.build', 'storage', '.cache', 'htmlcov', 'coverage',
]);
const JUNK_FILES = new Set(['.DS_Store', 'Thumbs.db', '.localized']);

const CODE_EXT = {
  '.swift': 'Swift', '.m': 'Objective-C', '.dart': 'Dart', '.js': 'JavaScript', '.mjs': 'JavaScript',
  '.jsx': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.vue': 'Vue', '.py': 'Python',
  '.php': 'PHP', '.java': 'Java', '.kt': 'Kotlin', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust',
  '.html': 'HTML', '.css': 'CSS', '.ipynb': 'Jupyter', '.r': 'R', '.R': 'R', '.c': 'C', '.cpp': 'C++',
};
const DOC_EXT = new Set(['.md', '.docx', '.doc', '.pdf', '.tex', '.bib', '.txt', '.pptx', '.xlsx', '.csv']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']);
const COVER_DOC_EXT = new Set(['.pdf', '.docx', '.pptx', '.key', '.pages']);
const MAX_IMAGES = 400;
// Claude Code session ids are UUIDs; anything else is ignored (the id ends up in a shell command or a URL).
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Sessions created in the Claude desktop app have their own `local_…` id (same rule the app uses for its links).
const LOCAL_SESSION_ID = /^local_[A-Za-z0-9-]{1,64}$/;

// ---------- helpers ----------

export const slug = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function git(dir, ...args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

// Bounded walk: counts files per language and finds the real last-modified time (ignoring Finder junk).
function walk(root) {
  // images: cover candidates ({ rel, size, mtime }); rootDocs: documents at the top level.
  const stats = { files: 0, lang: {}, docs: 0, latest: 0, truncated: false, images: [], rootDocs: [] };
  const stack = [[root, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (JUNK_FILES.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || depth >= CONFIG.maxDepth) continue;
        stack.push([full, depth + 1]);
      } else if (e.isFile()) {
        if (++stats.files > CONFIG.maxFilesPerProject) { stats.truncated = true; return stats; }
        const ext = path.extname(e.name);
        if (CODE_EXT[ext]) stats.lang[CODE_EXT[ext]] = (stats.lang[CODE_EXT[ext]] || 0) + 1;
        if (DOC_EXT.has(ext.toLowerCase())) stats.docs++;
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.mtimeMs > stats.latest) stats.latest = st.mtimeMs;
        const lower = ext.toLowerCase();
        if (IMAGE_EXT.has(lower) && stats.images.length < MAX_IMAGES) {
          stats.images.push({ rel: path.relative(root, full), size: st.size, mtime: st.mtimeMs });
        } else if (depth === 0 && COVER_DOC_EXT.has(lower)) {
          stats.rootDocs.push({ rel: e.name, size: st.size, mtime: st.mtimeMs });
        }
      }
    }
  }
  return stats;
}

function findFirst(dir, re, maxDepth = 2) {
  const stack = [[dir, 0]];
  while (stack.length) {
    const [d, depth] = stack.shift();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (re.test(e.name)) return path.join(d, e.name);
      if (e.isDirectory() && depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.endsWith('.xcodeproj')) {
        stack.push([path.join(d, e.name), depth + 1]);
      }
    }
  }
  return null;
}

// ---------- description ----------

const DESC_SOURCES = [
  /^(project_)?(context|contexto)\.md$/i,
  /_(context|contexto)\.md$/i,
  /^readme\.md$/i,
  /^claude\.md$/i,
];

// Paragraphs that don't describe the project (templates, CLAUDE.md meta text, etc.).
const BOILERPLATE = [
  /^this project is a starting point for a flutter application/i,
  /^(this|este) (file|archivo) /i,
  /^a new flutter project/i,
];
// Whole files that are templates (README from `flutter create`, etc.) are skipped entirely.
const BOILERPLATE_FILE = /starting point for a Flutter application|Getting Started with Create React App|bootstrapped with \[?create-next-app/i;
// When a section has one of these headings, its first paragraph wins.
const GOAL_HEADING = /^#{1,3}\s*(goal|purpose|description|overview|about|what is|objetivo|prop[oó]sito|descripci[oó]n|qu[eé] es)\b/im;

export function firstParagraph(md) {
  md = md.replace(/\r/g, '');
  const goal = md.match(GOAL_HEADING);
  if (goal) {
    const found = paragraphs(md.slice(goal.index + goal[0].length));
    if (found) return found;
  }
  return paragraphs(md);
}

function paragraphs(md) {
  const blocks = md.split(/\n\s*\n/);
  let inCode = false;
  for (let b of blocks) {
    const fences = (b.match(/```/g) || []).length;
    if (inCode || b.trimStart().startsWith('```')) { if (fences % 2 === 1) inCode = !inCode; continue; }
    b = b.split('\n').filter((l) => !/^\s*(#|>|\||---|\*\*\*|<|!\[|\[!\[)/.test(l)).join(' ').trim();
    if (!b || /^\s*([-*+]|\d+\.)\s/.test(b)) continue;
    const text = b
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length >= 30 && !BOILERPLATE.some((re) => re.test(text))) return text;
  }
  return null;
}

export function clip(text, max = 220) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (end > 80 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…');
}

function describeFromDocs(dir, entries) {
  for (const re of DESC_SOURCES) {
    const name = entries.find((n) => re.test(n));
    if (!name) continue;
    try {
      const md = fs.readFileSync(path.join(dir, name), 'utf8').slice(0, 20000);
      if (BOILERPLATE_FILE.test(md)) continue;
      const para = firstParagraph(md);
      if (para) return { description: clip(para), descriptionSource: name };
    } catch {}
  }
  return null;
}

// ---------- kind and actions ----------

function detectKind(dir, entries, stats, g) {
  const has = (re) => entries.some((n) => re.test(n));
  const code = Object.values(stats.lang).reduce((a, b) => a + b, 0);
  // Hollow folder: nothing at all, or only notes next to a .git with no commits (lost source).
  if (stats.files === 0 || (code === 0 && g?.broken)) return 'empty';
  if (has(/\.playground$/) || dir.endsWith('.playground')) return 'playground';
  if (has(/^pubspec\.yaml$/)) return 'flutter';
  if (has(/\.(xcodeproj|xcworkspace)$/) || findFirst(dir, /\.xcodeproj$/, 1)) return 'ios';
  if (has(/^(build\.gradle|settings\.gradle)(\.kts)?$/)) return 'android';
  if (has(/^composer\.json$/) || (stats.lang.PHP || 0) > 3) return 'php';
  if (has(/^(package\.json|index\.html|vite\.config\.\w+)$/)) return 'web';
  if (has(/^(pyproject\.toml|requirements\.txt|setup\.py)$/) || (stats.lang.Python || 0) + (stats.lang.Jupyter || 0) > 0) return 'python';
  if (stats.docs > 0 && code <= 2) return 'docs';
  return code > 0 ? 'code' : 'other';
}

export const KIND_LABEL = {
  ios: 'iOS app', playground: 'Swift Playground', flutter: 'Flutter app', android: 'Android app',
  php: 'PHP web', web: 'Web', python: 'Python', docs: 'Documents', code: 'Code', other: 'Folder', empty: 'Empty',
};

function fallbackDescription(kind, stats) {
  if (kind === 'empty') return 'Empty folder: no source code left, only folders and system files.';
  const langs = Object.entries(stats.lang).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l);
  const parts = [KIND_LABEL[kind]];
  if (langs.length) parts.push(langs.join(', '));
  parts.push(`${stats.truncated ? `more than ${CONFIG.maxFilesPerProject}` : stats.files} files`);
  return parts.join(' · ');
}

function gitInfo(dir) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  const last = git(dir, 'log', '-1', '--format=%cI');
  if (!last) return { broken: true };
  let remote = git(dir, 'remote', 'get-url', 'origin');
  if (remote) {
    remote = remote
      .replace(/^git@([^:]+):/, 'https://$1/')
      .replace(/^https:\/\/[^@/]+@/, 'https://') // drop embedded credentials, if any
      .replace(/\.git$/, '');
    if (!/^https?:\/\//.test(remote)) remote = null;
  }
  return { lastCommit: last, branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), remote };
}

export const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

// "Claude" actions. In the desktop app (claude:// links):
//   a session created in the app       → claude://code/continue?session=local_…
//   a session started in a terminal    → claude://resume?session=<uuid> (the app imports it)
//   no session yet                     → claude://code/new?folder=<dir> (offered as a secondary action)
// In Terminal: `claude --resume <uuid>` in the session's folder.
function claudeActions(p, dir) {
  const latest = p.sessions[0];
  const terminal = latest?.id && (() => {
    const command = `cd ${sh(latest.cwd)} && claude --resume ${latest.id}`;
    return { id: 'claude-terminal', label: CONFIG.claudeOpen === 'app' ? 'Claude in Terminal' : 'Resume Claude', detail: latest.title, command, exec: { terminal: command } };
  })();
  const openUrl = (url) => ({ url, command: `open '${url}'`, exec: { cmd: 'open', args: [url] } });

  if (CONFIG.claudeOpen === 'terminal') return { primary: terminal ? [terminal] : [], secondary: [] };
  if (!latest) {
    if (p.kind === 'empty') return { primary: [], secondary: [] };
    const url = `claude://code/new?folder=${encodeURIComponent(dir)}`;
    return { primary: [], secondary: [{ id: 'claude-new', label: 'New in Claude', detail: 'New Claude Code session in this folder', ...openUrl(url) }] };
  }
  const url = latest.localId
    ? `claude://code/continue?session=${latest.localId}`
    : `claude://resume?session=${latest.id}`;
  const app = { id: 'claude-app', label: 'Open in Claude', detail: latest.title, ...openUrl(url) };
  return { primary: [app], secondary: terminal ? [terminal] : [] };
}

// Each action has `command` (copied to the clipboard in the static page) and `exec` (what the server runs, no shell).
// `exec.terminal` is a command the server opens in a new Terminal window.
function buildActions(p, dir, entries) {
  const claude = claudeActions(p, dir);
  const actions = [...claude.primary];
  if (p.kind === 'ios' || p.kind === 'playground') {
    const target = path.join(dir,
      entries.find((n) => n.endsWith('.xcworkspace')) ||
      entries.find((n) => n.endsWith('.xcodeproj') || n.endsWith('.playground')) ||
      (p.kind === 'playground' ? '' : path.relative(dir, findFirst(dir, /\.xcodeproj$/, 1) || dir)));
    actions.push({ id: 'xcode', label: 'Open in Xcode', command: `open -a Xcode ${sh(target)}`, exec: { cmd: 'open', args: ['-a', 'Xcode', target] } });
  }
  if (p.kind === 'flutter' || p.kind === 'android') {
    actions.push({
      id: 'android-studio', label: 'Android Studio',
      command: `open -a 'Android Studio' ${sh(dir)}`, exec: { cmd: 'open', args: ['-a', 'Android Studio', dir] },
    });
  }
  if (p.kind !== 'empty') {
    actions.push({
      id: 'vscode', label: 'VS Code', url: `vscode://file${encodeURI(dir)}`,
      command: `code ${sh(dir)}`, exec: { cmd: 'open', args: ['-a', 'Visual Studio Code', dir] },
    });
  }
  if (p.git?.remote) actions.push({ id: 'repo', label: 'Repository', url: p.git.remote });
  actions.push({ id: 'finder', label: 'Finder', command: `open ${sh(dir)}`, exec: { cmd: 'open', args: [dir] } });
  // Secondary Claude actions go right after the main one.
  actions.splice(1, 0, ...claude.secondary);
  return actions;
}

// ---------- Claude Code sessions ----------

// Sessions from the Claude desktop app: `…/claude-code-sessions/<account>/<org>/local_<id>.json`.
export function readDesktopSessions() {
  const out = [];
  const stack = [[CONFIG.claudeDesktopSessionsDir, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) { stack.push([full, depth + 1]); continue; }
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(full, 'utf8')); } catch { continue; }
      if (!d || !LOCAL_SESSION_ID.test(d.sessionId)) continue;
      const cwd = typeof d.originCwd === 'string' ? d.originCwd : d.cwd;
      if (typeof cwd !== 'string') continue;
      out.push({
        localId: d.sessionId,
        id: SESSION_ID.test(d.cliSessionId) ? d.cliSessionId : null,
        cwd,
        title: typeof d.title === 'string' && d.title ? d.title : 'Untitled session',
        at: new Date(Number(d.lastActivityAt) || Number(d.createdAt) || 0).toISOString(),
        archived: d.isArchived === true,
      });
    }
  }
  return out;
}

// CLI sessions (~/.claude/projects) merged with desktop-app sessions, newest first.
// A desktop session also writes a CLI transcript; they are matched by the CLI session id.
export function readSessions() {
  const cli = readCliSessions();
  const desktop = readDesktopSessions();
  const archived = new Set(desktop.filter((d) => d.archived && d.id).map((d) => d.id));
  const byCliId = new Map(desktop.filter((d) => !d.archived && d.id).map((d) => [d.id, d]));
  const merged = cli
    .filter((s) => !archived.has(s.id))
    .map((s) => {
      const d = byCliId.get(s.id);
      if (!d) return s;
      byCliId.delete(s.id);
      return { ...s, localId: d.localId, title: d.title, at: d.at > s.at ? d.at : s.at };
    });
  const desktopOnly = desktop.filter((d) => !d.archived && (!d.id || byCliId.has(d.id)));
  return [...merged, ...desktopOnly.map(({ archived: _, ...d }) => d)].sort((a, b) => b.at.localeCompare(a.at));
}

function readCliSessions() {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(CONFIG.claudeProjectsDir); } catch { return out; }
  for (const d of dirs) {
    const full = path.join(CONFIG.claudeProjectsDir, d);
    let files;
    try { files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const id = path.basename(f, '.jsonl');
      if (!SESSION_ID.test(id)) continue;
      const file = path.join(full, f);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const cwd = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1];
      if (!cwd) continue;
      const lastOf = (re) => { let m, v = null; while ((m = re.exec(text))) v = m[1]; return v; };
      const title = lastOf(/"customTitle":"((?:[^"\\]|\\.)*)"/g) || lastOf(/"aiTitle":"((?:[^"\\]|\\.)*)"/g);
      try {
        out.push({
          id,
          cwd: JSON.parse(`"${cwd}"`),
          title: title ? JSON.parse(`"${title}"`) : 'Untitled session',
          at: new Date(fs.statSync(file).mtimeMs).toISOString(),
        });
      } catch {}
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

// ---------- main ----------

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Raw scan: what the disk and `.showroom.json` files say. Curation is applied separately.
export function scan() {
  const sessions = readSessions();
  const aiCache = readAiCache();
  const now = Date.now();
  const projects = [];

  for (const root of CONFIG.roots) {
    let rootEntries;
    try {
      rootEntries = fs.readdirSync(root, { withFileTypes: true });
    } catch (err) {
      console.error(`[showroom] can't read ${root}: ${err.message}`);
      continue;
    }
    for (const e of rootEntries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(root, e.name);
      let entries;
      try { entries = fs.readdirSync(dir); } catch { continue; }
      const override = readJson(path.join(dir, '.showroom.json'), {});
      const stats = walk(dir);
      const g = gitInfo(dir);
      const kind = detectKind(dir, entries, stats, g);
      const own = sessions.filter((s) => s.cwd === dir || s.cwd.startsWith(dir + path.sep));

      const times = [stats.latest, g?.lastCommit && Date.parse(g.lastCommit), own[0] && Date.parse(own[0].at)].filter(Boolean);
      const lastActivity = times.length ? new Date(Math.max(...times)).toISOString() : null;
      // Description: AI on request → project docs → AI in bulk → stack summary.
      const ai = kind !== 'empty' && aiCache[slug(e.name)];
      const fromAi = ai && { description: ai.description, descriptionSource: 'ai' };
      const desc = (ai?.preferred && fromAi) || (kind !== 'empty' && describeFromDocs(dir, entries)) || fromAi ||
        { description: fallbackDescription(kind, stats), descriptionSource: 'auto' };
      const age = lastActivity ? (now - Date.parse(lastActivity)) / 86400000 : Infinity;

      const p = {
        id: slug(e.name) || slug(dir),
        name: e.name,
        path: dir,
        kind,
        kindLabel: KIND_LABEL[kind],
        ...desc,
        image: null,
        lastActivity,
        languages: Object.entries(stats.lang).sort((a, b) => b[1] - a[1]).map(([l]) => l),
        files: stats.files,
        git: g,
        sessions: own.slice(0, 5).map(({ id, localId, title, at, cwd }) => ({ id, localId, title, at, cwd })),
        sessionCount: own.length,
        tags: [],
        pinned: false,
        hidden: false,
        archived: kind === 'empty' || age > CONFIG.archiveAfterDays,
      };
      for (const k of ['description', 'tags', 'pinned', 'hidden', 'archived']) if (k in override) p[k] = override[k];
      if (override.description) p.descriptionSource = '.showroom.json';
      p.actions = buildActions(p, dir, entries);
      p.imageCandidate = kind === 'empty' ? null : pickImage(dir, entries, stats, override);
      projects.push(p);
    }
  }

  // Unique ids even if two folders produce the same slug.
  const seen = new Map();
  for (const p of projects) {
    const n = seen.get(p.id) || 0;
    seen.set(p.id, n + 1);
    if (n) p.id = `${p.id}-${n + 1}`;
  }

  projects.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  return { generatedAt: new Date().toISOString(), roots: CONFIG.roots, projects };
}

// ---------- curation ----------

export const CURATION_FILE = () => path.join(CONFIG.outDir, 'curation.json');
export const CURABLE = {
  pinned: (v) => typeof v === 'boolean',
  hidden: (v) => typeof v === 'boolean',
  archived: (v) => typeof v === 'boolean',
  description: (v) => typeof v === 'string' && v.length <= 500,
  tags: (v) => Array.isArray(v) && v.length <= 20 && v.every((t) => typeof t === 'string' && t.length <= 40),
  imageFile: () => false, // can only be removed (null); it is set by uploading through /api/image
};

export function readCuration() {
  return readJson(CURATION_FILE(), {});
}

export function writeCuration(curation) {
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
  const file = CURATION_FILE();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(curation, null, 2));
  fs.renameSync(tmp, file);
}

// The user's choices always win over what was detected. Doesn't mutate the raw catalog.
export function applyCuration(raw, curation) {
  return {
    ...raw,
    projects: raw.projects.map((p) => {
      const c = curation[p.id];
      if (!c) return p;
      const merged = { ...p, ...c };
      if (c.description) Object.assign(merged, { descriptionSource: 'manual', autoDescription: p.description });
      return merged;
    }),
  };
}
