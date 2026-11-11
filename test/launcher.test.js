// The FAI Firefox launcher without a browser or a network: Firefox detection on every platform (a fake filesystem),
// the profile (user.js, the add-on file, policies.json), the Mozilla download checks (fake fetch, fake tar and gpg),
// the menu entry, and whole launches with fake service and browser. Everything lives in a temporary HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../src/zip.js';
import { GECKO_ID, GECKO_IDS } from '../src/native.js';
import { launcherPaths } from '../src/launcher/dirs.js';
import { MIN_FIREFOX_MAJOR, findFirefox, inspectCandidate, privateBinary, readVersion, realFs, systemCandidates } from '../src/launcher/detect.js';
import { FORBIDDEN_PREF, PROFILE_PREFS, installAddonInProfile, policies, policiesPath, prepareProfile, profileAddonPath,
  profileInUse, userJs } from '../src/launcher/profile.js';
import { MOZILLA_RELEASE_KEY, downloadFirefox, expectedSha512, latestUrl, mozillaTarget, parseGpgStatus, parseReleaseLocation,
  resolveLatest } from '../src/launcher/download.js';
import { locateAddon, obtainAddon } from '../src/launcher/addon.js';
import { MARKER, desktopEntry, desktopEntryPath, installDesktopEntry, removeDesktopEntry } from '../src/launcher/desktop.js';
import { firefoxCommand, launch, main, planLaunch, uninstallLauncher } from '../src/launcher/launch.js';
import { releaseAssetUrl, xpiName } from '../src/launcher/release.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
const INI = version => `[App]\nVendor=Mozilla\nName=Firefox\nVersion=${version}\nBuildID=20261001000000\n`;
// File modes are POSIX: on Windows a file's access comes from the user profile's ACL and stat reports 0o666.
const POSIX_MODES = process.platform !== 'win32';

async function scratch(t) {
  // realpath: macOS's tmpdir is a symlink (/var -> /private/var), and the launcher resolves real paths.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'fai-launcher-test-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake filesystem: `files` maps path -> text (null for a binary), `links` path -> real path. */
function fakeFs(files = {}, links = {}) {
  return {
    isFile: path => Object.hasOwn(files, path) || Object.hasOwn(links, path),
    exists: path => Object.hasOwn(files, path),
    realpath: path => links[path] ?? path,
    readText: path => (Object.hasOwn(files, path) ? files[path] ?? '\u007fELF' : null),
  };
}

function signedXpi(version = VERSION, { id = GECKO_ID, signed = true } = {}) {
  const entries = [{ name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, name: 'FAI Browser', version,
    browser_specific_settings: { gecko: { id } } }) }];
  if (signed) entries.push({ name: 'META-INF/cose.sig', data: 'sig' }, { name: 'META-INF/mozilla.rsa', data: 'sig' });
  return createZip(entries);
}

