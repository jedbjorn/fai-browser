#!/usr/bin/env node
// Long-horizon corpus runner: drives FAI Browser with Jev directly (no coding agent) on fixtures/long (12-15 hops per
// task) and measures how far chained hops get before the loop breaks, and why.
//
//   node bench/long/run.mjs --list
//   node bench/long/run.mjs --dry-run [--browser]        validate tasks and start pages (--browser: walk every gold path)
//   node bench/long/run.mjs [--tasks a,b] [--conditions a,b] [--repeat N] [--out DIR] [--label X] [--sim-jev [ms]]
//                           [--steps on|off] [--profile on|off] [--timeout-ms N] [--max-calls N] [--max-ms N]
//   node bench/long/run.mjs --report DIR[,DIR...]          markdown table over earlier runs (regraded)
//   node bench/long/run.mjs --regrade DIR                  rewrite a result set's grades and summaries
//
// Conditions: (a) one run call with the task's whole instruction, expectation and answerQuestion and maxActions about
// 2 per hop (at most 60, the MCP cap for one run): what a naive host sends; (b) the task's `steps` sent as lists of at
// most 15 (MAX_STEPS, the MCP and runtime cap), with an emulated host that follows `next` literally and has no model
// (README). The host lives under the MCP caps it would meet through fai_browser_run: 60 actions per single run (a list's
// total is the runtime's default, at most 60), 15 steps per list, 6 run/act calls and 120 s of run time per tab request,
// a 45 s call window (each extra 43 s of one call is one fai_browser_wait turn).
// The session is bench/qa/session.mjs (isolated daemon on a random port, never 4318; headless Chromium; the daemon
// loads the Jev key from FAI_HOME itself).
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { headlessEnv } from '../../scripts/headless-env.mjs';
import { startQaSite } from '../qa/serve.mjs';
import { VIEWPORT, makeSession, sleep, writeFixtureProfile } from '../qa/session.mjs';
import { median } from '../qa/lib.mjs';
import { TREE, OTHER_TREE, treeImport } from '../qa/tree.mjs';
// --tree: the tree's list timeout (before round 6: a flat 45 s) and receipt shaping.
const TREE_STEPS = await treeImport('src/steps.js');
const listTimeoutMs = TREE_STEPS.listTimeoutMs ?? (() => 45_000);
import {
  MCP, ROOT, actingSteps, chunkSteps, gradeRecord, loadLongSuite, materialize, naiveMaxActions, passedReceipt, passedSteps,
  pickOption, reportMarkdown, runLongOracle, summarizeLong, supplyValues, traceObservations, validateLongSuite, validateLongTask,
} from './lib.mjs';

// Statuses after which the MCP server refuses an identical repeat (src/mcp.js REFUSE_REPEAT_STATUSES).
const REFUSE_REPEAT = new Set(['needs_host', 'unverified', 'budget_exhausted']);
// A backstop on the emulated host's turns, far above the 6-call MCP budget (only reached with --max-calls).
const MAX_HOST_CALLS = 40;

