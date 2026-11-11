// Mechanical oversight helpers (docs/design/OVERSIGHT-SPEC.md sections 1-3): answer thresholds, the page
// classification (consent dialog, login wall, error page) and refusal texts. Pure, synchronous and model-free.
// Nothing here returns page text inside a trusted field.
import {
  COMMIT_ACTION, COMMIT_OTHER, DANGEROUS, DELETE_WORDS, PURCHASE, SIGN_IN_WORDS, SUBMIT_WORDS, commitOtherClass,
} from './guardrails.js';

/** The answer gates (config.json `thresholds`): when an answer candidate is auto-confirmed as verdict.answer. */
export const DEFAULT_THRESHOLDS = Object.freeze({
  answerConfirm: 0.8, // top candidate confidence for an auto-confirmed verdict.answer
  answerMargin: 0.5, // and its margin over the second candidate
});

export const THRESHOLD_NAMES = Object.freeze(Object.keys(DEFAULT_THRESHOLDS));
// Gates of the removed Jev autopilot: accepted in an older config.json and ignored.
const RETIRED_THRESHOLDS = new Set(['linkFloor', 'controlFloor', 'doneThreshold', 'strongDone', 'placeholderFloor',
  'placeholderMargin', 'commitVeto', 'secondOpinionMargin']);

/**
 * The thresholds: defaults, then `options.thresholds`. Returns `{ thresholds, explicit }` where `explicit` lists the
 * names the caller set.
 */
export function resolveThresholds(options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS };
  const explicit = new Set();
  const given = options.thresholds;
  if (given !== undefined && given !== null) {
    if (typeof given !== 'object' || Array.isArray(given)) throw new TypeError('thresholds must be an object');
    for (const [name, value] of Object.entries(given)) {
      if (RETIRED_THRESHOLDS.has(name)) continue;
      if (!THRESHOLD_NAMES.includes(name)) throw new TypeError(`Unknown threshold "${name}"`);
      if (value === undefined) continue;
      thresholds[name] = value;
      explicit.add(name);
    }
  }
  for (const name of THRESHOLD_NAMES) {
    const value = thresholds[name];
    if (typeof value !== 'number' || !(value >= 0 && value <= 1)) throw new RangeError(`${name} must be a number from 0 to 1`);
  }
  return { thresholds, explicit };
}

// ---------------------------------------------------------------------------------------------------------------
// Rung 0: consent dialogs and login walls
// ---------------------------------------------------------------------------------------------------------------

/**
 * Labels of the consent buttons the runtime may offer: reject, decline, necessary or essential only, in English,
 * German, French, Spanish, Italian, Portuguese and Dutch. Accept, agree and allow buttons are never offered or
 * clicked, in any mode. CONSENT_REJECT, CONSENT_ACCEPT, CONSENT_SETTINGS and CONSENT_WITHOUT_ACCEPT are identical
 * to extension/page.js (drift check in test/machinery-consent-i18n.test.js and test/oversight-receipt.test.js).
 */
export const CONSENT_REJECT = /reject|decline|refuse|necessary|essential|only required|без|ablehnen|nur notwendig|nur erforderlich|refuser|continuer sans accepter|rechazar|necesari|rifiut|solo necessari|rejeitar|recusar|apenas necess|weiger|alleen noodzakelijk/i;
export const CONSENT_ACCEPT = /\baccept|\bagree|\ballow|\bgot it\b|\bok(?:ay)?\b|\bakzeptier|\bzustimm|\beinverstanden|\btout accepter|\bacept|\baccett|\baceit|\bakkoord/i;
export const CONSENT_SETTINGS = /settings|manage|customi|options|preferences|einstellungen|anpassen|verwalten|paramètres|personnaliser|gérer|configur|ajustes|preferencias|impostazioni|personalizza|gestisci|definições|personalizar|gerir|instellingen|aanpassen|beheren/i;
/** "Continue without accepting" in each language: a reject, although it contains the accept verb. */
export const CONSENT_WITHOUT_ACCEPT = /without accepting|ohne (?:zu )?(?:akzeptieren|zustimmen)|sans accepter|sin aceptar|senza accettare|sem aceitar|zonder (?:te )?accepteren/i;

