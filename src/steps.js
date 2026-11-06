// Step lists: several verified hops in one run call (`steps: [{instruction, expectation, answerQuestion?,
// maxActions?}]`, docs/REFERENCE.md "Step lists"). The runtime runs them in order in the same tab, lease, level,
// grant, guardrails and budgets, and stops at the first step that is not completed and verified. This module holds
// what every entry point shares: validation (MCP, daemon, CLI and runtime refuse the same lists) and the placeholder
// rule. A later step may write `{{answer:N}}` (N = an earlier step, 1-based) in its instruction, answerQuestion or an
// expectation text field; it is filled only from step N's auto-confirmed `verdict.answer` (at read-only and reversible
// also from a clearly leading likely answer, likelyValue), never from other page text, and the list stops before the
// step when that answer is missing or unfit (code placeholder_unconfirmed).
import { autoConfirm } from './digest.js';
import { validateExpectation } from './expectation.js';
import { commitIntent } from './oversight.js';

export const MAX_STEPS = 15;
export const STEP_KEYS = Object.freeze(['instruction', 'expectation', 'answerQuestion', 'maxActions']);
export const STEP_MAX_ACTIONS = 30;
export const STEP_DEFAULT_ACTIONS = 8;
// A list's total action budget: by default its steps' maxActions summed, at most LIST_DEFAULT_ACTIONS; a caller's
// explicit maxActions may raise it to LIST_MAX_ACTIONS. Each step keeps its own maxActions inside it.
export const LIST_DEFAULT_ACTIONS = 60;
export const LIST_MAX_ACTIONS = 120;
// One run without steps (MCP maxActions); the daemon, CLI and SDK accept up to 100 as before.
export const RUN_MAX_ACTIONS = 60;
// A list's default time budget: 45 s, plus room for long lists of fast hops (6 s per step), at most 120 s (the MCP
// request budget). The MCP call window (45 s) does not end it: the run continues and fai_browser_wait follows it.
export const LIST_TIMEOUT_MS = 45_000;
export const LIST_STEP_TIMEOUT_MS = 6_000;
export const LIST_MAX_TIMEOUT_MS = 120_000;

/** The default action budget of a validated step list (each step's maxActions, default 8, summed; at most 60). */
export function listActionBudget(steps) {
  return Math.min(LIST_DEFAULT_ACTIONS, steps.reduce((sum, step) => sum + (step.maxActions ?? STEP_DEFAULT_ACTIONS), 0));
}

/** The default time budget of a list of `count` steps. */
export function listTimeoutMs(count) {
  return Math.min(LIST_MAX_TIMEOUT_MS, Math.max(LIST_TIMEOUT_MS, count * LIST_STEP_TIMEOUT_MS));
}
// A filled value is a short page value (a name, a price, a version), never a paragraph.
export const PLACEHOLDER_MAX_CHARS = 120;
// instruction and steps together: the steps are the task and the instruction is kept as its summary (hosts write an
// overall instruction next to the steps on the first call). It is never sent to the provider: each step's own
// instruction is. It names the task on the approval card and leads the trace's numbered instruction (listInstruction).
export const SUMMARY_MAX = 4000;

/** A summary instruction sent with steps, checked (a non-empty string of at most 4000 characters) or undefined. */
export function checkSummary(instruction, path = 'instruction') {
  if (instruction === undefined || instruction === null) return undefined;
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > SUMMARY_MAX) {
    throw new TypeError(`${path} with steps is the task summary: a non-empty string of at most ${SUMMARY_MAX} characters `
      + '(or leave it out; each step has its own instruction)');
  }
  return instruction.trim();
}

