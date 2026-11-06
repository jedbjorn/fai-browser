#!/usr/bin/env node
// QA/QC corpus runner: drives FAI Browser with Jev directly (no coding agent) on the local corpus in fixtures/qa/.
//
//   node bench/qa/run.mjs --list
//   node bench/qa/run.mjs --dry-run [--browser]           validate tasks and pages without Jev (--browser: oracles)
//   node bench/qa/run.mjs [--tasks a,b] [--archetype consent,spa] [--repeat N] [--out DIR] [--label X]
//   node bench/qa/run.mjs --regrade bench/results/qa-<stamp>   re-grade runs.jsonl with the current tasks.json
//   node bench/qa/run.mjs --tasks steps-docs-rollback-cli --steps off   step-list tasks as one call per step
//
// One session: bench/qa/serve.mjs on a random loopback port; headless Chromium with a copy of the extension whose
// manifest grants <all_urls> (the test manifest of bench/fai-condition.mjs); an isolated daemon (scratch
// FAI_DAEMON_DIR, random FAI_BRIDGE_PORT, disposable pairing secret; FAI_HOME stays the package root, so the daemon
// loads the Jev key itself and the user's daemon on 4318 is untouched). Per task and repeat: cookies cleared, a
// fresh tab on the start URL, a tab request for the corpus origin approved through the popup, one client.run with
// the task's instruction, expectation, answerQuestion, mode and maxActions (what fai_browser_run sends), the trace
// read back, the request released, and the run graded (bench/qa/lib.mjs gradeRun).
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { headlessEnv } from '../../scripts/headless-env.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startQaSite } from './serve.mjs';
import { VIEWPORT, makeSession, sleep, writeFixtureProfile } from './session.mjs';
import { slimFromText } from '../../src/runtime.js';
import {
  ROOT, approvalLevel, gradeRun, guardsFromTrace, loadSuite, requestsFromTrace, materialize, runOracle, stepsFromTrace, summarize, summaryMarkdown,
  validateSuite, validateTask,
} from './lib.mjs';

