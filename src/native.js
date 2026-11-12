// Native messaging pairing: host manifests for every detected browser, the launcher they point at, and removal.
//
// The extension asks the native host (src/native-host.js) for the FAI service's address and pairing secret, and the
// host starts the service when it is not running, so nobody copies a secret by hand. A browser launches the host
// only for an extension its manifest names: Chromium-family browsers (Chrome, Chromium, Brave, Edge, Vivaldi) by
// `allowed_origins` (the pinned extension ID), Firefox by `allowed_extensions` (GECKO_IDS: the signed ID and the old
// dev ID). The host checks the caller
// again from its arguments.
//
// Where the manifests go (user level, no admin rights):
//   Linux:   ~/.config/google-chrome/NativeMessagingHosts/, ~/.config/chromium/..., ~/.config/BraveSoftware/
//            Brave-Browser/..., ~/.config/microsoft-edge/..., ~/.config/vivaldi/..., ~/.mozilla/native-messaging-hosts/
//   macOS:   ~/Library/Application Support/<Google/Chrome|Chromium|BraveSoftware/Brave-Browser|Microsoft Edge|
//            Vivaldi>/NativeMessagingHosts/, ~/Library/Application Support/Mozilla/NativeMessagingHosts/
//            (Firefox on Linux is detected by ~/.mozilla or, since Firefox 147, $XDG_CONFIG_HOME/mozilla/firefox; its
//            manifest goes to ~/.mozilla/native-messaging-hosts/ either way. Snap and Flatpak Firefox are not covered.)
//   Windows: the manifest file in the settings directory, registered under HKCU\Software\<Google\Chrome|Chromium|
//            BraveSoftware\Brave-Browser|Microsoft\Edge|Vivaldi|Mozilla>\NativeMessagingHosts\fai_browser
//            (default value: the manifest path), written with `reg add`.
// A browser counts as detected when its profile directory exists; `all` writes every one.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PACKAGE_ROOT, faiHome } from './paths.js';
import { PINNED_EXTENSION_ID } from './bridge.js';

export const NATIVE_HOST_NAME = 'fai_browser';
/**
 * The Firefox add-on ID the Firefox build declares (browser_specific_settings.gecko.id): the ID the add-on is signed
 * under on addons.mozilla.org (unlisted), so it never changes once a signed version exists.
 */
export const GECKO_ID = 'fai-browser@jedbjorn.github.io';
/** The add-on ID of builds before 0.3.0 and of `build-firefox --gecko-id fai-browser@local` dev builds; still paired. */
export const GECKO_DEV_ID = 'fai-browser@local';
/** Every add-on ID the native host answers (the manifest's allowed_extensions). */
export const GECKO_IDS = Object.freeze([GECKO_ID, GECKO_DEV_ID]);
export const NATIVE_HOST_ENTRY = join(PACKAGE_ROOT, 'src', 'native-host.js');
const DESCRIPTION = 'FAI Browser: pairs the extension with the local FAI service';
const MARKER = 'FAI Browser native messaging host launcher';

/**
 * The browsers FAI Browser knows, per platform: `{ id, name, kind, profile, profiles?, dir?, registry? }`. `profile`
 * (or any of `profiles`) is a directory whose existence means the browser is installed for this user; `dir` is where its manifest goes (POSIX);
 * `registry` the HKCU key (Windows).
 */