/** The trace's `instruction` for a step list: the summary (when given), then the steps' instructions, numbered. */
export function listInstruction(steps, summary) {
  const numbered = steps.map((step, index) => `${index + 1}. ${step.instruction}`).join(' ');
  return summary ? `${summary} Steps: ${numbered}` : numbered;
}
const INSTRUCTION_MAX = 4000;
const QUESTION_MAX = 2000;
// Expectation fields a placeholder may appear in: positive text checks only. urlMatches is a regex (page text is never
// compiled into one); urlEquals and textAbsent would let a page value decide what passes. Every step also keeps at
// least one field without a placeholder, and a filled value must have EXPECTATION_FILL_MIN_CHARS characters.
const PLACEHOLDER_FIELDS = new Set(['urlIncludes', 'textIncludes', 'titleEquals', 'titleIncludes']);
export const EXPECTATION_FILL_MIN_CHARS = 3;
const PLACEHOLDER = /\{\{\s*answer\s*:\s*(\d+)\s*\}\}/g;
// A placeholder the host wrapped in quotes: the quotes are replaced by FAI's own (see quoteValue).
const QUOTED_PLACEHOLDER = /(["'“‘«])\{\{\s*answer\s*:\s*(\d+)\s*\}\}(["'”’»])|\{\{\s*answer\s*:\s*(\d+)\s*\}\}/g;
const BRACES = /\{\{|\}\}/;
// Room a filled value may take in an instruction or question: the value at its longest, every quote escaped, quoted.
const FILL_ROOM = 2 * PLACEHOLDER_MAX_CHARS + 2;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** The step numbers (1-based) a text refers to with `{{answer:N}}`, in order of appearance. */
export function placeholdersIn(text) {
  return [...String(text ?? '').matchAll(PLACEHOLDER)].map(match => Number(match[1]));
}

/** Every placeholder of a step, with where it is (`instruction`, `answerQuestion` or `expectation.<field>`). */
export function stepPlaceholders(step) {
  const found = [];
  for (const n of placeholdersIn(step.instruction)) found.push({ n, where: 'instruction' });
  for (const n of placeholdersIn(step.answerQuestion)) found.push({ n, where: 'answerQuestion' });
  for (const [field, value] of Object.entries(step.expectation ?? {})) {
    if (typeof value === 'string') for (const n of placeholdersIn(value)) found.push({ n, where: `expectation.${field}` });
  }
  return found;
}

function checkText(value, path, max, { required }) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${path} must be a non-empty string`);
  if (value.length > max) throw new TypeError(`${path} must be at most ${max} characters`);
  // A misspelt placeholder (or a {{supply:N}} from a receipt's next.steps that the host did not replace) would otherwise
  // reach the provider as literal text.
  if (BRACES.test(value.replace(PLACEHOLDER, ''))) {
    throw new TypeError(`${path} has a placeholder FAI cannot fill; write {{answer:N}} with N an earlier step number, `
      + 'and replace {{supply:N}} with the value yourself');
  }
  return value;
}

/**
 * Validate a step list and return a normalized copy (`[{instruction, expectation, answerQuestion?, maxActions?}]`).
 * Throws a TypeError naming the first problem (`steps[1].expectation is required`). Every step needs a declarative
 * expectation: each hop is verified like a single run. Placeholders must name an earlier step that has an
 * answerQuestion (otherwise no answer could ever fill them).
 */
export function validateSteps(steps, { path = 'steps', maxActions = STEP_MAX_ACTIONS } = {}) {
  if (!Array.isArray(steps)) throw new TypeError(`${path} must be an array of steps`);
  if (!steps.length || steps.length > MAX_STEPS) throw new TypeError(`${path} must have 1 to ${MAX_STEPS} steps`);
  const out = [];
  for (const [index, raw] of steps.entries()) {
    const at = `${path}[${index}]`;
    if (!isPlainObject(raw)) throw new TypeError(`${at} must be an object`);
    for (const key of Object.keys(raw)) {
      if (!STEP_KEYS.includes(key)) {
        const safe = /^[A-Za-z0-9_]{1,32}$/.test(key) ? key : 'unsupported';
        throw new TypeError(`${at}.${safe} is not a step field (${STEP_KEYS.join(', ')})`);
      }
    }
    const step = { instruction: checkText(raw.instruction, `${at}.instruction`, INSTRUCTION_MAX, { required: true }) };
    if (raw.expectation === undefined || raw.expectation === null) {
      throw new TypeError(`${at}.expectation is required: each step is verified like a single run`);
    }
    if (!isPlainObject(raw.expectation)) throw new TypeError(`${at}.expectation must be an object`);
    try {
      validateExpectation(raw.expectation);
    } catch (error) {
      throw new TypeError(`${at}.${error.message}`);
    }
    for (const [field, value] of Object.entries(raw.expectation)) {
      if (typeof value !== 'string') continue;
      if (field === 'urlMatches' && /\{\{/.test(value)) {
        throw new TypeError(`${at}.expectation.urlMatches cannot hold a placeholder; use urlIncludes`);
      }
      checkText(value, `${at}.expectation.${field}`, INSTRUCTION_MAX, { required: true });
    }
    if (Object.values(raw.expectation).every(value => typeof value === 'string' && placeholdersIn(value).length)) {
      throw new TypeError(`${at}.expectation needs a field without a placeholder (the page path or text that proves the `
        + 'step), so a page value never chooses its own check');
    }
    step.expectation = { ...raw.expectation };
    const question = checkText(raw.answerQuestion, `${at}.answerQuestion`, QUESTION_MAX, { required: false });
    if (question !== undefined) step.answerQuestion = question;
    if (raw.maxActions !== undefined) {
      if (!Number.isInteger(raw.maxActions) || raw.maxActions < 1 || raw.maxActions > maxActions) {
        throw new TypeError(`${at}.maxActions must be an integer from 1 to ${maxActions}`);
      }
      step.maxActions = raw.maxActions;
    }
    for (const [field, max] of [['instruction', INSTRUCTION_MAX], ['answerQuestion', QUESTION_MAX]]) {
      const text = step[field];
      const count = placeholdersIn(text).length;
      if (count && text.replace(PLACEHOLDER, '').length + count * FILL_ROOM > max) {
        throw new TypeError(`${at}.${field} leaves no room for its filled values (at most ${max} characters with each `
          + `placeholder counted as ${FILL_ROOM})`);
      }
    }
    for (const { n, where } of stepPlaceholders(step)) {
      if (where.startsWith('expectation.') && !PLACEHOLDER_FIELDS.has(where.slice('expectation.'.length))) {
        throw new TypeError(`${at}.${where} cannot hold a placeholder`);
      }
      if (!(n >= 1 && n <= index)) {
        throw new TypeError(`${at}.${where} uses {{answer:${n}}}; a placeholder can only name an earlier step (1 to ${index})`);
      }
      if (!out[n - 1].answerQuestion) {
        throw new TypeError(`${at}.${where} uses {{answer:${n}}}, but step ${n} has no answerQuestion to answer it`);
      }
    }
    out.push(step);
  }
  return out;
}

function sameExpectation(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

/**
 * A step list with the call's top-level `expectation` and `answerQuestion` folded in (hosts send an expectation on
 * every run, so one arrives next to `steps`): the last step takes them when it has none; an identical one is a no-op;
 * a different expectation becomes `finalExpectation`, checked on the final page once every step passed (a whole-call
 * check, never a reason to refuse the list); a different question is ignored with a warning (the step's own is the
 * one asked). Returns `{steps, finalExpectation?, warnings}` with the steps validated (validateSteps); throws a
 * TypeError naming the problem. Idempotent: the daemon folds the list, the runtime folds it again.
 */
export function foldTopLevel(steps, { expectation, answerQuestion: question, ...options } = {}) {
  const answerQuestion = question === null ? undefined : question;
  const warnings = [];
  let finalExpectation;
  let list = steps;
  const hasExpectation = expectation !== undefined && expectation !== null;
  if (hasExpectation || answerQuestion !== undefined) {
    if (!Array.isArray(steps) || !steps.length) return { steps: validateSteps(steps, options), warnings };
    const last = isPlainObject(steps.at(-1)) ? { ...steps.at(-1) } : steps.at(-1);
    list = [...steps.slice(0, -1), last];
    if (hasExpectation && isPlainObject(last)) {
      if (!isPlainObject(expectation)) throw new TypeError('expectation must be an object');
      validateExpectation(expectation);
      if (last.expectation === undefined || last.expectation === null) last.expectation = { ...expectation };
      else if (!isPlainObject(last.expectation) || !sameExpectation(last.expectation, expectation)) {
        for (const [field, value] of Object.entries(expectation)) {
          if (typeof value === 'string' && /\{\{|\}\}/.test(value)) {
            throw new TypeError(`expectation.${field} cannot hold a placeholder at the top level; put it in the last step`);
          }
        }
        finalExpectation = { ...expectation };
      }
    }
    if (answerQuestion !== undefined && isPlainObject(last)) {
      if (last.answerQuestion === undefined) last.answerQuestion = answerQuestion;
      else if (last.answerQuestion !== answerQuestion) {
        warnings.push(`answer_question_ignored: steps[${steps.length - 1}] has its own answerQuestion, which was asked instead`);
      }
    }
  }
  const out = { steps: validateSteps(list, options), warnings };
  if (finalExpectation) out.finalExpectation = finalExpectation;
  return out;
}

/**
 * The value `{{answer:N}}` may take from step N's (runtime) result, or `{why}` when it may not: only an auto-confirmed
 * `verdict.answer` of a completed, verified step, cut to the value (`exact` not false), short, on one line, without
 * control or format characters or braces, on a page the injection guard did not flag, and not itself a command
 * (commitIntent). Page text never reaches a placeholder any other way.
 */
export function placeholderValue(result) {
  if (!result || result.status !== 'completed' || result.verification?.passed !== true) return { why: 'step_not_verified' };
  const answer = result.verdict?.answer;
  if (!answer || typeof answer.text !== 'string') return { why: 'answer_not_confirmed' };
  if (answer.exact === false) return { why: 'answer_whole_line' };
  if ((result.verdict.why ?? []).some(code => String(code).startsWith('guard:injection'))) return { why: 'answer_injection' };
  const value = answer.text.replace(/\s+/g, ' ').trim().replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim();
  if (!value) return { why: 'answer_empty' };
  if (value.length > PLACEHOLDER_MAX_CHARS) return { why: 'answer_too_long' };
  if (CONTROL.test(answer.text) || /[{}\\]/.test(value)) return { why: 'answer_characters' };
  if (commitIntent(value)) return { why: 'answer_command' };
  return { value };
}

// Levels at which a placeholder may fill from a likely (not auto-confirmed) answer: nothing irreversible can follow.
export const LIKELY_LEVELS = new Set(['read-only', 'reversible']);
// A lone candidate has no runner-up, so the margin says nothing: once the provider ranked it (src/runtime.js
// rankSingle) it needs at least this confidence on top of the shape check.
export const LIKELY_SINGLE_FLOOR = 0.6;

/**
 * The value `{{answer:N}}` may take from step N's likely answer when its answer was not auto-confirmed: only at
 * read-only and reversible (`level`), only from candidates the provider ranked (a lone candidate counts only once
 * src/runtime.js rankSingle had the provider rank it; an unranked heuristic share never fills), with the auto-confirm rule run at `thresholds.placeholderFloor` (default 0.35)
 * and `placeholderMargin` (0.15) instead of answerConfirm and answerMargin: the intent's shape, never a list, Nth or
 * late-load question, never loading text, the value cut from its block. Not on a page scored blocked or still
 * loading, nor for a join task without a trail line. Then every check of placeholderValue (verified step, exact
 * value, injection guard, length, characters, command). Returns `{value, likely: true}` or `{why}`.
 */
export function likelyValue(result, { question = '', instruction = '', level, thresholds = {} } = {}) {
  const none = { why: 'answer_not_confirmed' };
  if (!LIKELY_LEVELS.has(level) || !String(question).trim()) return none;
  const answer = result?.answer;
  const candidates = Array.isArray(answer?.candidates) ? answer.candidates : [];
  if (answer?.method !== 'provider' || !candidates.length) return none;
  const why = result.verdict?.why ?? [];
  if (why.includes('guard:blocked_page') || why.includes('content_loading')
    || (why.includes('join_task') && !result.trail?.length)) return none;
  const floor = thresholds.placeholderFloor ?? 0.35;
  const single = candidates.length === 1;
  const floors = { answerConfirm: single ? Math.max(floor, LIKELY_SINGLE_FLOOR) : floor,
    answerMargin: thresholds.placeholderMargin ?? 0.15 };
  const likely = autoConfirm({ ...answer, method: 'provider' }, { question, instruction, thresholds: floors }).answer;
  if (!likely) return none;
  const checked = placeholderValue({ ...result, verdict: { ...result.verdict, answer: likely } });
  return checked.value === undefined ? checked : { value: checked.value, likely: true };
}

/** A value as FAI writes it into an instruction or question: in ASCII double quotes, every embedded quote escaped. */
export function quoteValue(value) {
  return `"${String(value).replace(/["“”]/g, '\\"')}"`;
}