// COMMIT_ACTION and DANGEROUS (composed) and their split sets live in src/guardrails.js, the guardrail policy's core
// (the single source of truth for the mechanical check); re-exported here for the existing
// importers.
export { COMMIT_ACTION, COMMIT_OTHER, DANGEROUS, DELETE_WORDS, PURCHASE, SIGN_IN_WORDS, SUBMIT_WORDS };

// ---------------------------------------------------------------------------------------------------------------
// Destructive links, refused tasks and error pages (machinery pass)
// ---------------------------------------------------------------------------------------------------------------

// A link label that starts with one of these verbs does something rather than going somewhere: it is never offered.
export const LINK_DANGER_LEAD = /^(?:delete|remove|erase|purchase|buy|pay|place\s+(?:an?\s+|the\s+|your\s+|my\s+)?order|order\s+now|check\s?out|proceed\s+to\s+check\s?out|confirm|submit|send|save|publish|invite|unsubscribe|subscribe|cancel\s+(?:my\s+|your\s+|the\s+)?(?:subscription|membership|account|plan|order)|close\s+(?:my\s+|your\s+|the\s+)?account|deactivate|sign\s?(?:in|out)|log\s?(?:in|out)|login|logout|signout)\b/i;
const MAX_GATED_LINK_WORDS = 4;

