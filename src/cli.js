#!/usr/bin/env node
// FAI Browser CLI: a thin client of the daemon (src/client.js auto-starts it). Stdout carries exactly one JSON line;
// all diagnostics go to stderr. `--port` (or an options.json "port") always names the daemon port.
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import { DEFAULT_PORT } from './bridge.js';
import { RESULT_VERSION, agentResult, approvalSteps, buildVerdict, leanObserve, nextFor } from './result.js';
import { envFilePath, faiHome } from './paths.js';
import { validateExpectation } from './expectation.js';
import { LEVELS, normalizeAdditions } from './guardrails.js';
import { requestStartUrl } from './origins.js';
import { RESUME_WAIT_TIMEOUT } from './resume.js';
import { GUIDE_TOPICS, guideCode, guideText } from './guide.js';

const FAI_HOME = faiHome();
const WAIT_SLICE_MS = 30_000;
const TERMINAL_REQUEST_STATES = new Set(['denied', 'expired', 'cancelled', 'released']);

const USAGE = `Usage (your agent chooses each action):
  fai-browser request-tab --origin O [--origin O2] --reason TEXT [--mode M] [--instruction TEXT] [--browser B]
                           --browser: which paired browser (firefox, chrome, chromium, edge, brave, or an id from
                           status); default: the one the user used FAI in last
  fai-browser wait (<requestId> | --run <runId>) [--max-ms N]
  fai-browser wait <requestId> --until active [--timeout 30m]
                           block until the user resumes or approves the tab (run it in the background: it exits 0
                           active, 3 ended, 2 timeout); it never starts a daemon
  fai-browser observe --request ID [--mode M] [--capture last]   (--capture last: also a screenshot)
  fai-browser act --request ID --action a3 --revision R [--expect-* ...]
  fai-browser act --request ID --point X,Y --revision R      (pixels of the observe screenshot; a guarded click)
  fai-browser act --request ID --open-tab URL --revision R   (Multiple task tabs grant required)
  fai-browser act --request ID --tab t0 --revision R
  fai-browser release <requestId>
  fai-browser runs [--limit N]    fai-browser evidence <runId> [--step N] [--kind screenshot|trace]
  fai-browser status              fai-browser pair
  fai-browser guide [topic] [--code CODE]   how FAI Browser works (topics: index, loop, finding, tabs, origins,
                           levels, states, tools, troubleshooting); no daemon needed
  fai-browser daemon [start|stop|restart|status|logs [--lines N]]
  fai-browser update [--check]    install the latest GitHub release into this checkout (--check: only look)
  fai-browser install --host claude|codex|opencode [--scope project|user] [--link] [--dry-run] [--force]
                      [--command-name] [--always-load]
  fai-browser uninstall --host claude|codex|opencode|all
                      undo the user-scope registration (MCP entry, skill, OpenCode plugin) that setup made
  fai-browser install-native [--browser chrome,brave,...] [--all] [--dry-run]
                      native messaging host for every detected browser (the extension pairs by itself)
  fai-browser uninstall-native    remove the native messaging host from every browser
  fai-browser launch [--print]    Firefox with a separate FAI profile and the signed add-on (launch --help)
  fai-browser uninstall-launcher  remove the FAI profile and what launch set up (asks first)
  fai-browser serve               deprecated alias for "daemon"

act flags:
  --expect-url-includes S, --expect-text-includes S, --expect-title-includes S
  --capture each|last|none --timeout-ms N
  --release                Release the tab when the act ends (default: keep it for the next command)
  --no-prune               Skip artifact retention after writing the trace
  --pretty                 Pretty-print the JSON result

Global flags:
  --port N                 Daemon port (default FAI_DAEMON_PORT or ${DEFAULT_PORT}); another port needs the manifest edit
  --no-auto-start          Fail with daemon_unreachable instead of starting the daemon

Stdout is one JSON line. Exit codes for act: 0 completed|unverified|checkpoint,
2 needs_user|needs_host|budget_exhausted|stopped, 1 failed. wait --until active: 0 active, 3 the request ended
(released, expired, denied, cancelled or unknown), 2 timeout (still pending or paused), 130 interrupted, 1 error.
Other commands: 0 success, 1 error.
First run: npm run setup. Every command except install, uninstall, install-native, guide and wait --until starts the
daemon if it is not running.`;

class ConfigError extends Error {
  constructor(message, { code = 'config', who = 'host', hint, extra } = {}) {
    super(message);
    this.code = code;
    this.who = who;
    this.hint = hint;
    this.extra = extra;
  }
}

const log = message => process.stderr.write(`fai-browser: ${message}\n`);

function exitCodeFor(status) {
  if (['completed', 'unverified', 'checkpoint'].includes(status)) {
    return 0;
  }
  if (['needs_user', 'needs_host', 'budget_exhausted', 'stopped'].includes(status)) {
    return 2;
  }
  return 1;
}

