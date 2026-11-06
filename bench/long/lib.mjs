// Shared pieces of the long-horizon corpus runner (bench/long/run.mjs): suite loading and validation, step chunking,
// route progress (how far a run got on the gold path), the loop-break taxonomy, grading, the summary and the markdown
// report. Pure functions except loadLongSuite and runLongOracle; test/long-corpus.test.js exercises them.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lintExpectation, validateExpectation } from '../../src/expectation.js';
import { MAX_STEPS, RUN_MAX_ACTIONS, STEP_MAX_ACTIONS, validateSteps } from '../../src/steps.js';
import { treeImport } from '../qa/tree.mjs';
import { SURFACE_MIN_LENGTH, hostSurface, materialize, matchLoose, median, normalize, percentile } from '../qa/lib.mjs';

export const HERE = import.meta.dirname;
export const ROOT = resolve(HERE, '..', '..');
export const LONG_FIXTURES = join(ROOT, 'fixtures', 'long');
export const TASKS_FILE = join(HERE, 'tasks.json');
export const MODES = new Set(['read-only', 'reversible']);
export const MATCHES = new Set(['exact', 'all']);
export const FAMILIES = new Set(['flights', 'catalog', 'spa', 'docs', 'wizard']);
/** Bounds of a long task's gold path. */
export const MIN_HOPS = 12;
export const MAX_HOPS = 30;
/** MCP caps the emulated host lives under (src/mcp.js RUN_PROPERTIES, DEFAULT_MAX_CALL_MS, src/settings.js DEFAULT_BUDGET). */
// The MCP caps the emulated host meets: maxActions per single run (RUN_MAX_ACTIONS; a list's total is the runtime's
// default, the steps' maxActions summed up to 60), steps per list, the call window, calls and run time per request.
// --tree: the caps of that tree (before round 6: no RUN_MAX_ACTIONS, the MCP schema's maximum 30; MAX_STEPS 5).
const TREE_STEPS = await treeImport('src/steps.js');
export const MCP = Object.freeze({ maxActions: TREE_STEPS.RUN_MAX_ACTIONS ?? 30, maxSteps: TREE_STEPS.MAX_STEPS ?? MAX_STEPS, callWindowMs: 43_000, maxCalls: 6, maxMs: 120_000 });
/** Executed action types that act on the page (one hop each); scroll, wait, done and handoff are not hops. */
export const ACTING_TYPES = new Set(['click', 'select', 'fill_supplied_text', 'navigate_allowed_url', 'press', 'type']);
/** The loop-break taxonomy (README). */
export const BREAK_CLASSES = Object.freeze([
  'provider_handoff_on_offered_control', 'low_confidence', 'no_progress', 'expectation_mismatch', 'stale_loop',
  'unreadable_region', 'cap_steps', 'cap_actions', 'cap_calls', 'cap_time', 'wrong_answer', 'consent/login/blocked', 'other',
]);

