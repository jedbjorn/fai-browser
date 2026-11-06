// Independent outcome checks. A run is only `completed` when one of these passes on a settled observation.
//
// Declarative expectations are plain objects. Every supplied field must match (logical AND). Supported fields:
//   urlEquals      exact URL match
//   urlIncludes    case-sensitive substring of the URL
//   urlMatches     regular expression source tested against the URL
//   textIncludes   case-insensitive substring of the visible page text, or of the page's rendered text past the
//                  viewport: the page script checks the expectation's textIncludes against the whole document (hidden
//                  text left out) and lists the ones it found in `observation.textFound` (expectText), so a run that
//                  scrolled below the sentence still passes
//   textAbsent     case-insensitive substring that must NOT appear in the visible (viewport) page text; never the
//                  whole document, so an off-screen "Loading more" row does not hold a finished page back
//   titleEquals    exact title match
//   titleIncludes  case-insensitive substring of the title
//   changedSinceStart  `true`: the final observation's revision or URL differs from the initial observation of the
//                  run, step or act (for act, the observe() that offered the action). Without an initial
//                  observation in the context there is no baseline, so the condition does not pass.
// A function predicate receives the full observation and the context `{ initial }` and must return (or resolve
// to) exactly `true`.

import { blocksOf } from './digest.js';

const FIELDS = new Set([
  'urlEquals',
  'urlIncludes',
  'urlMatches',
  'textIncludes',
  'textAbsent',
  'titleEquals',
  'titleIncludes',
  'changedSinceStart',
]);

export const EXPECTATION_FIELDS = [...FIELDS];

/**
 * Throw a TypeError when the expectation has an invalid shape. `undefined`/`null` means "no expectation".
 * Called before a run starts so a typo fails fast instead of silently producing `unverified`.
 */
export function validateExpectation(expectation) {
  if (expectation === undefined || expectation === null) return;
  if (typeof expectation === 'function') return;
  if (typeof expectation !== 'object' || Array.isArray(expectation)) {
    throw new TypeError('expectation must be an object of string conditions or a predicate function');
  }
  const keys = Object.keys(expectation);
  if (!keys.length) throw new TypeError('expectation must contain at least one condition');
  for (const key of keys) {
    if (!FIELDS.has(key)) {
      throw new TypeError(`Unsupported expectation field "${key}"; supported: ${EXPECTATION_FIELDS.join(', ')}`);
    }
    const value = expectation[key];
    if (key === 'changedSinceStart') {
      if (value !== true) throw new TypeError('expectation.changedSinceStart must be true');
      continue;
    }
    if (typeof value !== 'string' || !value.length) {
      throw new TypeError(`expectation.${key} must be a non-empty string`);
    }
    if (key === 'urlMatches') {
      try {
        new RegExp(value);
      } catch (error) {
        throw new TypeError(`expectation.urlMatches is not a valid regular expression: ${error.message}`);
      }
    }
  }
}

function lower(value) {
  return String(value ?? '').toLowerCase();
}

// The lower-cased texts the page script found in the rendered document (an array of strings, else none).
function foundText(observation) {
  const found = observation?.textFound;
  return Array.isArray(found) ? found.filter(item => typeof item === 'string') : [];
}

/**
 * The lower-cased textIncludes strings of a declarative expectation, for the page script's document check
 * (observe's `expectText`), or null when there are none.
 */
export function expectationTexts(expectation) {
  if (!expectation || typeof expectation !== 'object' || typeof expectation.textIncludes !== 'string') return null;
  const text = expectation.textIncludes.toLowerCase();
  if (!text.trim()) return null;
  // textAbsent too: read in the whole document when textIncludes passed only there (checkField).
  const absent = typeof expectation.textAbsent === 'string' && expectation.textAbsent.trim() ? expectation.textAbsent.toLowerCase() : null;
  return absent && absent !== text ? [text, absent] : [text];
}

function changedSince(observation, initial) {
  if (!initial || typeof initial !== 'object') return false;
  return observation?.revision !== initial.revision || observation?.url !== initial.url;
}

// ---------------------------------------------------------------------------------------------------------------
// Expectation miss hint
// ---------------------------------------------------------------------------------------------------------------

/** Page strings quoted in a hint: at most this many, each cut to this length; control and format characters out. */
const HINT_STRINGS = 5;
const HINT_STRING_LIMIT = 60;
const HINT_EXPECTED_LIMIT = 80;
// A "short prominent string": a block of at most this many words (a heading, a tab, a button, a short line).
const HINT_SHORT_WORDS = 6;
const HINT_HEADINGS = new Set(['h1', 'h2', 'h3', 'h4']);
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/gu;