// The CLI's own outcomes (no run happened) still carry the receipt v2 verdict and next {kind, text}, like a run.
function baseResult({ runId = null, status, code, reason, who, message, expectation = null, elapsedMs = 0, extra }) {
  const result = {
    v: RESULT_VERSION,
    runId,
    status,
    reason,
    code,
    needs: { who, message },
    verification: { checked: false, passed: false, expectation },
    page: null,
    steps: [],
    cost: { decisions: 0, inputTokens: 0, outputTokens: 0, elapsedMs },
    trace: null,
    ...extra,
  };
  const verdict = buildVerdict(result);
  result.verdict = { ...verdict };
  result.next = nextFor({ ...result, verdict }, { requestId: result.lease?.requestId });
  return result;
}

function parseCli(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        pretty: { type: 'boolean' },
        port: { type: 'string' },
        browser: { type: 'string' },
        all: { type: 'boolean' },
        'output-dir': { type: 'string' },
        capture: { type: 'string' },
        'timeout-ms': { type: 'string' },
        mode: { type: 'string' },
        'no-prune': { type: 'boolean' },
        'no-auto-start': { type: 'boolean' },
        request: { type: 'string' },
        release: { type: 'boolean' },
        origin: { type: 'string', multiple: true },
        reason: { type: 'string' },
        instruction: { type: 'string' },
        'expect-url-includes': { type: 'string' },
        'expect-text-includes': { type: 'string' },
        'expect-title-includes': { type: 'string' },
        policy: { type: 'string' },
        run: { type: 'string' },
        'max-ms': { type: 'string' },
        until: { type: 'string' },
        timeout: { type: 'string' },
        action: { type: 'string' },
        point: { type: 'string' },
        'open-tab': { type: 'string' },
        tab: { type: 'string' },
        revision: { type: 'string' },
        limit: { type: 'string' },
        step: { type: 'string' },
        kind: { type: 'string' },
        lines: { type: 'string' },
        foreground: { type: 'boolean' },
        host: { type: 'string' },
        scope: { type: 'string' },
        link: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        force: { type: 'boolean' },
        'command-name': { type: 'boolean' },
        'always-load': { type: 'boolean' },
        check: { type: 'boolean' },
        finish: { type: 'boolean' },
        tag: { type: 'string' },
        code: { type: 'string' },
      },
    });
  } catch (error) {
    throw new ConfigError(`${error.message}. Run with --help for usage.`);
  }
  return { flags: parsed.values, positionals: parsed.positionals };
}

