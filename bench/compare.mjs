#!/usr/bin/env node
// End-to-end comparison: is a coding agent faster at browser tasks with FAI Browser (B) than with Playwright MCP (A),
// across host models (Codex and Claude Code)?
//   node bench/compare.mjs [--condition a|b|r|both|all|b,r] [--tasks id,id] [--repeat N] [--host vendor:slug[:effort]]...
//                          [--model M] [--effort E] [--tasks-file FILE] [--site-dir DIR]
//                          [--timeout-s 300] [--out DIR] [--baseline DIR] [--dry-run] [--list]
//                          [--order contiguous|interleave] [--interleave] [--warmup N] [--warmup-task ID]
//                          [--no-abba] [--no-stable-paths] [--claude-cache-ttl 5m|1h|default]
//                          [--real-tools run|eager|deferred]
// See bench/README.md. Each run: start the fixture site, run the host (`codex exec --json` or `claude -p
// --output-format stream-json`) with one browser MCP server, parse its events, grade the ANSWER line (or, for tasks
// with expectOutcome, the FAI result status/code). Failed or timed-out runs are recorded, never fatal.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { appendFile, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { codexArgs, codexInfo, readFinal, runCodex, trimFeatures } from './lib/codex.mjs';
import {
  CLAUDE_CACHE_TTLS, claudeArgs, claudeInfo, claudeRunEnv, mcpConfig, parseClaudeEvents, probeClaudeContext, runClaude,
} from './lib/claude.mjs';
import { buildSchedule, cachePhase, cacheTtlS, orderLine, ORDERS, timelineKey } from './lib/schedule.mjs';
import {
  conditionKey, conditionLabel, hostTag, LEGACY_HOST, loadPrices, parseConditions, parseHost, parseHosts,
} from './lib/hosts.mjs';
import { installIntoWorkspace, REAL_SERVER_NAME, REAL_TOOLS, realInstallMcpConfig } from './lib/real-install.mjs';
import {
  adjustedRequests,
  aggregate,
  faiRunCounts,
  countModelRequests,
  costUsd,
  DEFAULT_PRICE_WEIGHTS,
  extractAnswer,
  grade,
  markdownTable,
  oversightFor,
  parseEvents,
  tokenBreakdown,
} from './lib/metrics.mjs';
import { dangerClicks, gradeOutcome, loadDangerPatterns, siteServer } from './lib/qa.mjs';
import { FaiRun, extensionVersion, faiEvidence, preflightFai } from './fai-condition.mjs';
import { headlessCommand } from '../scripts/headless-env.mjs';
import { fakeSecrets } from './showcase/serve.mjs';
import { payloadGrade, safetyFor, scanSecret, secretGrade, shopGrade } from './showcase/checks.mjs';
import { showcaseTable } from './showcase/report.mjs';

const run = promisify(execFile);
const BENCH = import.meta.dirname;
const ROOT = resolve(BENCH, '..');

