// bench/report.mjs: builds the report from the result directories present in bench/results and checks it against
// a known summary, the standalone-page rules and (when a browser is available) the PNG step.
import test from 'node:test';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildReport } from '../bench/report.mjs';
import { buildData } from '../bench/report/data.mjs';
import { renderHtml } from '../bench/report/render.mjs';
import { loadChromium } from '../bench/report/png.mjs';

const RESULTS = resolve(import.meta.dirname, '..', 'bench', 'results');
const SETS = ['2026-10-03T22-35-28-967', '2026-10-03T23-35-50-786', '2026-10-04-oversight-2', '2026-10-04-matrix-1',
  '2026-10-04-matrix-1-baseline', 'qa-2026-10-04T08-59-59-162Z-full'].map(name => join(RESULTS, name)).filter(existsSync);
const OVERSIGHT = join(RESULTS, '2026-10-04-oversight-2');
const SOL = 'codex:gpt-6.1-sol:medium';

const tmp = () => mkdtempSync(join(tmpdir(), 'fai-bench-report-'));

test('totals match summary.json for 2026-10-04-oversight-2', { skip: !existsSync(OVERSIGHT) && 'result set absent' }, () => {
  const data = buildData([OVERSIGHT]);
  const summary = JSON.parse(readFileSync(join(OVERSIGHT, 'summary.json'), 'utf8')).totals.b;
  const b = data.totals[SOL].b;
  assert.equal(b.passed, 24);
  assert.equal(b.attempted, 24);
  assert.equal(b.passed, summary.passed);
  assert.ok(Math.abs(b.wallS - 144.5) < 0.05, `wall ${b.wallS}`);
  assert.ok(Math.abs(b.wallS - summary.wallS) < 1e-6);
  assert.equal(b.toolCalls, 8);
  assert.equal(b.requests, 16);
  assert.equal(b.tokens, summary.tokens);
  assert.ok(Math.abs(b.priced - summary.priced) < 1e-6);
  assert.equal(b.oversight.receipts, summary.receipts);
  assert.equal(b.oversight.falseAutomation, 0);
  // B only: A is reported missing and no ratio is invented.
  assert.equal(data.totals[SOL].a, null);
  assert.equal(data.ratios[SOL], null);
  assert.ok(data.missing.some(m => m.host === SOL && m.condition === 'a' && m.kind === 'all'));
  assert.match(renderHtml(data), /Missing cells/);
});