function parseArgs(argv) {
  const args = {
    tasks: null, conditions: ['a', 'b'], repeat: 1, out: null, label: '', list: false, dryRun: false, browser: false,
    report: null, regrade: null, simJev: null, steps: 'on', profile: null, timeoutMs: null, maxCalls: MCP.maxCalls, maxMs: MCP.maxMs,
    capture: 'last', retry: null, thresholds: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--tasks') args.tasks = argv[++i].split(',').filter(Boolean);
    else if (a === '--conditions') {
      args.conditions = argv[++i].split(',').filter(Boolean);
      if (!args.conditions.every(c => c === 'a' || c === 'b')) throw new Error('--conditions takes a, b or a,b');
    } else if (a === '--repeat') args.repeat = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--out') args.out = resolve(argv[++i]);
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--browser') args.browser = true;
    else if (a === '--regrade') args.regrade = resolve(argv[++i]);
    else if (a === '--report') args.report = argv[++i].split(',').filter(Boolean).map(dir => resolve(dir));
    else if (a === '--sim-jev') args.simJev = /^\d+$/.test(argv[i + 1] ?? '') ? Number(argv[++i]) : 260;
    else if (a === '--steps') {
      args.steps = argv[++i];
      if (args.steps !== 'on' && args.steps !== 'off') throw new Error('--steps must be on or off');
    } else if (a === '--profile') {
      args.profile = argv[++i];
      if (args.profile !== 'on' && args.profile !== 'off') throw new Error('--profile must be on or off');
    } else if (a === '--retry') {
      const value = argv[++i];
      if (value !== 'on' && value !== 'off') throw new Error('--retry must be on or off');
      args.retry = value === 'on';
    } else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (a === '--max-calls') args.maxCalls = Math.max(1, Number(argv[++i]) || MCP.maxCalls);
    else if (a === '--max-ms') args.maxMs = Math.max(1000, Number(argv[++i]) || MCP.maxMs);
    else if (a === '--capture') args.capture = argv[++i];
    // --thresholds '{"answerConfirm":0.9}': the run body's gate thresholds (docs/REFERENCE.md), e.g. a before/after.
    else if (a === '--thresholds') args.thresholds = JSON.parse(argv[++i]);
    else if (a === '--tree') i++; // read by bench/qa/tree.mjs at load time
    else if (a === '--help' || a === '-h') {
      console.log('usage: node bench/long/run.mjs [--list] [--dry-run [--browser]] [--tasks ids] [--conditions a,b] [--repeat N] [--out DIR] '
        + '[--label X] [--sim-jev [latencyMs]] [--steps on|off] [--profile on|off] [--retry on|off] [--timeout-ms N] [--max-calls N] [--max-ms N] '
        + '[--capture each|last|none] [--thresholds JSON] [--tree PATH] [--report DIR[,DIR]] [--regrade DIR]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

function selectTasks(suite, args) {
  if (!args.tasks) return suite.tasks;
  const unknown = args.tasks.filter(id => !suite.tasks.some(t => t.id === id));
  if (unknown.length) throw new Error(`unknown task ids: ${unknown.join(', ')}`);
  return suite.tasks.filter(t => args.tasks.includes(t.id));
}

// ------------------------------------------------------------------------------------------------ dry run

async function dryRun(suite, tasks, { browser }) {
  const site = await startQaSite();
  let failed = 0;
  for (const error of validateLongSuite(suite).errors) {
    console.error(`suite: ${error}`);
    failed += 1;
  }
  let browserHandle = null;
  let context = null;
  if (browser) {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
    browserHandle = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(), args: ['--no-sandbox'] });
    context = await browserHandle.newContext({ viewport: VIEWPORT });
  }
  try {
    for (const task of tasks) {
      const { errors, warnings } = validateLongTask(task);
      const t = materialize(task, site.origin);
      const response = await fetch(t.start).catch(error => ({ status: error.message }));
      if (response.status !== 200) errors.push(`start ${t.start} answered ${response.status}`);
      await response.arrayBuffer?.();
      let oracle = null;
      if (context) {
        oracle = await runLongOracle(context, task, site.origin).catch(error => ({ ok: false, missing: [error.message.split('\n')[0]] }));
        if (!oracle.ok) errors.push(`oracle: missing ${JSON.stringify(oracle.missing)}`);
      }
      if (errors.length) failed += 1;
      console.log(`${errors.length ? 'FAIL' : 'ok  '} ${task.id.padEnd(26)} hops ${task.hops} steps ${task.steps.length} (${chunkSteps(task.steps).length} calls)`
        + `${oracle ? ` gold path ${oracle.ok ? 'ok' : 'BROKEN'}` : ''}${errors.length ? `  ${errors.join('; ')}` : ''}${warnings.length ? `  (warn: ${warnings.join('; ')})` : ''}`);
    }
  } finally {
    await browserHandle?.close();
    await site.close();
  }
  const forbidden = site.stats.forbidden.length;
  console.log(`\n${tasks.length} tasks, ${failed} failing, ${forbidden} non-GET requests`);
  return failed === 0 && forbidden === 0 ? 0 : 1;
}

// ------------------------------------------------------------------------------------------------ host emulation

function stepBody(step) {
  const body = { instruction: step.instruction, expectation: step.expectation, maxActions: step.maxActions ?? 8 };
  if (step.answerQuestion) body.answerQuestion = step.answerQuestion;
  return body;
}

async function readTrace(receipt) {
  return receipt?.trace && existsSync(receipt.trace) ? JSON.parse(await readFile(receipt.trace, 'utf8')) : null;
}

/** One emulated host call (run or act) through the SDK client; returns the call record. */
async function hostCall(session, kind, body, { timeoutMs }) {
  const { agentResult } = await treeImport('src/result.js');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('long run timeout')), (body.timeoutMs ?? timeoutMs ?? 300_000) + 15_000);
  const started = performance.now();
  const call = { kind, sent: body.steps ? body.steps.length : 1, startedAt: new Date().toISOString() };
  try {
    const response = kind === 'act' ? await session.client.act(body, { signal: abort.signal }) : await session.client.run(body, { signal: abort.signal });
    call.receipt = agentResult(response.result);
  } catch (error) {
    call.error = `${error.code ?? ''} ${error.message}`.trim();
  } finally {
    clearTimeout(timer);
  }
  call.ms = Math.round(performance.now() - started);
  call.waits = Math.max(0, Math.ceil(call.ms / MCP.callWindowMs) - 1);
  const trace = await readTrace(call.receipt);
  call.observations = traceObservations(trace);
  const acting = actingSteps(trace);
  call.hops = acting.length;
  call.labels = acting.map(step => String(step.action?.label ?? '').slice(0, 120));
  call.steps = (trace?.steps ?? []).map(step => ({
    type: step.action?.type ?? null, label: String(step.action?.label ?? '').slice(0, 100), confidence: step.decision?.confidence ?? null,
    done: step.decision?.done ?? null, by: step.decision?.by ?? null, url: step.observation?.url ?? null,
  }));
  const final = trace?.finalObservation;
  call.finalObservation = final ? { url: final.url, controls: (final.controls ?? []).map(c => ({ label: String(c.label ?? '').slice(0, 100), kind: c.kind ?? c.tag ?? null })) } : null;
  call.finalDecision = trace?.finalDecision ? {
    actionId: trace.finalDecision.actionId, confidence: trace.finalDecision.confidence, done: trace.finalDecision.done,
    top: Object.entries(trace.finalDecision.probabilities ?? {}).slice(0, 4),
  } : null;
  const requests = trace?.cost?.requests ?? [];
  call.jevRequests = requests.length;
  call.jevMs = requests.filter(r => !r.error && !r.discarded && Number.isFinite(r.providerMs ?? r.ms)).map(r => r.providerMs ?? r.ms);
  return call;
}