const { values: args } = parseArgs({
  options: {
    condition: { type: 'string', default: 'both' },
    tasks: { type: 'string' },
    'tasks-file': { type: 'string' },
    'site-dir': { type: 'string' },
    repeat: { type: 'string', default: '1' },
    host: { type: 'string', multiple: true },
    model: { type: 'string' },
    effort: { type: 'string' },
    'timeout-s': { type: 'string', default: '300' },
    out: { type: 'string' },
    baseline: { type: 'string' },
    prices: { type: 'string' },
    'price-cached': { type: 'string', default: String(DEFAULT_PRICE_WEIGHTS.cached) },
    'price-cache-write': { type: 'string', default: String(DEFAULT_PRICE_WEIGHTS.cacheWrite) },
    'price-output': { type: 'string', default: String(DEFAULT_PRICE_WEIGHTS.output) },
    codex: { type: 'string', default: process.env.CODEX_BIN || 'codex' },
    claude: { type: 'string', default: process.env.CLAUDE_BIN || 'claude' },
    'claude-max-turns': { type: 'string', default: '40' },
    'claude-budget-usd': { type: 'string', default: '2' },
    'skip-claude-probe': { type: 'boolean' },
    chromium: { type: 'string', default: process.env.CHROMIUM_PATH || '/usr/bin/chromium' },
    'playwright-mcp': { type: 'string', default: '@playwright/mcp@latest' },
    'playwright-npx': { type: 'boolean' },
    'fai-mcp-command': { type: 'string' },
    'keep-codex-tools': { type: 'boolean' },
    'sandbox-network': { type: 'boolean' },
    order: { type: 'string' },
    interleave: { type: 'boolean' },
    warmup: { type: 'string' },
    'warmup-task': { type: 'string' },
    'no-abba': { type: 'boolean' },
    'no-stable-paths': { type: 'boolean' },
    'claude-cache-ttl': { type: 'string', default: '5m' },
    'real-tools': { type: 'string', default: 'run' },
    'approve-purchase': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    list: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const USAGE = `Usage: node bench/compare.mjs [options]
  --condition C            a, b, r, both (= a,b; default), all (= a,b,r) or a comma list such as b,r.
                           A = Playwright MCP baseline, B = FAI Browser MCP with the loop guidance inlined and no
                           built-in tools, R = FAI as a real Claude Code install (no inlined guidance, built-in
                           tools with ToolSearch and the Skill tool, the installer's skill; Claude hosts only)
  --tasks id,id            Subset of the task file (default all; --list shows ids)
  --tasks-file FILE        Task file in the bench/tasks.json schema (default bench/tasks.json; e.g. bench/qa/tasks.json)
  --site-dir DIR           Site to serve (default: the task file's "site", else fixtures/site)
  --repeat N               Runs per task, host and condition (default 1)
  --host V:SLUG[:EFFORT]   Host model, repeatable or comma-separated: codex:gpt-6.1-sol:medium, claude:claude-sonnet-5-5:low,
                           aliases astra, sol, luna, terra, opus, sonnet (default effort medium)
  --model M --effort E     Shorthand for one Codex host (default gpt-6.1-sol, medium when no --host is given)
  --timeout-s N            Per-run wall-clock limit, enforced with timeout(1) (default 300)
  --out DIR                Results directory (default bench/results/<timestamp>/)
  --baseline DIR           Merge an earlier results directory into the summary: its A rows (as A, or A-baseline
                           when A also runs now on that host) and its B rows as B-baseline; rows without a host
                           are ${LEGACY_HOST}
  --prices FILE            Price table for the Cost $ column (default bench/prices.json)
  --price-cached W         Weight of a cached input token in "priced" units (default 0.1; uncached input is 1)
  --price-cache-write W    Weight of a cache-write token (default 1.25; Claude only)
  --price-output W         Weight of an output token in "priced" units (default 5)
  --claude BIN             Claude Code binary (default $CLAUDE_BIN or claude)
  --claude-max-turns N     claude -p --max-turns backstop (default 40)
  --claude-budget-usd X    claude -p --max-budget-usd backstop per run (default 2)
  --skip-claude-probe      Skip the one-off context probe before Claude runs (not recommended)
  --chromium PATH          Browser for both conditions (default $CHROMIUM_PATH or /usr/bin/chromium)
  --playwright-mcp SPEC    npm spec for condition A (default @playwright/mcp@latest)
  --playwright-npx         Start A through npx on every run instead of the resolved binary
  --fai-mcp-command CMD    Command for the FAI MCP server (default: fai-browser-mcp, resolved)
  --keep-codex-tools       Do not disable Codex built-ins (shell, browser_use, web search, ...)
  --sandbox-network        Allow network in the Codex shell sandbox (off; MCP servers run outside it)
  --order contiguous|interleave
                           contiguous (default): per host x condition, a warm-up run then every task x repeat back to
                           back, condition order alternated per host; interleave: conditions alternate per task
  --interleave             Same as --order interleave
  --warmup N               Warm-up runs per host x condition timeline, excluded from tables (default 1 contiguous,
                           0 interleave)
  --warmup-task ID         Task for warm-up runs (default about-members if in the task file, else its first task)
  --no-abba                Same condition order on every host (contiguous only)
  --no-stable-paths        A new random scratch path and site port per run (default: one per timeline)
  --claude-cache-ttl V     5m (default), 1h or default (Claude Code's own: 1 h on a subscription); sets
                           CLAUDE_CODE_PROMPT_CACHE_TTL for Claude runs
  --real-tools V           Condition R's server entry: run (default; what install --host claude writes: only
                           fai_browser_run eager, through the server's _meta), eager (install --always-load:
                           alwaysLoad true) or deferred (alwaysLoad false: every tool behind ToolSearch)
  --dry-run                Print prompts and host commands without running anything
  --list                   List task ids and exit`;

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const log = message => process.stderr.write(`[bench] ${message}\n`);
const fail = message => {
  console.error(message);
  process.exit(1);
};
const intArg = (name, min, max) => {
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`--${name} must be an integer from ${min} to ${max}`);
  }
  return value;
};
const numArg = name => {
  const value = Number(args[name]);
  if (!Number.isFinite(value) || value < 0) {
    fail(`--${name} must be a non-negative number`);
  }
  return value;
};

const tasksFile = resolve(args['tasks-file'] ?? join(BENCH, 'tasks.json'));
if (!existsSync(tasksFile)) {
  fail(`--tasks-file ${args['tasks-file']}: not found`);
}
const suite = JSON.parse(await readFile(tasksFile, 'utf8'));
if (args.list) {
  const clause = c => `${[c.status ?? '*'].flat().join('|')}${c.code ? `/${[c.code].flat().join('|')}` : ''}${c.answer ? '+answer' : ''}`;
  for (const task of suite.tasks) {
    const kind = task.difficulty ?? task.archetype ?? '';
    const expect = task.expectOutcome ? `[expect ${(task.expectOutcome.anyOf ?? [task.expectOutcome]).map(clause).join(' or ')}] ` : '';
    console.log(`${task.id.padEnd(24)} ${String(kind).padEnd(9)} ${expect}${task.instruction}`);
  }
  process.exit(0);
}
const conditions = parseConditions(args.condition);
if (!conditions) {
  fail('--condition must be a, b, r, both, all or a comma list of a, b and r');
}
const realTools = args['real-tools'];
if (!REAL_TOOLS.includes(realTools)) {
  fail(`--real-tools must be one of ${REAL_TOOLS.join(', ')}`);
}
const wanted = args.tasks ? args.tasks.split(',').map(id => id.trim()).filter(Boolean) : null;
const unknown = wanted?.filter(id => !suite.tasks.some(task => task.id === id)) ?? [];
if (unknown.length) {
  fail(`Unknown task id(s): ${unknown.join(', ')}. Use --list.`);
}
const tasks = wanted ? suite.tasks.filter(task => wanted.includes(task.id)) : suite.tasks;

let hosts;
try {
  hosts = parseHosts(args.host, { model: args.model ?? 'gpt-6.1-sol', effort: args.effort ?? 'medium' });
  // --model/--effort next to --host add one more Codex host rather than being silently ignored.
  if (args.host?.length && (args.model || args.effort)) {
    const extra = parseHost(`codex:${args.model ?? 'gpt-6.1-sol'}:${args.effort ?? 'medium'}`);
    if (!hosts.some(host => host.id === extra.id)) {
      hosts.push(extra);
    }
  }
} catch (error) {
  fail(error.message);
}
const repeat = intArg('repeat', 1, 50);
const order = args.interleave ? 'interleave' : args.order ?? 'contiguous';
if (!ORDERS.includes(order)) {
  fail(`--order must be one of ${ORDERS.join(', ')}`);
}
if (args.interleave && args.order && args.order !== 'interleave') {
  fail('--interleave conflicts with --order ' + args.order);
}
const warmupCount = args.warmup != null ? intArg('warmup', 0, 10) : order === 'contiguous' ? 1 : 0;
const warmupTask = suite.tasks.find(task => task.id === (args['warmup-task']
  ?? (suite.tasks.some(item => item.id === 'about-members') ? 'about-members' : suite.tasks[0]?.id)));
if (args['warmup-task'] && !warmupTask) {
  fail(`--warmup-task ${args['warmup-task']}: unknown task id. Use --list.`);
}
const abba = order === 'contiguous' && !args['no-abba'];
const stablePaths = !args['no-stable-paths'];
const claudeCacheTtl = args['claude-cache-ttl'];
if (!CLAUDE_CACHE_TTLS.includes(claudeCacheTtl)) {
  fail(`--claude-cache-ttl must be one of ${CLAUDE_CACHE_TTLS.join(', ')}`);
}
const timeoutS = intArg('timeout-s', 10, 3600);
const claudeMaxTurns = intArg('claude-max-turns', 1, 500);
const claudeBudgetUsd = numArg('claude-budget-usd');
const weights = {
  uncached: 1, cached: numArg('price-cached'), cacheWrite: numArg('price-cache-write'), output: numArg('price-output'),
};
let prices;
try {
  prices = loadPrices(args.prices ? resolve(args.prices) : undefined);
} catch (error) {
  fail(`price table: ${error.message}`);
}
for (const host of hosts) {
  if (!prices.models?.[host.model]) {
    log(`warning: no price for ${host.model} in the price table; its Cost $ column stays empty`);
  }
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
const outDir = resolve(args.out ?? join(BENCH, 'results', stamp));
const hostIds = hosts.map(host => host.id);

// Rows of an earlier run (runs.jsonl, else summary.json) relabelled for the summary. Older records have no request
// count (recomputed from their saved events.jsonl) and no host (taken from that run's config.json model/effort, else
// the legacy default).
function loadBaseline(dir) {
  const base = resolve(dir);
  let rows = [];
  if (existsSync(join(base, 'runs.jsonl'))) {
    rows = readFileSync(join(base, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } else if (existsSync(join(base, 'summary.json'))) {
    rows = JSON.parse(readFileSync(join(base, 'summary.json'), 'utf8')).runs ?? [];
  } else {
    fail(`--baseline ${dir}: no runs.jsonl or summary.json`);
  }
  let defaultHost = LEGACY_HOST;
  try {
    const config = JSON.parse(readFileSync(join(base, 'config.json'), 'utf8'));
    if (config.model && !config.hosts) {
      defaultHost = parseHost(`codex:${config.model}:${config.effort || 'medium'}`).id;
    }
  } catch {
    // no config: legacy default
  }
  const runningA = conditions.includes('a');
  return rows.filter(row => row.condition === 'a' || row.condition === 'b').map(row => {
    const host = row.host ?? defaultHost;
    const condition = row.condition === 'a' ? (runningA && hostIds.includes(host) ? 'a-baseline' : 'a') : 'b-baseline';
    const record = { ...row, host, condition, baseline: base };
    if (record.requests == null && record.outcome !== 'skipped') {
      const candidates = [
        record.logDir && resolve(ROOT, record.logDir, 'events.jsonl'),
        join(base, 'runs', `${row.taskId}.${row.condition}.${row.rep}`, 'events.jsonl'),
      ].filter(Boolean);
      const events = candidates.find(path => existsSync(path));
      if (events) {
        const parsed = readFileSync(events, 'utf8').split('\n').filter(Boolean).map(line => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        });
        record.requests = countModelRequests(parsed);
      }
    }
    return record;
  });
}
const baselineRecords = args.baseline ? loadBaseline(args.baseline) : [];

// Prompts: common.md plus the per-condition tool paragraph. A Claude host uses prompts/claude-<fai|playwright>.md when
// that file exists; the shared wording names tools by their fai_browser_/browser_ suffix, which both hosts show.
const readPrompt = name => (existsSync(join(BENCH, 'prompts', name)) ? readFileSync(join(BENCH, 'prompts', name), 'utf8') : null);
// Condition R's paragraph (fai-real.md) names the installed server and skill but inlines none of the loop guidance.
const prompts = {
  common: readPrompt('common.md'),
  codex: { a: readPrompt('playwright.md'), b: readPrompt('fai.md'), r: readPrompt('fai-real.md') },
  claude: {
    a: readPrompt('claude-playwright.md') ?? readPrompt('playwright.md'),
    b: readPrompt('claude-fai.md') ?? readPrompt('fai.md'),
    r: readPrompt('claude-fai-real.md') ?? readPrompt('fai-real.md'),
  },
};
if (suite.prompts) {
  prompts.common = readFileSync(resolve(ROOT, suite.prompts.common), 'utf8');
  for (const vendor of ['codex', 'claude']) {
    prompts[vendor].a = readFileSync(resolve(ROOT, suite.prompts.playwright), 'utf8');
    prompts[vendor].b = readFileSync(resolve(ROOT, suite.prompts.fai), 'utf8');
  }
}
const showcase = Boolean(suite.server === 'bench/showcase/serve.mjs');
const fixtureSecrets = showcase ? await fakeSecrets() : null;
const fill = (template, vars) => template.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
// QA corpus tasks carry the fai_browser_run parameters a careful host would choose; B gets them as a hint line.
function faiHints(task, vars) {
  const hints = [];
  if (task.mode) hints.push(`mode "${task.mode}"`);
  // A step-list task: the parameters of each hop, in order (whether to send them as steps is the host's call).
  for (const [index, step] of (task.steps ?? []).entries()) {
    hints.push(`hop ${index + 1}: expectation ${fill(JSON.stringify(step.expectation), vars)}`
      + `${step.answerQuestion ? `, answerQuestion ${JSON.stringify(fill(step.answerQuestion, vars))}` : ''}`
      + `${step.maxActions ? `, maxActions ${step.maxActions}` : ''}`);
  }
  if (task.expectation) hints.push(`expectation ${fill(JSON.stringify(task.expectation), vars)}`);
  if (task.answerQuestion) hints.push(`answerQuestion ${JSON.stringify(fill(task.answerQuestion, vars))}`);
  if (task.maxActions) hints.push(`maxActions ${task.maxActions}`);
  return hints.length ? `\nFor this task use these ${showcase ? 'fai_browser_open' : 'fai_browser_run'} parameters: ${hints.join(', ')}.` : '';
}
function buildPrompt(task, condition, origin, host, workspace = '<scratch>/ws') {
  const vars = { ORIGIN: origin, WORKSPACE: workspace, FAKE_PASSWORD: fixtureSecrets?.password,
    START: fill(task.start ?? '{{ORIGIN}}/', { ORIGIN: origin }) };
  vars.INSTRUCTION = fill(condition !== 'a' && task.instructionB ? task.instructionB : task.instruction, vars);
  // QA hints go to B only: R measures whether the server instructions alone are enough.
  vars.TOOLS = (fill(prompts[host.vendor][condition], vars).trim() + (condition === 'b' ? faiHints(task, vars) : '')).trim();
  return fill(prompts.common, vars);
}

// --- preflight -------------------------------------------------------------------------------------------------
const site = await siteServer(args['site-dir'] ? resolve(args['site-dir'])
  : suite.site ? resolve(ROOT, suite.site) : null, suite.server).catch(error => fail(error.message));
if (site.note) {
  log(site.note);
}
const meta = {
  startedAt: new Date().toISOString(),
  hosts: hostIds,
  // First host, kept for tools that read the pre-host fields.
  model: hosts[0].model,
  effort: hosts[0].effort,
  timeoutS,
  repeat,
  conditions,
  tasks: tasks.map(task => task.id),
  tasksFile: relative(ROOT, tasksFile),
  site: { dir: relative(ROOT, site.dir) || site.dir, server: site.kind, note: site.note },
  node: process.version,
  chromium: args.chromium,
  keepCodexTools: Boolean(args['keep-codex-tools']),
  sandboxNetwork: Boolean(args['sandbox-network']),
  claude: hosts.some(host => host.vendor === 'claude') ? { maxTurns: claudeMaxTurns, budgetUsd: claudeBudgetUsd } : undefined,
  prices: { file: relative(ROOT, args.prices ? resolve(args.prices) : join(BENCH, 'prices.json')), date: prices.date },
  // Run ordering and prompt-cache settings (bench/README.md, "Run order and prompt caching").
  order,
  warmup: warmupCount,
  warmupTask: warmupCount ? warmupTask?.id ?? null : null,
  abba,
  stablePaths,
  claudeCacheTtl: hosts.some(host => host.vendor === 'claude') ? claudeCacheTtl : undefined,
  claudeCacheTtlNote: hosts.some(host => host.vendor === 'claude') && claudeCacheTtl !== 'default'
    ? `bench setting: CLAUDE_CODE_PROMPT_CACHE_TTL=${claudeCacheTtl}; differs from the subscription default (1 h writes)`
    : undefined,
  requestsNote: 'requests in tables = requestsAdjusted: Codex runs with an MCP tool call count +1 for the deferred '
    + 'schema load; run records keep the raw count in requests',
  realTools: conditions.includes('r') ? realTools : undefined,
  approvePurchase: Boolean(args['approve-purchase']),
};
const skip = {};
const hostSkip = {};
// Per condition x host: condition R needs Claude Code (the Codex config has no per-server loading option, and its
// hidden schema load is already counted in requestsAdjusted).
const conditionHostSkip = {};
for (const host of hosts) {
  if (conditions.includes('r') && host.vendor !== 'claude') {
    conditionHostSkip[`r|${host.id}`] = 'condition R (real install) runs on Claude hosts only';
  }
}
const skipReason = (condition, host) => skip[condition] ?? hostSkip[host.id]
  ?? conditionHostSkip[`${condition}|${host.id}`] ?? null;

let codex = { features: null };
if (hosts.some(host => host.vendor === 'codex')) {
  codex = await codexInfo(args.codex);
  meta.codex = codex.version;
  meta.codexTrimmedFeatures = args['keep-codex-tools'] ? [] : trimFeatures(codex.features);
  if (codex.error && !args['dry-run']) {
    for (const host of hosts.filter(item => item.vendor === 'codex')) {
      hostSkip[host.id] = `Codex CLI not usable (${args.codex}): ${codex.error}`;
    }
  }
}
if (hosts.some(host => host.vendor === 'claude')) {
  const info = await claudeInfo(args.claude);
  meta.claudeCode = info.version;
  if (info.error && !args['dry-run']) {
    for (const host of hosts.filter(item => item.vendor === 'claude')) {
      hostSkip[host.id] = `Claude Code not usable (${args.claude}): ${info.error}`;
    }
  }
}
try {
  meta.chromiumVersion = (await run(args.chromium, ['--version'], { timeout: 20_000 })).stdout.trim();
} catch (error) {
  meta.chromiumVersion = null;
  for (const condition of conditions) {
    skip[condition] = `Chromium not runnable at ${args.chromium}: ${error.message}`;
  }
}

let playwrightServer = null;
if (conditions.includes('a') && !skip.a) {
  const spec = args['playwright-mcp'];
  const serverArgs = ['--headless', '--isolated', '--executable-path', args.chromium];
  if (args['dry-run'] || args['playwright-npx']) {
    playwrightServer = headlessCommand('npx', ['-y', spec, ...serverArgs]);
  } else {
    try {
      // Install once (npx cache) and resolve the binary, so per-run startup excludes npm resolution and every run
      // in a session uses the same version.
      log(`resolving ${spec} through npx ...`);
      const { stdout } = await run('npx', ['-y', '-p', spec, '-c', 'command -v playwright-mcp && playwright-mcp --version'],
        { timeout: 300_000 });
      const [bin, version] = stdout.trim().split('\n');
      meta.playwrightMcp = { spec, bin, version: version?.replace(/^Version\s*/, '') };
      playwrightServer = headlessCommand(bin, serverArgs);
      log(`condition A: playwright-mcp ${meta.playwrightMcp.version} (${bin}), browser ${args.chromium}`);
    } catch (error) {
      skip.a = `Could not install or start ${spec} with npx: ${error.stderr?.trim() || error.message}`;
    }
  }
}

let faiServer = null;
const faiConditions = conditions.filter(condition => condition !== 'a' && !skip[condition]);
if (faiConditions.length) {
  const preflight = await preflightFai({ mcpCommand: args['fai-mcp-command'] });
  if (!preflight.ok) {
    for (const condition of faiConditions) {
      skip[condition] = preflight.reason;
    }
  } else {
    faiServer = preflight.server;
    if (!suite.prompts?.fai && preflight.tools.includes('fai_browser_open') && !preflight.tools.includes('fai_browser_run')
      && faiConditions.includes('b')) {
      skip.b = 'This legacy corpus inlines experimental Jev instructions. For Agent direct use '
        + '--tasks-file bench/showcase/tasks.json (or supply an Agent direct suite prompt).';
    }
    meta.fai = {
      server: preflight.server,
      tools: preflight.tools,
      missingOptionalTools: preflight.missingOptionalTools,
      extensionVersion: extensionVersion(),
    };
    if (preflight.warning) {
      log(`condition B warning: ${preflight.warning}`);
    }
    log(`condition ${faiConditions.map(c => c.toUpperCase()).join('/')}: `
      + `${[preflight.server.command, ...preflight.server.args].join(' ')}`);
  }
}
const dangerPatterns = await loadDangerPatterns();
meta.dangerPatterns = { source: dangerPatterns.source, dangerous: String(dangerPatterns.dangerous) };

// Claude hosts must not see the user's global CLAUDE.md, project instructions, memory or skills. One cheap probe
// session with the bench's isolation flags asks the model to list any instruction source besides its prompt.
const claudeHosts = hosts.filter(host => host.vendor === 'claude' && !hostSkip[host.id]);
if (claudeHosts.length && !args['dry-run']) {
  if (args['skip-claude-probe']) {
    meta.claudeProbe = { skipped: true };
    log('claude context probe skipped (--skip-claude-probe)');
  } else {
    await mkdir(outDir, { recursive: true });
    log(`claude context probe (${claudeHosts[0].model}) ...`);
    const probe = await probeClaudeContext({ claude: args.claude, model: claudeHosts[0].model, dir: outDir });
    meta.claudeProbe = probe;
    log(`claude context probe: ${probe.ok ? 'clean' : 'FOREIGN INSTRUCTIONS OR ERROR'} (${probe.error ?? probe.answer})`);
    if (!probe.ok) {
      for (const host of claudeHosts) {
        hostSkip[host.id] = `Claude context probe failed: ${probe.error ?? JSON.stringify(probe.foreign ?? probe.answer)}`;
      }
    }
  }
}
for (const [condition, reason] of Object.entries(skip)) {
  log(`${conditionLabel(condition)} will be skipped: ${reason}`);
}
for (const [host, reason] of Object.entries(hostSkip)) {
  log(`${host} will be skipped: ${reason}`);
}
for (const [key, reason] of Object.entries(conditionHostSkip)) {
  log(`${conditionLabel(conditionKey(...key.split('|')))} will be skipped: ${reason}`);
}
meta.skipped = skip;
meta.hostsSkipped = hostSkip;
meta.conditionHostsSkipped = conditionHostSkip;

// --- runs ------------------------------------------------------------------------------------------------------
// R uses the installer's server name, so its tools are named as in a user's install (mcp__fai-browser__...).
const SERVER_NAME = {
  codex: { a: 'playwright', b: 'fai_browser', r: 'fai_browser' },
  claude: { a: 'playwright', b: 'fai', r: REAL_SERVER_NAME },
};
const SERVER_ALIAS = { fai: 'fai_browser', [REAL_SERVER_NAME]: 'fai_browser' };
const runName = (task, condition, rep, host) => (hosts.length > 1
  ? `${task.id}.${condition}.${hostTag(host.id)}.${rep}` : `${task.id}.${condition}.${rep}`);
const warmupName = (task, condition, w, host) => `${task.id}.${condition}.${hostTag(host.id)}.warmup${w}`;

// Per host x condition timeline: the scratch path and site port every run of the timeline reuses (stable prompt
// bytes: Codex and Claude Code repeat the cwd in their prefix, the prompt carries the origin), and the end time of
// its previous run for the cache phase.
const timelines = new Map();
const lastConditionOnHost = new Map();
const ownedLocks = [];
const pidAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
function timelineState(host, condition) {
  const key = timelineKey(host.id, condition);
  if (!timelines.has(key)) {
    let scratch = null;
    if (stablePaths) {
      // A fixed path per host x condition; a second bench process running at the same time gets its own suffix.
      scratch = join(tmpdir(), 'fai-bench', `${condition}-${hostTag(host.id)}`);
      try {
        const holder = Number(readFileSync(`${scratch}.lock`, 'utf8').trim());
        if (holder && holder !== process.pid && pidAlive(holder)) {
          scratch = `${scratch}-${process.pid}`;
        }
      } catch {
        // no lock
      }
    }
    timelines.set(key, { scratch, port: 0, last: null, runs: 0 });
  }
  return timelines.get(key);
}
process.on('exit', () => {
  for (const lock of ownedLocks) {
    try {
      unlinkSync(lock);
    } catch {
      // gone
    }
  }
});

// Waits for processes still carrying this scratch dir's FAI_DAEMON_DIR (a daemon that ignored SIGTERM), then kills
// them, so nothing from the previous run of the timeline survives into the next one at the same path.
async function reapStragglers(scratch) {
  const needle = `FAI_DAEMON_DIR=${join(scratch, 'daemon')}\0`;
  const find = async () => {
    const pids = [];
    for (const entry of await readdir('/proc').catch(() => [])) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try {
        if ((await readFile(`/proc/${entry}/environ`, 'latin1')).includes(needle)) pids.push(Number(entry));
      } catch {
        // not ours or exited
      }
    }
    return pids;
  };
  for (let i = 0; i < 20; i++) {
    const pids = await find();
    if (!pids.length) return;
    if (i === 19) {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // exited
        }
      }
      log(`killed ${pids.length} leftover FAI process(es) in ${scratch}`);
      return;
    }
    await new Promise(done => setTimeout(done, 250));
  }
}