function words(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * True for a link whose label is an action, not a destination: a short label (at most 4 words) that starts with a
 * destructive or commit verb ("Delete account", "Delete this filter", "Sign out", "Subscribe now") or matches
 * COMMIT_ACTION ("Proceed to checkout"). Longer descriptive labels ("How to delete your account safely") and
 * labels that only contain such a word later ("Order history", "Account deletion policy") are navigation.
 */
export function destructiveLink(label) {
  // Ignore decorative prefixes without moving a later verb to the start of a prose label.
  const text = words(words(label).replace(/^[^\p{L}\p{N}]+/u, ''));
  if (!text || text.split(' ').length > MAX_GATED_LINK_WORDS) return false;
  // Account deletion help is documentation, even though its short label begins with a verb.
  if (/^(?:delete|remove)\s+(?:(?:my|your|the)\s+)?account\s+help[.!?]*$/i.test(text)) return false;
  if (LINK_DANGER_LEAD.test(text)) return true;
  // COMMIT_ACTION matches anywhere in a button label; on a link only a leading commit phrase counts, so "Where to
  // buy" and "How to subscribe" stay navigation while "Checkout" and "Go to checkout" do not.
  const commit = text.match(COMMIT_ACTION);
  return Boolean(commit) && commit.index === 0;
}

// The class of a link action's leading verb, for the level check (destructiveLink decides whether it is one).
// extension/page.js keeps byte copies of this and LINK_DANGER_LEAD (test/guardrails-drift.test.js).
export const LINK_LEAD_CLASSES = [
  ['sign_in', /^(?:sign\s?(?:in|out)|log\s?(?:in|out)|login|logout|signout)\b/i],
  ['purchase', /^(?:purchase|buy|pay|place\s+(?:an?\s+|the\s+|your\s+|my\s+)?order|order\s+now|check\s?out|proceed\s+to\s+check\s?out|subscribe)\b/i],
  ['delete', /^(?:delete|remove|erase|unsubscribe|cancel\s+(?:my\s+|your\s+|the\s+)?(?:subscription|membership|account|plan|order)|close\s+(?:my\s+|your\s+|the\s+)?account|deactivate)\b/i],
  ['submit', /^(?:confirm|submit|send|save|publish|invite)\b/i],
];

/**
 * The class of a link that is an action (destructiveLink): 'purchase', 'sign_in' (sign in or out), 'delete' or
 * 'submit'; null for navigation. A link the label rules call an action but no lead names counts as a purchase
 * when PURCHASE matches it, else by COMMIT_OTHER.
 */
export function destructiveLinkClass(label) {
  if (!destructiveLink(label)) return null;
  const text = words(words(label).replace(/^[^\p{L}\p{N}]+/u, ''));
  for (const [kind, pattern] of LINK_LEAD_CLASSES) if (pattern.test(text)) return kind;
  if (PURCHASE.test(text)) return 'purchase';
  const other = text.match(COMMIT_OTHER);
  return other ? commitOtherClass(other[0]) : 'purchase';
}

// Imperative clauses of the host's instruction that ask for something FAI Browser never does. Matched at the start
// of a clause only, after "please"/"then"/"and", so "Do not submit forms" and "report the order total" are not.
const INTENT_LEADS = [
  ['purchase', /^(?:buy|purchase|order|proceed\s+to\s+(?:the\s+)?(?:checkout|payment)|place\s+(?:[\p{L}]+\s+)?orders?|check\s?out|checkout|pay(?:\s+for)?|complete\s+(?:the\s+|my\s+)?(?:purchase|checkout|order|payment)|subscribe|book\s+(?:a|an|the|my|this)\b|reserve)\b/iu],
  ['delete', /^(?:delete|remove|erase|wipe|deactivate|unsubscribe|cancel\s+(?:my\s+|the\s+|this\s+)?(?:subscription|account|order|membership|plan|booking)|close\s+(?:my\s+|the\s+|this\s+)?account)\b/i],
  ['send', /^(?:send|email|post|publish|invite|reply\s+to|message)\b/i],
  ['submit', /^(?:submit|save|confirm|sign\s?up|register|apply\s+(?:for|to))\b/i],
  ['login', /^(?:log\s?in|login|sign\s?in|log\s+me\s+in|sign\s+me\s+in)\b/i],
];
const CLAUSE_SPLIT = /[.;!?\n]+|,?\s+(?:and\s+)?then\s+|,\s+and\s+|\s+and\s+(?=[\p{L}]+\s)/iu;
const CLAUSE_LEAD = /^(?:please|kindly|now|just|then|and|also|go ahead and|can you|could you|i want you to|help me|for me,?)\s+/i;
// "Click Save", "Press the Proceed to checkout button": the control named after the click verb is the clause's verb.
const CLICK_LEAD = /^(?:click|press|tap|hit)\s+(?:on\s+)?(?:the\s+)?/i;

// Objects that make a delete/submit verb harmless: removing a filter, a date restriction or a tag narrows a view,
// submitting a search reads. Used on the instruction clause and on the refused control's label alike.
export const HARMLESS_OBJECT = /\b(?:filters?|search(?:es)?|quer(?:y|ies)|restrictions?|dates?|sort(?:ing)?|tags?|chips?|selections?|criteria|facets?|keywords?|highlight(?:s|ing)?|limits?|ranges?|conditions?|constraints?|refinements?|zoom|columns?|sidebar|banner|notice|popup|overlay)\b/i;
// Objects that keep the verb dangerous even next to a harmless word ("delete the saved search alert account").
const DANGEROUS_OBJECT = /\b(?:account|workspace|project|repo(?:sitory)?|order|cart|items?|products?|subscriptions?|membership|plan|payment|card|messages?|emails?|posts?|comments?|files?|documents?|users?|members?|keys?|tokens?|data|history|profile|forms?|application|invoice)\b/i;
// "Send me the list", "send us the numbers": a request to report, not to send anything from the tab.
const SEND_TO_HOST = /^(?:send|email|message)\s+(?:me|us|back)\b/i;

function harmlessClause(kind, clause) {
  if (kind === 'send') return SEND_TO_HOST.test(clause);
  if (kind !== 'delete' && kind !== 'submit') return false;
  const object = clause.replace(INTENT_LEADS.find(([name]) => name === kind)[1], '');
  return HARMLESS_OBJECT.test(object) && !DANGEROUS_OBJECT.test(object);
}

/**
 * The kind of irreversible action the instruction asks for: `purchase`, `delete`, `send`, `submit`, `login`, or null.
 * Conservative: only an imperative clause that starts with the verb counts, and a verb used in its harmless sense
 * ("remove the filter", "submit a search", "send me the list") does not.
 */
export function commitIntent(instruction) {
  for (const raw of String(instruction ?? '').split(CLAUSE_SPLIT)) {
    let clause = String(raw ?? '').trim();
    for (let i = 0; i < 4 && CLAUSE_LEAD.test(clause); i++) clause = clause.replace(CLAUSE_LEAD, '');
    clause = clause.replace(CLICK_LEAD, '');
    for (const [kind, lead] of INTENT_LEADS) {
      if (lead.test(clause)) {
        if (harmlessClause(kind, clause)) break;
        return kind;
      }
    }
  }
  return null;
}

/** True for a refused control label that is an ordinary view control ("Remove filter", "Submit search", "Search"). */
export function harmlessControlLabel(label) {
  const text = words(label);
  if (/^(?:search|go|find|filter|apply|clear(?:\s+all)?|reset|ok|done|close|×|x)$/i.test(text)) return true;
  return HARMLESS_OBJECT.test(text) && !DANGEROUS_OBJECT.test(text);
}

const LABEL_INTENTS = [
  ['purchase', /\b(?:buy|purchase|pay|order|check ?out|checkout|subscribe|book|reserve)\b/i],
  ['delete', /\b(?:delete|remove|erase|cancel|deactivate|unsubscribe|close\s+account)\b/i],
  ['send', /\b(?:send|post|publish|invite|reply)\b/i],
  ['submit', /\b(?:submit|save|confirm|apply|sign\s?up|register)\b/i],
  ['login', /\b(?:sign\s?in|log\s?in|login)\b/i],
];

/** The intent kinds a blocked control's label would carry out (a "Place order" button: purchase). */
export function labelIntents(label) {
  const text = words(label);
  const out = new Set();
  for (const [kind, pattern] of LABEL_INTENTS) if (pattern.test(text)) out.add(kind);
  if (COMMIT_ACTION.test(text)) out.add('purchase');
  return out;
}

/** The refusal text when no level would allow the action (an addition the user forbade, a page-script block). */
export const REFUSAL_TEXT = 'FAI never purchases, deletes, sends or logs in. Tell the user what to do in the tab.';
/** The refusal text for a purchase below testing (never relayed as a level request). */
export const PURCHASE_REFUSAL_TEXT = 'FAI never purchases outside testing mode. Tell the user what to do in the tab.';
/** The refusal text for a control the user reserved with a `forbid` addition. */
export const FORBID_REFUSAL_TEXT = 'The user reserved this control for themselves. Tell the user what to do in the tab.';

/** Display names of the levels, as the popup shows them (Use stands for reversible and interactive there). */
export const LEVEL_NAMES = Object.freeze({
  'read-only': 'Read', reversible: 'Use (no submit)', interactive: 'Use', full: 'Act', testing: 'Test site',
});

/**
 * The trusted message for a refusal a higher level would lift. `granted` is the user's grant for the tab and
 * `needed` the lowest level that allows the action. When the grant already covers it, the agent asked for too
 * low a mode itself and is told to observe again with that mode instead of asking the user.
 */
export function levelRefusalText({ granted, needed }) {
  const want = LEVEL_NAMES[needed] ?? needed;
  if (LEVEL_ORDER.indexOf(granted) >= LEVEL_ORDER.indexOf(needed)) {
    return `This task needs mode ${needed}, which the user already granted for this tab. Call fai_browser_observe `
      + `with mode "${needed}".`;
  }
  const text = `The user approved ${LEVEL_NAMES[granted] ?? granted} for this tab; this task needs ${want}. Ask them to `
    + `approve the new request at ${want} in FAI Browser (it is preselected).`;
  return needed === 'testing'
    ? `${text} Test site can be granted only on origins the user listed as test sites.`
    : text;
}
const LEVEL_ORDER = Object.keys(LEVEL_NAMES);

const ERROR_STATUSES = new Set([404, 410, 500, 502, 503, 504]);
const ERROR_SEGMENT = [
  [null, /^(?:(?:error|http)\s*)?(404|410|500|502|503|504)(?:\s*(?:error|[-:–]\s*.*))?$/i],
  [404, /^(?:error\s*[-:]?\s*)?(?:(?:the\s+)?(?:page|file|document)\s+)?not\s+found$/i],
  [404, /^(?:(?:the\s+)?page\s+)?(?:does\s*n[o']?t|does\s+not)\s+exist$/i],
  [500, /^internal\s+server\s+error$/i],
  [502, /^bad\s+gateway$/i],
  [503, /^service\s+(?:temporarily\s+)?unavailable$/i],
  [504, /^gateway\s+time-?out$/i],
];
// "HTTP 404" is also the name of an article about the status (Wikipedia's "HTTP 404"): on a document whose HTTP
// status is known to be a success it does not count.
const HTTP_NAMED = /^http\s*\d{3}\b/i;
const TINY_BODY = 400;

function errorStatusOf(text, successful = false) {
  for (const segment of String(text ?? '').split(/\s+[|·–—-]\s+/)) {
    const value = segment.replace(/\s+/g, ' ').trim();
    if (!value || value.length > 80) continue;
    if (successful && HTTP_NAMED.test(value)) continue;
    for (const [status, pattern] of ERROR_SEGMENT) {
      const match = value.match(pattern);
      if (match) return status ?? Number(match[1]);
    }
  }
  return null;
}

/**
 * An HTTP error page: `{ status, source }` or null. Sources, strongest first: the document's HTTP status as the page
 * script read it (`http`, Navigation Timing responseStatus; 404, 410, 500, 502, 503, 504 only), the browser's own
 * error page (`browser`, status null), the title, the first h1, or (only when the HTTP status is unknown, e.g. after
 * a same-document route change) a tiny page whose first line or block is itself an error line ("Error 500"). Body
 * text that merely mentions a status never counts, so an article about HTTP errors is not an error page. `status` is a
 * number (null for `browser`); never page text.
 */
export function errorPageOf(observation) {
  if (!observation) return null;
  const http = observation.httpStatus;
  if (Number.isInteger(http) && ERROR_STATUSES.has(http)) return { status: http, source: 'http' };
  // The browser's own error page (the extension's `browserErrorPage`: an HTTP error sent without a page body, or a
  // network failure). No page script ran there, so the status is unknown.
  if (observation.browserErrorPage === true) return { status: null, source: 'browser' };
  const successful = Number.isInteger(http) && http >= 200 && http < 400;
  const fromTitle = errorStatusOf(observation.title, successful);
  if (fromTitle) return { status: fromTitle, source: 'title' };
  const h1 = (observation.blocks ?? []).find(block => block?.t === 'h1');
  const fromHeading = h1 ? errorStatusOf(h1.text, successful) : null;
  if (fromHeading) return { status: fromHeading, source: 'heading' };
  if (Number.isInteger(http)) return null;
  const text = String(observation.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length >= TINY_BODY) return null;
  const lines = [text.split(/[.!\n]/)[0], ...(observation.blocks ?? []).slice(0, 3).map(block => block?.text)];
  for (const line of lines) {
    const status = errorStatusOf(String(line ?? '').replace(/[.!:]+$/, ''));
    if (status) return { status, source: 'body' };
  }
  return null;
}

/** The observation's consent dialog `{ text, buttons }`, or null. */
export function consentOf(observation) {
  const consent = observation?.consent;
  if (!consent || typeof consent !== 'object' || !Array.isArray(consent.buttons)) return null;
  return consent;
}

const SIGN_IN = /sign in|log in|login/i;

function firstHeading(observation) {
  const block = (observation?.blocks ?? []).find(item => /^h[1-4]$/.test(String(item?.t)));
  return String(block?.text ?? '');
}

/**
 * `{ passwordField, wall }`. A visible password field alone is only a warning; a login wall needs the field AND a
 * sign-in title or first heading (brief decision 2). The page script's `warnings` are honoured as well.
 */
export function loginState(observation) {
  const warnings = Array.isArray(observation?.warnings) ? observation.warnings : [];
  const passwordField = warnings.includes('password_field')
    || (observation?.controls ?? []).some(control => control?.type === 'password' && control.visible !== false);
  const wall = warnings.includes('login_wall')
    || (passwordField && (SIGN_IN.test(String(observation?.title ?? '')) || SIGN_IN.test(firstHeading(observation))));
  return { passwordField, wall };
}

// ---------------------------------------------------------------------------------------------------------------
// Instruction terms and hops
// ---------------------------------------------------------------------------------------------------------------

const TERM_STOPWORDS = new Set(`
after again also back before being both does done each else even every from have here into just like more
most much must only other over page pages please read report same should some such than that their them then there
these they this those through tell what when where which while will with would your link links click open visit
follow find stop order first next last into onto
`.trim().split(/\s+/));
const MAX_TERMS = 24;

/** Lower-cased words of at least 4 characters from the instruction, for the page script's control ordering. */
export function instructionTerms(...texts) {
  const out = [];
  for (const text of texts) {
    for (const match of String(text ?? '').toLowerCase().matchAll(/[\p{L}\p{N}]{4,}/gu)) {
      const word = match[0];
      if (TERM_STOPWORDS.has(word) || out.includes(word)) continue;
      out.push(word);
      if (out.length >= MAX_TERMS) return out;
    }
  }
  return out;
}

const NAV_VERB = /^(?:and\s+)?(?:then\s+)?(?:visit|open|click(?:\s+on)?|follow|go\s+to|navigate\s+to|select|choose|press|tap)\s+/i;
const READ_VERB = /^(?:and\s+)?(?:read|report|find|tell|answer|count|note|stop|look|check|say|return|give|list|get|copy|extract|scroll)\b/i;
const START_PAGE = /^(?:the\s+)?(?:home|start|front|main|landing)(?:\s+page)?$/i;
const NAME_TRIM = /\s+(?:page|link|tab|article|section|button|menu item)$/i;

function cleanName(raw) {
  let name = raw.trim()
    .replace(/^(?:the\s+)?(?:link|button)\s+(?:to|for)\s+/i, '')
    .replace(/[.,;:!?]+$/, '')
    .replace(/\s+in that order$/i, '')
    .replace(/\s+in\s+(?:that|this|the|a new)\s+tab$/i, '')
    .replace(/\s+(?:which|that)\s+opens?\b.*$/i, '')
    .replace(/\s+(?:link|button)\s+to\s+the\s+.*$/i, '');
  name = name.replace(/[.,;:!?]+$/, '').replace(/^the\s+/i, '').replace(NAME_TRIM, '').trim();
  return name.slice(0, 80);
}

/**
 * The pages or links the instruction names, in order: "visit Docs, then the API documentation" → ["Docs", "API
 * documentation"]. A clause counts when it starts with a navigation verb, or is a bare noun phrase right after
 * one ("then the API authentication page"). Start-page mentions ("the home page") are dropped.
 */
export function namedHops(instruction) {
  const hops = [];
  for (const sentence of String(instruction ?? '').split(/(?<=[.!?])\s+/)) {
    const body = sentence.replace(/^from\s+(?:the\s+)?[\w\s-]{1,40}?\s+page,?\s+/i, '');
    const clauses = body.split(/,?\s+and\s+then\s+|,?\s+then\s+|;\s*|,?\s+(?:and\s+)?(?=(?:visit|open|click|follow|go to)\b)|\s+and\s+(?=(?:read|report|find|tell|count|note|stop|answer|return|give)\b)/i);
    let inChain = false;
    for (const clause of clauses) {
      const text = clause.trim();
      if (!text) continue;
      if (NAV_VERB.test(text)) {
        const name = cleanName(text.replace(NAV_VERB, ''));
        inChain = true;
        if (name && !START_PAGE.test(name)) hops.push(name);
      } else if (inChain && !READ_VERB.test(text) && text.split(/\s+/).length <= 8) {
        const name = cleanName(text);
        if (name && !START_PAGE.test(name)) hops.push(name);
      } else {
        inChain = false;
      }
    }
  }
  return hops;
}

const JOIN = /\b(?:use (?:it|that|this|them|the (?:name|value|result|number))|that (?:person|item|product|plan|name|author|value)|the same (?:item|person|plan|product)|(?:then|and) (?:look up|find out|check) (?:what|which|how)|on (?:the )?\w+ page,? (?:then|and) (?:on|in) (?:the )?\w+ page)\b/i;

/** True for "find X on A, use it on B" tasks, which verify far better as two runs (spec 1.2, rule C). */
export function isJoinTask(instruction) {
  return JOIN.test(String(instruction ?? ''));
}

// ---------------------------------------------------------------------------------------------------------------
// Suggested fixes
// ---------------------------------------------------------------------------------------------------------------

const TRACKING_PARAM = /^(?:utm_|fbclid$|gclid$|mc_|ref$|ref_src$)/i;

/**
 * `{ urlIncludes: <final path[?query]> }` from the real final URL, or null when there is nothing distinctive (the
 * site root) or it equals the current expectation. Tracking parameters are dropped.
 */
export function suggestExpectation(url, current) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const params = [...parsed.searchParams].filter(([key]) => !TRACKING_PARAM.test(key));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const path = parsed.pathname === '/' && !query ? '' : `${parsed.pathname}${query}`;
  if (!path) return null;
  const suggestion = { urlIncludes: path.slice(0, 300) };
  if (current && typeof current === 'object' && Object.keys(current).length === 1
    && current.urlIncludes === suggestion.urlIncludes) return null;
  return suggestion;
}

