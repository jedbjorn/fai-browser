// Flight finding: the reviewed engine code of the flights task sub-skill (the host guide is SKILL.md beside this
// file). It ships two shortcut kinds a site profile may name (src/shortcuts.js registry, through tasks/index.js) and
// the task's own vocabulary. Nothing in src/ names flights; the Google Flights profile (domains/www.google.com) names
// the kinds by id.
//
// Google Flights `tfs`: the results URL /travel/flights/search?tfs=<value> carries the whole search as a base64url
// protobuf (no padding). For a one-way search it holds one flight-leg message (top-level field 3) whose field 2 is the
// departure date as a 10-byte string "YYYY-MM-DD":
//   08 1c 10 02 1a 28 | 12 0a "2026-10-07" | 6a 0c ... (origin) | 72 0c ... (destination) | ... 98 01 02
// withTfsDate walks the protobuf (varints, fixed 32/64-bit and length-delimited fields, nothing else), finds that
// string, replaces its 10 bytes with the new date (same length, so no length prefix changes) and re-encodes in the
// input's own alphabet and padding. It is not substring surgery on the base64 text: the base64 alignment of the date
// depends on what precedes it. A round trip, a multi-city search or a value it cannot parse yields null.
//
// Google Flights `q`: /travel/flights?q=<plain query> shows the results of a plain-text search, so a step that names
// the route and the date can land on them in one hop from the search page, without the date picker (whose textbox
// ignores typed text; a live run on 2026-10-08 found the picker fill reported done while the field stayed empty and
// this URL worked: ?q=One%20way%20flights%20from%20Marseille%20to%20London%20on%202027-01-12). The query text is
// built by code from the step's own words (the trip type, the two places after "from ... to ..." and the ISO dates)
// in one fixed form, URL-encoded, on the page's own origin and path; no step text goes into the URL as written.
import { Buffer } from 'node:buffer';
import { dateTexts, isIsoDate, isoDatesIn, plainDateIn, stepDate } from '../../src/dates.js';

/** The task's name, as tasks/index.js lists it. */
export const name = 'flights';

/** The longest `tfs` value accepted (a one-way search is about 70-100 characters). */
export const TFS_MAX = 1024;
// Top-level field 3 is a flight leg; inside it field 2 is the date.
const LEG_FIELD = 3;
const DATE_FIELD = 2;
const MAX_FIELDS = 200;

function readVarint(bytes, at) {
  let value = 0;
  let shift = 0;
  for (let index = at; index < bytes.length && index < at + 10; index++) {
    const byte = bytes[index];
    // Only lengths and field keys are used as numbers; larger values (the ff...01 varint) are skipped, not read.
    if (shift < 49) value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) return { value, next: index + 1 };
  }
  return null;
}

/**
 * The fields of one protobuf message in `bytes[start, end)`: `[{ field, wire, start, end }]` (start/end: the payload
 * of a length-delimited field, else the value bytes), or null when the bytes are not a well-formed message.
 */
function fieldsOf(bytes, start, end) {
  const out = [];
  for (let at = start; at < end;) {
    if (out.length >= MAX_FIELDS) return null;
    const key = readVarint(bytes, at);
    if (!key || key.next > end) return null;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (field < 1) return null;
    at = key.next;
    if (wire === 0) {
      const value = readVarint(bytes, at);
      if (!value || value.next > end) return null;
      out.push({ field, wire, start: at, end: value.next });
      at = value.next;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (at + size > end) return null;
      out.push({ field, wire, start: at, end: at + size });
      at += size;
    } else if (wire === 2) {
      const length = readVarint(bytes, at);
      if (!length || length.next + length.value > end) return null;
      out.push({ field, wire, start: length.next, end: length.next + length.value });
      at = length.next + length.value;
    } else {
      return null;
    }
  }
  return out;
}

/**
 * Decode a `tfs` value: `{ bytes, legs: [{ offset, date }], format: { urlSafe, padded } }`, or null when it is not
 * base64 of a well-formed protobuf. `legs` lists each top-level flight leg (field 3): its one date field holding a real
 * YYYY-MM-DD date (`offset`: the date's first byte in `bytes`), or `{ offset: -1, date: null }` for a leg without
 * exactly one.
 */
