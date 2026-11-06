#!/usr/bin/env node
// Live bench: a real Claude Code host (`claude -p`) with the real installed FAI Browser MCP entry, per task.
//
//   node bench/live/run.mjs --live [--tasks id,id] [--host claude:claude-sonnet-5-5:low]... [--yes]
//       The owner's daemon on 127.0.0.1:4318, the owner's headed Chrome (profile "Public"), the owner approving each
//       tab in the extension popup, live sites. No daemon, browser or site is started here. The scratch workspace
//       holds only the installer's files; its .mcp.json (the plain entry, no env) is the --mcp-config.
//   node bench/live/run.mjs --private [--tasks about-members,pricing-pro] [--tasks-file bench/tasks.json] [--fai-home DIR]
//       compare.mjs condition R: private daemon on a random port, headless Chromium with the extension, the
//       harness approving at the task's mode, the fixture site. For verification and CI-like reruns.
//   node bench/live/run.mjs --regrade DIR      recompute grades after the owner edits DIR/grades.json
//   node bench/live/run.mjs --import DIR --out RESULTS   convert hand-run live dirs (events.jsonl, traces/) to this format
//   node bench/live/run.mjs --list [--private]
// See bench/live/README.md.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs, promisify } from 'node:util';
import {
  CLAUDE_CACHE_TTLS, claudeArgs, claudeInfo, claudeRunEnv, parseClaudeEvents, probeClaudeContext, runClaude,
} from '../lib/claude.mjs';
import { hostTag, loadPrices, parseHost, parseHosts } from '../lib/hosts.mjs';
import { installIntoWorkspace, REAL_SERVER_NAME, REAL_TOOLS, realInstallMcpConfig } from '../lib/real-install.mjs';
import { costUsd, faiRunCounts, oversightFor, tokenBreakdown } from '../lib/metrics.mjs';
import { serverCommand } from '../../src/install.js';
import { CLIENT_VERSION, FaiBrowserClient, probeHealth } from '../../src/client.js';
import {
  applyGrades, approvalEstimate, approvalOutcome, liveMcpConfig, buildSummary, evaluateChecklist, gradeFinal, graderFor, gradesFile, loadLiveTasks,
  loadPrivateTasks, privatePrompt, receiptsFrom, renderChecklist, runCallStats, renderSummary, runKey, sanitizeHome, signalsIn,
  summarizeTrace,
} from './lib.mjs';

const run = promisify(execFile);
const HERE = import.meta.dirname;
const BENCH = resolve(HERE, '..');
const ROOT = resolve(BENCH, '..');
const LIVE_PORT = 4318;
const DEFAULT_HOST = 'claude:claude-sonnet-5-5:low';
const SERVER_ALIAS = { [REAL_SERVER_NAME]: 'fai_browser' };

