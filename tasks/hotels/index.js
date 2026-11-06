// Hotel finding: the reviewed engine code of the hotels task sub-skill (the host guide is SKILL.md beside this file).
// It ships two shortcut kinds a site profile may name (src/shortcuts.js registry, through tasks/index.js) and the
// task's own vocabulary. Nothing in src/ names hotels; the Booking.com profile (domains/www.booking.com) names the
// kinds by id.
//
// Booking.com results: /searchresults.html?ss=<destination>&checkin=YYYY-MM-DD&checkout=YYYY-MM-DD&group_adults=N
// &group_children=N&no_rooms=N shows the stays for that search, so a step that names the destination, the dates and
// the guests can land on them in one hop, without the date and guest pickers (a calendar popover whose textbox ignores
// typed text; a fill there comes back fill_not_kept). The URL is built by code from the step's own words (the place
// after "hotels in ...", the two ISO dates, the guest and room counts, or the task's defaults of 2 adults and 1 room)
// as one fixed parameter set, each value URL-encoded, on the page's own origin and path; no step text goes into the
// URL as written, and no parameter outside that set is ever added.
//
// Booking.com dates: the same URL for another check-in and check-out keeps every other parameter (destination,
// guests, sort order, filters) in order and rewrites only `checkin` and `checkout`, the way the flights task rewrites
// the date in `tfs`.
import { isIsoDate, nightsBetween, stepDateRange } from '../../src/dates.js';

/** The task's name, as tasks/index.js lists it. */
export const name = 'hotels';

/** The longest stay a search may ask for, in nights (a longer one is not a hotel search). */
export const MAX_NIGHTS = 30;
/** The guests a search gets when the step names none (the guide says so). */
export const DEFAULT_GUESTS = Object.freeze({ adults: 2, children: 0, rooms: 1 });
/** The counts the site accepts. */
export const GUEST_LIMITS = Object.freeze({ adults: 30, children: 10, rooms: 30 });
/** The longest canonical search text accepted or built. */
export const SEARCH_MAX = 200;
const PLACE_MAX = 60;

// The query parameters the search kind sets, in this order: the fixed set of a Booking.com search.
const SEARCH_PARAMS = ['ss', 'checkin', 'checkout', 'group_adults', 'group_children', 'no_rooms'];
// Parameters a search replaces: the set above plus the site's own pins of a chosen place (a kept dest_id would hold
// the old destination against a new ss) and the legacy split-date parameters.
const LEGACY_DATE_PARAMS = new Set(['checkin_year', 'checkin_month', 'checkin_monthday', 'checkout_year', 'checkout_month',
  'checkout_monthday']);
const REPLACED_PARAMS = new Set([...SEARCH_PARAMS, ...LEGACY_DATE_PARAMS, 'ss_raw', 'dest_id', 'dest_type',
  'search_selected', 'place_id', 'place_id_lat', 'place_id_lon', 'latitude', 'longitude']);

// A place as a step writes it: letters, digits, spaces and . ' -; at most 60 characters.
const PLACE = `[\\p{L}\\p{N}][\\p{L}\\p{N}\\p{M} .'’-]{0,${PLACE_MAX - 1}}`;
// Words that end a place name: a punctuation mark, the end, a date, a number or a word that starts the next clause.
const PLACE_END = '(?=\\s*(?:$|[,.;:!?()"]|\\s\\d|\\s(?:from|for|between|on|checking|check-?in|check-?out|arriving|'
  + 'arrival|staying|with|without|under|below|above|over|at|and|then|that|rated|near|the|a|an|one|two|three|four|'
  + 'five|six|seven|eight|nine|cheapest|cheap|best|about|around|during|in|to)\\b))';
