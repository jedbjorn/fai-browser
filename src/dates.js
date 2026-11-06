// General ISO-date helpers for the step texts a task sub-skill reads (tasks/<name>/index.js shortcut kinds) and for the
// core: real calendar dates written YYYY-MM-DD, the distinct dates a text names, and whether a date in a step reads as
// the date the step asks for rather than a negated, opposite-leg, bound or reference date. Nothing here knows a site.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_GLOBAL = /(?<![\d-])(20\d{2})-(\d{2})-(\d{2})(?![\d-])/g;

/** True for a real calendar date written YYYY-MM-DD (years 2000-2099). */
export function isIsoDate(value) {
  const match = ISO_DATE.exec(String(value ?? ''));
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  if (year < 2000 || year > 2099) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The distinct real YYYY-MM-DD dates in a text, in order of first appearance (at most 8 looked at). */
export function isoDatesIn(text) {
  const out = [];
  for (const match of String(text ?? '').slice(0, 4000).matchAll(ISO_DATE_GLOBAL)) {
    if (isIsoDate(match[0]) && !out.includes(match[0])) out.push(match[0]);
    if (out.length >= 8) break;
  }
  return out;
}

// Words right before a date that make it something other than the date the step asks for: a negation ("not
// 2026-10-08", "except"), the opposite leg of a trip ("return", "back", "inbound"), a deadline or bound ("before",
// "by", "until", "after"), or a reference date ("as of"). Optional linking words ("on", "the") may sit between the
// word and the date.
const NOT_TARGET_DATE = new RegExp('\\b(?:not|never|no|except|excluding|exclude|without|avoid|skip|other than|instead of|'
  + 'rather than|but|return|returning|returns|back|inbound|before|after|until|till|by|since|as of|through|due|deadline|'
  + 'expires?|valid)\\s+(?:(?:on|the|of|date|day|for)\\s+)*$', 'i');

/** The step texts a date may be named in: the instruction and expectation.textIncludes, each cut to 4000 characters. */
export function dateTexts({ instruction, expectation } = {}) {
  const texts = [String(instruction ?? '').slice(0, 4000)];
  if (expectation && typeof expectation === 'object' && typeof expectation.textIncludes === 'string') {
    texts.push(expectation.textIncludes.slice(0, 4000));
  }
  return texts;
}

// Words right before the last date of a range that make it the range's end rather than a bound ("from 2027-03-01
// until 2027-03-04", "through"); a range's end is still a date the step asks for.
const RANGE_END = /\b(?:to|until|till|through|thru)\s+(?:(?:on|the)\s+)*$/i;

/**
 * Whether every place `date` appears in `text` reads as a plain date (no NOT_TARGET_DATE word right before it). With
 * `rangeEnd`, an occurrence right after a range word (RANGE_END) reads as the end of a range, which is plain too.
 */
export function plainDateIn(text, date, { rangeEnd = false } = {}) {
  for (let at = text.indexOf(date); at >= 0; at = text.indexOf(date, at + 1)) {
    const before = text.slice(Math.max(0, at - 40), at);
    if (rangeEnd && RANGE_END.test(before)) continue;
    if (NOT_TARGET_DATE.test(before)) return false;
  }
  return true;
}

/** The whole nights (days) from `from` to `to`, both YYYY-MM-DD; null for an invalid date. */
export function nightsBetween(from, to) {
  if (!isIsoDate(from) || !isIsoDate(to)) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The one date range a step asks for (`{ from, to }`): exactly two distinct ISO dates across its texts, the later
 * one second, the first plain wherever it appears and the second plain or a range's end ("from D1 to D2", "until D2"),
 * and (with `template`, as for stepDate) both named there too. Null otherwise.
 */
export function stepDateRange({ instruction, expectation, template } = {}) {
  const texts = dateTexts({ instruction, expectation });
  const dates = [...new Set(texts.flatMap(text => isoDatesIn(text)))];
  if (dates.length !== 2) return null;
  const [from, to] = dates;
  if (to <= from) return null;
  if (!texts.every(text => plainDateIn(text, from) && plainDateIn(text, to, { rangeEnd: true }))) return null;
  if (template !== undefined) {
    const named = dateTexts(template ?? {}).flatMap(text => isoDatesIn(text));
    if (!named.includes(from) || !named.includes(to)) return null;
  }
  return { from, to };
}

/**
 * The one plain date a step asks for: exactly one distinct ISO date across its texts, plain wherever it appears, and
 * (when `template`, the host's own text before a step list filled its placeholders, is given) named there too, so a
 * date a placeholder wrote in from page text never drives a URL. Null otherwise.
 */
export function stepDate({ instruction, expectation, template } = {}) {
  const texts = dateTexts({ instruction, expectation });
  const dates = [...new Set(texts.flatMap(text => isoDatesIn(text)))];
  if (dates.length !== 1 || !texts.every(text => plainDateIn(text, dates[0]))) return null;
  if (template !== undefined && !dateTexts(template ?? {}).some(text => isoDatesIn(text).includes(dates[0]))) return null;
  return dates[0];
}