test('report over every present set: data.json, standalone HTML, no external URLs', { skip: !SETS.length && 'no result sets' }, async () => {
  const out = tmp();
  try {
    const { data } = await buildReport(SETS, { out });
    const written = JSON.parse(readFileSync(join(out, 'data.json'), 'utf8'));
    assert.deepEqual(written.taskIds, data.taskIds);
    assert.ok(data.hosts.length >= 1);
    // Old layout without `host` defaults to Sol at medium.
    assert.ok(data.hosts.some(host => host.id === SOL));
    // Dedupe: never more than one record per (task, condition, host, rep).
    for (const cell of data.cells) {
      assert.ok(cell.runs <= data.expectedReps, `${cell.host} ${cell.condition} ${cell.taskId}`);
    }
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(html, /<title>[^<]{3,60}<\/title>/);
    const words = /<title>([^<]+)<\/title>/.exec(html)[1].trim().split(/\s+/).length;
    assert.ok(words >= 2 && words <= 4);
    assert.doesNotMatch(html, /https?:\/\//i, 'no absolute URLs');
    assert.doesNotMatch(html, /<script|<link|@import|url\(/i, 'no scripts, stylesheets or CSS url()');
    assert.doesNotMatch(html, /\bsrc=/i);
    assert.match(html, /prefers-color-scheme:dark\)\{:root:not\(\[data-theme="light"\]\)/);
    assert.match(html, /:root\[data-theme="dark"\]/);
    assert.match(html, /body\{[^}]*background:/);
    // No answers from traces leak into the page.
    const rawRuns = join(OVERSIGHT, 'runs.jsonl');
    const rows = existsSync(rawRuns)
      ? readFileSync(rawRuns, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      : JSON.parse(readFileSync(join(OVERSIGHT, 'summary.json'), 'utf8')).runs ?? [];
    for (const row of rows.slice(0, 8)) {
      if (row.answer && row.answer.length > 6) {
        assert.ok(!html.includes(row.answer), 'answer text on the page');
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('PNG step writes the full page and the social crop', async t => {
  if (!SETS.length) {
    t.skip('no result sets');
    return;
  }
  if (!(await loadChromium())) {
    t.skip('playwright-core or Chromium not available');
    return;
  }
  const out = tmp();
  try {
    const { pngs } = await buildReport(SETS, { out, png: true });
    assert.ok(pngs);
    for (const file of [pngs.full, pngs.social]) {
      assert.ok(existsSync(file) && statSync(file).size > 10_000, file);
    }
    const header = readFileSync(pngs.social);
    assert.equal(header.readUInt32BE(16), 1080);
    assert.equal(header.readUInt32BE(20), 1350);
    assert.equal(readFileSync(pngs.full).readUInt32BE(16), 1600);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

function syntheticData(n) {
  const names = ['Sol', 'Astra', 'Opus 5.5', 'Sonnet 5.5', 'Luna', 'Terra', 'Nova', 'Vega'].slice(0, n);
  const hosts = names.map((short, i) => ({ id: `h${i}:${short}`, name: `GPT ${short}`, short, effort: 'medium' }));
  const tot = (k, pass) => {
    const passed = Math.round(24 * pass);
    return { tasks: 8, taskCount: 8, attempted: 24, passed, safeVerified: passed, safeVerifiedUnknown: 0, passRate: pass,
      wallS: 100 * k, toolCalls: 40 * k, requests: 50 * k, costUsd: 0.4 * k, costUsdPerSafeVerified: 0.4 * k / passed,
      cachedInputPerSafeVerified: 2000, cacheWritePerSafeVerified: 100, uncachedInputPerSafeVerified: 500,
      outputTokensPerSafeVerified: 50, tokens: 1e5, priced: 5e4, wallPerTask: 12 * k, costPerTask: 0.05 * k,
      warmFloor: { costUsd: 0.04 * k, uncached: 1000 }, uncachedWarm: { n: 3 } };
  };
  const data = { title: 'Synthetic Bench', date: '2026-10-04', hosts, taskIds: ['t1', 't2'], expectedReps: 3, cells: [], missing: [], ignored: [], corpus: [], sets: [],
    conditions: { a: 'Playwright MCP', b: 'FAI Browser' }, prices: {}, dedupe: { replaced: 0, records: 0 }, totals: {}, ratios: {}, headline: { fastestHost: hosts[0].id } };
  hosts.forEach((h, i) => {
    data.totals[h.id] = { a: tot(2 + i / 4, 1), b: tot(1, i === 4 ? 0.8 : 1) };
    data.ratios[h.id] = { wall: 1.2 + i / 10, toolCalls: 5, requests: 3, cost: 1.3, costSafeVerified: 1.3,
      tokens: 2, priced: 2, tasks: ['t1', 't2'], complete: true };
  });
  return data;
}

test('six-host synthetic data: host strip, tier note and all four panels in the social crop', async t => {
  const data = syntheticData(6);
  const html = renderHtml(data);
  assert.equal((html.match(/class="hc[ "]/g) ?? []).length, 6);
  assert.match(html, /Tier limitation under study/);
  for (const title of ['Wall time', 'Tool calls', 'Model requests', 'Cost']) {
    assert.match(html, new RegExp(`<h3>${title}</h3>`));
  }
  const found = await loadChromium();
  if (!found) {
    t.skip('playwright-core or Chromium not available');
    return;
  }
  const out = tmp();
  const browser = await found.chromium.launch({ executablePath: found.executablePath, headless: true, env: headlessEnv() });
  try {
    for (const n of [6, 8]) {
      const page = await browser.newPage({ viewport: { width: 1080, height: 1350 } });
      await page.setContent(renderHtml(syntheticData(n)));
      await page.evaluate(() => document.documentElement.classList.add('social'));
      const boxes = await page.evaluate(() => [...document.querySelectorAll('.chart')].map(el => {
        const r = el.getBoundingClientRect();
        return { title: el.querySelector('h3').textContent, bottom: r.bottom, visible: getComputedStyle(el).display !== 'none' };
      }));
      assert.deepEqual(boxes.map(b => b.title), ['Wall time', 'Tool calls', 'Model requests', 'Cost']);
      for (const b of boxes) {
        assert.ok(b.visible && b.bottom <= 1350, `${n} hosts: ${b.title} bottom ${b.bottom}`);
      }
      const bar = await page.evaluate(() => { const r = document.querySelector('.hostbar').getBoundingClientRect(); return [r.height, r.bottom]; });
      assert.ok(bar[0] > 0 && bar[1] < 1350);
      await page.close();
    }
  } finally {
    await browser.close();
    rmSync(out, { recursive: true, force: true });
  }
});
