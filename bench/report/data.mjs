// Loads benchmark result directories (bench/compare.mjs layout, old and new) and QA corpus runs (bench/qa/run.mjs)
// and reduces them to the report model written as data.json. Pure apart from reading files. Only numbers, task ids,
// host ids and directory names leave this module: answers, prompts and page text from traces are never copied.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  adjustedRequests, completeCostUsd, countModelRequests, quantile, safeVerifiedStats, safeVerifiedSuccess, tokenBreakdown, tokenCoverage,
} from '../lib/metrics.mjs';
import { LEGACY_HOST, hostModel, loadPrices, parseHost } from '../lib/hosts.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CONDITIONS = ['a', 'b'];
export const CONDITION_NAME = { a: 'Playwright MCP', b: 'FAI Browser' };

const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

// JSONL that may still be written: a torn last line is skipped, not fatal.
const readJsonl = path => readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
  try {
    return [JSON.parse(line)];
  } catch {
    return [];
  }
});

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) {
    return null;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const sum = values => {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((a, b) => a + b, 0) : null;
};

// "codex:gpt-6.1-sol:medium" -> {name: "GPT-6.1 Sol", effort: "medium"}; "claude:claude-opus-5-5:medium" -> "Claude Opus 5.5".
export function hostName(id) {
  const [vendor, model = '', effort = ''] = String(id).split(':');
  const cap = word => word.charAt(0).toUpperCase() + word.slice(1);
  let name = model;
  let match;
  if ((match = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(model))) {
    name = `Claude ${cap(match[1])} ${match[2]}.${match[3]}`;
  } else if ((match = /^gpt-([\d.]+)-([a-z]+)$/.exec(model))) {
    name = `GPT-${match[1]} ${cap(match[2])}`;
  }
  return { id, vendor, model, effort, name, short: name.replace(/^(GPT-[\d.]+|Claude) /, '') };
}

function classify(dir) {
  const summary = readJson(join(dir, 'summary.json'));
  if (summary?.byArchetype && summary?.overall) {
    return { kind: 'qa', summary };
  }
  if (existsSync(join(dir, 'runs.jsonl')) || Array.isArray(summary?.runs)) {
    return { kind: 'bench', summary };
  }
  return { kind: 'unknown' };
}

function recountRequests(record, dir) {
  const candidates = [
    record.logDir && resolve(ROOT, record.logDir, 'events.jsonl'),
    join(dir, 'runs', `${record.taskId}.${record.condition}.${record.rep}`, 'events.jsonl'),
  ].filter(Boolean);
  const events = candidates.find(path => existsSync(path));
  return events ? countModelRequests(readJsonl(events)) : null;
}

// One bench directory -> slim records (numbers only).
function loadBench(dir, summary, prices) {
  const config = readJson(join(dir, 'config.json')) ?? {};
  let defaultHost = LEGACY_HOST;
  if (config.model && !config.hosts) {
    try {
      defaultHost = parseHost(`codex:${config.model}:${config.effort || 'medium'}`).id;
    } catch {
      // keep the legacy default
    }
  }
  const rows = existsSync(join(dir, 'runs.jsonl')) ? readJsonl(join(dir, 'runs.jsonl')) : summary?.runs ?? [];
  const source = basename(dir);
  const startedAt = config.startedAt ?? summary?.meta?.startedAt ?? null;
  // Warm-up runs (timeline harness) live in warmup/runs.jsonl; a stray one in runs.jsonl is still left out.
  const records = rows.filter(row => CONDITIONS.includes(row.condition) && row.taskId && !row.warmup).map(row => {
    const host = row.host ?? defaultHost;
    const requests = row.requests ?? (row.outcome === 'skipped' ? null : recountRequests(row, dir));
    // Codex runs with an MCP call made one hidden schema-load request (see metrics.mjs adjustedRequests).
    const requestsAdjusted = adjustedRequests({ ...row, host, requests });
    const split = tokenBreakdown(row.tokens);
    const recorded = Number.isFinite(row.cost?.usd) ? { usd: row.cost.usd, basis: row.cost.basis ?? null } : null;
    const coverage = tokenCoverage(row.tokens);
    const computed = recorded ? null : completeCostUsd(row.tokens, hostModel(host), prices);
    return {
      taskId: row.taskId,
      condition: row.condition,
      host,
      rep: row.rep ?? 1,
      source,
      startedAt,
      skipped: row.outcome === 'skipped',
      ungraded: Boolean(row.ungraded),
      pass: Boolean(row.pass),
      safeVerified: safeVerifiedSuccess(row),
      timedOut: Boolean(row.timedOut),
      wallS: Number.isFinite(row.wallMs) ? row.wallMs / 1000 : null,
      toolCalls: row.toolCalls ?? null,
      requests,
      requestsAdjusted,
      tokens: split?.total ?? null,
      tokenSplit: split,
      usageCoverage: coverage,
      usagePartial: row.claude?.usageSource === 'messages (partial)',
      uncached: split?.uncachedInput ?? null,
      // Older result sets have no cache phase: unknown, never counted as cold.
      cachePhase: row.cachePhase === 'warm' || row.cachePhase === 'cold' ? row.cachePhase : null,
      priced: split?.priced ?? null,
      costUsd: recorded?.usd ?? computed?.usd ?? null,
      costPartial: Boolean(row.costPartial || row.cost?.unpriced?.length),
      costBasis: recorded?.basis ?? computed?.basis ?? null,
      costSource: recorded ? 'recorded' : computed ? 'prices.json' : null,
      dangerClicks: row.dangerClicks ?? null,
      oversight: row.oversight ? {
        receipts: row.oversight.receipts ?? 0,
        oversightReceipts: row.oversight.oversightReceipts ?? 0,
        autoAnswers: row.oversight.autoAnswers ?? 0,
        falseAutomation: row.oversight.falseAutomation ?? 0,
      } : null,
    };
  });
  return { source, path: dir, startedAt, repeat: config.repeat ?? null, records };
}

function loadQa(dir, summary) {
  const archetypes = Object.entries(summary.byArchetype).map(([name, row]) => ({
    name,
    runs: row.runs,
    passes: row.passes,
    passRate: row.passRate ?? (row.runs ? row.passes / row.runs : null),
    p50RunMs: row.p50RunMs ?? null,
    dangerClicks: row.dangerClicks ?? 0,
    dangerOffered: row.dangerOffered ?? 0,
    falseAutomation: row.falseAutomation ?? 0,
    autoAnswer: row.autoAnswer ?? 0,
  }));
  const o = summary.overall;
  return {
    source: basename(dir),
    label: summary.label ?? null,
    startedAt: summary.startedAt ?? null,
    repeat: summary.repeat ?? 1,
    tasks: summary.tasksCount ?? summary.tasks?.length ?? null,
    overall: {
      runs: o.runs, passes: o.passes, passRate: o.passRate ?? (o.runs ? o.passes / o.runs : null),
      p50RunMs: o.p50RunMs ?? null, p90RunMs: o.p90RunMs ?? null, autoAnswer: o.autoAnswer ?? 0,
      falseAutomation: o.falseAutomation ?? 0, dangerClicks: o.dangerClicks ?? 0, dangerOffered: o.dangerOffered ?? 0,
      violations: o.violations ?? 0,
    },
    archetypes,
  };
}

function taskOrder() {
  const tasks = readJson(join(ROOT, 'bench', 'tasks.json'));
  return (tasks?.tasks ?? []).map(task => task.id);
}

function cellStats(runs) {
  const done = runs.filter(run => !run.skipped && !run.ungraded);
  const over = list => (list.length ? list : null);
  const oversight = done.map(run => run.oversight).filter(Boolean);
  return {
    runs: runs.length,
    attempted: done.length,
    passed: done.filter(run => run.pass).length,
    safeVerified: done.filter(run => run.safeVerified === true).length,
    safeVerifiedUnknown: done.filter(run => run.safeVerified == null).length,
    skipped: runs.filter(run => run.skipped).length,
    timedOut: done.filter(run => run.timedOut).length,
    wallS: median(done.map(run => run.wallS)),
    toolCalls: median(done.map(run => run.toolCalls)),
    requests: median(done.map(run => run.requests)),
    requestsAdjusted: median(done.map(run => run.requestsAdjusted)),
    tokens: median(done.map(run => run.tokens)),
    cachedInput: median(done.map(run => run.tokenSplit?.cachedInput ?? null)),
    uncachedInput: median(done.map(run => run.tokenSplit?.uncachedInput ?? null)),
    cacheWrite: median(done.map(run => run.tokenSplit?.cacheWrite ?? null)),
    outputTokens: median(done.map(run => run.tokenSplit?.output ?? null)),
    priced: median(done.map(run => run.priced)),
    costUsd: median(done.map(run => run.costUsd)),
    dangerClicks: sum(done.map(run => run.dangerClicks)),
    oversight: over(oversight) && {
      receipts: sum(oversight.map(item => item.receipts)),
      oversightReceipts: sum(oversight.map(item => item.oversightReceipts)),
      autoAnswers: sum(oversight.map(item => item.autoAnswers)),
      falseAutomation: sum(oversight.map(item => item.falseAutomation)),
    },
    sources: [...new Set(runs.map(run => run.source))],
  };
}

const TOTAL_KEYS = ['wallS', 'toolCalls', 'requests', 'requestsAdjusted', 'tokens', 'cachedInput', 'uncachedInput',
  'cacheWrite', 'outputTokens', 'priced', 'costUsd'];

const mean = values => {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null;
};

// Per host x condition prompt-cache view over individual runs: uncached input and cost split into cold-start and
// warm runs, runs of unknown phase (older sets), mean cost per run, and the warm floor (p25 of warm runs).
export function cacheView(runs) {
  const done = runs.filter(run => !run.skipped && !run.ungraded);
  const warm = done.filter(run => run.cachePhase === 'warm');
  const cold = done.filter(run => run.cachePhase === 'cold');
  return {
    runs: done.length,
    uncachedMean: mean(done.map(run => run.uncached)),
    uncachedWarm: { n: warm.length, mean: mean(warm.map(run => run.uncached)) },
    uncachedCold: { n: cold.length, mean: mean(cold.map(run => run.uncached)) },
    unknown: done.length - warm.length - cold.length,
    costMean: mean(done.map(run => run.costUsd)),
    costWarm: mean(warm.map(run => run.costUsd)),
    costCold: mean(cold.map(run => run.costUsd)),
    warmFloor: warm.length
      ? { uncached: quantile(warm.map(run => run.uncached), 0.25), costUsd: quantile(warm.map(run => run.costUsd), 0.25) }
      : null,
  };
}
const RATIO_KEYS = { wall: 'wallS', toolCalls: 'toolCalls', requests: 'requests', requestsAdjusted: 'requestsAdjusted', tokens: 'tokens', priced: 'priced',
  cost: 'costUsd' };

// dirs: result directories (bench or QA). Returns the full report model.
export function buildData(dirs, { prices = loadPrices(), title = 'FAI Browser Benchmarks', now = new Date() } = {}) {
  const sets = [];
  const corpus = [];
  const ignored = [];
  for (const raw of dirs) {
    const dir = resolve(raw);
    if (!existsSync(dir)) {
      ignored.push({ source: raw, reason: 'not found' });
      continue;
    }
    const kind = classify(dir);
    if (kind.kind === 'qa') {
      corpus.push(loadQa(dir, kind.summary));
    } else if (kind.kind === 'bench') {
      sets.push(loadBench(dir, kind.summary, prices));
    } else {
      ignored.push({ source: basename(dir), reason: 'no runs.jsonl or summary.json' });
    }
  }

  // Dedupe by (task, condition, host, rep): the newest set (config startedAt, then argument order) wins.
  const ordered = sets.map((set, index) => ({ set, index }))
    .sort((x, y) => String(x.set.startedAt ?? '').localeCompare(String(y.set.startedAt ?? '')) || x.index - y.index);
  const byKey = new Map();
  let replaced = 0;
  for (const { set } of ordered) {
    for (const record of set.records) {
      const key = `${record.taskId}|${record.condition}|${record.host}|${record.rep}`;
      if (byKey.has(key)) {
        replaced += 1;
      }
      byKey.set(key, record);
    }
  }
  const records = [...byKey.values()];

  const known = taskOrder();
  const seenTasks = new Set(records.map(record => record.taskId));
  const taskIds = [...known.filter(id => seenTasks.has(id)), ...[...seenTasks].filter(id => !known.includes(id)).sort()];
  // Host order: first appearance in time order, so a host keeps its colour across reports of the same sets.
  const hostIds = [];
  for (const { set } of ordered) {
    for (const record of set.records) {
      if (!hostIds.includes(record.host)) {
        hostIds.push(record.host);
      }
    }
  }

  const cells = {};
  for (const host of hostIds) {
    for (const condition of CONDITIONS) {
      for (const taskId of taskIds) {
        const runs = records.filter(r => r.host === host && r.condition === condition && r.taskId === taskId);
        cells[`${host}|${condition}|${taskId}`] = { host, condition, taskId, ...cellStats(runs) };
      }
    }
  }
  const expectedReps = Math.max(1, ...Object.values(cells).map(cell => cell.attempted),
    ...sets.map(set => set.repeat ?? 1));

  const totals = {};
  const missing = [];
  for (const host of hostIds) {
    totals[host] = {};
    for (const condition of CONDITIONS) {
      const list = taskIds.map(id => cells[`${host}|${condition}|${id}`]).filter(cell => cell.attempted);
      const absent = taskIds.filter(id => !cells[`${host}|${condition}|${id}`].attempted);
      const partial = list.filter(cell => cell.attempted < expectedReps).map(cell => cell.taskId);
      if (!list.length) {
        totals[host][condition] = null;
        missing.push({ host, condition, kind: 'all', tasks: taskIds });
        continue;
      }
      if (absent.length) {
        missing.push({ host, condition, kind: 'tasks', tasks: absent });
      }
      if (partial.length) {
        missing.push({ host, condition, kind: 'repeats', tasks: partial, expectedReps });
      }
      const oversight = list.map(cell => cell.oversight).filter(Boolean);
      const total = {
        tasks: list.length,
        taskCount: taskIds.length,
        attempted: sum(list.map(cell => cell.attempted)),
        passed: sum(list.map(cell => cell.passed)),
        runs: sum(list.map(cell => cell.runs)),
        repsMin: Math.min(...list.map(cell => cell.attempted)),
        repsMax: Math.max(...list.map(cell => cell.attempted)),
        ...Object.fromEntries(TOTAL_KEYS.map(key => [key, sum(list.map(cell => cell[key]))])),
        dangerClicks: sum(list.map(cell => cell.dangerClicks)),
        sources: [...new Set(list.flatMap(cell => cell.sources))],
        costBasis: [...new Set(records.filter(r => r.host === host && r.condition === condition).map(r => r.costBasis)
          .filter(Boolean))].join('+') || null,
      };
      const measured = records.filter(r => r.host === host && r.condition === condition && !r.skipped && !r.ungraded);
      Object.assign(total, safeVerifiedStats(measured));
      total.passRate = total.attempted ? total.passed / total.attempted : null;
      const cache = cacheView(records.filter(r => r.host === host && r.condition === condition));
      Object.assign(total, {
        uncachedMean: cache.uncachedMean,
        uncachedWarm: cache.uncachedWarm,
        uncachedCold: cache.uncachedCold,
        cacheUnknown: cache.unknown,
        costMean: cache.costMean,
        costWarm: cache.costWarm,
        costCold: cache.costCold,
        warmFloor: cache.warmFloor,
      });
      total.costPerTask = total.costUsd != null ? total.costUsd / total.tasks : null;
      total.wallPerTask = total.wallS != null ? total.wallS / total.tasks : null;
      if (oversight.length) {
        const o = {
          receipts: sum(oversight.map(item => item.receipts)),
          oversightReceipts: sum(oversight.map(item => item.oversightReceipts)),
          autoAnswers: sum(oversight.map(item => item.autoAnswers)),
          falseAutomation: sum(oversight.map(item => item.falseAutomation)),
        };
        o.oversightRate = o.receipts ? o.oversightReceipts / o.receipts : null;
        total.oversight = o;
      }
      totals[host][condition] = total;
    }
  }

  // A / B per host over tasks attempted under both; above 1 means FAI is better.
  const ratios = {};
  for (const host of hostIds) {
    const shared = taskIds.filter(id => cells[`${host}|a|${id}`].attempted && cells[`${host}|b|${id}`].attempted);
    if (!shared.length) {
      ratios[host] = null;
      continue;
    }
    const pick = (condition, key) => sum(shared.map(id => cells[`${host}|${condition}|${id}`][key]));
    const ratio = { tasks: shared, complete: shared.length === taskIds.length };
    for (const [name, key] of Object.entries(RATIO_KEYS)) {
      const a = pick('a', key);
      const b = pick('b', key);
      ratio[name] = a != null && b ? a / b : null;
    }
    const successCost = condition => safeVerifiedStats(records.filter(record => record.host === host
      && record.condition === condition && shared.includes(record.taskId) && !record.skipped && !record.ungraded))
      .costUsdPerSafeVerified;
    const a = successCost('a');
    const b = successCost('b');
    ratio.costSafeVerified = a != null && b ? a / b : null;
    ratios[host] = ratio;
  }

  const hosts = hostIds.map(id => hostName(id));
  const fullB = hostIds.filter(host => totals[host].b && totals[host].b.tasks === taskIds.length);
  const pool = fullB.length ? fullB : hostIds.filter(host => totals[host].b);
  const fastest = pool.length
    ? pool.reduce((best, host) => (totals[host].b.wallPerTask < totals[best].b.wallPerTask ? host : best))
    : null;

  return {
    title,
    generatedAt: now.toISOString(),
    date: now.toISOString().slice(0, 10),
    conditions: CONDITION_NAME,
    taskIds,
    expectedReps,
    hosts,
    cells: Object.values(cells).map(({ sources: _sources, ...cell }) => cell),
    totals,
    ratios,
    headline: { fastestHost: fastest, completeHosts: fullB },
    missing,
    sets: sets.map(set => ({ source: set.source, startedAt: set.startedAt, repeat: set.repeat, records: set.records.length })),
    dedupe: { records: records.length, replaced },
    corpus,
    ignored,
    prices: { date: prices?.date ?? null, unit: prices?.unit ?? null },
  };
}

// Every result directory under bench/results, for "report everything".
export function allResultDirs(base = join(ROOT, 'bench', 'results')) {
  return existsSync(base) ? readdirSync(base).map(name => join(base, name)) : [];
}
