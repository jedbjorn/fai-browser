// Pure helpers for bench/live/run.mjs: date placeholders, task loading, FAI receipt and trace summaries, grading,
// the approval-time estimate, the live checklist verdict and the summary tables. No I/O except the task loaders.
import { readFileSync } from 'node:fs';
import { extractAnswer, faiResultFrom, grade } from '../lib/metrics.mjs';

// --- placeholders ----------------------------------------------------------------------------------------------

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = n => String(n).padStart(2, '0');

/** Local calendar date `offset` days from `now`, formatted: iso (2026-10-07), long (Wednesday 7 October 2026), dm (7 October). */
export function formatDate(now, offset = 0, format = 'iso') {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 12);
  if (format === 'long') {
    return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  }
  if (format === 'dm') {
    return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  }
  if (format !== 'iso') {
    throw new Error(`unknown date format "${format}" (iso, long, dm)`);
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// {{DATE}}, {{DATE+N}}, {{DATE-N}}, each optionally with |iso, |long or |dm.
const DATE_RE = /\{\{DATE(?:([+-])(\d{1,3}))?(?:\|(\w+))?\}\}/g;

/** Replaces the date placeholders in `text` (strings only; other values pass through). */
export function fillDates(text, now = new Date()) {
  if (typeof text !== 'string') {
    return text;
  }
  return text.replace(DATE_RE, (_match, sign, days, format) =>
    formatDate(now, days ? (sign === '-' ? -1 : 1) * Number(days) : 0, format ?? 'iso'));
}

/** Deep copy of `value` with every string's date placeholders filled. */
export function fillDeep(value, now = new Date()) {
  if (typeof value === 'string') {
    return fillDates(value, now);
  }
  if (Array.isArray(value)) {
    return value.map(item => fillDeep(item, now));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillDeep(item, now)]));
  }
  return value;
}

// --- tasks -----------------------------------------------------------------------------------------------------

const LEVELS = ['read-only', 'reversible', 'interactive', 'full', 'testing'];

/** Checks one live task; returns a list of problems (empty when valid). */
export function validateLiveTask(task) {
  const problems = [];
  if (!task || typeof task.id !== 'string' || !task.id) {
    return ['task without an id'];
  }
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) problems.push(`${task.id}: prompt is required`);
  if (!task.skip) {
    if (!Array.isArray(task.origins) || !task.origins.length) problems.push(`${task.id}: origins must list 1+ origins`);
    for (const origin of task.origins ?? []) {
      if (!/^https:\/\/(\*\.)?[a-z0-9.-]+$/i.test(origin)) problems.push(`${task.id}: origin ${origin} is not an https origin`);
    }
    if (!LEVELS.includes(task.mode)) problems.push(`${task.id}: mode must be one of ${LEVELS.join(', ')}`);
  }
  if (task.answerPattern != null) {
    try {
      new RegExp(task.answerPattern, 'i');
    } catch (error) {
      problems.push(`${task.id}: answerPattern is not a regex (${error.message})`);
    }
  }
  return problems;
}

/**
 * Loads bench/live/tasks.json (or `file`): {tasks, skipped: [{id, reason}]}. `ids` selects tasks (unknown ids throw);
 * tasks with `skip: true` are never run and are listed in `skipped`. Date placeholders are filled with `now`.
 */
export function loadLiveTasks(file, { ids = null, now = new Date() } = {}) {
  const suite = JSON.parse(readFileSync(file, 'utf8'));
  const all = suite.tasks ?? [];
  const problems = all.flatMap(validateLiveTask);
  const seen = new Set();
  for (const task of all) {
    if (seen.has(task.id)) problems.push(`duplicate task id ${task.id}`);
    seen.add(task.id);
  }
  if (problems.length) {
    throw new Error(`${file}: ${problems.join('; ')}`);
  }
  const unknown = (ids ?? []).filter(id => !seen.has(id));
  if (unknown.length) {
    throw new Error(`unknown task id(s): ${unknown.join(', ')} (use --list)`);
  }
  const chosen = ids ? all.filter(task => ids.includes(task.id)) : all;
  const tasks = [];
  const skipped = [];
  for (const task of chosen) {
    if (task.skip) {
      skipped.push({ id: task.id, reason: task.skipReason ?? task.notes ?? 'skip: true' });
    } else {
      tasks.push(fillDeep(task, now));
    }
  }
  return { tasks, skipped, preamble: suite.preamble ?? null };
}