/**
 * Condition b: the careful host. `todo` holds the steps not yet passed; each turn sends the next chunk (at most 5, or 1
 * with --steps off; a lone step as a single run) or the replacement the receipt suggested, then follows next literally:
 * next.steps are resent ({{supply:N}} filled from that step's answer or top candidate), a rerun with
 * verdict.suggested.instruction runs it for the current step, choose acts on the option whose label best matches the
 * step (then resends the steps unless that passed the step), and anything else (relay, stop, a rerun or split without a ready instruction, an identical repeat the MCP
 * server would refuse) ends the task. The MCP call and time budget are enforced before every call.
 */
async function careful(session, task, base, opts, rec) {
  let todo = task.steps.map(step => ({ ...step }));
  let override = null;
  const ledger = { calls: 0, ms: 0 };
  const chunk = opts.steps === 'off' ? 1 : MCP.maxSteps;
  while (todo.length) {
    if (ledger.calls >= Math.min(opts.maxCalls, MAX_HOST_CALLS)) return 'cap_calls';
    if (ledger.ms >= opts.maxMs) return 'cap_time';
    const left = opts.maxMs - ledger.ms;
    let kind = 'run';
    let body;
    let sentSteps;
    if (override?.act) {
      kind = 'act';
      body = { requestId: base.requestId, actionId: override.act.id, revision: override.act.revision, expectation: todo[0].expectation, capture: base.capture, outputDir: base.outputDir };
      sentSteps = [todo[0]];
    } else if (override?.instruction) {
      body = { ...base, ...stepBody({ ...todo[0], ...override.instruction }) };
      sentSteps = [todo[0]];
    } else {
      sentSteps = todo.slice(0, chunk);
      body = sentSteps.length === 1 ? { ...base, ...stepBody(sentSteps[0]) } : { ...base, steps: sentSteps };
      if (override?.expectation && body.steps) body.expectation = override.expectation;
    }
    const isList = Boolean(body.steps);
    if (kind === 'run') {
      const runtimeDefault = isList ? listTimeoutMs(body.steps.length) : 30_000;
      if (opts.timeoutMs) body.timeoutMs = Math.min(opts.timeoutMs, Math.max(1000, left));
      else if (left < runtimeDefault) body.timeoutMs = Math.max(1000, Math.floor(left));
    }
    const fingerprint = JSON.stringify({ kind, steps: body.steps ?? null, instruction: body.instruction ?? null, expectation: body.expectation ?? null, actionId: body.actionId ?? null });
    const previous = rec.calls.at(-1);
    if (previous && previous.fingerprint === fingerprint && REFUSE_REPEAT.has(previous.receipt?.status)) return 'repeat';
    const call = await hostCall(session, kind, body, opts);
    call.fingerprint = fingerprint;
    rec.calls.push(call);
    ledger.calls += 1;
    ledger.ms += call.ms;
    override = null;
    const receipt = call.receipt;
    if (!receipt) return 'error';
    const passed = Math.min(passedSteps(receipt, sentSteps.length), sentSteps.length);
    const remainder = todo.slice(sentSteps.length);
    todo = todo.slice(passed);
    if (passed === sentSteps.length && passedReceipt(receipt)) continue;
    // An act that ran its one action without passing the step yet (checkpoint): send the remaining steps from here.
    if (kind === 'act' && receipt.status === 'checkpoint') continue;
    const next = receipt.next ?? {};
    const suggested = receipt.verdict?.suggested ?? {};
    // choose: act on the option first; its receipt decides whether the step passed, and the rest follows as next.steps.
    if (next.kind === 'choose') {
      const option = pickOption(receipt.verdict?.decide?.options, todo[0]?.instruction);
      if (!option) return 'no_model';
      if (Array.isArray(next.steps) && next.steps.length) {
        const steps = supplyValues(next.steps, receipt);
        if (!steps) return 'no_model';
        todo = [...steps, ...remainder];
      }
      override = { act: { id: option.id, revision: receipt.verdict.decide.revision } };
      continue;
    }
    if (Array.isArray(next.steps) && next.steps.length) {
      const steps = supplyValues(next.steps, receipt);
      if (!steps) return 'no_model';
      todo = [...steps, ...remainder];
      override = next.expectation ? { expectation: next.expectation } : null;
      continue;
    }
    if ((next.kind === 'rerun' || next.kind === 'split' || next.kind === 'confirm_page') && suggested.instruction) {
      override = { instruction: { instruction: suggested.instruction, ...(suggested.expectation ? { expectation: suggested.expectation } : {}),
        ...(suggested.maxActions ? { maxActions: suggested.maxActions } : {}) } };
      continue;
    }
    return next.kind === 'rerun' || next.kind === 'split' ? 'no_model' : 'done';
  }
  return 'done';
}

