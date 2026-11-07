#!/usr/bin/env node
// Usage: node bench/report/results-md.mjs [data.json] > section.md
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const fmt = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const count = value => fmt(value, 1).replace(/\.0$/, '');
const ratio = value => Number.isFinite(value) ? `${value.toFixed(2)}×` : '—';
const safe = text => String(text).replace(/[\r\n|<>]/g, ' ');
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.join(' | ')} |`).join('\n');

export function renderResults(data) {
  if (!Array.isArray(data.hosts) || !Array.isArray(data.taskIds) || !data.totals || !data.ratios) throw new Error('Invalid report data');
  const out = ['## Measured comparison', '',
    `${data.taskIds.length} local fixture tasks; per-task medians of up to ${data.expectedReps} repeats. Suite totals sum those medians; per-task values divide by tasks run. Pass counts include all graded repeats, including failures. The current harness uses a contiguous timeline per host × condition with an excluded warm-up. This report can also include older runs with unknown cache phase and targeted reruns without warm-up; it is not a single uniform timeline experiment. Wall time includes host start-up through exit. Prices come from bench/prices.json (${safe(data.prices?.date ?? 'undated')}); Claude costs use list prices and Codex costs are API-equivalent, not subscription charges. Requests are shown both as recorded and adjusted: Codex adds one request per run with a tool call for the hidden MCP schema load; Claude is unchanged. A/B ratios compare Playwright MCP (A) with FAI Browser (B) on shared tasks; values above 1 favour FAI.`, ''];
  for (const host of data.hosts) {
    const totals = data.totals[host.id] ?? {};
    const r = data.ratios[host.id];
    out.push(`### ${safe(host.name)} (${safe(host.effort)})`, '', table(
      ['Condition', 'Pass', 'Safe verified', 'Wall s', 'Tool calls', 'Requests', 'Requests adjusted', 'Cost $', 'A/B wall', 'A/B cost'],
      ['a', 'b'].map(cond => {
        const t = totals[cond];
        return [cond === 'a' ? 'Playwright MCP' : 'FAI Browser', t ? `${t.passed}/${t.attempted}` : '—',
          t ? `${t.safeVerified}/${t.attempted}` : '—', fmt(t?.wallS), count(t?.toolCalls), count(t?.requests),
          count(t?.requestsAdjusted), fmt(t?.costUsd, 6), cond === 'b' ? ratio(r?.wall) : '—', cond === 'b' ? ratio(r?.cost) : '—'];
      })), '');
    out.push('#### Cache and cost per safe verified success', '', table(
      ['Condition', 'Unknown success', 'Cached in', 'Cache write', 'Uncached in', 'Output', 'Cost $'], ['a', 'b'].map(cond => {
        const t = totals[cond];
        return [cond === 'a' ? 'Playwright MCP' : 'FAI Browser', count(t?.safeVerifiedUnknown),
          count(t?.cachedInputPerSafeVerified), count(t?.cacheWritePerSafeVerified), count(t?.uncachedInputPerSafeVerified),
          count(t?.outputTokensPerSafeVerified), fmt(t?.costUsdPerSafeVerified, 6)];
      })), '');
    out.push(table(['Condition', 'Cached in (suite)', 'Cache write (suite)', 'Uncached in (suite)', 'Output (suite)',
      'Tokens (suite)', 'Priced tokens (suite)', 'Warm mean $/run (n)', 'Cold mean $/run (n)'], ['a', 'b'].map(cond => {
      const t = totals[cond];
      const phase = name => Number.isFinite(t?.[`cost${name}`]) ? `${fmt(t[`cost${name}`], 6)} (${t[`uncached${name}`]?.n ?? '—'})` : '—';
      return [cond === 'a' ? 'Playwright MCP' : 'FAI Browser', count(t?.cachedInput), count(t?.cacheWrite),
        count(t?.uncachedInput), count(t?.outputTokens), count(t?.tokens), fmt(t?.priced, 1), phase('Warm'), phase('Cold')];
    })), '');
  }
  out.push('### Across hosts', '', 'Wall values below are suite totals divided by tasks run. Cost uses actual measured-run cost divided by fully known safe verified successes. Each host has its own price; no cross-model cost average is implied.', '', table(
    ['Host', 'Pass A / B', 'Wall s/task A / B', 'Cost $/safe verified success A / B', 'A/B wall', 'A/B calls', 'A/B requests raw / adjusted', 'A/B cost'],
    data.hosts.map(host => {
      const { a, b } = data.totals[host.id] ?? {};
      const r = data.ratios[host.id];
      const per = (t, key, digits) => fmt(t?.tasks && Number.isFinite(t[key]) ? t[key] / t.tasks : null, digits);
      return [safe(host.name), `${a ? `${a.passed}/${a.attempted}` : '—'} / ${b ? `${b.passed}/${b.attempted}` : '—'}`,
        `${per(a, 'wallS', 1)} / ${per(b, 'wallS', 1)}`,
        `${fmt(a?.costUsdPerSafeVerified, 6)} / ${fmt(b?.costUsdPerSafeVerified, 6)}`, ratio(r?.wall), ratio(r?.toolCalls),
        `${ratio(r?.requests)} / ${ratio(r?.requestsAdjusted)}`, ratio(r?.costSafeVerified)];
    })), '',
    'Safe verified requires a strict pass and no recorded safety failure; FAI conditions also require a completed final receipt with verification.passed true, while A uses its independent grade. Per-success usage and cost include every measured run, failures too; unknown success status or incomplete metric coverage is shown as —, and unreported cache writes are not zero. Codex usage is cumulative per exec, so these summaries do not attribute its cache reads to individual requests.', '',
    'Priced tokens are weighted equivalents (uncached input × 1, cached input × 0.1, cache write × 1.25, output × 5), not dollar prices. Warm/cold costs are means of individual runs, not suite medians; missing phases are shown as —. A cold sample is not necessarily more expensive when the tasks differ.', '',
    `Sources: ${(data.sets ?? []).map(set => `\`${safe(set.source)}\``).join(', ')}. Overlapping task/host/condition/repeat records use the newer result.`, '');
  if (data.missing?.length) out.push(`Incomplete coverage: ${data.missing.length} missing-cell or repeat notices in data.json; ratios use shared tasks only.`, '');
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 3) throw new Error('Usage');
    const file = process.argv[2] ?? resolve(import.meta.dirname, 'out/all-hosts/data.json');
    process.stdout.write(renderResults(JSON.parse(readFileSync(file, 'utf8'))));
  } catch {
    console.error('Could not render report. Usage: node bench/report/results-md.mjs [data.json]');
    process.exitCode = 1;
  }
}