function hintClean(value) {
  const text = String(value ?? '').replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  return text.length > HINT_STRING_LIMIT ? `${text.slice(0, HINT_STRING_LIMIT - 1)}…` : text;
}

/** Quoted for the trusted text: JSON quoting escapes the quote marks, so a page string cannot end the quote. */
function quoted(text) {
  return JSON.stringify(text);
}

/**
 * A short trusted hint for a declarative expectation whose textIncludes or titleIncludes is not on the observation:
 * `expected text "Departing flights" not found; the page has "Top flights", "Other departing flights"` (up to five
 * of the page's headings and short prominent strings, ranked by word overlap with the expected text, headings
 * first, then in page order), or for a title, the page's title. Page strings are quoted, cut to 60 characters and
 * stripped of control characters: still untrusted page text, which the hint says. Null when every text field
 * passes, or the expectation has none.
 */
export function expectationHint(observation, expectation) {
  if (!observation || !expectation || typeof expectation !== 'object') return null;
  const parts = [];
  if (typeof expectation.textIncludes === 'string' && expectation.textIncludes.trim()
    && !checkField(observation, 'textIncludes', expectation.textIncludes, {})) {
    const expected = hintClean(expectation.textIncludes).slice(0, HINT_EXPECTED_LIMIT);
    const strings = prominentStrings(observation, expected);
    parts.push(`expected text ${quoted(expected)} not found`
      + (strings.length ? `; the page has ${strings.map(quoted).join(', ')}` : '; the page has no heading like it'));
  }
  if (typeof expectation.titleIncludes === 'string' && expectation.titleIncludes.trim()
    && !checkField(observation, 'titleIncludes', expectation.titleIncludes, {})) {
    const expected = hintClean(expectation.titleIncludes).slice(0, HINT_EXPECTED_LIMIT);
    const title = hintClean(observation.title);
    parts.push(`expected title ${quoted(expected)} not found; the title is ${quoted(title)}`);
  }
  if (!parts.length) return null;
  return `${parts.join('. ')} (quoted page text, untrusted)`;
}

const HINT_WORD = /[\p{L}\p{N}]+/gu;
const HINT_STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'at', 'by', 'from', 'with', 'is', 'are']);

function hintWords(text) {
  const out = new Set();
  for (const match of String(text ?? '').toLowerCase().matchAll(HINT_WORD)) {
    const word = match[0];
    if (HINT_STOP.has(word) || word.length < 2) continue;
    // A light stem, enough for "flights"/"flight" and "departing"/"departure" to meet.
    out.add(word.replace(/(ing|ures?|ed|s)$/, ''));
  }
  return out;
}

/**
 * The page's headings and short prominent strings (blocks of at most six words: tabs, buttons, short lines), at most
 * five, ranked by how many of the expected text's words they share (ties: headings first, then page order); when
 * fewer than three share a word, the page's first headings fill in, so the host still sees what the page is about.
 */
function prominentStrings(observation, expected) {
  // The page script's blocks, or without them the text lines (digest.js blocksOf): known types, 300 characters each.
  const blocks = blocksOf(observation);
  const want = hintWords(expected);
  const seen = new Set();
  const candidates = [];
  for (const [index, block] of blocks.entries()) {
    if (candidates.length >= 400) break;
    const text = hintClean(block?.text);
    const heading = HINT_HEADINGS.has(block?.t);
    if (!text || block?.hidden === true) continue;
    const words = hintWords(text);
    if (!heading && words.size > HINT_SHORT_WORDS) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let overlap = 0;
    for (const word of words) if (want.has(word)) overlap++;
    candidates.push({ text, heading, overlap, index });
  }
  const ranked = candidates.filter(entry => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || Number(b.heading) - Number(a.heading) || a.index - b.index);
  const out = ranked.slice(0, HINT_STRINGS).map(entry => entry.text);
  if (out.length < 3) {
    for (const entry of candidates) {
      if (out.length >= HINT_STRINGS) break;
      if (entry.heading && !out.includes(entry.text)) out.push(entry.text);
    }
  }
  return out;
}

function checkField(observation, key, expected, context) {
  const url = String(observation?.url ?? '');
  const title = String(observation?.title ?? '');
  // Text may be missing on a malformed or empty observation; treat it as empty rather than throwing.
  const text = String(observation?.text ?? '');
  switch (key) {
    case 'urlEquals':
      return url === expected;
    case 'urlIncludes':
      return url.includes(expected);
    case 'urlMatches':
      return new RegExp(expected).test(url);
    case 'textIncludes':
      return lower(text).includes(lower(expected)) || foundText(observation).includes(lower(expected));
    case 'textAbsent': {
      if (lower(text).includes(lower(expected))) return false;
      // textIncludes passed only past the viewport: the absent text is read in the whole document too, and a walk
      // that hit its node cap (textCapped) counts it as possibly present.
      const includes = typeof context?.textIncludes === 'string' ? lower(context.textIncludes) : null;
      if (!includes || lower(text).includes(includes) || !foundText(observation).includes(includes)) return true;
      return !observation?.textCapped && !foundText(observation).includes(lower(expected));
    }
    case 'titleEquals':
      return title === expected;
    case 'titleIncludes':
      return lower(title).includes(lower(expected));
    case 'changedSinceStart':
      return changedSince(observation, context?.initial);
    default:
      return false;
  }
}