/**
 * Replace the placeholders of one text. `resolve(n)` returns `{value}` (written in: quoted in an instruction or
 * question, bare in an expectation field) or `{raw}` (put back as is, keeping a quote pair the host wrote around it).
 */
function substitute(text, resolve, { quote }) {
  if (!quote) {
    return text.replace(PLACEHOLDER, (match, n) => {
      const out = resolve(Number(n));
      return out.raw ?? out.value;
    });
  }
  return text.replace(QUOTED_PLACEHOLDER, (match, open, quotedN, close, plainN) => {
    const out = resolve(Number(quotedN ?? plainN));
    if (out.raw !== undefined) return open ? `${open}${out.raw}${close}` : out.raw;
    return quoteValue(out.value);
  });
}

function fillAll(step, resolve, resolveExpectation = resolve) {
  const filled = { ...step, instruction: substitute(step.instruction, resolve, { quote: true }) };
  if (step.answerQuestion !== undefined) filled.answerQuestion = substitute(step.answerQuestion, resolve, { quote: true });
  filled.expectation = Object.fromEntries(Object.entries(step.expectation).map(([field, value]) => [
    field, typeof value === 'string' ? substitute(value, resolveExpectation, { quote: false }) : value,
  ]));
  return filled;
}

/**
 * The step with its placeholders filled from `values` (step number -> value from placeholderValue), or
 * `{missing: [{n, why}]}` when a placeholder has no value, a value is too short for an expectation field, the filled
 * text would be too long, or the filled instruction would ask for an irreversible action the step as written did not
 * ask for. Instruction and question get the value in ASCII double quotes with embedded quotes escaped (a quote pair
 * the host wrote around the placeholder is replaced); expectation fields get it bare.
 */