/** Loads a bench/tasks.json-schema file (bench/tasks.json, bench/qa/tasks.json) for --private. */
export function loadPrivateTasks(file, { ids = null } = {}) {
  const suite = JSON.parse(readFileSync(file, 'utf8'));
  const all = suite.tasks ?? [];
  const unknown = (ids ?? []).filter(id => !all.some(task => task.id === id));
  if (unknown.length) {
    throw new Error(`unknown task id(s): ${unknown.join(', ')} (use --list)`);
  }
  return { suite, tasks: ids ? all.filter(task => ids.includes(task.id)) : all, skipped: [] };
}

// Condition R's prompt from compare.mjs: common.md with the fai-real.md tool paragraph, no inlined loop guidance.
// A task with its own `prompt` (bench/live/tasks-fixture.json: what a user types) is sent as is, with {{ORIGIN}} and
// {{START}} filled and nothing added.
export function privatePrompt(task, origin, { common, tools }) {
  const fill = (template, vars) => template.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
  const vars = { ORIGIN: origin, START: fill(task.start ?? '{{ORIGIN}}/', { ORIGIN: origin }) };
  if (typeof task.prompt === 'string') {
    return fill(task.prompt, vars);
  }
  vars.INSTRUCTION = fill(task.instruction, vars);
  vars.TOOLS = fill(tools, vars).trim();
  return fill(common, vars);
}

// --- receipts and traces ---------------------------------------------------------------------------------------

/**
 * One record per fai_browser_* tool call in a parsed Claude run (lib/claude.mjs parseClaudeEvents `calls`): the
 * receipt's trusted fields (status, code, verdict, next, permissions, needs, budget, cost) plus its answer text and
 * trail length. `answer` is page text: it stays in receipts.json, never in the summary.
 */
export function receiptsFrom(calls = []) {
  const receipts = [];
  for (const call of calls) {
    if (!String(call.tool ?? '').startsWith('fai_browser_')) {
      continue;
    }
    const result = faiResultFrom(call.result);
    const base = {
      callId: call.id,
      tool: call.tool,
      startedAtMs: call.startedAtMs ?? null,
      callMs: call.ms ?? null,
      isError: Boolean(call.isError),
      arguments: summarizeArguments(call.arguments),
    };
    if (!result) {
      receipts.push({ ...base, parsed: false, errorCode: errorCodeOf(call),
        error: call.isError ? String(call.error ?? '').slice(0, 300) : null });
      continue;
    }
    receipts.push({
      ...base,
      parsed: true,
      v: result.v,
      runId: result.runId ?? null,
      requestId: result.requestId ?? null,
      state: result.state ?? null,
      status: result.status ?? null,
      code: result.code ?? null,
      verified: Boolean(result.verification?.passed),
      verdict: result.verdict ? {
        kind: result.verdict.kind ?? null,
        oversight: result.verdict.oversight ?? null,
        why: Array.isArray(result.verdict.why) ? result.verdict.why : [],
        budget: result.verdict.budget ?? null,
        hasAnswer: Boolean(result.verdict.answer?.text),
        answerExact: result.verdict.answer?.exact ?? null,
      } : null,
      next: result.next ? { kind: result.next.kind ?? null, text: result.next.text ?? null } : null,
      needs: result.needs ? { level: result.needs.level ?? null, kind: result.needs.kind ?? null } : null,
      permissions: result.permissions ?? null,
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      trailLength: Array.isArray(result.trail) ? result.trail.length : 0,
      steps: Array.isArray(result.steps) ? result.steps.length : null,
      stepRuns: Array.isArray(result.stepRuns) ? result.stepRuns.length : null,
      cost: result.cost ?? null,
      trace: typeof result.trace === 'string' ? result.trace : null,
      answer: result.verdict?.answer?.text ?? null,
    });
  }
  return receipts;
}

