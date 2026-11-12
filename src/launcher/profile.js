// The dedicated FAI profile: a normal Firefox profile directory under the launcher's data directory, started with
// `--profile <dir> --no-remote`. It is not registered in Firefox's profiles.ini, so the everyday profile, the profile
// manager and ~/.mozilla stay exactly as they were; the agent only ever sees accounts signed in here.
//
// user.js (rewritten at every launch; Firefox applies it at startup) holds PROFILE_PREFS: no default-browser
// question, no first-run or what's-new pages, no telemetry, studies or sponsored content, HTTPS-Only, Global Privacy
// Control, no saved passwords or card autofill in an agent profile, and the add-on enabled without the sideload
// prompt (extensions.autoDisableScopes 14 leaves only the profile scope enabled, the one the launcher writes to).
// Nothing enables a remote protocol: no Marionette, no remote debugging, no remote-agent prefs or flags; the
// browser runs exactly as a person would run it.
//
// How the add-on gets in:
//   Any Firefox: the signed .xpi is copied to <profile>/extensions/<gecko-id>.xpi (profile-scope install). No admin
//     rights, nothing outside the profile, the same file Firefox would write itself; Firefox's own update check
//     (update_url) keeps it current afterwards, and the launcher never replaces it with an older version.
//   The private Firefox the launcher downloaded, in addition: distribution/policies.json with ExtensionSettings
//     force_installed for the add-on (install_url = the .xpi on disk). That copy runs only the FAI profile, so the
//     policy keeps the add-on installed and enabled even if it is removed by mistake. The launcher never writes a
//     policy into a system Firefox (it would need admin rights and would apply to every profile).
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { closeSync, openSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GECKO_ID } from '../native.js';
import { compareVersions, inspectXpi } from './addon.js';

export const PROFILE_PREFS = Object.freeze({
  // First run, default browser, what's new.
  'browser.shell.checkDefaultBrowser': false,
  'browser.shell.didSkipDefaultBrowserCheckOnFirstRun': true,
  'browser.aboutwelcome.enabled': false,
  'browser.startup.homepage_override.mstone': 'ignore',
  'startup.homepage_welcome_url': '',
  'startup.homepage_welcome_url.additional': '',
  'startup.homepage_override_url': '',
  'browser.startup.upgradeDialog.enabled': false,
  'browser.startup.firstrunSkipsHomepage': true,
  'trailhead.firstrun.didSeeAboutWelcome': true,
  'browser.uitour.enabled': false,
  'browser.vpn_promo.enabled': false,
  'browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons': false,
  'browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features': false,
  'extensions.getAddons.showPane': false,
  'extensions.htmlaboutaddons.recommendations.enabled': false,
  // Telemetry, studies, sponsored content.
  'datareporting.policy.dataSubmissionEnabled': false,
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
  'datareporting.healthreport.uploadEnabled': false,
  'toolkit.telemetry.enabled': false,
  'toolkit.telemetry.unified': false,
  'toolkit.telemetry.archive.enabled': false,
  'toolkit.telemetry.reportingpolicy.firstRun': false,
  'app.shield.optoutstudies.enabled': false,
  'app.normandy.enabled': false,
  'browser.discovery.enabled': false,
  'browser.newtabpage.activity-stream.feeds.telemetry': false,
  'browser.newtabpage.activity-stream.telemetry': false,
  'browser.newtabpage.activity-stream.showSponsored': false,
  'browser.newtabpage.activity-stream.showSponsoredTopSites': false,
  'browser.urlbar.suggest.quicksuggest.sponsored': false,
  // Privacy and safety for a profile an agent works in.
  'dom.security.https_only_mode': true,
  'privacy.globalprivacycontrol.enabled': true,
  'signon.rememberSignons': false,
  'extensions.formautofill.creditCards.enabled': false,
  'browser.startup.page': 1,
  // The FAI Browser add-on, installed in the profile scope, starts enabled; other scopes stay auto-disabled.
  'extensions.autoDisableScopes': 14,
});

/** Pref names the profile must never set: anything that opens a remote protocol into the browser. */
export const FORBIDDEN_PREF = /marionette|^remote\.|remote-enabled|remote-debugging|devtools\.debugger\.remote|devtools\.chrome\.enabled/i;