function integerFlag(name, value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ConfigError(`--${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function envInteger(name, min = 0) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    throw new ConfigError(`${name} must be an integer of at least ${min}`);
  }
  return number;
}

function checkMode(mode) {
  if (mode !== undefined && !LEVELS.includes(mode)) {
    throw new ConfigError(`--mode must be one of ${LEVELS.join(', ')}`);
  }
}

/** --policy: JSON (an array of phrases or {forbid, note}) when it starts with [ or {, else comma-separated phrases. */
function parsePolicyFlag(value) {
  const text = String(value).trim();
  if (!text) throw new ConfigError('--policy must not be empty');
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`--policy is not valid JSON: ${error.message}`);
    }
  }
  const phrases = text.split(',').map(part => part.trim()).filter(Boolean);
  // "--policy ' , '" names nothing: refuse it rather than run without the restriction the host meant to add.
  if (!phrases.length) throw new ConfigError('--policy names no phrase');
  return phrases;
}

function applyOverrides(options, flags) {
  const merged = { ...options };
  const timeoutMs = integerFlag('timeout-ms', flags['timeout-ms'], { min: 1, max: 300_000 });
  if (timeoutMs !== undefined) {
    merged.timeoutMs = timeoutMs;
  }
  if (flags.policy !== undefined) merged.policy = parsePolicyFlag(flags.policy);
  if (merged.policy !== undefined) {
    try {
      normalizeAdditions(merged.policy, 'policy');
    } catch (error) {
      throw new ConfigError(error.message);
    }
  }
  if (flags.mode !== undefined) {
    checkMode(flags.mode);
    merged.mode = flags.mode;
  }
  if (flags.capture !== undefined) {
    merged.capture = flags.capture;
  }
  if (merged.capture !== undefined && !['each', 'last', 'none'].includes(merged.capture)) {
    throw new ConfigError('capture must be each, last or none');
  }
  const fromFlags = {
    urlIncludes: flags['expect-url-includes'],
    textIncludes: flags['expect-text-includes'],
    titleIncludes: flags['expect-title-includes'],
  };
  for (const [key, value] of Object.entries(fromFlags)) {
    if (value !== undefined) {
      merged.expectation = { ...(merged.expectation ?? {}), [key]: value };
    }
  }
  try {
    validateExpectation(merged.expectation);
  } catch (error) {
    throw new ConfigError(error.message);
  }
  return merged;
}

function emitLine(value, pretty) {
  const line = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  return new Promise(resolveWrite => process.stdout.write(`${line}\n`, resolveWrite));
}

// ---------------------------------------------------------------------------------------------------------------
// Daemon client.

// --no-auto-start turns the default off for every command.
let autoStartDefault = true;

async function connectClient({ autoStart = autoStartDefault } = {}) {
  const { FaiBrowserClient } = await import('./client.js');
  try {
    return await FaiBrowserClient.connect({ home: FAI_HOME, autoStart, clientName: 'cli' });
  } catch (error) {
    throw clientConfigError(error);
  }
}

function clientConfigError(error) {
  if (error instanceof ConfigError) {
    return error;
  }
  const code = typeof error?.code === 'string' && !/^E[A-Z]+$/.test(error.code) ? error.code : 'daemon_unreachable';
  const status = Number.isInteger(error?.status) ? error.status : 0;
  const daemonProblem = status === 0 || status === 401 || status >= 500;
  return new ConfigError(String(error?.message || error), {
    code,
    who: code === 'unauthorized' || code === 'port_in_use' ? 'user' : 'host',
    hint: daemonProblem
      ? 'Check `fai-browser daemon status` and `fai-browser daemon logs`; run npm run setup if the daemon is not '
        + 'configured.'
      : 'Fix the request and retry.',
    extra: status ? { httpStatus: status } : undefined,
  });
}

function applyDaemonPortFlag(flags) {
  const port = integerFlag('port', flags.port, { max: 65535 });
  if (port !== undefined) {
    process.env.FAI_DAEMON_PORT = String(port);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// step / run / act through the daemon.

// Follow a run response until it is done, logging each new step to stderr.
async function followRun(client, response) {
  let current = response;
  let reported = 0;
  while (current.state === 'running') {
    const steps = current.progress?.steps ?? 0;
    const last = current.progress?.lastStep;
    if (steps > reported && last?.action) {
      reported = steps;
      log(`step ${last.i ?? steps}: ${last.action.type}${last.action.ref ? ` #${last.action.ref}` : ''}`);
    }
    current = await client.wait({ runId: current.runId, afterStep: steps, maxMs: WAIT_SLICE_MS });
  }
  return current;
}

// SIGINT/SIGTERM: the first stops the run (or the tab wait), the second exits 130.
function interruptHandler(client) {
  const controller = new AbortController();
  const state = { runId: null };
  const onSignal = () => {
    if (controller.signal.aborted) {
      process.exit(130);
    }
    log('interrupted; stopping the run (press Ctrl+C again to force exit)');
    controller.abort();
    if (state.runId) {
      client.stop(state.runId).catch(error => log(`stop failed: ${error.message}`));
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {
    signal: controller.signal,
    state,
    dispose() {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

async function finishRun(client, response, { requestId, release, interrupt }) {
  if (response.runId) {
    interrupt.state.runId = response.runId;
    if (interrupt.signal.aborted) {
      await client.stop(response.runId).catch(() => null);
    }
  }
  const done = await followRun(client, response);
  const result = done.result;
  if (!result || typeof result !== 'object') {
    throw new ConfigError('The daemon returned no result', { code: 'internal' });
  }
  result.lease ??= { requestId, state: 'active' };
  if (release) {
    const released = await client.release(requestId, 'cli --release');
    result.lease = { requestId, state: released.state };
  }
  if (result.trace) {
    log(`trace written to ${result.trace}`);
  }
  // Normalised to receipt v2 (idempotent for a current daemon; an older daemon's v1 result gains verdict and next).
  return agentResult(result);
}

// `--point X,Y`: pixels of the observe screenshot (the image `observe` served for that revision).
function parsePoint(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(String(text));
  if (!match) throw new ConfigError('--point must be X,Y in pixels of the observe screenshot (for example 640,310)');
  return { x: Number(match[1]), y: Number(match[2]) };
}

async function executeAct(flags) {
  for (const name of ['request', 'revision']) {
    if (!flags[name]) {
      throw new ConfigError(`act needs --${name}`);
    }
  }
  if (['action', 'point', 'open-tab', 'tab'].filter(key => flags[key]).length !== 1) throw new ConfigError('act needs exactly one of --action, --point, --open-tab, or --tab');
  const options = applyOverrides({}, flags);
  const body = { requestId: flags.request, revision: flags.revision, waitMs: 0 };
  if (flags.point) body.point = parsePoint(flags.point);
  else if (flags['open-tab']) body.openTab = flags['open-tab'];
  else if (flags.tab) body.tab = flags.tab;
  else body.actionId = flags.action;
  for (const key of ['expectation', 'capture', 'timeoutMs']) {
    if (options[key] !== undefined) {
      body[key] = options[key];
    }
  }
  if (flags['no-prune']) {
    body.prune = false;
  }
  const client = await connectClient();
  const interrupt = interruptHandler(client);
  try {
    const response = await client.request('POST', '/v1/act', body, { timeoutMs: 20_000 });
    return await finishRun(client, response, { requestId: flags.request, release: flags.release, interrupt });
  } catch (error) {
    throw clientConfigError(error);
  } finally {
    interrupt.dispose();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Other commands. Each resolves the JSON value to print; errors become {"error":{...}} with exit 1.

function positional(positionals, index, what) {
  const value = positionals[index];
  if (!value) {
    throw new ConfigError(`${what} is required. Run with --help for usage.`);
  }
  return value;
}

async function commandRequestTab(flags) {
  if (!flags.origin?.length) {
    throw new ConfigError('request-tab needs at least one --origin');
  }
  if (!flags.reason) {
    throw new ConfigError('request-tab needs --reason');
  }
  checkMode(flags.mode);
  const client = await connectClient();
  const body = { origins: flags.origin, mode: flags.mode ?? 'read-only', reason: flags.reason };
  if (flags.instruction) {
    body.instruction = flags.instruction;
  }
  // Several paired browsers: the one to open the request in (the daemon names the connected ones if it is not).
  if (flags.browser) body.browser = flags.browser;
  const url = requestStartUrl(flags.origin, [], [flags.instruction]);
  if (url) body.url = url;
  const created = await client.requestTab(body);
  log(`ACTION NEEDED: approve request ${created.requestId} for ${flags.origin.join(' or ')} in the browser: `
    + `${approvalSteps(created.request?.approval)}. Then run: fai-browser wait ${created.requestId}`);
  return created;
}

async function commandWait(flags, positionals) {
  const maxMs = integerFlag('max-ms', flags['max-ms'], { max: 45_000 }) ?? WAIT_SLICE_MS;
  const client = await connectClient();
  if (flags.run) {
    return client.wait({ runId: flags.run, maxMs });
  }
  return client.wait({ requestId: positional(positionals, 1, 'A requestId (or --run <runId>)'), maxMs });
}

// wait --until active: the background command a host runs so the user's Resume (or approval) in the extension wakes
// it (src/resume.js). Each round is one daemon long poll (POST /v1/wait, which blocks while the request is pending or
// paused), so nothing spins. It never starts a daemon: tab requests live in the daemon's memory, so a new daemon could
// not know the request. A daemon that stops answering is retried with a short backoff; after UNTIL_GONE_MS without one
// (FAI_WAIT_DAEMON_GONE_MS) the request is taken as gone.
const UNTIL_EXIT = Object.freeze({ active: 0, timeout: 2, ended: 3, interrupted: 130, error: 1 });
const UNTIL_MAX_MS = 24 * 3_600_000;
// A round that comes back early (a daemon shutting down answers at once) is not repeated sooner than this.
const UNTIL_MIN_ROUND_MS = 250;
const UNTIL_BACKOFF_MS = [250, 500, 1000, 2000, 5000];
const UNTIL_GONE_MS = 30_000;

/** A duration flag: an integer with a unit, ms, s, m or h (`30m`, `90s`, `1500ms`). */
function durationFlag(name, value, { max = UNTIL_MAX_MS } = {}) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(String(value).trim());
  const ms = match ? Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]] : NaN;
  if (!Number.isSafeInteger(ms) || ms > max) {
    throw new ConfigError(`--${name} must be a duration with a unit, ms, s, m or h (for example 30m), of at most 24h`);
  }
  return ms;
}

/** How the host continues on the request once the tab is ready. */
function continueOn(requestId) {
  return `call fai_browser_observe with requestId ${requestId} (CLI: observe --request ${requestId}), then choose`;
}

function untilNext(outcome, requestId, timeoutText, goneMs) {
  switch (outcome.state) {
    case 'active':
      return { kind: 'observe',
        text: `The tab is ready (request ${requestId} is active). Continue the task: ${continueOn(requestId)}.` };
    case 'timeout':
      return { kind: 'relay', text: `Request ${requestId} is still ${outcome.lastState ?? 'waiting'} after `
        + `${timeoutText}. Ask the user to ${outcome.lastState === 'pending' ? 'approve it' : 'click Resume'} in the `
        + `FAI Browser extension and to tell you when they have; then ${continueOn(requestId)}. Or run this `
        + 'wait again.' };
    case 'interrupted':
      return { kind: 'stop', text: `The wait was interrupted before request ${requestId} became active. Run it again, `
        + 'or ask the user to tell you when they have resumed.' };
    case 'unknown':
      if (outcome.reason === 'daemon_gone') {
        return { kind: 'stop', text: `The FAI Browser daemon has not answered for ${Math.round(goneMs / 1000)} s, and `
          + `tab requests do not survive a daemon restart: request ${requestId} is gone. Tell the user (they can check `
          + '`fai-browser daemon status`); request a tab again only if they still want this.' };
      }
      return { kind: 'stop', text: `The daemon no longer knows request ${requestId} (it may have restarted). Tell the `
        + 'user; request a tab again only if they still want this.' };
    default:
      if (outcome.reason === 'superseded') {
        return { kind: 'stop', text: `Request ${requestId} was replaced by a newer approved request. Continue on that `
          + 'request\'s requestId, or ask the user.' };
      }
      return { kind: 'stop', text: `Tab request ${requestId} has ended (${outcome.state}`
        + `${outcome.reason && outcome.reason !== outcome.state ? `: ${outcome.reason}` : ''}). Tell the user; request a `
        + 'tab again only if they still want this.' };
  }
}

/** The one line a failed wait --until prints (a bad flag, a refused token, an unexpected daemon answer): exit 1. */
function untilErrorLine(error, requestId) {
  const failure = failureJson(error).error;
  const ref = typeof requestId === 'string' && requestId ? requestId : null;
  return {
    state: 'error',
    requestId: ref,
    until: 'active',
    error: failure,
    next: {
      kind: 'relay',
      text: `The background wait failed (${failure.code}: ${String(failure.message).slice(0, 200)}). Ask the user to `
        + 'tell you when they have resumed or approved the tab in the FAI Browser extension, then call '
        + `fai_browser_observe${ref ? ` with requestId ${ref}` : ''}.`,
    },
  };
}

// Daemon trouble the wait outlives: no answer (stopped, restarting, a reset socket or an HTTP timeout), shutting down,
// or a token that changed under a client connected before (a fresh connection refused is a real configuration error).
function transientWaitError(error, fresh) {
  const status = Number.isInteger(error?.status) ? error.status : 0;
  if (error?.code === 'port_in_use') return false;
  return error?.code === 'daemon_unreachable' || status === 503 || (status === 401 && !fresh);
}

function pause(ms, signal) {
  return new Promise(resolvePause => {
    if (signal.aborted || ms <= 0) {
      resolvePause();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolvePause();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function commandWaitUntil(flags, positionals) {
  if (flags.until !== 'active') throw new ConfigError('--until takes active (wait until the tab lease is usable)');
  if (flags.run) throw new ConfigError('--until waits on a tab request: give a requestId, not --run');
  if (flags['max-ms'] !== undefined) throw new ConfigError('--max-ms bounds one wait call; with --until use --timeout');
  const requestId = positional(positionals, 1, 'A requestId');
  const timeoutText = flags.timeout ?? RESUME_WAIT_TIMEOUT;
  const timeoutMs = durationFlag('timeout', timeoutText);
  const goneMs = envInteger('FAI_WAIT_DAEMON_GONE_MS', 1) ?? UNTIL_GONE_MS;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const controller = new AbortController();
  const { signal } = controller;
  const onSignal = () => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const { FaiBrowserClient } = await import('./client.js');
  let client = null;
  let fresh = false;
  let last = null;
  let reconnects = 0;
  let failures = 0;
  // When the current outage began; null while the daemon answers.
  let downSince = null;
  const finish = (state, extra = {}) => {
    const outcome = {
      state,
      requestId,
      until: 'active',
      ...extra,
      reason: extra.reason ?? last?.stateReason ?? null,
      waitedMs: Date.now() - started,
      reconnects,
      request: last,
    };
    outcome.next = untilNext(outcome, requestId, timeoutText, goneMs);
    return { value: outcome, exitCode: UNTIL_EXIT[state] ?? UNTIL_EXIT.ended };
  };
  const timedOut = () => finish('timeout', { lastState: last?.state ?? null });
  try {
    for (;;) {
      if (signal.aborted) return finish('interrupted');
      try {
        if (!client) {
          fresh = true;
          client = await FaiBrowserClient.connect({ home: FAI_HOME, autoStart: false, clientName: 'cli' });
        }
        const roundStarted = Date.now();
        const maxMs = Math.max(0, Math.min(WAIT_SLICE_MS, deadline - roundStarted));
        const response = await client.wait({ requestId, maxMs }, { signal });
        if (downSince !== null) {
          // One outage counts once, however many connection attempts it took.
          reconnects += 1;
          log(`daemon answering again; still waiting for request ${requestId}`);
        }
        fresh = false;
        downSince = null;
        failures = 0;
        last = response.request ?? last;
        const state = response.state ?? last?.state;
        if (state === 'active') return finish('active');
        if (TERMINAL_REQUEST_STATES.has(state)) return finish(state);
        if (deadline - Date.now() <= 0) return timedOut();
        await pause(UNTIL_MIN_ROUND_MS - (Date.now() - roundStarted), signal);
      } catch (error) {
        if (signal.aborted) return finish('interrupted');
        if (error?.status === 404 && error?.code === 'unknown_request') return finish('unknown', { reason: 'unknown_request' });
        if (!transientWaitError(error, fresh)) throw error;
        client = null;
        downSince ??= Date.now();
        const backoff = UNTIL_BACKOFF_MS[Math.min(failures, UNTIL_BACKOFF_MS.length - 1)];
        failures += 1;
        if (failures === 1) log(`daemon not answering (${error.message}); retrying for up to ${Math.round(goneMs / 1000)} s`);
        if (deadline - Date.now() <= 0) return timedOut();
        if (Date.now() - downSince >= goneMs) return finish('unknown', { reason: 'daemon_gone' });
        await pause(Math.min(backoff, deadline - Date.now(), downSince + goneMs - Date.now()), signal);
      }
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function commandObserve(flags) {
  if (!flags.request) {
    throw new ConfigError('observe needs --request');
  }
  checkMode(flags.mode);
  const client = await connectClient();
  // A screenshot only when asked for (--capture last): none is taken or written otherwise.
  const body = { requestId: flags.request, capture: flags.capture === 'last' || flags.capture === 'each' };
  if (flags.mode) {
    body.mode = flags.mode;
  }
  if (flags['no-prune']) {
    body.prune = false;
  }
  const response = await client.observe(body);
  if (response?.state !== 'ok') {
    return response;
  }
  // The lean observe shape: digest and short action lines; the full observation stays in the observe trace.
  return {
    state: 'ok',
    requestId: response.requestId,
    observeId: response.observeId,
    ...leanObserve(response),
    screenshot: response.screenshot ?? null,
    trace: response.trace ?? null,
    // The same next step as MCP observe, in CLI terms.
    next: {
      kind: 'choose',
      text: `Run act --request ${response.requestId} with one --action id and --revision "${response.revision}".`,
    },
  };
}

async function commandStatus() {
  const client = await connectClient();
  return client.status();
}

async function commandRelease(positionals) {
  const requestId = positional(positionals, 1, 'A requestId');
  const client = await connectClient();
  return client.release(requestId, 'cli release');
}

async function commandRuns(flags) {
  const limit = integerFlag('limit', flags.limit, { min: 1, max: 500 });
  const client = await connectClient();
  return client.runs({ limit, requestId: flags.request });
}

async function commandEvidence(flags, positionals) {
  const runId = positional(positionals, 1, 'A runId');
  const step = integerFlag('step', flags.step, { min: 1 });
  if (flags.kind !== undefined && !['screenshot', 'trace'].includes(flags.kind)) {
    throw new ConfigError('--kind must be screenshot or trace');
  }
  const client = await connectClient();
  return client.evidence(runId, { step, kind: flags.kind });
}

function readPairingSecret() {
  try {
    return parseEnv(readFileSync(envFilePath(), 'utf8')).FAI_BRIDGE_SECRET ?? null;
  } catch {
    return null;
  }
}

async function commandPair() {
  if (!process.stdout.isTTY) {
    throw new ConfigError('pair prints the pairing secret only to an interactive terminal', { code: 'not_a_tty' });
  }
  let secret = readPairingSecret();
  if (!secret) {
    await connectClient(); // The daemon generates and saves the pairing secret on first start.
    secret = readPairingSecret();
  }
  if (!secret) {
    throw new ConfigError('No pairing secret is configured', { hint: 'Run npm run setup.' });
  }
  const port = process.env.FAI_DAEMON_PORT || DEFAULT_PORT;
  process.stdout.write('In the extension, open Setup & connection and enter this pairing secret once:\n');
  process.stdout.write(`${secret}\n`);
  process.stdout.write(`Daemon address: http://127.0.0.1:${port}\n`);
  return undefined;
}

async function daemonPaths() {
  const { homePaths, readDaemonInfo } = await import('./home.js');
  const paths = homePaths({ home: FAI_HOME });
  return { paths, info: readDaemonInfo(paths) };
}

async function waitUntilDown(client, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.health();
    } catch {
      return true;
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  return false;
}

async function daemonStop() {
  let client;
  try {
    client = await connectClient({ autoStart: false });
  } catch {
    return { state: 'not_running' };
  }
  await client.shutdown();
  const down = await waitUntilDown(client);
  return { state: down ? 'stopped' : 'stopping' };
}

async function daemonStatus() {
  let client;
  try {
    client = await connectClient({ autoStart: false });
  } catch (error) {
    const { paths } = await daemonPaths();
    const result = { running: false, home: FAI_HOME, log: paths.logFile, reason: error.message };
    return { value: result, exitCode: 1 };
  }
  const status = await client.status();
  return { value: { running: true, ...status }, exitCode: 0 };
}

async function daemonLogs(flags) {
  const lines = integerFlag('lines', flags.lines, { min: 1, max: 100_000 }) ?? 50;
  const { paths, info } = await daemonPaths();
  const file = info?.log ?? paths.logFile;
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`No daemon log at ${file} (${error.code || error.message})`);
  }
  const tail = text.split('\n').filter(Boolean).slice(-lines);
  process.stdout.write(tail.length ? `${tail.join('\n')}\n` : '');
}

