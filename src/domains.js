// Site profiles (experimental, opt-in): versioned per-origin knowledge that lets the runtime take known link hops
// without a Jev decision, and give Jev a short templated hint on the hops it still decides.
//
// Storage: $FAI_DOMAINS_DIR, else $FAI_HOME/domains, else the package's domains/, one directory per origin slug (host, plus "_<port>" for a
// non-default port: github.com, 127.0.0.1_39521) holding profile.json (validated strictly here; unknown keys anywhere
// are rejected). Hit/miss counters go to a separate stats directory (domainStatsDir), never into the profile
// directory and never inside the package. A profile applies only to an origin it lists in `origins`, matched exactly;
// a request's domain root ("https://*.example.com", src/origins.js) attaches the profiles of the origins it covers.
//
// A profile is untrusted-ish data. It can never widen anything: it holds no origins to approve, no level, no grant,
// no capability and no threshold, and no URL the runtime would navigate to. Its only restriction channel is
// `restrict.forbid` (plain phrases merged into the run's guardrail additions after config and request, so it can only
// add refusals). Everything else is assistance:
//   - the fast path only ever selects one link out of the ones legalActions() already offers for this page and level
//     (a same-origin link whose href is on the page), never a button, select, fill, submit or URL of its own, and
//     checks the landing page type after every hop;
//   - hints reach Jev as state.site, rendered from fixed templates and filtered plain phrases, never free text;
//   - a shortcut (`shortcuts`) names one of the reviewed URL transforms a shipped task defines (tasks/<name>/index.js,
//     registered by src/shortcuts.js) by kind; the transform rewrites the current page's own URL (same origin and
//     path) for a value the step's instruction names, at reversible or above, so the profile still holds no URL of
//     its own;
//   - `controls` pins labelled controls against the option caps (ordering only) and may give a page-script name of a
//     control the page left unnamed (`next-value button after "Departure" (unlabelled)`) a plain name for Jev, never
//     a direction the page script did not derive; `status` names page status lines that are not loading placeholders
//     on a page with rows of its own; `notes` are filtered plain sentences for Jev. All three apply only on the
//     profile's pages (a URL matching one of its page types' url templates).
//
// No profile string is ever compiled as a regular expression. Page checks and link labels are literal,
// case-insensitive text; URLs, link hrefs and expectation names are path templates ("/{owner}/{repo}/issues",
// "/search/r/{n}.html", "/a?page={page}", "/{owner}/{repo}/issues?*") that this module turns into its own linear
// matchers: a placeholder matches 1-100 of [A-Za-z0-9._~@:%+-] (no separator), two placeholders always have a separator
// (/ ? & =) between them, and every input is capped (URLs at 2048 characters).
//
// Profile format (schema 1):
//   {
//     "schema": 1, "id": "github.com", "version": 3, "origins": ["https://github.com"],
//     "description": "plain text, never sent to Jev",                              (optional)
//     "restrict": { "forbid": ["Star", "Fork"] },                                 (optional, plain phrases)
//     "defaults": { "mode": "read-only", "maxActions": 4 },                        (optional, advisory, not applied)
//     "pageTypes": {
//       "issue_list": {
//         "label": "issue list",                                                  plain phrase for hints
//         "url": "/{owner}/{repo}/issues?*",                                       path template (query: ?* any)
//         "checks": [{ "title": "Issues · " }],                                    literal text, all must be found
//         "expect": ["/issues", "/{owner}/{repo}/issues"],                         templates naming this type from
//                                                                                  expectation.urlIncludes
//         "expectation": { "urlIncludes": "/{owner}/{repo}/issues" },              advisory, not applied
//         "answers": [{ "question": "how many", "block": "a", "text": "Open" }]     advisory literals, not applied
//       }
//     },
//     "edges": [
//       { "id": "repo->issues", "from": "repo_home", "to": "issue_list",
//         "link": { "label": "Issues", "href": "/{owner}/{repo}/issues", "hint": "Issues" } }
//     ],
//     "shortcuts": [{ "id": "results-date", "on": "results", "to": "results", "kind": "<a task's kind>" }],  (optional)
//     "controls": [{ "label": "Date grid", "pin": true },                                                 (optional)
//                  { "label": "next-value button after \"Departure\" (unlabelled)", "pin": true, "name": "Next day" }],
//     "status": ["Loading results"],                                    literal block texts, never loading (optional)
//     "notes": ["The Departure textbox opens a calendar."]              plain sentences for Jev (optional)
//   }
// A link edge needs `href`; a placeholder named like a capture of the source page's URL must take the same value there
// (from /foo/bar the edge above only follows /foo/bar/issues), and on the route's last hop the destination must also
// satisfy the run's expectation (urlIncludes at path boundaries, or urlEquals).
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { PACKAGE_ROOT, customHome, faiHome } from './paths.js';
import { LEVELS, labelClasses, normalizeAdditions } from './guardrails.js';
import { destructiveLink, plainNavLabel } from './oversight.js';
import { hostInSite, originCovered, siteRoot } from './origins.js';
import { SHORTCUT_KINDS, rewriteWithin } from './shortcuts.js';
import { carriesRows } from './digest.js';

export const PROFILE_SCHEMA = 1;
export const PROFILE_LIMITS = Object.freeze({
  maxOrigins: 4, maxPageTypes: 50, maxEdges: 100, maxChecks: 6, maxExpect: 6, maxAnswers: 6, maxTemplate: 120,
  maxPlaceholders: 6, maxLiteral: 120, maxLabel: 40, maxHint: 60, maxDescription: 300, maxRoute: 8, maxBytes: 64 * 1024,
  maxNotes: 3, maxNote: 160, maxStatus: 6, maxStatusText: 60, maxControls: 12, maxShortcuts: 4,
});
// Every input is capped before matching.
export const URL_INPUT = 2048;
const LABEL_INPUT = 180;
const TEXT_INPUT = 12000;
// Hint words added to the observation terms (the extension takes 30; instruction terms are at most 24).
const MAX_SITE_TERMS = 6;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TYPE_ID = /^[a-z][a-z0-9_]{0,39}$/;
const EDGE_ID = /^[a-z0-9][a-z0-9_>.-]{0,63}$/;
const CAPTURE_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;
// Labels and hints: letters, digits, marks, spaces and light punctuation (the guardrail phrase class, no colon).
const PLAIN = /^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M} '’&/,()-]*$/u;
// Literal check text: any printable text without control, format or private-use characters.
const LITERAL_BAD = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u;
const CHECK_KINDS = new Set(['title', 'heading', 'link', 'text']);
const BLOCK_TYPES = new Set(['h1', 'h2', 'h3', 'p', 'li', 'td', 'th', 'dd', 'dt', 'a']);
// Template characters: literals, separators and {name} placeholders; `?*` only at the end (any query).
const TEMPLATE_CHARS = /^[A-Za-z0-9._~@:%+\-/?&={}*]+$/;
const SEPARATORS = new Set(['/', '?', '&', '=']);
const PLACEHOLDER_CLASS = '[A-Za-z0-9._~@:%+\\-]{1,100}';
// Words a link destination may never contain: account and commit endpoints reachable with a GET.
const PATH_DANGER = /(?:^|[^a-z])(?:log-?out|sign-?out|logoff|delete|remove|destroy|unsubscribe|cancel|checkout|purchase|payment|pay|buy|order|subscribe|confirm|approve|transfer|withdraw)(?:[^a-z]|$)/i;
// Page text addressed to an agent: the fast path stops on such a page and lets Jev (with its injection noul) decide.
const AGENT_ADDRESSED = /\b(?:ignore (?:all |any )?(?:earlier|previous|prior|above|other) instructions|(?:ai|llm) (?:agent|assistant)s?\b|dear (?:agent|assistant|ai)|system prompt|(?:agents?|assistants?|ai|bots?)\s*:\s)/i;