async function runTask(session, site, task, rep, condition, opts) {
  const tag = `${task.id}.${condition}.${rep}`;
  const artifacts = join(opts.outDir, 'runs', tag);
  await mkdir(artifacts, { recursive: true });
  const rec = {
    task: task.id, family: task.family, condition, rep, hops: task.hops, mode: task.mode, origin: site.origin,
    startedAt: new Date().toISOString(), calls: [], stepsMode: condition === 'b' ? opts.steps : null,
  };
  const mark = site.mark();
  let requestId = null;
  const t0 = performance.now();
  try {
    await session.openTask(task.start);
    ({ requestId } = await session.client.requestTab({ origins: task.allowedOrigins, mode: task.mode, reason: `Long corpus: ${task.id}` }));
    for (let i = 0; i < 40 && (await session.badge()) !== '?'; i++) await sleep(100);
    const approval = await session.approve('long', { level: task.mode });
    const tab = await session.client.waitForTab(requestId, { timeoutMs: 15_000 });
    rec.approval = { ok: approval?.ok ?? false, ms: approval?.ms ?? null, state: tab.state, granted: tab.request?.grant?.level ?? null };
    if (tab.state !== 'active') throw new Error(`lease not active: ${tab.state}`);
    const base = { requestId, mode: task.mode, capture: opts.capture, prune: false, outputDir: artifacts };
    if (task.suppliedText) base.suppliedText = task.suppliedText;
    if (opts.provider) Object.assign(base, opts.provider);
    if (opts.retry !== null && opts.retry !== undefined) base.retry = opts.retry;
    if (opts.profile) base.profiles = opts.profile;
    if (opts.thresholds) base.thresholds = opts.thresholds;
    if (condition === 'a') {
      const body = { ...base, instruction: task.instruction, expectation: task.expectation, answerQuestion: task.answerQuestion, maxActions: naiveMaxActions(task) };
      if (opts.timeoutMs) body.timeoutMs = opts.timeoutMs;
      rec.calls.push(await hostCall(session, 'run', body, opts));
      rec.hostStop = rec.calls[0].receipt ? 'done' : 'error';
      rec.complete = passedReceipt(rec.calls[0].receipt);
    } else {
      rec.hostStop = await careful(session, task, base, opts, rec);
      const last = rec.calls.at(-1)?.receipt;
      rec.complete = rec.hostStop === 'done' && passedReceipt(last) && (last.stepResults ?? []).every(e => e.status === 'completed' && e.passed === true);
    }
  } catch (error) {
    rec.error = error.message;
    rec.hostStop = 'error';
    opts.log(`[${tag}] error: ${error.message}`);
  } finally {
    if (requestId) await session.client.release(requestId).catch(() => {});
    await sleep(250);
  }
  rec.elapsedMs = Math.round(performance.now() - t0);
  const delta = site.since(mark);
  rec.beacons = delta.beacons.map(b => b.ev);
  rec.forbidden = delta.forbidden.length;
  rec.grade = gradeRecord(task, rec, site.origin);
  const g = rec.grade;
  opts.log(`[${tag}] ${g.success ? 'OK  ' : 'FAIL'} progress ${g.progressHop}/${task.hops} survival ${g.hopsBeforeBreak} hops ${g.hopsExecuted} `
    + `turns ${g.hostTurns} jev ${g.jevRequests} ${Math.round(g.taskMs / 100) / 10}s${g.break ? ` break ${g.break.class} (${g.break.code})` : ''} stop ${rec.hostStop}`);
  return rec;
}