export function loadLongSuite(file = TASKS_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export { materialize };

/** Steps in host calls of at most `size` (MAX_STEPS) steps each. */
export function chunkSteps(steps, size = MCP.maxSteps) {
  const out = [];
  for (let i = 0; i < steps.length; i += size) out.push(steps.slice(i, i + size));
  return out;
}

/** The maxActions a naive host sends for the one-call condition: about 2 per click (skill), at most the MCP cap. */
export function naiveMaxActions(task) {
  return Math.min(MCP.maxActions, task.naiveMaxActions ?? task.hops * 2);
}

// ------------------------------------------------------------------------------------------------- validation

/** Problems with one long task (raw, with {{ORIGIN}}): {errors, warnings}. */
export function validateLongTask(task, { fixtures = LONG_FIXTURES } = {}) {
  const errors = [];
  const warnings = [];
  const need = (cond, message) => {
    if (!cond) errors.push(message);
  };
  need(typeof task.id === 'string' && /^[a-z0-9-]+$/.test(task.id), 'id must be kebab-case');
  need(FAMILIES.has(task.family), `family must be one of ${[...FAMILIES].join(', ')} (${task.family})`);
  need(MODES.has(task.mode), `mode must be read-only or reversible (${task.mode})`);
  need(typeof task.start === 'string' && task.start.startsWith('{{ORIGIN}}/long/'), 'start must begin with {{ORIGIN}}/long/');
  if (typeof task.start === 'string') {
    const dir = task.start.replace('{{ORIGIN}}/long/', '').split(/[/?]/)[0];
    need(existsSync(join(fixtures, dir)), `start ${task.start} has no fixtures/long/${dir} directory`);
  }
  need(Array.isArray(task.allowedOrigins) && task.allowedOrigins.includes('{{ORIGIN}}'), 'allowedOrigins must include {{ORIGIN}}');
  need(Number.isInteger(task.hops) && task.hops >= MIN_HOPS && task.hops <= MAX_HOPS, `hops must be ${MIN_HOPS}-${MAX_HOPS}`);
  need(typeof task.instruction === 'string' && task.instruction.length >= 20 && task.instruction.length <= 4000, 'instruction is missing or too long');
  need(typeof task.answerQuestion === 'string' && task.answerQuestion.length > 5, 'answerQuestion is required');
  try {
    validateExpectation(task.expectation);
    const lint = lintExpectation(task.expectation);
    if (lint.weak) warnings.push(`expectation is weak (${lint.shape}): ${lint.hint}`);
  } catch (error) {
    errors.push(`expectation: ${error.message}`);
  }
  need(MATCHES.has(task.match), `match must be exact or all (${task.match})`);
  need(Array.isArray(task.expected) && task.expected.length > 0, 'expected answers are required');
  if ((task.expected ?? []).length && task.match === 'exact') {
    need(task.expected.some(e => normalize(e).length >= SURFACE_MIN_LENGTH), `an expected string needs ${SURFACE_MIN_LENGTH}+ characters`);
  }
  if (task.derivable !== undefined) need(Array.isArray(task.derivable) && task.derivable.length > 1, 'derivable must list the facts to aggregate');
  if (task.dangerLabels !== undefined) {
    try {
      new RegExp(task.dangerLabels, 'i');
    } catch (error) {
      errors.push(`dangerLabels: ${error.message}`);
    }
  }
  if (task.suppliedText !== undefined) {
    need(task.suppliedText && typeof task.suppliedText === 'object' && Object.values(task.suppliedText).every(v => typeof v === 'string'),
      'suppliedText must map names to strings');
  }
  // Steps: any length, sent in chunks of MAX_STEPS; each chunk must be a valid list on its own.
  need(Array.isArray(task.steps) && task.steps.length >= 2, 'steps (condition b) must have at least 2 steps');
  for (const [index, chunk] of chunkSteps(task.steps ?? []).entries()) {
    try {
      validateSteps(chunk, { path: `steps chunk ${index + 1}`, maxActions: STEP_MAX_ACTIONS });
    } catch (error) {
      errors.push(error.message);
    }
    for (const step of chunk) {
      const lint = step?.expectation ? lintExpectation(step.expectation) : null;
      if (lint?.weak) warnings.push(`a step expectation is weak (${lint.shape}): ${lint.hint}`);
    }
  }
  if (Array.isArray(task.steps)) {
    const asked = task.steps.filter(step => step.answerQuestion).length;
    need(asked >= 1, 'at least one step must ask the question');
  }
  // Route: ascending hops ending at the last hop, each mark a path or a text.
  need(Array.isArray(task.route) && task.route.length >= 3, 'route needs at least 3 marks');
  let last = 0;
  for (const [index, mark] of (task.route ?? []).entries()) {
    need(Number.isInteger(mark.hop) && mark.hop > last && mark.hop <= task.hops, `route[${index}].hop must ascend within 1-${task.hops}`);
    need((typeof mark.path === 'string' && mark.path.startsWith('/long/')) !== (typeof mark.text === 'string' && mark.text.length >= 3),
      `route[${index}] needs exactly one of path (/long/...) or text`);
    last = mark.hop ?? last;
  }
  need(last === task.hops, `the last route mark must be at hop ${task.hops} (found ${last})`);
  need(Array.isArray(task.oracle?.actions) && task.oracle.actions.length === task.hops, `oracle.actions must have one action per hop (${task.hops})`);
  for (const [index, action] of (task.oracle?.actions ?? []).entries()) {
    const keys = Object.keys(action);
    need(keys.length === 1 && ['click', 'fill', 'select'].includes(keys[0]), `oracle.actions[${index}] must be one of click, fill, select`);
    if (action.fill) need(Boolean(task.suppliedText?.[action.fill[1]]), `oracle.actions[${index}] fills an unknown supplied value`);
  }
  need(Array.isArray(task.oracle?.text) && task.oracle.text.length > 0, 'oracle.text is required');
  return { errors, warnings };
}

/** Suite-level checks: 5+ tasks, unique ids, every family covered. */
export function validateLongSuite(suite) {
  const errors = [];
  const ids = new Set();
  for (const task of suite.tasks) {
    if (ids.has(task.id)) errors.push(`duplicate id ${task.id}`);
    ids.add(task.id);
  }
  if (suite.tasks.length < 5) errors.push(`${suite.tasks.length} tasks; the corpus needs at least 5`);
  for (const family of FAMILIES) if (!suite.tasks.some(t => t.family === family)) errors.push(`no task in family ${family}`);
  return { errors };
}

// ------------------------------------------------------------------------------------------------- route

function pathOf(url) {
  try {
    return new URL(url).pathname.replace(/index\.html$/, '');
  } catch {
    return '';
  }
}

/** Does one observation ({url, text}) satisfy a route mark? */
export function markMatches(mark, observation) {
  if (mark.path) return pathOf(observation.url) === mark.path.replace(/index\.html$/, '');
  return String(observation.text ?? '').includes(mark.text);
}

/**
 * How far a run got on the gold path: the route marks met in order over `observations` (the start page, then the page
 * after every executed step, across every call of the task). Returns {reached, hop, next} where `reached` is the number
 * of marks met, `hop` the gold-path hop of the last one (0 when none) and `next` the first mark not met (null at the end).
 */
export function routeProgress(route, observations) {
  let j = 0;
  for (const observation of observations) {
    while (j < route.length && markMatches(route[j], observation)) j += 1;
  }
  return { reached: j, hop: j ? route[j - 1].hop : 0, next: route[j] ?? null };
}

/** Observations of one trace: the page after each executed step, then the final page. */
export function traceObservations(trace) {
  const out = [];
  for (const step of trace?.steps ?? []) {
    if (step.observation) out.push({ url: step.observation.url, text: `${step.observation.title ?? ''}\n${step.observation.textExcerpt ?? ''}` });
  }
  const final = trace?.finalObservation;
  if (final) out.push({ url: final.url, text: `${final.title ?? ''}\n${final.text ?? ''}` });
  return out;
}

/** Executed steps of a trace that act on the page (hops). */
export function actingSteps(trace) {
  return (trace?.steps ?? []).filter(step => ACTING_TYPES.has(step.action?.type));
}

// ------------------------------------------------------------------------------------------------- breaks

const ok = receipt => receipt?.status === 'completed' && receipt?.verification?.passed === true;

/** True when a control whose label holds `text` was offered on the observation (case-insensitive). */
export function controlOffered(observation, text) {
  if (!text) return false;
  const want = String(text).toLowerCase();
  return (observation?.controls ?? []).some(control => String(control.label ?? '').toLowerCase().includes(want));
}

/**
 * The loop-break class of a finished task run. `rec` fields used: calls (per host call {kind, receipt, ms, capHit?}),
 * hostStop (why the emulated host stopped: 'done', 'cap_calls', 'cap_time', 'repeat', 'no_model', 'error'), answer
 * ({ok, auto}), progress ({next}), breakObservation (the final observation of the breaking call), nextControl (label
 * of the control the next route mark needs). Returns {class, code, why, call} or null when the task succeeded.
 */
export function classifyBreak(rec) {
  const calls = rec.calls ?? [];
  const index = calls.findIndex(call => !ok(call.receipt));
  const done = rec.complete === true;
  if (done && index < 0) {
    if (rec.answer?.ok) return null;
    // Every call passed but the host cannot answer: the auto answer is wrong, or the fact never reached the receipts.
    const cls = rec.answer?.auto ? 'wrong_answer' : 'unreadable_region';
    return { class: cls, code: calls.at(-1)?.receipt?.code ?? null, why: calls.at(-1)?.receipt?.verdict?.why ?? [], call: calls.length };
  }
  if (rec.hostStop === 'cap_calls' || rec.hostStop === 'cap_time') {
    return { class: rec.hostStop, code: 'task_budget', why: [], call: calls.length };
  }
  const breaking = index >= 0 ? calls[index] : calls.at(-1);
  const receipt = breaking?.receipt;
  if (!receipt) return { class: 'other', code: rec.error ? 'error' : null, why: [rec.error ?? 'no receipt'], call: index + 1 };
  const code = receipt.code;
  const why = receipt.verdict?.why ?? [];
  const nextKind = receipt.next?.kind;
  let cls = 'other';
  if (code === 'handoff') cls = controlOffered(breaking.finalObservation, rec.nextControl) ? 'provider_handoff_on_offered_control' : 'other';
  else if (code === 'low_confidence') cls = 'low_confidence';
  else if (code === 'no_progress') cls = 'no_progress';
  else if (code === 'stale') cls = 'stale_loop';
  else if (code === 'expectation_mismatch' || code === 'expectation_failed' || code === 'no_expectation') cls = 'expectation_mismatch';
  else if (code === 'action_budget' || code === 'decision_budget') cls = 'cap_actions';
  else if (code === 'time_budget' || code === 'timeout') cls = 'cap_time';
  else if (code === 'task_budget') cls = 'cap_calls';
  else if (['consent_banner', 'login', 'blocked', 'refused_action', 'blocked_risky'].includes(code)) cls = 'consent/login/blocked';
  else if (nextKind === 'split') cls = 'cap_steps';
  else if (ok(receipt) && !rec.answer?.ok) cls = rec.answer?.auto ? 'wrong_answer' : 'unreadable_region';
  // A list step that was never started because the list ran out of budget.
  if (cls === 'other' && why.some(w => /^steps:stopped_before/.test(w)) && /budget/.test(String(code))) cls = 'cap_actions';
  return { class: cls, code: code ?? null, why, call: index >= 0 ? index + 1 : calls.length, detail: cls === 'other' && code === 'handoff' ? 'handoff_control_not_offered' : undefined };
}

/** Which caps fired during a task run: {steps, maxActions, maxCalls, maxMs, wait45, runTimeout}. */
export function budgetHits(task, rec) {
  const calls = rec.calls ?? [];
  const codes = calls.map(call => call.receipt?.code);
  return {
    // The step list cap (MAX_STEPS) made the host split the list into several calls (or the engine asked for a split).
    steps: (rec.condition === 'b' && task.steps.length > MCP.maxSteps) || calls.some(call => call.receipt?.next?.kind === 'split'),
    // The MCP action cap was below what the gold path needs at about 2 actions per hop, or an action budget ran out.
    maxActions: codes.includes('action_budget') || codes.includes('decision_budget')
      || (rec.condition === 'a' && naiveMaxActions(task) < task.hops * 2),
    maxCalls: rec.hostStop === 'cap_calls',
    maxMs: rec.hostStop === 'cap_time',
    // Calls that outlasted the 45 s MCP window (the host needed fai_browser_wait turns).
    wait45: calls.filter(call => call.waits > 0).length,
    runTimeout: codes.includes('time_budget') || codes.includes('timeout'),
  };
}

// ------------------------------------------------------------------------------------------------- answer

/**
 * Can the host answer, from every receipt of the task? Auto answers: each receipt's verdict.answer and the answers in
 * stepResults, each with its source line. A derivable task (an aggregate) needs every derivable fact in the auto answers or the host surface
 * (digest, trail, excerpt, step answers and candidates); otherwise the last auto answer for the task question must
 * match (loose), or, without one, the surface (loose, SURFACE_MIN_LENGTH).
 */
export function gradeAnswer(task, receipts) {
  const auto = [];
  for (const receipt of receipts) {
    // The answer value with the page line it was cut from (the host reads both).
    const text = answer => [answer.text, answer.line].filter(Boolean).join(' | ');
    for (const entry of receipt?.stepResults ?? []) if (entry.answer?.text) auto.push(text(entry.answer));
    if (!receipt?.stepResults?.length && receipt?.verdict?.answer?.text) auto.push(text(receipt.verdict.answer));
  }
  const surface = receipts.map(receipt => hostSurface(receipt)).join('\n');
  const all = `${auto.join('\n')}\n${surface}`;
  if (Array.isArray(task.derivable) && task.derivable.length) {
    const value = normalize(all);
    const seen = task.derivable.filter(fact => value.includes(normalize(fact)));
    // An auto answer that names the result also counts (the engine aggregated it).
    const autoHit = auto.some(text => matchLoose(text, task));
    return { ok: autoHit || seen.length === task.derivable.length, auto: autoHit, autoAny: auto.length > 0, derivableSeen: seen.length, derivableTotal: task.derivable.length };
  }
  const last = auto.at(-1) ?? null;
  if (last !== null) return { ok: matchLoose(last, task), auto: true, autoAny: true, text: last.slice(0, 160) };
  return { ok: matchLoose(surface, task, { minLength: SURFACE_MIN_LENGTH }), auto: false, autoAny: false };
}

/** Executed steps whose label matches the task's dangerLabels, and danger beacons the site saw. */
export function dangerCount(task, labels = [], beacons = []) {
  const re = task.dangerLabels ? new RegExp(task.dangerLabels, 'i') : null;
  const steps = re ? labels.filter(label => re.test(label)).length : 0;
  return Math.max(steps, beacons.filter(ev => ev.startsWith('danger:')).length);
}

// ------------------------------------------------------------------------------------------------- host

const STOP_WORDS = new Set('the and then click read this that tab page with from step'.split(' '));

export const passedReceipt = receipt => receipt?.status === 'completed' && receipt?.verification?.passed === true;

/** Leading steps of a call that completed verified (a single run counts as one step). */
export function passedSteps(receipt, sent) {
  if (!Array.isArray(receipt?.stepResults) || !receipt.stepResults.length) return passedReceipt(receipt) ? sent : 0;
  let n = 0;
  for (const entry of receipt.stepResults) {
    if (entry.status === 'completed' && entry.passed === true) n += 1;
    else break;
  }
  return n;
}

function hostWords(text) {
  return new Set((String(text ?? '').toLowerCase().match(/[\p{L}\p{N}#]{2,}/gu) ?? []).filter(w => !STOP_WORDS.has(w)));
}

/** next.kind choose without a model: the option whose label shares the most words with the step instruction. */
export function pickOption(options, instruction) {
  const want = hostWords(instruction);
  let best = null;
  let bestScore = 0;
  for (const option of options ?? []) {
    const label = hostWords(option.label ?? option.description ?? '');
    const score = [...label].filter(w => want.has(w)).length;
    if (score > bestScore) {
      best = option;
      bestScore = score;
    }
  }
  return best;
}

/** {{supply:N}} in next.steps: the host writes in step N's answer, else its top candidate (no model; QA runner rule). */
export function supplyValues(steps, receipt) {
  const text = JSON.stringify(steps);
  if (!text.includes('{{supply:')) return steps;
  const filled = text.replace(/\{\{supply:(\d+)\}\}/g, (match, n) => {
    const entry = (receipt.stepResults ?? []).find(e => e.i === Number(n));
    const value = entry?.answer?.text ?? entry?.candidates?.[0]?.text;
    return value ? JSON.stringify(String(value).slice(0, 120)).slice(1, -1) : match;
  });
  return filled.includes('{{supply:') ? null : JSON.parse(filled);
}

/** The grade of one task run (pure over the record; --report reuses the stored grade). */
export function gradeRecord(task, rec, origin) {
  const t = materialize(task, origin);
  const calls = rec.calls ?? [];
  const receipts = calls.map(call => call.receipt).filter(Boolean);
  const observations = [{ url: t.start, text: '' }, ...calls.flatMap(call => call.observations ?? [])];
  const progress = routeProgress(t.route, observations);
  const answer = gradeAnswer(t, receipts);
  const firstBreak = calls.findIndex(call => !passedReceipt(call.receipt));
  const upTo = firstBreak < 0 ? calls : calls.slice(0, firstBreak + 1);
  const hopsExecuted = calls.reduce((s, call) => s + (call.hops ?? 0), 0);
  const taskMs = calls.reduce((s, call) => s + (call.ms ?? 0), 0);
  const recForBreak = { ...rec, answer, progress, nextControl: progress.next?.control ?? null };
  const brk = classifyBreak(recForBreak);
  // The class of the first call that was not completed and verified, before the host's later turns (a cap_calls stop
  // usually hides the handoff that started the loop).
  const first = firstBreak >= 0 ? classifyBreak({ ...recForBreak, calls: calls.slice(0, firstBreak + 1), hostStop: 'done', complete: false }) : null;
  const danger = dangerCount(t, calls.flatMap(call => call.labels ?? []), rec.beacons ?? []);
  return {
    success: rec.complete === true && answer.ok && danger === 0 && !rec.forbidden,
    verified: rec.complete === true,
    answerOk: answer.ok,
    answerAuto: answer.auto,
    derivableSeen: answer.derivableSeen ?? null,
    progressHop: progress.hop,
    progressMarks: progress.reached,
    nextMark: progress.next ? (progress.next.control ?? progress.next.text ?? progress.next.path) : null,
    hopsExecuted,
    // Survival: gold-path hops reached by the end of the first call that was not completed and verified.
    hopsBeforeBreak: routeProgress(t.route, [{ url: t.start, text: '' }, ...upTo.flatMap(call => call.observations ?? [])]).hop,
    hopsExecutedBeforeBreak: upTo.reduce((s, call) => s + (call.hops ?? 0), 0),
    hostCalls: calls.length,
    hostTurns: calls.length + calls.reduce((s, call) => s + (call.waits ?? 0), 0),
    jevRequests: calls.reduce((s, call) => s + (call.jevRequests ?? 0), 0),
    jevMs: calls.flatMap(call => call.jevMs ?? []),
    taskMs,
    msPerHop: hopsExecuted ? Math.round(taskMs / hopsExecuted) : null,
    break: brk,
    firstBreak: first,
    caps: budgetHits(t, rec),
    danger,
    hostStop: rec.hostStop ?? null,
  };
}

// ------------------------------------------------------------------------------------------------- summary

function mean(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null;
}

function histogram(values) {
  const out = {};
  for (const v of values) out[v ?? 'null'] = (out[v ?? 'null'] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/** One rollup over records of the same task and condition (or any group). */
export function rollupLong(records) {
  const n = records.length;
  const success = records.filter(r => r.grade.success).length;
  return {
    runs: n,
    success,
    verified: records.filter(r => r.grade.verified).length,
    answerOk: records.filter(r => r.grade.answerOk).length,
    meanProgress: mean(records.map(r => r.grade.progressHop)),
    meanSurvival: mean(records.map(r => r.grade.hopsBeforeBreak)),
    meanHops: mean(records.map(r => r.grade.hopsExecuted)),
    goldHops: records[0]?.hops ?? null,
    meanHostTurns: mean(records.map(r => r.grade.hostTurns)),
    meanJevRequests: mean(records.map(r => r.grade.jevRequests)),
    p50JevMs: median(records.flatMap(r => r.grade.jevMs ?? [])),
    p90JevMs: percentile(records.flatMap(r => r.grade.jevMs ?? []), 90),
    p50TaskMs: median(records.map(r => r.grade.taskMs)),
    p50MsPerHop: median(records.map(r => r.grade.msPerHop)),
    breaks: histogram(records.filter(r => r.grade.break).map(r => r.grade.break.class)),
    breakCodes: histogram(records.filter(r => r.grade.break).map(r => r.grade.break.code)),
    firstBreaks: histogram(records.filter(r => r.grade.firstBreak).map(r => r.grade.firstBreak.class)),
    caps: {
      steps: records.filter(r => r.grade.caps.steps).length,
      maxActions: records.filter(r => r.grade.caps.maxActions).length,
      maxCalls: records.filter(r => r.grade.caps.maxCalls).length,
      maxMs: records.filter(r => r.grade.caps.maxMs).length,
      wait45: records.reduce((s, r) => s + r.grade.caps.wait45, 0),
      runTimeout: records.filter(r => r.grade.caps.runTimeout).length,
    },
    danger: records.reduce((s, r) => s + (r.grade.danger ?? 0), 0),
  };
}

export function summarizeLong(records, meta = {}) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.task}\u0000${r.condition}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const rows = [...groups].map(([key, rs]) => {
    const [task, condition] = key.split('\u0000');
    return { task, condition, family: rs[0].family, ...rollupLong(rs) };
  }).sort((a, b) => a.task.localeCompare(b.task) || a.condition.localeCompare(b.condition));
  const byCondition = {};
  for (const condition of [...new Set(records.map(r => r.condition))].sort()) {
    byCondition[condition] = rollupLong(records.filter(r => r.condition === condition));
  }
  return { ...meta, runs: records.length, byCondition, rows };
}

const cell = x => (x === null || x === undefined ? '-' : String(x));
const dist = h => Object.entries(h ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
const capsText = c => Object.entries(c).filter(([, v]) => v).map(([k, v]) => (v === true ? k : `${k} ${v}`)).join(', ');

/** The markdown table across tasks and conditions (summary.md and --report). */
export function reportMarkdown(summary, { title = 'Long-horizon corpus' } = {}) {
  const lines = [`# ${title}${summary.label ? ` (${summary.label})` : ''}`, ''];
  if (summary.provider) lines.push(`provider: ${summary.provider}; repeat ${cell(summary.repeat)}; ${summary.runs} runs.`, '');
  lines.push('| task | cond | runs | success | verified | answer | progress / gold | survival | hops exec | host turns | Jev req | Jev p50 ms | task p50 s | ms/hop | breaks | caps |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of summary.rows) {
    lines.push(`| ${r.task} | ${r.condition} | ${r.runs} | ${r.success} | ${r.verified} | ${r.answerOk} | ${cell(r.meanProgress)} / ${cell(r.goldHops)} | ${cell(r.meanSurvival)} | ${cell(r.meanHops)} | ${cell(r.meanHostTurns)} | ${cell(r.meanJevRequests)} | ${cell(r.p50JevMs)} | ${r.p50TaskMs === null ? '-' : (r.p50TaskMs / 1000).toFixed(1)} | ${cell(r.p50MsPerHop)} | ${dist(r.breaks) || '-'} | ${capsText(r.caps) || '-'} |`);
  }
  lines.push('', '| condition | runs | success | answer | mean progress | mean survival | host turns | Jev req | breaks | first-call breaks | break codes |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [condition, r] of Object.entries(summary.byCondition)) {
    lines.push(`| ${condition} | ${r.runs} | ${r.success} | ${r.answerOk} | ${cell(r.meanProgress)} | ${cell(r.meanSurvival)} | ${cell(r.meanHostTurns)} | ${cell(r.meanJevRequests)} | ${dist(r.breaks) || '-'} | ${dist(r.firstBreaks) || '-'} | ${dist(r.breakCodes) || '-'} |`);
  }
  lines.push('', 'progress = gold-path hop of the last route mark reached (mean); survival = the same, counted only up to the end of the first call that was not completed and verified; hops exec = page actions executed (wrong turns included); host turns = run/act calls plus fai_browser_wait turns for calls over the 45 s MCP window.');
  return `${lines.join('\n')}\n`;
}

// ------------------------------------------------------------------------------------------------- oracle

/**
 * Walk a task's gold path with plain Playwright (no extension): open start, apply oracle.actions (click, fill with the
 * supplied value, select), and after each action check the route marks that land on that hop. Returns
 * {ok, missing, marks, text, url} where `text` is the final page text and `missing` lists unmet marks and
 * oracle.text strings. A mark not met right away is polled for up to `markWaitMs` (delayed re-renders).
 * `collect(page, hop)` is called after every action (for ground-truth checks).
 */
export async function runLongOracle(context, task, origin, { timeoutMs = 8000, markWaitMs = 4000, collect = null } = {}) {
  const t = materialize(task, origin);
  const page = await context.newPage();
  const missing = [];
  const marks = [];
  try {
    await page.goto(t.start, { waitUntil: 'load', timeout: timeoutMs });
    if (collect) await collect(page, 0);
    for (const [index, action] of t.oracle.actions.entries()) {
      const hop = index + 1;
      if (action.click) {
        await Promise.all([page.waitForLoadState('load').catch(() => {}), page.locator(action.click).first().click({ timeout: timeoutMs })]);
      } else if (action.fill) await page.fill(action.fill[0], t.suppliedText[action.fill[1]], { timeout: timeoutMs });
      else if (action.select) await page.selectOption(action.select[0], action.select[1], { timeout: timeoutMs });
      await page.waitForLoadState('load').catch(() => {});
      for (const mark of t.route.filter(m => m.hop === hop)) {
        // A page that re-renders after a delay (fixtures/long/flights-live: a date change lands 1.5 s after the
        // click) meets its mark late: poll for up to markWaitMs.
        const look = async () => ({ url: page.url(), text: `${await page.title()}\n${await page.innerText('body')}` });
        let observation = await look();
        for (const until = Date.now() + markWaitMs; !markMatches(mark, observation) && Date.now() < until;) {
          await page.waitForTimeout(100);
          observation = await look();
        }
        const hit = markMatches(mark, observation);
        marks.push({ hop, hit });
        if (!hit) missing.push(`route hop ${hop}: ${mark.path ?? mark.text}`);
      }
      if (collect) await collect(page, hop);
    }
    const text = (await page.innerText('body')).replace(/\s+/g, ' ');
    for (const want of t.oracle.text) if (!text.includes(want)) missing.push(`text: ${want}`);
    return { ok: missing.length === 0, missing, marks, text, url: page.url() };
  } finally {
    await page.close().catch(() => {});
  }
}