export class ProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileError';
    this.code = 'invalid_profile';
  }
}

function fail(path, message) {
  throw new ProfileError(`${path}: ${message}`);
}

function plainObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, 'must be an object');
  return value;
}

function onlyKeys(value, path, allowed, required = []) {
  plainObject(value, path);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(path, `unknown key "${/^[A-Za-z0-9_]{1,32}$/.test(key) ? key : 'unsupported'}"`);
  }
  for (const key of required) if (value[key] === undefined) fail(path, `"${key}" is required`);
}

function list(value, path, max, { min = 0 } = {}) {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  if (value.length < min) fail(path, `needs at least ${min} entr${min === 1 ? 'y' : 'ies'}`);
  if (value.length > max) fail(path, `may list at most ${max} entries`);
  return value;
}

/** A plain label or hint: PLAIN characters, capped, no risky class (purchase, sign-in, delete, submit), no action link. */
export function safeLabel(value, max = PROFILE_LIMITS.maxHint) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > max || !PLAIN.test(text)) return null;
  if (labelClasses(text).length || destructiveLink(text) || !plainNavLabel(text)) return null;
  return text;
}

function label(value, path, max) {
  const text = safeLabel(value, max);
  if (!text) {
    fail(path, `must be a plain navigation phrase of at most ${max} characters (letters, digits, spaces, - ' & / , ( )), `
      + 'with no action word');
  }
  return text;
}

/** Literal text for a check or a link label: 1-120 characters, no control or invisible characters; lower-cased. */
function literal(value, path, max = PROFILE_LIMITS.maxLiteral) {
  if (typeof value !== 'string') fail(path, 'must be a string (literal text, not a regex)');
  const text = value.replace(/\s+/g, ' ');
  if (!text.trim() || text.length > max || LITERAL_BAD.test(text)) {
    fail(path, `must be literal text of 1 to ${max} characters without control or invisible characters`);
  }
  return text.toLowerCase();
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Compile a path template into this module's own matcher. `kind` is `url` (a page URL's path and query: must start
 * with "/"; no query unless the template has one, `?*` accepts any), `href` (the same, for a link destination) or
 * `expect` (an expectation.urlIncludes value, matched whole; may start without "/"). Returns `{ test(input) -> captures
 * | null, names, template }`. Throws ProfileError on anything outside the template grammar.
 */
export function compileTemplate(source, path, { kind = 'url', names: allowed = null } = {}) {
  if (typeof source !== 'string' || !source.length) fail(path, 'must be a non-empty path template');
  if (source.length > PROFILE_LIMITS.maxTemplate) fail(path, `must be at most ${PROFILE_LIMITS.maxTemplate} characters`);
  if (!TEMPLATE_CHARS.test(source)) {
    fail(path, 'must be a path template: letters, digits, . _ ~ @ : % + - / ? & = and {name} placeholders (no regex)');
  }
  if (kind !== 'expect' && (!source.startsWith('/') || source.startsWith('//'))) fail(path, 'must start with a single "/"');
  let body = source;
  let anyQuery = false;
  if (body.endsWith('?*')) {
    if (kind === 'expect') fail(path, 'may not end with ?*');
    anyQuery = true;
    body = body.slice(0, -2);
  }
  if (body.includes('*')) fail(path, '"*" is only allowed as a final "?*"');
  if ((body.match(/\?/g) ?? []).length > 1) fail(path, 'may have at most one "?"');
  if (anyQuery && body.includes('?')) fail(path, 'cannot combine a literal query with ?*');
  if (/(?:^|\/)\.\.?(?:\/|$|\?)/.test(body)) fail(path, 'must not contain "." or ".." segments');
  if (kind !== 'expect' && body.length > 1 && body.endsWith('/')) body = body.slice(0, -1);
  const parts = body.split(/(\{[^{}]*\})/);
  const names = [];
  let pattern = '';
  // A placeholder since the last separator: a second one before the next separator is refused, so each placeholder is
  // bounded by characters it cannot consume and matching stays linear.
  let open = false;
  for (const part of parts) {
    if (!part) continue;
    const placeholder = /^\{([^{}]*)\}$/.exec(part);
    if (placeholder) {
      const name = placeholder[1];
      if (!CAPTURE_NAME.test(name)) fail(path, `has an invalid placeholder {${name.slice(0, 32)}}`);
      if (names.includes(name)) fail(path, `repeats the placeholder {${name}}`);
      if (allowed && !allowed.includes(name)) fail(path, `uses {${name}}, which the page type's url does not capture`);
      if (open) fail(path, 'needs a separator (/ ? & =) between two placeholders');
      names.push(name);
      pattern += `(?<${name}>${PLACEHOLDER_CLASS})`;
      open = true;
      continue;
    }
    if (part.includes('{') || part.includes('}')) fail(path, 'has a malformed {placeholder}');
    if ([...part].some(char => SEPARATORS.has(char))) open = false;
    pattern += escapeRegExp(part);
  }
  if (names.length > PROFILE_LIMITS.maxPlaceholders) fail(path, `may have at most ${PROFILE_LIMITS.maxPlaceholders} placeholders`);
  // Built by this module from escaped literals and bounded, separator-free placeholders: never profile regex text.
  const regex = new RegExp(`^${pattern}${anyQuery ? '(?:\\?[^#]{0,2047})?' : ''}$`);
  return {
    template: source,
    names,
    test(input) {
      if (typeof input !== 'string' || input.length > URL_INPUT) return null;
      let value = input;
      if (kind !== 'expect') {
        const [pathPart, query = null] = splitQuery(value);
        value = (pathPart.length > 1 && pathPart.endsWith('/') ? pathPart.slice(0, -1) : pathPart) + (query === null ? '' : `?${query}`);
      } else if (value.length > 1 && value.endsWith('/')) {
        value = value.slice(0, -1);
      }
      const match = regex.exec(value);
      return match ? { ...(match.groups ?? {}) } : null;
    },
  };
}

function splitQuery(value) {
  const index = value.indexOf('?');
  return index < 0 ? [value, null] : [value.slice(0, index), value.slice(index + 1)];
}

function compileCheck(check, path) {
  onlyKeys(check, path, [...CHECK_KINDS]);
  const keys = Object.keys(check);
  if (keys.length !== 1) fail(path, 'must have exactly one of title, heading, link, text');
  const kind = keys[0];
  return { kind, text: literal(check[kind], `${path}.${kind}`) };
}

function compilePageType(id, raw, path) {
  if (!TYPE_ID.test(id)) fail(path, 'page type ids are lowercase letters, digits and _ (at most 40)');
  onlyKeys(raw, path, ['label', 'url', 'checks', 'expect', 'expectation', 'answers'], ['label', 'url', 'checks']);
  const url = compileTemplate(raw.url, `${path}.url`, { kind: 'url' });
  const checks = list(raw.checks, `${path}.checks`, PROFILE_LIMITS.maxChecks, { min: 1 })
    .map((check, index) => compileCheck(check, `${path}.checks[${index}]`));
  const expect = raw.expect === undefined ? [] : list(raw.expect, `${path}.expect`, PROFILE_LIMITS.maxExpect)
    .map((source, index) => compileTemplate(source, `${path}.expect[${index}]`, { kind: 'expect' }));
  let expectation = null;
  if (raw.expectation !== undefined) {
    onlyKeys(raw.expectation, `${path}.expectation`, ['urlIncludes'], ['urlIncludes']);
    expectation = compileTemplate(raw.expectation.urlIncludes, `${path}.expectation.urlIncludes`, { kind: 'url', names: url.names });
  }
  const answers = raw.answers === undefined ? [] : list(raw.answers, `${path}.answers`, PROFILE_LIMITS.maxAnswers)
    .map((answer, index) => {
      const at = `${path}.answers[${index}]`;
      onlyKeys(answer, at, ['question', 'block', 'text'], ['question', 'text']);
      if (answer.block !== undefined && !BLOCK_TYPES.has(answer.block)) fail(`${at}.block`, `must be one of ${[...BLOCK_TYPES].join(', ')}`);
      return { question: literal(answer.question, `${at}.question`), block: answer.block ?? null, text: literal(answer.text, `${at}.text`) };
    });
  return {
    id, label: label(raw.label, `${path}.label`, PROFILE_LIMITS.maxLabel), url, captures: url.names,
    checks, expect, expectation, answers,
  };
}