function tempEnv(home) {
  return { HOME: home, PATH: '/nonexistent', XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state') };
}

// --- detection -------------------------------------------------------------------------------------------------------

test('detect, Linux: the PATH wrapper script resolves to the real binary and its application.ini', () => {
  const fs = fakeFs({
    '/usr/bin/firefox': '#!/bin/sh\nexec /usr/lib/firefox/firefox "$@"\n',
    '/usr/lib/firefox/firefox': null,
    '/usr/lib/firefox/application.ini': INI('159.0'),
  });
  const found = findFirefox({ platform: 'linux', env: { PATH: '/usr/local/bin:/usr/bin' }, home: '/home/u', fs });
  assert.equal(found.chosen.binary, '/usr/lib/firefox/firefox');
  assert.equal(found.chosen.path, '/usr/bin/firefox');
  assert.deepEqual(found.chosen.version, { major: 159, version: '159.0', name: 'Firefox' });
  assert.equal(found.usable.length, 1, 'the wrapper and /usr/lib/firefox/firefox are one Firefox');
  assert.deepEqual(found.sandboxed, []);
});

test('detect, Linux: Snap, the Ubuntu snap wrapper and Flatpak are sandboxed, never chosen', () => {
  const snap = findFirefox({ platform: 'linux', env: { PATH: '/usr/bin:/snap/bin' }, home: '/home/u', fs: fakeFs({
    '/usr/bin/firefox': '#!/bin/sh\n# transitional package\nexec /snap/bin/firefox "$@"\n',
    '/snap/bin/firefox': null,
  }, { '/snap/bin/firefox': '/usr/bin/snap' }) });
  assert.equal(snap.chosen, null);
  assert.deepEqual(snap.sandboxed.map(item => item.kind), ['snap', 'snap']);
  const flatpak = findFirefox({ platform: 'linux', env: { PATH: '' }, home: '/home/u', fs: fakeFs({
    '/var/lib/flatpak/exports/bin/org.mozilla.firefox': '#!/bin/sh\nexec flatpak run org.mozilla.firefox "$@"\n',
    '/home/u/.local/share/flatpak/exports/bin/org.mozilla.firefox': null,
  }) });
  assert.equal(flatpak.chosen, null);
  assert.deepEqual(flatpak.sandboxed.map(item => item.kind), ['flatpak', 'flatpak']);
  assert.equal(inspectCandidate('/usr/bin/firefox', { platform: 'linux', fs: fakeFs({ '/usr/bin/firefox': '#!/bin/sh\necho "Command requires the firefox snap to be installed"' }) }).kind, 'snap');
});

test('detect, Linux: /opt tarball, ESR, too old, explicit, saved and private copy order', () => {
  const files = {
    '/opt/firefox/firefox': null, '/opt/firefox/application.ini': INI('160.0.1'),
    '/usr/lib/firefox-esr/firefox-esr': null, '/usr/lib/firefox-esr/application.ini': INI('128.9.0esr'),
    '/data/firefox/firefox': null, '/data/firefox/application.ini': INI('161.0'),
    '/custom/firefox': null, '/custom/application.ini': INI('150.0'),
  };
  const fs = fakeFs(files);
  const base = { platform: 'linux', env: { PATH: '' }, home: '/home/u', fs };
  const system = findFirefox(base);
  assert.equal(system.chosen.binary, '/opt/firefox/firefox');
  assert.deepEqual(system.tooOld.map(item => item.version.major), [128]);
  assert.ok(128 < MIN_FIREFOX_MAJOR);
  assert.equal(findFirefox({ ...base, privateDir: '/data/firefox' }).chosen.source, 'private');
  assert.equal(findFirefox({ ...base, privateDir: '/data/firefox', saved: '/opt/firefox/firefox' }).chosen.source, 'saved');
  assert.equal(findFirefox({ ...base, explicit: '/custom/firefox', privateDir: '/data/firefox' }).chosen.binary, '/custom/firefox');
  assert.equal(findFirefox({ ...base, env: { PATH: '', FIREFOX_PATH: '/custom/firefox' } }).chosen.source, 'explicit');
  assert.throws(() => findFirefox({ ...base, explicit: '/missing/firefox' }), error => error.code === 'no_firefox');
  assert.equal(findFirefox({ platform: 'linux', env: { PATH: '' }, home: '/home/u', fs: fakeFs({}) }).chosen, null);
});

test('detect, macOS and Windows: application bundles and Program Files', () => {
  const mac = findFirefox({ platform: 'darwin', env: {}, home: '/Users/u', fs: fakeFs({
    '/Users/u/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox': null,
    '/Users/u/Applications/Firefox Developer Edition.app/Contents/Resources/application.ini': INI('160.0'),
    '/Applications/Firefox.app/Contents/MacOS/firefox': null,
    '/Applications/Firefox.app/Contents/Resources/application.ini': INI('159.0.2'),
  }) });
  assert.equal(mac.chosen.binary, '/Applications/Firefox.app/Contents/MacOS/firefox');
  assert.equal(mac.chosen.version.version, '159.0.2');
  assert.equal(mac.usable.length, 2);
  assert.equal(privateBinary('/d/firefox', 'darwin'), '/d/firefox/Firefox.app/Contents/MacOS/firefox');
  const programFiles = 'C:\\Program Files';
  const winPaths = systemCandidates({ platform: 'win32', env: { ProgramFiles: programFiles, LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home: 'C:\\Users\\u' })
    .map(item => item.path);
  assert.equal(winPaths.length, 3);
  assert.ok(winPaths[0].startsWith(programFiles) && winPaths[0].endsWith('firefox.exe'));
  const exe = winPaths[0];
  const win = findFirefox({ platform: 'win32', env: { ProgramFiles: programFiles }, home: 'C:\\Users\\u', fs: fakeFs({
    [exe]: null, [join(exe, '..', 'application.ini')]: INI('159.0') }) });
  assert.equal(win.chosen.binary, exe);
  assert.equal(win.chosen.version.major, 159);
  assert.equal(readVersion('/x/firefox', { platform: 'linux', fs: fakeFs({ '/x/application.ini': 'garbage' }) }), null);
});

// --- profile ---------------------------------------------------------------------------------------------------------

test('user.js: first-run, default-browser and telemetry off, add-on enabled, no remote-control pref', () => {
  const text = userJs();
  assert.doesNotMatch(text, /marionette/i);
  assert.doesNotMatch(text.split('\n').filter(line => line.startsWith('user_pref')).join('\n'), /remote/i);
  for (const line of text.trim().split('\n').filter(item => !item.startsWith('//'))) {
    assert.match(line, /^user_pref\("[\w.-]+", (true|false|-?\d+|"[^"]*")\);$/, line);
  }
  assert.match(text, /user_pref\("browser\.shell\.checkDefaultBrowser", false\);/);
  assert.match(text, /user_pref\("extensions\.autoDisableScopes", 14\);/);
  assert.match(text, /user_pref\("toolkit\.telemetry\.enabled", false\);/);
  assert.match(text, /user_pref\("datareporting\.healthreport\.uploadEnabled", false\);/);
  assert.match(text, /user_pref\("browser\.aboutwelcome\.enabled", false\);/);
  assert.match(text, /user_pref\("dom\.security\.https_only_mode", true\);/);
  assert.match(text, /user_pref\("signon\.rememberSignons", false\);/);
  assert.ok(!('xpinstall.signatures.required' in PROFILE_PREFS), 'signature checks stay on');
  for (const name of ['marionette.port', 'remote.active-protocols', 'devtools.debugger.remote-enabled', 'devtools.chrome.enabled']) {
    assert.match(name, FORBIDDEN_PREF);
    assert.throws(() => userJs({ [name]: true }), /Refusing/);
  }
});

test('the Firefox command: --profile, --no-remote and the page, nothing else', () => {
  const command = firefoxCommand({ binary: '/usr/lib/firefox/firefox', profile: '/p', url: 'file:///w.html#v=1' });
  assert.deepEqual(command, ['/usr/lib/firefox/firefox', '--profile', '/p', '--no-remote', 'file:///w.html#v=1']);
  assert.doesNotMatch(command.join(' '), /marionette|remote-debugging|remote-allow|headless|start-debugger/i);
  assert.deepEqual(firefoxCommand({ binary: 'f', profile: '/p' }), ['f', '--profile', '/p', '--no-remote']);
});

test('profile: user.js 0600 in a 0700 directory; the add-on as extensions/<gecko-id>.xpi, never downgraded', async t => {
  const dir = await scratch(t);
  const profile = join(dir, 'profile');
  assert.deepEqual(await prepareProfile(profile), { created: true });
  assert.deepEqual(await prepareProfile(profile), { created: false });
  if (POSIX_MODES) {
    assert.equal((await stat(profile)).mode & 0o777, 0o700);
    assert.equal((await stat(join(profile, 'user.js'))).mode & 0o777, 0o600);
  }
  assert.equal(await readFile(join(profile, 'user.js'), 'utf8'), userJs());
  const write = async (name, version) => {
    await writeFile(join(dir, name), signedXpi(version));
    return join(dir, name);
  };
  const first = await installAddonInProfile(profile, await write('a.xpi', '1.2.0'));
  assert.equal(first.path, join(profile, 'extensions', `${GECKO_ID}.xpi`));
  assert.equal(first.path, profileAddonPath(profile));
  assert.deepEqual([first.installed, first.version, first.previous], [true, '1.2.0', null]);
  const older = await installAddonInProfile(profile, await write('b.xpi', '1.1.9'));
  assert.deepEqual([older.installed, older.version], [false, '1.2.0'], 'an update Firefox installed is kept');
  const newer = await installAddonInProfile(profile, await write('c.xpi', '1.10.0'));
  assert.deepEqual([newer.installed, newer.version, newer.previous], [true, '1.10.0', '1.2.0']);
  assert.deepEqual(await readdir(join(profile, 'extensions')), [`${GECKO_ID}.xpi`]);
});

test('policies.json for the private copy: force_installed from the file on disk', () => {
  const value = policies('/data/addon/fai-browser-firefox-0.3.0.xpi');
  assert.deepEqual(value.policies.ExtensionSettings, {
    [GECKO_ID]: { installation_mode: 'force_installed', install_url: 'file:///data/addon/fai-browser-firefox-0.3.0.xpi' },
  });
  assert.equal(value.policies.DisableTelemetry, true);
  assert.equal(value.policies.DontCheckDefaultBrowser, true);
  assert.equal(Object.keys(value.policies).some(name => /remote|debug/i.test(name)), false);
  assert.equal(policiesPath('/d/firefox/firefox', 'linux'), '/d/firefox/distribution/policies.json');
  assert.equal(policiesPath('/d/firefox/Firefox.app/Contents/MacOS/firefox', 'darwin'),
    '/d/firefox/Firefox.app/Contents/Resources/distribution/policies.json');
});

test('profileInUse: the Linux lock symlink and a live pid', () => {
  const alive = pid => pid === 4242;
  assert.equal(profileInUse('/p', { platform: 'linux', readLink: () => '127.0.1.1:+4242', alive }), true);
  assert.equal(profileInUse('/p', { platform: 'linux', readLink: () => '127.0.1.1:+99', alive }), false);
  assert.equal(profileInUse('/p', { platform: 'linux', readLink: () => { throw new Error('ENOENT'); }, alive }), false);
  assert.equal(profileInUse('/p', { platform: 'darwin', readLink: () => '127.0.1.1:+4242', alive }), false);
});

// --- Mozilla download ------------------------------------------------------------------------------------------------

const RELEASE_URL = 'https://download-installer.cdn.mozilla.net/pub/firefox/releases/161.0/linux-x86_64/en-US/firefox-161.0.tar.xz';

test('download: platform names, the redirect, the checksum entry, gpg status', () => {
  assert.deepEqual(mozillaTarget('linux', 'x64'), { os: 'linux64', dir: 'linux-x86_64', format: 'tar' });
  assert.equal(mozillaTarget('linux', 'arm64').os, 'linux64-aarch64');
  assert.equal(mozillaTarget('darwin', 'arm64').format, 'dmg');
  assert.equal(mozillaTarget('win32', 'x64').os, 'win64');
  assert.equal(mozillaTarget('linux', 'ia32'), null);
  assert.equal(latestUrl(mozillaTarget('linux', 'x64')), 'https://download.mozilla.org/?product=firefox-latest-ssl&os=linux64&lang=en-US');
  assert.deepEqual(parseReleaseLocation(RELEASE_URL), { url: RELEASE_URL, version: '161.0', dir: 'linux-x86_64', lang: 'en-US',
    file: 'firefox-161.0.tar.xz', key: 'linux-x86_64/en-US/firefox-161.0.tar.xz' });
  assert.equal(parseReleaseLocation('https://download-installer.cdn.mozilla.net/pub/firefox/releases/161.0/mac/en-US/Firefox%20161.0.dmg').key,
    'mac/en-US/Firefox 161.0.dmg');
  for (const bad of ['http://download-installer.cdn.mozilla.net/pub/firefox/releases/161.0/linux-x86_64/en-US/f.tar.xz',
    'https://evil.example/pub/firefox/releases/161.0/linux-x86_64/en-US/f.tar.xz',
    'https://archive.mozilla.org/pub/thunderbird/releases/1.0/linux-x86_64/en-US/f.tar.xz', 'not a url']) {
    assert.throws(() => parseReleaseLocation(bad), error => error.code === 'bad_redirect', bad);
  }
  const release = parseReleaseLocation(RELEASE_URL);
  const hash = 'ab'.repeat(64);
  assert.equal(expectedSha512(`${'cd'.repeat(64)}  linux-x86_64/de/firefox-161.0.tar.xz\n${hash}  ${release.key}\n`, release), hash);
  assert.throws(() => expectedSha512('', release), error => error.code === 'checksum');
  assert.deepEqual(parseGpgStatus(`[GNUPG:] NEWSIG\n[GNUPG:] VALIDSIG 09BEED63F3462A2DFFAB3B875ECB6497C1A20256 2026-10-01 1 0 4 0 1 10 00 ${MOZILLA_RELEASE_KEY}\n`),
    { valid: true, fingerprint: '09BEED63F3462A2DFFAB3B875ECB6497C1A20256', primary: MOZILLA_RELEASE_KEY });
  assert.deepEqual(parseGpgStatus('[GNUPG:] BADSIG x'), { valid: false });
});

/** A fake Mozilla: download.mozilla.org redirect, the archive's SHA512SUMS/.asc/KEY, the CDN file. */
function fakeMozilla(payload, { sumsFor = payload, requests = [] } = {}) {
  const sha = createHash('sha512').update(sumsFor).digest('hex');
  const routes = new Map([
    ['https://archive.mozilla.org/pub/firefox/releases/161.0/SHA512SUMS', `${sha}  linux-x86_64/en-US/firefox-161.0.tar.xz\n`],
    ['https://archive.mozilla.org/pub/firefox/releases/161.0/SHA512SUMS.asc', 'signature'],
    ['https://archive.mozilla.org/pub/firefox/releases/161.0/KEY', 'key'],
    [RELEASE_URL, payload],
  ]);
  return async (url, init = {}) => {
    requests.push(url);
    if (url.startsWith('https://download.mozilla.org/')) {
      assert.equal(init.redirect, 'manual');
      return new Response(null, { status: 302, headers: { location: RELEASE_URL } });
    }
    if (!routes.has(url)) return new Response('missing', { status: 404 });
    return new Response(routes.get(url), { status: 200 });
  };
}

/** Fake tar and gpg: tar unpacks a firefox/ directory with a binary and application.ini; gpg answers `gpgStatus`. */
function fakeTools({ gpg = 'good', calls = [] } = {}) {
  return async (program, args) => {
    calls.push([program, ...args]);
    if (program === 'tar') {
      const staging = args[args.indexOf('-C') + 1];
      await mkdir(join(staging, 'firefox'), { recursive: true });
      await writeFile(join(staging, 'firefox', 'firefox'), 'binary', { mode: 0o755 });
      await writeFile(join(staging, 'firefox', 'application.ini'), INI('161.0'));
      return { stdout: '', stderr: '' };
    }
    if (program === 'gpg') {
      if (gpg === 'missing') throw Object.assign(new Error('spawn gpg ENOENT'), { code: 'ENOENT' });
      if (args.includes('--import')) return { stdout: '', stderr: '' };
      if (gpg === 'good') return { stdout: `[GNUPG:] VALIDSIG AAAA 2026-10-01 1 0 4 0 1 10 00 ${MOZILLA_RELEASE_KEY}\n`, stderr: '' };
      if (gpg === 'other') return { stdout: '[GNUPG:] VALIDSIG BBBB 2026-10-01 1 0 4 0 1 10 00 BBBB\n', stderr: '' };
      throw Object.assign(new Error('bad signature'), { stdout: '[GNUPG:] BADSIG x\n' });
    }
    throw new Error(`unexpected ${program}`);
  };
}

test('downloadFirefox: verified checksum and signature, unpacked into the data directory', async t => {
  const dir = await scratch(t);
  const dest = join(dir, 'data', 'firefox');
  const requests = [];
  const calls = [];
  const lines = [];
  const result = await downloadFirefox({ dest, platform: 'linux', arch: 'x64', fetch: fakeMozilla(Buffer.from('tarball'), { requests }),
    run: fakeTools({ calls }), log: line => lines.push(line) });
  assert.deepEqual(result, { version: '161.0', dir: dest, signature: 'verified' });
  assert.equal(await readFile(join(dest, 'application.ini'), 'utf8'), INI('161.0'));
  assert.ok(requests[0].startsWith('https://download.mozilla.org/?product=firefox-latest-ssl&os=linux64'));
  assert.ok(requests.every(url => /^https:\/\/(download\.mozilla\.org|archive\.mozilla\.org|download-installer\.cdn\.mozilla\.net)\//.test(url)));
  assert.ok(calls.some(call => call[0] === 'tar' && call[1] === '-xJf'));
  assert.ok(lines.some(line => /Checksum matches/.test(line)));
  assert.deepEqual((await readdir(join(dir, 'data'))).sort(), ['firefox'], 'the staging directory is gone');
});

test('downloadFirefox: a checksum mismatch or a foreign signature installs nothing; no gpg is reported', async t => {
  const dir = await scratch(t);
  const dest = join(dir, 'data', 'firefox');
  await assert.rejects(downloadFirefox({ dest, platform: 'linux', arch: 'x64',
    fetch: fakeMozilla(Buffer.from('tampered'), { sumsFor: Buffer.from('original') }), run: fakeTools() }),
  error => error.code === 'checksum');
  await assert.rejects(stat(dest));
  for (const gpg of ['other', 'bad']) {
    await assert.rejects(downloadFirefox({ dest, platform: 'linux', arch: 'x64', fetch: fakeMozilla(Buffer.from('x')), run: fakeTools({ gpg }) }),
      error => error.code === 'signature', gpg);
    await assert.rejects(stat(dest));
  }
  await assert.rejects(downloadFirefox({ dest, platform: 'linux', arch: 'x64', fetch: fakeMozilla(Buffer.from('x')),
    run: fakeTools({ gpg: 'missing' }), requireSignature: true }), error => error.code === 'signature');
  const lines = [];
  const unchecked = await downloadFirefox({ dest, platform: 'linux', arch: 'x64', fetch: fakeMozilla(Buffer.from('x')),
    run: fakeTools({ gpg: 'missing' }), log: line => lines.push(line) });
  assert.equal(unchecked.signature, 'unchecked');
  assert.ok(lines.some(line => /gpg is not installed/.test(line)));
  await assert.rejects(resolveLatest({ target: mozillaTarget('linux', 'x64'), fetch: async () => new Response('', { status: 200 }) }),
    error => error.code === 'bad_redirect');
});

// --- the add-on ------------------------------------------------------------------------------------------------------

test('add-on sources: --xpi, the cache, the checkout, else the release (checked against SHA256SUMS)', async t => {
  const dir = await scratch(t);
  const addonDir = join(dir, 'addon');
  const root = join(dir, 'checkout');
  assert.deepEqual(await locateAddon({ version: '1.0.0', addonDir, root }),
    { source: 'release', url: releaseAssetUrl('1.0.0', xpiName('1.0.0')) });
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', xpiName('1.0.0')), signedXpi('1.0.0', { signed: false }));
  assert.equal((await locateAddon({ version: '1.0.0', addonDir, root })).source, 'release', 'an unsigned build is skipped');
  await writeFile(join(root, 'dist', xpiName('1.0.0')), signedXpi('1.0.0'));
  const fromCheckout = await obtainAddon({ version: '1.0.0', addonDir, root });
  assert.equal(fromCheckout.source, 'checkout');
  assert.equal(fromCheckout.path, join(addonDir, xpiName('1.0.0')));
  assert.equal((await locateAddon({ version: '1.0.0', addonDir, root })).source, 'cache');
  await writeFile(join(dir, 'unsigned.xpi'), signedXpi('1.0.0', { signed: false }));
  await assert.rejects(obtainAddon({ version: '1.0.0', xpi: join(dir, 'unsigned.xpi'), addonDir, root }), error => error.code === 'unsigned_addon');
  await writeFile(join(dir, 'other.xpi'), signedXpi('1.0.0', { id: 'other@example.com' }));
  await assert.rejects(obtainAddon({ version: '1.0.0', xpi: join(dir, 'other.xpi'), addonDir, root }), error => error.code === 'wrong_addon');

  const xpi = signedXpi('2.0.0');
  const sha = createHash('sha256').update(xpi).digest('hex');
  const release = (bytes, sums) => async url => {
    if (url === releaseAssetUrl('2.0.0', 'SHA256SUMS')) return new Response(sums, { status: 200 });
    if (url === releaseAssetUrl('2.0.0', xpiName('2.0.0'))) return new Response(bytes, { status: 200 });
    return new Response('', { status: 404 });
  };
  const downloaded = await obtainAddon({ version: '2.0.0', addonDir, root, fetch: release(xpi, `${sha}  ${xpiName('2.0.0')}\n`) });
  assert.equal(downloaded.source, 'release');
  assert.deepEqual(await readFile(downloaded.path), xpi);
  await rm(downloaded.path);
  await assert.rejects(obtainAddon({ version: '2.0.0', addonDir, root, fetch: release(signedXpi('2.0.0', { signed: false }), `${sha}  ${xpiName('2.0.0')}\n`) }),
    error => error.code === 'addon_checksum');
  await assert.rejects(obtainAddon({ version: '3.0.0', addonDir, root, fetch: release(xpi, '') }), error => error.code === 'addon_download' && /--xpi/.test(error.hint));
});

// --- menu entry ------------------------------------------------------------------------------------------------------

test('the Linux menu entry: launch command, icon, no MIME types; removed only when ours', async t => {
  const home = await scratch(t);
  const env = tempEnv(home);
  const text = desktopEntry({ execPath: '/usr/bin/node', cli: '/a b/src/cli.js', icon: '/i.png' });
  assert.match(text, /^Exec=\/usr\/bin\/node "\/a b\/src\/cli\.js" launch --from-desktop$/m);
  assert.match(text, /^Name=FAI Browser$/m);
  assert.match(text, /^Icon=\/i\.png$/m);
  assert.doesNotMatch(text, /MimeType|x-scheme-handler|WebBrowser/);
  assert.match(desktopEntry({ execPath: '/n', cli: '/x/100%$`"\\', icon: '/i' }), /Exec=\/n "\/x\/100%%\\\$\\`\\"\\\\" launch/);
  const dataDir = join(home, 'data');
  const entry = await installDesktopEntry({ env, home, dataDir, execPath: '/usr/bin/node' });
  assert.equal(entry.path, join(home, '.local', 'share', 'applications', 'fai-browser.desktop'));
  assert.equal(entry.path, desktopEntryPath({ env, home }));
  assert.ok((await readFile(entry.path, 'utf8')).includes(MARKER));
  assert.ok((await stat(entry.icon)).size > 100);
  assert.equal(await removeDesktopEntry({ env, home }), entry.path);
  await writeFile(entry.path, '[Desktop Entry]\nName=Someone else\n');
  assert.equal(await removeDesktopEntry({ env, home }), null);
  assert.ok(await readFile(entry.path, 'utf8'));
});

// --- whole launches --------------------------------------------------------------------------------------------------

/** Fake dependencies around a temporary HOME; `fs` limits detection to the temp directory plus `extra` files. */
function fakeDeps(home, { extra = {}, answers = [], interactive = true } = {}) {
  const lines = [];
  const spawned = [];
  const asked = [];
  const only = path => path.startsWith(home);
  const fs = {
    isFile: path => Object.hasOwn(extra, path) || (only(path) && realFs.isFile(path)),
    exists: path => Object.hasOwn(extra, path) || (only(path) && realFs.exists(path)),
    realpath: path => (only(path) ? realFs.realpath(path) : path),
    readText: (path, max) => (Object.hasOwn(extra, path) ? extra[path] ?? 'ELF' : only(path) ? realFs.readText(path, max) : null),
  };
  return {
    lines, spawned, asked,
    deps: {
      env: tempEnv(home), platform: 'linux', arch: 'x64', home, fs, interactive, execPath: '/usr/bin/node', version: VERSION,
      out: line => lines.push(line),
      ask: async question => {
        asked.push(question);
        return answers.length ? answers.shift() : false;
      },
      spawnBrowser: (command, options) => {
        spawned.push({ command, env: options.env });
        return { pid: 1234 };
      },
      ensureService: async () => ({ port: 4999 }),
      waitPaired: async () => true,
      fetch: async () => new Response('', { status: 404 }),
    },
  };
}

const SYSTEM_FIREFOX = { '/usr/lib/firefox/firefox': null, '/usr/lib/firefox/application.ini': INI('159.0') };

test('launch: system Firefox, secret, native host, signed add-on, profile, welcome page, menu entry, command', async t => {
  const home = await scratch(t);
  const xpi = join(home, 'signed.xpi');
  await writeFile(xpi, signedXpi());
  const { deps, lines, spawned, asked } = fakeDeps(home, { extra: SYSTEM_FIREFOX, answers: [true] });
  const result = await launch({ xpi, wait: true }, deps);
  assert.equal(result.status, 'started');
  assert.equal(result.paired, true);
  const paths = launcherPaths({ env: deps.env, platform: 'linux' });
  assert.equal(paths.data, join(home, '.local', 'share', 'fai-browser'));
  // Pairing: the secret and the Firefox manifest, both under the temporary HOME.
  assert.match(await readFile(join(home, '.config', 'fai-browser', '.env.local'), 'utf8'), /^FAI_BRIDGE_SECRET="[0-9a-f]{64}"$/m);
  const manifest = JSON.parse(await readFile(join(home, '.mozilla', 'native-messaging-hosts', 'fai_browser.json'), 'utf8'));
  assert.deepEqual(manifest.allowed_extensions, [...GECKO_IDS]);
  assert.equal(manifest.path, join(home, '.config', 'fai-browser', 'native-host'));
  // Profile and add-on.
  assert.equal(await readFile(join(paths.profile, 'user.js'), 'utf8'), userJs());
  assert.deepEqual(await readFile(profileAddonPath(paths.profile)), await readFile(xpi));
  assert.equal(result.plan.policies, false, 'no policies.json for a system Firefox');
  // The command.
  assert.equal(spawned.length, 1);
  const [binary, ...args] = spawned[0].command;
  assert.equal(binary, '/usr/lib/firefox/firefox');
  assert.deepEqual(args.slice(0, 3), ['--profile', paths.profile, '--no-remote']);
  assert.match(args[3], /^file:\/\/.*\/fai-browser\/welcome\.html#v=1&firefox=159\.0&addon=/);
  assert.doesNotMatch(spawned[0].command.join(' '), /marionette|remote-debugging|headless/i);
  assert.equal(spawned[0].env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS, undefined);
  assert.match(await readFile(paths.welcome, 'utf8'), /FAI Browser is ready/);
  // Menu entry (asked, accepted) and state.
  assert.ok(asked.some(question => /applications menu/.test(question)));
  assert.ok((await readFile(join(home, '.local', 'share', 'applications', 'fai-browser.desktop'), 'utf8')).includes('launch --from-desktop'));
  const state = JSON.parse(await readFile(paths.state, 'utf8'));
  assert.equal(state.firefox, '/usr/lib/firefox/firefox');
  assert.equal(state.addonId, GECKO_ID);
  assert.ok(lines.some(line => /^Paired/.test(line)));
  // A second launch reuses everything, asks nothing and keeps the secret.
  const secret = await readFile(join(home, '.config', 'fai-browser', '.env.local'), 'utf8');
  const again = fakeDeps(home, { extra: SYSTEM_FIREFOX });
  await launch({ wait: false }, again.deps);
  assert.deepEqual(again.asked, []);
  assert.equal(await readFile(join(home, '.config', 'fai-browser', '.env.local'), 'utf8'), secret);
  assert.ok(again.lines.some(line => /already there/.test(line)));
});

test('launch --print changes nothing and names every step', async t => {
  const home = await scratch(t);
  const { deps, lines, spawned } = fakeDeps(home, { extra: SYSTEM_FIREFOX });
  const result = await launch({ print: true }, deps);
  assert.equal(result.status, 'printed');
  assert.deepEqual(spawned, []);
  assert.deepEqual(await readdir(home), [], 'no file written');
  const text = lines.join('\n');
  assert.match(text, /dry run/);
  assert.match(text, /Firefox 159\.0 at \/usr\/lib\/firefox\/firefox/);
  assert.match(text, /would download https:\/\/github\.com\/.*\.xpi/);
  assert.match(text, /--profile .*fai-browser\/profile --no-remote file:/);
  const json = fakeDeps(home, { extra: SYSTEM_FIREFOX });
  await launch({ print: true, json: true }, json.deps);
  const plan = JSON.parse(json.lines[0]);
  assert.equal(plan.firefox.binary, '/usr/lib/firefox/firefox');
  assert.equal(plan.native.manifest, join(home, '.mozilla', 'native-messaging-hosts', 'fai_browser.json'));
  assert.deepEqual(await readdir(home), []);
});

test('launch: only a Snap Firefox: explains, asks before downloading, refusal changes nothing', async t => {
  const home = await scratch(t);
  const xpi = join(home, 'signed.xpi');
  await writeFile(xpi, signedXpi());
  const { deps, lines, asked, spawned } = fakeDeps(home, { extra: { '/snap/bin/firefox': null }, answers: [false] });
  await assert.rejects(launch({ xpi }, deps), error => error.code === 'no_firefox' && /not Snap or Flatpak/.test(error.hint));
  assert.ok(lines.some(line => /sandboxed and cannot start FAI's pairing helper/.test(line)));
  assert.equal(asked.length, 1);
  assert.match(asked[0], /download\.mozilla\.org/);
  assert.deepEqual(spawned, []);
  await assert.rejects(stat(join(home, '.mozilla')));
});

test('launch: with consent, Mozilla\'s Firefox goes into the data directory and gets the add-on policy', async t => {
  const home = await scratch(t);
  const xpi = join(home, 'signed.xpi');
  await writeFile(xpi, signedXpi());
  const { deps, spawned } = fakeDeps(home);
  deps.fetch = fakeMozilla(Buffer.from('tarball'));
  deps.run = fakeTools();
  const result = await launch({ xpi, download: true, desktop: false, wait: false }, deps);
  const paths = launcherPaths({ env: deps.env, platform: 'linux' });
  assert.equal(result.firefox.binary, join(paths.firefox, 'firefox'));
  assert.equal(spawned[0].command[0], join(paths.firefox, 'firefox'));
  const policy = JSON.parse(await readFile(join(paths.firefox, 'distribution', 'policies.json'), 'utf8'));
  assert.equal(policy.policies.ExtensionSettings[GECKO_ID].installation_mode, 'force_installed');
  assert.equal(policy.policies.ExtensionSettings[GECKO_ID].install_url, `file://${join(paths.addon, xpiName(VERSION))}`);
  // The next launch finds the private copy without asking.
  const again = fakeDeps(home);
  const second = await launch({ wait: false, desktop: false }, again.deps);
  assert.equal(second.firefox.source, 'saved');
});

test('launch: no signed add-on stops before anything is written', async t => {
  const home = await scratch(t);
  const { deps, spawned } = fakeDeps(home, { extra: SYSTEM_FIREFOX });
  await assert.rejects(launch({}, deps), error => error.code === 'addon_download');
  assert.deepEqual(spawned, []);
  await assert.rejects(stat(join(home, '.mozilla')));
  await assert.rejects(stat(join(home, '.config', 'fai-browser', '.env.local')));
});

test('launch: a running FAI profile is not started twice', async t => {
  const home = await scratch(t);
  const xpi = join(home, 'signed.xpi');
  await writeFile(xpi, signedXpi());
  const { deps } = fakeDeps(home, { extra: SYSTEM_FIREFOX });
  const paths = launcherPaths({ env: deps.env, platform: 'linux' });
  await mkdir(paths.profile, { recursive: true });
  await symlink(`127.0.0.1:+${process.pid}`, join(paths.profile, 'lock'));
  const run = fakeDeps(home, { extra: SYSTEM_FIREFOX });
  const result = await launch({ xpi, desktop: false }, run.deps);
  assert.equal(result.status, 'running');
  assert.deepEqual(run.spawned, []);
  await assert.rejects(uninstallLauncher({ yes: true }, run.deps), error => error.code === 'profile_in_use');
});

test('uninstall-launcher asks first and removes only the launcher\'s files', async t => {
  const home = await scratch(t);
  const xpi = join(home, 'signed.xpi');
  await writeFile(xpi, signedXpi());
  const setup = fakeDeps(home, { extra: SYSTEM_FIREFOX });
  await launch({ xpi, desktop: true, wait: false }, setup.deps);
  const paths = launcherPaths({ env: setup.deps.env, platform: 'linux' });
  const declined = fakeDeps(home, { answers: [false] });
  assert.equal((await uninstallLauncher({}, declined.deps)).status, 'cancelled');
  assert.ok(await stat(paths.profile));
  assert.ok(declined.lines.some(line => line.includes(paths.data)));
  const accepted = fakeDeps(home, { answers: [true] });
  const result = await uninstallLauncher({}, accepted.deps);
  assert.equal(result.status, 'removed');
  await assert.rejects(stat(paths.data));
  await assert.rejects(stat(join(home, '.local', 'share', 'applications', 'fai-browser.desktop')));
  // Settings and the pairing helper stay.
  assert.ok(await stat(join(home, '.config', 'fai-browser', '.env.local')));
  assert.ok(await stat(join(home, '.mozilla', 'native-messaging-hosts', 'fai_browser.json')));
  assert.equal((await uninstallLauncher({}, fakeDeps(home).deps)).status, 'nothing');
  const noTerminal = fakeDeps(home, { interactive: false });
  assert.equal(await main('uninstall-launcher', [], noTerminal.deps), 1);
});

test('the CLI routes launch and uninstall-launcher to the launcher', () => {
  const help = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.js'), 'launch', '--help'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /fai-browser launch \[--print/);
  assert.match(help.stdout, /uninstall-launcher/);
  const bad = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.js'), 'launch', '--bogus'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(bad.status, 1);
  const usage = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.js'), '--help'], { encoding: 'utf8', timeout: 20_000 });
  assert.match(usage.stdout, /fai-browser launch \[--print\]/);
});

test('planLaunch refuses an explicit Firefox that cannot pair', async t => {
  const home = await scratch(t);
  const { deps } = fakeDeps(home, { extra: { '/snap/bin/firefox': null, ...SYSTEM_FIREFOX } });
  await assert.rejects(planLaunch({ firefox: '/snap/bin/firefox' }, deps), error => error.code === 'unusable_firefox' && /Snap/.test(error.message));
});

test('setup\'s Firefox offer: asks when Firefox is there, else prints the launcher command', async () => {
  const { OFFER_QUESTION, offerFirefoxProfile } = await import('../src/launcher/offer.js');
  const run = async ({ found, answer = true, start = async () => {} }) => {
    const lines = [];
    const asked = [];
    const result = await offerFirefoxProfile({ find: () => found, log: line => lines.push(line), start,
      ask: async question => { asked.push(question); return answer; } });
    return { result, lines, asked };
  };
  const firefox = { chosen: { binary: '/usr/lib/firefox/firefox' }, sandboxed: [] };
  const yes = await run({ found: firefox });
  assert.equal(yes.result, 'launched');
  assert.deepEqual(yes.asked, [OFFER_QUESTION]);
  assert.equal(OFFER_QUESTION, 'Set up the FAI Browser profile for Firefox? [Y/n]: ');
  const no = await run({ found: firefox, answer: false });
  assert.equal(no.result, 'declined');
  assert.match(no.lines.join('\n'), /node src\/cli\.js launch/);
  const failed = await run({ found: firefox, start: async () => { throw Object.assign(new Error('no signed add-on'), { hint: 'pass --xpi' }); } });
  assert.equal(failed.result, 'failed');
  assert.deepEqual(failed.lines, ['Could not set up the FAI Browser profile: no signed add-on', '  pass --xpi']);
  const none = await run({ found: { chosen: null, sandboxed: [{ kind: 'snap' }] } });
  assert.equal(none.result, 'no-firefox');
  assert.deepEqual(none.asked, []);
  assert.match(none.lines[0], /Snap build/);
  assert.match(none.lines[1], /node src\/cli\.js launch$/);
  const setup = await readFile(join(ROOT, 'scripts', 'setup.mjs'), 'utf8');
  assert.match(setup, /offerFirefoxProfile\(/);
  assert.match(setup, /'no-firefox'/);
});
