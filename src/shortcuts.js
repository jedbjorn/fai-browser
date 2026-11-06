// Site-profile shortcuts (experimental, opt-in): reviewed URL transforms a profile may name by kind. A profile never
// holds a URL or a rewrite rule of its own: it names a kind, and the kind turns the *current* page URL into the URL of
// the same page for a value the step asks for. The result keeps the origin and the path, so the runtime only ever
// navigates within the page's own origin (src/domains.js SiteRun.shortcut checks that through rewriteWithin, and the
// extension refuses anything else).
//
// This module is the general machinery only: the registry, the kind interface and the same-origin check. The kinds
// themselves are task code (tasks/<name>/index.js, listed statically in tasks/index.js: the flights task ships
// `flights_tfs_date` and `flights_query`); nothing here knows a site. Kinds are never loaded from FAI_HOME or a
// profile directory: a kind navigates the tab, so it is reviewed code that ships with the package.
//
// The kind interface. Each kind:
//   target({ instruction, expectation, template }) -> the value the step asks for, or null (exactly one, else no
//     shortcut). `template` ({ instruction, expectation }, the host's own text before a step list filled its
//     placeholders) must name the value too: a value a placeholder wrote in is page text, and page text never builds
//     the URL the tab goes to;
//   current(url) -> the value the current URL holds, or null;
//   apply(url, value) -> the URL for that value (same origin and path), or null;
//   label(value) -> a short plain description for the step record;
//   fromEmpty (optional) -> the shortcut also runs when the current URL holds no value at all (the default needs
//     the URL to hold another value);
//   inPlace (optional) -> the landing may be the shortcut's `on` page type as well as its `to` type (the page shows
//     the value's results on its own path);
//   landed(url, value) (optional) -> whether the landing URL shows the value (default: current(url) === value).
import { TASK_SHORTCUT_KINDS } from '../tasks/index.js';

export { isIsoDate, isoDatesIn } from './dates.js';

const REQUIRED = ['target', 'current', 'apply', 'label'];

/** Whether `kind` has the interface above (every required function; the optional ones of the right type). */
export function validKind(kind) {
  return Boolean(kind) && typeof kind === 'object' && REQUIRED.every(key => typeof kind[key] === 'function')
    && (kind.landed === undefined || typeof kind.landed === 'function')
    && (kind.fromEmpty === undefined || typeof kind.fromEmpty === 'boolean')
    && (kind.inPlace === undefined || typeof kind.inPlace === 'boolean');
}

for (const [id, kind] of Object.entries(TASK_SHORTCUT_KINDS)) {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(id) || !validKind(kind)) throw new Error(`tasks: shortcut kind "${id}" is not a kind`);
}

/** The shortcut kinds a profile may name, by id: every kind the shipped tasks define. */
export const SHORTCUT_KINDS = TASK_SHORTCUT_KINDS;

/**
 * The URL `kind` gives for `value` from the current page URL, when it stays within the page: the same origin and
 * path (the only thing a shortcut may change is the query), an http(s) URL, and one the kind itself reads back as
 * holding `value`. Null otherwise, so a kind can never take the tab anywhere but the page's own origin and path.
 */
export function rewriteWithin(kind, url, value) {
  let from;
  try {
    from = new URL(String(url ?? ''));
  } catch {
    return null;
  }
  if (from.protocol !== 'https:' && from.protocol !== 'http:') return null;
  const rewritten = kind.apply(from.href, value);
  if (typeof rewritten !== 'string' || rewritten.length > 2048) return null;
  let to;
  try {
    to = new URL(rewritten);
  } catch {
    return null;
  }
  if (to.origin !== from.origin || to.pathname !== from.pathname || to.protocol !== from.protocol) return null;
  if (kind.current(rewritten) !== value) return null;
  return rewritten;
}