function compileEdge(raw, path, types) {
  onlyKeys(raw, path, ['id', 'from', 'to', 'link'], ['id', 'from', 'to', 'link']);
  if (typeof raw.id !== 'string' || !EDGE_ID.test(raw.id)) fail(`${path}.id`, 'must be 1-64 lowercase letters, digits and _ > . -');
  for (const end of ['from', 'to']) {
    if (typeof raw[end] !== 'string' || !types.has(raw[end])) fail(`${path}.${end}`, 'must name a page type');
  }
  onlyKeys(raw.link, `${path}.link`, ['label', 'href', 'hint'], ['href']);
  const href = compileTemplate(raw.link.href, `${path}.link.href`, { kind: 'href' });
  if (PATH_DANGER.test(raw.link.href.replace(/\{[^}]*\}/g, 'x'))) fail(`${path}.link.href`, 'names an account or commit endpoint');
  return {
    id: raw.id,
    from: raw.from,
    to: raw.to,
    link: {
      label: raw.link.label === undefined ? null : literal(raw.link.label, `${path}.link.label`, PROFILE_LIMITS.maxHint),
      href,
      hint: raw.link.hint === undefined ? null : label(raw.link.hint, `${path}.link.hint`, PROFILE_LIMITS.maxHint),
    },
  };
}

// Notes: letters, digits, marks, spaces and sentence punctuation (no colon, so no URL and no "agent:" address); no
// host name, no injection vocabulary and no risky label class.
const NOTE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} '’&/,()\-.;"]*$/u;
const NOTE_NOISE = /\b(?:ignore|instructions?|system|prompt|must|urgent|immediately|password|credentials?|always|never)\b/i;
// A host name ("evil.example", "www.example.com/promo"): a dot between two words of which the second has 2+ letters.
const NOTE_HOST = /[\p{L}\p{N}-]\.[\p{L}]{2,}/u;

/** A profile note for Jev: a filtered plain sentence of at most 160 characters, or null. */
export function safeNote(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > PROFILE_LIMITS.maxNote || !NOTE.test(text) || NOTE_NOISE.test(text) || NOTE_HOST.test(text)) return null;
  if (labelClasses(text).length || AGENT_ADDRESSED.test(text)) return null;
  return text;
}

// A page-script name for an unnamed control ("unlabelled button 2 of 2 next to \"Departure\"", or with a direction the
// page script derived from the layout, "next-value button after \"Departure\" (unlabelled)"): the only labels a profile
// may rename, since they hold no page wording of the control itself.
const UNNAMED_LABEL = /^unlabelled [a-z]+ |\(unlabelled\)$/;
// The direction the page script derived for an unnamed button (extension/page.js unnamedDirections): the first word of a
// "... (unlabelled)" label. A label without one ("unlabelled button 1 of 2 next to ...") was left without a direction
// on purpose (a lone icon, or a pair whose icon hints name another function: clear, delete, edit, calendar).
const DERIVED_DIRECTION = /^(previous-value|next-value|previous|next|decrease|increase) [a-z ]+ .*\(unlabelled\)$/;
const BACKWARD_WORDS = /\b(?:previous|prev|back|backward|earlier|before|decrease|less|fewer|minus|down|left|last)\b/i;
const FORWARD_WORDS = /\b(?:next|forward|later|after|increase|more|plus|up|right|following)\b/i;

/** Whether a profile `name` for `label` claims no direction the page script did not derive (or the opposite one). */
function nameKeepsDirection(label, name) {
  const derived = DERIVED_DIRECTION.exec(label)?.[1] ?? null;
  const backward = BACKWARD_WORDS.test(name);
  const forward = FORWARD_WORDS.test(name);
  if (!derived) return !backward && !forward;
  const isBackward = /^(?:previous|decrease)/.test(derived);
  return isBackward ? !forward : !backward;
}

function compileControl(raw, path) {
  onlyKeys(raw, path, ['label', 'pin', 'name'], ['label']);
  const text = literal(raw.label, `${path}.label`, PROFILE_LIMITS.maxLiteral).trim();
  if (raw.pin !== undefined && typeof raw.pin !== 'boolean') fail(`${path}.pin`, 'must be a boolean');
  let name = null;
  if (raw.name !== undefined) {
    if (!UNNAMED_LABEL.test(text)) {
      fail(`${path}.name`, 'may only rename a page-script name ("unlabelled <role> ..." or "... (unlabelled)")');
    }
    name = label(raw.name, `${path}.name`, PROFILE_LIMITS.maxLabel);
    if (!nameKeepsDirection(text, name)) {
      fail(`${path}.name`, 'may not claim a direction the page script did not derive for the label (or the opposite one)');
    }
  }
  if (!raw.pin && !name) fail(path, 'needs "pin": true or a "name"');
  return Object.freeze({ label: text, pin: raw.pin === true, name });
}

function compileShortcut(raw, path, types) {
  onlyKeys(raw, path, ['id', 'on', 'to', 'kind'], ['id', 'on', 'to', 'kind']);
  if (typeof raw.id !== 'string' || !EDGE_ID.test(raw.id)) fail(`${path}.id`, 'must be 1-64 lowercase letters, digits and _ > . -');
  for (const end of ['on', 'to']) {
    if (typeof raw[end] !== 'string' || !types.has(raw[end])) fail(`${path}.${end}`, 'must name a page type');
  }
  if (typeof raw.kind !== 'string' || !Object.hasOwn(SHORTCUT_KINDS, raw.kind)) {
    fail(`${path}.kind`, `must be one of ${Object.keys(SHORTCUT_KINDS).join(', ')}`);
  }
  return Object.freeze({ id: raw.id, on: raw.on, to: raw.to, kind: raw.kind });
}

function exactOrigin(value, path) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(path, 'must be an origin such as https://example.com');
  }
  if (!/^https?:$/.test(url.protocol) || url.origin !== value || !originSlug(value)) {
    fail(path, 'must be an exact http(s) origin with no path (a DNS name or IPv4 address, no wildcard)');
  }
  return value;
}

/**
 * Validate a parsed profile.json and compile it. Throws ProfileError naming the first offending path. The result
 * is frozen; nothing in it is a permission.
 */
