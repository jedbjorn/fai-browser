// Agent-facing result schema (docs/design/PROPOSAL.md section 5) and the mapping from error codes to outcomes.
//
// Page-derived text only ever appears under `page`, `answer.candidates[].text`, `trail[]`, `steps[].observation`,
// `steps[].action.label`. `reason` and `needs.message`
// are written by the runtime and never contain page text, so a host can treat them as trusted.
//
// Two shapes: the full in-memory runtime result (createResult, written to trace.json by writeRun) and the lean
// agent result (agentResult) that CLI stdout and toAgentResult return and MCP summarizes as readable text. The lean result has
// no per-step observations, screenshots, probabilities or control bounds; they stay in the trace.
import { buildDigest, recordsOf, scoreBlocks } from './digest.js';
import { ratingValue } from './facts.js';
import { siteRoot } from './origins.js';
import { LEVEL_NAMES } from './oversight.js';
import { capOffer, relevanceHints } from './relevance.js';
import { withResumeWait } from './resume.js';

export const RESULT_VERSION = 2;

export const STATUSES = [
  'completed',
  'unverified',
  'checkpoint',
  'budget_exhausted',
  'needs_user',
  'needs_host',
  'stopped',
  'failed',
];

// Bridge error codes that the runtime handles by re-observing and asking for a new decision.
export const RECOVERABLE_CODES = new Set(['stale', 'target_unavailable', 'capture_failed']);

export const PAGE_TEXT_LIMIT = 600;
const STEP_TEXT_LIMIT = 500;

/** Statuses whose results carry ranked answer candidates. */
export const ANSWER_STATUSES = new Set(['completed', 'unverified', 'checkpoint']);
export const MAX_ANSWER_CANDIDATES = 5;

/** Create an Error carrying the bridge/runtime error shape `{ code, recoverable }`. */
export function bridgeError(code, message, recoverable = RECOVERABLE_CODES.has(code)) {
  const error = new Error(message || code);
  error.code = code;
  error.recoverable = recoverable;
  return error;
}

// What a host does after line_break_input (needs.message and the trusted next text).
const LINE_BREAK_TEXT = "Newlines can't be typed into a single-line field. Fill without the line break, then use "
  + 'submit_field (or the submit option) to submit.';

// Outcome for each machine code. `message` tells the host what to do next and never includes page content.
const OUTCOMES = {
  // Terminal outcomes chosen by the runtime itself.
  expectation_passed: {
    status: 'completed',
    who: 'none',
    reason: 'Expectation passed on the settled page',
    message: '',
  },
  expectation_failed: {
    status: 'unverified',
    who: 'host',
    reason: 'The expectation did not pass on the page the act landed on',
    message: 'Inspect the page evidence and decide whether to continue.',
  },
  step_complete: {
    status: 'checkpoint',
    who: 'host',
    reason: 'One action executed; no expectation passed yet',
    message: 'Observe the page and choose the next action.',
  },
  task_budget: {
    status: 'budget_exhausted',
    who: 'host',
    reason: 'The call budget for this tab request is used up',
    message: 'Report the best answer you have from the last result; do not call FAI Browser again for this task.',
  },
  time_budget: {
    status: 'budget_exhausted',
    who: 'host',
    reason: 'Time budget reached',
    message: 'Inspect the evidence; raise timeoutMs or narrow the instruction.',
  },
  // A fill the field did not keep (extension/page.js fillKept): the page reverted or ignored the typed value.
  fill_not_kept: {
    status: 'needs_host',
    who: 'host',
    reason: 'The field did not keep the supplied value: the page reverted or ignored the typed text',
    message: 'Typing into this field does not work on this page. Do not fill it again; set the value another way: a '
      + 'URL in allowedUrls that carries it, or the page\'s own picker or control.',
  },
  // A fill whose text has a line break, aimed at a single-line input (extension/page.js refuseLineBreak): Enter there
  // would submit the form past the submit gate, so nothing was typed.
  line_break_input: {
    status: 'needs_host',
    who: 'host',
    reason: 'A line break cannot be typed into a single-line field',
    message: LINE_BREAK_TEXT,
  },
  unsupported: {
    status: 'needs_host',
    who: 'host',
    reason: 'The browser cannot perform this action',
    message: 'Choose a different approach or ask the user to perform the action.',
  },
  stale: {
    status: 'needs_host',
    who: 'host',
    reason: 'The page changed before the action could run',
    message: 'Observe the page again and choose a fresh action.',
  },
  target_unavailable: {
    status: 'needs_host',
    who: 'host',
    reason: 'The chosen control is no longer available',
    message: 'Observe the page again and choose a fresh action.',
  },
  capture_failed: {
    status: 'needs_host',
    who: 'host',
    reason: 'The browser could not capture evidence',
    message: 'Observe the page again; ask the user to keep the selected tab visible.',
  },
  // Point clicks (act with a point instead of an actionId).
  no_control: {
    status: 'needs_host',
    who: 'host',
    reason: 'No clickable control is at that point',
    message: 'Nothing clickable is at that point (an overlay, text or an element this page script cannot drive). '
      + 'Use an offered actionId, or a point on a visible control.',
  },
  point_outside: {
    status: 'needs_host',
    who: 'host',
    reason: 'The point is outside the screenshot or the viewport',
    message: 'The point is off the image. Coordinates are pixels of the screenshot of that revision (see image: '
      + 'width and height); observe again with returnImages "final" and pick a point inside it.',
  },
  js_dialog: {
    status: 'needs_user',
    who: 'user',
    reason: 'The page shows a JavaScript dialog (alert, confirm or prompt) and stopped answering',
    message: 'The page stopped answering, most likely because it shows a JavaScript dialog (alert, confirm or prompt). '
      + 'Below Test site FAI Browser never answers one: ask the user to answer it in the tab, then observe again.',
  },
  point_frame: {
    status: 'needs_host',
    who: 'host',
    reason: 'The point is inside a frame the page script cannot read (another origin)',
    message: 'That point is inside a frame from another origin, which FAI Browser never drives. Use an offered '
      + 'actionId, or ask the user to handle it in the tab.',
  },
  // User-side outcomes.
  stopped: {
    status: 'stopped',
    who: 'none',
    reason: 'Stopped by user',
    message: 'The user pressed Stop. Do not retry without asking.',
  },
  cancelled: {
    status: 'stopped',
    who: 'none',
    reason: 'Cancelled by caller',
    message: '',
  },
  // The user denied the tab request (issue #36): their answer, not a technical end.
  denied: {
    status: 'stopped',
    who: 'none',
    reason: 'Denied by the user',
    message: 'The user denied this tab request. Do not ask again unless the user asks you to.',
  },
  paused: {
    status: 'needs_user',
    who: 'user',
    reason: 'Paused by user',
    message: 'The user paused the run. Ask them to finish what they are doing, then observe again with the same requestId.',
  },
  cross_origin: {
    status: 'needs_user',
    who: 'user',
    reason: 'The page or action leads to an origin that is not approved',
    message: 'Ask the user to handle the tab or approve the origin, then observe again with the same requestId.',
  },
  blocked: {
    status: 'needs_user',
    who: 'user',
    reason: 'The page is a login wall, captcha, paywall or consent-only page',
    message: 'The page blocks the task (sign-in, captcha, paywall or a consent page). FAI Browser never signs in or '
      + 'solves captchas: ask the user to clear it in the tab themselves, then observe again with the requestId.',
  },
  login: {
    status: 'needs_user',
    who: 'user',
    reason: 'The page asks the user to sign in',
    message: 'The page asks the user to sign in. FAI Browser never logs in: ask the user to sign in in the tab '
      + 'themselves, then observe again with the requestId.',
  },
  child_tab: {
    status: 'needs_user',
    who: 'user',
    reason: 'The action opened a new tab',
    message: 'Ask the user to handle the new tab and select a tab again before you observe again.',
  },
  tab_changed: {
    status: 'needs_user',
    who: 'user',
    reason: 'The selected tab is no longer active',
    message: 'Ask the user to return to the selected tab or select a tab again.',
  },
  origin_changed: {
    status: 'needs_user',
    who: 'user',
    reason: 'The selected tab left the approved origin',
    message: 'Ask the user to return to an approved page and select the tab again.',
  },
  session_inactive: {
    status: 'needs_user',
    who: 'user',
    reason: 'No active browser tab lease',
    message: 'Ask the user to click "Select tab and start" in the extension, then observe again.',
  },
  disconnected: {
    status: 'needs_user',
    who: 'user',
    reason: 'The browser extension is disconnected',
    message: 'Ask the user to check the extension connection and select the tab again.',
  },
  refused_action: {
    status: 'needs_user',
    who: 'user',
    reason: 'The task asks for a purchase, deletion, message, submission or sign-in that the approved level does not '
      + 'allow',
    message: 'FAI never purchases, deletes, sends or logs in. Tell the user what to do in the tab.',
  },
  // The Approve gate: the action waits for the user's Approve click in the FAI Browser window (the same act again,
  // with the same actionId and revision, runs it once approved; the request waits five minutes).
  approval_pending: {
    status: 'needs_user',
    who: 'user',
    reason: 'The action waits for the user to approve it in the FAI Browser window',
    message: 'This action needs the user\'s approval: ask them to click Approve once on it in the FAI Browser window.',
  },
  blocked_risky: {
    status: 'needs_user',
    who: 'user',
    reason: 'The page script classified the control as a submission or account change',
    message: 'Ask the user to perform this action themselves.',
  },
  // Daemon tab-request outcomes (Phase 2).
  // A command reached the browser while it was still switching to this request's tab (an approval finishing): nothing
  // ran, the request is active.
  tab_not_ready: {
    status: 'needs_host',
    who: 'host',
    reason: 'The browser was still switching to this tab',
    message: 'Nothing ran: the browser was still switching to this tab. Observe again with the same requestId.',
  },
  // The agent asked for more on an approved request (fai_browser_open with its requestId): a level or an origin.
  ask_pending: {
    status: 'needs_user',
    who: 'user',
    reason: 'The user has not approved the added level or site yet',
    message: 'Ask the user to approve it on this task in the FAI Browser window (it is preselected). The task keeps '
      + 'its tab and page.',
  },
  ask_declined: {
    status: 'needs_user',
    who: 'user',
    reason: 'The user declined the added level or site',
    message: 'The user declined it. Continue at the granted level, or tell the user what is left for them to do.',
  },
  select_tab: {
    status: 'needs_user',
    who: 'user',
    reason: 'No tab has been selected for this request yet',
    message: 'Not approved yet. Ask the user to click Open on the request in the FAI Browser window, then '
      + 'Approve in the page request modal (grant browser site access if asked), or use the FAI Browser toolbar icon.',
  },
  request_closed: {
    status: 'needs_host',
    who: 'host',
    reason: 'The tab request has ended',
    message: 'This tab request has ended. Request a tab again only if the user still wants this.',
  },
  interrupted: {
    status: 'stopped',
    who: 'host',
    reason: 'Interrupted because the FAI Browser daemon shut down',
    message: 'The daemon stopped during the run. Request a tab again if the task is still needed.',
  },
  // Failures.
  error_page: {
    status: 'failed',
    who: 'host',
    reason: 'The page is an HTTP error page',
    message: 'The page or link is broken (an HTTP error page). Report that to the user; do not retry the same link.',
  },
  timeout: {
    status: 'failed',
    who: 'host',
    reason: 'A browser command timed out',
    message: 'Check that the extension is connected and the tab is responsive.',
  },
  invalid_observation: {
    status: 'failed',
    who: 'host',
    reason: 'The bridge returned an invalid observation',
    message: 'Check the browser extension version.',
  },
  config: {
    status: 'failed',
    who: 'user',
    reason: 'FAI Browser is not configured',
    message: 'Ask the user to run npm run setup in the fai-browser directory. Never ask for keys in chat.',
  },
  failed: {
    status: 'failed',
    who: 'host',
    reason: 'Runtime failure',
    message: 'See the error detail in reason.',
  },
};

