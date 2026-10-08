// ShowRoom — start automatically at login with launchd (a per-user LaunchAgent).
// Usage: node src/agent.mjs install | uninstall | restart | status
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.mjs';

const LABEL = 'local.showroom';
const HOME = os.homedir();
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(CONFIG.outDir, 'server.log');
const DOMAIN = `gui/${process.getuid()}`;

// Homebrew's process.execPath points into a versioned Cellar folder that `brew upgrade node` deletes;
// prefer a stable symlink to the same binary when there is one.
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const NODE = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find((p) => real(p) === real(process.execPath)) || process.execPath;

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist() {
  // Explicit PATH: launchd doesn't load the shell profile (git, claude, sips, qlmanage).
  const pathVar = [path.join(HOME, '.local', 'bin'), path.dirname(NODE), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    .filter((v, i, a) => a.indexOf(v) === i).join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(NODE)}</string>
    <string>${xml(path.join(PROJECT, 'src', 'server.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(PROJECT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(pathVar)}</string>
    <key>HOME</key><string>${xml(HOME)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart only if it crashes; a clean exit (e.g. port already in use) is left alone. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;
}

const launchctl = (...args) => execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const loaded = () => { try { launchctl('print', `${DOMAIN}/${LABEL}`); return true; } catch { return false; } };
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// `bootout` returns before the job is gone; bootstrapping it again too soon fails with "5: Input/output error".
function unload() {
  try { launchctl('bootout', `${DOMAIN}/${LABEL}`); } catch { return false; }
  for (let i = 0; i < 50 && loaded(); i++) pause(100);
  return true;
}

function load() {
  for (let attempt = 1; ; attempt++) {
    try { return launchctl('bootstrap', DOMAIN, PLIST); } catch (err) {
      if (attempt >= 5) throw err;
      pause(500);
    }
  }
}

function status() {
  try {
    const out = launchctl('print', `${DOMAIN}/${LABEL}`);
    const state = out.match(/^\s*state = (.+)$/m)?.[1] || 'unknown';
    const pid = out.match(/^\s*pid = (\d+)$/m)?.[1];
    return { installed: true, state, pid };
  } catch {
    return { installed: fs.existsSync(PLIST), state: 'not loaded' };
  }
}

const cmd = process.argv[2];
if (cmd === 'install') {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(CONFIG.outDir, { recursive: true });
  unload();
  fs.writeFileSync(PLIST, plist());
  load();
  console.log(`Installed: ${PLIST}`);
  console.log(`ShowRoom will start at login → http://localhost:${CONFIG.port}`);
  console.log(`Log: ${LOG}`);
} else if (cmd === 'uninstall') {
  const was = unload();
  fs.rmSync(PLIST, { force: true });
  console.log(was ? 'Uninstalled: ShowRoom no longer starts at login.' : 'It was not installed.');
} else if (cmd === 'restart') {
  launchctl('kickstart', '-k', `${DOMAIN}/${LABEL}`);
  console.log('Restarted.');
} else if (cmd === 'status') {
  const s = status();
  console.log(s.installed ? `Agent ${LABEL}: ${s.state}${s.pid ? ` (pid ${s.pid})` : ''}` : 'Agent not installed.');
} else {
  console.log('Usage: node src/agent.mjs install | uninstall | restart | status');
  process.exitCode = 1;
}