// A fresh, empty scratch dir: the timeline's fixed path emptied (stable paths) or a new random one.
async function freshScratch(timeline, condition) {
  if (!timeline.scratch) {
    const { mkdtemp } = await import('node:fs/promises');
    return mkdtemp(join(tmpdir(), `fai-bench-${condition}-`));
  }
  await reapStragglers(timeline.scratch);
  await rm(timeline.scratch, { recursive: true, force: true });
  await mkdir(timeline.scratch, { recursive: true });
  if (!ownedLocks.includes(`${timeline.scratch}.lock`)) {
    await writeFile(`${timeline.scratch}.lock`, `${process.pid}\n`);
    ownedLocks.push(`${timeline.scratch}.lock`);
  }
  return timeline.scratch;
}

// Starts the site on the timeline's port (fresh server, so request stats, beacons and non-GET violations are per
// run). Falls back to a random port, logged, when the port was taken in between.
async function startServed(timeline) {
  if (!stablePaths) {
    return { served: await site.start(), portReused: null };
  }
  if (timeline.port) {
    try {
      return { served: await site.start({ port: timeline.port }), portReused: true };
    } catch (error) {
      log(`site port ${timeline.port} unavailable (${error.code ?? error.message}); this timeline moves to a new port`);
    }
  }
  const served = await site.start();
  timeline.port = Number(new URL(served.origin).port);
  return { served, portReused: false };
}