export function fillStep(step, values, reasons = new Map(), likely = new Map()) {
  const missing = [];
  const add = (n, why) => {
    if (!missing.some(entry => entry.n === n)) missing.push({ n, why });
  };
  // A likely value (likelyValue) fills only the instruction and question, never an expectation field: a check is
  // never built from a value FAI could not confirm.
  const text = n => values.get(n) ?? likely.get(n);
  const used = new Set();
  for (const { n, where } of stepPlaceholders(step)) {
    const inExpectation = where.startsWith('expectation.');
    const value = inExpectation ? values.get(n) : text(n);
    if (value === undefined) add(n, reasons.get(n) ?? 'answer_not_confirmed');
    else if (inExpectation && value.length < EXPECTATION_FILL_MIN_CHARS) add(n, 'answer_too_short');
    else if (!values.has(n)) used.add(n);
  }
  if (missing.length) return { missing };
  const filled = fillAll(step, n => ({ value: text(n) }), n => ({ value: values.get(n) }));
  if (filled.instruction.length > INSTRUCTION_MAX || (filled.answerQuestion?.length ?? 0) > QUESTION_MAX) {
    for (const { n } of stepPlaceholders(step)) add(n, 'filled_too_long');
    return { missing };
  }
  // Checked with the value unquoted as well: quotes would hide a command from commitIntent, not from the provider.
  const asked = commitIntent(step.instruction.replace(PLACEHOLDER, ' '));
  const bare = substitute(step.instruction, n => ({ value: text(n) }), { quote: false });
  if (commitIntent(filled.instruction) !== asked || commitIntent(bare) !== asked) {
    return { missing: stepPlaceholders(step).filter(({ where }) => where === 'instruction')
      .map(({ n }) => ({ n, why: 'answer_command' })) };
  }
  return { step: filled, likely: [...used] };
}