async function commandDaemon(flags, positionals) {
  const action = positionals[1];
  if (action === undefined || action === 'run') {
    const { runDaemonMain } = await import('./daemon.js');
    await runDaemonMain({ env: process.env });
    return { exitCode: 0 };
  }
  if (action === 'start') {
    const client = await connectClient();
    const health = await client.health();
    return { value: { state: 'running', ...health, warnings: client.warnings ?? [] }, exitCode: 0 };
  }
  if (action === 'stop') {
    return { value: await daemonStop(), exitCode: 0 };
  }
  if (action === 'restart') {
    await daemonStop();
    const client = await connectClient();
    return { value: { state: 'running', ...(await client.health()) }, exitCode: 0 };
  }
  if (action === 'status') {
    return daemonStatus();
  }
  if (action === 'logs') {
    await daemonLogs(flags);
    return { exitCode: 0 };
  }
  throw new ConfigError(`Unknown daemon action "${action}"; expected start, stop, restart, status or logs`);
}

// Native messaging host (src/native.js): the extension pairs with the FAI service by itself.
async function commandNative(command, flags) {
  const { applyNativeInstall, planNativeInstall, uninstallNative } = await import('./native.js');
  if (command === 'uninstall-native') return uninstallNative();
  const only = flags.browser ? flags.browser.split(',').map(item => item.trim()).filter(Boolean) : null;
  const plan = planNativeInstall({ only, all: Boolean(flags.all) });
  if (only) {
    const known = new Set([...plan.browsers.map(browser => browser.id), ...plan.missing]);
    const unknown = only.filter(id => !known.has(id));
    if (unknown.length) throw new ConfigError(`Unknown browser: ${unknown.join(', ')} (known: ${[...known].join(', ')})`);
  }
  if (flags['dry-run']) {
    return { launcher: plan.launcher.path, browsers: plan.browsers.map(({ id, name, path, registry }) => ({ id, name, path, registry })) };
  }
  if (!plan.browsers.length) {
    throw new ConfigError('No supported browser found for this user', {
      hint: 'Name one with --browser chrome (or chromium, brave, edge, vivaldi, firefox), or pass --all.' });
  }
  return applyNativeInstall(plan);
}