const { values: args } = parseArgs({
  options: {
    live: { type: 'boolean' },
    private: { type: 'boolean' },
    regrade: { type: 'string' },
    import: { type: 'string' },
    'approval-wait-ms': { type: 'string', default: '180000' },
    list: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    tasks: { type: 'string' },
    'tasks-file': { type: 'string' },
    'site-dir': { type: 'string' },
    host: { type: 'string', multiple: true },
    repeat: { type: 'string', default: '1' },
    'timeout-s': { type: 'string' },
    out: { type: 'string' },
    label: { type: 'string' },
    claude: { type: 'string', default: process.env.CLAUDE_BIN || 'claude' },
    'claude-max-turns': { type: 'string', default: '40' },
    'claude-budget-usd': { type: 'string', default: '3' },
    'claude-cache-ttl': { type: 'string' },
    'real-tools': { type: 'string', default: 'run' },
    'skip-claude-probe': { type: 'boolean' },
    chromium: { type: 'string', default: process.env.CHROMIUM_PATH || '/usr/bin/chromium' },
    'fai-home': { type: 'string' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const USAGE = `Usage: node bench/live/run.mjs --live | --private | --regrade DIR | --list [options]
  --live                  The owner's daemon on 127.0.0.1:${LIVE_PORT}, headed Chrome, owner approval, live sites
  --private               Private daemon + headless Chromium + auto-approval + fixture site (verification)
  --regrade DIR           Recompute grades (auto from the task file, manual from DIR/grades.json) and the summary
  --import DIR            Convert hand-run live run dirs (DIR/<id>/ with prompt.txt, events.jsonl, started.txt,
                          ended.txt, traces/*.json) into run.json + summary under --out (live mode, grading manual)
  --approval-wait-ms N    Live: FAI_MCP_MAX_CALL_MS written into the workspace's server entry: how long one
                          fai_browser_run call waits for the owner's approval (default 180000; the server's own
                          default is 45000). MCP_TOOL_TIMEOUT stays above it.
  --list                  List task ids (--private: of --tasks-file)
  --tasks id,id           Subset (default: every task that is not skip: true)
  --tasks-file FILE       Live: default bench/live/tasks.json. Private: default bench/tasks.json (or bench/qa/tasks.json)
  --site-dir DIR          Private: site to serve (default: the task file's "site", else fixtures/site)
  --host V:SLUG:EFFORT    Claude host, repeatable (default ${DEFAULT_HOST}; aliases sonnet, opus)
  --repeat N              Runs per task and host (default 1)
  --timeout-s N           Per-task limit for timeout(1) (default 900 live, 300 private)
  --yes, -y               Live: do not wait for Enter at the checklist and between tasks
  --out DIR               Results directory (default bench/live/results/<mode>-<timestamp>)
  --label TEXT            Label in the summary
  --claude BIN            Claude Code binary (default $CLAUDE_BIN or claude)
  --claude-max-turns N    claude -p --max-turns backstop (default 40)
  --claude-budget-usd X   claude -p --max-budget-usd backstop per task (default 3)
  --claude-cache-ttl V    default (live default: Claude Code's own), 5m (private default) or 1h
  --real-tools V          run (default: what install --host claude writes), eager or deferred
  --skip-claude-probe     Skip the one-off context probe
  --chromium PATH         Private: browser (default $CHROMIUM_PATH or /usr/bin/chromium)
  --fai-home DIR          Private: FAI_HOME for the private daemon (where .env.local and artifacts/ are; default the
                          package root). Never read by the runner.
  --dry-run               Print the checklist plan, prompts and host commands without contacting anything`;

const log = message => process.stderr.write(`[live] ${message}\n`);
const fail = message => {
  console.error(message);
  process.exit(1);
};
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
const modes = ['live', 'private', 'regrade', 'import'].filter(mode => args[mode]);
if (modes.length > 1) fail('pick one of --live, --private, --regrade, --import');
const mode = modes[0] ?? (args.list ? 'live' : null);
if (!mode) fail(`${USAGE}\n\nPick --private (verification) or --live (owner present).`);

const intArg = (name, value, min, max) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) fail(`--${name} must be an integer from ${min} to ${max}`);
  return number;
};
const ids = args.tasks ? args.tasks.split(',').map(id => id.trim()).filter(Boolean) : null;
const live = mode === 'live' || mode === 'import';
const tasksFile = resolve(args['tasks-file'] ?? (live ? join(HERE, 'tasks.json') : join(BENCH, 'tasks.json')));

async function git(...argv) {
  try {
    return (await run('git', ['-C', ROOT, ...argv], { timeout: 10_000 })).stdout.trim();
  } catch {
    return null;
  }
}

// --- regrade ---------------------------------------------------------------------------------------------------
if (mode === 'regrade') {
  await regrade(resolve(args.regrade));
  process.exit(0);
}
const approvalWaitMs = intArg('approval-wait-ms', args['approval-wait-ms'], 1000, 3_600_000);
// Claude Code must not cut the tool call before the server's own approval wait ends.
const mcpToolTimeoutMs = Math.max(600_000, approvalWaitMs + 120_000);

let loaded;
try {
  loaded = live ? loadLiveTasks(tasksFile, { ids }) : loadPrivateTasks(tasksFile, { ids });
} catch (error) {
  fail(error.message);
}
if (args.list) {
  for (const task of loaded.tasks) {
    console.log(`${task.id.padEnd(22)} ${(task.mode ?? '').padEnd(12)} ${live ? task.prompt : task.prompt ?? task.instruction}`);
  }
  for (const item of loaded.skipped) console.log(`${item.id.padEnd(22)} SKIP         ${item.reason}`);
  process.exit(0);
}
for (const item of loaded.skipped) log(`skipping ${item.id}: ${item.reason}`);

let hosts;
try {
  hosts = args.host?.length ? parseHosts(args.host) : [parseHost(DEFAULT_HOST)];
} catch (error) {
  fail(error.message);
}
if (hosts.some(host => host.vendor !== 'claude')) fail('bench/live runs Claude Code hosts only (--host claude:<slug>:<effort>)');
const repeat = intArg('repeat', args.repeat, 1, 20);
const timeoutS = intArg('timeout-s', args['timeout-s'] ?? (live ? 900 : 300), 10, 7200);
const maxTurns = intArg('claude-max-turns', args['claude-max-turns'], 1, 500);
const budgetUsd = Number(args['claude-budget-usd']);
if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) fail('--claude-budget-usd must be a positive number');
const cacheTtl = args['claude-cache-ttl'] ?? (live ? 'default' : '5m');
if (!CLAUDE_CACHE_TTLS.includes(cacheTtl)) fail(`--claude-cache-ttl must be one of ${CLAUDE_CACHE_TTLS.join(', ')}`);
const realTools = args['real-tools'];
if (!REAL_TOOLS.includes(realTools)) fail(`--real-tools must be one of ${REAL_TOOLS.join(', ')}`);
if (live && args['fai-home']) fail('--fai-home is for --private only: live mode uses the plain entry (FAI_HOME = this checkout)');
const faiHome = args['fai-home'] ? resolve(args['fai-home']) : ROOT;
const prices = loadPrices();
const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
const outDir = resolve(args.out ?? join(HERE, 'results', `${mode}-${stamp}`));
const interactive = mode === 'live' && !args.yes && !args['dry-run'];
if (interactive && !process.stdin.isTTY) fail('--live waits for Enter at the checklist and between tasks; pass --yes without a terminal');

// Live: the host's environment carries no FAI_* variable, so the plain entry resolves FAI_HOME (this checkout), the
// port (daemon.json, else 4318) and the client token exactly as a user's install does.
const FOREIGN_ENV = Object.keys(process.env).filter(name => name.startsWith('FAI_'));
function hostEnv() {
  const env = { ...process.env };
  if (live) {
    for (const name of FOREIGN_ENV) delete env[name];
  }
  return claudeRunEnv(env, cacheTtl);
}

// --- one line of input -----------------------------------------------------------------------------------------
let interrupted = false;
let rl = null;
function pause(question) {
  if (!interactive) return Promise.resolve(true);
  rl ??= createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(done => {
    rl.question(`${question} `, answer => done(!/^q(uit)?$/i.test(answer.trim())));
  });
}
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  log('interrupt: finishing the current task, then writing the summary (Ctrl+C again to abort)');
  rl?.close();
  rl = null;
});

