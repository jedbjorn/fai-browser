#!/usr/bin/env node
// Writes the release's update manifest and checksums next to the signed add-on (the release workflow attaches all of
// them to the GitHub Release; src/launcher/release.js has the URLs):
//   dist/updates.json   Firefox's update manifest: this version, its download link and sha256 (update_hash)
//   dist/SHA256SUMS     sha256 of the signed .xpi, the unsigned .zip and updates.json, `sha256sum -c` compatible
//   node scripts/update-manifest.mjs [--dist dist]
// The signed add-on carries update_url = the latest release's updates.json, so Firefox moves to a newer signed
// version by itself; the launcher checks SHA256SUMS before it installs a downloaded .xpi.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { FIREFOX_MIN_VERSION, GECKO_ID } from './build-firefox.mjs';
import { ROOT, releaseVersion } from './package.mjs';
import { SUMS_FILE, UPDATES_FILE, updateManifest, xpiName, zipName } from '../src/launcher/release.js';

const sha256 = data => createHash('sha256').update(data).digest('hex');

/** Writes updates.json and SHA256SUMS in `dist`. Resolves `{ version, updates, sums }` (paths). */
export async function writeReleaseFiles({ root = ROOT, dist = join(root, 'dist') } = {}) {
  const version = await releaseVersion(root);
  const xpi = await readFile(join(dist, xpiName(version)));
  const manifest = updateManifest({ id: GECKO_ID, version, sha256: sha256(xpi), minVersion: FIREFOX_MIN_VERSION });
  const updatesText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(dist, UPDATES_FILE), updatesText);
  const lines = [[xpiName(version), xpi], [UPDATES_FILE, Buffer.from(updatesText)]];
  try {
    lines.push([zipName(version), await readFile(join(dist, zipName(version)))]);
  } catch {
    // No unsigned package in dist: only the signed file and the manifest are listed.
  }
  const sums = lines.sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, data]) => `${sha256(data)}  ${name}`).join('\n');
  await writeFile(join(dist, SUMS_FILE), `${sums}\n`);
  return { version, updates: join(dist, UPDATES_FILE), sums: join(dist, SUMS_FILE) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { dist: { type: 'string' } } });
  try {
    const result = await writeReleaseFiles({ dist: values.dist ? resolve(values.dist) : undefined });
    console.log(`${result.updates}\n${result.sums}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