const RUN_COMMANDS = new Set(['act']);
const OTHER_COMMANDS = {
  'request-tab': flags => commandRequestTab(flags),
  wait: (flags, positionals) => commandWait(flags, positionals),
  observe: flags => commandObserve(flags),
  status: () => commandStatus(),
  release: (flags, positionals) => commandRelease(positionals),
  runs: flags => commandRuns(flags),
  evidence: (flags, positionals) => commandEvidence(flags, positionals),
  pair: () => commandPair(),
  guide: (flags, positionals) => commandGuide(flags, positionals),
};

// The MCP tool fai_browser_guide on the command line: no daemon call (src/guide.js).
function commandGuide(flags, positionals) {
  const topic = positionals[1];
  if (topic !== undefined && !GUIDE_TOPICS.includes(topic)) {
    throw new ConfigError(`Unknown guide topic "${topic}"; expected one of ${GUIDE_TOPICS.join(', ')}`);
  }
  if (flags.code !== undefined) {
    const text = guideCode(flags.code);
    if (!text) throw new ConfigError(`"${flags.code}" is not a code FAI Browser uses; see fai-browser guide states`);
    return topic === undefined ? { code: flags.code, text } : { code: flags.code, topic, text: `${text}\n\n${guideText(topic)}` };
  }
  return { topic: topic ?? 'index', text: guideText(topic) };
}