// --- checklist -------------------------------------------------------------------------------------------------
// Status through src/client.js (the CLI `daemon status` path) with autoStart off. The health probe comes first:
// connecting to an idle daemon of another version would make the client restart it, so that case is only reported.
async function gatherChecklist({ port, env, root, claudeVersion }) {
  const health = await probeHealth(port, 2000);
  let status = null;
  let statusError = null;
  if (health && health.version === CLIENT_VERSION) {
    try {
      const client = await FaiBrowserClient.connect({ home: root, env, autoStart: false, clientName: 'live-bench-checklist' });
      status = await client.status();
      // The extension (re)connects a moment after pairing or a service-worker wake: give it a few seconds.
      for (let i = 0; i < 10 && !status.extension?.connected; i++) {
        await new Promise(done => setTimeout(done, 500));
        status = await client.status();
      }
    } catch (error) {
      statusError = `${error.code ?? 'error'}: ${error.message}`;
    }
  } else if (health) {
    statusError = 'not queried: version mismatch';
  }
  const [headCommit, mainCommit, mainTime] = await Promise.all([
    git('rev-parse', 'HEAD'), git('rev-parse', 'main'), git('log', '-1', '--format=%ct', 'main'),
  ]);
  return evaluateChecklist({
    port, health, status, statusError, clientVersion: CLIENT_VERSION, root, nowMs: Date.now(),
    mainCommitEpochS: mainTime ? Number(mainTime) : null, headCommit, mainCommit, claudeVersion,
    foreignEnv: live ? FOREIGN_ENV : [],
  });
}