export function decodeTfs(value) {
  if (typeof value !== 'string' || !value || value.length > TFS_MAX || !/^[A-Za-z0-9_\-+/]+={0,2}$/.test(value)) return null;
  const urlSafe = !/[+/]/.test(value);
  if (!urlSafe && /[-_]/.test(value)) return null;
  const bytes = Buffer.from(value, urlSafe ? 'base64url' : 'base64');
  const format = { urlSafe, padded: value.endsWith('=') };
  // Node decodes leniently; only a value that encodes back to itself is accepted.
  if (encodeTfs(bytes, format) !== value) return null;
  const top = fieldsOf(bytes, 0, bytes.length);
  if (!top) return null;
  const legs = [];
  for (const leg of top) {
    if (leg.field !== LEG_FIELD || leg.wire !== 2) continue;
    const inner = fieldsOf(bytes, leg.start, leg.end);
    if (!inner) return null;
    const dates = inner.filter(entry => entry.field === DATE_FIELD && entry.wire === 2 && entry.end - entry.start === 10)
      .map(entry => ({ offset: entry.start, date: bytes.subarray(entry.start, entry.end).toString('latin1') }))
      .filter(entry => isIsoDate(entry.date));
    // Every leg counts: one without exactly one date (none, or two) is still a leg, so the search is not one-way.
    legs.push(dates.length === 1 ? dates[0] : { offset: -1, date: null });
  }
  return { bytes, legs, format };
}

/** Encode protobuf bytes as a `tfs` value in the given format (default base64url without padding). */
export function encodeTfs(bytes, { urlSafe = true, padded = false } = {}) {
  let text = Buffer.from(bytes).toString(urlSafe ? 'base64url' : 'base64');
  if (urlSafe && padded) text += '='.repeat((4 - (text.length % 4)) % 4);
  if (!urlSafe && !padded) text = text.replace(/=+$/, '');
  return text;
}

/** The departure date of a one-way `tfs` value ("YYYY-MM-DD"), or null (not parsable, or not exactly one leg). */
export function tfsDate(value) {
  const decoded = decodeTfs(value);
  return decoded?.legs.length === 1 ? decoded.legs[0].date : null;
}

/**
 * The `tfs` value with its one leg's departure date set to `date` (YYYY-MM-DD), in the input's own encoding; the
 * same value when the date is already `date`; null for an invalid date, an unparsable value or a search with more
 * than one leg (round trip, multi-city).
 */
export function withTfsDate(value, date) {
  if (!isIsoDate(date)) return null;
  const decoded = decodeTfs(value);
  if (decoded?.legs.length !== 1 || !decoded.legs[0].date) return null;
  const bytes = Buffer.from(decoded.bytes);
  bytes.write(date, decoded.legs[0].offset, 10, 'latin1');
  return encodeTfs(bytes, decoded.format);
}

function splitUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const query = parsed.search.startsWith('?') ? parsed.search.slice(1) : '';
  return { parsed, pairs: query ? query.split('&') : [] };
}

function tfsPair(pairs) {
  const found = pairs.filter(pair => pair.startsWith('tfs='));
  return found.length === 1 ? found[0] : null;
}

function rawValue(pair) {
  const raw = pair.slice(4);
  try {
    return { raw, value: decodeURIComponent(raw) };
  } catch {
    return null;
  }
}

/** The departure date of a Google Flights results URL (its one-way `tfs`), or null. */
export function flightsUrlDate(url) {
  const split = splitUrl(url);
  const pair = split && tfsPair(split.pairs);
  const value = pair && rawValue(pair);
  return value ? tfsDate(value.value) : null;
}

/**
 * The Google Flights results URL for another departure date: the same origin, path and query parameters in the same
 * order, with `tfs` rewritten by withTfsDate and `tfu` (the page's own UI state, appended after an in-page date change)
 * dropped; no fragment. Null when the URL has no single one-way `tfs` or the date is invalid.
 */