/** The user.js text. */
export function userJs(prefs = PROFILE_PREFS) {
  const lines = [
    '// Written by the FAI Browser launcher (src/launcher/profile.js) at every launch; edits here are replaced.',
    '// Change other settings in about:config or Settings as usual. No remote-control pref is ever set here.',
  ];
  for (const [name, value] of Object.entries(prefs)) {
    if (FORBIDDEN_PREF.test(name)) throw new Error(`Refusing to write ${name} into the FAI profile`);
    lines.push(`user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`);
  }
  return `${lines.join('\n')}\n`;
}

/** The profile's add-on file: extensions/<gecko-id>.xpi. */
export function profileAddonPath(profile) {
  return join(profile, 'extensions', `${GECKO_ID}.xpi`);
}

/** Creates the profile directory (0700) when missing and writes user.js. Resolves `{ created }`. */
export async function prepareProfile(profile) {
  let created = false;
  try {
    await readFile(join(profile, 'user.js'));
  } catch {
    created = true;
  }
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const temporary = join(profile, 'user.js.fai-tmp');
  await writeFile(temporary, userJs(), { mode: 0o600 });
  await rename(temporary, join(profile, 'user.js'));
  return { created };
}

/**
 * Copies the signed add-on into the profile unless the profile already has the same or a newer version (Firefox may
 * have updated it). Resolves `{ path, installed, version, previous }`.
 */
export async function installAddonInProfile(profile, xpiPath) {
  const target = profileAddonPath(profile);
  const incoming = inspectXpi(await readFile(xpiPath));
  let previous = null;
  try {
    previous = inspectXpi(await readFile(target)).version;
  } catch {
    previous = null;
  }
  if (previous && compareVersions(previous, incoming.version) >= 0) {
    return { path: target, installed: false, version: previous, previous };
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.fai-tmp`;
  await copyFile(xpiPath, temporary);
  await rename(temporary, target);
  return { path: target, installed: true, version: incoming.version, previous };
}

/** distribution/policies.json for the launcher's private Firefox copy. */
export function policies(xpiPath) {
  return {
    policies: {
      ExtensionSettings: {
        [GECKO_ID]: { installation_mode: 'force_installed', install_url: pathToFileURL(xpiPath).href },
      },
      DisableTelemetry: true,
      DisableFirefoxStudies: true,
      DontCheckDefaultBrowser: true,
      OverrideFirstRunPage: '',
      OverridePostUpdatePage: '',
    },
  };
}

/** Where a Firefox installation reads policies.json: <install>/distribution/ (macOS: Contents/Resources/distribution). */
export function policiesPath(binary, platform = process.platform) {
  const dir = dirname(binary);
  return platform === 'darwin' ? join(dir, '..', 'Resources', 'distribution', 'policies.json') : join(dir, 'distribution', 'policies.json');
}

export async function writePolicies(binary, xpiPath, platform = process.platform) {
  const path = policiesPath(binary, platform);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(policies(xpiPath), null, 2)}\n`);
  return path;
}

/**
 * True when a Firefox is running this profile. Linux: the `lock` symlink names "<host>:+<pid>" and that process is
 * alive. Windows: Firefox holds `parent.lock` open without sharing, so opening it fails while it runs (the file stays
 * behind after Firefox exits). macOS is not checked (Firefox shows its own "already running" message).
 */
export function profileInUse(profile, { platform = process.platform, readLink = readlinkSync, alive = isAlive,
  tryOpen = path => closeSync(openSync(path, 'r+')) } = {}) {
  if (platform === 'win32') {
    try {
      tryOpen(join(profile, 'parent.lock'));
      return false;
    } catch (error) {
      return error?.code === 'EBUSY' || error?.code === 'EPERM' || error?.code === 'EACCES';
    }
  }
  if (platform !== 'linux') return false;
  let target;
  try {
    target = readLink(join(profile, 'lock'));
  } catch {
    return false;
  }
  const pid = Number(/\+(\d+)$/.exec(String(target))?.[1]);
  return Number.isInteger(pid) && pid > 0 && alive(pid);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