/**
 * Evaluate a validated declarative expectation synchronously. Function predicates are handled by
 * `evaluateExpectation`, which may await them. `context.initial` is the baseline for changedSinceStart.
 */
export function checkDeclarative(observation, expectation, context = {}) {
  return Object.entries(expectation).every(([key, expected]) => checkField(observation, key, expected, { ...context, textIncludes: expectation.textIncludes }));
}

/**
 * Evaluate any expectation. Resolves to `true` only on an explicit pass. Predicate exceptions propagate to the
 * caller, which records them as a failed check.
 */
export async function evaluateExpectation(observation, expectation, context = {}) {
  if (typeof expectation === 'function') return (await expectation(observation, context)) === true;
  return checkDeclarative(observation, expectation, context);
}

/**
 * Backwards-compatible boolean check. Returns false (never throws) for missing or invalid expectations and
 * does not support function predicates.
 */
export function verifyExpectation(observation, expectation, context = {}) {
  if (!expectation || typeof expectation === 'function') return false;
  try {
    validateExpectation(expectation);
  } catch {
    return false;
  }
  return checkDeclarative(observation, expectation, context);
}

/** JSON-safe description of an expectation for the result's `verification.expectation` field. */
export function describeExpectation(expectation) {
  if (expectation === undefined || expectation === null) return null;
  if (typeof expectation === 'function') return { predicate: expectation.name || 'anonymous' };
  return { ...expectation };
}

// ---------------------------------------------------------------------------------------------------------------
// Expectation lint (docs/design/OVERSIGHT-SPEC.md 1.2, rung 0). A shape, not a verdict: the run always proceeds.
//   url_path     urlIncludes (the recommended form: the last page's path)
//   url_start    (runtime only) a urlIncludes the start page already matched and no page since failed
//   url_guess    urlMatches or urlEquals (guesses of the URL shape; matched 1/4 in the bench)
//   text_menu    a textIncludes of at most three words that equals a link or button label on the start page
//   text_unique  other text or title checks
//   absent       only textAbsent / changedSinceStart
//   predicate    a function (SDK only)
//   none         no expectation
// `weak` is true for url_guess and text_menu.
// ---------------------------------------------------------------------------------------------------------------

const WEAK_SHAPES = new Set(['url_guess', 'text_menu']);

function words(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean);
}

/** Lower-cased labels of the observation's links and buttons, for the text_menu rule. */
function controlLabels(observation) {
  const labels = new Set();
  for (const control of observation?.controls ?? []) {
    if (control?.role !== 'link' && control?.role !== 'button') continue;
    const label = String(control.label ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (label) labels.add(label);
  }
  return labels;
}

/**
 * `{ shape, weak, hint }` for an expectation; `observation` (the start page) enables the text_menu rule. `hint` is
 * a short runtime-written sentence naming what to change, or '' when the shape is fine.
 */
export function lintExpectation(expectation, observation = null) {
  if (expectation === undefined || expectation === null) return { shape: 'none', weak: false, hint: '' };
  if (typeof expectation === 'function') return { shape: 'predicate', weak: false, hint: '' };
  const keys = Object.keys(expectation);
  let shape;
  if (keys.includes('urlMatches') || keys.includes('urlEquals')) shape = 'url_guess';
  else if (keys.includes('urlIncludes')) shape = 'url_path';
  else if (keys.some(key => key === 'textIncludes' || key === 'titleIncludes' || key === 'titleEquals')) {
    const text = String(expectation.textIncludes ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const menu = text && words(text).length <= 3 && controlLabels(observation).has(text);
    shape = menu ? 'text_menu' : 'text_unique';
  } else {
    shape = 'absent';
  }
  const weak = WEAK_SHAPES.has(shape);
  let hint = '';
  if (shape === 'url_guess') {
    hint = 'urlMatches and urlEquals guess the URL shape; use urlIncludes with the final page path instead.';
  } else if (shape === 'text_menu') {
    hint = 'textIncludes equals a link label on the start page, so it passes too early; use urlIncludes with the '
      + 'final page path or text only the final page has.';
  }
  return { shape, weak, hint };
}
