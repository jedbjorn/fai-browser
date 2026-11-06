// Bench timeline ordering, warm-up exclusion, adjusted request counts, the warm/cold cache split and the report fields
// built on them (bench/lib/schedule.mjs, bench/lib/metrics.mjs, bench/report/data.mjs). Offline, no host sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSchedule, cachePhase, cacheTtlS, orderLine } from '../bench/lib/schedule.mjs';
import { adjustedRequests, aggregate, cacheStats, markdownTable, quantile } from '../bench/lib/metrics.mjs';
import { CACHE_TRIM_FEATURES, codexArgs } from '../bench/lib/codex.mjs';
import { claudeRunEnv } from '../bench/lib/claude.mjs';
import { buildData } from '../bench/report/data.mjs';
import { renderHtml } from '../bench/report/render.mjs';

const host = (vendor, model) => ({ vendor, model, effort: 'low', id: `${vendor}:${model}:low` });
const LUNA = host('codex', 'gpt-6-luna');
const SONNET = host('claude', 'claude-sonnet-5-5');
const T = id => ({ id });
const tasks = [T('t1'), T('t2')];
const label = item => `${item.warmup ? 'W:' : ''}${item.task.id}/${item.condition}/${item.host.vendor}${item.warmup ? '' : `#${item.rep}`}`;

test('contiguous schedule: one timeline per host x condition, warm-up first, ABBA per host', () => {
  const items = buildSchedule({ hosts: [LUNA, SONNET], conditions: ['a', 'b'], tasks, repeat: 2, warmupTask: T('w') });
  assert.equal(items.length, 2 * 2 * (1 + 2 * 2));
  assert.deepEqual(items.slice(0, 5).map(label), ['W:w/a/codex', 't1/a/codex#1', 't2/a/codex#1', 't1/a/codex#2', 't2/a/codex#2']);
  // Each timeline is contiguous: once it ends it never comes back.
  const order = [...new Set(items.map(item => item.timeline))];
  assert.deepEqual(order, ['codex:gpt-6-luna:low|a', 'codex:gpt-6-luna:low|b', 'claude:claude-sonnet-5-5:low|b',
    'claude:claude-sonnet-5-5:low|a']);
  for (const key of order) {
    const at = items.map((item, i) => (item.timeline === key ? i : -1)).filter(i => i >= 0);
    assert.equal(at.at(-1) - at[0] + 1, at.length, `${key} contiguous`);
    assert.equal(items[at[0]].warmup, true, `${key} starts with its warm-up`);
  }
  // --no-abba keeps A before B on every host; --warmup 0 drops warm-ups; default warm-up task is the first task.
  const plain = buildSchedule({ hosts: [LUNA, SONNET], conditions: ['a', 'b'], tasks, abba: false, warmup: 0 });
  assert.deepEqual([...new Set(plain.map(item => item.condition + item.host.vendor))], ['acodex', 'bcodex', 'aclaude', 'bclaude']);
  assert.ok(!plain.some(item => item.warmup));
  assert.equal(buildSchedule({ hosts: [LUNA], conditions: ['b'], tasks })[0].task.id, 't1');
});

test('interleave schedule keeps the old rep -> task -> host -> condition order and no warm-up by default', () => {
  const items = buildSchedule({ hosts: [LUNA, SONNET], conditions: ['a', 'b'], tasks, repeat: 2, order: 'interleave' });
  const expected = [];
  for (let rep = 1; rep <= 2; rep++) {
    for (const task of tasks) {
      for (const h of [LUNA, SONNET]) {
        for (const condition of ['a', 'b']) {
          expected.push(`${task.id}/${condition}/${h.vendor}#${rep}`);
        }
      }
    }
  }
  assert.deepEqual(items.map(label), expected);
  assert.throws(() => buildSchedule({ hosts: [LUNA], conditions: ['a'], tasks, order: 'random' }), /order must be/);
  assert.match(orderLine({ order: 'interleave', warmup: 0 }), /^order: interleave \(per-task alternation\)/);
  assert.match(orderLine({ order: 'contiguous', warmup: 1, warmupTask: 'w', abba: true, stablePaths: true, claudeCacheTtl: '5m' }),
    /contiguous per host×condition, ABBA, warm-up 1 \(w, excluded\), stable paths, claude cache TTL 5m/);
});

test('cache phase: cold on the first run, after a gap over the TTL or a condition switch; warm otherwise', () => {
  assert.equal(cachePhase({ state: null, condition: 'a', nowMs: 0, ttlS: 300 }).phase, 'cold');
  const state = { endedAt: 1_000_000 };
  assert.deepEqual(cachePhase({ state, lastOnHost: 'a', condition: 'a', nowMs: 1_002_000, ttlS: 300 }), { phase: 'warm', gapS: 2, why: null });
  assert.equal(cachePhase({ state, lastOnHost: 'a', condition: 'a', nowMs: 1_000_000 + 301_000, ttlS: 300 }).phase, 'cold');
  assert.equal(cachePhase({ state, lastOnHost: 'b', condition: 'a', nowMs: 1_002_000, ttlS: 300 }).phase, 'cold');
  assert.equal(cacheTtlS(LUNA), 1800);
  assert.equal(cacheTtlS(SONNET, '5m'), 300);
  assert.equal(cacheTtlS(SONNET, 'default'), 3600);
});

