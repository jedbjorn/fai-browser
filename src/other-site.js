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

// At most this many characters of a destination's path are shown; a longer path is not shown at all.
const PATH_CHARS = 80;
// At most this many characters of the label.
const LABEL_CHARS = 50;

function pathHidesSecret(path) {
  if (path.includes('[secret:')) return true;
  return path.split('/').some(segment => {
    let value = segment;
    try {
      value = decodeURIComponent(segment);
    } catch {
      // Keep the raw segment.
    }
    return secretKeyShaped(value) || /^[0-9a-f]{24,}$/i.test(value);
  });
}

/**
 * What a line shows of a link's destination: `{ origin, shown, exact }`. `shown` is the origin and path, never the
 * user info, query or fragment (they carry tokens); a path longer than PATH_CHARS, or one holding a redacted or
 * key-shaped segment (a reset link's token), is left out: `shown` is the origin and `exact` false (request the origin
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
 * A link's label for its line: page text that must not imitate the destination or the line's own words, so arrows,
 * quotes, brackets and line breaks are removed and it is clipped to LABEL_CHARS.
 */
export function otherSiteLabel(label) {
  const text = String(label ?? '').replace(/[←-⇿⟰-⟿"'`“”‘’«»<>()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
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
