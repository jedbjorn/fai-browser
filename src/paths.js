// Filesystem locations shared by the CLI, the daemon and the setup scripts. Nothing resolves against the current
// directory, so the CLI works when invoked from another project, and nothing is written into the package checkout.
//
// Without FAI_HOME, state lives in the per-user directories of the platform:
//   Linux and other Unix: settings in $XDG_CONFIG_HOME/fai-browser (default ~/.config/fai-browser): .env.local,
//                         config.json; runtime state, logs and artifacts in $XDG_STATE_HOME/fai-browser (default
//                         ~/.local/state/fai-browser).
//   macOS:                both in ~/Library/Application Support/fai-browser.
//   Windows:              settings in %APPDATA%\fai-browser, state in %LOCALAPPDATA%\fai-browser.
// FAI_HOME puts everything in that one directory instead (tests, benchmarks, a second install). Under `node --test`
// with no FAI_HOME, a per-user temporary directory stands in, so a test can never touch the real settings.
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const PACKAGE_ROOT = resolve(import.meta.dirname, '..');
export const APP_DIR = 'fai-browser';

function userHome(env) {
  return env.HOME || env.USERPROFILE || homedir();
}

/**
 * The platform's default directories: `{ config, state }` (equal on macOS). `platform` and `env` are parameters so
 * tests can check every platform.
 */
export function defaultDirs(env = process.env, platform = process.platform) {
  const home = userHome(env);
  if (platform === 'darwin') {
    const dir = join(home, 'Library', 'Application Support', APP_DIR);
    return { config: dir, state: dir };
  }
  if (platform === 'win32') {
    const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return { config: join(roaming, APP_DIR), state: join(local, APP_DIR) };
  }
  const config = env.XDG_CONFIG_HOME ? resolve(env.XDG_CONFIG_HOME) : join(home, '.config');
  const state = env.XDG_STATE_HOME ? resolve(env.XDG_STATE_HOME) : join(home, '.local', 'state');
  return { config: join(config, APP_DIR), state: join(state, APP_DIR) };
}

function testHome() {
  const user = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return join(tmpdir(), `fai-browser-test-home-${user}`);
}

/** Base directory for .env.local and config.json: FAI_HOME, else the platform's settings directory. */
export function faiHome(env = process.env, platform = process.platform) {
  if (env.FAI_HOME) return resolve(env.FAI_HOME);
  if (env.NODE_TEST_CONTEXT) return testHome();
  return defaultDirs(env, platform).config;
}

/**
 * Where runtime state, logs and artifacts go for a home directory: the platform's state directory when `home` is the
 * default settings directory, else `home` itself (FAI_HOME keeps everything in one place).
 */
export function dataDir(home, env = process.env, platform = process.platform) {
  const root = resolve(home);
  const defaults = defaultDirs(env, platform);
  return root === resolve(defaults.config) ? defaults.state : root;
}

/** True when `home` is a custom directory (FAI_HOME or an explicit one), not the platform default. */
export function customHome(home, env = process.env, platform = process.platform) {
  return resolve(home) !== resolve(defaultDirs(env, platform).config);
}

/** The local settings file written by `npm run setup` and loaded by the CLI. */
export function envFilePath(env = process.env) {
  return resolve(faiHome(env), '.env.local');
}
