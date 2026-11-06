// `fai-browser launch`: official Firefox with the dedicated FAI profile, the signed add-on installed and paired.
// `fai-browser uninstall-launcher`: removes what launch created (asks first).
//
//   fai-browser launch                 set up what is missing, then start Firefox with the FAI profile
//   fai-browser launch --print         dry run: what it would use, write and run; changes nothing
//   options: --firefox <path>  --xpi <signed.xpi>  --download (agree to download Firefox without asking)
//            --lang <ab-CD>  --require-signature  --desktop | --no-desktop  --no-welcome  --no-wait  --json
//
// What a launch does, in order (each step is skipped when already done):
//   1. Firefox: an official Firefox 140+ (src/launcher/detect.js). Snap and Flatpak builds cannot start the pairing
//      helper, so they are not used; with no usable Firefox the launcher offers to download Mozilla's build into its
//      data directory (src/launcher/download.js; asks first, checksum and signature checked).
//   2. Pairing: the pairing secret in the settings directory (as npm run setup makes it), the native messaging host
//      manifest for Firefox (src/native.js), and the FAI service.
//   3. The add-on: the signed .xpi for this version (src/launcher/addon.js), copied into the profile
//      (src/launcher/profile.js; the private copy also gets a policies.json).
//   4. The profile: <launcher data>/profile with user.js; never registered in profiles.ini.
//   5. A welcome page (static, src/launcher/welcome.html) and, on Linux, the "FAI Browser" menu entry (asks first).
//   6. Firefox starts detached: <firefox> --profile <profile> --no-remote <welcome page>. No remote-control flag or
//      pref, ever. --no-remote keeps links from other apps out of the agent profile. When the profile is already
//      running, the launcher says so instead of starting a second copy.
//   7. With a terminal it waits up to 30 s for the add-on to connect to the service and says so.
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PACKAGE_ROOT } from '../paths.js';
import { homePaths } from '../home.js';
import { readEnvFile, saveSettings } from '../settings.js';
import { GECKO_ID, applyNativeInstall, planNativeInstall } from '../native.js';
import { launcherPaths } from './dirs.js';
import { MIN_FIREFOX_MAJOR, findFirefox, privateBinary, realFs } from './detect.js';
import { AddonError, locateAddon, obtainAddon } from './addon.js';
import { DownloadError, downloadFirefox, mozillaTarget } from './download.js';
import { installAddonInProfile, prepareProfile, profileAddonPath, profileInUse, writePolicies } from './profile.js';
import { ICON_SOURCE, desktopEntryPath, installDesktopEntry, removeDesktopEntry } from './desktop.js';

export const WELCOME_SOURCE = join(PACKAGE_ROOT, 'src', 'launcher', 'welcome.html');
const PAIR_WAIT_MS = 30_000;

