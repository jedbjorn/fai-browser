// One-time move of settings from the package checkout (the default home before 0.3) to the per-user directories
// (src/paths.js). `npm run setup` runs it when FAI_HOME is not set. It stops a daemon still running from the old
// location (its client token and port would otherwise shadow the new one), moves .env.local and config.json (mode
// 0600 kept) and removes the old daemon's state files. Logs, artifacts and any file that already exists at the new
// location stay where they are; the result names them.
import { copyFileSync, chmodSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from './paths.js';
import { ensureDir, isAlive } from './home.js';

const MOVED = ['.env.local', 'config.json'];
const STATE = ['client-token', 'daemon.json', 'daemon.pid', 'daemon.lock'];

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

async function stopLegacyDaemon(legacy) {
  const info = readJson(join(legacy, 'daemon.json'));
  if (!info || !isAlive(info.pid)) return false;
  let token = null;
  try {
    token = readFileSync(join(legacy, 'client-token'), 'utf8').trim();
  } catch {
    // No token: fall back to a signal.
  }
  try {
    if (!token || !info.port) throw new Error('no token');
    await fetch(`http://127.0.0.1:${info.port}/v1/daemon/shutdown`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  for (let i = 0; i < 50 && isAlive(info.pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  return true;
}

/**
 * Move legacy settings from `legacy` (default: the package root) into `paths` (src/home.js homePaths). Does nothing
 * when `paths` is a custom home (FAI_HOME), when there is nothing to move, or when `paths.home` is `legacy` itself.
 * Never overwrites a file that already exists at the new location. Resolves `{ moved: [names], stopped, left }`.
 */
export async function migrateLegacyHome(paths, { legacy = PACKAGE_ROOT } = {}) {
  const result = { moved: [], stopped: false, left: [] };
  if (paths.custom || paths.home === legacy) return result;
  const found = MOVED.filter(name => existsSync(join(legacy, name)));
  const daemon = STATE.some(name => existsSync(join(legacy, name)));
  if (!found.length && !daemon) return result;
  result.stopped = await stopLegacyDaemon(legacy);
  ensureDir(paths.home);
  for (const name of found) {
    const from = join(legacy, name);
    const to = join(paths.home, name);
    if (existsSync(to)) {
      // Never overwrite newer settings; the old file stays for the user to compare and delete.
      result.left.push(from);
      continue;
    }
    copyFileSync(from, to);
    chmodSync(to, 0o600);
    rmSync(from, { force: true });
    result.moved.push(name);
  }
  for (const name of STATE) rmSync(join(legacy, name), { force: true });
  for (const name of ['logs', 'artifacts']) {
    try {
      if (statSync(join(legacy, name)).isDirectory()) result.left.push(join(legacy, name));
    } catch {
      // Not there.
    }
  }
  return result;
}