export function compileProfile(raw) {
  onlyKeys(raw, 'profile', ['schema', 'id', 'version', 'origins', 'description', 'restrict', 'defaults', 'pageTypes',
    'edges', 'shortcuts', 'controls', 'status', 'notes'], ['schema', 'id', 'version', 'origins', 'pageTypes']);
  if (raw.schema !== PROFILE_SCHEMA) fail('profile.schema', `must be ${PROFILE_SCHEMA}`);
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) fail('profile.id', 'must be 1-64 lowercase letters, digits and . _ -');
  if (!Number.isSafeInteger(raw.version) || raw.version < 1) fail('profile.version', 'must be a positive integer');
  const origins = list(raw.origins, 'profile.origins', PROFILE_LIMITS.maxOrigins, { min: 1 })
    .map((origin, index) => exactOrigin(origin, `profile.origins[${index}]`));
  if (raw.description !== undefined && (typeof raw.description !== 'string'
    || raw.description.length > PROFILE_LIMITS.maxDescription)) {
    fail('profile.description', `must be a string of at most ${PROFILE_LIMITS.maxDescription} characters`);
  }
  let forbid = [];
  if (raw.restrict !== undefined) {
    onlyKeys(raw.restrict, 'profile.restrict', ['forbid']);
    try {
      ({ forbid } = normalizeAdditions({ forbid: raw.restrict.forbid ?? [] }, 'profile.restrict'));
    } catch (error) {
      throw new ProfileError(error.message);
    }
  }
  let defaults = {};
  if (raw.defaults !== undefined) {
    onlyKeys(raw.defaults, 'profile.defaults', ['mode', 'maxActions']);
    if (raw.defaults.mode !== undefined && !LEVELS.slice(0, 4).includes(raw.defaults.mode)) {
      fail('profile.defaults.mode', 'must be read-only, reversible, interactive or full');
    }
    if (raw.defaults.maxActions !== undefined && (!Number.isInteger(raw.defaults.maxActions)
      || raw.defaults.maxActions < 1 || raw.defaults.maxActions > 20)) fail('profile.defaults.maxActions', 'must be 1 to 20');
    defaults = { ...raw.defaults };
  }
  plainObject(raw.pageTypes, 'profile.pageTypes');
  const entries = Object.entries(raw.pageTypes);
  if (!entries.length || entries.length > PROFILE_LIMITS.maxPageTypes) {
    fail('profile.pageTypes', `must define 1 to ${PROFILE_LIMITS.maxPageTypes} page types`);
  }
  const types = new Map(entries.map(([id, type]) => [id, compilePageType(id, type, `profile.pageTypes.${id}`)]));
  const edges = raw.edges === undefined ? [] : list(raw.edges, 'profile.edges', PROFILE_LIMITS.maxEdges)
    .map((edge, index) => compileEdge(edge, `profile.edges[${index}]`, types));
  const ids = new Set();
  for (const edge of edges) {
    if (ids.has(edge.id)) fail('profile.edges', `repeats the edge id "${edge.id}"`);
    ids.add(edge.id);
  }
  const shortcuts = raw.shortcuts === undefined ? [] : list(raw.shortcuts, 'profile.shortcuts', PROFILE_LIMITS.maxShortcuts)
    .map((shortcut, index) => compileShortcut(shortcut, `profile.shortcuts[${index}]`, types));
  for (const shortcut of shortcuts) {
    if (ids.has(shortcut.id)) fail('profile.shortcuts', `repeats the id "${shortcut.id}" (edges and shortcuts share ids)`);
    ids.add(shortcut.id);
  }
  const controls = raw.controls === undefined ? [] : list(raw.controls, 'profile.controls', PROFILE_LIMITS.maxControls)
    .map((control, index) => compileControl(control, `profile.controls[${index}]`));
  const status = raw.status === undefined ? [] : list(raw.status, 'profile.status', PROFILE_LIMITS.maxStatus)
    .map((text, index) => literal(text, `profile.status[${index}]`, PROFILE_LIMITS.maxStatusText).trim());
  const notes = raw.notes === undefined ? [] : list(raw.notes, 'profile.notes', PROFILE_LIMITS.maxNotes)
    .map((note, index) => safeNote(note) ?? fail(`profile.notes[${index}]`, `must be a plain sentence of at most `
      + `${PROFILE_LIMITS.maxNote} characters (letters, digits, spaces and . , ; - ' " / ( ) &, no colon) with no action `
      + 'or instruction word'));
  return Object.freeze({
    id: raw.id, version: raw.version, ref: `${raw.id}@${raw.version}`, origins: Object.freeze(origins),
    forbid: Object.freeze(forbid), defaults: Object.freeze(defaults), types, edges: Object.freeze(edges),
    shortcuts: Object.freeze(shortcuts), controls: Object.freeze(controls), status: Object.freeze(status),
    notes: Object.freeze(notes),
  });
}

// Profile directories a domain root's matchSite() looks at, at most.
const MAX_SITE_SCAN = 200;

/** The directory name for an origin: host, plus "_<port>" for a non-default port; null for anything else. */
export function originSlug(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.origin !== origin) return null;
  const slug = `${url.hostname.toLowerCase()}${url.port ? `_${url.port}` : ''}`;
  return /^[a-z0-9][a-z0-9.-]{0,252}(?:_\d{1,5})?$/.test(slug) && !slug.includes('..') ? slug : null;
}

/** $FAI_DOMAINS_DIR, else $FAI_HOME/domains, else the package's own domains/. */
export function domainsDir(env = process.env) {
  if (env.FAI_DOMAINS_DIR) return resolve(env.FAI_DOMAINS_DIR);
  const home = faiHome(env);
  return join(customHome(home, env) ? home : PACKAGE_ROOT, 'domains');
}

