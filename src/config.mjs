// ShowRoom — shared configuration.
// Precedence: environment variables > ~/.showroom/config.json > defaults.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const home = process.env.SHOWROOM_HOME || path.join(HOME, '.showroom');
const configFile = path.join(home, 'config.json');

// Folders people commonly keep projects in; the ones that exist are used when nothing is configured.
const CANDIDATE_ROOTS = ['Projects', 'projects', 'Developer', 'Code', 'code', 'dev', 'src', 'repos', 'GitHub', 'proyectos'];

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[showroom] ignoring invalid ${configFile}: ${err.message}`);
    return {};
  }
}

const expand = (p) => path.resolve(p.replace(/^~(?=$|\/)/, HOME));
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

const file = readConfigFile();

function resolveRoots() {
  if (process.env.SHOWROOM_ROOTS) return { roots: process.env.SHOWROOM_ROOTS.split(':').filter(Boolean).map(expand), source: 'env' };
  if (Array.isArray(file.roots) && file.roots.length) return { roots: file.roots.map(expand), source: 'config' };
  const found = CANDIDATE_ROOTS.map((n) => path.join(HOME, n)).filter(isDir);
  // On case-insensitive APFS, ~/Projects and ~/projects are the same folder.
  const unique = [...new Map(found.map((p) => [fs.realpathSync(p).toLowerCase(), p])).values()];
  return { roots: unique, source: unique.length ? 'auto' : 'none' };
}

const { roots, source } = resolveRoots();
const requestedOpen = process.env.SHOWROOM_CLAUDE_OPEN || file.claude?.open;

export const CONFIG = {
  home,
  outDir: home,
  configFile,
  roots: roots.filter(isDir),
  missingRoots: roots.filter((r) => !isDir(r)),
  rootsSource: source,
  port: Number(process.env.SHOWROOM_PORT) || Number(file.port) || 4747,
  claudeProjectsDir: process.env.SHOWROOM_CLAUDE_DIR || path.join(HOME, '.claude', 'projects'),
  // Sessions created in the Claude desktop app (each maps a `local_…` id to the CLI session id and folder).
  claudeDesktopSessionsDir: process.env.SHOWROOM_CLAUDE_DESKTOP_DIR ||
    path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'),
  // Where "Claude" actions open: the desktop app (via claude:// links) or a Terminal window running the CLI.
  claudeOpen: ['app', 'terminal'].includes(requestedOpen) ? requestedOpen : (isDir('/Applications/Claude.app') ? 'app' : 'terminal'),
  archiveAfterDays: Number(file.archiveAfterDays) || 365 * 2,
  describe: {
    model: file.describe?.model || 'haiku',
    language: file.describe?.language || 'English',
  },
  maxFilesPerProject: 4000,
  maxDepth: 4,
};