// --- per-run pieces --------------------------------------------------------------------------------------------
const runName = (task, host, rep) => `${task.id}.${hostTag(host.id)}.${rep}`;
const quote = arg => (arg === '' ? "''" : /[\s"'{}[\]*$|()<>;&]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg);

// Live observer: tell the owner when the host asks for the tab and what each receipt says (FAI's own fields only).
function liveObserver(task) {
  let announced = false;
  return ({ text }) => {
    if (!text.includes('fai_browser_')) return;
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      return;
    }
    for (const block of event.message?.content ?? []) {
      if (event.type === 'assistant' && block.type === 'tool_use' && /fai_browser_run$/.test(block.name ?? '')) {
        const origins = block.input?.origins ?? task.origins;
        if (!announced) {
          announced = true;
          log(`>>> waiting for the owner to approve the tab for ${origins.join(', ')} `
            + `(click the FAI Browser icon, pick ${block.input?.mode ?? task.mode} in Allow, Approve this tab)`);
        } else {
          log(`host calls fai_browser_run again${block.input?.mode ? ` (mode ${block.input.mode})` : ''}`);
        }
      }
    }
    if (event.type === 'user') {
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_result') continue;
        const raw = typeof block.content === 'string' ? block.content
          : (block.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
        try {
          const receipt = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
          if (receipt?.v) {
            log(`receipt: ${receipt.status}/${receipt.code} next ${receipt.next?.kind ?? '-'}`
              + `${receipt.needs?.level ? ` needs ${receipt.needs.level}` : ''}`
              + `${receipt.next?.kind === 'relay' && receipt.next?.text ? ` — ${String(receipt.next.text).slice(0, 200)}` : ''}`);
          }
        } catch {
          // not a receipt
        }
      }
    }
  };
}

// Copies each run's trace.json into <runDir>/traces/ (page text stays there) and summarizes it.
async function collectTraces(receipts, runDir, traceDir = null) {
  const runIds = [...new Set(receipts.map(receipt => receipt.runId).filter(Boolean))];
  const summaries = [];
  const missing = [];
  if (runIds.length) await mkdir(join(runDir, 'traces'), { recursive: true });
  for (const runId of runIds) {
    const fromReceipt = receipts.find(receipt => receipt.runId === runId && receipt.trace)?.trace;
    const candidates = [traceDir && join(traceDir, `${runId}.json`), fromReceipt,
      join(faiHome, 'artifacts', runId, 'trace.json')].filter(Boolean);
    const path = candidates.find(candidate => existsSync(candidate));
    if (!path) {
      missing.push(runId);
      continue;
    }
    await copyFile(path, join(runDir, 'traces', `${runId}.json`));
    try {
      summaries.push(summarizeTrace(JSON.parse(await readFile(path, 'utf8'))));
    } catch (error) {
      missing.push(`${runId} (${error.message})`);
    }
  }
  return { summaries, missing };
}

function receiptEvidence(receipts) {
  // faiEvidence-shaped runs (one per runId, last receipt wins) for oversightFor.
  const byRun = new Map();
  for (const receipt of receipts) {
    if (receipt.runId) {
      byRun.set(receipt.runId, {
        runId: receipt.runId, oversight: receipt.verdict?.oversight ?? null, verdictKind: receipt.verdict?.kind ?? null,
        nextKind: receipt.next?.kind ?? null, verdictAnswer: receipt.answer,
      });
    }
  }
  return [...byRun.values()];
}

// Shared tail of both modes: parse, grade, receipts, traces, the compare.mjs metric fields.
async function finishRecord({ record, task, host, runDir, result, startEpochMs, traceDir = null }) {
  const parsed = parseClaudeEvents(result.lines, { serverAlias: SERVER_ALIAS, realInstall: true });
  const final = parsed.lastMessage ?? '';
  await writeFile(join(runDir, 'final.txt'), final);
  await writeFile(join(runDir, 'event-times.json'), JSON.stringify(result.lines.map(line => Math.round(line.at))));
  const graded = gradeFinal(task, final);
  const receipts = receiptsFrom(parsed.calls);
  await writeFile(join(runDir, 'receipts.json'), `${JSON.stringify(receipts, null, 2)}\n`);
  const traces = await collectTraces(receipts, runDir, traceDir);
  const grader = graderFor(task);
  const runs = receiptEvidence(receipts);
  const oversight = runs.length ? oversightFor(runs, grader.task ?? { expected: [] }) : null;
  if (oversight && grader.kind === 'manual') {
    oversight.falseAutomation = null;
    oversight.verdictAnswerPass = null;
  }
  const lastVerdict = receipts.filter(receipt => receipt.verdict).at(-1)?.verdict ?? null;
  const approval = approvalEstimate(receipts, traces.summaries, startEpochMs);
  const approvalState = approvalOutcome(receipts);
  Object.assign(record, {
    outcome: result.abortReason ? 'error' : result.timedOut ? 'timeout' : result.exitCode === 0 ? 'ok' : 'error',
    reason: result.spawnError || result.abortReason || (result.timedOut ? `timed out after ${timeoutS} s`
      : result.exitCode !== 0 ? `claude exited ${result.exitCode ?? result.signal}${parsed.errors.length ? `: ${parsed.errors.at(-1)}` : ''}` : null),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    wallMs: Math.round(result.wallMs),
    firstToolCallMs: parsed.firstToolCallMs,
    toolCalls: parsed.toolCalls,
    toolCallsByName: parsed.toolCallsByName,
    toolErrors: parsed.toolErrors,
    toolMs: parsed.calls.reduce((total, call) => total + (call.ms || 0), 0),
    commandExecutions: parsed.commandExecutions,
    webSearches: parsed.webSearches,
    tokens: parsed.usage,
    requests: parsed.requests,
    requestsAdjusted: parsed.requests,
    tokenSplit: tokenBreakdown(parsed.usage),
    grading: graded.grading,
    gradedBy: graded.grading === 'auto' ? 'auto' : null,
    pass: graded.pass,
    passLoose: graded.passLoose,
    answer: graded.answer,
    answerText: graded.answer,
    formatOk: graded.formatOk,
    ...faiRunCounts(parsed.calls),
    ...(Object.keys(parsed.hostToolUses ?? {}).length ? { hostToolUses: parsed.hostToolUses } : {}),
    receiptCount: receipts.length,
    faiRuns: new Set(receipts.map(receipt => receipt.runId).filter(Boolean)).size,
    numTurns: parsed.claude?.numTurns ?? null,
    receiptsSummary: receipts.map(({ answer: _answer, next, ...receipt }) => ({ ...receipt, next: next ? { kind: next.kind } : null })),
    traceCount: traces.summaries.length,
    tracesMissing: traces.missing,
    traceSummaries: traces.summaries,
    jev: {
      requests: traces.summaries.reduce((total, item) => total + item.jevRequests, 0),
      ms: traces.summaries.reduce((total, item) => total + item.jevMs, 0),
      hops: traces.summaries.reduce((total, item) => total + (item.hops ?? 0), 0),
      errors: traces.summaries.reduce((total, item) => total + item.jevErrors, 0),
    },
    oversight,
    oversightKind: lastVerdict?.oversight ?? null,
    signals: task.expectSignals?.length ? signalsIn(task.expectSignals, receipts, traces.summaries) : undefined,
    approvalEstimateMs: approval.ms,
    approvalTimeouts: approvalState.approvalTimeouts,
    invalidParams: approvalState.invalidParams,
  });
  const callStats = runCallStats(receipts);
  Object.assign(record, { suppliedTextCalls: callStats.suppliedTextCalls, needsHostCalls: callStats.needsHostCalls,
    unverifiedCalls: callStats.unverifiedCalls, runCalls: callStats.calls });
  if (approvalState.lost && record.outcome === 'ok') {
    // The owner never approved within the per-call wait and nothing ran: not a pass or a fail.
    Object.assign(record, { outcome: 'approval_timeout', pass: null, passLoose: null, gradedBy: null,
      reason: `${approvalState.approvalTimeouts} fai_browser_run call(s) ended needs_user/select_tab; no FAI run happened` });
  }
  const cost = costUsd(parsed.usage, host.model, prices);
  record.cost = { usd: cost?.usd ?? null, basis: cost?.basis ?? null, reportedUsd: parsed.claude?.totalCostUsd ?? null };
  const { tools: _tools, ...claude } = parsed.claude ?? {};
  record.claude = { ...claude, usageSource: parsed.usageSource };
  const violations = [];
  if (claude.permissionDenials?.length) violations.push(`${claude.permissionDenials.length} permission denial(s)`);
  if (record.commandExecutions || record.webSearches) violations.push('used a built-in tool other than ToolSearch/Skill');
  if (violations.length) record.violations = violations;
  return record;
}

function baseRecord(task, host, rep) {
  return {
    taskId: task.id, host: host.id, hostVendor: host.vendor, model: host.model, effort: host.effort, rep, mode,
    taskMode: task.mode ?? null, origins: task.origins ?? null,
    grading: graderFor(task).kind,
  };
}

async function runLive(task, host, rep) {
  const record = baseRecord(task, host, rep);
  const runDir = join(outDir, 'runs', runName(task, host, rep));
  await mkdir(runDir, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'fai-live-'));
  const workdir = join(scratch, 'ws');
  await mkdir(workdir);
  try {
    const writes = await installIntoWorkspace(workdir, { tools: realTools });
    record.realInstall = { tools: realTools, writes: writes.map(write => relative(workdir, write.path)) };
    // The installer's own .mcp.json is the server entry (the plain entry: no env), plus one env key in the entry
    // itself: FAI_MCP_MAX_CALL_MS, the per-call approval wait. Claude Code does not pass the host's environment
    // through to the server for it (a live run with it set in the shell still ended at 45 s), so it goes where
    // hostEntry puts env: the entry's "env" object.
    const configPath = join(workdir, '.mcp.json');
    const installed = JSON.parse(await readFile(configPath, 'utf8'));
    const plain = installed.mcpServers?.[REAL_SERVER_NAME];
    if (!plain) throw new Error(`the installer wrote no ${REAL_SERVER_NAME} entry`);
    if (plain.env) {
      throw new Error(`the installed entry carries env (${Object.keys(plain.env).join(', ')}); `
        + 'live mode needs the plain entry: unset FAI_HOME');
    }
    const config = liveMcpConfig(installed, approvalWaitMs);
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const prompt = task.prompt;
    await writeFile(join(runDir, 'prompt.txt'), prompt);
    const argv = claudeArgs({ prompt, model: host.model, effort: host.effort, mcpConfigPath: configPath,
      serverName: REAL_SERVER_NAME, maxTurns, budgetUsd, realInstall: true });
    await writeFile(join(runDir, 'command.json'), `${JSON.stringify({
      mode, host: host.id, claude: args.claude, args: argv.map(arg => (arg === prompt ? '<prompt.txt>' : arg)),
      mcpConfig: config, cwd: '<scratch>/ws', stdin: '/dev/null', timeoutS,
      env: { MCP_TOOL_TIMEOUT: String(mcpToolTimeoutMs), ...(cacheTtl === 'default' ? {} : { CLAUDE_CODE_PROMPT_CACHE_TTL: cacheTtl }) },
      envRemoved: FOREIGN_ENV,
    }, null, 2)}\n`);
    const startEpochMs = Date.now();
    record.startedAt = new Date(startEpochMs).toISOString();
    const result = await runClaude({
      claude: args.claude, args: argv, env: hostEnv(), envOverrides: { MCP_TOOL_TIMEOUT: String(mcpToolTimeoutMs) }, cwd: workdir,
      timeoutS, eventsPath: join(runDir, 'events.jsonl'), stderrPath: join(runDir, 'stderr.txt'), onLine: liveObserver(task),
    });
    await finishRecord({ record, task, host, runDir, result, startEpochMs });
    record.approvalMs = record.approvalEstimateMs;
    record.approvalSource = 'estimate';
  } catch (error) {
    Object.assign(record, { outcome: 'error', reason: `harness: ${error.stack || error.message}`, pass: false });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    record.endedAt = new Date().toISOString();
    await writeFile(join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  }
  return record;
}

let site = null;
let privateChecklist = null;
let promptParts = null;
async function runPrivate(task, host, rep) {
  const { FaiRun } = await import('../fai-condition.mjs');
  const record = baseRecord(task, host, rep);
  const runDir = join(outDir, 'runs', runName(task, host, rep));
  await mkdir(runDir, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'fai-live-private-'));
  const workdir = join(scratch, 'ws');
  await mkdir(workdir);
  const served = await site.start();
  let fai = null;
  try {
    const startUrl = (task.start ?? '{{ORIGIN}}/').replace('{{ORIGIN}}', served.origin);
    const server = serverCommand();
    fai = new FaiRun({ server, origin: served.origin, startUrl, scratch, chromiumPath: args.chromium, log,
      level: task.mode ?? null, extraEnv: args['fai-home'] ? { FAI_HOME: faiHome } : null });
    await fai.setup();
    record.faiWarm = fai.warm;
    record.faiPaired = fai.paired;
    if (!privateChecklist) {
      // The live checklist code path, run once against this private daemon (its port and state dir).
      privateChecklist = await gatherChecklist({ port: fai.port, env: { ...process.env, ...fai.env }, root: faiHome,
        claudeVersion: meta.claudeCode });
      await writeFile(join(outDir, 'checklist.json'), `${JSON.stringify(sanitizeHome(privateChecklist, homedir()), null, 2)}\n`);
      log(`checklist against the private daemon:\n${renderChecklist(privateChecklist)}`);
    }
    const writes = await installIntoWorkspace(workdir, { tools: realTools });
    record.realInstall = { tools: realTools, writes: writes.map(write => relative(workdir, write.path)) };
    const config = realInstallMcpConfig({ ...server, env: fai.env }, { tools: realTools });
    const configPath = join(scratch, 'mcp.json');
    await writeFile(configPath, JSON.stringify(config));
    const prompt = privatePrompt(task, served.origin, promptParts);
    await writeFile(join(runDir, 'prompt.txt'), prompt);
    const argv = claudeArgs({ prompt, model: host.model, effort: host.effort, mcpConfigPath: configPath,
      serverName: REAL_SERVER_NAME, maxTurns, budgetUsd, realInstall: true });
    const redacted = structuredClone(config);
    const entry = redacted.mcpServers[REAL_SERVER_NAME];
    if (entry.env?.FAI_BRIDGE_SECRET) entry.env.FAI_BRIDGE_SECRET = '<random per run>';
    await writeFile(join(runDir, 'command.json'), `${JSON.stringify({
      mode, host: host.id, claude: args.claude, args: argv.map(arg => (arg === prompt ? '<prompt.txt>' : arg)),
      mcpConfig: redacted, cwd: '<scratch>/ws', stdin: '/dev/null', timeoutS,
      env: cacheTtl === 'default' ? {} : { CLAUDE_CODE_PROMPT_CACHE_TTL: cacheTtl },
    }, null, 2)}\n`);
    fai.start();
    const startEpochMs = Date.now();
    record.startedAt = new Date(startEpochMs).toISOString();
    record.origin = served.origin;
    const result = await runClaude({
      claude: args.claude, args: argv, env: hostEnv(), cwd: workdir, timeoutS,
      eventsPath: join(runDir, 'events.jsonl'), stderrPath: join(runDir, 'stderr.txt'),
    });
    await finishRecord({ record, task, host, runDir, result, startEpochMs });
    record.approvals = fai.approvals;
    record.approvalMs = fai.approvals.reduce((total, approval) => total + (approval.ms || 0), 0);
    record.approvalSource = 'harness';
  } catch (error) {
    Object.assign(record, { outcome: 'error', reason: `harness: ${error.stack || error.message}`, pass: false });
  } finally {
    await fai?.teardown().catch(error => log(`teardown: ${error.message}`));
    await served.close();
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    record.endedAt = new Date().toISOString();
    await writeFile(join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  }
  return record;
}

const resultLine = record => `${record.taskId} ${record.host} rep ${record.rep}: `
  + `${record.grading === 'manual' ? 'TO GRADE' : record.pass ? 'PASS' : 'FAIL'} (${record.outcome}), `
  + `${((record.wallMs ?? 0) / 1000).toFixed(1)} s wall (approval ~${((record.approvalMs ?? 0) / 1000).toFixed(1)} s), `
  + `${record.requests ?? '-'} host turns, ${record.toolCalls ?? '-'} tool calls, ${record.faiRunCalls ?? '-'} fai runs, `
  + `${record.jev?.requests ?? '-'} Jev req, ${record.jev?.hops ?? '-'} hops, `
  + `cost ${record.cost?.usd != null ? `$${record.cost.usd.toFixed(3)}` : '-'}`
  + `${record.signals ? `, signals ${JSON.stringify(record.signals)}` : ''}`
  + `${record.reason ? ` — ${String(record.reason).split('\n')[0].slice(0, 200)}` : ''}`;

async function writeSummary(records, meta, skipped) {
  const graded = applyGrades(records, readGrades(outDir));
  const summary = buildSummary(graded, { meta: { ...meta, finishedAt: new Date().toISOString() }, skipped });
  const clean = sanitizeHome(summary, homedir());
  await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(clean, null, 2)}\n`);
  await writeFile(join(outDir, 'summary.md'), renderSummary(clean));
  await writeFile(join(outDir, 'grades.json'), `${JSON.stringify(gradesFile(graded, readGrades(outDir)), null, 2)}\n`);
  return clean;
}

function readGrades(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'grades.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function regrade(dir) {
  if (!existsSync(join(dir, 'runs.jsonl'))) fail(`--regrade ${dir}: no runs.jsonl`);
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  const file = resolve(args['tasks-file'] ?? resolve(ROOT, config.tasksFile));
  const isLive = config.mode === 'live';
  const { tasks } = isLive ? loadLiveTasks(file) : loadPrivateTasks(file);
  const records = readFileSync(join(dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const grades = readGrades(dir);
  const regraded = records.map(record => {
    const task = tasks.find(item => item.id === record.taskId);
    const finalPath = join(dir, 'runs', `${record.taskId}.${hostTag(record.host)}.${record.rep}`, 'final.txt');
    // Imported hand runs stay manually graded (config.imported).
    if (!task || config.imported || !existsSync(finalPath)) return record;
    const graded = gradeFinal(task, readFileSync(finalPath, 'utf8'));
    return { ...record, grading: graded.grading, pass: graded.pass, passLoose: graded.passLoose,
      gradedBy: graded.grading === 'auto' ? 'auto' : null, answerText: graded.answer };
  });
  const applied = applyGrades(regraded, grades);
  const summary = buildSummary(applied, { meta: { ...config, regradedAt: new Date().toISOString() }, skipped: config.skipped ?? [] });
  const clean = sanitizeHome(summary, homedir());
  await writeFile(join(dir, 'summary.json'), `${JSON.stringify(clean, null, 2)}\n`);
  await writeFile(join(dir, 'summary.md'), renderSummary(clean));
  await writeFile(join(dir, 'grades.json'), `${JSON.stringify(gradesFile(applied, grades), null, 2)}\n`);
  const manual = applied.filter(record => record.grading === 'manual');
  console.log(renderSummary(clean));
  console.log(`Regraded ${applied.length} run(s): ${manual.filter(record => record.pass != null).length}/${manual.length} manual grade(s) set.`);
}

// --- import -----------------------------------------------------------------------------------------------------
// Hand-run live sessions (one dir per run: prompt.txt, events.jsonl, stderr.txt, started.txt, ended.txt, exit.txt,
// traces/<runId>.json) become run records like --live ones. A "-rN" suffix is repeat N of the same id. Every run is
// graded manually (the owner grades in grades.json). Wall = the result event's duration_ms, else ended - started.
async function importRuns(srcDir) {
  const { readdir } = await import('node:fs/promises');
  const host = hosts[0];
  await mkdir(outDir, { recursive: true });
  const ids = (await readdir(srcDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && existsSync(join(srcDir, entry.name, 'events.jsonl'))).map(entry => entry.name).sort();
  const read = (dir, name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : null);
  const records = [];
  const importMeta = { ...meta, mode: 'live', imported: true, importedFrom: sanitizeHome(srcDir, homedir()),
    tasks: ids, skipped: [], approvalWaitMs: null, claude: { note: 'hand-run sessions; flags as run by the operator' } };
  await writeFile(join(outDir, 'config.json'), `${JSON.stringify(sanitizeHome(importMeta, homedir()), null, 2)}\n`);
  await rm(join(outDir, 'runs.jsonl'), { force: true });
  for (const id of ids) {
    const dir = join(srcDir, id);
    const match = /^(.*?)-r(\d+)$/.exec(id);
    const taskId = match ? match[1] : id;
    const rep = match ? Number(match[2]) : 1;
    const known = loaded.tasks.find(task => task.id === taskId);
    const prompt = read(dir, 'prompt.txt') ?? '';
    // Manual grading for every imported run, whatever the task file says.
    const task = { id: taskId, prompt, origins: known?.origins ?? null, mode: known?.mode ?? null };
    const runDir = join(outDir, 'runs', runName(task, host, rep));
    await mkdir(runDir, { recursive: true });
    for (const name of ['prompt.txt', 'events.jsonl', 'stderr.txt']) {
      if (existsSync(join(dir, name))) await copyFile(join(dir, name), join(runDir, name));
    }
    const startEpochMs = Date.parse(String(read(dir, 'started.txt') ?? '').trim()) || null;
    const endEpochMs = Date.parse(String(read(dir, 'ended.txt') ?? '').trim()) || null;
    let at = 0;
    let durationMs = null;
    const lines = read(dir, 'events.jsonl').split('\n').filter(line => line.trim()).map(text => {
      try {
        const event = JSON.parse(text);
        const ts = Date.parse(event.timestamp ?? '');
        if (Number.isFinite(ts) && startEpochMs) at = Math.max(at, ts - startEpochMs);
        if (event.type === 'result' && Number.isFinite(event.duration_ms)) durationMs = event.duration_ms;
      } catch {
        // counted by the parser
      }
      return { at, text };
    });
    const exit = /(-?\d+)/.exec(read(dir, 'exit.txt') ?? '');
    const result = {
      lines, exitCode: exit ? Number(exit[1]) : 0, signal: null, timedOut: false, abortReason: null, spawnError: null,
      wallMs: durationMs ?? (startEpochMs && endEpochMs ? endEpochMs - startEpochMs : 0),
    };
    const record = { ...baseRecord(task, host, rep), mode: 'live', importedFrom: id, startedAt: startEpochMs ? new Date(startEpochMs).toISOString() : null };
    await finishRecord({ record, task, host, runDir, result, startEpochMs, traceDir: join(dir, 'traces') });
    record.approvalMs = record.approvalEstimateMs;
    record.approvalSource = 'estimate';
    record.endedAt = endEpochMs ? new Date(endEpochMs).toISOString() : null;
    await writeFile(join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
    const { traceSummaries: _traces, receiptsSummary: _receipts, answerText: _answer, answer: _a, ...compact } = record;
    await appendFile(join(outDir, 'runs.jsonl'), `${JSON.stringify(sanitizeHome(compact, homedir()))}\n`);
    records.push(record);
    log(`imported ${id}: ${resultLine(record)}`);
  }
  const summary = await writeSummary(records, importMeta, []);
  await writeFile(join(outDir, 'answers.md'), answersMd(records));
  console.log(renderSummary(summary));
  console.log(`Results: ${outDir}\nManual grades: edit ${join(outDir, 'grades.json')}, then node bench/live/run.mjs --regrade ${outDir}`);
}

function answersMd(records) {
  return `# Host answers (for grading; may quote page text)\n\n${records.map(record =>
    `## ${runKey(record)} (${record.outcome === 'approval_timeout' ? 'approval timeout' : record.grading}`
    + `${record.pass != null ? `, ${record.pass ? 'pass' : 'fail'}` : ''})\n\n${record.answerText ?? '(no answer)'}\n`).join('\n')}`;
}

// --- main ------------------------------------------------------------------------------------------------------
const info = args['dry-run'] ? { version: null } : await claudeInfo(args.claude);
const meta = {
  mode,
  label: args.label ?? null,
  startedAt: new Date().toISOString(),
  commit: await git('rev-parse', 'HEAD'),
  hosts: hosts.map(host => host.id),
  tasks: loaded.tasks.map(task => task.id),
  skipped: loaded.skipped,
  tasksFile: relative(ROOT, tasksFile),
  repeat,
  timeoutS,
  claudeCode: info.version,
  claude: { maxTurns, budgetUsd, cacheTtl, mcpToolTimeoutMs: live ? mcpToolTimeoutMs : 120000 },
  approvalWaitMs: live ? approvalWaitMs : null,
  realTools,
  faiHome: live ? ROOT : faiHome,
  node: process.version,
};
if (!live) {
  const readPrompt = name => readFileSync(join(BENCH, 'prompts', name), 'utf8');
  promptParts = {
    common: readPrompt('common.md'),
    tools: existsSync(join(BENCH, 'prompts', 'claude-fai-real.md')) ? readPrompt('claude-fai-real.md') : readPrompt('fai-real.md'),
  };
}

if (mode === 'import') {
  if (!args.out) fail('--import needs --out RESULTS');
  await importRuns(resolve(args.import));
  process.exit(0);
}

if (args['dry-run']) {
  console.log(`mode ${mode}; hosts ${meta.hosts.join(', ')}; ${loaded.tasks.length} task(s) x ${repeat}; timeout ${timeoutS} s`);
  if (live) {
    console.log(`checklist (not run): GET /v1/health on 127.0.0.1:${LIVE_PORT}, then GET /v1/status through src/client.js `
      + `(home ${ROOT}, autoStart off); daemon start vs last commit on main; extension connected; Jev key configured`);
    if (FOREIGN_ENV.length) console.log(`removed from the host env: ${FOREIGN_ENV.join(', ')}`);
  }
  for (const task of loaded.tasks) {
    for (const host of hosts) {
      const prompt = live ? task.prompt : privatePrompt(task, 'http://127.0.0.1:PORT', promptParts);
      const argv = claudeArgs({ prompt: '<prompt.txt>', model: host.model, effort: host.effort,
        mcpConfigPath: live ? '<scratch>/ws/.mcp.json' : '<scratch>/mcp.json', serverName: REAL_SERVER_NAME,
        maxTurns, budgetUsd, realInstall: true });
      console.log(`\n===== ${task.id} / ${host.id} (mode ${task.mode ?? 'card preset'}${live ? `, origins ${task.origins.join(' ')}` : ''})`);
      if (live && task.startUrl) console.log(`# owner opens ${task.startUrl}`);
      console.log(prompt);
      const entry = realInstallMcpConfig({ ...serverCommand(), env: live ? { FAI_MCP_MAX_CALL_MS: String(approvalWaitMs) } : { FAI_BRIDGE_PORT: '<port>', FAI_BRIDGE_SECRET: '<random>', FAI_DAEMON_DIR: '<scratch>/daemon' } }, { tools: realTools });
      console.log(`# ${live ? '<scratch>/ws/.mcp.json (written by the installer)' : '<scratch>/mcp.json'} = ${JSON.stringify(entry)}`);
      console.log(`$ (cd <scratch>/ws && CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 MCP_TOOL_TIMEOUT=${live ? mcpToolTimeoutMs : 120000} MCP_TIMEOUT=60000 `
        + `${cacheTtl === 'default' ? '' : `CLAUDE_CODE_PROMPT_CACHE_TTL=${cacheTtl} `}timeout -k 10 ${timeoutS}s ${args.claude} `
        + `${argv.map(quote).join(' ')} < /dev/null)`);
    }
  }
  for (const item of loaded.skipped) console.log(`\n(skipped: ${item.id}: ${item.reason})`);
  process.exit(0);
}

