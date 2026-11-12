#!/usr/bin/env node
// Runs the test files that need no browser: every test/*.test.js that neither mentions a browser driver
// (playwright-core, CHROMIUM_PATH, a Chromium launch, a Firefox driven through Marionette) nor imports a test helper
// that does. The release workflow and the Windows and macOS CI jobs run this subset; CI on Linux and contributors run
// the full `npm test` with Chromium.
//   npm run test:browserless             run them (concurrency 2, kind to small machines)
//   node scripts/test-browserless.mjs --list
//   npm run test:browserless -- --test-timeout=120000   node's --test-* options pass through
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
export const BROWSER_PATTERN = /playwright|CHROMIUM_PATH|launchPersistentContext|chromium\.launch|Marionette\.connect/;

/** The browserless test files under `root`/test, sorted. */
export function browserlessTests(root = ROOT) {
  const dir = join(root, 'test');
  const read = name => readFileSync(join(dir, name), 'utf8');
  const helperUsesBrowser = new Map();
  const usesBrowser = (source, seen = new Set()) => {
    if (BROWSER_PATTERN.test(source)) return true;
    for (const [, helper] of source.matchAll(/from '\.\/(helpers\/[^']+)'/g)) {
      if (seen.has(helper)) continue;
      seen.add(helper);
      if (!helperUsesBrowser.has(helper)) {
        let text = '';
        try { text = read(helper); } catch { /* not a file */ }
        helperUsesBrowser.set(helper, usesBrowser(text.replaceAll("from './", "from './helpers/"), seen));
      }
      if (helperUsesBrowser.get(helper)) return true;
    }
    return false;
  };
  return readdirSync(dir).filter(name => name.endsWith('.test.js')).sort()
    .filter(name => !usesBrowser(read(name)))
    .map(name => join('test', name));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = browserlessTests();
  if (process.argv.includes('--list')) {
    console.log(files.join('\n'));
  } else {
    // Node's own --test-* options pass through (CI: --test-timeout, so a hung test fails by name instead of the job).
    const extra = process.argv.slice(2).filter(arg => /^--test-[a-z-]+(=.*)?$/.test(arg));
    const child = spawn(process.execPath, ['--test', '--test-concurrency=2', ...extra, ...files],
      { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  }
}
