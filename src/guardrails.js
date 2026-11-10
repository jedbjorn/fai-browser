// Guardrail policy (docs/design/PROPOSAL.md "Guardrail pass", docs/proposals/configurable-guardrails.md): the single source of
// truth for what FAI Browser does on the user's behalf at each permission level: the mechanical check, label patterns
// applied in the runtime (legalActions, blockedControls, refusal receipts) and in extension/page.js (risk class +
// dispatch block), before and independent of any model.
//
// Levels (what the user grants in the extension popup) are fixed presets of capabilities (what the code checks):
//
//   read-only    navigate
//   reversible   + controls (buttons, selects, fills of supplied text)
//   interactive  + submit_safe (search/filter/sort/apply/show/next/load-more submits, no password/payment forms)
//   full         + submit, delete, consent_accept
//   testing      + sign_in, purchase (only on origins the user listed as test environments, granted in the popup)
//
// A level is a ceiling: the run's mode is clamped to the user's grant (clampLevel). Nothing from the agent, the page,
// a run `policy` or config.json can raise a capability; `purchase` exists only at `testing`, and `testing` is granted
// only by the user in the extension. `additions` (per request: the `policy` run field; per install: config.json
// `guardrails`) can only add forbidden control labels, at every level including testing. Additions are plain phrases,
// validated here, escaped and word-bounded when compiled; the extension receives the normalized phrases (strings,
// never RegExp source) and compiles them with the identical forbidPattern() below, while keeping its own hard-coded
// block, because page content is untrusted and the worker never trusts the page to classify itself.
//
// Mirrored in extension/page.js (byte-identical literals; String() of each constant is compared by drift tests):
//   PURCHASE, COMMIT_OTHER, SUBMIT_WORDS, DELETE_WORDS, SIGN_IN_WORDS, SAFE_SUBMIT, PAYMENT_AUTOCOMPLETE,
//   PAYMENT_FIELD, AMBIGUOUS_SUBMIT, AMBIGUOUS_PURCHASE, plus the functions forbidPattern, normalizeLabel,
//   labelSpellings and labelTier.
// COMMIT_ACTION (PURCHASE | COMMIT_OTHER) and DANGEROUS (every word of the three *_WORDS lists plus purchase, buy,
// pay) stay exported as composed compatibility patterns; the level checks key off the split sets.

/**
 * Purchases: pay, buy, order, check out, book, reserve, subscribe, upgrade or renew a plan, start a trial, move
 * money, donate, bid, add a payment method. Never allowed below `testing`. Ambiguous words ("Order", "Book",
 * "Reserve", "Transfer", "Check out", "Bid", "Renew", "Upgrade") count only as the whole label or followed by "now"
 * or an article, so "Bookmarks", "Book list", "Order history", "Bid history" and "Upgrade guide" do not. "Add to
 * cart" commits nothing and is an ordinary control. A consent button with such a label ("Reject and subscribe" on a
 * pay-or-consent wall) is never a reject button.
 */
export const PURCHASE = /^(?:order|book|reserve|transfer|check ?out|bid|renew|upgrade|pre-?order)(?:\s+now)?[\s.!]*$|\b(?:place\s+(?:an?\s+|the\s+|your\s+|my\s+)?(?:order|bid)|order\s+now|pre-?order|checkout|(?:proceed|continue|go)\s+to\s+(?:check ?out|payment)|(?:book|reserve)\s+(?:now|(?:this|it|a|an|the|your|my)\b)|pay(?:\s+now)?|buy|purchase|subscribe|donate|bid\s+now|make\s+(?:a\s+)?(?:payment|donation)|(?:complete|confirm|submit|finali[sz]e)\s+(?:(?:my|your|the|this)\s+)?(?:order|purchase|payment|booking|reservation|subscription|donation|bid|transfer)|upgrade(?:\s+(?:your|my))?\s+plan|upgrade\s+(?:now|to\s+(?:pro|premium|plus|business|enterprise|team|paid))|renew\s+(?:now|(?:(?:my|your|the)\s+)?(?:subscription|membership|plan))|start\s+(?:a\s+|your\s+|my\s+)?(?:free\s+)?trial|transfer\s+(?:now|money|funds)|withdraw|send\s+(?:money|payment)|add\s+(?:a\s+)?(?:new\s+)?(?:payment\s+method|(?:credit|debit)\s+card))\b/i;