if (info.error) fail(`Claude Code not usable (${args.claude}): ${info.error}`);
if (!loaded.tasks.length) fail('no tasks to run');
await mkdir(outDir, { recursive: true });

if (live) {
  const checklist = await gatherChecklist({ port: LIVE_PORT, env: Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !name.startsWith('FAI_'))), root: ROOT, claudeVersion: info.version });
  meta.checklist = checklist;
  console.error([
    '',
    '================ FAI Browser live bench ================',
    renderChecklist(checklist),
    '',
    `tasks: ${loaded.tasks.map(task => `${task.id} (${task.mode})`).join(', ')}`,
    `host: ${meta.hosts.join(', ')}; ${repeat} run(s) each; up to ${timeoutS} s per task; results ${relative(process.cwd(), outDir) || outDir}`,
    'Before each task: open its start page in Chrome (profile Public). When the host asks for the tab, click the',
    'FAI Browser icon, pick the level shown in Allow, then Approve this tab. Each task bills your Claude subscription.',
    '========================================================',
  ].join('\n'));
  if (!checklist.ok) {
    await writeFile(join(outDir, 'config.json'), `${JSON.stringify(sanitizeHome(meta, homedir()), null, 2)}\n`);
    fail('checklist failed: fix the [FAIL] lines and rerun');
  }
  if (!(await pause('Press Enter to start (q to quit):'))) process.exit(0);
} else {
  const { siteServer } = await import('../lib/qa.mjs');
  const suite = loaded.suite;
  site = await siteServer(args['site-dir'] ? resolve(args['site-dir']) : suite.site ? resolve(ROOT, suite.site) : null)
    .catch(error => fail(error.message));
  meta.site = { dir: relative(ROOT, site.dir) || site.dir, server: site.kind };
}