test('requestsAdjusted: +1 for a Codex run with an MCP call, raw otherwise', () => {
  assert.equal(adjustedRequests({ host: LUNA.id, hostVendor: 'codex', requests: 2, toolCalls: 1 }), 3);
  assert.equal(adjustedRequests({ host: LUNA.id, hostVendor: 'codex', requests: 1, toolCalls: 0 }), 1);
  assert.equal(adjustedRequests({ host: SONNET.id, hostVendor: 'claude', requests: 3, toolCalls: 2 }), 3);
  assert.equal(adjustedRequests({ requests: 2, toolCalls: 1 }), 3, 'legacy record without host is Codex');
  assert.equal(adjustedRequests({ host: LUNA.id, requests: null, toolCalls: 1 }), null);
  assert.equal(adjustedRequests({ host: LUNA.id, requests: 2, toolCalls: 1, requestsAdjusted: 7 }), 7);
  const summary = aggregate([
    { taskId: 't', condition: 'b', host: LUNA.id, hostVendor: 'codex', outcome: 'ok', pass: true, wallMs: 1000, toolCalls: 1, requests: 2, tokens: { input: 10, output: 1 } },
  ], ['t'], ['b']);
  assert.equal(summary.cells['t|b'].requests, 2);
  assert.equal(summary.cells['t|b'].requestsAdjusted, 3);
  assert.match(markdownTable(summary, ['t'], ['b']), /\| Requests \| Req\. adj\. \|/);
});

