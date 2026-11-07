// Relevance of offered actions to the task, for every cap on offered actions and the slim request switches:
//   - the offer cap (offerCap: observe's listing, MAX_OFFERED in src/runtime.js legalActions) keeps the most relevant
//     offered actions when a page offers more than the cap; act() still resolves every offered id;
//   - the option cap (slim.cap, src/runtime.js resolveSlim) does the same for one provider request, with the same
//     ranking, so it only ever drops from what the offer cap kept (capActions composes: cap 40 of cap 80 of all is
//     cap 40 of all);
//   - compact controls (slim.controls) keep a link's path only for the most relevant links.
// Local only: the hints are built from host-written text (instruction, answerQuestion, expectation) and are never
// sent to a provider. Scores use labels and URL paths of offered actions, never page text.

import { forbidPattern, labelClasses, labelSpellings } from './guardrails.js';
import { harmlessControlLabel, instructionTerms, labelIntents, namedHops } from './oversight.js';

/** Default number of non-terminal options sent to the provider when the option cap is on. */
export const DEFAULT_OPTION_CAP = 40;

/**
 * Control actions observe() lists for a host at each level (page actions, consent buttons and fills of supplied values
 * come on top): links at read-only and reversible, buttons, selects and fills from interactive up.
 */
export const OFFER_CAPS = Object.freeze({ 'read-only': 40, reversible: 40, interactive: 80, full: 80, testing: 80 });

/** The observe listing cap for a level (40 for an unknown level). */
export function offerCap(level) {
  return Object.hasOwn(OFFER_CAPS, level) ? OFFER_CAPS[level] : OFFER_CAPS['read-only'];
}