/**
 * The steps a host sends to continue a list that stopped at (0-based) `from`: steps from..end, renumbered so the list
 * stands on its own. A placeholder for a step inside it becomes `{{answer:<new number>}}`; one for a step that already
 * ran is written in from `values` as fillStep would, or becomes `{{supply:N}}` when FAI has no value it may write in
 * there (the host replaces it; validateSteps refuses it unreplaced). The host's next call validates the list again.
 */
export function carryForward(steps, from, values) {
  return steps.slice(from).map(step => {
    const inList = n => (n - 1 >= from ? { raw: `{{answer:${n - from}}}` } : null);
    let filled = fillAll(step, n => inList(n) ?? (values.has(n) ? { value: values.get(n) } : { raw: `{{supply:${n}}}` }));
    // The checks fillStep runs on a filled step: a value that turns the instruction into a command, or makes the
    // instruction or question too long, is never written in; the host supplies it instead.
    const asked = commitIntent(step.instruction.replace(PLACEHOLDER, ' '));
    const bare = substitute(step.instruction, n => inList(n) ?? (values.has(n) ? { value: values.get(n) } : { raw: ' ' }),
      { quote: false });
    if (commitIntent(filled.instruction) !== asked || commitIntent(bare) !== asked
      || filled.instruction.length > INSTRUCTION_MAX || (filled.answerQuestion?.length ?? 0) > QUESTION_MAX) {
      const supply = n => inList(n) ?? { raw: `{{supply:${n}}}` };
      filled = { ...filled, instruction: substitute(step.instruction, supply, { quote: true }) };
      if (step.answerQuestion !== undefined) filled.answerQuestion = substitute(step.answerQuestion, supply, { quote: true });
    }
    // An expectation field never takes a value too short to check: the host supplies one.
    for (const [field, value] of Object.entries(step.expectation)) {
      if (typeof value !== 'string') continue;
      if (placeholdersIn(value).some(n => n - 1 < from && values.has(n) && values.get(n).length < EXPECTATION_FILL_MIN_CHARS)) {
        filled.expectation[field] = substitute(value, n => inList(n)
          ?? (values.has(n) && values.get(n).length >= EXPECTATION_FILL_MIN_CHARS ? { value: values.get(n) } : { raw: `{{supply:${n}}}` }),
        { quote: false });
      }
    }
    return filled;
  });
}

/**
 * The call's own top-level expectation (foldTopLevel finalExpectation) carried into a resend list: merged into its last
 * step when no field conflicts (`{steps}`), else left out of the steps and returned for the host to send next to them
 * (`{steps, expectation}`), so resending next.steps never drops the call's check.
 */
export function carryExpectation(steps, finalExpectation) {
  if (!finalExpectation || !steps?.length) return { steps };
  const last = steps.at(-1);
  const conflict = Object.entries(finalExpectation).some(([field, value]) => field in last.expectation
    && last.expectation[field] !== value);
  if (conflict) return { steps, expectation: { ...finalExpectation } };
  return { steps: [...steps.slice(0, -1), { ...last, expectation: { ...last.expectation, ...finalExpectation } }] };
}