export function browserTargets({ platform = process.platform, home, env = process.env } = {}) {
  const list = [];
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
    const config = join(home, '.config');
    const xdgConfig = env.XDG_CONFIG_HOME?.startsWith('/') ? env.XDG_CONFIG_HOME : config;
    const chromium = (id, name, sub) => list.push({ id, name, kind: 'chromium', profile: join(config, sub),
      dir: join(config, sub, 'NativeMessagingHosts') });
    chromium('chrome', 'Google Chrome', 'google-chrome');
    chromium('chrome-beta', 'Google Chrome Beta', 'google-chrome-beta');
    chromium('chrome-dev', 'Google Chrome Dev', 'google-chrome-unstable');
    chromium('chromium', 'Chromium', 'chromium');
    chromium('brave', 'Brave', join('BraveSoftware', 'Brave-Browser'));
    chromium('edge', 'Microsoft Edge', 'microsoft-edge');
    chromium('edge-beta', 'Microsoft Edge Beta', 'microsoft-edge-beta');
    chromium('edge-dev', 'Microsoft Edge Dev', 'microsoft-edge-dev');
    chromium('vivaldi', 'Vivaldi', 'vivaldi');
    // Firefox 147+ keeps new profiles under $XDG_CONFIG_HOME/mozilla/firefox (no ~/.mozilla at all), but still reads
    // user native messaging manifests from ~/.mozilla/native-messaging-hosts (checked with Firefox 159: its
    // XREUserNativeManifests directory is ~/.mozilla in both layouts). Creating ~/.mozilla for it left the profile
    // root at $XDG_CONFIG_HOME/mozilla/firefox (checked with Firefox 159; scripts/firefox-smoke.mjs pairs that way).
    list.push({ id: 'firefox', name: 'Firefox', kind: 'firefox', profile: join(home, '.mozilla'),
      profiles: [join(xdgConfig, 'mozilla', 'firefox')], dir: join(home, '.mozilla', 'native-messaging-hosts') });
  } else if (platform === 'darwin') {
    const support = join(home, 'Library', 'Application Support');
    const chromium = (id, name, sub) => list.push({ id, name, kind: 'chromium', profile: join(support, sub),
      dir: join(support, sub, 'NativeMessagingHosts') });
    chromium('chrome', 'Google Chrome', join('Google', 'Chrome'));
    chromium('chrome-beta', 'Google Chrome Beta', join('Google', 'Chrome Beta'));
    chromium('chrome-canary', 'Google Chrome Canary', join('Google', 'Chrome Canary'));
    chromium('chromium', 'Chromium', 'Chromium');
    chromium('brave', 'Brave', join('BraveSoftware', 'Brave-Browser'));
    chromium('edge', 'Microsoft Edge', 'Microsoft Edge');
    chromium('vivaldi', 'Vivaldi', 'Vivaldi');
    list.push({ id: 'firefox', name: 'Firefox', kind: 'firefox', profile: join(support, 'Firefox'),
      dir: join(support, 'Mozilla', 'NativeMessagingHosts') });
  } else if (platform === 'win32') {
    // %LOCALAPPDATA% and %APPDATA% when set (a redirected or roaming profile moves them), else their default places.
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');
    const key = path => `HKCU\\Software\\${path}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
    list.push(
      { id: 'chrome', name: 'Google Chrome', kind: 'chromium', profile: join(local, 'Google', 'Chrome'), registry: key('Google\\Chrome') },
      { id: 'chromium', name: 'Chromium', kind: 'chromium', profile: join(local, 'Chromium'), registry: key('Chromium') },
      { id: 'brave', name: 'Brave', kind: 'chromium', profile: join(local, 'BraveSoftware', 'Brave-Browser'),
        registry: key('BraveSoftware\\Brave-Browser') },
      { id: 'edge', name: 'Microsoft Edge', kind: 'chromium', profile: join(local, 'Microsoft', 'Edge'), registry: key('Microsoft\\Edge') },
      { id: 'vivaldi', name: 'Vivaldi', kind: 'chromium', profile: join(local, 'Vivaldi'), registry: key('Vivaldi') },
      { id: 'firefox', name: 'Firefox', kind: 'firefox', profile: join(roaming, 'Mozilla', 'Firefox'), registry: key('Mozilla') },
    );
  }
  return list;
}

/** The host manifest for one browser kind. */
export function nativeManifest(kind, { path, extensionId = PINNED_EXTENSION_ID } = {}) {
  const manifest = { name: NATIVE_HOST_NAME, description: DESCRIPTION, path, type: 'stdio' };
  if (kind === 'firefox') manifest.allowed_extensions = [...GECKO_IDS];
  else manifest.allowed_origins = [`chrome-extension://${extensionId}/`];
  return manifest;
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

/**
 * The launcher a manifest points at: browsers start native hosts with a minimal environment, so it names node by its
 * absolute path (and FAI_HOME when one is set). A shell script on Linux and macOS, a .bat file on Windows.
 */
export function launcherFile({ platform = process.platform, dir, execPath = process.execPath, env = process.env,
  entry = NATIVE_HOST_ENTRY } = {}) {
  const home = env.FAI_HOME ? faiHome(env) : null;
  if (platform === 'win32') {
    // Inside double quotes cmd.exe takes every character literally except `%` (variable expansion), written `%%`.
    // Windows paths cannot hold `"`.
    const bat = value => String(value).replaceAll('%', '%%');
    const lines = ['@echo off', `rem ${MARKER}`];
    if (home) lines.push(`set "FAI_HOME=${bat(home)}"`);
    lines.push(`"${bat(execPath)}" "${bat(entry)}" %*`);
    return { path: join(dir, 'native-host.bat'), content: `${lines.join('\r\n')}\r\n`, mode: 0o600 };
  }
  const prefix = home ? `FAI_HOME=${shQuote(home)} ` : '';
  const content = `#!/bin/sh\n# ${MARKER} (written by fai-browser install-native).\n`
    + `${prefix}exec ${shQuote(execPath)} ${shQuote(entry)} "$@"\n`;
  return { path: join(dir, 'native-host'), content, mode: 0o700 };
}

function readExtensionId(settingsDir) {
  try {
    const match = /^\s*FAI_EXTENSION_ID\s*=\s*"?([a-p]{32})"?\s*$/m.exec(readFileSync(join(settingsDir, '.env.local'), 'utf8'));
    return match?.[1] ?? PINNED_EXTENSION_ID;
  } catch {
    return PINNED_EXTENSION_ID;
  }
}

/**
 * Plan the native host install without touching anything: `{ launcher, manifestFile?, browsers: [{ id, name, kind,
 * detected, path?, registry?, content }] }`. `browsers` names ids to include (default: the detected ones, or every
 * one with `all`).
 */
export function planNativeInstall({ env = process.env, platform = process.platform, home, execPath = process.execPath,
  only = null, all = false, extensionId } = {}) {
  const userHome = home ?? env.HOME ?? env.USERPROFILE;
  const settingsDir = faiHome(env, platform);
  const id = extensionId ?? readExtensionId(settingsDir);
  const launcher = launcherFile({ platform, dir: settingsDir, execPath, env });
  const targets = browserTargets({ platform, home: userHome, env })
    .map(target => ({ ...target, detected: [target.profile, ...(target.profiles ?? [])].some(path => existsSync(path)) }));
  const chosen = targets.filter(target => (only ? only.includes(target.id) : all || target.detected));
  const plan = { launcher, extensionId: id, platform, browsers: [] };
  for (const target of chosen) {
    const content = `${JSON.stringify(nativeManifest(target.kind, { path: launcher.path, extensionId: id }), null, 2)}\n`;
    if (target.registry) {
      // One manifest file per kind next to the launcher; the registry value points at it.
      const path = join(settingsDir, `${NATIVE_HOST_NAME}.${target.kind}.json`);
      plan.browsers.push({ id: target.id, name: target.name, kind: target.kind, detected: target.detected, path,
        registry: target.registry, content });
    } else {
      plan.browsers.push({ id: target.id, name: target.name, kind: target.kind, detected: target.detected,
        path: join(target.dir, `${NATIVE_HOST_NAME}.json`), content });
    }
  }
  plan.missing = targets.filter(target => !chosen.includes(target)).map(target => target.id);
  return plan;
}

async function atomicWrite(path, content, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.fai-${process.pid}.tmp`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

/** Write the launcher and every planned manifest (and, on Windows, its registry value). Resolves the written paths. */
export async function applyNativeInstall(plan, { reg = registryAdd } = {}) {
  await mkdir(dirname(plan.launcher.path), { recursive: true, mode: 0o700 });
  await atomicWrite(plan.launcher.path, plan.launcher.content, plan.launcher.mode);
  const written = [];
  for (const browser of plan.browsers) {
    await atomicWrite(browser.path, browser.content, 0o644);
    if (browser.registry) reg(browser.registry, browser.path);
    written.push({ id: browser.id, name: browser.name, path: browser.path, ...(browser.registry ? { registry: browser.registry } : {}) });
  }
  return { launcher: plan.launcher.path, browsers: written };
}

function registryAdd(key, value) {
  execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore' });
}

function registryDelete(key) {
  try {
    execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' });
  } catch {
    // Not registered.
  }
}

/**
 * Remove the launcher and the host manifest from every known browser location (detected or not); only files whose
 * `name` is this host are removed. Resolves the removed paths.
 */
export async function uninstallNative({ env = process.env, platform = process.platform, home, regDelete = registryDelete } = {}) {
  const plan = planNativeInstall({ env, platform, home, all: true });
  const removed = [];
  for (const browser of plan.browsers) {
    let ours = false;
    try {
      ours = JSON.parse(readFileSync(browser.path, 'utf8'))?.name === NATIVE_HOST_NAME;
    } catch {
      ours = false;
    }
    if (ours) {
      await rm(browser.path, { force: true });
      removed.push(browser.path);
    }
    if (browser.registry) regDelete(browser.registry);
  }
  try {
    if (readFileSync(plan.launcher.path, 'utf8').includes(MARKER)) {
      await rm(plan.launcher.path, { force: true });
      removed.push(plan.launcher.path);
    }
  } catch {
    // No launcher.
  }
  return { removed };
}