function lower(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The lower-cased path, query and hash of a URL (decoded, separators as spaces), or '' when unparsable. */
function pathWords(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return lower(decodeURIComponent(`${parsed.pathname}${parsed.search}${parsed.hash}`).replace(/[-_/.?=&#+]+/g, ' '));
  } catch {
    return '';
  }
}

/**
 * Local relevance hints: instruction (and answerQuestion) terms, the pages the instruction names, and the
 * expectation's URL, title and text conditions. A function expectation contributes nothing.
 */
export function relevanceHints({ instruction, answerQuestion, expectation } = {}) {
  const hints = {
    terms: instructionTerms(instruction, answerQuestion),
    hops: namedHops(instruction).map(lower).filter(hop => hop.length >= 2),
    urlIncludes: [],
    urlEquals: [],
    urlMatches: [],
    texts: [],
  };
  if (expectation && typeof expectation === 'object') {
    if (typeof expectation.urlIncludes === 'string' && expectation.urlIncludes) hints.urlIncludes.push(expectation.urlIncludes);
    if (typeof expectation.urlEquals === 'string' && expectation.urlEquals) hints.urlEquals.push(expectation.urlEquals);
    if (typeof expectation.urlMatches === 'string' && expectation.urlMatches) {
      try {
        hints.urlMatches.push(new RegExp(expectation.urlMatches));
      } catch {
        // validateExpectation already rejects invalid patterns.
      }
    }
    for (const key of ['textIncludes', 'titleIncludes']) {
      const text = lower(expectation[key]);
      if (text.length >= 3) hints.texts.push(text);
    }
  }
  return hints;
}

/** The URL an offered action navigates to (a link's href or an explicit URL), or null. */
export function actionUrl(action) {
  if (action?.type === 'navigate_allowed_url') return action.url ?? null;
  return action?.href ?? null;
}

function terminal(action) {
  return action.type === 'done' || action.type === 'handoff' || action.id === 'done' || action.id === 'handoff';
}

/**
 * Actions the cap never drops: scrolling, waiting, explicitly supplied URLs (allowedUrls), consent buttons, open
 * floating-menu/overlay choices, fills of host-supplied values (the host named them for this task), secret handle fills
 * and copies (at most a few, src/runtime.js SECRET_FILL_*), and terminal actions.
 */
export function essentialAction(action) {
  if (terminal(action) || action.consent || action.floating) return true;
  if (['scroll', 'wait', 'fill_supplied_text', 'submit_field', 'fill_secret', 'copy_secret'].includes(action.type)) return true;
  return action.type === 'navigate_allowed_url' && !action.newTab;
}

/**
 * True when the action satisfies the expectation as far as its option shows: its destination meets a URL condition,
 * or its label contains (or is contained in) a text or title condition (a text-only expectation names what the next
 * page shows, often the link's own label).
 */
export function matchesExpectation(action, hints) {
  if (!hints) return false;
  const label = lower(`${action.label ?? ''} ${action.optionLabel ?? ''}`);
  if (label.length >= 3 && hints.texts.some(text => label.includes(text) || text.includes(label))) return true;
  const url = actionUrl(action);
  if (!url) return false;
  if (hints.urlEquals.some(value => url === value)) return true;
  if (hints.urlIncludes.some(value => url.includes(value))) return true;
  return hints.urlMatches.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(url);
  });
}

function formControl(action) {
  return action.type !== 'navigate_allowed_url' && action.target !== undefined && action.role !== 'link';
}

/**
 * A relevance score for one offered action: a label equal to (or containing) a page the instruction names scores
 * highest, then a destination that satisfies the expectation's URL condition and expectation title/text conditions in
 * the label, then instruction terms in the label or the URL path.
 */
export function relevanceScore(action, hints) {
  if (!hints) return 0;
  const label = lower(`${action.label ?? ''} ${action.optionLabel ?? ''}`);
  const path = pathWords(actionUrl(action));
  let score = matchesExpectation(action, hints) ? 3 : 0;
  // A supplied value's name ("email") the instruction mentions makes its fill relevant.
  const supplied = lower(action.suppliedName).replace(/[-_.]+/g, ' ');
  if (supplied && hints.terms.some(term => supplied.includes(term) || term.includes(supplied))) score += 2;
  // On a form task (a supplied value is offered) buttons, selects and toggles outrank unrelated links: "Join" next
  // to the email field must survive a page with many links.
  if (hints.formTask && formControl(action)) score += 1;
  for (const hop of hints.hops) {
    if (label === hop) score += 8;
    else if (label.length >= 3 && (label.includes(hop) || hop.includes(label))) score += 4;
  }
  for (const text of hints.texts) {
    if (label.length >= 3 && (label.includes(text) || text.includes(label))) score += 3;
  }
  for (const term of hints.terms) {
    if (label.includes(term)) score += 2;
    else if (path.includes(term)) score += 1;
  }
  return score;
}

/** The position legalActions gave an action (its id `a<n>`), or null for other ids (consent buttons, tests). */
function offeredIndex(action) {
  const match = /^a(\d+)$/.exec(String(action?.id ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * The offered actions ordered by relevance (highest first; ties keep the offered order, which is the page script's:
 * in-viewport controls first, in document order, also when the list arrives reordered, as for a second opinion).
 * Terminal actions are left out.
 */
export function rankActions(actions, hints) {
  return actions
    .map((action, index) => ({ action, index: offeredIndex(action) ?? index, score: relevanceScore(action, hints) }))
    .filter(entry => !terminal(entry.action))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.action);
}

/**
 * Cap the non-terminal options at `cap`. Kept: every essential action, every action that matches the expectation
 * (matchesExpectation), then the most relevant of the rest (with a supplied value offered, form controls first): a
 * label naming a page the instruction names or holding an instruction or question word always ranks above one that
 * does not. The result keeps the input order (document order, or the reversed order of a second opinion) and every
 * terminal action. `pinned` (optional predicate) names more actions to keep like essential ones. Returns
 * `{ actions, dropped }`.
 */
export function capActions(actions, cap, hints, pinned = null) {
  const options = actions.filter(action => !terminal(action));
  if (!Number.isInteger(cap) || cap <= 0 || options.length <= cap) return { actions, dropped: 0 };
  if (hints && options.some(action => action.type === 'fill_supplied_text')) hints = { ...hints, formTask: true };
  const keep = new Set(options.filter(action => essentialAction(action) || matchesExpectation(action, hints)
    || Boolean(pinned?.(action))));
  for (const action of rankActions(options, hints)) {
    if (keep.size >= cap) break;
    keep.add(action);
  }
  return {
    actions: actions.filter(action => terminal(action) || keep.has(action)),
    dropped: options.length - keep.size,
  };
}

/**
 * The offer cap for one observe listing: at most offerCap(level) control actions plus every essential action (scroll,
 * wait, explicit URLs, fills of supplied values) and every action `pinned` names (observe pins the consent dialog's
 * buttons), chosen by capActions. Returns `{ actions, dropped, cap }` with `actions` in the input order and their ids
 * unchanged.
 */
export function capOffer(actions, level, hints, pinned = null) {
  const cap = offerCap(level);
  const extra = actions.filter(action => !terminal(action) && (essentialAction(action) || Boolean(pinned?.(action)))).length;
  return { ...capActions(actions, cap + extra, hints, pinned), cap };
}

// ---------------------------------------------------------------------------------------------------------------
// Named controls: the buttons the host's instruction tells the run to click
// ---------------------------------------------------------------------------------------------------------------

// The verb that makes a label a click target: "click Next", "then press the 'Show 4 more flights' button".
const CLICK_VERB = /(?<![\p{L}\p{N}])(?:click|press|tap|hit|push)(?:\s+on)?\s+(?:the\s+)?$/iu;
// A negation in the same clause before the verb: "never click Submit order", "do not press Delete".
// Any n't contraction counts, with a straight or typographic apostrophe ("don’t", "shouldn't", "won’t").
const NEGATION = /(?<![\p{L}\p{N}])(?:never|not|dont|cannot|nor|avoid|without|except|instead|no)(?![\p{L}\p{N}])|\p{L}n['\u2019\u02bc]t(?![\p{L}\p{N}])/iu;
const CLAUSE_END = /[.;:!?()\n]/;
const QUOTES = '"\'\u2018\u2019\u201c\u201d`';
export const MAX_NAMED_CONTROLS = 3;
const NAMED_LABEL_LIMIT = 60;
// Labels the line never promotes although no guardrail class names them: irreversible or binding verbs (a trash,
// an approval, a signature, an accepted offer or terms, a deploy, a transfer) and the page script's descriptor for an
// unnamed control ("unlabelled button 1 of 2 next to ...", or with a derived direction "next-value button after ...
// (unlabelled)"), whose function the page did not name; an action marked `unnamed` is refused before any label check.
// Checked on every safety spelling (homoglyphs and invisible characters folded), as the guardrail classes are.
const NAMED_DENY = /^unlabel+ed\b|\(unlabel+ed\)\s*$|\b(?:trash|discard|erase|wipe|purge|destroy|deactivate|terminate|revoke|archive|approve|accept|agree|consent|sign|merge|deploy|release|withdraw|transfer|enrol+|claim|rent|redeem|share|unsubscribe|cancel|reset\s+password|close\s+account)\b/i;

/** A control label without leading or trailing symbols ("Continue →" -> "Continue"), whitespace collapsed. */
export function bareLabel(label) {
  return String(label ?? '').replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, '').trim();
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True for an offered action a named-control rule may favour: a plain button click (not a link, a consent button, a
 * select or a fill) whose label trips no guardrail class (purchase, sign in, delete, submit, send, commit lookalikes,
 * the user's forbid phrases), unless it is an ordinary view control (harmlessControlLabel: Apply, Search, Filter).
 */
export function nameableControl(action, pattern = null) {
  if (action?.type !== 'click' || action.target === undefined || action.consent || action.unnamed) return false;
  if (action.role === 'link' || action.href || action.newTab) return false;
  const label = bareLabel(action.label);
  if (label.length < 2 || label.length > NAMED_LABEL_LIMIT) return false;
  // Invisible or control characters would be copied into the policy line (a note refuses them the same way).
  if (/[\p{Cc}\p{Cf}\p{Co}]/u.test(String(action.label))) return false;
  if (pattern && labelSpellings(action.label).some(text => pattern.test(text))) return false;
  if (labelClasses(action.label).length) return false;
  const spellings = labelSpellings(action.label);
  if (spellings.some(text => NAMED_DENY.test(text))) return false;
  return spellings.every(text => !labelIntents(text).size) || harmlessControlLabel(label);
}

/**
 * The offered buttons the instruction names as click targets: a click verb ("click", "press", "tap", "hit", "push",
 * optionally "on" / "the"), then the label (optionally quoted), not inside a negated clause ("never click ..."), for
 * nameableControl() actions only. Returns at most MAX_NAMED_CONTROLS `{ label, ids }`, in instruction order, where
 * `label` is the instruction's own spelling (host text, never page text) and `ids` the offered action ids with that
 * label. A shorter label inside a longer named one ("Next" in "click Next page") is not named. With `history` (the
 * run's provider history), a label stops being named once the run has clicked it as often as the instruction names
 * it: "then click Next" is used up by one Next click, while a whole wizard's instruction that says "click Next" six
 * times names it until the sixth. Local only: the result feeds the `named` policy line (src/typesafe.js) and the
 * runtime's named-control done rule.
 */
export function namedControls(instruction, offered, { forbid = [], history = null } = {}) {
  const text = String(instruction ?? '');
  if (!text || !Array.isArray(offered)) return [];
  const pattern = forbidPattern(forbid);
  const byLabel = new Map();
  for (const action of offered) {
    if (!nameableControl(action, pattern)) continue;
    const key = bareLabel(action.label).toLowerCase();
    byLabel.set(key, [...(byLabel.get(key) ?? []), action]);
  }
  const hits = [];
  for (const [key, actions] of byLabel) {
    const label = bareLabel(actions[0].label);
    const quote = `[${QUOTES}]?`;
    const re = new RegExp(`${quote}(${escapeRegExp(label).replace(/ /g, '\\s+')})${quote}(?![\\p{L}\\p{N}])`, 'giu');
    for (const match of text.matchAll(re)) {
      const start = match.index;
      if (start > 0 && /[\p{L}\p{N}]/u.test(text[start - 1])) continue;
      const before = text.slice(0, start);
      if (!CLICK_VERB.test(before)) continue;
      const clause = before.split(CLAUSE_END).pop();
      if (NEGATION.test(clause.replace(CLICK_VERB, ''))) continue;
      const offset = match[0].indexOf(match[1]);
      hits.push({ key, start: start + offset, end: start + offset + match[1].length, label: match[1], ids: actions.map(action => action.id) });
    }
  }
  // A shorter label inside a longer named one is the longer one's prefix, not a control of its own.
  const kept = hits.filter(hit => !hits.some(other => other !== hit && other.start <= hit.start && other.end >= hit.end
    && other.end - other.start > hit.end - hit.start));
  kept.sort((a, b) => a.start - b.start);
  const clicked = new Map();
  for (const entry of Array.isArray(history) ? history : []) {
    if (entry?.type !== 'click') continue;
    const key = bareLabel(entry.label).toLowerCase();
    clicked.set(key, (clicked.get(key) ?? 0) + 1);
  }
  const out = [];
  for (const hit of kept) {
    if (out.some(entry => entry.key === hit.key)) continue;
    const times = kept.filter(other => other.key === hit.key).length;
    if ((clicked.get(hit.key) ?? 0) >= times) continue;
    out.push(hit);
    if (out.length >= MAX_NAMED_CONTROLS) break;
  }
  return out.map(({ label, ids }) => ({ label: label.replace(/\s+/g, ' '), ids }));
}
