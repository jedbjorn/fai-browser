#!/usr/bin/env node
// Runtime loop benchmark.
//   node scripts/bench.mjs --fake     in-memory bridge, deterministic provider, artificial stage latencies
//   node scripts/bench.mjs --browser  headless Chromium + extension + fixtures (same setup as browser-smoke.mjs)
// Prints a markdown table of p50/p95 per stage; --json prints JSON instead.
// --answer ends each run like a completed task: the provider reports done, a final decide confirms it on the last
// page and choose() ranks the answer (both take --decide-ms); "Run tail" is the time from the last action to the
// returned result.
import http from 'node:http';
import { headlessEnv } from './headless-env.mjs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { BrowserRuntime } from '../src/runtime.js';

const ROOT = resolve(import.meta.dirname, '..');
const PNG_1X1 = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEt8AAAAASUVORK5CYII=';
const LINKS = ['About project', 'Back to overview'];
const STAGES = {
  observe: 'Observe round trip',
  execute: 'Execute to observation',
  screenshot: 'Screenshot arrival',
  decision: 'Provider decision',
  total: 'Total per step',
  choose: 'Answer ranking (choose)',
  tail: 'Run tail (last action to result)',
};

const { values: args } = parseArgs({
  options: {
    fake: { type: 'boolean' },
    browser: { type: 'boolean' },
    json: { type: 'boolean' },
    steps: { type: 'string', default: '20' },
    runs: { type: 'string' },
    'observe-ms': { type: 'string', default: '5' },
    'execute-ms': { type: 'string', default: '40' },
    'capture-ms': { type: 'string', default: '20' },
    'decide-ms': { type: 'string' },
    capture: { type: 'string', default: 'last' },
    headed: { type: 'boolean' },
    'inline-capture': { type: 'boolean' },
    answer: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.help || args.fake === args.browser) {
  process.stderr.write(`Usage: node scripts/bench.mjs --fake|--browser [--steps 20] [--runs N] [--json] [--answer]
  --fake:    [--observe-ms 5] [--execute-ms 40] [--capture-ms 20] [--decide-ms 30] [--inline-capture]
  --browser: [--decide-ms 0] [--headed]   env: CHROMIUM_PATH, PLAYWRIGHT_MODULE
`);
  process.exit(args.help ? 0 : 1);
}

const number = (name, value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative number`);
  }
  return parsed;
};
const config = {
  mode: args.fake ? 'fake' : 'browser',
  steps: number('steps', args.steps),
  runs: number('runs', args.runs ?? (args.fake ? 3 : 1)),
  decideMs: number('decide-ms', args['decide-ms'] ?? (args.fake ? 30 : 0)),
  capture: args.capture,
  answer: Boolean(args.answer),
  ...(args.fake ? {
    observeMs: number('observe-ms', args['observe-ms']),
    executeMs: number('execute-ms', args['execute-ms']),
    captureMs: number('capture-ms', args['capture-ms']),
    inlineCapture: Boolean(args['inline-capture']),
  } : {}),
};
if (!Number.isInteger(config.steps) || config.steps < 1 || config.steps > 100) {
  throw new Error('--steps must be an integer from 1 to 100');
}

const sleep = ms => (ms > 0 ? new Promise(resolveSleep => setTimeout(resolveSleep, ms)) : Promise.resolve());

// Wraps every method of a bridge or provider and records its wall-clock span.
function instrument(target, timeline) {
  return new Proxy(target, {
    get(object, property) {
      const value = object[property];
      if (typeof value !== 'function') {
        return value;
      }
      return async (...callArgs) => {
        const start = performance.now();
        const entry = { kind: String(property), start };
        timeline.push(entry);
        try {
          const result = await value.apply(object, callArgs);
          entry.end = performance.now();
          const screenshot = result?.screenshot;
          if (screenshot?.dataUrl) {
            entry.screenshotAt = entry.end;
          } else if (typeof screenshot?.then === 'function') {
            // Async capture: the screenshot arrives after execute has returned the observation.
            screenshot.then(value => {
              if (value?.dataUrl) {
                entry.screenshotAt = performance.now();
              }
            }, () => {});
          }
          return result;
        } catch (error) {
          entry.end = performance.now();
          entry.error = error.message;
          throw error;
        }
      };
    },
  });
}

// Deterministic provider: alternately follows the About link and the back link. With --answer it reports done (high
// only on the decision after the last step) and ranks answers with choose().
function alternatingProvider(decideMs, { answer = false, steps = 0 } = {}) {
  let decisions = 0;
  const provider = {
    async decide(observation, actions) {
      await sleep(decideMs);
      decisions++;
      if (answer && decisions > steps) {
        return { actionId: 'handoff', done: { probability: 0.9 } };
      }
      const label = LINKS.find(name => observation.controls.some(control => control.label === name));
      const control = observation.controls.find(item => item.label === label);
      const id = control?.ref ?? control?.id;
      const action = actions.find(item => item.type === 'click' && (item.target === id || item.ref === id))
        || actions.find(item => item.type === 'click' && String(item.description || '').includes(label));
      if (!action) {
        // Out of action budget the runtime offers only terminal choices; finish instead of failing.
        const terminal = actions.find(item => item.type === 'done');
        if (terminal) {
          return { actionId: terminal.id };
        }
        throw new Error(`No offered click for ${label ?? 'a known link'} on ${observation.url}`);
      }
      return answer ? { actionId: action.id, done: { probability: 0.05 } } : { actionId: action.id };
    },
  };
  if (answer) {
    provider.choose = async ({ candidates }) => {
      await sleep(decideMs);
      return { choice: candidates[0].id };
    };
  }
  return provider;
}

function fakeBridge({ observeMs, executeMs, captureMs, inlineCapture }, origin) {
  let revision = 1;
  let onAbout = false;
  const observation = () => ({
    revision: `doc${revision}:r${revision}`,
    documentId: `doc${revision}`,
    tabId: 1,
    url: onAbout ? `${origin}/about.html` : `${origin}/`,
    title: onAbout ? 'About project' : 'FAI fixture',
    text: onAbout ? 'About project. Members: Ada, Grace, Linus.' : 'Project overview',
    viewport: { width: 1280, height: 800 },
    controls: [onAbout
      ? { id: '1', role: 'link', label: 'Back to overview', href: `${origin}/index.html`, enabled: true, visible: true }
      : { id: '1', role: 'link', label: 'About project', href: `${origin}/about.html`, enabled: true, visible: true }],
  });
  return {
    async observe() {
      await sleep(observeMs);
      return observation();
    },
    // Mirrors the bridge contract: execute(action, expectedRevision, {capture}, signal). The observation returns
    // after settle; the screenshot follows as a promise unless --inline-capture asks for the older blocking shape.
    async execute(action, expectedRevision, executeOptions = {}) {
      await sleep(executeMs);
      onAbout = !onAbout;
      revision++;
      const current = observation();
      const wantCapture = executeOptions?.capture !== false;
      const shot = () => ({ dataUrl: PNG_1X1, revision: current.revision, format: 'png' });
      if (!wantCapture) {
        return { action, observation: current, screenshot: null };
      }
      if (inlineCapture) {
        await sleep(captureMs);
        return { action, observation: current, screenshot: shot() };
      }
      return { action, observation: current, screenshot: sleep(captureMs).then(shot) };
    },
  };
}

function metricsFor(timeline, result, runStart, runEnd) {
  const pick = kind => timeline.filter(entry => entry.kind === kind && entry.end !== undefined && !entry.error);
  const executes = pick('execute');
  const metrics = {
    observe: pick('observe').map(entry => entry.end - entry.start),
    execute: executes.map(entry => entry.end - entry.start),
    decision: pick('decide').map(entry => entry.end - entry.start),
    choose: pick('choose').map(entry => entry.end - entry.start),
    screenshot: [],
    total: [],
    tail: executes.length ? [runEnd - executes.at(-1).end] : [],
  };
  let previous = runStart;
  for (const [index, entry] of executes.entries()) {
    metrics.total.push(entry.end - previous);
    previous = entry.end;
    if (entry.screenshotAt !== undefined) {
      metrics.screenshot.push(entry.screenshotAt - entry.start);
    }
  }
  return metrics;
}

function percentile(sorted, p) {
  if (!sorted.length) {
    return null;
  }
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = value => (value === null ? null : Math.round(value * 10) / 10);
  const mean = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
  return { n: sorted.length, p50: round(percentile(sorted, 50)), p95: round(percentile(sorted, 95)), mean: round(mean) };
}

async function benchRuns({ bridge, beforeRun, origin }) {
  const all = { observe: [], execute: [], screenshot: [], decision: [], total: [], choose: [], tail: [] };
  const runs = [];
  for (let run = 0; run < config.runs; run++) {
    await beforeRun?.();
    const timeline = [];
    const runtime = new BrowserRuntime({
      bridge: instrument(bridge, timeline),
      provider: instrument(alternatingProvider(config.decideMs, { answer: config.answer, steps: config.steps }), timeline),
    });
    const executed = () => timeline.filter(entry => entry.kind === 'execute' && entry.end !== undefined && !entry.error).length;
    // --answer: the expectation passes once every step ran; one more decide confirms done, then the answer is ranked.
    const answerOptions = config.answer ? {
      maxActions: config.steps + 1,
      maxDecisions: config.steps + 2,
      expectation: () => executed() >= config.steps,
      answerQuestion: 'What is this project about?',
    } : {};
    const runStart = performance.now();
    let result;
    let error;
    try {
      result = await runtime.run('Alternate between the About page and the overview', {
        allowedOrigins: [origin],
        mode: 'read-only',
        maxActions: config.steps,
        maxDecisions: config.steps,
        timeoutMs: 300_000,
        capture: config.capture,
        ...answerOptions,
      });
    } catch (caught) {
      error = caught.message;
    }
    const runEnd = performance.now();
    const steps = result?.steps?.length ?? 0;
    const failed = Boolean(error) || result?.status === 'failed' || steps < config.steps;
    runs.push({
      status: result?.status ?? 'error',
      reason: error ?? result?.reason,
      steps,
      failed,
      elapsedMs: Math.round(performance.now() - runStart),
    });
    const metrics = metricsFor(timeline, result, runStart, runEnd);
    for (const key of Object.keys(all)) {
      all[key].push(...metrics[key]);
    }
  }
  return {
    config,
    runs: runs.length,
    failures: runs.filter(run => run.failed).length,
    runDetails: runs,
    stages: Object.fromEntries(Object.keys(STAGES).map(key => [key, summarize(all[key])])),
  };
}

function markdown(report) {
  const format = value => (value === null ? 'n/a' : value.toFixed(1));
  const lines = [
    `## fai-browser bench (${report.config.mode})`,
    '',
    `Runs: ${report.runs}, steps per run: ${report.config.steps}, failures: ${report.failures}`,
    `Config: ${JSON.stringify(report.config)}`,
    '',
    '| Stage | n | p50 ms | p95 ms | mean ms |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const [key, label] of Object.entries(STAGES)) {
    const stage = report.stages[key];
    if (!report.config.answer && (key === 'choose' || key === 'tail')) continue;
    lines.push(`| ${label} | ${stage.n} | ${format(stage.p50)} | ${format(stage.p95)} | ${format(stage.mean)} |`);
  }
  const failed = report.runDetails.filter(run => run.failed);
  if (failed.length) {
    lines.push('', 'Failed runs:');
    for (const run of failed) {
      lines.push(`- ${run.status}: ${run.reason} (${run.steps} steps)`);
    }
  }
  return lines.join('\n');
}

async function fake() {
  const origin = 'http://127.0.0.1:8765';
  return benchRuns({ bridge: fakeBridge(config, origin), origin });
}

// Mirrors scripts/browser-smoke.mjs: temporary extension copy whose manifest grants <all_urls> so headless
// capture works, a fixture server, the harness companion (bench/companion.js), and a session started from the popup
// over CDP with the worker's start message.
async function browser() {
  const { createCompanion } = await import('../bench/companion.js');
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
  const scratch = await mkdtemp(join(tmpdir(), 'fai-bench-'));
  const extension = join(scratch, 'extension');
  await cp(join(ROOT, 'extension'), extension, { recursive: true });
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  await writeFile(manifestPath, JSON.stringify(manifest));

  const site = http.createServer(async (req, res) => {
    try {
      const name = req.url === '/' ? 'index.html' : req.url.slice(1);
      if (!['index.html', 'about.html', 'child.html'].includes(name)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(await readFile(join(ROOT, 'fixtures', name)));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise(resolveListen => site.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${site.address().port}`;

  let context;
  let companion;
  try {
    context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: !args.headed,
      env: args.headed ? process.env : headlessEnv(),
      args: [
        '--no-sandbox',
        '--ozone-platform=x11',
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = await worker.evaluate(() => chrome.runtime.id);
    const secret = 'disposable-bench-pairing-token-123456789';
    companion = createCompanion({ port: 0, extensionId, secret, allowedOrigins: [origin] });
    const address = await companion.listen();
    const endpoint = `http://127.0.0.1:${address.port}`;
    const page = context.pages()[0] || await context.newPage();
    await page.goto(origin);
    await page.bringToFront();
    await selectTab({ context, worker, extensionId, endpoint, secret, companion });
    return await benchRuns({
      bridge: companion.bridge,
      origin,
      beforeRun: async () => {
        await page.goto(origin);
        await page.bringToFront();
      },
    });
  } finally {
    await context?.close();
    await companion?.close();
    await new Promise(resolveClose => site.close(resolveClose));
    await rm(scratch, { recursive: true, force: true });
  }
}

// Runtime.evaluate inside a non-flattened target session, as browser-smoke.mjs does.
function evaluateInTarget(cdp, sessionId, expression) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolveEval, reject) => {
    const timer = setTimeout(() => {
      cdp.off('Target.receivedMessageFromTarget', listener);
      reject(new Error('Popup CDP timeout'));
    }, 5000);
    const listener = event => {
      if (event.sessionId !== sessionId) {
        return;
      }
      const message = JSON.parse(event.message);
      if (message.id !== id) {
        return;
      }
      clearTimeout(timer);
      cdp.off('Target.receivedMessageFromTarget', listener);
      const exception = message.result?.exceptionDetails;
      if (message.error || exception) {
        reject(new Error(message.error?.message || exception.exception?.description || exception.text));
      } else {
        resolveEval(message.result.result);
      }
    };
    cdp.on('Target.receivedMessageFromTarget', listener);
    cdp.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    }).catch(error => {
      clearTimeout(timer);
      cdp.off('Target.receivedMessageFromTarget', listener);
      reject(error);
    });
  });
}