// A tool error's fixed code ({"error": {"code": "invalid_params", ...}} as JSON text), or null.
function errorCodeOf(call) {
  const text = (call.result?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n')
    || String(call.error ?? '');
  try {
    const code = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))?.error?.code;
    return typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * Approval accounting for one run: `approvalTimeouts` = calls that returned needs_user/select_tab (the per-call wait
 * ended before the owner approved); `lost` when no FAI run happened at all after that (the outcome is then
 * approval_timeout, kept out of the pass rate). `invalidParams` = calls refused as invalid_params.
 */
export function approvalOutcome(receipts = []) {
  const approvalTimeouts = receipts.filter(receipt => receipt.status === 'needs_user' && receipt.code === 'select_tab').length;
  const ran = receipts.some(receipt => receipt.runId);
  return {
    approvalTimeouts,
    lost: approvalTimeouts > 0 && !ran,
    invalidParams: receipts.filter(receipt => receipt.errorCode === 'invalid_params' || receipt.code === 'invalid_params').length,
  };
}

// The call arguments without free text the user did not write: origins, mode, step count, expectation keys.
function summarizeArguments(args) {
  let value = args;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  return {
    origins: Array.isArray(value.origins) ? value.origins : undefined,
    mode: value.mode,
    requestId: value.requestId,
    runId: value.runId,
    steps: Array.isArray(value.steps) ? value.steps.length : undefined,
    maxActions: value.maxActions,
    hasAnswerQuestion: typeof value.answerQuestion === 'string' ? true : undefined,
    allowedUrls: Array.isArray(value.allowedUrls) ? value.allowedUrls.length : undefined,
    // Shape only: suppliedText field names (never values), instruction length, expectation keys per call and step.
    suppliedText: value.suppliedText && typeof value.suppliedText === 'object' ? Object.keys(value.suppliedText) : undefined,
    instructionChars: typeof value.instruction === 'string' ? value.instruction.length : undefined,
    expectation: expectationKeys(value.expectation),
    stepExpectations: Array.isArray(value.steps) ? value.steps.map(step => expectationKeys(step?.expectation) ?? []) : undefined,
  };
}

function expectationKeys(expectation) {
  return expectation && typeof expectation === 'object' ? Object.keys(expectation).sort() : undefined;
}

/**
 * How the host used fai_browser_run, from the receipts: `suppliedTextCalls` (run calls that sent a non-empty
 * suppliedText), `needsHostCalls` / `unverifiedCalls` (calls that ended with that status), and `calls`, one short
 * shape string per run call ("steps 6, st destination, exp textIncludes+urlIncludes" or "plain 412 ch, exp
 * textIncludes"). No page text and no typed values.
 */
export function runCallStats(receipts = []) {
  const runs = receipts.filter(receipt => /fai_browser_run$/.test(String(receipt.tool ?? '')));
  return {
    suppliedTextCalls: runs.filter(receipt => receipt.arguments?.suppliedText?.length).length,
    needsHostCalls: receipts.filter(receipt => receipt.status === 'needs_host').length,
    unverifiedCalls: receipts.filter(receipt => receipt.status === 'unverified').length,
    calls: runs.map(receipt => callShape(receipt.arguments, receipt.status ?? receipt.errorCode ?? null)),
  };
}

export function callShape(args, ended = null) {
  if (!args) return ended ? `? -> ${ended}` : '?';
  const parts = [];
  if (args.steps) {
    const stepExp = (args.stepExpectations ?? []).map(keys => keys.join('+') || 'none');
    parts.push(`steps ${args.steps} [${stepExp.join(', ')}]`);
  } else if (args.requestId || args.runId) {
    parts.push('continue');
  } else {
    parts.push('plain');
  }
  if (args.instructionChars != null) parts.push(`${args.instructionChars} ch`);
  if (args.suppliedText?.length) parts.push(`st ${args.suppliedText.join('+')}`);
  if (args.expectation?.length) parts.push(`exp ${args.expectation.join('+')}`);
  return `${parts.join(', ')}${ended ? ` -> ${ended}` : ''}`;
}

/** Numbers and fixed codes from one trace.json (never its page text). */
export function summarizeTrace(trace) {
  const requests = Array.isArray(trace?.cost?.requests) ? trace.cost.requests : [];
  const kinds = {};
  for (const entry of requests) {
    kinds[entry.kind ?? 'unknown'] = (kinds[entry.kind ?? 'unknown'] || 0) + 1;
  }
  const warnings = new Set();
  for (const step of trace?.steps ?? []) {
    for (const code of step?.observation?.warnings ?? []) {
      if (typeof code === 'string' && /^[a-z_:.-]+$/i.test(code)) warnings.add(code);
    }
  }
  for (const code of trace?.warnings ?? []) {
    if (typeof code === 'string' && /^[a-z_:.-]+$/i.test(code)) warnings.add(code);
  }
  return {
    runId: trace?.runId ?? null,
    status: trace?.status ?? null,
    code: trace?.code ?? null,
    startedAt: trace?.startedAt ?? null,
    finishedAt: trace?.finishedAt ?? null,
    hops: Array.isArray(trace?.steps) ? trace.steps.length : null,
    stepRuns: Array.isArray(trace?.stepRuns) ? trace.stepRuns.length : null,
    jevRequests: requests.length,
    jevRequestKinds: kinds,
    jevMs: requests.reduce((sum, entry) => sum + (Number(entry.ms) || 0), 0),
    jevErrors: requests.filter(entry => entry.error).length,
    decisions: trace?.cost?.decisions ?? null,
    elapsedMs: trace?.cost?.elapsedMs ?? null,
    warnings: [...warnings].sort(),
  };
}

/** Whether each wanted signal (a fixed code such as "unreadable_region:canvas") shows in the receipts or traces. */
export function signalsIn(wanted = [], receipts = [], traceSummaries = []) {
  const codes = new Set();
  for (const receipt of receipts) {
    for (const code of [receipt.code, ...(receipt.verdict?.why ?? []), ...(receipt.warnings ?? [])]) {
      if (code) codes.add(String(code));
    }
  }
  for (const summary of traceSummaries) {
    for (const code of [summary.code, ...(summary.warnings ?? [])]) {
      if (code) codes.add(String(code));
    }
  }
  return Object.fromEntries(wanted.map(signal => [signal, [...codes].some(code => code === signal || code.startsWith(`${signal}`))]));
}

/**
 * Approval wait inside fai_browser_* calls, estimated: for a call whose receipt names a run with a trace, the time
 * from the call's start to the trace's startedAt (request, popup approval, MCP and daemon overhead); for a call
 * that ended without a run while the request was waiting (next.kind relay, no runId), the whole call.
 * `startEpochMs` is the host process start (call.startedAtMs counts from it).
 */
export function approvalEstimate(receipts, traceSummaries, startEpochMs) {
  const traces = new Map(traceSummaries.map(summary => [summary.runId, summary]));
  let ms = 0;
  let calls = 0;
  for (const receipt of receipts) {
    if (receipt.tool !== 'fai_browser_run' && receipt.tool !== 'fai_browser_wait') continue;
    const trace = receipt.runId ? traces.get(receipt.runId) : null;
    if (trace?.startedAt && startEpochMs != null && receipt.startedAtMs != null) {
      const gap = Date.parse(trace.startedAt) - (startEpochMs + receipt.startedAtMs);
      if (Number.isFinite(gap) && gap > 0) {
        ms += gap;
        calls += 1;
      }
    } else if (!receipt.runId && (receipt.next?.kind === 'relay' || receipt.code === 'select_tab') && receipt.callMs) {
      ms += receipt.callMs;
      calls += 1;
    }
  }
  return { ms: Math.round(ms), calls };
}

/**
 * The live --mcp-config: the installer's .mcp.json with FAI_MCP_MAX_CALL_MS in the fai-browser entry's env (the
 * shape hostEntry('claude', {command, args, env}) writes). Throws if the entry already carries other env.
 */
export function liveMcpConfig(installed, approvalWaitMs, serverName = 'fai-browser') {
  const config = structuredClone(installed);
  const entry = config.mcpServers?.[serverName];
  if (!entry) throw new Error(`no ${serverName} entry`);
  const extra = Object.keys(entry.env ?? {}).filter(name => name !== 'FAI_MCP_MAX_CALL_MS');
  if (extra.length) throw new Error(`the entry carries env ${extra.join(', ')}; live mode adds only FAI_MCP_MAX_CALL_MS`);
  entry.env = { FAI_MCP_MAX_CALL_MS: String(approvalWaitMs) };
  return config;
}

// --- grading ---------------------------------------------------------------------------------------------------

/** How a task is graded: auto (answerPattern regex or expected list) or manual (owner fills grades.json). */
export function graderFor(task) {
  if (task.answerPattern) {
    return { kind: 'auto', by: 'answerPattern', task: { expected: [task.answerPattern], match: 'regex' } };
  }
  if (Array.isArray(task.expected) && task.expected.length) {
    return { kind: 'auto', by: 'expected', task };
  }
  return { kind: 'manual', by: null, task: null };
}

/**
 * Grades the host's final text. A final `ANSWER:` line (private prompts ask for one) is graded as compare.mjs does;
 * without one (live prompts are plain requests) an answerPattern is tested on the whole reply and an expected list
 * matched loosely against it.
 */
export function gradeFinal(task, final) {
  const grader = graderFor(task);
  const { answer: line, formatOk } = extractAnswer(final);
  const answer = line ?? String(final ?? '').trim();
  if (grader.kind === 'manual') {
    return { grading: 'manual', pass: null, passLoose: null, answer, formatOk };
  }
  if (grader.by === 'answerPattern') {
    const pass = answer ? new RegExp(task.answerPattern, 'i').test(answer) || new RegExp(task.answerPattern, 'i').test(String(final ?? '')) : false;
    return { grading: 'auto', pass, passLoose: pass, answer, formatOk };
  }
  const graded = grade(task, answer);
  return { grading: 'auto', pass: line != null ? graded.pass : graded.passLoose, passLoose: graded.passLoose, answer, formatOk };
}

/** grades.json entry key for a run. */
export const runKey = record => `${record.taskId}|${record.host}|${record.rep}`;

/** grades.json content for `records`: answer text plus a pass field the owner edits for manual tasks. */
export function gradesFile(records, existing = {}) {
  const out = {};
  for (const record of records) {
    const key = runKey(record);
    const before = existing[key];
    out[key] = {
      taskId: record.taskId,
      host: record.host,
      rep: record.rep,
      grading: record.grading ?? 'manual',
      pass: record.grading === 'manual' ? (typeof before?.pass === 'boolean' ? before.pass : null) : record.pass,
      note: before?.note ?? (record.grading === 'manual' ? 'owner: set pass to true or false' : 'auto'),
      answer: record.answerText ?? before?.answer ?? null,
    };
  }
  return out;
}

/** Applies owner grades (manual tasks) to records; auto grades are recomputed by the caller from the task file. */
export function applyGrades(records, grades = {}) {
  return records.map(record => {
    const entry = grades[runKey(record)];
    if (record.grading === 'manual' && typeof entry?.pass === 'boolean') {
      return { ...record, pass: entry.pass, passLoose: entry.pass, gradedBy: 'owner' };
    }
    return record;
  });
}

// --- checklist -------------------------------------------------------------------------------------------------

/**
 * The live preflight verdict from what the runner gathered (no I/O here). Each line is {level: ok|warn|fail, text}.
 * `health` is GET /v1/health (null: nothing answers), `status` GET /v1/status through src/client.js (null with
 * `statusError` when the client could not connect), `mainCommitEpochS` the last commit on main.
 */
export function evaluateChecklist({ port = 4318, health, status, statusError = null, clientVersion, root, nowMs = Date.now(),
  mainCommitEpochS = null, headCommit = null, mainCommit = null, claudeVersion = null, foreignEnv = [] }) {
  const lines = [];
  const add = (level, text) => lines.push({ level, text });
  if (claudeVersion) add('ok', `Claude Code ${claudeVersion}`);
  else add('fail', 'claude --version failed: is Claude Code installed and logged in?');
  if (!health) {
    add('fail', `no FAI Browser daemon answers on 127.0.0.1:${port}: run \`node src/cli.js daemon restart\` in this checkout`);
    return { ok: false, lines };
  }
  if (health.version !== clientVersion) {
    add('warn', `DAEMON VERSION ${health.version} != this checkout's ${clientVersion}: the MCP server restarts an idle `
      + 'daemon of another version; restart it yourself first (`node src/cli.js daemon restart`)');
  } else {
    add('ok', `daemon ${health.version} on 127.0.0.1:${port} (pid ${health.pid})`);
  }
  if (!status) {
    add('fail', `daemon status unavailable through src/client.js (${statusError ?? 'unknown error'}): run the bench `
      + 'from the checkout the daemon serves (its client token lives there)');
    return { ok: false, lines };
  }
  const daemon = status.daemon ?? {};
  if (daemon.home && root && daemon.home !== root) {
    add('fail', `daemon home is ${daemon.home}, this checkout is ${root}: the installed entry uses this checkout's `
      + 'FAI_HOME, so run the bench from the daemon\'s checkout');
  } else if (daemon.home) {
    add('ok', `daemon home ${daemon.home} (the plain entry's FAI_HOME)`);
  }
  const startedMs = Number.isFinite(daemon.uptimeMs) ? nowMs - daemon.uptimeMs : null;
  if (startedMs != null) {
    const started = new Date(startedMs).toISOString();
    if (mainCommitEpochS != null && startedMs < mainCommitEpochS * 1000) {
      add('warn', `!!! DAEMON STARTED ${started}, BEFORE THE LAST COMMIT ON MAIN (${new Date(mainCommitEpochS * 1000)
        .toISOString()}): it runs old code. Run \`node src/cli.js daemon restart\` and reload the extension. !!!`);
    } else {
      add('ok', `daemon started ${started}${mainCommitEpochS != null ? ', after the last commit on main' : ''}`);
    }
  }
  if (headCommit && mainCommit && headCommit !== mainCommit) {
    add('warn', `this checkout is at ${headCommit.slice(0, 10)}, main is at ${mainCommit.slice(0, 10)}`);
  } else if (headCommit) {
    add('ok', `checkout at ${headCommit.slice(0, 10)}${mainCommit ? ' (= main)' : ''}`);
  }
  const extension = status.extension ?? {};
  if (extension.connected) {
    add('ok', `extension connected (${extension.transport ?? 'transport ?'}${extension.version ? `, extension ${extension.version}` : ''})`);
  } else if (Number.isFinite(extension.lastSeenMs)) {
    // An idle MV3 service worker drops its socket; it reconnects when the popup opens.
    add('warn', `extension not connected right now (last seen ${Math.round(extension.lastSeenMs / 1000)} s ago): click the `
      + 'FAI Browser icon in the Public profile once to wake it');
  } else {
    add('fail', 'extension never connected to this daemon: open the Public Chrome profile, reload FAI Browser at '
      + 'chrome://extensions, check Setup & connection');
  }
  const pending = status.requests?.length ?? 0;
  const active = status.runs?.active?.length ?? 0;
  if (pending || active) {
    add('warn', `${pending} open request(s), ${active} active run(s) on the daemon: a stale lease may be reused`);
  }
  for (const name of foreignEnv) {
    add('warn', `${name} is set in this shell; the runner removes it from the host's environment (plain entry)`);
  }
  return { ok: !lines.some(line => line.level === 'fail'), lines };
}

export function renderChecklist({ lines }) {
  const tag = { ok: '[ ok ]', warn: '[WARN]', fail: '[FAIL]' };
  return lines.map(line => `${tag[line.level]} ${line.text}`).join('\n');
}

// --- summary ---------------------------------------------------------------------------------------------------

const sum = values => values.reduce((total, value) => total + (Number(value) || 0), 0);
const fmtS = ms => (ms == null ? '-' : (ms / 1000).toFixed(1));
const fmtUsd = usd => (usd == null ? '-' : `$${usd.toFixed(3)}`);
const cell = value => (value == null ? '-' : String(value));

/** Replaces the home directory with ~ in every string of `value` (deep). */
export function sanitizeHome(value, home) {
  if (!home) return value;
  if (typeof value === 'string') return value.split(home).join('~');
  if (Array.isArray(value)) return value.map(item => sanitizeHome(item, home));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeHome(item, home)]));
  }
  return value;
}