if (!args['skip-claude-probe']) {
  log(`claude context probe (${hosts[0].model}) ...`);
  const probe = await probeClaudeContext({ claude: args.claude, model: hosts[0].model, dir: outDir });
  meta.claudeProbe = { ok: probe.ok, error: probe.error, costUsd: probe.costUsd };
  log(`claude context probe: ${probe.ok ? 'clean' : 'FOREIGN INSTRUCTIONS OR ERROR'} (${probe.error ?? probe.answer})`);
  if (!probe.ok) fail('context probe failed; see claude-probe.json (or pass --skip-claude-probe)');
}
await writeFile(join(outDir, 'config.json'), `${JSON.stringify(sanitizeHome(meta, homedir()), null, 2)}\n`);
log(`results: ${relative(process.cwd(), outDir) || outDir}`);

const records = [];
const schedule = loaded.tasks.flatMap(task => hosts.flatMap(host => Array.from({ length: repeat }, (_, i) => ({ task, host, rep: i + 1 }))));
for (const [index, { task, host, rep }] of schedule.entries()) {
  if (interrupted) break;
  log(`[${index + 1}/${schedule.length}] ${task.id} on ${host.id} rep ${rep}`);
  if (live) {
    console.error(`\n--- ${task.id} (${task.mode}; origins ${task.origins.join(', ')})\n`
      + `${task.startUrl ? `open ${task.startUrl} in Chrome (Public), ` : ''}approve at ${task.mode} when asked.\n`
      + `prompt: ${task.prompt}`);
    if (index > 0 && !(await pause('Press Enter when the start page is open (q to stop):'))) break;
  }
  const record = live ? await runLive(task, host, rep) : await runPrivate(task, host, rep);
  records.push(record);
  const { traceSummaries: _traces, receiptsSummary: _receipts, answerText: _answer, answer: _a, ...compact } = record;
  await appendFile(join(outDir, 'runs.jsonl'), `${JSON.stringify(sanitizeHome(compact, homedir()))}\n`);
  log(resultLine(record));
  await writeSummary(records, meta, loaded.skipped);
  if (live && index < schedule.length - 1 && !interrupted && !(await pause('Press Enter for the next task (q to stop):'))) break;
}
rl?.close();
const summary = await writeSummary(records, meta, loaded.skipped);
await writeFile(join(outDir, 'answers.md'), answersMd(records));
console.log(renderSummary(summary));
console.log(`Results: ${outDir}`);
if (records.some(record => record.grading === 'manual')) {
  console.log(`Manual grades: edit ${join(outDir, 'grades.json')} (pass: true|false), then node bench/live/run.mjs --regrade ${outDir}`);
}
process.exit(0);
