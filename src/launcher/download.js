// Downloads official Firefox from Mozilla into the launcher's data directory, only after the user agreed, when no
// usable Firefox is installed. The copy is Mozilla's own build, unmodified, and updates itself from Mozilla.
//
//   1. https://download.mozilla.org/?product=firefox-latest-ssl&os=<os>&lang=<lang> redirects to the current release
//      file on Mozilla's CDN; the redirect names the version, platform, language and file name.
//   2. https://archive.mozilla.org/pub/firefox/releases/<version>/SHA512SUMS lists the file's SHA-512. When gpg is
//      installed, SHA512SUMS.asc is checked against Mozilla's release key (KEY in the same directory, accepted only
//      when its primary fingerprint is MOZILLA_RELEASE_KEY) in a throwaway keyring; without gpg the launcher says so
//      and relies on HTTPS and the checksum (--require-signature refuses instead).
//   3. The download is hashed as it streams to disk and installed only when the SHA-512 matches:
//      Linux .tar.xz extracted with tar; macOS .dmg copied out of the mounted image (hdiutil); Windows: the full
//      installer's /ExtractDir, which unpacks without installing. macOS and Windows are untested.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSums } from './release.js';

/** "Mozilla Software Releases <release@mozilla.com>": the primary key that signs SHA512SUMS. */
export const MOZILLA_RELEASE_KEY = '14F26682D0916CDD81E37B6D61B7B526D98F0353';
export const DOWNLOAD_HOST = 'https://download.mozilla.org/';
export const ARCHIVE = 'https://archive.mozilla.org/pub/firefox/releases';
const CDN_HOSTS = new Set(['download-installer.cdn.mozilla.net', 'archive.mozilla.org', 'ftp.mozilla.org']);

