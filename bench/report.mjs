#!/usr/bin/env node
// Benchmark report: node bench/report.mjs <resultsDir>... [--out bench/report/out/<name>] [--png] [--title "..."]
// Loads bench/compare.mjs result directories (old layout without `host` too) and QA corpus runs, writes data.json and
// a standalone index.html (inline CSS and SVG, no scripts or external URLs), and with --png renders it with headless
// Chromium. See bench/README.md, "Report".
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { buildData } from './report/data.mjs';
import { renderHtml } from './report/render.mjs';
import { renderPng } from './report/png.mjs';

export async function buildReport(dirs, { out, png = false, title } = {}) {
  const data = buildData(dirs, title ? { title } : {});
  const outDir = resolve(out ?? join(import.meta.dirname, 'report', 'out', data.date));
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'data.json'), `${JSON.stringify(data, null, 2)}\n`);
  await writeFile(join(outDir, 'index.html'), renderHtml(data));
  const pngs = png ? await renderPng(outDir) : null;
  return { data, outDir, pngs };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string' }, png: { type: 'boolean' }, title: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help || !positionals.length) {
    console.log('usage: node bench/report.mjs <resultsDir>... [--out DIR] [--png] [--title "..."]');
    process.exit(values.help ? 0 : 2);
  }
  const { data, outDir, pngs } = await buildReport(positionals, values);
  console.log(`report: ${join(outDir, 'index.html')}`);
  console.log(`data:   ${join(outDir, 'data.json')}`);
  if (values.png) {
    console.log(pngs ? `png:    ${pngs.full}\n        ${pngs.social}` : 'png:    skipped (playwright-core or Chromium not found)');
  }
  for (const host of data.hosts) {
    const r = data.ratios[host.id];
    const t = data.totals[host.id];
    console.log(`${host.id}: B ${t.b ? `${t.b.passed}/${t.b.attempted} ${t.b.wallS.toFixed(1)} s` : '-'} | A ${t.a ? `${t.a.passed}/${t.a.attempted} ${t.a.wallS.toFixed(1)} s` : '-'}${r?.wall ? ` | A/B wall ${r.wall.toFixed(2)}x over ${r.tasks.length} task(s)` : ''}`);
  }
  if (data.missing.length) {
    console.log(`missing cells: ${data.missing.length} (listed on the page)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
  });
}
