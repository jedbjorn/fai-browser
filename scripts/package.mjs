#!/usr/bin/env node
// Packages the Firefox add-on for addons.mozilla.org: dist/fai-browser-firefox-<version>.zip, the file AMO signs
// (scripts/sign-firefox.mjs signs the same build directory) and the source a reviewer can compare with the repository.
//   npm run package                   dist/fai-browser-firefox-<version>.zip and its SHA-256
//   node scripts/package.mjs --out <dir>
//
// Reproducible: the Firefox build (scripts/build-firefox.mjs) is zipped with sorted entries, one fixed timestamp
// (SOURCE_DATE_EPOCH, else 2000-01-01) and fixed permissions (src/zip.js), so the same commit gives the same bytes with
// the same Node major. Left out: dot files, editor and OS leftovers, source maps and anything test-only
// (PACKAGE_EXCLUDED). The package and add-on versions must agree (package.json and extension/manifest.json).
//
// The Chromium extension is not packaged for a store: it is loaded unpacked from extension/ (see docs/guide/install.md).
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildFirefox } from './build-firefox.mjs';
import { createZip, zipTime } from '../src/zip.js';

export const ROOT = resolve(import.meta.dirname, '..');
/** Names never shipped in a package: tests, fixtures, source maps, dot files, OS and editor leftovers. */
export const PACKAGE_EXCLUDED = [/(^|\/)\./, /(^|\/)(test|tests|__tests__|fixtures)\//, /\.test\.[cm]?js$/, /\.map$/,
  /(^|\/)Thumbs\.db$/, /~$/, /\.(orig|rej|swp|bak)$/];

export function excluded(name) {
  return PACKAGE_EXCLUDED.some(pattern => pattern.test(name));
}

/** The versions that must agree for a release: `{ package, manifest }`; throws when they differ. */
export async function releaseVersion(root = ROOT) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const manifest = JSON.parse(await readFile(join(root, 'extension', 'manifest.json'), 'utf8')).version;
  if (pkg !== manifest) throw new Error(`package.json version ${pkg} and extension/manifest.json version ${manifest} differ`);
  return pkg;
}

/** Every file under `dir` as [{ name, data }] with "/" names, minus the excluded ones. */
export async function collectFiles(dir) {
  const names = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => relative(dir, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join('/'))
    .filter(name => !excluded(name))
    .sort();
  return Promise.all(names.map(async name => ({ name, data: await readFile(join(dir, name)) })));
}

/** Builds and zips the Firefox add-on. Resolves `{ version, path, sha256, files }`. */
export async function packageFirefox({ root = ROOT, out = join(root, 'dist'), env = process.env } = {}) {
  const version = await releaseVersion(root);
  const build = await mkdtemp(join(tmpdir(), 'fai-package-'));
  try {
    await buildFirefox({ root, out: build });
    const files = await collectFiles(build);
    const zip = createZip(files, { time: zipTime(env) });
    await mkdir(out, { recursive: true });
    const path = join(out, `fai-browser-firefox-${version}.zip`);
    await writeFile(path, zip);
    return { version, path, sha256: createHash('sha256').update(zip).digest('hex'), files: files.map(file => file.name) };
  } finally {
    await rm(build, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  try {
    const result = await packageFirefox({ out: values.out ? resolve(values.out) : undefined });
    console.log(`${result.path}\n  ${result.files.length} files, sha256 ${result.sha256}`);
    console.log('Sign it for Firefox: npm run sign:firefox (needs WEB_EXT_API_KEY and WEB_EXT_API_SECRET, see docs/PUBLISHING.md).');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