export class LaunchError extends Error {
  constructor(message, { code = 'launch', hint } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

function packageVersion() {
  return JSON.parse(realFs.readText(join(PACKAGE_ROOT, 'package.json'))).version;
}

/** The Firefox command line. Nothing else is ever passed: no remote protocol, no headless, no extra prefs. */
export function firefoxCommand({ binary, profile, url }) {
  return [binary, '--profile', profile, '--no-remote', ...(url ? [url] : [])];
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Default dependencies: the real machine. Tests replace any of them. */
export function defaultDeps(overrides = {}) {
  const env = overrides.env ?? process.env;
  const interactive = overrides.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    env,
    platform: process.platform,
    arch: process.arch,
    home: env.HOME || env.USERPROFILE || homedir(),
    fs: realFs,
    fetch: globalThis.fetch,
    run: undefined,
    interactive,
    execPath: process.execPath,
    version: packageVersion(),
    out: line => process.stdout.write(`${line}\n`),
    async ask(question, defaultYes = false) {
      if (!interactive) return false;
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await prompt.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim();
        return answer ? /^y(es)?$/i.test(answer) : defaultYes;
      } finally {
        prompt.close();
      }
    },
    spawnBrowser([program, ...args], { env: childEnv }) {
      const child = spawn(program, args, { env: childEnv, detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      return { pid: child.pid };
    },
    async ensureService(serviceEnv) {
      const { ensureDaemon } = await import('../client.js');
      return ensureDaemon({ env: serviceEnv, autoStart: true });
    },
    async waitPaired(serviceEnv, timeoutMs) {
      const { FaiBrowserClient } = await import('../client.js');
      const client = await FaiBrowserClient.connect({ env: serviceEnv, autoStart: false, clientName: 'launcher' });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const status = await client.status().catch(() => null);
        if (status?.extension?.connected) return true;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return false;
    },
    ...overrides,
  };
}

/** True for the Firefox the launcher downloaded into its own data directory. */
function isPrivateCopy(found, paths) {
  return Boolean(found?.binary?.startsWith(`${paths.firefox}${sep}`));
}

function describeFirefox(found) {
  if (!found) return 'none';
  const version = found.version ? `Firefox ${found.version.version}` : 'Firefox (version unknown)';
  return `${version} at ${found.binary}${found.private ? ' (FAI\'s own copy, from Mozilla)' : ''}`;
}

/** Everything a launch would use and do, with no change made. */
export async function planLaunch(options = {}, deps = defaultDeps()) {
  const { env, platform, home } = deps;
  const paths = launcherPaths({ env, platform });
  const state = (await readJson(paths.state)) ?? {};
  const found = findFirefox({ platform, env, home, explicit: options.firefox, saved: state.firefox, privateDir: paths.firefox, fs: deps.fs });
  if (options.firefox && found.chosen?.source !== 'explicit') {
    const named = [...found.sandboxed, ...found.tooOld].find(item => item.source === 'explicit');
    throw new LaunchError(`${options.firefox} cannot be used: ${named?.reason ?? (named?.version ? `Firefox ${named.version.version} is older than ${MIN_FIREFOX_MAJOR}` : 'not a Firefox')}`,
      { code: 'unusable_firefox' });
  }
  const settings = homePaths({ env });
  let secret = false;
  try {
    secret = Boolean(readEnvFile(settings.envFile).FAI_BRIDGE_SECRET);
  } catch {
    secret = false;
  }
  const native = planNativeInstall({ env, platform, home, only: ['firefox'] });
  let addon;
  try {
    addon = await locateAddon({ version: deps.version, xpi: options.xpi, addonDir: paths.addon });
  } catch (error) {
    addon = { error: error.message, hint: error.hint };
  }
  const desktopPath = platform === 'linux' ? desktopEntryPath({ env, home }) : null;
  const binary = found.chosen?.binary ?? privateBinary(paths.firefox, platform);
  return {
    version: deps.version,
    dataDir: paths.data,
    profile: { path: paths.profile, exists: await exists(join(paths.profile, 'user.js')), addon: profileAddonPath(paths.profile) },
    firefox: found.chosen ? { ...found.chosen, private: isPrivateCopy(found.chosen, paths) } : null,
    sandboxed: found.sandboxed,
    tooOld: found.tooOld,
    download: found.chosen ? null : { dir: paths.firefox, target: mozillaTarget(platform, deps.arch) },
    settings: { file: settings.envFile, secret: secret ? 'present' : 'will be created' },
    native: { launcher: native.launcher.path, manifest: native.browsers[0]?.path ?? null, registry: native.browsers[0]?.registry ?? null },
    addon,
    policies: !found.chosen || isPrivateCopy(found.chosen, paths),
    desktop: desktopPath ? { path: desktopPath, exists: await exists(desktopPath) } : null,
    welcome: paths.welcome,
    command: firefoxCommand({ binary, profile: paths.profile, url: options.welcome === false ? null : `${pathToFileURL(paths.welcome).href}#…` }),
    running: profileInUse(paths.profile, { platform }),
  };
}

/** The plan as lines for --print. */
export function planLines(plan) {
  const lines = [`FAI Browser launcher ${plan.version} (dry run: nothing is changed)`];
  if (plan.firefox) lines.push(`Firefox:   ${describeFirefox(plan.firefox)}`);
  else {
    lines.push('Firefox:   no usable Firefox found');
    lines.push(plan.download?.target
      ? `           would ask to download the latest Firefox from download.mozilla.org into ${plan.download.dir} (SHA512SUMS checked)`
      : '           Mozilla has no build for this platform');
  }
  for (const item of plan.sandboxed) lines.push(`           skipped ${item.path}: ${item.reason} (sandboxed: cannot start the pairing helper)`);
  for (const item of plan.tooOld) lines.push(`           skipped ${item.path}: Firefox ${item.version.version} is older than ${MIN_FIREFOX_MAJOR}`);
  lines.push(`Profile:   ${plan.profile.path} (${plan.profile.exists ? 'exists, user.js rewritten' : 'would be created'})`);
  if (plan.addon.error) lines.push(`Add-on:    ${plan.addon.error}`);
  else if (plan.addon.url) lines.push(`Add-on:    would download ${plan.addon.url} (checked against the release's SHA256SUMS)`);
  else lines.push(`Add-on:    ${plan.addon.info.id} ${plan.addon.info.version}, signed, from ${plan.addon.path}`);
  lines.push(`           installed as ${plan.profile.addon}${plan.policies ? ' and pinned by distribution/policies.json in FAI\'s own Firefox' : ''}`);
  lines.push(`Pairing:   secret ${plan.settings.secret} in ${plan.settings.file}`);
  lines.push(`           native host ${plan.native.manifest ?? '(none for this platform)'}${plan.native.registry ? ` (${plan.native.registry})` : ''} -> ${plan.native.launcher}`);
  lines.push('Service:   started if not running');
  if (plan.desktop) lines.push(`Menu:      ${plan.desktop.path} ${plan.desktop.exists ? '(exists)' : '(would ask)'}`);
  lines.push(`Command:   ${plan.command.map(arg => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`);
  if (plan.running) lines.push('Note:      the FAI profile is running now; launch would not start a second copy.');
  return lines;
}

async function ensureSecret(env) {
  const settings = homePaths({ env });
  let saved = {};
  try {
    saved = readEnvFile(settings.envFile);
  } catch {
    saved = {};
  }
  if (saved.FAI_BRIDGE_SECRET) return false;
  await saveSettings({ FAI_BRIDGE_SECRET: randomBytes(32).toString('hex') }, settings.envFile);
  return true;
}

async function writeWelcome(paths, checks) {
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  await copyFile(WELCOME_SOURCE, paths.welcome);
  await copyFile(ICON_SOURCE, join(paths.data, 'fai-browser.png'));
  const fragment = new URLSearchParams({ v: '1', ...checks }).toString();
  return `${pathToFileURL(paths.welcome).href}#${fragment}`;
}

/** Runs a launch. Resolves `{ status, ... }`; status 'started', 'running' (already open) or 'printed'. */
export async function launch(options = {}, deps = defaultDeps()) {
  const { env, platform, home, out } = deps;
  const plan = await planLaunch(options, deps);
  if (options.print) {
    if (options.json) out(JSON.stringify(plan));
    else planLines(plan).forEach(line => out(line));
    return { status: 'printed', plan };
  }
  const paths = launcherPaths({ env, platform });
  await mkdir(paths.data, { recursive: true, mode: 0o700 });

  // The signed add-on first: without it there is nothing to set up, so nothing is downloaded or written.
  const addon = await obtainAddon({ version: deps.version, xpi: options.xpi, addonDir: paths.addon, fetch: deps.fetch });

  // 1. Firefox.
  let firefox = plan.firefox;
  if (!firefox) {
    for (const item of plan.sandboxed) {
      out(`Found ${item.reason} at ${item.path}: it runs sandboxed and cannot start FAI's pairing helper, so the add-on could not pair.`);
    }
    for (const item of plan.tooOld) out(`Found Firefox ${item.version.version} at ${item.path}: FAI Browser needs ${MIN_FIREFOX_MAJOR} or newer.`);
    if (!plan.download?.target) throw new LaunchError(`Mozilla has no Firefox build for ${platform} ${deps.arch}`, { code: 'no_firefox' });
    const agreed = options.download || await deps.ask(
      `No usable Firefox found. Download official Firefox from Mozilla (download.mozilla.org) into ${paths.firefox}? It updates itself from Mozilla.`, false);
    if (!agreed) {
      throw new LaunchError('No usable Firefox', { code: 'no_firefox',
        hint: 'Install Firefox from https://www.mozilla.org/firefox/ (on Linux the .tar.xz or your distribution\'s package, not Snap or Flatpak), or run fai-browser launch --download.' });
    }
    const downloaded = await downloadFirefox({ dest: paths.firefox, platform, arch: deps.arch, lang: options.lang, fetch: deps.fetch,
      ...(deps.run ? { run: deps.run } : {}), log: line => out(`  ${line}`), requireSignature: options.requireSignature });
    out(`Firefox ${downloaded.version} installed in ${downloaded.dir}.`);
    const chosen = findFirefox({ platform, env, home, explicit: privateBinary(paths.firefox, platform), fs: deps.fs }).chosen;
    firefox = chosen && { ...chosen, private: true };
    if (!firefox) throw new LaunchError(`The downloaded Firefox is not usable at ${privateBinary(paths.firefox, platform)}`, { code: 'no_firefox' });
  }
  out(`Using ${describeFirefox(firefox)}.`);

  // 2. Pairing: secret, native host, service.
  if (await ensureSecret(env)) out('Created the pairing secret (settings directory, mode 0600).');
  const nativePlan = planNativeInstall({ env, platform, home, only: ['firefox'] });
  await applyNativeInstall(nativePlan);
  out(`Pairing helper registered for Firefox (${nativePlan.browsers[0]?.registry ?? nativePlan.browsers[0]?.path}).`);
  let service = 'ok';
  try {
    const daemon = await deps.ensureService(env);
    out(`FAI service running on 127.0.0.1:${daemon.port}.`);
  } catch (error) {
    service = 'warn';
    out(`Could not start the FAI service (${error.message}); the add-on starts it when it pairs.`);
  }

  // A running FAI profile is left alone: no user.js or add-on file changes under a running Firefox, no second copy.
  if (profileInUse(paths.profile, { platform })) {
    out('FAI Browser is already open (the FAI profile is running); switch to its window.');
    return { status: 'running', plan, firefox };
  }

  // 3-4. Add-on (obtained first, above) and profile.
  const profileState = await prepareProfile(paths.profile);
  const installed = await installAddonInProfile(paths.profile, addon.path);
  if (isPrivateCopy(firefox, paths)) await writePolicies(firefox.binary, addon.path, platform);
  out(`${profileState.created ? 'Created' : 'Updated'} the FAI profile in ${paths.profile}; add-on ${installed.version} ${installed.installed ? 'installed' : 'already there'}.`);

  // 5. Welcome page and menu entry.
  const url = options.welcome === false ? null : await writeWelcome(paths, {
    firefox: firefox.version?.version ?? 'ok', addon: installed.version, native: 'ok', service, profile: 'ok', profilePath: paths.profile });
  if (platform === 'linux' && options.desktop !== false && !options.fromDesktop) {
    const present = await exists(desktopEntryPath({ env, home }));
    if (options.desktop || (!present && await deps.ask('Add "FAI Browser" to your applications menu?', true))) {
      const entry = await installDesktopEntry({ env, home, dataDir: paths.data, execPath: deps.execPath });
      out(`Menu entry: ${entry.path}`);
    }
  }

  const stateFile = { firefox: firefox.binary, firefoxVersion: firefox.version?.version ?? null, source: firefox.source,
    addonId: GECKO_ID, addonVersion: installed.version, profile: paths.profile };
  await writeFile(paths.state, `${JSON.stringify(stateFile, null, 2)}\n`, { mode: 0o600 });

  // 6. Start Firefox.
  const command = firefoxCommand({ binary: firefox.binary, profile: paths.profile, url });
  const child = deps.spawnBrowser(command, { env });
  out(`Started FAI Browser (Firefox, pid ${child.pid ?? '?'}).`);

  // 7. Pairing confirmation.
  let paired = null;
  if (deps.interactive && options.wait !== false && service === 'ok') {
    out('Waiting for the add-on to pair with the FAI service...');
    paired = await deps.waitPaired(env, PAIR_WAIT_MS).catch(() => false);
    out(paired ? 'Paired: the FAI Browser add-on is connected. Your agent can now ask for a tab.'
      : 'Not paired yet. Click the FAI Browser button in Firefox and choose "Pair with the FAI service" (docs/guide/troubleshooting.md).');
  }
  return { status: 'started', plan, firefox, addon: installed, command, paired };
}

/** What uninstall-launcher removes (nothing outside the launcher's data directory and the menu entry). */
export async function uninstallLauncher(options = {}, deps = defaultDeps()) {
  const { env, platform, home, out } = deps;
  const paths = launcherPaths({ env, platform });
  const desktop = platform === 'linux' ? desktopEntryPath({ env, home }) : null;
  const targets = [];
  if (await exists(paths.data)) targets.push(paths.data);
  if (desktop && await exists(desktop)) targets.push(desktop);
  if (!targets.length) {
    out('Nothing to remove: the FAI Browser launcher is not set up for this user.');
    return { status: 'nothing', removed: [] };
  }
  if (profileInUse(paths.profile, { platform })) {
    throw new LaunchError('The FAI profile is running. Quit FAI Browser (Firefox with the FAI profile) first.', { code: 'profile_in_use' });
  }
  out('This removes:');
  out(`  ${paths.data}  (the FAI profile with its sign-ins, history and settings; FAI's own Firefox copy if any; the add-on file)`);
  if (targets.includes(desktop)) out(`  ${desktop}  (the "FAI Browser" menu entry)`);
  out('It keeps your everyday Firefox, the FAI settings and the pairing helper (remove that with fai-browser uninstall-native).');
  const agreed = options.yes || await deps.ask('Remove them?', false);
  if (!agreed) {
    out('Nothing removed.');
    return { status: 'cancelled', removed: [] };
  }
  const removed = [];
  if (desktop) {
    const path = await removeDesktopEntry({ env, home });
    if (path) removed.push(path);
  }
  await rm(paths.data, { recursive: true, force: true });
  removed.push(paths.data);
  out(`Removed ${removed.join(' and ')}.`);
  return { status: 'removed', removed };
}

const LAUNCH_OPTIONS = {
  print: { type: 'boolean' },
  json: { type: 'boolean' },
  firefox: { type: 'string' },
  xpi: { type: 'string' },
  download: { type: 'boolean' },
  lang: { type: 'string' },
  'require-signature': { type: 'boolean' },
  desktop: { type: 'boolean' },
  'no-desktop': { type: 'boolean' },
  'no-welcome': { type: 'boolean' },
  'no-wait': { type: 'boolean' },
  'from-desktop': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
};

export const LAUNCH_USAGE = `Usage:
  fai-browser launch [--print [--json]] [--firefox PATH] [--xpi SIGNED.xpi] [--download] [--lang ab-CD]
                     [--require-signature] [--desktop | --no-desktop] [--no-welcome] [--no-wait]
      Official Firefox with a separate FAI profile and the signed FAI Browser add-on, paired with the FAI service.
      --print shows what it would do and changes nothing.
  fai-browser uninstall-launcher [--yes]
      Removes the FAI profile, FAI's own Firefox copy and the menu entry (asks first).`;

/** CLI entry for `launch` and `uninstall-launcher`. Resolves the exit code. */
export async function main(command, argv, deps = defaultDeps()) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: LAUNCH_OPTIONS, strict: true, allowPositionals: false }));
  } catch (error) {
    process.stderr.write(`${error.message}\n${LAUNCH_USAGE}\n`);
    return 1;
  }
  if (values.help) {
    deps.out(LAUNCH_USAGE);
    return 0;
  }
  const options = {
    print: values.print, json: values.json, firefox: values.firefox, xpi: values.xpi, download: values.download,
    lang: values.lang ?? 'en-US', requireSignature: values['require-signature'],
    desktop: values['no-desktop'] ? false : values.desktop ? true : undefined,
    welcome: !values['no-welcome'], wait: !values['no-wait'], fromDesktop: values['from-desktop'], yes: values.yes,
  };
  try {
    if (command === 'uninstall-launcher') {
      if (!values.yes && !deps.interactive) throw new LaunchError('Run uninstall-launcher in a terminal, or pass --yes.', { code: 'needs_confirmation' });
      await uninstallLauncher(options, deps);
    } else {
      await launch(options, deps);
    }
    return 0;
  } catch (error) {
    const known = error instanceof LaunchError || error instanceof AddonError || error instanceof DownloadError;
    process.stderr.write(`fai-browser ${command}: ${known ? error.message : error.stack ?? error}\n`);
    if (error.hint) process.stderr.write(`  ${error.hint}\n`);
    if (options.fromDesktop) notify(error);
    return 1;
  }
}

// A desktop launch has no terminal: show the failure as a notification when notify-send exists.
function notify(error) {
  try {
    const child = spawn('notify-send', ['FAI Browser could not start', `${error.message}${error.hint ? `\n${error.hint}` : ''}`],
      { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No notifier.
  }
}
