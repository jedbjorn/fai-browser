// The Firefox release path without a network or a browser: the reproducible package, the AMO signing wrapper's
// credentials (amo.env loading, permission refusal, values never printed), the signed-file checks, the update
// manifest and the release workflow. Every test uses a temporary HOME; the real amo.env is never read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_EXCLUDED, collectFiles, excluded, packageFirefox, releaseVersion } from '../scripts/package.mjs';
import { amoEnvPath, credentialEnv, signCommand, signFirefox } from '../scripts/sign-firefox.mjs';
import { writeReleaseFiles } from '../scripts/update-manifest.mjs';
import { firefoxManifest } from '../scripts/build-firefox.mjs';
import { createZip, readZip } from '../src/zip.js';
import { GECKO_DEV_ID, GECKO_ID } from '../src/native.js';
import { checkAddon, compareVersions, inspectXpi } from '../src/launcher/addon.js';
import { UPDATE_URL, parseSums, releaseAssetUrl, updateManifest, xpiName } from '../src/launcher/release.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE_KEY = 'user:12345678:999';
const FAKE_SECRET = 'f00dfacecafebeef0123456789abcdef0123456789abcdef0123456789abcdef';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-release-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A minimal checkout: package.json and an extension with a few files, test leftovers among them.
async function fakeRoot(dir, version = '9.8.7') {
  const root = join(dir, 'root');
  await mkdir(join(root, 'extension', 'icons'), { recursive: true });
  await mkdir(join(root, 'extension', 'test'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fai-browser', version }));
  await writeFile(join(root, 'extension', 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'FAI Browser', version,
    background: { service_worker: 'background.js' }, permissions: ['storage', 'offscreen'], key: 'abc' }));
  for (const name of ['background.js', 'compat.js', 'psl-data.js', 'icons/icon-16.png']) {
    await writeFile(join(root, 'extension', name), `// ${name}\n`);
  }
  for (const name of ['.DS_Store', 'page.test.js', 'test/helper.js', 'background.js.map', 'notes.swp', 'popup.js~']) {
    await writeFile(join(root, 'extension', name), 'leftover');
  }
  return root;
}

function homeEnv(home) {
  return { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: process.env.PATH };
}

async function writeAmoEnv(home, mode = 0o600) {
  const path = amoEnvPath(homeEnv(home), 'linux');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `# AMO\nWEB_EXT_API_KEY=${FAKE_KEY}\nWEB_EXT_API_SECRET="${FAKE_SECRET}"\nOTHER=ignored\n`);
  await chmod(path, mode);
  return path;
}

function signedXpi({ id = GECKO_ID, version = '9.8.7', signed = true } = {}) {
  const entries = [{ name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, name: 'FAI Browser', version,
    browser_specific_settings: { gecko: { id } } }) }, { name: 'background.js', data: '//' }];
  if (signed) entries.push({ name: 'META-INF/mozilla.rsa', data: 'sig' }, { name: 'META-INF/cose.sig', data: 'sig' },
    { name: 'META-INF/manifest.mf', data: 'Manifest-Version: 1.0' });
  return createZip(entries);
}

test('package: same bytes twice, sorted entries, fixed time, test-only files left out', async t => {
  const dir = await scratch(t);
  const root = await fakeRoot(dir);
  const env = { SOURCE_DATE_EPOCH: '1700000000' };
  const first = await packageFirefox({ root, out: join(dir, 'a'), env });
  const second = await packageFirefox({ root, out: join(dir, 'b'), env });
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(await readFile(first.path), await readFile(second.path));
  assert.match(first.path, /fai-browser-firefox-9\.8\.7\.zip$/);
  const entries = readZip(await readFile(first.path));
  const names = entries.map(entry => entry.name);
  assert.deepEqual(names, [...names].sort());
  assert.deepEqual(names, ['background.js', 'compat.js', 'icons/icon-16.png', 'manifest.json', 'psl-data.js']);
  const manifest = JSON.parse(entries.find(entry => entry.name === 'manifest.json').read());
  assert.equal(manifest.browser_specific_settings.gecko.id, GECKO_ID);
  assert.equal(manifest.key, undefined);
  // Another epoch gives other bytes (the timestamp is the only input that changed).
  const third = await packageFirefox({ root, out: join(dir, 'c'), env: { SOURCE_DATE_EPOCH: '1600000000' } });
  assert.notEqual(third.sha256, first.sha256);
});

