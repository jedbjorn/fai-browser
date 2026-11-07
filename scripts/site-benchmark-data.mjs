#!/usr/bin/env node
// Reproduce the public trial figures from the sanitized, checked-in measurements.
// Run: node scripts/site-benchmark-data.mjs
// Historical fixture charts are retained as artifacts, not refreshed or claimed here.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const data = JSON.parse(readFileSync(resolve(root, 'site/media/evidence/public-pilots-2026-11-07.json'), 'utf8'));
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const number = value => value.toLocaleString('en-US');
const series = [['fai', 'FAI Agent direct'], ['playwright', 'Playwright MCP']];
for (const pair of data.pairs) for (const [id] of series) {
  const run = pair[id];
  for (const key of ['wallMs', 'toolCalls', 'inputTokens', 'cachedInputTokens', 'uncachedInputTokens', 'outputTokens']) {
    if (!Number.isFinite(run[key]) || run[key] < 0) throw new Error(`Invalid ${pair.task}/${id}/${key}`);
  }
  if (run.inputTokens - run.cachedInputTokens !== run.uncachedInputTokens) throw new Error('Fresh input mismatch');
}
const metrics = [['wall', 'Wall time', 'seconds', run => run.wallMs / 1000, value => `${value.toFixed(2)} s`], ['fresh', 'Fresh input', 'uncached input tokens', run => run.uncachedInputTokens, value => `${number(value)} tokens`]];
const charts = metrics.map(([id, label, unit, get, format]) => {
  const max = Math.max(...data.pairs.flatMap(pair => series.map(([key]) => get(pair[key]))));
  return `<div class="pilot-charts" data-chart-metric="${id}"${id === 'fresh' ? ' hidden' : ''}><p class="metric-caption">${label} · lower is better · common zero baseline, shared scale across all three tasks</p><div class="pilot-grid">${data.pairs.map(pair => `<article class="pilot-card"><div class="pilot-card-heading"><h3>${esc(pair.label)}</h3><span>Partial result</span></div>${series.map(([key, name]) => `<div class="pilot-series ${key}"><div><span>${name}</span><strong>${format(get(pair[key]))}</strong></div><div class="pilot-track" aria-hidden="true"><span style="width:${(get(pair[key]) / max * 100).toFixed(4)}%"></span></div></div>`).join('')}<p class="pilot-scale">0 → ${format(max)}</p><p class="pilot-outcome">${esc(pair.outcome)}</p></article>`).join('')}</div></div>`;
}).join('\n');
const table = `<details class="pilot-method"><summary>Exact values as a table</summary><div class="pilot-table-wrap" tabindex="0" role="region" aria-label="Measurements table; scroll horizontally on small screens"><table><caption>Elapsed wall time and model usage. Fresh input = total input − cached input. Output tokens are separate.</caption><thead><tr><th scope="col">Task / tool</th><th scope="col">Wall (ms)</th><th scope="col">Calls</th><th scope="col">Fresh input</th><th scope="col">Cached input</th><th scope="col">Total input</th><th scope="col">Output</th></tr></thead><tbody>${data.pairs.flatMap(pair => series.map(([key, name]) => {const r = pair[key]; return `<tr><th scope="row">${esc(pair.label)} / ${name}</th><td>${r.wallMs}</td><td>${r.toolCalls}</td><td>${number(r.uncachedInputTokens)}</td><td>${number(r.cachedInputTokens)}</td><td>${number(r.inputTokens)}</td><td>${number(r.outputTokens)}</td></tr>`;})).join('')}</tbody></table></div></details>`;
const path = resolve(root, 'site/index.html');
const html = readFileSync(path, 'utf8');
const begin = '<!-- public-pilots:begin -->';
const end = '<!-- public-pilots:end -->';
if (!html.includes(begin) || !html.includes(end)) throw new Error('Missing public trial figure markers');
writeFileSync(path, html.slice(0, html.indexOf(begin) + begin.length) + '\n' + charts + '\n' + table + '\n      ' + html.slice(html.indexOf(end)));
console.log('Reproduced public trial charts and exact-value table from sanitized measurements.');