// The words that make a text a stay search, and that a destination follows ("hotels in Paris", "a room near Lyon").
const STAY_WORD = '(?:hotels?|stays?|accommodations?|propert(?:y|ies)|rooms?|lodgings?|hostels?|apartments?|guest ?houses?|b&bs?)';
const DESTINATION = new RegExp(`\\b${STAY_WORD}\\s+(?:in|near|around)\\s+(${PLACE}?)${PLACE_END}`, 'giu');
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const COUNT = '(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine)';
const ADULTS = new RegExp(`\\b${COUNT}\\s+adults?\\b`, 'gi');
const GUESTS = new RegExp(`\\b${COUNT}\\s+(?:guests?|people|persons?|travell?ers?)\\b`, 'gi');
const CHILDREN = new RegExp(`\\b${COUNT}\\s+(?:child(?:ren)?|kids?)\\b`, 'gi');
const ROOMS = new RegExp(`\\b${COUNT}\\s+rooms?\\b`, 'gi');
const QUERY = new RegExp(`^Stays in (${PLACE}?) from (\\d{4}-\\d{2}-\\d{2}) to (\\d{4}-\\d{2}-\\d{2}) for `
  + '(\\d{1,2}) adults?, (\\d{1,2}) child(?:ren)?, (\\d{1,2}) rooms?$', 'u');
const RANGE = /^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/;

// A place never starts with a determiner or a page word: "stays in the list", "rooms in this page" name no destination.
const NOT_A_PLACE = new RegExp('^(?:the|a|an|this|that|these|those|my|your|our|their|its|which|each|every|all|some|any|'
  + 'no|both|lists?|results?|pages?|maps?|order|front|stock|total|town|city|area|view|person|rows?|table|section)\\b', 'i');

function cleanPlace(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().replace(/[.,;:'’-]+$/, '').trim();
  return text && text.length <= PLACE_MAX && /^[\p{L}\p{N}]/u.test(text) && !NOT_A_PLACE.test(text) ? text : null;
}

function count(word) {
  return /^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word.toLowerCase()];
}

/** Whether the guest counts are ones the site takes: at least one adult per room, within GUEST_LIMITS. */
export function validGuests({ adults, children, rooms } = {}) {
  return [adults, children, rooms].every(Number.isInteger) && adults >= 1 && adults <= GUEST_LIMITS.adults
    && children >= 0 && children <= GUEST_LIMITS.children && rooms >= 1 && rooms <= GUEST_LIMITS.rooms && rooms <= adults;
}

/** Whether `from` to `to` is a stay: real dates, check-out after check-in, at most MAX_NIGHTS nights. */
export function validStay(from, to) {
  const nights = nightsBetween(from, to);
  return nights !== null && nights >= 1 && nights <= MAX_NIGHTS;
}

/** The parts of a canonical search text (`{ destination, checkin, checkout, adults, children, rooms }`), or null. */
export function parseHotelsSearch(text) {
  const match = typeof text === 'string' && text.length <= SEARCH_MAX ? QUERY.exec(text) : null;
  if (!match) return null;
  const [, destination, checkin, checkout, adults, children, rooms] = match;
  const parts = { destination, checkin, checkout, adults: Number(adults), children: Number(children), rooms: Number(rooms) };
  if (cleanPlace(destination) !== destination || !validStay(checkin, checkout) || !validGuests(parts)) return null;
  // Only the one spelling this code writes ("1 adult", "2 children") is a canonical text.
  return hotelsSearchText(parts) === text ? parts : null;
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The canonical search text for the parts: the value the search kind reads from and writes to the URL. */
export function hotelsSearchText({ destination, checkin, checkout, adults, children, rooms }) {
  return `Stays in ${destination} from ${checkin} to ${checkout} for ${plural(adults, 'adult')}, `
    + `${plural(children, 'child', 'children')}, ${plural(rooms, 'room')}`;
}

/**
 * One count a text names with the given pattern, or the default: null when the text names it twice with different
 * values, or names an impossible one (0 adults, 40 rooms).
 */
function oneCount(text, pattern, fallback) {
  const found = [...new Set([...text.matchAll(pattern)].map(match => count(match[1])))];
  if (found.length > 1) return null;
  return found.length ? found[0] : fallback;
}

/**
 * The guests a step's text asks for, or the defaults for the ones it does not name. "N guests" (people, persons)
 * counts as adults when the text names no adults; a text that names both differently is ambiguous (null).
 */
export function guestsIn(text) {
  const adultsNamed = oneCount(text, ADULTS, undefined);
  const guestsNamed = oneCount(text, GUESTS, undefined);
  const children = oneCount(text, CHILDREN, DEFAULT_GUESTS.children);
  const rooms = oneCount(text, ROOMS, DEFAULT_GUESTS.rooms);
  if (adultsNamed === null || guestsNamed === null || children === null || rooms === null) return null;
  if (adultsNamed !== undefined && guestsNamed !== undefined && adultsNamed !== guestsNamed) return null;
  const adults = adultsNamed ?? guestsNamed ?? DEFAULT_GUESTS.adults;
  const guests = { adults, children, rooms };
  return validGuests(guests) ? guests : null;
}

/**
 * The search a step asks for, from its own texts: the place after "hotels in <place>" (stays, rooms, ...; the last
 * such phrase), the one date range (src/dates.js stepDateRange: check-in first, check-out after it, at most MAX_NIGHTS
 * nights) and the guests the text names or the defaults. Null otherwise.
 */
function hotelsSearchTarget({ instruction, expectation } = {}) {
  const range = stepDateRange({ instruction, expectation });
  if (!range || !validStay(range.from, range.to)) return null;
  const text = String(instruction ?? '').slice(0, 4000);
  // The last "hotels in <place>" of the text: an earlier one may describe the page ("the hotels in the list").
  const place = [...text.matchAll(DESTINATION)].at(-1) ?? null;
  const destination = place && cleanPlace(place[1]);
  if (!destination || isIsoDate(destination)) return null;
  const guests = guestsIn(text);
  if (!guests) return null;
  const query = hotelsSearchText({ destination, checkin: range.from, checkout: range.to, ...guests });
  return query.length <= SEARCH_MAX && parseHotelsSearch(query) ? query : null;
}

// The results page's path: /searchresults.html, or its localized form (/searchresults.en-gb.html).
const RESULTS_PATH = /^\/searchresults(?:\.[a-z]{2}(?:-[a-z]{2})?)?\.html$/;

/** A results URL split into its parts and query pairs; null for anything but an http(s) results page URL. */
function splitUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!RESULTS_PATH.test(parsed.pathname)) return null;
  const query = parsed.search.startsWith('?') ? parsed.search.slice(1) : '';
  return { parsed, pairs: query ? query.split('&') : [] };
}