test('package: the real extension packages deterministically and ships no test-only file', async t => {
  const dir = await scratch(t);
  const first = await packageFirefox({ out: join(dir, 'a'), env: {} });
  const second = await packageFirefox({ out: join(dir, 'b'), env: {} });
  assert.equal(first.sha256, second.sha256);
  assert.ok(first.files.includes('manifest.json') && first.files.includes('background.js'));
  assert.ok(!first.files.includes('trusted-input.js'), 'the Chromium-only file stays out');
  for (const name of first.files) assert.equal(excluded(name), false, name);
  const manifest = JSON.parse(readZip(await readFile(first.path)).find(entry => entry.name === 'manifest.json').read());
  assert.equal(manifest.version, await releaseVersion());
  assert.equal(manifest.browser_specific_settings.gecko.update_url, UPDATE_URL);
});

test('package: exclusion patterns and version agreement', async t => {
  for (const name of ['.DS_Store', 'a/.hidden', 'test/x.js', 'a/fixtures/y.html', 'x.test.js', 'x.js.map', 'Thumbs.db', 'x~', 'x.swp']) {
    assert.equal(excluded(name), true, name);
  }
  for (const name of ['background.js', 'icons/icon-16.png', 'testing.js', 'latest.js']) assert.equal(excluded(name), false, name);
  assert.ok(PACKAGE_EXCLUDED.length > 3);
  const dir = await scratch(t);
  const root = await fakeRoot(dir);
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  await assert.rejects(releaseVersion(root), /differ/);
  assert.deepEqual((await collectFiles(join(root, 'extension'))).map(file => file.name),
    ['background.js', 'compat.js', 'icons/icon-16.png', 'manifest.json', 'psl-data.js']);
});

test('the update_url is only in builds with the signed ID', () => {
  const chrome = { manifest_version: 3, version: '1.0.0', background: { service_worker: 'b.js' } };
  assert.equal(firefoxManifest(chrome).browser_specific_settings.gecko.update_url, UPDATE_URL);
  assert.equal(firefoxManifest(chrome, { geckoId: GECKO_DEV_ID }).browser_specific_settings.gecko.update_url, undefined);
  assert.match(UPDATE_URL, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/latest\/download\/updates\.json$/);
});

test('amo.env: loaded only when the environment lacks the credentials, only the two names', async t => {
  const home = await scratch(t);
  const path = await writeAmoEnv(home);
  assert.equal(path, join(home, '.config', 'fai-browser', 'amo.env'));
  const loaded = await credentialEnv(homeEnv(home), { platform: 'linux' });
  assert.equal(loaded.source, 'file');
  assert.equal(loaded.env.WEB_EXT_API_KEY, FAKE_KEY);
  assert.equal(loaded.env.WEB_EXT_API_SECRET, FAKE_SECRET);
  assert.equal(loaded.env.OTHER, undefined);
  const fromEnv = await credentialEnv({ ...homeEnv(home), WEB_EXT_API_KEY: 'k', WEB_EXT_API_SECRET: 's' }, { platform: 'linux' });
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.env.WEB_EXT_API_KEY, 'k');
  // XDG_CONFIG_HOME and FAI_HOME move the file.
  assert.equal(amoEnvPath({ HOME: home, XDG_CONFIG_HOME: '/x/cfg' }, 'linux'), '/x/cfg/fai-browser/amo.env');
  assert.equal(amoEnvPath({ HOME: home, FAI_HOME: '/x/fai' }, 'linux'), '/x/fai/amo.env');
  assert.equal(amoEnvPath({ HOME: '/Users/u' }, 'darwin'), '/Users/u/Library/Application Support/fai-browser/amo.env');
  const missing = await credentialEnv({ HOME: join(home, 'nobody') }, { platform: 'linux' });
  assert.equal(missing.source, null);
});