export class DownloadError extends Error {
  constructor(message, { code = 'download', hint } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/** Mozilla's names for this platform: `{ os, dir, format }`, or null when Mozilla has no build for it. */
export function mozillaTarget(platform = process.platform, arch = process.arch) {
  if (platform === 'linux' && arch === 'x64') return { os: 'linux64', dir: 'linux-x86_64', format: 'tar' };
  if (platform === 'linux' && arch === 'arm64') return { os: 'linux64-aarch64', dir: 'linux-aarch64', format: 'tar' };
  if (platform === 'darwin') return { os: 'osx', dir: 'mac', format: 'dmg' };
  if (platform === 'win32' && arch === 'x64') return { os: 'win64', dir: 'win64', format: 'exe' };
  if (platform === 'win32' && arch === 'arm64') return { os: 'win64-aarch64', dir: 'win64-aarch64', format: 'exe' };
  return null;
}

export function latestUrl(target, lang = 'en-US') {
  return `${DOWNLOAD_HOST}?product=firefox-latest-ssl&os=${encodeURIComponent(target.os)}&lang=${encodeURIComponent(lang)}`;
}

/**
 * The release a download.mozilla.org redirect points at: `{ url, version, dir, lang, file, key }` (`key` is the
 * SHA512SUMS entry). Throws for anything but a Mozilla host and a /pub/firefox/releases/ path.
 */
export function parseReleaseLocation(location) {
  let url;
  try {
    url = new URL(location);
  } catch {
    throw new DownloadError(`Unexpected download location: ${location}`, { code: 'bad_redirect' });
  }
  const match = /^\/pub\/firefox\/releases\/(\d+\.\d+(?:\.\d+)?(?:esr)?)\/([\w-]+)\/([\w-]+)\/([^/]+)$/.exec(url.pathname);
  if (url.protocol !== 'https:' || !CDN_HOSTS.has(url.hostname) || !match) {
    throw new DownloadError(`Unexpected download location: ${location}`, { code: 'bad_redirect' });
  }
  const [, version, dir, lang, encoded] = match;
  const file = decodeURIComponent(encoded);
  return { url: url.href, version, dir, lang, file, key: `${dir}/${lang}/${file}` };
}

/** Asks download.mozilla.org which file is current (one request, redirect not followed). */
export async function resolveLatest({ target, lang = 'en-US', fetch = globalThis.fetch }) {
  const response = await fetch(latestUrl(target, lang), { redirect: 'manual' });
  const location = response.headers.get('location');
  if (response.status < 300 || response.status >= 400 || !location) {
    throw new DownloadError(`download.mozilla.org answered ${response.status} without a release location`, { code: 'bad_redirect' });
  }
  const release = parseReleaseLocation(location);
  if (release.dir !== target.dir) throw new DownloadError(`Mozilla offered ${release.dir}, expected ${target.dir}`, { code: 'bad_redirect' });
  return release;
}

/** The SHA-512 SHA512SUMS lists for `release.key`; throws when it lists none. */
export function expectedSha512(sumsText, release) {
  const expected = parseSums(sumsText, { bits: 512 }).get(release.key);
  if (!expected) throw new DownloadError(`SHA512SUMS of Firefox ${release.version} does not list ${release.key}`, { code: 'checksum' });
  return expected;
}

/** Parses gpg --status-fd output: `{ valid, fingerprint, primary }` from the VALIDSIG line. */
export function parseGpgStatus(text) {
  const line = String(text).split('\n').find(item => item.startsWith('[GNUPG:] VALIDSIG '));
  if (!line) return { valid: false };
  const fields = line.trim().split(/\s+/).slice(2);
  return { valid: true, fingerprint: fields[0]?.toUpperCase(), primary: (fields[9] ?? fields[0])?.toUpperCase() };
}

function execFileText(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(program, args, { ...options, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/**
 * Checks SHA512SUMS against its detached signature with gpg in a throwaway keyring. Resolves `{ verified: true,
 * fingerprint }`, or `{ verified: false, reason }` when gpg is missing or the signature is not Mozilla's.
 */
export async function verifySumsSignature({ sums, signature, key, run = execFileText, tmp }) {
  const dir = await mkdtemp(join(tmp, 'gpg-'));
  try {
    await writeFile(join(dir, 'SHA512SUMS'), sums);
    await writeFile(join(dir, 'SHA512SUMS.asc'), signature);
    await writeFile(join(dir, 'KEY'), key);
    const gnupg = join(dir, 'gnupg');
    await mkdir(gnupg, { mode: 0o700 });
    const base = ['--batch', '--no-tty', '--homedir', gnupg];
    try {
      await run('gpg', [...base, '--import', join(dir, 'KEY')]);
    } catch (error) {
      if (error.code === 'ENOENT') return { verified: false, reason: 'gpg is not installed' };
      return { verified: false, reason: 'Mozilla\'s KEY file could not be imported' };
    }
    let status = '';
    try {
      status = (await run('gpg', [...base, '--status-fd', '1', '--verify', join(dir, 'SHA512SUMS.asc'), join(dir, 'SHA512SUMS')])).stdout;
    } catch (error) {
      status = error.stdout ?? '';
    }
    const result = parseGpgStatus(status);
    if (!result.valid) return { verified: false, bad: true, reason: 'the SHA512SUMS signature does not verify' };
    if (result.primary !== MOZILLA_RELEASE_KEY) {
      return { verified: false, bad: true, reason: `SHA512SUMS is signed by ${result.primary}, not Mozilla's release key` };
    }
    return { verified: true, fingerprint: result.fingerprint };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function getText(fetch, url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new DownloadError(`${url} answered ${response.status}`, { code: 'download' });
  return Buffer.from(await response.arrayBuffer());
}

/** Streams `url` to `path`, hashing as it goes. Resolves the SHA-512 hex. */
export async function downloadTo(url, path, { fetch = globalThis.fetch, onProgress } = {}) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new DownloadError(`${url} answered ${response.status}`, { code: 'download' });
  const total = Number(response.headers.get('content-length')) || 0;
  const hash = createHash('sha512');
  const out = createWriteStream(path, { mode: 0o600 });
  let received = 0;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
      onProgress?.(received, total);
    }
  } finally {
    await new Promise((resolve, reject) => out.end(error => (error ? reject(error) : resolve())));
  }
  return hash.digest('hex');
}

async function extract(format, file, staging, run) {
  if (format === 'tar') {
    await run('tar', ['-xJf', file, '-C', staging]);
    return join(staging, 'firefox');
  }
  if (format === 'dmg') {
    const mount = join(staging, 'mount');
    await mkdir(mount);
    await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, file]);
    try {
      const out = join(staging, 'out');
      await mkdir(out);
      await cp(join(mount, 'Firefox.app'), join(out, 'Firefox.app'), { recursive: true, verbatimSymlinks: true });
      return out;
    } finally {
      await run('hdiutil', ['detach', mount, '-quiet']).catch(() => {});
    }
  }
  const out = join(staging, 'out');
  await run(file, [`/ExtractDir=${out}`]);
  // The full installer unpacks into a "core" folder.
  const names = await readdir(out).catch(() => []);
  return names.includes('core') ? join(out, 'core') : out;
}

/**
 * Downloads, verifies and installs the latest Firefox into `dest` (replaced). Resolves `{ version, dir, signature }`.
 * `log` gets one line per stage; nothing is installed unless the checksum matches.
 */
export async function downloadFirefox({ dest, platform = process.platform, arch = process.arch, lang = 'en-US',
  fetch = globalThis.fetch, run = execFileText, log = () => {}, requireSignature = false, onProgress }) {
  const target = mozillaTarget(platform, arch);
  if (!target) throw new DownloadError(`Mozilla has no Firefox build for ${platform} ${arch}`, { code: 'unsupported_platform' });
  const release = await resolveLatest({ target, lang, fetch });
  log(`Firefox ${release.version} (${release.file}) from Mozilla.`);
  const base = `${ARCHIVE}/${release.version}`;
  const sums = await getText(fetch, `${base}/SHA512SUMS`);
  const expected = expectedSha512(sums.toString('utf8'), release);
  const parent = join(dest, '..');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, '.firefox-download-'));
  try {
    let signature;
    try {
      signature = await verifySumsSignature({ sums, signature: await getText(fetch, `${base}/SHA512SUMS.asc`),
        key: await getText(fetch, `${base}/KEY`), run, tmp: staging });
    } catch (error) {
      signature = { verified: false, reason: error.message };
    }
    if (signature.bad || (!signature.verified && requireSignature)) {
      throw new DownloadError(`Not installed: ${signature.reason}`, { code: 'signature' });
    }
    log(signature.verified ? `SHA512SUMS signed by Mozilla's release key (${MOZILLA_RELEASE_KEY}).`
      : `SHA512SUMS signature not checked (${signature.reason}); relying on HTTPS and the checksum.`);
    const file = join(staging, release.file);
    const actual = await downloadTo(release.url, file, { fetch, onProgress });
    if (actual !== expected) throw new DownloadError(`${release.file} does not match its SHA-512 in SHA512SUMS; deleted`, { code: 'checksum' });
    log('Checksum matches SHA512SUMS.');
    const unpacked = await extract(target.format, file, staging, run);
    await rm(dest, { recursive: true, force: true });
    await rename(unpacked, dest);
    return { version: release.version, dir: dest, signature: signature.verified ? 'verified' : 'unchecked' };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
