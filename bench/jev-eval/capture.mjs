#!/usr/bin/env node
// Capture the observations behind bench/jev-eval/cases.mjs into test/fixtures/jev/cases.json.
//   node bench/jev-eval/capture.mjs [--out test/fixtures/jev/cases.json]
// Headless Chromium (CHROMIUM_PATH, default /usr/bin/chromium) loads each case's page from https://lanternfish.test
// (fixtures/site/ plus bench/jev-eval/pages/ under /jev/, served by request interception, no network), injects
// extension/page.js and records its observation exactly as the extension would send it (bounds dropped). No model
// is called.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { headlessEnv } from '../../scripts/headless-env.mjs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { CASES, ORIGIN } from './cases.mjs';
import { instructionTerms } from '../../src/oversight.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SITE = join(ROOT, 'fixtures', 'site');
const PAGES = join(import.meta.dirname, 'pages');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const { values: args } = parseArgs({ options: { out: { type: 'string', default: join(ROOT, 'test', 'fixtures', 'jev', 'cases.json') } } });

function fileFor(pathname) {
  const [root, rest] = pathname.startsWith('/jev/') ? [PAGES, pathname.slice(5)] : [SITE, pathname];
  const file = normalize(join(root, decodeURIComponent(rest)));
  return file.startsWith(root + sep) ? file : null;
}

const pageScript = await readFile(join(ROOT, 'extension', 'page.js'), 'utf8');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv() });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== ORIGIN || route.request().method() !== 'GET') return route.fulfill({ status: 405, body: '' });
  const file = fileFor(url.pathname);
  try {
    const body = await readFile(file);
    return route.fulfill({ status: 200, body, headers: { 'Content-Type': TYPES[extname(file)] ?? 'text/plain' } });
  } catch {
    return route.fulfill({ status: 404, body: 'Not found' });
  }
});

const out = [];
try {
  for (const spec of CASES) {
    const page = await context.newPage();
    await page.goto(ORIGIN + spec.path, { waitUntil: 'load' });
    if (spec.setup?.select) await page.selectOption(spec.setup.select[0], spec.setup.select[1]);
    if (spec.setup?.fill) await page.fill(spec.setup.fill[0], spec.setup.fill[1]);
    await page.addScriptTag({ content: pageScript });
    const terms = instructionTerms(spec.instruction);
    // Guardrail additions reach the page script as the runtime sends them (src/guardrails.js wire()).
    const forbid = spec.guardrails?.forbid ?? [];
    const observation = await page.evaluate(([t, f]) => globalThis.__faiPage.observe({ terms: t, forbid: f }), [terms, forbid]);
    for (const control of observation.controls) delete control.bounds;
    delete observation.viewport;
    const { setup, ...rest } = spec;
    out.push({ ...rest, observation });
    await page.close();
    process.stderr.write(`${spec.id}: ${observation.controls.length} controls${observation.consent ? ', consent' : ''}\n`);
  }
} finally {
  await browser.close();
}
await mkdir(dirname(args.out), { recursive: true });
await writeFile(args.out, `${JSON.stringify({ capturedAt: new Date().toISOString(), origin: ORIGIN, cases: out }, null, 1)}\n`);
process.stderr.write(`wrote ${out.length} cases to ${args.out}\n`);