test('amo.env: a file group or others can read is refused, and the error carries no value', async t => {
  const home = await scratch(t);
  for (const mode of [0o640, 0o604, 0o644]) {
    await writeAmoEnv(home, mode);
    await assert.rejects(credentialEnv(homeEnv(home), { platform: 'linux' }), error => {
      assert.equal(error.code, 'unsafe_credentials_file');
      assert.match(error.message, /chmod 600/);
      assert.ok(!error.message.includes(FAKE_SECRET) && !error.message.includes(FAKE_KEY));
      return true;
    });
  }
});

test('sign:firefox --dry-run names the file and never prints a credential', async t => {
  const home = await scratch(t);
  await writeAmoEnv(home);
  const run = env => spawnSync(process.execPath, [join(ROOT, 'scripts', 'sign-firefox.mjs'), '--dry-run'],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 });
  const ok = run(homeEnv(home));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /web-ext@8 sign --channel unlisted/);
  assert.match(ok.stdout, /credentials from .*\.config\/fai-browser\/amo\.env/);
  for (const text of [ok.stdout, ok.stderr]) {
    assert.ok(!text.includes(FAKE_SECRET) && !text.includes(FAKE_KEY), 'no credential in the output');
  }
  await chmod(join(home, '.config', 'fai-browser', 'amo.env'), 0o644);
  const refused = run(homeEnv(home));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /readable by other users/);
  assert.ok(!refused.stderr.includes(FAKE_SECRET) && !refused.stdout.includes(FAKE_SECRET));
  const none = run(homeEnv(join(home, 'empty')));
  assert.equal(none.status, 0);
  assert.match(none.stdout, /credentials missing/);
});