/**
 * Commits that are not purchases: applications ("Apply now", "Apply for this job", "Apply changes"; plain "Apply"
 * and "Apply filters" do not count) and cancellations of a subscription, membership, account, plan or order. An
 * "apply" label needs `submit`, a "cancel" label needs `delete` (both from `full`); see commitOtherClass().
 */
export const COMMIT_OTHER = /\b(?:apply\s+(?:now|for|changes)|cancel\s+(?:(?:my|your|the)\s+)?(?:subscription|membership|account|plan|order))\b/i;

/**
 * Submissions and messages (buttons and other non-link controls): need `submit` (full). "Save" followed by an amount
 * ("Save 30%", "Save €20", "save up to 40%", "Two years (save 30%)", "Save 20 percent") is discount wording, not a
 * save: an amount is a currency sign before a number, or a number followed by %, "percent", a currency sign or code.
 * A plain "Save", "Save changes", "Save draft", "Save card" or "Save 2 files" stays a submit.
 */
export const SUBMIT_WORDS = /\b(save(?!\s+(?:up\s+to\s+|over\s+|an\s+extra\s+|extra\s+)?(?:[$€£¥₹]\s?\d|\d[\d.,]*\s?(?:%|percent\b|[$€£¥₹]|(?:usd|eur|gbp)\b)))|submit|send|confirm|invite|publish)\b/i;

/** Deletions (buttons and other non-link controls): need `delete` (full). */
export const DELETE_WORDS = /\b(delete|remove)\b/i;

/** Sign-in controls: need `sign_in` (testing). */
export const SIGN_IN_WORDS = /\b(sign ?in|log ?in)\b/i;

/**
 * Form-submit labels that only read: search, filter, sort, apply, show, next, load more. A page-script `submit` risk
 * on a control with such a label is allowed with `submit_safe` (interactive) when the page has no password or
 * payment field.
 */