// Each pause says what paused it (issue #31): never "stopped" or "released", which only the user's Stop is.
const RESUME_HINT = 'Ask the user to click Resume on this task in FAI Browser; next says how to continue.';

/**
 * `needs.message` overrides the daemon applies to results of runs on a tab request (design section 2.3). These are
 * runtime-written and trusted; they tell the agent how to continue with the lease.
 */
export const LEASE_MESSAGES = Object.freeze({
  paused: 'The user paused the tab. Ask them to click Resume in the FAI Browser extension when the task may continue; '
    + 'next says how to continue once they do.',
  tab_changed: `Paused: another tab came to the front in the task tab's window, or the task tab closed. ${RESUME_HINT}`,
  origin_changed: `Paused: the tab left the approved sites. ${RESUME_HINT}`,
  child_tab: `Paused: the page opened a tab or window this task cannot follow. ${RESUME_HINT}`,
  session_inactive: `Paused: the browser extension restarted. ${RESUME_HINT}`,
  disconnected: `Paused: the browser extension lost its connection. ${RESUME_HINT}`,
  stopped: 'The user pressed Stop and released the tab. Do not retry without asking.',
  select_tab: OUTCOMES.select_tab.message,
  request_closed: OUTCOMES.request_closed.message,
});

/** Apply the lease message override for the result's code, if any. Returns the result. */
export function applyLeaseMessage(result) {
  if (result && Object.hasOwn(LEASE_MESSAGES, result.code)) {
    result.needs = { ...result.needs, message: LEASE_MESSAGES[result.code] };
  }
  return result;
}

/** True when the code has a defined outcome (bridge or runtime code). */
export function isKnownCode(code) {
  return typeof code === 'string' && Object.hasOwn(OUTCOMES, code);
}

/** Look up the outcome for a code; unknown codes are failures. */
export function outcomeFor(code) {
  return OUTCOMES[code] ?? { ...OUTCOMES.failed, reason: `Browser error (${code})` };
}

/**
 * Write the outcome fields onto a result. `detail` is appended to the reason; callers must only pass
 * runtime-generated strings, never page text.
 */
export function setOutcome(result, code, detail) {
  const outcome = outcomeFor(code);
  result.status = outcome.status;
  result.code = code;
  result.reason = detail ? `${outcome.reason}: ${detail}` : outcome.reason;
  result.needs = { who: outcome.who, message: outcome.message };
  return result;
}

/**
 * A lean v1 result (see agentResult) for an outcome decided without running anything (no tab selected, request
 * closed, configuration missing). `trace` is null. `lease`, when given, is `{requestId, state}`. `approval` (a
 * select_tab outcome) is how the user approves the request (see approvalSteps) and words needs.message.
 */
export function outcomeResult(code, { runId = null, expectation = null, detail, lease, permissions,
  approval = null } = {}) {
  const result = createResult({ runId, expectation });
  setOutcome(result, code, detail);
  if (permissions) result.permissions = permissions;
  applyLeaseMessage(result);
  if (code === 'select_tab' && approval) {
    result.needs.message = selectTabMessage(approval);
    // Non-enumerable (not part of the serialized result): the next text is worded by it too (agentResult).
    Object.defineProperty(result, 'approval', { value: approval, enumerable: false, configurable: true });
  }
  result.trace = null;
  if (lease) result.lease = { requestId: lease.requestId, state: lease.state };
  return agentResult(result);
}

export function createResult({ runId, expectation }) {
  const result = {
    v: RESULT_VERSION,
    runId,
    status: 'failed',
    reason: '',
    code: 'failed',
    needs: { who: 'host', message: '' },
    verification: { checked: false, passed: false, expectation },
    page: null,
    answer: emptyAnswer(),
    steps: [],
    cost: { decisions: 0, inputTokens: 0, outputTokens: 0, elapsedMs: 0 },
  };
  // Non-enumerable diagnostics, omitted from JSON so the serialized result stays lean; writeRun puts them in the
  // trace. `observation` is the last full (uncompacted) observation; `answerDetail` records how the answer was
  // ranked (the heuristic's candidates and scores).
  Object.defineProperty(result, 'observation', { value: undefined, writable: true, enumerable: false });
  Object.defineProperty(result, 'answerDetail', { value: undefined, writable: true, enumerable: false });
  return result;
}

/** What a redacted secret reads as in receipts and traces. */
export const REDACTED = '[redacted]';
/** Secrets shorter than this are not searched for in page text (a two-letter value would blank ordinary words). */
export const SECRET_MIN_LENGTH = 3;

/**
 * Replace every occurrence of the secrets (values filled into password inputs) in the strings of `value`, in place:
 * own properties, enumerable or not, of plain objects and arrays, recursively. Data URLs, promises and frozen
 * objects are left alone. Each secret is also matched URL-encoded (a GET form puts it in the query) and
 * base64-encoded (standard and URL-safe, unpadded). Returns `value`.
 */
