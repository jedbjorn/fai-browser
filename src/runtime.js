import { randomUUID } from 'node:crypto';
import {
  URL_HOP_REFUSED, URL_IN_TEXT, namedUrls, originCovered, sameSite, siteEntryFor, siteHost, siteRoots, trimNamedUrl,
  urlCovered,
} from './origins.js';

export { namedUrls };
import {
  checkDeclarative, describeExpectation, evaluateExpectation, expectationHint, expectationTexts, lintExpectation, validateExpectation,
} from './expectation.js';
import {
  DIGEST_MAX_BLOCKS, DIGEST_MAX_CHARS, autoConfirm, blocksOf, buildDigest, classifyIntent, heuristicConfidences, loadingBlocks, loadingLexiconEntry,
  pageHasShape, persistentPlaceholders, pickAnswerCandidates, recordListsOf, tokenize,
} from './digest.js';
import {
  aggregateIntent, aggregateItems, answerScope, buildMemory, coverage, itemValue, lineText, passesFilters, traceFacts,
} from './facts.js';
import {
  ANSWER_STATUSES,
  MAX_ANSWER_CANDIDATES,
  RECOVERABLE_CODES,
  bridgeError,
  buildVerdict,
  compactPage,
  pageExtras,
  compactStepObservation,
  createResult,
  isKnownCode,
  nextFor,
  outcomeFor,
  redactSecrets,
  setOutcome,
  topProbabilities,
} from './result.js';
import {
  COMMIT_ACTION,
  DANGEROUS,
  FORBID_REFUSAL_TEXT,
  PURCHASE_REFUSAL_TEXT,
  REFUSAL_TEXT,
  commitIntent,
  consentAcceptActions,
  levelRefusalText,
  consentContinueOrigin,
  consentKey,
  consentOf,
  consentRejectActions,
  consentText,
  destructiveLink,
  destructiveLinkClass,
  errorPageOf,
  instructionTerms,
  isJoinTask,
  harmlessControlLabel,
  labelIntents,
  loginState,
  namedHops,
  plainNavLabel,
  remainingHops,
  resolveThresholds,
  suggestExpectation,
  suggestInstruction,
  suggestMaxActions,
  actionHops,
  boundedImperative,
  hopsDone,
  hopsDoneInOrder,
} from './oversight.js';
import {
  LIKELY_LEVELS, LIST_MAX_ACTIONS, STEP_DEFAULT_ACTIONS, checkSummary, carryExpectation, carryForward, fillStep, foldTopLevel,
  likelyValue, listActionBudget, listTimeoutMs, placeholderValue, stepPlaceholders,
} from './steps.js';
import {
  CLASS_CAPABILITY, LEVELS, SAFE_SUBMIT, capabilitiesOf, clampLevel, commitCandidate, guardrailPolicy, isLevel,
  labelClasses, labelSpellings, labelTier, levelFor, levelRank, paymentField, purchaseControl, purchasePage, secretAction,
} from './guardrails.js';
import { SiteRun, agentAddressed, mergeSite, resolveProfiles, statusFilter } from './domains.js';
import { scrubSecrets, secretIds } from './secrets.js';
import {
  DEFAULT_OPTION_CAP, bareLabel, capActions, capOffer, namedControls, rankActions, relevanceHints, relevanceScore,
} from './relevance.js';
import {
  MAX_OVERLAY_ACTIONS, MAX_OVERLAY_RETURNS, MAX_OVERLAY_WAITS, overlayDismissActions, overlayKey, overlayOf, overlayState,
} from './overlay.js';

// ---------------------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------------------

const MAX_OFFERED = 250; // non-terminal actions offered per decision, including reserved page actions
const MAX_CONTROLS = 100;
const MAX_OPTIONS = 30;
const MAX_ALLOWED_URLS = 10;
const MAX_RECOVERABLE_RETRIES = 2; // consecutive stale/target_unavailable retries before handing off
const NOOP_LIMIT = 3; // consecutive actions that leave the page unchanged
const SCREENSHOT_WAIT_MS = 5000; // safety cap; the bridge contract says the promise always resolves
const OFFER_CACHE_SIZE = 4;
const MAX_ALTERNATIVES = 5; // offered alternatives returned with a low_confidence handoff
const ANSWER_TIMEOUT_MS = 3000; // cap on provider.choose(), further bounded by the run's remaining time
const ANSWER_MIN_MS = 100; // below this much remaining time the provider is not asked
// An early answer ranking that failed with one of these is replaced by a serial one when time remains.
const EARLY_RETRY_CODES = new Set(['timeout', 'provider_error']);
// An instruction that reads a fact (Session.readClause): "read", "find", "report", "tell", "what ...".
const READ_CLAUSE = /\b(?:read|reads|find|report|tell|note|get|copy|extract|look up|check (?:what|which|how)|what|which|who|how (?:much|many|long|often))\b/i;
// Whether an instruction-only run asks anything (auto-confirm gate, instructionAsks): a real question mark, a wh-word
// or a read verb outside quoted labels and URLs ("Click the 'Where to?' field" asks nothing). A run that only performs
// actions ("Click Where to?, type London and choose London") keeps its ranked candidates but never auto-confirms one.
// Quoted labels in any common style; a single quote opens only after a non-letter (so "don't ... store's" is no quote).
const QUOTED = /(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])|"[^"\n]*"|‘[^’\n]*’|“[^”\n]*”|„[^“”\n]*[“”]|«[^»\n]*»|`[^`\n]*`|\[[^\]\n]*\]/gu;
const URLISH = /\b(?:https?:\/\/|www\.)\S+/gi;
// An unquoted label that ends in "?" mid-sentence: "the Where to? field" (the next word goes on in lower case).
const LABEL_QUESTION = /\b[A-Z][\p{L}'’]*(?:\s+[\p{L}'’]+){0,3}\?(?=\s*[a-z(,])/gu;
// A question about what to do, not what to read: "click Search, then what?", "what should I click?".
const WHAT_NEXT = /\b(?:(?:and|then|now|next|after that)\s+)what\s*\?|\bwhat\s+(?:next|now)\s*\?|\bwhat\s+(?:should|do|can|must)\s+(?:i|we|you)\s+(?:do|click|press|choose|select|pick|try)\b[^?]*\?/gi;
const FACT_NOUN = '(?:date|day|time|price|prices|fare|fares|cost|fee|total|amount|number|count|status|address|name|hours|rate|balance|value|stock|availability|seats?)';
const ASKS_RULES = [
  /\?/,
  /\b(?:what|which|who|whom|whose|how (?:much|many|long|often|far|old))\b/i,
  /\b(?:read|reads|report|tell|extract|look up|show me|give me|find out|let me know)\b/i,
  /\b(?:list|count|copy) (?:the|all|every|each|its|their|how)\b/i,
  /\bcompare (?:the|their|its|these|those|prices|fares)\b/i,
  /\b(?:check|see|verify|confirm) (?:whether|if)\b/i,
  new RegExp(`\\b(?:check|verify|confirm) (?:the |its |their )?(?:[\\p{L}-]+ ){0,3}${FACT_NOUN}\\b`, 'iu'),
  // get / find / note only with a fact as object: not "get to Settings", "find the Search box and click it", "note: ...".
  /\bget (?!(?:to|back|started|in|into|out|on|off|rid|past|through|there|here|going|signed|logged)\b)(?:the|me|a|an|its|their|his|her|our|your|all)\b/i,
  /\bnote (?!that\b)(?:the|down|its|their|all|which|what|how)\b/i,
  /\bfind (?!(?:and|then)\b)(?![^.;!?]*?\b(?:box|field|button|link|tab|menu|input|bar|dropdown|icon|checkbox|toggle|option)\b(?:\s*$|\s*[.;,]|\s+(?:and|then)\b))(?![^.;!?]*?\b(?:and|then|,)\s+(?:then\s+)?(?:click|press|tap|select|choose|open|type|fill|enter|hit|toggle|use)\b)/i,
];

/**
 * Whether an instruction asks something to read (Session.asks without answerQuestion): quoted labels, URLs, a label
 * ending in "?" mid-sentence and "then what?" left out, a question mark, a wh-word or a read verb remains.
 */
export function instructionAsks(instruction) {
  const text = String(instruction ?? '').replace(URLISH, ' ').replace(QUOTED, ' ').replace(WHAT_NEXT, ' ')
    .replace(LABEL_QUESTION, ' ');
  return ASKS_RULES.some(rule => rule.test(text));
}
const LATE_CAPTURE_MS = 1000; // capture 'last' after the time budget ran out: the lease is still valid
const MAX_QUESTION_LENGTH = 2000;
// Doneness. With a provider that reports `done` (a probability that the requested outcome is visible), a run
// completes when the expectation passes and done >= doneThreshold. Without an expectation, done >= this value ends
// the run as unverified.
const NO_EXPECTATION_DONE = 0.8;
// Consecutive decisions where the provider reports done but the expectation fails before the run returns
// unverified instead of spending the rest of the budget (usually a too-strict expectation).
const DONE_BUT_FAILING_LIMIT = 2;
// Consecutive strong-done decisions (done >= strongDone) with a failing expectation, after the late re-observe,
// before the run ends as expectation_mismatch although the provider chose to act.
const STRONG_FAILING_LIMIT = 2;
// Earlier pages summarized for multi-hop answers: the most recent pages before the final one, at most two lines
// each, and only blocks that match the question well (two rare question terms, roughly). A single common term,
// such as "plan" on every catalog row, scores under 1.
// The trail now comes from the run's fact memory (src/facts.js), keyed by semantic revision rather than URL, so
// same-URL states (single-page panels, a day list redrawn in place) count as earlier states too. The receipt keeps
// at most TRAIL_STATES states (the most relevant, shown in run order), TRAIL_LINES lines per state (all of a state's
// aggregation items, up to its memory bound, when the question aggregates) and TRAIL_TOTAL lines in all.
const TRAIL_STATES = 12;
// An earlier-state line that states a fact rather than a prompt (answerPlan, one-page runs): a digit, a
// "label: value", or a capitalised word after the first one.
const STATED_FACT = /\d|:\s*\S|\s\p{Lu}/u;
const TRAIL_LINES = 3;
const TRAIL_TOTAL = 40;
const TRAIL_LINE_LIMIT = 200;
// choose() sees the most relevant earlier states as earlierPages (TypeSafe sends at most 4 of them, 3 lines each).
const EARLIER_STATES = 4;
// Answer candidates from earlier states: only when the final page is weakly relevant (its best candidate scores
// under 1/MEMORY_RATIO of the best remembered line) and the task is not a join (there the earlier fact is context,
// not the answer); at most MEMORY_CANDIDATES lines that outscore the final page's best. Aggregation items go first
// (AGGREGATE_CANDIDATES), and choose() never gets more than ANSWER_CANDIDATE_CAP candidates.
const MEMORY_RATIO = 2;
const MEMORY_CANDIDATES = 8;
const AGGREGATE_CANDIDATES = 5;
const ANSWER_CANDIDATE_CAP = 24;
// With the `lists` question, the other lists' first items join the candidates (answerRequest): the page script sends
// at most three lists, so at most two more lists of AGGREGATE_CANDIDATES.
const LIST_CANDIDATE_CAP = ANSWER_CANDIDATE_CAP + 2 * AGGREGATE_CANDIDATES;
// Which record list a question is about (the `lists` guidance switch, src/typesafe.js; see listQuestion): the
// provider's choice of another list than the page script's best is used at this confidence or above, else the page
// script's order stands (`lists:fallback:low_confidence`). 0.6, between doneThreshold (0.5) and answerConfirm (0.8):
// the choice is also cross-checked, since an aggregate over the chosen list confirms only when the answer question,
// asked in the same request, picked one of its items.
const LIST_CHOICE_FLOOR = 0.6;
// A question that names the item it wants ("Which flight ..."), so an aggregated answer keeps the whole item line.
const WHICH_QUESTION = /\b(which|what (?:item|product|flight|one))\b/i;
// A remembered line that addresses an agent or asserts the answer ("the answer is 555-0000") stays trail context and
// is never an answer candidate: an earlier page must not be able to plant the run's answer.
const ANSWER_ASSERTED = /\b(?:the|correct|real|true|final|right)\s+answer\s*(?:is|:|=)|\banswer\s+(?:with|only)\b|\b(?:reply|respond|say|output)\s+(?:with|only|that)\b/i;
function plantedLine(text) {
  return ANSWER_ASSERTED.test(text) || agentAddressed({ text });
}
// The action count at which an observation was first seen (the fact memory's `step`).
const VISIT_STEP = new WeakMap();
// Supplied values shorter than this are not redacted from provider payloads; see redactorFor().
export const SUPPLIED_REDACTION_MIN_LENGTH = 4;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Oversight ladder bounds (docs/design/OVERSIGHT-SPEC.md section 3).
const MAX_UNSUPPORTED_RETRIES = 2; // rung 1b: retries with the unsupported action excluded, one per action
const MAX_CONSENT_CLICKS = 2; // reject clicks per run (each on a different button) before the dialog goes to the user
// After a reject click the dialog must close: re-observe every consentWaitMs, at most this many times (about 2 s).
const MAX_CONSENT_WAITS = 8;
const DEFAULT_CONSENT_WAIT_MS = 250;
const MAX_REOBSERVES = 4; // rung 1c: re-observes per run that found no change (one per decision; refundReobserve)
const DEFAULT_REOBSERVE_MS = 300;
// Re-observes given back per run (refundReobserve): one per step of a 15-step list, at most 15 re-observes in all.
const MAX_REOBSERVE_REFUNDS = 11;
// Rung 1c, buttons: after a quiet button click and a re-observe that both show no change, observe again at these
// fractions of lateChangeMs (default 3000: at 1.5 s and 3 s), leaving LATE_CHANGE_RESERVE_MS of the run's time.
const DEFAULT_LATE_CHANGE_MS = 3000;
const LATE_CHANGE_ROUNDS = Object.freeze([0.5, 1]);
const LATE_CHANGE_RESERVE_MS = 3000;
// Those rounds only after a click on a control that re-renders late (lateLook: a stepper arrow, a picker-open click, a
// control in an open dialog, a site profile's pinned control). Any other button gets one look this long after the
// re-observe, and only while the page shows work pending (its control disabled, a loading placeholder); else none.
const LATE_LOOK_SHORT_MS = 700;
// Late content: while the page shows a loading placeholder ("Loading reconciliation status…") on the final page or in
// a late-load task, the runtime re-observes after this delay, at most MAX_CONTENT_WAITS times per run (about 3 s),
// with no provider decision. Under a late-load intent a placeholder also fails the expectation (an implicit
// textAbsent), so such a run never completes on the pre-load text even when the host's expectation omits textAbsent.
const DEFAULT_CONTENT_WAIT_MS = 400;
const MAX_CONTENT_WAITS = 8;
// An in-place list expansion (completeList): "View more flights", "Show more", "Load more results", "Show 4 more";
// never pagination ("Next page", "More results" links are links and are never clicked by it), and never a label that
// names something other than list rows ("View more details", "Show more options", "Load more comments").
const IN_PLACE_MORE = /^(?:show|view|see|load)\s+(?:all\s+)?(?:\d+\s+)?more(?:\s+(?:flights|results|items|products|listings|rows|entries|offers|deals|fares|departures|connections|trains|buses|hotels|stays|properties|rooms))?$/iu;
// At most this many non-row blocks (a "Showing 10 of 24" line, a sort link) between a list's last row and its "more"
// button (moreExtendsItems).
const MORE_GAP_BLOCKS = 2;
const ROW_BLOCKS = new Set(['li', 'tr', 'dt', 'dd']);
const HEADING_BLOCKS = new Set(['h1', 'h2', 'h3', 'h4']);

// The expectation fields about the URL: the ones an in-place expansion that rewrites the URL carries forward.
const URL_FIELDS = new Set(['urlIncludes', 'urlEquals', 'urlMatches']);
// Of the texts a page showed before the runtime's own expand click, the share that must still be there afterwards.
const SAME_DOCUMENT_KEPT = 0.8;

/**
 * Whether the page after the runtime's own expand click is plainly the document that was verified before it, with
 * only its URL rewritten in place (Google's results page turns /travel/flights?q=... into /travel/flights/search?tfs=...
 * when "View more flights" is clicked): the same origin, the same leading content (the first text block, or the title
 * when the page has no blocks, still among the first three) and nearly everything it showed before (at least
 * SAME_DOCUMENT_KEPT of the earlier blocks' distinct texts) still on it. A real navigation to another page fails
 * this: a new heading or a list that replaced the rows loses the earlier texts.
 */
function sameDocumentExpanded(before, after) {
  let from;
  let to;
  try {
    from = new URL(String(before?.url ?? ''));
    to = new URL(String(after?.url ?? ''));
  } catch {
    return false;
  }
  if (from.origin !== to.origin) return false;
  const texts = observation => [...new Set(blocksOf(observation).map(block => block.text.trim()).filter(Boolean))];
  const earlier = texts(before);
  const later = texts(after);
  if (!earlier.length) return Boolean(before?.title) && before.title === after?.title;
  if (!later.slice(0, 3).includes(earlier[0])) return false;
  const shown = new Set(later);
  const kept = earlier.filter(text => shown.has(text)).length;
  return kept >= Math.ceil(earlier.length * SAME_DOCUMENT_KEPT);
}

/**
 * Whether an in-place "more" button (completeList) extends the list the answer reads: the run of rows directly above
 * the button (li/tr/dt blocks or answer items, back to the section heading, at most MORE_GAP_BLOCKS other blocks
 * between the last row and the button) holds one of the memory's aggregation items, or a row the question's filters
 * leave out (a 07:35 departure for "between 10:00 and 12:00": the hidden rows may be the ones in the window). A
 * "Show 4 more flights" under a flight list the ranking does not read leaves a date grid further up the page alone
 * (QA spa-toggle-date-grid). The rows directly below the button count the same way (a button above its list). A
 * button the blocks do not show (no page-script blocks), or a page where the answer reads no item yet, keeps the click.
 */
function moreExtendsItems(observation, action, memory, intent) {
  const blocks = blocksOf(observation);
  const label = String(action.label ?? '').trim().toLowerCase();
  let at = blocks.findIndex(block => block.ref !== undefined && block.ref === String(action.target));
  if (at < 0) at = blocks.findIndex(block => block.t === 'button' && block.text.toLowerCase() === label);
  if (at < 0) return true;
  const items = new Set((memory?.states ?? []).flatMap(state => state.lines.filter(line => line.item).map(line => line.key)));
  // No answer item read anywhere: nothing shows the button belongs to another list.
  if (!items.size) return true;
  const row = block => ROW_BLOCKS.has(block.t) || items.has(block.text.toLowerCase());
  const filtered = text => itemValue(text, intent) !== null && !passesFilters(text, intent);
  // The run of rows on one side of the button (step -1: above, the usual place; step 1: below, a button over its list).
  const extends_ = step => {
    let i = at + step;
    const inside = () => i >= 0 && i < blocks.length;
    for (let gap = 0; inside() && gap < MORE_GAP_BLOCKS && !row(blocks[i]) && !HEADING_BLOCKS.has(blocks[i].t); gap++) i += step;
    for (; inside() && row(blocks[i]); i += step) if (items.has(blocks[i].text.toLowerCase()) || filtered(blocks[i].text)) return true;
    return false;
  };
  return extends_(-1) || extends_(1);
}
// Consecutive unchanged content waits before a visible placeholder counts as persistent status text (awaitContent).
const PERSISTENT_QUIET_WAITS = 2;
// A handoff whose done is at most this, on a page where an expectation that already passed on the start page still
// passes, is a handoff to the host, not handoff_expectation_passed (Session.vacuousPass).
const PREPASS_DONE_MAX = 0.3;
const DEFAULT_TIMEOUT_MS = 30000;
const LONG_TASK_TIMEOUT_MS = 45000; // default for instructions that name 4 or more pages
const MAX_DECIDE_OPTIONS = 5;
// Provider guards (TypeSafe `blocked` / `injection` / `commit` nouls). At or above GUARD_VETO a guard acts: blocked
// ends the run as needs_user/blocked (after rung 0 had its chance), injection lets only a link to an approved origin
// run. `commit` (reversible mode) has its own threshold, thresholds.commitVeto (default 0.7): at or above it a chosen
// button/select/fill, or a handoff while such controls are offered (not on a page the injection guard scores at
// GUARD_VETO, whose text can push the commit noul either way), ends the run as needs_user/refused_action.
// At or above GUARD_NOTE the highest value per guard is listed in the receipt's `why` (guard:blocked:0.64); the
// injection guard is listed at or above INJECTION_NOTE (guard:injection:0.91), which also turns off the second
// opinion (in a self-rerun too), refuses auto-confirm of a remembered earlier-page answer, refuses placeholder fills
// (steps.js keys off the why line) and ends the site-profile fast path. Benign pages mostly score below 0.8 on
// injection, real injected instructions 0.96-0.99 (bench/jev-eval.mjs).
export const GUARD_VETO = 0.85;
const GUARD_NOTE = 0.5;
export const INJECTION_NOTE = 0.8;
const GUARD_NAMES = ['blocked', 'injection', 'commit', 'purchase_control', 'purchase_page'];
const LONG_TASK_HOPS = 4;
const SPLIT_HOPS = 3;

// In-call retries (run option `retry`, default on; docs/REFERENCE.md "In-call retries"): before handing a result
// back to the host, the runtime does the obvious next step itself. The bounds hold per call: a self-rerun shares them
// with the attempt it follows.
//   secondOpinion  links only: one more decide with the options in reverse order when a link choice is close to the
//                  next link (gap under thresholds.secondOpinionMargin) or below linkFloor, or a handoff is close to
//                  the best link. The agreed or more confident choice runs, but a second look can only pick a link
//                  (or hand off instead of a link): buttons, selects and fills keep the first decision, its floor and
//                  its alternatives. At most MAX_SECOND_OPINIONS per call.
//   backOut        read-only runs only: after a link landed on a page where the expectation fails and the provider
//                  handed off, navigate back to the page before the link once and decide again without that link.
//   rerun          read-only runs only: a result whose next step is `rerun` with a concrete suggested instruction
//                  (never after expectation_failed, _mismatch or _error) runs once in the same call with the host's own expectation and
//                  the remaining actions, decisions and time, and returns its result.
// Request cap: requestCap = maxDecisions + MAX_SECOND_OPINIONS + CALL_EXTRA_REQUESTS only stops retries from starting:
// no second opinion or rerun starts once the call has sent that many requests (Session.retryRoom). It is not a hard
// cap on the call. Decides stay within maxDecisions and second opinions within MAX_SECOND_OPINIONS, but answer
// rankings are not capped: per attempt an early ranking that is discarded plus its serial fallback can add 2, so a
// call with a self-rerun can send about maxDecisions + 6 requests (more if several early rankings are discarded).
// slim.terminal adds at most one more: its requests count against requestCap (they are provider requests like any
// other), a confirmed one replaces the full decide it ends the run with, and after the first fallback the call never
// sends another, so about maxDecisions + 7 with it on. Each site-profile fast hop and each stale re-resolve adds its
// slim guards request (site_guards / stale_guards) on top: about maxDecisions + 7 + fast hops + re-resolves.
// A run or list step that ends on its own expectation (endOnPass) sends step_guards instead of its terminal decide; a
// failed one falls back to that decide. A step list repeats the per-attempt ranking (2) and step_guards (1) per step:
// about maxDecisions + 3 x steps + 7 (MCP single run at maxActions 60: ~71; 15 steps at 60 actions: ~157, at 120: ~217).
export const RETRY_KINDS = Object.freeze(['secondOpinion', 'backOut', 'rerun']);
export const MAX_SECOND_OPINIONS = 2;
export const MAX_BACK_OUTS = 1;
export const MAX_RERUNS = 1;
const SECOND_OPINION_MIN_MS = 1000; // remaining run time below which no second opinion is asked
const BACK_OUT_MIN_MS = 2000; // remaining run time below which the runtime does not back out
const RERUN_MIN_MS = 5000; // remaining run time below which no self-rerun starts
// Step lists (run option `steps`, src/steps.js): below this much of the call's time no further step starts.
const LIST_STEP_MIN_MS = 1000;
// Answer rankings allowed for in requestCap (one per attempt); rankings themselves are not capped by it.
export const CALL_EXTRA_REQUESTS = 2;
// Step classes after which a back-out or a self-rerun is still free of side effects: links, scrolling, waiting and the
// runtime's consent reject clicks and nag-overlay dismissals. Any button, select or fill in the run rules both out.
const SIDE_EFFECT_FREE = new Set(['link', 'page', 'consent', 'dismiss']);
// The shared per-call retry counters travel to a self-rerun's configure() under this key, never from a caller.
const RETRY_STATE = Symbol('retryState');

/**
 * Resolve the `retry` run option: undefined or true turns every in-call retry on, false turns them all off, and an
 * object replaces single switches (`{"rerun": false}`). Unknown names and non-boolean values throw.
 */
export function resolveRetry(value) {
  if (value === undefined || value === null || value === true) return Object.fromEntries(RETRY_KINDS.map(kind => [kind, true]));
  if (value === false) return Object.fromEntries(RETRY_KINDS.map(kind => [kind, false]));
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('retry must be a boolean or an object');
  const resolved = Object.fromEntries(RETRY_KINDS.map(kind => [kind, true]));
  for (const [kind, flag] of Object.entries(value)) {
    if (!RETRY_KINDS.includes(kind)) throw new TypeError(`Unknown retry switch "${kind}"`);
    if (typeof flag !== 'boolean') throw new TypeError(`retry.${kind} must be a boolean`);
    resolved[kind] = flag;
  }
  return resolved;
}

// Slim provider requests (each switch measurable on its own; bench/request-size.mjs, bench/jev-eval.mjs --slim):
//   controls  every control sent once: offered links only as their option, with a relative path for the most
//             relevant, vague-labelled or same-labelled links; other controls without hrefs (src/typesafe.js
//             compactPlan). The runtime's own checks (labels, risk classes, origins, guards) read the full
//             observation and are unchanged.
//   terminal  on a page where the expectation already passes, first ask only done and the blocked/injection guards
//             (provider.confirm, no controls, no action question); the run completes there when done reaches
//             doneThreshold, otherwise the full decide follows as before (cost.requests kind `terminal`,
//             `fallback: true`; the fallback does not count against maxDecisions).
//   cap       at most DEFAULT_OPTION_CAP (40) non-terminal options per request: scrolling, waiting, explicit URLs,
//             consent buttons and links whose destination satisfies the expectation always, then the most relevant
//             to the instruction, answerQuestion and expectation (src/relevance.js capActions), in the offered order;
//             handoff stays last. Only the provider's request is capped: alternatives, decide options and act() keep
//             the full offered set. cost.requests records `optionsDropped`.
export const SLIM_KEYS = Object.freeze(['controls', 'terminal', 'cap']);
/** Defaults: off until the live gates (jev-eval accuracy, QA verified rate) confirm a switch. */
export const DEFAULT_SLIM = Object.freeze({ controls: false, terminal: false, cap: false });

/**
 * Resolve the `slim` run option: undefined → DEFAULT_SLIM, true/false → every switch on/off, an object →
 * DEFAULT_SLIM with those switches replaced. Unknown names and invalid values throw.
 */
export function resolveSlim(value) {
  if (value === undefined || value === null) return { ...DEFAULT_SLIM };
  if (typeof value === 'boolean') return Object.fromEntries(SLIM_KEYS.map(key => [key, value]));
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('slim must be a boolean or an object');
  const resolved = { ...DEFAULT_SLIM };
  for (const [key, flag] of Object.entries(value)) {
    if (!SLIM_KEYS.includes(key)) throw new TypeError(`Unknown slim switch "${key}"`);
    if (typeof flag !== 'boolean') throw new TypeError(`slim.${key} must be a boolean`);
    resolved[key] = flag;
  }
  return resolved;
}

/**
 * A `slim` value from command-line text: "on"/"off" (also true/false), a JSON object, or the comma-separated switches
 * to turn on, every other switch off ("controls"). Throws on unknown names.
 */
export function slimFromText(text) {
  const value = String(text ?? '').trim();
  if (/^(?:on|true|all)$/i.test(value)) return true;
  if (/^(?:off|false|none)$/i.test(value)) return false;
  if (value.startsWith('{')) {
    const parsed = JSON.parse(value);
    resolveSlim(parsed);
    return parsed;
  }
  const names = value.split(',').map(part => part.trim()).filter(Boolean);
  if (!names.length) throw new TypeError('slim names no switch');
  for (const name of names) if (!SLIM_KEYS.includes(name)) throw new TypeError(`Unknown slim switch "${name}"`);
  return Object.fromEntries(SLIM_KEYS.map(key => [key, names.includes(key)]));
}

const CAPTURE_POLICIES = new Set(['each', 'last', 'none']);
// The capability a refused intent (commitIntent) needs, for the level a refusal names when no blocked control does.
const INTENT_CAPABILITY = Object.freeze({
  purchase: 'purchase', delete: 'delete', send: 'submit', submit: 'submit', login: 'sign_in',
});

/** The lowest level above `level` with `capability`, or null. */
function nextLevelFor(capability, level) {
  const needed = capability ? levelFor(capability) : null;
  return needed && levelRank(needed) > levelRank(level) ? needed : null;
}
const MODES = new Set(LEVELS);

// Label heuristic for submissions and account changes (DANGEROUS in src/oversight.js). Applied to buttons and custom
// dropdown options; link text such as "Payments" or "Resend history" is navigation, so links go through the anchored
// destructiveLink rule instead ("Delete account", "Sign out" and "Proceed to checkout" are never offered, "Order
// history" and "How to delete your account" are). The page script's own `risk` classification applies to every
// control, including links.
export { DANGEROUS, REFUSAL_TEXT };
// Commit actions (orders, bookings, payments, subscriptions, applications, transfers), buttons only: COMMIT_ACTION in
// src/oversight.js, identical to extension/page.js (drift check in test/jev-commit.test.js).
export { COMMIT_ACTION };

const TEXT_TYPES = new Set(['text', 'email', 'search', 'tel', 'url', 'number', 'textarea']);
const TOGGLE_TYPES = new Set(['checkbox', 'radio']);
const MENU_ITEM_ROLES = new Set(['menuitem', 'menuitemcheckbox', 'menuitemradio']);
const CHECKABLE_ROLES = new Set(['checkbox', 'radio', 'menuitemcheckbox', 'menuitemradio']);

function originOf(url) {
  return new URL(url).origin;
}

/** True when the URL's origin is covered by the approved origins (exact entries and domain roots, src/origins.js). */
function allowedOrigin(url, origins) {
  return urlCovered(url, origins ?? []);
}

/**
 * A consent reject button the runtime may click: it is one of the observation's controls, the page script does
 * not refuse it (accept buttons carry risk 'destructive'), and a link form stays on an approved origin
 * (script links such as href="javascript:void(0)" or "#" are fine; they do not navigate away).
 */
function consentClickable(action, observation, config) {
  const control = (observation.controls ?? []).find(item => String(item?.id) === action.target);
  if (!control) return false;
  if (control.risk === 'submit' || control.risk === 'destructive') return false;
  // An accept button (risk consent_accept from the page script) only at a level with consent_accept (full).
  if (control.risk === 'consent_accept' && !config.capabilities?.has('consent_accept')) return false;
  if (control.risk !== undefined && !['reversible', 'navigation', 'consent_accept'].includes(control.risk)) return false;
  if (control.href) {
    let url;
    try {
      url = new URL(control.href, observation.url);
    } catch {
      return false;
    }
    if (/^https?:$/.test(url.protocol) && !originCovered(url.origin, config.allowedOrigins ?? [])) return false;
  }
  return true;
}

function safeOrigin(url) {
  try {
    return originOf(url);
  } catch {
    return null;
  }
}

/** True for a page on a consent.* host (consent.google.com), the only source of a followed redirect. */
function consentContinueHost(url) {
  try {
    return /^consent\./i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

function sameOrigin(url, origin) {
  try {
    return originOf(url) === origin;
  } catch {
    return false;
  }
}

function clip(value, limit) {
  return String(value ?? '').slice(0, limit);
}

// ---------------------------------------------------------------------------------------------------------------
// Legal actions
// ---------------------------------------------------------------------------------------------------------------

function terminalActions() {
  return [
    {
      id: 'done',
      type: 'done',
      label: 'done',
      description: 'The requested outcome is already visible; finish so it can be verified.',
    },
    {
      id: 'handoff',
      type: 'handoff',
      label: 'handoff',
      description: 'Stop for host interpretation or user input.',
    },
  ];
}

function isTextEntry(control) {
  if (TOGGLE_TYPES.has(control.type)) return false;
  if (control.role === 'textbox') return true;
  // An autocomplete combobox is a text input; a <select> combobox carries options instead. A combobox the page script
  // reports as not editable (a div role=combobox that opens a list, "Round trip") is clicked instead.
  if (control.role === 'combobox' && control.editable === false) return false;
  return control.role === 'combobox' && !control.options?.length && (!control.type || TEXT_TYPES.has(control.type));
}

// A date- or time-ish field name or placeholder: a field whose click usually opens a picker.
const PICKER_FIELD = /\b(?:dates?|day|departure|departing|depart|return(?:ing)?|check[\s-]?in|check[\s-]?out|arrival|arrive|time|calendar|when|dd[/.-]mm|mm[/.-]dd|yyyy)\b/i;
const PICKER_TYPES = new Set(['date', 'datetime-local', 'month', 'week', 'time']);

/**
 * A text entry the page script says a click opens (read-only, aria-haspopup, inputmode=none: `opens`), a combobox, a
 * date or time input, or a field whose label or placeholder names a date or time: legalActions also offers its click.
 */
export function opensOnClick(control, label = control?.label) {
  if (!control || control.type === 'password') return false;
  if (control.opens === true || control.role === 'combobox' || PICKER_TYPES.has(control.type)) return true;
  return PICKER_FIELD.test(String(label ?? '')) || PICKER_FIELD.test(String(control.placeholder ?? ''));
}

// Supplied values whose name says they are secrets (password, pin, token, ...). Such a value is treated like a password
// fill wherever it goes: the step never records it and it is redacted from the receipt and the trace.
const SECRET_NAME = /pass|pwd|^pw$|secret|otp|token|api[\s_-]?key|credential|^pin$|[_-]pin$/i;
// A non-password field that is meant to take a secret (a shown password, a PIN, an API key or one-time code field).
const SECRET_FIELD = /pass(?:word|code|phrase)|\bpwd\b|\bpin\b|secret|\btoken\b|api[\s_-]?key|one[\s-]?time|\botp\b/i;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a secret supplied value may be offered for a non-password field: the field looks like one meant for a
 * secret, or the instruction explicitly puts this value into this field ("fill Username with the supplied password",
 * "type the password into API key"). A login page then offers the password for the password field only, which also
 * keeps the provider's choice between fills unambiguous.
 */
function secretFillAllowed(control, name, instruction) {
  const label = String(control.label ?? '').replace(/\s+/g, ' ').trim();
  if (SECRET_FIELD.test(label)) return true;
  if (typeof instruction !== 'string' || label.length < 3) return false;
  const field = escapeRegExp(label);
  const value = escapeRegExp(name);
  const filler = '(?:the\\s+)?(?:(?:supplied|given|provided|test)\\s+)?';
  return new RegExp(`${field}(?:\\s+field)?\\s+with\\s+${filler}${value}\\b`, 'i').test(instruction)
    || new RegExp(`\\b${value}(?:\\s+value)?\\s+(?:in|into)\\s+(?:the\\s+)?${field}`, 'i').test(instruction);
}

function isToggle(control) {
  return CHECKABLE_ROLES.has(control.role) || TOGGLE_TYPES.has(control.type);
}

/**
 * The run's guardrail policy: `options.guardrails` when it is one already (configure() builds it), else one built
 * from the level and raw additions (`options.policy` per request, `options.guardrails` from config).
 */
function policyOf(options) {
  if (typeof options?.guardrails?.forbids === 'function') return options.guardrails;
  return guardrailPolicy({
    level: isLevel(options?.mode) ? options.mode : 'read-only',
    request: options?.policy,
    config: options?.guardrails,
  });
}

// The capability a page-script risk class needs. `destructive` (a label the request's additions forbid, or an older
// page script's block) and any unknown class need one nothing grants.
const RISK_CAPABILITY = Object.freeze({
  purchase: 'purchase', submit: 'submit', delete: 'delete', sign_in: 'sign_in', consent_accept: 'consent_accept',
});

/**
 * Page facts the per-control gate needs once per observation: whether the page shows a password or payment field
 * (a form submit is `submit_safe` only without them).
 */
function pageFacts(observation) {
  const controls = observation?.controls ?? [];
  const password = loginState(observation).passwordField;
  const payment = controls.some(control => control?.visible !== false && paymentField(control));
  // The Approve gate's purchase page (src/guardrails.js purchasePage): a payment field, a purchase path or a total.
  let path = '';
  try {
    path = new URL(observation?.url ?? '').pathname;
  } catch {
    // No path: the other signals decide.
  }
  const purchase = purchasePage({ path, text: typeof observation?.text === 'string' ? observation.text : '', payment });
  return { sensitiveForm: password || payment, payment, password, purchasePage: purchase };
}

/**
 * A control under the Approve gate's purchase-page rule (src/guardrails.js purchaseControl; page.js applies the same
 * rule itself): on a purchase page a button, script link or submit inside the checkout region (the page script's
 * `region: 'checkout'`) or with a commit-like label is a purchase, unless it backs out, steps a quantity or sits in
 * navigation or a search form (`region: 'navigation'`). Returns the control (a copy with `risk: 'purchase'`, `gate:
 * 'purchase'` when the rule applies).
 */
function gatedControl(control, facts) {
  if (!facts.purchasePage || !control || control.consent) return control;
  const role = control.role || 'control';
  // Buttons, script links and submits; an option only selects (a plan picker's choice is not the purchase).
  const button = role === 'button' || role === 'tab' || (role === 'link' && !control.href) || control.type === 'submit';
  if (!button || isTextEntry(control) || control.options?.length || isToggle(control)) return control;
  if (['purchase', 'destructive', 'sign_in', 'consent_accept'].includes(control.risk)) return control;
  if (!purchaseControl(control.label, { checkout: control.region === 'checkout', navigation: control.region === 'navigation' })) return control;
  return { ...control, risk: 'purchase', gate: 'purchase' };
}

/** Whether a control is a credential action (the page script's `gate: 'secret'`, or SECRET_ACTION on its label). */
function secretGated(control) {
  return control?.gate === 'secret' || (control?.role !== 'link' && secretAction(control?.label));
}

/**
 * The Approve gate class of a control on a host-driven offer: 'purchase' (refused below testing; approvable from
 * full), 'secret' (a credential action: asks at every level, testing included), 'delete' or 'submit' (above the
 * granted level), or null when the control is offered as usual or refused as before. Never a field, a select, a
 * real link, a sign-in or consent control, a label the user forbade, a page-script block or a search submit (which
 * keeps its level request). Read-only offers nothing to approve.
 */
function approvalGate(control, block, guard, asks = APPROVAL_ASKS) {
  if (!guard.allows('controls') || !control) return null;
  const role = control.role || 'control';
  if ((role === 'link' && control.href) || isTextEntry(control) || control.options?.length || control.consent
    || control.type === 'password' || control.sensitive || paymentField(control)) return null;
  // The user's settings in the extension (reported to the daemon): a class they do not want to be asked about is never
  // marked "(asks the user)"; it is refused, or for a credential action run at its level, as before the gate.
  const secret = secretGated(control) && asks.secret;
  if (!block) return secret ? 'secret' : null;
  if (block.kind === 'purchase') return asks.purchase && guard.allows('submit') && !guard.testing ? 'purchase' : null;
  if ((block.kind === 'delete' || block.kind === 'submit') && block.capability && block.capability !== 'submit_safe') {
    return secret ? 'secret' : asks.level ? block.kind : null;
  }
  return null;
}

/** The Approve gate's asks when the extension reported none (an older one): every class asks. */
export const APPROVAL_ASKS = Object.freeze({ purchase: true, secret: true, level: true });

/** The asks the extension reported ({purchase, secret, level} booleans), every missing one on. */
export function cleanAsks(value) {
  return { purchase: value?.purchase !== false, secret: value?.secret !== false, level: value?.level !== false };
}

// Secret handles (docs/REFERENCE.md "Secret handles"): per field that takes a secret, the newest handles offered as
// fills; copies offered per handle. Each asks the user every time, whatever the settings.
const SECRET_FILL_HANDLES = 3;
const SECRET_FILL_FIELDS = 3;
const SECRET_COPY_HANDLES = 3;

/** The vault the worker reported with the observation: [{handle, kind, origin, label}], handles as digit strings. */
function vaultSecrets(observation) {
  const list = Array.isArray(observation?.secrets) ? observation.secrets : [];
  return list.filter(item => item && typeof item.handle === 'string' && /^\d{1,4}$/.test(item.handle)).slice(0, 10)
    .map(item => ({ handle: item.handle, kind: typeof item.kind === 'string' ? item.kind : 'generic',
      origin: typeof item.origin === 'string' ? item.origin : null, label: clip(item.label, 120) || `[secret:${item.handle}]` }));
}

const SECRET_KIND_WORDS = Object.freeze({ password: 'password', 'private-key': 'private key', totp: 'TOTP seed',
  'recovery-code': 'recovery code', jwt: 'token', generic: 'secret' });

/** A secret's source for a description: "openai key from platform.openai.com". */
export function secretSource(secret) {
  let host = '';
  try {
    host = new URL(secret.origin).host;
  } catch {
    // No origin: the kind alone.
  }
  const kind = typeof secret.kind === 'string' && secret.kind ? secret.kind : 'generic';
  const words = SECRET_KIND_WORDS[kind] ?? `${kind} key`;
  return `${words}${host ? ` from ${host}` : ''}`;
}

// The intent question (guidance switch `intent`, src/typesafe.js; tiers in src/guardrails.js labelTier): a refused
// control whose label trips only ambiguous words is offered to the provider's own choice, at most INTENT_LIMIT per
// decision (the ones the instruction names most), each with one `choice` question in the same request: what would
// activating it do? It runs only when Session.intentVerdict clears it: an answer in INTENT_CLASSES whose capability
// the level holds, at confidence INTENT_FLOOR or more, purchase_or_payment below INTENT_DOUBT, both purchase nouls
// and the injection noul answered and low, no payment or password field, a label in the ambiguous tier that the
// user did not forbid. Anything else, an unanswered question or a failed request included, refuses it as before.
// INTENT_FLOOR is above GUARD_VETO (owner's call, 2026-10-11): clearing a flag takes more confidence than a guard needs
// to act on its own, and any doubt refuses as before.
export const INTENT_LIMIT = 2;
export const INTENT_FLOOR = 0.9;
export const INTENT_DOUBT = 0.1;
// The capability each answer needs; purchase_or_payment has none below testing.
export const INTENT_CLASSES = Object.freeze({
  select_option_or_navigate: 'controls', marketing_or_discount_text: 'controls', submit_or_send_user_data: 'submit',
  change_account_settings: 'submit', purchase_or_payment: null,
});

/**
 * True for a refused control Jev may clear (the ambiguous tier): a button, option or menu item the level refuses for
 * its label class (submit or purchase) alone, below testing with controls, whose label is in the ambiguous tier and not one
 * the user forbade; not a text entry, select, consent button, password or payment field, and not on a page with a
 * password or payment field. A page-script risk counts only with the script's own `ambiguous` mark (a form submit or
 * a payment form never carries it); without a risk (an SDK bridge), a submit-type control is never one.
 */
function intentEligible(control, block, guard, facts) {
  if (!block?.capability || !['submit', 'purchase'].includes(block.kind)) return false;
  if (guard.testing || !guard.allows('controls') || guard.forbids(control.label) || facts.sensitiveForm) return false;
  const role = control.role || 'control';
  if (!['button', 'option'].includes(role) && !MENU_ITEM_ROLES.has(role)
    || isTextEntry(control) || control.options?.length || control.consent) return false;
  if (control.type === 'password' || control.sensitive || paymentField(control)) return false;
  if (control.risk !== undefined ? control.ambiguous !== true : control.type === 'submit') return false;
  return labelTier(control.label) === 'ambiguous' && labelClasses(control.label).includes(block.kind);
}

/**
 * The capability pressing Enter in a filled text field needs, from the page script's `enter` class (what its form
 * submit amounts to): submit_safe (a search form, interactive) only on a page without password or payment fields,
 * submit for any other form (full), sign_in or purchase for such forms; null when Enter submits nothing or the
 * request's additions forbid it.
 */
function enterCapability(control, facts) {
  switch (control.enter) {
    case 'submit_safe':
      return facts.sensitiveForm ? 'submit' : 'submit_safe';
    case 'submit':
      return 'submit';
    case 'sign_in':
    case 'purchase':
      return control.enter;
    default:
      return null;
  }
}

/** True for a form submit the page script flags whose label only reads (SAFE_SUBMIT) on a page without such fields. */
function safeSubmit(control, facts) {
  return !facts.sensitiveForm && labelSpellings(control.label).some(text => SAFE_SUBMIT.test(text));
}

/**
 * Why a control is refused at this level: `{ kind, capability }`, or null when it may be offered. `kind` is the
 * label or risk class (purchase, forbid, sign_in, delete, submit, consent_accept, risk); `capability` is what would
 * allow it (null: nothing does, for a `forbid` addition or a page-script block). Checks, in order: the request's
 * additions (every role), links that are actions (destructiveLink), password and payment fields, the page script's
 * risk class and the label classes (buttons, options, menu items, text entries, selects; `labelled` decides for other roles).
 */
function controlBlock(control, guard, facts, { labelled } = {}) {
  if (guard.forbids(control.label)) return { kind: 'forbid', capability: null };
  const role = control.role || 'control';
  if (role === 'link') {
    const kind = labelSpellings(control.label).map(destructiveLinkClass).find(Boolean);
    if (kind && !guard.allows(CLASS_CAPABILITY[kind])) return { kind, capability: CLASS_CAPABILITY[kind] };
  }
  if (control.type === 'password' && !guard.allows('sign_in')) return { kind: 'sign_in', capability: 'sign_in' };
  if (role !== 'link' && paymentField(control) && !guard.allows('purchase')) {
    return { kind: 'purchase', capability: 'purchase' };
  }
  const risk = control.risk ?? (control.type === 'submit' ? 'submit' : undefined);
  if (risk !== undefined && risk !== 'reversible' && risk !== 'navigation') {
    let capability = Object.hasOwn(RISK_CAPABILITY, risk) ? RISK_CAPABILITY[risk] : null;
    if (risk === 'submit' && !guard.allows('submit') && guard.allows('submit_safe') && safeSubmit(control, facts)) {
      capability = 'submit_safe';
    }
    if (!capability) return { kind: 'risk', capability: null };
    if (!guard.allows(capability)) return { kind: risk, capability };
  }
  const checkLabel = labelled ?? (role === 'button' || role === 'tab' || role === 'option' || role === 'combobox' || isTextEntry(control)
    || MENU_ITEM_ROLES.has(role) || Boolean(control.options?.length));
  if (role !== 'link' && checkLabel) {
    const kind = guard.blocks(control.label);
    if (kind) return { kind, capability: CLASS_CAPABILITY[kind] };
  }
  return null;
}

/** Why an option of a custom dropdown or select is refused (label classes and additions), or null. */
function optionBlock(option, guard) {
  const kind = guard.blocks(option.label);
  return kind ? { kind, capability: CLASS_CAPABILITY[kind] } : null;
}

/**
 * Build the actions a provider (or host) may choose from at the run's level. Every action is something the
 * extension is expected to accept: links only to the current page's origin, nothing the page script marks as a
 * class the level does not allow, and text fills only with caller-supplied values, referenced by name.
 *
 * Supplied text values are never placed in the returned actions; `fill_supplied_text` carries `suppliedName` and
 * the runtime resolves the value at execution time. A fill into a password input (offered only with `sign_in`)
 * carries `sensitive: true`, and its value is redacted from the step, the receipt and the trace.
 */
export function legalActions(observation, options = {}) {
  return offeredActions(observation, options).actions;
}

/**
 * legalActions with the count of control actions the MAX_OFFERED cap left out: `{ actions, dropped }`. Above the
 * cap the most relevant actions stay (src/relevance.js capActions, hints from `options.hints` or the instruction,
 * answerQuestion and expectation), never just the first ones; page actions always stay.
 */
/**
 * Controls inside a popup over the page that is not a task dialog (page.js marks them `overlay: true`, src/overlay.js)
 * are offered after the main content's controls, described as such, so a decision prefers the page under the popup.
 * In place; the order within each group is kept.
 */
function markOverlayActions(observation, actions) {
  const inside = new Set((observation.controls ?? []).filter(control => control?.overlay === true).map(control => String(control.id)));
  if (!inside.size) return;
  const main = [];
  const popup = [];
  for (const action of actions) {
    if (action.target !== undefined && inside.has(String(action.target))) {
      action.overlay = true;
      action.description = `${action.description} (inside a popup over the page)`;
      popup.push(action);
    } else {
      main.push(action);
    }
  }
  actions.splice(0, actions.length, ...main, ...popup);
}

/** Open floating menus and task overlays are the current task: their choices precede and survive background actions. */
function markFloatingActions(observation, actions) {
  const inside = new Set((observation.controls ?? []).filter(control => control?.floating === true).map(control => String(control.id)));
  if (!inside.size) return;
  const floating = [];
  const background = [];
  for (const action of actions) {
    if (action.target !== undefined && inside.has(String(action.target))) {
      action.floating = true;
      action.description = `${action.description} (in an open floating menu or overlay)`;
      floating.push(action);
    } else {
      background.push(action);
    }
  }
  actions.splice(0, actions.length, ...floating, ...background);
}

export function offeredActions(observation, options = {}) {
  // The capability set of the level (src/guardrails.js) plus the additions (extra forbidden labels, every role).
  const guard = policyOf(options);
  const controls = guard.allows('controls');
  const facts = pageFacts(observation);
  let leaseOrigin = null;
  try {
    leaseOrigin = originOf(observation.url);
  } catch {
    // An unparsable page URL yields no link or navigation actions.
  }
  const allowedOrigins = options.allowedOrigins ?? (leaseOrigin ? [leaseOrigin] : []);
  const suppliedText = Object.entries(options.suppliedText ?? {}).filter(([, value]) => typeof value === 'string');
  const secretNames = new Set(suppliedText.map(([name]) => name).filter(name => SECRET_NAME.test(name)));
  // The Approve gate's asks (`approvals`: true, or the extension's reported settings) and the secret handles it may
  // offer (host-driven offers only, from reversible).
  const asks = options.approvals ? (typeof options.approvals === 'object' ? cleanAsks(options.approvals) : APPROVAL_ASKS) : null;
  const secrets = asks && controls ? vaultSecrets(observation) : [];
  let secretFields = 0;

  // Links are offered only on the approved site: to the current page's origin, or (with a domain root the user
  // approved) to another https subdomain of the same root. The extension refuses any other link click.
  const linkAllowed = href => Boolean(href) && Boolean(leaseOrigin) && sameSite(observation.url, href, allowedOrigins);
  // A link inside an approved cross-origin frame (extension/frames.js, `frameOrigin`) that navigates only a frame
  // must land on an approved origin (the frame stays readable); one that navigates the tab (_top, or _parent from a
  // frame directly under the page) follows the page's rule above. The frame's page script checks the same again at dispatch.
  const frameLinkAllowed = control => {
    const target = String(control.linkTarget ?? '').toLowerCase();
    // _parent navigates the tab only from a frame whose parent is the top document (frameDepth 1), as page.js checks.
    if (target === '_top' || (target === '_parent' && control.frameDepth === 1)) return linkAllowed(control.href);
    return Boolean(control.href) && Boolean(leaseOrigin) && (sameSite(control.frameOrigin, control.href, allowedOrigins)
      || allowedOrigin(control.href, allowedOrigins));
  };

  const controlActions = [];
  const intentActions = [];
  for (const control of (observation.controls ?? []).slice(0, MAX_CONTROLS)) {
    if (control.enabled === false || control.visible === false) continue;
    // A field that takes a secret (the page script's secretTarget): the newest handles, as fills the user approves.
    if (secrets.length && control.secretTarget === true && !control.sensitive && secretFields < SECRET_FILL_FIELDS
      && !guard.forbids(control.label) && !paymentField(control)) {
      secretFields++;
      const ref = String(control.id);
      const role = control.role || 'textbox';
      const label = clip(control.label, 180) || `unlabelled ${role} ${ref}`;
      for (const secret of secrets.slice(0, SECRET_FILL_HANDLES)) {
        controlActions.push({ type: 'fill_secret', target: ref, role, label, handle: secret.handle, secretLabel: secret.label,
          source: secretSource(secret), needsApproval: 'secret',
          description: `Fill ${role} ${ref}: ${label} with secret:${secret.handle} (${secretSource(secret)}; the value stays hidden) (asks the user)` });
      }
    }
    const password = control.type === 'password';
    // A sensitive control is never offered; a password input only as a fill target with sign_in (testing).
    if (control.sensitive && !password) continue;
    if (password && !(controls && guard.allows('sign_in'))) continue;
    const ref = String(control.id);
    const role = control.role || 'control';
    // A control is never offered with an empty label: the page script names unnamed controls itself ("unlabelled
    // button 1 of 2 next to ..."); an observation without one (an older page script, an SDK bridge) gets its role and ref.
    const label = clip(control.label, 180) || `unlabelled ${role} ${ref}`;
    const block = controlBlock(gatedControl(control, facts), guard, facts);
    // The Approve gate (host-driven offers only): a control the user may approve once is offered, marked.
    const gate = asks ? approvalGate(gatedControl(control, facts), block, guard, asks) : null;
    if (block && gate) {
      controlActions.push({ type: 'click', target: ref, role, label, needsApproval: gate,
        description: `Click ${role} ${ref}: ${label} (asks the user)` });
      continue;
    }
    // A credential action runs only with an approval (page.js refuses it otherwise): never offered to a run, unless
    // the user turned that ask off (the extension then runs it at its level).
    if (!(asks && !asks.secret) && !gate && !block && secretGated(control) && controls && !isTextEntry(control) && !control.options?.length
      && !(role === 'link' && control.href)) continue;
    if (block) {
      // An ambiguous refused control (intentEligible) is offered with the intent question when the switch is on.
      if (options.intent && intentEligible(control, block, guard, facts)) {
        intentActions.push({ type: 'click', target: ref, role, label, intent: { kind: block.kind, capability: block.capability },
          description: `Click ${role} ${ref}: ${label} (refused unless Jev clears it)` });
      }
      continue;
    }
    const base = { target: ref, role, label };
    // The label is the page script's descriptor (no name of its own): never a control the instruction names.
    if (control.unnamed === true) base.unnamed = true;

    if (role === 'link') {
      const frameTarget = String(control.linkTarget ?? '').toLowerCase();
      if (frameTarget && !['_self', '_parent', '_top'].includes(frameTarget)) {
        // Clicking would open a new tab, which the extension refuses (child_tab). A same-origin, approved href can
        // still be opened in the selected tab: the same navigation, without a tab the lease does not cover.
        if (linkAllowed(control.href)) {
          controlActions.push({
            type: 'navigate_allowed_url',
            url: control.href,
            label,
            newTab: true,
            description: `Open link ${ref}: ${label} in this tab (it would open a new tab)`,
          });
        }
        continue;
      }
      // Read-only: real same-origin links only. With controls: also script links without an href.
      const admitted = typeof control.frameOrigin === 'string' ? frameLinkAllowed(control) : linkAllowed(control.href);
      if (admitted || (controls && !control.href)) {
        const action = { type: 'click', ...base, description: `Click link ${ref}: ${label}` };
        if (control.href) action.href = control.href;
        controlActions.push(action);
      }
      continue;
    }
    if (!controls) continue;
    // A file input: only an upload of a file from the host's workspace (Act and Test site), which the user approves
    // each time (the card names the file, its size and the site); never a fill.
    if (control.type === 'file') {
      if (asks && guard.allows('submit') && !guard.forbids(control.label)) {
        controlActions.push({ type: 'upload', ...base, needsApproval: 'submit',
          description: `Upload a file to ${role} ${ref}: ${label} (act with path; asks the user)` });
      }
      continue;
    }

    if (password || isTextEntry(control)) {
      for (const [name] of suppliedText) {
        const secret = secretNames.has(name);
        // When the host named a secret value, a password field takes only secret values (never the username).
        if (password && secretNames.size && !secret) continue;
        // A secret value goes into a non-password field only when that field is meant for one or the instruction
        // asks for exactly that fill (test accounts sometimes need it).
        if (!password && secret && !secretFillAllowed(control, name, options.instruction)) continue;
        const action = {
          type: 'fill_supplied_text',
          ...base,
          suppliedName: name,
          description: `Fill ${password ? 'password field' : role} ${ref}: ${label} with supplied value ${name}`,
        };
        if (password || secret) action.sensitive = true;
        controlActions.push(action);
      }
      // Host-driven control: a fill whose text the host gives with the act (`text`), into an ordinary text field only:
      // never a password, payment or secret field (secrets go through fill_secret) or a sensitive one.
      if (options.agentText && !password && !control.sensitive && control.secretTarget !== true && !paymentField(control)) {
        controlActions.push({ type: 'fill', ...base, description: `Fill ${role} ${ref}: ${label} with text the host gives` });
      }
      // A field that opens a picker on click (a date textbox, an autocomplete combobox) is also clicked: focus and
      // open only, no typing. Never a password field.
      if (!password && opensOnClick(control, label)) {
        controlActions.push({ type: 'click', ...base, opens: true, description: `Click ${role} ${ref}: ${label} (opens it, no typing)` });
      }
      // Host-driven control: press Enter in a filled field (a search box), gated as the submit it is (enterCapability).
      if (options.enterSubmit && !password && control.filled === true) {
        const need = enterCapability(control, facts);
        if (need && guard.allows(need)) {
          controlActions.push({ type: 'submit_field', ...base, submits: need,
            description: `Press Enter in ${role} ${ref}: ${label} (submits it${need === 'submit_safe' ? ': a search' : ''})` });
        }
      }
      continue;
    }
    if (control.options?.length) {
      for (const option of control.options.slice(0, MAX_OPTIONS)) {
        if (option.disabled) continue;
        if (option.value === control.selectedValue) continue;
        if (optionBlock(option, guard)) continue;
        controlActions.push({
          type: 'select',
          ...base,
          value: option.value,
          optionLabel: clip(option.label, 120),
          description: `Select "${clip(option.label, 120)}" in ${role} ${ref}: ${label}`,
        });
      }
      continue;
    }
    // Buttons, checkboxes, radios and other clickable roles.
    const toggle = isToggle(control);
    const selection = role === 'tab';
    const state = (toggle || selection) && typeof control.checked === 'boolean'
      ? ` (currently ${selection ? (control.checked ? 'selected' : 'unselected') : (control.checked ? 'checked' : 'unchecked')})`
      : '';
    const action = { type: 'click', ...base, description: `Click ${role} ${ref}: ${label}${state}` };
    if ((toggle || selection) && typeof control.checked === 'boolean') action.checked = control.checked;
    if (gate) {
      action.needsApproval = gate;
      action.description += ' (asks the user)';
    }
    controlActions.push(action);
  }
  // The ambiguous refused controls the instruction names most (relevanceScore above 0), at most INTENT_LIMIT, after
  // the usable controls: one the instruction does not name is never worth a question.
  if (intentActions.length) {
    const hints = options.hints ?? relevanceHints({
      instruction: options.instruction, answerQuestion: options.answerQuestion, expectation: options.expectation,
    });
    const named = rankActions(intentActions.filter(action => relevanceScore(action, hints) > 0), hints);
    controlActions.push(...named.slice(0, INTENT_LIMIT));
  }
  markOverlayActions(observation, controlActions);
  markFloatingActions(observation, controlActions);

  // Page-level actions are reserved so they survive the cap on busy pages. The browser's own error page has nothing to
  // scroll (no page script runs there): only wait, history moves and approved URLs apply.
  const reserved = [
    ...(observation?.browserErrorPage === true ? [] : [
      { type: 'scroll', direction: 'down', label: 'scroll down', description: 'Scroll down to see more of the page' },
      { type: 'scroll', direction: 'up', label: 'scroll up', description: 'Scroll up' },
    ]),
    { type: 'wait', label: 'wait', description: 'Wait briefly for page content to finish loading' },
  ];
  // A secret handle onto the OS clipboard (local programs, the agent included, can read it), approved each time.
  for (const secret of secrets.slice(0, SECRET_COPY_HANDLES)) {
    reserved.push({ type: 'copy_secret', handle: secret.handle, label: secret.label, source: secretSource(secret), needsApproval: 'secret',
      description: `Copy secret:${secret.handle} (${secretSource(secret)}) to the clipboard (asks the user)` });
  }
  for (const url of (options.allowedUrls ?? []).slice(0, MAX_ALLOWED_URLS)) {
    // The extension only navigates within the selected origin, or its approved domain root.
    if (leaseOrigin && sameSite(observation.url, url, allowedOrigins)) {
      reserved.push({
        type: 'navigate_allowed_url',
        url,
        label: url,
        description: `Navigate to explicitly supplied URL ${url}`,
      });
    }
  }

  const exclude = options.exclude;
  const keep = action => !exclude?.size || !exclude.has(actionKey(action));
  let offered = [...controlActions.filter(keep), ...reserved.filter(keep)];
  // Controls past MAX_CONTROLS (the page script sends at most as many; an SDK bridge may send more) count as dropped.
  let dropped = Math.max(0, (observation.controls?.length ?? 0) - MAX_CONTROLS);
  if (offered.length > MAX_OFFERED) {
    const hints = options.hints ?? relevanceHints({
      instruction: options.instruction, answerQuestion: options.answerQuestion, expectation: options.expectation,
    });
    const capped = capActions(offered, MAX_OFFERED, hints, options.pinned ?? null);
    offered = capped.actions;
    dropped += capped.dropped;
  }
  return {
    actions: [...offered.map((action, index) => ({ id: `a${index}`, ...action })), ...terminalActions()],
    dropped,
  };
}

/**
 * The controls_capped warning for an observation and the actions a cap left out of what was offered or listed:
 * `controls_capped:<n>` (n: the page script's controlsDropped plus `dropped`), a bare `controls_capped` when the page
 * script reports the cap without a count, or null when nothing was left out.
 */
export function cappedWarning(observation, dropped = 0) {
  const pageCapped = Array.isArray(observation?.warnings) && observation.warnings.includes('controls_capped');
  const pageDropped = Number.isInteger(observation?.controlsDropped) && observation.controlsDropped > 0 ? observation.controlsDropped : 0;
  const total = pageDropped + (Number.isInteger(dropped) && dropped > 0 ? dropped : 0);
  if (total) return `controls_capped:${total}`;
  return pageCapped ? 'controls_capped' : null;
}

const UNREADABLE_KINDS = new Set(['chart', 'canvas', 'image', 'table']);

/**
 * `unreadable_region:<kind>` warnings for an observation whose page script flagged regions it holds only as pixels or
 * cut (`observation.unreadable`, kinds chart | canvas | image | table), one per kind in first-seen order; a bare
 * `unreadable_region` when the script lists none it knows. The kind is a fixed word, never page text.
 */
export function unreadableWarnings(observation) {
  const kinds = [];
  for (const region of Array.isArray(observation?.unreadable) ? observation.unreadable : []) {
    if (UNREADABLE_KINDS.has(region?.kind) && !kinds.includes(region.kind)) kinds.push(region.kind);
  }
  return kinds.length ? kinds.map(kind => `unreadable_region:${kind}`) : ['unreadable_region'];
}

function cappedCount(code) {
  const match = /^controls_capped:(\d+)$/.exec(String(code));
  return match ? Number(match[1]) : 0;
}

/** A stable key for an offered action across observations (ids are renumbered every time). */
export function actionKey(action) {
  return `${action.type}:${action.target ?? action.url ?? action.direction ?? ''}:${action.value ?? action.suppliedName ?? ''}`;
}

/** The lower-cased title and path (not "/") of a page, for hop matching (earlyEnd). */
function pageTexts(observation) {
  const out = [];
  if (observation?.title) out.push(String(observation.title).toLowerCase());
  const path = urlPath(observation?.url);
  if (path && path !== '/') out.push(path.toLowerCase());
  return out;
}

function controlLabel(action) {
  return String(action?.label ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A record of a clicked control, matched against later offers by sameControl (key, or type and label). */
function toggleRecord(action, url) {
  return { key: actionKey(action), type: action.type, label: controlLabel(action), url };
}

/** Whether an offered action is the recorded control: the same stable key, or the same type and (non-empty) label. */
function sameControl(action, record) {
  if (actionKey(action) === record.key) return true;
  return Boolean(record.label) && action.type === record.type && controlLabel(action) === record.label;
}

/**
 * The gate class of an action: link (navigation), control (button/select/fill), page (scroll/wait), consent or
 * dismiss (the runtime closing a nag overlay, src/overlay.js).
 */
export function actionClass(action) {
  if (action?.consent) return 'consent';
  if (action?.overlayDismiss) return 'dismiss';
  if (['navigate_allowed_url', 'open_tab'].includes(action?.type)) return 'link';
  if (['scroll', 'wait', 'history', 'switch_tab'].includes(action?.type)) return 'page';
  if (action?.type === 'click' && action.role === 'link') return 'link';
  return 'control';
}

/**
 * Controls the runtime and the page script refuse at the run's level for their label, risk or field type:
 * submissions, deletions, sign-in and purchase controls the level does not allow, labels the additions forbid,
 * and links that are actions (destructiveLink) of such a class. Visible, enabled controls only; options are
 * listed as their own entries. Used for refusal receipts; never offered.
 */
export function blockedControls(observation, options = {}) {
  return blockedEntries(observation, options).map(entry => entry.control);
}

/** blockedControls with the reason: `[{ control, kind, capability }]` (see controlBlock). */
export function blockedEntries(observation, options = {}) {
  const guard = policyOf(options);
  const facts = pageFacts(observation);
  const out = [];
  for (const control of (observation?.controls ?? []).slice(0, MAX_CONTROLS)) {
    if (control.enabled === false || control.visible === false) continue;
    const role = control.role || 'control';
    const block = controlBlock(gatedControl(control, facts), guard, facts, { labelled: role !== 'link' && !isToggle(control) });
    // `intent`: Jev may clear it (intentEligible); refusal() leaves such a control to the decision.
    if (block) out.push(intentEligible(control, block, guard, facts) ? { control, ...block, intent: true } : { control, ...block });
    for (const option of control.options ?? []) {
      if (option.disabled) continue;
      const reason = optionBlock(option, guard);
      if (reason) out.push({ control: { ...control, label: option.label, optionLabel: option.label, value: option.value }, ...reason });
    }
  }
  return out;
}

/**
 * The lowest level above `level` that would allow a blocked entry, or null when none would (a `forbid` addition,
 * a page-script block, or a purchase, which is never relayed as a level request below testing).
 */
export function levelToUnblock(entries, level) {
  let best = null;
  for (const entry of entries) {
    if (!entry.capability) continue;
    const needed = levelFor(entry.capability);
    if (!needed || levelRank(needed) <= levelRank(level)) continue;
    if (best === null || levelRank(needed) < levelRank(best)) best = needed;
  }
  return best;
}

/** The bridge command for a legal action. Supplied text is resolved here, never earlier. */
function toCommand(action, suppliedText) {
  const command = { type: action.type };
  if (action.target !== undefined) command.target = action.target;
  // A point click on a control the observation left out: the page script clicks the element it located there (the
  // action's own target "point" is the receipt's ref, not a page id).
  if (action.point !== undefined) {
    delete command.target;
    command.point = { x: action.point.x, y: action.point.y };
  }
  if (action.type === 'fill_supplied_text') {
    const text = suppliedText?.[action.suppliedName];
    if (typeof text !== 'string') {
      throw bridgeError('failed', `Supplied value ${action.suppliedName} is missing`, false);
    }
    command.text = text;
    // The extension keeps sensitive values out of its screenshot annotations (captions and labels).
    if (action.sensitive) command.sensitive = true;
  }
  if (action.type === 'fill') {
    if (typeof action.text !== 'string') throw bridgeError('failed', 'The text to fill is missing', false);
    command.type = 'fill_supplied_text';
    command.text = action.text;
    command.typed = true;
  }
  // Host-composed page actions: a history move, a key, a pointer rest, a tab of the lease, a JS dialog's answer.
  for (const key of ['move', 'key', 'tab', 'answer', 'file']) if (action[key] !== undefined) command[key] = action[key];
  if (action.type === 'dialog' && typeof action.text === 'string') command.text = action.text;
  if (action.value !== undefined) command.value = action.value;
  if (action.direction !== undefined) command.direction = action.direction;
  if (action.url !== undefined) command.url = action.url;
  // A nag overlay's Escape or backdrop click (page.js dismissOverlay).
  if (action.type === 'dismiss_overlay') command.method = action.method;
  // A refused ambiguous control Jev cleared (Session.intentVerdict): the capability its class needs; page.js checks
  // its own ambiguous mark and the grant before it clicks.
  if (action.intentCleared !== undefined) command.intentCleared = action.intentCleared;
  // The Approve gate: the id the extension minted when the user approved this one click (it checks the binding).
  if (typeof action.approvalId === 'string') command.approvalId = action.approvalId;
  // A secret handle (fill_secret, copy_secret): the worker resolves the value; it never passes through here.
  if (action.type === 'fill_secret' || action.type === 'copy_secret') command.handle = action.handle;
  return command;
}

// ---------------------------------------------------------------------------------------------------------------
// Observation helpers
// ---------------------------------------------------------------------------------------------------------------

function validateObservation(observation) {
  const valid = observation
    && typeof observation.revision === 'string'
    && typeof observation.url === 'string'
    && Array.isArray(observation.controls);
  if (!valid) throw bridgeError('invalid_observation', 'Invalid bridge observation', false);
}

/**
 * What a page says, independent of where it is scrolled: the title, every block's text (on screen or not, live
 * regions included) and every control's identity and state, each as a sorted list, so an order the viewport set does
 * not count. Null when the observation cannot tell (no blocks, or blocks or controls capped: what was left out
 * depends on the scroll position), and the revision decides instead.
 */
function contentKey(observation) {
  const parts = contentParts(observation);
  return parts === null ? null : JSON.stringify([parts.title, parts.blocks, parts.controls]);
}

/** contentKey's parts, each serialised on its own so that contentDiff can name the one that differs. */
function contentParts(observation) {
  if (!Array.isArray(observation?.blocks) || observation.blocksTruncated
    || observation.warnings?.some(code => String(code).startsWith('controls_capped'))) return null;
  const blocks = observation.blocks.map(block => `${block.t}:${block.text}`).sort();
  const controls = observation.controls.map(control => JSON.stringify([control.role, control.label, control.checked,
    control.filled, control.value, control.selectedValue, control.href, control.frame])).sort();
  return { title: JSON.stringify(observation.title), blocks: JSON.stringify(blocks), controls: JSON.stringify(controls) };
}

/**
 * How long rung 1c looks for a late change after a quiet button click that changed nothing: 'full' (the
 * LATE_CHANGE_ROUNDS) for a control that re-renders seconds later, a derived-label stepper arrow (previous / next /
 * decrease / increase, with or without -value), a picker-open click, a control in an open dialog or one a site
 * profile pins (Google Flights' date arrows and grid); 'short' (one look) for any other button while the page shows work pending, the clicked control now
 * disabled or a loading placeholder; else null, no wait.
 */
function lateLook(chosen, before, fresh, session) {
  // Any direction descriptor the page script derives (describeUnnamed): `next-value button after "Departure"`, and
  // `next button after "Departure"` when the control's own attributes say next (the live-like flights fixture).
  const stepper = stepperArrow(chosen);
  const control = before.controls?.find(candidate => String(candidate.id) === String(chosen.target));
  if (stepper || chosen.opens === true || control?.dialog === true || session.site?.pinned(before)?.(chosen)) {
    return 'full';
  }
  const now = fresh.controls?.find(candidate => candidate.role === control?.role && candidate.label === control?.label);
  if (now?.enabled === false || session.loadingOf(fresh).length) return 'short';
  return null;
}

/**
 * Whether the page moved between two observations: another URL, or other content. A change of scroll position alone
 * (a click that scrolled its offscreen target into view) does not count, nor a revision that only the scroll moved,
 * and a live region that filled in does (the semantic revision leaves live regions out).
 */
function pageMoved(before, after) {
  return contentDiff(before, after) !== null;
}

/**
 * What differs between two observations, as pageMoved reads them: 'url', else the content parts that differ
 * ('title', 'blocks', 'controls', joined with '+'), else 'revision' when the content cannot tell and the revision
 * moved; null when nothing did. A rung 1c click step records it as `moved`, so a missed late change is diagnosable.
 */
function contentDiff(before, after) {
  if (before.url !== after.url) return 'url';
  const a = contentParts(before);
  const b = a === null ? null : contentParts(after);
  if (a === null || b === null) return before.revision !== after.revision ? 'revision' : null;
  const differing = ['title', 'blocks', 'controls'].filter(part => a[part] !== b[part]);
  return differing.length ? differing.join('+') : null;
}

/**
 * Whether two observations' blocks differ only by one-for-one replacements: no more blocks were added than removed
 * (a live-region clock "Updated 3s ago" -> "Updated 4s ago", an ad that rotated). An append adds more than it removes.
 */
function blockChurn(before, after) {
  const counts = new Map();
  for (const block of before.blocks ?? []) {
    const key = `${block.t}:${block.text}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let added = 0;
  for (const block of after.blocks ?? []) {
    const key = `${block.t}:${block.text}`;
    if (counts.get(key)) counts.set(key, counts.get(key) - 1);
    else added++;
  }
  const removed = [...counts.values()].reduce((sum, n) => sum + n, 0);
  return added <= removed;
}

/**
 * Whether a click on a control in an open dialog closed that dialog and changed nothing else: same URL, no dialog
 * control left, and every other control as it was (identity and state, as contentKey reads them). The flights-live
 * calendar's Done on a results page; a Done that also wrote the day into the form's Departure field moved the page.
 * False when the controls were capped (what was left out depends on the scroll position).
 */
function onlyDialogClosed(chosen, before, after) {
  const clicked = before.controls?.find(candidate => String(candidate.id) === String(chosen.target));
  if (clicked?.dialog !== true || before.url !== after.url || after.controls?.some(control => control.dialog === true)) {
    return false;
  }
  const capped = observation => observation.warnings?.some(code => String(code).startsWith('controls_capped'));
  if (capped(before) || capped(after)) return false;
  const outside = observation => JSON.stringify(observation.controls.filter(control => control.dialog !== true)
    .map(control => JSON.stringify([control.role, control.label, control.checked, control.filled, control.value,
      control.selectedValue, control.href, control.frame])).sort());
  return outside(before) === outside(after);
}

/** Observation given to providers and to hosts via observe(). Bounds are dropped; sensitive controls excluded. */
function compactForDecision(observation) {
  return {
    revision: observation.revision,
    url: observation.url,
    title: clip(observation.title, 500),
    text: clip(observation.text, 12000),
    controls: observation.controls
      .slice(0, MAX_CONTROLS)
      .filter(control => !control.sensitive && control.type !== 'password')
      .map(control => ({
        id: control.id,
        role: control.role,
        label: clip(control.label, 300),
        type: control.type,
        href: control.href,
        selectedValue: control.selectedValue,
        filled: control.filled,
        checked: control.checked,
        enabled: control.enabled,
        options: control.options?.slice(0, MAX_OPTIONS),
      })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Provider payload: supplied-value redaction
// ---------------------------------------------------------------------------------------------------------------

/**
 * Build a function that replaces exact occurrences of supplied values with `[supplied:<name>]`.
 *
 * Supplied values never appear in offered actions or history by construction, but a page can echo a filled value
 * back (a live preview, a control label, a URL query). Everything sent to a provider passes through this redactor
 * first: page URL, title, text and controls, action criteria, and history.
 *
 * Matching is exact and case-sensitive, and also covers the URL-encoded forms (`encodeURIComponent`, and `+` for
 * spaces) so a value reflected into a query string is caught. Values shorter than SUPPLIED_REDACTION_MIN_LENGTH (4)
 * characters are not redacted: replacing every "a", "12" or "yes" would corrupt unrelated page text, labels and
 * URLs until the provider could no longer read the page, and values that short carry too little information to
 * be worth hiding. Callers should not pass secrets that short (and never pass credentials at all).
 */
export function redactorFor(suppliedText) {
  const pairs = [];
  for (const [name, value] of Object.entries(suppliedText ?? {})) {
    if (typeof value !== 'string' || value.length < SUPPLIED_REDACTION_MIN_LENGTH) continue;
    const marker = `[supplied:${name}]`;
    const encoded = encodeURIComponent(value);
    for (const variant of new Set([value, encoded, encoded.replace(/%20/g, '+')])) {
      pairs.push([variant, marker]);
    }
  }
  if (!pairs.length) return value => value;
  // Longest first, so a value that contains another supplied value is replaced whole.
  pairs.sort((a, b) => b[0].length - a[0].length);
  return value => {
    if (typeof value !== 'string') return value;
    let out = value;
    for (const [variant, marker] of pairs) {
      if (out.includes(variant)) out = out.split(variant).join(marker);
    }
    return out;
  };
}

function redactFields(entry, redact, keys) {
  const copy = { ...entry };
  for (const key of keys) {
    if (typeof copy[key] === 'string') copy[key] = redact(copy[key]);
  }
  return copy;
}

/** The compact page, offered actions and history exactly as a provider receives them. */
export function providerPayload(observation, actions, history, suppliedText) {
  const redact = redactorFor(suppliedText);
  const page = compactForDecision(observation);
  return {
    observation: {
      ...redactFields(page, redact, ['url', 'title', 'text']),
      controls: page.controls.map(control => {
        const entry = redactFields(control, redact, ['label', 'href', 'selectedValue']);
        if (control.options) entry.options = control.options.map(option => redactFields(option, redact, ['value', 'label']));
        return entry;
      }),
    },
    actions: actions.map(action => redactFields(action, redact,
      ['label', 'description', 'optionLabel', 'value', 'href', 'url'])),
    history: history.map(entry => redactFields(entry, redact, ['label', 'fromUrl', 'toUrl'])),
  };
}

/**
 * The decision as recorded on a step. `probabilities` (top five) is non-enumerable: readable by SDK callers and
 * written to the trace by writeRun, but left out of serialized results, where it only costs host tokens.
 */
function decisionRecord(by, decision) {
  const record = { by, actionId: decision.actionId };
  if (Number.isFinite(decision.confidence)) record.confidence = decision.confidence;
  const done = doneProbability(decision);
  if (done !== null) record.done = done;
  const probabilities = topProbabilities(decision.probabilities);
  if (probabilities) {
    Object.defineProperty(record, 'probabilities', {
      value: probabilities, enumerable: false, writable: true, configurable: true,
    });
  }
  const guards = guardsOf(decision);
  if (guards) record.guards = Object.fromEntries(Object.entries(guards).map(([name, p]) => [name, round3(p)]));
  if (decision.model) record.model = decision.model;
  if (decision.requestId) record.requestId = decision.requestId;
  if (Number.isFinite(decision.latencyMs)) record.latencyMs = decision.latencyMs;
  return record;
}

/** Guard probabilities rounded to three decimals, as on a decision record. */
function roundedGuards(guards) {
  return Object.fromEntries(Object.entries(guards).map(([name, p]) => [name, round3(p)]));
}

/**
 * A stale re-resolve's step decision: the stale decide's record (its non-enumerable probabilities included) with the
 * re-resolved action id and `reason: "stale_reresolve"`, without that decide's guards, which scored the page before
 * the new content; the loop sets the fresh guards when the stale_guards request answers.
 */
function reresolveRecord(previous, actionId) {
  const record = { ...previous, actionId, reason: 'stale_reresolve' };
  delete record.guards;
  if (previous.probabilities) {
    Object.defineProperty(record, 'probabilities', {
      value: previous.probabilities, enumerable: false, writable: true, configurable: true,
    });
  }
  return record;
}

/** relevanceHints over the instruction, answerQuestion and expectation with supplied values redacted. */
function slimHints(instruction, config) {
  const redact = redactorFor(config.suppliedText);
  const expectation = config.expectation && typeof config.expectation === 'object'
    ? Object.fromEntries(Object.entries(config.expectation).map(([key, value]) => [key, redact(value)]))
    : null;
  return relevanceHints({ instruction: redact(instruction ?? ''), answerQuestion: redact(config.answerQuestion), expectation });
}

const SIZE_KEY = /^[A-Za-z]{1,24}$/;

/** A provider's reported request size (`{ chars, options, controls }`), reduced to non-negative integers, or null. */
function requestSizesOf(request) {
  if (!request || typeof request !== 'object' || !request.chars || typeof request.chars !== 'object') return null;
  const chars = {};
  for (const [key, value] of Object.entries(request.chars)) {
    if (SIZE_KEY.test(key) && Number.isSafeInteger(value) && value >= 0) chars[key] = value;
  }
  if (!Number.isSafeInteger(chars.total)) return null;
  const out = { chars };
  for (const key of ['options', 'controls', 'named']) {
    if (Number.isSafeInteger(request[key]) && request[key] >= 0) out[key] = request[key];
  }
  return out;
}

/** The provider's guard probabilities `{ blocked?, injection? }`, or null when it reported none. */
export function guardsOf(decision) {
  const guards = decision?.guards;
  if (!guards || typeof guards !== 'object') return null;
  const out = {};
  for (const name of GUARD_NAMES) if (isUnit(guards[name])) out[name] = guards[name];
  return Object.keys(out).length ? out : null;
}

/** True for a link action whose destination is on an approved origin (the only kind an injection guard lets run). */
function approvedLink(action, observation, config) {
  if (actionClass(action) !== 'link') return false;
  const href = action.type === 'navigate_allowed_url' ? action.url : action.href;
  if (!href) return false;
  try {
    return originCovered(new URL(href, observation.url).origin, config.allowedOrigins ?? []);
  } catch {
    return false;
  }
}

function stepAction(action, command, fromUrl) {
  const entry = { type: action.type };
  if (action.target !== undefined) entry.ref = action.target;
  entry.label = action.label ?? action.description;
  entry.fromUrl = fromUrl;
  entry.toUrl = fromUrl;
  if (action.suppliedName !== undefined) entry.suppliedName = action.suppliedName;
  // A secret handle's use records the handle only.
  if (action.handle !== undefined) entry.handle = `secret:${action.handle}`;
  // A password fill (sign_in) never records its value, even in memory; a fill the host typed records its length.
  if (action.sensitive) entry.sensitive = true;
  else if (action.type === 'fill' && typeof command.text === 'string') entry.chars = command.text.length;
  else if (action.type === 'dialog') entry.answer = action.answer;
  else if (command.text !== undefined) entry.text = command.text;
  for (const key of ['move', 'key', 'tab']) if (command[key] !== undefined) entry[key] = command[key];
  if (action.file) entry.file = { name: action.file.name, size: action.file.size };
  if (command.value !== undefined) entry.value = command.value;
  if (command.direction !== undefined) entry.direction = command.direction;
  if (command.url !== undefined) entry.url = command.url;
  if (command.method !== undefined) entry.method = command.method;
  return entry;
}

/** History sent to the provider: what was done and where, never supplied text. */
function historyEntry(step) {
  const entry = {
    i: step.i,
    type: step.action.type,
    label: step.action.label,
    fromUrl: step.action.fromUrl,
    toUrl: step.action.toUrl,
    changed: step.changed,
  };
  if (step.action.ref !== undefined) entry.ref = step.action.ref;
  if (step.action.suppliedName !== undefined) entry.suppliedName = step.action.suppliedName;
  return entry;
}

/**
 * Whether a fill kept its value: the page script's own read-back of the field after the page settled (`fill: {kept,
 * empty}`, extension/page.js fillKept: the value contains the supplied text with whitespace and case ignored, the
 * same digits, or the same ISO date in another form), else, from a bridge that reports none (an older extension, a
 * custom bridge), the next observation's `filled` flag on the same control: a field left empty did not keep it. Null
 * for any other action, and when nothing can be read. The field's value itself never reaches the runtime.
 */
function fillOutcome(action, execution, after) {
  if (action?.type === 'fill_secret') {
    const reported = execution?.fill;
    return reported && typeof reported.kept === 'boolean' ? { kept: reported.kept, empty: reported.empty === true, holds: `[secret:${action.handle}]` } : null;
  }
  if (action?.type !== 'fill_supplied_text' && action?.type !== 'fill') return null;
  const reported = execution?.fill;
  if (reported && typeof reported === 'object' && typeof reported.kept === 'boolean') {
    return { kept: reported.kept, empty: reported.empty === true };
  }
  if (action.target === undefined) return null;
  const control = (after?.controls ?? []).find(entry => String(entry?.id) === String(action.target));
  if (control && control.filled === false) return { kept: false, empty: true };
  return null;
}

function applyScreenshot(step, value, revision) {
  step.screenshot = null;
  if (!value) return;
  if (value.error) {
    step.captureError = { code: value.error.code ?? 'capture_failed', message: String(value.error.message ?? '') };
    return;
  }
  if (typeof value.dataUrl !== 'string' || !value.dataUrl.startsWith('data:image/')) {
    step.captureError = { code: 'capture_failed', message: 'Screenshot is not an image data URL' };
    return;
  }
  // A later revision of the same document (a chat transcript, a ticker or a clock kept changing after the
  // observation) is still evidence of that page: kept, with the observation's revision alongside. A different
  // document (the page navigated) is not.
  const later = value.revision !== revision && sameDocument(value.revision, revision);
  if (value.revision !== revision && !later) {
    step.captureError = { code: 'revision_mismatch', message: 'Screenshot revision does not match the observation' };
    return;
  }
  const format = value.format ?? (value.dataUrl.startsWith('data:image/jpeg') ? 'jpeg' : 'png');
  step.screenshot = { dataUrl: value.dataUrl, revision: value.revision, format };
  if (later) step.screenshot.observedRevision = revision;
  // The action-id badges the extension drew (only on the offer's own revision), for the trace.
  if (Array.isArray(value.tags)) step.screenshot.tags = value.tags.slice(0, MAX_CONTROLS);
  Object.assign(step.screenshot, redactionMeta(value));
}

/**
 * A screenshot's redaction note (extension/offscreen.js): `redactions`, how many boxes hide secrets on it, and
 * `redaction: "withheld"` when the whole frame was filled solid black because the page would not hold still. Numbers and one
 * fixed word only.
 */
export function redactionMeta(value) {
  const out = {};
  if (Number.isInteger(value?.redactions) && value.redactions >= 0) out.redactions = Math.min(value.redactions, 10_000);
  if (value?.redaction === 'withheld') out.redaction = 'withheld';
  return out;
}

/**
 * The badge labels for a screenshot of an offer: control ref -> the offered action ids on that control, in offer
 * order (a select's options, a field's fills). Page actions (scroll, wait, allowed URLs) have no control and no tag.
 */
export function actionLabels(actions) {
  const labels = {};
  for (const action of actions ?? []) {
    if (action?.target === undefined || typeof action.id !== 'string') continue;
    (labels[String(action.target)] ??= []).push(action.id);
  }
  return labels;
}

/** Revisions are "<documentId>:<sequence>" (extension/page.js): true when both name the same document. */
function sameDocument(a, b) {
  const doc = value => {
    const text = String(value ?? '');
    const at = text.lastIndexOf(':');
    // A revision that also stands for approved frames (extension/frames.js) is "<documentId>:<sequence>.<n>".
    return at > 0 && /^\d+(?:\.\d+)?$/.test(text.slice(at + 1)) ? text.slice(0, at) : null;
  };
  const left = doc(a);
  return left !== null && left === doc(b);
}

function withCap(promise, ms) {
  let timer;
  const cap = new Promise(resolve => {
    timer = setTimeout(() => resolve({ error: { code: 'timeout', message: 'Screenshot was not delivered' } }), ms);
    timer.unref?.();
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

function isRecoverable(error) {
  return Boolean(error && (error.recoverable === true || RECOVERABLE_CODES.has(error.code)));
}

/** The provider's probability that the requested outcome is already visible, or null when it did not report one. */
export function doneProbability(decision) {
  const probability = decision?.done?.probability;
  return isUnit(probability) ? probability : null;
}

/** The provider's confidence in its own choice: `confidence`, else the chosen action's probability, else null. */
export function choiceConfidence(decision) {
  if (Number.isFinite(decision?.confidence)) return decision.confidence;
  const probability = decision?.probabilities?.[decision?.actionId];
  return Number.isFinite(probability) ? probability : null;
}

/**
 * Up to five executable offered actions the host may pass to act(), most likely first. Uses the provider's
 * probabilities when it reported them, else only the chosen action. `description` is runtime-written but embeds
 * the control's page label, so it is untrusted page text.
 */
function alternativesFor(decision, actions, confidence) {
  const byId = new Map(actions.map(action => [action.id, action]));
  const entry = (action, probability) => ({ id: action.id, description: action.description, probability });
  const ranked = Object.entries(decision?.probabilities ?? {})
    .filter(([id, probability]) => byId.has(id) && Number.isFinite(probability))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ALTERNATIVES)
    .map(([id, probability]) => entry(byId.get(id), probability));
  if (!ranked.length && byId.has(decision?.actionId)) ranked.push(entry(byId.get(decision.actionId), confidence));
  return ranked;
}

/** The destination of a link action, resolved against the page URL, or null. */
function linkHref(action, base) {
  const href = action?.type === 'navigate_allowed_url' ? action.url : action?.href;
  if (!href) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Explicit-URL hop (E2): "Open https://... and read" goes to that URL without a provider decision.
// ---------------------------------------------------------------------------------------------------------------

// A clause that names an action to do (namesMoreAfterOpen): an imperative verb at its start.
const ACTION_CLAUSE = /^(?:(?:and|then|now|next|also|please|first)\s+)*(?:click|press|tap|select|choose|set|type|enter|fill|pick|search|sort|filter|toggle|switch|change|add|remove|expand|collapse|open|go|navigate|follow|visit|scroll|book|apply|submit|use|move|close|accept|reject|upload|download|sign|log|save|delete|send|create|edit|update|clear|uncheck|check(?!\s+(?:whether|if|what|which|how|that)\b))\b/i;

/**
 * Whether the instruction names an action after the URL its opening hop goes to: "Open <url> directly. Set trip type
 * to One way, ..., read the grid" does; "Open <url>.", "Open <url> and read the flights." and "Open <url>. A section
 * loads late. What text appears there?" do not (prose and questions to read there are not more to do).
 */
export function namesMoreAfterOpen(instruction, url) {
  const text = String(instruction ?? '');
  const match = [...text.matchAll(URL_IN_TEXT)].find(found => {
    try {
      const href = new URL(trimNamedUrl(found[0])).href;
      return href === url || (Boolean(url) && sameNamedPage(href, url) && sameNamedPage(url, href));
    } catch {
      return false;
    }
  });
  if (!match) return false;
  const rest = text.slice(match.index + match[0].length).replace(QUOTED, ' label ');
  return rest.split(/[.;:!?,]+|\b(?:and|then)\b/i).some(clause => ACTION_CLAUSE.test(clause.trim()));
}

/**
 * Whether `current` already is the page `named` names: the same origin and path, and every query parameter of the
 * named URL present in the current one with the same value (a site may add its own: Google Flights' `&tfu=`).
 */
export function sameNamedPage(named, current) {
  try {
    const a = new URL(named);
    const b = new URL(current);
    if (a.origin !== b.origin || a.pathname.replace(/\/+$/, '') !== b.pathname.replace(/\/+$/, '')) return false;
    for (const [key, value] of a.searchParams) if (!b.searchParams.getAll(key).includes(value)) return false;
    return true;
  } catch {
    return false;
  }
}

/** The words of a URL's path, hash route and short query keys and values (camelCase split), for the commit checks. */
function urlWords(url) {
  const parsed = new URL(url);
  const parts = [decodeURIComponent(parsed.pathname), decodeURIComponent(parsed.hash)];
  for (const [key, value] of parsed.searchParams) {
    parts.push(key);
    if (value.length <= 24 && /^[\p{L} _-]+$/u.test(value)) parts.push(value);
  }
  return parts.join(' ').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/[/_\-.+=&?#!]+/g, ' ').trim();
}

/** Whether a URL is one the URL hop must never navigate to (a commit, sign-out or form-action URL). */
export function urlHopRefused(url, guardrails) {
  try {
    const words = urlWords(url);
    return URL_HOP_REFUSED.test(words) || Boolean(guardrails?.classes(words).length);
  } catch {
    return true;
  }
}

/**
 * Stale re-resolve: the one offered link with the stale choice's type, destination, label and frame, or null when
 * there is none or more than one (two same-label links to one place are ambiguous: the provider decides again).
 */
function staleMatch(stale, offered, observation, config) {
  if (!staleResolvable(stale.href, observation.url)) return null;
  const { chosen } = stale;
  const matches = offered.filter(candidate => candidate.type === chosen.type && actionClass(candidate) === 'link'
    && candidate.label === chosen.label && linkHref(candidate, observation.url) === stale.href
    && frameOf(candidate, observation) === stale.frame);
  return matches.length === 1 && approvedLink(matches[0], observation, config) ? matches[0] : null;
}

/** The labels of the controls listed just before and after control `ref` in an observation (its neighbours). */
function neighbourLabels(observation, ref) {
  const controls = observation?.controls ?? [];
  const index = controls.findIndex(control => String(control.id) === String(ref));
  if (index < 0) return null;
  return [controls[index - 1]?.label ?? '', controls[index + 1]?.label ?? ''];
}

/**
 * Whether an action is a derived-label stepper arrow: a control with no name of its own that the page script named by
 * its direction (describeUnnamed: `next-value button after "Departure"`, `next button after "Departure"` when its own
 * attributes say next, `increase button after "Adults"`). Shared by lateLook and staleControl so both read the same
 * labels as steppers.
 */
function stepperArrow(action) {
  return action?.unnamed === true
    && /^(?:previous|next|decrease|increase)(?:-value)? \S+ (?:before|after|beside) /.test(String(action.label ?? ''));
}

/** A non-sensitive supplied-text fill whose control is explicitly a search or filter field. */
function staleSearchFill(action, observation) {
  if (action?.type !== 'fill_supplied_text' || action.sensitive || action.needsApproval) return false;
  const control = observation.controls?.find(candidate => String(candidate.id) === String(action.target));
  if (!control || control.sensitive || control.type === 'password' || paymentField(control)) return false;
  return control.type === 'search' || control.role === 'searchbox'
    || labelSpellings(control.label).some(label => /^(?:search|find|filter)\b/i.test(label));
}

/**
 * Host act() stale re-resolve: the one action offered on the fresh observation that is the same control as `action`
 * from `offer` (same type, role, label, value, supplied name, destination, scroll direction, frame and picker
 * click), on the same origin and path; with several, the one whose neighbouring controls also carry the same
 * labels. Null when none or more than one match, when the page moved to another path, or for a consent button.
 * Only for a link, a derived-label stepper arrow (stepperArrow), a picker-open click or a search/filter supplied
 * fill (staleSearchFill). Any other button, select or fill stays stale for the host.
 * Also null (the host decides on the new page) for a control whose label trips a guardrail class (delete, submit,
 * purchase, sign-in, commit) or whose risk is above reversible, when a consent dialog shows on the fresh page, and
 * when the number of such controls changed (a removed row shifts every same-label "Delete" one place).
 */
function staleControl(action, offer, fresh) {
  if (action.consent || action.type === 'done' || action.type === 'handoff') return null;
  const stepper = stepperArrow(action);
  const searchFill = staleSearchFill(action, offer.observation);
  if (actionClass(action) !== 'link' && !stepper && !(action.type === 'click' && action.opens === true) && !searchFill) return null;
  if (consentOf(fresh)) return null;
  if (action.target !== undefined) {
    const control = offer.observation.controls?.find(candidate => String(candidate.id) === String(action.target));
    const risk = control?.risk ?? (control?.type === 'submit' ? 'submit' : undefined);
    if (risk !== undefined && risk !== 'reversible' && risk !== 'navigation') return null;
    if (labelSpellings(action.label).length && labelClasses(action.label).length) return null;
  }
  try {
    const before = new URL(offer.observation.url);
    const now = new URL(fresh.url);
    if (before.origin !== now.origin || before.pathname !== now.pathname) return null;
  } catch {
    return null;
  }
  const fields = ['type', 'role', 'label', 'value', 'suppliedName', 'url', 'href', 'direction', 'optionLabel', 'newTab'];
  const frame = frameOf(action, offer.observation);
  const same = (candidate, page) => fields.every(field => candidate[field] === action[field])
    && Boolean(candidate.opens) === Boolean(action.opens) && frameOf(candidate, page) === frame;
  const offered = offeredActions(fresh, { ...offer.config }).actions;
  let matches = offered.filter(candidate => same(candidate, fresh));
  if (matches.length !== offer.actions.filter(candidate => same(candidate, offer.observation)).length) return null;
  if (matches.length > 1 && action.target !== undefined) {
    const near = neighbourLabels(offer.observation, action.target);
    matches = matches.filter(candidate => {
      const there = neighbourLabels(fresh, candidate.target);
      return near && there && near[0] === there[0] && near[1] === there[1];
    });
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * A stale link destination a re-resolve may follow: a real href to another document. `href="#"`, `href=""` and
 * fragment links resolve to the page itself, so the destination says nothing about what the click does (an "OK" that
 * moved into a "Confirm delete?" dialog): those always decide again.
 */
function staleResolvable(href, pageUrl) {
  if (!href) return false;
  try {
    const target = new URL(href);
    const page = new URL(pageUrl);
    target.hash = '';
    page.hash = '';
    return target.href !== page.href;
  } catch {
    return false;
  }
}

/** The 1-based same-origin frame index of an offered control action's control (extension/page.js), or null. */
function frameOf(action, observation) {
  if (action?.target === undefined) return null;
  const control = (observation.controls ?? []).find(item => String(item.id) === String(action.target));
  return control?.frame ?? null;
}

/** A URL's path for retry records (no query, no fragment), or null. */
function urlPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function providerName(provider) {
  return provider?.model ?? provider?.name ?? null;
}

function isUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** Settle with the operation, or reject when the signal aborts, even if the operation ignores the signal. */
function abandonable(operation, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** What a choose() request depends on besides the run's instruction: equal keys make equal requests. */
function rankingKey(question, candidates, trail, lists = null) {
  return JSON.stringify([question, candidates.map(candidate => candidate.text), trail, lists]);
}

/** A candidate's identity across answer plans (the plan's dedupe key). */
function candidateKey(candidate) {
  return String(candidate.key ?? candidate.text).toLowerCase();
}

function answerEntry(candidate, confidence) {
  const source = { t: candidate.t };
  if (candidate.ref !== undefined) source.ref = candidate.ref;
  // A line remembered from an earlier page state, or an aggregation item: where it was read.
  if (candidate.state !== undefined) {
    source.state = candidate.state;
    source.url = candidate.url;
    if (candidate.heading) source.heading = candidate.heading;
  }
  const entry = { text: candidate.text, confidence, source };
  if (candidate.aggregate !== undefined) entry.aggregate = candidate.aggregate;
  return entry;
}

/** The memory key of an observation: its semantic revision, else URL, title and text. */
function stateKey(observation) {
  if (observation?.revision) return String(observation.revision);
  return `${observation?.url ?? ''}\u0000${observation?.title ?? ''}\u0000${String(observation?.text ?? '')}`;
}

/**
 * Rank candidates with a provider reply: the chosen one first with the provider's confidence (else its
 * probability, else the heuristic), the rest by the provider's probabilities when it reported them, else by the
 * heuristic capped at the remaining mass. Throws when the choice is not one of the offered ids.
 */
function rankWithReply(reply, candidates, ids, heuristic) {
  const chosen = ids.indexOf(reply?.choice);
  if (chosen < 0) throw new Error('Provider chose an answer outside the offered candidates');
  const probabilities = {};
  for (const [id, p] of Object.entries(reply.probabilities ?? {})) if (ids.includes(id) && isUnit(p)) probabilities[id] = p;
  const hasProbabilities = Object.keys(probabilities).length > 0;
  const top = isUnit(reply.confidence) ? reply.confidence : probabilities[ids[chosen]] ?? heuristic[chosen];
  const ranked = candidates.map((candidate, i) => {
    let confidence;
    if (i === chosen) confidence = top;
    else if (hasProbabilities) confidence = probabilities[ids[i]] ?? 0;
    else confidence = Math.min(heuristic[i], round3(1 - top));
    return { candidate, confidence: round3(confidence), i };
  });
  ranked.sort((a, b) => (b.i === chosen) - (a.i === chosen) || b.confidence - a.confidence || a.i - b.i);
  return { ranked, probabilities: hasProbabilities ? probabilities : undefined };
}

/**
 * Which record list the answer aggregates over, from the `lists` question's reply (listQuestion, guidance switch
 * `lists`): `{ list, none?, detail }`, `detail` the trace entry `{ lists, choice?, confidence?, list, why }` whose
 * `why` goes to verdict.why. The provider's list is used when it names an offered list at LIST_CHOICE_FLOOR or above
 * (`lists:provider:<n>`, n the page script's list number, 0 its best). "None of these" at the floor keeps the page
 * script's best list but marks the aggregation partial (`lists:none`, `aggregate:partial:list_none`): the provider
 * read none of the lists as the question's items, and the runtime has no other list to offer, so it never confirms an
 * item of one. Every other case keeps the page script's best list, as without the switch: `lists:fallback:<reason>`
 * with off (the switch), no_choose / single_candidate / no_time / cancelled (choose() not called), timeout /
 * provider_error / failed (it failed), no_reply (the provider did not answer the question), invalid, low_confidence.
 */
function listChoice(listing, outcome, skipped) {
  const detail = { lists: listing.lists.length, list: 0 };
  const fallback = reason => ({ list: 0, detail: { ...detail, why: `lists:fallback:${reason}` } });
  if (!listing.ask) return fallback('off');
  if (!outcome) return fallback(skipped ?? 'no_choose');
  if (outcome.detail?.skipped) return fallback(outcome.detail.skipped);
  if (outcome.detail?.error) return fallback(outcome.detail.error.code ?? 'failed');
  const reply = outcome.lists;
  if (!reply) return fallback('no_reply');
  const known = reply.choice === 'none' || listing.lists.some(entry => entry.list === reply.choice);
  if (reply.error || !known) return fallback('invalid');
  detail.choice = reply.choice;
  const id = reply.choice === 'none' ? 'none' : `list${reply.choice}`;
  const confidence = isUnit(reply.confidence) ? reply.confidence : reply.probabilities?.[id];
  if (isUnit(confidence)) detail.confidence = round3(confidence);
  if (!(confidence >= LIST_CHOICE_FLOOR)) return { list: 0, detail: { ...detail, why: 'lists:fallback:low_confidence' } };
  if (reply.choice === 'none') return { list: 0, none: true, detail: { ...detail, why: 'lists:none' } };
  return { list: reply.choice, detail: { ...detail, list: reply.choice, why: `lists:provider:${reply.choice}` } };
}

// ---------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------

function checkInteger(name, value, max) {
  if (!Number.isInteger(value) || value <= 0 || value > max) throw new RangeError(`Invalid ${name}`);
}

function configure(options, { step = false } = {}) {
  const maxActions = step ? 1 : options.maxActions ?? options.maxSteps ?? 8;
  const { thresholds, explicit } = resolveThresholds(options);
  // The level: the run's mode clamped to the user's grant (options.grant, from the tab lease). Without a grant (an
  // SDK caller with its own bridge) the ceiling is `full`: `testing` needs a grant, which only the user gives in the
  // extension for listed test origins.
  const requested = options.mode ?? 'read-only';
  if (!MODES.has(requested)) throw new TypeError('Unknown action policy');
  const grant = options.grant && typeof options.grant === 'object' && isLevel(options.grant.level)
    ? { level: options.grant.level, testing: options.grant.level === 'testing', tabMode: options.grant.tabMode === 'multiple' ? 'multiple' : 'single' }
    : null;
  if (options.grant !== undefined && options.grant !== null && !grant) throw new TypeError('grant.level must be a level');
  const level = clampLevel(requested, grant?.level ?? 'full');
  const config = {
    mode: level,
    level,
    grant,
    capabilities: capabilitiesOf(level),
    permissions: {
      requested: isLevel(options.permissions?.requested) ? options.permissions.requested : requested,
      granted: grant?.level ?? null,
      effective: level,
      testing: level === 'testing',
      tabMode: grant?.tabMode ?? 'single',
      // What the approved origins cover: `domain` when they hold a domain root ("https://*.example.com", which the
      // daemon keeps only when the user approved it), else `origin`.
      scope: siteRoots(options.allowedOrigins).length ? 'domain' : 'origin',
    },
    maxActions,
    // A stale retry that decides again costs a decision (a stale link re-resolve does not), and a run without an
    // expectation may spend one final decision on `done`.
    maxDecisions: options.maxDecisions ?? (step ? 2 : maxActions + 3),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    capture: options.capture ?? 'last',
    allowedOrigins: options.allowedOrigins,
    allowedUrls: options.allowedUrls ?? [],
    suppliedText: options.suppliedText ?? {},
    expectation: options.expectation,
    // Every gate in one object (linkFloor, controlFloor, doneThreshold, strongDone, answerConfirm, answerMargin);
    // `minConfidence` is accepted as an alias for controlFloor and `doneThreshold` at the top level.
    thresholds,
    explicitThresholds: explicit,
    // Rung 1c: how long to wait before the one late-navigation re-observe.
    reobserveDelayMs: options.reobserveDelayMs ?? DEFAULT_REOBSERVE_MS,
    // Rung 1c, buttons: how long to look for a late change after a click that changed nothing (0 turns it off).
    lateChangeMs: options.lateChangeMs ?? DEFAULT_LATE_CHANGE_MS,
    // Late content: delay between re-observes while a loading placeholder shows.
    contentWaitMs: options.contentWaitMs ?? DEFAULT_CONTENT_WAIT_MS,
    // Delay between re-observes while a clicked consent dialog is still open.
    consentWaitMs: options.consentWaitMs ?? DEFAULT_CONSENT_WAIT_MS,
    // The question answer candidates are ranked for; defaults to the instruction.
    answerQuestion: options.answerQuestion,
    onAction: options.onAction,
    awaitCallbacks: options.awaitCallbacks === true,
    signal: options.signal,
    runId: options.runId,
    step,
    retry: resolveRetry(options.retry),
    slim: resolveSlim(options.slim),
    // Counters shared by every attempt of one call (second opinions, back-outs, reruns).
    retryState: options[RETRY_STATE] ?? {
      secondOpinions: 0, backOuts: 0, reruns: 0, requests: 0, requestCap: null,
      // slim.terminal: pages (URLs) already asked once, and whether a fallback has ended it for the call.
      terminalUrls: new Set(), terminalOff: false,
      // Stale re-resolve: pages (URLs) where a stale link was kept for one, and whether a guard stop has ended them.
      staleUrls: new Set(), staleOff: false,
      // Rung 1c late change: off for the call (a list: for the step) once a wait saw no change.
      lateChangeOff: false,
      // Its short look (lateLook 'short'): off for the call once one saw no change.
      lateLookOff: false,
    },
  };
  // The call's provider request cap, fixed by the host's first attempt (a rerun's smaller budget never changes it).
  config.retryState.requestCap ??= config.maxDecisions + MAX_SECOND_OPINIONS + CALL_EXTRA_REQUESTS;
  // Guardrails (src/guardrails.js): core rules plus additions from config (`guardrails`) and the request (`policy`).
  // Invalid additions throw here, before any observation or provider call.
  const inherited = typeof options.guardrails?.forbids === 'function';
  config.guardrails = inherited && options.policy === undefined && options.guardrails.mode === config.mode
    ? options.guardrails
    : guardrailPolicy(inherited && options.policy === undefined
      ? { mode: config.mode, merged: options.guardrails.additions }
      : { mode: config.mode, request: options.policy, config: inherited ? options.guardrails.additions : options.guardrails });
  // Site profiles (src/domains.js, experimental): the `profiles` switch and the store that matches them by origin.
  config.profiles = resolveProfiles(options.profiles);
  if (options.domains !== undefined && options.domains !== null && typeof options.domains?.match !== 'function') {
    throw new TypeError('domains must be a profile store with match(origin)');
  }
  config.domains = options.domains ?? null;
  config.siteProfiles = null;
  if (config.allowedOrigins) attachProfiles(config);
  if (!CAPTURE_POLICIES.has(config.capture)) throw new TypeError('capture must be "each", "last" or "none"');
  checkInteger('maxActions', config.maxActions, LIST_MAX_ACTIONS);
  checkInteger('maxDecisions', config.maxDecisions, 200);
  checkInteger('timeoutMs', config.timeoutMs, 300000);
  if (!Number.isInteger(config.reobserveDelayMs) || config.reobserveDelayMs < 0 || config.reobserveDelayMs > 5000) {
    throw new RangeError('reobserveDelayMs must be an integer from 0 to 5000');
  }
  if (!Number.isInteger(config.lateChangeMs) || config.lateChangeMs < 0 || config.lateChangeMs > 10000) {
    throw new RangeError('lateChangeMs must be an integer from 0 to 10000');
  }
  if (!Number.isInteger(config.contentWaitMs) || config.contentWaitMs < 0 || config.contentWaitMs > 5000) {
    throw new RangeError('contentWaitMs must be an integer from 0 to 5000');
  }
  if (!Number.isInteger(config.consentWaitMs) || config.consentWaitMs < 0 || config.consentWaitMs > 2000) {
    throw new RangeError('consentWaitMs must be an integer from 0 to 2000');
  }
  if (config.answerQuestion !== undefined) {
    const valid = typeof config.answerQuestion === 'string' && config.answerQuestion.trim()
      && config.answerQuestion.length <= MAX_QUESTION_LENGTH;
    if (!valid) throw new TypeError(`answerQuestion must be a non-empty string of at most ${MAX_QUESTION_LENGTH} characters`);
  }
  if (config.allowedOrigins !== undefined) {
    const valid = Array.isArray(config.allowedOrigins)
      && config.allowedOrigins.length > 0
      && config.allowedOrigins.every(origin => typeof origin === 'string');
    if (!valid) throw new TypeError('At least one allowed origin is required');
  }
  if (!Array.isArray(config.allowedUrls)) throw new TypeError('allowedUrls must be an array');
  if (typeof config.suppliedText !== 'object' || Array.isArray(config.suppliedText)) {
    throw new TypeError('suppliedText must be an object of strings');
  }
  if (config.onAction !== undefined && typeof config.onAction !== 'function') {
    throw new TypeError('onAction must be a function');
  }
  validateExpectation(config.expectation);
  if (config.runId !== undefined && (typeof config.runId !== 'string' || !RUN_ID.test(config.runId))) {
    throw new TypeError('runId must be 1-128 characters of letters, digits, ".", "_" or "-"');
  }
  // Host offers retain the authority at observation time, independent of later caller mutations.
  if (config.allowedOrigins) config.allowedOrigins = [...config.allowedOrigins];
  config.allowedUrls = [...config.allowedUrls];
  config.suppliedText = { ...config.suppliedText };
  return config;
}

/**
 * Match the site profiles of the approved origins (exact origin match; a domain root's covered origins) once per run and merge their `restrict.forbid`
 * phrases into the guardrail additions, after config and request (src/guardrails.js `site`): a profile can only add
 * refusals. With the switch off or no store, no profile applies and nothing changes.
 */
function attachProfiles(config) {
  if (config.siteProfiles !== null) return config.siteProfiles;
  config.siteProfiles = [];
  if (!config.domains || !config.profiles.enabled) return config.siteProfiles;
  for (const origin of new Set(config.allowedOrigins ?? [])) {
    let profiles = [];
    try {
      // A domain root attaches the profiles of the origins it covers (src/domains.js matchSite); an exact origin its own.
      profiles = siteRoots([origin]).length
        ? config.domains.matchSite?.(origin) ?? []
        : [config.domains.match(origin)];
    } catch {
      profiles = [];
    }
    for (const profile of profiles) if (profile && !config.siteProfiles.includes(profile)) config.siteProfiles.push(profile);
  }
  const forbid = config.siteProfiles.flatMap(profile => profile.forbid ?? []);
  if (forbid.length) {
    config.guardrails = guardrailPolicy({ mode: config.mode, merged: config.guardrails.additions, site: forbid });
  }
  return config.siteProfiles;
}

// ---------------------------------------------------------------------------------------------------------------
// Session: one run, step or act. Owns cancellation, the result object and the pending screenshot.
// ---------------------------------------------------------------------------------------------------------------

class Session {
  constructor(runtime, config, instruction) {
    this.runtime = runtime;
    this.bridge = runtime.bridge;
    this.provider = runtime.provider;
    this.config = config;
    this.instruction = instruction;
    // Only provider-driven runs and steps ask the provider to rank the answer; act() and observe() never do.
    this.answerProvider = instruction ? runtime.provider : null;
    this.started = Date.now();
    this.pending = null;
    // Baseline for changedSinceStart: the first observation of a run or step, or the observation behind an offer.
    this.initial = null;
    // Observations of the pages this run saw, in order, for the earlier-page trail of multi-hop answers.
    this.visited = [];
    // The last expectation check, so one observation is never checked twice.
    this.lastCheck = null;
    // The last provider decision, written to the trace as finalDecision.
    this.lastDecision = null;
    // Instruction words for the page script's control ordering under the 100-control cap.
    this.terms = instruction ? instructionTerms(instruction, config.answerQuestion) : [];
    // Local relevance hints for the slim switches (instruction, answerQuestion, expectation), built from redacted text
    // like everything else that reaches a provider (decide contexts carry them with slim.controls).
    this.hints = slimHints(instruction, config);
    // Mechanical oversight signals for the verdict: extra machine `why` codes, the last done, the expectation
    // shape, host decide options and the late re-observe count.
    this.signals = { why: [], done: null, expectationShape: null, decide: null, guards: {} };
    this.reobserves = 0;
    this.contentWaits = 0;
    // Placeholder texts awaitContent found persistent (status text that never goes): not loading for this run.
    this.persistentLoading = new Set();

    const controller = new AbortController();
    this.interruptSignal = controller.signal;
    this.interrupted = null; // outcome code ('paused', 'stopped', 'tab_changed', ...) once interrupted
    this.interrupt = code => {
      if (this.interrupted) return;
      this.interrupted = code;
      controller.abort(bridgeError(code, outcomeFor(code).reason, false));
    };
    // AbortSignal.timeout() is unref'ed by Node: an SDK-only process could exit before returning its result.
    const timeoutController = new AbortController();
    this.timeoutSignal = timeoutController.signal;
    this.timeoutTimer = setTimeout(() => {
      timeoutController.abort(new DOMException('Run time budget reached', 'TimeoutError'));
    }, config.timeoutMs);
    this.callerSignal = config.signal;
    this.signal = AbortSignal.any([controller.signal, this.timeoutSignal, ...(config.signal ? [config.signal] : [])]);

    this.result = createResult({
      runId: config.runId ?? randomUUID(),
      expectation: describeExpectation(config.expectation),
      provider: providerName(this.provider),
    });
    // Trusted: what the agent asked for, what the user granted and what the run used.
    this.result.permissions = { ...config.permissions };
    // Values filled into password inputs (sign_in): redacted from the receipt and the trace (redactSecrets).
    // Earlier runs on the same runtime (one tab lease) count too: a page can echo a password later.
    Object.defineProperty(this.result, 'secrets', {
      value: [...(runtime.secrets ?? [])], writable: true, enumerable: false, configurable: true,
    });
    // One entry per provider request (numbers only, see requestEntry()). Non-enumerable, like the other
    // diagnostics: serialized results keep their shape, and writeRun puts it in the trace as cost.requests.
    Object.defineProperty(this.result.cost, 'requests', {
      value: [], writable: true, enumerable: false, configurable: true,
    });
    // The entry of the latest decide request, marked with the step it executed (if any) by execute().
    this.lastRequest = null;
    // The answer ranking started next to a decision that may end the run (speculateAnswer), and the promises of
    // discarded ones, settled before the run closes so their cost.requests entries are complete.
    this.speculation = null;
    this.discardedRankings = [];
    this.earlyRankingOff = false;
    // In-call retries of this attempt ({kind, why, outcome, ...}, trusted, no page text) and the second-opinion
    // decides, which do not count against maxDecisions.
    this.retries = [];
    this.extraDecisions = 0;
    // A self-rerun for late content: wait for the placeholder on the first page before deciding.
    this.awaitLoading = false;
    // A self-rerun numbers its steps after the first attempt's, so the merged result (and the daemon's live
    // progress, trace images and evidence) see one sequence of steps for the call.
    this.stepBase = 0;
    // A self-rerun without answerQuestion ranks answers for the host's original instruction, not the suggestion.
    this.callQuestion = null;
    // Whether the host's call asks something (asks()); a self-rerun inherits the first attempt's.
    this.asked = null;
    // Actions counted against maxActions in this attempt (the loop's counter, mirrored for rerunPlan).
    this.actionsTaken = 0;
    // Site-profile state of a provider-driven run (src/domains.js SiteRun), set once by startSite().
    this.site = null;
    this.siteStarted = false;
    // The expectation already passed on the start page while the instruction names an action (notePrepass).
    this.prepass = false;
    // The run's provider-chosen actions for earlyEnd ({changed, labelled, texts}), in order (hopEvent).
    this.hopEvents = [];
  }

  /**
   * Attach the approved origins' site profiles (once the origins are known) and, for a run with a declarative
   * expectation, start the fast path and hints. Steps, act() and observe() never use them.
   */
  startSite() {
    if (this.siteStarted) return;
    this.siteStarted = true;
    const profiles = attachProfiles(this.config);
    const expectation = this.config.expectation;
    if (!profiles.length || !this.instruction || this.config.step || !expectation || typeof expectation !== 'object') return;
    // The fast path needs the provider's slim done-and-guards request (confirm) for the pages it leaves.
    this.site = new SiteRun(profiles, {
      expectation,
      instruction: this.instruction,
      // The host's own text (before a list filled its placeholders; a re-run's runtime-written instruction is not
      // it): a shortcut value must appear there, never only in what a page supplied (src/shortcuts.js target).
      template: { instruction: this.hopTemplate ?? this.instruction, expectation: this.expectationTemplate ?? expectation },
      fastPath: this.config.profiles.fastPath && typeof this.provider?.confirm === 'function',
      hints: this.config.profiles.hints,
      // Profile shortcuts (a built-in rewrite of the current URL, src/shortcuts.js) from reversible up.
      shortcuts: levelRank(this.config.level) >= levelRank('reversible'),
    });
    // The route's link words (and the pinned control labels) join the instruction terms, so those controls survive the
    // page script's control cap.
    if (this.site.fastPath || this.site.hints) {
      for (const term of this.site.terms()) if (!this.terms.includes(term)) this.terms.push(term);
    }
  }

  /** The number the next executed step gets. */
  nextStep() {
    return this.stepBase + this.result.steps.length + 1;
  }

  guard() {
    if (this.interrupted) throw bridgeError(this.interrupted, this.interrupted, false);
    this.signal.throwIfAborted();
  }

  /** Run an operation that the signal can abandon, even if the operation itself ignores AbortSignal. */
  bounded(operation) {
    return new Promise((resolve, reject) => {
      this.guard();
      const abort = () => reject(this.signal.reason ?? new Error('Aborted'));
      this.signal.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(operation)
        .then(resolve, reject)
        .finally(() => this.signal.removeEventListener('abort', abort));
    });
  }

  async observe() {
    const options = this.terms.length ? { terms: [...this.terms] } : {};
    // Guardrail additions go to the page script too, which compiles them itself and refuses matching controls.
    // The level goes along too: the extension intersects it with the user's own grant and never widens it.
    const { forbid, level } = this.config.guardrails.wire();
    if (forbid) options.forbid = forbid;
    options.level = level;
    // The expectation's textIncludes: the page script also looks for it in the rendered text past the viewport
    // (observation.textFound), so a run that scrolled below the sentence still passes. The extension keeps it for
    // the act that follows, as it keeps the terms.
    const expectText = expectationTexts(this.config.expectation);
    if (expectText) options.expectText = expectText;
    // Test site: an observe that asked for the dev logs (BrowserRuntime.observe({ logs: true })).
    if (this.wantLogs) options.logs = true;
    // Secret redaction, daemon side (src/secrets.js): the extension already scrubbed the page; this pass is defense in
    // depth and numbers page tags a bridge without the worker left unnumbered.
    const observation = scrubSecrets(await this.bounded(() => this.bridge.observe(this.signal, options)), this.runtime.secretIds);
    validateObservation(observation);
    this.result.observation = observation;
    return observation;
  }

  /** Rung 1c: wait briefly and observe once more, for navigations that start after the action settled. */
  async reobserve() {
    if (this.reobserves >= MAX_REOBSERVES) return null;
    this.reobserves++;
    const delay = this.config.reobserveDelayMs;
    if (delay > 0) {
      await this.bounded(() => new Promise(resolve => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
      }));
    }
    const observation = await this.observe();
    this.visit(observation);
    return observation;
  }

  /**
   * A rung 1c re-observe that found the page moved (a late navigation, or a late change it led to) was no waste: give
   * it back. The cap bounds re-observes of clicks that changed nothing; a date stepper whose every click lands late
   * (flights-live-form-arrows, one arrow per day for a week) spent all four by the fifth day and stopped waiting.
   */
  refundReobserve() {
    // A hard ceiling: a page that keeps changing late (a stepper on a page with a ticking region) gets at most
    // MAX_REOBSERVES + MAX_REOBSERVE_REFUNDS re-observes per run.
    if ((this.reobserveRefunds ?? 0) >= MAX_REOBSERVE_REFUNDS) return;
    this.reobserveRefunds = (this.reobserveRefunds ?? 0) + 1;
    this.reobserves = Math.max(0, this.reobserves - 1);
  }

  /**
   * Late change (rung 1c, buttons): after a button click whose settle and re-observe both show the page unchanged,
   * observe again at LATE_CHANGE_ROUNDS fractions of `lateChangeMs` (1.5 s and 3 s by default) until the URL or
   * content moves. Returns `{ observation, ms }` for the first changed observation, else null. A wait that saw no
   * change turns the wait off for the rest of the call (a button that really does nothing costs it once). `look`
   * 'short' (lateLook) is one look at LATE_LOOK_SHORT_MS, with no `why`; one that saw nothing turns later short looks
   * off for the call, as a full one that saw nothing turns full ones off.
   */
  async awaitLateChange(unchanged, look = 'full') {
    const total = this.config.lateChangeMs;
    const state = this.config.retryState;
    if (total <= 0 || (look === 'full' ? state.lateChangeOff : state.lateLookOff)) return null;
    const started = Date.now();
    let waited = 0;
    const rounds = look === 'full' ? LATE_CHANGE_ROUNDS.map(share => Math.round(total * share))
      : [Math.min(LATE_LOOK_SHORT_MS, total)];
    for (const at of rounds) {
      const delay = at - waited;
      // Never past the run's own deadline: the decision after it needs time too.
      if (this.remainingMs() < delay + LATE_CHANGE_RESERVE_MS) break;
      await this.bounded(() => new Promise(resolve => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
      }));
      waited += delay;
      const observation = await this.observe();
      this.visit(observation);
      if (pageMoved(unchanged, observation)) {
        return { observation, ms: Date.now() - started };
      }
    }
    // A short look that saw nothing turns short looks off (a control that stays disabled, a lasting placeholder).
    if (look !== 'full') {
      state.lateLookOff = true;
      return null;
    }
    state.lateChangeOff = true;
    this.why('late_change:none');
    return null;
  }

  /** Whether the task asks for late-loaded content (question or instruction), memoized. */
  lateIntent() {
    this.late ??= classifyIntent(this.question(), this.instruction ?? '') === 'late';
    return this.late;
  }

  /**
   * The loading placeholders of an observation (src/digest.js loadingBlocks, without the persistent status texts this
   * run has seen), less the status lines the attached site profiles name for that page (profiles on; Google Flights
   * keeps "Loading results" on every results page), which need no settle waits to be known.
   */
  loadingOf(observation) {
    const blocks = loadingBlocks(observation, this.persistentLoading);
    if (!blocks.length || !this.config.siteProfiles?.length) return blocks;
    const status = statusFilter(this.config.siteProfiles, observation);
    return status ? blocks.filter(block => !status(block.text)) : blocks;
  }

  /**
   * Late content: while the observation shows a loading placeholder, wait and observe again, up to
   * MAX_CONTENT_WAITS per run. No provider decision is spent. Returns the latest observation (the same object when
   * nothing was loading).
   */
  async awaitContent(observation) {
    let current = observation;
    let previous = null;
    let quiet = 0;
    for (let placeholders = this.loadingOf(current); placeholders.length; placeholders = this.loadingOf(current)) {
      // Persistent status text (the same visible placeholder after PERSISTENT_QUIET_WAITS consecutive settle waits, on
      // a page whose rows did not change; never on the first observation, where it gets the normal waiting): not
      // loading. A hidden one next to rows never gets here (loadingBlocks). It is remembered for the rest of the run
      // (and the list's later steps), so neither the checks below nor the receipt treat it as a placeholder again.
      quiet = persistentPlaceholders(previous, current, placeholders) ? quiet + 1 : 0;
      if (quiet >= PERSISTENT_QUIET_WAITS) {
        for (const block of placeholders) this.persistentLoading.add(String(block.text).trim());
        this.why('content_status:persistent');
        break;
      }
      if (this.contentWaits >= MAX_CONTENT_WAITS) {
        this.why('content_loading');
        break;
      }
      this.contentWaits++;
      this.why('content_wait');
      const delay = this.config.contentWaitMs;
      if (delay > 0) {
        await this.bounded(() => new Promise(resolve => {
          const timer = setTimeout(resolve, delay);
          timer.unref?.();
        }));
      }
      previous = current;
      current = await this.observe();
      this.visit(current);
    }
    return current;
  }

  /**
   * After a consent reject click: re-observe every consentWaitMs (at most MAX_CONSENT_WAITS times, about 2 s) until
   * the dialog closes. Banners often close after a fade or a network round trip, so
   * the observation right after the click can still show them (booking.com). Records `consent:rejected` when it
   * closed, else sets consentPersisted and records `consent:persisted`. Returns the latest observation.
   */
  async awaitConsentClosed(observation, clicked) {
    const open = current => Boolean(consentOf(current));
    let current = observation;
    for (let waits = 0; open(current) && waits < MAX_CONSENT_WAITS; waits++) {
      const delay = this.config.consentWaitMs;
      if (delay > 0) {
        await this.bounded(() => new Promise(resolve => {
          const timer = setTimeout(resolve, delay);
          timer.unref?.();
        }));
      }
      current = await this.observe();
      this.visit(current);
    }
    this.consentPersisted = open(current);
    if (current !== observation) this.why('consent:wait');
    this.why(this.consentPersisted ? 'consent:persisted' : 'consent:rejected');
    return current;
  }

  /**
   * After a nag overlay dismissal: re-observe every consentWaitMs (at most MAX_OVERLAY_WAITS times) until the overlay
   * with this key is gone (a closing animation, a fade). Returns the latest observation.
   */
  async awaitOverlayClosed(observation, key) {
    const open = current => {
      const overlay = overlayOf(current);
      return Boolean(overlay) && overlayKey(overlay) === key;
    };
    let current = observation;
    for (let waits = 0; open(current) && waits < MAX_OVERLAY_WAITS; waits++) {
      const delay = this.config.consentWaitMs;
      if (delay > 0) {
        await this.bounded(() => new Promise(resolve => {
          const timer = setTimeout(resolve, delay);
          timer.unref?.();
        }));
      }
      current = await this.observe();
      this.visit(current);
    }
    return current;
  }

  why(code) {
    if (!this.signals.why.includes(code)) this.signals.why.push(code);
  }

  /** Remember the highest value of each provider guard for the receipt. */
  /**
   * The user's grant dropped mid-run (the extension revoked testing): re-clamp this run's level, capabilities,
   * guardrail policy and `permissions` block in place, so its next decision offers only what the new level allows
   * (the hub and the extension already refuse the rest). Never raises anything.
   */
  lowerGrant(level) {
    const config = this.config;
    if (!isLevel(level) || (config.grant && levelRank(config.grant.level) <= levelRank(level))) return false;
    config.grant = { level, testing: level === 'testing' };
    const effective = clampLevel(config.level, level);
    if (effective !== config.level) {
      config.level = effective;
      config.mode = effective;
      config.capabilities = capabilitiesOf(effective);
      config.guardrails = guardrailPolicy({ mode: effective, merged: config.guardrails.additions });
    }
    config.permissions = { ...config.permissions, granted: level, effective, testing: effective === 'testing' };
    this.result.permissions = { ...config.permissions };
    this.why(`grant:lowered:${level}`);
    return true;
  }

  noteGuards(guards) {
    for (const [name, p] of Object.entries(guards ?? {})) {
      if (!(this.signals.guards[name] >= p)) this.signals.guards[name] = p;
    }
  }

  warn(code) {
    this.result.warnings ??= [];
    if (!this.result.warnings.includes(code)) this.result.warnings.push(code);
  }

  /**
   * `controls_capped:<n>` when controls were left out of what this run could choose from: `n` adds the page script's
   * controlsDropped (its 100-control cap) and `dropped` (the offered actions the MAX_OFFERED cap left out). One entry per
   * result, the largest count seen; a bare `controls_capped` only from a page script that sends no count.
   */
  noteCapped(observation, dropped = 0) {
    const code = cappedWarning(observation, dropped);
    if (!code) return;
    this.result.warnings ??= [];
    const index = this.result.warnings.findIndex(item => /^controls_capped(?::|$)/.test(item));
    if (index < 0) this.result.warnings.push(code);
    else if (cappedCount(code) > cappedCount(this.result.warnings[index])) this.result.warnings[index] = code;
  }

  /** Rung 0 annotations on the first observation: password field, controls cap, expectation lint. */
  precheck(observation) {
    const login = loginState(observation);
    if (login.passwordField && !login.wall) this.warn('password_field');
    this.noteCapped(observation);
    const lint = lintExpectation(this.config.expectation, observation);
    this.signals.expectationShape = lint.shape;
    if (lint.weak) this.warn('expectation_weak');
  }

  /**
   * Pre-passing expectation (rung 0, first observation): a declarative text or title expectation (no URL field)
   * already passes on the start page while the instruction names a click or page the run has not reached (the page's
   * title and path do not match the
   * last named one). Such a pass proves nothing: a textIncludes of a toggle's label passes before and after the
   * click. It is recorded (`expectation_prepassing` in warnings and why), and from then on a pass counts only after at
   * least one action of this run and on a page whose revision or URL differs from the start (prepassOk). A task that
   * names no action ("read the price on this page"), or whose named page is the start page, keeps its pass.
   */
  notePrepass(observation) {
    const expectation = this.config.expectation;
    if (!this.instruction || !expectation || typeof expectation !== 'object') return;
    // Any declarative expectation (URL fields included) that passes on the start page: a later handoff on a page
    // where it still passes proves nothing unless the check failed somewhere in between (vacuousPass).
    try {
      this.startPassed = checkDeclarative(observation, expectation, { initial: observation }) === true;
    } catch {
      this.startPassed = false;
    }

    // A URL check names the page itself: a start page that matches it is the destination. Only text and title checks
    // (which a page can show before the click, like a toggle's own label) are gated.
    if (['urlIncludes', 'urlEquals', 'urlMatches'].some(field => field in expectation)) return;
    let passes = false;
    try {
      passes = checkDeclarative(observation, expectation, { initial: observation }) === true;
    } catch {
      return;
    }
    if (!passes) return;
    const hops = namedHops(this.instruction);
    if (!hops.length) return;
    const here = [String(observation.title ?? '').toLowerCase(), (urlPath(observation.url) ?? '').toLowerCase()].filter(Boolean);
    if (hopsDone(hops.slice(-1), here)) return;
    this.prepass = true;
    this.warn('expectation_prepassing');
    this.why('expectation_prepassing');
  }

  /**
   * Whether a passing expectation proves nothing about this run (E6): it already passed on the start page and never
   * failed on any page since, the run acted, and the provider's done is at most PREPASS_DONE_MAX (it does not see
   * the outcome either). A handoff there is not handoff_expectation_passed: the run goes to the host
   * (`expectation:prepassing`). A run that took no action (a read on the start page) keeps its pass.
   */
  vacuousPass(done) {
    return this.startPassed === true && !this.expectationFailedOnce && this.actionsTaken > 0
      && Number.isFinite(done) && done <= PREPASS_DONE_MAX;
  }

  /**
   * The opening URL hop landed on a page where the expectation passes while the instruction names more to do
   * (namesMoreAfterOpen): from here the landing page is the start page for vacuousPass, so a later handoff that never
   * saw the expectation fail and pass again is reported as a pre-pass (`expectation:prepassing`, `url_landing`).
   */
  holdLanding() {
    this.landingHeld = true;
    this.startPassed = true;
    this.expectationFailedOnce = false;
    this.why('expectation:url_landing');
  }

  /** Records a vacuous pass (vacuousPass) in the receipt: why, warning and, for a urlIncludes, the url_start shape. */
  noteVacuous() {
    this.why('expectation:prepassing');
    this.warn('expectation_prepassing');
    this.warn('expectation_weak');
    if (this.signals.expectationShape === 'url_path') this.signals.expectationShape = 'url_start';
  }

  /**
   * E2, the explicit-URL hop: the first URL the instruction names right after a navigation verb ("Open <url>", "go
   * to", "navigate to", "load", "visit") that is not the current page (sameNamedPage) runs as a navigation without a
   * provider decision. Only a URL on the approved site (the allowedUrls entry for it, else the literal URL when it is
   * same-site within the granted origins), never one whose words sign out, unsubscribe, submit or trip a guardrail
   * class (urlHopRefused), never on a consent dialog, and each URL at most once per run. Only the first named URL:
   * a later one ("open A, click X, then open B") is the provider's, after the work on A. A list step's or re-run's
   * URLs count only when the host wrote them (`hopTemplate`, namedUrls). Returns the action or null.
   */
  urlHop(observation, offered) {
    const config = this.config;
    this.urlHops ??= new Set();
    for (const url of namedUrls(this.instruction, this.hopTemplate).slice(0, 1)) {
      if (this.urlHops.has(url)) continue;
      this.urlHops.add(url);
      // Already there (the named page, maybe with the site's own extra parameters): nothing to do for this URL.
      if (sameNamedPage(url, observation.url)) continue;
      if (urlHopRefused(url, config.guardrails)) {
        this.why('url:refused');
        continue;
      }
      const listed = offered.find(candidate => candidate.type === 'navigate_allowed_url' && !candidate.newTab
        && sameNamedPage(candidate.url, url) && sameNamedPage(url, candidate.url));
      if (listed) return listed;
      let origin = null;
      try {
        origin = originOf(observation.url);
      } catch {
        return null;
      }
      if (!sameSite(observation.url, url, config.allowedOrigins ?? [origin])) {
        this.why('url:outside_origins');
        continue;
      }
      return { id: 'url', type: 'navigate_allowed_url', url, label: url,
        description: `Navigate to the URL the instruction names: ${url}` };
    }
    return null;
  }

  /** Whether a pass on `observation` counts: always, unless the expectation was pre-passing (notePrepass). */
  prepassOk(observation) {
    if (!this.prepass) return true;
    return this.actionsTaken > 0 && Boolean(this.initial)
      && (observation?.revision !== this.initial.revision || observation?.url !== this.initial.url);
  }

  /**
   * Whether a run may end on a passing expectation right after an action, whatever the provider's done says:
   * a list step (its expectation is the host's check for that hop) whose named clicks or pages, if any, are done, or a
   * run whose instruction is a bounded imperative (one or two named actions, src/oversight.js boundedImperative)
   * once every named target was clicked or reached. "Done" is a conjunction over every named hop, in the
   * instruction's order, one of the run's own provider-chosen actions per hop (hopsDoneInOrder over hopEvents: the
   * action's label, or the title or path of the page it landed on; an action that changed nothing and a consent
   * click do no hop). A list step that names no click or page ends only when the action made the expectation pass
   * (`flipped`): an expectation that passed before the action and still passes proves nothing about that action.
   */
  earlyEnd(observation, { flipped }) {
    const hops = this.config.listStep ? actionHops(this.instruction) : boundedImperative(this.instruction);
    if (!hops) return false;
    if (!hops.length) return flipped;
    // The page the last action landed on may have settled since it was recorded (awaitContent).
    const last = this.hopEvents.at(-1);
    if (last?.changed) last.texts = [...last.texts.slice(0, last.labelled ? 1 : 0), ...pageTexts(observation)];
    return hopsDoneInOrder(hops, this.hopEvents.map(event => event.texts));
  }

  /** Records a provider-chosen action for earlyEnd: its label (a select's option too) and its landing page, unless it changed nothing. */
  hopEvent(action, step, observation) {
    const changed = step.changed === true && !action.consent;
    // A select's text is its control label and the option it chose ("Delivery speed Standard (3-5 days)").
    const text = [action.label, action.type === 'select' ? action.optionLabel : null].filter(Boolean).join(' ');
    const label = changed && text ? [text.toLowerCase()] : [];
    this.hopEvents.push({ changed, labelled: label.length > 0, texts: changed ? [...label, ...pageTexts(observation)] : [] });
  }

  /**
   * End the run on a passing expectation after its own action (earlyEnd), without the terminal decide. The page
   * guards are still asked: with the provider's slim done-and-guards request (confirm), next to the answer ranking
   * (cost.requests kind `step_guards`, one request like the terminal decide it replaces, with no action to choose), and
   * a blocked score marks the result `guard:blocked_page` as the terminal decide would. When the provider has no
   * confirm() (custom SDK providers; TypeSafe and local SystemOne have it) or that request fails, returns false and
   * the terminal decide follows as before, so the page guards are never skipped.
   */
  async endOnPass(observation, history) {
    if (typeof this.provider?.confirm !== 'function') return false;
    // The read clause first: a price, count or hours question on a page with no line of that shape is not answered
    // here (the named page was reached, but the fact sits one page further: "Open Contact and read the opening hours
    // of the Lisbon office"). The done-gated terminal decide follows instead.
    const read = this.readClause();
    if (read && !pageHasShape(observation, read.intent)) {
      this.why('early_end:read_unmet');
      return false;
    }
    // The answer ranking runs next to the guards request, with or without answerQuestion (the instruction is then
    // the question, and the run's end ranks it anyway): never serially after it.
    this.speculateAnswer(observation);
    this.prefetchCapture();
    const stop = await this.siteGuards(observation, history, 'step_guards');
    if (stop === 'guard_error') {
      this.discardSpeculation();
      return false;
    }
    // A bounded imperative that reads a fact ends here only when the ranked answer passes the autoConfirm gates;
    // otherwise the done-gated terminal decide judges the page (the ranking stays for it when it ends here).
    if (read && !this.config.listStep && !(await this.earlyAnswerConfirmed(observation, read))) {
      this.why('early_end:read_unmet');
      return false;
    }
    const signInPage = this.config.capabilities.has('sign_in') && loginState(observation).passwordField;
    if (stop === 'blocked' && !signInPage) this.why('guard:blocked_page');
    this.why(this.config.listStep ? 'step:expectation_end' : 'early_end:named_actions');
    setOutcome(this.result, 'expectation_passed');
    return true;
  }

  /**
   * The run's read clause, for an early end: `{question, intent}` when the run asks a question (answerQuestion) or its
   * instruction reads, finds or reports something; null for a pure navigation ("Click Next page.").
   */
  readClause() {
    const asked = this.config.answerQuestion ?? this.callQuestion;
    if (!asked && !READ_CLAUSE.test(this.instruction ?? '')) return null;
    const question = this.question();
    return { question, intent: classifyIntent(question, this.instruction ?? '') };
  }

  /**
   * Whether the answer ranking started for `observation` (speculateAnswer) has a top candidate at or above the
   * autoConfirm gates (confidence, shape for the question's intent, margin). No ranking (one candidate, no choose(),
   * a local provider) never auto-confirms anything, so it does not hold the early end back; a failed ranking does.
   */
  async earlyAnswerConfirmed(observation, read) {
    const speculation = this.speculation;
    if (!speculation || speculation.discarded || speculation.observation !== observation) return true;
    const outcome = await speculation.promise;
    if (speculation.discarded) return false;
    if (!outcome?.ranked) return false;
    const answer = {
      method: 'provider',
      candidates: outcome.ranked.map(({ candidate, confidence }) => ({
        text: candidate.text, confidence, t: candidate.t, items: candidate.items,
      })),
    };
    return autoConfirm(answer, { question: read.question, instruction: this.instruction ?? '',
      thresholds: this.config.thresholds }).answer !== null;
  }

  /**
   * cross_origin naming the origin the tab is on (a URL origin, not page text), or `onward`: the approved-origin
   * gap a consent wall would redirect to once answered.
   */
  crossOrigin(observation, onward) {
    setOutcome(this.result, 'cross_origin');
    if (onward) {
      this.result.needs.message = `The tab is on a consent page that continues to ${onward}, which this request does `
        + `not cover. Call fai_browser_run again with ${onward} added to origins, or ask the user to answer the `
        + 'consent page themselves.';
      this.why(`origin:${onward}`);
      this.why('consent:continue_not_approved');
      return this.result;
    }
    let origin = '';
    try {
      origin = originOf(observation.url);
    } catch {
      // Unparsable URL: the generic message stands.
    }
    if (origin && origin !== 'null') {
      this.result.needs.message = `The tab is on ${origin}, which this request does not cover. Ask the user to return `
        + `to an approved page. ${this.siteAdvice(origin)}`;
      this.why(`origin:${origin}`);
    }
    return this.result;
  }

  /** What would cover `origin` (URL-derived, never page text): the domain root of a sibling subdomain, or the origin. */
  siteAdvice(origin) {
    const allowed = this.config.allowedOrigins ?? [];
    // A consent wall's host is requested exactly (README: Google needs https://consent.google.com), never as a root.
    const entry = consentContinueHost(origin) ? null : siteEntryFor(origin);
    // A sibling subdomain of an approved https origin (also when the user approved a requested root for one origin
    // only: the lease then lists that origin, and asking again with the root opens a new approval).
    if (entry && allowed.some(item => siteHost(item) && siteEntryFor(item) === entry)) {
      return `If the task needs it, call fai_browser_run again with ${entry} in origins (it covers every https `
        + `subdomain of ${entry.slice('https://*.'.length)}).`;
    }
    return `If ${origin} is a consent or redirect page the task needs, call fai_browser_run again with ${origin} added `
      + 'to origins.';
  }

  /** A consent dialog the runtime cannot dismiss with a reject / necessary-only button. */
  consentBlocked(consent) {
    setOutcome(this.result, 'consent_banner');
    const text = consentText(consent);
    if (text) this.result.needs.dialog = text;
    if (this.consentPersisted) {
      this.result.needs.message = 'The cookie dialog stayed open after FAI Browser clicked its reject button. Ask the '
        + 'user to dismiss it in the tab (reject or necessary only), then run again with the requestId.';
    } else {
      this.why('consent:no_reject');
    }
    return this.result;
  }

  /** The irreversible action the instruction asks for (commitIntent), memoized; null for ordinary tasks. */
  intent() {
    if (this.intentKind === undefined) this.intentKind = this.instruction ? commitIntent(this.instruction) : null;
    return this.intentKind;
  }

  /**
   * Refusal receipt: the instruction asks to buy, order, pay, delete, remove, send, submit or log in, and the page's
   * controls for it are ones the run's level refuses. Ends the run needs_user / refused_action without a provider
   * decision (see refuse() for stop versus relay). Returns the result, or null when the task is not refused here.
   */
  refusal(observation, { defer = true } = {}) {
    const intent = this.intent();
    if (!intent) return null;
    // Both conditions: the instruction asks for the action in its dangerous sense (commitIntent), and the page's
    // controls for it are refused ones. A refused control that is an ordinary view control ("Remove filter",
    // "Search") is not one, and a usable control with the same intent (a toggle) means the task is not refused here.
    const entries = blockedEntries(observation, this.config);
    const blocked = new Set(entries.map(entry => entry.control));
    const matching = entries.filter(({ control }) => (labelIntents(control.label).has(intent)
      || (intent === 'submit' && control.risk === 'submit')) && !harmlessControlLabel(control.label));
    if (!matching.length) return null;
    const usable = (observation.controls ?? []).some(control => !blocked.has(control) && control.role !== 'link'
      && control.enabled !== false && control.visible !== false && labelIntents(control.label).has(intent)
      && !harmlessControlLabel(control.label));
    if (usable) return null;
    // With the intent question on, a control Jev may clear (intentEligible) that the instruction names goes to the
    // decision first; a decision that does not run it refuses as here (the handoff path calls this with `defer` off).
    if (defer && this.intentOn() && matching.some(entry => entry.intent && relevanceScore(entry.control, this.hints) > 0)) {
      this.why('intent:deferred');
      return null;
    }
    return this.refuse(intent, matching);
  }

  /** The intent question applies: the provider's `intent` switch is on, below testing, at a level with controls. */
  intentOn() {
    return this.provider?.guidance?.intent === true && this.config.level !== 'testing'
      && this.config.capabilities.has('controls');
  }

  /**
   * Whether the decision clears `action`, an ambiguous refused control offered with the intent question (its
   * `intent`). Resolves `{ cleared: <class>, capability }` or `{ kept: <reason> }`; every missing or doubtful signal
   * keeps it (fail closed): no answer (the switch off, an invalid reply), purchase_or_payment, a label outside the
   * ambiguous tier or forbidden by the user, a payment or password field on the page, a purchase noul unanswered or
   * at commitVeto, the injection noul unanswered or at INJECTION_NOTE, the commit noul (reversible) at commitVeto,
   * purchase_or_payment at INTENT_DOUBT, confidence under INTENT_FLOOR, or a class whose capability the level lacks.
   */
  intentVerdict(decision, action, observation) {
    const answer = decision?.intents?.[action.id];
    if (!answer || typeof answer.choice !== 'string' || !Object.hasOwn(INTENT_CLASSES, answer.choice)) return { kept: 'unanswered' };
    if (answer.choice === 'purchase_or_payment') return { kept: 'purchase_or_payment' };
    if (labelTier(action.label) !== 'ambiguous') return { kept: 'hard_tier' };
    if (this.config.guardrails.forbids(action.label)) return { kept: 'forbid' };
    const facts = pageFacts(observation);
    if (facts.payment) return { kept: 'payment_field' };
    if (facts.password) return { kept: 'password_field' };
    const guards = guardsOf(decision) ?? {};
    const veto = this.config.thresholds.commitVeto;
    const low = (p, limit) => Number.isFinite(p) && p < limit;
    if (!low(guards.purchase_control, veto) || !low(guards.purchase_page, veto)) return { kept: 'purchase_guard' };
    if (!low(guards.injection, INJECTION_NOTE)) return { kept: 'injection' };
    if (this.config.level === 'reversible' && Number.isFinite(guards.commit) && guards.commit >= veto) return { kept: 'commit_guard' };
    const doubt = answer.probabilities?.purchase_or_payment;
    if (Number.isFinite(doubt) && doubt >= INTENT_DOUBT) return { kept: 'purchase_doubt' };
    if (!(Number.isFinite(answer.confidence) && answer.confidence >= INTENT_FLOOR)) return { kept: 'low_confidence' };
    const capability = INTENT_CLASSES[answer.choice];
    if (!this.config.capabilities.has(capability)) return { kept: answer.choice, capability };
    return { cleared: answer.choice, capability };
  }

  /**
   * End the run as refused_action for an ambiguous control the intent question did not clear, as the mechanical
   * refusal would have: a purchase (the label's class, or Jev's purchase_or_payment) stops, a submission relays the
   * level it needs (the class Jev named, else the label's). `intent:kept:<reason>` is listed in the receipt's why.
   */
  intentKept(action, verdict) {
    this.why(`intent:kept:${verdict.kept}`);
    const purchase = verdict.kept === 'purchase_or_payment' || (action.intent?.kind === 'purchase' && !verdict.capability);
    const kind = purchase ? 'purchase' : 'submit';
    const capability = purchase ? 'purchase' : verdict.capability ?? action.intent?.capability ?? 'submit';
    const control = { id: String(action.target), role: action.role, label: action.label };
    this.refuse(kind, [{ control, kind, capability }]);
    this.result.needs.control = { ref: String(action.target), label: clip(action.label, 120) };
    return this.result;
  }

  /**
   * The chosen ambiguous control, cleared or refused: the action to run (marked `intentCleared` with the capability
   * of its class, which page.js checks against its own mark and the grant), or the refused result.
   */
  intentGate(decision, action, observation) {
    const verdict = this.intentVerdict(decision, action, observation);
    if (verdict.kept) return { result: this.intentKept(action, verdict) };
    this.why(`intent:cleared:${verdict.cleared}`);
    const { intent, ...rest } = action;
    return { action: { ...rest, intentCleared: verdict.capability } };
  }

  /** The purchase guard (purchase_control or purchase_page) is at or above thresholds.commitVeto, below testing. */
  purchaseHigh(decision) {
    if (this.config.level === 'testing' || !this.config.capabilities.has('controls')) return false;
    const guards = guardsOf(decision);
    const veto = this.config.thresholds.commitVeto;
    return [guards?.purchase_control, guards?.purchase_page].some(p => Number.isFinite(p) && p >= veto);
  }

  /** The broad commit guard is at or above thresholds.commitVeto for this decision (reversible only). */
  commitHigh(decision) {
    if (this.config.level !== 'reversible') return false;
    const p = guardsOf(decision)?.commit;
    return Number.isFinite(p) && p >= this.config.thresholds.commitVeto;
  }

  /**
   * True when `action` is a button the instruction names as a click target and the run has not used up yet
   * (src/relevance.js namedControls over the offered actions and the provider history: plain buttons whose labels
   * trip no guardrail class, the user's forbid phrases included, never a link, never in a negated clause).
   */
  namedChoice(action, offered, history) {
    if (!action || action.type !== 'click' || !this.config.capabilities.has('controls')) return false;
    const named = namedControls(this.instruction, offered, { forbid: this.config.guardrails.additions.forbid, history });
    return named.some(entry => entry.ids.includes(action.id));
  }

  /**
   * True when the instruction names at least one offered button as a click target and the run has clicked each as
   * often as the instruction names it (namedControls without and with the history).
   */
  namedClicksDone(offered, history) {
    if (!this.config.capabilities.has('controls')) return false;
    const forbid = this.config.guardrails.additions.forbid;
    const named = namedControls(this.instruction, offered, { forbid });
    if (!named.length || namedControls(this.instruction, offered, { forbid, history }).length) return false;
    // At least one of those clicks changed the page: a named click that did nothing on a start page where the
    // expectation already passed must not turn a doubtful choice into a completion.
    const keys = new Set(named.map(entry => bareLabel(entry.label).toLowerCase()));
    return history.some(entry => entry?.type === 'click' && entry.changed === true && keys.has(bareLabel(entry.label).toLowerCase()));
  }

  /** Either guard would veto a button, select or fill on this decision. */
  controlVeto(decision) {
    return this.purchaseHigh(decision) || this.commitHigh(decision);
  }

  /**
   * Purchase guard veto (below testing): Jev judged that the button, select or fill that best advances the
   * instruction would pay, order, book, subscribe or move money, or that the page is a checkout or confirmation
   * step. Nothing is executed; the run ends needs_user / refused_action, verdict failed, next stop.
   */
  purchaseVeto(action) {
    setOutcome(this.result, 'refused_action', 'the purchase guard judged the next control to be a purchase');
    this.result.needs.message = PURCHASE_REFUSAL_TEXT;
    if (action?.target !== undefined) {
      this.result.needs.control = { ref: String(action.target), label: clip(action.label, 120) };
    }
    this.why('guard:purchase_veto');
    return this.result;
  }

  /**
   * Commit guard veto (reversible, as before the levels): Jev judged that the button, select or fill that best
   * advances the instruction would order, pay, send, delete, sign in or otherwise commit the user. Nothing is
   * executed; the run ends needs_user / refused_action (verdict failed, next stop) like the mechanical refusal. The
   * commit noul also covers purchases, so it is never relayed as a level request. `needs.control` names the vetoed
   * control (its page label, untrusted); the trusted message is REFUSAL_TEXT.
   */
  commitVeto(action) {
    setOutcome(this.result, 'refused_action', 'the commit guard judged the next control to commit the user');
    this.result.needs.message = REFUSAL_TEXT;
    if (action?.target !== undefined) {
      this.result.needs.control = { ref: String(action.target), label: clip(action.label, 120) };
    }
    this.why('guard:commit_veto');
    return this.result;
  }

  /**
   * Turn a refused_action into a level request: `needs.level` and a trusted message naming the grant and the level
   * the task needs. With a grant that already covers it, the host is told to run again with that mode instead.
   */
  needLevel(needed) {
    // Without a grant (an SDK caller with its own bridge) the ceiling is `full`, as in configure().
    const granted = this.config.grant?.level ?? 'full';
    this.result.needs.level = needed;
    this.result.needs.message = levelRefusalText({ granted, needed });
    if (levelRank(granted) >= levelRank(needed)) this.result.needs.who = 'host';
    this.why(`level:${needed}`);
  }

  /**
   * End the run as refused_action for `intent`. Purchases below testing stop (PURCHASE_REFUSAL_TEXT); a control the
   * user forbade, or one no level allows, stops (REFUSAL_TEXT); anything a higher level would allow relays a level
   * request (needs.level). `entries` are the blocked controls behind the refusal (blockedEntries), when known.
   */
  refuse(intent, entries = null) {
    setOutcome(this.result, 'refused_action');
    this.why(`refused:${intent}`);
    const level = this.config.level;
    const list = entries ?? [];
    const purchase = level !== 'testing' && (intent === 'purchase' || list.some(entry => entry.kind === 'purchase'));
    if (intent === 'all_controls_blocked') {
      // Every control is refused: a level that would allow any of them (purchases aside) is worth asking for.
      const needed = levelToUnblock(list.filter(entry => entry.kind !== 'purchase'), level);
      if (needed) {
        this.needLevel(needed);
        return this.result;
      }
    }
    if (purchase) {
      this.result.needs.message = PURCHASE_REFUSAL_TEXT;
      return this.result;
    }
    if (list.some(entry => entry.kind === 'forbid')) {
      this.result.needs.message = FORBID_REFUSAL_TEXT;
      return this.result;
    }
    let needed = null;
    if (!entries) needed = nextLevelFor(INTENT_CAPABILITY[intent], level);
    else if (list.length && list.every(entry => entry.capability)) needed = levelToUnblock(list, level);
    if (needed) {
      this.needLevel(needed);
      return this.result;
    }
    this.result.needs.message = REFUSAL_TEXT;
    return this.result;
  }

  /**
   * An HTTP error page (404, 410, 500, 502, 503, 504 by status, title, heading or a tiny body) ends the run failed /
   * error_page before any further provider decision, unless the host's expectation passes on it (the host asked
   * for that page: "read the error reference the Billing page shows"). The browser's own error page is never exempt:
   * it keeps the URL the tab tried and a fixed text, so a URL or textAbsent expectation would pass on a page that
   * shows nothing; any pass recorded there is withdrawn. Returns the result or null.
   */
  async errorPage(observation, hasExpectation) {
    const error = errorPageOf(observation);
    if (!error) return null;
    const label = error.status ? `http:${error.status}` : 'http:error';
    const browser = error.source === 'browser';
    if (!browser && hasExpectation && await this.expectationFor(observation)) {
      this.why(label);
      return null;
    }
    if (browser && this.result.verification?.passed === true) {
      this.result.verification.passed = false;
      if (this.lastCheck?.observation === observation) this.lastCheck = { observation, passed: false };
    }
    setOutcome(this.result, 'error_page', error.status ? `HTTP ${error.status}` : undefined);
    this.why(label);
    this.why(`error_source:${error.source}`);
    return this.result;
  }

  /** Default the approved origins to the first page's origin, as before. */
  resolveOrigins(observation) {
    if (this.config.allowedOrigins) return;
    try {
      this.config.allowedOrigins = [originOf(observation.url)];
    } catch {
      throw bridgeError('invalid_observation', 'Observation URL is not valid', false);
    }
  }

  /**
   * The context for provider.decide(): instruction, history and run id, plus the level (as `mode` and `level`), its
   * capabilities and any guardrail additions so the provider renders state.policy (src/guardrails.js) and asks the
   * purchase guard below testing and the commit guard in reversible mode. The
   * additions are host- or config-written plain phrases, never page text.
   */
  decideContext(instruction, history, { withSite = false, observation = null } = {}) {
    const context = {
      instruction,
      history,
      runId: this.result.runId,
      mode: this.config.level,
      level: this.config.level,
      capabilities: [...this.config.capabilities],
    };
    const { forbid, note } = this.config.guardrails.additions;
    if (forbid.length || note) context.guardrails = { forbid: [...forbid], note };
    // slim.controls: the provider sends every control once (TypeSafeProvider compactPlan). `hints` rank the links
    // whose path stays in their option; they are host-written and the provider never sends them.
    if (this.config.slim.controls) {
      context.compact = true;
      context.hints = this.hints;
    }
    // A site-profile hint for a full decide only (never the slim terminal or guards request) (fixed templates over filtered plain phrases; src/domains.js renderSite).
    // On the profile's pages it also carries the profile's notes (src/domains.js SiteRun.context).
    const site = withSite ? this.site?.context(observation) : null;
    if (site) context.site = site;
    return context;
  }

  async decide(observation, actions, history, instruction = this.instruction, kind = 'decide') {
    let decision;
    this.pairedRequest = null;
    const started = Date.now();
    // slim.cap: the provider sees at most DEFAULT_OPTION_CAP options; the caller keeps the full offered set.
    let dropped = 0;
    // A site profile's pinned controls (date arrows, Date grid) are kept like essential options.
    if (this.config.slim.cap && kind !== 'guard') {
      ({ actions, dropped } = capActions(actions, DEFAULT_OPTION_CAP, this.hints, this.site?.pinned(observation) ?? null));
    }
    // A site profile's plain names for page-script names of unnamed controls ("next-value button after ..."), in
    // copies; ids unchanged.
    if (this.site && kind !== 'guard') ({ observation, actions } = this.site.present(observation, actions));
    try {
      // Supplied values echoed by the page are redacted here, the single provider boundary.
      const payload = providerPayload(observation, actions, history, this.config.suppliedText);
      const redact = redactorFor(this.config.suppliedText);
      decision = await this.bounded(() => this.provider.decide(
        payload.observation,
        payload.actions,
        this.decideContext(redact(instruction), payload.history, { withSite: kind === 'decide', observation }),
        this.signal,
      ));
    } catch (error) {
      const aborted = this.signal.aborted || this.interrupted;
      this.lastRequest = this.noteRequest(kind, started, null, aborted ? 'cancelled' : 'provider_error');
      if (dropped) this.lastRequest.optionsDropped = dropped;
      if (aborted) throw error;
      const wrapped = bridgeError('provider_error', String(error?.message ?? error), false);
      wrapped.cause = error;
      throw wrapped;
    }
    const cost = this.result.cost;
    cost.decisions++;
    this.addUsage(decision?.usage);
    this.lastRequest = this.noteRequest(kind, started, decision);
    // The trace marker of a capped request: how many offered options the provider did not see.
    if (dropped) this.lastRequest.optionsDropped = dropped;
    if (decision?.model) cost.provider = decision.model;
    if (decision && typeof decision === 'object') this.lastDecision = decisionRecord('provider', decision);
    return decision;
  }

  /**
   * slim.terminal: ask the provider only whether the outcome is visible (done) and the blocked/injection guards on a
   * page where the expectation already passes (provider.confirm). Resolves the reply when done reaches doneThreshold,
   * else null after marking its cost.requests entry `fallback` (the caller then sends the full decide, which does not
   * count against maxDecisions). A failed request is a fallback too; only an abort is thrown.
   */
  async confirmTerminal(observation, history) {
    const started = Date.now();
    let reply;
    try {
      const payload = providerPayload(observation, [], history, this.config.suppliedText);
      const redact = redactorFor(this.config.suppliedText);
      reply = await this.bounded(() => this.provider.confirm(
        payload.observation,
        this.decideContext(redact(this.instruction), payload.history),
        this.signal,
      ));
    } catch (error) {
      const aborted = this.signal.aborted || this.interrupted;
      const entry = this.noteRequest('terminal', started, null, aborted ? 'cancelled' : 'provider_error');
      if (aborted) throw error;
      entry.fallback = true;
      return null;
    }
    const cost = this.result.cost;
    cost.decisions++;
    this.addUsage(reply?.usage);
    const entry = this.noteRequest('terminal', started, reply);
    if (reply?.model) cost.provider = reply.model;
    const done = doneProbability(reply);
    if (done !== null && done >= this.config.thresholds.doneThreshold) {
      this.lastRequest = entry;
      this.lastDecision = decisionRecord('provider', { ...reply, actionId: 'done' });
      return reply;
    }
    entry.fallback = true;
    // The full decide that follows replaces this request in the decision budget.
    this.extraDecisions++;
    return null;
  }

  /**
   * The page guards for a page a site-profile fast hop leaves: the provider's slim done-and-guards request (confirm),
   * recorded in cost.requests as `site_guards` (not a decision) and fed into the run-wide guard signals. Resolves the
   * fallback reason that ends the fast path ('blocked' at GUARD_VETO, 'injection' at INJECTION_NOTE, 'guard_error' when the
   * request failed) or null. Never rejects. A stale re-resolve (the run loop) sends the same request as `stale_guards`.
   */
  async siteGuards(observation, history, kind = 'site_guards', onGuards = null) {
    const started = Date.now();
    try {
      const payload = providerPayload(observation, [], history, this.config.suppliedText);
      const redact = redactorFor(this.config.suppliedText);
      const reply = await this.bounded(() => this.provider.confirm(
        payload.observation,
        this.decideContext(redact(this.instruction), payload.history),
        this.signal,
      ));
      this.addUsage(reply?.usage);
      this.noteRequest(kind, started, reply);
      const guards = guardsOf(reply);
      if (guards) this.noteGuards(guards);
      onGuards?.(guards);
      if (guards?.blocked >= GUARD_VETO) return 'blocked';
      if (guards?.injection >= INJECTION_NOTE) return 'injection';
      return null;
    } catch {
      this.noteRequest(kind, started, null, this.signal.aborted || this.interrupted ? 'cancelled' : 'provider_error');
      return 'guard_error';
    }
  }

  /** Add a provider reply's reported token usage to the run totals. */
  addUsage(usage) {
    if (!usage) return;
    this.result.cost.inputTokens += Number(usage.input_tokens ?? usage.inputTokens) || 0;
    this.result.cost.outputTokens += Number(usage.output_tokens ?? usage.outputTokens) || 0;
  }

  /**
   * Record one provider request in cost.requests: `kind` (decide, choose, or guard for act()'s purchase guard),
   * `ms` (wall time as the runtime waited for it, retries included), `inputTokens`/`outputTokens` when the provider
   * reported usage, `providerMs` when it reported its own latency, and `error` (a fixed code) when it failed.
   * execute() adds `step` to a decide whose choice ran. With a provider that reports its body size (TypeSafeProvider
   * requestSizes): `chars` (JSON characters by section: total, instruction, policy, page, text, controls, history,
   * options, questions, ...), `options` (choices offered) and `controls` (controls sent in the page).
   * Numbers and fixed codes only: no payloads, no page text.
   */
  noteRequest(kind, started, reply, error) {
    const entry = { kind, ms: Date.now() - started };
    const usage = reply?.usage;
    if (usage) {
      const input = Number(usage.input_tokens ?? usage.inputTokens);
      const output = Number(usage.output_tokens ?? usage.outputTokens);
      if (Number.isFinite(input)) entry.inputTokens = input;
      if (Number.isFinite(output)) entry.outputTokens = output;
    }
    if (Number.isFinite(reply?.latencyMs)) entry.providerMs = reply.latencyMs;
    const sizes = requestSizesOf(reply?.request);
    if (sizes) Object.assign(entry, sizes);
    if (error) entry.error = error;
    // Any provider failure in this run stops early answer rankings for the rest of it (a failed slim terminal
    // request is followed at once by the full decide, which decides that).
    if (error && error !== 'cancelled' && kind !== 'terminal') this.earlyRankingOff = true;
    this.result.cost.requests.push(entry);
    this.config.retryState.requests++;
    return entry;
  }

  /**
   * Execute one legal action. The step is recorded before the bridge call so an interrupted action still appears
   * in the trace. The screenshot promise is stored as pending and awaited later by finalizePending().
   */
  async execute(action, before, decision, decisionStart, decisionMs) {
    // An action changes the page: an answer ranking started for this one can no longer be the final one.
    this.discardSpeculation();
    const command = toCommand(action, this.config.suppliedText);
    // A value filled into a password input is a secret: redacted from the receipt and the trace at close().
    if (action.sensitive && typeof command.text === 'string' && !this.result.secrets.includes(command.text)) {
      this.result.secrets.push(command.text);
      this.runtime.secrets?.add(command.text);
    }
    const step = {
      i: this.nextStep(),
      action: stepAction(action, command, before.url),
      class: actionClass(action),
      decision,
      ms: { decision: decisionMs, settle: 0, capture: 0, total: 0 },
      settle: 'none',
      screenshot: null,
      observation: null,
      changed: false,
    };
    this.result.steps.push(step);
    const capture = this.capturesEachAction();

    let execution;
    try {
      const { forbid, level } = this.config.guardrails.wire();
      const options = forbid ? { capture, forbid, level } : { capture, level };
      execution = scrubSecrets(await this.bounded(() => this.bridge.execute(command, before.revision, options, this.signal)),
        this.runtime.secretIds);
      validateObservation(execution?.observation);
    } catch (error) {
      if (error?.code === 'stale' || error?.code === 'target_unavailable' || error?.code === 'unsupported') {
        // The page script rejects these before acting, so nothing happened; drop the record.
        this.result.steps.pop();
      } else {
        // The action may or may not have run (e.g. Stop during execution). Keep it, marked as interrupted.
        step.interrupted = true;
        step.error = { code: typeof error?.code === 'string' ? error.code : 'failed' };
        step.ms.total = Date.now() - decisionStart;
      }
      throw error;
    }

    const executedAt = Date.now();
    // The decide request whose choice this step ran (a terminal or vetoed decide never gets a step).
    if (decision?.by === 'provider' && ['decide', 'second_opinion'].includes(this.lastRequest?.kind)
      && this.lastRequest.step === undefined) {
      this.lastRequest.step = step.i;
      if (this.pairedRequest && this.pairedRequest.step === undefined) this.pairedRequest.step = step.i;
    }
    this.pairedRequest = null;
    const after = execution.observation;
    step.action.toUrl = after.url;
    step.settle = execution.settle?.reason ?? 'none';
    // The extension reports a navigation inside settle (bridge.js forwards only observation and settle).
    if (execution.settle?.navigated === true || execution.navigated === true) step.navigated = true;
    step.ms.settle = Number.isFinite(execution.settle?.ms) ? execution.settle.ms : 0;
    step.observation = compactStepObservation(after);
    step.changed = after.revision !== before.revision || after.url !== before.url;
    // A fill the field did not keep (reverted or ignored) is no progress, whatever else the input event moved (a
    // dropdown, a focus ring); the caller ends the run or act on it (fill_not_kept).
    const fill = fillOutcome(action, execution, after);
    if (fill) {
      step.fill = fill;
      if (!fill.kept) step.changed = false;
    }
    this.result.observation = after;

    // Record when capture actually finished, independent of when it is awaited, so ms.capture is real latency.
    // `deferred`: capture 'last' on a bridge with capture(); the screenshot is requested only if this step is final.
    const pending = {
      step, observation: after, executedAt, decisionStart, capturedAt: null, screenshot: null,
      deferred: this.config.capture === 'last' && !capture,
    };
    pending.screenshot = capture
      ? Promise.resolve(execution.screenshot).then(
        value => {
          pending.capturedAt = Date.now();
          return value ?? null;
        },
        error => {
          pending.capturedAt = Date.now();
          return { error: { code: 'capture_failed', message: String(error?.message ?? error) } };
        },
      )
      : Promise.resolve(null);
    this.pending = pending;
    return { step, observation: after };
  }

  /**
   * Attach the pending step's screenshot and fire onAction.
   *
   * capture 'each': always await the screenshot. In run() this is called after the next provider decision, so the
   *   capture overlaps the provider call instead of adding to the step time.
   * capture 'last': actions run without capture, and only the final step is captured, with one bridge.capture()
   *   call when the run ends. Executes then never wait on Chrome's capture quota. A bridge without capture() is
   *   asked to capture every action instead and all but the final screenshot are discarded unawaited.
   * capture 'none': the bridge was asked not to capture; the promise resolves null.
   */
  async finalizePending(final) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    const { step } = pending;
    const keep = this.config.capture === 'each' || (this.config.capture === 'last' && final);
    let end = pending.executedAt;
    // An early capture (prefetchCapture, started next to the terminal decide) is used when it delivered an image or a
    // revision verdict; a failed or cut-off one falls through to the capture below, exactly as without it.
    const early = pending.early ? await withCap(pending.early.promise, SCREENSHOT_WAIT_MS) : null;
    if (keep && pending.deferred && early && !early.error) {
      applyScreenshot(step, early, pending.observation.revision);
      step.ms.capture = Math.max(0, (pending.early.at ?? Date.now()) - pending.early.started);
    } else if (keep && pending.deferred) {
      // Skipped once the run was stopped or cancelled. A run that only ran out of time still holds a valid lease:
      // it captures with its own short cap. The page may have moved on since the observation (a late navigation);
      // applyScreenshot then rejects the image as revision_mismatch, as for any capture.
      const timedOut = !this.interrupted && !this.callerSignal?.aborted && this.timeoutSignal.aborted;
      if (!this.signal.aborted || timedOut) {
        const started = Date.now();
        const value = timedOut
          ? await withCap(this.captureNow(pending, LATE_CAPTURE_MS), LATE_CAPTURE_MS)
          : await withCap(this.captureNow(pending), SCREENSHOT_WAIT_MS);
        applyScreenshot(step, value, pending.observation.revision);
        step.ms.capture = Date.now() - started;
      }
    } else if (keep) {
      const value = await withCap(pending.screenshot, SCREENSHOT_WAIT_MS);
      applyScreenshot(step, value, pending.observation.revision);
      const capturedAt = pending.capturedAt ?? Date.now();
      step.ms.capture = Math.max(0, capturedAt - pending.executedAt);
      end = Math.max(end, capturedAt);
    }
    step.ms.total = end - pending.decisionStart;
    await this.notify(step, pending.observation);
  }

  /**
   * capture 'last': start the pending step's final capture now, next to the decision that is likely the last (the
   * expectation already passes on this page), instead of serially in close(). finalizePending() uses the result when
   * the run ends here, and otherwise waits for it before the next action (so no capture overlaps an execute) and drops
   * it. At most one per pending step.
   */
  prefetchCapture() {
    const pending = this.pending;
    if (!pending?.deferred || pending.early || this.signal.aborted) return;
    const early = { started: Date.now(), at: null, promise: null };
    early.promise = this.captureNow(pending).then(value => {
      early.at = Date.now();
      return value;
    });
    pending.early = early;
  }

  /** 'each' always; 'last' only when the bridge cannot capture on demand; never for 'none'. */
  capturesEachAction() {
    if (this.config.capture === 'none') return false;
    return this.config.capture === 'each' || typeof this.bridge.capture !== 'function';
  }

  /**
   * On-demand capture of the current page for the final step (capture 'last'). The extension labels the image
   * with the revision it actually shows; applyScreenshot rejects it as revision_mismatch if the page changed
   * after the action, exactly as for per-action captures. Resolves a ScreenshotOutcome and never rejects.
   */
  captureNow(pending, lateCapMs = 0) {
    const { action } = pending.step;
    const command = { type: action.type };
    for (const key of ['value', 'direction', 'url']) if (action[key] !== undefined) command[key] = action[key];
    if (action.ref !== undefined) command.target = action.ref;
    const details = {
      // Supplied text is never sent back to the browser for annotation.
      action: command,
      target: action.ref !== undefined ? { id: action.ref, label: action.label } : null,
      fromUrl: action.fromUrl,
    };
    // A final page the host can act on (an offer remembered for its revision: low_confidence alternatives, a handoff's
    // decide options) is tagged with those action ids instead of the control refs.
    const offer = this.runtime.offers?.get(pending.observation.revision);
    if (offer) Object.assign(details, { labels: actionLabels(offer.actions), revision: offer.revision });
    // After the time budget the run signal is aborted: use one bounded by its own cap and the user's interrupts.
    const request = lateCapMs
      ? abandonable(() => this.bridge.capture(details, AbortSignal.any([this.interruptSignal, AbortSignal.timeout(lateCapMs),
        ...(this.callerSignal ? [this.callerSignal] : [])])), AbortSignal.any([this.interruptSignal, AbortSignal.timeout(lateCapMs)]))
      : this.bounded(() => this.bridge.capture(details, this.signal));
    return request.then(
      value => value ?? null,
      error => ({ error: { code: error?.code ?? 'capture_failed', message: String(error?.message ?? error) } }),
    );
  }

  /** onAction is fire-and-forget unless awaitCallbacks is set. A throwing callback never fails the run. */
  async notify(step, observation) {
    const callback = this.config.onAction;
    if (!callback) return;
    const invoke = () => callback(step, { observation });
    if (this.config.awaitCallbacks) {
      try {
        await this.bounded(invoke);
      } catch {
        // Cancellation is picked up by the next guard(); callback errors are ignored by design.
      }
      return;
    }
    Promise.resolve().then(invoke).catch(() => {});
  }

  /**
   * Make `fresh` (a later observation of the final page) the run's final observation when the expectation still
   * passes on it; otherwise keep `before` and its verification. Returns whether `fresh` was adopted.
   */
  async adoptFinal(fresh, before) {
    const result = this.result;
    const hasExpectation = this.config.expectation !== undefined && this.config.expectation !== null;
    const saved = structuredClone(result.verification);
    const passed = !hasExpectation || await this.expectationFor(fresh);
    if (passed && allowedOrigin(fresh.url, this.config.allowedOrigins)) {
      result.observation = fresh;
      return true;
    }
    result.verification = saved;
    result.observation = before;
    this.lastCheck = null;
    return false;
  }

  /**
   * Adopt the page the runtime's own expand click (completeList) left: as adoptFinal when the expectation passes
   * there ('passed'). When it fails only because the page rewrote its own URL in place (a "Show more" that
   * history.replaceState's or pushState's the URL while the document stays: same origin, the same leading content and
   * nearly everything it showed before, sameDocumentExpanded), the URL conditions the page passed before the click
   * are carried forward and the text and title conditions are verified on the expanded page ('carried';
   * `verification.carried` lists the carried fields). Null when nothing is adopted: the earlier observation stays
   * final. Only the runtime's own click calls this, never a provider's or a host's navigation, and a real navigation
   * to another page (a new heading, a new list) fails the same-document check and never passes a URL expectation.
   */
  async adoptExpanded(fresh, before) {
    const result = this.result;
    const passedBefore = result.verification?.passed === true;
    if (await this.adoptFinal(fresh, before)) return 'passed';
    const expectation = this.config.expectation;
    if (!passedBefore || !expectation || typeof expectation !== 'object' || fresh.url === before.url) return null;
    const carried = Object.keys(expectation).filter(key => URL_FIELDS.has(key));
    if (!carried.length || !allowedOrigin(fresh.url, this.config.allowedOrigins) || !sameDocumentExpanded(before, fresh)) return null;
    const rest = Object.fromEntries(Object.entries(expectation).filter(([key]) => !URL_FIELDS.has(key)));
    if (!checkDeclarative(fresh, rest, { initial: this.initial })) return null;
    if (this.lateIntent() && this.loadingOf(fresh).length) return null;
    result.observation = fresh;
    const verification = { ...result.verification, passed: true, carried };
    for (const key of ['hint', 'error', 'contentLoading']) delete verification[key];
    result.verification = verification;
    this.lastCheck = { observation: fresh, passed: true };
    return 'carried';
  }

  /**
   * Before the final answer ranking of a completed run whose question aggregates over a list ("the cheapest flight
   * between 10:00 and 12:00"): (1) when the final page's items look half-rendered (an item with only a time and no
   * name, or a loading placeholder as loadingOf reads it, with content waits left), wait one content wait and observe once
   * more (`answer:settle_wait`), and (2) when the final page offers an in-place "View more" / "Show more" button
   * (never a link, never "Next page"), click it once (`more:expanded`) and let the content settle, so the ranking sees
   * the whole list rather than reporting `partial:more_offered`. Only at a level with controls (reversible and up),
   * with one action of the budget and some time left, once per page URL per call. A click the page refuses, or a page
   * whose expectation no longer passes afterwards, leaves the run's final observation as it was. Never fails the run.
   */
  async completeList() {
    const result = this.result;
    const config = this.config;
    if (result.status !== 'completed' || !result.observation || this.interrupted || this.signal.aborted) return;
    const question = this.question();
    if (!aggregateIntent(question)) return;
    const atFinal = observation => {
      const memory = this.answerMemory(question, observation);
      const key = stateKey(observation);
      return memory.states.find(state => state.key === key) ?? null;
    };
    // The final observation and its verification before the runtime's own click, while that click is unsettled.
    let clicked = null;
    try {
      let observation = result.observation;
      let final = atFinal(observation);
      // A half-rendered row is a time with no name at all ("10:47 AM – 4:05 PM"); `unnamed_item` alone also marks a
      // fully rendered short row ("10:40 AM – 11:45 AM · easyJet · Nonstop · €100") and costs no wait.
      const nameless = text => !String(text ?? '').replace(/\b\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?/giu, ' ')
        .replace(/\b[ap]\.?m\.?(?![\p{L}])/giu, ' ').replace(/[^\p{L}]+/gu, '').length;
      const half = final?.lines.some(line => line.item && line.notes?.includes('unnamed_item') && nameless(line.text))
        // As in awaitContent (F1): hidden status text next to rows and persistent status text are not loading.
        || this.loadingOf(observation).length > 0;
      if (half && this.contentWaits < MAX_CONTENT_WAITS && this.remainingMs() > 2 * config.contentWaitMs + 500) {
        this.contentWaits++;
        this.why('answer:settle_wait');
        const delay = config.contentWaitMs;
        if (delay > 0) {
          await this.bounded(() => new Promise(resolve => {
            const timer = setTimeout(resolve, delay);
            timer.unref?.();
          }));
        }
        const fresh = await this.observe();
        this.visit(fresh);
        if (await this.adoptFinal(fresh, observation)) {
          observation = fresh;
          final = atFinal(observation);
        }
      }
      if (result.steps.length >= config.maxActions || this.remainingMs() < 3000) return;
      // A "more" click needs controls (reversible and up); scrolling a lazy list (scrollToLoad) needs none.
      const controls = config.capabilities.has('controls');
      const state = config.retryState;
      state.moreUrls ??= new Set();
      if (state.moreUrls.has(observation.url)) return;
      // Only when the list has items here: a "Show more" on a page without any is not the list the question reads.
      if (!final?.lines.some(line => line.item)) return;
      // The provider's injection guard flagged a page of this run: no click the model did not choose.
      if ((this.signals.guards?.injection ?? 0) >= INJECTION_NOTE) return;
      const { actions } = controls ? offeredActions(observation, { ...config, hints: this.hints }) : { actions: [] };
      // A plain button of the page itself: not in a consent dialog, not a form submit or riskier class, not in a frame.
      const plain = action => {
        const control = (observation.controls ?? []).find(item => String(item.id) === String(action.target));
        return Boolean(control) && !control.consent && control.frame === undefined
          && (control.risk === undefined || control.risk === 'reversible');
      };
      const more = actions.find(action => action.type === 'click' && action.role !== 'link' && !action.href
        && IN_PLACE_MORE.test(String(action.label ?? '').trim()) && plain(action));
      if (!more) {
        // No "more" button: a list that loads as its end scrolls into view (an infinite feed) is scrolled instead.
        clicked = { observation, verification: structuredClone(result.verification) };
        await this.scrollToLoad(observation, state.moreUrls);
        clicked = null;
        return;
      }
      // Only a button under the rows the answer ranks: another list's "more" leaves the answer as it is.
      if (!moreExtendsItems(observation, more, this.answerMemory(question, observation), aggregateIntent(question))) {
        this.why('more:other_list');
        return;
      }
      state.moreUrls.add(observation.url);
      await this.finalizePending(false);
      this.guard();
      const before = observation;
      clicked = { observation: before, verification: structuredClone(result.verification) };
      let executed;
      try {
        executed = await this.execute({ id: 'more', ...more }, before, { by: 'runtime', actionId: 'more', reason: 'expand_more' },
          Date.now(), 0);
      } catch (error) {
        if (this.interrupted || this.signal.aborted) throw error;
        this.why('more:failed');
        result.observation = before;
        return;
      }
      this.visit(executed.observation);
      const settled = await this.awaitContent(executed.observation);
      const adopted = await this.adoptExpanded(settled, before);
      this.why(adopted ? 'more:expanded' : 'more:unverified');
      if (adopted === 'carried') this.why('more:url_carried');
      clicked = null;
    } catch (error) {
      // Best effort: an interrupt still ends the run as it would have; anything else leaves the outcome alone. A
      // click that ran but did not settle (the run budget ran out in its content waits) is reported, and the final
      // observation is the verified one from before it.
      if (clicked) {
        result.observation = clicked.observation;
        result.verification = clicked.verification;
        this.lastCheck = null;
        this.why('more:failed');
        return;
      }
      if (this.interrupted || this.signal.aborted) return;
      this.why('more:failed');
    }
  }

  /**
   * completeList for a lazy list: when the final page's document ends within two viewports below the view (the page
   * script's `scroll {top, height}`), scroll down as a runtime page step (`decision.reason: "scroll_more"`) and settle,
   * at most three times while the document keeps growing and actions are left. A scroll after which the document grew
   * and the expectation still passes becomes the final observation (`more:scrolled`); otherwise the earlier
   * observation stays final. Observations without `scroll` (older page scripts, SDK bridges) are never scrolled.
   */
  async scrollToLoad(observation, tried) {
    const config = this.config;
    let before = observation;
    let grew = false;
    for (let round = 0; round < 3; round++) {
      const scroll = before.scroll;
      const height = Number(before.viewport?.height);
      if (!scroll || !Number.isFinite(scroll.top) || !Number.isFinite(scroll.height) || !(height > 0)) break;
      const left = scroll.height - (scroll.top + height);
      if (left <= 0 || left > 2 * height) break;
      if (this.result.steps.length >= config.maxActions || this.remainingMs() < 2000) break;
      tried.add(observation.url);
      await this.finalizePending(false);
      this.guard();
      const action = { id: 'more', type: 'scroll', direction: 'down', label: 'scroll down', description: 'Scroll down to load more of the list' };
      const executed = await this.execute(action, before, { by: 'runtime', actionId: 'more', reason: 'scroll_more' }, Date.now(), 0);
      this.visit(executed.observation);
      const settled = await this.awaitContent(executed.observation);
      if (!(Number(settled.scroll?.height) > scroll.height) || !(await this.adoptFinal(settled, before))) break;
      grew = true;
      before = settled;
    }
    if (grew) this.why('more:scrolled');
    else this.result.observation = observation;
  }

  /** Remember an observation for the earlier-page trail. */
  visit(observation) {
    if (!observation) return;
    // The page script lists cross-origin frames it could not read (their content is never offered or sent).
    if (Array.isArray(observation.warnings) && observation.warnings.includes('cross_origin_frame')) {
      this.warn('cross_origin_frame');
    }
    // A credentials page (src/secrets.js secretPageSignal): the page script redacted it strictly.
    if (Array.isArray(observation.warnings) && observation.warnings.includes('secret_page')) this.warn('secret_page');
    // Regions the page holds only as pixels, or that a derived view had to cut (extension/page.js collectViews):
    // `unreadable_region:<kind>` per kind (chart, canvas, image, table), so a later tier knows when to look.
    if (Array.isArray(observation.warnings) && observation.warnings.includes('unreadable_region')) {
      for (const code of unreadableWarnings(observation)) this.warn(code);
    }
    // The extension follows one redirect from a consent.* host to an origin this request approved; the receipt
    // names the origin it landed on (URL-derived, never page text).
    const previous = this.visited.at(-1);
    if (previous && consentContinueHost(previous.url) && allowedOrigin(observation.url, this.config.allowedOrigins)) {
      const from = safeOrigin(previous.url);
      const to = safeOrigin(observation.url);
      if (from && to && from !== to) this.why(`consent:redirect:${to}`);
    }
    if (!VISIT_STEP.has(observation)) VISIT_STEP.set(observation, (this.stepBase ?? 0) + (this.result.steps?.length ?? 0));
    this.visited.push(observation);
  }

  /** checkExpectation, memoized for the observation it last checked. */
  async expectationFor(observation) {
    if (this.lastCheck?.observation === observation) return this.lastCheck.passed;
    const passed = await this.checkExpectation(observation);
    this.lastCheck = { observation, passed };
    return passed;
  }

  /** Returns null when no expectation is configured, otherwise whether it passed. */
  async checkExpectation(observation) {
    const expectation = this.config.expectation;
    if (expectation === undefined || expectation === null) return null;
    const verification = this.result.verification;
    verification.checked = true;
    try {
      const context = { initial: this.initial };
      verification.passed = typeof expectation === 'function'
        ? await this.bounded(() => evaluateExpectation(observation, expectation, context))
        : checkDeclarative(observation, expectation, context);
      delete verification.error;
      delete verification.contentLoading;
      if (verification.passed !== true) this.expectationFailedOnce = true;
      // A late-load task is not done while the page still shows a loading placeholder, whatever the expectation.
      if (verification.passed && this.lateIntent() && this.loadingOf(observation).length) {
        verification.passed = false;
        verification.contentLoading = true;
      }
      // A pre-passing expectation (notePrepass) counts only after an action changed the page.
      if (verification.passed && !this.prepassOk(observation)) verification.passed = false;
    } catch (error) {
      if (this.signal.aborted || this.interrupted) throw error;
      verification.passed = false;
      verification.error = String(error?.message ?? error);
    }
    return verification.passed;
  }

  async finishDone(observation) {
    const passed = await this.checkExpectation(observation);
    if (passed === null) return setOutcome(this.result, 'no_expectation');
    if (passed) return setOutcome(this.result, 'expectation_passed');
    return setOutcome(this.result, this.result.verification.error ? 'expectation_error' : 'expectation_failed');
  }

  /** Map an error to an outcome. User interrupts and budgets take precedence over whatever error surfaced. */
  fail(error) {
    let code;
    if (this.interrupted) code = this.interrupted;
    else if (this.timeoutSignal.aborted) code = 'time_budget';
    else if (this.callerSignal?.aborted) code = 'cancelled';
    else if (error?.code === 'blocked_risky' && this.intent()) {
      this.refuse(this.intent());
      return;
    } else if (isKnownCode(error?.code)) code = error.code;
    else code = 'failed';
    // Provider and bridge errors can echo page content. Keep their diagnostic text out of the trusted reason.
    const detail = outcomeFor(code).status === 'failed' ? String(error?.message ?? error) : undefined;
    if (detail) Object.defineProperty(this.result, 'errorDetail', {
      value: { code, message: detail }, enumerable: false, configurable: true,
    });
    setOutcome(this.result, code);
  }

  /** The question the digest and the answer candidates are conditioned on. */
  question() {
    return this.config.answerQuestion ?? this.callQuestion ?? this.instruction ?? '';
  }

  /**
   * Whether the call asks a question: it carries answerQuestion, or its instruction (quoted labels left out) has a
   * question mark, a wh-word or a read verb. Only a call that asks gets an auto-confirmed answer.
   */
  asks() {
    if (this.asked !== null) return this.asked;
    if (this.config.answerQuestion !== undefined) return true;
    return instructionAsks(this.instruction);
  }

  /**
   * The run's fact memory for `question` (src/facts.js buildMemory): one state per semantic revision the run saw, in
   * first-seen order (same-URL states included), each with its aggregation items (at most 30) and at most 6 other
   * relevant lines, at most runLineBudget(states) in all, supplied values redacted (the memory reaches the provider,
   * the host and the trace). Memoized per question and visit count.
   */
  memory(question) {
    const cached = this.memoryCache;
    if (cached && cached.question === question && cached.count === this.visited.length
      && cached.last === this.visited.at(-1)) return cached.memory;
    const states = this.memoryStates();
    const memory = buildMemory(states, question, { redact: redactorFor(this.config.suppliedText) });
    memory.coverage = coverage(states);
    this.memoryCache = { question, count: this.visited.length, last: this.visited.at(-1), memory };
    return memory;
  }

  /**
   * One entry per semantic revision the run saw, in first-seen order, each with its latest observation; `carried`
   * marks a state of an earlier list step's pages (#driveList).
   */
  memoryStates() {
    const states = [];
    const byKey = new Map();
    for (const observation of this.visited) {
      if (!observation) continue;
      const key = stateKey(observation);
      const known = byKey.get(key);
      if (known) {
        known.observation = observation;
        continue;
      }
      const entry = {
        state: states.length,
        step: VISIT_STEP.get(observation) ?? 0,
        url: observation.url ?? '',
        title: observation.title ?? '',
        revision: observation.revision ?? undefined,
        key,
        observation,
      };
      if (this.carried?.has(observation)) entry.carried = true;
      byKey.set(key, entry);
      states.push(entry);
    }
    return states;
  }

  /**
   * The fact memory the answer ranks from, for `observation` as the final page (src/facts.js answerScope): the run's
   * states without half-rendered revisions superseded with no action in between, and without states keyed to
   * another day than the question's page ("departing 2026-10-12" on a run that asks about Oct 13). The excluded
   * states stay in the trail (memory()). The final page's own state keeps every item (buildMemory finalKey: its
   * observation is in hand, so no memory bound applies to it). Memoized like memory(); `scope` says what was left
   * out (state numbers) and whether the question spans days or pages. `mainList` is the final page's main record
   * list (src/facts.js factPool; default 0, the page script's best), one memo entry per list.
   */
  answerMemory(question, observation, mainList = 0) {
    let cached = this.answerMemoryCache;
    if (!(cached && cached.question === question && cached.observation === observation && cached.count === this.visited.length
      && cached.last === this.visited.at(-1))) {
      cached = { question, observation, count: this.visited.length, last: this.visited.at(-1), byList: new Map() };
      this.answerMemoryCache = cached;
    }
    if (cached.byList.has(mainList)) return cached.byList.get(mainList);
    const all = this.memoryStates();
    const scope = answerScope(all, observation, { question, instruction: this.instruction ?? '' });
    let memory = buildMemory(scope.states, question,
      { redact: redactorFor(this.config.suppliedText), finalKey: stateKey(observation), mainList });
    memory.coverage = coverage(scope.states);
    memory = { ...memory, scope: { excluded: scope.excluded, collapsed: scope.collapsed, mismatch: scope.mismatch, spans: scope.spans } };
    cached.byList.set(mainList, memory);
    return memory;
  }

  /**
   * The earlier-state trail: the memory's relevant lines of the states before `observation` (by semantic revision,
   * so same-URL states count), grouped by state in run order: `[{url, state, lines}]`. Lines the final page still
   * shows are left out (page.digest has them); a line reads "<section heading> › <line>" when it sits under one.
   * With an aggregating question a state shows its aggregation items first, then its other relevant lines while the
   * state has room (TRAIL_LINES) and they carry no value of the aggregated measure: a join fact read on the way
   * ("Kestrel Field Lamp · Available on the Team plan" for "the price of that plan") is kept even when the question
   * aggregates, a decoy ("Tent footprint | €19") is not. Untrusted page text, redacted.
   */
  trail(question, observation = this.result.observation) {
    const memory = this.memory(question);
    const finalKey = observation ? stateKey(observation) : null;
    const shown = new Set(observation ? blocksOf(observation).map(block => block.text.toLowerCase()) : []);
    const entries = [];
    for (const state of memory.states) {
      if (state.key === finalKey) continue;
      let lines = state.lines.filter(line => !shown.has(line.key));
      if (memory.intent) {
        const items = lines.filter(line => line.item);
        // A line with a value of the aggregated measure that is not an item is a decoy the filters left out (an
        // accessory's price, an out-of-window time): never in the trail. A line without one is context.
        const rest = lines.filter(line => !line.item && itemValue(line.text, memory.intent) === null);
        lines = [...items, ...rest.slice(0, Math.max(0, TRAIL_LINES - items.length))];
      } else {
        lines = lines.slice(0, TRAIL_LINES);
      }
      if (!lines.length) continue;
      entries.push({ state, lines, best: Math.max(...lines.map(line => line.score)) });
    }
    // The most relevant states when there are too many (ties: the more recent), then in run order.
    let kept = entries;
    if (kept.length > TRAIL_STATES) {
      kept = [...kept].sort((a, b) => b.best - a.best || b.state.state - a.state.state).slice(0, TRAIL_STATES)
        .sort((a, b) => a.state.state - b.state.state);
    }
    let room = TRAIL_TOTAL;
    const out = [];
    for (const { state, lines } of kept) {
      if (room <= 0) break;
      const take = lines.slice(0, room);
      room -= take.length;
      out.push({ url: state.url, state: state.state, lines: take.map(line => clip(lineText(line), TRAIL_LINE_LIMIT)) });
    }
    return out;
  }

  /**
   * Everything one answer ranking depends on, for `observation` as the final page: the candidates (aggregation
   * items first, then earlier-state lines when the final page is weakly relevant, then the final page's own blocks),
   * the receipt trail, the earlierPages context for choose() (the most relevant trail states, without lines that
   * are already candidates) and the aggregation summary. Deterministic for equal inputs, so a ranking started next
   * to the final decision asks exactly what rankAnswer() would. `mainList` is the final page's main record list
   * (answerMemory); `itemKeys` holds the candidate keys of every aggregation item, not only the AGGREGATE_CANDIDATES
   * first (the provider's pick is checked against it).
   */
  answerPlan(observation, question, { mainList = 0 } = {}) {
    const trail = this.trail(question, observation);
    const own = pickAnswerCandidates(observation, question);
    const memory = this.answerMemory(question, observation, mainList);
    const finalKey = stateKey(observation);
    const seen = new Set();
    const candidates = [];
    const push = candidate => {
      const key = (candidate.key ?? candidate.text).toLowerCase();
      if (seen.has(key) || candidates.length >= ANSWER_CANDIDATE_CAP) return;
      seen.add(key);
      candidates.push(candidate);
    };
    const remembered = (state, line, extra = {}) => ({
      t: line.t, text: lineText(line), key: line.key, score: line.score, state: state.state, url: state.url,
      ...(line.context ? { heading: line.context } : {}), ...extra,
    });
    const stateOf = new Map(memory.states.map(state => [state.state, state]));
    // Aggregation over the remembered states (the final one included), when items come from two or more states.
    // A list step's question is about its own hop: the states carried from earlier steps (#driveList) are context
    // (the trail, earlier-state candidates), never its aggregation items, unless the question spans days or pages
    // ("across", "each day", "all pages": src/facts.js answerScope spans), where every step's items count.
    let aggregate = null;
    const itemKeys = new Set();
    const spans = memory.scope?.spans === true;
    const pool = spans ? memory : { ...memory, states: memory.states.filter(state => !state.carried) };
    const summary = aggregateItems(pool);
    // Items of one earlier state only (the run read them, then moved on) count too: the answer would come from
    // memory, so the same coverage and value checks apply.
    const finalState = memory.states.find(state => state.key === finalKey)?.state;
    // Detected records (src/digest.js recordsOf) aggregate on the final page alone too: each is one named item with its
    // values, so the order is the page's own, and the same coverage and value checks decide whether it is complete.
    if (summary && (summary.states >= 2 || summary.items.some(item => item.state !== finalState)
      || summary.items.some(item => item.line.record !== undefined))) {
      const why = [...(memory.coverage?.why ?? [])];
      // Items the bounds left out of the states aggregated over (never the final page's own state, which keeps all).
      if (pool.states.some(state => state.droppedItems > 0)) why.push('memory_full');
      why.push(...(summary.uncertain ?? []));
      aggregate = {
        op: summary.op, measure: summary.measure, code: summary.code, items: summary.items.length,
        states: summary.states, tie: summary.tie, partial: why.length > 0, why,
        // Condition clauses of the question the intent did not parse (src/facts.js unreadConditions): the order may
        // put an item first that fails one, so no override (aggregateOverride).
        ...(summary.unread ? { unread: [...summary.unread] } : {}),
        // Items with no value of the measure (they would order last): a minimum or maximum over them is not complete.
        // 0 by construction today (passesFilters asks a measure's value of every item); kept as the override's
        // invariant (aggregateOverride), so a looser item rule can never confirm an order it could not compute.
        unvalued: summary.items.filter(item => !Number.isFinite(item.line.value)).length,
        top: summary.items.slice(0, AGGREGATE_CANDIDATES).map(item => ({ state: item.state, value: item.line.value ?? null })),
      };
      for (const item of summary.items) {
        itemKeys.add(String(item.line.key ?? lineText(item.line)).toLowerCase());
        itemKeys.add(lineText(item.line).toLowerCase());
        itemKeys.add(String(item.line.text).toLowerCase());
      }
      const best = Math.max(0, ...own.map(candidate => candidate.score),
        ...memory.states.flatMap(state => state.lines.map(line => line.score)));
      if (summary.items.some(item => plantedLine(lineText(item.line)))) {
        aggregate.why.push('planted_text');
        aggregate.partial = true;
      }
      summary.items.slice(0, AGGREGATE_CANDIDATES).forEach((item, rank) => {
        push(remembered(stateOf.get(item.state), item.line,
          { score: Math.round((best + AGGREGATE_CANDIDATES - rank) * 1000) / 1000, aggregate: rank }));
      });
    }
    // Earlier-state lines, when the final page is weakly relevant and the task is not a join.
    const bestOwn = own.length ? own[0].score : 0;
    if (!isJoinTask(this.instruction ?? '')) {
      const earlier = memory.states.filter(state => state.key !== finalKey)
        .flatMap(state => state.lines.map(line => ({ state, line })))
        .filter(({ line }) => line.score > bestOwn && !plantedLine(lineText(line)))
        .sort((a, b) => b.line.score - a.line.score || b.state.state - a.state.state);
      if (earlier.length && earlier[0].line.score >= MEMORY_RATIO * bestOwn) {
        for (const { state, line } of earlier.slice(0, MEMORY_CANDIDATES)) push(remembered(state, line));
      }
    }
    for (const candidate of own) push(candidate);
    // choose() context: the most relevant earlier states, without lines that are already candidates. On a run that
    // never left the final page's URL (one page, a select or a toggle redrawn in place), an earlier state's line is
    // context only when it states a fact (a digit, a "label: value" or a name after the first word): "Select a region
    // to see the shipping cost." is the page's own prompt before the action, and sending it only blurs the ranking.
    const offered = new Set(candidates.map(candidate => candidate.text));
    const onePage = trail.every(entry => entry.url === observation.url);
    const context = line => !offered.has(line) && (!onePage || STATED_FACT.test(line.split(' › ').at(-1)));
    const earlierPages = trail
      .map(entry => ({ entry, lines: entry.lines.filter(context) }))
      .filter(({ lines }) => lines.length)
      .slice(-EARLIER_STATES)
      .map(({ entry, lines }) => ({ url: entry.url, state: entry.state, lines }));
    return { candidates, trail, earlierPages, aggregate, itemKeys, intent: aggregate ? null : summary?.code ?? null,
      scope: memory.scope };
  }

  /**
   * The `lists` question for `observation` as the final page (guidance switch `lists`, src/typesafe.js): asked only
   * where its answer changes something, that is when the question ranks or bounds a value (an aggregate intent with
   * a measure: only then do the lists order the items, src/facts.js factPool) and the page has two or more record
   * lists (src/digest.js recordListsOf, RECORD_LIST_MIN records each), and only to a provider with choose().
   * Returns null when it does not apply, else `{ lists, ask }`: `lists` the summaries, titles redacted; `ask` false
   * when the provider's switch is off (`lists:fallback:off`, the request unchanged).
   */
  listQuestion(observation, question) {
    const provider = this.answerProvider;
    if (typeof provider?.choose !== 'function' || !aggregateIntent(question)?.measure) return null;
    const lists = recordListsOf(observation);
    if (lists.length < 2) return null;
    const redact = redactorFor(this.config.suppliedText);
    return {
      lists: lists.map(entry => ({ ...entry, titles: entry.titles.map(title => redact(title)) })),
      ask: provider.guidance?.lists !== false,
    };
  }

  /**
   * The choose() request for `observation` as the final page: the answer plan over the page script's best list, and,
   * when the `lists` question is asked, its lists and the first AGGREGATE_CANDIDATES items of every other list's
   * aggregation after the plan's own candidates (each other list's plan has them as its own first items), so the
   * answer question can pick an item of whichever list holds the answer and the runtime can check that pick against
   * the list the `lists` question chose. `keys` are the sent candidates' identities (candidateKey).
   */
  answerRequest(observation, question) {
    const plan = this.answerPlan(observation, question);
    const listing = this.listQuestion(observation, question);
    const keys = plan.candidates.map(candidateKey);
    const candidates = plan.candidates.map(({ key, ...candidate }) => candidate);
    if (listing?.ask) {
      const seen = new Set(keys);
      for (const entry of listing.lists) {
        if (entry.list === 0) continue;
        const other = this.answerPlan(observation, question, { mainList: entry.list });
        for (const candidate of other.candidates) {
          if (candidate.aggregate === undefined) continue;
          const key = candidateKey(candidate);
          if (seen.has(key) || candidates.length >= LIST_CANDIDATE_CAP) continue;
          seen.add(key);
          keys.push(key);
          const { key: _, aggregate, ...rest } = candidate;
          candidates.push(rest);
        }
      }
    }
    const lists = listing?.ask ? listing.lists : null;
    return { plan, listing, candidates, keys, lists, key: rankingKey(question, candidates, plan.earlierPages, lists) };
  }

  /**
   * Rank answer candidates for completed, unverified and checkpoint results. Candidates are page blocks chosen by
   * pickAnswerCandidates; nothing is generated, so the host can only confirm page text. With two or more
   * candidates and a provider that implements choose(), the provider picks one (bounded by the run's remaining
   * time and 3 s); otherwise, and whenever the provider fails, the heuristic order stands.
   */
  async rankAnswer() {
    // A ranking started next to the final decision is used only when it asked exactly what is asked here;
    // otherwise it is discarded and everything below runs as if it had never started.
    const speculation = this.speculation;
    this.speculation = null;
    try {
      await this.rankAnswerWith(speculation);
    } finally {
      this.discardSpeculation(speculation);
      await Promise.all(this.discardedRankings);
    }
  }

  /**
   * A step list's placeholder may take a likely answer (src/steps.js likelyValue). A lone candidate is never sent to the
   * provider by rankAnswerWith (single_candidate), so its confidence is only the heuristic share; here the provider
   * ranks it once when it can, and result.answer then carries that ranking (method provider).
   */
  async rankSingle(question) {
    const result = this.result;
    const detail = result.answerDetail;
    const provider = this.answerProvider;
    if (result.answer?.method === 'provider' || detail?.skipped !== 'single_candidate' || detail.candidates?.length !== 1
      || typeof provider?.choose !== 'function') return;
    const { id, heuristic, ...candidate } = detail.candidates[0];
    const outcome = await this.chooseAnswer(provider, question, [candidate], [id], [heuristic],
      this.answerPlan(result.observation, question).earlierPages);
    if (!outcome.ranked) return;
    result.answer = { method: 'provider',
      candidates: outcome.ranked.slice(0, MAX_ANSWER_CANDIDATES).map(({ candidate: c, confidence }) => answerEntry(c, confidence)) };
    result.answerDetail = { ...detail, method: 'provider', skipped: undefined, ranked: 'placeholder', ...outcome.detail };
  }

  async rankAnswerWith(speculation) {
    const result = this.result;
    const observation = result.observation;
    this.answerFirst = null;
    if (!ANSWER_STATUSES.has(result.status) || !observation) return;
    const question = this.question();
    if (!question.trim()) {
      result.answerDetail = { method: 'none', skipped: 'no_question' };
      return;
    }
    const request = this.answerRequest(observation, question);
    let plan = request.plan;
    const { trail, earlierPages } = plan;
    if (trail.length) result.trail = trail;
    const { candidates } = request;
    if (!candidates.length) {
      result.answerDetail = { method: 'none', skipped: 'no_candidates' };
      return;
    }
    const heuristic = heuristicConfidences(candidates);
    const ids = candidates.map((_, i) => `c${i}`);
    const detail = {
      candidates: candidates.map((candidate, i) => ({ id: ids[i], ...candidate, heuristic: heuristic[i] })),
    };
    // States left out of the candidates (another day's page, a superseded half-rendered revision): trace only.
    if (plan.scope?.excluded?.length || plan.scope?.collapsed?.length || plan.scope?.mismatch) detail.scope = plan.scope;
    // The question aggregates but its items are on the final page only (no aggregate summary): remembered lines are
    // not items, so one of them is never auto-confirmed (see receipt()). Independent of the scope above.
    if (plan.intent) detail.aggregateIntent = plan.intent;
    let ranked = candidates.map((candidate, i) => ({ candidate, confidence: heuristic[i], i }));
    let method = 'heuristic';
    let outcome = null;
    const provider = this.answerProvider;
    if (typeof provider?.choose !== 'function') {
      detail.skipped = 'no_choose';
    } else if (candidates.length < 2) {
      detail.skipped = 'single_candidate';
    } else {
      // The same observation, question, candidates, trail and lists make the same choose() request.
      const same = speculation && !speculation.discarded && speculation.observation === observation
        && speculation.key === request.key;
      if (same) speculation.used = true;
      else this.discardSpeculation(speculation);
      outcome = same ? await speculation.promise : null;
      // `early` (trace only, answerDetail): used, or fallback when the early ranking failed upstream (it may have
      // been slowed by running next to the decide) and a fresh serial one ran in its place, or off when early
      // rankings were stopped for this run after a provider error.
      if (same) detail.early = 'used';
      else if (this.earlyRankingOff) detail.early = 'off';
      if (outcome && EARLY_RETRY_CODES.has(outcome.detail?.error?.code)
        && this.config.timeoutMs - (Date.now() - this.started) >= ANSWER_MIN_MS) {
        detail.early = 'fallback';
        outcome = null;
      }
      outcome ??= await this.chooseAnswer(provider, question, candidates, ids, heuristic, earlierPages, null, request.lists);
      Object.assign(detail, outcome.detail);
      if (outcome.ranked) {
        ranked = outcome.ranked;
        method = 'provider';
      }
    }
    // The record list the question is about (listQuestion): the provider's choice when it is usable, else the page
    // script's best list. The aggregation and the candidates are then the chosen list's plan; the ranking sent over
    // the wider request keeps its order, without the other lists' items.
    if (request.listing) {
      const choice = listChoice(request.listing, outcome, detail.skipped);
      detail.lists = choice.detail;
      if (choice.list !== 0) plan = this.answerPlan(observation, question, { mainList: choice.list });
      if (choice.none && plan.aggregate) {
        plan.aggregate.why.push('list_none');
        plan.aggregate.partial = true;
      }
    }
    const aggregate = plan.aggregate;
    if (aggregate) detail.aggregate = aggregate;
    // The provider's top pick against the aggregation (trace, and the receipt's aggregate rule): `first` (its first
    // item), `item` (another of its items) or `other` (not an item: a plain block, an earlier line, another list's
    // item), and `mass`, the provider's probability on the aggregation's items (its top confidence without
    // probabilities).
    if (aggregate && method === 'provider') {
      const first = plan.candidates.find(candidate => candidate.aggregate === 0);
      const topKey = request.keys[ranked[0].i];
      aggregate.pick = first && topKey === candidateKey(first) ? 'first' : plan.itemKeys.has(topKey) ? 'item' : 'other';
      const mass = detail.probabilities
        ? ranked.filter(entry => plan.itemKeys.has(request.keys[entry.i])).reduce((sum, entry) => sum + entry.confidence, 0)
        : aggregate.pick === 'other' ? 0 : ranked[0].confidence;
      aggregate.mass = round3(Math.min(1, mass));
    }
    if (request.listing?.ask) {
      // The final candidates are the chosen plan's: provider order where it ranked them, the rest after them.
      const finals = plan.candidates.map(({ key, ...candidate }) => candidate);
      const finalKeys = plan.candidates.map(candidateKey);
      if (method === 'provider') {
        const at = new Map(finalKeys.map((key, i) => [key, i]));
        const used = new Set();
        const mapped = [];
        for (const entry of ranked) {
          const i = at.get(request.keys[entry.i]);
          if (i === undefined || used.has(i)) continue;
          used.add(i);
          mapped.push({ candidate: finals[i], confidence: entry.confidence, i });
        }
        finals.forEach((candidate, i) => { if (!used.has(i)) mapped.push({ candidate, confidence: 0, i }); });
        ranked = mapped;
      } else {
        const own = heuristicConfidences(finals);
        ranked = finals.map((candidate, i) => ({ candidate, confidence: own[i], i }));
      }
    }
    result.answer = {
      method,
      candidates: ranked.slice(0, MAX_ANSWER_CANDIDATES).map(({ candidate, confidence }) => answerEntry(candidate, confidence)),
    };
    // The aggregation's first item, whatever the provider ranked first (receipt(): a complete minimum or maximum).
    const firstEntry = aggregate ? ranked.find(entry => entry.candidate.aggregate === 0) : null;
    if (firstEntry) this.answerFirst = answerEntry(firstEntry.candidate, firstEntry.confidence);
    // Where the top candidate was read, when that is an earlier page state (or an aggregation over several).
    const top = ranked[0]?.candidate;
    if (top?.state !== undefined) result.answer.source = { state: top.state, url: top.url };
    if (aggregate) {
      // An aggregate over a run that did not complete verified may have missed items.
      if (result.status !== 'completed' || result.verification?.passed !== true) {
        aggregate.why.push('not_verified');
        aggregate.partial = true;
      }
      result.answer.aggregate = { op: aggregate.op, measure: aggregate.measure, items: aggregate.items,
        states: aggregate.states, partial: aggregate.partial };
      if (aggregate.why.length) result.answer.aggregate.why = [...aggregate.why];
      if (aggregate.tie) result.answer.aggregate.tie = true;
    }
    result.answerDetail = { method, ...detail };
  }

  /**
   * Start the answer ranking for `observation` next to a decision that may end the run there (the expectation
   * already passes on it), so a completed run does not wait for one more provider round trip after the loop. It
   * builds exactly the choose() request rankAnswer() would build if the run ended on this observation; rankAnswer()
   * uses its outcome only in that case and discards it otherwise (an executed action discards it at once). The
   * decision never waits for it or sees it. A discarded request that had already answered still counts in cost
   * (its tokens were spent) and is marked `discarded` in cost.requests.
   */
  speculateAnswer(observation) {
    const current = this.speculation;
    // Best effort, like the ranking in close(): nothing here may fail the run or leave a rejection unhandled.
    try {
      // The same request is already running for this page (an early end fell back to the terminal decide): keep it.
      if (current && !current.discarded && current.observation === observation) {
        if (current.key === this.answerRequest(observation, this.question()).key) return;
      }
    } catch {
      // Fall through to a fresh ranking.
    }
    this.discardSpeculation();
    try {
      const provider = this.answerProvider;
      // A local SystemOne server may serve one request at a time, so a parallel ranking could delay the decision.
      if (typeof provider?.choose !== 'function' || provider.local === true) return;
      // After a provider error in this run, rankings wait for the loop to end (no parallel load on the provider).
      if (this.earlyRankingOff) return;
      const question = this.question();
      if (!question.trim()) return;
      const request = this.answerRequest(observation, question);
      const { candidates, lists } = request;
      if (candidates.length < 2) return;
      const trail = request.plan.earlierPages;
      const heuristic = heuristicConfidences(candidates);
      const ids = candidates.map((_, i) => `c${i}`);
      const speculation = {
        observation,
        key: request.key,
        abort: new AbortController(),
        discarded: false,
        used: false,
        entry: null,
        promise: null,
      };
      speculation.promise = this.chooseAnswer(provider, question, candidates, ids, heuristic, trail, speculation, lists)
        .catch(() => ({ detail: { error: { code: 'failed', message: 'Answer ranking failed' } } }));
      this.speculation = speculation;
    } catch {
      this.speculation = null;
    }
  }

  /** Abandon a speculative ranking (default: the current one). Idempotent; never awaits. */
  discardSpeculation(speculation = this.speculation) {
    if (!speculation || speculation.discarded || speculation.used) return;
    if (this.speculation === speculation) this.speculation = null;
    speculation.discarded = true;
    if (speculation.entry) speculation.entry.discarded = true;
    speculation.abort.abort(new DOMException('Answer ranking discarded', 'AbortError'));
    this.discardedRankings.push(speculation.promise);
  }

  /**
   * Whether the expectation passes on `observation`, without recording anything (declarative expectations only;
   * a predicate is never run early). It only decides whether to start the answer ranking early.
   */
  expectationHint(observation) {
    if (this.lastCheck?.observation === observation) return this.lastCheck.passed === true;
    const expectation = this.config.expectation;
    if (!expectation || typeof expectation !== 'object') return false;
    if (!this.prepassOk(observation)) return false;
    try {
      return checkDeclarative(observation, expectation, { initial: this.initial }) === true;
    } catch {
      return false;
    }
  }

  /**
   * One provider.choose() call. Resolves `{ ranked?, detail }` and never rejects. With `speculation`, its abort
   * signal can abandon the call and its cost.requests entry is kept on it (marked `discarded` if it is).
   */
  async chooseAnswer(provider, question, candidates, ids, heuristic, trail = [], speculation = null, lists = null) {
    const budget = Math.min(ANSWER_TIMEOUT_MS, this.config.timeoutMs - (Date.now() - this.started));
    if (budget < ANSWER_MIN_MS) return { detail: { skipped: 'no_time' } };
    if (this.interrupted || this.callerSignal?.aborted) return { detail: { skipped: 'cancelled' } };
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException('Answer time budget reached', 'TimeoutError')), budget);
    const signal = AbortSignal.any([timeout.signal, this.interruptSignal, ...(this.callerSignal ? [this.callerSignal] : []),
      ...(speculation ? [speculation.abort.signal] : [])]);
    // The provider boundary: supplied values the page echoes are redacted, exactly as for decide().
    const redact = redactorFor(this.config.suppliedText);
    const offered = candidates.map((candidate, i) => ({ id: ids[i], text: redact(candidate.text) }));
    const started = Date.now();
    try {
      const request = { instruction: redact(this.instruction), question: redact(question), candidates: offered, signal };
      // Trail lines and URLs are already redacted by trail().
      if (trail.length) request.earlierPages = trail;
      // The `lists` question's input (listQuestion): titles already redacted.
      if (lists) request.lists = lists;
      const reply = await abandonable(() => provider.choose(request), signal);
      const { ranked, probabilities } = rankWithReply(reply, candidates, ids, heuristic);
      this.addUsage(reply.usage);
      this.noteRanking(speculation, this.noteRequest('choose', started, reply));
      const detail = { choice: reply.choice, ms: Date.now() - started };
      if (isUnit(reply.confidence)) detail.confidence = reply.confidence;
      if (probabilities) detail.probabilities = probabilities;
      if (reply.model) detail.model = reply.model;
      if (reply.requestId) detail.requestId = reply.requestId;
      if (Number.isFinite(reply.latencyMs)) detail.latencyMs = reply.latencyMs;
      return { ranked, detail, lists: reply.lists };
    } catch (error) {
      const code = timeout.signal.aborted ? 'timeout' : signal.aborted ? 'cancelled' : 'provider_error';
      this.noteRanking(speculation, this.noteRequest('choose', started, null, code));
      return { detail: { error: { code, message: String(error?.message ?? error) }, ms: Date.now() - started } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Keep a speculative ranking's cost.requests entry on it, marked if it was already discarded. */
  noteRanking(speculation, entry) {
    if (!speculation) return;
    speculation.entry = entry;
    if (speculation.discarded) entry.discarded = true;
  }

  async close() {
    try {
      await this.finalizePending(true);
    } catch {
      // Evidence collection must never mask the outcome.
    }
    if (this.lastDecision) {
      Object.defineProperty(this.result, 'finalDecision', {
        value: this.lastDecision, writable: true, enumerable: false, configurable: true,
      });
    }
    this.result.page = compactPage(this.result.observation, this.question());
    // The lease's tabs, a JavaScript dialog and Test-site logs on the final page (src/result.js pageExtras).
    const final = this.result.observation;
    if (final) Object.assign(this.result, pageExtras({ tabs: final.tabs, frames: final.frames, ...(this.config.level === 'testing' ? { dialog: final.dialog } : {}) }));
    if (this.retries.length) {
      // A back-out's outcome is how the run ended after it.
      for (const entry of this.retries) if (entry.kind === 'back_out') entry.outcome = this.result.code;
      this.result.retries = this.retries.map(entry => structuredClone(entry));
    }
    if (this.site) {
      // Trusted: which profile ran, its fast steps and hints, and where the fast path stopped. Counters go to the
      // profile's stats.json (best effort).
      if (this.site.pending) this.site.stop('ended');
      const block = this.site.receipt();
      if (block) this.result.site = block;
      for (const { profile, delta } of this.site.deltas()) {
        try {
          this.config.domains?.record?.(profile, delta);
        } catch {
          // Stats are best effort and must never mask the outcome.
        }
      }
    }
    try {
      await this.rankAnswer();
    } catch (error) {
      // Ranking is best effort and must never mask the outcome.
      this.result.answerDetail = { method: 'none', error: { code: 'failed', message: String(error?.message ?? error) } };
    }
    try {
      // The fact memory (bounded, redacted) goes to the trace as `facts`, never to the host.
      const question = this.question();
      const facts = question.trim() && ANSWER_STATUSES.has(this.result.status) ? traceFacts(this.memory(question)) : [];
      if (facts.length) {
        Object.defineProperty(this.result, 'facts', { value: facts, enumerable: false, writable: true, configurable: true });
      }
    } catch {
      // Diagnostics only.
    }
    try {
      this.receipt();
    } catch (error) {
      // A verdict the runtime cannot compute falls back to the code-only verdict in agentResult.
      this.result.receiptError = String(error?.message ?? error);
    }
    this.result.cost.elapsedMs = Date.now() - this.started;
    // Password values (sign_in) the page may echo: out of the page digest, answers, steps, diagnostics and receipt.
    if (this.result.secrets.length) redactSecrets(this.result, this.result.secrets);
    clearTimeout(this.timeoutTimer);
  }

  /**
   * The aggregate rule (receipt()): a minimum or maximum the runtime computed over every item it read is the answer
   * whatever item the provider ranked first. Code computes the values (src/facts.js parses each item's price, time,
   * rating or count and orders them); the provider says what the page means, so its pick still has to say that the
   * answer is one of these items. Returns `{ confirmed, code }` (autoConfirm's shape, its answer the aggregation's
   * first item) or null. It applies when the aggregation is op min or max with a measure, not partial (every page
   * and item read: no records_cut, more_offered, memory_full, not_verified, list_none or value note), not a tie, every
   * item has a value of the measure (`unvalued` 0), the question has no condition clause the intent left unread
   * (`unread`, src/facts.js unreadConditions: "with free cancellation"), the provider ranked the candidates and its top pick is the first
   * item or another item of the aggregation (`pick` first or item, rankAnswerWith), no page of the run tripped the
   * injection guard, and the first item passes autoConfirm's own checks (intent, shape, multi-part line) as if it
   * were the certain top candidate. A pick that is no item at all (`pick` other: a plain block, an earlier line, an
   * item of another list) keeps the old rule and its `answer:aggregate_disagrees`: the provider read the answer
   * somewhere else, which says the aggregation may be over the wrong thing (the wrong list, the wrong kind of
   * value). When the provider's top is the first item and the usual rule already confirms it, nothing changes. The
   * answer's `confidence` is the provider's probability on the aggregation's items (`mass`), its basis
   * `aggregate:computed`; `code` is `answer:aggregate_overrides` (the provider ranked another item first) or
   * `answer:aggregate_confirms` (it ranked the first item first, below answerConfirm or answerMargin). The guards
   * after it in receipt() (page loading, scope mismatch, blocked page, more_unverified, a join without its trail)
   * still clear it.
   */
  aggregateOverride(question, instruction, confirmed) {
    const result = this.result;
    const aggregate = result.answer?.aggregate;
    const summary = result.answerDetail?.aggregate;
    const first = this.answerFirst;
    if (!aggregate || !summary || !first || result.answer.method !== 'provider') return null;
    if (!['min', 'max'].includes(aggregate.op) || !aggregate.measure || aggregate.partial || aggregate.tie) return null;
    if (summary.unvalued !== 0 || !['first', 'item'].includes(summary.pick)) return null;
    // A condition the aggregation did not read ("with free cancellation"): the provider's disagreement is likely that
    // condition, so the old rule stands (`aggregate:unread_condition`, then `answer:aggregate_disagrees`).
    if (summary.unread?.length) return null;
    if (confirmed.answer && result.answer.candidates?.[0]?.aggregate === 0) return null;
    if ((this.signals.guards?.injection ?? 0) >= INJECTION_NOTE) return null;
    const computed = autoConfirm({ method: 'provider', candidates: [{ ...first, confidence: 1 }] },
      { question, instruction, thresholds: this.config.thresholds });
    if (!computed.answer) return null;
    const answer = {
      ...computed.answer,
      confidence: Number.isFinite(summary.mass) ? summary.mass : first.confidence,
      basis: ['aggregate:computed', ...computed.answer.basis.filter(entry => !entry.startsWith('candidate>=')
        && !entry.startsWith('margin:'))],
    };
    return { confirmed: { ...computed, answer }, code: summary.pick === 'item' ? 'answer:aggregate_overrides' : 'answer:aggregate_confirms' };
  }

  /**
   * Receipt v2: the verdict (auto-confirmed answer, machine `why` codes, decide options, ready-to-send suggestions,
   * split plan) and the next step. Runtime-written and trusted; built from the host's instruction, URL paths and
   * runtime state, never from page text (except the auto-confirmed answer block itself).
   */
  receipt() {
    const result = this.result;
    const config = this.config;
    const question = this.question();
    const instruction = this.instruction ?? '';
    const why = [...this.signals.why];
    if (this.signals.done !== null) why.push(`done:${round2(this.signals.done)}`);
    for (const name of GUARD_NAMES) {
      const p = this.signals.guards[name];
      const note = name === 'injection' ? INJECTION_NOTE : GUARD_NOTE;
      if (Number.isFinite(p) && p >= note) why.push(`guard:${name}:${round2(p)}`);
    }
    const shape = this.signals.expectationShape ?? lintExpectation(config.expectation).shape;
    if (shape !== 'none') why.push(`expectation:${shape}`);
    const finalUrl = result.observation?.url;
    if (finalUrl && ['expectation_mismatch', 'expectation_failed'].includes(result.code)) {
      const path = suggestExpectation(finalUrl)?.urlIncludes;
      if (path) why.push(`final_url:${path}`);
    }
    // The expectation's textIncludes or titleIncludes is not on the final page: say what the page has instead (its
    // headings closest to the expected words, quoted), so a host that guessed the wording can correct it.
    if (result.verification?.checked && !result.verification.passed && result.status !== 'completed'
      && config.expectation && typeof config.expectation === 'object') {
      const hint = expectationHint(result.observation, config.expectation);
      if (hint) {
        result.verification.hint = hint;
        why.push('expectation:text_missing');
      } else {
        delete result.verification.hint;
      }
    }
    const hops = namedHops(instruction);
    const join = isJoinTask(instruction);
    if (join) why.push('join_task');
    if (hops.length > SPLIT_HOPS) why.push(`hops:${hops.length}`);
    if (result.trail?.length) why.push('trail_has_fact');
    const aggregated = result.answer?.aggregate;
    if (aggregated) {
      why.push(`aggregate:${aggregated.measure ? `${aggregated.op}_${aggregated.measure}` : aggregated.op}:${aggregated.items}`);
      if (aggregated.partial) why.push(...(aggregated.why ?? []).map(code => `aggregate:partial:${code}`));
    }
    // The question sets a condition on the items that the aggregation did not parse (src/facts.js unreadConditions).
    if (result.answerDetail?.aggregate?.unread?.length) why.push('aggregate:unread_condition');
    // Which record list the aggregation read (listChoice): the provider's, "none", or the fallback and its reason.
    if (result.answerDetail?.lists?.why) why.push(result.answerDetail.lists.why);
    if (result.answer?.source) why.push(`answer:from_state:${result.answer.source.state}`);
    // Earlier states keyed to another day than the question's page were not answer candidates (trail only).
    const scopedOut = result.answerDetail?.scope?.excluded?.length ?? 0;
    if (scopedOut) why.push(`answer:scoped_out:${scopedOut}`);
    // Status text already on the two latest earlier observations of the final page, with nothing else changed (no
    // content wait ran: the run did not end on a passing page), is not loading either (persistentPlaceholders).
    const final = result.observation;
    const pending = this.loadingOf(final);
    // As in awaitContent: the two latest earlier observations of the URL and the final one all alike.
    const earlier = pending.length
      ? this.visited.filter(item => item !== final && item?.url === final?.url).slice(-PERSISTENT_QUIET_WAITS)
      : [];
    if (earlier.length === PERSISTENT_QUIET_WAITS
      && [...earlier, final].every((item, i, all) => i === 0 || persistentPlaceholders(all[i - 1], item, pending))) {
      for (const block of pending) this.persistentLoading.add(String(block.text).trim());
      if (!why.includes('content_status:persistent')) why.push('content_status:persistent');
    }
    // The final page still shows a loading placeholder (waits exhausted): its text is not the answer yet.
    const loading = this.loadingOf(final).length > 0;
    if (loading && !why.includes('content_loading')) why.push('content_loading');

    let answer = null;
    // A call that only performs actions asked nothing: its ranked candidates stay in answer.candidates, unconfirmed.
    const asks = this.asks();
    if (!asks && result.answer?.candidates?.length) why.push('answer:not_asked');
    if (asks && ANSWER_STATUSES.has(result.status) && question.trim()) {
      let confirmed = autoConfirm(result.answer, { question, instruction, thresholds: config.thresholds });
      // A complete minimum or maximum is computed, not ranked: its first item is the answer (aggregateOverride).
      const override = this.aggregateOverride(question, instruction, confirmed);
      if (override) confirmed = override.confirmed;
      answer = confirmed.answer;
      // A join task's answer depends on an earlier page: without a trail line the final page alone is not enough.
      if (answer && join && !result.trail?.length) {
        answer = null;
        why.push('answer:no_trail');
      }
      if (answer && loading) {
        answer = null;
        why.push('answer:page_loading');
      }
      // The question (or instruction) names a day no page of the run was keyed to, while some page was keyed to
      // another day: the rows read are not that day's (src/facts.js answerScope).
      // The runtime's own "more" click (completeList) left a page the expectation rejects, or failed midway: the
      // states it read are in the memory, but nothing verified them; the list may be half-expanded.
      if (answer && (why.includes('more:unverified') || why.includes('more:failed'))) {
        answer = null;
        why.push('answer:more_unverified');
      }
      if (result.answerDetail?.scope?.mismatch) {
        if (answer) answer = null;
        why.push('answer:scope_mismatch');
      }
      // The provider scored the page as blocked (login/paywall/captcha): its text is never auto-confirmed.
      if (answer && why.includes('guard:blocked_page')) answer = null;
      // An aggregation over remembered states: auto-confirmed only over items the run fully read, with a unique
      // first value, and either the provider's top candidate is its first item or the override took it
      // (aggregateOverride: a complete minimum or maximum whose items the provider's pick is one of).
      const aggregate = result.answer?.aggregate;
      if (aggregate) {
        const top = override ? this.answerFirst : result.answer.candidates?.[0];
        let blocked = null;
        if (aggregate.op === 'filter') blocked = 'answer:aggregate_filter';
        else if (aggregate.partial) blocked = 'answer:aggregate_partial';
        else if (aggregate.tie) blocked = 'answer:aggregate_tie';
        else if (top?.aggregate !== 0) blocked = 'answer:aggregate_disagrees';
        if (answer && blocked) {
          answer = null;
          why.push(blocked);
        } else if (answer && override) {
          why.push(override.code);
        }
        if (answer && !blocked && WHICH_QUESTION.test(question)) {
          // "Which tent ... and what does it cost?": the item line is the answer, not only its price.
          answer = { ...answer, text: String(top.text ?? '').trim(), exact: false,
            basis: [...answer.basis.filter(entry => !entry.startsWith('value:')), 'value:aggregate_item'] };
          delete answer.line;
        }
      }
      const fromState = (override ? this.answerFirst : result.answer?.candidates?.[0])?.source?.state !== undefined;
      if (answer && fromState && !aggregate && result.answerDetail?.aggregateIntent) {
        // An aggregating question whose items are on the final page: an earlier-state line is not one of them.
        answer = null;
        why.push('answer:aggregate_disagrees');
      }
      if (answer && fromState && (this.signals.guards?.injection ?? 0) >= INJECTION_NOTE) {
        // The provider's injection guard flagged a page of this run: a remembered line is never auto-confirmed.
        answer = null;
        why.push('answer:from_state_guarded');
      }
      // A remembered line is ranked with its section heading in front; the confirmed value is the line itself.
      const heading = result.answer?.candidates?.[0]?.source?.heading;
      if (answer && !override && heading && result.answer.candidates[0].aggregate === undefined) {
        const prefix = `${heading} › `;
        const strip = text => (typeof text === 'string' && text.startsWith(prefix) ? text.slice(prefix.length) : text);
        answer = { ...answer, text: strip(answer.text) };
        if (answer.line !== undefined) answer.line = strip(answer.line);
        if (answer.line === answer.text) delete answer.line;
      }
      if (!answer && result.status === 'completed') why.push(...confirmed.why);
    }
    const plan = (join || hops.length > SPLIT_HOPS) && result.status !== 'completed'
      ? { split: true, reason: join ? 'join_task' : 'hops>3', hops: hops.length }
      : null;
    result.verdict = buildVerdict(result, {
      answer,
      hasQuestion: Boolean(config.answerQuestion),
      why,
      decide: this.signals.decide,
      suggested: (loading && this.suggestLoaded()) || this.suggest(hops, plan),
      plan,
      loading,
    });
    result.next = nextFor(result);
  }

  /**
   * The host's expectation plus textAbsent set to the runtime's lexicon constant for the placeholder ("Loading"), so
   * a re-run waits for the content. The placeholder's page text never enters this trusted field; it stays in
   * page.digest. A placeholder outside the lexicon gets no suggestion.
   */
  suggestLoaded() {
    const current = this.config.expectation && typeof this.config.expectation === 'object' ? this.config.expectation : {};
    if (current.textAbsent) return null;
    const absent = this.loadingOf(this.result.observation).map(block => loadingLexiconEntry(block.text)).find(Boolean);
    if (!absent) return null;
    const expectation = { ...current, textAbsent: absent };
    const finalUrl = this.result.observation?.url;
    if (!expectation.urlIncludes && finalUrl) {
      const path = suggestExpectation(finalUrl)?.urlIncludes;
      if (path) expectation.urlIncludes = path;
    }
    return { expectation };
  }

  /** Ready-to-send fixes: the real final URL as the expectation, and the unvisited named pages as an instruction. */
  suggest(hops, plan) {
    const result = this.result;
    const code = result.code;
    if (['completed', 'needs_user', 'failed', 'stopped'].includes(result.status)) return null;
    const config = this.config;
    const current = config.expectation && typeof config.expectation === 'object' ? config.expectation : null;
    const finalUrl = result.observation?.url;
    const suggested = {};
    // The run stopped on the page the provider judged final: its real URL is the expectation to use.
    if (['expectation_mismatch', 'expectation_failed', 'no_expectation', 'expectation_error'].includes(code)) {
      const expectation = finalUrl ? suggestExpectation(finalUrl, current) : null;
      if (expectation) suggested.expectation = expectation;
    }
    const wrongPage = ['handoff', 'action_budget', 'decision_budget', 'time_budget', 'no_progress', 'unsupported',
      'stale', 'target_unavailable', 'capture_failed', 'step_complete', 'expectation_failed', 'low_confidence'];
    if (wrongPage.includes(code) && hops.length) {
      const seen = [];
      for (const step of result.steps) seen.push(String(step.action?.label ?? '').toLowerCase());
      for (const observation of this.visited) {
        seen.push(String(observation?.title ?? '').toLowerCase());
        try {
          seen.push(decodeURIComponent(new URL(observation.url).pathname).toLowerCase().replace(/[-_/.]+/g, ' '));
        } catch {
          // Unparsable URL: nothing to compare.
        }
      }
      const remaining = remainingHops(hops, seen);
      const next = plan ? remaining.slice(0, SPLIT_HOPS) : remaining;
      // The run acted but reached none of the named pages: the suggestion would be the tried instruction again.
      const repeat = result.steps.length > 0 && remaining.length === hops.length;
      const instruction = suggestInstruction({
        hops,
        remaining: next,
        question: config.answerQuestion,
        readOnly: config.mode === 'read-only',
      });
      if (instruction && !repeat && instruction !== this.instruction) {
        suggested.instruction = instruction;
        suggested.maxActions = suggestMaxActions(next.length);
        // Keep a good expectation with the new instruction so the re-run is still verified.
        // Never one that passed on the start page already (url_start, expectation:prepassing): it proves nothing.
        const vacuous = this.signals.expectationShape === 'url_start'
          || this.signals.why.includes('expectation:prepassing');
        if (!suggested.expectation && current && !vacuous && !lintExpectation(current).weak) {
          suggested.expectation = { ...current };
        }
      }
    }
    return Object.keys(suggested).length ? suggested : null;
  }

  /** Whether the call's provider request cap leaves room for `count` more requests (in-call retries only). */
  retryRoom(count) {
    const state = this.config.retryState;
    return state.requests + count <= state.requestCap;
  }

  /** Milliseconds left in this attempt's time budget. */
  remainingMs() {
    return this.config.timeoutMs - (Date.now() - this.started);
  }

  /**
   * Whether a second opinion could change what this decision does, and why: `floor` (the choice is below its
   * confidence floor, so it would go to the host as low_confidence), `handoff_close` (a handoff whose lead over the
   * best link or control is under secondOpinionMargin) or `close` (a link whose lead over the next link or control is
   * under it). Null when the switch is off, the per-call bound is used up, the provider reported no probabilities,
   * or the page or decision is one a retry must not second-guess (consent dialog, injection or commit guard).
   */
  secondOpinionReason(decision, action, offered, { consent, budgetLeft }) {
    const config = this.config;
    if (!config.retry.secondOpinion || config.retryState.secondOpinions >= MAX_SECOND_OPINIONS) return null;
    if (consent || !budgetLeft || this.remainingMs() < SECOND_OPINION_MIN_MS) return null;
    const probabilities = decision?.probabilities;
    if (!probabilities || typeof probabilities !== 'object') return null;
    const guards = guardsOf(decision);
    if ((guards?.injection ?? 0) >= INJECTION_NOTE || this.controlVeto(decision)) return null;
    if (!this.retryRoom(1)) return null;
    // Links only: a button, select or fill keeps its first decision, its floor and its alternatives.
    if (action.type !== 'handoff' && actionClass(action) !== 'link') return null;
    const p = id => (isUnit(probabilities[id]) ? probabilities[id] : 0);
    const top = choiceConfidence(decision) ?? p(action.id);
    // Rivals are links only: a second opinion never swaps a handoff for a control, scrolling or waiting.
    const rival = offered
      .filter(candidate => candidate.id !== action.id && actionClass(candidate) === 'link')
      .reduce((best, candidate) => Math.max(best, p(candidate.id)), 0);
    if (rival <= 0) return null;
    const margin = config.thresholds.secondOpinionMargin;
    if (action.type === 'handoff') return top - rival < margin ? 'handoff_close' : null;
    const floor = config.thresholds.linkFloor;
    if (floor > 0 && choiceConfidence(decision) !== null && top < floor) return 'floor';
    return top - rival < margin ? 'close' : null;
  }

  /**
   * In-call retry 1, the second opinion: ask the provider once more with the non-terminal options in reverse order
   * (handoff stays last). The same choice keeps the more confident of the two decisions; a different choice wins only
   * with a higher confidence. Guards are merged by their maximum, so a second opinion can add a veto but never lift
   * one. Returns `{ decision, action }` to continue with. A failed request keeps the first decision.
   */
  async secondOpinion(decision, action, offered, observation, history, reason) {
    const state = this.config.retryState;
    state.secondOpinions++;
    const firstRequest = this.lastRequest;
    const firstRecord = this.lastDecision;
    const terminal = offered.filter(candidate => candidate.type === 'done' || candidate.type === 'handoff');
    const reordered = [...offered.filter(candidate => !terminal.includes(candidate)).reverse(), ...terminal];
    const c1 = choiceConfidence(decision);
    const entry = {
      kind: 'second_opinion', why: reason, step: this.nextStep(), first: { p: c1 === null ? null : round3(c1) },
    };
    this.retries.push(entry);
    const keepFirst = outcome => {
      entry.outcome = outcome;
      this.lastRequest = firstRequest;
      this.lastDecision = firstRecord;
      this.why(`retry:second_opinion:${outcome}`);
      return { decision, action };
    };
    let second;
    try {
      second = await this.decide(observation, reordered, history, this.instruction, 'second_opinion');
    } catch (error) {
      if (this.signal.aborted || this.interrupted) throw error;
      return keepFirst('error');
    }
    this.extraDecisions++;
    const secondAction = offered.find(candidate => candidate.id === second?.actionId);
    if (!secondAction) return keepFirst('invalid');
    const secondGuards = guardsOf(second);
    if (secondGuards) this.noteGuards(secondGuards);
    const c2 = choiceConfidence(second);
    entry.second = { p: c2 === null ? null : round3(c2), same: secondAction.id === action.id };
    const higher = (c2 ?? -1) > (c1 ?? -1);
    // A different choice may only be a link, or a handoff instead of a link: never a control, scroll or wait.
    const switchable = actionClass(secondAction) === 'link' || (secondAction.type === 'handoff' && action.type !== 'handoff');
    let use = decision;
    let chosen = action;
    if (secondAction.id === action.id) {
      entry.outcome = 'agreed';
      if (higher) use = second;
    } else if (higher && switchable) {
      entry.outcome = 'changed';
      use = second;
      chosen = secondAction;
    } else {
      entry.outcome = 'kept';
    }
    // Both requests asked the guard questions about this page: the higher value of each counts.
    const merged = { ...(guardsOf(decision) ?? {}) };
    for (const [name, value] of Object.entries(secondGuards ?? {})) if (!(merged[name] >= value)) merged[name] = value;
    if (use === decision) this.lastRequest = firstRequest;
    // The second decide's choice runs: the first decide's entry gets the step as well (execute()).
    else this.pairedRequest = firstRequest;
    use = Object.keys(merged).length ? { ...use, guards: merged } : use;
    this.lastDecision = decisionRecord('provider', use);
    this.lastDecision.secondOpinion = { why: reason, outcome: entry.outcome };
    this.why(`retry:second_opinion:${entry.outcome}`);
    return { decision: use, action: chosen };
  }

  /**
   * In-call retry 2, the back-out target: on a read-only run whose steps so far are free of side effects, the page
   * reached by the last link (followed only by scrolling or waiting) fails the expectation and is none of the pages
   * the instruction names. Returns the link step and the URL before it, or null. The caller has already established
   * that the provider handed off (or chose below its floor) on this page.
   */
  async backOutTarget(observation, { budgetLeft }) {
    const config = this.config;
    if (!config.retry.backOut || config.retryState.backOuts >= MAX_BACK_OUTS) return null;
    if (config.level !== 'read-only' || config.step || !budgetLeft) return null;
    if (config.expectation === undefined || config.expectation === null) return null;
    if (this.result.cost.decisions - this.extraDecisions >= config.maxDecisions) return null;
    if (this.remainingMs() < BACK_OUT_MIN_MS) return null;
    const steps = this.result.steps;
    if (!steps.length || !steps.every(step => SIDE_EFFECT_FREE.has(step.class) && !step.interrupted)) return null;
    let index = steps.length - 1;
    while (index >= 0 && steps[index].class === 'page') index--;
    const link = steps[index];
    if (!link || link.class !== 'link' || link.decision?.by !== 'provider') return null;
    const from = link.action.fromUrl;
    if (!from || from === link.action.toUrl || observation.url !== link.action.toUrl) return null;
    if (!sameOrigin(from, safeOrigin(observation.url)) || !allowedOrigin(from, config.allowedOrigins)) return null;
    // Clearly not the target: the instruction names its pages, and neither the link nor the page it reached is one
    // of them (a handoff on a named intermediate page goes to the rerun suggestion instead). Without named pages
    // the runtime cannot tell a wrong link from an unnamed intermediate hop, so it does not back out.
    const hops = namedHops(this.instruction ?? '');
    if (!hops.length) return null;
    let path = '';
    try {
      path = decodeURIComponent(new URL(observation.url).pathname).toLowerCase().replace(/[-_/.]+/g, ' ');
    } catch {
      // Unparsable URL: the label and the title still count.
    }
    const seen = [String(link.action.label ?? '').toLowerCase(), String(observation.title ?? '').toLowerCase(), path];
    if (hops.some(hop => !remainingHops([hop], seen).length)) return null;
    if (await this.expectationFor(observation) !== false) return null;
    return { link, from };
  }

  /**
   * In-call retry 3, the self-rerun plan: after close(), the next step is `rerun` with a concrete suggestion (a
   * suggested instruction, or the same instruction with an expectation that waits for late content), the run asked
   * no one for anything (no needs.level, no relay) and changed nothing (no button, select or fill ran), and enough
   * time is left. Returns `{ instruction, expectation, maxActions, why }` or null.
   */
  rerunPlan() {
    const { config, result } = this;
    if (!config.retry.rerun || config.step || config.retryState.reruns >= MAX_RERUNS) return null;
    // Read-only only: a suggested instruction does not carry the host's constraints for controls and forms.
    if (config.level !== 'read-only') return null;
    // Never after an expectation verdict: the suggestion there swaps the host's expectation for the page that just
    // failed it, which would verify the wrong page.
    if (['expectation_failed', 'expectation_mismatch', 'expectation_error'].includes(result.code)) return null;
    if (this.interrupted || this.callerSignal?.aborted || this.timeoutSignal.aborted) return null;
    if (result.next?.kind !== 'rerun' || !result.verdict?.suggested) return null;
    if (result.code === 'refused_action' || result.needs?.level || result.needs?.who === 'user') return null;
    if (!result.steps.every(step => SIDE_EFFECT_FREE.has(step.class) && !step.interrupted)) return null;
    if (this.remainingMs() < RERUN_MIN_MS) return null;
    // The host's budgets cover the whole call: the rerun gets what the first attempt left.
    const actionsLeft = config.maxActions - this.actionsTaken;
    const decisionsLeft = config.maxDecisions - (result.cost.decisions - this.extraDecisions);
    if (actionsLeft < 1 || decisionsLeft < 1 || !this.retryRoom(1)) return null;
    const suggested = result.verdict.suggested;
    const hostExpectation = config.expectation;
    const loading = Boolean(result.verdict.why?.includes('content_loading') && suggested.expectation && !suggested.instruction);
    let expectation = hostExpectation;
    if (loading) {
      // The one change allowed to the host's expectation: wait for the placeholder (textAbsent), nothing else.
      if (!hostExpectation || typeof hostExpectation !== 'object' || !suggested.expectation.textAbsent) return null;
      expectation = { ...hostExpectation, textAbsent: suggested.expectation.textAbsent };
    }
    if (!suggested.instruction && !loading) return null;
    const same = text => String(text ?? '').trim().toLowerCase();
    if (suggested.instruction && same(suggested.instruction) === same(this.instruction)) return null;
    return {
      instruction: suggested.instruction ?? this.instruction,
      expectation,
      maxActions: Math.min(suggested.maxActions ?? actionsLeft, actionsLeft),
      maxDecisions: decisionsLeft,
      why: result.code,
      loading,
    };
  }

  /**
   * Rung 4: after a handoff, up to five offered actions whose labels contain a question or instruction term, most
   * likely first. Two or more make a `choose` receipt; the host passes one id to act() with the revision.
   */
  decideOptions(decision, offered, observation) {
    const terms = new Set(tokenize(`${this.question()} ${this.instruction ?? ''}`, { query: true }));
    if (!terms.size) return null;
    const probabilities = decision?.probabilities ?? {};
    let executable = offered.filter(action => !['done', 'handoff', 'scroll', 'wait'].includes(action.type));
    // The page looks like it carries injected instructions: only plain navigation links to approved origins remain
    // (the same thing the injection veto lets run), so the host is never told to act on what the page asked for.
    const injection = Math.max(guardsOf(decision)?.injection ?? 0, this.signals.guards.injection ?? 0);
    if (injection >= GUARD_VETO) {
      executable = executable.filter(action => approvedLink(action, observation, this.config) && plainNavLabel(action.label));
      this.why('decide:injection_filtered');
    }
    // The commit guard is high: no button, select or fill is offered to the host either.
    if (this.controlVeto(decision) && executable.some(commitCandidate)) {
      executable = executable.filter(action => !commitCandidate(action));
      this.why('decide:commit_filtered');
    }
    const matching = executable
      .map((action, index) => ({ action, index, p: Number.isFinite(probabilities[action.id]) ? probabilities[action.id] : null }))
      .filter(({ action }) => tokenize(action.label ?? '').some(term => terms.has(term)))
      .sort((a, b) => (b.p ?? -1) - (a.p ?? -1) || a.index - b.index)
      .slice(0, MAX_DECIDE_OPTIONS);
    if (matching.length < 2) return null;
    const ask = clip(String(this.config.answerQuestion ?? this.instruction ?? '').replace(/\s+/g, ' ').trim(), 160);
    return {
      question: `Which offered action leads toward: ${ask}`,
      options: matching.map(({ action, p }) => {
        const option = { id: action.id, label: clip(action.label, 120) };
        if (p !== null) option.p = round3(p);
        return option;
      }),
      revision: observation.revision,
      executable,
    };
  }

  /** True when off-screen blocks or links contain an instruction term (scroll nudge before a handoff). */
  offscreenMatch(observation) {
    const terms = new Set(tokenize(`${this.question()} ${this.instruction ?? ''}`, { query: true }));
    if (!terms.size) return false;
    const hit = text => tokenize(text).some(term => terms.has(term));
    if (blocksOf(observation).some(block => block.offscreen && hit(block.text))) return true;
    return (observation.controls ?? []).some(control => control.offscreen === true && hit(control.label));
  }
}

/**
 * The first attempt of a self-rerun as the trace keeps it: outcome, verdict codes and suggestion. Its steps are the
 * first `steps` entries of the merged result's steps.
 */
function attemptRecord(session) {
  const result = session.result;
  return {
    attempt: 1,
    instruction: session.instruction,
    status: result.status,
    code: result.code,
    why: [...(result.verdict?.why ?? [])],
    suggested: result.verdict?.suggested ? structuredClone(result.verdict.suggested) : null,
    finalUrl: result.observation?.url ?? null,
    steps: result.steps.length,
    cost: { ...result.cost },
  };
}

/** Fold the first attempt of a self-rerun into the second's result (see BrowserRuntime #rerun). */
function mergeAttempts(first, second, plan) {
  const a = first.result;
  const b = second.result;
  const cost = b.cost;
  cost.decisions += a.cost.decisions;
  cost.inputTokens += a.cost.inputTokens;
  cost.outputTokens += a.cost.outputTokens;
  cost.elapsedMs = Date.now() - first.started;
  cost.requests = [
    ...a.cost.requests.map(entry => ({ ...entry, attempt: 1 })),
    ...cost.requests.map(entry => ({ ...entry, attempt: 2 })),
  ];
  // Every action this call ran, in order: the first attempt's steps (its final one carries the screenshot capture
  // 'last' took when it closed) and the rerun's, which continue its numbering (Session.stepBase).
  b.steps = [...a.steps, ...b.steps];
  const rerun = {
    kind: 'rerun',
    why: plan.why,
    outcome: b.code,
    status: b.status,
    first: { status: a.status, code: a.code, steps: a.steps.length, url: urlPath(a.observation?.url) },
  };
  if (plan.instruction !== first.instruction) rerun.instruction = plan.instruction;
  if (plan.expectation && typeof plan.expectation === 'object'
    && JSON.stringify(plan.expectation) !== JSON.stringify(first.config.expectation)) {
    rerun.expectation = structuredClone(plan.expectation);
  }
  rerun.maxActions = plan.maxActions;
  b.retries = [...(a.retries ?? []), rerun, ...(b.retries ?? [])];
  for (const warning of a.warnings ?? []) {
    b.warnings ??= [];
    if (!b.warnings.includes(warning)) b.warnings.push(warning);
  }
  // The site-profile block covers both attempts (the first attempt's fast steps stay on the receipt).
  const site = mergeSite([a.site, b.site]);
  if (site) b.site = site;
  Object.defineProperty(b, 'attempts', { value: [attemptRecord(first)], enumerable: false, writable: true, configurable: true });
}

/**
 * Whether a list step lets the next one start: completed with its expectation passing, and a result the host would
 * accept as is (next answer or answer_from_digest; not a page the provider scored as blocked or still loading).
 */
function listStepPassed(result) {
  return listStepHeld(result) === null && result.status === 'completed' && result.verification?.passed === true;
}

/**
 * Why a list step whose expectation passed still stops the list, or null: `guard:blocked_page` (the provider scored
 * the page blocked), or `next:<kind>` when its verdict is not one the host would accept as is. A page that still
 * shows a placeholder does not stop it once the step's own expectation passed (a late-load step's expectation never
 * passes while one shows, checkExpectation); the receipt keeps `content_loading`.
 */
function listStepHeld(result) {
  if (result.status !== 'completed' || result.verification?.passed !== true) return null;
  const why = result.verdict?.why ?? [];
  if (why.includes('guard:blocked_page')) return 'guard:blocked_page';
  const kind = result.next?.kind;
  if (['answer', 'answer_from_digest'].includes(kind)) return null;
  if (why.includes('content_loading') && kind === 'rerun') return null;
  return `next:${kind ?? 'none'}`;
}

/**
 * One step of a list as the receipt's `stepResults` carries it, kept small: `{i, status, code, passed}` plus, when the
 * step asked a question, `asked`, its auto-confirmed `answer` (`{text, line?, exact?}`), its `url` and (an earlier
 * step without a confirmed answer) its top two `candidates`. The step a list stopped at also has `kind` (its verdict
 * kind), `expectation` and `url`. Codes are trusted; `answer`, `candidates` and `url` are page text.
 */
function listEntry(result, index, spec, { last, stopping, likely }) {
  const entry = { i: index + 1, status: result.status, code: result.code, passed: result.verification?.passed === true };
  // Its expectation passed, but the list did not accept the step (listStepHeld): the list stops here, at this step.
  const held = stopping ? listStepHeld(result) : null;
  if (held) entry.held = held;
  const answer = result.verdict?.answer;
  if (spec.answerQuestion) {
    entry.asked = true;
    // A likely answer filled a later step's placeholder: trusted marker; the value itself stays among the candidates.
    if (likely) entry.answerSource = 'likely';
    if (answer) {
      entry.answer = { text: answer.text };
      if (typeof answer.line === 'string' && answer.line !== answer.text) entry.answer.line = answer.line;
      if (answer.exact === false) entry.answer.exact = false;
    } else if (!last && result.answer?.candidates?.length) {
      // Its page is no longer the final page (the last step's candidates are the result's own answer.candidates).
      entry.candidates = result.answer.candidates.slice(0, 2).map(candidate => ({ text: candidate.text, confidence: candidate.confidence }));
    }
  }
  if (stopping) {
    entry.kind = result.verdict?.kind ?? null;
    entry.expectation = result.verification?.expectation ?? null;
  }
  if ((stopping || entry.asked) && result.page?.url) entry.url = result.page.url;
  return entry;
}

/**
 * A step list's answer when every step that asked a question has an auto-confirmed one: `{ text, confidence, basis,
 * steps, exact? }`, where `text` is one "step N: <answer>" line per step, `confidence` the lowest of them, `steps`
 * each step's `{ i, text, line?, exact? }` (trusted structure; the values are page text, as every answer is) and
 * `exact: false` when any step's answer is a whole page line.
 */
function listAnswer(results, specs) {
  const steps = [];
  let confidence = 1;
  let exact = true;
  results.forEach((item, index) => {
    const answer = item.verdict?.answer;
    if (!specs[index]?.answerQuestion || !answer) return;
    const entry = { i: index + 1, text: answer.text };
    if (typeof answer.line === 'string' && answer.line !== answer.text) entry.line = answer.line;
    if (answer.exact === false) {
      entry.exact = false;
      exact = false;
    }
    confidence = Math.min(confidence, Number(answer.confidence) || 0);
    steps.push(entry);
  });
  const out = {
    text: steps.map(entry => `step ${entry.i}: ${entry.text}`).join('\n'),
    confidence: Math.round(confidence * 1000) / 1000,
    basis: [`steps:answers:${steps.length}`],
    steps,
  };
  if (!exact) out.exact = false;
  return out;
}

/**
 * Fold the steps a list ran into one result (the stopping or last step's, mutated): every action in order, summed
 * cost (cost.requests marked with `listStep`), merged warnings and retries, `stepResults` for every step (`not_run`
 * for those that did not start) and the call's outcome. Verification passes only when every step ran and passed;
 * `stop` ({before, code, why}) is a stop decided between steps (placeholder, time, actions, decisions, interrupt),
 * which becomes the outcome while the page, answer candidates and trail stay the last step's. The trace keeps each
 * step's filled instruction and outcome under `stepRuns`.
 */
function composeList(sessions, specs, filled, stop, started, values, usedLikely = new Set(), finalExpectation = null) {
  const count = specs.length;
  const results = sessions.map(session => session.result);
  const ran = results.length;
  const result = results.at(-1);
  const entries = specs.map((spec, index) => {
    if (index < ran) {
      return listEntry(results[index], index, spec, { last: index === ran - 1,
        stopping: !stop && index === ran - 1 && !listStepPassed(results[index]), likely: usedLikely.has(index + 1) });
    }
    const entry = { i: index + 1, status: 'not_run', code: stop && index === stop.before ? stop.code : 'not_run' };
    if (stop && index === stop.before && stop.why?.length) entry.why = [...stop.why];
    return entry;
  });
  const runs = results.map((item, index) => ({
    step: index + 1,
    instruction: filled[index]?.instruction,
    status: item.status,
    code: item.code,
    why: [...(item.verdict?.why ?? [])],
    finalUrl: item.observation?.url ?? null,
    steps: item.steps.length,
    ...(usedLikely.has(index + 1) ? { answerSource: 'likely' } : {}),
    cost: { ...item.cost },
    ...(Array.isArray(item.attempts) ? { attempts: item.attempts } : {}),
  }));
  const cost = result.cost;
  const requests = results.flatMap((item, index) => (item.cost.requests ?? []).map(entry => ({ ...entry, listStep: index + 1 })));
  cost.decisions = results.reduce((sum, item) => sum + item.cost.decisions, 0);
  cost.inputTokens = results.reduce((sum, item) => sum + item.cost.inputTokens, 0);
  cost.outputTokens = results.reduce((sum, item) => sum + item.cost.outputTokens, 0);
  cost.elapsedMs = Date.now() - started;
  cost.requests = requests;
  result.steps = results.flatMap(item => item.steps);
  const retries = results.flatMap((item, index) => (item.retries ?? []).map(entry => ({ ...entry, listStep: index + 1 })));
  if (retries.length) result.retries = retries;
  const warnings = [...new Set(results.flatMap(item => item.warnings ?? []))];
  if (warnings.length) result.warnings = warnings;
  // Site-profile blocks of every step, merged (fast steps, path, hints, the first fallback).
  const site = mergeSite(results.map(item => item.site));
  if (site) result.site = site;
  const passed = results.filter(listStepPassed).length;
  const stepNumber = stop ? stop.before + 1 : ran;
  // A receipt the runtime could not compute (receiptError) falls back to the code-only verdict.
  result.verdict ??= buildVerdict(result);
  if (stop) {
    setOutcome(result, stop.code);
    result.reason = `Step ${stepNumber} of ${count} did not start: ${result.reason}`;
    result.verification = { ...result.verification, passed: false };
    result.verdict = buildVerdict(result, {
      why: [...(stop.why ?? []), `steps:stopped_before:${stepNumber}`, `steps:${passed}/${count}`],
      hasQuestion: Boolean(specs[stop.before].answerQuestion),
    });
  } else if (ran < count || passed < count) {
    result.reason = `Step ${stepNumber} of ${count}: ${result.reason}`;
    if (ran < count) result.verification = { ...result.verification, passed: false };
    // The last step's own expectation passed, but the list held it: the call's verification says why it failed.
    const held = entries[ran - 1]?.held;
    if (held) result.verification = { ...result.verification, passed: false, held: `step:${ran}:${held}` };
    result.verdict.why.push(`steps:stopped_at:${stepNumber}`, `steps:${passed}/${count}`);
  } else {
    result.reason = `All ${count} steps passed: ${result.reason}`;
    result.verdict.why.push(`steps:${count}/${count}`);
    // Answers from more than one step (or from an earlier step only): with every asked step auto-confirmed, the
    // call's verdict.answer lists them (listAnswer); otherwise the host replies from stepResults and the digest, and
    // the last step's own answer alone would mislead as the call's.
    const asked = entries.filter(entry => entry.asked);
    if (asked.length > 1 || (asked.length === 1 && asked[0].i !== count)) {
      const confirmed = asked.every(entry => entry.answer);
      const kind = confirmed ? 'answer' : 'answer_from_digest';
      result.verdict.kind = 'verified';
      result.verdict.oversight = confirmed ? 'none' : 'confirm';
      result.verdict.suggested = null;
      result.verdict.answer = confirmed ? listAnswer(results, specs) : null;
      Object.defineProperty(result.verdict, 'nextKind', { value: kind, enumerable: false, writable: true, configurable: true });
    }
  }
  result.stepResults = entries;
  // A likely answer filled a later step's instruction or question (trusted marker; never a confirmed answer).
  for (const n of [...usedLikely].sort((a, b) => a - b)) {
    if (!result.verdict.why.includes(`steps:likely_fill:${n}`)) result.verdict.why.push(`steps:likely_fill:${n}`);
  }
  // The steps the host sends to continue (renumbered, earlier answers written in): next.steps, with the call's own
  // top-level expectation in the last of them (or, when a field conflicts, next.expectation to send alongside).
  const from = stop ? stop.before : ran < count || passed < count ? ran - 1 : null;
  result.next = nextFor(result, from === null ? {} : carryExpectation(carryForward(specs, from, values), finalExpectation));
  Object.defineProperty(result, 'stepRuns', { value: runs, enumerable: false, writable: true, configurable: true });
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------------------------

// The widest screenshot the extension serves (extension/offscreen.js MAX_WIDTH): a frame wider than this is scaled down.
const IMAGE_MAX_WIDTH = 1280;

/**
 * The size of the screenshot of an offer's revision: the one the daemon noted after the observe capture, else what
 * the extension would make of this viewport (device pixels, downscaled to IMAGE_MAX_WIDTH). Null without a viewport.
 */
export function offerImage(offer) {
  if (offer?.image?.width > 0 && offer.image.height > 0) return { ...offer.image, noted: true };
  const viewport = offer?.observation?.viewport;
  if (!(viewport?.width > 0 && viewport?.height > 0)) return null;
  const dpr = viewport.dpr > 0 ? viewport.dpr : 1;
  const scale = Math.min(1, IMAGE_MAX_WIDTH / (viewport.width * dpr)) * dpr;
  return { width: Math.round(viewport.width * scale), height: Math.round(viewport.height * scale), noted: false };
}

/**
 * A point of the screenshot of an offer mapped to CSS viewport pixels: { image: {x, y}, css: {x, y}, scale,
 * imageSize } or null when the point is off the image (or no image size is known). The image shows the whole
 * viewport (the footer band is drawn over it), so image pixels scale uniformly to CSS pixels.
 */
export function mapPoint(offer, point) {
  const image = offerImage(offer);
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!image || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const scale = image.width / offer.observation.viewport.width;
  // Rounded to a tenth of a CSS pixel: the same numbers go to locate and to execute, which compares them.
  const css = { x: Math.round((x / scale) * 10) / 10, y: Math.round((y / scale) * 10) / 10 };
  return { image: { x, y }, css, scale: Math.round(scale * 1000) / 1000, imageSize: { width: image.width, height: image.height } };
}

/**
 * What a point click runs for the control the page script located (`found`: { id, control }, id the observed
 * control's id or null): the offered click on that control when there is one (exactly what the host could have named
 * by id), else the click offeredActions would build for the control alone under the offer's authority (the same
 * gate: forbid labels, link rules, password and payment fields, risk classes, level capabilities). A field or select
 * offered only as fills or options is clicked (focused or opened), never typed into. `{ refusal }` names why nothing
 * may run: a controlBlock reason ({ kind, capability }), `unavailable`, `cross_origin` (a link off the approved site
 * or into a new tab), `level` (no controls at this level) or `risk`.
 */
export function pointAction(offer, found, config) {
  const control = found.control;
  const id = found.id;
  const run = (action, offered) => ({ action, offered, control });
  if (id !== null && id !== undefined) {
    const own = offer.actions.filter(action => action.target !== undefined && String(action.target) === String(id));
    const click = own.find(action => action.type === 'click');
    if (click) return run(click, true);
  }
  const ref = id ?? 'point';
  const alone = { ...offer.observation, controls: [{ ...control, id: ref }] };
  const built = offeredActions(alone, { ...config, allowedUrls: [], exclude: undefined, hints: undefined, pinned: null }).actions
    .filter(action => action.target === ref || (action.type === 'navigate_allowed_url' && action.newTab));
  const click = built.find(action => action.type === 'click') ?? built.find(action => action.type === 'navigate_allowed_url');
  const place = action => (id === null || id === undefined ? { ...action, point: config.point } : action);
  if (click) return run(place({ ...click, id: 'point' }), false);
  if (built.length) {
    const role = control.role || 'control';
    const label = clip(control.label, 180) || `unlabelled ${role} ${ref}`;
    return run(place({ id: 'point', type: 'click', target: ref, role, label, description: `Click ${role} ${ref}: ${label} (focus or open only, no typing)` }), false);
  }
  const guard = policyOf(config);
  const block = controlBlock(control, guard, pageFacts(offer.observation));
  if (block) return { refusal: block, control };
  if (control.enabled === false || control.visible === false) return { refusal: { kind: 'unavailable', capability: null }, control };
  if (control.sensitive) return { refusal: { kind: 'risk', capability: null }, control };
  if (control.role === 'link') return { refusal: { kind: 'cross_origin', capability: null }, control };
  if (!guard.allows('controls')) return { refusal: { kind: 'level', capability: 'controls' }, control };
  return { refusal: { kind: 'risk', capability: null }, control };
}

// The Approve gate's outcomes for an act whose action the user has not approved (BrowserRuntime #askApproval):
// pending (the user has not clicked yet: approval_pending, next.kind approve), denied (refused_action, stop), and
// for a class the user does not want to be asked about, a bridge that cannot ask or a level that never allows it,
// the refusal the action had before the gate (a purchase stops, a submit or delete relays its level).
export const APPROVAL_DENIED_TEXT = 'The user denied this action in the FAI Browser window. Tell the user; do not retry it.';
export const APPROVAL_PENDING_MS = 5 * 60_000;

function approvalOutcome(session, action, offer, approval) {
  const result = session.result;
  const cls = action.needsApproval;
  const control = { ref: String(action.target ?? ''), label: clip(action.label, 120) };
  if (approval.decision === 'pending') {
    setOutcome(result, 'approval_pending');
    result.needs.control = control;
    result.needs.approval = { class: cls, actionId: action.id, revision: offer.revision, expiresInMs: APPROVAL_PENDING_MS };
    // A submit or delete above the granted level: asking for that level stays the other way.
    const level = cls === 'delete' || cls === 'submit' ? levelFor(cls) : null;
    if (level && levelRank(level) > levelRank(session.config.level)) result.needs.level = level;
    session.why('approval:pending');
    return;
  }
  if (approval.decision === 'denied') {
    setOutcome(result, 'refused_action');
    result.needs.message = APPROVAL_DENIED_TEXT;
    result.needs.control = control;
    session.why('approval:denied');
    return;
  }
  if (approval.decision === 'error' && approval.code && !['unsupported', 'failed'].includes(approval.code)) {
    setOutcome(result, approval.code);
    session.why(`approval:${approval.code}`);
    return;
  }
  session.why(`approval:${['off', 'refused', 'unavailable'].includes(approval.decision) ? approval.decision : 'failed'}`);
  if (cls === 'purchase' || cls === 'secret') {
    session.refuse(cls === 'purchase' ? 'purchase' : 'secret', cls === 'purchase' ? [{ control: action, kind: 'purchase', capability: 'purchase' }] : []);
  } else {
    session.refuse(cls, [{ control: action, kind: cls, capability: cls }]);
  }
  result.needs.control = control;
}

// ---------------------------------------------------------------------------------------------------------------
// Host-composed acts (fai_browser_act beyond one offered id): typed text, batched fills, keys, hover, URLs, history,
// tabs and dialog answers. checkActChoice is the one shape check (the daemon answers 400 with it before any act).
// ---------------------------------------------------------------------------------------------------------------

export const MAX_BATCH_FILLS = 20;
export const MAX_TYPED_CHARS = 5000;
const HISTORY_MOVES = new Set(['back', 'forward', 'reload']);
// The keys a host may press: navigation and focus keys at reversible; Enter only as a field's own submit (gated as
// the submit it is); a shortcut with Ctrl or Cmd (a letter or digit, Shift allowed) only at full and testing.
const PLAIN_KEYS = new Map([
  ['escape', 'Escape'], ['esc', 'Escape'], ['tab', 'Tab'], ['shift+tab', 'Shift+Tab'], ['arrowup', 'ArrowUp'], ['up', 'ArrowUp'],
  ['arrowdown', 'ArrowDown'], ['down', 'ArrowDown'], ['arrowleft', 'ArrowLeft'], ['left', 'ArrowLeft'], ['arrowright', 'ArrowRight'],
  ['right', 'ArrowRight'], ['home', 'Home'], ['end', 'End'], ['pageup', 'PageUp'], ['pagedown', 'PageDown'], ['space', 'Space'],
  ['enter', 'Enter'], ['return', 'Enter'],
]);

/** A key name as the host wrote it: `{ wire, key, modifier }`, or null when it is not on the allowlist. */
export function pressKey(name) {
  if (typeof name !== 'string') return null;
  const compact = name.replace(/\s+/g, '').toLowerCase();
  if (compact === ' ') return { wire: 'Space', key: 'Space', modifier: false };
  const plain = PLAIN_KEYS.get(compact);
  if (plain) return { wire: plain, key: plain, modifier: false };
  const shortcut = /^(ctrl|control|cmd|command|meta)\+(shift\+)?([a-z0-9])$/.exec(compact);
  if (shortcut) {
    const mod = ['ctrl', 'control'].includes(shortcut[1]) ? 'Ctrl' : 'Cmd';
    return { wire: `${mod}+${shortcut[2] ? 'Shift+' : ''}${shortcut[3].toUpperCase()}`, key: shortcut[3], modifier: true };
  }
  return null;
}

function actChoice(choice) {
  if (typeof choice === 'string') return { actionId: choice };
  if (choice && typeof choice === 'object') return choice;
  return {};
}

/**
 * What is wrong with an act's choice on `offer`, or null: exactly one of an offered action id, a point, a URL, a
 * history move, a tab, a dialog answer and a fill batch (a key may name the field it is pressed in); text only for
 * an offered host-text fill (and every such fill needs one), submit after typed or supplied text, hover on a control, a
 * file only for an upload. Without a revision: never a point, an action the user approves or a secret use.
 */
export function checkActChoice(offer, choice, { revisionless = false } = {}) {
  const spec = actChoice(choice);
  const given = ['point', 'url', 'openTab', 'nav', 'tab', 'dialog', 'fills', 'key'].filter(key => spec[key] !== undefined && spec[key] !== null);
  if (given.length > 1) return `Give one of ${given.join(' and ')}, not both.`;
  const kind = given[0] ?? null;
  if (kind && !['key'].includes(kind) && spec.actionId !== undefined) return `actionId and ${kind} are exclusive: send one.`;
  if (!kind && (typeof spec.actionId !== 'string' || !spec.actionId)) return 'actionId or point (or url, nav, key, tab, dialog or fills) is required.';
  if (kind === 'point' && revisionless) return 'revision is required with point.';
  const find = id => offer.actions.find(candidate => candidate.id === id) ?? null;
  const action = typeof spec.actionId === 'string' ? find(spec.actionId) : null;
  if (typeof spec.actionId === 'string' && !action) return `Action ${spec.actionId} was not offered for revision ${offer.revision}.`;
  if (['url', 'openTab'].includes(kind) && (typeof spec[kind] !== 'string' || !spec[kind] || spec[kind].length > 2048)) return 'url must be a URL on the approved origins.';
  if (kind === 'nav' && !HISTORY_MOVES.has(spec.nav)) return 'nav must be back, forward or reload.';
  if (kind === 'tab' && (typeof spec.tab !== 'string' || !/^t\d{1,3}$/.test(spec.tab))) return 'tab must be a tab id from tabs (t0, t1, ...).';
  if (kind === 'dialog' && !['accept', 'dismiss'].includes(spec.dialog)) return 'dialog must be accept or dismiss.';
  if (kind === 'key') {
    if (!pressKey(spec.key)) return `Key ${String(spec.key).slice(0, 20)} is not allowed: Escape, Tab, Shift+Tab, arrows, Home, End, PageUp, PageDown, Space, Enter, or Ctrl/Cmd+letter.`;
    if (action && action.target === undefined) return 'A key is pressed in an offered control: that actionId names none.';
    if (pressKey(spec.key).key === 'Enter' && !action) return 'Enter is pressed in a filled field: give that field\'s actionId (or act on its "press Enter in" action).';
  }
  if (spec.fills !== undefined) {
    if (!Array.isArray(spec.fills) || !spec.fills.length || spec.fills.length > MAX_BATCH_FILLS) return `fills takes 1-${MAX_BATCH_FILLS} {actionId, text}.`;
    const seen = new Set();
    for (const fill of spec.fills) {
      const offered = fill && typeof fill.actionId === 'string' ? find(fill.actionId) : null;
      if (!offered) return `fills: action ${String(fill?.actionId).slice(0, 20)} was not offered for revision ${offer.revision}.`;
      if (offered.type !== 'fill') return `fills: ${fill.actionId} is not a fill the host types (a "fill ... with text" action).`;
      if (typeof fill.text !== 'string' || fill.text.length > MAX_TYPED_CHARS) return `fills: each text is a string of at most ${MAX_TYPED_CHARS} characters.`;
      if (seen.has(fill.actionId)) return `fills: ${fill.actionId} appears twice.`;
      seen.add(fill.actionId);
    }
  }
  if (spec.text !== undefined && kind !== 'dialog') {
    if (typeof spec.text !== 'string' || spec.text.length > MAX_TYPED_CHARS) return `text is a string of at most ${MAX_TYPED_CHARS} characters.`;
    if (action?.type !== 'fill') return 'text goes with a fill action ("fill ... with text"); passwords and secrets never (use fill_secret).';
  }
  if (action?.type === 'fill' && spec.text === undefined && !spec.hover && kind !== 'key') return `${action.id} is a fill: give the text to type.`;
  if (spec.submit !== undefined && spec.submit !== false
    && !(spec.fills || ['fill', 'fill_supplied_text'].includes(action?.type))) return 'submit goes with typed text (text or fills).';
  if (spec.hover && (!action || action.target === undefined || kind)) return 'hover takes the actionId of an offered control.';
  if (spec.file !== undefined && action?.type !== 'upload') return 'file goes with an upload action.';
  if (action?.type === 'upload' && spec.file === undefined) return `${action.id} is an upload: give the file.`;
  if (revisionless && action && (action.needsApproval || ['fill_secret', 'copy_secret'].includes(action.type))) {
    return `revision is required for ${action.id}: the user approves it on the page they saw.`;
  }
  return null;
}

/** The trusted one-line echo of what ran: never a typed value (its length instead). Labels are page text. */
function didLine(action) {
  const label = JSON.stringify(String(action.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 80));
  switch (action.type) {
    case 'fill': return `fill ${label} (${String(action.text ?? '').length} chars)`;
    case 'fill_supplied_text': return `fill ${label} with supplied ${action.suppliedName}`;
    case 'submit_field': return `press Enter in ${label}`;
    case 'click': return `click ${label}`;
    case 'select': return `select ${JSON.stringify(String(action.optionLabel ?? action.value ?? ''))} in ${label}`;
    case 'navigate_allowed_url': return `open ${action.url}`;
    case 'open_tab': return `open task tab ${action.url}`;
    case 'history': return `go ${action.move}`;
    case 'press': return action.target !== undefined ? `press ${action.key} in ${JSON.stringify(String(action.label ?? '').replace(/^press \S+ in /, '').slice(0, 80))}` : `press ${action.key}`;
    case 'hover': return `hover ${label}`;
    case 'switch_tab': return `switch to tab ${action.tab}`;
    case 'dialog': return `${action.answer} the dialog`;
    case 'upload': return `upload ${JSON.stringify(action.file?.name ?? '')} (${action.file?.size ?? 0} bytes) to ${label}`;
    default: return String(action.type);
  }
}

export class BrowserRuntime {
  constructor({ bridge, provider, asks } = {}) {
    if (!bridge) throw new TypeError('A browser bridge is required');
    this.bridge = bridge;
    this.provider = provider;
    // The Approve gate's asks the extension reported (a function: the daemon's latest), so offers say "(asks the
    // user)" only for what the extension will ask about.
    this.asks = typeof asks === 'function' ? asks : () => APPROVAL_ASKS;
    this.active = null;
    // Actions offered by observe(), keyed by revision, so act() can validate host choices.
    this.offers = new Map();
    // Values filled into password inputs on this runtime (sign_in): redacted from every later result too.
    this.secrets = new Set();
    // Secret placeholder numbers for this runtime (one tab lease): page tags and values the daemon's own pass finds.
    this.secretIds = secretIds();
  }

  /** Pause the active run. It ends as needs_user/paused; the user resumes by starting a fresh run. */
  pause() {
    this.interrupt('paused');
  }

  /** Stop the active run. It ends as stopped. */
  stop() {
    this.interrupt('stopped');
  }

  /**
   * End the active run, step or act with the outcome for `code` (for example 'tab_changed', 'disconnected',
   * 'request_closed' or 'interrupted'). Unknown codes end it as failed. The first interrupt wins.
   */
  interrupt(code) {
    if (typeof code !== 'string' || !code) throw new TypeError('An interrupt code is required');
    this.active?.interrupt(code);
  }

  /**
   * The user's grant for this runtime's tab dropped to `level` (the daemon calls this when the extension revokes
   * testing mid-session). The active run, step or act continues at the lower level; offers made above it are
   * dropped, so act() needs a fresh observe(). Never raises anything.
   */
  lowerGrant(level) {
    if (!isLevel(level)) throw new TypeError('level must be a level');
    this.grantCeiling = this.grantCeiling && levelRank(this.grantCeiling) < levelRank(level) ? this.grantCeiling : level;
    for (const [revision, offer] of this.offers) {
      if (levelRank(offer.config.level) > levelRank(level)) this.offers.delete(revision);
    }
    if (this.lastOffer && levelRank(this.lastOffer.config.level) > levelRank(level)) this.lastOffer = null;
    this.active?.lowerGrant(level);
  }

  step(instruction, options = {}) {
    return this.#drive(instruction, options, true);
  }

  run(instruction, options = {}) {
    return this.#drive(instruction, options, false);
  }

  /**
   * Host-driven control: return the compact page and the actions the host may pass to act(). `actions` holds every
   * offered action (act() resolves any of them); `offer` is the listing a host is shown: `{cap, listed, dropped}`, at
   * most offerCap(level) control actions (40 at read-only and reversible, 80 from interactive up) plus the page
   * actions, the most relevant to the optional `instruction`, `answerQuestion` and `expectation` when there are more
   * (src/relevance.js capOffer). `observation.warnings` carries `controls_capped:<n>` whenever anything was left out
   * (the page script's 100-control cap, MAX_OFFERED or the listing).
   */
  async observe(options = {}) {
    const config = configure(options, { step: true });
    const instruction = typeof options.instruction === 'string' && options.instruction.trim() ? options.instruction : null;
    const session = this.#open(config, instruction);
    // Dev logs (console errors, failed requests) are read only on a Test site; elsewhere the observe says so.
    const logs = options.logs === true;
    session.wantLogs = logs && config.level === 'testing';
    try {
      const observation = await session.observe();
      session.resolveOrigins(observation);
      // The digest is ranked by the task the host named (its question, else its instruction), which an act on this
      // offer keeps for the page it lands on; `focus` ranks this observe's digest only, `digestChars` widens it.
      const question = session.question();
      const { offer, actions, listing } = this.#offerOn(observation, config, session.hints, question);
      const focus = typeof options.focus === 'string' && options.focus.trim() ? options.focus : null;
      const maxChars = Number.isInteger(options.digestChars) && options.digestChars > DIGEST_MAX_CHARS
        ? options.digestChars : DIGEST_MAX_CHARS;
      const built = buildDigest(observation, focus ?? question, {
        maxChars, maxBlocks: Math.max(DIGEST_MAX_BLOCKS, Math.round(DIGEST_MAX_BLOCKS * maxChars / DIGEST_MAX_CHARS)),
      });
      const capped = cappedWarning(observation, offer.dropped + listing.dropped);
      const warnings = [...(Array.isArray(observation.warnings) ? observation.warnings : [])
        .filter(code => typeof code === 'string' && code !== 'controls_capped')
        .flatMap(code => (code === 'unreadable_region' ? unreadableWarnings(observation) : [code])), ...(capped ? [capped] : [])];
      if (logs && !session.wantLogs) warnings.push('logs_need_testing');
      return redactSecrets({
        observation: { ...compactForDecision(observation), warnings, consent: observation.consent ?? null,
          ...(observation.records ? { records: observation.records, recordLists: observation.recordLists,
            recordsTruncated: observation.recordsTruncated === true,
            ...(observation.recordState ? { recordState: observation.recordState } : {}) } : {}),
          ...(observation.overlay ? { overlay: observation.overlay } : {}),
          // Logs only when asked for on a Test site, a dialog only on a Test site (the hook exists only there).
          ...pageExtras({ tabs: observation.tabs, frames: observation.frames, ...(config.level === 'testing' ? { dialog: observation.dialog } : {}),
            ...(session.wantLogs ? { logs: observation.logs ?? [], logsDropped: observation.logsDropped } : {}) }) },
        actions: actions.map(action => ({ ...action })),
        offer: { cap: listing.cap, listed: listing.actions.map(action => action.id), dropped: listing.dropped },
        digest: built.digest,
        digestTruncated: built.truncated || observation.textTruncated === true || observation.blocksTruncated === true,
      }, [...this.secrets]);
    } finally {
      clearTimeout(session.timeoutTimer);
      this.active = null;
    }
  }

  /**
   * Host-driven control: execute one action offered by observe(). Authority (mode, origins, supplied text) is
   * fixed by the observe() call; act() options may add an expectation, capture policy, timeout and callback.
   */
  async act(choice, options = {}) {
    // An action id (a string), or `{ actionId?, point?, text?, submit?, fills?, hover?, key?, url?, nav?, tab?,
    // dialog?, file? }` (checkActChoice). A point is pixels of the screenshot of the offer's revision.
    const spec = actChoice(choice);
    const point = spec.point;
    const actionId = spec.actionId ?? null;
    const composedKind = ['url', 'openTab', 'nav', 'tab', 'dialog', 'fills', 'key'].some(key => spec[key] !== undefined);
    if (point !== undefined ? !(point && typeof point === 'object' && Number.isFinite(point.x) && Number.isFinite(point.y))
      : !(typeof actionId === 'string' && actionId) && !composedKind) {
      throw new TypeError('An action id or a point {x, y} is required');
    }
    const offer = options.revision !== undefined ? this.offers.get(options.revision) : this.lastOffer;
    if (!offer) {
      throw new Error(this.grantCeiling
        ? `Unknown revision; the user lowered the level to ${this.grantCeiling}: call observe() again`
        : 'Unknown revision: revisions are single-use; use the latest act or observe result, or call observe() first');
    }
    // Without a revision (the daemon resolves the host's latest offer and says so): re-resolved if the page moved,
    // within #sameControlOn's rules. A direct runtime call without a revision keeps the strict stale rules.
    const revisionless = options.revisionless === true;
    const problem = checkActChoice(offer, spec, { revisionless });
    if (problem) throw new Error(problem);
    let action = actionId !== null && !spec.fills ? offer.actions.find(candidate => candidate.id === actionId) : null;
    if (point && typeof this.bridge.locate !== 'function') throw new Error('This bridge cannot locate a point');
    // The host's text rides on its own copy of the offered fill (the offer itself never holds it), as an upload's file.
    if (action && typeof spec.text === 'string') action = { ...action, text: spec.text };
    if (action?.type === 'upload' && spec.file) action = { ...action, file: spec.file };

    const config = configure({
      ...options,
      mode: offer.config.permissions.requested,
      grant: offer.config.grant,
      allowedOrigins: offer.config.allowedOrigins,
      allowedUrls: offer.config.allowedUrls,
      suppliedText: offer.config.suppliedText,
      guardrails: offer.config.guardrails,
      policy: undefined,
    }, { step: true });
    // The Approve gate: a gated action first asks the user in the extension (approval waits are outside the act's
    // time budget). `approval` is the extension's answer; an approved one carries the id it minted for this click.
    // A point on a gated control (resolved below) asks the same way, bound to the control's id.
    let approval = null;
    let approvalMs = 0;
    const ask = async gated => {
      const askedAt = Date.now();
      try {
        approval = await this.#askApproval(gated, offer, options);
      } finally {
        approvalMs += Date.now() - askedAt;
      }
      if (approval.decision === 'approved' && typeof approval.approvalId === 'string') return { ...gated, approvalId: approval.approvalId };
      // The user turned off asking before credential actions: the click runs as an ordinary one (never a secret use).
      if (approval.decision === 'off' && gated.needsApproval === 'secret' && gated.type === 'click') approval = null;
      return gated;
    };
    if (action?.needsApproval && !spec.hover) action = await ask(action);
    // Accepting a JavaScript dialog whose text names a delete or a purchase (Test site): the user approves it first.
    if (spec.dialog === 'accept' && config.level === 'testing' && typeof this.bridge.approve === 'function') {
      const seen = offer.observation?.dialog;
      const cls = seen ? labelClasses(String(seen.text ?? '')).find(item => item === 'delete' || item === 'purchase') : null;
      if (cls) {
        action = await ask({ type: 'dialog', answer: 'accept', label: clip(String(seen.text ?? ''), 120), needsApproval: cls,
          ...(typeof spec.text === 'string' ? { text: spec.text } : {}) });
      }
    }
    let pointGated = null;
    let located = null;
    if (point && typeof this.bridge.approve === 'function') {
      // A point on an offered gated control: located first (no session yet, nothing runs), then asked like an id.
      // Anything else keeps what was located for #resolvePoint, which reports it inside the act's session.
      const gate = await this.#pointGate(offer, config, point, options);
      if (gate?.gated) {
        pointGated = gate.gated;
        action = await ask(pointGated.action);
      } else {
        located = gate?.located ?? null;
      }
    }
    const session = this.#open(config, null);
    // Waiting for the user's Approve click is not the agent's time: the receipt says how long it took, and the MCP
    // server does not charge it to the request's time budget.
    if (approvalMs) session.result.approvalMs = approvalMs;
    // The landing page's digest is ranked by the task the host named on the observe behind this offer.
    if (offer.question) session.callQuestion = offer.question;
    // One action per offer: once it runs, the revision is spent (a pending approval keeps it for the same act again).
    const pending = approval?.decision === 'pending';
    if (!pending) {
      this.offers.delete(offer.revision);
      if (this.lastOffer === offer) this.lastOffer = null;
    }
    try {
      const before = offer.observation;
      session.initial = before;
      session.result.observation = before;
      if (approval && !action.approvalId) {
        approvalOutcome(session, action, offer, approval);
        return session.result;
      }
      const started = Date.now();
      // The purchase guard on host-driven control, as for a run's own choice (below testing, with controls): the
      // provider is asked about the button, select or fill the host picked before it runs. A guard at the veto
      // refuses it; a failed provider call fails the act (nothing is dispatched). Without a provider, or with a
      // custom one that reports no guards, only the mechanical checks apply (they already shaped the offer).
      // An ambiguous refused control the offer carried (the intent question) runs only when this guard request clears
      // it (Session.intentGate); without a provider it is refused. hostGuard returns `{ result }` or `{ action }`.
      const hostGuard = async (page, chosen) => {
        if (!this.provider || !commitCandidate(chosen) || config.level === 'testing' || !config.capabilities.has('controls')) {
          return chosen?.intent ? { result: session.intentKept(chosen, { kept: 'unanswered' }) } : { action: chosen };
        }
        const offered = [{ ...chosen }, { id: 'handoff', type: 'handoff', description: 'None of these: stop here' }];
        const label = chosen.description ?? chosen.label ?? chosen.type;
        const decision = await session.decide(page, offered, [], `The host chose this control: ${label}`, 'guard');
        const guards = guardsOf(decision);
        if (guards) session.noteGuards(guards);
        if (session.purchaseHigh(decision)) return { result: session.purchaseVeto(chosen) };
        if (session.commitHigh(decision)) return { result: session.commitVeto(chosen) };
        return chosen.intent ? session.intentGate(decision, chosen, page) : { action: chosen };
      };
      let decision = { by: 'host', actionId };
      // A refusal of a composed act keeps the host going: the page it ends on, with its actions and revision.
      const offerAgain = page => {
        session.result.observation = page;
        session.result.offer = this.#offerAfter(session, config, page, offer.hints, offer.question);
        return session.result;
      };
      // What runs: one action, or several in a row (a batch of fills, a fill and its Enter), each on the page the one
      // before it left. A host-composed act (a URL, a history move, a key, a tab, a dialog answer) is built here.
      let plan;
      if (pointGated) {
        // A point the user approved (or that waits for them) on an offered gated control: the click runs by its id.
        session.result.point = pointGated.point;
        session.why('act:point_approved');
        decision = pointGated.decision;
        plan = [{ action }];
      } else if (point) {
        // A point click: at least reversible, inside the image, on a control the page script finds under it, through
        // the same gate as an offered action, and then the same guards. Nothing is typed.
        const resolved = await this.#resolvePoint(session, offer, config, point, located);
        if (resolved.result) return resolved.result;
        ({ action, decision } = resolved);
        plan = [{ action }];
      } else {
        const composed = this.#compose(session, spec, offer, config, action);
        // Refused before anything ran: the page is the one the host saw, offered again (its revision stays usable).
        if (composed.result) return offerAgain(before);
        plan = composed.plan;
      }
      session.result.did = [];
      // Re-resolving a choice on a page the host has not seen: only for an act without a revision, or a later step
      // of a batch (never a point, an approved click or a secret use).
      const loose = revisionless;
      let page = before;
      let base = offer;
      let executed = null;
      for (const [index, entry] of plan.entries()) {
        let next = entry.action;
        if (entry.submitFor) {
          const submit = this.#submitOn(session, config, base, page, entry.submitFor);
          if (submit.result) return offerAgain(page);
          next = submit.action;
        } else if (index > 0 && page.revision !== base.revision) {
          const again = this.#sameControlOn(next, base, page);
          if (!again) {
            setOutcome(session.result, 'stale');
            session.why('act:batch_stale');
            return session.result;
          }
          ({ action: next, offer: base } = again);
        }
        // The user approved this very click: no model guard second-guesses them.
        const guarded = next.approvalId ? { action: next } : await hostGuard(page, next);
        if (guarded.result) return guarded.result;
        next = guarded.action;
        const stepDecision = index === 0 ? decision : { by: 'host', actionId: next.id, batch: index };
        try {
          executed = await session.execute(next, page, stepDecision, started, 0);
        } catch (error) {
          // The page changed after the offer (a late update from the previous click): look again, and run the same
          // control when exactly one offered action on the fresh page matches it (staleControl; for an act without a
          // revision or a batch step, any plain control whose label and class are unchanged), after the guards judged
          // it again on that page. Otherwise stale. A point click is never re-resolved (its coordinates were read off
          // the stale page), nor an approved click (bound to the revision the user saw), nor a field submission.
          if (error?.code !== 'stale' || point || next.approvalId) throw error;
          const fresh = await session.observe();
          session.visit(fresh);
          let again = staleControl(next, base, fresh);
          if (!again && next.type !== 'submit_field' && (loose || index > 0)) {
            again = this.#sameControlOn(next, base, fresh)?.action ?? null;
          }
          if (!again) throw error;
          if (typeof next.text === 'string' && again.text === undefined) again = { ...again, text: next.text };
          const reguarded = await hostGuard(fresh, again);
          if (reguarded.result) return reguarded.result;
          again = reguarded.action;
          session.why('act:stale_reresolve');
          // The host chose from a page it has not seen since: its observation is out of date, and the receipt says so.
          session.warn('act_reresolved');
          executed = await session.execute(again, fresh, { by: 'host', actionId, reresolved: again.id, reason: 'stale_reresolve' },
            started, 0);
          next = again;
        }
        session.result.did.push(didLine(next));
        page = executed.observation;
        if (!allowedOrigin(page.url, config.allowedOrigins) || executed.step.fill?.kept === false) break;
      }
      const after = executed.observation;
      if (!allowedOrigin(after.url, config.allowedOrigins)) setOutcome(session.result, 'cross_origin');
      else {
        if (executed.step.fill?.kept === false) {
          // The field did not keep the value: not a step done, whatever the expectation says of the page.
          session.why('fill:not_kept');
          setOutcome(session.result, 'fill_not_kept');
        } else if (errorPageOf(after)?.source === 'browser') {
          // The browser's own error page (nothing on it to read): error_page, as a run's landing on an HTTP error
          // page, before any expectation (its URL and fixed text would pass one falsely). The offer stays, so the host
          // can still reload or open another approved URL once the site is back.
          await session.errorPage(after, false);
        } else if (await session.checkExpectation(after)) setOutcome(session.result, 'expectation_passed');
        else setOutcome(session.result, 'step_complete');
        // What the host may do next from here, without another observe(); listed by the task its observe() named.
        session.result.offer = this.#offerAfter(session, config, after, offer.hints, offer.question);
      }
    } catch (error) {
      session.fail(error);
    } finally {
      await session.close();
      this.active = null;
    }
    return session.result;
  }

  /**
   * A host-composed act as the plan of actions to run (`{ plan: [{ action } | { submitFor }] }`), or the refusal it
   * ends with (`{ result }`): fills with host or supplied text (one, or a batch, then Enter when `submit`), a hover,
   * a key, a URL on the granted origins, a history move, another tab of the lease or a JS dialog's answer. Levels: a URL,
   * a history move and a tab switch are navigation (read-only); a hover, a key and a fill need controls (reversible);
   * a shortcut with Ctrl or Cmd needs full; a dialog answer testing. The page script checks each again.
   */
  #compose(session, spec, offer, config, action) {
    const result = session.result;
    const before = offer.observation;
    const need = level => {
      setOutcome(result, 'refused_action');
      session.needLevel(level);
      return { result };
    };
    const controls = config.capabilities.has('controls');
    if (spec.fills) {
      if (!controls) return need('reversible');
      const plan = spec.fills.map(fill => ({ action: { ...offer.actions.find(candidate => candidate.id === fill.actionId), text: fill.text } }));
      if (spec.submit) plan.push({ submitFor: plan.at(-1).action });
      return { plan };
    }
    if (spec.url !== undefined || spec.openTab !== undefined) {
      if (spec.openTab !== undefined && config.grant?.tabMode !== 'multiple') {
        setOutcome(result, 'refused_action');
        result.needs.message = 'This request allows one task tab. Choose Multiple task tabs and approve a new request to open another.';
        return { result };
      }
      let target;
      try {
        target = new URL(spec.openTab ?? spec.url, before.url);
      } catch {
        target = null;
      }
      if (!target || !['https:', 'http:'].includes(target.protocol)) {
        setOutcome(result, 'refused_action');
        result.needs.message = 'Only an http(s) URL on the approved origins can be opened.';
        session.why('url:scheme');
        return { result };
      }
      if (!sameSite(before.url, target.href, config.allowedOrigins)) {
        setOutcome(result, 'cross_origin');
        result.needs.message = `${target.origin} is not covered by this request. If the task needs it, request the tab `
          + `again with ${target.origin} added to origins (fai_browser_open with the requestId).`;
        session.why(`url:${target.origin}`);
        return { result };
      }
      if (urlHopRefused(target.href, config.guardrails)) {
        setOutcome(result, 'refused_action');
        result.needs.message = 'This URL names an action (sign-out, delete, payment and the like) that FAI Browser does '
          + 'not open directly. Use the page\'s own control, or tell the user.';
        session.why('url:refused');
        return { result };
      }
      return { plan: [{ action: { type: spec.openTab !== undefined ? 'open_tab' : 'navigate_allowed_url', url: target.href, label: target.href, composed: true } }] };
    }
    if (spec.nav !== undefined) return { plan: [{ action: { type: 'history', move: spec.nav, label: `go ${spec.nav}` } }] };
    if (spec.tab !== undefined) {
      if (config.grant?.tabMode !== 'multiple') {
        setOutcome(result, 'refused_action');
        result.needs.message = 'This request allows one task tab; switching task tabs requires Multiple task tabs approval.';
        return { result };
      }
      return { plan: [{ action: { type: 'switch_tab', tab: spec.tab, label: `tab ${spec.tab}` } }] };
    }
    if (spec.dialog !== undefined) {
      if (config.level !== 'testing') {
        setOutcome(result, 'refused_action');
        result.needs.message = 'JavaScript dialogs are answered by FAI Browser only on a Test site; ask the user to answer '
          + 'it in the tab, then observe.';
        session.why('dialog:level');
        return { result };
      }
      // An accept the user approved (act(), above) carries its approval id.
      if (action?.type === 'dialog') return { plan: [{ action: { ...action, label: `${action.answer} the dialog` } }] };
      const dialog = { type: 'dialog', answer: spec.dialog, label: `${spec.dialog} the dialog` };
      if (typeof spec.text === 'string') dialog.text = spec.text;
      return { plan: [{ action: dialog }] };
    }
    if (spec.key !== undefined) {
      const key = pressKey(spec.key);
      if (key.modifier && levelRank(config.level) < levelRank('full')) return need('full');
      if (!controls) return need('reversible');
      if (key.key === 'Enter') {
        // Enter submits: only as the field's own "press Enter in" action, gated as the submit it is.
        return { plan: [{ submitFor: action }] };
      }
      const press = { type: 'press', key: key.wire, label: `press ${key.wire}` };
      if (action?.target !== undefined) Object.assign(press, { target: action.target, role: action.role, label: `press ${key.wire} in ${action.label}` });
      return { plan: [{ action: press }] };
    }
    if (spec.hover) {
      if (!controls) return need('reversible');
      return { plan: [{ action: { type: 'hover', target: action.target, role: action.role, label: action.label } }] };
    }
    if (action.type === 'fill' && !controls) return need('reversible');
    const plan = [{ action }];
    if (spec.submit) plan.push({ submitFor: action });
    return { plan };
  }

  /**
   * The same control as `action` (offered on `base`) on the page `fresh`: `{ action, offer }` (that page's matching
   * offered action and its offer) when exactly one offered action there has the same type, role, label, value and
   * destination and its control the same risk class, on the same origin and path; else null. Never an action the
   * user approves, a secret use or a point.
   */
  #sameControlOn(action, base, fresh) {
    if (!action || !fresh || action.needsApproval || action.point || ['fill_secret', 'copy_secret'].includes(action.type)) return null;
    if (['scroll', 'wait', 'history', 'switch_tab', 'dialog'].includes(action.type) || action.composed) {
      return { action, offer: { revision: fresh.revision, observation: fresh, actions: [], config: base.config, flags: base.flags } };
    }
    try {
      const was = new URL(base.observation.url);
      const now = new URL(fresh.url);
      if (was.origin !== now.origin || was.pathname !== now.pathname) return null;
    } catch {
      return null;
    }
    // Never across a dialog that appeared, never a control whose label names a class (delete, submit, purchase, ...),
    // and a click (not a link) only while the page reads the same: "Next" on the next wizard step, "OK" on another
    // dialog stay stale.
    if (consentOf(fresh)) return null;
    if (labelSpellings(action.label).length && labelClasses(action.label).length) return null;
    const link = action.type === 'click' && action.role === 'link';
    if (action.type === 'click' && !link && (fresh.title !== base.observation.title || fresh.text !== base.observation.text)) return null;
    const actions = offeredActions(fresh, { ...base.config, ...(base.flags ?? {}) }).actions;
    const fields = ['type', 'role', 'label', 'value', 'suppliedName', 'url', 'href', 'direction', 'optionLabel', 'newTab', 'key'];
    const riskOn = (page, target) => page.controls?.find(control => String(control.id) === String(target))?.risk ?? null;
    const same = candidate => fields.every(field => candidate[field] === action[field])
      && Boolean(candidate.opens) === Boolean(action.opens) && !candidate.needsApproval;
    let matches = actions.filter(candidate => same(candidate)
      && (action.target === undefined || riskOn(fresh, candidate.target) === riskOn(base.observation, action.target)));
    // As many as there were: a row removed or added makes "the same" one ambiguous.
    if (Array.isArray(base.actions) && base.actions.length && matches.length !== base.actions.filter(same).length) return null;
    if (action.target !== undefined) {
      const near = neighbourLabels(base.observation, action.target);
      matches = matches.filter(candidate => {
        const there = neighbourLabels(fresh, candidate.target);
        return !near || (there && near[0] === there[0] && near[1] === there[1]);
      });
    }
    if (matches.length !== 1) return null;
    const found = typeof action.text === 'string' ? { ...matches[0], text: action.text } : matches[0];
    return { action: found, offer: { revision: fresh.revision, observation: fresh, actions, config: base.config, flags: base.flags } };
  }

  /**
   * Enter in the field `fill` named, on `page`: `{ action }` (the field's offered "press Enter in" there), or the
   * refusal (`{ result }`): the level its form submit needs, a sign-in or purchase form, or a field Enter does not
   * submit (click the form's own button instead).
   */
  #submitOn(session, config, base, page, fill) {
    const result = session.result;
    const flags = base.flags ?? {};
    const actions = offeredActions(page, { ...config, ...flags, enterSubmit: true }).actions;
    let target = fill?.target;
    // The field on this page: the same id when the page is the one the fill was offered on, else the same label.
    if (page.revision !== base.revision && fill) {
      const same = actions.filter(candidate => candidate.target !== undefined && candidate.label === fill.label && candidate.role === fill.role
        && (candidate.type === 'fill' || candidate.type === 'submit_field' || candidate.type === 'fill_supplied_text'));
      const targets = [...new Set(same.map(candidate => String(candidate.target)))];
      target = targets.length === 1 ? targets[0] : targets.includes(String(fill.target)) ? String(fill.target) : null;
    }
    const submit = target === undefined || target === null ? null
      : actions.find(candidate => candidate.type === 'submit_field' && String(candidate.target) === String(target));
    if (submit) return { action: submit };
    const control = (page.controls ?? []).find(candidate => String(candidate.id) === String(target));
    const needed = control ? enterCapability(control, pageFacts(page)) : null;
    if (needed === 'sign_in' || needed === 'purchase') {
      session.refuse(needed, [{ control, kind: needed, capability: needed }]);
      return { result };
    }
    if (needed && !policyOf(config).allows(needed)) {
      setOutcome(result, 'refused_action');
      session.needLevel(levelFor(needed));
      session.why('submit:level');
      return { result };
    }
    setOutcome(result, 'refused_action');
    result.needs.message = 'Enter does not submit this field (it is not filled, or not in a form FAI Browser can '
      + 'classify). Click the form\'s own submit button instead.';
    session.why('submit:none');
    return { result };
  }

  /**
   * The Approve gate's question for one offered action (bridge.approve): the extension shows the control's label (read
   * from the page itself), the class and the agent's `reason`, and waits up to `approvalWaitMs` (default 60 s, at
   * most 120 s) for the user's click. Returns the extension's answer ({ decision, approvalId? }), or { decision:
   * 'unavailable' } for a bridge that cannot ask and { decision: 'error', code } when the ask failed. stop(), pause()
   * and the caller's signal end the wait.
   */
  async #askApproval(action, offer, options) {
    if (typeof this.bridge.approve !== 'function') return { decision: 'unavailable' };
    if (this.active) throw new Error('A browser run is already active');
    const controller = new AbortController();
    this.active = {
      interrupt: code => controller.abort(bridgeError(code, outcomeFor(code).reason, false)),
      lowerGrant: () => controller.abort(bridgeError('stale', 'The level changed', false)),
    };
    const waitMs = Number.isFinite(options.approvalWaitMs) ? Math.max(0, Math.min(options.approvalWaitMs, 120_000)) : 60_000;
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    try {
      const secretUse = action.type === 'fill_secret' || action.type === 'copy_secret';
      const answer = await this.bridge.approve({
        target: action.target,
        revision: offer.revision,
        cls: action.needsApproval,
        note: typeof options.reason === 'string' ? options.reason.slice(0, 200) : undefined,
        waitMs,
        ...(secretUse ? { kind: action.type, handle: action.handle } : {}),
        ...(action.type === 'dialog' ? { kind: 'dialog' } : {}),
        ...(action.type === 'upload' ? { kind: 'upload', file: { name: action.file?.name, size: action.file?.size } } : {}),
      }, { level: offer.config.level }, signal);
      return answer && typeof answer === 'object' && typeof answer.decision === 'string' ? answer : { decision: 'error', code: 'unsupported' };
    } catch (error) {
      return { decision: 'error', code: isKnownCode(error?.code) ? error.code : 'failed', message: String(error?.message ?? error) };
    } finally {
      this.active = null;
    }
  }

  /**
   * A point on an offered control that asks the user (needsApproval): `{ action, point, decision }` (the offered action,
   * the receipt's point block and the step decision), or null for anything else (resolved by #resolvePoint as before,
   * inside the act's session). Below reversible, off the image or when locate fails: null too, and #resolvePoint
   * reports it. Nothing runs here; the approval binds to the control's id, never to pixels.
   */
  async #pointGate(offer, config, point, options) {
    if (levelRank(config.level) < levelRank('reversible') || typeof this.bridge.locate !== 'function') return null;
    const mapped = mapPoint(offer, point);
    if (!mapped) return null;
    if (this.active) throw new Error('A browser run is already active');
    const { forbid, level } = config.guardrails.wire();
    let found;
    try {
      found = scrubSecrets(await this.bridge.locate(mapped.css, offer.revision, forbid ? { forbid, level } : { level },
        options.signal), this.secretIds);
    } catch (error) {
      return { located: { error } };
    }
    const id = typeof found?.id === 'string' ? found.id : null;
    const gated = id === null || !found?.control ? null
      : offer.actions.find(action => action.type === 'click' && action.needsApproval && String(action.target) === id);
    if (!gated) return { located: { found } };
    const label = clip(gated.label, 120);
    return { gated: {
      action: gated,
      point: { image: mapped.image, css: mapped.css, scale: mapped.scale, imageSize: mapped.imageSize, control: { ref: id, label, offered: true } },
      decision: { by: 'host', actionId: gated.id, point: { image: mapped.image, css: mapped.css }, resolved: { ref: id, label, offered: true } },
    } };
  }

  /**
   * act() with a point: maps the screenshot pixels to the page (mapPoint), asks the page script what is under them
   * (bridge.locate, on the offer's revision only) and classifies it (pointAction). Returns `{ action, decision }` to
   * run, or `{ result }` when the act ends here: refused_action with needs.level reversible below reversible,
   * point_outside off the image, the locate error's code (stale, no_control, point_outside, point_frame), or the
   * gate's refusal (purchase, forbid, a level request, cross_origin, target_unavailable). The receipt's `why` says
   * `point:<reason>`; the step's decision records the point, the control it resolved to and whether it was offered.
   */
  async #resolvePoint(session, offer, config, point, located = null) {
    const result = session.result;
    const refuse = (code, why, detail) => {
      setOutcome(result, code, detail);
      session.why(why);
      return { result };
    };
    if (levelRank(config.level) < levelRank('reversible')) {
      setOutcome(result, 'refused_action');
      session.needLevel('reversible');
      session.why('point:level');
      return { result };
    }
    const mapped = mapPoint(offer, point);
    if (!mapped) return refuse('point_outside', 'point:off_image');
    result.point = { image: mapped.image, css: mapped.css, scale: mapped.scale, imageSize: mapped.imageSize };
    const { forbid, level } = config.guardrails.wire();
    const locateOptions = forbid ? { forbid, level } : { level };
    let found;
    try {
      // `located`: the page script already answered before the act's session (#pointGate).
      if (located?.error) throw located.error;
      found = located?.found ?? scrubSecrets(await session.bounded(() => this.bridge.locate(mapped.css, offer.revision, locateOptions,
        session.signal)), this.secretIds);
    } catch (error) {
      session.why(`point:${isKnownCode(error?.code) ? error.code : 'failed'}`);
      throw error;
    }
    if (!found?.control || typeof found.control !== 'object') return refuse('no_control', 'point:no_control');
    const id = typeof found.id === 'string' ? found.id : null;
    const resolved = pointAction(offer, { id, control: found.control }, { ...config, point: mapped.css });
    const control = resolved.control;
    const ref = id ?? 'point';
    result.point.control = { ref, label: clip(control.label, 120), offered: resolved.offered === true };
    if (resolved.refusal) {
      const { kind, capability } = resolved.refusal;
      if (kind === 'unavailable') return refuse('target_unavailable', 'point:unavailable');
      if (kind === 'cross_origin') return refuse('cross_origin', 'point:cross_origin');
      if (kind === 'level') {
        setOutcome(result, 'refused_action');
        session.needLevel('reversible');
        session.why('point:level');
        return { result };
      }
      session.refuse(kind, [{ control, kind, capability }]);
      result.needs.control = { ref, label: clip(control.label, 120) };
      session.why(`point:${kind}`);
      return { result };
    }
    session.why(resolved.offered ? 'act:point_offered' : 'act:point');
    const decision = {
      by: 'host',
      actionId: resolved.action.id,
      point: { image: mapped.image, css: mapped.css },
      resolved: { ref, label: clip(control.label, 120), offered: resolved.offered },
    };
    return { action: resolved.action, decision };
  }

  /**
   * The actions offered on `observation` under `config`, remembered by revision so act() can run one, and the listing
   * a host is shown (capOffer: at most offerCap(level) control actions, the most relevant to `hints`; scroll, wait,
   * allowed URLs and the consent dialog's buttons always listed). Shared by observe() and an act() landing page.
   */
  #offerOn(observation, config, hints, question = null) {
    // The intent switch: ambiguous refused controls are listed too; act() runs one only when its guard request clears it.
    const intent = this.provider?.guidance?.intent === true && config.level !== 'testing';
    // Host-driven offers also press Enter in a filled field (a search box), gated like the form submit it is.
    // The Approve gate: gated controls are offered (marked needsApproval) when the bridge can ask the user.
    const approvals = typeof this.bridge.approve === 'function' && levelRank(config.level) >= levelRank('reversible')
      ? cleanAsks(this.asks()) : false;
    // Host-driven offers also take fills of the host's own text (agentText).
    const flags = { intent, enterSubmit: true, approvals, agentText: true };
    const offer = offeredActions(observation, { ...config, hints, ...flags });
    const actions = offer.actions.filter(action => !['done', 'handoff'].includes(action.type));
    // `hints` (the task the host named on its observe) rank the listing of the page an act() on this offer lands on;
    // `question` ranks its digest.
    this.#remember({ revision: observation.revision, observation, actions, config, hints, question: question || null, flags });
    const consentTargets = new Set((observation.consent?.buttons ?? [])
      .filter(button => button?.id !== undefined && button.id !== null).map(button => String(button.id)));
    const listing = capOffer(actions, config.level, hints,
      action => action.target !== undefined && consentTargets.has(String(action.target)));
    return { offer, actions, listing };
  }

  /**
   * After a host act(): the next offered actions on the page it landed on, as the result's `offer` ({revision,
   * actions, listed, cap, dropped}; agentResult lists `listed` as `actions` with `moreActions`), so a host driving
   * step by step needs one call per step: the next act() may name this revision without an observe() in between.
   */
  #offerAfter(session, config, observation, hints, question) {
    const { offer, actions, listing } = this.#offerOn(observation, config, hints ?? session.hints, question);
    session.noteCapped(observation, offer.dropped + listing.dropped);
    return {
      revision: observation.revision,
      actions: actions.map(action => ({ ...action })),
      listed: listing.actions.map(action => action.id),
      cap: listing.cap,
      dropped: offer.dropped + listing.dropped,
    };
  }

  #remember(offer) {
    this.offers.delete(offer.revision);
    this.offers.set(offer.revision, offer);
    while (this.offers.size > OFFER_CACHE_SIZE) this.offers.delete(this.offers.keys().next().value);
    this.lastOffer = offer;
  }

  /**
   * The size of the screenshot served for an offer's revision (the daemon notes it after an observe capture), so a
   * point click's image pixels map back to the page. Ignored for a revision with no offer.
   */
  noteImage(revision, image) {
    const offer = this.offers.get(revision);
    if (!offer || !(image?.width > 0 && image?.height > 0)) return;
    offer.image = { width: Math.round(image.width), height: Math.round(image.height) };
  }

  #open(config, instruction) {
    if (this.active) throw new Error('A browser run is already active');
    const session = new Session(this, config, instruction);
    this.active = session;
    return session;
  }

  async #drive(instruction, options, step) {
    if (instruction && typeof instruction === 'object') {
      options = { ...instruction, ...options };
      instruction = options.instruction;
    }
    if (options.steps !== undefined && options.steps !== null) {
      if (step) throw new Error('A step list runs with run(), not step()');
      // An instruction next to steps is the task summary: checked, never sent to the provider (each step's is).
      checkSummary(instruction);
      return this.#driveList(options);
    }
    if (typeof instruction !== 'string' || !instruction.trim()) throw new Error('An instruction is required');
    if (!this.provider) throw new Error('A decision provider is required for run() and step()');
    // Long instructions (4 or more named pages) get 45 s instead of 30 s unless the caller set a timeout.
    if (options.timeoutMs === undefined && namedHops(instruction).length >= LONG_TASK_HOPS) {
      options = { ...options, timeoutMs: LONG_TASK_TIMEOUT_MS };
    }
    const config = configure(options, { step });
    // legalActions reads it to decide whether a secret supplied value may go into a non-password field.
    config.instruction = instruction;
    let session = this.#open(config, instruction);
    try {
      await this.#attempt(session);
      // In-call retry 3: the result's next step is a rerun FAI can send itself. The first session stays active
      // until the rerun opens, so a pause or stop in between still lands (and rerunPlan then sees it).
      const plan = session.rerunPlan();
      if (plan) session = await this.#rerun(session, plan, options, step);
    } finally {
      this.active = null;
    }
    return session.result;
  }

  async #attempt(session) {
    try {
      await this.#loop(session);
      await session.completeList();
    } catch (error) {
      session.fail(error);
    } finally {
      await session.close();
    }
  }

  /**
   * Run `plan` (a verdict.suggested the first attempt's next step pointed to) as a second attempt in the same call:
   * the same origins, level, grant, guardrails, supplied values and answer question, the remaining time, the shared
   * retry bounds and no further rerun. Its result is returned with both attempts merged: cost and cost.requests
   * (each entry marked with its attempt) cover both, `retries` lists the first attempt's retries, the rerun and the
   * second attempt's own, and the trace keeps the first attempt's outcome under `attempts`.
   */
  async #rerun(first, plan, options, step) {
    const prior = first.config;
    const timeoutMs = Math.max(1000, Math.floor(first.remainingMs()));
    let config;
    try {
      config = configure({
        ...options,
        instruction: undefined,
        expectation: plan.expectation,
        maxActions: plan.maxActions,
        maxDecisions: plan.maxDecisions,
        timeoutMs,
        runId: first.result.runId,
        mode: prior.permissions.requested,
        grant: prior.grant ? { level: prior.grant.level, tabMode: prior.grant.tabMode } : options.grant,
        permissions: prior.permissions,
        allowedOrigins: prior.allowedOrigins,
        guardrails: prior.guardrails,
        policy: undefined,
        retry: { ...prior.retry, rerun: false },
        [RETRY_STATE]: prior.retryState,
      }, { step });
    } catch {
      // A suggestion the options cannot carry (it never should) leaves the first attempt's result to the host.
      return first;
    }
    prior.retryState.reruns++;
    config.instruction = plan.instruction;
    config.listStep = prior.listStep === true;
    const second = new Session(this, config, plan.instruction);
    this.active = second;
    // The pages the first attempt saw feed the second's earlier-page trail and its suggestions.
    second.visited.push(...first.visited);
    // The pages carried from earlier list steps stay marked (answerPlan never aggregates a step's question over them).
    if (first.carried) second.carried = first.carried;
    // The re-run's instruction is the runtime's (with the host's question in it): only the host's URLs may hop.
    second.hopTemplate = first.hopTemplate ?? first.instruction;
    second.expectationTemplate = first.expectationTemplate ?? first.config.expectation;
    for (const text of first.persistentLoading) second.persistentLoading.add(text);
    second.why('retry:rerun');
    second.awaitLoading = plan.loading;
    second.stepBase = first.stepBase + first.result.steps.length;
    second.callQuestion = first.question();
    second.asked = first.asks();
    await this.#attempt(second);
    mergeAttempts(first, second, plan);
    return second;
  }

  /**
   * A step list (`steps`, src/steps.js): each step runs as its own attempt, in order, in the same tab, with the call's
   * origins, level, grant (lowered if the user lowered it), guardrails, supplied values and retry switches, and with
   * what is left of the call's actions, decisions and time. Each step is verified by its own expectation and may get
   * its own in-call retries. The list stops at the first step that does not complete verified (or whose page the host
   * must confirm), before a step whose placeholder has no auto-confirmed answer, or when time, actions or decisions
   * run out between steps; composeList() folds everything into one result for the stopping (or last) step.
   */
  async #driveList(options) {
    if (!this.provider) throw new Error('A decision provider is required for run() and step()');
    // A top-level expectation or question goes to the last step, or (a different expectation) is checked at the end.
    const { steps, finalExpectation, warnings: foldWarnings } = foldTopLevel(options.steps,
      { expectation: options.expectation, answerQuestion: options.answerQuestion, maxActions: 100 });
    const { steps: _steps, instruction: _instruction, expectation: _expectation, answerQuestion: _question, ...base } = options;
    const count = steps.length;
    const perStep = steps.map(spec => spec.maxActions ?? STEP_DEFAULT_ACTIONS);
    // The list's total action budget: the steps' maxActions summed, at most 60 unless the caller set it (up to 120).
    const totalActions = options.maxActions ?? listActionBudget(steps);
    const totalDecisions = options.maxDecisions ?? Math.min(200, totalActions + 3 * count);
    const timeoutMs = options.timeoutMs
      ?? (count > 1 ? listTimeoutMs(count)
        : namedHops(steps[0].instruction).length >= LONG_TASK_HOPS ? LONG_TASK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    // The call-wide options, validated once before anything runs (guardrail additions included), as for one run.
    const call = configure({ ...base, expectation: steps[0].expectation, maxActions: totalActions,
      maxDecisions: totalDecisions, timeoutMs });
    const runId = call.runId ?? randomUUID();
    const started = Date.now();
    const sessions = [];
    const filled = [];
    const values = new Map();
    const reasons = new Map();
    // Step number -> a likely (not auto-confirmed) answer a placeholder may still take at read-only and reversible;
    // the steps whose likely answer did fill a placeholder (stepResults answerSource "likely").
    const likely = new Map();
    const usedLikely = new Set();
    const referenced = new Set(steps.flatMap(spec => stepPlaceholders(spec).map(({ n }) => n)));
    let stop = null;
    let actionsUsed = 0;
    let decisionsUsed = 0;
    try {
      for (let index = 0; index < count; index++) {
        const prev = sessions.at(-1);
        if (prev) {
          // A pause, stop or cancel that arrived after the previous step closed (it is still the active session).
          if (prev.interrupted || prev.callerSignal?.aborted) {
            stop = { before: index, code: prev.interrupted ?? 'cancelled' };
            break;
          }
          if (timeoutMs - (Date.now() - started) < LIST_STEP_MIN_MS) {
            stop = { before: index, code: 'time_budget' };
            break;
          }
          if (totalActions - actionsUsed < 1) {
            stop = { before: index, code: 'action_budget' };
            break;
          }
          if (totalDecisions - decisionsUsed < 1) {
            stop = { before: index, code: 'decision_budget' };
            break;
          }
        }
        const fill = fillStep(steps[index], values, reasons, likely);
        for (const n of fill.likely ?? []) usedLikely.add(n);
        if (fill.missing) {
          stop = { before: index, code: 'placeholder_unconfirmed',
            why: fill.missing.map(({ n, why }) => `placeholder:answer:${n}:${why}`) };
          break;
        }
        const spec = fill.step;
        filled.push(spec);
        const grant = this.#listGrant(prev?.config.grant ?? call.grant);
        const config = configure({
          ...base,
          expectation: spec.expectation,
          answerQuestion: spec.answerQuestion,
          maxActions: Math.min(perStep[index], totalActions - actionsUsed),
          maxDecisions: Math.min(perStep[index] + 3, totalDecisions - decisionsUsed),
          timeoutMs: Math.max(1000, Math.floor(timeoutMs - (Date.now() - started))),
          runId,
          mode: call.permissions.requested,
          grant: grant ? { level: grant.level, tabMode: grant.tabMode } : undefined,
          permissions: call.permissions,
          allowedOrigins: call.allowedOrigins,
          guardrails: (prev?.config ?? call).guardrails,
          policy: undefined,
          // One set of retry bounds for the whole list (cap: the list's decisions + 4), and one slim.terminal memo.
          [RETRY_STATE]: call.retryState,
        });
        // The late-change waits are off only for the step that saw a wait come to nothing: a calendar Done on the day
        // already shown changes nothing, and the next step's Done on another day lands 1.5 s later (bench/long
        // flights-live-landing-calendar b broke at step 2 in every run with the wait off for the rest of the list).
        config.retryState.lateChangeOff = false;
        config.retryState.lateLookOff = false;
        config.instruction = spec.instruction;
        // A list step ends as soon as its own expectation passes after its own action (#loop, endOnPass).
        config.listStep = true;
        let session = new Session(this, config, spec.instruction);
        // The host's step text before its placeholders were filled: only its URLs may hop (urlHop).
        session.hopTemplate = steps[index].instruction;
        session.expectationTemplate = steps[index].expectation;
        this.active = session;
        session.stepBase = sessions.reduce((sum, done) => sum + done.result.steps.length, 0);
        // Earlier steps' pages feed this step's earlier-page trail (a later question may join a fact from them); they
        // are marked carried, so this step's own question never aggregates over them (answerPlan).
        if (prev) {
          session.carried = new Set(prev.visited);
          session.visited.push(...prev.visited);
        }
        // Status text an earlier step found persistent is not loading on this step's pages either.
        if (prev) for (const text of prev.persistentLoading) session.persistentLoading.add(text);
        await this.#attempt(session);
        const plan = session.rerunPlan();
        if (plan) session = await this.#rerun(session, plan, { ...base, answerQuestion: spec.answerQuestion }, false);
        sessions.push(session);
        actionsUsed += session.result.steps.length;
        decisionsUsed += session.result.cost.decisions;
        const answer = placeholderValue(session.result);
        if (answer.value !== undefined) values.set(index + 1, answer.value);
        else {
          // Below the auto-confirm floor: at read-only and reversible (the call's level), a clearly leading answer
          // may still fill a placeholder (thresholds.placeholderFloor / placeholderMargin), never confirmed for the host.
          // Only for a step a later placeholder names; a lone unranked candidate is ranked by the provider first.
          const wanted = answer.why === 'answer_not_confirmed' && spec.answerQuestion && referenced.has(index + 1);
          if (wanted && LIKELY_LEVELS.has(call.level)) await session.rankSingle(spec.answerQuestion);
          const fallback = wanted
            ? likelyValue(session.result, { question: spec.answerQuestion, instruction: spec.instruction,
              level: call.level, thresholds: session.config.thresholds })
            : answer;
          if (fallback.value !== undefined) likely.set(index + 1, fallback.value);
          else reasons.set(index + 1, fallback.why);
        }
        if (!listStepPassed(session.result)) break;
      }
    } finally {
      this.active = null;
    }
    const last = sessions.at(-1)?.result;
    // The call's own expectation is checked whenever the list reached its last step, whatever that step's outcome
    // (a blocked or still-loading page included): verification never passes without it.
    if (finalExpectation && !stop && sessions.length === count
      && !checkDeclarative(last.observation ?? {}, finalExpectation, { initial: sessions[0].initial })) {
      if (last.verification?.passed === true) {
        // The last step's own check passed, but the page is not what the host asked for: the call failed.
        const before = (last.verdict?.why ?? []).filter(code => code !== last.code);
        setOutcome(last, 'expectation_failed');
        last.verification = { ...last.verification, passed: false };
        last.verdict = buildVerdict(last, { why: [...before, 'steps:final_expectation_failed'],
          hasQuestion: Boolean(steps.at(-1).answerQuestion) });
        last.next = nextFor(last);
      } else if (last.verdict?.why) {
        last.verdict.why.push('steps:final_expectation_failed');
      }
    }
    const result = composeList(sessions, steps, filled, stop, started, values, usedLikely, finalExpectation);
    if (foldWarnings.length) result.warnings = [...new Set([...(result.warnings ?? []), ...foldWarnings])];
    return result;
  }

  /** The grant a list step runs under: the previous step's (lowered in place by lowerGrant), never above the ceiling. */
  #listGrant(grant) {
    if (!this.grantCeiling) return grant;
    if (!grant || levelRank(this.grantCeiling) < levelRank(grant.level)) return { level: this.grantCeiling };
    return grant;
  }

  /**
   * The decision loop. Completion depends on whether the provider reports `done` (the probability that the
   * requested outcome is already visible on the current page):
   *
   * - With done: a run completes when the expectation passes and done >= doneThreshold. A passing expectation with
   *   a lower done continues, so a loose expectation that matches an intermediate page no longer ends the run there.
   *   When the action budget runs out with the expectation passing, the run completes as
   *   budget_reached_expectation_passed. A handoff on a page where the expectation passes completes it as
   *   handoff_expectation_passed. Without an expectation, done >= 0.8 ends the run as unverified.
   * - Without done (custom providers): the expectation is checked after every action and a pass completes the run;
   *   a `done` choice ends it, verified by the expectation when there is one.
   */
  async #loop(session) {
    const { config, result } = session;
    const thresholds = config.thresholds;
    // With the origins known up front (the daemon's lease), the profile is attached before the first observe, so its
    // route words order the first page's controls too; otherwise right after the origins default to the first page's.
    if (config.allowedOrigins) session.startSite();
    let observation = await session.observe();
    session.initial = observation;
    session.resolveOrigins(observation);
    session.startSite();
    session.visit(observation);
    session.precheck(observation);
    session.notePrepass(observation);
    const hasExpectation = config.expectation !== undefined && config.expectation !== null;
    const history = [];
    let actionsTaken = 0;
    let noops = 0;
    // The last click that changed nothing, as `url, target, label` (a repeat of it ends the run).
    let lastNoop = null;
    let retries = 0;
    let doneAware = false; // the provider's latest decision reported done
    let passing = false; // the expectation passed on the current observation (done-aware runs)
    let doneButFailing = 0;
    let strongFailing = 0; // consecutive decisions with done >= strongDone and a failing expectation
    let consentClicks = 0;
    const consentClicked = new Set(); // consentKey() of every consent button clicked this run
    const overlays = overlayState(); // nag overlay dismissals this run (#overlay)
    let unsupportedRetries = 0;
    let nudged = false;
    const excluded = new Set(); // rung 1b: actions the browser reported unsupported
    const avoided = new Set(); // in-call back-out: destinations of links the run backed out of, never offered again
    const linkHrefs = new Map(); // step number -> destination of the link that step clicked
    // Rung 1, stale re-resolve: a provider-chosen link the page refused as stale (it changed after it was observed,
    // as MDN does when it adds ad and sign-in links after load) is kept for the fresh observation, where the same link
    // runs without a new decide. At most once per page (URL), and never again in the call after a guard stop.
    // The tried pages and the guard stop live in retryState, so a self-rerun or a later list step keeps them.
    let staleRetry = null;
    // The control whose click made the expectation pass ({key, type, label, url}), excluded from later offers on that
    // page while the expectation still passes (sameControl).
    let toggled = null;
    const staleState = config.retryState;
    const live = () => !session.interrupted && !session.signal.aborted;
    // Named-control done rule: page revisions on which a done claim did not count because the provider chose a button
    // the instruction names (namedChoice); at most one per revision.
    const namedPending = new Set();

    for (;;) {
      session.guard();
      // A kept stale choice is for the observation right after it only: a Rung 0 detour (a consent click) drops it.
      const stale = staleRetry;
      staleRetry = null;
      // Rung 0, on every page: approved origin, login wall, consent dialog. No provider call is spent on them. Each of
      // them also ends the site-profile fast path for the run.
      if (!allowedOrigin(observation.url, config.allowedOrigins)) {
        session.site?.stop('cross_origin');
        return session.crossOrigin(observation);
      }
      // Refusal receipt: the task itself asks for a purchase, deletion, message, submission or sign-in.
      if (session.refusal(observation)) return result;
      // A login wall stops the run unless the level has sign_in (testing), where the password field is a fill target.
      if (!config.capabilities.has('sign_in') && loginState(observation).wall) {
        session.site?.stop('login');
        setOutcome(result, 'login');
        // The agent asked for testing (sign-in on a test environment) but the user's grant is lower, for example
        // because the testing environment was removed mid-session: say which level would let FAI sign in.
        if (config.permissions.requested === 'testing') session.needLevel('testing');
        return result;
      }
      const consent = consentOf(observation);
      let consentActions = null;
      if (consent) {
        session.site?.stop('consent');
        // A consent wall on its own host (consent.google.com) continues to its `continue` URL once answered. When
        // that origin is not approved, the click would leave the lease: name the origin instead of clicking.
        const onward = consentContinueOrigin(observation.url);
        if (onward && !allowedOrigin(onward, config.allowedOrigins)) return session.crossOrigin(observation, onward);
        // Never the same consent button twice: one that did not close the dialog will not close it on a retry.
        const rejects = consentRejectActions(consent)
          .filter(action => consentClickable(action, observation, config) && !consentClicked.has(consentKey(action)));
        // With consent_accept (full and above) and no usable reject button, the accept buttons are offered to the
        // provider (the policy's consent line still prefers rejecting); a reject is always clicked first.
        const accepts = !rejects.length && config.capabilities.has('consent_accept')
          ? consentAcceptActions(consent)
            .filter(action => consentClickable(action, observation, config) && !consentClicked.has(consentKey(action)))
          : [];
        if ((!rejects.length && !accepts.length) || consentClicks >= MAX_CONSENT_CLICKS) return session.consentBlocked(consent);
        if (rejects.length === 1 && !accepts.length) {
          // Exactly one reject / necessary-only button: click it mechanically, then continue the task.
          consentClicks++;
          consentClicked.add(consentKey(rejects[0]));
          try {
            observation = await this.#mechanical(session, { id: 'consent', ...rejects[0] }, observation, history);
            observation = await session.awaitConsentClosed(observation, rejects[0]);
          } catch (error) {
            if (live() && isRecoverable(error) && retries < MAX_RECOVERABLE_RETRIES) {
              retries++;
              observation = await session.observe();
              session.visit(observation);
              continue;
            }
            if (live() && (error?.code === 'blocked_risky' || error?.code === 'unsupported')) {
              return session.consentBlocked(consent);
            }
            throw error;
          }
          if (session.consentPersisted) return session.consentBlocked(consentOf(observation) ?? consent);
          continue;
        }
        consentActions = (rejects.length ? rejects : accepts).map((action, index) => ({ id: `c${index}`, ...action }));
      }
      // A nag overlay (sign-in, newsletter, promo, app or permission prompt) over the page: one dismissal step, then
      // Rung 0 again on what it left (#overlay). Not on a cookie dialog, which goes first.
      if (!consentActions) {
        const dismissed = await this.#overlay(session, observation, history, overlays);
        if (dismissed) {
          observation = dismissed;
          continue;
        }
      }
      // An HTTP error page ends the run before any further provider decision (unless the expectation passes on it).
      if (!consentActions && await session.errorPage(observation, hasExpectation)) {
        session.site?.stop('error_page');
        return result;
      }
      // Late content on the final page (or in a late-load task): wait for the placeholder to go before deciding.
      if (!consentActions && (passing || session.lateIntent() || session.awaitLoading)) {
        // A self-rerun for late content waits for the placeholder on its first page as well.
        session.awaitLoading = false;
        const settled = await session.awaitContent(observation);
        if (settled !== observation) {
          observation = settled;
          if (!allowedOrigin(observation.url, config.allowedOrigins)) return session.crossOrigin(observation);
          if (hasExpectation) passing = Boolean(await session.expectationFor(observation));
        }
      }
      // Second-opinion decides (in-call retries) do not count against the decision budget; they have their own bound.
      // A stale re-resolve spends no decision, so it may still run the last decision's link (checked below).
      const decisionsSpent = result.cost.decisions - session.extraDecisions >= config.maxDecisions;
      if (decisionsSpent && !stale) {
        return setOutcome(result, doneAware && passing ? 'budget_reached_expectation_passed' : 'decision_budget');
      }
      const budgetLeft = actionsTaken < config.maxActions;
      if (!budgetLeft && hasExpectation) {
        // The expectation was already checked after the last action; no further decision can complete the run.
        return setOutcome(result, doneAware && passing ? 'budget_reached_expectation_passed' : 'action_budget');
      }
      // Without an expectation, allow one final terminal-only decision so the provider can still report done.
      // On a consent dialog with several reject buttons, only those buttons are offered.
      let offered;
      if (!budgetLeft) offered = terminalActions();
      else if (consentActions) offered = [...consentActions, ...terminalActions()];
      else {
        let dropped;
        ({ actions: offered, dropped } = offeredActions(observation, { ...config, exclude: excluded, hints: session.hints,
          intent: session.intentOn(),
          pinned: session.site?.pinned(observation) ?? null }));
        session.noteCapped(observation, dropped);
      }
      if (avoided.size && !consentActions && budgetLeft) {
        offered = offered.filter(candidate => !avoided.has(linkHref(candidate, observation.url)));
      }
      // The last click's late change was already waited for (settle late_change) and the page shows nothing loading:
      // no wait is offered on this decision. Jev, told to "wait for the new results", otherwise split between the
      // next control and a wait the runtime had just done (flights-live, both tasks: low_confidence).
      if (budgetLeft && !consentActions && result.steps.at(-1)?.settle === 'late_change'
        && !session.loadingOf(observation).length && offered.some(candidate => candidate.type === 'wait')) {
        offered = offered.filter(candidate => candidate.type !== 'wait');
        session.why('wait_excluded');
      }

      // The expectation already passes here (read from the check recorded for this very observation, or a
      // side-effect-free declarative check, so a `passing` left from an earlier page never counts).
      const passingHere = hasExpectation && !consentActions && session.expectationHint(observation);
      // A control whose click made the expectation pass is not offered again while it still passes on that page: a
      // second click on a toggle (Date grid, Show more) would close what the first opened.
      if (toggled && passingHere && budgetLeft && observation.url === toggled.url) {
        const before = offered.length;
        // A button the instruction names again and the run has not used up ("click Show more, then Show more") stays.
        offered = offered.filter(candidate => !sameControl(candidate, toggled)
          || session.namedChoice(candidate, offered, history));
        if (offered.length < before) session.why('toggle_excluded');
      }
      // Stale re-resolve: on the same URL, with the expectation state unchanged, exactly one offered link with the same
      // type, destination and label as the stale choice runs as that choice. Anything else decides again.
      const reresolve = stale && !consentActions && budgetLeft && observation.url === stale.url
        && Boolean(passingHere) === stale.passingHere
        ? staleMatch(stale, offered, observation, config)
        : null;
      if (decisionsSpent && !reresolve) {
        return setOutcome(result, doneAware && passing ? 'budget_reached_expectation_passed' : 'decision_budget');
      }
      // Site profile fast path (src/domains.js): when the expectation names a page type of this origin's profile and
      // the current page proves a page type with a route to it, the route's next hop runs without a decision. It is
      // one of `offered` (a link whose href is on this page), never a button, select, fill or submit; never on a
      // consent dialog, in a step, on a page where the expectation already passes, or with the last action of the
      // budget, so the landing page always gets a decision of its own. Rung 0 has already run on this page.
      // A profile shortcut (src/domains.js SiteRun.shortcut) goes first: the step names a value (a departure date) the
      // current page's URL does not hold, so the page cannot be the step's outcome even where the expectation passes;
      // the runtime-built URL keeps this page's origin and path and must be on an approved origin.
      const siteStep = !reresolve && session.site && !consentActions && budgetLeft && actionsTaken + 1 < config.maxActions;
      const fast = siteStep
        ? session.site.shortcut(observation, url => allowedOrigin(url, config.allowedOrigins))
          ?? (passingHere ? null : session.site.next(observation, offered, session.nextStep()))
        : null;
      // E2: an instruction that says to open a URL that is not this page goes there without a decision (urlHop), with
      // an action left for the landing page's own decision.
      const urlHop = !reresolve && !fast && !consentActions && budgetLeft && actionsTaken + 1 < config.maxActions
        ? session.urlHop(observation, offered)
        : null;
      let chosen;
      let record = null;
      let decisionStart = Date.now();
      let decisionMs = 0;
      if (reresolve) {
        // The stale decide's own choice, resolved again: no request, nothing charged to maxDecisions. Its decide
        // entry in cost.requests (marked `stale`) gets this step.
        chosen = reresolve;
        record = reresolveRecord(stale.record, reresolve.id);
        session.why('retry:stale_reresolve');
      } else if (fast?.shortcut) {
        chosen = fast.action;
        record = { by: 'profile', actionId: fast.action.id, reason: 'site_shortcut', shortcut: fast.shortcut };
        session.why('site:shortcut');
      } else if (fast) {
        chosen = fast.action;
        record = { by: 'profile', actionId: fast.action.id, reason: 'site_fast', edge: fast.edge.id };
        session.why('site:fast');
      } else if (urlHop) {
        chosen = urlHop;
        record = { by: 'url', actionId: urlHop.id, reason: 'named_url' };
        session.why('url:direct');
      } else {
        // The expectation already passes here, so this decision is likely the last: rank the answer next to it.
        // expectationHint reads the check recorded for this very observation (or a side-effect-free declarative
        // check), so a value of `passing` left from an earlier page never starts a ranking. The final screenshot
        // (capture 'last') is taken next to it too, instead of serially after the run ends.
        if (passingHere) {
          session.speculateAnswer(observation);
          session.prefetchCapture();
        }
        // slim.terminal: on that page, first ask only done and the page guards. Done at the threshold completes the
        // run exactly as the full decide's done would (the blocked guard marks it, never stops it, as below);
        // anything else falls back to the full decide.
        // At most once per URL, and never again in the call after a fallback: a fallback means this provider's slim
        // answer and the expectation disagree here, and every further try would cost one more request.
        const slimState = config.retryState;
        if (passingHere && budgetLeft && config.slim.terminal && !session.landingHeld && typeof this.provider?.confirm === 'function'
          && !slimState.terminalOff && !slimState.terminalUrls.has(observation.url)) {
          slimState.terminalUrls.add(observation.url);
          const confirmed = await session.confirmTerminal(observation, history);
          if (!confirmed) slimState.terminalOff = true;
          if (confirmed && await session.expectationFor(observation)) {
            const guards = guardsOf(confirmed);
            if (guards) session.noteGuards(guards);
            session.signals.done = doneProbability(confirmed);
            const signInPage = config.capabilities.has('sign_in') && loginState(observation).passwordField;
            if (guards?.blocked >= GUARD_VETO && !signInPage) session.why('guard:blocked_page');
            return setOutcome(result, 'expectation_passed');
          }
          if (confirmed) {
            // The recorded check disagrees with the declarative hint (a late-load page still showing a loading
            // placeholder): the full decide decides, outside the budget like any fallback.
            session.lastRequest.fallback = true;
            session.extraDecisions++;
            slimState.terminalOff = true;
          }
        }
        decisionStart = Date.now();
        let decision = await session.decide(observation, offered, history);
        decisionMs = Date.now() - decisionStart;

        let action = offered.find(candidate => candidate.id === decision?.actionId);
        if (!action) throw bridgeError('invalid_decision', 'Provider chose an action outside the offered choices', false);
        let guards = guardsOf(decision);
        if (guards) session.noteGuards(guards);
        const done = doneProbability(decision);
        doneAware = done !== null;
        // Guard reporting and the blocked veto precede every done-based early return. A passing expectation with done
        // at the threshold still completes, but never as verified: the verdict is likely/confirm (guard:blocked_page)
        // and the host must check the page is not a login, paywall or captcha page before trusting the digest.
        if (doneAware && hasExpectation) passing = Boolean(await session.expectationFor(observation));
        // At testing (sign_in) a sign-in page with a password field is part of the task, not a blocked page.
        const signInPage = config.capabilities.has('sign_in') && loginState(observation).passwordField;
        if (guards?.blocked >= GUARD_VETO && !consentActions && !signInPage) {
          if (!(doneAware && passing && done >= thresholds.doneThreshold)) return setOutcome(result, 'blocked');
          session.signals.done = done;
          session.why('guard:blocked_page');
          return setOutcome(result, 'expectation_passed');
        }
        if (doneAware) {
          session.signals.done = done;
          if (hasExpectation) {
            passing = Boolean(await session.expectationFor(observation));
            if (passing && done >= thresholds.doneThreshold) return setOutcome(result, 'expectation_passed');
            // Named-control done rule: "Choose Standard, then click Next" after the select reads as done (0.68-0.75)
            // while the provider's own choice is the Next the instruction names. That choice says the outcome is one
            // named click away, so this decision's done claim counts toward neither failing limit below; the click
            // still meets every guard, veto and floor. Once per page revision: a Next that changes nothing counts.
            const pendingNamed = !passing && done >= thresholds.doneThreshold && !namedPending.has(observation.revision)
              && session.namedChoice(action, offered, history);
            if (pendingNamed) {
              namedPending.add(observation.revision);
              session.why('named:done_pending');
            } else {
              doneButFailing = !passing && done >= thresholds.doneThreshold ? doneButFailing + 1 : 0;
            }
            if (!passing && done >= thresholds.strongDone && !pendingNamed) {
              // Rung 1c: the provider is sure the outcome is visible but the expectation fails. A navigation may have
              // started after the observation settled: look once more before reclassifying.
              const before = observation;
              const fresh = await session.reobserve();
              if (fresh) {
                observation = fresh;
                if (!allowedOrigin(observation.url, config.allowedOrigins)) return session.crossOrigin(observation);
                passing = Boolean(await session.expectationFor(observation));
                if (passing) {
                  session.why('late_reobserve');
                  return setOutcome(result, 'expectation_passed');
                }
              }
              // The run ends as a mismatch only when the provider also stopped (handoff/done), or when it was sure
              // and wrong on two consecutive decisions. Otherwise its click still runs: a provider can be sure the
              // answer is one click away (hn "98 comments" at done 0.93, github "Apache-2.0 license" at 0.88).
              strongFailing++;
              const chosenType = offered.find(candidate => candidate.id === decision?.actionId)?.type;
              if (chosenType === 'handoff' || chosenType === 'done' || strongFailing >= STRONG_FAILING_LIMIT) {
                return setOutcome(result, result.verification.error ? 'expectation_error' : 'expectation_mismatch');
              }
              if (fresh && (fresh.url !== before.url || fresh.revision !== before.revision)) {
                // The page changed under the decision: decide again on what is there now.
                session.why('late_reobserve');
                continue;
              }
            } else if (!pendingNamed) {
              strongFailing = 0;
            }
            if (doneButFailing >= DONE_BUT_FAILING_LIMIT) {
              return setOutcome(result, result.verification.error ? 'expectation_error' : 'expectation_failed');
            }
          } else if (done >= NO_EXPECTATION_DONE) {
            return setOutcome(result, 'no_expectation');
          }
          // The final terminal-only decision did not report done.
          if (!budgetLeft) return setOutcome(result, 'action_budget');
        }

        // In-call retry 1: a close call (or a choice below its floor) gets one second opinion with the options
        // reordered, before any guard veto, handoff or floor reads the decision. Never on a page where the expectation
        // already passes: there the done logic above decides.
        const opinion = doneAware && passing ? null
          : session.secondOpinionReason(decision, action, offered, { consent: Boolean(consentActions), budgetLeft });
        if (opinion) {
          ({ decision, action } = await session.secondOpinion(decision, action, offered, observation, history, opinion));
          guards = guardsOf(decision);
          decisionMs = Date.now() - decisionStart;
          // The blocked veto ran on the first decision; a second look that scores the page blocked stops here too.
          if (guards?.blocked >= GUARD_VETO && !signInPage) return setOutcome(result, 'blocked');
        }

        // Provider guards. Rung 0 (origin, login wall, consent dialog) has already run on this page, and code-side
        // vetoes stay authoritative: a guard can only stop an action, never allow one the runtime would refuse.
        if (guards) {
          if (guards.injection >= GUARD_VETO
            && ((!['handoff', 'done'].includes(action.type) && !approvedLink(action, observation, config))
              || (action.type === 'handoff' && session.offscreenMatch(observation)))) {
            session.why('guard:injection_veto');
            return setOutcome(result, 'handoff');
          }
        }
        // Commit guard (reversible mode; the mechanical label checks have already run): a chosen button, select or
        // fill the provider judges to commit the user is refused, never executed. Links, scrolling and waiting proceed.
        const purchaseHigh = session.purchaseHigh(decision);
        const commitHigh = purchaseHigh || session.commitHigh(decision);
        if (purchaseHigh && commitCandidate(action)) return session.purchaseVeto(action);
        if (commitHigh && commitCandidate(action)) return session.commitVeto(action);
        // An ambiguous refused control (offered with the intent question) runs only when the decision clears it.
        if (action.intent) {
          const gate = session.intentGate(decision, action, observation);
          if (gate.result) return gate.result;
          action = gate.action;
        }
        chosen = action;
        // A terminal choice leaves the previous step pending, so close() finalizes it as the final step.
        if (action.type === 'handoff') {
          // The provider sees nothing more to do on a page where the expectation passes. Common on the last page of
          // a multi-hop task, whose answer combines facts from several pages, so done stays low.
          if (doneAware && passing && session.vacuousPass(session.signals.done)) {
            // The expectation passed on the start page already and never failed since, and done is low: it cannot
            // show the task is done. The handoff goes to the host as one.
            session.noteVacuous();
          } else if (doneAware && passing) {
            return setOutcome(result, 'handoff_expectation_passed');
          }
          // A handoff while the commit guard is high and such controls are offered: the next step is the user's, so
          // the host is told to stop rather than steered to run the control itself (decide options, act()). Not on a
          // page carrying injected instructions (injection guard at GUARD_VETO): its text can push the commit noul
          // either way (a harmless "Next page" called a purchase scored 0.70 in the QA corpus), so a stop there would
          // let the page end the task; the handoff stands, and decide options keep only approved plain links.
          if (commitHigh && offered.some(commitCandidate) && !(guards?.injection >= GUARD_VETO)) {
            return purchaseHigh ? session.purchaseVeto(null) : session.commitVeto(null);
          }
          // The task's own refusal, left to this decision for a control Jev might have cleared (refusal defer).
          if (session.intentOn() && session.refusal(observation, { defer: false })) return result;
          // Every visible control is refused at this level and nothing else is offered: the task cannot go on here.
          if (config.capabilities.has('controls') && !(guards?.injection >= GUARD_VETO)
            && !offered.some(candidate => candidate.target !== undefined || candidate.type === 'navigate_allowed_url')) {
            const entries = blockedEntries(observation, config);
            const blocked = new Set(entries.map(entry => String(entry.control.id)));
            const remaining = (observation.controls ?? []).filter(control => control.enabled !== false && control.visible !== false);
            if (remaining.length && remaining.every(control => blocked.has(String(control.id)))) {
              return session.refuse('all_controls_blocked', entries);
            }
          }
          const scroll = !nudged && budgetLeft && !consentActions && session.offscreenMatch(observation)
            ? offered.find(candidate => candidate.type === 'scroll' && candidate.direction === 'down')
            : null;
          if (scroll) {
            // Scroll nudge: what the task names is below the fold. Scroll once and let the provider decide again.
            nudged = true;
            session.why('scroll_nudge');
            chosen = scroll;
            record = { by: 'runtime', actionId: scroll.id, reason: 'scroll_nudge' };
          } else {
            // In-call retry 2: a read-only run that followed a wrong link goes back once instead of handing off.
            const back = await session.backOutTarget(observation, { budgetLeft });
            if (back) {
              observation = await this.#backOut(session, back, observation, history, avoided, linkHrefs, 'handoff');
              // The navigation back is an action of the call: it counts against maxActions.
              actionsTaken++;
              session.actionsTaken = actionsTaken;
              passing = false;
              continue;
            }
            const decide = session.decideOptions(decision, offered, observation);
            if (decide) {
              const { executable, ...rest } = decide;
              this.#remember({ revision: observation.revision, observation, actions: executable, config });
              session.signals.decide = rest;
            }
            return setOutcome(result, 'handoff');
          }
        }
        if (chosen.type === 'done') return session.finishDone(observation);
        if (!record) {
          // Per-class confidence floors: links are never gated by default (linkFloor 0), buttons, selects and fills
          // are (controlFloor 0.5). A doubtful choice goes to the host with alternatives instead of running; the offer
          // is remembered so the host can pick one with act() without observing again.
          const kind = actionClass(chosen);
          const floorName = kind === 'link' ? 'linkFloor' : kind === 'control' ? 'controlFloor' : null;
          const floor = floorName ? thresholds[floorName] : 0;
          if (floor > 0) {
            const confidence = choiceConfidence(decision);
            const gated = confidence === null ? config.explicitThresholds.has(floorName) : confidence < floor;
            // Named clicks done: on a page where the expectation passes, after the run clicked every button the
            // instruction names ("..., then click Next" and Next ran), a doubtful further choice (the next page's own
            // Next at 0.48-0.53) ends the run as a handoff there would: completed, handoff_expectation_passed. Nothing
            // runs; without named clicks, or with one left, the floor returns low_confidence as before.
            if (gated && doneAware && passing && session.namedClicksDone(offered, history)) {
              session.why('named:clicks_done');
              return setOutcome(result, 'handoff_expectation_passed');
            }
            if (gated) {
              const back = await session.backOutTarget(observation, { budgetLeft });
              if (back) {
                observation = await this.#backOut(session, back, observation, history, avoided, linkHrefs, 'low_confidence');
                // The navigation back is an action of the call: it counts against maxActions.
                actionsTaken++;
                session.actionsTaken = actionsTaken;
                passing = false;
                continue;
              }
              const executable = offered.filter(candidate => candidate.type !== 'done' && candidate.type !== 'handoff'
                && !(commitHigh && commitCandidate(candidate)));
              this.#remember({ revision: observation.revision, observation, actions: executable, config });
              setOutcome(result, 'low_confidence');
              result.needs.revision = observation.revision;
              result.needs.confidence = confidence;
              result.needs.minConfidence = floor;
              result.needs.alternatives = alternativesFor(decision, executable, confidence);
              session.why(`floor:${kind}`);
              return result;
            }
          }
          record = decisionRecord('provider', decision);
        }
      }
      // The previous step's screenshot was being captured while the provider decided; attach it now.
      await session.finalizePending(false);
      session.guard();

      // A fast hop skips the decide, not the page guards: the slim done-and-guards request for the page it leaves runs
      // in parallel with the hop, and a blocked or injection score ends the fast path (applied after the landing check).
      // A stale re-resolve gets the same request for the content that arrived after its decide (`stale_guards`): a
      // blocked or injection score (or a failed request) switches re-resolves off for the rest of the call, so every
      // later stale link is decided again.
      // The re-resolved step's decision carries the guards of the page it ran on (the stale decide's were scored
      // before the new content), set when that request answers.
      const siteGuards = fast ? session.siteGuards(observation, history)
        : reresolve ? session.siteGuards(observation, history, 'stale_guards', guards => {
          if (guards) record.guards = roundedGuards(guards);
        }) : null;
      let executed;
      try {
        executed = await session.execute(chosen, observation, record, decisionStart, decisionMs);
      } catch (error) {
        if (fast) {
          // A page that changed after it was observed (stale) gets the edge resolved again once on a fresh
          // observation; a guard stop, any other error or a second stale ends the fast path.
          const guardStop = await siteGuards;
          if (guardStop) session.site.stop(guardStop, fast.edge);
          else if (!(error?.code === 'stale' && live() && session.site.retry())) session.site.stop('action_error');
        } else if (reresolve) {
          const guardStop = await siteGuards;
          if (guardStop) {
            staleState.staleOff = true;
            session.why(`retry:stale_reresolve:${guardStop}`);
          }
        }
        if (error?.code === 'stale' && live() && retries < MAX_RECOVERABLE_RETRIES) {
          // Trace marker: a stale retry, and on the decide entry whose choice the page refused, `stale: true`.
          session.why('retry:stale');
          if (record?.by === 'provider' && !reresolve
            && ['decide', 'second_opinion'].includes(session.lastRequest?.kind)) session.lastRequest.stale = true;
          // A provider-chosen link to an approved origin is kept for one re-resolve on the fresh observation, only
          // with a provider that has the slim guards request (it checks the new content). Buttons, selects and fills
          // always decide again.
          const href = linkHref(chosen, observation.url);
          if (record?.by === 'provider' && !reresolve && !staleState.staleOff && !consentActions
            && !staleState.staleUrls.has(observation.url) && actionClass(chosen) === 'link'
            && approvedLink(chosen, observation, config) && staleResolvable(href, observation.url)
            && typeof this.provider?.confirm === 'function') {
            staleState.staleUrls.add(observation.url);
            staleRetry = { chosen, record, url: observation.url, href, frame: frameOf(chosen, observation),
              passingHere: Boolean(passingHere) };
          }
        }
        // Rung 1: stale page or vanished target: re-observe and let the provider choose again.
        if (live() && isRecoverable(error) && retries < MAX_RECOVERABLE_RETRIES) {
          retries++;
          observation = await session.observe();
          session.visit(observation);
          continue;
        }
        // Rung 1b: the browser cannot perform this action (a shadow host, an unusual widget). Offer the rest.
        if (live() && error?.code === 'unsupported' && unsupportedRetries < MAX_UNSUPPORTED_RETRIES
          && !excluded.has(actionKey(chosen))) {
          unsupportedRetries++;
          excluded.add(actionKey(chosen));
          session.why('retry:unsupported');
          observation = await session.observe();
          session.visit(observation);
          continue;
        }
        throw error;
      }
      const guardStop = siteGuards ? await siteGuards : null;
      if (reresolve && guardStop) {
        // The hop already ran (the provider's own link, same destination and label, on an approved origin); the new
        // content it was not decided on scored blocked or injection, so no further stale link runs without a decide.
        staleState.staleOff = true;
        session.why(`retry:stale_reresolve:${guardStop}`);
      }
      retries = 0;
      actionsTaken++;
      session.actionsTaken = actionsTaken;
      if (actionClass(chosen) === 'link') linkHrefs.set(executed.step.i, linkHref(chosen, observation.url));
      let after = executed.observation;
      if (chosen.consent) {
        // A reject button the provider chose among several: verify the dialog closed, as for a mechanical click.
        consentClicks++;
        consentClicked.add(consentKey(chosen));
        after = await session.awaitConsentClosed(after, chosen);
        if (session.consentPersisted) {
          history.push(historyEntry(executed.step));
          session.visit(after);
          return session.consentBlocked(consentOf(after) ?? consentOf(observation));
        }
      }
      // Rung 1c: a link click that settled quiet on the same URL may be a navigation that started late; so may a
      // button click that settled quiet and changed nothing at all (an app's nav buttons that load the next page: a
      // live run verified a step on the page it was leaving and handed off on the next). "Changed nothing" is read on
      // the URL and the content (pageMoved), not the revision: the click on an offscreen arrow scrolls it into view,
      // which moves the revision but is no change of the page.
      const lateLink = actionClass(chosen) === 'link' && after.url === observation.url
        && (executed.step.settle === 'quiet' || executed.step.navigated);
      // A calendar's Done that only closed its dialog changed nothing either: the results land seconds later.
      const moved = chosen.type === 'click' ? contentDiff(observation, after) : null;
      if (moved) executed.step.moved = moved;
      // The page's revision can stay put while its content moved (a listbox option that closed its menu and rewrote
      // its field: Google Flights' "One way"): a click whose title, blocks or controls changed changed the page.
      // Not a blocks-only move under an unchanged revision that only replaced blocks one for one: the revision leaves
      // live regions and off-screen content out, so that is a ticking clock or a rotating ad (blockChurn), not this
      // click's doing; an off-screen append (Load more) adds blocks and does count.
      if (moved && moved !== 'revision' && !(moved === 'blocks' && after.revision === observation.revision
        && blockChurn(observation, after))) executed.step.changed = true;
      const lateButton = actionClass(chosen) === 'control' && executed.step.settle === 'quiet'
        && (!moved || onlyDialogClosed(chosen, observation, after));
      if (chosen.type === 'click' && (lateLink || lateButton)) {
        const fresh = await session.reobserve();
        if (fresh && pageMoved(after, fresh)) {
          executed.step.action.toUrl = fresh.url;
          executed.step.changed = fresh.revision !== observation.revision || fresh.url !== observation.url;
          executed.step.lateNavigation = true;
          session.why('late_navigation');
          session.refundReobserve();
          after = fresh;
        } else if (fresh && lateButton) {
          // Still nothing: an app that updates the URL and results seconds after the click (a date stepper). Wait
          // longer, in bounded rounds, for a late change before deciding again on a page that only looks unchanged.
          // Only a control that re-renders late gets the full wait; any other button one short look while work
          // shows pending, else none (a button that does nothing paid 3 s per call: QA spa-project-owner).
          const look = lateLook(chosen, observation, fresh, session);
          const late = look ? await session.awaitLateChange(fresh, look) : null;
          if (late) {
            executed.step.action.toUrl = late.observation.url;
            executed.step.changed = late.observation.revision !== observation.revision || late.observation.url !== observation.url;
            executed.step.settle = 'late_change';
            executed.step.ms.settle += late.ms;
            session.why('late_change');
            session.refundReobserve();
            after = late.observation;
          }
        }
      }
      history.push(historyEntry(executed.step));
      // The field did not keep the supplied value (the page reverted or ignored the typed text: a date picker's
      // textbox): not progress and not success, however the page looks. The host hears which field and switches
      // method (a URL in allowedUrls, the page's own picker) instead of the provider typing again.
      if (executed.step.fill?.kept === false) {
        observation = after;
        session.visit(observation);
        session.why('fill:not_kept');
        return setOutcome(result, 'fill_not_kept');
      }
      noops = executed.step.changed ? 0 : noops + 1;
      // The same click on the same page that changed nothing last time will change nothing again: the first repeat
      // ends the run (no_progress) instead of the third no-change action (gf-date-grid: "Search" three times).
      const noopKey = executed.step.changed || chosen.type !== 'click' ? null
        : `${observation.url}\u0000${chosen.target}\u0000${executed.step.action.label ?? ''}`;
      const repeated = noopKey !== null && noopKey === lastNoop;
      lastNoop = noopKey;
      observation = after;
      session.visit(observation);
      session.hopEvent(chosen, executed.step, observation);

      if (!allowedOrigin(observation.url, config.allowedOrigins)) {
        if (fast) session.site.land(observation, executed.step.i);
        return session.crossOrigin(observation);
      }
      passing = Boolean(await session.expectationFor(observation));
      // A late change that landed on its first paint (a placeholder where the rows go, Google Flights' date arrows) is
      // work still in flight: waiting it out costs the bounded content waits, a decision on it a Jev request and a
      // split between the same control again and a wait (fix 3, flights-live-form-arrows).
      if (passing || session.lateIntent() || executed.step.settle === 'late_change') {
        // Late content: the action landed on a page still filling in. Wait before any completion check.
        const settled = await session.awaitContent(observation);
        if (settled !== observation) {
          observation = settled;
          if (!allowedOrigin(observation.url, config.allowedOrigins)) {
            if (fast) session.site.land(observation, executed.step.i);
            return session.crossOrigin(observation);
          }
          passing = Boolean(await session.expectationFor(observation));
        }
      }
      // The opening URL hop of an instruction that names more after it (namesMoreAfterOpen): a pass on the page it
      // landed on proves the URL, not the task. The landing page counts as the start page (vacuousPass), and the run
      // goes on to a provider decision instead of ending here (gf-date-grid: one hop, none of the instruction done).
      const landingHold = passing && record?.by === 'url' && actionsTaken === 1
        && namesMoreAfterOpen(session.instruction, chosen.url);
      if (landingHold) session.holdLanding();
      // A fast step must land on the edge's page type (URL pattern and every check). A miss ends the fast path: the
      // normal loop decides from this page on.
      if (fast) session.site.land(observation, executed.step.i);
      if (fast && guardStop) session.site.stop(guardStop, fast.edge, executed.step.i);
      // The action landed on an HTTP error page (a broken link): stop here, also for a step.
      if (await session.errorPage(observation, hasExpectation)) return result;
      // This click made the expectation pass: the same control is not offered again on this page while it passes.
      // Only a click that stayed on its page is a toggle: a Next that navigated is a different page's Next. Any page
      // change (another URL) or a failing expectation clears the record.
      if (passing && !passingHere && chosen.type === 'click' && actionClass(chosen) === 'control'
        && observation.url === executed.step.action.fromUrl) {
        toggled = toggleRecord(chosen, observation.url);
      } else if (!passing || (toggled && observation.url !== toggled.url)) {
        toggled = null;
      }
      // A step has no further decision to confirm doneness, so a passing expectation completes it either way. A fast
      // step never completes the run by itself: its landing page gets the terminal decision (done and the guards).
      if (passing && !fast && !landingHold && (!doneAware || config.step)) return setOutcome(result, 'expectation_passed');
      // A list step, or a bounded imperative whose named actions are done, ends on its own passing expectation
      // whatever done says: another decide on a page that already proves the hop only risks overshooting it
      // (a second "Next page", a second click on a toggle). A question still gets its page guards (endOnPass).
      if (passing && !fast && !landingHold && doneAware && session.earlyEnd(observation, { flipped: !passingHere })
        && await session.endOnPass(observation, history)) {
        return result;
      }
      if (config.step) return setOutcome(result, 'step_complete');
      if (doneAware && passing && actionsTaken >= config.maxActions) {
        return setOutcome(result, 'budget_reached_expectation_passed');
      }
      if (repeated) session.why('no_progress:repeat');
      if (noops >= NOOP_LIMIT || repeated) return setOutcome(result, 'no_progress');
    }
  }

  /**
   * In-call retry 2, the back-out: navigate to the URL before the wrong link (a same-origin GET to a page this run
   * already showed; the extension refuses anything else) and never offer that link's destination again in this run.
   * The navigation is a step (`decision.by: "runtime"`, reason `back_out`) that counts against maxActions.
   * Returns the observation to decide on next.
   */
  async #backOut(session, back, observation, history, avoided, linkHrefs, why) {
    session.config.retryState.backOuts++;
    for (const url of [linkHrefs.get(back.link.i), back.link.action.toUrl]) if (url) avoided.add(url);
    session.retries.push({
      kind: 'back_out', why, step: session.nextStep(), from: urlPath(back.link.action.toUrl), to: urlPath(back.from),
    });
    session.why('retry:back_out');
    await session.finalizePending(false);
    session.guard();
    const action = {
      id: 'back',
      type: 'navigate_allowed_url',
      url: back.from,
      label: 'Back to the page before the last link',
      description: 'Return to the page before the last link (runtime back-out)',
    };
    let executed;
    try {
      executed = await session.execute(action, observation, { by: 'runtime', actionId: 'back', reason: 'back_out' }, Date.now(), 0);
    } catch (error) {
      if (!isRecoverable(error) || session.interrupted || session.signal.aborted) throw error;
      const fresh = await session.observe();
      session.visit(fresh);
      return fresh;
    }
    history.push(historyEntry(executed.step));
    session.visit(executed.observation);
    return executed.observation;
  }

  /** Execute a runtime-chosen action (a consent reject click, a nag overlay dismissal) with no provider decision. */
  async #mechanical(session, action, before, history, reason = 'consent') {
    await session.finalizePending(false);
    session.guard();
    const started = Date.now();
    const executed = await session.execute(action, before, { by: 'runtime', actionId: action.id, reason },
      started, 0);
    history.push(historyEntry(executed.step));
    session.visit(executed.observation);
    return executed.observation;
  }

  /**
   * Rung 0 for a blocking overlay that is not a cookie dialog (src/overlay.js): a nag (sign-in, newsletter, promo,
   * app-install, permission prompt) is dismissed with its close control, then Escape, then a click on its separate
   * backdrop, one step at a time, each step at most once per overlay, as a `dismiss` step that needs no level (like a
   * consent reject). Returns the observation after a step, or null when nothing was done (no overlay, not a nag, or
   * given up on): the task then goes on, and the page script's `overlay` marks keep decisions on the main content.
   * Why codes: overlay:dismissed and overlay:<method> on success, overlay:kept:<kind> for a task dialog, age gate or
   * unknown dialog, overlay:user_opened for a nag the run's own click opened, overlay:undismissable when every step
   * failed, overlay:persistent when it came back more than MAX_OVERLAY_RETURNS times.
   */
  async #overlay(session, observation, history, state) {
    const overlay = overlayOf(observation);
    if (!overlay) return null;
    const key = overlayKey(overlay);
    const first = !state.seen.has(key);
    state.seen.add(key);
    if (!overlay.nag) {
      session.why(`overlay:kept:${overlay.kind}`);
      return null;
    }
    if (state.stuck.has(key)) return null;
    // A nag the run's own button click opened on this page (a "Save" that asks to sign in) answers that click: the
    // provider sees it, its close control included, and decides.
    const last = session.result.steps.at(-1);
    if (first && last?.decision?.by === 'provider' && last.class === 'control' && last.action?.fromUrl === observation.url) {
      state.stuck.add(key);
      session.why('overlay:user_opened');
      return null;
    }
    if ((state.dismissed.get(key) ?? 0) > MAX_OVERLAY_RETURNS) {
      state.stuck.add(key);
      session.why('overlay:persistent');
      return null;
    }
    const tried = state.tried.get(key) ?? new Set();
    state.tried.set(key, tried);
    const next = overlayDismissActions(overlay, observation).find(action => !tried.has(action.key));
    if (!next || state.actions >= MAX_OVERLAY_ACTIONS) {
      state.stuck.add(key);
      session.why('overlay:undismissable');
      return null;
    }
    tried.add(next.key);
    state.actions++;
    let after;
    try {
      after = await this.#mechanical(session, { id: 'overlay', ...next }, observation, history, 'overlay');
    } catch (error) {
      if (session.interrupted || session.signal.aborted) throw error;
      // Refused or gone before it ran (the overlay closed by itself, a stale page): look again; the step is spent.
      if (isRecoverable(error) || ['blocked_risky', 'unsupported', 'target_unavailable', 'stale'].includes(error?.code)) {
        const fresh = await session.observe();
        session.visit(fresh);
        return fresh;
      }
      throw error;
    }
    after = await session.awaitOverlayClosed(after, key);
    const still = overlayOf(after);
    if (!still || overlayKey(still) !== key) {
      state.dismissed.set(key, (state.dismissed.get(key) ?? 0) + 1);
      // The step that worked is tried first again if the overlay comes back.
      state.tried.delete(key);
      session.why('overlay:dismissed');
      session.why(`overlay:${next.method}`);
    }
    return after;
  }
}