function inside(dir, root) {
  const rel = relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Where hit/miss counters go: `<home>/domain-stats` when FAI_HOME is not the package root, else `<stateDir>/domain-stats`
 * when the daemon state directory (FAI_DAEMON_DIR) is outside the package, else a per-user temporary directory. Never
 * inside the package (so never in the repository's domains/) and never in a profile directory.
 */
export function domainStatsDir({ home = faiHome(), stateDir = home } = {}) {
  for (const base of [home, stateDir]) {
    const dir = join(resolve(base), 'domain-stats');
    if (!inside(dir, PACKAGE_ROOT)) return dir;
  }
  const user = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return join(tmpdir(), `fai-browser-domain-stats-${user}`);
}

function emptyStats(profile) {
  return { id: profile.id, version: profile.version, runs: 0, fastSteps: 0, hinted: 0, fallbacks: {}, pageTypes: {},
    edges: {}, shortcuts: {}, updatedAt: null };
}

function bump(table, key, field, n = 1) {
  table[key] ??= {};
  table[key][field] = (table[key][field] ?? 0) + n;
}

/**
 * The profile store the daemon (or an SDK caller) hands the runtime: `match(origin)` returns the compiled profile
 * for an exact origin or null (cached by file mtime; an invalid file is logged once per mtime and ignored), and
 * `record(profile, delta)` adds a run's hit/miss counters to `<statsDir>/<slug>.json` (0600, atomic replace).
 */
export function createDomainStore({ dir = domainsDir(), statsDir = domainStatsDir(), log = () => {} } = {}) {
  const root = resolve(dir);
  const stats = resolve(statsDir);
  if (inside(stats, root)) throw new TypeError('statsDir must not be inside the profiles directory');
  const cache = new Map(); // slug -> { mtimeMs, profile, error }

  function load(slug) {
    const file = join(root, slug, 'profile.json');
    let stat;
    try {
      stat = statSync(file);
    } catch {
      cache.delete(slug);
      return null;
    }
    const cached = cache.get(slug);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
    const entry = { mtimeMs: stat.mtimeMs, profile: null, error: null };
    try {
      if (stat.size > PROFILE_LIMITS.maxBytes) throw new ProfileError(`profile: larger than ${PROFILE_LIMITS.maxBytes} bytes`);
      let raw;
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        throw new ProfileError(`profile: not valid JSON (${error.message})`);
      }
      entry.profile = compileProfile(raw);
    } catch (error) {
      entry.error = String(error?.message ?? error).slice(0, 300);
      log('profile_invalid', { slug, message: entry.error });
    }
    cache.set(slug, entry);
    return entry;
  }

  return {
    dir: root,
    statsDir: stats,
    match(origin) {
      const slug = originSlug(origin);
      if (!slug) return null;
      const entry = load(slug);
      const profile = entry?.profile;
      return profile && profile.origins.includes(origin) ? profile : null;
    },
    /**
     * The profiles of the origins a domain-root entry ("https://*.example.com") covers: profile directories named after
     * the root or one of its subdomains (default port), each profile kept only when an origin it lists is covered by
     * the entry (the same matcher as every origin check). At most MAX_SITE_SCAN directories are looked at.
     */
    matchSite(entry) {
      const rootHost = siteRoot(entry);
      if (!rootHost) return [];
      let names;
      try {
        names = readdirSync(root).sort().slice(0, MAX_SITE_SCAN);
      } catch {
        return [];
      }
      const found = [];
      for (const slug of names) {
        if (slug.includes('_') || slug !== originSlug(`https://${slug}`) || !hostInSite(slug, rootHost)) continue;
        const profile = load(slug)?.profile;
        if (profile && profile.origins.some(origin => originCovered(origin, [entry])) && !found.includes(profile)) {
          found.push(profile);
        }
      }
      return found;
    },
    /** The load error for an origin's profile file, or null (for `status` and tests). */
    error(origin) {
      const slug = originSlug(origin);
      return slug ? load(slug)?.error ?? null : null;
    },
    /** The stats file of a profile (for benches and tests). */
    statsFile(profile) {
      const slug = originSlug(profile.origins[0]);
      return slug ? join(stats, `${slug}.json`) : null;
    },
    record(profile, delta) {
      const slug = originSlug(profile.origins[0]);
      if (!slug || !delta) return;
      const file = join(stats, `${slug}.json`);
      let current;
      try {
        current = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        current = null;
      }
      if (!current || current.id !== profile.id || current.version !== profile.version) current = emptyStats(profile);
      current.runs += 1;
      current.fastSteps += delta.fastSteps ?? 0;
      current.hinted += delta.hinted ?? 0;
      if (delta.fallback) current.fallbacks[delta.fallback] = (current.fallbacks[delta.fallback] ?? 0) + 1;
      for (const [id, counts] of Object.entries(delta.pageTypes ?? {})) {
        for (const [field, n] of Object.entries(counts)) bump(current.pageTypes, id, field, n);
      }
      for (const [id, counts] of Object.entries(delta.edges ?? {})) {
        for (const [field, n] of Object.entries(counts)) bump(current.edges, id, field, n);
      }
      current.shortcuts ??= {};
      for (const [id, counts] of Object.entries(delta.shortcuts ?? {})) {
        for (const [field, n] of Object.entries(counts)) bump(current.shortcuts, id, field, n);
      }
      current.updatedAt = new Date().toISOString();
      try {
        mkdirSync(stats, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, file);
      } catch (error) {
        log('profile_stats_error', { slug, code: typeof error?.code === 'string' ? error.code : 'failed' });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Matching and planning
// ---------------------------------------------------------------------------------------------------------------

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function pathOf(url, base) {
  try {
    const parsed = new URL(url, base);
    const path = `${parsed.pathname}${parsed.search}`;
    return path.length > URL_INPUT ? null : { origin: parsed.origin, path };
  } catch {
    return null;
  }
}

const has = (haystack, needle) => String(haystack ?? '').slice(0, TEXT_INPUT).replace(/\s+/g, ' ').toLowerCase().includes(needle);

function checkPasses(check, observation) {
  switch (check.kind) {
    case 'title':
      return has(String(observation.title ?? '').slice(0, LABEL_INPUT), check.text);
    case 'heading':
      return (observation.blocks ?? []).some(block => block?.t === 'h1' && has(String(block.text ?? '').slice(0, LABEL_INPUT), check.text));
    case 'link':
      return (observation.controls ?? []).some(control => control?.role === 'link' && control.visible !== false
        && has(String(control.label ?? '').slice(0, LABEL_INPUT), check.text));
    case 'text':
      return has(observation.text, check.text);
    default:
      return false;
  }
}

/** The captures of `type` on this observation (URL template and every check), or null when it is not that type. */
export function matchType(profile, typeId, observation) {
  const type = profile.types.get(typeId);
  const at = pathOf(observation?.url ?? '');
  if (!type || !at || !profile.origins.includes(at.origin)) return null;
  const captures = type.url.test(at.path);
  if (!captures) return null;
  if (!type.checks.every(check => checkPasses(check, observation))) return null;
  return captures;
}

/** The first page type (profile order) this observation proves, `{ id, captures }`, or null. */
export function pageTypeOf(profile, observation) {
  for (const id of profile.types.keys()) {
    const captures = matchType(profile, id, observation);
    if (captures) return { id, captures };
  }
  return null;
}

/** Page types a declarative expectation names through their `expect` templates (urlIncludes, or urlEquals' path). */
export function targetTypes(profile, expectation) {
  if (!expectation || typeof expectation !== 'object') return [];
  const values = [];
  if (typeof expectation.urlIncludes === 'string') values.push(expectation.urlIncludes);
  if (typeof expectation.urlEquals === 'string') {
    const at = pathOf(expectation.urlEquals);
    if (at && profile.origins.includes(at.origin)) values.push(at.path);
  }
  if (!values.length) return [];
  return [...profile.types.values()]
    .filter(type => values.every(value => type.expect.some(template => template.test(value))))
    .map(type => type.id);
}

/** The shortest edge route (breadth first, profile order on ties) from `from` to any of `targets`; null if none. */
export function planRoute(profile, from, targets) {
  if (!profile.types.has(from) || !targets.length) return null;
  if (targets.includes(from)) return [];
  const previous = new Map([[from, null]]);
  let frontier = [from];
  for (let depth = 0; depth < PROFILE_LIMITS.maxRoute && frontier.length; depth++) {
    const next = [];
    for (const node of frontier) {
      for (const edge of profile.edges) {
        if (edge.from !== node || previous.has(edge.to)) continue;
        previous.set(edge.to, edge);
        if (targets.includes(edge.to)) {
          const route = [edge];
          for (let step = previous.get(edge.from); step; step = previous.get(step.from)) route.unshift(step);
          return route;
        }
        next.push(edge.to);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * True for an offered action the fast path may take: a link click with a real href observed on the page, or the
 * same-tab form legalActions builds for an observed same-origin link that would open a new tab (`newTab`). Never a
 * host-supplied allowed URL, a button, select, fill, scroll or wait.
 */
export function fastClass(action) {
  if (!action) return false;
  if (action.type === 'click') return action.role === 'link' && typeof action.href === 'string' && Boolean(action.href);
  return action.type === 'navigate_allowed_url' && action.newTab === true && typeof action.url === 'string';
}

function destinationOf(action, base) {
  try {
    const url = new URL(action.type === 'navigate_allowed_url' ? action.url : action.href, base);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Fast-path selection never takes a link whose label or path reads like an account or commit action, nor one that
 * leaves the page's origin (legalActions already offers only same-origin links; this is defence in depth).
 */
function quietLink(action, base) {
  const text = String(action.label ?? '');
  if (labelClasses(text).length || destructiveLink(text)) return false;
  const at = pathOf(destinationOf(action, base) ?? '', base);
  return Boolean(at) && at.origin === originOf(base) && !PATH_DANGER.test(at.path);
}

/** A literal link label matches the whole label, or its start followed by a non-letter, non-digit character. */
function labelMatches(literalText, label) {
  const text = String(label ?? '').slice(0, LABEL_INPUT).replace(/\s+/g, ' ').trim().toLowerCase();
  if (text === literalText) return true;
  return text.startsWith(literalText) && !/[\p{L}\p{N}]/u.test(text.charAt(literalText.length));
}

const BOUNDARY = new Set(['/', '?', '&', '#', '.', '=']);

/**
 * True when `path` (a destination's path and query) contains `want` (expectation.urlIncludes) at boundaries: the
 * character before is a separator (or `want` starts with one, or it is the start), and the one after is the end or one
 * of / ? & # . =, so /issues/123 never accepts /issues/1234.
 */
export function containsAtBoundary(path, want) {
  if (typeof want !== 'string' || !want) return false;
  for (let index = path.indexOf(want); index >= 0; index = path.indexOf(want, index + 1)) {
    const before = index === 0 ? '' : path.charAt(index - 1);
    const after = path.charAt(index + want.length);
    const startOk = index === 0 || BOUNDARY.has(want.charAt(0)) || BOUNDARY.has(before);
    const endOk = after === '' || BOUNDARY.has(after) || BOUNDARY.has(want.charAt(want.length - 1));
    if (startOk && endOk) return true;
  }
  return false;
}

/** Whether a last-hop destination satisfies the run's expectation (urlIncludes at boundaries, urlEquals exactly). */
function satisfiesExpectation(destination, base, expectation) {
  if (!expectation || typeof expectation !== 'object') return false;
  const at = pathOf(destination ?? '', base);
  if (!at) return false;
  if (typeof expectation.urlEquals === 'string' && destination !== expectation.urlEquals) return false;
  if (typeof expectation.urlIncludes === 'string' && !containsAtBoundary(at.path, expectation.urlIncludes)) return false;
  return typeof expectation.urlEquals === 'string' || typeof expectation.urlIncludes === 'string';
}

/**
 * Resolve one link edge against this page: `{ action }` with exactly one destination among the offered fast-class
 * links, or `{ reason }` (no_match, ambiguous). The destination must match the edge's href template with every
 * placeholder named like a source capture bound to that capture's value; on the route's last hop (`last`) it must also
 * satisfy the run's expectation. Nothing outside `offered` is ever considered.
 */
export function resolveEdge(edge, observation, captures, offered, { last = false, expectation } = {}) {
  const base = observation.url;
  const matches = offered.filter(action => {
    if (!fastClass(action) || !quietLink(action, base)) return false;
    if (edge.link.label !== null && !labelMatches(edge.link.label, action.label)) return false;
    const destination = destinationOf(action, base);
    const at = pathOf(destination ?? '', base);
    const bound = at ? edge.link.href.test(at.path) : null;
    if (!bound) return false;
    for (const [name, value] of Object.entries(bound)) {
      if (Object.hasOwn(captures ?? {}, name) && captures[name] !== value) return false;
    }
    return !last || satisfiesExpectation(destination, base, expectation);
  });
  const destinations = new Set(matches.map(action => destinationOf(action, base)));
  if (!matches.length) return { reason: 'no_match' };
  if (destinations.size > 1) return { reason: 'ambiguous' };
  return { action: matches[0] };
}

/** True when the page text or title addresses an agent (the fast path then defers to Jev and its injection noul). */
export function agentAddressed(observation) {
  return AGENT_ADDRESSED.test(`${String(observation?.title ?? '').slice(0, LABEL_INPUT)}\n${String(observation?.text ?? '').slice(0, TEXT_INPUT)}`);
}

/** True when `url` is one of the profile's pages: on one of its origins, with a path matching a page type's url. */
export function onProfilePage(profile, url) {
  const at = pathOf(url ?? '');
  if (!at || !profile?.origins.includes(at.origin)) return false;
  for (const type of profile.types.values()) if (type.url.test(at.path)) return true;
  return false;
}

/**
 * The persistent status lines of the profiles for a page (an observation): a predicate on a block's text (the whole
 * text, or its start followed by a non-letter, non-digit character: "Fetching results, 0%"), or null when no profile
 * names any for this page or the page carries no rows of its own (src/digest.js carriesRows; the rule persistent
 * status text follows too: on an empty results page the same line is the only sign of a real load). The runtime does
 * not treat such a block as a loading placeholder (src/runtime.js loadingOf).
 */
export function statusFilter(profiles, observation) {
  const url = observation?.url;
  if (!carriesRows(observation)) return null;
  const texts = (profiles ?? []).filter(profile => profile.status?.length && onProfilePage(profile, url))
    .flatMap(profile => profile.status);
  return texts.length ? text => texts.some(literalText => labelMatches(literalText, text)) : null;
}

const exactLabel = (literalText, label) => String(label ?? '').slice(0, LABEL_INPUT).replace(/\s+/g, ' ').trim()
  .toLowerCase() === literalText;
// Pinned control labels that join the page script's control-ordering terms (phrases; ordering only).
const MAX_PIN_TERMS = 6;

// ---------------------------------------------------------------------------------------------------------------
// Per-run state
// ---------------------------------------------------------------------------------------------------------------

/**
 * Resolve the `profiles` switch: 'on' | 'off' | boolean | { fastPath?, hints? } -> { enabled, fastPath, hints }.
 * Default OFF (experimental, opt-in): only "on", true or an object turns profiles on. `enabled` is false when both
 * parts are off; then no profile applies at all (its `restrict.forbid` included).
 */
export function resolveProfiles(value) {
  let out;
  if (value === undefined || value === null || value === false || value === 'off') out = { fastPath: false, hints: false };
  else if (value === true || value === 'on') out = { fastPath: true, hints: true };
  else if (typeof value === 'object' && !Array.isArray(value)) {
    out = { fastPath: true, hints: true };
    for (const [key, flag] of Object.entries(value)) {
      if (key !== 'fastPath' && key !== 'hints') throw new TypeError(`Unknown profiles switch "${key}" (use fastPath and hints)`);
      if (typeof flag !== 'boolean') throw new TypeError(`profiles.${key} must be a boolean`);
      out[key] = flag;
    }
  } else {
    throw new TypeError('profiles must be "on", "off", a boolean or { fastPath, hints }');
  }
  return { enabled: out.fastPath || out.hints, ...out };
}

export const SITE_FALLBACKS = Object.freeze(['mismatch', 'cross_origin', 'consent', 'login', 'injection', 'blocked',
  'guard_error', 'error_page', 'action_error', 'ended']);

/**
 * One run's use of the matched profiles. `next()` proposes a fast step (or prepares a hint), `land()` checks where
 * a fast step landed, `stop()` ends the fast path for the rest of the run, `context()` is the state.site hint for
 * the decide about to be made, `receipt()` the trusted `site` block and `deltas()` the stats per profile.
 */
export class SiteRun {
  /**
   * `shortcuts`: the runtime allows profile shortcuts in this run (fast path on, level reversible or above);
   * `instruction`: the run's (or list step's) instruction, which names the value a shortcut goes to.
   */
  constructor(profiles, { expectation, instruction = '', template, fastPath = true, hints = true, shortcuts = false } = {}) {
    this.profiles = profiles; // compiled profiles, each for its own origins
    this.expectation = expectation;
    this.fastPath = fastPath;
    this.hints = hints;
    this.shortcutsOn = Boolean(fastPath && shortcuts);
    // Shortcut kind -> the value this step asks for (the kind's target, src/shortcuts.js), computed once.
    this.targets = new Map();
    if (this.shortcutsOn) {
      for (const kind of new Set(profiles.flatMap(profile => (profile.shortcuts ?? []).map(shortcut => shortcut.kind)))) {
        const value = SHORTCUT_KINDS[kind].target({ instruction, expectation, template });
        if (value) this.targets.set(kind, value);
      }
    }
    this.shortcutsTaken = 0;
    this.noted = 0;
    this.renamed = 0;
    this.steps = []; // fast steps taken: edge ids
    this.pending = null; // { profile, edge } awaiting land()
    this.hint = null;
    this.hinted = 0;
    this.stopped = null; // { reason, edge?, step? }
    this.retried = false; // a fast step the page refused as stale was resolved again once
    this.counts = new Map(); // profile -> { pageTypes, edges }
    // The profiles this run plans with: those whose page types the expectation names (receipt and stats).
    // Also those with a shortcut this step names a value for; a profile whose pins, names or notes reach a decide
    // joins when they do (use()).
    this.used = new Set(profiles.filter(profile => targetTypes(profile, expectation).length
      || (profile.shortcuts ?? []).some(shortcut => this.targets.has(shortcut.kind))));
  }

  use(profile) {
    this.used.add(profile);
  }

  /**
   * The shortcut for this observation: `{ action, edge, shortcut, profile }` with a runtime-built same-origin
   * navigate_allowed_url action, or null. Taken when the page proves the shortcut's `on` page type, the step names
   * exactly one value for its kind and the current URL holds another one; the transformed URL must keep the page's
   * origin and path. `allowed(url)` is the runtime's approved-origin check.
   */
  shortcut(observation, allowed = () => false) {
    if (!this.shortcutsOn || this.stopped || this.pending || !this.targets.size) return null;
    const profile = this.profileFor(observation?.url);
    if (!profile?.shortcuts?.length) return null;
    const here = pageTypeOf(profile, observation);
    if (!here) return null;
    for (const shortcut of profile.shortcuts) {
      const kind = SHORTCUT_KINDS[shortcut.kind];
      const value = this.targets.get(shortcut.kind);
      if (shortcut.on !== here.id || !value) continue;
      const current = kind.current(observation.url);
      // The URL holds another value, or (a kind that starts from nothing: a search query on the search page) none.
      if (current === value || (!current && !kind.fromEmpty)) continue;
      // The kind's URL for the value, only when it keeps the page's origin and path (src/shortcuts.js rewriteWithin).
      const url = rewriteWithin(kind, observation.url, value);
      const to = url ? pathOf(url) : null;
      if (!to || !profile.origins.includes(to.origin) || !allowed(url)) {
        this.count(profile, 'shortcuts', shortcut.id, 'no_url');
        continue;
      }
      if (agentAddressed(observation)) {
        this.stop('injection', shortcut);
        return null;
      }
      this.use(profile);
      this.pending = { profile, edge: shortcut, shortcut: { kind, value } };
      const label = kind.label(value);
      return {
        action: {
          id: 'site_shortcut', type: 'navigate_allowed_url', url, label: `Open ${label}`,
          description: `Open the ${label} (site profile shortcut ${shortcut.id})`,
        },
        edge: shortcut, shortcut: shortcut.id, from: here.id, to: shortcut.to, profile,
      };
    }
    return null;
  }

  /**
   * The pinned-control predicate for this page (the option caps keep every action it accepts, src/relevance.js
   * capActions), or null. Hints on, the profile's pages only; matched on the action's own label (exact, or the
   * literal followed by a non-letter).
   */
  pinned(observation) {
    if (!this.hints) return null;
    const profile = this.profileFor(observation?.url);
    const pins = profile?.controls?.filter(control => control.pin) ?? [];
    if (!pins.length || !onProfilePage(profile, observation.url)) return null;
    return action => pins.some(control => labelMatches(control.label, action?.label));
  }

  /**
   * What the provider is shown for this page: the observation and offered actions with each page-script name the
   * profile renames (`next-value button after "Departure" (unlabelled)`) replaced by its plain name, in copies, for
   * controls the page script marked `unnamed` only (a page label that reads the same is the page's own); the inputs
   * themselves when nothing is renamed. Ids, targets and every other field are unchanged, so a choice maps back.
   */
  present(observation, actions) {
    if (!this.hints) return { observation, actions };
    const profile = this.profileFor(observation?.url);
    const names = profile?.controls?.filter(control => control.name) ?? [];
    if (!names.length || !onProfilePage(profile, observation.url)) return { observation, actions };
    const nameOf = text => names.find(control => exactLabel(control.label, text))?.name ?? null;
    let renamed = 0;
    const outActions = actions.map(action => {
      const name = action.target !== undefined && action.unnamed === true ? nameOf(action.label) : null;
      if (!name) return action;
      renamed++;
      const original = String(action.label);
      const description = typeof action.description === 'string' && action.description.endsWith(original)
        ? `${action.description.slice(0, -original.length)}${name} (site profile name; page: ${original})`
        : action.description;
      return { ...action, label: name, description };
    });
    if (!renamed) return { observation, actions };
    const controls = (observation.controls ?? []).map(control => {
      const name = control?.unnamed === true ? nameOf(control.label) : null;
      return name ? { ...control, label: name } : control;
    });
    this.renamed += renamed;
    this.use(profile);
    return { observation: { ...observation, controls }, actions: outActions };
  }

  profileFor(url) {
    const origin = originOf(url);
    return this.profiles.find(profile => profile.origins.includes(origin)) ?? null;
  }

  count(profile, table, id, field) {
    if (!this.counts.has(profile)) this.counts.set(profile, { pageTypes: {}, edges: {}, shortcuts: {} });
    bump(this.counts.get(profile)[table], id, field);
  }

  /**
   * The fast step for this observation: `{ action, edge }` out of `offered`, or null. Also leaves `hint` for the
   * decide when a planned link edge cannot be taken mechanically. `atStep` labels a fallback in the receipt.
   */
  next(observation, offered, atStep) {
    this.hint = null;
    if (this.stopped || this.pending) return null;
    const profile = this.profileFor(observation?.url);
    if (!profile) return null;
    const targets = targetTypes(profile, this.expectation);
    if (!targets.length) return null;
    const here = pageTypeOf(profile, observation);
    if (!here) return null;
    this.count(profile, 'pageTypes', here.id, 'seen');
    const route = planRoute(profile, here.id, targets);
    if (!route?.length) return null;
    const edge = route[0];
    const target = route.at(-1).to;
    if (agentAddressed(observation)) {
      this.stop('injection', edge, atStep);
      return null;
    }
    // Every edge for this hop (same from and to, profile order) is tried.
    const choices = profile.edges.filter(candidate => candidate.from === edge.from && candidate.to === edge.to);
    const last = route.length === 1;
    if (this.fastPath) {
      for (const choice of choices) {
        const resolved = resolveEdge(choice, observation, here.captures, offered, { last, expectation: this.expectation });
        if (resolved.action) {
          this.pending = { profile, edge: choice };
          return { action: resolved.action, edge: choice, from: here.id, to: choice.to, profile };
        }
        this.count(profile, 'edges', choice.id, resolved.reason);
      }
    }
    const hinted = choices.find(choice => choice.link.hint);
    if (this.hints && hinted) {
      this.hint = {
        page: profile.types.get(here.id).label,
        target: profile.types.get(target).label,
        link: hinted.link.hint,
      };
    }
    return null;
  }

  /**
   * Check the page a fast step landed on: 'hit' (it proves the edge's page type) or 'miss' (fast path stops; a page off
   * the profile's origins is recorded as cross_origin).
   */
  land(observation, atStep) {
    const pending = this.pending;
    if (!pending) return null;
    this.pending = null;
    const { profile, edge } = pending;
    if (pending.shortcut) {
      // A shortcut lands when the URL is the target type's URL (or, for an in-place kind, the `on` type's own URL)
      // showing the value asked for. The page's checks are not required: a results page is often still filling in
      // when the navigation settles.
      const { kind, value } = pending.shortcut;
      const at = pathOf(observation?.url ?? '');
      const typeHit = Boolean(at) && (Boolean(profile.types.get(edge.to)?.url.test(at.path))
        || (kind.inPlace === true && Boolean(profile.types.get(edge.on)?.url.test(at.path))));
      const shows = typeof kind.landed === 'function' ? kind.landed(observation.url, value) : kind.current(observation.url) === value;
      const hit = Boolean(at) && profile.origins.includes(at.origin) && typeHit && shows;
      this.count(profile, 'shortcuts', edge.id, hit ? 'hit' : 'miss');
      this.count(profile, 'pageTypes', edge.to, hit ? 'hit' : 'miss');
      if (hit) {
        this.steps.push(edge.id);
        this.shortcutsTaken++;
        return 'hit';
      }
      this.stop(at && profile.origins.includes(at.origin) ? 'mismatch' : 'cross_origin', edge, atStep);
      return 'miss';
    }
    if (matchType(profile, edge.to, observation)) {
      this.steps.push(edge.id);
      this.count(profile, 'edges', edge.id, 'hit');
      this.count(profile, 'pageTypes', edge.to, 'hit');
      return 'hit';
    }
    this.count(profile, 'edges', edge.id, 'miss');
    this.count(profile, 'pageTypes', edge.to, 'miss');
    this.stop(profile.origins.includes(originOf(observation?.url)) ? 'mismatch' : 'cross_origin', edge, atStep);
    return 'miss';
  }

  /**
   * A fast step the page refused as stale (it changed between the observation and the click: MDN adds its ad and
   * sign-in links a few hundred ms after load): clear the pending step without ending the fast path, so the edge is
   * resolved again on the fresh observation. Once per run; returns false when already used (the caller then stops).
   */
  retry() {
    if (this.retried || !this.pending || this.stopped) return false;
    this.retried = true;
    this.count(this.pending.profile, this.pending.shortcut ? 'shortcuts' : 'edges', this.pending.edge.id, 'stale');
    this.pending = null;
    return true;
  }

  /** End the fast path for this run (first reason wins); a pending step counts as a miss. */
  stop(reason, edge = this.pending?.edge, atStep) {
    if (this.pending) {
      this.count(this.pending.profile, this.pending.shortcut ? 'shortcuts' : 'edges', this.pending.edge.id, 'miss');
      this.pending = null;
    }
    this.hint = null;
    if (this.stopped) return;
    this.stopped = { reason };
    if (edge) this.stopped.edge = edge.id;
    if (Number.isInteger(atStep)) this.stopped.step = atStep;
  }

  /**
   * Words of the link hints on any route to the targets (at most MAX_SITE_TERMS), for the page script's control
   * ordering under its 100-control cap, so the link a hop needs is observed on busy pages. Ordering only: it never
   * changes what is offered or allowed.
   */
  terms() {
    const out = [];
    for (const profile of this.used) {
      const targets = targetTypes(profile, this.expectation);
      const reach = new Set(targets);
      for (let grew = true; grew;) {
        grew = false;
        for (const edge of profile.edges) {
          if (reach.has(edge.to) && !reach.has(edge.from)) {
            reach.add(edge.from);
            grew = true;
          }
        }
      }
      for (const edge of profile.edges) {
        if (!edge.link.hint || !reach.has(edge.to)) continue;
        for (const word of edge.link.hint.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
          if (!out.includes(word) && out.length < MAX_SITE_TERMS) out.push(word);
        }
      }
    }
    // Pinned labels (hints on), as whole phrases; page-script names are not page labels and are left out.
    if (this.hints) {
      let pins = 0;
      for (const profile of this.profiles) {
        for (const control of profile.controls ?? []) {
          const phrase = control.label.slice(0, 40);
          if (!control.pin || UNNAMED_LABEL.test(control.label) || out.includes(phrase) || pins >= MAX_PIN_TERMS) continue;
          out.push(phrase);
          pins++;
        }
      }
    }
    return out;
  }

  /**
   * The state.site hint for the decide about to be made, or null. The link hint is consumed by one decide; the
   * profile's notes (hints on, the profile's pages only) go with every full decide on its pages.
   */
  context(observation = null) {
    const hint = this.hint;
    this.hint = null;
    const profile = this.hints && observation ? this.profileFor(observation.url) : null;
    const notes = profile?.notes?.length && onProfilePage(profile, observation.url) ? [...profile.notes] : null;
    if (!hint && !notes) return null;
    if (hint) this.hinted++;
    if (notes) {
      this.noted++;
      this.use(profile);
    }
    return notes ? { ...(hint ?? {}), notes } : hint;
  }

  /** The trusted receipt block: profile ref(s), fast steps, hints given and where the fast path stopped. */
  receipt() {
    if (!this.used.size) return null;
    const refs = [...this.used].map(profile => profile.ref);
    const out = { profile: refs.length === 1 ? refs[0] : refs, fastSteps: this.steps.length };
    if (this.steps.length) out.path = [...this.steps];
    if (this.shortcutsTaken) out.shortcuts = this.shortcutsTaken;
    if (this.hinted) out.hinted = this.hinted;
    if (this.noted) out.noted = this.noted;
    if (this.renamed) out.renamed = this.renamed;
    if (this.stopped) out.fellBack = { ...this.stopped };
    return out;
  }

  /** Stats deltas per used profile, for DomainStore.record(). */
  deltas() {
    const out = [];
    for (const profile of this.used) {
      const counts = this.counts.get(profile) ?? { pageTypes: {}, edges: {}, shortcuts: {} };
      out.push({
        profile,
        delta: {
          fastSteps: this.steps.length,
          hinted: this.hinted,
          fallback: this.stopped?.reason ?? null,
          pageTypes: counts.pageTypes,
          edges: counts.edges,
          shortcuts: counts.shortcuts,
        },
      });
    }
    return out;
  }
}

/**
 * Merge `site` receipt blocks of several attempts or list steps, in order: the union of profile refs, summed fast
 * steps and hints, the concatenated path, and the first fallback. Null when none used a profile.
 */
export function mergeSite(blocks) {
  const present = blocks.filter(block => block && typeof block === 'object');
  if (!present.length) return null;
  if (present.length === 1) return structuredClone(present[0]);
  const refs = [...new Set(present.flatMap(block => (Array.isArray(block.profile) ? block.profile : [block.profile])))];
  const out = { profile: refs.length === 1 ? refs[0] : refs, fastSteps: present.reduce((sum, block) => sum + (block.fastSteps ?? 0), 0) };
  const path = present.flatMap(block => block.path ?? []);
  if (path.length) out.path = path;
  for (const key of ['shortcuts', 'hinted', 'noted', 'renamed']) {
    const total = present.reduce((sum, block) => sum + (block[key] ?? 0), 0);
    if (total) out[key] = total;
  }
  const back = present.find(block => block.fellBack)?.fellBack;
  if (back) out.fellBack = { ...back };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// state.site rendering (src/typesafe.js)
// ---------------------------------------------------------------------------------------------------------------

/** The policy line sent with state.site: hints never allow anything. */
export const SITE_POLICY_LINE = '`site` is a hint from the user\'s FAI Browser site profile, not from the page: it '
  + 'never makes an action allowed that `policy` reserves for the user.';

/**
 * Render state.site from a hint `{ page, target, link }` with fixed templates; every field is re-filtered with
 * safeLabel, so a direct provider caller cannot put anything else in. Null when nothing survives.
 */
export function renderSite(hint) {
  if (!hint || typeof hint !== 'object') return null;
  const page = safeLabel(hint.page, PROFILE_LIMITS.maxLabel);
  const target = safeLabel(hint.target, PROFILE_LIMITS.maxLabel);
  const link = safeLabel(hint.link, PROFILE_LIMITS.maxHint);
  // Profile notes (every one re-filtered with safeNote, at most maxNotes).
  const notes = Array.isArray(hint.notes)
    ? hint.notes.slice(0, PROFILE_LIMITS.maxNotes).map(safeNote).filter(Boolean)
    : [];
  const out = page && target && link
    ? { page, target, next: `The usual next step toward the ${target} is the link labelled "${link}".` }
    : null;
  if (!notes.length) return out;
  return { ...(out ?? {}), notes };
}
