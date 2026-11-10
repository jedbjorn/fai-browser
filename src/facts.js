// Fact memory for long runs and deterministic aggregation over it.
//
// A long single run (12-15 hops in one call) often reads its answer on an earlier page state: a flight on Thursday's
// list when the run ends on Sunday, the cheapest tent on page 11 of 13, a token in a log panel of a single-page app
// whose URL never changes. The runtime keeps every observation it saw; this module turns them into a bounded fact
// memory keyed by semantic revision (not URL, so same-URL states count), and, for questions that ask for an extremum
// or a filter over items ("the cheapest in-stock tent", "the earliest flight between 10:00 and 12:00"), parses the
// shaped values (currency amounts, times, counts) from the remembered lines, applies the filter words and orders the
// items so the answer ranking chooses among the right ones.
//
// Everything here is deterministic, synchronous and cheap; nothing is generated. Page text stays untrusted: lines are
// copied from page blocks (redacted by the caller's redactor) and values only order them.

import { pickAnswerCandidates, scoreBlocks, tokenize } from './digest.js';

/** Lines remembered per page state (aggregation items on top of them, up to FACT_STATE_ITEMS), and per run. */
export const FACT_STATE_LINES = 6;
/**
 * Aggregation items kept per state: a results page shows 10-20 rows (Google Flights: 9-14 priced rows), so the old
 * six-line cap dropped items on nearly every page and marked every aggregate `memory_full`. The final page's own
 * state keeps all its items (its observation is in hand).
 */
export const FACT_STATE_ITEMS = 30;
/** The run bound: at least FACT_RUN_LINES, FACT_RUN_LINES_PER_STATE per state seen, at most FACT_RUN_LINES_MAX. */
export const FACT_RUN_LINES = 80;
export const FACT_RUN_LINES_PER_STATE = 12;
export const FACT_RUN_LINES_MAX = 400;

/**
 * The lines a run of `stateCount` states may remember in all: a step list sees several states per step (each page
 * in two or three paints, the site's URL rewrite), so the bound grows with the states and a 5-15 step comparison
 * keeps every step's items; bounded whatever the run length.
 */
export function runLineBudget(stateCount) {
  return Math.min(FACT_RUN_LINES_MAX, Math.max(FACT_RUN_LINES, FACT_RUN_LINES_PER_STATE * Math.max(0, stateCount)));
}
/** States listed in the trace's `facts` (the memory itself is bounded by lines). */
export const FACT_TRACE_STATES = 40;
/** A remembered line, and the heading context in front of it, are clipped to these lengths. */
export const FACT_LINE_LIMIT = 200;
const FACT_RECORD_LIMIT = 300;
const CONTEXT_LIMIT = 80;
/** A line that is not an aggregation item is remembered only at this score (the old trail floor). */
export const FACT_MIN_SCORE = 1.5;
/** Non-item lines kept per state next to the items when the question aggregates. */
const AGGREGATE_EXTRA_LINES = 2;
/** Candidates scored per state before the bounds apply. */
const FACT_POOL = 40;

// ---------------------------------------------------------------------------------------------------------------
// Values: currency amounts, times, counts
// ---------------------------------------------------------------------------------------------------------------

const SEP = '[,.\\u00a0\\u202f]';
const AMOUNT = `(?:\\d{1,3}(?:${SEP}\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)`;
const SYMBOL = '(?:US\\$|C\\$|A\\$|[$€£¥₹])';
const CODE = '(?:usd|eur|gbp|chf|dollars?|euros?|pounds?)';
const MONEY_SPAN = new RegExp(`${SYMBOL}\\s?(${AMOUNT})|(?<![\\d.,])(${AMOUNT})\\s?(?:[€£$]|${CODE}(?![\\p{L}]))(?!\\s?\\d)`, 'giu');

/** A matched amount as a number: the last separator followed by one or two digits is the decimal point. */
function parseAmount(raw) {
  const compact = String(raw).replace(/[\s  ]/g, '');
  const match = /^(.*?)(?:[.,](\d{1,2}))?$/.exec(compact);
  const whole = Number(match[1].replace(/[.,]/g, ''));
  if (!Number.isFinite(whole)) return null;
  return match[2] ? whole + Number(`0.${match[2]}`) : whole;
}

/** Currency amounts in `text`, in order: "€1.299,00" and "$1,299.00" are both 1299, "min€61" is 61. */
export function moneyValues(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(MONEY_SPAN)) {
    const value = parseAmount(match[1] ?? match[2]);
    if (value !== null) out.push(value);
  }
  return out;
}

const TIME_24 = '(?:[01]?\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?';
const MERIDIEM = '[ap]\\.?\\s?m\\.?(?![\\p{L}])';
const TIME_SPAN = new RegExp(`(?<![\\d:.])(${TIME_24})(?!\\d)(?:\\s?(${MERIDIEM}))?|(?<![\\d:.])(1[0-2]|0?[1-9])\\s?(${MERIDIEM})`, 'giu');

function minutes(clock, meridiem) {
  const [h, m = '0'] = String(clock).split(':');
  let hour = Number(h);
  const ampm = meridiem ? meridiem.toLowerCase()[0] : null;
  if (ampm === 'p' && hour < 12) hour += 12;
  if (ampm === 'a' && hour === 12) hour = 0;
  return hour * 60 + Number(m);
}

/** Times of day in `text` as minutes after midnight: 24 h ("10:55", "14:00:03") and 12 h ("2:30 pm", "10 am"). */
export function timeValues(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(TIME_SPAN)) {
    if (match[1]) {
      const hour = Number(match[1].split(':')[0]);
      // "13:30 pm" is not a 12 h time; keep the 24 h reading.
      out.push(minutes(match[1], hour <= 12 ? match[2] : undefined));
    } else {
      out.push(minutes(match[3], match[4]));
    }
  }
  return out;
}