export const SAFE_SUBMIT = /^(?:search(?:\s+(?:for\s+)?[\p{L}\p{N}'-]+)?|find|go|filters?|apply(?:\s+filters?)?|sort(?:\s+results)?|refine(?:\s+search)?|show(?:\s+(?:more|all|results))?|(?:see|view|load)\s+more|more\s+results|update\s+results|next(?:\s+page)?|prev(?:ious)?(?:\s+page)?)[\s.!]*$/iu;

/** An input whose `autocomplete` token list names a payment field (cc-number, cc-exp, cc-csc, billing cc-name...). */
export const PAYMENT_AUTOCOMPLETE = /(?:^|\s)cc-[a-z-]+(?:\s|$)/i;

/** A field name, id or label for a card number, expiry, security code or IBAN ("cardnumber", "cc_exp", "CVC"). */
export const PAYMENT_FIELD = /(?:^|[^a-z])(?:card[\s_.-]*(?:number|num|no)|cc[\s_.-]*(?:number|num|exp\w*|csc|cvc|cvv)|(?:credit|debit)[\s_.-]*card|card[\s_.-]*(?:expir\w*|exp)|expir(?:y|ation)[\s_.-]*(?:date|month|year)|exp[\s_.-]*(?:date|month|year)|cvc|cvv2?|csc|card[\s_.-]*(?:security|verification)[\s_.-]*code|security[\s_.-]*code|iban|kartennummer|n[uú]mero[\s_.-]*de[\s_.-]*(?:la[\s_.-]*)?tarjeta)(?![a-z])/i;

// The Approve gate (docs/REFERENCE.md "Approve gate"): classes of controls an agent may click only after the user
// clicks Approve once for that one click in the extension. Byte copies in extension/page.js (drift check), which
// applies them at observation and again at dispatch. The gate classes:
//   purchase  a PURCHASE label or payment form submit, and on a purchase page (purchasePage) a button or submit inside
//             the checkout region (a form with a payment field, a container named checkout, payment or billing) or
//             one whose label commits (COMMIT_LIKE: pay, place order, confirm, continue, next, submit, buy, ...),
//             except a back-out (BACK_OUT), a quantity stepper (STEPPER) or a consent reject; navigation, search
//             forms and links stay as they are;
//   delete    a button in a dialog whose text reads like a commit (COMMIT_DIALOG) that does not back out;
//   secret    a control that makes, shows, copies or revokes a credential (SECRET_ACTION), or an eye toggle next to a
//             password or secret field (page.js only: it needs the DOM);
//   submit / delete above the granted level (the level classes of SUBMIT_WORDS, DELETE_WORDS, COMMIT_OTHER).

/** A control that makes, shows, copies or revokes a credential: "Show password", "Create API key", "Roll secret". */
export const SECRET_ACTION = /\b(?:generate|create|new|regenerate|roll|rotate|revoke|reveal|show|view|copy|unmask)(?:\s+[\p{L}\p{N}-]+){0,3}?\s+(?:keys?|tokens?|secrets?|passwords?|credentials?|(?:recovery|backup)\s+codes?)\b/iu;

/** Dialog text that says the button in it commits: are you sure, cannot be undone, permanently, delete, remove, cancel a plan. */
export const COMMIT_DIALOG = /\b(?:are you sure|cannot be undone|can(?:'|’)?t be undone|permanently|delete|remove|cancel\s+(?:(?:my|your|the|this)\s+)?(?:subscription|account|membership|plan))\b/i;

/** A label that only backs out of a dialog or page: never a commit, never a purchase. */
export const BACK_OUT = /^(?:cancel|no|no,? thanks|keep(?:\s+\p{L}+){0,2}|go back|back|close|never ?mind|not now|dismiss|stay|return|x|×|✕|✖)[\s.!]*$/iu;

/** A quantity stepper ("+", "−", "Increase quantity", "Qty"): never a purchase on a purchase page. */
export const STEPPER = /^(?:[+−–-]\s*\d*|(?:increase|decrease|increment|decrement)(?:\s+quantity)?|plus|minus)$|\b(?:quantity|qty)\b/iu;

/**
 * A purchase page's path: a /checkout, /payment, /billing, /order, /subscribe, /upgrade or /plans segment, alone or as
 * a file stem (/billing.html, /checkout.php).
 */
export const PURCHASE_PATH = /\/(?:checkout|payment|payments|billing|order|subscribe|upgrade|plans)(?:\.[a-z0-9]{1,6})?(?=[/?#;]|$)/i;

/**
 * A button label that commits on a purchase page: pay, place order, confirm, complete, continue, next, submit, buy, ...
 * unless it names an account detail it acts on ("Confirm email address", "Continue with email").
 */
export const COMMIT_LIKE = /\b(?:pay|place\s+(?:(?:an?|the|your|my)\s+)?order|confirm|complete|continue|next|submit|buy|subscribe|purchase|check\s?out|proceed|finish)\b(?!\s+(?:(?:with|your|my|the|this)\s+)?(?:e-?mail|address|phone|password|profile|settings|identity|name)\b)/i;

/** A line that starts with "Total", "Order summary", "Amount due" or the like, with a currency amount close after it. */
export const PURCHASE_TOTAL = /(?:^|\n)[ \t]*(?:order\s+summary|(?:order\s+|grand\s+|estimated\s+)?total(?:\s+due)?|amount\s+due|due\s+today)\b[\s\S]{0,60}?(?:[$€£¥₹]\s?\d|\b(?:usd|eur|gbp)\s?\d|\b\d[\d.,]*\s?(?:[$€£¥₹]|(?:usd|eur|gbp)\b))/i;

/** Whether a page is a purchase page: a payment field on it, a purchase path, or a total with an amount in its text. */
export function purchasePage({ path, text, payment } = {}) {
  if (payment) return true;
  if (typeof path === 'string' && PURCHASE_PATH.test(path)) return true;
  return typeof text === 'string' && PURCHASE_TOTAL.test(text.slice(0, 20_000));
}

/** Whether a button label on a purchase page stays out of the purchase class (a back-out or a quantity stepper). */
export function purchaseExempt(label) {
  return labelSpellings(label).some(text => BACK_OUT.test(text) || STEPPER.test(text));
}

/**
 * Whether a button on a purchase page is a purchase: inside the checkout region (`checkout`, the page script's DOM
 * check), or a commit-like label (COMMIT_LIKE); never in navigation or a search form (`navigation`), never a back-out
 * or a stepper.
 */
export function purchaseControl(label, { checkout = false, navigation = false } = {}) {
  if (navigation || purchaseExempt(label)) return false;
  return checkout || labelSpellings(label).some(text => COMMIT_LIKE.test(text));
}

/** Whether a label names a credential action (SECRET_ACTION) in either safety spelling. */
export function secretAction(label) {
  return labelSpellings(label).some(text => SECRET_ACTION.test(text));
}

/** The gate classes, in priority order, and the capability each one stands in for (secret: none, it asks anyway). */
export const GATE_CLASSES = Object.freeze(['purchase', 'secret', 'delete', 'submit']);

// The intent tiers (labelTier): which refused labels are ambiguous (page.js marks such controls `ambiguous`, as a
// diagnostic only; nothing lifts the block). The ambiguous tier is narrow.
//
//   ambiguous  every class the label trips comes from these words alone, in either safety spelling:
//              SUBMIT_WORDS save, confirm, send, invite, publish (AMBIGUOUS_SUBMIT; never "submit");
//              PURCHASE order, book, reserve, upgrade as the whole label, and book or reserve before a, an or the
//              ("Book a demo", "Reserve a table") (AMBIGUOUS_PURCHASE).
//   hard       everything else that trips a class, never cleared: buy, pay, purchase, check out, place order,
//              subscribe, donate, start a trial, add a payment method, send money, withdraw, transfer, bid, renew,
//              any word followed by "now" ("Book now", "Order now"), book or reserve before this, it, your or my
//              (the item already chosen), complete / confirm / submit an order, purchase, payment, booking or
//              reservation, "submit", every COMMIT_OTHER, DELETE_WORDS and SIGN_IN_WORDS label, a flagged label
//              naming a card, payment, billing, bank, wallet or IBAN ("Save card"), and a label holding a hard word
//              next to an ambiguous one ("Book a demo and pay", "Confirm purchase").
// Bare "Bid", "Transfer" and "Renew" are hard although PURCHASE matches them only as the whole label: on their own
// they are most often the commit itself. Labels are not the only condition: the runtime clears only a button or
// option with no page-script risk but its label (no form submit, payment or password form), on a page without
// payment or password fields, never a label the user forbade (runtime.js intentEligible, intentVerdict), and the
// page script re-checks the tier of every name of the element before it dispatches a cleared click.

/** The ambiguous SUBMIT_WORDS words (the intent tier); `g` for replace only. */
export const AMBIGUOUS_SUBMIT = /\b(?:save|confirm|send|invite|publish)\b/gi;

/** The ambiguous PURCHASE forms (the intent tier); `g` for replace only. */
export const AMBIGUOUS_PURCHASE = /^(?:order|book|reserve|upgrade)[\s.!]*$|\b(?:book|reserve)\s+(?:a|an|the)\b/gi;

/**
 * The intent tier of a label: 'ambiguous' when it trips only purchase or submit and every match comes from the
 * ambiguous words (with them blanked out, neither PURCHASE nor SUBMIT_WORDS matches), 'hard' when any spelling trips
 * a class beyond them, null when it trips no core class. Byte copy in extension/page.js (drift check).
 */
export function labelTier(label) {
  let flagged = false;
  for (const text of labelSpellings(label)) {
    if (SIGN_IN_WORDS.test(text) || DELETE_WORDS.test(text) || COMMIT_OTHER.test(text)) return 'hard';
    // A label naming a payment object ("Save card", "Confirm billing details") is about money whatever its verb.
    const purchase = PURCHASE.test(text);
    const submit = SUBMIT_WORDS.test(text);
    if (!purchase && !submit) continue;
    if (/\b(?:cards?|payments?|billing|bank|wallet|iban)\b/i.test(text)) return 'hard';
    flagged = true;
    if (purchase && PURCHASE.test(text.replace(AMBIGUOUS_PURCHASE, ' '))) return 'hard';
    if (submit && SUBMIT_WORDS.test(text.replace(AMBIGUOUS_SUBMIT, ' '))) return 'hard';
  }
  return flagged ? 'ambiguous' : null;
}

/**
 * Commit actions, composed (compatibility): PURCHASE or COMMIT_OTHER. Used where any commit counts (the reject-label
 * exception for consent buttons, destructive links, labelIntents).
 */
export const COMMIT_ACTION = new RegExp(`${PURCHASE.source}|${COMMIT_OTHER.source}`, 'i');

/**
 * Label heuristic for submissions and account changes, composed (compatibility): every SUBMIT_WORDS, DELETE_WORDS and
 * SIGN_IN_WORDS word plus purchase, buy and pay (which PURCHASE covers), with the same discount exception for "save".
 * Links go through destructiveLink in
 * src/oversight.js. The level checks use the split lists.
 */
export const DANGEROUS = /\b(save(?!\s+(?:up\s+to\s+|over\s+|an\s+extra\s+|extra\s+)?(?:[$€£¥₹]\s?\d|\d[\d.,]*\s?(?:%|percent\b|[$€£¥₹]|(?:usd|eur|gbp)\b)))|submit|send|purchase|buy|pay|delete|remove|confirm|invite|publish|sign ?in|log ?in)\b/i;

// ---------------------------------------------------------------------------------------------------------------
// Levels and capabilities
// ---------------------------------------------------------------------------------------------------------------

/** Permission levels, lowest first. A level is a ceiling; see clampLevel(). */
export const LEVELS = Object.freeze(['read-only', 'reversible', 'interactive', 'full', 'testing']);

/** Every capability, in the order of the design table. */
export const CAPABILITY_NAMES = Object.freeze(['navigate', 'controls', 'submit_safe', 'submit', 'delete',
  'consent_accept', 'sign_in', 'purchase']);

/** The capabilities of each level (frozen arrays). */
export const CAPABILITIES = Object.freeze({
  'read-only': Object.freeze(['navigate']),
  reversible: Object.freeze(['navigate', 'controls']),
  interactive: Object.freeze(['navigate', 'controls', 'submit_safe']),
  full: Object.freeze(['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept']),
  testing: Object.freeze([...CAPABILITY_NAMES]),
});

/** The level a client gets when it names none. */
export const DEFAULT_LEVEL = 'read-only';

/** True for one of LEVELS. */
export function isLevel(value) {
  return typeof value === 'string' && LEVELS.includes(value);
}

/** The rank of a level (0 = read-only); -1 for anything else. */
export function levelRank(level) {
  return isLevel(level) ? LEVELS.indexOf(level) : -1;
}

/** The capability set of a level, as a new Set. Anything but a level fails closed to read-only. */
export function capabilitiesOf(level) {
  return new Set(CAPABILITIES[isLevel(level) ? level : DEFAULT_LEVEL]);
}

/**
 * The effective level: the lower of what was requested and what the user granted. An unknown or missing grant
 * fails closed to read-only; an unknown request is read-only. Never higher than `granted`.
 */
export function clampLevel(requested, granted) {
  const want = levelRank(requested);
  const ceiling = levelRank(granted);
  if (want < 0 || ceiling < 0) return DEFAULT_LEVEL;
  return LEVELS[Math.min(want, ceiling)];
}

/** The lowest level that has `capability`; null for an unknown name. */
export function levelFor(capability) {
  return LEVELS.find(level => CAPABILITIES[level].includes(capability)) ?? null;
}

/** The capability a label class needs (`forbid` needs one nothing grants). */
export const CLASS_CAPABILITY = Object.freeze({
  purchase: 'purchase', submit: 'submit', delete: 'delete', sign_in: 'sign_in', forbid: null,
});

/** The class of a COMMIT_OTHER label: `delete` for a cancellation, `submit` for an application. */
export function commitOtherClass(text) {
  return /\bcancel\b/i.test(String(text ?? '')) ? 'delete' : 'submit';
}

/**
 * True for a payment input: an `autocomplete` cc-* token, or a name, id, label or placeholder for a card number,
 * expiry, security code or IBAN. Takes an observation control (or any object with those string fields).
 */
export function paymentField(control) {
  if (!control || typeof control !== 'object') return false;
  if (typeof control.autocomplete === 'string' && PAYMENT_AUTOCOMPLETE.test(control.autocomplete)) return true;
  return ['name', 'inputId', 'label', 'placeholder'].some(key => typeof control[key] === 'string'
    && labelSpellings(control[key]).some(text => PAYMENT_FIELD.test(text)));
}

/** Canonical safety spelling; shared byte-for-byte with the page script. Display labels stay unchanged. */
export function normalizeLabel(label) {
  const lookalikes = { а: 'a', α: 'a', в: 'b', β: 'b', с: 'c', ϲ: 'c', е: 'e', ε: 'e', ё: 'e',
    һ: 'h', н: 'h', η: 'h', і: 'i', ι: 'i', ї: 'i', ј: 'j', к: 'k', κ: 'k', м: 'm', μ: 'm',
    о: 'o', ο: 'o', р: 'p', ρ: 'p', ѕ: 's', т: 't', τ: 't', у: 'y', υ: 'y', х: 'x', χ: 'x', ν: 'v' };
  return String(label ?? '').normalize('NFKD').toLowerCase().replace(/[\p{M}\p{Cf}]/gu, '')
    .replace(/[аαвβсϲеεёһнηіιїјкκмμоορрѕтτуυхχν]/gu, char => lookalikes[char] ?? char)
    .replace(/\s+/g, ' ').trim()
    .replace(/\b(?:[a-z] ){2,}[a-z]\b/g, word => word.replace(/ /g, ''));
}

/** Invisible formatting may join letters or separate words: refuse either safety spelling. */
export function labelSpellings(label) {
  return [...new Set([normalizeLabel(label), normalizeLabel(String(label ?? '').replace(/\p{Cf}/gu, ' '))])];
}

/**
 * The core rules. `text`-less records: `enforced` names the code that enforces the rule, and
 * `lifted` the lowest level that lifts it (null: never, at any level).
 */
export const CORE_RULES = Object.freeze([
  Object.freeze({ id: 'sign_in', lifted: 'testing', enforced: 'SIGN_IN_WORDS; login wall check; password fields offered only with sign_in' }),
  Object.freeze({ id: 'purchase', lifted: 'testing', enforced: 'PURCHASE; payment fields; destructiveLink; the purchase guard (purchase_control, purchase_page) below testing' }),
  Object.freeze({ id: 'commit', lifted: 'full', enforced: 'COMMIT_OTHER; destructiveLink; the commit guard in reversible mode' }),
  Object.freeze({ id: 'delete', lifted: 'full', enforced: 'DELETE_WORDS; destructiveLink' }),
  Object.freeze({ id: 'send', lifted: 'full', enforced: 'SUBMIT_WORDS (save, submit, send, confirm, invite, publish); page.js submit risk (search-like submits from interactive)' }),
  Object.freeze({ id: 'browser_internal', lifted: null, enforced: 'extension: http(s) tabs and same-origin navigation only' }),
  Object.freeze({ id: 'consent', lifted: 'full', enforced: 'reject / necessary-only consent buttons preferred; accept offered only with consent_accept (CONSENT_* in oversight.js)' }),
]);

/** Caps on additions: at most 20 phrases of at most 60 characters, and a note of at most 200 characters. */
export const GUARDRAIL_LIMITS = Object.freeze({ maxForbid: 20, maxPhraseLength: 60, maxNoteLength: 200 });

// Regex metacharacters are rejected with a clear message; the allowlist below then admits letters, digits, marks,
// spaces and a little punctuation that real control labels carry ("Add-ons", "Gift & wrap", "Save 20%").
const METACHARACTERS = /[\\^$.|?*+()[\]{}]/;
const PHRASE = /^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M} '’&/:,!#%@-]*$/u;
// Control, format (zero-width, bidi overrides), private-use and unassigned code points: a note is plain text stored
// verbatim, so nothing invisible or direction-changing gets in.
const NOTE_CONTROL = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u;

function fail(source, message) {
  throw new TypeError(`${source}: ${message}`);
}

function cleanPhrase(raw, source, index) {
  if (typeof raw !== 'string') fail(source, `forbid[${index}] must be a string`);
  const phrase = raw.replace(/\s+/g, ' ').trim();
  if (!phrase) fail(source, `forbid[${index}] must not be blank`);
  if (phrase.length > GUARDRAIL_LIMITS.maxPhraseLength) {
    fail(source, `forbid[${index}] must be at most ${GUARDRAIL_LIMITS.maxPhraseLength} characters`);
  }
  if (METACHARACTERS.test(phrase)) {
    fail(source, `forbid[${index}] must be a plain phrase (regex metacharacters \\ ^ $ . | ? * + ( ) [ ] { } are not allowed)`);
  }
  if (!PHRASE.test(phrase)) {
    fail(source, `forbid[${index}] may contain only letters, digits, spaces and - ' & / : , ! # % @`);
  }
  return phrase;
}

/**
 * Validate and normalize a guardrail addition: undefined/null, an array of plain phrases, or `{ forbid?: [...],
 * note?: "..." }`. Returns `{ forbid: string[], note: string }` (whitespace collapsed, duplicates dropped
 * case-insensitively, order kept so the rendered policy is byte-stable for identical input). Throws a TypeError
 * prefixed with `source` (for example "policy" or "config.json guardrails") on anything else.
 */
export function normalizeAdditions(input, source = 'policy') {
  if (input === undefined || input === null) return { forbid: [], note: '' };
  let list;
  let note = '';
  if (Array.isArray(input)) {
    list = input;
  } else if (typeof input === 'object') {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(source, 'must be a plain object');
    for (const key of Object.keys(input)) {
      if (key !== 'forbid' && key !== 'note') fail(source, `unknown key "${/^[a-zA-Z0-9_]{1,32}$/.test(key) ? key : "unsupported"}" (use forbid and note)`);
    }
    list = input.forbid === undefined ? [] : input.forbid;
    if (!Array.isArray(list)) fail(source, 'forbid must be an array of strings');
    if (input.note !== undefined) {
      if (typeof input.note !== 'string') fail(source, 'note must be a string');
      note = input.note.replace(/\s+/g, ' ').trim();
      if (note.length > GUARDRAIL_LIMITS.maxNoteLength) {
        fail(source, `note must be at most ${GUARDRAIL_LIMITS.maxNoteLength} characters`);
      }
      if (NOTE_CONTROL.test(note)) fail(source, 'note must not contain control, format or invisible characters');
    }
  } else {
    fail(source, 'must be an array of strings or an object { forbid, note }');
  }
  if (list.length > GUARDRAIL_LIMITS.maxForbid) fail(source, `forbid may list at most ${GUARDRAIL_LIMITS.maxForbid} phrases`);
  const forbid = [];
  const seen = new Set();
  for (const [index, raw] of list.entries()) {
    const phrase = cleanPhrase(raw, source, index);
    const key = normalizeLabel(phrase);
    if (seen.has(key)) continue;
    seen.add(key);
    forbid.push(phrase);
  }
  return { forbid, note };
}

/**
 * Merge additions (config first, then the request): the union of the phrases, capped at twice the per-source limit,
 * and the notes joined. Restrict-only by construction: nothing here can remove a phrase or a core rule.
 */
export function mergeAdditions(...sources) {
  const forbid = [];
  const seen = new Set();
  const notes = [];
  for (const source of sources) {
    for (const phrase of source?.forbid ?? []) {
      const key = normalizeLabel(phrase);
      if (seen.has(key)) continue;
      seen.add(key);
      forbid.push(phrase);
    }
    if (source?.note && !notes.includes(source.note)) notes.push(source.note);
  }
  return { forbid: forbid.slice(0, GUARDRAIL_LIMITS.maxForbid * 2), note: notes.join(' ') };
}

/**
 * Re-validate additions taken from an existing policy (`policy.additions`): every phrase cleaned as in
 * normalizeAdditions, at most twice the per-source cap, and a note of at most two joined notes. Throws on anything
 * else, like normalizeAdditions.
 */
function readditions(input) {
  const source = 'guardrail additions';
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(source, 'must be an object { forbid, note }');
  const list = input.forbid ?? [];
  if (!Array.isArray(list) || list.length > GUARDRAIL_LIMITS.maxForbid * 2) fail(source, 'forbid must be a short array');
  const forbid = list.map((raw, index) => cleanPhrase(raw, source, index));
  const note = typeof input.note === 'string' ? input.note.replace(/\s+/g, ' ').trim() : '';
  if (note.length > GUARDRAIL_LIMITS.maxNoteLength * 2 + 1 || NOTE_CONTROL.test(note)) fail(source, 'note is not a plain note');
  return { forbid, note };
}

/**
 * Compile plain phrases into one case-insensitive pattern: each phrase escaped, inner whitespace as \s+, bounded by
 * non-letter/digit (Unicode-aware, so "Upgrade" does not match "Upgrades" or "Downgrade"). Null for no phrases.
 * extension/page.js has a byte-identical copy (drift check in test/guardrails-drift.test.js).
 */
export function forbidPattern(phrases) {
  const parts = [];
  for (const raw of Array.isArray(phrases) ? phrases : []) {
    for (const phrase of new Set([String(raw), normalizeLabel(raw)])) {
      const words = String(phrase).trim().split(/\s+/).filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (words.length) parts.push(words.join('\\s+'));
    }
  }
  return parts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'iu') : null;
}

/** The label classes a text trips, in priority order (purchase, forbid, sign_in, delete, submit). */
function classesOf(spellings, pattern) {
  const out = [];
  const add = name => {
    if (!out.includes(name)) out.push(name);
  };
  for (const text of spellings) if (PURCHASE.test(text)) add('purchase');
  for (const text of spellings) if (pattern?.test(text)) add('forbid');
  for (const text of spellings) if (SIGN_IN_WORDS.test(text)) add('sign_in');
  for (const text of spellings) {
    if (DELETE_WORDS.test(text)) add('delete');
    if (COMMIT_OTHER.test(text)) add(commitOtherClass(text.match(COMMIT_OTHER)[0]));
  }
  for (const text of spellings) if (SUBMIT_WORDS.test(text)) add('submit');
  const order = ['purchase', 'forbid', 'sign_in', 'delete', 'submit'];
  return out.sort((x, y) => order.indexOf(x) - order.indexOf(y));
}

/** The label classes (purchase, forbid, sign_in, delete, submit) of a label, core rules only, highest first. */
export function labelClasses(label) {
  return classesOf(labelSpellings(label), null);
}

// ---------------------------------------------------------------------------------------------------------------
// The policy object
// ---------------------------------------------------------------------------------------------------------------

/**
 * The guardrail policy for one run at one level: `{ core, additions, level, mode, capabilities, testing, pattern,
 * matches(label), classes(label), blocks(label), allows(capability), forbids(label), wire() }`.
 *
 * - `matches(label)` names the highest-priority class a label trips: 'purchase', 'forbid', 'sign_in', 'delete',
 *   'submit', or null (core first; additions apply to every role).
 * - `blocks(label)` names the first class the level does not allow (a `forbid` match is blocked at every level,
 *   testing included), or null when the label is usable at this level.
 * - `allows(capability)` is true when the level has it.
 * - `wire()` is what the extension receives: `{ level, forbid? }` (plain phrases).
 *
 * `level` (or its alias `mode`) must be one of LEVELS; `request` and `config` are raw additions, validated here.
 */
export function guardrailPolicy({ level, mode, request, config, merged } = {}) {
  const name = level ?? mode ?? DEFAULT_LEVEL;
  if (!isLevel(name)) throw new TypeError('Unknown action policy');
  // `merged`: the additions of an existing policy (config and request already merged, so possibly more phrases than
  // one source may carry), re-cleaned phrase by phrase.
  const base = merged
    ? mergeAdditions(readditions(merged))
    : mergeAdditions(normalizeAdditions(config, 'config.json guardrails'), normalizeAdditions(request, 'policy'));
  const additions = base;
  const pattern = forbidPattern(additions.forbid);
  const capabilities = CAPABILITIES[name];
  const allows = capability => capabilities.includes(capability);
  return Object.freeze({
    core: CORE_RULES,
    additions: Object.freeze({ forbid: Object.freeze([...additions.forbid]), note: additions.note }),
    level: name,
    mode: name,
    capabilities,
    testing: name === 'testing',
    pattern,
    allows,
    /** Every class the label trips, highest priority first. */
    classes(label) {
      return classesOf(labelSpellings(label), pattern);
    },
    /** The highest-priority class the label trips, or null. */
    matches(label) {
      return classesOf(labelSpellings(label), pattern)[0] ?? null;
    },
    /** The first class this level does not allow, or null. */
    blocks(label) {
      return classesOf(labelSpellings(label), pattern).find(kind => !allows(CLASS_CAPABILITY[kind])) ?? null;
    },
    forbids(label) {
      return labelSpellings(label).some(text => Boolean(pattern?.test(text)));
    },
    wire() {
      return additions.forbid.length ? { forbid: [...additions.forbid], level: name } : { level: name };
    },
  });
}