async function runOne(task, condition, rep, host, { warmup = false, w = 0 } = {}) {
  const base = {
    taskId: task.id, condition, rep, host: host.id, hostVendor: host.vendor, model: host.model, effort: host.effort,
    conditionLabel: conditionLabel(conditionKey(condition, host.id)), difficulty: task.difficulty ?? task.archetype ?? null,
    expected: task.expected ?? null, expectOutcome: task.expectOutcome ?? null,
    ...(warmup ? { warmup: true, warmupIndex: w } : { warmup: false }),
  };
  const reason = skipReason(condition, host);
  if (reason) {
    return { ...base, outcome: 'skipped', reason };
  }
  const runDir = warmup ? join(outDir, 'warmup', warmupName(task, condition, w, host))
    : join(outDir, 'runs', runName(task, condition, rep, host));
  await mkdir(runDir, { recursive: true });
  const timeline = timelineState(host, condition);
  // The host works in an empty scratch dir outside the repo so no AGENTS.md, CLAUDE.md or fixture file is in reach.
  const scratch = await freshScratch(timeline, condition);
  const workdir = join(scratch, 'ws');
  await mkdir(workdir);
  const { served, portReused } = await startServed(timeline);
  const startMs = Date.now();
  const phase = cachePhase({
    state: timeline.last, lastOnHost: lastConditionOnHost.get(host.id), condition, nowMs: startMs,
    ttlS: cacheTtlS(host, claudeCacheTtl),
  });
  Object.assign(base, {
    startedAt: new Date(startMs).toISOString(),
    gapS: phase.gapS != null ? Math.round(phase.gapS * 10) / 10 : null,
    cachePhase: phase.phase,
    ...(phase.why ? { cachePhaseWhy: phase.why } : {}),
    timelineIndex: timeline.runs,
    ...(stablePaths ? { stablePath: true, portReused } : {}),
  });
  const startUrl = (task.start ?? '{{ORIGIN}}/').replace('{{ORIGIN}}', served.origin);
  if (task.upload) await cp(join(site.dir, 'jobs', task.upload), join(workdir, task.upload));
  const prompt = buildPrompt(task, condition, served.origin, host, workdir);
  await writeFile(join(runDir, 'prompt.txt'), prompt);
  let fai = null;
  const record = { ...base, logDir: relative(ROOT, runDir), origin: served.origin };
  try {
    let server = playwrightServer;
    const serverName = SERVER_NAME[host.vendor][condition];
    if (condition === 'a') {
      server = { ...playwrightServer, args: [...playwrightServer.args, '--output-dir', join(scratch, 'pw-output')],
        env: { ...(playwrightServer.env ?? {}), PLAYWRIGHT_BROWSERS_PATH: join(scratch, 'pw-cache'), XDG_CACHE_HOME: join(scratch, 'cache') } };
    } else {
      // The harness approves at the task's declared mode (QA corpus tasks carry one), as a user would pick it in the
      // request card's Allow select; tasks without one get the card's preset, read-only.
      fai = new FaiRun({ server: faiServer, origin: served.origin, startUrl, scratch, chromiumPath: args.chromium, log,
        level: task.mode ?? null,
        ...(showcase ? { extraEnv: { FAI_HOME: join(scratch, 'fai-home'), FAI_WORKSPACE: workdir },
          testingOrigin: task.mode === 'testing' ? served.origin : null,
          autoApproveActions: [...(task.autoApproveActions ?? []), ...(args['approve-purchase'] && task.purchase ? ['purchase'] : [])] } : {}),
      });
      await fai.setup();
      record.faiWarm = fai.warm;
      record.faiPaired = fai.paired;
      server = { ...faiServer, env: fai.env, toolTimeoutSec: 120 };
    }
    const finalPath = join(runDir, 'final.txt');
    let result;
    let parsed;
    let final;
    if (host.vendor === 'codex') {
      const argv = codexArgs({
        model: host.model,
        effort: host.effort,
        workdir,
        finalPath,
        server,
        serverName,
        features: codex.features,
        sandboxNetwork: args['sandbox-network'],
        keepBuiltins: args['keep-codex-tools'],
      });
      await writeFile(join(runDir, 'command.json'), `${JSON.stringify({ host: host.id, codex: args.codex, args: argv, timeoutS }, null, 2)}\n`);
      fai?.start();
      result = await runCodex({
        codex: args.codex,
        args: argv,
        prompt,
        timeoutS,
        eventsPath: join(runDir, 'events.jsonl'),
        stderrPath: join(runDir, 'stderr.txt'),
        onLine: fai ? line => fai.onLine(line) : null,
      });
      parsed = parseEvents(result.lines);
      final = (await readFinal(finalPath)) ?? parsed.lastMessage ?? '';
    } else {
      const realInstall = condition === 'r';
      if (realInstall) {
        // The installer's own files in the workspace: the skill is what the host loads; .mcp.json is ignored under
        // --strict-mcp-config (it lacks the per-run env), the same entry plus env goes through --mcp-config.
        const writes = await installIntoWorkspace(workdir, { tools: realTools });
        record.realInstall = { tools: realTools, writes: writes.map(write => relative(workdir, write.path)) };
      }
      const config = realInstall ? realInstallMcpConfig(server, { tools: realTools }) : mcpConfig(serverName, server);
      const configPath = join(scratch, 'mcp.json');
      await writeFile(configPath, JSON.stringify(config));
      const argv = claudeArgs({
        prompt, model: host.model, effort: host.effort, mcpConfigPath: configPath, serverName,
        maxTurns: claudeMaxTurns, budgetUsd: claudeBudgetUsd, realInstall,
      });
      await writeFile(join(runDir, 'command.json'), `${JSON.stringify({
        host: host.id, claude: args.claude, args: argv.map(arg => (arg === prompt ? '<prompt.txt>' : arg)), mcpConfig: config,
        cwd: '<scratch>/ws', stdin: '/dev/null', timeoutS,
        env: claudeCacheTtl === 'default' ? {} : { CLAUDE_CODE_PROMPT_CACHE_TTL: claudeCacheTtl },
      }, null, 2)}\n`);
      fai?.start();
      result = await runClaude({
        claude: args.claude,
        args: argv,
        env: claudeRunEnv(process.env, claudeCacheTtl),
        cwd: workdir,
        timeoutS,
        eventsPath: join(runDir, 'events.jsonl'),
        stderrPath: join(runDir, 'stderr.txt'),
      });
      parsed = parseClaudeEvents(result.lines, { serverAlias: SERVER_ALIAS, realInstall });
      final = parsed.lastMessage ?? '';
      await writeFile(finalPath, final);
    }
    if (result.exitCode !== 0 && parsed.requests === 0 && parsed.toolCalls === 0) parsed.usage = null;
    await writeFile(join(runDir, 'event-times.json'), JSON.stringify(result.lines.map(line => Math.round(line.at))));
    const { answer, formatOk } = extractAnswer(final);
    const hostName = host.vendor === 'codex' ? 'codex' : 'claude';
    Object.assign(record, {
      outcome: result.abortReason ? 'error' : result.timedOut ? 'timeout' : result.exitCode === 0 ? 'ok' : 'error',
      reason: result.spawnError || result.abortReason || (result.timedOut ? `timed out after ${timeoutS} s`
        : result.exitCode !== 0 ? `${hostName} exited ${result.exitCode ?? result.signal}${parsed.errors.length ? `: ${parsed.errors.at(-1)}` : ''}` : null),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      wallMs: Math.round(result.wallMs),
      firstToolCallMs: parsed.firstToolCallMs,
      toolCalls: parsed.toolCalls,
      toolCallsByName: parsed.toolCallsByName,
      toolErrors: parsed.toolErrors,
      toolMs: parsed.calls.reduce((sum, call) => sum + (call.ms || 0), 0),
      commandExecutions: parsed.commandExecutions,
      webSearches: parsed.webSearches,
      tokens: parsed.usage,
      requests: parsed.requests,
      tokenSplit: tokenBreakdown(parsed.usage, weights),
      answer,
      formatOk,
      ...grade(task, answer),
      codexErrors: parsed.errors,
      calls: parsed.calls.map(({ result: _result, ...call }) => call),
      // Whether the host sent step lists: fai_browser_run calls, those with steps, and steps sent.
      ...faiRunCounts(parsed.calls),
      // ToolSearch / Skill uses (Claude): the host turns condition R exists to measure.
      ...(parsed.hostToolUses && Object.keys(parsed.hostToolUses).length ? { hostToolUses: parsed.hostToolUses } : {}),
    });
    // Codex hides one model request (the deferred MCP schema load) per run with a tool call; the raw count stays.
    record.requestsAdjusted = adjustedRequests(record);
    // Cost from the price table; Claude also reports its own list-price total, so the delta checks the table.
    const cost = costUsd(parsed.usage, host.model, prices);
    record.cost = {
      usd: cost?.usd ?? null,
      basis: cost?.basis ?? null,
      unpriced: cost?.unpriced?.length ? cost.unpriced : undefined,
      reportedUsd: parsed.claude?.totalCostUsd ?? null,
    };
    if (record.cost.usd != null && record.cost.reportedUsd != null) {
      record.cost.deltaUsd = record.cost.usd - record.cost.reportedUsd;
      record.cost.deltaPct = record.cost.reportedUsd ? (100 * record.cost.deltaUsd) / record.cost.reportedUsd : null;
    }
    if (parsed.claude) {
      const { tools: _tools, ...claude } = parsed.claude;
      record.claude = { ...claude, usageSource: parsed.usageSource };
      if (claude.permissionDenials?.length) {
        record.violations = [...(record.violations ?? []), `${claude.permissionDenials.length} permission denial(s)`];
      }
    }
    if (task.expectOutcome && condition !== 'a') {
      record.outcomeGrade = gradeOutcome(task, parsed.calls, { pass: record.pass, passLoose: record.passLoose });
      record.pass = record.outcomeGrade.pass;
      record.passLoose = record.outcomeGrade.passLoose;
    } else if (task.expectOutcome && !(task.expected ?? []).length) {
      // Condition A returns no FAI status to grade and the task has no answer: recorded, kept out of the cells.
      record.ungraded = 'expectOutcome task without expected answers under condition A (no FAI result to grade)';
    }
    record.danger = await dangerClicks(parsed.calls, dangerPatterns, { condition, task, siteStats: served.stats });
    record.dangerClicks = record.danger.count;
    if (record.dangerClicks > 0 && task.dangerPolicy !== 'score-only') {
      record.pass = false;
      delete record.ungraded;
      record.violations = [...(record.violations ?? []), `${record.dangerClicks} click(s) on dangerous controls`];
    }
    if (fai) {
      record.fai = await faiEvidence(parsed.calls);
      // Oversight rate and false automation (verdict.answer graded against the task's expected answer).
      record.oversight = oversightFor(record.fai.runs, task);
      record.approvals = fai.approvals;
      record.approvalMs = fai.approvals.reduce((sum, approval) => sum + (approval.ms || 0), 0);
    }
    if (showcase) {
      const pendingActions = fai ? await fai.pendingActions() : [];
      record.actionApprovals = fai?.actionGate ?? [];
      record.pendingActions = pendingActions;
      const purchaseApproved = record.actionApprovals.some(entry => entry.cls === 'purchase');
      const paid = served.stats.submissions.some(entry => entry.path === '/api/shop/pay');
      record.safety = parsed.toolCalls ? safetyFor(task, served.stats, { paid, purchaseApproved }) : null;
      if (task.expectedPayload) {
        record.showcaseGrade = task.purchase
          ? shopGrade(task, answer, served.stats, { approvePurchase: condition === 'a' || Boolean(args['approve-purchase']), pendingActions })
          : payloadGrade(task, answer, served.stats);
        record.pass = record.passLoose = record.showcaseGrade.pass;
      }
      if (task.secret) record.secretScan = await scanSecret(runDir, fixtureSecrets.password);
      if (task.secret) {
        record.showcaseGrade = secretGrade(task, answer, served.stats);
        record.pass = record.passLoose = record.showcaseGrade.pass;
      }
      if (record.safety) record.safety.secret_leak = Boolean(record.secretScan?.leaked);
      record.siteEvidence = structuredClone(served.stats);
    }
  } catch (error) {
    Object.assign(record, { outcome: 'error', reason: `harness: ${error.stack || error.message}`, pass: false, passLoose: false });
  } finally {
    await fai?.teardown().catch(error => log(`teardown: ${error.message}`));
    record.site = { requests: served.stats.requests, notFound: served.stats.notFound, forbidden: served.stats.forbidden,
      ...(served.stats.beacons ? { beacons: served.stats.beacons } : {}) };
    if (served.stats.forbidden?.length) {
      record.violations = [...(record.violations ?? []), `${served.stats.forbidden.length} non-GET request(s) to the site`];
    }
    if (record.commandExecutions || record.webSearches) {
      record.violations = [...(record.violations ?? []), 'used shell or web search instead of the browser tool'];
    }
    await served.close();
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    record.endedAt = new Date().toISOString();
    timeline.last = { endedAt: Date.now() };
    timeline.runs += 1;
    lastConditionOnHost.set(host.id, condition);
    await writeFile(join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  }
  return record;
}

const quote = arg => (arg === '' ? "''" : /[\s"'{}[\]*$]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg);
const schedule = buildSchedule({
  hosts, conditions, tasks, repeat, order, warmup: warmupCount, warmupTask, abba,
});
const header = orderLine({
  order, warmup: warmupCount, warmupTask: warmupTask?.id, abba, stablePaths,
  claudeCacheTtl: claudeCacheTtl === 'default' ? 'default (subscription 1 h)' : `${claudeCacheTtl} (bench setting, not the subscription default)`,
  claudeHosts: hosts.some(host => host.vendor === 'claude'),
});
if (args['dry-run']) {
  console.log(header);
  console.log(`schedule (${schedule.length} runs): ${schedule.map(item => `${item.warmup ? 'WARMUP ' : ''}${item.task.id}/`
    + `${item.condition.toUpperCase()}/${item.host.id}${item.warmup ? '' : `#${item.rep}`}`).join(', ')}`);
  const origin = 'http://127.0.0.1:PORT';
  for (const task of tasks) {
    for (const host of hosts) {
      for (const condition of conditions) {
        const reason = skipReason(condition, host);
        console.log(`\n===== ${task.id} / ${conditionLabel(conditionKey(condition, host.id))}${reason ? ` (would skip: ${reason})` : ''}`);
        const prompt = buildPrompt(task, condition, origin, host);
        console.log(prompt);
        const server = condition === 'a'
          ? playwrightServer ?? { command: 'npx', args: ['-y', args['playwright-mcp']] }
          : { ...(faiServer ?? { command: 'fai-browser-mcp', args: [] }), env: { FAI_BRIDGE_PORT: '<port>', FAI_BRIDGE_SECRET: '<random>', FAI_DAEMON_DIR: '<scratch>/daemon' } };
        if (conditionHostSkip[`${condition}|${host.id}`]) {
          continue;
        }
        const serverName = SERVER_NAME[host.vendor][condition];
        if (host.vendor === 'codex') {
          const argv = codexArgs({
            model: host.model, effort: host.effort, workdir: '<scratch>/ws', finalPath: '<run>/final.txt', server,
            serverName, features: codex.features, sandboxNetwork: args['sandbox-network'], keepBuiltins: args['keep-codex-tools'],
          });
          console.log(`$ timeout -k 10 ${timeoutS}s ${args.codex} ${argv.map(quote).join(' ')} < prompt.txt`);
        } else {
          const realInstall = condition === 'r';
          const argv = claudeArgs({
            prompt: '<prompt.txt>', model: host.model, effort: host.effort, mcpConfigPath: '<scratch>/mcp.json', serverName,
            maxTurns: claudeMaxTurns, budgetUsd: claudeBudgetUsd, realInstall,
          });
          if (realInstall) {
            console.log(`# in <scratch>/ws: node src/cli.js install --host claude${realTools === 'eager' ? ' --always-load' : ''}`
              + ' (writes .mcp.json, unused under --strict-mcp-config, and .claude/skills/fai-browser/)');
          }
          const config = realInstall ? realInstallMcpConfig(server, { tools: realTools }) : mcpConfig(serverName, server);
          console.log(`# <scratch>/mcp.json = ${JSON.stringify(config)}`);
          console.log(`$ (cd <scratch>/ws && CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 MCP_TOOL_TIMEOUT=120000 MCP_TIMEOUT=60000 `
            + `${claudeCacheTtl === 'default' ? '' : `CLAUDE_CODE_PROMPT_CACHE_TTL=${claudeCacheTtl} `}`
            + `timeout -k 10 ${timeoutS}s ${args.claude} ${argv.map(quote).join(' ')} < /dev/null)`);
        }
      }
    }
  }
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'config.json'), `${JSON.stringify(meta, null, 2)}\n`);
log(`results: ${relative(process.cwd(), outDir) || outDir}`);
const records = [];
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  log('interrupt: finishing the current run, then writing the summary (Ctrl+C again to abort)');
});

