// Links that leave the approved site (issue #32): listed for the host with their destination, never clicked. Shared
// by the offer (src/runtime.js otherSiteAction), the host's action line (src/result.js) and the next step. The
// destination and the label are page data (the page script already redacted the href); this module only decides how
// much of them a trusted-looking line may show.
import { secretKeyShaped } from './secrets.js';

/** The fixed trusted text of an act (or a point) on a link to another site. Never holds page data. */
export const OTHER_SITE_TEXT = 'This link leaves the approved site; nothing ran. Its destination is in its action line. '
  + 'If the task needs that page, request it with fai_browser_open: origins set to that origin and, when the line shows '
  + 'the whole address, allowedUrls set to it; never guess another address.';

/** The trusted next step after such an act: the agent requests the origin itself; the user approves a new request. */
export const OTHER_SITE_NEXT = 'Nothing ran: the link leaves the approved site. If the task needs that page, call '
  + 'fai_browser_open yourself with origins set to the link\'s origin from its action line (and allowedUrls set to its '
  + 'address when the line shows it whole), and tell the user a new FAI Browser approval is coming. Never guess an address.';

/** The fixed trusted text of a point on a javascript:, data: or other non-web link: never run, at any level. */
export const NOT_WEB_LINK_TEXT = 'This link does not lead to a web page (it runs a script or holds data); nothing ran, and '
  + 'FAI Browser never follows such links. Use another offered action.';

// At most this many characters of a destination's path are shown; a longer path is not shown at all.
const PATH_CHARS = 80;
// At most this many characters of the label.
const LABEL_CHARS = 50;

// A path segment that names what the next segment is: a one-time or private link's token follows it
// (/reset/<token>, /invite/<code>, /s/<id>, /magic-link/<token>).
const SECRET_LEAD = /^(?:reset|verify|verification|confirm|confirmation|invite|invitation|magic|activate|activation|token|tokens|session|sessions|sess|auth|oauth|sso|key|keys|apikey|api-key|share|shared|s|join|password|passwd|otp|code|unsubscribe|login|signin|callback|access|ticket|grant|recover|recovery|onetime|one-time)(?:[-_].*)?$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Whether a path may carry a secret, so the line shows only the origin: a redacted placeholder, a key-shaped, long
// hex or UUID segment, a segment holding `=` (a token in the path), or any segment after a SECRET_LEAD word.
function pathHidesSecret(path) {
  if (path.includes('[secret:')) return true;
  const segments = path.split('/').map(segment => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  return segments.some((value, index) => secretKeyShaped(value) || /^[0-9a-f]{24,}$/i.test(value) || UUID.test(value)
    || value.includes('=') || (index > 0 && value !== '' && SECRET_LEAD.test(segments[index - 1])));
}

/**
 * What a line shows of a link's destination: `{ origin, shown, exact }`. `shown` is the origin and path, never the
 * user info, query or fragment (they carry tokens); a path longer than PATH_CHARS, or one holding a redacted or
 * key-shaped, UUID or `=` segment, or a segment after a reset-, invite- or share-style word (a one-time link's token), is left out: `shown` is the origin and `exact` false (request the origin
 * only). Null for anything but an http(s) URL.
 */
export function otherSiteView(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const path = url.pathname === '/' ? '' : url.pathname;
  const exact = path.length <= PATH_CHARS && !pathHidesSecret(path);
  // Brackets and quotes stay percent-encoded, so a path cannot close the line's own parenthesis or quote.
  const safe = path.replace(/[()"'<>`\s]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  return { origin: url.origin, shown: exact ? `${url.origin}${safe}` : url.origin, exact };
}

/**
 * A link's label for its line: page text that must not imitate the destination or the line's own words, so symbols,
 * quotes, brackets, "://" and line breaks are removed and it is clipped to LABEL_CHARS.
 */
export function otherSiteLabel(label) {
  // Symbols (arrows, ➜), maths signs (<, >, =), opening, closing and quoting punctuation (brackets, ‹›, ［］, quotes of
  // every width) and "://" go; what is left cannot read as a destination or close the line's own quote.
  const text = String(label ?? '').replace(/:\/\//g, ' ')
    .replace(/[\p{So}\p{Sm}\p{Ps}\p{Pe}\p{Pi}\p{Pf}"'`＂＇]/gu, ' ').replace(/\s+/g, ' ').trim();
  return text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1)}…` : text;
}

/**
 * The host's one line for an other_site action: destination first, then the cleaned label, and how many more links
 * to the same origin the listing folded into it: `link to https://jane.example.org/site/ (other site): "Our site"`.
 */
export function otherSiteBrief(action, sameOrigin = 0) {
  const view = otherSiteView(action.href) ?? { shown: String(action.origin ?? ''), exact: false };
  const note = view.exact ? 'other site' : 'other site, address not shown';
  const more = sameOrigin > 0 ? ` (+${sameOrigin} more to this origin)` : '';
  return `link to ${view.shown} (${note}): "${otherSiteLabel(action.label)}"${more}`;
}
