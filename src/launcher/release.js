// Where signed FAI Browser add-ons are published: GitHub Releases of the repository named in package.json. One place
// for the URLs that the release workflow (.github/workflows/release.yml), the update manifest
// (scripts/update-manifest.mjs), the Firefox build (its gecko update_url) and the launcher (src/launcher/addon.js) use.
//
// Each release v<version> carries:
//   fai-browser-firefox-<version>.xpi   the add-on, signed by Mozilla (AMO, unlisted channel)
//   fai-browser-firefox-<version>.zip   the same build before signing (reproducible, `npm run package`)
//   updates.json                        Firefox's update manifest for self-distributed add-ons
//   SHA256SUMS                          sha256 of each file above, `sha256sum` format
// Firefox checks UPDATE_URL, GitHub's stable "latest release" redirect to that release's updates.json, about once a
// day and installs a newer signed version by itself (update_hash pins the bytes).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../paths.js';

function repositoryUrl() {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(url ?? '');
    if (match) return `https://github.com/${match[1]}/${match[2]}`;
  } catch {
    // Fall through to the default.
  }
  return 'https://github.com/jedbjorn/fai-browser';
}

export const REPOSITORY_URL = repositoryUrl();
export const UPDATES_FILE = 'updates.json';
export const SUMS_FILE = 'SHA256SUMS';
/** The update_url baked into the signed add-on. */
export const UPDATE_URL = `${REPOSITORY_URL}/releases/latest/download/${UPDATES_FILE}`;

export function xpiName(version) {
  return `fai-browser-firefox-${version}.xpi`;
}

export function zipName(version) {
  return `fai-browser-firefox-${version}.zip`;
}

/** The download URL of one file of release v<version>. */
export function releaseAssetUrl(version, name) {
  return `${REPOSITORY_URL}/releases/download/v${version}/${encodeURIComponent(name)}`;
}

/**
 * Parses checksum-file text ("<hex>  <name>" per line, as sha256sum and Mozilla's SHA512SUMS write it; a "*" binary
 * marker is allowed): Map name -> lower-case hex. `bits` is 256 or 512.
 */
export function parseSums(text, { bits = 256 } = {}) {
  const sums = new Map();
  const pattern = new RegExp(`^([0-9a-fA-F]{${bits / 4}}) [ *](.+)$`);
  for (const line of String(text).split(/\r?\n/)) {
    const match = pattern.exec(line.replace(/\s+$/, ''));
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}

/** Firefox's update manifest for one signed version: https://extensionworkshop.com/documentation/manage/updating-your-extension/ */
export function updateManifest({ id, version, sha256, minVersion }) {
  const update = { version, update_link: releaseAssetUrl(version, xpiName(version)), update_hash: `sha256:${sha256}` };
  if (minVersion) update.applications = { gecko: { strict_min_version: minVersion } };
  return { addons: { [id]: { updates: [update] } } };
}