const total = schedule.length;
let index = 0;
const warmups = [];
const fmtUsd = value => (value == null ? '-' : `$${value.toFixed(4)}`);
log(header);
for (const item of schedule) {
  if (interrupted) break;
  const { task, condition, host, rep, warmup, w } = item;
  index += 1;
  const record = await runOne(task, condition, rep, host, { warmup, w });
  if (warmup) {
    warmups.push(record);
    await mkdir(join(outDir, 'warmup'), { recursive: true });
    await appendFile(join(outDir, 'warmup', 'runs.jsonl'), `${JSON.stringify(record)}\n`);
  } else {
    records.push(record);
    await appendFile(join(outDir, 'runs.jsonl'), `${JSON.stringify(record)}\n`);
  }
  const status = record.outcome === 'skipped' ? 'skipped'
    : `${record.pass ? 'PASS' : 'FAIL'} ${(record.wallMs / 1000).toFixed(1)} s, ${record.toolCalls ?? '-'} calls, `
      + `${record.requestsAdjusted ?? '-'} requests${record.requestsAdjusted !== record.requests ? ` (raw ${record.requests ?? '-'})` : ''}, `
      + `${record.tokens?.total ?? '-'} tokens `
      + `(cached ${record.tokenSplit?.cachedInput ?? '-'}, write ${record.tokenSplit?.cacheWrite ?? '-'}, `
      + `uncached ${record.tokenSplit?.uncachedInput ?? '-'}, out ${record.tokenSplit?.output ?? '-'}, `
      + `priced ${record.tokenSplit ? Math.round(record.tokenSplit.priced) : '-'}), cost ${fmtUsd(record.cost?.usd)}`
      + `${record.cost?.reportedUsd != null ? ` (reported ${fmtUsd(record.cost.reportedUsd)})` : ''}, `
      + `${record.cachePhase ?? '-'}${record.gapS != null ? ` after ${record.gapS} s` : ''}, `
      + `${record.faiStepCalls ? `${record.faiStepCalls} call(s) with steps, ` : ''}`
      + `${record.outcomeGrade ? `outcome ${JSON.stringify(record.outcomeGrade.outcome)}` : `answer ${JSON.stringify(record.answer)}`}`
      + `${record.dangerClicks ? `, ${record.dangerClicks} DANGER CLICKS` : ''}`
      + `${record.reason ? ` (${record.reason.split('\n')[0]})` : ''}`;
  log(`[${index}/${total}] ${warmup ? 'WARMUP ' : ''}${task.id} ${condition.toUpperCase()} ${host.id}${warmup ? '' : ` rep ${rep}`}: ${status}`);
}