export function flightsUrlForDate(url, date) {
  const split = splitUrl(url);
  const pair = split && tfsPair(split.pairs);
  const value = pair && rawValue(pair);
  if (!value) return null;
  const next = withTfsDate(value.value, date);
  if (!next) return null;
  const encoded = value.raw === value.value ? next : encodeURIComponent(next);
  const pairs = split.pairs.filter(item => !item.startsWith('tfu=')).map(item => (item === pair ? `tfs=${encoded}` : item));
  return `${split.parsed.origin}${split.parsed.pathname}?${pairs.join('&')}`;
}

/** The longest `q` value accepted or built. */
export const QUERY_MAX = 200;
const PLACE_MAX = 40;
// A place as a step writes it: letters, digits, spaces and . ' -; at most 40 characters.
const PLACE = `[\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M} .'’-]{0,${PLACE_MAX - 1}}`;
// Words that end a place name: a punctuation mark, the end, or a word that starts the date, trip or extra clause.
const PLACE_END = '(?=\\s*(?:$|[,.;:!?()"]|\\s\\d{4}-\\d{2}-\\d{2}|\\s(?:on|for|departing|departs?|leaving|leaves?|dep|out|'
  + 'returning|return|back|and|then|in|at|between|around|with|via|the|a|an|one|round|flights?|flying|fly|date|dated|from)\\b))';
const ROUTE = new RegExp(`\\bfrom\\s+(${PLACE}?)(?=\\s+to\\b)\\s+to\\s+(${PLACE}?)${PLACE_END}`, 'giu');
const FLIGHT_WORDS = /\b(?:flights?|fly|flying)\b/i;
const ONE_WAY = /\bone[- ]?way\b/i;
// A round trip: the words, or two dates written as a range ("2027-01-12 to 2027-01-19").
const ROUND_TRIP = /\b(?:round[- ]?trips?|return(?:ing)? (?:flights?|trip|ticket|on)|returning|and back)\b|\d{4}-\d{2}-\d{2}\s*(?:to|-|–|through|until|till)\s*\d{4}-\d{2}-\d{2}/i;
const QUERY = new RegExp(`^(One way|Round trip) flights from (${PLACE}?) to (${PLACE}?) on (\\d{4}-\\d{2}-\\d{2})`
  + '(?: returning on (\\d{4}-\\d{2}-\\d{2}))?$', 'u');

