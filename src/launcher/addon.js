// The signed FAI Browser add-on (.xpi) the launcher installs: where it comes from, and the checks it passes first.
//
// Release Firefox installs only add-ons Mozilla signed, so the launcher only takes a signed file with the right ID:
//   1. --xpi <file>                                     a file you name (for example one you signed yourself)
//   2. <launcher data>/addon/fai-browser-firefox-<v>.xpi  the copy a previous launch kept
//   3. <checkout>/dist/fai-browser-firefox-<v>.xpi       `npm run sign:firefox` in this checkout
//   4. the GitHub Release v<v>                          downloaded, and checked against the release's SHA256SUMS
// <v> is this package's version, so the add-on always matches the service that pairs with it.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readZip } from '../zip.js';
import { GECKO_ID } from '../native.js';
import { PACKAGE_ROOT } from '../paths.js';
import { SUMS_FILE, parseSums, releaseAssetUrl, xpiName } from './release.js';

/** The files a Mozilla signature adds to an .xpi (PKCS#7 and COSE). */
export const SIGNATURE_FILES = Object.freeze(['META-INF/mozilla.rsa', 'META-INF/cose.sig']);

export class AddonError extends Error {
  constructor(message, { code = 'addon', hint } = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/** What an .xpi is: `{ id, version, name, signed, updateUrl }`. Throws for a file that is not an add-on. */
export function inspectXpi(buffer) {
  let entries;
  try {
    entries = readZip(buffer);
  } catch (error) {
    throw new AddonError(`Not an add-on package (${error.message})`, { code: 'bad_xpi' });
  }
  const manifestEntry = entries.find(entry => entry.name === 'manifest.json');
  if (!manifestEntry) throw new AddonError('Not an add-on package (no manifest.json)', { code: 'bad_xpi' });
  const manifest = JSON.parse(manifestEntry.read().toString('utf8'));
  const gecko = manifest.browser_specific_settings?.gecko ?? manifest.applications?.gecko ?? {};
  const names = new Set(entries.map(entry => entry.name));
  return {
    id: gecko.id ?? null,
    version: String(manifest.version ?? ''),
    name: manifest.name ?? null,
    signed: SIGNATURE_FILES.some(name => names.has(name)),
    updateUrl: gecko.update_url ?? null,
  };
}

/** -1, 0 or 1 for dotted numeric versions ("0.3.0" < "0.10.0"). */
export function compareVersions(a, b) {
  const left = String(a).split('.').map(part => Number.parseInt(part, 10) || 0);
  const right = String(b).split('.').map(part => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** Throws unless `info` is a signed FAI Browser add-on; `path` names the file in the message. */
export function checkAddon(info, path) {
  if (info.id !== GECKO_ID) {
    throw new AddonError(`${path} is add-on ${info.id ?? '(no ID)'}, not FAI Browser (${GECKO_ID})`, { code: 'wrong_addon' });
  }
  if (!info.signed) {
    throw new AddonError(`${path} is not signed by Mozilla; release Firefox refuses unsigned add-ons`, {
      code: 'unsigned_addon',
      hint: 'Use a signed release (npm run sign:firefox, or the GitHub Release), or load the build as a temporary add-on (docs/guide/firefox.md).',
    });
  }
  return info;
}

async function readIfPresent(path) {
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

const sha256 = data => createHash('sha256').update(data).digest('hex');

/** Downloads release v<version>'s .xpi and checks it against the release's SHA256SUMS. Resolves the bytes. */
export async function downloadAddon(version, { fetch = globalThis.fetch } = {}) {
  const name = xpiName(version);
  const get = async url => {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) {
      throw new AddonError(`Download failed: ${url} answered ${response.status}`, { code: 'addon_download',
        hint: `No signed release ${version} yet? Pass --xpi <signed file>, or run npm run sign:firefox in the checkout.` });
    }
    return Buffer.from(await response.arrayBuffer());
  };
  const sums = parseSums((await get(releaseAssetUrl(version, SUMS_FILE))).toString('utf8'));
  const expected = sums.get(name);
  if (!expected) throw new AddonError(`${SUMS_FILE} of release ${version} does not list ${name}`, { code: 'addon_checksum' });
  const data = await get(releaseAssetUrl(version, name));
  if (sha256(data) !== expected) {
    throw new AddonError(`${name} does not match its SHA-256 in ${SUMS_FILE}; not installed`, { code: 'addon_checksum' });
  }
  return data;
}

/**
 * Finds the signed add-on for `version` without changing anything: `{ source, path, info }` for a local file, or
 * `{ source: 'release', url }` when it would be downloaded. Throws for a named file that fails the checks.
 */
export async function locateAddon({ version, xpi, addonDir, root = PACKAGE_ROOT }) {
  if (xpi) {
    const data = await readIfPresent(xpi);
    if (!data) throw new AddonError(`No such file: ${xpi}`, { code: 'no_xpi' });
    return { source: 'file', path: xpi, info: checkAddon(inspectXpi(data), xpi) };
  }
  for (const [source, path] of [['cache', join(addonDir, xpiName(version))], ['checkout', join(root, 'dist', xpiName(version))]]) {
    const data = await readIfPresent(path);
    if (!data) continue;
    try {
      const info = checkAddon(inspectXpi(data), path);
      if (info.version === version) return { source, path, info };
    } catch {
      // An unsigned or foreign file here is skipped, not an error: the next source may have the signed one.
    }
  }
  return { source: 'release', url: releaseAssetUrl(version, xpiName(version)) };
}

/**
 * The signed add-on as a file in `addonDir` (copied or downloaded there): `{ path, info, source }`. A file named
 * with --xpi may have another version than the package; it is installed as it is.
 */
export async function obtainAddon({ version, xpi, addonDir, root = PACKAGE_ROOT, fetch = globalThis.fetch }) {
  const found = await locateAddon({ version, xpi, addonDir, root });
  await mkdir(addonDir, { recursive: true, mode: 0o700 });
  if (found.source === 'cache') return found;
  const data = found.path ? await readFile(found.path) : await downloadAddon(version, { fetch });
  const info = checkAddon(inspectXpi(data), found.path ?? found.url);
  const target = join(addonDir, xpiName(info.version));
  if (found.path) {
    await copyFile(found.path, target);
  } else {
    const temporary = `${target}.download`;
    await writeFile(temporary, data, { mode: 0o644 });
    await rename(temporary, target);
  }
  return { source: found.source, path: target, info };
}