export function redactSecrets(value, secrets) {
  const needles = new Set();
  for (const secret of Array.isArray(secrets) ? secrets : []) {
    if (typeof secret !== 'string' || secret.length < SECRET_MIN_LENGTH) continue;
    needles.add(secret);
    needles.add(encodeURIComponent(secret));
    needles.add(encodeURIComponent(secret).replace(/%20/g, '+'));
    // A page or a URL that echoes the value base64-encoded (a basic-auth header shown back, a token in a query):
    // standard and URL-safe alphabets, without padding (the padded form contains it).
    const base64 = Buffer.from(secret, 'utf8').toString('base64').replace(/=+$/, '');
    needles.add(base64);
    needles.add(base64.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  const list = [...needles].sort((a, b) => b.length - a.length);
  if (!list.length) return value;
  const clean = text => {
    if (text.startsWith('data:')) return text;
    let out = text;
    for (const needle of list) if (out.includes(needle)) out = out.split(needle).join(REDACTED);
    return out;
  };
  const seen = new WeakSet();
  const walk = item => {
    if (!item || typeof item !== 'object' || seen.has(item) || Object.isFrozen(item)) return;
    if (typeof item.then === 'function') return;
    seen.add(item);
    for (const key of Object.getOwnPropertyNames(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor)) continue;
      const current = descriptor.value;
      if (typeof current === 'string') {
        const next = clean(current);
        if (next !== current && descriptor.writable) item[key] = next;
        else if (next !== current && descriptor.configurable) Object.defineProperty(item, key, { ...descriptor, value: next });
      } else {
        walk(current);
      }
    }
  };
  if (typeof value === 'string') return clean(value);
  walk(value);
  return value;
}

/** The `answer` of a result without candidates. */
export function emptyAnswer() {
  return { method: 'none', candidates: [] };
}

function clip(value, limit) {
  return String(value ?? '').slice(0, limit);
}

const RESULT_DATE = /\b(?:\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|20\d{2}-\d{2}-\d{2})/i;

function resultStateOf(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const state = {};
  const count = raw.resultCount;
  if (Number.isSafeInteger(count?.value) && count.value >= 0) {
    state.resultCount = { value: count.value, ...(count.approximate === true ? { approximate: true } : {}) };
  }
  const label = typeof raw.sort?.label === 'string' ? raw.sort.label.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  if (label) {
    state.sort = { label };
    if (['ascending', 'descending'].includes(raw.sort.direction)) state.sort.direction = raw.sort.direction;
  }
  if (raw.pagination && typeof raw.pagination === 'object') {
    const pagination = {};
    const current = raw.pagination.current;
    const total = raw.pagination.total;
    if (Number.isInteger(current) && current > 0) pagination.current = current;
    if (Number.isInteger(total) && total > 0 && (!pagination.current || total >= pagination.current)) pagination.total = total;
    else if (pagination.current && total !== undefined) delete pagination.current;
    for (const key of ['next', 'previous']) {
      const value = raw.pagination[key];
      if (value === true || (typeof value === 'string' && value)) pagination[key] = value === true ? true : clip(value, 20);
    }
    if (Object.keys(pagination).length) state.pagination = pagination;
  }
  return state;
}

function resultFields(record, date) {
  const hints = record.hints ?? {};
  return record.fields.filter(field => {
    if (date && field === date) return false;
    if (hints.price && field.replace(/^(?:price|total)\s*:?\s*/i, '') === hints.price) return false;
    const rating = ratingValue(field);
    if (rating && rating.value === hints.rating && (hints.scale === undefined || rating.scale === undefined
      || rating.scale === hints.scale)) return false;
    if (hints.reviews !== undefined && /^\(?\d[\d,. ]*\)?\s+(?:reviews?|ratings?)$/i.test(field)
      && Number(field.replace(/\D/g, '')) === hints.reviews) return false;
    return true;
  });
}

const DIRECT_RESULT_CHARS = PAGE_TEXT_LIMIT;

/**
 * The primary detected record list in a compact structured form. `total` is the detected rows on this page;
 * `resultCount` is the page's own global count when explicit. At most 600 characters of task-relevant rows are
 * projected, with omitted rows left to the digest. `complete` is false for a capped/projected list, either pagination
 * direction, an approximate or contradictory global count. Raw open/pagination refs become action ids for Agent direct.
 */
export function recordResultsOf(observation, instruction = '') {
  const members = recordsOf(observation).filter(record => record.list === 0);
  if (members.length < 3) return null;
  const rawMeta = (Array.isArray(observation?.recordLists) ? observation.recordLists : [])
    .find(entry => entry?.list === 0) ?? {};
  const total = Number.isInteger(rawMeta.total) && rawMeta.total >= members.length ? rawMeta.total : members.length;
  const state = resultStateOf(observation?.recordState);
  const pagination = state.pagination;
  const count = state.resultCount;
  const { blocks, scores } = scoreBlocks(observation, instruction);
  const relevance = new Map(blocks.map((block, index) => [block.rec, scores[index]]).filter(([id]) => id));
  const candidates = members.map((record, index) => {
    const hints = record.hints ?? {};
    const date = hints.when?.find(text => RESULT_DATE.test(text));
    const fields = resultFields(record, date);
    const projected = {
      id: record.id,
      title: record.title,
      ...(date ? { date } : {}),
      ...(hints.price ? { price: hints.price } : {}),
      ...(hints.rating !== undefined ? { rating: hints.rating, ...(hints.scale !== undefined ? { scale: hints.scale } : {}) } : {}),
      ...(hints.reviews !== undefined ? { reviews: hints.reviews } : {}),
      ...(fields.length ? { fields } : {}),
      ...(record.ref !== undefined ? { openRef: record.ref } : {}),
      ...Object.fromEntries(['sponsored', 'unavailable', 'offscreen'].filter(flag => record[flag] === true).map(flag => [flag, true])),
    };
    const { id, ...row } = projected;
    return { projected, index, score: relevance.get(record.id) ?? 0, chars: `result ${id}: ${JSON.stringify(row)}\n`.length };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = [];
  let chars = 0;
  for (const candidate of candidates) {
    if (chars + candidate.chars > DIRECT_RESULT_CHARS) continue;
    selected.push(candidate);
    chars += candidate.chars;
  }
  const records = selected.sort((a, b) => a.index - b.index).map(candidate => candidate.projected);
  const truncated = records.length < members.length;
  const complete = !truncated && observation?.recordsTruncated !== true && total === members.length
    && !pagination?.next && !pagination?.previous && (!count || (!count.approximate && count.value === total));
  return { list: 0, shown: records.length, total, ...state, ...(truncated ? { truncated: true } : {}), complete, records };
}

function withResultActions(results, actions) {
  if (!results) return null;
  const byRef = new Map((actions ?? []).filter(action => action?.id && action.target !== undefined
    && (action.type === 'click' || action.type === 'navigate_allowed_url')).map(action => [String(action.target), action.id]));
  const records = results.records.map(({ openRef, ...record }) => ({
    ...record, ...(openRef !== undefined && byRef.has(openRef) ? { open: byRef.get(openRef) } : {}),
  }));
  const out = { ...results, records };
  if (results.pagination) {
    out.pagination = Object.fromEntries(Object.entries(results.pagination).map(([key, value]) => {
      if (!['next', 'previous'].includes(key) || value === true) return [key, value];
      return [key, byRef.get(value) ?? true];
    }));
  }
  return out;
}

function withoutProjectedRows(digest, results) {
  if (!results) return digest;
  const ids = new Set(results.records.map(record => record.id));
  return digest.filter(block => typeof block === 'string' || !block?.rec || !ids.has(block.rec));
}

/**
 * Final page summary for the host: a digest of the blocks most relevant to `question` (at most 25 blocks and
 * about 1500 characters, in document order), structured primary records for Agent-direct projection, and a
 * 600-character text excerpt as a fallback. Controls are not included; they stay in observe() results and in the
 * trace. `truncated` is true when page content was left out
 * of both (excerpt cut, relevant blocks over the digest budget, or the page script's own limits hit).
 */
export function compactPage(observation, question = '') {
  if (!observation) return null;
  const text = String(observation.text ?? '');
  const { digest, truncated } = buildDigest(observation, question);
  const results = recordResultsOf(observation, question);
  return {
    url: String(observation.url ?? ''),
    title: clip(observation.title, 500),
    digest,
    ...(results ? { results } : {}),
    textExcerpt: text.slice(0, PAGE_TEXT_LIMIT),
    truncated: text.length > PAGE_TEXT_LIMIT || truncated || results?.truncated === true
      || observation.textTruncated === true || observation.blocksTruncated === true,
  };
}

// Page facts beyond the digest that the extension reports (all untrusted page content, redacted by the extension and
// again by the daemon's final pass): the lease's tabs when it followed a popup or new tab, a JavaScript dialog the page
// opened, and on a Test site the page's console errors and failed requests since the last read.
const DIALOG_KINDS = new Set(['alert', 'confirm', 'prompt', 'beforeunload']);
const LOG_KINDS = new Set(['error', 'warning', 'exception', 'rejection', 'network']);
const MAX_PAGE_TABS = 8;
const MAX_PAGE_LOGS = 30;
const line = (value, limit) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

/** `{ tabs?, dialog?, logs? }` of an observation, each cleaned and bounded; empty when it has none. */
export function pageExtras(observation) {
  const out = {};
  if (!observation || typeof observation !== 'object') return out;
  if (Array.isArray(observation.tabs) && observation.tabs.length > 1) {
    out.tabs = observation.tabs.slice(0, MAX_PAGE_TABS)
      .filter(tab => tab && typeof tab.id === 'string' && /^t\d{1,5}$/.test(tab.id))
      .map(tab => ({ id: tab.id, url: line(tab.url, 300), title: line(tab.title, 120), ...(tab.current === true ? { current: true } : {}) }));
  }
  const dialog = observation.dialog;
  if (dialog && typeof dialog === 'object' && DIALOG_KINDS.has(dialog.kind)) {
    out.dialog = { kind: dialog.kind, text: line(dialog.text, 300) };
    if (['accept', 'dismiss'].includes(dialog.answered)) out.dialog.answered = dialog.answered;
    if (dialog.open === true) out.dialog.open = true;
  }
  // The page's cross-origin frames (extension/frames.js): the ones read (`id` f<n>, their controls carry it) and the
  // ones not read with why (`not_approved`: the request does not list the origin; `no_access`: the browser gives the
  // extension no access to it; `sandboxed`, `limit`, `unavailable`). Origins only, written by the extension.
  const frames = pageFrames(observation.frames);
  if (frames) out.frames = frames;
  // origin_changed: the origin the tab went to (the extension's report, origin only; a page can choose where it sends
  // the tab, so it is untrusted text, never part of needs.message).
  if (typeof observation.leftOrigin === 'string' && FRAME_ORIGIN.test(observation.leftOrigin)) out.leftOrigin = observation.leftOrigin;
  // child_tab: the origin of the tab or window the page opened (the same rules: origin only, untrusted).
  if (typeof observation.childOrigin === 'string' && FRAME_ORIGIN.test(observation.childOrigin)) out.childOrigin = observation.childOrigin;
  if (Array.isArray(observation.logs)) {
    out.logs = observation.logs.slice(-MAX_PAGE_LOGS).filter(entry => entry && LOG_KINDS.has(entry.kind)).map(entry => {
      const item = { kind: entry.kind, text: line(entry.text, 300) };
      if (Number.isInteger(entry.status)) item.status = entry.status;
      if (typeof entry.method === 'string' && /^[A-Z]{1,10}$/.test(entry.method)) item.method = entry.method;
      if (typeof entry.url === 'string' && entry.url) item.url = line(entry.url, 300);
      return item;
    });
    if (Number.isInteger(observation.logsDropped) && observation.logsDropped > 0) out.logsDropped = observation.logsDropped;
  }
  return out;
}

const FRAME_REASONS = new Set(['not_approved', 'no_access', 'sandboxed', 'limit', 'unavailable']);
const FRAME_ORIGIN = /^https?:\/\/[a-z0-9.[\]:-]{1,260}$/i;

/** The observation's `frames` list, cleaned: [{id?, origin, read, reason?}] (at most 16), or null when empty. */
export function pageFrames(frames) {
  if (!Array.isArray(frames)) return null;
  const out = [];
  for (const frame of frames.slice(0, 16)) {
    if (!frame || typeof frame !== 'object') continue;
    const origin = typeof frame.origin === 'string' && FRAME_ORIGIN.test(frame.origin) ? frame.origin : null;
    if (frame.read === true && typeof frame.id === 'string' && /^f[1-9]$/.test(frame.id) && origin) {
      out.push({ id: frame.id, origin, read: true });
    } else if (frame.read === false && FRAME_REASONS.has(frame.reason)) {
      out.push({ origin, read: false, reason: frame.reason, ...(frame.declared === true ? { declared: true } : {}) });
    }
  }
  return out.length ? out : null;
}

/**
 * The next-step note for frames the page holds but FAI did not read because the request does not cover their origin
 * (or the browser gives no access). Trusted text: it counts them and never names an origin (a page chooses its frames'
 * origins); the origins are in the untrusted `frames` list. '' when there are none.
 */
export function framesNote(result) {
  const frames = pageFrames(result?.frames ?? result?.page?.frames) ?? [];
  const count = reason => frames.filter(frame => !frame.read && frame.reason === reason).length;
  const missing = count('not_approved');
  const blocked = count('no_access');
  const plural = n => (n === 1 ? '1 frame on another origin is' : `${n} frames on other origins are`);
  let note = '';
  if (missing) {
    note += ` ${plural(missing)} unread because this request does not cover them; their origins are in frames (page `
      + 'content: check them with the user). If the task needs them, ask the user and call fai_browser_open with those '
      + 'origins added to origins (the user approves them).';
  }
  if (blocked) {
    note += ` ${plural(blocked)} unread because the browser gives FAI Browser no access to them although this request `
      + 'lists them (a toolbar approval covers only the tab\'s own site): ask the user to approve the request from its '
      + 'request window, which asks the browser for every origin of the request.';
  }
  return note;
}

/** Compact post-action observation stored on each step. */
export function compactStepObservation(observation) {
  const text = String(observation.text ?? '');
  return {
    revision: observation.revision,
    url: observation.url,
    title: clip(observation.title, 300),
    textExcerpt: text.slice(0, STEP_TEXT_LIMIT),
    truncated: text.length > STEP_TEXT_LIMIT,
    controlCount: (observation.controls ?? []).length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Lean agent results
// ---------------------------------------------------------------------------------------------------------------

/**
 * Actions listed by a lean observe result when the daemon sends no listing (an older daemon): at most this many, scroll,
 * wait and allowed-URL navigation always included. A current daemon sends `offer` (src/relevance.js capOffer).
 */
export const OBSERVE_ACTION_LIMIT = 40;
/** Answer candidates in a lean result; the trace keeps all five. */
const LEAN_ANSWER_CANDIDATES = 3;
const PAGE_ACTION_TYPES = new Set(['scroll', 'wait', 'navigate_allowed_url']);
const BRIEF_LABEL_LIMIT = 80;

function digestText(block) {
  if (typeof block === 'string') return block;
  return String(block?.text ?? '');
}

function leanNeeds(needs) {
  if (!needs || (needs.who === 'none' && !needs.message)) return undefined;
  const out = { who: needs.who, message: needs.message };
  if (needs.revision !== undefined) out.revision = needs.revision;
  if (needs.confidence !== undefined) out.confidence = needs.confidence;
  // The level a refusal asks the user to grant (refused_action relayed as a level request).
  if (typeof needs.level === 'string') out.level = needs.level;
  // Untrusted page text (the consent dialog), kept apart from the trusted message.
  if (typeof needs.dialog === 'string' && needs.dialog) out.dialog = needs.dialog;
  // The control the commit guard vetoed (guardrail pass): its page label is untrusted page text as well.
  if (needs.control && typeof needs.control.label === 'string') {
    out.control = { ref: needs.control.ref, label: needs.control.label };
  }
  // The Approve gate: the class, and the action id and revision to act on again once the user approves.
  const approval = needs.approval;
  if (approval && typeof approval === 'object' && typeof approval.actionId === 'string' && typeof approval.revision === 'string') {
    out.approval = { class: String(approval.class ?? ''), actionId: approval.actionId, revision: approval.revision,
      ...(Number.isInteger(approval.expiresInMs) ? { expiresInMs: approval.expiresInMs } : {}) };
  }
  return out;
}

function leanStep(step) {
  const action = step?.action ?? {};
  const out = { i: step?.i, action: { type: action.type, label: action.label, toUrl: action.toUrl } };
  // A fill's supplied-text name: the host's own key, never the value.
  if (typeof action.suppliedName === 'string') out.action.suppliedName = action.suppliedName;
  // A consent reject click.
  if (step?.class === 'consent') out.class = step.class;
  const confidence = step?.confidence ?? step?.decision?.confidence;
  if (Number.isFinite(confidence)) out.confidence = confidence;
  const ms = Number.isFinite(step?.ms) ? step.ms : step?.ms?.total;
  out.ms = Number.isFinite(ms) ? ms : 0;
  // A point click (act with a point): the screenshot pixels the host gave, the control ref it resolved to ("point"
  // for one the observation left out) and whether that control was offered. Runtime-written.
  const point = leanPoint(step?.decision?.point, step?.decision?.resolved);
  if (point) out.point = point;
  // A fill the field did not keep (fill_not_kept): the trail says so next to the action. Runtime-written.
  if (step?.fill?.kept === false) out.fill = 'not_kept';
  return out;
}

function leanPoint(point, resolved) {
  if (!point?.image || !Number.isFinite(point.image.x) || !Number.isFinite(point.image.y)) return null;
  const out = { x: point.image.x, y: point.image.y };
  if (resolved && typeof resolved === 'object') {
    out.ref = String(resolved.ref ?? 'point');
    out.offered = resolved.offered === true;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Receipt v2: verdict and next (docs/design/OVERSIGHT-SPEC.md section 2). Both are runtime-written and trusted; the only page
// text inside `verdict` is `answer.text` (an auto-confirmed page block).
// ---------------------------------------------------------------------------------------------------------------

// The next kinds a host sees (directNext), and the oversight a verdict implies for each.
export const NEXT_KINDS = Object.freeze(['answer', 'choose', 'observe', 'relay', 'approve', 'stop']);

const OVERSIGHT_FOR_NEXT = {
  answer: 'none',
  choose: 'choose',
  observe: 'instruct',
  relay: 'user',
  approve: 'approve',
  stop: 'user',
};
// Codes after which the host observes again and chooses.
const OBSERVE_CODES = new Set([
  'time_budget', 'fill_not_kept', 'unsupported', 'stale',
  'target_unavailable', 'capture_failed', 'step_complete',
]);
// Lease codes the daemon resumes on the same request once the user acts.
const RESUME_CODES = new Set([
  'select_tab', 'paused', 'tab_changed', 'origin_changed', 'child_tab', 'session_inactive', 'disconnected',
]);
// needs_user codes the user handles in the tab before the same request runs again.
const RELAY_CODES = new Set(['login', 'blocked', 'cross_origin', 'js_dialog']);
/**
 * The actions a host act() may run next, from the runtime's `offer` on an act result ({revision, actions, listed,
 * cap, dropped}: the listing as `actions` [{id, description}], the rest counted in `moreActions`) or from an already
 * lean result (`revision`, `actions`, `moreActions`). Null when the result offers nothing (a run, a refused act).
 */
export function offerOf(result) {
  const offer = result?.offer;
  if (offer && typeof offer === 'object' && Array.isArray(offer.actions) && typeof offer.revision === 'string') {
    const listed = Array.isArray(offer.listed) ? new Set(offer.listed) : null;
    const shown = listed ? offer.actions.filter(action => listed.has(action.id)) : offer.actions;
    const out = { revision: offer.revision, actions: shown.map(listedAction) };
    const left = offer.actions.length - shown.length;
    if (left > 0) out.moreActions = left;
    return out;
  }
  if (typeof result?.revision === 'string' && Array.isArray(result.actions)) {
    const out = { revision: result.revision, actions: result.actions.map(action => ({ id: action.id, description: action.description, ...(typeof action.needsApproval === 'string' ? { needsApproval: action.needsApproval } : {}) })) };
    if (Number.isInteger(result.moreActions) && result.moreActions > 0) out.moreActions = result.moreActions;
    return out;
  }
  return null;
}

/**
 * The verdict for a result. `signals` come from the runtime (auto-confirmed answer, extra `why` codes, whether a
 * question was asked, a loading final page); without them (older traces, daemon-side outcomes) the verdict is
 * derived from the code alone. Shape: `{kind, oversight, answer, why, budget}`.
 */
export function buildVerdict(result, signals = {}) {
  const code = result?.code ?? 'failed';
  const status = result?.status ?? 'failed';
  const why = [...new Set([code, ...(signals.why ?? [])].filter(Boolean))];
  let answer = null;
  let kind;
  let next;
  if (status === 'completed' && signals.loading) {
    // The final page still shows a loading placeholder: the digest holds the pre-load text, not the answer.
    kind = 'likely';
    next = 'answer';
  } else if (status === 'completed') {
    if (signals.answer) {
      kind = 'verified';
      answer = signals.answer;
      next = 'answer';
    } else if (signals.hasQuestion === false) {
      kind = 'verified';
      next = 'answer';
    } else {
      kind = code === 'expectation_passed' ? 'verified' : 'likely';
      next = 'answer';
    }
  } else if (code === 'expectation_failed') {
    kind = 'likely';
    next = offerOf(result) ? 'choose' : 'observe';
  } else if (code === 'step_complete' && offerOf(result)) {
    // A host act() landed on a page with offered actions: the host keeps driving.
    kind = 'needs_decision';
    next = 'choose';
  } else if (code === 'refused_action' && typeof result?.needs?.level === 'string') {
    // A higher level would allow it: the user re-approves the tab at needs.level (or, when the grant already covers
    // it, the host observes again with that mode).
    kind = result.needs.who === 'host' ? 'needs_decision' : 'needs_user';
    next = result.needs.who === 'host' ? 'observe' : 'relay';
  } else if (code === 'refused_action' || code === 'error_page') {
    // FAI Browser refuses the task itself, or the page it reached is broken.
    kind = 'failed';
    next = 'stop';
  } else if (OBSERVE_CODES.has(code)) {
    kind = 'needs_decision';
    next = 'observe';
  } else if (status === 'needs_user') {
    kind = 'needs_user';
    next = 'relay';
  } else if (code === 'config') {
    kind = 'failed';
    next = 'relay';
  } else if (status === 'needs_host' && code !== 'request_closed') {
    kind = 'needs_decision';
    next = 'observe';
  } else {
    // request_closed, task_budget, stopped, cancelled, interrupted and failures.
    kind = 'failed';
    next = 'stop';
  }
  const verdict = {
    kind,
    oversight: OVERSIGHT_FOR_NEXT[next],
    answer,
    why,
    budget: signals.budget ?? null,
  };
  return verdict;
}

/** An auto-confirmed answer as stored: the value, its source block (`line`) when cut from it, `exact: false` when
 * the block is compound and the host must reply with only the requested part; a step list's answer also lists each
 * step's (`steps`, src/runtime.js listAnswer). */
function leanAnswer(answer) {
  const out = { text: answer.text, confidence: answer.confidence, basis: [...(answer.basis ?? [])] };
  if (typeof answer.line === 'string' && answer.line !== answer.text) out.line = answer.line;
  if (answer.exact === false) out.exact = false;
  if (Array.isArray(answer.steps)) {
    out.steps = answer.steps.map(step => {
      const entry = { i: step.i, text: step.text };
      if (typeof step.line === 'string') entry.line = step.line;
      if (step.exact === false) entry.exact = false;
      return entry;
    });
  }
  return out;
}

/** A verdict as stored on a lean result: known fields only, JSON-safe; the next kind travels in `next`. */
function leanVerdict(verdict) {
  const out = {
    kind: verdict.kind,
    oversight: verdict.oversight,
    answer: verdict.answer ? leanAnswer(verdict.answer) : null,
    why: [...(verdict.why ?? [])],
    budget: verdict.budget ? { ...verdict.budget } : null,
  };
  return out;
}

/** Approval instructions for an automatically opened task page or the request window. */
export function approvalSteps(approval) {
  if (approval === 'page') {
    return 'its task page opened in an existing browser window; click Approve in the page request modal (grant browser site access if asked), or use the FAI Browser toolbar icon';
  }
  return 'click Open in the FAI Browser window, then Approve in the page request modal (grant browser site access if asked), or use the FAI Browser toolbar icon';
}

/** The select_tab needs.message for how the request is presented (see approvalSteps). */
export function selectTabMessage(approval) {
  if (approval === 'page') return `Not approved yet. Ask the user to approve: ${approvalSteps(approval)}.`;
  return OUTCOMES.select_tab.message;
}

// `resume`: {env, wake} for the resume wait sentences (src/resume.js): the MCP server's environment, and its wake
// capability (a session FAI wakes needs no background wait command).
const resumeOf = context => ({ env: context?.env, wake: context?.wake ?? null });

const STATUS_NAMES = {
  404: 'Not Found', 410: 'Gone', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

// The trusted refusal texts a stop may carry (runtime-written needs.message); anything else falls back to the generic
// one, so a stop text never repeats a message the runtime did not write.
const REFUSAL_STOP_TEXTS = new Set([
  'FAI never purchases, deletes, sends or logs in. Tell the user what to do in the tab.',
  'FAI never purchases outside testing mode. Tell the user what to do in the tab.',
  'The user reserved this control for themselves. Tell the user what to do in the tab.',
  'The user denied this action in the FAI Browser window. Tell the user; do not retry it.',
]);

function refusalStopText(result) {
  const message = result?.needs?.message;
  return REFUSAL_STOP_TEXTS.has(message) ? message
    : 'FAI never purchases, deletes, sends or logs in. Tell the user what to do in the tab.';
}

function stopText(result) {
  switch (result.code) {
    case 'stopped':
      return 'The user pressed Stop. Report that and do not retry without asking the user.';
    case 'task_budget':
      return 'The call budget for this request is used up. Report the best partial answer from the last page.digest '
        + 'and trail, and say it is not verified. Do not call FAI Browser again for this task.';
    case 'refused_action':
      return refusalStopText(result);
    case 'error_page': {
      const why = result.verdict?.why ?? [];
      // The browser's own error page (an HTTP error sent without a page body, or a network failure): status unknown.
      if (why.includes('error_source:browser')) {
        return 'The browser showed its own error page: the server answered with an HTTP error and no page, or the site '
          + 'could not be reached. Report that to the user and do not retry the same link. The tab stays approved: it '
          + 'can be reloaded later, once the site is back.';
      }
      const status = why.map(code => /^http:(\d{3})$/.exec(code)?.[1]).find(Boolean);
      return `The page is an HTTP ${status ? `${status} ` : ''}error page${status ? ` (${STATUS_NAMES[status] ?? 'error'})` : ''}: `
        + 'the link or page is broken. Report that to the user and do not retry the same link.';
    }
    case 'request_closed':
      return 'This tab request has ended. Call fai_browser_open with origins and reason only if the user still wants '
        + 'this.';
    default:
      return 'Report the outcome to the user (needs.message explains it). Do not retry automatically.';
  }
}

/**
 * The trusted next step `{kind, text}` for a lean result with a verdict. `context.requestId` names the tab request
 * in the text; `context.origin` is used by the approval hint.
 */
export function nextFor(result, context = {}) {
  return directNext(result, context);
}

// ---------------------------------------------------------------------------------------------------------------
// The host chooses every action (fai_browser_open / observe / act). Its next kinds are few and short.
// ---------------------------------------------------------------------------------------------------------------

// Codes after which the page the host saw is out of date or the action could not land: look again, then choose.
const DIRECT_OBSERVE_CODES = new Set(['stale', 'target_unavailable', 'capture_failed', 'time_budget', 'unsupported',
  'point_outside', 'no_control', 'point_frame']);

function directChooseText(revision) {
  return `Answer from page.digest if it answers the task; else fai_browser_act with one actions[].id and revision "${revision}".`;
}

function directApproveText(origin, requestId, approval, resume) {
  const root = siteRoot(origin);
  const site = root ?? (origin ? origin.replace(/^https:\/\//, '') : null);
  return withResumeWait(`Ask the user to approve the request${site ? ` for ${site}` : ''} in the browser: `
    + `${approvalSteps(approval)}. Then call fai_browser_observe with requestId ${requestId}.`, requestId, resume);
}

// The label is page text (redacted, clipped, quotes and line breaks removed), quoted inside a trusted sentence.
// `waitMs`: how long one act waits for the click (the MCP server's gate wait); the approval itself stays open for
// APPROVAL_PENDING_MS, and the same act repeated meanwhile picks up a click given in between.
function approvalPendingText(result, waitMs = null) {
  const label = String(result.needs?.control?.label ?? '').replace(/["'\u2018\u2019\u201c\u201d\s]+/g, ' ').trim().slice(0, 60);
  const pending = result.needs?.approval ?? {};
  const again = pending.actionId && pending.revision
    ? `fai_browser_act again with actionId ${pending.actionId} and revision "${pending.revision}"`
    : 'fai_browser_act again with the same actionId and revision';
  const level = typeof result.needs?.level === 'string'
    ? ` Or ask for ${result.needs.level}: tell the user "approve ${LEVEL_NAMES[result.needs.level] ?? result.needs.level} for this task in FAI Browser; it is preselected", then fai_browser_open with the requestId and mode "${result.needs.level}".` : '';
  const seconds = Number.isFinite(waitMs) && waitMs > 0 ? Math.round(waitMs / 1000) : null;
  const wait = seconds
    ? `; it returns at once if they already approved, else waits up to ${seconds} s (the approval stays open for 5 minutes: repeat the call if it returns pending again)`
    : '; it returns at once if they already approved (the approval stays open for 5 minutes)';
  return `Tell the user to approve '${label || 'this action'}' (page text) in the FAI Browser window (Approve once), then call `
    + `${again}${wait}.${level}`;
}

/** The trusted next step `{kind, text}` of a host-driven (Agent direct) result: choose, observe, answer, relay, approve, stop. */
export function directNext(result, context = {}) {
  const next = directNextStep(result, context);
  const note = ['choose', 'observe', 'answer'].includes(next.kind) ? framesNote(result) : '';
  return note ? { ...next, text: `${next.text}${note}` } : next;
}

function directNextStep(result, context = {}) {
  const ref = context.requestId ?? result.requestId ?? result.lease?.requestId ?? 'from this result';
  const code = result.code;
  const offered = offerOf(result);
  const level = typeof result.needs?.level === 'string' ? result.needs.level : null;
  if (result.status === 'completed' && result.verification?.passed === true) {
    return { kind: 'answer', text: 'Verified: the expectation passed. Report the outcome from page.digest; no tool call '
      + `needed${offered ? ' unless the task needs more actions' : ''}.` };
  }
  if (code === 'select_tab') return { kind: 'relay', text: directApproveText(context.origin, ref, context.approval ?? result.approval, resumeOf(context)) };
  if (code === 'approval_pending') return { kind: 'approve', text: approvalPendingText(result, context.gateWaitMs) };
  if (level && (code === 'refused_action' || code === 'login')) {
    if (result.needs?.who === 'host') {
      return { kind: 'observe', text: `The grant already covers ${level}: call fai_browser_observe with mode "${level}", then choose.` };
    }
    return { kind: 'relay', text: `Relay needs.message; tell the user "approve ${LEVEL_NAMES[level] ?? level} for this task `
      + `in FAI Browser; it is preselected". Then call fai_browser_open with requestId ${ref} and mode "${level}" (same tab and page).` };
  }
  if (code === 'refused_action') return { kind: 'stop', text: `${refusalStopText(result)} Do not retry it.` };
  if (code === 'error_page') return { kind: 'stop', text: stopText(result).replace(/ and do not retry the same link\./, '; do not retry the same link.') };
  if (code === 'fill_not_kept') {
    return { kind: 'observe', text: 'The field did not keep the value. Do not fill it again: observe, then use the page\'s '
      + 'own picker or control, or open a URL that carries the value (allowedUrls).' };
  }
  if (code === 'line_break_input') return { kind: 'observe', text: `${LINE_BREAK_TEXT} Observe first for a fresh revision.` };
  if (code === 'step_complete' && offered) {
    const missed = result.verification?.checked === true && result.verification.passed !== true;
    return { kind: 'choose', text: `${missed ? 'The expectation did not pass on this page. ' : ''}${directChooseText(offered.revision)}` };
  }
  if (code === 'expectation_failed') {
    return offered
      ? { kind: 'choose', text: `The expectation did not pass on this page. ${directChooseText(offered.revision)}` }
      : { kind: 'observe', text: 'The expectation did not pass on this page. Observe, then choose.' };
  }
  if (DIRECT_OBSERVE_CODES.has(code) || (result.status === 'needs_host' && code !== 'request_closed')) {
    return { kind: 'observe', text: 'The page changed or the action could not land. Observe again (fai_browser_observe), then choose.' };
  }
  if (RESUME_CODES.has(code)) {
    // The lease is paused: the user's Resume in the extension makes it active again (wait --until active wakes a host).
    return { kind: 'relay', text: withResumeWait('Relay needs.message to the user (they click Resume in the FAI '
      + `Browser extension); once the tab is active again, call fai_browser_observe with requestId ${ref}.`, ref,
    resumeOf(context)) };
  }
  if (RELAY_CODES.has(code) || result.status === 'needs_user') {
    return { kind: 'relay', text: `Relay needs.message to the user; once they have done it, call fai_browser_observe with requestId ${ref}.` };
  }
  if (code === 'config') return { kind: 'relay', text: 'Relay needs.message to the user. Never ask for API keys in chat.' };
  if (code === 'task_budget') {
    return { kind: 'stop', text: 'The call budget for this request is used up. Report what page.digest shows and say it is '
      + 'not verified. Do not call FAI Browser again for this task.' };
  }
  if (code === 'request_closed') {
    return { kind: 'stop', text: 'This tab request has ended. Call fai_browser_open with origins and reason only if the user still wants this.' };
  }
  if (code === 'stopped') return { kind: 'stop', text: 'The user pressed Stop. Report that and do not retry without asking.' };
  if (code === 'denied') return { kind: 'stop', text: 'The user denied the request. Report that; ask again only if the user asks you to.' };
  return { kind: 'stop', text: 'Report the outcome to the user (needs.message explains it). Do not retry automatically.' };
}


/**
 * The lean result a host driving the tab itself reads (open, observe and act in Agent direct):
 * `{status, code, requestId, verification, page{url,title,digest,results?,truncated}, granted{level, asked}, revision,
 *   actions, moreActions, consent?, overlay?, needs?, warnings?, callsLeft?, next}`. No verdict, answer candidates,
 * cost or step list: the host chose the action and reads the page itself. `source` is an agentResult/observe
 * structure as the MCP server builds it (its `next` already direct).
 */
export function directResult(source) {
  const result = source ?? {};
  // An act that ran and landed without an expectation to check is `acted`.
  const acted = result.code === 'step_complete';
  const out = { status: acted ? 'acted' : result.status ?? 'observed' };
  if (result.code && !acted && result.code !== result.status && result.status !== 'completed') out.code = result.code;
  if (result.requestId) out.requestId = result.requestId;
  const verification = result.verification;
  if (verification?.checked) {
    out.verification = { passed: verification.passed === true, expectation: verification.expectation ?? null };
    if (verification.hint) out.verification.hint = verification.hint;
  }
  const page = result.page;
  if (page && typeof page === 'object') {
    out.page = { url: page.url, title: page.title, digest: Array.isArray(page.digest) ? page.digest : [],
      ...(page.results ? { results: page.results } : {}) };
    if (!out.page.digest.length && !page.results && page.textExcerpt) out.page.textExcerpt = page.textExcerpt;
    out.page.truncated = page.truncated === true;
  }
  const permissions = cleanPermissions(result.permissions);
  if (permissions) out.granted = { level: permissions.effective, asked: permissions.requested,
    ...(permissions.tabMode ? { tabMode: permissions.tabMode } : {}), ...(permissions.browser ? { browser: permissions.browser.name } : {}) };
  if (typeof result.revision === 'string') out.revision = result.revision;
  if (Array.isArray(result.actions)) out.actions = result.actions;
  if (Number.isInteger(result.moreActions) && result.moreActions > 0) out.moreActions = result.moreActions;
  if (result.consent) out.consent = result.consent;
  if (result.overlay) out.overlay = result.overlay;
  const kind = result.next?.kind;
  if (result.needs?.message && ['relay', 'stop', 'approve'].includes(kind)) {
    out.needs = { message: String(result.needs.message) };
    if (result.needs.approval && typeof result.needs.approval === 'object') out.needs.approval = { ...result.needs.approval };
    if (typeof result.needs.level === 'string') out.needs.level = result.needs.level;
    if (result.needs.dialog) out.needs.dialog = result.needs.dialog;
    if (result.needs.control?.label) out.needs.control = { label: result.needs.control.label };
  }
  if (result.point) out.point = result.point;
  if (Array.isArray(result.did) && result.did.length) out.did = result.did;
  // The lease's tabs when there is more than one (a popup or new tab the lease followed): ids for act {tab}.
  if (Array.isArray(result.tabs) && result.tabs.length > 1) out.tabs = result.tabs;
  // A JavaScript dialog the page opened (Test site): its kind and untrusted text.
  if (result.dialog && typeof result.dialog === 'object') out.dialog = result.dialog;
  // Test site only: the page's console errors and failed requests since the last read (untrusted, redacted).
  if (Array.isArray(result.logs)) out.logs = result.logs;
  if (Number.isInteger(result.logsDropped)) out.logsDropped = result.logsDropped;
  if (result.waited && typeof result.waited === 'object') out.waited = result.waited;
  if (typeof result.notice === 'string' && result.notice) out.notice = result.notice;
  for (const key of ['image', 'images', 'imagesOmitted']) if (result[key]) out[key] = result[key];
  if (Array.isArray(result.warnings) && result.warnings.length) out.warnings = [...result.warnings];
  const left = result.verdict?.budget?.callsLeft ?? result.callsLeft;
  if (Number.isInteger(left) && left <= 3) out.callsLeft = left;
  out.next = result.next;
  return out;
}

/**
 * Apply the per-request call budget to a lean result (MCP): sets `verdict.budget` and, when no call is left,
 * turns a next step that needs another call into `stop`. Returns the result.
 */
export function applyBudget(result, budget, context = {}) {
  if (!result?.verdict || !budget) return result;
  result.verdict.budget = { ...budget };
  const next = directNext(result, context);
  result.next = budget.callsLeft <= 0 && ['choose', 'observe'].includes(next.kind)
    ? directNext({ code: 'task_budget' }, context) : next;
  return result;
}

/**
 * The lean agent result (receipt v2): what a host model reads. Accepts a runtime result, a trace record or an
 * already lean result (the function is idempotent). Shape:
 * `{v: 2, runId, status, code, reason, needs?, verification, verdict{kind, oversight, answer, why, budget},
 *   page{url,title,digest,results?,textExcerpt?,truncated}, answer, trail?, steps:[{i, action:{type,label,
 *   toUrl}, class?, confidence?, ms}], cost, warnings?, next{kind, text}, lease?, trace}`. `results` is Agent-direct only.
 * `page.digest` is a list of block texts and `page.textExcerpt` is sent only when both it and `results` are empty;
 * `answer.candidates` are the top three `{text, confidence}`.
 */
export function agentResult(source) {
  const result = source ?? {};
  const out = {
    v: RESULT_VERSION,
    runId: result.runId ?? null,
    status: result.status,
    code: result.code,
    reason: result.reason,
  };
  const needs = leanNeeds(result.needs);
  if (needs) out.needs = needs;
  const verification = result.verification ?? {};
  out.verification = {
    checked: verification.checked === true,
    passed: verification.passed === true,
    expectation: verification.expectation ?? null,
  };
  if (verification.error) out.verification.error = verification.error;
  if (verification.contentLoading) out.verification.contentLoading = true;
  // A step list held its last step although that step's expectation passed (`step:<n>:<why>`, runtime-written).
  if (typeof verification.held === 'string') out.verification.held = verification.held;
  // The expected text or title is not on the page: what the page has instead (quoted page text, runtime-built).
  if (typeof verification.hint === 'string' && verification.hint) out.verification.hint = verification.hint;
  // The runtime's own expand click left the page rewriting its URL in place: these URL fields were carried from
  // before the click, the rest verified on the expanded page (runtime-written).
  if (Array.isArray(verification.carried) && verification.carried.length) out.verification.carried = [...verification.carried];
  const verdict = result.verdict && typeof result.verdict === 'object' ? result.verdict : buildVerdict(result);
  out.verdict = leanVerdict(verdict);
  const page = result.page;
  if (page && typeof page === 'object') {
    const offered = result.offer && Array.isArray(result.offer.actions)
      ? (Array.isArray(result.offer.listed)
        ? result.offer.actions.filter(action => result.offer.listed.includes(action.id)) : result.offer.actions)
      : null;
    const results = page.results && offered ? withResultActions(page.results, offered)
      : page.results && Array.isArray(result.actions) ? page.results : null;
    const rawDigest = Array.isArray(page.digest) ? page.digest : [];
    const digest = withoutProjectedRows(rawDigest, results).map(digestText).filter(Boolean);
    out.page = { url: page.url, title: page.title, digest, ...(results ? { results } : {}) };
    // The excerpt is the fallback for pages without a digest or structured rows; with either it would mostly repeat them.
    if (!digest.length && !results) out.page.textExcerpt = page.textExcerpt ?? '';
    out.page.truncated = page.truncated === true;
  } else {
    out.page = null;
  }
  out.answer = {
    method: result.answer?.method ?? 'none',
    candidates: (result.answer?.candidates ?? []).slice(0, LEAN_ANSWER_CANDIDATES).map(candidate => {
      const entry = { text: typeof candidate === 'string' ? candidate : candidate?.text, confidence: candidate?.confidence };
      // A candidate read on an earlier page state names that state (trail[].state).
      const state = candidate?.state ?? candidate?.source?.state;
      if (Number.isInteger(state)) entry.state = state;
      return entry;
    }),
  };
  // Where the top candidate was read (an earlier page state), and the aggregation it came from: runtime-written.
  const answerSource = result.answer?.source;
  if (answerSource && Number.isInteger(answerSource.state)) out.answer.source = { state: answerSource.state, url: answerSource.url };
  const aggregate = result.answer?.aggregate;
  if (aggregate && typeof aggregate === 'object') {
    out.answer.aggregate = { op: aggregate.op, measure: aggregate.measure ?? null, items: aggregate.items,
      states: aggregate.states, partial: aggregate.partial === true };
    if (Array.isArray(aggregate.why) && aggregate.why.length) out.answer.aggregate.why = [...aggregate.why];
    if (aggregate.tie === true) out.answer.aggregate.tie = true;
  }
  if (Array.isArray(result.trail) && result.trail.length) {
    out.trail = result.trail.map(entry => {
      const item = { url: entry.url, lines: [...(entry.lines ?? [])] };
      if (Number.isInteger(entry.state)) item.state = entry.state;
      return item;
    });
  }
  out.steps = (result.steps ?? []).map(leanStep);
  const cost = result.cost ?? {};
  out.cost = {
    decisions: cost.decisions ?? 0,
    inputTokens: cost.inputTokens ?? 0,
    outputTokens: cost.outputTokens ?? 0,
    elapsedMs: cost.elapsedMs ?? 0,
  };
  if (Array.isArray(result.warnings) && result.warnings.length) out.warnings = [...result.warnings];
  // Trusted: how long an act waited for the user's Approve click (never charged to the request's time budget).
  if (Number.isFinite(result.approvalMs) && result.approvalMs > 0) out.approvalMs = Math.round(result.approvalMs);
  // A host act: one line per action that ran (runtime-written; labels are page text, a typed value only its length).
  if (Array.isArray(result.did) && result.did.length) out.did = result.did.filter(line => typeof line === 'string').slice(0, 25);
  // The lease's tabs, a JavaScript dialog and Test-site logs on the page the act ended on (pageExtras; untrusted).
  Object.assign(out, pageExtras({ tabs: result.tabs, dialog: result.dialog, logs: result.logs, logsDropped: result.logsDropped,
    frames: result.frames, leftOrigin: result.leftOrigin, childOrigin: result.childOrigin }));
  // Trusted: an act with a point: the pixels given, the CSS point they map to, the image size assumed and the control
  // under them (ref "point" for one the observation left out; label is page text), also when the act was refused.
  if (result.point && typeof result.point === 'object' && result.point.image) {
    out.point = { image: result.point.image, css: result.point.css, scale: result.point.scale, imageSize: result.point.imageSize };
    if (result.point.control) out.point.control = { ...result.point.control };
  }
  // Trusted: the level the agent asked for, the user's grant for the tab and the level the run used.
  const permissions = cleanPermissions(result.permissions);
  if (permissions) out.permissions = permissions;
  // A host act(): the actions offered on the page it landed on (`revision`, `actions` [{id, description}] as an
  // observe lists them, `moreActions` for the ones the listing cap left out), so the next act needs no observe.
  const offered = offerOf(result);
  if (offered) Object.assign(out, offered);
  out.next = nextFor(out, { requestId: result.lease?.requestId ?? result.requestId, approval: result.approval ?? null });
  if (result.lease) out.lease = { requestId: result.lease.requestId, state: result.lease.state };
  out.trace = result.trace ?? null;
  return out;
}

const PERMISSION_LEVELS = new Set(['read-only', 'reversible', 'interactive', 'full', 'testing']);

/** A `permissions` block with known levels only (`granted` may be null without a user grant) and `scope`, or null. */
export function cleanPermissions(value) {
  if (!value || typeof value !== 'object') return null;
  const level = item => (PERMISSION_LEVELS.has(item) ? item : null);
  const effective = level(value.effective);
  if (!effective) return null;
  const out = {
    requested: level(value.requested) ?? effective,
    granted: level(value.granted),
    effective,
    testing: effective === 'testing',
  };
  // `origin` (exact origins) or `domain` (the request's domain roots, approved by the user); left out when unknown.
  if (value.scope === 'origin' || value.scope === 'domain') out.scope = value.scope;
  if (value.tabMode === 'single' || value.tabMode === 'multiple') out.tabMode = value.tabMode;
  // The browser that holds the tab: {id, product, name}, plain strings only.
  const browser = value.browser;
  if (browser && typeof browser.id === 'string' && typeof browser.name === 'string') {
    out.browser = { id: browser.id.slice(0, 64), product: typeof browser.product === 'string' ? browser.product.slice(0, 24) : null,
      name: browser.name.slice(0, 40) };
  }
  return out;
}

function quoted(label) {
  return JSON.stringify(String(label ?? '').replace(/\s+/g, ' ').trim().slice(0, BRIEF_LABEL_LIMIT));
}

/** One short line per offered action: `click "About"`, `select "Team" in "Plan"`, `scroll down`, `open <url>`. */
/**
 * One listed action for a host: `{id, description}`, plus `needsApproval` (purchase, secret, delete or submit) for an
 * action the user approves once in the FAI Browser window when it is acted on (the Approve gate).
 */
export function listedAction(action) {
  const out = { id: action.id, description: actionBrief(action) };
  if (typeof action.needsApproval === 'string') out.needsApproval = action.needsApproval;
  return out;
}

export function actionBrief(action) {
  if (typeof action.needsApproval === 'string') return `${actionBriefOf(action)} (asks the user)`;
  return actionBriefOf(action);
}

function actionBriefOf(action) {
  const role = action.role && action.role !== 'link' ? `${action.role} ` : '';
  switch (action.type) {
    case 'click': {
      const state = typeof action.checked === 'boolean' ? ` (${action.checked ? 'checked' : 'unchecked'})` : '';
      return `click ${role}${quoted(action.label)}${state}`;
    }
    case 'fill_supplied_text':
      return `fill ${role}${quoted(action.label)} with supplied ${action.suppliedName}`;
    // A fill whose text the host gives with the act (`text`, or a `fills` batch).
    case 'fill':
      return `fill ${role}${quoted(action.label)} (act with text)`;
    case 'upload':
      return `upload a file to ${quoted(action.label)} (act with path)`;
    // A secret handle: the user approves each use; the value never reaches the agent.
    case 'fill_secret':
      return `fill_secret ${quoted(action.label)} ← secret:${action.handle}${action.source ? ` (${action.source})` : ''}`;
    case 'copy_secret':
      return `copy_secret secret:${action.handle}${action.source ? ` (${action.source})` : ''} to the clipboard`;
    case 'submit_field':
      return `press Enter in ${role}${quoted(action.label)}${action.submits === 'submit_safe' ? ' (search)' : ' (submits its form)'}`;
    case 'select':
      return `select ${quoted(action.optionLabel ?? action.value)} in ${quoted(action.label)}`;
    case 'scroll':
      return `scroll ${action.direction ?? 'down'}`;
    case 'wait':
      return 'wait';
    case 'navigate_allowed_url':
      return action.newTab ? `open ${quoted(action.label)} in this tab` : `open ${action.url}`;
    default:
      return String(action.description ?? action.type);
  }
}

/**
 * The lean observe result: `{revision, page{url,title,digest,results?}, actions:[{id, description}], moreActions?, warnings?}`.
 * The listing is the daemon's `offer.listed` (at most 40 control actions at read-only and reversible, 80 from
 * interactive up, the most relevant to the task when there are more; page actions always listed), else capOffer at
 * the result's level with `options` (instruction, answerQuestion, expectation) as relevance hints. Ids keep their
 * offered numbers, so a gap means actions were left out: `moreActions` counts them (act still resolves them), and
 * `warnings` carries `controls_capped:<n>` whenever anything was left out of the page, the offer or the listing.
 */
const OBSERVE_CONSENT_TEXT = 120;
const OVERLAY_KINDS = new Set(['sign_in', 'newsletter', 'promo', 'app', 'permission', 'age_gate', 'task', 'unknown']);
const OBSERVE_CONSENT_BUTTONS = 10;

export function leanObserve(response, options = {}) {
  const page = response?.page ?? {};
  const all = Array.isArray(response?.actions) ? response.actions : [];
  const permissions = cleanPermissions(response?.permissions);
  let listed;
  const offered = Array.isArray(response?.offer?.listed) ? new Set(response.offer.listed) : null;
  if (offered) {
    listed = all.filter(action => offered.has(action.id));
  } else if (permissions) {
    // No listing from the daemon: the same cap here, at the result's level.
    const hints = options.instruction || options.answerQuestion || options.expectation ? relevanceHints(options) : null;
    listed = capOffer(all, permissions.effective, hints).actions;
  } else {
    // A new-tab link offered as same-tab navigation is still a control action, not a reserved page action.
    const isPageAction = action => PAGE_ACTION_TYPES.has(action.type) && !action.newTab;
    const pageActions = all.filter(isPageAction);
    const room = Math.max(0, OBSERVE_ACTION_LIMIT - pageActions.length);
    const kept = new Set([...all.filter(action => !isPageAction(action)).slice(0, room), ...pageActions]);
    listed = all.filter(action => kept.has(action));
  }
  const instruction = options.instruction || options.answerQuestion || '';
  const results = withResultActions(recordResultsOf(page, instruction), listed);
  const rawDigest = Array.isArray(response?.digest) ? response.digest : buildDigest(page, instruction).digest;
  const digest = withoutProjectedRows(rawDigest, results).map(digestText).filter(Boolean);
  const out = {
    revision: response?.revision ?? page.revision,
    page: { url: page.url, title: page.title, digest, ...(results ? { results } : {}),
      ...(results?.truncated ? { truncated: true } : {}) },
    actions: listed.map(listedAction),
  };
  const left = all.length - listed.length;
  if (left > 0) out.moreActions = left;
  if (permissions) out.permissions = permissions;
  // Machine codes from the page script and the runtime (password_field, login_wall, controls_capped:<n>,
  // cross_origin_frame), as in run results. A count the runtime has not added yet (an older daemon) is added here.
  const warnings = (Array.isArray(page.warnings) ? page.warnings : [])
    .filter(code => typeof code === 'string' && /^[a-z_]{1,40}(?::\d{1,6})?$/.test(code));
  const capIndex = warnings.findIndex(code => /^controls_capped(?::|$)/.test(code));
  if (capIndex < 0 && left > 0) warnings.push(`controls_capped:${left}`);
  else if (capIndex >= 0 && warnings[capIndex] === 'controls_capped' && left > 0) warnings[capIndex] = `controls_capped:${left}`;
  if (warnings.length) out.warnings = [...new Set(warnings)];
  // A cookie dialog on the page: its text and button labels are untrusted page content; `kind` is the page
  // script's classification (reject, accept, settings, other). Accept buttons are never offered as actions.
  const consent = page.consent;
  if (consent && typeof consent === 'object' && Array.isArray(consent.buttons)) {
    out.consent = {
      text: String(consent.text ?? '').replace(/\s+/g, ' ').trim().slice(0, OBSERVE_CONSENT_TEXT),
      buttons: consent.buttons.slice(0, OBSERVE_CONSENT_BUTTONS).map(button => {
        const entry = { label: String(button?.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) };
        if (typeof button?.kind === 'string') entry.kind = button.kind;
        return entry;
      }),
    };
  }
  // A popup over the page other than a cookie dialog (extension/page.js detectOverlay): its kind is the page script's
  // classification, its text untrusted page content. The runtime dismisses only nags; a host acts on the rest.
  const overlay = page.overlay;
  if (overlay && typeof overlay === 'object' && OVERLAY_KINDS.has(overlay.kind)) {
    out.overlay = { kind: overlay.kind, text: String(overlay.text ?? '').replace(/\s+/g, ' ').trim().slice(0, OBSERVE_CONSENT_TEXT) };
  }
  Object.assign(out, pageExtras(page));
  return out;
}
