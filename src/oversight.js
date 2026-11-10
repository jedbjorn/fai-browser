// Mechanical oversight helpers (docs/design/OVERSIGHT-SPEC.md sections 1-3): thresholds, the rung 0 page classification
// (consent dialog, login wall), instruction hops and the ready-to-send `suggested` fixes. Pure, synchronous and
// model-free. Nothing here returns page text inside a trusted field: suggestions are built from the host's own
// instruction and question and from URL paths only.
import {
  COMMIT_ACTION, COMMIT_OTHER, DANGEROUS, DELETE_WORDS, PURCHASE, SIGN_IN_WORDS, SUBMIT_WORDS, commitOtherClass, labelSpellings,
} from './guardrails.js';

/** One config object for every gate, so a later pass can tune them together (config.json `thresholds`). */
export const DEFAULT_THRESHOLDS = Object.freeze({
  linkFloor: 0, // click confidence below which a link choice is returned to the host (0 = never)
  controlFloor: 0.5, // the same for buttons, selects and fills (reversible mode)
  doneThreshold: 0.5, // done at or above which a passing expectation completes the run
  strongDone: 0.8, // done at or above which a failing expectation is re-observed; a mismatch on handoff/done or twice
  answerConfirm: 0.8, // top candidate confidence for an auto-confirmed verdict.answer
  answerMargin: 0.5, // and its margin over the second candidate
  // Step lists at read-only and reversible: a {{answer:N}} placeholder may also fill from step N's top candidate when
  // it is at least placeholderFloor and leads the second by placeholderMargin (and passes every fill check); the
  // receipt marks it stepResults[N].answerSource "likely", never as a confirmed answer (src/steps.js likelyValue).
  placeholderFloor: 0.35,
  placeholderMargin: 0.15,
  // Reversible mode: the provider's `commit` guard at or above which a chosen button/select/fill (or a handoff while
  // one is offered) is refused (guard:commit_veto, needs_user/refused_action). The daemon lets a run lower it, never
  // raise it. 0.7, not the 0.85 of the other guards: in bench/jev-eval the true commits scored 0.83-0.96 depending on
  // the policy wording and the harmless generic controls at most 0.49 (docs/design/PROPOSAL.md "Guardrail pass").
  commitVeto: 0.7,
  // In-call retries (run option `retry`): a link choice, or a handoff, whose probability leads the best other link or
  // control by less than this gets one second-opinion decide with the options reordered. A choice below its floor
  // (linkFloor, controlFloor/minConfidence) gets one whatever the gap.
  secondOpinionMargin: 0.2,
});

export const THRESHOLD_NAMES = Object.freeze(Object.keys(DEFAULT_THRESHOLDS));

/**
 * The thresholds for a run: defaults, then `options.thresholds`, then the older top-level names (`doneThreshold`,
 * and `minConfidence` as an alias for `controlFloor`). Returns `{ thresholds, explicit }` where `explicit` lists
 * the names the caller set (a floor set explicitly also gates choices that report no confidence).
 */
export function resolveThresholds(options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS };
  const explicit = new Set();
  const given = options.thresholds;
  if (given !== undefined && given !== null) {
    if (typeof given !== 'object' || Array.isArray(given)) throw new TypeError('thresholds must be an object');
    for (const [name, value] of Object.entries(given)) {
      if (!THRESHOLD_NAMES.includes(name)) throw new TypeError(`Unknown threshold "${name}"`);
      if (value === undefined) continue;
      thresholds[name] = value;
      explicit.add(name);
    }
  }
  if (options.doneThreshold !== undefined) {
    thresholds.doneThreshold = options.doneThreshold;
    explicit.add('doneThreshold');
  }
  if (options.minConfidence !== undefined) {
    thresholds.controlFloor = options.minConfidence;
    explicit.add('controlFloor');
  }
  for (const name of THRESHOLD_NAMES) {
    const value = thresholds[name];
    if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
      const label = name === 'controlFloor' && options.minConfidence !== undefined ? 'minConfidence' : name;
      throw new RangeError(`${label} must be a number from 0 to 1`);
    }
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
const CONSENT_TEXT_LIMIT = 120;
const NOT_REJECT = /non[- ]?(essential|necessary)/i;
const ACCEPT = CONSENT_ACCEPT;
const NECESSARY_ONLY = /^(?:accept|allow|agree(?: to)?)\s+(?:only\s+)?(?:strictly\s+)?(?:necessary|essential|required)(?:\s+cookies)?(?:\s+only)?[.!]?$/i;

