// Where the FAI Firefox launcher keeps its files: the dedicated profile, a downloaded official Firefox, the signed
// add-on and its own state. Nothing goes in the user's Firefox directories (~/.mozilla, ~/.config/mozilla, the macOS
// or Windows Firefox profile roots); the only file outside these directories is the native messaging host manifest
// (src/native.js) and, when asked, a desktop shortcut (src/launcher/desktop.js).
//
//   Linux:   $XDG_DATA_HOME/fai-browser (default ~/.local/share/fai-browser)
//   macOS:   ~/Library/Application Support/fai-browser (shared with the settings, as src/paths.js does)
//   Windows: %LOCALAPPDATA%\fai-browser
//   FAI_HOME set: <FAI_HOME>/browser (tests, a second install). Under `node --test` without FAI_HOME: the per-user
//   test directory of src/paths.js, so a test never touches the real one.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP_DIR, faiHome } from '../paths.js';

function userHome(env) {
  return env.HOME || env.USERPROFILE || homedir();
}

/** The launcher's data directory. */
export function launcherDataDir(env = process.env, platform = process.platform) {
  if (env.FAI_HOME || env.NODE_TEST_CONTEXT) return join(faiHome(env, platform), 'browser');
  const home = userHome(env);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DIR, 'browser');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), APP_DIR, 'browser');
  const data = env.XDG_DATA_HOME?.startsWith('/') ? resolve(env.XDG_DATA_HOME) : join(home, '.local', 'share');
  return join(data, APP_DIR);
}

/** Every launcher path: `{ data, profile, firefox, addon, state, welcome }`. */
export function launcherPaths({ env = process.env, platform = process.platform } = {}) {
  const data = launcherDataDir(env, platform);
  return {
    data,
    // The dedicated FAI profile: a normal Firefox profile directory, started with --profile.
    profile: join(data, 'profile'),
    // A private copy of official Firefox, downloaded from Mozilla only when no usable Firefox is installed.
    firefox: join(data, 'firefox'),
    // The signed add-on (.xpi) the profile or the private copy's policy installs.
    addon: join(data, 'addon'),
    state: join(data, 'launcher.json'),
    welcome: join(data, 'welcome.html'),
  };
}