/** The summary row of one run record: numbers and codes only, never page or answer text. */
export function summaryRow(record) {
  return {
    taskId: record.taskId,
    host: record.host,
    rep: record.rep,
    outcome: record.outcome,
    reason: record.reason ? String(record.reason).split('\n')[0].slice(0, 200) : null,
    grading: record.grading ?? null,
    pass: record.pass ?? null,
    gradedBy: record.gradedBy ?? (record.grading === 'auto' ? 'auto' : null),
    wallMs: record.wallMs ?? null,
    approvalMs: record.approvalMs ?? null,
    approvalSource: record.approvalSource ?? null,
    requests: record.requests ?? null,
    numTurns: record.numTurns ?? record.claude?.numTurns ?? null,
    faiRuns: record.faiRuns ?? null,
    toolCalls: record.toolCalls ?? null,
    faiRunCalls: record.faiRunCalls ?? null,
    faiStepCalls: record.faiStepCalls ?? null,
    stepsSent: record.faiListSteps ?? null,
    suppliedTextCalls: record.suppliedTextCalls ?? null,
    needsHostCalls: record.needsHostCalls ?? null,
    unverifiedCalls: record.unverifiedCalls ?? null,
    calls: record.runCalls ?? null,
    jevRequests: record.jev?.requests ?? null,
    jevMs: record.jev?.ms ?? null,
    hops: record.jev?.hops ?? null,
    autoAnswers: record.oversight?.autoAnswers ?? null,
    oversightKind: record.oversightKind ?? null,
    finalNext: record.oversight?.finalNext ?? null,
    falseAutomations: record.oversight?.falseAutomation ?? null,
    costUsd: record.cost?.usd ?? record.cost?.reportedUsd ?? null,
    approvalTimeouts: record.approvalTimeouts ?? null,
    invalidParams: record.invalidParams ?? null,
    hostToolUses: record.hostToolUses ?? null,
    signals: record.signals ?? null,
    receipts: record.receiptCount ?? null,
    traces: record.traceCount ?? null,
  };
}