// COMMIT_ACTION and DANGEROUS (composed) and their split sets live in src/guardrails.js, the guardrail policy's core
// (the single source of truth for the mechanical check and the Jev policy text); re-exported here for the existing
// importers.
export { COMMIT_ACTION, COMMIT_OTHER, DANGEROUS, DELETE_WORDS, PURCHASE, SIGN_IN_WORDS, SUBMIT_WORDS };

/** The reject label rule with the page script's safety exceptions. */
export function isRejectLabel(label) {
  const text = String(label ?? '');
  const accepting = ACCEPT.test(text) && !CONSENT_WITHOUT_ACCEPT.test(text);
  const necessaryOnly = NECESSARY_ONLY.test(text.trim()) && /\bonly\b/i.test(text);
  return CONSENT_REJECT.test(text) && !NOT_REJECT.test(text) && !labelSpellings(text).some(text => COMMIT_ACTION.test(text))
    && (!accepting || necessaryOnly);
}

// ---------------------------------------------------------------------------------------------------------------
// Destructive links, refused tasks and error pages (machinery pass)
// ---------------------------------------------------------------------------------------------------------------

// A link label that starts with one of these verbs does something rather than going somewhere: it is never offered.
const LINK_DANGER_LEAD = /^(?:delete|remove|erase|purchase|buy|pay|place\s+(?:an?\s+|the\s+|your\s+|my\s+)?order|order\s+now|check\s?out|proceed\s+to\s+check\s?out|confirm|submit|send|save|publish|invite|unsubscribe|subscribe|cancel\s+(?:my\s+|your\s+|the\s+)?(?:subscription|membership|account|plan|order)|close\s+(?:my\s+|your\s+|the\s+)?account|deactivate|sign\s?(?:in|out)|log\s?(?:in|out)|login|logout|signout)\b/i;
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
const LINK_LEAD_CLASSES = [
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

const NAV_SHAPE = /^[\p{L}\p{N}][\p{L}\p{N} &'’·:,.()/-]*$/u;
const NAV_NOISE = /\b(?:agent|assistant|ai|ignore|instructions?|must|required|requires?|urgent|immediately|first|now|click|press|tap|verify|confirm|proceed|allow|grant|enable|download|install|run)\b/i;

/**
 * A plain navigation label (the only kind of decide option kept while the injection guard is at or above the veto):
 * at most 4 words, letters, digits and light punctuation, and no action or instruction word anywhere.
 */
export function plainNavLabel(label) {
  const text = words(label);
  if (!text || text.split(' ').length > MAX_GATED_LINK_WORDS || !NAV_SHAPE.test(text)) return false;
  return !DANGEROUS.test(text) && !COMMIT_ACTION.test(text) && !LINK_DANGER_LEAD.test(text) && !NAV_NOISE.test(text)
    && !/\b(?:delete|remove|unsubscribe|cancel|sign ?out|log ?out)\b/i.test(text);
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
 * low a mode itself and is told to run again with that mode instead of asking the user.
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

/**
 * The consent dialog's reject / necessary-only buttons as offered actions (no ids yet): `kind: "reject"` from the
 * page script, or, without kinds, a label matching CONSENT_REJECT minus the page script's exceptions.
 */
export function consentRejectActions(consent) {
  const actions = [];
  const seen = new Set();
  for (const button of consent?.buttons ?? []) {
    if (button?.id === undefined || button.id === null) continue;
    const label = String(button.label ?? '').replace(/\s+/g, ' ').trim();
    // The page script's kind is authoritative (it also excludes "non-essential" and "allow all and necessary");
    // the label rule is only a fallback for observations without kinds.
    if (button.kind !== undefined ? button.kind !== 'reject' : !isRejectLabel(label)) continue;
    // Defence in depth for an older page script: a commit label is never a reject, whatever its kind says.
    if (labelSpellings(label).some(text => COMMIT_ACTION.test(text))) continue;
    const target = String(button.id);
    if (seen.has(target)) continue;
    seen.add(target);
    actions.push({
      type: 'click',
      target,
      role: 'button',
      label: label.slice(0, 180),
      consent: true,
      description: `Dismiss the cookie dialog with button ${target}: ${label.slice(0, 180)}`,
    });
  }
  return actions;
}

/**
 * The consent dialog's accept buttons as offered actions (no ids yet), for a level with `consent_accept` (full and
 * above) when the dialog has no usable reject button: `kind: "accept"` from the page script, or, without kinds, a
 * label matching CONSENT_ACCEPT that is not a reject. A commit label ("Accept and subscribe") is never offered.
 */
export function consentAcceptActions(consent) {
  const actions = [];
  const seen = new Set();
  for (const button of consent?.buttons ?? []) {
    if (button?.id === undefined || button.id === null) continue;
    const label = String(button.label ?? '').replace(/\s+/g, ' ').trim();
    const accepting = button.kind !== undefined ? button.kind === 'accept'
      : ACCEPT.test(label) && !CONSENT_WITHOUT_ACCEPT.test(label) && !isRejectLabel(label);
    if (!accepting) continue;
    if (labelSpellings(label).some(text => COMMIT_ACTION.test(text))) continue;
    const target = String(button.id);
    if (seen.has(target)) continue;
    seen.add(target);
    actions.push({
      type: 'click',
      target,
      role: 'button',
      label: label.slice(0, 180),
      consent: true,
      accept: true,
      description: `Accept the cookie dialog with button ${target}: ${label.slice(0, 180)}`,
    });
  }
  return actions;
}

/** Identity of a consent button across observations (ids are renumbered): its normalized label. */
export function consentKey(action) {
  return String(action?.label ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The origin a consent wall on its own host (consent.google.com, consent.youtube.com, any consent.* host) continues
 * to once answered: its `continue` parameter's origin, or null. Built from the URL, never from page text.
 */
export function consentContinueOrigin(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^consent\./i.test(parsed.hostname)) return null;
  const next = parsed.searchParams.get('continue');
  if (!next) return null;
  try {
    const target = new URL(next);
    return /^https?:$/.test(target.protocol) ? target.origin : null;
  } catch {
    return null;
  }
}

/** The dialog text for the host, at most 120 characters. Untrusted page text. */
export function consentText(consent) {
  return String(consent?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, CONSENT_TEXT_LIMIT);
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

function tokens(text) {
  return String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]{3,}|\d+/gu) ?? [];
}

/** True when at least two thirds of the hop name's words appear in one of the visited haystacks. */
function visitedHop(name, haystacks) {
  const words = tokens(name).filter(word => !TERM_STOPWORDS.has(word));
  if (!words.length) return true;
  return haystacks.some(hay => words.filter(word => hay.includes(word)).length * 3 >= words.length * 2);
}

/**
 * The hops still to visit: those after the last named hop the run reached. `visited` are lower-cased strings that
 * describe pages the run saw (step labels, titles, URL paths); they are compared, never echoed.
 */
export function remainingHops(hops, visited) {
  let last = -1;
  hops.forEach((hop, index) => {
    if (visitedHop(hop, visited)) last = index;
  });
  return hops.slice(last + 1);
}

// Short function words that never identify a hop ("through the pages", "Terms of the service").
const HOP_STOPWORDS = new Set('the and for you see its are was all any our via per but not out has can get'.split(' '));

/** The words that identify a hop: its tokens minus stopwords, or all of them when nothing else is left ("Next"). */
function hopWords(name) {
  const all = tokens(name);
  const kept = all.filter(word => !TERM_STOPWORDS.has(word) && !HOP_STOPWORDS.has(word));
  return kept.length ? kept : all;
}

/**
 * Whether `hay` (a lower-cased label, title or URL path) holds the hop's words: at least two thirds of them, each as a
 * whole word or a word prefix ("plan" in "plans", never "art" in "start"; numbers exactly).
 */
function hopMatches(words, hay) {
  if (!words.length) return true;
  const hayWords = tokens(hay);
  const hit = word => hayWords.some(candidate => candidate === word
    || (!/^\d+$/.test(word) && candidate.startsWith(word)));
  return words.filter(hit).length * 3 >= words.length * 2;
}

/**
 * True when every named hop is matched by one of `haystacks` (lower-cased labels, page titles or URL paths), in any
 * order (notePrepass: is the start page the last named page). An empty haystack list matches nothing.
 */
export function hopsDone(hops, haystacks) {
  if (!haystacks.length) return false;
  return hops.every(name => haystacks.some(hay => hopMatches(hopWords(name), hay)));
}

/**
 * True when the run's actions did every named hop, in order, one action per hop: `events` are the run's own
 * actions in order, each a list of lower-cased texts (the action's label, and the title and path of the page it
 * landed on). Hop i must match an action after the one that matched hop i-1, so "Click Next, then Next" needs two
 * Next clicks and "Open Settings, then Billing" is not done by a Settings page whose title mentions billing.
 */
export function hopsDoneInOrder(hops, events) {
  let next = 0;
  for (const name of hops) {
    const words = hopWords(name);
    let found = -1;
    for (let index = next; index < events.length && found < 0; index++) {
      if (events[index].some(hay => hopMatches(words, hay))) found = index;
    }
    if (found < 0) return false;
    next = found + 1;
  }
  return true;
}

// A purpose clause names the click's result, not another action: "click 'Date grid' to open the date grid".
const PURPOSE = /\s+(?:in order\s+)?to\s+(?:open|show|see|view|reveal|expand|display|load)\b[^,.;!?]*/gi;

/** namedHops for hop completion (src/runtime.js earlyEnd): the hops the instruction's actions name, purpose clauses left out. */
export function actionHops(instruction) {
  return namedHops(String(instruction ?? '').replace(PURPOSE, ''));
}

// An instruction that loops or scans ("every page", "each day", "until", "all 13 pages") is never a bounded imperative.
// Repeat counts ("twice", "3 times", "again") and keep/while/scan/browse wording are open-ended for this purpose too.
export const OPEN_ENDED = /\b(?:each|every|until|repeat(?:edly)?|one by one|in turn|while|keep|as long as|twice|thrice|again|\d+\s+times|(?:two|three|four|five)\s+times|scan|browse|through\s+(?:all|the|every)|all\s+(?:the\s+)?(?:\d+\s+)?(?:pages|days|items|results|rows|steps|entries|products))\b/i;
// A leading place phrase before the verb: "On the Google Flights results page, click ...".
const PLACE_PREFIX = /^(?:on|in|from|at)\s+[^,.;]{1,80},\s*/i;

/**
 * The named targets of a bounded imperative instruction ("Click the 'Date grid' button.", "Open Pricing, then
 * Enterprise."): it starts with an action verb (after an optional place phrase), names one or two clicks or pages
 * (namedHops) and does not loop or scan. Returns the hop names, or null for any other instruction. A run with such an
 * instruction ends as soon as every named target was clicked or reached and its expectation passes (src/runtime.js).
 */
export function boundedImperative(instruction) {
  const text = String(instruction ?? '').trim();
  if (!text || OPEN_ENDED.test(text)) return null;
  if (!NAV_VERB.test(text.replace(PLACE_PREFIX, ''))) return null;
  const hops = actionHops(text);
  return hops.length >= 1 && hops.length <= 2 ? hops : null;
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

function listHops(hops) {
  if (hops.length === 1) return `visit ${hops[0]}`;
  return `visit ${hops.slice(0, -1).join(', then ')}, then ${hops.at(-1)}`;
}

/**
 * A sharper instruction for a re-run from the current page: the unvisited named hops, then the question, then the
 * read-only reminder. Built only from the host's instruction and question. Null when nothing is left to name.
 */
export function suggestInstruction({ hops, remaining, question, readOnly = true }) {
  if (!remaining.length) return null;
  const parts = [`From the current page, ${listHops(remaining)}, in that order.`];
  const ask = String(question ?? '').replace(/\s+/g, ' ').trim();
  if (ask) parts.push(`Read the answer to: ${ask.slice(0, 300)}${/[.?!]$/.test(ask) ? '' : '.'} Stop there.`);
  else parts.push(`Stop on the ${remaining.at(-1)} page.`);
  if (readOnly) parts.push('Do not type into or submit forms.');
  return parts.join(' ').slice(0, 1000);
}

/** maxActions for a re-run: about two per remaining click, at least 3, at most 8. */
export function suggestMaxActions(remaining) {
  return Math.min(8, Math.max(3, 2 * remaining));
}