// Plain numbers: not part of a time, an amount or a longer token.
const NUMBER = /(?<![\d.,:$€£¥₹\p{L}-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?![\d:]|[.,]\d)/gu;

/** The count a line states for the question: its only plain number, else the one next to a question term. */
export function countValue(text, terms) {
  const value = String(text ?? '');
  const spans = [...value.matchAll(MONEY_SPAN), ...value.matchAll(TIME_SPAN)].map(m => [m.index, m.index + m[0].length]);
  const numbers = [];
  for (const match of value.matchAll(NUMBER)) {
    if (spans.some(([from, to]) => match.index >= from && match.index < to)) continue;
    numbers.push({ value: Number(match[1].replace(/,/g, '')), index: match.index, end: match.index + match[0].length });
  }
  if (!numbers.length) return null;
  if (numbers.length === 1) return numbers[0].value;
  // "48 stars", "Stars: 48": the word right after the number, else the one right before it.
  for (const number of numbers) {
    const after = /^[^\p{L}\p{N}]*([\p{L}\p{N}]+)/u.exec(value.slice(number.end))?.[1];
    const before = /([\p{L}\p{N}]+)[^\p{L}\p{N}]*$/u.exec(value.slice(0, number.index))?.[1];
    if ((after && terms.has(tokenize(after)[0])) || (before && terms.has(tokenize(before)[0]))) return number.value;
  }
  return null;
}

// A rating: "4.5 out of 5 stars", "8.4/10", "Scored 7.8", "Rated 4.6", "Rating: 9", "4.5 stars" (the same shapes the
// page script reads into a record's rating hint). Review counts ("5,041 reviews") are not ratings.
const RATING_WORDS = /\b(?:scored|score|rated|rating|ratings|review score|guest rating|stars?)\b|★/i;
const RATING_OUT_OF = /(?<![\d.,])(\d{1,2}(?:[.,]\d{1,2})?)\s*out of\s*(5|10|100)\b/i;
const RATING_SLASH = /(?<![\d.,/])(\d{1,2}(?:[.,]\d{1,2})?)\s*\/\s*(5|10|100)\b(?!\s*\/)/;
const RATING_LEAD = /\b(?:scored|score|rated|rating|review score|guest rating)\s*:?\s*(\d{1,2}(?:[.,]\d{1,2})?)(?![\d.,]*\s*(?:reviews?|ratings?|votes?))(?!\d)/i;
const RATING_STARS = /(?<![\d.,])(\d(?:[.,]\d{1,2})?)\s*(?:-\s*)?(?:stars?|★)/i;
// A score with its verbal grade, either order ("8.7 Excellent", "8.4Very good", "Very good 8.4"), the way review sites
// print it.
const GRADES = '(?:exceptional|superb|wonderful|excellent|fabulous|very good|good|pleasant|fair|okay|poor)';
const RATING_GRADE = new RegExp(`(?<![\\d.,])(\\d{1,2}[.,]\\d)\\s*${GRADES}\\b`, 'i');
const RATING_GRADE_BEFORE = new RegExp(`\\b${GRADES}\\s*:?\\s*(\\d{1,2}[.,]\\d)(?![\\d.,]|\\s*(?:reviews?|ratings?|km|mi|m\\b))`, 'i');
// A decimal score right before its review count ("4.31 (5,760 reviews)"): out of 5 up to 5, else out of 10.
const RATING_COUNT = /(?<![\d.,])(\d{1,2}[.,]\d{1,2})\s*\(\s*\d[\d,.  ]*\s*(?:reviews?|ratings?|votes?|opinions?)\s*\)/i;

/** The rating a text states, or null: `{ value, scale? }` (scale 5, 10 or 100 when the text says it). */
export function ratingValue(text) {
  const value = String(text ?? '');
  const number = raw => Number(String(raw).replace(',', '.'));
  let match = RATING_OUT_OF.exec(value);
  if (!match) {
    match = RATING_SLASH.exec(value);
    if (match && !RATING_WORDS.test(value) && !/[.,]/.test(match[1])) match = null;
  }
  if (match) {
    const rating = number(match[1]);
    const scale = Number(match[2]);
    return rating <= scale ? { value: rating, scale } : null;
  }
  match = RATING_LEAD.exec(value);
  if (match) {
    const rating = number(match[1]);
    return rating <= 10 ? { value: rating } : null;
  }
  match = RATING_GRADE.exec(value) ?? RATING_GRADE_BEFORE.exec(value);
  if (match) {
    const rating = number(match[1]);
    return rating <= 10 ? { value: rating, scale: 10 } : null;
  }
  match = RATING_COUNT.exec(value);
  if (match) {
    const rating = number(match[1]);
    return rating <= 10 ? { value: rating, scale: rating <= 5 ? 5 : 10 } : null;
  }
  match = RATING_STARS.exec(value);
  if (match) {
    const rating = number(match[1]);
    return rating <= 5 ? { value: rating, scale: 5 } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The question: extremum, measure and filters
// ---------------------------------------------------------------------------------------------------------------

const PRICE_WORDS = /\b(price[sd]?|pricing|costs?|fares?|fees?|rates?|cheap\w*|expensive|priciest)\b|[$€£¥]/i;
const PRICE_MIN = /\b(cheapest|least expensive|lowest[- ]priced|best price)\b/i;
const PRICE_MAX = /\b(most expensive|priciest|highest[- ]priced|dearest)\b/i;
const TIME_MIN = /\b(earliest|soonest)\b/i;
const TIME_MAX = /\blatest\b/i;
const GENERIC_MIN = /\b(lowest|least|smallest|fewest|minimum|shortest)\b/i;
const GENERIC_MAX = /\b(highest|largest|biggest|most|maximum|longest)\b/i;
// A clock time, or a named one ("before noon", "until midday", "after midnight").
const TIME_IN_QUESTION = `(?:(?:[01]?\\d|2[0-3]):[0-5]\\d(?:\\s?${MERIDIEM})?|(?:1[0-2]|0?[1-9])\\s?${MERIDIEM}|noon|midday|midnight)`;
const NAMED_TIME = { noon: 720, midday: 720, midnight: 0 };
// "a morning flight", "departing in the morning": before noon.
const MORNING = /\bmorning\b/i;
const WINDOW_BETWEEN = new RegExp(`\\b(?:between|from)\\s+(${TIME_IN_QUESTION})\\s*(?:and|to|until|till|-|–)\\s*(${TIME_IN_QUESTION})`, 'iu');
const WINDOW_DASH = new RegExp(`(${TIME_IN_QUESTION})\\s*[-–]\\s*(${TIME_IN_QUESTION})`, 'iu');
const WINDOW_BEFORE = new RegExp(`\\b(?:before|until|no later than)\\s+(${TIME_IN_QUESTION})`, 'iu');
const WINDOW_AFTER = new RegExp(`\\b(?:after|no earlier than)\\s+(${TIME_IN_QUESTION})`, 'iu');
const PRICE_UNDER = new RegExp(`\\b(?:under|below|less than|cheaper than|at most|up to)\\s+(${SYMBOL}\\s?${AMOUNT}|${AMOUNT}\\s?(?:[€£$]|${CODE}))`, 'iu');
const PRICE_OVER = new RegExp(`\\b(?:over|above|more than|at least)\\s+(${SYMBOL}\\s?${AMOUNT}|${AMOUNT}\\s?(?:[€£$]|${CODE}))`, 'iu');
const STOCK_QUESTION = /\b(in[- ]stock|available|availability)\b/i;
// A rating bound: "a rating of 8 or more", "rated 8+", "rating at least 4.5", "4 stars or more", "8+ rating", "a score
// above 8". A bare "rating of 8" is no bound. `above`/`over` are strict.
const RATING_NOUN = String.raw`(?:(?:guest |review |customer )?rat(?:ed|ings?)|scor(?:ed|es?)|stars?)`;
const RATING_NUM = String.raw`(\d{1,2}(?:[.,]\d)?)(?:\s*(?:\/|out of)\s*(?:5|10|100))?`;
const OR_MORE = String.raw`(?:\s*\+|\s+or\s+(?:more|higher|above|better|over)|\s+and\s+(?:up|above|over|higher)|\s+plus)`;
const RATING_LEAD_WORDS = String.raw`(at least|no less than|min(?:imum)?(?: of)?|above|over|more than|higher than|better than|>=?|≥)`;
const RATING_MIN_AFTER = new RegExp(String.raw`\b${RATING_NOUN}\s*(?:of\s+|:\s*)?(?:${RATING_LEAD_WORDS}\s+)?${RATING_NUM}(?:\s*stars?)?(${OR_MORE})?`, 'iu');
const RATING_MIN_BEFORE = new RegExp(String.raw`(?:${RATING_LEAD_WORDS}\s+)?(?<![\d.,])${RATING_NUM}\s*(\+)?\s*-?\s*${RATING_NOUN}(${OR_MORE})?`, 'iu');
// The rating as the measure: "the highest rated", "best-rated", "top rated", "highest rating", "lowest score".
const RATING_MAX = /\b(?:highest|best|top)[- ](?:rated|reviewed|scored)\b|\b(?:highest|best|top)\s+(?:guest\s+|review\s+|customer\s+)?(?:rating|score)s?\b/i;
const RATING_MIN = /\b(?:lowest|worst)[- ](?:rated|reviewed|scored)\b|\b(?:lowest|worst)\s+(?:guest\s+|review\s+|customer\s+)?(?:rating|score)s?\b/i;

/** The rating bound a question sets, or null: `{ min, strict }`. */
export function ratingBound(question) {
  const text = String(question ?? '');
  for (const [pattern, lead, num, plus, more] of [[RATING_MIN_AFTER, 1, 2, null, 3], [RATING_MIN_BEFORE, 1, 2, 3, 4]]) {
    const match = pattern.exec(text);
    if (!match) continue;
    const leadWord = match[lead];
    if (!leadWord && !(plus && match[plus]) && !match[more]) continue;
    const min = Number(match[num].replace(',', '.'));
    if (!Number.isFinite(min) || min > 100) continue;
    return { min, strict: /^(?:above|over|more than|higher than|better than|>)$/i.test(leadWord ?? ''), span: [match.index, match.index + match[0].length] };
  }
  return null;
}

/** The question without its rating bound ("rating at least 8" is a filter, not a "least" extremum). */
function unbounded(text) {
  const span = ratingBound(text)?.span;
  return span ? `${text.slice(0, span[0])} ${text.slice(span[1])}` : text;
}
const IN_STOCK =/\bin[- ]stock\b|\bavailable\b/i;
const OUT_OF_STOCK = /\bout[- ]of[- ]stock\b|\bsold[- ]out\b|\bunavailable\b|\bnot (?:in stock|available)\b|\bno stock\b/i;
// Words of the question that describe the aggregation rather than the items.
const AGGREGATE_WORDS = new Set(tokenize('cheapest lowest highest least most expensive priciest earliest latest soonest smallest '
  + 'largest biggest fewest minimum maximum shortest longest price priced cost costs fare stock available availability across '
  + 'between before after under below over above rating ratings rated score scored stars star reviews'));

// ---------------------------------------------------------------------------------------------------------------
// Unread conditions: what the question asks of the items that the intent does not parse
// ---------------------------------------------------------------------------------------------------------------
//
// The intent reads an extremum, a measure and a few filters (a rating bound, a price bound, a time window, stock). A
// question can say more about its items: "the cheapest hotel with free cancellation", "the cheapest laptop that has
// 16 GB of RAM", "the lowest price plan without ads". The aggregation then orders every item it read, and its first
// item may fail the unread condition, so a computed minimum is never confirmed then. What the intent consumed (its patterns' spans, and the measure's own nouns) is
// blanked out first; then a condition marker that still introduces a word is an unread condition. The markers, plain
// English and short on purpose:
//   with, without, including, excluding, except, only, near, within   + a word (not its/their/his/her: "with its
//                                                                         name and price" asks for fields)
//   that / which / who + has, have, had, offers, includes, is, are, comes, allows, supports, provides, contains,
//                        lets + a word ("which is the cheapest" is the extremum itself, blanked out)
//   free <word>, <word>-free                                             ("free cancellation", "ad-free")
//   no <word>                                                            ("no stops"; "no later than" is a window)
// A determiner (the, a, an, any, some) between the marker and its word is skipped. Phrases about the stay rather than
// the items ("for the stay of 1-4 March 2027", "for 2 adults", "per night") carry no marker; a parsed filter ("with a
// rating of 8 or more", "with a price under €50") and a party size ("with 2 adults") are blanked out before the markers
// are read. Missing a marker only
// keeps the earlier behaviour (the override); a false one only keeps a block.
const BLANK = '\u2027';
const DETERMINER = String.raw`(?:(?:the|a|an|any|some)\s+)?`;
// The clause's first word, never a determiner itself (so an optional DETERMINER cannot be skipped by backtracking).
const CLAUSE_WORD = String.raw`(?!(?:the|a|an|any|some)\s)([\p{L}\d][\p{L}\d'’-]*)`;
const CONDITION_MARKERS = [
  new RegExp(String.raw`\b(?:with|without|including|excluding|except|only|near|within)\s+${DETERMINER}${CLAUSE_WORD}`, 'giu'),
  new RegExp(String.raw`\b(?:that|which|who)\s+(?:also\s+)?(?:has|have|had|offers?|includes?|is|are|comes?|allows?|supports?|provides?|contains?|lets?)\s+${DETERMINER}${CLAUSE_WORD}`, 'giu'),
  new RegExp(String.raw`\bfree\s+${CLAUSE_WORD}|\b[\p{L}]+-free\b`, 'giu'),
  new RegExp(String.raw`\bno\s+${CLAUSE_WORD}`, 'giu'),
];
const OUTPUT_WORDS = new Set(['its', 'their', 'his', 'her', 'it', 'them']);
// The measure's own nouns, consumed with it ("with a departure time between 10:00 and 12:00", "with the lowest fare").
const MEASURE_NOUNS = /\b(?:depart\w*|arriv\w*|leav\w*|times?|reviews?|value|amount|total)\b/giu;
// Party and stay sizes are about the search, not the items ("with 2 adults", "for 3 nights").
const PARTY_SIZE = /\b(?:for|with)\s+\d+\s+(?:adults?|guests?|people|persons?|travell?ers?|passengers?|children|kids|rooms?|nights?)\b/giu;
const UNREAD_SNIPPET = 40;

/**
 * The condition clauses of `text` that the intent did not consume, as short snippets of the host's question (empty when
 * none): every pattern the intent matched is blanked out, then each CONDITION_MARKERS match that still introduces a
 * word is one snippet.
 */
export function unreadConditions(text) {
  let rest = String(text ?? '');
  const blank = (start, end) => {
    rest = rest.slice(0, start) + BLANK.repeat(end - start) + rest.slice(end);
  };
  const rating = ratingBound(rest)?.span;
  if (rating) blank(rating[0], rating[1]);
  for (const pattern of [PRICE_MIN, PRICE_MAX, RATING_MAX, RATING_MIN, TIME_MIN, TIME_MAX, GENERIC_MIN, GENERIC_MAX,
    WINDOW_BETWEEN, WINDOW_DASH, WINDOW_BEFORE, WINDOW_AFTER, MORNING, PRICE_UNDER, PRICE_OVER, STOCK_QUESTION, PRICE_WORDS,
    MEASURE_NOUNS, PARTY_SIZE, new RegExp(RATING_NOUN, 'giu')]) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of [...rest.matchAll(global)]) blank(match.index, match.index + match[0].length);
  }
  const out = [];
  for (const pattern of CONDITION_MARKERS) {
    for (const match of rest.matchAll(pattern)) {
      const word = (match[1] ?? match[0]).toLowerCase();
      if (OUTPUT_WORDS.has(word)) continue;
      out.push(clip(text.slice(match.index, match.index + match[0].length + UNREAD_SNIPPET).split(/[,;?]/)[0], UNREAD_SNIPPET));
    }
  }
  return [...new Set(out)];
}

function timeOf(text) {
  const named = NAMED_TIME[String(text ?? '').trim().toLowerCase()];
  if (named !== undefined) return named;
  return timeValues(text)[0] ?? null;
}

/**
 * What the question aggregates, or null: `{ op: 'min'|'max'|'filter', measure: 'price'|'time'|'count'|null,
 * window?: {from, to} (minutes, inclusive), priceMax?, priceMin?, stock?: true, unread?: [snippets], terms: Set }`.
 * `terms` are the question's item words (aggregation words removed), used for counts and for category cells; `unread`
 * the condition clauses it did not parse (unreadConditions), present only when there are some.
 */
export function aggregateIntent(question) {
  const text = String(question ?? '');
  if (!text.trim()) return null;
  let op = null;
  let measure = null;
  if (PRICE_MIN.test(text)) [op, measure] = ['min', 'price'];
  else if (PRICE_MAX.test(text)) [op, measure] = ['max', 'price'];
  else if (RATING_MAX.test(text)) [op, measure] = ['max', 'rating'];
  else if (RATING_MIN.test(text)) [op, measure] = ['min', 'rating'];
  else if (TIME_MIN.test(text)) [op, measure] = ['min', 'time'];
  else if (TIME_MAX.test(text)) [op, measure] = ['max', 'time'];
  else if (GENERIC_MIN.test(unbounded(text))) [op, measure] = ['min', PRICE_WORDS.test(text) ? 'price' : 'count'];
  else if (GENERIC_MAX.test(unbounded(text))) [op, measure] = ['max', PRICE_WORDS.test(text) ? 'price' : 'count'];
  const intent = { op, measure };
  const between = WINDOW_BETWEEN.exec(text) ?? WINDOW_DASH.exec(text);
  if (between) {
    const [from, to] = [timeOf(between[1]), timeOf(between[2])];
    // "between 22:00 and 02:00" spans midnight: the window wraps (a dash range in the other order too).
    if (from !== null && to !== null) intent.window = from <= to ? { from, to } : { from, to, wrap: true };
  } else {
    const before = WINDOW_BEFORE.exec(text);
    const after = WINDOW_AFTER.exec(text);
    if (before || after) {
      intent.window = { from: after ? timeOf(after[1]) ?? 0 : 0, to: before ? timeOf(before[1]) ?? 24 * 60 : 24 * 60 };
    } else if (MORNING.test(text)) {
      intent.window = { from: 0, to: 720 };
    }
  }
  const under = PRICE_UNDER.exec(text);
  if (under) intent.priceMax = moneyValues(under[1])[0];
  const over = PRICE_OVER.exec(text);
  if (over) intent.priceMin = moneyValues(over[1])[0];
  if (STOCK_QUESTION.test(text)) intent.stock = true;
  const rating = ratingBound(text);
  if (rating) {
    intent.ratingMin = rating.min;
    if (rating.strict) intent.ratingStrict = true;
  }
  const filters = Boolean(intent.window || intent.priceMax !== undefined || intent.priceMin !== undefined || intent.stock
    || intent.ratingMin !== undefined);
  if (!op && !filters) return null;
  if (!op) {
    intent.op = 'filter';
    intent.measure = intent.window ? 'time' : intent.priceMax !== undefined || intent.priceMin !== undefined ? 'price'
      : intent.ratingMin !== undefined ? 'rating' : null;
  }
  const unread = unreadConditions(text);
  if (unread.length) intent.unread = unread;
  intent.terms = new Set(tokenize(text, { query: true }).filter(word => !AGGREGATE_WORDS.has(word) && !/^\d/.test(word)));
  return intent;
}

/** The intent as a short machine code: `min_price`, `filter_time`, ... (`filter` without a measure). */
export function aggregateCode(intent) {
  if (!intent) return null;
  return intent.measure ? `${intent.op}_${intent.measure}` : intent.op;
}

/** Every rating a line states, in order: one per " · " or " | " part (a record line, a table row), else the line's. */
export function ratingsOf(text) {
  const value = String(text ?? '');
  const out = value.split(/\s+[·|]\s+/).map(ratingValue).filter(Boolean);
  if (!out.length) {
    const one = ratingValue(value);
    if (one) out.push(one);
  }
  return out;
}

/**
 * The rating of a line for the intent: a record's typed hints first (the page script's rating is the one read next to
 * the review count), then the ratings its text states. A bound above 5 ("rated 8 or more") is on a scale above 5, so
 * a 5-point rating (a star class, "4 out of 5") neither passes nor fails it; a bound of 5 or less prefers a 5-point
 * rating when the line has one.
 */
export function ratingFor(text, intent, hints = null) {
  const all = [];
  if (typeof hints?.rating === 'number') all.push({ value: hints.rating, scale: hints.scale });
  if (Array.isArray(hints?.ratings)) {
    for (const item of hints.ratings) if (typeof item?.value === 'number') all.push({ value: item.value, scale: item.scale });
  }
  all.push(...ratingsOf(text));
  if (!all.length) return null;
  const bound = intent?.ratingMin;
  if (bound !== undefined && bound > 5) return all.find(item => !item.scale || item.scale > 5) ?? null;
  if (bound !== undefined) return all.find(item => item.scale === 5) ?? all[0];
  return all[0];
}

/**
 * The value a line has for the intent's measure, or null. `hints` (a record's typed hints from the page script, see
 * src/digest.js recordsOf) is the fallback when the line's text does not state the value itself.
 */
export function itemValue(text, intent, hints = null) {
  switch (intent?.measure) {
    case 'price':
      return moneyValues(text)[0] ?? (hints?.price ? moneyValues(hints.price)[0] ?? null : null);
    case 'rating':
      return ratingFor(text, intent, hints)?.value ?? null;
    case 'time': {
      // Inside a window that wraps midnight, an after-midnight time orders after the evening ones.
      const time = timeOf(text);
      return time !== null && intent.window?.wrap && time <= intent.window.to ? time + 24 * 60 : time;
    }
    case 'count':
      return countValue(text, intent.terms ?? new Set());
    default:
      return null;
  }
}

/** Whether a line passes the intent's filters (window, price bounds, stock, rating) and has the measure's value. */
export function passesFilters(text, intent, hints = null) {
  if (!intent) return false;
  const value = String(text ?? '');
  if (intent.measure && itemValue(value, intent, hints) === null) return false;
  if (intent.ratingMin !== undefined) {
    const rating = ratingFor(value, intent, hints)?.value ?? null;
    if (rating === null) return false;
    if (intent.ratingStrict ? rating <= intent.ratingMin : rating < intent.ratingMin) return false;
  }
  if (intent.window) {
    const time = timeOf(value);
    if (time === null) return false;
    const inside = intent.window.wrap ? time >= intent.window.from || time <= intent.window.to
      : time >= intent.window.from && time <= intent.window.to;
    if (!inside) return false;
  }
  if (intent.priceMax !== undefined || intent.priceMin !== undefined) {
    const price = moneyValues(value)[0];
    if (price === undefined) return false;
    if (intent.priceMax !== undefined && price > intent.priceMax) return false;
    if (intent.priceMin !== undefined && price < intent.priceMin) return false;
  }
  if (intent.stock && OUT_OF_STOCK.test(value)) return false;
  return true;
}

// What makes a line's value unsafe to order by: several different amounts (a range, a struck-through old price,
// per-person next to total), an approximate amount ("from €94", "€94+"), a number split by a plain space ("1 299 €"
// reads as 299), several times when the question does not say departure, a next-day marker, or no stock wording
// when the question asks for stock. A note never drops an item; it makes the aggregation partial (never confirmed).
const APPROX_BEFORE = /(?:\b(?:from|starting(?: at| from)?|as low as|as little as|ab|desde|dès|à partir de|approx\.?|about|around|circa|ca\.?)|~|≈)\s*$/iu;
const APPROX_AFTER = /^\s?(?:\+(?!\s?\d)|\s?or more\b|\s?and up\b)/iu;
const FIRST_TIME_QUESTION = /\b(depart\w*|leav\w*|start\w*|open\w*|begin\w*)\b/i;
const NEXT_DAY = /\(\s?\+\s?\d\s?\)|\+\s?1\s?(?:day|d)\b|\bnext day\b|\bovernight\b/i;
const UNIT = /\b(?:per|a|\/)\s?(person|adult|guest|night|day|week|month|year|seat|user|unit|kg|item)\b|\b(pp|p\.p\.|each|total|in total)\b/iu;
const CURRENCY_OF = [
  [/US\$|\busd\b|\bdollars?\b/iu, 'usd'], [/C\$|\bcad\b/iu, 'cad'], [/A\$|\baud\b/iu, 'aud'],
  [/€|\beur\b|\beuros?\b/iu, 'eur'], [/£|\bgbp\b|\bpounds?\b/iu, 'gbp'], [/¥/u, 'jpy'], [/₹/u, 'inr'], [/\bchf\b/iu, 'chf'],
  [/\$/u, 'usd'],
];

/** The currency of each amount in `text`, in order (`eur`, `usd`, ...). */
export function moneyCurrencies(text) {
  return [...String(text ?? '').matchAll(MONEY_SPAN)].map(match => {
    const span = match[0];
    return CURRENCY_OF.find(([pattern]) => pattern.test(span))?.[1] ?? 'unknown';
  });
}

/** The unit a price line states ("per person", "total", ...), or "none". */
export function priceUnit(text) {
  const match = UNIT.exec(String(text ?? ''));
  if (!match) return 'none';
  const unit = (match[1] ?? match[2]).toLowerCase().replace(/\./g, '');
  return unit === 'in total' ? 'total' : unit === 'pp' || unit === 'adult' || unit === 'guest' ? 'person' : unit;
}

/**
 * Fixed codes for what makes an item's value unsafe to order by (empty when it is safe): `ambiguous_value`,
 * `approximate_value`, `stock_unknown`, `unnamed_item`, `decoy_name`. Never page text.
 */
export function valueNotes(text, intent, question = '') {
  const value = String(text ?? '');
  const notes = new Set();
  if (intent?.measure === 'price' || intent?.priceMax !== undefined || intent?.priceMin !== undefined) {
    const spans = [...value.matchAll(MONEY_SPAN)];
    if (new Set(spans.map(match => parseAmount(match[1] ?? match[2]))).size > 1) notes.add('ambiguous_value');
    for (const match of spans) {
      if (APPROX_BEFORE.test(value.slice(0, match.index)) || APPROX_AFTER.test(value.slice(match.index + match[0].length))) {
        notes.add('approximate_value');
      }
      // "1 299 €": a digit and a plain space right before the amount.
      if (/\d[ \t]$/.test(value.slice(0, match.index))) notes.add('ambiguous_value');
    }
  }
  if (intent?.measure === 'time' || intent?.window) {
    const times = timeValues(value);
    if (new Set(times).size > 1 && !FIRST_TIME_QUESTION.test(question)) notes.add('ambiguous_value');
    if (NEXT_DAY.test(value)) notes.add('ambiguous_value');
  }
  if (intent?.stock && !IN_STOCK.test(value) && !OUT_OF_STOCK.test(value)) notes.add('stock_unknown');
  const terms = intent?.terms ?? new Set();
  const words = tokenize(value.replace(MONEY_SPAN, ' ').replace(TIME_SPAN, ' '));
  const named = words.some(word => terms.has(word));
  // "Shipping €4.99" on a product page: a short label and a value, no item word.
  if (!named && value.replace(MONEY_SPAN, ' ').replace(TIME_SPAN, ' ').split(/[^\p{L}]+/u).filter(w => w.length > 1).length <= 2) {
    notes.add('unnamed_item');
  }
  // "Tent pegs | €9" for "which tent": the name cell has the item word, but not as its last word.
  const name = value.split(/\s+[|·•]\s+|\s+[—–-]\s+/)[0];
  const nameWords = name.split(/\s+/).filter(word => /\p{L}/u.test(word) && !/\d/.test(word)).map(word => tokenize(word)[0]).filter(Boolean);
  if (nameWords.some(word => terms.has(word)) && !terms.has(nameWords.at(-1))) notes.add('decoy_name');
  return [...notes];
}

/** Whether a table row has a whole cell made only of question item words ("Tents" for "Which tent ..."). */
export function categoryCell(text, terms) {
  const cells = String(text ?? '').split(/\s+\|\s+/);
  if (cells.length < 2 || !terms?.size) return false;
  return cells.some(cell => {
    const words = tokenize(cell);
    return words.length > 0 && words.length <= 2 && words.every(word => terms.has(word));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Lines of one page state
// ---------------------------------------------------------------------------------------------------------------

const HEADING = new Set(['h2', 'h3', 'h4']);
const ANY_HEADING = new Set(['h1', 'h2', 'h3', 'h4']);

function clip(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** The nearest heading above block `index` when it is a section heading (h2-h4), else null. */
function contextOf(blocks, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (!ANY_HEADING.has(blocks[i].t)) continue;
    return HEADING.has(blocks[i].t) ? blocks[i].text : null;
  }
  return null;
}

/**
 * Candidate lines of one observation for `question`: `{ key, text, context?, score, t, value?, item?, category? }`,
 * best first. `item` marks a line that has the intent's value and passes its filters. `mainList` is the record list
 * the question is about (default 0, the page script's best list).
 */
export function factPool(observation, question, intent = aggregateIntent(question), { mainList = 0 } = {}) {
  const { blocks } = scoreBlocks(observation, question);
  const out = [];
  const candidates = pickAnswerCandidates(observation, question, { max: FACT_POOL });
  // An aggregating question reads every record of the page's lists, not only those that share a word with it: a
  // list's records are its items (src/digest.js recordsOf).
  if (intent) {
    const taken = new Set(candidates.map(candidate => candidate.index));
    const seen = new Set(candidates.map(candidate => candidate.text.toLowerCase()));
    blocks.forEach((block, index) => {
      if (!block.record || taken.has(index) || seen.has(block.text.toLowerCase())) return;
      seen.add(block.text.toLowerCase());
      const entry = { t: block.t, text: block.text, index, score: 0.01 };
      if (block.ref !== undefined) entry.ref = block.ref;
      candidates.push(entry);
    });
  }
  const tiers = new Map(); // item line -> 0 (the main record list), 1 (another record list), 2 (a block)
  for (const candidate of candidates) {
    const line = { key: candidate.text.toLowerCase(), text: candidate.text, score: candidate.score, t: candidate.t };
    // A detected record (src/digest.js recordsOf): one item with its name, its fields and the page's typed hints.
    const record = candidate.t === 'list' ? null : blocks[candidate.index]?.record ?? null;
    const context = candidate.t === 'list' ? null : contextOf(blocks, candidate.index);
    if (context && !candidate.text.toLowerCase().includes(context.toLowerCase())) line.context = context;
    if (record) line.record = record.id;
    const hints = record?.hints ?? null;
    // An unavailable record (sold out) offers no price to rank.
    const offered = !(record?.unavailable && intent?.measure === 'price');
    if (intent && candidate.t !== 'list' && offered && passesFilters(candidate.text, intent, hints)) {
      line.item = true;
      const value = itemValue(candidate.text, intent, hints);
      if (value !== null) line.value = value;
      if (categoryCell(candidate.text, intent.terms)) line.category = true;
      let notes = valueNotes(candidate.text, intent, question);
      // A record with a title is named by it; its title is a proper name, not a category word in the wrong place.
      if (record?.title) notes = notes.filter(note => note !== 'unnamed_item' && note !== 'decoy_name');
      if (notes.length) line.notes = notes;
      if (intent.measure === 'price') {
        line.currency = moneyCurrencies(candidate.text)[0] ?? 'unknown';
        line.unit = priceUnit(candidate.text);
      }
    }
    out.push(line);
    // Only a question that ranks or bounds a value (cheapest, rated 8 or more) orders the lists; a filter without a
    // measure ("available on") keeps every item.
    if (line.item && intent?.measure) tiers.set(line, record ? (record.list === mainList ? 0 : 1) : 2);
  }
  // The page's main results first: when the main record list (`mainList`, default list 0, the
  // page script's best) has items for the question, only they are items; else the other lists' records (a carousel, a
  // module); else the plain blocks. A carousel of cheaper extras never wins a question about the results, and a
  // question about the extras still finds them.
  const tier = Math.min(...tiers.values());
  for (const [line, level] of tiers) {
    if (level === tier) continue;
    for (const key of ['item', 'value', 'category', 'notes', 'currency', 'unit']) delete line[key];
  }
  return out;
}

/** The text a remembered line is shown and ranked as: its section heading, then the line. */
export function lineText(line) {
  return line.context ? `${line.context} › ${line.text}` : line.text;
}

// ---------------------------------------------------------------------------------------------------------------
// The memory: every state of the run, bounded
// ---------------------------------------------------------------------------------------------------------------

const PAGE_OF = /\bpage\s+(\d{1,4})\s+of\s+(\d{1,4})\b/i;
const SHOWING_OF = /\bshowing\s+(\d{1,5})\s+of\s+(\d{1,5})\b/i;
const MORE_CONTROL = /^(?:next page|next results|load more|show more|show \d+ more|more results|see more|view more|older (?:posts|results|items)|next\s*[›»→>]?$|[›»→>]$)/i;

function textsOf(observation) {
  const blocks = Array.isArray(observation?.blocks) && observation.blocks.length ? observation.blocks : null;
  if (blocks) return blocks.map(block => String(block?.text ?? ''));
  return String(observation?.text ?? '').split(/\n+/);
}

/**
 * Whether the states cover their item set: every "Page X of Y" from 1 to Y seen, no "showing X of Y" (X < Y) state
 * left without a fuller one right after it, and no next-page or show-more control on the final state. Returns
 * `{ complete, why: [codes] }`.
 */
export function coverage(states) {
  const why = [];
  let total = 0;
  const pages = new Set();
  const showing = [];
  for (const state of states) {
    let partialHere = false;
    for (const text of textsOf(state.observation)) {
      const page = PAGE_OF.exec(text);
      if (page) {
        pages.add(Number(page[1]));
        total = Math.max(total, Number(page[2]));
      }
      const shown = SHOWING_OF.exec(text);
      if (shown && Number(shown[1]) < Number(shown[2])) partialHere = true;
    }
    showing.push(partialHere);
  }
  if (total > 1 && total <= 1000) {
    for (let n = 1; n <= total; n++) {
      if (!pages.has(n)) {
        why.push('pages_unread');
        break;
      }
    }
  }
  if (showing.some((partial, i) => partial && (i === showing.length - 1 || showing[i + 1]))) why.push('more_unread');
  const last = states.at(-1)?.observation;
  const controls = Array.isArray(last?.controls) ? last.controls : [];
  const offered = controls.some(control => control?.enabled !== false && control?.visible !== false
    && MORE_CONTROL.test(String(control?.label ?? '').trim()))
    || (Array.isArray(last?.blocks) && last.blocks.some(block => (block?.t === 'a' || block?.t === 'button')
      && MORE_CONTROL.test(String(block?.text ?? '').trim())));
  if (offered) why.push('more_offered');
  // The page script read fewer records than its list holds (extension/page.js MAX_RECORDS).
  if (last?.recordsTruncated === true) why.push('records_cut');
  return { complete: why.length === 0, why };
}

/**
 * The bounded fact memory over `states` (`[{ state, step, url, title, revision, observation, carried? }]`, one per
 * semantic revision, first-seen order): per state at most FACT_STATE_ITEMS aggregation items (all of them for the
 * state whose key is `finalKey`, the final page) and FACT_STATE_LINES other lines (AGGREGATE_EXTRA_LINES next to
 * items; lines scoring at least FACT_MIN_SCORE; a line seen in an earlier state is not repeated), at most
 * runLineBudget(states) in all (the lowest-scoring non-item lines go first). `redact` is applied to every page string;
 * `mainList` is the final page's main record list (factPool).
 * Returns `{ states: [{ state, step, url, title, revision, carried?, lines, droppedItems }], intent, category, dropped,
 * droppedItems }`: `droppedItems` (per state, and in all) are aggregation items the bounds left out (`memory_full`).
 */
export function buildMemory(states, question, { redact = value => value, finalKey = null, mainList = 0 } = {}) {
  let intent = aggregateIntent(question);
  // The main list chosen for the final page applies to that page's state only: list numbers are per observation.
  const pools = states.map(state => factPool(state.observation, question, intent,
    { mainList: finalKey !== null && state.key === finalKey ? mainList : 0 }));
  if (intent && !pools.some(pool => pool.some(line => line.item))) intent = null;
  // A category column ("Tents") the question names: when any item has one, only items with one count.
  const category = Boolean(intent && pools.some(pool => pool.some(line => line.item && line.category)));
  const seen = new Set();
  let droppedItems = 0;
  let dropped = 0;
  const records = states.map((state, i) => {
    const pool = pools[i].filter(line => !seen.has(line.key));
    for (const line of pool) {
      if (intent && line.item && category && !line.category) line.item = false;
      if (!intent) delete line.item;
    }
    const items = intent ? pool.filter(line => line.item) : [];
    const rest = pool.filter(line => !line.item && line.score >= FACT_MIN_SCORE);
    const keepItems = finalKey !== null && state.key === finalKey ? items : items.slice(0, FACT_STATE_ITEMS);
    const droppedHere = items.length - keepItems.length;
    droppedItems += droppedHere;
    const keepRest = rest.slice(0, intent ? AGGREGATE_EXTRA_LINES : FACT_STATE_LINES);
    const lines = [...keepItems, ...keepRest];
    for (const line of lines) seen.add(line.key);
    return { state, lines, droppedItems: droppedHere };
  });
  // The run bound: the lowest-scoring non-item lines go first, then the lowest-scoring items (counted as unread).
  let total = records.reduce((sum, record) => sum + record.lines.length, 0);
  const budget = runLineBudget(states.length);
  if (total > budget) {
    const all = records.flatMap((record, r) => record.lines.map((line, l) => ({ r, l, line })));
    all.sort((a, b) => Number(Boolean(a.line.item)) - Number(Boolean(b.line.item)) || a.line.score - b.line.score || b.r - a.r);
    const drop = new Set();
    for (const entry of all) {
      if (total <= budget) break;
      drop.add(entry.line);
      total -= 1;
      dropped += 1;
      if (entry.line.item) {
        droppedItems += 1;
        records[entry.r].droppedItems += 1;
      }
    }
    for (const record of records) record.lines = record.lines.filter(line => !drop.has(line));
  }
  return {
    states: records.map(({ state, lines, droppedItems: droppedHere }) => ({
      state: state.state,
      step: state.step,
      url: redact(state.url),
      title: redact(state.title ?? ''),
      revision: state.revision,
      key: state.key,
      ...(state.carried ? { carried: true } : {}),
      droppedItems: droppedHere,
      lines: lines.map(line => {
        // A record line is kept whole (the page script caps it at 300 characters): its price is often its last field.
        const limit = line.record ? FACT_RECORD_LIMIT : FACT_LINE_LIMIT;
        const out = { key: line.key, text: redact(clip(line.text, limit)), score: line.score, t: line.t };
        if (line.context) out.context = redact(clip(line.context, CONTEXT_LIMIT));
        if (line.item) out.item = true;
        if (line.value !== undefined && line.item) out.value = line.value;
        if (line.item && line.notes) out.notes = [...line.notes];
        if (line.item && line.currency) out.currency = line.currency;
        if (line.item && line.unit) out.unit = line.unit;
        if (line.record) out.record = line.record;
        return out;
      }),
    })),
    intent,
    category,
    dropped,
    droppedItems,
  };
}

/**
 * The items of the memory in aggregation order: by value (ascending for min, descending for max, state order for a
 * filter), ties in state order. Returns `{ op, measure, code, items: [{ state, url, line }], states, tie }` or null when
 * the memory has no items. `states` is how many distinct states the items come from.
 */
export function aggregateItems(memory) {
  const intent = memory?.intent;
  if (!intent) return null;
  const items = [];
  for (const state of memory.states) {
    for (const line of state.lines) if (line.item) items.push({ state: state.state, url: state.url, step: state.step, line });
  }
  if (!items.length) return null;
  const sign = intent.op === 'max' ? -1 : 1;
  if (intent.op !== 'filter' && intent.measure) {
    items.sort((a, b) => sign * ((a.line.value ?? Infinity * sign) - (b.line.value ?? Infinity * sign)) || a.state - b.state);
  }
  const tie = intent.op !== 'filter' && items.length > 1 && items[0].line.value === items[1].line.value;
  // Why the order may be wrong although every item was read: fixed codes, never page text.
  const uncertain = new Set(items.flatMap(item => item.line.notes ?? []));
  // "From €60" on every item (a fare list) still orders consistently; only a mix of "from" and exact prices does not.
  if (items.every(item => item.line.notes?.includes('approximate_value'))) uncertain.delete('approximate_value');
  if (new Set(items.map(item => item.line.currency).filter(Boolean)).size > 1) uncertain.add('mixed_currency');
  if (new Set(items.map(item => item.line.unit).filter(Boolean)).size > 1) uncertain.add('mixed_units');
  return {
    op: intent.op,
    measure: intent.measure,
    code: aggregateCode(intent),
    items,
    states: new Set(items.map(item => item.state)).size,
    tie,
    uncertain: [...uncertain].sort(),
    ...(intent.unread ? { unread: [...intent.unread] } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Page scope: which remembered states belong to the page the question is about
// ---------------------------------------------------------------------------------------------------------------
//
// A per-day results loop starts each run (or list step) on the previous day's page, so the memory holds that day's
// rows too: "Which flights between 10:00 and 12:00 on Oct 13?" must not rank an Oct 12 row first (gf-week-window,
// 2026-10-06). A results page says which day it is in a "departing 2026-10-13" sentence, in its title, or in its URL
// (as text, or base64 inside a query value like Google Flights' `tfs`). States keyed to another day than the
// question's (or, when the question names none, than the final page's) are not answer candidates; they stay in the
// trail. Pages without a date key are never scoped, and a question or instruction that spans days ("over Mon 12 Oct
// to Sun 18 Oct", "each day", "this week") keeps every state.

const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const WEEKDAY = '(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?\\s+)?';
const ISO_DATE = '(20\\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])';
const DAY_FIRST = `${WEEKDAY}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}(?:,?\\s+(20\\d{2}))?`;
const MONTH_FIRST = `${WEEKDAY}${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])(?:,?\\s+(20\\d{2}))?`;
const DATE_ANY = new RegExp(`(?<![\\d-])${ISO_DATE}(?![\\d])|\\b${DAY_FIRST}\\b|\\b${MONTH_FIRST}`, 'giu');
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// The sentence a results page states its own day in ("departing 2026-10-13", "Departures on Tue 13 Oct").
const PAGE_DATE_LEAD = /\b(?:departing|departs|departures?\s+on|departure\s+date:?|flights?\s+on|outbound(?:\s+on)?|leaving\s+on)\s+$/i;
// A question or instruction about several days at once.
const SPANS_DAYS = /\b(?:across|each|every|throughout|per\s+day|daily|weekly|week|weekend|days|dates|overall|until|through|since|all\s+(?:the\s+)?(?:days|dates|pages))\b/i;
// Several days however many dates parse ("Oct 12-13", "12 or 13 October", "from the 7th to the 13th", "Tuesday and
// Wednesday", "which day", "any day"): checked whatever the question names. A time range ("10:00 and 12:00") is not.
const DAY_RANGE = new RegExp([
  '(?<![\\d:.,€$£])\\d{1,2}(?:st|nd|rd|th)?\\s*(?:-|–|—|to|or|and|&|through|until|thru)\\s*(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?(?![\\d:.,%])',
  '\\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?\\s*(?:-|–|—|,|&|and|or|to|through|until|thru)\\s*(?:on\\s+)?(?:mon|tue|wed|thu|fri|sat|sun)',
  '\\b(?:which|what|any|whichever|either|both|other|several|multiple|two|three)\\s+(?:\\w+\\s+)?(?:day|date|night)s?\\b',
].join('|'), 'iu');

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Dates written in `text`, in order: `[{ md: 'MM-DD', year: 'YYYY'|null }]` (ISO, "13 Oct", "Tue, Oct 13, 2026"). */
export function datesIn(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(DATE_ANY)) {
    let year = null;
    let month;
    let day;
    if (match[1]) [year, month, day] = [match[1], Number(match[2]), Number(match[3])];
    else if (match[4]) [day, month, year] = [Number(match[4]), MONTHS.indexOf(match[5].slice(0, 3).toLowerCase()) + 1, match[6] ?? null];
    else [month, day, year] = [MONTHS.indexOf(match[7].slice(0, 3).toLowerCase()) + 1, Number(match[8]), match[9] ?? null];
    if (month < 1 || day < 1 || day > 31) continue;
    out.push({ md: `${pad(month)}-${pad(day)}`, year, index: match.index, end: match.index + match[0].length });
  }
  return out;
}

/** Distinct dates named in `text` (by month and day). */
function namedDates(text) {
  const seen = new Map();
  for (const date of datesIn(text)) if (!seen.has(date.md)) seen.set(date.md, { md: date.md, year: date.year });
  return [...seen.values()];
}

/** ISO dates inside a URL: in its decoded text, or base64-encoded inside a query value (`tfs=...`). */
function urlDates(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? ''));
  } catch {
    return [];
  }
  let text = '';
  try {
    text = decodeURIComponent(`${parsed.pathname}?${parsed.search}`);
  } catch {
    text = `${parsed.pathname}?${parsed.search}`;
  }
  const iso = new RegExp(ISO_DATE, 'g');
  const found = [...text.matchAll(iso)].map(m => ({ md: `${m[2]}-${m[3]}`, year: m[1] }));
  if (found.length) return found;
  for (const value of parsed.searchParams.values()) {
    if (value.length < 12 || value.length > 2000 || !/^[A-Za-z0-9_+/-]+={0,2}$/.test(value)) continue;
    let raw = '';
    try {
      raw = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
    } catch {
      continue;
    }
    for (const m of raw.matchAll(iso)) found.push({ md: `${m[2]}-${m[3]}`, year: m[1] });
  }
  return found;
}

/**
 * The day a page state is about, or null: `{ md, year, from: 'text'|'title'|'url' }`. The page's own sentence
 * ("departing 2026-10-13") comes first, since the URL of a single-page app can change before its content does; then
 * a single date in the title; then a single date in the URL. Several different dates in a source make it no key.
 */
export function pageDate(observation) {
  const texts = textsOf(observation);
  const stated = [];
  for (const text of texts) {
    for (const date of datesIn(text)) {
      if (PAGE_DATE_LEAD.test(text.slice(Math.max(0, date.index - 40), date.index))) stated.push(date);
    }
  }
  const one = (dates, from) => {
    const days = new Set(dates.map(date => date.md));
    return days.size === 1 ? { md: dates[0].md, year: dates.find(date => date.year)?.year ?? null, from } : null;
  };
  return one(stated, 'text') ?? one(datesIn(observation?.title ?? ''), 'title') ?? one(urlDates(observation?.url), 'url');
}

/** Whether two date keys name the same day (the year counts only when both have one). */
export function sameDay(a, b) {
  return Boolean(a && b) && a.md === b.md && (!a.year || !b.year || a.year === b.year);
}

/**
 * The page scope of an answer over `states` (memory states with `observation`, `url`, `step`), for the final
 * `observation`: `{ states, excluded, collapsed, target, mismatch, spans }` (`spans`: the question or instruction is
 * about several days or pages, so every state keeps its say).
 *
 * 1. Settled revisions: a state followed by another state of the same URL with no action in between (the same
 *    `step`) and at least as many text lines is the same document half-rendered (a first paint, a loading
 *    placeholder); only the later one counts.
 * 2. Day scope: unless the question or the instruction spans days, the target day is the one the question names
 *    (else the one the instruction names, else the final page's own day); states keyed to another day are excluded.
 */
export function answerScope(states, observation, { question = '', instruction = '' } = {}) {
  const collapsed = [];
  const settled = states.filter((state, i) => {
    const next = states[i + 1];
    // Only when the later revision has at least as much text: one that lost lines (a transient re-render, a loading
    // skeleton after the rows) is not the settled page, and both stay.
    const same = next && next.step === state.step && sameDocument(next.url, state.url) && state.observation !== observation
      && textLines(next.observation) >= textLines(state.observation);
    if (same) collapsed.push(state.state);
    return !same;
  });
  const asked = namedDates(question);
  const told = namedDates(instruction);
  const spans = asked.length > 1 || (asked.length === 0 && (told.length > 1 || SPANS_DAYS.test(instruction)))
    || (asked.length !== 1 && SPANS_DAYS.test(question)) || DAY_RANGE.test(question)
    || (asked.length === 0 && DAY_RANGE.test(instruction));
  let target = null;
  if (!spans) {
    if (asked.length === 1) target = { ...asked[0], from: 'question' };
    else if (told.length === 1) target = { ...told[0], from: 'instruction' };
    else {
      // The final page's own day only from its own sentence ("departing 2026-10-13"): a date in a title (an
      // article's publication date) or in a URL (a tracking parameter) says nothing about the data's day.
      const own = pageDate(observation);
      target = own?.from === 'text' ? own : null;
    }
  }
  const keys = target ? settled.map(state => pageDate(state.observation)) : [];
  // No page of the target day at all: nothing is excluded (that would leave only pages of other days or none), and
  // when another day's page was read the answer is about a day the run never showed (`mismatch`, never confirmed).
  const matched = keys.some(key => key !== null && sameDay(key, target));
  const mismatch = Boolean(target) && !matched && keys.some(key => key !== null);
  const excluded = [];
  const kept = target && matched ? settled.filter((state, i) => {
    const out = keys[i] !== null && !sameDay(keys[i], target);
    if (out) excluded.push(state.state);
    return !out;
  }) : settled;
  return { states: kept, excluded, collapsed, target, mismatch, spans };
}

/** How many non-empty text blocks (or lines) `observation` has. */
function textLines(observation) {
  return textsOf(observation).filter(text => text.trim()).length;
}

/** The same document: the same origin, path and query, ignoring the fragment and a trailing `tfu`-style marker. */
function sameDocument(a, b) {
  const norm = url => {
    try {
      const parsed = new URL(String(url ?? ''));
      parsed.hash = '';
      parsed.searchParams.delete('tfu');
      parsed.searchParams.sort();
      return parsed.href;
    } catch {
      return String(url ?? '');
    }
  };
  return norm(a) === norm(b);
}

/** The trace's `facts`: the memory without internal keys, at most FACT_TRACE_STATES states. */
export function traceFacts(memory) {
  return (memory?.states ?? []).slice(-FACT_TRACE_STATES).map(state => ({
    state: state.state,
    step: state.step,
    url: state.url,
    title: state.title,
    ...(state.revision ? { revision: state.revision } : {}),
    lines: state.lines.map(({ key, ...line }) => line),
  }));
}