/** summary.json body: rows, per-host totals, skipped tasks. */
export function buildSummary(records, { meta = {}, skipped = [] } = {}) {
  const rows = records.map(summaryRow);
  const hosts = [...new Set(rows.map(row => row.host))];
  const totals = {};
  for (const host of hosts) {
    const mine = rows.filter(row => row.host === host && row.outcome !== 'skipped');
    // A run lost to the approval wait (outcome approval_timeout) is counted, never graded.
    const graded = mine.filter(row => row.pass != null && row.outcome !== 'approval_timeout');
    totals[host] = {
      runs: mine.length,
      graded: graded.length,
      passed: graded.filter(row => row.pass).length,
      approvalTimeoutRuns: mine.filter(row => row.outcome === 'approval_timeout').length,
      ungraded: mine.filter(row => row.outcome !== 'approval_timeout').length - graded.length,
      wallMs: sum(mine.map(row => row.wallMs)),
      approvalMs: sum(mine.map(row => row.approvalMs)),
      requests: sum(mine.map(row => row.requests)),
      requestsPerTask: mine.length ? sum(mine.map(row => row.requests)) / mine.length : null,
      numTurns: sum(mine.map(row => row.numTurns)),
      faiRuns: sum(mine.map(row => row.faiRuns)),
      toolCalls: sum(mine.map(row => row.toolCalls)),
      faiRunCalls: sum(mine.map(row => row.faiRunCalls)),
      stepCalls: sum(mine.map(row => row.faiStepCalls)),
      stepsSent: sum(mine.map(row => row.stepsSent)),
      suppliedTextCalls: sum(mine.map(row => row.suppliedTextCalls)),
      needsHostCalls: sum(mine.map(row => row.needsHostCalls)),
      unverifiedCalls: sum(mine.map(row => row.unverifiedCalls)),
      jevRequests: sum(mine.map(row => row.jevRequests)),
      jevMs: sum(mine.map(row => row.jevMs)),
      hops: sum(mine.map(row => row.hops)),
      autoAnswers: sum(mine.map(row => row.autoAnswers)),
      falseAutomations: sum(mine.map(row => row.falseAutomations)),
      costUsd: sum(mine.map(row => row.costUsd)),
    };
  }
  return { meta, rows, totals, skipped };
}