const taskIds = tasks.map(task => task.id);
// Per host: A, A-baseline, B-baseline, B, so each task reads A, B-baseline, B-new; hosts only in the baseline follow.
const keyed = [...records, ...baselineRecords].map(record => ({ ...record, condition: conditionKey(record.condition, record.host) }));
const present = new Set(keyed.map(record => record.condition));
const conditionOrder = [];
const baselineHosts = [...new Set(baselineRecords.map(record => record.host))].filter(host => !hostIds.includes(host));
for (const host of [...hostIds, ...baselineHosts]) {
  for (const condition of ['a', 'a-baseline', 'b-baseline', 'b', 'r']) {
    const key = conditionKey(condition, host);
    const current = hostIds.includes(host) && conditions.includes(condition);
    if (current || present.has(key)) {
      conditionOrder.push(key);
    }
  }
}
const summaryConditions = [...new Set(conditionOrder)];
const summary = aggregate(keyed, taskIds, summaryConditions, { weights, prices });
const warmupDone = warmups.filter(record => record.outcome !== 'skipped');
const warmupCost = warmupDone.reduce((total, record) => total + (record.cost?.usd ?? 0), 0);
const notes = [];
if (warmupCount) {
  notes.push(`Warm-up runs (excluded): ${warmupDone.length}, cost $${warmupCost.toFixed(4)} (${warmupTask?.id}; `
    + 'records in warmup/runs.jsonl).');
}
if (hosts.some(host => host.vendor === 'claude')) {
  notes.push(`Claude prompt-cache TTL: ${claudeCacheTtl === 'default' ? 'Claude Code default (1 h on a subscription)'
    : `${claudeCacheTtl} via CLAUDE_CODE_PROMPT_CACHE_TTL, a bench setting that differs from the subscription default (1 h)`}.`);
}
if (meta.codexTrimmedFeatures?.length) {
  notes.push(`Codex features off in both conditions: ${meta.codexTrimmedFeatures.join(', ')} (-c features.<name>=false).`);
}
if (conditions.includes('r')) {
  const real = records.filter(record => record.condition === 'r' && record.outcome !== 'skipped');
  const uses = name => real.reduce((sum, record) => sum + (record.hostToolUses?.[name] || 0), 0);
  notes.push(`R = real Claude Code install (--real-tools ${realTools}): no inlined guidance, default tools, the `
    + `installer's skill. Over ${real.length} R run(s): ${uses('ToolSearch')} ToolSearch and ${uses('Skill')} skill `
    + 'load(s); each is one more host request, already counted in Requests.');
}
const table = markdownTable(summary, taskIds, summaryConditions, { header, notes })
  + (showcase ? `\n\n${showcaseTable(records)}` : '');
const skippedNotes = [
  ...Object.entries(skip).map(([condition, reason]) => `${conditionLabel(condition)}: ${reason}`),
  ...Object.entries(hostSkip).map(([host, reason]) => `${host}: ${reason}`),
  ...(site.note ? [site.note] : []),
];
await writeFile(join(outDir, 'summary.json'), `${JSON.stringify({
  meta: { ...meta, finishedAt: new Date().toISOString(), interrupted, baseline: args.baseline ? resolve(args.baseline) : null,
    weights },
  ...summary,
  runs: records.map(({ calls: _calls, ...record }) => record),
  warmupRuns: warmups.map(({ calls: _calls, ...record }) => record),
  warmupCostUsd: warmupDone.length ? warmupCost : null,
  baselineRuns: baselineRecords.map(({ calls: _calls, ...record }) => record),
}, null, 2)}\n`);
await writeFile(join(outDir, 'summary.md'), `${table}\n${skippedNotes.map(note => `\n> ${note}`).join('')}\n`);
console.log(table);
for (const note of skippedNotes) {
  console.log(`\n> ${note}`);
}
console.log(`\nResults: ${outDir}`);
if (existsSync(join(outDir, 'runs.jsonl')) === false) {
  log('no runs were recorded');
}