function parseArgs(argv) {
  const args = {
    tasks: null, archetype: null, repeat: 1, out: null, label: '', list: false, dryRun: false, browser: false,
    regrade: null, capture: 'last', timeoutMs: 60_000, simJev: null, retry: null, slim: null, steps: 'on', profile: null, thresholds: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--tasks') args.tasks = argv[++i].split(',').filter(Boolean);
    else if (a === '--archetype') args.archetype = argv[++i].split(',').filter(Boolean);
    else if (a === '--repeat') args.repeat = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--out') args.out = resolve(argv[++i]);
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--browser') args.browser = true;
    else if (a === '--regrade') args.regrade = resolve(argv[++i]);
    else if (a === '--capture') args.capture = argv[++i];
    else if (a === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (a === '--sim-jev') args.simJev = /^\d+$/.test(argv[i + 1] ?? '') ? Number(argv[++i]) : 260;
    else if (a === '--retry') {
      const value = argv[++i];
      if (value !== 'on' && value !== 'off') throw new Error('--retry must be on or off');
      args.retry = value === 'on';
    }
    else if (a === '--profile') {
      const value = argv[++i];
      if (value !== 'on' && value !== 'off') throw new Error('--profile must be on or off');
      args.profile = value;
    }
    else if (a === '--slim') args.slim = slimFromText(argv[++i]);
    // --thresholds '{"answerConfirm":0.9}': the run body's gate thresholds (docs/REFERENCE.md), e.g. a before/after.
    else if (a === '--thresholds') args.thresholds = JSON.parse(argv[++i]);
    else if (a === '--steps') {
      args.steps = argv[++i];
      if (args.steps !== 'on' && args.steps !== 'off') throw new Error('--steps must be on or off');
    }
    else if (a === '--help' || a === '-h') {
      console.log('usage: node bench/qa/run.mjs [--list] [--dry-run [--browser]] [--tasks ids] [--archetype names] [--repeat N] [--out DIR] [--label X] [--capture each|last|none] [--timeout-ms N] [--sim-jev [latencyMs]] [--retry on|off] [--slim on|off|<switches>] [--steps on|off] [--profile on|off] [--thresholds JSON] [--regrade DIR]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

function selectTasks(suite, args) {
  let tasks = suite.tasks;
  if (args.tasks) {
    const unknown = args.tasks.filter(id => !tasks.some(t => t.id === id));
    if (unknown.length) throw new Error(`unknown task ids: ${unknown.join(', ')}`);
    tasks = tasks.filter(t => args.tasks.includes(t.id));
  }
  if (args.archetype) tasks = tasks.filter(t => args.archetype.includes(t.archetype));
  return tasks;
}

// ------------------------------------------------------------------------------------------------ dry run

async function dryRun(suite, tasks, { browser }) {
  const site = await startQaSite();
  const rows = [];
  let failed = 0;
  const suiteCheck = validateSuite(suite);
  for (const error of suiteCheck.errors) {
    console.error(`suite: ${error}`);
    failed += 1;
  }
  let context = null;
  if (browser) {
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
    const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: headlessEnv(), args: ['--no-sandbox'] });
    context = await b.newContext({ viewport: VIEWPORT });
    context.closeBrowser = () => b.close();
  }
  try {
    for (const task of tasks) {
      const { errors, warnings } = validateTask(task);
      const t = materialize(task, site.origin);
      let status = null;
      try {
        const response = await fetch(t.start);
        status = response.status;
        await response.arrayBuffer();
        if (status >= 400 && !(status === 403 && task.archetype === 'captcha')) errors.push(`start ${t.start} answered ${status}`);
      } catch (error) {
        errors.push(`start ${t.start}: ${error.message}`);
      }
      let oracle = null;
      if (context && (task.expected?.length || task.oracle)) {
        await context.clearCookies();
        oracle = await runOracle(context, task, site.origin).catch(error => ({ ok: false, missing: [error.message.split('\n')[0]] }));
        if (!oracle.ok) errors.push(`oracle: missing ${JSON.stringify(oracle.missing)}`);
      }
      if (errors.length) failed += 1;
      rows.push({ task: task.id, archetype: task.archetype, kind: task.kind, start: status, oracle: oracle ? oracle.ok : null, errors, warnings });
      console.log(`${errors.length ? 'FAIL' : 'ok  '} ${task.id.padEnd(28)} start ${status}${oracle ? ` oracle ${oracle.ok ? 'ok' : 'MISSING'}` : ''}${errors.length ? `  ${errors.join('; ')}` : ''}${warnings.length ? `  (warn: ${warnings.join('; ')})` : ''}`);
    }
  } finally {
    await context?.closeBrowser();
    await site.close();
  }
  const forbidden = site.stats.forbidden.length;
  console.log(`\n${tasks.length} tasks, ${Object.keys(suiteCheck.archetypes).length} archetypes, ${failed} failing, ${forbidden} non-GET requests during the dry run`);
  return failed === 0 && forbidden === 0 ? 0 : 1;
}

// ------------------------------------------------------------------------------------------------ session

/**
 * A step-list task with --steps off: one client.run per step, as a host that splits the task into separate calls
 * would make them. A placeholder is filled from the referenced step's auto-confirmed answer, else from its top answer
 * candidate (a host reading the receipt; recorded in `offFill`). Stops after a step that is not completed and verified.
 */
async function runChain(session, task, base, { timeoutMs, rec }) {
  const { agentResult } = await import('../../src/result.js');
  const { fillStep } = await import('../../src/steps.js');
  const values = new Map();
  rec.chain = [];
  rec.chainAsked = [];
  rec.runMs = 0;
  for (const [index, raw] of task.steps.entries()) {
    const reasons = new Map();
    let fill = fillStep(raw, values, reasons);
    if (fill.missing) {
      for (const { n } of fill.missing) {
        const guess = rec.chain[n - 1]?.answer?.candidates?.[0]?.text;
        if (guess) values.set(n, String(guess).replace(/\s+/g, ' ').trim().slice(0, 120));
      }
      rec.offFill = 'candidate';
      fill = fillStep(raw, values);
      if (fill.missing) break;
    }
    const step = fill.step;
    const body = { ...base, instruction: step.instruction, expectation: step.expectation, maxActions: step.maxActions ?? 8 };
    if (step.answerQuestion) body.answerQuestion = step.answerQuestion;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('qa run timeout')), timeoutMs + 15_000);
    const started = performance.now();
    let result = null;
    try {
      result = agentResult((await session.client.run(body, { signal: abort.signal })).result);
    } catch (error) {
      rec.runError = `${error.code ?? ''} ${error.message}`.trim();
    } finally {
      clearTimeout(timer);
      rec.runMs += Math.round(performance.now() - started);
    }
    if (!result) break;
    rec.chain.push(result);
    rec.chainAsked.push(Boolean(step.answerQuestion));
    const answer = result.verdict?.answer;
    if (answer?.text && answer.exact !== false) values.set(index + 1, answer.text);
    if (result.status !== 'completed' || result.verification?.passed !== true) break;
  }
  rec.hostCalls = rec.chain.length;
  return rec.chain.at(-1) ?? null;
}

async function runTask(session, site, task, rep, { outDir, capture, timeoutMs, log, provider, retry, slim, steps: stepsMode = 'on', profile, thresholds }) {
  const { agentResult } = await import('../../src/result.js');
  const tag = `${task.id}.${rep}`;
  const artifacts = join(outDir, 'runs', tag);
  await mkdir(artifacts, { recursive: true });
  const rec = {
    task: task.id, archetype: task.archetype, kind: task.kind, hops: task.hops, mode: task.mode, tags: task.tags ?? [],
    grant: approvalLevel(task), rep, origin: site.origin, startedAt: new Date().toISOString(),
  };
  const t0 = performance.now();
  const mark = site.mark();
  let requestId = null;
  try {
    rec.startStatus = await session.openTask(task.start);
    rec.landingUrl = session.page.url();
    ({ requestId } = await session.client.requestTab({ origins: task.allowedOrigins, mode: task.mode, reason: `QA corpus: ${task.id}` }));
    for (let i = 0; i < 40 && (await session.badge()) !== '?'; i++) await sleep(100);
    // Approve at the task's level (its mode, or a lower `grant`), as a user picking it in the card's Allow select.
    const approval = await session.approve('qa', { level: rec.grant });
    const tab = await session.client.waitForTab(requestId, { timeoutMs: 15_000 });
    rec.leaseOk = tab.state === 'active';
    rec.approval = { ok: approval?.ok ?? false, ms: approval?.ms ?? null, state: tab.state, via: approval?.via ?? null, granted: tab.request?.grant?.level ?? null };
    if (!rec.leaseOk) throw new Error(`lease not active: ${tab.state}`);
    if (rec.approval.granted !== rec.grant) throw new Error(`lease granted ${rec.approval.granted}, task needs ${rec.grant}`);
    const body = {
      requestId, mode: task.mode, maxActions: task.maxActions, timeoutMs, capture, prune: false, outputDir: artifacts,
    };
    if (task.allowedUrls?.length) body.allowedUrls = task.allowedUrls;
    // --sim-jev: the loopback simulated provider (bench/qa/sim-jev.mjs); --retry: the in-call retry switch.
    if (provider) Object.assign(body, provider);
    if (retry !== null && retry !== undefined) body.retry = retry;
    // --profile on|off: the run's site-profile switch (the fixture profile exists in both cases).
    if (profile) body.profiles = profile;
    // --slim: the slim provider request switches (src/runtime.js resolveSlim); unset keeps the daemon's default.
    if (slim !== null && slim !== undefined) body.slim = slim;
    if (thresholds) body.thresholds = thresholds;
    if (task.steps) rec.stepsMode = stepsMode;
    if (task.steps && stepsMode === 'off') {
      const { maxActions: _total, ...perStep } = body;
      rec.result = await runChain(session, task, perStep, { timeoutMs, rec });
    } else {
      if (task.steps) body.steps = task.steps;
      else {
        body.instruction = task.instruction;
        if (task.expectation) body.expectation = task.expectation;
        if (task.answerQuestion) body.answerQuestion = task.answerQuestion;
      }
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error('qa run timeout')), timeoutMs + 15_000);
      const runStart = performance.now();
      try {
        const response = await session.client.run(body, { signal: abort.signal });
        rec.result = agentResult(response.result);
        // A placeholder stop hands the value to the host, which then makes one more call for the rest.
        rec.hostCalls = rec.result?.code === 'placeholder_unconfirmed' ? 2 : 1;
      } catch (error) {
        rec.runError = `${error.code ?? ''} ${error.message}`.trim();
      } finally {
        clearTimeout(timer);
        rec.runMs = Math.round(performance.now() - runStart);
      }
    }
    // Every receipt of the task (one, or one per step with --steps off): steps, guards and requests are summed.
    const receipts = rec.chain?.length ? rec.chain : rec.result ? [rec.result] : [];
    for (const receipt of receipts) {
      const trace = receipt.trace && existsSync(receipt.trace) ? JSON.parse(await readFile(receipt.trace, 'utf8')) : null;
      rec.steps = [...(rec.steps ?? []), ...stepsFromTrace(trace, receipt)];
      if (trace) {
        for (const [name, p] of Object.entries(guardsFromTrace(trace))) if (!((rec.guards ??= {})[name] >= p)) rec.guards[name] = p;
        const requests = requestsFromTrace(trace);
        if (requests) rec.requests = [...(rec.requests ?? []), ...requests];
      }
      rec.finalUrl = trace?.finalObservation?.url ?? receipt.page?.url ?? null;
    }
  } catch (error) {
    rec.error = error.message;
    log(`[${tag}] error: ${error.message}`);
  } finally {
    if (requestId) await session.client.release(requestId).catch(() => {});
    await sleep(250); // let late beacons land before slicing the site log
  }
  const delta = site.since(mark);
  rec.delta = {
    requests: delta.requests.map(r => ({ method: r.method, path: r.path, search: r.search, status: r.status })),
    beacons: delta.beacons.map(b => ({ ev: b.ev })),
    forbidden: delta.forbidden,
  };
  rec.elapsedMs = Math.round(performance.now() - t0);
  rec.grade = gradeRun(task, rec);
  const g = rec.grade;
  log(`[${tag}] ${g.pass ? 'PASS' : 'FAIL'} ${rec.result?.status ?? '-'}/${rec.result?.code ?? '-'} next=${g.nextKind} `
    + `${rec.runMs ?? '-'} ms steps=${rec.steps?.length ?? 0} calls=${g.hostCalls} danger=${g.dangerClicks}${g.failure ? ` (${g.failure})` : ''}`);
  return rec;
}