function nameOf(pair) {
  const at = pair.indexOf('=');
  return at < 0 ? pair : pair.slice(0, at);
}

/** The decoded value of the one `name=` pair, undefined when there is none, null when there are two or it is bad. */
function paramOf(pairs, name) {
  const found = pairs.filter(pair => nameOf(pair) === name);
  if (!found.length) return undefined;
  if (found.length > 1) return null;
  const at = found[0].indexOf('=');
  try {
    return decodeURIComponent((at < 0 ? '' : found[0].slice(at + 1)).replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** A query value encoded by code (RFC 3986 unreserved characters only: ' ( ) ! * encoded too). */
function encodeParam(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function countParam(pairs, name, fallback) {
  const raw = paramOf(pairs, name);
  if (raw === undefined) return fallback;
  return raw !== null && /^\d{1,2}$/.test(raw) ? Number(raw) : null;
}

/** The search parts a Booking.com results URL carries (its ss, checkin, checkout and guest counts), or null. */
export function bookingUrlParts(url) {
  const split = splitUrl(url);
  if (!split) return null;
  const destination = paramOf(split.pairs, 'ss');
  const checkin = paramOf(split.pairs, 'checkin');
  const checkout = paramOf(split.pairs, 'checkout');
  if (!destination || !checkin || !checkout) return null;
  const parts = {
    destination: cleanPlace(destination), checkin, checkout,
    adults: countParam(split.pairs, 'group_adults', DEFAULT_GUESTS.adults),
    children: countParam(split.pairs, 'group_children', DEFAULT_GUESTS.children),
    rooms: countParam(split.pairs, 'no_rooms', DEFAULT_GUESTS.rooms),
  };
  if (!parts.destination || !validStay(checkin, checkout) || !validGuests(parts)) return null;
  return parts;
}

/** The canonical search text a Booking.com results URL carries, or null (no search, or not one this code builds). */
export function bookingUrlSearch(url) {
  const parts = bookingUrlParts(url);
  if (!parts) return null;
  const text = hotelsSearchText(parts);
  return parseHotelsSearch(text) ? text : null;
}

/**
 * The Booking.com results URL for a canonical search: the same origin and path, the fixed parameter set first
 * (ss, checkin, checkout, group_adults, group_children, no_rooms; every value encoded by code), the site's own pins
 * of the old place and its legacy date parameters dropped, every other parameter kept in order; no fragment. Null for
 * a search this code does not build.
 */
export function bookingUrlForSearch(url, search) {
  const split = splitUrl(url);
  const parts = parseHotelsSearch(search);
  if (!split || !parts) return null;
  const values = [parts.destination, parts.checkin, parts.checkout, parts.adults, parts.children, parts.rooms];
  const pairs = SEARCH_PARAMS.map((param, index) => `${param}=${encodeParam(String(values[index]))}`);
  pairs.push(...split.pairs.filter(pair => !REPLACED_PARAMS.has(nameOf(pair))));
  return `${split.parsed.origin}${split.parsed.pathname}?${pairs.join('&')}`;
}

/**
 * Whether a URL shows the results of a canonical search: the same dates and guests, and a destination the URL's `ss`
 * starts with (the site may pin the place it chose, "Paris" to "Paris, France", on landing).
 */
export function bookingUrlShowsSearch(url, search) {
  const wanted = parseHotelsSearch(search);
  const parts = wanted && bookingUrlParts(url);
  if (!parts) return false;
  return ['checkin', 'checkout', 'adults', 'children', 'rooms'].every(key => parts[key] === wanted[key])
    && parts.destination.toLowerCase().startsWith(wanted.destination.toLowerCase());
}

/** A canonical date range text ("2027-03-01 to 2027-03-04") for a stay, or null. */
function rangeText(from, to) {
  return validStay(from, to) ? `${from} to ${to}` : null;
}

/** The check-in and check-out of a Booking.com results URL as a range text, or null. */
export function bookingUrlRange(url) {
  const split = splitUrl(url);
  if (!split) return null;
  const checkin = paramOf(split.pairs, 'checkin');
  const checkout = paramOf(split.pairs, 'checkout');
  return checkin && checkout ? rangeText(checkin, checkout) : null;
}

/**
 * The Booking.com results URL for another stay: the same origin, path and query parameters in the same order, with
 * `checkin` and `checkout` rewritten in place and the legacy split-date parameters dropped; no fragment. Null when the
 * URL has no single checkin and checkout or the range is not a stay.
 */
export function bookingUrlForRange(url, range) {
  const split = splitUrl(url);
  const match = typeof range === 'string' ? RANGE.exec(range) : null;
  if (!split || !match || rangeText(match[1], match[2]) !== range) return null;
  // Exactly one checkin and one checkout to rewrite.
  if (split.pairs.filter(pair => nameOf(pair) === 'checkin').length !== 1) return null;
  if (split.pairs.filter(pair => nameOf(pair) === 'checkout').length !== 1) return null;
  const pairs = split.pairs.filter(pair => !LEGACY_DATE_PARAMS.has(nameOf(pair))).map(pair => {
    const name = nameOf(pair);
    return name === 'checkin' ? `checkin=${match[1]}` : name === 'checkout' ? `checkout=${match[2]}` : pair;
  });
  return `${split.parsed.origin}${split.parsed.pathname}?${pairs.join('&')}`;
}

/** The shortcut kinds this task ships (the interface is documented in src/shortcuts.js). */
export const shortcutKinds = Object.freeze({
  booking_search: Object.freeze({
    target({ instruction, expectation, template } = {}) {
      const search = hotelsSearchTarget({ instruction, expectation });
      if (!search) return null;
      // The host's own text must build the same search: a place, date or count a placeholder wrote in is page text.
      if (template !== undefined && hotelsSearchTarget(template ?? {}) !== search) return null;
      return search;
    },
    current: bookingUrlSearch,
    apply: bookingUrlForSearch,
    landed: bookingUrlShowsSearch,
    label: search => `results for "${search}"`,
    fromEmpty: true,
    inPlace: true,
  }),
  booking_dates: Object.freeze({
    target({ instruction, expectation, template } = {}) {
      const range = stepDateRange({ instruction, expectation, template });
      return range ? rangeText(range.from, range.to) : null;
    },
    current: bookingUrlRange,
    apply: bookingUrlForRange,
    label: range => `results for ${range}`,
  }),
});

/**
 * The task's vocabulary the core reads through tasks/index.js. `askNouns`: nouns a question asks for in a two-part
 * question ("the hotel and its price", "the price per night and total"; src/digest.js isMultiPart), as regex sources.
 * Name, price and rating are core nouns already.
 */
export const vocabulary = Object.freeze({
  askNouns: Object.freeze(['hotels?', 'propert(?:y|ies)', 'nights?', 'totals?']),
});