test('codex args: the five trim features go off with -c features.<name>=false, only when listed', () => {
  const base = { model: 'm', effort: 'low', workdir: '/w', finalPath: '/f', server: { command: 'x' }, serverName: 's' };
  const all = codexArgs({ ...base, features: new Set(CACHE_TRIM_FEATURES) });
  for (const feature of CACHE_TRIM_FEATURES) {
    assert.ok(all.includes(`features.${feature}=false`), feature);
  }
  const some = codexArgs({ ...base, features: new Set(['goals']) });
  assert.deepEqual(some.filter(arg => arg.startsWith('features.')), ['features.goals=false']);
  assert.ok(!codexArgs({ ...base, features: null, keepBuiltins: true }).some(arg => arg.startsWith('features.')));
  assert.equal(claudeRunEnv({ A: '1' }, '5m').CLAUDE_CODE_PROMPT_CACHE_TTL, '5m');
  assert.equal('CLAUDE_CODE_PROMPT_CACHE_TTL' in claudeRunEnv({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' }, 'default'), false);
});

// Synthetic runs.jsonl: one host x condition timeline, a warm-up, one cold run and three warm runs.
const run = (taskId, rep, extra) => ({
  taskId, condition: 'b', rep, host: LUNA.id, hostVendor: 'codex', outcome: 'ok', pass: true, wallMs: 10_000,
  toolCalls: 1, requests: 2, ...extra,
});
const tok = (input, cached) => ({ input, cachedInput: cached, output: 100, total: input + 100 });
const ROWS = [
  run('t1', 1, { cachePhase: 'cold', tokens: tok(30_000, 10_000), cost: { usd: 0.04 } }),
  run('t2', 1, { cachePhase: 'warm', tokens: tok(30_000, 26_000), cost: { usd: 0.014 } }),
  run('t1', 2, { cachePhase: 'warm', tokens: tok(30_000, 24_000), cost: { usd: 0.02 } }),
  run('t2', 2, { cachePhase: 'warm', tokens: tok(30_000, 22_000), cost: { usd: 0.024 } }),
];
const WARMUP = run('t1', 0, { warmup: true, cachePhase: 'cold', tokens: tok(40_000, 0), cost: { usd: 0.09 } });

test('warm/cold split and warm floor on a synthetic runs.jsonl; warm-up runs are excluded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fai-bench-cache-'));
  try {
    writeFileSync(join(dir, 'runs.jsonl'), [...ROWS, WARMUP].map(row => JSON.stringify(row)).join('\n'));
    const rows = readFileSync(join(dir, 'runs.jsonl'), 'utf8').split('\n').map(line => JSON.parse(line));
    const key = `b/${LUNA.id}`;
    const records = rows.map(row => ({ ...row, condition: key }));
    const summary = aggregate(records, ['t1', 't2'], [key]);
    assert.equal(summary.cells[`t1|${key}`].attempted, 2, 'warm-up not in the cells');
    const cache = cacheStats(records, [key])[key];
    assert.equal(cache.runs, 4);
    assert.equal(cache.cold.n, 1);
    assert.equal(cache.warm.n, 3);
    assert.equal(cache.unknown, 0);
    assert.equal(cache.cold.uncachedMean, 20_000);
    assert.equal(cache.warm.uncachedMean, 6_000);
    assert.ok(Math.abs(cache.costWarm - 0.058 / 3) < 1e-12);
    assert.equal(cache.costCold, 0.04);
    assert.ok(Math.abs(cache.costMean - 0.098 / 4) < 1e-12);
    assert.equal(cache.warmFloor.uncached, quantile([4000, 6000, 8000], 0.25));
    assert.equal(cache.warmFloor.uncached, 5000);
    assert.ok(Math.abs(cache.warmFloor.costUsd - 0.017) < 1e-12);
    assert.ok(summary.ratiosWarm === null || Array.isArray(summary.ratiosWarm));
    const table = markdownTable(summary, ['t1', 't2'], [key], { header: 'order: contiguous', notes: ['Warm-up runs (excluded): 1, cost $0.0900'] });
    assert.match(table, /^order: contiguous/);
    assert.match(table, /Cost warm \(mean, n\)/);
    assert.match(table, /\| B\/codex:gpt-6-luna:low \| 4 \| 9,500 \/ 7,000 \|/);
    assert.match(table, /Warm floor codex:gpt-6-luna:low \(p25 of warm runs\): B FAI Browser 5,000 uncached, \$0\.0170/);
    assert.match(table, /Warm-up runs \(excluded\): 1/);
    // Old records without a phase are unknown, not cold.
    const old = cacheStats(records.map(({ cachePhase: _phase, ...row }) => row), [key])[key];
    assert.equal(old.unknown, 4);
    assert.equal(old.cold.n, 0);
    assert.equal(old.warmFloor, null);
    assert.equal(old.costCold, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('warm-only ratios are reported next to the all-runs ratios', () => {
  const a = ROWS.map(row => ({ ...row, condition: `a/${LUNA.id}`, wallMs: 20_000 }));
  const b = ROWS.map(row => ({ ...row, condition: `b/${LUNA.id}` }));
  const summary = aggregate([...a, ...b], ['t1', 't2'], [`a/${LUNA.id}`, `b/${LUNA.id}`]);
  assert.equal(summary.ratios.length, 1);
  assert.equal(summary.ratiosWarm.length, 1);
  const table = markdownTable(summary, ['t1', 't2'], [`a/${LUNA.id}`, `b/${LUNA.id}`]);
  assert.match(table, /shared task\(s\), all measured runs/);
  assert.match(table, /shared task\(s\), warm runs only/);
});

function writeSet(dir, rows, config) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'runs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
}

test('report data and cards with and without the cache fields', () => {
  const root = mkdtempSync(join(tmpdir(), 'fai-bench-report-cache-'));
  try {
    const fresh = join(root, 'new');
    writeSet(fresh, [...ROWS, WARMUP], { startedAt: '2026-10-04T12:00:00Z', hosts: [LUNA.id], repeat: 2, order: 'contiguous' });
    const data = buildData([fresh]);
    const b = data.totals[LUNA.id].b;
    assert.equal(b.attempted, 4, 'warm-up row left out');
    assert.equal(b.uncachedCold.n, 1);
    assert.equal(b.uncachedWarm.n, 3);
    assert.equal(b.cacheUnknown, 0);
    assert.equal(b.costCold, 0.04);
    assert.ok(Math.abs(b.warmFloor.costUsd - 0.017) < 1e-12);
    assert.ok(Math.abs(b.costMean - 0.0245) < 1e-12);
    assert.equal(b.requests, 4, 'raw requests: sum of per-task medians');
    assert.equal(b.requestsAdjusted, 6);
    const html = renderHtml(data);
    assert.match(html, /warm floor \$0\.017 \(3 warm runs\)/);
    assert.match(html, /Cost warm · cold/);

    // An older set: no cache phase, no requestsAdjusted. Unknown, never cold; no floor rendered.
    const old = join(root, 'old');
    writeSet(old, ROWS.map(({ cachePhase: _phase, hostVendor: _vendor, ...row }) => row), { startedAt: '2026-10-03T12:00:00Z', model: 'gpt-6-luna', effort: 'low' });
    const legacy = buildData([old]);
    const lb = legacy.totals[LUNA.id].b;
    assert.equal(lb.cacheUnknown, 4);
    assert.equal(lb.uncachedCold.n, 0);
    assert.equal(lb.warmFloor, null);
    assert.equal(lb.costCold, null);
    assert.equal(lb.requestsAdjusted, 6, 'adjusted count recomputed for old Codex rows');
    assert.doesNotMatch(renderHtml(legacy), /warm floor \$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