// ------------------------------------------------------------------------------------------------ report

async function readRecords(dir) {
  const text = await readFile(join(dir, 'runs.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** Summary over earlier result sets, each record regraded with the current tasks.json and grader. */
async function report(dirs, suite) {
  const records = [];
  let meta = {};
  for (const dir of dirs) {
    for (const rec of await readRecords(dir)) {
      const task = suite.tasks.find(t => t.id === rec.task);
      if (task) rec.grade = gradeRecord(task, rec, rec.origin);
      records.push(rec);
    }
    if (existsSync(join(dir, 'config.json'))) meta = { ...meta, ...JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) };
  }
  process.stdout.write(reportMarkdown(summarizeLong(records, { ...meta, label: dirs.length > 1 ? `${dirs.length} result sets` : meta.label })));
}

// ------------------------------------------------------------------------------------------------ main

function treeDescribe() {
  try {
    return `${TREE} (${execFileSync('git', ['-C', TREE, 'describe', '--tags', '--always'], { encoding: 'utf8' }).trim()})`;
  } catch {
    return TREE;
  }
}

const args = parseArgs(process.argv.slice(2));
const suite = loadLongSuite();
if (args.list) {
  for (const t of suite.tasks) console.log(`${t.id}\t${t.family}\t${t.mode}\thops ${t.hops}\tsteps ${t.steps.length} (${chunkSteps(t.steps).length} calls)`);
  process.exit(0);
}
if (args.regrade) {
  // Rewrite runs.jsonl grades, summary.json and summary.md of a result set with the current tasks and grader.
  const records = await readRecords(args.regrade);
  for (const rec of records) {
    const task = suite.tasks.find(t => t.id === rec.task);
    if (task) rec.grade = gradeRecord(task, rec, rec.origin);
  }
  await writeFile(join(args.regrade, 'runs.jsonl'), `${records.map(r => JSON.stringify(r)).join('\n')}\n`);
  const meta = existsSync(join(args.regrade, 'config.json')) ? JSON.parse(await readFile(join(args.regrade, 'config.json'), 'utf8')) : {};
  const summary = summarizeLong(records, { ...meta, regradedAt: new Date().toISOString() });
  summary.p50JevMsAll = median(records.flatMap(r => r.grade.jevMs));
  await writeFile(join(args.regrade, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(args.regrade, 'summary.md'), reportMarkdown(summary));
  process.stdout.write(reportMarkdown(summary));
  process.exit(0);
}
if (args.report) {
  await report(args.report, suite);
  process.exit(0);
}
const selected = selectTasks(suite, args);
if (args.dryRun) process.exit(await dryRun(suite, selected, { browser: args.browser }));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = args.out ?? join(ROOT, 'bench', 'results', `long-${stamp}${args.label ? `-${args.label}` : ''}`);
await mkdir(outDir, { recursive: true });
const logLines = [];
const log = line => {
  logLines.push(`${new Date().toISOString()} ${line}`);
  console.error(line);
};
const site = await startQaSite();
let sim = null;
if (args.simJev !== null) {
  const { startSimJev } = await import('../qa/sim-jev.mjs');
  sim = await startSimJev({ latencyMs: args.simJev });
  log(`simulated Jev on port ${sim.port}, ${args.simJev} ms per request`);
}
const provider = sim ? { provider: 'local', providerOptions: { port: sim.port } } : null;
const scratch = await mkdtemp(join(tmpdir(), 'fai-long-'));
const domainsDir = args.profile ? await writeFixtureProfile(join(scratch, 'domains'), site.origin) : null;
const config = {
  label: args.label || null, tree: OTHER_TREE ? treeDescribe() : 'this checkout', repeat: args.repeat, conditions: args.conditions, startedAt: new Date().toISOString(), origin: site.origin,
  tasks: selected.map(t => t.id), node: process.version, provider: sim ? `sim-jev ${args.simJev} ms` : 'daemon default (Jev)',
  steps: args.steps, profile: args.profile ?? 'none', retry: args.retry === null ? 'default' : args.retry ? 'on' : 'off',
  thresholds: args.thresholds ?? 'default',
  hostCaps: { maxActions: MCP.maxActions, maxSteps: MCP.maxSteps, maxCalls: args.maxCalls, maxMs: args.maxMs, callWindowMs: MCP.callWindowMs },
  timeoutMs: args.timeoutMs ?? 'MCP default (runtime 30 s single, 45-120 s list (6 s per step), clamped to the request budget)',
};
await writeFile(join(outDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
const records = [];
let session = null;
const opts = { outDir, log, provider, steps: args.steps, profile: args.profile, retry: args.retry, timeoutMs: args.timeoutMs, maxCalls: args.maxCalls, maxMs: args.maxMs, capture: args.capture, thresholds: args.thresholds };
process.on('SIGINT', async () => {
  await session?.teardown().catch(() => {});
  await session?.client?.shutdown?.().catch(() => {});
  process.exit(130);
});
try {
  for (let rep = 1; rep <= args.repeat; rep++) {
    for (const raw of selected) {
      for (const condition of args.conditions) {
        if (!session) {
          session = await makeSession(scratch, log, domainsDir, { clientName: 'long-run' });
          log(`session up: daemon dir ${session.daemonDir}, bridge port ${session.port}, site ${site.origin}`);
        }
        const task = materialize(raw, site.origin);
        let rec = await runTask(session, site, task, rep, condition, opts);
        if (rec.error && !rec.calls.length && /closed|Target|daemon_unreachable|lease not active|popup/i.test(rec.error)) {
          log(`rebuilding the session after: ${rec.error}`);
          await session.teardown().catch(() => {});
          session = await makeSession(join(scratch, `s${Date.now()}`), log, domainsDir, { clientName: 'long-run' });
          rec = await runTask(session, site, task, rep, condition, opts);
          rec.retried = true;
        }
        records.push(rec);
        await appendFile(join(outDir, 'runs.jsonl'), `${JSON.stringify(rec)}\n`);
      }
    }
  }
} finally {
  if (session) {
    await cp(join(session.daemonDir, 'logs', 'daemon.log'), join(outDir, 'daemon.log')).catch(() => {});
    await session.teardown().catch(() => {});
  }
  await site.close();
  await sim?.close();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
  await writeFile(join(outDir, 'log.txt'), `${logLines.join('\n')}\n`);
}
config.finishedAt = new Date().toISOString();
await writeFile(join(outDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
const summary = summarizeLong(records, config);
summary.p50JevMsAll = median(records.flatMap(r => r.grade.jevMs));
await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
const md = reportMarkdown(summary);
await writeFile(join(outDir, 'summary.md'), md);
process.stdout.write(md);
console.error(`\nresults: ${outDir}`);