test('signFirefox: credentials reach web-ext only through its environment; the signed file is checked', async t => {
  const dir = await scratch(t);
  const root = await fakeRoot(dir);
  const home = join(dir, 'home');
  await writeAmoEnv(home);
  const calls = [];
  const fakeWebExt = signed => async (command, { env }) => {
    calls.push({ command, key: env.WEB_EXT_API_KEY, secret: env.WEB_EXT_API_SECRET });
    const artifacts = command[command.indexOf('--artifacts-dir') + 1];
    await writeFile(join(artifacts, 'fai_browser-9.8.7.xpi'), signedXpi({ signed }));
  };
  const result = await signFirefox({ root, env: homeEnv(home), run: fakeWebExt(true) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, FAKE_KEY);
  assert.equal(calls[0].secret, FAKE_SECRET);
  assert.ok(!calls[0].command.join(' ').includes(FAKE_SECRET), 'never on the command line');
  assert.deepEqual(calls[0].command.slice(0, 6), ['npx', '--yes', 'web-ext@8', 'sign', '--channel', 'unlisted']);
  assert.equal(result.path, join(root, 'dist', 'fai-browser-firefox-9.8.7.xpi'));
  assert.ok(!JSON.stringify(result).includes(FAKE_SECRET));
  await assert.rejects(signFirefox({ root, env: homeEnv(home), run: fakeWebExt(false) }), /not the signed FAI Browser/);
  await assert.rejects(signFirefox({ root, env: homeEnv(join(dir, 'nobody')), run: fakeWebExt(true) }),
    error => error.code === 'no_credentials');
  assert.deepEqual(signCommand({ sourceDir: 's', artifactsDir: 'a' }).slice(-5), ['--source-dir', 's', '--artifacts-dir', 'a', '--no-input']);
});

test('inspectXpi and checkAddon: the ID, the version, a Mozilla signature', () => {
  const info = inspectXpi(signedXpi());
  assert.deepEqual(info, { id: GECKO_ID, version: '9.8.7', name: 'FAI Browser', signed: true, updateUrl: null });
  assert.equal(checkAddon(info, 'x.xpi'), info);
  assert.throws(() => checkAddon(inspectXpi(signedXpi({ signed: false })), 'x.xpi'), error => error.code === 'unsigned_addon');
  assert.throws(() => checkAddon(inspectXpi(signedXpi({ id: 'other@example.com' })), 'x.xpi'), error => error.code === 'wrong_addon');
  assert.throws(() => inspectXpi(Buffer.from('not a zip')), error => error.code === 'bad_xpi');
  assert.equal(compareVersions('0.3.0', '0.10.0'), -1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('2.0.1', '2.0.0'), 1);
});

test('update manifest and SHA256SUMS for the release', async t => {
  const dir = await scratch(t);
  const root = await fakeRoot(dir);
  const dist = join(root, 'dist');
  await mkdir(dist);
  const xpi = signedXpi();
  await writeFile(join(dist, xpiName('9.8.7')), xpi);
  await writeFile(join(dist, 'fai-browser-firefox-9.8.7.zip'), 'zip');
  const result = await writeReleaseFiles({ root, dist });
  const updates = JSON.parse(await readFile(result.updates, 'utf8'));
  const sha = createHash('sha256').update(xpi).digest('hex');
  assert.deepEqual(updates, updateManifest({ id: GECKO_ID, version: '9.8.7', sha256: sha, minVersion: '140.0' }));
  const entry = updates.addons[GECKO_ID].updates[0];
  assert.equal(entry.update_link, releaseAssetUrl('9.8.7', 'fai-browser-firefox-9.8.7.xpi'));
  assert.equal(entry.update_hash, `sha256:${sha}`);
  const sums = parseSums(await readFile(result.sums, 'utf8'));
  assert.deepEqual([...sums.keys()], ['fai-browser-firefox-9.8.7.xpi', 'fai-browser-firefox-9.8.7.zip', 'updates.json']);
  assert.equal(sums.get('fai-browser-firefox-9.8.7.xpi'), sha);
  if (process.platform === 'linux') {
    execFileSync('sha256sum', ['-c', '--quiet', 'SHA256SUMS'], { cwd: dist });
  }
});

test('release workflow: version tags, pinned actions, secrets only for signing, browserless tests, lint, release', async () => {
  const text = await readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(text, /on:\n {2}push:\n {4}tags: \["v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"\]/);
  const uses = [...text.matchAll(/uses: ([^\s]+)/g)].map(match => match[1]);
  assert.ok(uses.length >= 2);
  for (const use of uses) assert.match(use, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${use} is pinned to a commit`);
  assert.match(text, /^permissions:\n {2}contents: read$/m);
  assert.match(text, /permissions:\n {6}contents: write/);
  const secretLines = text.split('\n').filter(line => line.includes('secrets.'));
  assert.deepEqual(secretLines.map(line => line.trim()), [
    'WEB_EXT_API_KEY: ${{ secrets.WEB_EXT_API_KEY }}', 'WEB_EXT_API_SECRET: ${{ secrets.WEB_EXT_API_SECRET }}']);
  const order = ['npm ci', 'npm run test:browserless', 'npm run lint:firefox', 'npm run package', 'npm run sign:firefox -- --yes',
    'node scripts/update-manifest.mjs', 'sha256sum -c SHA256SUMS', 'gh release create'];
  let at = 0;
  for (const step of order) {
    const index = text.indexOf(step, at);
    assert.ok(index > at, `${step} runs after the previous step`);
    at = index;
  }
  assert.match(text, /persist-credentials: false/);
  assert.ok(!/pull_request_target|\$\{\{ github\.event\.(head_commit|pull_request)/.test(text));
});

test('release workflow passes actionlint when it is installed', t => {
  const found = spawnSync('actionlint', ['-version'], { encoding: 'utf8' });
  if (found.error) {
    t.skip('actionlint not on PATH');
    return;
  }
  const result = spawnSync('actionlint', [join(ROOT, '.github', 'workflows', 'release.yml')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('release asset helpers', () => {
  assert.equal(xpiName('1.2.3'), 'fai-browser-firefox-1.2.3.xpi');
  assert.match(releaseAssetUrl('1.2.3', 'SHA256SUMS'), /\/releases\/download\/v1\.2\.3\/SHA256SUMS$/);
  const sums = parseSums(`${'a'.repeat(64)}  one.xpi\n${'B'.repeat(64)} *two file.zip\nbad line\n`);
  assert.deepEqual([...sums], [['one.xpi', 'a'.repeat(64)], ['two file.zip', 'b'.repeat(64)]]);
  assert.equal(parseSums(`${'c'.repeat(128)}  linux-x86_64/en-US/firefox-1.0.tar.xz`, { bits: 512 }).size, 1);
});
