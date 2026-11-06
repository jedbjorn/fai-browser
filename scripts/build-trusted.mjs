#!/usr/bin/env node
// Builds the trusted-input variant of the Chromium extension: extension/ copied to dist/trusted/ (or --out <dir>) with
// the `debugger` permission added. Only this build can offer Advanced, "Trusted input" (extension/trusted-input.js):
// Chrome does not allow `debugger` as an optional permission, so the regular extension never carries it and never
// shows its install warning ("Access the page debugger backend", "Read and change all your data on all websites").
// The key stays the same, so the extension ID (and native pairing) does not change; load one variant at a time.
//   node scripts/build-trusted.mjs                dist/trusted/
//   node scripts/build-trusted.mjs --out <dir>
// See docs/REFERENCE.md "Detection".
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** The trusted-input manifest for the Chromium manifest `chrome`; a new object. */
export function trustedManifest(chrome) {
  const manifest = structuredClone(chrome);
  manifest.permissions = [...new Set([...(manifest.permissions ?? []), 'debugger'])];
  return manifest;
}

export async function buildTrusted({ root = resolve(import.meta.dirname, '..'), out } = {}) {
  const target = resolve(out ?? join(root, 'dist', 'trusted'));
  const source = join(root, 'extension');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
  const chrome = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  await writeFile(join(target, 'manifest.json'), `${JSON.stringify(trustedManifest(chrome), null, 2)}\n`);
  return target;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  const out = await buildTrusted({ out: values.out });
  console.log(`Trusted-input extension built in ${out}`);
  console.log('Load it unpacked in place of extension/, then turn on Advanced, Trusted input in the FAI Browser popup.');
}