async function selectTab({ context, worker, extensionId, endpoint, secret, companion }) {
  const cdp = await context.browser().newBrowserCDPSession();
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const deadline = Date.now() + 5000;
  let target;
  while (!target && Date.now() < deadline) {
    try {
      await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        await chrome.action.openPopup({ windowId: tab.windowId });
      });
    } catch (error) {
      if (!error.message.includes('Failed to open popup')) {
        throw error;
      }
    }
    target = (await cdp.send('Target.getTargets')).targetInfos.find(info => info.url === popupUrl);
    if (!target) {
      await sleep(100);
    }
  }
  if (!target) {
    throw new Error('Extension popup did not open');
  }
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  // The harness companion (bench/companion.js) has no tab requests: start the session on the active tab with the
  // worker's own start message, carrying the pairing, as the removed Phase 1 "Select tab and start" button did.
  const start = `chrome.runtime.sendMessage({ type: 'start', level: 'read-only', endpoint: ${JSON.stringify(endpoint)},
    secret: ${JSON.stringify(secret)} }).then(reply => reply?.error ?? null)`;
  const leaseDeadline = Date.now() + 8000;
  let lastError = null;
  while (companion.status()?.status !== 'active') {
    if (Date.now() > leaseDeadline) throw new Error(`Tab lease did not become active (worker: ${lastError})`);
    lastError = await evaluateInTarget(cdp, sessionId, start).then(value => value?.value, error => error.message);
    for (let i = 0; i < 10 && companion.status()?.status !== 'active'; i++) {
      await sleep(50);
    }
  }
  await evaluateInTarget(cdp, sessionId, 'window.close()').catch(() => {});
}

const report = config.mode === 'fake' ? await fake() : await browser();
process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : markdown(report)}\n`);
process.exitCode = report.failures ? 1 : 0;