// ------------------------------------------------------------------------------------------------ write

async function writeSummary(outDir, records, meta) {
  const summary = summarize(records, meta);
  await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const md = summaryMarkdown(summary);
  await writeFile(join(outDir, 'summary.md'), md);
  return { summary, md };
}

async function readRecords(dir) {
  const text = await readFile(join(dir, 'runs.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function regrade(dir, suite) {
  const records = await readRecords(dir);
  for (const rec of records) {
    const raw = suite.tasks.find(t => t.id === rec.task);
    if (!raw) continue;
    const task = materialize(raw, rec.origin);
    Object.assign(rec, { archetype: task.archetype, kind: task.kind, hops: task.hops, mode: task.mode, tags: task.tags ?? [] });
    rec.grade = gradeRun(task, rec);
  }
  await writeFile(join(dir, 'runs.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const config = existsSync(join(dir, 'config.json')) ? JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) : {};
  const { md } = await writeSummary(dir, records, { ...config, regradedAt: new Date().toISOString() });
  process.stdout.write(md);
}

// ------------------------------------------------------------------------------------------------ main

const args = parseArgs(process.argv.slice(2));
const suite = loadSuite();
if (args.list) {
  for (const t of suite.tasks) console.log(`${t.id}\t${t.archetype}\t${t.kind}\t${t.mode}\tgrant ${approvalLevel(t)}\thops ${t.hops}`);
  process.exit(0);
}
if (args.regrade) {
  await regrade(args.regrade, suite);
  process.exit(0);
}
const selected = selectTasks(suite, args);
if (args.dryRun) process.exit(await dryRun(suite, selected, { browser: args.browser }));

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = args.out ?? join(ROOT, 'bench', 'results', `qa-${stamp}${args.label ? `-${args.label}` : ''}`);
await mkdir(outDir, { recursive: true });
const logLines = [];
const log = line => {
  const text = `${new Date().toISOString()} ${line}`;
  logLines.push(text);
  console.error(line);
};
const site = await startQaSite();
let sim = null;
if (args.simJev !== null) {
  const { startSimJev } = await import('./sim-jev.mjs');
  sim = await startSimJev({ latencyMs: args.simJev });
  log(`simulated Jev on port ${sim.port}, ${args.simJev} ms per request`);
}
const provider = sim ? { provider: 'local', providerOptions: { port: sim.port } } : null;
const scratch = await mkdtemp(join(tmpdir(), 'fai-qa-'));
// --profile on|off: materialize the fixture site profile (domains/_templates/qa-fixture.json) for this session's origin
// into a scratch FAI_DOMAINS_DIR; the daemon's counters for it are copied to profile-stats.json at the end.
const domainsDir = args.profile ? await writeFixtureProfile(join(scratch, 'domains'), site.origin) : null;
const config = {
  label: args.label || null, repeat: args.repeat, startedAt: new Date().toISOString(), origin: site.origin,
  tasks: selected.map(t => t.id), capture: args.capture, timeoutMs: args.timeoutMs, node: process.version,
  provider: sim ? `sim-jev ${args.simJev} ms` : 'daemon default', retry: args.retry === null ? 'default' : args.retry ? 'on' : 'off',
  slim: args.slim === null ? 'default' : args.slim,
  steps: args.steps,
  profile: args.profile ?? 'none (no profile written)',
  thresholds: args.thresholds ?? 'default',
};
await writeFile(join(outDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
const records = [];
let session = null;
const stop = async () => {
  await session?.teardown().catch(() => {});
  await session?.client?.shutdown?.().catch(() => {});
};
process.on('SIGINT', async () => {
  await stop();
  process.exit(130);
});
try {
  for (let rep = 1; rep <= args.repeat; rep++) {
    for (const raw of selected) {
      if (!session) {
        session = await makeSession(scratch, log, domainsDir);
        log(`session up: daemon dir ${session.daemonDir}, bridge port ${session.port}, site ${site.origin}`);
      }
      const task = materialize(raw, site.origin);
      let rec = await runTask(session, site, task, rep, { outDir, capture: args.capture, timeoutMs: args.timeoutMs, log, provider, retry: args.retry, slim: args.slim, steps: args.steps, profile: args.profile, thresholds: args.thresholds });
      // A broken session (browser or daemon gone) is rebuilt once and the task retried.
      if (rec.error && !rec.result && /closed|Target|daemon_unreachable|lease not active|popup/i.test(rec.error)) {
        log(`rebuilding the session after: ${rec.error}`);
        await session.teardown().catch(() => {});
        session = await makeSession(join(scratch, `s${Date.now()}`), log, domainsDir);
        rec = await runTask(session, site, task, rep, { outDir, capture: args.capture, timeoutMs: args.timeoutMs, log, provider, retry: args.retry, slim: args.slim, steps: args.steps, profile: args.profile, thresholds: args.thresholds });
        rec.retried = true;
      }
      records.push(rec);
      await appendFile(join(outDir, 'runs.jsonl'), `${JSON.stringify(rec)}\n`);
    }
  }
} finally {
  if (session) {
    await cp(join(session.daemonDir, 'logs', 'daemon.log'), join(outDir, 'daemon.log')).catch(() => {});
    // The daemon keeps profile counters in its state dir (FAI_DAEMON_DIR/domain-stats), never in the profile dir.
    if (domainsDir) {
      const { originSlug } = await import('../../src/domains.js');
      await cp(join(session.daemonDir, 'domain-stats', `${originSlug(site.origin)}.json`), join(outDir, 'profile-stats.json')).catch(() => {});
    }
    await session.teardown().catch(() => {});
  }
  await site.close();
  await sim?.close();
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
  await writeFile(join(outDir, 'log.txt'), `${logLines.join('\n')}\n`);
}
config.finishedAt = new Date().toISOString();
await writeFile(join(outDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
const { md } = await writeSummary(outDir, records, config);
process.stdout.write(md);
console.error(`\nresults: ${outDir}`);