function failureJson(error) {
  const failure = clientConfigError(error);
  const body = { code: failure.code, message: failure.message };
  if (failure.hint) {
    body.hint = failure.hint;
  }
  return { error: { ...body, ...failure.extra } };
}

async function runCommand(operation, flags, positionals) {
  try {
    return await executeAct(flags);
  } catch (error) {
    if (!(error instanceof ConfigError) && !Number.isInteger(error?.status)) {
      log(error?.stack || String(error));
      return baseResult({
        status: 'failed',
        code: 'internal_error',
        reason: String(error?.message || error),
        who: 'host',
        message: 'Unexpected CLI failure; see stderr.',
      });
    }
    const failure = clientConfigError(error);
    return baseResult({
      status: 'failed',
      code: failure.code,
      reason: failure.message,
      who: failure.who,
      message: failure.hint || 'Fix the configuration and rerun.',
      extra: failure.extra,
    });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  // The Firefox launcher talks to a person (prompts, plain text), so it has its own argument parsing.
  if (argv[0] === 'launch' || argv[0] === 'uninstall-launcher') {
    const launcher = await import('./launcher/launch.js');
    return launcher.main(argv[0], argv.slice(1));
  }
  const pretty = argv.includes('--pretty');
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    const result = baseResult({ status: 'failed', code: error.code, reason: error.message, who: error.who,
      message: error.hint || 'Fix the command line and rerun.' });
    await emitLine(result, pretty);
    return 1;
  }
  const { flags, positionals } = parsed;
  autoStartDefault = !flags['no-auto-start'];
  if (flags.help || !positionals.length) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const command = positionals[0];
  const waitUntil = command === 'wait' && flags.until !== undefined;
  if (command !== 'wait' && (flags.until !== undefined || flags.timeout !== undefined)) {
    // Flags of wait --until only: no other command may take them and silently ignore them.
    const result = baseResult({ status: 'failed', code: 'config', who: 'host',
      reason: `--${flags.until !== undefined ? 'until' : 'timeout'} belongs to wait <requestId> --until active, not ${command}`,
      message: 'Fix the command line and rerun.' });
    await emitLine(result, pretty);
    return 1;
  }
  if (RUN_COMMANDS.has(command)) {
    try {
      applyDaemonPortFlag(flags);
    } catch (error) {
      const result = baseResult({ status: 'failed', code: error.code, reason: error.message, who: error.who,
        message: error.hint || 'Fix the command line and rerun.' });
      await emitLine(result, pretty);
      return 1;
    }
    const result = await runCommand(command, flags, positionals);
    await emitLine(result, pretty);
    return exitCodeFor(result.status);
  }
  try {
    if (command === 'install') {
      const { runInstall } = await import('./install.js');
      return await runInstall(flags);
    }
    if (command === 'install-native' || command === 'uninstall-native') {
      await emitLine(await commandNative(command, flags), pretty);
      return 0;
    }
    if (command === 'uninstall') {
      const { HOSTS, unregisterHost } = await import('./install.js');
      const hosts = flags.host === 'all' ? HOSTS : [flags.host];
      if (!flags.host || hosts.some(host => !HOSTS.includes(host))) {
        throw new ConfigError(`uninstall needs --host ${[...HOSTS, 'all'].join('|')}`);
      }
      const results = [];
      for (const host of hosts) results.push(await unregisterHost(host));
      await emitLine({ uninstalled: results }, pretty);
      return 0;
    }
    applyDaemonPortFlag(flags);
    if (command === 'update') {
      // Self-update from tagged GitHub releases (src/update-cli.js); one JSON line, exit 1 when refused or failed.
      const { updateCommand } = await import('./update-cli.js');
      const { value, exitCode } = await updateCommand(flags, { home: FAI_HOME });
      await emitLine(value, pretty);
      return exitCode;
    }
    if (command === 'daemon' || command === 'serve') {
      if (command === 'serve') {
        log('"serve" is deprecated; running "fai-browser daemon" (the options file is ignored).');
        positionals.splice(1);
      }
      const { value, exitCode } = await commandDaemon(flags, positionals);
      if (value !== undefined) {
        await emitLine(value, pretty);
      }
      return exitCode;
    }
    if (waitUntil) {
      const { value, exitCode } = await commandWaitUntil(flags, positionals);
      await emitLine(value, pretty);
      return exitCode;
    }
    if (flags.timeout !== undefined) throw new ConfigError('--timeout belongs to wait <requestId> --until active');
    const handler = OTHER_COMMANDS[command];
    if (!handler) {
      throw new ConfigError(`Unknown command "${command}". Run with --help for usage.`);
    }
    const value = await handler(flags, positionals);
    if (value !== undefined) {
      await emitLine(value, pretty);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof ConfigError) && !Number.isInteger(error?.status) && !error?.code) {
      log(error?.stack || String(error));
    }
    // wait --until prints its own shape, with a next, even when it fails.
    await emitLine(waitUntil ? untilErrorLine(error, positionals[1]) : failureJson(error), pretty);
    return 1;
  }
}

const code = await main();
process.exitCode = code;
// Do not let a lingering socket (for example a provider keep-alive) hold the process open.
setTimeout(() => process.exit(code), 1000).unref();