/** summary.md: one row per run, then per-host totals, then notes. */
export function renderSummary({ meta = {}, rows, totals, skipped = [] }) {
  const out = [];
  out.push(`# Live bench: ${meta.mode ?? '?'} mode${meta.label ? ` (${meta.label})` : ''}`);
  out.push('');
  const facts = [
    meta.startedAt && `started ${meta.startedAt}`,
    meta.commit && `commit ${String(meta.commit).slice(0, 10)}`,
    meta.claudeCode && `Claude Code ${meta.claudeCode}`,
    meta.tasksFile && `tasks ${meta.tasksFile}`,
    meta.realTools && `real-tools ${meta.realTools}`,
  ].filter(Boolean);
  if (facts.length) out.push(facts.join(' · '), '');
  const header = ['Task', 'Host', 'Rep', 'Grading', 'Pass', 'Wall s', 'Approval s', 'Requests', 'Turns', 'Tool calls',
    'Run calls', 'FAI runs', 'Step calls', 'Steps sent', 'suppliedText calls', 'needs_host', 'unverified', 'Jev req', 'Jev s', 'Hops', 'Auto answers', 'Oversight', 'False auto', 'Cost $', 'Notes'];
  out.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`);
  for (const row of rows) {
    const notes = [];
    if (row.outcome && row.outcome !== 'ok') notes.push(row.outcome);
    if (row.finalNext) notes.push(`next ${row.finalNext}`);
    if (row.approvalTimeouts) notes.push(`${row.approvalTimeouts}× select_tab`);
    if (row.invalidParams) notes.push(`${row.invalidParams}× invalid_params`);
    for (const [signal, seen] of Object.entries(row.signals ?? {})) notes.push(`${signal} ${seen ? 'seen' : 'absent'}`);
    if (row.hostToolUses) notes.push(Object.entries(row.hostToolUses).map(([name, n]) => `${name}×${n}`).join(' '));
    const pass = row.outcome === 'approval_timeout' ? 'approval timeout' : row.pass == null ? (row.grading === 'manual' ? 'to grade' : '-') : row.pass ? 'PASS' : 'FAIL';
    out.push(`| ${[row.taskId, row.host, row.rep, row.grading ?? '-', `${pass}${row.gradedBy === 'owner' ? ' (owner)' : ''}`,
      fmtS(row.wallMs), fmtS(row.approvalMs), cell(row.requests), cell(row.numTurns), cell(row.toolCalls),
      cell(row.faiRunCalls), cell(row.faiRuns), cell(row.faiStepCalls), cell(row.stepsSent), cell(row.suppliedTextCalls),
      cell(row.needsHostCalls), cell(row.unverifiedCalls), cell(row.jevRequests), fmtS(row.jevMs), cell(row.hops), cell(row.autoAnswers),
      cell(row.oversightKind), cell(row.falseAutomations), fmtUsd(row.costUsd), notes.join('; ') || ''].join(' | ')} |`);
  }
  out.push('');
  const shaped = rows.filter(row => row.calls?.length);
  if (shaped.length) {
    out.push('## What the host sent', '', 'One line per run: each fai_browser_run call\'s shape (steps with each step\'s '
      + 'expectation keys, or plain; instruction length; suppliedText field names; expectation keys) and how it ended.', '');
    for (const row of shaped) {
      out.push(`- ${row.taskId} ${row.host} #${row.rep}: ${row.calls.map((shape, index) => `(${index + 1}) ${shape}`).join('; ')}`);
    }
    out.push('');
  }
  out.push('## Totals per host', '');
  const totalHeader = ['Host', 'Runs', 'Passed/graded', 'Approval timeouts', 'To grade', 'Wall s', 'Approval s', 'Requests/task',
    'Turns', 'Tool calls', 'Run calls', 'FAI runs', 'Step calls', 'Steps sent', 'suppliedText calls', 'needs_host', 'unverified', 'Jev req', 'Jev s', 'Hops', 'Auto answers', 'False auto', 'Cost $'];
  out.push(`| ${totalHeader.join(' | ')} |`, `|${totalHeader.map(() => '---').join('|')}|`);
  for (const [host, total] of Object.entries(totals)) {
    out.push(`| ${[host, total.runs, `${total.passed}/${total.graded}`, total.approvalTimeoutRuns, total.ungraded, fmtS(total.wallMs),
      fmtS(total.approvalMs), total.requestsPerTask == null ? '-' : total.requestsPerTask.toFixed(2), total.numTurns,
      total.toolCalls, total.faiRunCalls, total.faiRuns, total.stepCalls, total.stepsSent, total.suppliedTextCalls,
      total.needsHostCalls, total.unverifiedCalls, total.jevRequests, fmtS(total.jevMs), total.hops, total.autoAnswers,
      total.falseAutomations, fmtUsd(total.costUsd)].join(' | ')} |`);
  }
  out.push('');
  out.push('Requests = distinct model requests (assistant message ids) of the Claude Code session, ToolSearch and '
    + 'skill loads included, as compare.mjs counts them; Turns = Claude Code\'s own num_turns. Run calls = '
    + 'fai_browser_run calls; FAI runs = distinct daemon runs (run ids) in the receipts, act included. Approval s = '
    + (meta.mode === 'live'
      ? 'estimated wait for the owner\'s popup approval: time inside fai_browser_* calls before the run\'s trace '
        + 'started, plus whole calls that returned relay while the request was pending (includes small MCP and daemon '
        + 'overhead); it is part of Wall s.'
      : 'the harness\'s auto-approval clicks (bench/fai-condition.mjs); part of Wall s.')
    + ' Jev req / Jev s / Hops come from each run\'s trace.json (cost.requests, steps). Grading auto = answerPattern '
    + 'or expected matched on the host\'s reply; manual = the owner grades in grades.json, then `--regrade DIR`. '
    + 'approval timeout = every fai_browser_run call ended needs_user/select_tab (the owner had not approved within the '
    + 'per-call wait) and no FAI run happened: counted, kept out of Passed/graded.');
  if (skipped.length) {
    out.push('', `Skipped tasks: ${skipped.map(item => `${item.id} (${item.reason})`).join(', ')}.`);
  }
  return `${out.join('\n')}\n`;
}
