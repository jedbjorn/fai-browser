#!/usr/bin/env node
// False-positive sweep for secret redaction: observes every fixture page (fixtures/, without fixtures/secrets) with
// extension/page.js in headless Chromium, Standard mode (or --strict), and lists every placeholder it wrote, split by
// whether the page counts as a secret page. Expected: none outside secret pages.
//   node scripts/secret-sweep.mjs [--strict] [--json]
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { headlessEnv } from './headless-env.mjs';
import { startStaticSite } from '../test/helpers/static-site.js';

const { values: args } = parseArgs({ options: { strict: { type: 'boolean' }, json: { type: 'boolean' } } });
const ROOT = new URL('../fixtures/', import.meta.url).pathname;
const PAGE_SCRIPT = new URL('../extension/page.js', import.meta.url).pathname;

function pages(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (relative(ROOT, path) !== 'secrets') out.push(...pages(path));
    } else if (name.endsWith('.html')) out.push(`/${relative(ROOT, path)}`);
  }
  return out;
}

const site = await startStaticSite(ROOT);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
  env: headlessEnv(), args: ['--no-sandbox'] });
const report = { pages: 0, failed: [], secretPages: [], hits: [], secretPageHits: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  for (const path of pages(ROOT)) {
    const page = await context.newPage();
    try {
      await page.goto(site.origin + path, { waitUntil: 'load', timeout: 10_000 });
      await page.waitForTimeout(100);
      await page.addScriptTag({ path: PAGE_SCRIPT });
      const observation = await page.evaluate(mode => {
        globalThis.__faiPage.useSecrets({ mode, relaxed: [], salt: 'sweep' });
        return globalThis.__faiPage.observe({});
      }, args.strict ? 'strict' : 'standard');
      report.pages++;
      const secretPage = observation.warnings.includes('secret_page');
      if (secretPage) report.secretPages.push(path);
      const json = JSON.stringify(observation);
      for (const match of json.matchAll(/.{0,50}\[secret:[^\]]*\].{0,20}/g)) {
        (secretPage ? report.secretPageHits : report.hits).push(`${path}: ${match[0]}`);
      }
    } catch (error) {
      report.failed.push(`${path}: ${String(error.message).split('\n')[0]}`);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await site.close();
}
if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${report.pages} pages observed (${args.strict ? 'Strict' : 'Standard'}), ${report.failed.length} failed to load`);
  console.log(`secret pages: ${report.secretPages.length}${report.secretPages.length ? ` (${report.secretPages.join(', ')})` : ''}`);
  console.log(`placeholders outside secret pages: ${report.hits.length}`);
  for (const hit of report.hits) console.log(`  ${hit}`);
  console.log(`placeholders on secret pages: ${report.secretPageHits.length}`);
  for (const hit of report.secretPageHits) console.log(`  ${hit}`);
  for (const failure of report.failed) console.log(`  failed: ${failure}`);
}
