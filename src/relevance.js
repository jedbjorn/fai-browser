// Relevance of offered actions to the task, for the cap on offered actions: the offer cap (offerCap: observe's
// listing, MAX_OFFERED in src/runtime.js legalActions) keeps the most relevant offered actions when a page offers more
// than the cap; act() still resolves every offered id. Local only: the hints are built from host-written text
// (instruction, answerQuestion, expectation). Scores use labels and URL paths of offered actions, never page text.

import { instructionTerms, namedHops } from './oversight.js';

/** Default number of options kept when the option cap is on. */
export const DEFAULT_OPTION_CAP = 40;

/**
 * Control actions observe() lists for a host at each level (page actions, consent buttons and fills of supplied values
 * come on top): links at read-only and reversible, buttons, selects and fills from interactive up.
 */
export const OFFER_CAPS = Object.freeze({ 'read-only': 40, reversible: 40, interactive: 80, full: 80, testing: 80 });

/** Links to other sites a listing shows when neither the task nor a focus names any (capOffer). */
export const OTHER_SITE_LISTED = 5;

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


/**
 * Actions the cap never drops: scrolling, waiting, explicitly supplied URLs (allowedUrls), consent buttons, open
 * floating-menu/overlay choices, fills of host-supplied values (the host named them for this task), secret handle fills
 * and copies (at most a few, src/runtime.js SECRET_FILL_*).
 */
export function essentialAction(action) {
  if (action.consent || action.floating) return true;
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
 * in-viewport controls first, in document order).
 */
export function rankActions(actions, hints) {
  return actions
    .map((action, index) => ({ action, index: offeredIndex(action) ?? index, score: relevanceScore(action, hints) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.action);
}

/**
 * Cap the options at `cap`. Kept: every essential action, every action that matches the expectation
 * (matchesExpectation), then the most relevant of the rest (with a supplied value offered, form controls first): a
 * label naming a page the instruction names or holding an instruction or question word always ranks above one that
 * does not. The result keeps the input order (document order). `pinned` (optional predicate) names more actions to keep like essential ones. Returns
 * `{ actions, dropped }`.
 */
export function capActions(actions, cap, hints, pinned = null) {
  if (!Number.isInteger(cap) || cap <= 0 || actions.length <= cap) return { actions, dropped: 0 };
  if (hints && actions.some(action => action.type === 'fill_supplied_text')) hints = { ...hints, formTask: true };
  const keep = new Set(actions.filter(action => essentialAction(action) || matchesExpectation(action, hints)
    || Boolean(pinned?.(action))));
  for (const action of rankActions(actions, hints)) {
    if (keep.size >= cap) break;
    keep.add(action);
  }
  return {
    actions: actions.filter(action => keep.has(action)),
    dropped: actions.length - keep.size,
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
  // Links to other sites (src/runtime.js other_site: listed with their destination, never clicked) are listed when
  // the task or a focus names them, else only the first OTHER_SITE_LISTED: a footer of social links must not crowd
  // the listing. The rest count as dropped (moreActions) and a focus brings them in.
  const others = actions.filter(action => action.type === 'other_site' && !matchesExpectation(action, hints)
    && relevanceScore(action, hints) === 0 && !pinned?.(action));
  const parked = new Set(others.slice(OTHER_SITE_LISTED));
  const pool = parked.size ? actions.filter(action => !parked.has(action)) : actions;
  const extra = pool.filter(action => (essentialAction(action) || Boolean(pinned?.(action)))).length;
  const capped = capActions(pool, cap + extra, hints, pinned);
  return { actions: capped.actions, dropped: capped.dropped + parked.size, cap };
}