function cleanPlace(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().replace(/[.,;:'’-]+$/, '').trim();
  return text && text.length <= PLACE_MAX && /^[\p{L}\p{N}]/u.test(text) ? text : null;
}

/** The parts of a canonical query (`{ trip, from, to, date, returnDate }`), or null when the text is not one. */
export function parseFlightsQuery(text) {
  const match = typeof text === 'string' && text.length <= QUERY_MAX ? QUERY.exec(text) : null;
  if (!match) return null;
  const [, trip, from, to, date, returnDate] = match;
  if (!isIsoDate(date) || (returnDate !== undefined && (!isIsoDate(returnDate) || returnDate <= date))) return null;
  if ((trip === 'Round trip') !== (returnDate !== undefined)) return null;
  return { trip, from, to, date, returnDate: returnDate ?? null };
}

/** The canonical query text for the parts, as the URL carries it. */
export function flightsQueryText({ trip, from, to, date, returnDate = null }) {
  return `${trip} flights from ${from} to ${to} on ${date}${returnDate ? ` returning on ${returnDate}` : ''}`;
}

/**
 * The flights query a step asks for, from its own texts: the route after "from <place> to <place>", exactly one
 * plain date (one way; a text that says one way, or says nothing about the trip) or exactly two dates in order with
 * a round-trip word (round trip). The text must mention flights. Null otherwise, and for a text that says both.
 */
function flightsQueryTarget({ instruction, expectation } = {}) {
  const texts = dateTexts({ instruction, expectation });
  const text = texts[0];
  if (!FLIGHT_WORDS.test(text)) return null;
  // The last "from <place> to <place>" of the text: an earlier one is a page to start from ("From the home page").
  const route = [...text.matchAll(ROUTE)].at(-1) ?? null;
  const from = route && cleanPlace(route[1]);
  const to = route && cleanPlace(route[2]);
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return null;
  const dates = [...new Set(texts.flatMap(item => isoDatesIn(item)))];
  const oneWay = ONE_WAY.test(text);
  const roundTrip = ROUND_TRIP.test(text);
  if (oneWay && roundTrip) return null;
  let parts;
  if (roundTrip) {
    if (dates.length !== 2 || dates[1] <= dates[0] || !plainDateIn(text, dates[0])) return null;
    parts = { trip: 'Round trip', from, to, date: dates[0], returnDate: dates[1] };
  } else {
    if (dates.length !== 1 || !texts.every(item => plainDateIn(item, dates[0]))) return null;
    parts = { trip: 'One way', from, to, date: dates[0], returnDate: null };
  }
  const query = flightsQueryText(parts);
  return query.length <= QUERY_MAX && parseFlightsQuery(query) ? query : null;
}

/** The canonical query a Google Flights URL's `q` carries, or null (no `q`, two, or not a query this code builds). */
export function flightsUrlQuery(url) {
  const split = splitUrl(url);
  if (!split) return null;
  const pairs = split.pairs.filter(pair => pair === 'q' || pair.startsWith('q='));
  if (pairs.length !== 1) return null;
  let value;
  try {
    value = decodeURIComponent(pairs[0].slice(2).replace(/\+/g, ' '));
  } catch {
    return null;
  }
  return parseFlightsQuery(value) ? value : null;
}

/**
 * The Google Flights search URL for a canonical query: the same origin and path, `q` set to the encoded query (an
 * existing `q`, `tfs` and `tfu` dropped, every other parameter kept in order); no fragment. Null for a query this
 * code does not build.
 */
export function flightsUrlForQuery(url, query) {
  const split = splitUrl(url);
  if (!split || !parseFlightsQuery(query)) return null;
  const pairs = split.pairs.filter(pair => !/^(?:q|tfs|tfu)(?:=|$)/.test(pair));
  pairs.unshift(`q=${encodeURIComponent(query)}`);
  return `${split.parsed.origin}${split.parsed.pathname}?${pairs.join('&')}`;
}

/**
 * Whether a URL shows the results of a canonical query: its `q` is the query, or its `tfs` is a search whose legs
 * hold the query's dates (Google Flights may redirect a `q` search to its results URL).
 */
export function flightsUrlShowsQuery(url, query) {
  const parts = parseFlightsQuery(query);
  if (!parts) return false;
  if (flightsUrlQuery(url) === query) return true;
  const split = splitUrl(url);
  const pair = split && tfsPair(split.pairs);
  const value = pair && rawValue(pair);
  const decoded = value && decodeTfs(value.value);
  if (!decoded) return false;
  const dates = decoded.legs.map(leg => leg.date);
  return parts.returnDate ? dates.length === 2 && dates[0] === parts.date && dates[1] === parts.returnDate
    : dates.length === 1 && dates[0] === parts.date;
}

/** The shortcut kinds this task ships (the interface is documented in src/shortcuts.js). */
export const shortcutKinds = Object.freeze({
  flights_tfs_date: Object.freeze({
    target: stepDate,
    current: flightsUrlDate,
    apply: flightsUrlForDate,
    label: date => `results for ${date}`,
  }),
  flights_query: Object.freeze({
    target({ instruction, expectation, template } = {}) {
      const query = flightsQueryTarget({ instruction, expectation });
      if (!query) return null;
      // The host's own text must build the same query: a place or date a placeholder wrote in is page text.
      if (template !== undefined && flightsQueryTarget(template ?? {}) !== query) return null;
      return query;
    },
    current: flightsUrlQuery,
    apply: flightsUrlForQuery,
    landed: flightsUrlShowsQuery,
    label: query => `results for "${query}"`,
    fromEmpty: true,
    inPlace: true,
  }),
});

/**
 * The task's vocabulary the core reads through tasks/index.js. `askNouns`: nouns a question asks for in a two-part
 * question ("its departure time, airline and price"; src/digest.js isMultiPart), as regex sources.
 */
export const vocabulary = Object.freeze({
  askNouns: Object.freeze(['airlines?', 'carriers?', 'fares?']),
});
