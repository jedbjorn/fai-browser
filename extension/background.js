'use strict';
// FAI Browser service worker: keeps a push connection to the FAI service (the local daemon), shows pending tab
// requests, holds the user-granted tab session, runs commands in the selected tab through page.js, and delivers
// annotated screenshots out of band.
//
// Pairing: with no saved secret, and again whenever the FAI service cannot be reached, the worker asks the native
// messaging host (NATIVE_HOST, installed by `npm run setup`) for the service's address and pairing secret; the host
// starts the service when it is not running. The secret goes only to chrome.storage.local (trusted contexts) and to
// the service on 127.0.0.1, never to a page or the popup's UI. Pasting it under the popup's Advanced section is the
// fallback when the host is not installed.
//
// MV3 lifecycle notes
// - The session lives only in worker memory on purpose. If Chrome restarts the worker, the authority the user
//   granted by clicking the popup is gone; the new worker's `hello` carries session:null and the daemon pauses
//   the old lease. The user must select the tab again.
// - Transport is a WebSocket to ws://127.0.0.1:<port>/ext/ws (protocol v3), authenticated with the subprotocols
//   ['fai-browser.v3', 'fai-auth.<secret>']. The worker connects whenever it is paired and stays connected
//   between runs. It pings every 20 s; on Chrome 116+ WebSocket traffic keeps the worker alive. Reconnects back
//   off 0.5, 1, 2, 4, 8, then 15 s (±20 %), and a 30 s alarm reconnects a worker that Chrome restarted.
// - After 3 consecutive WebSocket failures before open, while HTTP POST /hello works, the worker falls back to
//   the HTTP long-poll (POST /commands?wait=25000) for 5 minutes, then tries the WebSocket again. In that mode a
//   cheap chrome.storage.session.get() every 20 s keeps the worker alive.
// - The port comes from the saved FAI service address. The shipped manifest grants HTTP host access only to
//   127.0.0.1:4318; the WebSocket needs no host permission, and test harnesses use their own manifest.

const PROTOCOL_VERSION = 3;
const WS_PROTOCOL = 'fai-browser.v3';
const AUTH_PROTOCOL_PREFIX = 'fai-auth.';
const PING_MS = 20_000;
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
const FALLBACK_AFTER_FAILURES = 3;
const FALLBACK_WINDOW_MS = 5 * 60_000;
const REPLY_TIMEOUT_MS = 10_000;
const CONNECT_WAIT_MS = 2_500;
const LONG_POLL_MS = 25_000;
const POLL_RETRIES = 3;
const RECONNECT_ALARM = 'fai-reconnect';
// The native messaging host (src/native.js NATIVE_HOST_NAME) and how often an unreachable service re-asks it.
const NATIVE_HOST = 'fai_browser';
const NATIVE_RETRY_MS = 30_000;
const MIN_SECRET_LENGTH = 24;
// captureVisibleTab is quota-limited to two calls per second.
const CAPTURE_SPACING_MS = 500;
// Settle policy (see docs/design/PROPOSAL.md 3.3). A navigation may start up to NAV_START_WINDOW_MS after the click (slow
// servers, click handlers that navigate late); the wait ends as soon as the tab is loading or its URL changed,
// re-checking the tab every NAV_POLL_MS in case an onUpdated event is late.
const NAV_START_WINDOW_MS = 2_000;
const NAV_POLL_MS = 50;
// How long an opened start URL may take to load before its tab is armed (see openAndArm).
const OPEN_LOAD_MS = 15_000;
const NAV_CAP_MS = 3_000;
// Once a load has started late, it still gets at least this long to complete.
const NAV_MIN_LOAD_MS = 1_000;
// executeScript failures that mean the document went away under the call (a navigation tore it down).
const TEARDOWN = /Page returned no result|message port closed|Receiving end does not exist|frame (with id \d+ )?was removed|No frame with id|No document with id|document was unloaded|Frame was removed/i;
// executeScript failures that mean the tab shows Chrome's own error page (chrome-error://chromewebdata/: an HTTP error
// sent without a page body, or a network failure) while tab.url keeps the URL it tried. Chromium 156 says "Frame with ID
// 0 is showing error page"; other versions name the error page's URL ("Cannot access contents of url
// "chrome-error://chromewebdata/""). Neither is an origin change. Anchored at the start of Chrome's own wording, so
// page-controlled text (a URL with "chrome-error://" in its query, quoted in some other error) never matches: Chrome
// percent-encodes a URL's quotes and spaces, so `url "chrome-error://` can only be Chrome naming the page itself.
const BROWSER_ERROR_PAGE = /^(?:Frame with ID \d+ is showing error page|Cannot access contents of url "chrome-error:\/\/)/i;
const BROWSER_ERROR_MESSAGE = 'The browser shows its own error page here (the server sent an HTTP error without a page, '
  + 'or the site could not be reached); nothing on it can be used. Reload it or open another approved URL later.';
const MAX_TERMS = 30;
const SETTLE_AFTER_NAVIGATION = { quietMs: 100, capMs: 1_500 };
const SETTLE_IN_PLACE = { quietMs: 50, capMs: 300 };
const WAIT_ACTION_MS = 500;

// dismiss_overlay: the runtime's Escape or backdrop click on a nag overlay page.js itself detected (no target).
// fill_secret / copy_secret: a secret handle's value into one field, or onto the clipboard, each approved by the user.
// press / hover: a key (src/runtime.js pressKey) and a pointer rest, both from reversible (page.js checks); history:
// back, forward or reload of the leased tab (same-origin entries only where the page can tell); switch_tab: another tab
// of this lease (a popup or new tab it followed); dialog: a JavaScript dialog's answer (Test site, the main-world hook).
const ACTION_TYPES = new Set(['click', 'fill_supplied_text', 'select', 'scroll', 'navigate_allowed_url', 'wait', 'dismiss_overlay',
  'submit_field', 'fill_secret', 'copy_secret', 'press', 'hover', 'history', 'switch_tab', 'open_tab', 'dialog', 'upload']);
const HISTORY_MOVES = new Set(['back', 'forward', 'reload']);
// Errors that mean the grant no longer covers what the user selected; they end the session.
// Everything else (stale, target_unavailable, cross_origin, blocked_risky, a blocked child-tab link, ...) is
// reported for that command only and the session stays active.
const SESSION_ENDING_ERRORS = new Set(['tab_changed', 'origin_changed']);
const KNOWN_CODES = new Set([
  'stale', 'target_unavailable', 'blocked_risky', 'cross_origin', 'child_tab', 'tab_changed', 'origin_changed',
  'session_inactive', 'capture_failed', 'timeout', 'unsupported', 'disconnected', 'paused', 'stopped',
  // Point clicks (locate): nothing clickable at the point, a point outside the viewport, a frame page.js cannot read.
  'no_control', 'point_outside', 'point_frame',
  // The page stopped answering while a JavaScript dialog (alert, confirm, prompt) is most likely open (callPage).
  'js_dialog',
]);
const RECOVERABLE = new Set(['stale', 'target_unavailable', 'capture_failed']);
// Message types that get exactly one reply, and their HTTP fallback paths.
const REPLY_TYPES = new Set(['hello', 'lease', 'lease_level', 'deny', 'validate', 'settings', 'driver']);
const HTTP_PATHS = {
  hello: '/hello',
  lease: '/lease',
  lease_level: '/lease-level',
  settings: '/settings',
  driver: '/driver',
  deny: '/deny',
  status: '/status',
  validate: '/validate',
  result: '/results',
  screenshot: '/screenshots',
};
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Permission levels (configurable-guardrails.md §3.1), lowest first, and the capabilities each grants. Identical to
// extension/permissions.js (drift check in test/extension-permissions.test.js); the worker cannot import it.
const LEVELS = ['read-only', 'reversible', 'interactive', 'full', 'testing'];
const CAPABILITIES = {
  'read-only': ['navigate'],
  reversible: ['navigate', 'controls'],
  interactive: ['navigate', 'controls', 'submit_safe'],
  full: ['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept'],
  testing: ['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept', 'sign_in', 'purchase'],
};

// The Public Suffix List (generated by scripts/update-psl.mjs). A classic service worker: importScripts runs once at
// start; without it (a test harness) FAI_PSL_RULES is absent and every domain root fails closed (exact origins only).
if (typeof importScripts === 'function') importScripts('psl-data.js');
// Trusted input (opt-in, chrome.debugger; off without the trusted-input build's permission): trusted-input.js.
if (typeof importScripts === 'function') importScripts('trusted-input.js');
const PSL_RULES = globalThis.FAI_PSL_RULES ?? '';

// <site-match> Identical in src/origins.js, extension/permissions.js and extension/background.js (drift check in
// test/origins.test.js). Plain declarations only: the worker loads it as a classic script under the test harness.

// The Public Suffix List (ICANN and PRIVATE sections, wildcard and exception rules), vendored and generated by
// scripts/update-psl.mjs: PSL_RULES is defined just above this block in each file (src/psl-data.js here,
// extension/psl-data.js in the extension). Parsed once, on first use.
let SITE_PSL = null;
let SITE_PSL_PARENTS = null;
function pslRules() {
  if (!SITE_PSL) SITE_PSL = new Set(String(PSL_RULES || '').split('\n').filter(Boolean));
  return SITE_PSL;
}

// Every name with a public suffix strictly below it (amazonaws.com above s3.amazonaws.com, kawasaki.jp above the
// wildcard *.kawasaki.jp, r.appspot.com above *.r.appspot.com): a root there would span several owners.
function pslParents() {
  if (!SITE_PSL_PARENTS) {
    SITE_PSL_PARENTS = new Set();
    for (const rule of pslRules()) {
      const labels = rule.replace(/^[!]/, '').split('.');
      const own = rule.startsWith('*.') ? 1 : 0;
      for (let i = own + 1; i < labels.length; i++) SITE_PSL_PARENTS.add(labels.slice(i).join('.'));
      if (own) SITE_PSL_PARENTS.add(labels.slice(1).join('.'));
    }
  }
  return SITE_PSL_PARENTS;
}

// Fail-closed overlay for multi-tenant domains the list does not (fully) cover: no root at or under them, so a page
// there is only ever approved by its exact origin and never suggested as a root. `SITE_SHARED_LABELS`: a registrable
// domain whose first label is one of these (blogspot.de, blogspot.co.uk, ...).
const SITE_SHARED = new Set(['amazonaws.com', 'on.aws', 'azure.com', 'windows.net', 'azurecontainerapps.io',
  'github.dev', 'gitpod.io', 'googleusercontent.com', 'wordpress.com', 'glitch.me', 'firebaseio.com', 'neocities.org',
  'loca.lt', 'stackblitz.io', 'sourceforge.io', 'tumblr.com', 'substack.com', 'weebly.com', '000webhostapp.com',
  'codesandbox.io']);
const SITE_SHARED_LABELS = new Set(['blogspot']);

/**
 * The number of labels of `labels`' public suffix under the list's rules (the longest matching rule, an exception rule
 * winning; "*" by default), or 0 when the top-level label is not in the list at all (localhost, test, example, ...).
 */
function publicSuffixLength(labels) {
  const rules = pslRules();
  const n = labels.length;
  if (!rules.has(labels[n - 1]) && !rules.has(`*.${labels[n - 1]}`)) return 0;
  let best = 1;
  for (let i = n - 1; i >= 0; i--) {
    const name = labels.slice(i).join('.');
    if (rules.has(`!${name}`)) return n - i - 1;
    if (rules.has(name)) best = Math.max(best, n - i);
    if (i < n - 1 && rules.has(`*.${labels.slice(i + 1).join('.')}`)) best = Math.max(best, n - i);
  }
  return best;
}

/**
 * True for a host that can never be a domain root: a public suffix (or a name inside one, such as a wildcard rule's
 * label), a host under an unknown top-level label, or a shared hosting domain of the overlay.
 */
function isSiteSuffix(host) {
  const labels = host.split('.');
  const suffix = publicSuffixLength(labels);
  if (suffix === 0 || labels.length <= suffix || pslParents().has(host)) return true;
  for (const shared of SITE_SHARED) if (host === shared || host.endsWith(`.${shared}`)) return true;
  return SITE_SHARED_LABELS.has(labels[labels.length - suffix - 1]);
}

/**
 * The root of a domain-root entry "https://*.<root>": a lower-case ASCII (punycode) DNS name of at least two labels
 * ending in a letter label (no IP address), not a public suffix. Null for anything else, an exact origin included.
 */
function siteRoot(entry) {
  if (typeof entry !== 'string' || entry.length > 262) return null;
  const match = /^https:\/\/\*\.((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)$/.exec(entry);
  if (!match || match[1].length > 253 || isSiteSuffix(match[1])) return null;
  return match[1];
}

/** True when `host` is `root` itself or a subdomain of it. */
function hostInSite(host, root) {
  return typeof host === 'string' && (host === root || (host.length > root.length && host.endsWith(`.${root}`)));
}

/** The host of a default-port https origin ("https://docs.example.com"), else null. */
function siteHost(origin) {
  const match = typeof origin === 'string' ? /^https:\/\/([a-z0-9.-]+)$/.exec(origin) : null;
  return match && !match[1].endsWith('.') ? match[1] : null;
}

/**
 * True when `origin` (a tab's or page's origin, as URL.origin writes it) is covered by `entries`: equal to an exact
 * entry, or an https origin on the default port whose host is a domain root or one of its subdomains.
 */
function originCovered(origin, entries) {
  if (typeof origin !== 'string' || origin.includes('*') || !Array.isArray(entries)) return false;
  if (entries.includes(origin)) return true;
  const host = siteHost(origin);
  return Boolean(host) && entries.some(entry => {
    const root = siteRoot(entry);
    return root !== null && hostInSite(host, root);
  });
}

/** The Chrome host permission pattern for a domain root: "https://*.<root>/*" (the root and every subdomain). */
function sitePattern(root) {
  return `https://*.${root}/*`;
}
// </site-match>

// <secret-rules> Identical in src/secrets.js, extension/background.js and extension/page.js (there indented two
// spaces inside its closure); drift check in test/secrets.test.js. Plain declarations only, every name starting with
// SECRET_ or secret: the worker loads it as a classic script and the page script inside its closure.
//
// Known formats, always on (every level, testing included, and on Relaxed origins): [kind, pattern, check?]. Group
// `pre` is the public prefix a placeholder keeps; group `lead` is text before the secret that stays (a parameter
// name, a connection string's user); the rest of the match is the secret. Without a check, the part after the prefix
// must mix letters and digits and not be words joined by dashes (secretFormatBody).
const SECRET_FORMATS = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[A-Za-z0-9+/=\s:,.-]*)/g, () => true],
  ['anthropic', /(?<![\w-])(?<pre>sk-ant-(?:[a-z]+\d*-)?)[\w-]{20,}/g],
  ['openai', /(?<![\w-])(?<pre>sk-(?:proj-|svcacct-|admin-|None-)?)(?!ant-)[\w-]{20,}/g],
  ['github', /(?<![\w-])(?<pre>gh[pousr]_)[A-Za-z0-9]{30,}/g],
  ['github', /(?<![\w-])(?<pre>github_pat_)\w{40,}/g],
  ['slack', /(?<![\w-])(?<pre>xox[abposr]-)[A-Za-z0-9-]{10,}/g],
  ['slack-webhook', /(?<pre>https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9_/-]{20,}/g],
  ['discord-webhook', /(?<pre>https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/)\d+\/[\w-]{30,}/g],
  ['aws', /(?<![A-Za-z0-9])(?<pre>AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g],
  ['aws-secret', /(?<=(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}[\s,;:|"'=]{1,6})[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g],
  ['google', /(?<![\w-])(?<pre>AIza)[\w-]{35}(?![\w-])/g],
  ['google-oauth', /(?<![\w-])(?<pre>ya29\.)[\w-]{20,}/g],
  ['google-oauth', /(?<![\w-])(?<pre>GOCSPX-)[\w-]{20,}/g],
  ['gitlab', /(?<![\w-])(?<pre>gl(?:pat|ptt)-)[\w-]{20,}/g],
  ['stripe', /(?<![\w-])(?<pre>(?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{16,}/g],
  ['stripe-webhook', /(?<![\w-])(?<pre>whsec_)[A-Za-z0-9+/=]{20,}/g],
  ['npm', /(?<![\w-])(?<pre>npm_)[A-Za-z0-9]{36,}/g],
  ['pypi', /(?<![\w-])(?<pre>pypi-AgEI)[\w-]{50,}/g],
  ['huggingface', /(?<![\w-])(?<pre>hf_)[A-Za-z0-9]{30,}/g],
  ['groq', /(?<![\w-])(?<pre>gsk_)[A-Za-z0-9]{40,}/g],
  ['xai', /(?<![\w-])(?<pre>xai-)[A-Za-z0-9]{40,}/g],
  ['replicate', /(?<![\w-])(?<pre>r8_)[A-Za-z0-9]{30,}/g],
  ['sendgrid', /(?<![\w-])(?<pre>SG\.)[\w-]{16,}\.[\w-]{16,}/g],
  ['digitalocean', /(?<![\w-])(?<pre>do[por]_v1_)[a-f0-9]{64}/g],
  ['shopify', /(?<![\w-])(?<pre>shp(?:at|ss|ca|pa)_)[a-fA-F0-9]{32}/g],
  ['linear', /(?<![\w-])(?<pre>lin_api_)[A-Za-z0-9]{40}/g],
  ['postman', /(?<![\w-])(?<pre>PMAK-)[a-f0-9]{24}-[a-f0-9]{34}/g],
  ['supabase', /(?<![\w-])(?<pre>sbp_)[a-f0-9]{40}/g],
  ['atlassian', /(?<![\w-])(?<pre>ATATT)[\w=-]{50,}/g],
  ['jwt', /(?<![\w-])(?<pre>eyJ)[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{10,}/g],
  // A signed or secret URL parameter (query or fragment): the value goes, the origin, path and name stay.
  ['url-param', /(?<lead>[?&#;](?:[\w.-]*[_.-])?(?:token|key|secret|sig|signature|code|auth|session|sessionid|password|passwd|pwd|apikey|credential)=)(?!\[secret:)[^&#\s"'<>\]]{6,}/gi, () => true],
  // A connection string's password: scheme://user:PASSWORD@host.
  ['password', /(?<lead>(?<![\w+.-])[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@?#[\]]{1,100}:)(?!\[secret:)[^\s@/?#[\]]{1,200}(?=@)/gi, value => !/^(?:\*+|x+|•+)$/i.test(value)],
  ['card', /(?<![\w-])(?:\d[ -]?){12,18}\d(?![\d-])/g, value => secretCard(value)],
];
// Generic and context rules (Standard and Strict; off on Relaxed origins). A candidate is a run of 20 or more key
// characters; it counts only next to a word that says key, token, secret, password, bearer, credential or recovery
// code (in the 60 characters before it or in the label the caller passes), or anywhere on a secret page or in Strict.
const SECRET_CANDIDATE = /(?<![\w+/-])[\w+/-]{20,}={0,2}(?![\w+/=-])/g;
const SECRET_CONTEXT = /(?<![A-Za-z])(?:api[\s_-]?keys?|keys?|tokens?|secrets?|passwords?|passwd|passphrase|passcode|bearer|credentials?|auth(?:orization)?|recovery[\s_-]?codes?|backup[\s_-]?codes?)(?![A-Za-z])/i;
const SECRET_CONTEXT_CHARS = 60;
// A base32 TOTP seed ("JBSW Y3DP EHPK 3PXP") next to setup key / authenticator wording.
const SECRET_TOTP = /(?<![A-Za-z0-9])(?:[A-Za-z2-7]{4}[ -]?){3,15}[A-Za-z2-7]{4}(?![A-Za-z0-9])/g;
const SECRET_TOTP_CONTEXT = /(?<![A-Za-z])(?:setup[\s_-]?key|secret[\s_-]?key|authenticator|two[\s-]?factor|2fa|mfa|totp|otp)(?![A-Za-z])/i;
const SECRET_TOTP_CHARS = 160;
// Recovery and backup codes in the list under such a heading.
const SECRET_RECOVERY = /(?<![A-Za-z0-9-])(?:[A-Za-z0-9]{4,6}-[A-Za-z0-9]{4,6}|\d{4}[ -]\d{4}|[A-Za-z0-9]{8,16})(?![A-Za-z0-9-])/g;
const SECRET_RECOVERY_CONTEXT = /(?<![A-Za-z])(?:recovery|backup)[\s_-]?(?:codes?|keys?)(?![A-Za-z])/i;
const SECRET_RECOVERY_CHARS = 400;
// An environment variable row: an UPPER_SNAKE name that says key, token, secret, password or DSN (or DATABASE_URL),
// then its value.
const SECRET_ENV = /(?<lead>(?<![A-Za-z0-9_])(?<name>[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?![A-Za-z0-9_])["']?[ \t]*(?:[=:|\t\n][ \t]*|[ \t]+)["']?)(?!\[secret:)[^\s"'|,;]{6,}/g;
const SECRET_ENV_NAME = /(?:^|_)[A-Z0-9]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|DSN|PRIVATE|CREDENTIALS?)[A-Z0-9]*(?:_|$)|^DATABASE_URL$/;
// "Password: X" (a temporary password, a generated one).
const SECRET_PASSWORD_LABEL = /(?<lead>(?<![A-Za-z])(?:password|passwd|passphrase|passcode|pwd)(?![A-Za-z])\s*(?:is\s+)?[:=]\s*["']?)(?!\[secret:)[^\s"'<>]{6,64}/gi;
// Pages that exist to show credentials: their paths and their top headings. There the generic rule needs no context.
const SECRET_PAGE_PATH = /\/(?:api[-_]?keys|credentials|security|2fa|mfa|totp|recovery(?:[-_]codes)?|personal[-_]access[-_]tokens|access[-_]tokens|service[-_]?accounts|webhooks|secrets)(?=\/|$)|\/settings\/(?:[^/]+\/)*tokens(?=\/|$)/i;
const SECRET_PAGE_HEADING = /(?<![A-Za-z])(?:api[\s-]keys?|access[\s-]tokens?|personal access tokens?|environment variables|recovery codes|backup codes|secret keys?|signing secrets?|credentials|two-factor authentication|authenticator app)(?![A-Za-z])/i;
// Kinds whose placeholder names only the kind; the generic kind names nothing.
const SECRET_BARE = new Set(['password', 'private-key', 'totp', 'recovery-code', 'url-param']);
// Every rule needs one of these (a digit in the value, a private-key header, a parameter, a URL password, a label's
// colon, an UPPER_SNAKE name): text without any is skipped at once.
const SECRET_HINT = /\d|PRIVATE KEY|[=:@_]/;

function secretLuhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** A payment card number: 13-19 digits, a card network's prefix, card grouping (or none) and a valid Luhn digit. */
function secretCard(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  if (!/^(?:4|5[1-5]|2[2-7]|3[47]|3[0689]|35|6(?:011|5|4[4-9]|2))/.test(digits)) return false;
  const groups = value.split(/[ -]/).map(group => group.length);
  if (groups.length > 1) {
    const fours = groups.slice(0, -1).every(length => length === 4) && groups.at(-1) <= 4;
    const amex = groups.length === 3 && groups[0] === 4 && groups[1] === 6 && groups[2] >= 4 && groups[2] <= 5;
    if (!fours && !amex) return false;
  }
  return secretLuhn(digits);
}

/** Shannon entropy in bits per character. */
function secretEntropy(token) {
  const counts = new Map();
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / token.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * A generic key-shaped token: letters and digits mixed, at least 3.5 bits per character, not a path ("/a/b/c", or
 * "8080/qa/i18n/page": slashes between short segments) and not words and numbers joined by dashes
 * ("screenshot-2024-01-01-at-10").
 */
function secretKeyShaped(token) {
  const bare = token.replace(/=+$/, '');
  if (bare.length < 20 || !/[A-Za-z]/.test(bare) || !/\d/.test(bare)) return false;
  if (/^\/|\/\/|\/$|(?:^|\/)[a-z]{3,}(?:[-_][a-z]+)*\//.test(bare)) return false;
  if (bare.includes('/') && bare.split('/').every(segment => segment.length < 12)) return false;
  const parts = bare.split(/[-_./+]+/).filter(Boolean);
  if (parts.length >= 2 && parts.every(part => /^[A-Za-z]+$/.test(part) || /^\d+$/.test(part))) return false;
  return secretEntropy(bare) >= 3.5;
}

/** The default format check: the part after the public prefix mixes letters and digits and is not dashed words. */
function secretFormatBody(value, match) {
  const body = value.slice((match.groups?.pre ?? '').length);
  if (!/[A-Za-z]/.test(body) || !/\d/.test(body)) return false;
  const parts = body.split(/[-_.]+/).filter(Boolean);
  return !(parts.length >= 3 && parts.every(part => /^[A-Za-z]+$/.test(part) || /^\d+$/.test(part)));
}

/** Whether a page is a credentials page: its path, or one of its top headings. */
function secretPageSignal(path, headings = []) {
  if (typeof path === 'string' && SECRET_PAGE_PATH.test(path)) return true;
  return headings.some(text => typeof text === 'string' && text.length <= 120 && SECRET_PAGE_HEADING.test(text));
}

/**
 * The secrets in `text`: [{start, end, kind, pre}] in order, never overlapping. `options.strict` applies the generic
 * rule without context (Strict, or a secret page); `options.relaxed` keeps the known formats only; `options.context`
 * is extra label text that counts as context (a column header, a field label).
 */
function secretFind(text, options = {}) {
  const spans = [];
  if (typeof text !== 'string' || text.length < 6 || !SECRET_HINT.test(text)) return spans;
  const push = (match, kind, check) => {
    const lead = match.groups?.lead ?? '';
    const value = match[0].slice(lead.length).replace(/\s+$/, '');
    if (!value || (check && !check(value, match))) return;
    const start = match.index + lead.length;
    spans.push({ start, end: start + value.length, kind, pre: match.groups?.pre ?? '' });
  };
  for (const [kind, pattern, check] of SECRET_FORMATS) {
    for (const match of text.matchAll(pattern)) push(match, kind, check ?? secretFormatBody);
  }
  if (!options.relaxed) {
    const extra = typeof options.context === 'string' ? options.context.slice(-200) : '';
    const before = (index, chars) => `${extra} ${text.slice(Math.max(0, index - chars), index)}`;
    for (const match of text.matchAll(SECRET_CANDIDATE)) {
      if (!secretKeyShaped(match[0])) continue;
      if (options.strict || SECRET_CONTEXT.test(before(match.index, SECRET_CONTEXT_CHARS))) push(match, 'generic');
    }
    for (const match of text.matchAll(SECRET_TOTP)) {
      const bare = match[0].replace(/[ -]/g, '');
      if (bare.length < 16 || !/[2-7]/.test(bare) || (bare !== bare.toUpperCase() && bare !== bare.toLowerCase())) continue;
      if (SECRET_TOTP_CONTEXT.test(before(match.index, SECRET_TOTP_CHARS))) push(match, 'totp');
    }
    if (SECRET_RECOVERY_CONTEXT.test(`${extra} ${text}`)) {
      for (const match of text.matchAll(SECRET_RECOVERY)) {
        if (!/\d/.test(match[0]) || (/^[A-Za-z0-9]+$/.test(match[0]) && !/[A-Za-z]/.test(match[0]) && match[0].length !== 8)) continue;
        if (SECRET_RECOVERY_CONTEXT.test(before(match.index, SECRET_RECOVERY_CHARS))) push(match, 'recovery-code');
      }
    }
    for (const match of text.matchAll(SECRET_ENV)) {
      const value = match[0].slice(match.groups.lead.length);
      if (!SECRET_ENV_NAME.test(match.groups.name) || /^[•*●·.x]+$/i.test(value)) continue;
      if (/[\d:/@.+=_-]/.test(value)) push(match, 'generic');
    }
    for (const match of text.matchAll(SECRET_PASSWORD_LABEL)) {
      const value = match[0].slice(match.groups.lead.length);
      if (/^[•*●·.x]+$/i.test(value) || !(/[\d\W_]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value)))) continue;
      push(match, 'password');
    }
  }
  // Nothing inside a placeholder an earlier pass wrote (its tag or kind words) is a secret: redaction is idempotent.
  const placed = text.includes('[secret:') ? [...text.matchAll(/\[secret:[^\]]*\]/g)].map(m => [m.index, m.index + m[0].length]) : [];
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const span of spans) {
    if (placed.some(([start, end]) => span.start < end && span.end > start)) continue;
    const last = kept.at(-1);
    if (last && span.start < last.end) {
      // Overlap: the longer span wins; on a tie the earlier rule (a known format before the generic one).
      if (span.end - span.start > last.end - last.start) kept[kept.length - 1] = span;
      continue;
    }
    kept.push(span);
  }
  return kept;
}

/** A 53-bit string hash (cyrb53), base 36. Salted, it tags a value without revealing it. */
function secretHash(value, salt = '') {
  const text = `${salt}\u0000${value}`;
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The placeholder for one secret value; `id` is its number (or `~<hash>` before the worker numbers it). */
function secretPlaceholder(id, kind, value, pre = '') {
  if (kind === 'generic') return `[secret:${id}]`;
  if (SECRET_BARE.has(kind)) return `[secret:${id} ${kind === 'url-param' ? 'param' : kind}]`;
  const body = kind === 'card' ? value.replace(/\D/g, '') : value;
  const tail = body.length - pre.length >= 16 || kind === 'card' ? body.slice(-4) : '';
  return `[secret:${id} ${kind} ${pre}…${tail} len ${body.length}]`;
}

/**
 * `text` with every secret replaced by its placeholder. `options` as secretFind, plus `id(value)` (the number a
 * value gets; default: `~` and its hash salted with `options.salt`).
 */
function secretRedactText(text, options = {}) {
  const spans = secretFind(text, options);
  if (!spans.length) return text;
  const idOf = typeof options.id === 'function' ? options.id : value => `~${secretHash(value, options.salt ?? '')}`;
  let out = '';
  let at = 0;
  for (const span of spans) {
    const value = text.slice(span.start, span.end);
    out += text.slice(at, span.start) + secretPlaceholder(idOf(value), span.kind, value, span.pre);
    at = span.end;
  }
  return out + text.slice(at);
}

/** A URL with its secrets redacted (known formats, signed parameters, a password): origin and path stay as they are. */
function secretRedactUrl(url, options = {}) {
  return secretRedactText(url, { ...options, relaxed: true, strict: false });
}
// </secret-rules>

// Domain roots the user approved keep Chrome's host permission https://*.<root>/* (requested by the popup inside the
// Approve click) only while their session lives (active or paused). It is removed when the session ends, unless the user
// turned on "Remember domain approvals" (chrome.storage.local.domainMemory) and the session was Read-only or Reversible:
// then it is kept for REMEMBER_MS (chrome.storage.local.rememberedSites, never extended). reconcileSites() enforces this
// on every session end, worker start, settings change and reconnect alarm; it only ever touches https://*.<root>/*
// patterns, never the manifest's required service permission.
const REMEMBER_MS = 24 * 60 * 60_000;
const REMEMBER_LEVELS = ['read-only', 'reversible'];
const MAX_REMEMBERED_SITES = 50;
const SITE_PERMISSION = /^https:\/\/\*\.[a-z0-9.-]+\/\*$/;
/** A host permission pattern this extension may request, track and remove: a domain root's only. */
function managedPattern(pattern) {
  return typeof pattern === 'string' && (SITE_PERMISSION.test(pattern) || /^https?:\/\/[^/*]+\/\*$/.test(pattern));
}

// Where "Open <host>" opens a request: its `url` when http(s) on one of its origins, else the first exact origin
// plus "/". Never taken from the popup; same rule as startTarget in permissions.js.
function requestTarget(request) {
  const origins = Array.isArray(request?.origins) ? request.origins.filter(entry => typeof entry === 'string') : [];
  let url = null;
  if (typeof request?.url === 'string' && /^https?:\/\//i.test(request.url)) {
    try {
      const parsed = new URL(request.url);
      if (!parsed.username && !parsed.password && originCovered(parsed.origin, origins)) url = parsed.href;
    } catch {
      // Not a URL: fall back to the first exact origin.
    }
  }
  if (!url) {
    const first = origins.find(entry => !entry.includes('*') && originOf(entry) === entry);
    if (first) url = `${first}/`;
  }
  if (!url) return null;
  const { origin, host } = new URL(url);
  return { url, origin, host };
}

// {requestId, leaseId, tabId, origin, origins, level, status, scope, sites, patterns}: `level` is what the user approved
// in the popup; `origin` is the tab's current origin; `scope` is 'domain' when the user approved the request's domain
// roots and Chrome granted their host permission (`sites`: those root entries, `patterns`: their permission patterns).
let session = null;
// Host permission patterns a start in progress is about to use (reconcileSites keeps them).
let pendingPatterns = [];
// When each https://*.<root>/* permission was granted (chrome.permissions.onAdded): the popup requests it in the Approve
// click and only then sends `start`, so a reconcile in between must not take it away. Kept for RECENT_GRANT_MS.
const recentGrants = new Map();
const RECENT_GRANT_MS = 60_000;
// "Open <host>" with "All of <root>" in progress: the popup's intent, sent before Chrome's prompt, which can close the
// popup before its own `open` is sent. { requestId, level, patterns, at, running }; see openFromIntent.
let openIntent = null;
const OPEN_INTENT_MS = 60_000;
// The user's testing environments (chrome.storage.local.permissions.testingOrigins), kept current from storage.
let testingOrigins = [];
// The user's per-request call budget (chrome.storage.local.budget {maxCalls, maxMs}; null: not set), reported to the
// daemon in the hello and in a `settings` message on every change, and the budget the daemon says is in effect
// ({maxCalls, maxMs, source}), shown by the popup.
let budget = null;
let budgetLoaded = false;
let effectiveBudget = null;
let driverControl = null; // Daemon-owned choice; never replayed from extension storage.
// "Open requested pages right away" (chrome.storage.local.openRightAway): on unless the user turned it off (an absent
// value is on). Reported with the budget, so the daemon can tell the agent whether the page opened by itself.
let openRightAway = true;
let tabMode = 'single';
const cleanTabMode = value => value === 'multiple' ? 'multiple' : 'single';
// Browser match patterns omit ports; runtime origin checks still require the exact approved origin.
function taskOriginPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}
// {endpoint, secret}: the saved FAI service address and pairing secret.
let pairing = null;
let socket = null;
let socketOpen = false;
let wsFailures = 0;
let backoffIndex = 0;
let reconnectTimer = null;
let fallbackUntil = 0;
let longPolling = false;
let pollController = null;
// Set once a hello was answered on the current transport.
let connected = false;
let transportName = 'none';
// The last native pairing outcome for the popup: 'paired', 'missing' (host not installed), 'error' or null (not tried).
let nativeState = null;
let nativeAt = 0;
let nativePairing = null;
let requests = [];
let refSequence = 0;
const replies = new Map();
const cancelled = new Set();
// Resolved whenever a connection attempt settles (hello answered, or the attempt failed).
let attemptWaiters = [];
let lastCapture = 0;
// Resolves once the most recent capture has taken its frame. An execute waits on it so an action can never
// change the page between a capture's revision check and captureVisibleTab().
let captureGate = Promise.resolve();
let creatingOffscreen = null;
// Values this worker filled as secrets (a fill the host marked sensitive, or one into a password input), most recent
// last. Screenshot annotations never carry them: not the action's text, and not a page label that echoes them.
const sensitiveTexts = new Set();
const SENSITIVE_MAX = 20;
const SENSITIVE_MIN_LENGTH = 3;
// Secret redaction (src/secrets.js): the user's setting (chrome.storage.local.secretRedaction {mode: 'standard' |
// 'strict', relaxed: [origins]}; never config.json, which an agent with a shell could edit). page.js receives it with
// every call and scrubs what it returns; this worker numbers the page's `~<hash>` tags per session.
let secretRedaction = { mode: 'standard', relaxed: [] };
// Secret handles (docs/REFERENCE.md "Secret handles"): the salt page.js tags values with, the session number of each
// tag (1, 2, 3 ...) and the vault: number -> { value, kind, pre, origin, at } for values page.js redacted from page text
// or a read-only field (never a card number or a URL parameter). Values never leave this worker except into the one
// field, or onto the clipboard, the user approves each time (fill_secret, copy_secret). Memory only, never storage: a
// restarted worker has no session to use them in. A session that takes over from a live one (the agent's next approved
// request) keeps the vault, so a key read on one site can be pasted on another; stopping (the user, a release, an
// expiry) clears it, and an entry lapses VAULT_TTL_MS after it was last seen.
const VAULT_KEY = '__faiVault';
const VAULT_MAX = 50;
const VAULT_TTL_MS = 30 * 60_000;
let secretVault = newVault();
function newVault() {
  return { salt: newSecretSalt(), ids: new Map(), entries: new Map() };
}
function newSecretSalt() {
  return globalThis.crypto?.randomUUID?.() ?? `${Math.random()}:${Date.now()}`;
}

class ExtensionError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ignore = promise => promise?.catch?.(() => {});

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// The saved FAI service address must be plain http on 127.0.0.1; the pairing secret is only ever sent there.
function serviceEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('The FAI service address must be on http://127.0.0.1');
  }
  return url.origin;
}

function validPairing(endpoint, secret) {
  if (typeof secret !== 'string' || !secret) return null;
  try {
    return { endpoint: serviceEndpoint(endpoint), secret };
  } catch {
    return null;
  }
}

// --- state published to the popup ----------------------------------------------------------------------------

function storeSession(values) {
  try {
    ignore(chrome.storage.session?.set?.(values));
  } catch {
    // storage.session is unavailable in some test contexts.
  }
}

function connectionView() {
  return { connected, transport: connected ? transportName : 'none', budget: effectiveBudget, paired: Boolean(pairing),
    native: nativeState, ...(driverControl ? { control: driverControl } : {}) };
}

function cleanDriverControl(value) {
  return value && ['jev', 'agent'].includes(value.driver) && typeof value.jevAvailable === 'boolean'
    ? { driver: value.driver, jevAvailable: value.jevAvailable } : null;
}

async function readDriver() {
  const data = await send('driver');
  driverControl = cleanDriverControl(data?.control);
  publishConnection();
}

function publishConnection() {
  storeSession({ connection: connectionView() });
  updateBadge();
}

function setRequests(list) {
  requests = Array.isArray(list) ? list.filter(item => item && typeof item.requestId === 'string') : [];
  storeSession({ requests });
  updateBadge();
  ignore(expireArms(true));
  promptChain = promptChain.then(showApproval).catch(() => {});
}

// The approval UI opens in the real toolbar popup when the browser permits it. Chrome before 127 has no openPopup;
// Firefox before 149 rejects it without a user gesture. Their fallback is the same popup page in a small window near
// the last-focused browser window's toolbar, never a centered dialog. Requests already shown are kept in
// storage.session, so a worker restart does not show them again. Off under Permissions (approvalWindow: false).
const APPROVAL_PAGE = 'popup.html?window=1';
const APPROVAL_SIZE = { width: 420, height: 620 };
const POPUP_WINDOW_INSET = { right: 24, top: 90 };
const SHOWN_KEEP = 100;
let promptChain = Promise.resolve();

async function openToolbarPopup() {
  if (typeof chrome.action?.openPopup !== 'function') return false;
  try {
    await chrome.action.openPopup();
    return true;
  } catch {
    return false;
  }
}

async function popupWindowPlacement(size) {
  const parent = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const left = Number.isInteger(parent?.left) ? parent.left : 0;
  const top = Number.isInteger(parent?.top) ? parent.top : 0;
  const width = Number.isInteger(parent?.width) ? parent.width : 1280;
  return {
    left: Math.max(left, left + width - size.width - POPUP_WINDOW_INSET.right),
    top: top + POPUP_WINDOW_INSET.top,
  };
}

async function createPopupWindow(url, size) {
  return chrome.windows.create({ url, type: 'popup', ...size, ...await popupWindowPlacement(size), focused: true });
}

async function showApproval() {
  const stored = (await chrome.storage.session?.get?.(['shownRequests', 'approvalWindowId'])) ?? {};
  const shown = Array.isArray(stored.shownRequests) ? stored.shownRequests : [];
  // A request the live session already serves needs no window.
  const served = session && ['active', 'paused'].includes(session.status) ? session.requestId : null;
  const pending = requests.filter(item => item.state === 'pending').map(item => item.requestId);
  const fresh = pending.filter(id => !shown.includes(id) && id !== served);
  if (!fresh.length) return;
  await chrome.storage.session?.set?.({ shownRequests: [...shown, ...fresh].slice(-SHOWN_KEEP) });
  if (!pairing) return;
  const settings = await chrome.storage.local.get(['approvalWindow', 'openRightAway']);
  // "Open requested pages right away" (on unless turned off): a request with a start URL that asks for Interactive or
  // less skips the window; its page opens armed at the requested level, with a prompt window that says what to do,
  // and the toolbar icon click on it is still the only approval. Full and Testing always get the window, where the
  // user picks the level.
  let left = fresh;
  if (settings.openRightAway !== false) {
    left = [];
    for (const id of fresh) {
      const request = requests.find(item => item.requestId === id);
      // A request the FAI tab already covers gets the window ("Approve on the FAI tab"), not a second page.
      const onFaiTab = served && session.origin && Array.isArray(request?.origins) && originCovered(session.origin, request.origins);
      const level = request ? rightAwayLevel(request) : null;
      if (!request || onFaiTab || !level || !requestTarget(request)) left.push(id);
      else await openAndArm(id, level, false).catch(() => left.push(id));
    }
  }
  if (!left.length || settings.approvalWindow === false) return;
  if (await openToolbarPopup()) return;
  const id = stored.approvalWindowId;
  if (Number.isInteger(id) && await chrome.windows.get(id).then(Boolean, () => false)) {
    await chrome.windows.update(id, { ...await popupWindowPlacement(APPROVAL_SIZE), focused: true });
    return;
  }
  const created = await createPopupWindow(chrome.runtime.getURL(APPROVAL_PAGE), APPROVAL_SIZE);
  await chrome.storage.session?.set?.({ approvalWindowId: created?.id ?? null });
}

// The tab the per-tab badge text was last set on (cleared when the session ends or moves).
let badgeTabId = null;

// On the driven tab only (per-tab text, seen while it is the selected tab): ON while its session is active, Ⅱ while
// paused. Everywhere: ? while a tab request waits for the user, Ⅱ for another paused request, else empty.
function updateBadge() {
  let text = '';
  let title = 'FAI Browser';
  const pendingCount = requests.filter(item => item.state === 'pending').length;
  const live = session && ['active', 'paused'].includes(session.status) ? session : null;
  const tabText = live ? (live.status === 'active' ? 'ON' : 'Ⅱ') : null;
  try {
    if (badgeTabId !== null && badgeTabId !== live?.tabId) {
      // null clears the tab's own text, so it shows the global text again.
      ignore(chrome.action.setBadgeText({ tabId: badgeTabId, text: null }));
    }
    // Kept in storage.session too: per-tab text outlives this worker, so the next one clears it (unmarkLeftover).
    if (badgeTabId !== (live ? live.tabId : null)) ignore(chrome.storage.session?.set?.({ badgeTab: live ? live.tabId : null }));
    badgeTabId = live ? live.tabId : null;
    if (live) {
      ignore(chrome.action.setBadgeText({ tabId: live.tabId, text: tabText }));
    }
  } catch {
    // The action API is unavailable in some test contexts.
  }
  const approving = [...approvals.values()].filter(entry => entry.status === 'pending').length;
  if (approving) {
    text = '!';
    title = `FAI Browser: approve ${approving === 1 ? 'an action' : `${approving} actions`}?`;
  } else if (pendingCount) {
    text = '?';
    title = `FAI Browser: ${pendingCount} tab request${pendingCount === 1 ? '' : 's'} waiting`;
  } else if (requests.some(item => item.state === 'paused' && item.requestId !== live?.requestId)) {
    text = 'Ⅱ';
  } else if (!pairing) {
    title = 'FAI Browser: not paired';
  } else if (!connected) {
    title = 'FAI Browser: daemon not running';
  }
  try {
    ignore(chrome.action.setBadgeText({ text }));
    if (text === '?') ignore(chrome.action.setBadgeBackgroundColor?.({ color: '#a66e20' }));
    if (text === '!') ignore(chrome.action.setBadgeBackgroundColor?.({ color: '#b3261e' }));
    ignore(chrome.action.setTitle?.({ title }));
  } catch {
    // The action API is unavailable in some test contexts.
  }
}

async function setStatus(value, { preserveVault = false } = {}) {
  if (session) session.status = value;
  // A stopped session (the user, a release, an expiry) takes its secret handles with it.
  if (value === 'stopped' && !preserveVault) clearVault();
  // A stopped session is over (a pause can still be resumed): its domain host permissions go now.
  if (value === 'stopped' && session) releaseSites(session);
  // ... and its Test-site hook registration.
  if (value === 'stopped' && session?.devHooks) {
    session.devHooks = false;
    ignore(disarmDevHooks());
  }
  if (session) markTab(session);
  await chrome.storage.local.set({ status: value });
  updateBadge();
}

// --- the driven tab's mark: a tab group titled FAI (FAI ⏸ while paused), nothing in the page ------------------------

const MARK_TITLE = { active: 'FAI', paused: 'FAI ⏸' };
const MARK_COLOR = 'grey';
const NO_GROUP = -1; // chrome.tabGroups.TAB_GROUP_ID_NONE
// Group changes run one at a time, so a stop followed by a new session's start never interleave.
let markChain = Promise.resolve();

// Puts an active or paused session's tab in this extension's group (made once, retitled on pause) and takes it out
// when the session stops. A tab already in a group the user made is left alone (no mark). The group id is kept in
// storage.session so a restarted worker can take back a mark its predecessor left (unmarkLeftover).
function markTab(target) {
  markChain = markChain.then(async () => {
    if (!chrome.tabGroups || !chrome.tabs.group) return;
    const title = MARK_TITLE[target.status];
    const tab = await chrome.tabs.get(target.tabId).catch(() => null);
    if (!tab) return;
    if (!title || session !== target) {
      await unmark(target, tab);
      return;
    }
    if (target.groupId != null && tab.groupId === target.groupId) {
      await chrome.tabGroups.update(target.groupId, { title });
      return;
    }
    if ((tab.groupId ?? NO_GROUP) !== NO_GROUP) return;
    // The tab's own window, named: Firefox otherwise moves the tab into the last focused window (a prompt popup).
    target.groupId = await chrome.tabs.group({ tabIds: [target.tabId], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(target.groupId, { title, color: MARK_COLOR, collapsed: false });
    await chrome.storage.session?.set?.({ markedTab: { tabId: target.tabId, groupId: target.groupId } });
  }).catch(() => {});
}

async function unmark(target, tab) {
  if (target.groupId == null) return;
  const groupId = target.groupId;
  target.groupId = null;
  const ids = [...new Set([tab?.id, ...(target.tabs ?? []).map(entry => entry.tabId)].filter(Number.isInteger))];
  for (const id of ids) {
    const member = await chrome.tabs.get(id).catch(() => null);
    if (member?.groupId === groupId) await chrome.tabs.ungroup([id]);
  }
  await chrome.storage.session?.set?.({ markedTab: null });
}

function unmarkLeftover() {
  markChain = markChain.then(async () => {
    const { markedTab, badgeTab } = (await chrome.storage.session?.get?.(['markedTab', 'badgeTab'])) ?? {};
    if (Number.isInteger(badgeTab) && badgeTab !== badgeTabId) ignore(chrome.action.setBadgeText({ tabId: badgeTab, text: null }));
    if (!Number.isInteger(markedTab?.tabId)) return;
    const tab = await chrome.tabs.get(markedTab.tabId).catch(() => null);
    await unmark({ groupId: markedTab.groupId, tabs: (markedTab.tabIds ?? []).map(tabId => ({ tabId })) }, tab);
  }).catch(() => {});
}

// --- domain roots: session coverage and host permissions ----------------------------------------------------------

/** The approved domain roots page.js may follow links within (empty without domain scope). */
function sessionSites() {
  return session?.scope === 'domain' ? (session.sites ?? []).map(siteRoot).filter(Boolean) : [];
}

// True when the session covers `url`: its current origin, or with domain scope another https page on an approved domain
// root (Chrome's host permission for it is what keeps tab.url and scripting available there; without it tab.url is
// absent and this fails). Moving within the root makes that origin the current one. Else the one consent redirect.
function sessionCovers(url) {
  const next = originOf(url);
  if (!session || !next) return false;
  if (next === session.origin) return true;
  if (session.scope === 'domain' && originCovered(next, session.sites ?? [])) {
    session.origin = next;
    return true;
  }
  return followConsentRedirect(url);
}

// A navigation the session may start: the current origin, or with domain scope a page under a root that also covers
// the current origin.
function sameSessionSite(url) {
  const next = originOf(url);
  if (!session || !next) return false;
  if (next === session.origin) return true;
  const from = siteHost(session.origin);
  const to = siteHost(next);
  return Boolean(from && to) && sessionSites().some(root => hostInSite(from, root) && hostInSite(to, root));
}

function cleanRemembered(list, now) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const until = Number(item?.until);
    if (!(until > now) || until > now + REMEMBER_MS) continue;
    const root = typeof item?.root === 'string' ? item.root : '';
    if (siteRoot(`https://*.${root}`) !== root) continue;
    if (!out.some(entry => entry.root === root)) out.push({ root, until });
  }
  return out.slice(0, MAX_REMEMBERED_SITES);
}

async function hasSitePermission(patterns) {
  try {
    return patterns.length > 0 && (await chrome.permissions?.contains?.({ origins: patterns })) === true;
  } catch {
    return false;
  }
}

// Ends a session's hold on its domain host permissions (once): remembered when the user opted in and the session never
// went above Reversible, then every permission no live session or remembered domain needs is removed.
function releaseSites(ended) {
  if (!ended || ended.sitesReleased) return;
  ended.sitesReleased = true;
  if (!ended.patterns?.length) return;
  ignore(rememberSites(ended).catch(() => {}).then(reconcileSites));
}

async function forgetSites(roots) {
  const saved = await chrome.storage.local.get(['rememberedSites']);
  const list = cleanRemembered(saved.rememberedSites, Date.now());
  const next = list.filter(entry => !roots.includes(entry.root));
  if (next.length !== list.length || !Array.isArray(saved.rememberedSites)) await chrome.storage.local.set({ rememberedSites: next });
}

async function rememberSites(ended) {
  const saved = await chrome.storage.local.get(['domainMemory', 'rememberedSites']);
  if (saved.domainMemory?.remember !== true || ended.scope !== 'domain') return;
  if (!REMEMBER_LEVELS.includes(cleanLevel(ended.level))) return;
  const now = Date.now();
  const list = cleanRemembered(saved.rememberedSites, now);
  for (const root of (ended.sites ?? []).map(siteRoot).filter(Boolean)) {
    // Time-boxed from the first remembered approval: a later one never extends it.
    if (!list.some(entry => entry.root === root)) list.push({ root, until: now + REMEMBER_MS });
  }
  await chrome.storage.local.set({ rememberedSites: list.slice(0, MAX_REMEMBERED_SITES) });
}

// The https://*.<root>/* patterns this extension asked Chrome for (chrome.storage.local.trackedSites, written only
// here: the popup reports each pattern it is about to request with a `track` message). reconcileSites() only ever removes a
// tracked pattern, so a site the user allowed by hand in chrome://extensions is never taken away.
const MAX_TRACKED_SITES = 100;

async function trackSites(patterns) {
  const valid = (Array.isArray(patterns) ? patterns : []).filter(pattern => managedPattern(pattern)
    && (!SITE_PERMISSION.test(pattern) || siteRoot(pattern.slice(0, -2)) !== null));
  if (!valid.length) return;
  const saved = await chrome.storage.local.get(['trackedSites']);
  const list = Array.isArray(saved.trackedSites) ? saved.trackedSites.filter(managedPattern) : [];
  for (const pattern of valid) {
    recentGrants.set(pattern, Date.now());
    if (!list.includes(pattern)) list.push(pattern);
  }
  await chrome.storage.local.set({ trackedSites: list.slice(-MAX_TRACKED_SITES) });
}

let reconciling = Promise.resolve();
// Removes every tracked https://*.<root>/* host permission that neither the live session (active or paused), a start in
// progress, a tab armed for "All of <root>", a just-requested approval nor an unexpired remembered domain (with the
// setting on) needs; drops expired remembered domains, and forgets tracked patterns Chrome no longer holds.
function reconcileSites() {
  reconciling = reconciling.then(async () => {
    if (!chrome.permissions?.getAll) return;
    await loadArms();
    const saved = await chrome.storage.local.get(['domainMemory', 'rememberedSites', 'trackedSites']);
    const tracked = new Set(Array.isArray(saved.trackedSites) ? saved.trackedSites : []);
    const remembered = saved.domainMemory?.remember === true ? cleanRemembered(saved.rememberedSites, Date.now()) : [];
    if (JSON.stringify(remembered) !== JSON.stringify(saved.rememberedSites ?? [])) {
      await chrome.storage.local.set({ rememberedSites: remembered });
    }
    const keep = new Set([...remembered.map(entry => sitePattern(entry.root)),
      ...pendingPatterns, ...[...armed.values()].flatMap(arm => arm.patterns ?? []),
      ...[...modalIntents.values()].filter(intent => armed.get(intent.arm.tabId) === intent.arm && Date.now() - intent.arm.at <= ARM_MS).map(intent => intent.pattern)]);
    for (const [pattern, at] of recentGrants) {
      if (Date.now() - at < RECENT_GRANT_MS) keep.add(pattern);
      else recentGrants.delete(pattern);
    }
    if (session && !session.sitesReleased && ['active', 'paused'].includes(session.status)) {
      for (const pattern of session.patterns ?? []) keep.add(pattern);
    }
    const granted = (await chrome.permissions.getAll())?.origins ?? [];
    const drop = granted.filter(pattern => managedPattern(pattern) && tracked.has(pattern) && !keep.has(pattern));
    if (drop.length) await chrome.permissions.remove({ origins: drop });
    const still = [...tracked].filter(pattern => keep.has(pattern) || (granted.includes(pattern) && !drop.includes(pattern)));
    if (still.length !== tracked.size) await chrome.storage.local.set({ trackedSites: still });
  }).catch(() => {});
  return reconciling;
}

function sessionView() {
  if (!session) return null;
  const { requestId, leaseId, tabId, origin, status } = session;
  return { requestId, leaseId, tabId, origin, status, level: grantedLevel(), scope: session.scope ?? 'origin', tabMode: session.tabMode ?? 'single' };
}

// --- permission levels -------------------------------------------------------------------------------------------

/** A known level, or null. */
// The popup's names for the levels (extension/permissions.js LEVEL_TEXT), for the icon title.
const LEVEL_NAMES = { 'read-only': 'Read', reversible: 'Use', interactive: 'Use', full: 'Act', testing: 'Test site' };

function cleanLevel(level) {
  return typeof level === 'string' && LEVELS.includes(level) ? level : null;
}

function minLevel(a, b) {
  return LEVELS[Math.min(Math.max(0, LEVELS.indexOf(a)), Math.max(0, LEVELS.indexOf(b)))];
}

// Exact http(s) origins only: what the popup stores is compared as typed.
// A stored or reported budget {maxCalls, maxMs} within the bounds (extension/permissions.js BUDGET_LIMITS, the same as
// src/settings.js), with its `source` when the daemon names one; anything else is null (not set).
const BUDGET_BOUNDS = { maxCalls: [1, 500], maxMs: [1000, 14_400_000] };
function cleanBudget(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const [key, [min, max]] of Object.entries(BUDGET_BOUNDS)) {
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max) return null;
    out[key] = value[key];
  }
  if (['extension', 'config', 'default'].includes(value.source)) out.source = value.source;
  return out;
}

async function loadBudget() {
  const saved = await chrome.storage.local.get(['budget', 'openRightAway', 'tabMode']);
  budget = cleanBudget(saved.budget);
  openRightAway = saved.openRightAway !== false;
  tabMode = cleanTabMode(saved.tabMode);
  budgetLoaded = true;
  return budget;
}

// The popup settings the daemon is told about: the budget, whether a request's page opens by itself, and which Approve
// gate asks are on (booleans only), so the agent's offer marks an action "(asks the user)" only when it will ask.
function reportedSettings() {
  return { budget, openRightAway, tabMode, approvals: { ...approvalSettings } };
}

// Tells the daemon a popup setting changed (settings reply: the budget now in effect, shown by the popup).
async function reportSettings() {
  if (!connected) return;
  try {
    const data = await send('settings', { settings: reportedSettings() });
    effectiveBudget = cleanBudget(data?.budget);
    publishConnection();
  } catch {
    // The next hello carries the setting.
  }
}

function cleanTestingOrigins(permissions) {
  const list = Array.isArray(permissions?.testingOrigins) ? permissions.testingOrigins : [];
  return list.filter(item => {
    if (typeof item !== 'string' || item.includes('*')) return false;
    try {
      const url = new URL(item);
      return /^https?:$/.test(url.protocol) && url.origin === item;
    } catch {
      return false;
    }
  });
}

async function loadTestingOrigins() {
  const saved = await chrome.storage.local.get(['permissions']);
  testingOrigins = cleanTestingOrigins(saved.permissions);
  revokeTesting();
  return testingOrigins;
}

// A testing session whose origins are no longer all listed drops to Full for good (listing the origin again does
// not bring testing back: that needs a new approval on a request card), and the daemon is told, so its grant, the
// receipts' `permissions` and the actions it offers follow. The daemon accepts a lower level from this message only.
function revokeTesting() {
  if (!session || cleanLevel(session.level) !== 'testing') return;
  const level = grantedLevel();
  if (level === 'testing') return;
  session.level = level;
  ignore(send('lease_level', { leaseId: session.leaseId, level }));
}

function allListed(origins, listed) {
  return Array.isArray(origins) && origins.length > 0 && origins.every(origin => listed.includes(origin));
}

// The level the user granted for the current session. A testing grant holds only while the session's origin is
// still a listed testing environment (the user can remove it mid-session); otherwise it falls back to Full.
function grantedLevel() {
  if (!session) return null;
  const level = cleanLevel(session.level) ?? 'read-only';
  // Every origin of the lease must still be listed, not only the current one.
  const origins = [session.origin, ...(Array.isArray(session.origins) ? session.origins : [])];
  if (level === 'testing' && !origins.every(origin => testingOrigins.includes(origin))) return 'full';
  return level;
}

// The capabilities page.js may use for one command: the lower of the level the host sent (none means read-only)
// and the user's grant. The host can lower what the user granted, never raise it.
function commandCapabilities(command) {
  const effective = minLevel(cleanLevel(command?.args?.level) ?? 'read-only', grantedLevel() ?? 'read-only');
  return [...CAPABILITIES[effective]];
}

// --- transport ---------------------------------------------------------------------------------------------

function settleAttempt() {
  const waiters = attemptWaiters;
  attemptWaiters = [];
  for (const resolve of waiters) resolve();
}

// Waits until the current connection attempt settles, at most `ms`.
function waitForAttempt(ms) {
  if (connected) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    attemptWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function rejectReplies(code, message) {
  for (const [ref, entry] of replies) {
    clearTimeout(entry.timer);
    entry.reject(new ExtensionError(code, message));
    replies.delete(ref);
  }
}

async function http(type, body, current = pairing) {
  if (!current) throw new ExtensionError('session_inactive', 'Pair the extension first');
  const response = await fetch(current.endpoint + HTTP_PATHS[type], {
    method: 'POST',
    headers: { Authorization: `Bearer ${current.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ v: 3, ...body }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new ExtensionError(data.code || 'rejected', data.error || `The FAI service returned ${response.status}`, {
      origins: data.origins,
    });
  }
  return data;
}

// Sends one message: over the socket when open, else over HTTP. Reply types resolve with the reply data.
function send(type, body = {}) {
  if (!socketOpen) return http(type, body);
  const message = { v: 3, type, ...body };
  if (!REPLY_TYPES.has(type)) {
    socket.send(JSON.stringify(message));
    return Promise.resolve({});
  }
  const ref = String(++refSequence);
  message.ref = ref;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      replies.delete(ref);
      reject(new ExtensionError('timeout', 'The FAI service did not reply'));
    }, REPLY_TIMEOUT_MS);
    replies.set(ref, { resolve, reject, timer });
    socket.send(JSON.stringify(message));
  });
}

function helloBody() {
  const version = chrome.runtime.getManifest?.().version ?? null;
  // `settings.budget`: the user's per-request budget, or null when not set (the daemon's default then applies);
  // `settings.openRightAway`: whether a request's page opens by itself (the daemon words its approval hint by it).
  return { ext: { version, protocol: PROTOCOL_VERSION }, session: sessionView(), settings: reportedSettings() };
}

function handleHello(data, via) {
  connected = true;
  transportName = via;
  // The budget the daemon applies (the user's, else config.json, else its default); an older daemon names none.
  effectiveBudget = cleanBudget(data?.budget);
  driverControl = cleanDriverControl(data?.control);
  if (data?.endSession && session) {
    releaseSites(session);
    const ended = session;
    session = null;
    markTab(ended);
    updateBadge();
    ignore(chrome.storage.local.set({ status: 'Reconnect required' }));
  } else if (!session) {
    // Connected with no lease: clear the worker-start "Reconnect required" text so the popup reads Ready.
    ignore(chrome.storage.local.set({ status: '' }));
  }
  if (Array.isArray(data?.requests)) setRequests(data.requests);
  publishConnection();
  settleAttempt();
}

function markDisconnected() {
  connected = false;
  transportName = 'none';
  if (!session) ignore(chrome.storage.local.set({ status: 'Not connected to the FAI service. Retrying.' }));
  publishConnection();
}

function scheduleReconnect() {
  if (reconnectTimer || !pairing) return;
  // An unreachable service: the native host can start it, or knows a new address or secret (setup ran again).
  if (backoffIndex >= 2) ignore(nativePair());
  const base = BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)];
  backoffIndex++;
  const wait = Math.round(base * (0.8 + Math.random() * 0.4));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, wait);
}

// Three WebSocket failures before open: use the long-poll if the service answers over HTTP.
async function tryFallback() {
  try {
    const data = await http('hello', helloBody());
    handleHello(data, 'longpoll');
    fallbackUntil = Date.now() + FALLBACK_WINDOW_MS;
    longPollLoop();
  } catch {
    markDisconnected();
    settleAttempt();
    scheduleReconnect();
  }
}

function connectionFailed(opened) {
  if (!opened) wsFailures++;
  if (wsFailures >= FALLBACK_AFTER_FAILURES) {
    tryFallback();
    return;
  }
  markDisconnected();
  settleAttempt();
  scheduleReconnect();
}

// Asks the native messaging host for the FAI service's address and secret (it starts the service when needed) and
// saves them. At most once per NATIVE_RETRY_MS unless `force` (the popup's Pair button). Resolves the outcome.
function nativePair({ force = false } = {}) {
  if (nativePairing) return nativePairing;
  if (!force && Date.now() - nativeAt < NATIVE_RETRY_MS) return Promise.resolve(nativeState);
  if (typeof chrome.runtime?.sendNativeMessage !== 'function') return Promise.resolve(nativeState);
  nativeAt = Date.now();
  nativePairing = (async () => {
    let reply;
    try {
      reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'pair' });
    } catch (error) {
      nativeState = /not found|forbidden|not allowed/i.test(String(error?.message)) ? 'missing' : 'error';
      return nativeState;
    }
    let next = null;
    if (reply?.ok === true && typeof reply.secret === 'string' && reply.secret.length >= MIN_SECRET_LENGTH) {
      next = validPairing(reply.endpoint, reply.secret);
    }
    if (!next) {
      nativeState = 'error';
      return nativeState;
    }
    nativeState = 'paired';
    await chrome.storage.local.set({ endpoint: next.endpoint, secret: next.secret });
    await usePairing(next);
    return nativeState;
  })().finally(() => {
    nativePairing = null;
    publishConnection();
  });
  return nativePairing;
}

async function connect() {
  if (!pairing) {
    const saved = await chrome.storage.local.get(['endpoint', 'secret']);
    pairing = validPairing(saved.endpoint, saved.secret);
  }
  // Not paired yet: pair through the native host (installed by setup); usePairing then connects.
  if (!pairing && await nativePair() === 'paired') return;
  // The first hello carries the user's budget, so it is read before connecting.
  if (!budgetLoaded) await loadBudget();
  if (!pairing) {
    markDisconnected();
    settleAttempt();
    return;
  }
  if (socket || longPolling) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (Date.now() < fallbackUntil) {
    longPollLoop();
    return;
  }
  if (typeof WebSocket !== 'function' || !TOKEN.test(pairing.secret)) {
    // No usable WebSocket (or a secret that is not a valid subprotocol token): long-poll only.
    wsFailures = FALLBACK_AFTER_FAILURES;
    tryFallback();
    return;
  }
  const url = pairing.endpoint.replace(/^http:/, 'ws:') + '/ext/ws';
  let current;
  try {
    current = new WebSocket(url, [WS_PROTOCOL, AUTH_PROTOCOL_PREFIX + pairing.secret]);
  } catch {
    connectionFailed(false);
    return;
  }
  socket = current;
  let opened = false;
  current.onopen = () => {
    if (socket !== current) return;
    opened = true;
    socketOpen = true;
    wsFailures = 0;
    backoffIndex = 0;
    fallbackUntil = 0;
    send('hello', helloBody()).then(data => handleHello(data, 'websocket'), () => {});
  };
  current.onmessage = event => {
    if (socket !== current) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleMessage(message);
  };
  current.onerror = () => {};
  current.onclose = () => {
    if (socket !== current) return;
    socket = null;
    socketOpen = false;
    rejectReplies('disconnected', 'Connection to the FAI service closed');
    connectionFailed(opened);
  };
}

// Drops the current transport and connects with the saved pairing (after a pairing change).
function reconnect() {
  const current = socket;
  socket = null;
  socketOpen = false;
  rejectReplies('disconnected', 'Pairing changed');
  try {
    current?.close(1000);
  } catch {
    // Already closed.
  }
  pollController?.abort();
  fallbackUntil = 0;
  wsFailures = 0;
  backoffIndex = 0;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  markDisconnected();
  connect();
}

async function usePairing(next) {
  if (pairing && next && pairing.endpoint === next.endpoint && pairing.secret === next.secret) return;
  if (!pairing && !next) return;
  pairing = next;
  reconnect();
}

// Daemon -> extension messages, from the socket or from a long-poll response.
function handleMessage(message) {
  switch (message?.type) {
    case 'reply': {
      const entry = replies.get(message.ref);
      if (!entry) return;
      replies.delete(message.ref);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.data ?? {});
      else {
        const error = message.error ?? {};
        const code = error.code || 'rejected';
        entry.reject(new ExtensionError(code, error.message || 'Rejected', { origins: error.origins }));
      }
      return;
    }
    case 'requests':
      setRequests(message.requests);
      return;
    case 'command':
      handleCommand(message.command);
      return;
    case 'cancel':
      cancelled.add(message.id);
      if (cancelled.size > 200) cancelled.delete(cancelled.values().next().value);
      return;
    case 'lease_update':
      if (session && message.leaseId === session.leaseId && message.state !== 'active') {
        // The daemon ended the lease; end the session locally without reporting back.
        // A new user-approved request supersedes the old lease before its lease reply arrives.
        // Keep only the in-memory handles for that handoff; the old lease still stops immediately.
        // Explicit stop, release and expiry continue to clear the vault.
        ignore(setStatus(message.state === 'paused' ? 'paused' : 'stopped',
          { preserveVault: message.reason === 'superseded' }));
      }
      return;
    default:
  }
}

async function longPollLoop() {
  if (longPolling) return;
  longPolling = true;
  let failures = 0;
  try {
    while (pairing && !socketOpen && Date.now() < fallbackUntil) {
      const current = pairing;
      const controller = new AbortController();
      pollController = controller;
      let body;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(LONG_POLL_MS + 5_000)]);
        // POST, not GET: Chrome omits the Origin header on extension GETs and the service requires it.
        const response = await fetch(`${current.endpoint}/commands?wait=${LONG_POLL_MS}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${current.secret}`, 'Content-Type': 'application/json' },
          body: '{}',
          signal,
        });
        body = await response.json();
        if (!response.ok) throw new Error(body.error || `The FAI service returned ${response.status}`);
        failures = 0;
      } catch {
        if (controller.signal.aborted || pairing !== current) continue;
        if (++failures >= POLL_RETRIES) {
          fallbackUntil = 0;
          markDisconnected();
          break;
        }
        await delay(250 * failures);
        continue;
      }
      if (!connected) {
        connected = true;
        transportName = 'longpoll';
        publishConnection();
      }
      if (Array.isArray(body.requests)) setRequests(body.requests);
      for (const message of body.messages ?? []) handleMessage(message);
      if (body.command) await handleCommand(body.command);
    }
  } finally {
    longPolling = false;
    pollController = null;
  }
  if (pairing && !socketOpen) scheduleReconnect();
}

// --- session -------------------------------------------------------------------------------------------------

// Ends (pauses or stops) the current session locally first, so a user Pause/Stop always takes effect even when
// the FAI service is unreachable, then reports it. `reason` becomes the BridgeError code on the service side.
async function endSession(status, reason) {
  if (!session) return;
  const current = session;
  expireApprovals(current.leaseId);
  await setStatus(status);
  await send('status', { leaseId: current.leaseId, status, reason }).catch(() => {});
}

function inactiveError() {
  const status = session?.status;
  if (status === 'paused' || status === 'stopped') return new ExtensionError(status, `Browser session is ${status}`);
  return new ExtensionError('session_inactive', 'Browser session is not active');
}

// A consent wall on its own host (consent.google.com, consent.youtube.com: "Before you continue") redirects to the
// page the user asked for once it is answered. The session follows that one hop, and only when the new origin is
// one the approved request listed; any other origin change still ends the session. One hop per session: after a
// redirect has been followed, no further origin change is (not even from one consent.* host to another).
function followConsentRedirect(url) {
  const next = originOf(url);
  if (!session || session.consentFollowed || !next || next === session.origin || !Array.isArray(session.origins)) {
    return false;
  }
  let host = '';
  try {
    host = new URL(session.origin).hostname;
  } catch {
    return false;
  }
  if (!/^consent\./i.test(host) || !originCovered(next, session.origins)) return false;
  session.origin = next;
  session.consentFollowed = true;
  return true;
}

// Called once per command: the leased tab must still exist, be the active tab of its window (capture and the
// activeTab grant both depend on that), and still be on the leased origin.
async function assertTab() {
  if (session?.status !== 'active') throw inactiveError();
  let tab;
  try {
    tab = await chrome.tabs.get(session.tabId);
  } catch {
    throw new ExtensionError('tab_changed', 'Selected tab was closed');
  }
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  if (active?.id !== tab.id) throw new ExtensionError('tab_changed', 'Selected tab is no longer active');
  if (session?.status !== 'active') throw inactiveError();
  // Without a live grant Chrome omits tab.url; treat that as having left the leased origin. A toolbar (activeTab) grant
  // also ends when Chrome commits its own error page (an opaque origin), on the approved URL: nothing can be read
  // there either, so the session pauses the same way, with a message that names both causes.
  if (!sessionCovers(tab.url)) {
    throw new ExtensionError('origin_changed', tab.url ? 'Origin changed; select this tab again'
      : 'The browser withdrew access to this tab: it left the approved site, or (toolbar approval) the browser '
        + 'showed its own error page; approve this tab again');
  }
  return tab;
}

// The secret redaction options for page.js: the user's mode and Relaxed origins, and the session's salt (stable tags
// across the session's documents).
function cleanSecretRedaction(value) {
  const mode = value?.mode === 'strict' ? 'strict' : 'standard';
  const relaxed = Array.isArray(value?.relaxed)
    ? value.relaxed.filter(origin => typeof origin === 'string' && /^https?:\/\/[^/\s]+$/.test(origin)).slice(0, 50) : [];
  return { mode, relaxed };
}

async function loadSecretRedaction() {
  const saved = await chrome.storage.local.get(['secretRedaction']);
  secretRedaction = cleanSecretRedaction(saved.secretRedaction);
}

function secretNumbering() {
  return secretVault;
}

function clearVault() {
  secretVault = newVault();
}

function secretOptions() {
  // `input`: input.js's settings for the call (trusted input on or off, trusted-input.js).
  const trusted = typeof trustedInputOn === 'function' && trustedInputOn();
  return { ...secretRedaction, salt: secretNumbering().salt, gates: approvalSettings, vault: true, input: { trusted } };
}

// The values page.js redacted (VAULT_KEY of a page result: [{ tag, value, kind, pre, origin }]), kept under their
// session numbers. Anything malformed is dropped.
function vaultFound(found) {
  if (!Array.isArray(found)) return;
  const now = Date.now();
  for (const item of found.slice(0, VAULT_MAX)) {
    if (!item || typeof item.tag !== 'string' || !/^[0-9a-z]{1,12}$/.test(item.tag) || typeof item.value !== 'string'
      || item.value.length < 6 || item.value.length > 8192 || ['card', 'url-param', 'filled'].includes(item.kind)) continue;
    const handle = secretNumber(item.tag);
    secretVault.entries.delete(handle);
    secretVault.entries.set(handle, { value: item.value, kind: typeof item.kind === 'string' ? item.kind.slice(0, 32) : 'generic',
      pre: typeof item.pre === 'string' ? item.pre.slice(0, 32) : '', origin: originOf(item.origin) ?? session?.origin ?? null, at: now });
  }
  while (secretVault.entries.size > VAULT_MAX) secretVault.entries.delete(secretVault.entries.keys().next().value);
}

// One vault entry by handle ('3'), or null when there is none (never seen, lapsed, or the vault was cleared).
function vaultEntry(handle) {
  const entry = typeof handle === 'string' ? secretVault.entries.get(handle) : null;
  if (!entry) return null;
  if (Date.now() - entry.at > VAULT_TTL_MS) {
    secretVault.entries.delete(handle);
    return null;
  }
  return entry;
}

// What an observation tells the daemon about the vault: [{ handle, kind, origin, label }], newest first, at most 10.
// `label` is the placeholder (kind, public prefix, last four, length: what the page text already showed). No value.
function vaultView() {
  const out = [];
  for (const handle of [...secretVault.entries.keys()].reverse()) {
    const entry = vaultEntry(handle);
    if (!entry) continue;
    out.push({ handle, kind: entry.kind, origin: entry.origin, label: secretPlaceholder(handle, entry.kind, entry.value, entry.pre) });
    if (out.length >= 10) break;
  }
  return out;
}

// The session number of a page tag (`~<hash>`): 1, 2, 3 ... in order of first sight.
function secretNumber(hash) {
  const { ids } = secretNumbering();
  if (!ids.has(hash)) ids.set(hash, String(ids.size + 1));
  return ids.get(hash);
}

// A page result with its `[secret:~<hash>` tags numbered for the session.
function numberSecrets(value) {
  if (typeof value === 'string') {
    return value.includes('[secret:~') ? value.replace(/\[secret:~([0-9a-z]{1,12})\b/g, (_, hash) => `[secret:${secretNumber(hash)}`) : value;
  }
  if (Array.isArray(value)) return value.map(numberSecrets);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) copy[key] = numberSecrets(item);
  return copy;
}

// A URL this worker reports itself (the tab's URL before an action), redacted as page.js redacts the page's URL, with
// the same tags, so the two compare equal.
function reportedUrl(url) {
  if (typeof url !== 'string') return url;
  const { salt } = secretNumbering();
  return numberSecrets(secretRedactUrl(url, { salt }));
}

// Text this worker reports itself (the tab's title on a lease), redacted by the same rules.
function reportedText(text) {
  const { salt } = secretNumbering();
  return numberSecrets(secretRedactText(text, { salt }));
}

// Runs inside the page (serialized by chrome.scripting); must not reference anything outside itself.
function pageCall(method, args, secrets) {
  const page = globalThis.__faiPage;
  if (!page) return { missing: true };
  if (secrets && typeof page.useSecrets === 'function') page.useSecrets(secrets);
  if (secrets?.gates && typeof page.useGates === 'function') page.useGates(secrets.gates);
  if (secrets?.input && typeof globalThis.__faiInput?.configure === 'function') globalThis.__faiInput.configure(secrets.input);
  return Promise.resolve()
    .then(() => page[method](...args))
    .then(
      value => ({ value }),
      error => ({ error: { code: error?.code || 'unsupported', message: String(error?.message || error) } }),
    );
}

// One executeScript per command in the common case. page.js is injected once per document: the first call
// probes for it, and only a new document (after navigation) costs the extra injection. The injection and retry
// are pinned to the probed documentId so they cannot land in a different document.
// A page whose main thread stops answering (a native alert, confirm or prompt blocks it until the user answers; below
// Test site no hook answers it): after PAGE_SLOW_MS a one-line probe runs in the page, and when that does not answer
// within PAGE_PROBE_MS either, the call fails with js_dialog instead of waiting for the command timeout. A page busy
// with its own async work (typing, a fetch) still answers the probe.
const PAGE_SLOW_MS = 6_000;
const PAGE_PROBE_MS = 2_000;

function callPage(tabId, method, args = []) {
  const call = callPageOnce(tabId, method, args);
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      const probe = chrome.scripting.executeScript({ target: { tabId }, func: () => true }).then(() => true, () => true);
      if (!(await resolvesWithin(probe, PAGE_PROBE_MS))) {
        reject(new ExtensionError('js_dialog', 'The page stopped answering; a JavaScript dialog is most likely open'));
      }
    }, PAGE_SLOW_MS);
  });
  return Promise.race([call, watchdog]).finally(() => clearTimeout(timer));
}

// chrome.scripting.executeScript for a page call. On the browser's own error page no page script runs: observe paths
// turn that into an error page observation (observePage); anything else fails that command only, never the session.
async function scriptPage(details) {
  try {
    return await chrome.scripting.executeScript(details);
  } catch (error) {
    if (BROWSER_ERROR_PAGE.test(String(error?.message || error))) {
      throw new ExtensionError('target_unavailable', BROWSER_ERROR_MESSAGE, { browserErrorPage: true });
    }
    throw error;
  }
}

async function callPageOnce(tabId, method, args = []) {
  const secrets = secretOptions();
  let [injection] = await scriptPage({ target: { tabId }, func: pageCall, args: [method, args, secrets] });
  if (injection?.result?.missing) {
    const target = injection.documentId ? { tabId, documentIds: [injection.documentId] } : { tabId };
    await scriptPage({ target, files: ['input.js', 'page.js'] });
    [injection] = await scriptPage({ target, func: pageCall, args: [method, args, secrets] });
  }
  const outcome = injection?.result;
  if (outcome?.error) throw new ExtensionError(outcome.error.code, numberSecrets(outcome.error.message));
  if (!outcome?.value) throw new ExtensionError('unsupported', 'Page returned no result', { teardown: true });
  // The values page.js redacted go into the vault here and nowhere else (after the result is numbered, so a value's
  // handle is the number its placeholder got).
  if (outcome.value && typeof outcome.value === 'object' && Object.hasOwn(outcome.value, VAULT_KEY)) {
    const { [VAULT_KEY]: found, ...rest } = outcome.value;
    const numbered = numberSecrets(rest);
    vaultFound(found);
    return numbered;
  }
  return numberSecrets(outcome.value);
}

// A short stable hash (FNV-1a, base 36) for the error page's revision: the same URL reads as the same page.
function shortHash(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(36);
}

// The revision of the browser's error page at `url`: a hash of the reported (redacted) URL, never of the raw one, so a
// low-entropy secret in the URL cannot be recovered from it.
function browserErrorRevision(url) {
  return `browser-error:${shortHash(String(reportedUrl(url)))}`;
}

// What the worker reports for a tab that shows the browser's own error page: the URL the tab tried (still on the
// approved site, or the observation is refused as an origin change by checkedObservation), no controls, a fixed text
// written here (no page text exists), `browserErrorPage: true` and the `browser_error_page` warning. The HTTP status is
// unknown: Chrome uses this page for an error status with an empty body and for network failures alike.
async function browserErrorObservation(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new ExtensionError('tab_changed', 'Selected tab was closed');
  if (!sessionCovers(tab.url)) throw new ExtensionError('origin_changed', 'Origin changed; select this tab again');
  const url = reportedUrl(tab.url);
  const text = 'The browser shows its own error page for this address: the server answered with an HTTP error and no '
    + 'page, or the site could not be reached. Nothing on it can be read or used; reload it later, or report it.';
  return {
    revision: browserErrorRevision(tab.url),
    documentId: 'browser-error',
    url,
    title: reportedText(String(tab.title ?? '').slice(0, 300)),
    text,
    textTruncated: false,
    blocks: [{ t: 'h1', text: 'Browser error page' }, { t: 'p', text }],
    blocksTruncated: false,
    controls: [],
    consent: null,
    warnings: ['browser_error_page'],
    browserErrorPage: true,
    viewport: { width: Number(tab.width) || 0, height: Number(tab.height) || 0, dpr: 1 },
    scroll: { top: 0, height: 0 },
  };
}

// observe or settleAndObserve through page.js, or, where the tab shows the browser's own error page, that page as an
// observation (the session goes on: the agent can report it, wait, or reload once the site is back).
async function observePage(tabId, method, args) {
  try {
    return await callPage(tabId, method, args);
  } catch (error) {
    if (!error?.browserErrorPage) throw error;
    const observation = await browserErrorObservation(tabId);
    return method === 'settleAndObserve' ? { settle: { reason: 'none', ms: 0 }, observation } : observation;
  }
}

// The document was replaced or unloaded while a page call ran.
function isTeardown(error) {
  if (error?.teardown) return true;
  if (error instanceof ExtensionError) return false;
  return TEARDOWN.test(String(error?.message || error));
}

// Expectation texts (the run's textIncludes) the page script looks for in the rendered text past the viewport:
// lower-case strings of at most 200 characters, at most four. [] when absent or malformed.
function cleanExpectText(texts) {
  if (!Array.isArray(texts)) return [];
  return texts.filter(text => typeof text === 'string' && text.trim() && text.length <= 200)
    .map(text => text.toLowerCase()).slice(0, 4);
}

// Instruction terms for control ordering: lower-case words, at most MAX_TERMS. null when absent or malformed.
function cleanTerms(terms) {
  if (!Array.isArray(terms)) return null;
  return terms.filter(term => typeof term === 'string' && term.length <= 40)
    .map(term => term.toLowerCase()).slice(0, MAX_TERMS);
}

// Guardrail additions (src/guardrails.js): plain phrases, at most 40 of at most 60 characters. The page script escapes
// and compiles them itself; the worker never passes regex source. null when absent or malformed.
const MAX_FORBID = 40;
const FORBID_PHRASE = /^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M} '’&/:,!#%@-]{0,59}$/u;
function cleanForbid(forbid) {
  if (!Array.isArray(forbid)) return null;
  return forbid.filter(item => typeof item === 'string' && FORBID_PHRASE.test(item)).slice(0, MAX_FORBID);
}

// Observations never leave the worker unless they are from the leased origin (or its approved domain roots).
function checkedObservation(observation, tabId) {
  if (!sessionCovers(observation?.url)) {
    throw new ExtensionError('origin_changed', 'Origin changed; select this tab again');
  }
  // The secret handles the agent may use (fill_secret, copy_secret): handles and placeholders only, never a value.
  const secrets = vaultView();
  const tabs = leaseTabsView(observation);
  return { ...observation, tabId, ...(secrets.length ? { secrets } : {}), ...(tabs ? { tabs } : {}) };
}

// --- Dev logs and JavaScript dialogs, Test site only (docs/REFERENCE.md "Dev logs and JavaScript dialogs") ---------
// A session granted at testing (every origin listed under Test sites) gets extension/devhook.js in the page's own
// world and extension/devlog.js beside page.js, registered at document_start for its origins and injected into the
// page open now. Nothing is registered at any other level, and the registration goes when the session ends. The hook
// is visible to the page and what it reports is untrusted page content: acceptable only on the user's own test sites.
const DEV_SCRIPT_IDS = ['fai-devhook', 'fai-devlog'];

function devPatterns(origins) {
  return [...new Set((origins ?? []).map(origin => {
    try {
      const url = new URL(origin);
      return ['http:', 'https:'].includes(url.protocol) ? `${url.protocol}//${url.host}/*` : null;
    } catch {
      return null;
    }
  }).filter(Boolean))];
}

async function armDevHooks(current) {
  if (!current || cleanLevel(current.level) !== 'testing' || !chrome.scripting?.registerContentScripts) return;
  await disarmDevHooks();
  const matches = devPatterns([current.origin, ...(current.origins ?? [])]);
  if (!matches.length) return;
  current.devHooks = true;
  try {
    await chrome.scripting.registerContentScripts([
      { id: 'fai-devhook', matches, js: ['devhook.js'], runAt: 'document_start', world: 'MAIN', persistAcrossSessions: false },
      { id: 'fai-devlog', matches, js: ['devlog.js'], runAt: 'document_start', persistAcrossSessions: false },
    ]);
  } catch {
    // No host access for those origins yet (the page open now still gets the hook below).
  }
  await injectDevHooks(current.tabId);
}

async function injectDevHooks(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['devlog.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['devhook.js'], world: 'MAIN' });
  } catch {
    // A page the extension cannot script: no logs there.
  }
}

async function disarmDevHooks() {
  if (!chrome.scripting?.unregisterContentScripts) return;
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: DEV_SCRIPT_IDS });
    if (registered?.length) await chrome.scripting.unregisterContentScripts({ ids: registered.map(item => item.id) });
  } catch {
    // Nothing registered.
  }
}

// What the hook reported since the last read: { logs, logsDropped, dialog } (logs only when asked for), redacted as
// any page text this worker reports, or null outside a testing session.
async function devRead(tabId, withLogs) {
  if (!session?.devHooks || grantedLevel() !== 'testing') return null;
  let read = null;
  try {
    [{ result: read } = {}] = await chrome.scripting.executeScript({ target: { tabId }, args: [withLogs], func: drain => {
      const log = globalThis.__faiDevLog;
      if (!log) return { missing: true };
      return drain ? log.drain() : { dialog: log.takeDialog() };
    } });
  } catch {
    return null;
  }
  if (read?.missing) {
    // A document the registration did not reach (no host access): the hook from now on.
    await injectDevHooks(tabId);
    return withLogs ? { logs: [], logsDropped: 0 } : null;
  }
  const out = {};
  const dialog = read?.dialog;
  if (dialog && ['alert', 'confirm', 'prompt'].includes(dialog.kind)) {
    out.dialog = { kind: dialog.kind, text: reportedText(String(dialog.text ?? '')).slice(0, 300),
      answered: dialog.answered === 'accept' ? 'accept' : 'dismiss' };
    // The last dialog, for the Approve gate on accepting it (approveCommand kind dialog, armDialog).
    session.lastDialog = { kind: out.dialog.kind, text: out.dialog.text };
  }
  if (withLogs) {
    out.logs = (Array.isArray(read?.logs) ? read.logs : []).slice(-50).map(entry => {
      const item = { kind: String(entry?.kind ?? ''), text: reportedText(String(entry?.text ?? '')).slice(0, 300) };
      if (typeof entry?.method === 'string' && entry.method) item.method = entry.method.slice(0, 10);
      if (typeof entry?.url === 'string' && entry.url) item.url = reportedUrl(entry.url).slice(0, 300);
      if (Number.isInteger(entry?.status)) item.status = entry.status;
      return item;
    });
    out.logsDropped = Number.isInteger(read?.dropped) ? read.dropped : 0;
  }
  return out;
}

// An upload's file as the approval and the execute name it: { name, size } (a plain file name, at most 25 MB), or null.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
function uploadFileInfo(file) {
  if (!file || typeof file !== 'object' || typeof file.name !== 'string' || !file.name || file.name.length > 255
    || /[\\/\u0000-\u001f]/.test(file.name) || !Number.isInteger(file.size) || file.size < 0 || file.size > MAX_UPLOAD_BYTES) return null;
  return { name: file.name, size: file.size };
}

// A dialog whose text names a destructive or paying step: accepting it asks the user first (Approve once).
const DIALOG_GATED = /\b(delete|deleting|remove|erase|destroy|discard|permanently|wipe|purge|buy|purchase|pay|payment|order|checkout|subscribe)\b/i;

// The answer the page's next confirm or prompt gets (act {dialog}, Test site only). Accepting after a dialog whose
// text is gated (DIALOG_GATED) needs the user's approval for exactly that dialog (approval, from takeApproval).
async function armDialog(tabId, answer, text, approval = null) {
  if (!session?.devHooks || grantedLevel() !== 'testing') {
    throw new ExtensionError('blocked_risky', 'JavaScript dialogs are answered only on a Test site');
  }
  if (answer === 'accept' && DIALOG_GATED.test(session.lastDialog?.text ?? '') && approval?.kind !== 'dialog') {
    throw new ExtensionError('blocked_risky', 'Accepting this dialog needs the user\'s approval in the FAI Browser window');
  }
  const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, args: [answer, text ?? null], func: (a, t) => {
    const log = globalThis.__faiDevLog;
    if (!log) return false;
    log.arm(a, typeof t === 'string' ? t : undefined);
    return true;
  } });
  if (!result) throw new ExtensionError('target_unavailable', 'The dialog hook is not on this page yet; reload it first');
}

// --- Lease tabs (docs/REFERENCE.md "Popups and new tabs") -------------------------------------------------------
// A tab the leased tab opens (an OAuth popup, a link that opens a new tab) joins the lease when its first page is on
// the approved origins, and commands follow it; a page anywhere else pauses the lease (child_tab) for the user, as
// before. The lease never reaches a tab it did not open: switch_tab moves only among these, and a closed child hands
// the commands back to the tab that opened it.
const MAX_LEASE_TABS = 8;
const CHILD_URL_WAIT_MS = 10_000;

function leaseTab(tabId) {
  return session?.tabs?.find(entry => entry.tabId === tabId) ?? null;
}

// The lease's tabs for a result (only when there is more than one): ids, the page each shows, which one is current.
function leaseTabsView(observation) {
  if (!Array.isArray(session?.tabs) || session.tabs.length < 2) return null;
  return session.tabs.map(entry => {
    const current = entry.tabId === session.tabId;
    if (current && observation) {
      entry.url = reportedUrl(observation.url ?? entry.url);
      entry.title = reportedText(String(observation.title ?? entry.title ?? '')).slice(0, 120);
    }
    return { id: entry.id, url: entry.url ?? '', title: entry.title ?? '', ...(current ? { current: true } : {}) };
  });
}

// A child of a lease tab: followed once its URL is known (an about:blank start waits for its first navigation).
async function followChild(tab) {
  const current = session;
  const opener = leaseTab(tab.openerTabId);
  if (!opener || current?.status !== 'active' || leaseTab(tab.id)) return;
  if (current.tabMode !== 'multiple' || tabMode !== 'multiple') {
    await endSession('paused', 'child_tab');
    return;
  }
  let url = tab.pendingUrl || tab.url || '';
  const deadline = Date.now() + CHILD_URL_WAIT_MS;
  while ((!url || url === 'about:blank') && Date.now() < deadline && session === current) {
    await delay(NAV_POLL_MS);
    const fresh = await chrome.tabs.get(tab.id).catch(() => null);
    if (!fresh) return;
    url = fresh.pendingUrl || fresh.url || '';
  }
  if (session !== current || current.status !== 'active') return;
  if (!url || url === 'about:blank' || !sessionCovers(url) || current.tabs.length >= MAX_LEASE_TABS) {
    await endSession('paused', 'child_tab');
    return;
  }
  const permitted = await hasSitePermission([taskOriginPattern(new URL(url).origin)]);
  if (session !== current || current.status !== 'active' || tabMode !== 'multiple') return;
  if (!permitted || current.tabs.length >= MAX_LEASE_TABS) {
    await endSession('paused', 'child_tab');
    return;
  }
  if (session !== current || current.status !== 'active' || tabMode !== 'multiple') return;
  if (leaseTab(tab.id)) return;
  const entry = { id: `t${Math.max(...current.tabs.map(item => Number(item.id.slice(1)))) + 1}`,
    tabId: tab.id, opener: opener.tabId, url: reportedUrl(url), title: '' };
  current.tabs.push(entry);
  await groupLeaseTab(current, tab.id);
  if (session === current && current.status === 'active') current.tabId = tab.id;
}

// Only tabs recorded in this lease can join its group. Personal tabs are never adopted by group membership.
async function groupLeaseTab(current, tabId) {
  if (!chrome.tabs.group || !chrome.tabGroups) return;
  await markChain;
  if (session !== current || current.status !== 'active') return;
  const home = await chrome.tabs.get(current.homeTabId).catch(() => null);
  if (!home || current.groupId == null || home.groupId !== current.groupId) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || (tab.groupId ?? NO_GROUP) !== NO_GROUP) return;
  if (session !== current || current.status !== 'active' || tabMode !== 'multiple') return;
  if (tab.windowId !== home.windowId) await chrome.tabs.move(tabId, { windowId: home.windowId, index: -1 });
  if (session !== current || current.status !== 'active') return;
  await chrome.tabs.group({ groupId: current.groupId, tabIds: [tabId] });
  if (session !== current || current.status !== 'active') return;
  await chrome.storage.session?.set?.({ markedTab: { tabId: current.homeTabId, tabIds: current.tabs.map(entry => entry.tabId), groupId: current.groupId } });
}

async function openLeaseTab(url) {
  const current = session;
  if (current?.tabMode !== 'multiple' || tabMode !== 'multiple') {
    throw new ExtensionError('blocked_risky', 'This request allows one task tab; approve Multiple task tabs first');
  }
  if (current.tabs.length >= MAX_LEASE_TABS) throw new ExtensionError('blocked_risky', 'This request already has eight task tabs');
  const parsed = new URL(url);
  if (parsed.username || parsed.password || !sameSessionSite(url)) throw new ExtensionError('cross_origin', 'Tab outside approved site');
  if (!(await hasSitePermission([taskOriginPattern(parsed.origin)]))) {
    throw new ExtensionError('blocked_risky', 'Browser site access is required for another task tab; approve again');
  }
  const home = await chrome.tabs.get(current.homeTabId);
  if (session !== current || current.status !== 'active' || tabMode !== 'multiple') throw inactiveError();
  // Inactive until registered: onActivated must not mistake our own new tab for a personal-tab switch.
  const tab = await chrome.tabs.create({ windowId: home.windowId, url, active: false });
  if (session !== current || current.status !== 'active' || tabMode !== 'multiple' || current.tabs.length >= MAX_LEASE_TABS) {
    await ignore(chrome.tabs.remove(tab.id));
    throw new ExtensionError('blocked_risky', 'This request changed while opening its tab');
  }
  const id = `t${Math.max(...current.tabs.map(item => Number(item.id.slice(1)))) + 1}`;
  current.tabs.push({ id, tabId: tab.id, opener: current.tabId, url: reportedUrl(url), title: '' });
  await groupLeaseTab(current, tab.id);
  if (session !== current || current.status !== 'active' || tabMode !== 'multiple') throw inactiveError();
  current.tabId = tab.id;
  await chrome.tabs.update(tab.id, { active: true });
  await waitTabComplete(tab.id, OPEN_LOAD_MS);
  if (session !== current || current.status !== 'active' || tabMode !== 'multiple') throw inactiveError();
  return assertTab();
}

// The command target moves to another tab of the lease (switch_tab): it is brought to the front of its window.
async function switchLeaseTab(id) {
  const current = session;
  const entry = current?.tabs?.find(item => item.id === id);
  if (!entry) throw new ExtensionError('target_unavailable', 'That tab is not part of this request');
  const tab = await chrome.tabs.get(entry.tabId).catch(() => null);
  if (session !== current || current.status !== 'active' || current.tabMode !== 'multiple' || tabMode !== 'multiple') throw inactiveError();
  if (!tab) {
    current.tabs = current.tabs.filter(item => item !== entry);
    throw new ExtensionError('target_unavailable', 'That tab was closed');
  }
  if (!sameSessionSite(tab.url)) throw new ExtensionError('cross_origin', 'That tab left the approved site');
  if (!(await hasSitePermission([taskOriginPattern(new URL(tab.url).origin)]))) throw new ExtensionError('blocked_risky', 'Browser site access was removed');
  if (session !== current || current.status !== 'active' || tabMode !== 'multiple') throw inactiveError();
  const active = await chrome.tabs.update(entry.tabId, { active: true }).catch(() => null);
  if (session !== current || current.status !== 'active' || tabMode !== 'multiple') throw inactiveError();
  if (!active || !sessionCovers(active.url)) throw new ExtensionError('cross_origin', 'That tab left the approved site');
  current.tabId = entry.tabId;
  return active;
}

// A lease tab closed: dropped; when it was the current one, commands go back to the tab that opened it (an OAuth
// popup that closes itself), else the lease pauses.
function leaseTabClosed(tabId) {
  const entry = leaseTab(tabId);
  if (!entry) return false;
  session.tabs = session.tabs.filter(item => item !== entry);
  if (session.tabId !== tabId) return true;
  const back = leaseTab(entry.opener) ?? session.tabs.at(-1);
  if (!back) return false;
  session.tabId = back.tabId;
  ignore(chrome.tabs.update(back.tabId, { active: true }).catch(() => {}));
  return true;
}

const resolvesWithin = (promise, ms) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), ms);
  promise.then(() => {
    clearTimeout(timer);
    resolve(true);
  });
});

// Watches the tab for a navigation started by the action. Registered before dispatch so no event is missed;
// tabs.onUpdated is backed by a short chrome.tabs.get poll because its 'loading' event can trail the click by
// several hundred milliseconds. `fromTab` is the tab as it was just before dispatch.
function watchNavigation(fromTab) {
  const tabId = fromTab.id;
  const fromUrl = fromTab.url;
  // A tab still loading its first document is not evidence of a new navigation; only a transition counts.
  const wasLoading = fromTab.status === 'loading';
  let started = false;
  let urlChanged = false;
  let complete = false;
  let markChange;
  let markComplete;
  const changePromise = new Promise(resolve => { markChange = resolve; });
  const completePromise = new Promise(resolve => { markComplete = resolve; });
  const note = ({ status, url, pendingUrl }, fromEvent) => {
    if ((status === 'loading' && (fromEvent || !wasLoading)) || (pendingUrl && pendingUrl !== fromUrl)) {
      started = true;
      markChange();
    }
    if (url && url !== fromUrl) {
      urlChanged = true;
      markChange();
    }
    if (status === 'complete' && started && (fromEvent || urlChanged)) {
      complete = true;
      markComplete();
    }
  };
  const listener = (id, info) => {
    if (id === tabId) note(info, true);
  };
  chrome.tabs.onUpdated.addListener(listener);
  const poll = async () => {
    try {
      note(await chrome.tabs.get(tabId), false);
    } catch {
      // A closed tab surfaces as tab_changed on the next page call.
    }
  };
  // Resolves when `signal` resolves or `deadline` passes, polling the tab in between.
  const waitUntil = async (signal, done, deadline) => {
    let settled = false;
    signal.then(() => { settled = true; });
    while (!done() && !settled && Date.now() < deadline) {
      await resolvesWithin(signal, Math.min(NAV_POLL_MS, Math.max(0, deadline - Date.now())));
      if (!done() && !settled) await poll();
    }
    return done();
  };
  return {
    get started() {
      return started;
    },
    get urlChanged() {
      return urlChanged;
    },
    // Waits up to NAV_START_WINDOW_MS after dispatch for a load to start or the URL to change.
    // 'load' when a document load started, 'url' for a same-document URL change, 'none' otherwise.
    async waitStart(dispatchedAt) {
      await waitUntil(changePromise, () => started || urlChanged, dispatchedAt + NAV_START_WINDOW_MS);
      return started ? 'load' : urlChanged ? 'url' : 'none';
    },
    // After a load started: 'complete', or 'cap' at NAV_CAP_MS after dispatch (at least NAV_MIN_LOAD_MS from now).
    async waitLoad(dispatchedAt) {
      const deadline = Math.max(dispatchedAt + NAV_CAP_MS, Date.now() + NAV_MIN_LOAD_MS);
      return (await waitUntil(completePromise, () => complete, deadline)) ? 'complete' : 'cap';
    },
    dispose() {
      chrome.tabs.onUpdated.removeListener(listener);
    },
  };
}

// A viewport point for a point click: finite, non-negative x and y (CSS pixels of the leased tab).
function validPoint(point) {
  return Boolean(point) && typeof point === 'object' && Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.y >= 0;
}

function validateAction(action) {
  if (!action || typeof action !== 'object' || !ACTION_TYPES.has(action.type)) {
    throw new ExtensionError('unsupported', 'Unsupported action');
  }
  if (action.target !== undefined && typeof action.target !== 'string') {
    throw new ExtensionError('unsupported', 'Invalid action target');
  }
  // A point click: a click with a viewport point and no target; page.js runs it only on the control it located.
  if (action.point !== undefined && (action.type !== 'click' || action.target !== undefined || !validPoint(action.point))) {
    throw new ExtensionError('unsupported', 'Invalid point');
  }
  // A click the runtime cleared with Jev: the capability its class needs, on a target (page.js runs it only on a
  // control it marked ambiguous itself, and only when `allow` holds that capability).
  if (action.intentCleared !== undefined && (action.type !== 'click' || action.target === undefined
    || !['controls', 'submit'].includes(action.intentCleared))) {
    throw new ExtensionError('unsupported', 'Invalid cleared click');
  }
  if (['navigate_allowed_url', 'open_tab'].includes(action.type) && !sameSessionSite(action.url)) {
    throw new ExtensionError('cross_origin', 'Navigation outside selected origin');
  }
  if (action.type === 'dismiss_overlay' && (action.target !== undefined || !['escape', 'backdrop'].includes(action.method))) {
    throw new ExtensionError('unsupported', 'Invalid overlay dismissal');
  }
  // An approved action (the Approve gate): bound to a target, never a point (copy_secret names a handle instead).
  if (action.approvalId !== undefined && (!['click', 'fill_secret', 'copy_secret', 'upload'].includes(action.type) || action.point !== undefined
    || (action.type !== 'copy_secret' && action.target === undefined)
    || typeof action.approvalId !== 'string' || action.approvalId.length > 64)) {
    throw new ExtensionError('unsupported', 'Invalid approved click');
  }
  // A secret handle's use: always approved, by handle; a fill on a target, a copy on none. Never a value.
  if (action.type === 'fill_secret' || action.type === 'copy_secret') {
    if (typeof action.handle !== 'string' || !/^\d{1,4}$/.test(action.handle) || typeof action.approvalId !== 'string'
      || action.text !== undefined || (action.type === 'fill_secret') !== (action.target !== undefined)) {
      throw new ExtensionError('unsupported', 'Invalid secret action');
    }
  }
  // Enter in a filled text field: on a target only (page.js gates it as the form submit it is).
  if (action.type === 'submit_field' && action.target === undefined) {
    throw new ExtensionError('unsupported', 'Invalid field submit');
  }
  if (action.type === 'press' && (typeof action.key !== 'string' || action.key.length > 20)) {
    throw new ExtensionError('unsupported', 'Invalid key');
  }
  if (action.type === 'hover' && action.target === undefined) throw new ExtensionError('unsupported', 'Invalid hover');
  if (action.type === 'upload' && (action.target === undefined || !uploadFileInfo(action.file) || typeof action.file.data !== 'string'
    || action.file.data.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 || typeof action.approvalId !== 'string')) {
    throw new ExtensionError('unsupported', 'Invalid upload');
  }
  if (action.type === 'history' && (!HISTORY_MOVES.has(action.move) || action.target !== undefined)) {
    throw new ExtensionError('unsupported', 'Invalid history move');
  }
  if (action.type === 'switch_tab' && (typeof action.tab !== 'string' || !/^t\d{1,3}$/.test(action.tab))) {
    throw new ExtensionError('unsupported', 'Invalid tab');
  }
  if (action.type === 'dialog' && (!['accept', 'dismiss'].includes(action.answer) || (action.text !== undefined
    && (typeof action.text !== 'string' || action.text.length > 5000)))) {
    throw new ExtensionError('unsupported', 'Invalid dialog answer');
  }
  // Typed text (the agent's own, never a supplied value): a plain fill of a string.
  if (action.typed !== undefined && (action.type !== 'fill_supplied_text' || action.typed !== true)) {
    throw new ExtensionError('unsupported', 'Invalid typed fill');
  }
}

// A history move of the leased tab: Chrome's own back, forward or reload. Back and forward go only to an entry of
// the same origin when the page can tell (the Navigation API lists same-origin entries only); without it the landing
// page's origin check pauses the lease as for any navigation off the approved site.
async function historyMove(tabId, move) {
  if (move !== 'reload') {
    const [probe] = await chrome.scripting.executeScript({ target: { tabId }, func: historyProbe, args: [move] }).catch(() => []);
    if (probe?.result === false) throw new ExtensionError('cross_origin', `There is no page to go ${move} to on the approved site`);
  }
  if (move === 'back') await chrome.tabs.goBack(tabId);
  else if (move === 'forward') await chrome.tabs.goForward(tabId);
  else await chrome.tabs.reload(tabId);
}

// In the page: whether the next history entry that way is listed (same origin), or null when the page cannot tell.
function historyProbe(move) {
  const navigation = globalThis.navigation;
  if (!navigation?.entries || !navigation.currentEntry) return null;
  const index = navigation.currentEntry.index + (move === 'back' ? -1 : 1);
  return index >= 0 && index < navigation.entries().length;
}

async function observeCommand(command) {
  const tab = await assertTab();
  const terms = cleanTerms(command.args?.terms);
  if (terms && session) session.terms = terms;
  // Each observe states the run's additions; none means none (a later run never inherits an earlier run's list).
  const forbid = cleanForbid(command.args?.forbid) ?? [];
  if (session) session.forbid = forbid;
  // Each observe states its expectation texts too (none means none); the act that follows keeps them.
  const expectText = cleanExpectText(command.args?.expectText);
  if (session) session.expectText = expectText;
  const allow = commandCapabilities(command);
  const sites = sessionSites();
  const observation = await observePage(tab.id, 'observe', [{ terms: session?.terms ?? [], forbid, allow, sites, expectText }]);
  // Test site: the dialog the page opened since the last read, and the dev logs when the observe asks for them.
  const dev = await devRead(tab.id, command.args?.logs === true);
  return checkedObservation(dev ? { ...observation, ...dev } : observation, tab.id);
}

// The `locate` command (a point click's first half): the control under a viewport point on the expected revision,
// described as an observation control, with its id when it is one of the observed controls. Nothing runs; the
// execute that follows carries the same point and page.js clicks only the element located here.
async function locateCommand(command) {
  const { point, expectedRevision } = command.args ?? {};
  if (!validPoint(point)) throw new ExtensionError('unsupported', 'Invalid point');
  if (typeof expectedRevision !== 'string') throw new ExtensionError('unsupported', 'expectedRevision is required');
  const tab = await assertTab();
  const terms = cleanTerms(command.args?.terms) ?? session.terms ?? [];
  const forbid = cleanForbid(command.args?.forbid) ?? session.forbid ?? [];
  const allow = commandCapabilities(command);
  const sites = sessionSites();
  const found = await callPage(tab.id, 'locate', [{ x: point.x, y: point.y }, expectedRevision, terms, forbid, allow, sites]);
  return { id: typeof found?.id === 'string' ? found.id : null, control: found?.control ?? null };
}

// Settles in the document that is current after a navigation and observes it. A document that is torn down
// under the call (a redirect, or a load that began after the start window) is waited for and observed again.
async function observeAfterNavigation(tabId, terms, forbid = [], allow = [...CAPABILITIES['read-only']], sites = [],
  expectText = []) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await observePage(tabId, 'settleAndObserve', [SETTLE_AFTER_NAVIGATION, terms, forbid, allow, sites, expectText]);
    } catch (error) {
      if (attempt >= 2 || !isTeardown(error)) throw error;
      await waitTabComplete(tabId, NAV_START_WINDOW_MS);
    }
  }
}

// Polls until the tab's current load completes, at most `ms`.
async function waitTabComplete(tabId, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status !== 'loading') return;
    await delay(NAV_POLL_MS);
  }
}

// --- Approve gate (docs/REFERENCE.md "Approve gate") ----------------------------------------------------------
// An agent's act on a gated control (purchase, secret, delete, submit) sends an `approve` command first. The worker
// reads the control from the page itself (page.js approvalInfo: label, label hash, gate class, a detected total),
// opens the toolbar popup or a small top-right fallback window, shows a badge and waits for the user's click. Approve once
// mints a random single-use approvalId bound to the tab, lease, document, revision, target, class and label hash, valid
// for 60 s; Deny refuses. The execute that follows carries the id: only an id this worker minted, unused, unexpired and
// bound to that very dispatch lets page.js run the control (it rechecks the label and class itself). The daemon only
// ever relays ids; it cannot mint one. Settings (chrome.storage.local `approvals`, never config.json): ask before
// purchases, credential actions and actions above the granted level; all on. There is no "always allow".
const APPROVAL_CLASSES = ['purchase', 'secret', 'delete', 'submit'];
const APPROVAL_PENDING_MS = 5 * 60_000;
const APPROVAL_USE_MS = 60_000;
const APPROVAL_MAX_WAIT_MS = 120_000;
const APPROVAL_PROMPT_PAGE = 'approve.html';
const APPROVAL_PROMPT_SIZE = { width: 440, height: 420 };
const MAX_APPROVALS = 20;
let approvalSettings = { purchase: true, secret: true, level: true };
// id -> { id, key, tabId, leaseId, requestId, origin, title, revision, documentId, target, cls, label, labelHash, total,
// note, level, createdAt, expiresAt, status: pending | approved | denied, approvalId, useBy, windowId, waiters }
const approvals = new Map();

// A random id from the platform's secure source (never Math.random): approval ids are the user's consent.
function randomId() {
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('No secure random source');
  return globalThis.crypto.randomUUID();
}

function cleanApprovalSettings(value) {
  return { purchase: value?.purchase !== false, secret: value?.secret !== false, level: value?.level !== false };
}

async function loadApprovalSettings() {
  const saved = await chrome.storage.local.get(['approvals']);
  approvalSettings = cleanApprovalSettings(saved.approvals);
}

// Which setting covers a class: purchases, credential actions, or anything above the granted level.
function approvalSetting(cls) {
  return cls === 'purchase' ? 'purchase' : cls === 'secret' ? 'secret' : 'level';
}

// What the popup card and the approval window show (no label hash, no approvalId, never a secret's value: a secret
// use shows its handle, its placeholder and the origin it came from).
function approvalView(entry) {
  return {
    id: entry.id, requestId: entry.requestId, origin: entry.origin, title: entry.title, cls: entry.cls, label: entry.label,
    ...(entry.total ? { total: entry.total } : {}), ...(entry.note ? { note: entry.note } : {}), level: entry.level,
    ...(entry.kind ? { kind: entry.kind, handle: entry.handle, secret: entry.secret } : {}),
    ...(entry.file ? { file: { ...entry.file } } : {}),
    createdAt: entry.createdAt, expiresAt: entry.expiresAt,
  };
}

function publishApprovals() {
  storeSession({ approvals: [...approvals.values()].filter(entry => entry.status === 'pending').map(approvalView) });
  updateBadge();
}

function closeApprovalWindow(entry) {
  if (!Number.isInteger(entry?.windowId)) return;
  const id = entry.windowId;
  entry.windowId = null;
  ignore(chrome.windows?.remove?.(id));
}

function settleApproval(entry, answer) {
  for (const resolve of entry.waiters) resolve(answer);
  entry.waiters.clear();
}

// Drops approvals past their time (pending: 5 min; approved and unused: 60 s), and with `leaseId` every approval of
// that lease (its session ended).
function expireApprovals(leaseId = null) {
  const now = Date.now();
  for (const entry of [...approvals.values()]) {
    const stale = (entry.status === 'pending' && now > entry.expiresAt) || (entry.status === 'approved' && now > entry.useBy)
      || entry.status === 'denied' && now > entry.expiresAt;
    if (!stale && (leaseId === null || entry.leaseId !== leaseId)) continue;
    approvals.delete(entry.id);
    closeApprovalWindow(entry);
    settleApproval(entry, { decision: entry.status === 'denied' ? 'denied' : 'pending' });
  }
  publishApprovals();
}

async function showApprovalWindow(entry) {
  try {
    if (await openToolbarPopup()) return;
    const created = await createPopupWindow(chrome.runtime.getURL(`${APPROVAL_PROMPT_PAGE}?id=${entry.id}`), APPROVAL_PROMPT_SIZE);
    if (Number.isInteger(created?.id) && approvals.get(entry.id) === entry && entry.status === 'pending') entry.windowId = created.id;
    else if (Number.isInteger(created?.id)) ignore(chrome.windows.remove(created.id));
  } catch {
    // No window: the badge and the popup card still show the request.
  }
}

// The `approve` command: { target, expectedRevision, cls, note?, waitMs, kind?, handle? }. Answers { decision:
// approved (approvalId) | denied | pending (expiresAt) | off (the user's setting does not ask for this class) | refused
// (reason) }. `kind` fill_secret (target: the field) or copy_secret (no target) with `handle` asks to use a secret
// handle's value: always asked, whatever the settings, at every level from reversible.
async function approveCommand(command) {
  const { target, expectedRevision, cls, note, waitMs, kind, handle, file } = command.args ?? {};
  const secretUse = kind === 'fill_secret' || kind === 'copy_secret';
  // An upload (Act and Test site): always asked, whatever the settings; the card names the file and its size.
  const uploadUse = kind === 'upload';
  if (uploadUse && (cls !== 'submit' || !uploadFileInfo(file))) throw new ExtensionError('unsupported', 'Invalid approval request');
  // Accepting a JavaScript dialog whose text is gated (Test site): no control, the dialog's own text is what the
  // user approves.
  const dialogUse = kind === 'dialog';
  if ((kind !== undefined && kind !== null && !secretUse && !dialogUse && !uploadUse) || (secretUse && (cls !== 'secret' || typeof handle !== 'string' || !/^\d{1,4}$/.test(handle)))) {
    throw new ExtensionError('unsupported', 'Invalid approval request');
  }
  const targetless = kind === 'copy_secret' || dialogUse;
  if ((!targetless && (typeof target !== 'string' || target.length > 8)) || (targetless && target !== undefined)
    || typeof expectedRevision !== 'string' || !APPROVAL_CLASSES.includes(cls)) {
    throw new ExtensionError('unsupported', 'Invalid approval request');
  }
  const tab = await assertTab();
  const level = grantedLevel() ?? 'read-only';
  // Never at read-only; a purchase only from Full (purchases otherwise stay the user's own job outside testing).
  if (level === 'read-only') return { decision: 'refused', reason: 'read_only' };
  if (cls === 'purchase' && !['full', 'testing'].includes(level)) return { decision: 'refused', reason: 'level' };
  if (uploadUse && !['full', 'testing'].includes(level)) return { decision: 'refused', reason: 'level' };
  if (dialogUse && (grantedLevel() !== 'testing' || !DIALOG_GATED.test(session.lastDialog?.text ?? ''))) {
    return { decision: 'refused', reason: 'class_mismatch' };
  }
  if (!secretUse && !dialogUse && !uploadUse && !approvalSettings[approvalSetting(cls)]) return { decision: 'off' };
  const secret = secretUse ? vaultEntry(handle) : null;
  if (secretUse && !secret) return { decision: 'refused', reason: 'unknown_secret' };
  // A copy names no control: what the user approves is the handle itself.
  const info = dialogUse
    ? { revision: expectedRevision, documentId: null, label: session.lastDialog.text, labelHash: `dialog:${session.lastDialog.text}`, cls }
    : kind === 'copy_secret'
    ? { revision: expectedRevision, documentId: null, label: '', labelHash: '', cls: 'secret' }
    : await callPage(tab.id, 'approvalInfo', [target, expectedRevision, kind ?? null]);
  // The page script must classify the control the same way: the daemon cannot pick the class the user sees.
  if (info?.cls !== cls || typeof info.labelHash !== 'string') return { decision: 'refused', reason: 'class_mismatch' };
  expireApprovals();
  const upload = uploadUse ? uploadFileInfo(file) : null;
  const key = [tab.id, session.leaseId, info.revision, target ?? '', cls, info.labelHash, kind ?? 'click', handle ?? '',
    upload ? `${upload.name}:${upload.size}` : ''].join('|');
  let entry = [...approvals.values()].find(item => item.key === key);
  if (entry?.status === 'approved') return { decision: 'approved', approvalId: entry.approvalId };
  if (entry?.status === 'denied') return { decision: 'denied' };
  if (!entry) {
    if (approvals.size >= MAX_APPROVALS) return { decision: 'refused', reason: 'too_many' };
    const now = Date.now();
    entry = {
      id: randomId(), key, tabId: tab.id, leaseId: session.leaseId, requestId: session.requestId ?? null,
      origin: session.origin, title: reportedText(String(tab.title ?? '')).slice(0, 120), revision: info.revision,
      documentId: info.documentId, target, cls, label: String(info.label ?? '').slice(0, 200), labelHash: info.labelHash,
      total: typeof info.total === 'string' ? info.total.slice(0, 120) : null,
      note: typeof note === 'string' && note.trim() ? reportedText(note.replace(/\s+/g, ' ').trim()).slice(0, 200) : null,
      level, createdAt: now, expiresAt: now + APPROVAL_PENDING_MS, status: 'pending', approvalId: null, useBy: 0,
      windowId: null, waiters: new Set(),
      // A secret use: the handle, and what the card shows of it (its placeholder and the origin it came from).
      kind: secretUse || dialogUse || uploadUse ? kind : null, handle: secretUse ? handle : null,
      // An upload: the file's name and size the user approves (the bytes are checked against them at execute).
      file: upload,
      secret: secretUse ? { label: secretPlaceholder(handle, secret.kind, secret.value, secret.pre), kind: secret.kind, from: secret.origin } : null,
    };
    approvals.set(entry.id, entry);
    publishApprovals();
  }
  if (!Number.isInteger(entry.windowId)) await showApprovalWindow(entry);
  const room = Math.min(APPROVAL_MAX_WAIT_MS, Number.isFinite(waitMs) ? Math.max(0, waitMs) : 0,
    Math.max(0, command.deadline - Date.now() - 1_000));
  return new Promise(resolve => {
    const done = answer => {
      clearTimeout(timer);
      entry.waiters.delete(done);
      resolve(answer);
    };
    const timer = setTimeout(() => done({ decision: 'pending', expiresAt: entry.expiresAt }), room);
    entry.waiters.add(done);
  });
}

// The user's click in the approval window or on the popup card.
function decideApproval(id, decision) {
  const entry = approvals.get(id);
  if (!entry || entry.status !== 'pending' || Date.now() > entry.expiresAt) throw new Error('This action is no longer waiting for approval.');
  if (decision === 'approve') {
    entry.status = 'approved';
    entry.approvalId = randomId();
    entry.useBy = Date.now() + APPROVAL_USE_MS;
    settleApproval(entry, { decision: 'approved', approvalId: entry.approvalId });
  } else {
    entry.status = 'denied';
    settleApproval(entry, { decision: 'denied' });
  }
  closeApprovalWindow(entry);
  publishApprovals();
}

// The approval an execute carries, checked against what the user approved: minted here, approved, unused, within its
// 60 s, for this tab, lease, revision and target. Spent before the dispatch. Returns what page.js rechecks.
function takeApproval(action, expectedRevision, tab) {
  const entry = [...approvals.values()].find(item => item.approvalId !== null && item.approvalId === action.approvalId);
  if (!entry || entry.status !== 'approved') throw new ExtensionError('blocked_risky', 'This action has no approval from the user');
  approvals.delete(entry.id);
  publishApprovals();
  if (Date.now() > entry.useBy) throw new ExtensionError('blocked_risky', 'The approval expired');
  // The approval names the action kind (a click, a secret fill or copy) and, for a secret use, the handle.
  const kind = action.type === 'click' ? null : action.type;
  if (entry.tabId !== tab.id || entry.leaseId !== session.leaseId || (entry.target ?? undefined) !== action.target
    || (entry.kind ?? null) !== kind || (entry.handle ?? undefined) !== action.handle) {
    throw new ExtensionError('blocked_risky', 'The approval was for another action');
  }
  if (entry.revision !== expectedRevision) throw new ExtensionError('stale', 'The page changed since the user approved this action');
  // An upload runs only the file the user approved: its name, and bytes of the size the card showed.
  if (kind === 'upload') {
    const given = uploadFileInfo(action.file);
    const bytes = typeof action.file?.data === 'string' ? Math.floor(action.file.data.replace(/=+$/, '').length * 3 / 4) : -1;
    if (!given || !entry.file || given.name !== entry.file.name || given.size !== entry.file.size || bytes !== entry.file.size) {
      throw new ExtensionError('blocked_risky', 'The approval was for another file');
    }
  }
  return { target: entry.target, cls: entry.cls, labelHash: entry.labelHash, ...(kind ? { kind } : {}) };
}

// The clipboard, written from an extension context only: the offscreen document on Chromium (reason CLIPBOARD), the
// background page itself where there are no offscreen documents (Firefox). Never from the page.
async function writeClipboard(text) {
  // A real offscreen document (Chromium). Firefox's background is a page: its own navigator.clipboard (with
  // clipboardWrite) first, compat.js's offscreen frame stand-in (`polyfill`) only when that is missing.
  const realOffscreen = chrome.offscreen?.createDocument && chrome.offscreen.polyfill !== true;
  if (!realOffscreen && typeof globalThis.navigator?.clipboard?.writeText === 'function' && typeof globalThis.document !== 'undefined') {
    await globalThis.navigator.clipboard.writeText(text);
    return;
  }
  if (chrome.offscreen?.createDocument) {
    await ensureOffscreen();
    const reply = await chrome.runtime.sendMessage({ type: 'clipboard_write', text });
    if (reply?.ok !== true) throw new ExtensionError('failed', 'Could not write to the clipboard');
    return;
  }
  if (typeof globalThis.navigator?.clipboard?.writeText === 'function') {
    await globalThis.navigator.clipboard.writeText(text);
    return;
  }
  throw new ExtensionError('unsupported', 'This browser gives the extension no clipboard access');
}

async function executeCommand(command) {
  const { action, expectedRevision, capture } = command.args ?? {};
  validateAction(action);
  if (['open_tab', 'switch_tab'].includes(action.type) && (command.lease?.tabMode !== 'multiple'
    || session?.tabMode !== 'multiple' || tabMode !== 'multiple')) {
    throw new ExtensionError('blocked_risky', 'This request allows one task tab');
  }
  if (typeof expectedRevision !== 'string') throw new ExtensionError('unsupported', 'expectedRevision is required');
  if (cancelled.has(command.id)) throw new ExtensionError('timeout', 'Command cancelled');
  const { valid } = await send('validate', { id: command.id, leaseId: session.leaseId });
  if (!valid || cancelled.has(command.id)) throw new ExtensionError('timeout', 'Command cancelled or expired');
  await captureGate;
  const tab = await assertTab();
  // Validation can become obsolete while capture or the tab API is pending.
  checkCommand(command);
  if (cancelled.has(command.id)) throw new ExtensionError('timeout', 'Command cancelled');
  // The terms the decision's observation was ordered with, so control ids resolve the same way.
  const terms = cleanTerms(command.args?.terms) ?? session.terms ?? [];
  // The run's guardrail additions, so the page script refuses those controls at dispatch and on the next page.
  const forbid = cleanForbid(command.args?.forbid) ?? session.forbid ?? [];
  // What page.js may dispatch: the command's level clamped to the user's grant.
  const allow = commandCapabilities(command);
  // The approved domain roots: page.js follows a link to another https subdomain only within one of them.
  const sites = sessionSites();
  // The run's expectation texts, from its last observe.
  const expectText = session.expectText ?? [];
  // The Approve gate: an approval this worker minted for exactly this click, spent now (takeApproval).
  const approval = action.approvalId !== undefined ? takeApproval(action, expectedRevision, tab) : null;
  const { approvalId: _approvalId, handle: _handle, ...pageAction } = action;
  // A secret use: the handle's value from the vault, into the one approved field (page.js) or onto the clipboard.
  const secret = action.type === 'fill_secret' || action.type === 'copy_secret' ? vaultEntry(action.handle) : null;
  if ((action.type === 'fill_secret' || action.type === 'copy_secret') && !secret) {
    throw new ExtensionError('blocked_risky', 'That secret handle is no longer available');
  }
  if (action.type === 'fill_secret') pageAction.text = secret.value;
  const navigation = watchNavigation(tab);
  const dispatchedAt = Date.now();
  try {
    let outcome;
    let navigated = false;
    if (action.type === 'copy_secret') {
      await writeClipboard(secret.value);
      const observation = await observePage(tab.id, 'observe', [{ terms, forbid, allow, sites, expectText }]);
      outcome = { observation, settle: { reason: 'none' }, fromUrl: reportedUrl(tab.url), target: null };
    } else if (action.type === 'wait') {
      await delay(WAIT_ACTION_MS);
      const observation = await observePage(tab.id, 'observe', [{ terms, forbid, allow, sites, expectText }]);
      outcome = { observation, settle: { reason: 'none' }, fromUrl: reportedUrl(tab.url), target: null };
    } else if (action.type === 'history') {
      // Navigation (read-only and up), outside the page: the tab's own history.
      if (!allow.includes('navigate')) throw new ExtensionError('blocked_risky', 'Navigation is not allowed at this level');
      await historyMove(tab.id, action.move);
      const start = await navigation.waitStart(dispatchedAt);
      const loaded = start === 'load' ? await navigation.waitLoad(dispatchedAt) : 'none';
      const after = await observeAfterNavigation(tab.id, terms, forbid, allow, sites, expectText);
      navigated = start !== 'none';
      outcome = { observation: after.observation, settle: { reason: loaded === 'complete' ? 'load_complete' : after.settle.reason },
        fromUrl: reportedUrl(tab.url), target: null };
    } else if (action.type === 'dialog') {
      // Arms the answer for the page's next confirm or prompt (the hook answers it at once when it opens).
      await armDialog(tab.id, action.answer, action.text, approval);
      const observation = await observePage(tab.id, 'observe', [{ terms, forbid, allow, sites, expectText }]);
      outcome = { observation, settle: { reason: 'none' }, fromUrl: reportedUrl(tab.url), target: null };
    } else if (action.type === 'switch_tab' || action.type === 'open_tab') {
      if (!allow.includes('navigate')) throw new ExtensionError('blocked_risky', 'Navigation is not allowed at this level');
      const next = action.type === 'open_tab' ? await openLeaseTab(action.url) : await switchLeaseTab(action.tab);
      const observation = await observePage(next.id, 'observe', [{ terms, forbid, allow, sites, expectText }]);
      outcome = { observation, settle: { reason: 'none' }, fromUrl: reportedUrl(tab.url), target: null };
      navigated = true;
    } else {
      try {
        // Validate, dispatch, settle in place and observe in a single round trip.
        outcome = await callPage(tab.id, 'execute', [pageAction, expectedRevision, SETTLE_IN_PLACE, terms, forbid, allow, sites,
          expectText, approval]);
      } catch (error) {
        if (error?.browserErrorPage && action.type === 'navigate_allowed_url') {
          // From the browser's own error page an approved URL (validateAction checked it) opens through the tab API,
          // as a history move does: page.js cannot run there. Any other page action fails this command only.
          if (!allow.includes('navigate')) throw new ExtensionError('blocked_risky', 'Navigation is not allowed at this level');
          // The action must come from an observation of this error page (its revision), as page.js would check.
          if (expectedRevision !== browserErrorRevision(tab.url)) throw new ExtensionError('stale', 'Stale observation');
          await chrome.tabs.update(tab.id, { url: new URL(action.url).href });
        } else {
          // A click that navigates tears the document down under the call ("Page returned no result", "message
          // port closed", ...). That is success if a navigation shows up within the start window.
          if (!isTeardown(error)) throw error;
          if (!navigation.started && !navigation.urlChanged && (await navigation.waitStart(dispatchedAt)) === 'none') {
            throw error;
          }
        }
        outcome = { expectNavigation: true, fromUrl: reportedUrl(tab.url), target: null };
      }
      if (outcome.expectNavigation || navigation.started) {
        const start = navigation.started ? 'load' : await navigation.waitStart(dispatchedAt);
        const loaded = start === 'load' ? await navigation.waitLoad(dispatchedAt) : 'none';
        const after = await observeAfterNavigation(tab.id, terms, forbid, allow, sites, expectText);
        const reason = loaded === 'complete' ? 'load_complete' : loaded === 'cap' ? 'cap' : after.settle.reason;
        navigated = start !== 'none' || navigation.started || navigation.urlChanged;
        outcome = { ...outcome, observation: after.observation, settle: { reason } };
      }
    }
    // The action opened a tab the lease followed (a link to a new tab or a popup on the approved origins): its page is
    // the outcome. A child the extension cannot read (no host access to it) pauses the lease for the user, as before.
    if (session?.childFollow) await resolvesWithin(session.childFollow, CHILD_URL_WAIT_MS);
    if (session?.status === 'active' && session.tabId !== tab.id && leaseTab(session.tabId)) {
      const childId = session.tabId;
      await waitTabComplete(childId, NAV_START_WINDOW_MS * 4);
      let after;
      try {
        after = await observeAfterNavigation(childId, terms, forbid, allow, sites, expectText);
      } catch (error) {
        await endSession('paused', 'child_tab');
        throw new ExtensionError('child_tab', `The new tab cannot be read: ${String(error?.message ?? error).slice(0, 120)}`);
      }
      outcome = { ...outcome, observation: after.observation, settle: { reason: 'child_tab' } };
      navigated = true;
    }
    if (action.type === 'fill_supplied_text' && (action.sensitive === true || outcome.target?.type === 'password')) {
      rememberSensitive(action.text);
    }
    // A secret's value is never drawn on a screenshot annotation either.
    if (secret) rememberSensitive(secret.value);
    // Test site: a JavaScript dialog the action made the page open (answered by the hook at once).
    const dev = action.type === 'dialog' ? null : await devRead(session?.tabId ?? tab.id, false);
    const observation = checkedObservation(dev?.dialog ? { ...outcome.observation, dialog: dev.dialog } : outcome.observation,
      session?.tabId ?? tab.id);
    navigated ||= Boolean(outcome.fromUrl) && observation.url !== outcome.fromUrl;
    const settle = { reason: outcome.settle.reason, ms: Date.now() - dispatchedAt };
    if (navigated) Object.assign(settle, { navigated: true, url: observation.url });
    const shown = action.type === 'upload' ? { ...action, file: uploadFileInfo(action.file) } : action;
    const captureDetails = capture ? { action: shown, target: outcome.target, fromUrl: outcome.fromUrl } : null;
    // A fill's read-back (booleans only); a secret fill names what the field holds by its handle, never its value.
    const kept = outcome.fill && typeof outcome.fill.kept === 'boolean' ? { kept: outcome.fill.kept, empty: outcome.fill.empty === true } : null;
    const fill = kept && action.type === 'fill_secret' ? { ...kept, holds: `[secret:${action.handle}]` } : kept;
    return { observation, settle, navigated, captureDetails, ...(fill ? { fill } : {}) };
  } finally {
    navigation.dispose();
  }
}

function rememberSensitive(text) {
  if (typeof text !== 'string' || text.length < SENSITIVE_MIN_LENGTH) return;
  sensitiveTexts.delete(text);
  sensitiveTexts.add(text);
  while (sensitiveTexts.size > SENSITIVE_MAX) sensitiveTexts.delete(sensitiveTexts.values().next().value);
}

// A copy of an annotation payload part with every remembered secret replaced in its strings, and without the text
// of a fill (the caption never draws it). Data URLs are left alone.
function scrubAnnotation(value) {
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return value;
    let out = value;
    for (const secret of sensitiveTexts) if (out.includes(secret)) out = out.split(secret).join('[redacted]');
    return out;
  }
  if (Array.isArray(value)) return value.map(scrubAnnotation);
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) copy[key] = scrubAnnotation(item);
  return copy;
}

function annotationAction(action) {
  if (!action || typeof action !== 'object') return action ?? null;
  const { text, ...rest } = action;
  return scrubAnnotation(rest);
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreen ??= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS', 'CLIPBOARD'],
    justification: 'Annotate captured browser evidence; copy a secret the user approved to the clipboard',
  }).finally(() => {
    creatingOffscreen = null;
  });
  await creatingOffscreen;
}

// --- screenshot redaction (docs/REFERENCE.md "Screenshot redaction") ------------------------------------------
// The secret boxes are asked of page.js right before and right after captureVisibleTab, with its dirty watch armed in
// between; the image gets the union of both sets. A frame that changed meanwhile (dirty, or boxes that moved) is taken
// again once; still unstable, or a scan that could not look at everything, and the whole frame is filled solid black
// (`withheld`). A query that fails or does not answer in time means no image at all (fail closed).
const REDACT_QUERY_MS = 2_000;
const REDACT_TOLERANCE_PX = 2;

function redactionQuery(tabId, arm) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ExtensionError('capture_failed', 'Secret boxes did not arrive in time')), REDACT_QUERY_MS);
    callPage(tabId, 'redactionRects', [{ arm }]).then(value => {
      clearTimeout(timer);
      if (!value || !Array.isArray(value.rects) || !value.viewport) {
        reject(new ExtensionError('capture_failed', 'Malformed secret boxes'));
        return;
      }
      resolve(value);
    }, error => {
      clearTimeout(timer);
      reject(new ExtensionError('capture_failed', `Secret boxes unavailable: ${String(error?.message || error).slice(0, 200)}`));
    });
  });
}

function cleanRect(rect) {
  const numbers = ['x', 'y', 'width', 'height'].map(key => Number(rect?.[key]));
  if (!numbers.every(Number.isFinite)) return null;
  const [x, y, width, height] = numbers;
  const out = { x, y, width, height };
  // A holder's tag, numbered like the text ("[secret:3]"); nothing else is ever drawn.
  if (typeof rect.label === 'string' && /^\[secret:\d{1,6}\]$/.test(rect.label)) out.label = rect.label;
  return out;
}

function sameRects(a, b) {
  if (a.length !== b.length) return false;
  const near = (p, q) => Math.abs(p.x - q.x) <= REDACT_TOLERANCE_PX && Math.abs(p.y - q.y) <= REDACT_TOLERANCE_PX
    && Math.abs(p.width - q.width) <= REDACT_TOLERANCE_PX && Math.abs(p.height - q.height) <= REDACT_TOLERANCE_PX;
  return a.every(rect => b.some(other => near(rect, other)));
}

// One capture of the leased tab with the boxes to fill: { raw, redaction: { rects, viewport, withheld } }.
async function captureRedacted(tab) {
  for (let attempt = 0; ; attempt++) {
    if (attempt) await delay(Math.max(0, CAPTURE_SPACING_MS - (Date.now() - lastCapture)));
    const before = await redactionQuery(tab.id, true);
    const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    lastCapture = Date.now();
    const after = await redactionQuery(tab.id, false);
    const first = before.rects.map(cleanRect);
    const second = after.rects.map(cleanRect);
    if (first.includes(null) || second.includes(null)) throw new ExtensionError('capture_failed', 'Malformed secret boxes');
    const incomplete = before.incomplete === true || after.incomplete === true;
    const sameView = before.viewport.width === after.viewport.width && before.viewport.height === after.viewport.height
      && before.viewport.dpr === after.viewport.dpr && before.scroll?.x === after.scroll?.x && before.scroll?.y === after.scroll?.y;
    const stable = after.dirty === false && sameView && !incomplete && sameRects(first, second);
    if (stable || incomplete || attempt >= 1) {
      // The union: whatever either query boxed is filled (a duplicate costs nothing).
      const rects = [...first, ...second.filter(rect => !first.some(other => sameRects([rect], [other])))];
      return { raw, redaction: { rects, viewport: after.viewport, withheld: !stable } };
    }
  }
}

// Captures, annotates and returns one screenshot of the leased tab. Holds the capture gate until the frame is
// taken, so an execute can never change the page between the revision check and captureVisibleTab().
// `observation` is the post-action observation the image should match, or null to label the current page.
// `details.labels` (control ref -> action ids) are drawn only on the revision they were made for: that observation's,
// or `labelRevision` for a capture of the current page.
async function takeScreenshot(observation, details, labelRevision = observation?.revision ?? null) {
  let releaseGate;
  const previousGate = captureGate;
  captureGate = new Promise(resolve => { releaseGate = resolve; });
  const started = Date.now();
  try {
    await previousGate;
    await delay(Math.max(0, CAPTURE_SPACING_MS - (Date.now() - lastCapture)));
    const waited = Date.now();
    // captureVisibleTab captures whatever tab is active in the window, so the tab check is required here.
    const tab = await assertTab();
    // The single revision check, immediately before capture. If the page changed by itself, annotate what
    // is actually on screen and label it with that revision; the runtime decides whether it is acceptable.
    const fresh = checkedObservation(await callPage(tab.id, 'observe').catch(error => {
      // The browser's own error page: no page script to ask for secret boxes, so no image (fail closed).
      throw error?.browserErrorPage ? new ExtensionError('capture_failed', BROWSER_ERROR_MESSAGE) : error;
    }), tab.id);
    const shown = observation && fresh.revision === observation.revision ? observation : fresh;
    const { raw, redaction } = await captureRedacted(tab);
    releaseGate();
    await ensureOffscreen();
    // Action-id tags are drawn only when the frame shows the revision they were made for: on another revision
    // the ids would name controls of a page the host has not seen.
    const labels = details.labels && (labelRevision === null || shown.revision === labelRevision) ? details.labels : undefined;
    const annotated = await chrome.runtime.sendMessage({
      type: 'annotate',
      dataUrl: raw,
      observation: sensitiveTexts.size ? scrubAnnotation(shown) : shown,
      action: annotationAction(details.action),
      target: scrubAnnotation(details.target),
      fromUrl: scrubAnnotation(reportedUrl(details.fromUrl)),
      ...(labels ? { labels } : {}),
      redact: redaction,
    });
    if (!annotated || annotated.error) throw new Error(annotated?.error || 'Annotation failed');
    // The offscreen document must confirm it drew every box (or withheld the frame): anything else is no image.
    if (annotated.redactions !== redaction.rects.length || annotated.withheld !== redaction.withheld) {
      throw new Error('Redaction was not applied');
    }
    return {
      dataUrl: annotated.dataUrl,
      revision: shown.revision,
      format: 'jpeg',
      ms: Date.now() - started,
      width: annotated.width,
      height: annotated.height,
      // How many boxes hide secrets on the image, and `withheld` when the page would not hold still long enough to
      // trust the boxes (the whole frame is filled solid black).
      redactions: redaction.rects.length,
      ...(redaction.withheld ? { redaction: 'withheld' } : {}),
      ...(Array.isArray(annotated.tags) ? { tags: annotated.tags } : {}),
      timings: {
        spacingWaitMs: waited - started,
        captureMs: lastCapture - waited,
        ...annotated.timings,
        encoder: annotated.encoder,
      },
    };
  } finally {
    releaseGate();
  }
}

// Captures after the observation has already been returned. Never throws: failures are reported as
// capture_failed in a `screenshot` message and never fail the action.
function startCapture(commandId, observation, details) {
  takeScreenshot(observation, details).then(
    screenshot => send('screenshot', { id: commandId, screenshot }),
    error => {
      const failure = { code: 'capture_failed', message: String(error?.message || error).slice(0, 500) };
      return send('screenshot', { id: commandId, error: failure });
    },
  ).catch(() => {});
}

// Action-id labels for the capture's badges: control ref -> offered action ids ("a12"), at most MAX_LABELS refs of at
// most 24 ids each. The ids are drawn as given (they match ACTION_ID, never page text). null when absent or malformed.
const MAX_LABELS = 300;
const ACTION_ID = /^a\d{1,4}$/;
function cleanLabels(labels) {
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return null;
  const out = {};
  for (const [ref, ids] of Object.entries(labels).slice(0, MAX_LABELS)) {
    if (typeof ref !== 'string' || ref.length > 8 || !Array.isArray(ids)) continue;
    const clean = ids.filter(id => typeof id === 'string' && ACTION_ID.test(id)).slice(0, 24);
    if (clean.length) out[ref] = clean;
  }
  return Object.keys(out).length ? out : null;
}

// The `capture` command (capture policy 'last', and observe evidence): screenshot the page as it is now,
// annotated with the action the runtime names, or labelled "Observation" when `action` is null. Only the closed
// action vocabulary and a ref/label pair are accepted; the label is drawn, never executed. With `labels` (control
// ref -> offered action ids) the badges read the action ids instead of the refs, and only offered controls are boxed.
// The frame is taken under `revision` when given: it must still be the page the labels were made for.
async function captureCommand(command) {
  const { action, target, fromUrl, labels, revision } = command.args ?? {};
  if (action !== null && (!action || typeof action !== 'object' || !ACTION_TYPES.has(action.type))) {
    throw new ExtensionError('unsupported', 'Unsupported action');
  }
  const cleanedLabels = cleanLabels(labels);
  const details = {
    ...(cleanedLabels ? { labels: cleanedLabels } : {}),
    action: action === null ? null : {
      type: action.type,
      ...(typeof action.target === 'string' ? { target: action.target } : {}),
      ...(typeof action.value === 'string' ? { value: action.value } : {}),
      ...(action.direction === 'up' || action.direction === 'down' ? { direction: action.direction } : {}),
    },
    target: target && typeof target === 'object'
      ? { id: String(target.id ?? ''), label: String(target.label ?? '').slice(0, 300) }
      : null,
    fromUrl: typeof fromUrl === 'string' ? fromUrl : undefined,
  };
  // The revision the labels belong to; the capture reports the revision it shows either way.
  const labelRevision = cleanedLabels && typeof revision === 'string' && revision ? revision : null;
  try {
    return { screenshot: await takeScreenshot(null, details, labelRevision) };
  } catch (error) {
    if (error instanceof ExtensionError && error.code !== 'capture_failed') throw error;
    throw new ExtensionError('capture_failed', String(error?.message || error));
  }
}

function wireError(error) {
  let code = error instanceof ExtensionError ? error.code : null;
  const message = String(error?.message || error).slice(0, 500);
  if (!code) {
    if (/No tab with id|Tabs cannot be edited/i.test(message)) code = 'tab_changed';
    // The browser's own error page on the approved URL is not an origin change (assertTab already checked the URL).
    else if (BROWSER_ERROR_PAGE.test(message)) code = 'target_unavailable';
    else if (/Cannot access|host permission|chrome:\/\//i.test(message)) code = 'origin_changed';
    else code = 'unsupported';
  }
  if (!KNOWN_CODES.has(code)) code = 'unsupported';
  return { code, message, recoverable: RECOVERABLE.has(code) };
}


function checkCommand(command) {
  if (command?.version !== PROTOCOL_VERSION) throw new ExtensionError('unsupported', 'Unsupported protocol version');
  if (session?.status !== 'active') throw inactiveError();
  if (command.lease?.tabId !== (session.homeTabId ?? session.tabId) || command.lease?.id !== session.leaseId) {
    throw new ExtensionError('session_inactive', 'Invalid tab lease');
  }
  if (Array.isArray(command.allowedOrigins) && !originCovered(session.origin, command.allowedOrigins)) {
    throw new ExtensionError('cross_origin', 'Selected tab origin is not approved for this command');
  }
  if (!(Date.now() <= command.deadline)) throw new ExtensionError('timeout', 'Command expired');
}

async function handleCommand(command) {
  const current = session;
  let reply;
  let endReason = null;
  try {
    checkCommand(command);
    if (command.method === 'observe') {
      reply = { id: command.id, result: await observeCommand(command) };
    } else if (command.method === 'execute') {
      const { observation, settle, navigated, captureDetails, fill } = await executeCommand(command);
      // Following a navigation can keep a command busy for seconds. One cancelled meanwhile, or whose session
      // ended or changed, reports no navigation and starts no capture.
      if (cancelled.has(command.id) || session !== current || session?.status !== 'active') {
        throw new ExtensionError('timeout', 'Command cancelled or expired');
      }
      checkCommand(command);
      // Start capture before sending the result so the next execute, which can only arrive after the result,
      // already sees the capture gate.
      if (captureDetails) startCapture(command.id, observation, captureDetails);
      // A navigation is reported at the top level and inside `settle` (the field the bridge forwards).
      reply = { id: command.id, result: { observation, settle, ...(navigated ? { navigated: true, url: observation.url } : {}),
        ...(fill ? { fill } : {}) } };
    } else if (command.method === 'capture') {
      reply = { id: command.id, result: await captureCommand(command) };
    } else if (command.method === 'locate') {
      reply = { id: command.id, result: await locateCommand(command) };
    } else if (command.method === 'approve') {
      reply = { id: command.id, result: await approveCommand(command) };
    } else {
      throw new ExtensionError('unsupported', 'Unsupported command');
    }
  } catch (error) {
    const wire = wireError(error);
    reply = { id: command?.id, error: wire };
    if (SESSION_ENDING_ERRORS.has(wire.code)) endReason = wire.code;
  }
  cancelled.delete(command?.id);
  await send('result', reply).catch(() => {});
  if (endReason && session === current && current?.status === 'active') await endSession('paused', endReason);
}

// Without an explicit request (the legacy "Select tab and start" button), a daemon gets the oldest pending
// request that asked for this tab's origin, else a paused one to resume.
function pickRequest(origin) {
  const matching = state => requests
    .filter(item => item.state === state && Array.isArray(item.origins) && originCovered(origin, item.origins))
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  return matching('pending')[0]?.requestId ?? matching('paused')[0]?.requestId ?? null;
}

// Open a fresh task tab in the most recently focused normal, non-private window. Approval popups must never
// become task windows, and a private window must never inherit an ordinary request. Creating a tab grants no
// page access: the icon click still approves it. The existing active-tab guard pauses work if the user switches tabs.
async function openTaskTab(url) {
  const suitable = win => Number.isInteger(win?.id) && win.id >= 0 && win.type === 'normal' && !win.incognito;
  let win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (!suitable(win)) {
    const candidates = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
    win = candidates.find(candidate => suitable(candidate) && candidate.focused) ?? candidates.find(suitable);
  }
  if (suitable(win)) {
    // A window can close between lookup and create; only a failed create falls back to a new window.
    const tab = await chrome.tabs.create({ windowId: win.id, url, active: true }).catch(() => null);
    if (Number.isInteger(tab?.id)) {
      await ignore(chrome.windows.update(win.id, { focused: true }));
      return { tab, window: win };
    }
  }
  const created = await chrome.windows.create({ url, focused: true });
  const tab = created?.tabs?.[0];
  if (!tab?.id) throw new Error('Could not open the page.');
  return { tab, window: created };
}

// The popup click is the activeTab gesture: the active tab at this moment is bound to the chosen request. `given` is
// a tab the worker already holds activeTab on (the toolbar icon click on an armed tab, or the live session's own tab).
async function startSession(message, given = null) {
  const next = validPairing(message.endpoint ?? pairing?.endpoint, message.secret ?? pairing?.secret);
  if (!next) {
    serviceEndpoint(message.endpoint ?? pairing?.endpoint ?? '');
    throw new Error('Enter the pairing secret once to connect.');
  }
  await chrome.storage.local.set({ endpoint: next.endpoint, secret: next.secret });
  await usePairing(next);
  if (!connected) await waitForAttempt(CONNECT_WAIT_MS);
  let requestId = typeof message.requestId === 'string' ? message.requestId : null;
  const [tab] = given ? [given] : await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error('Select an HTTP page');
  const origin = new URL(tab.url).origin;
  if (!requestId) requestId = pickRequest(origin);
  // The level the user picked on the request card. Anything unknown or missing is read-only.
  const level = cleanLevel(message.level) ?? 'read-only';
  if (level === 'testing') {
    // Re-checked here, not only in the popup: testing needs a known request whose every origin, and this tab's
    // origin, is a listed testing environment, read fresh from storage.
    const listed = await loadTestingOrigins();
    const request = requests.find(item => item.requestId === requestId);
    if (!request || !allListed(request.origins, listed) || !listed.includes(origin)) {
      throw new Error('Testing mode needs every requested origin listed under Testing environments.');
    }
  }
  // Site scope for a request with domain roots: `domain` only when the user chose "All of <root>" on the card and
  // Chrome holds the host permission for every root (the popup requested it inside the Approve click); checked here,
  // never taken from the popup's word. Otherwise `origin`: the tab's exact origin stands in for the roots.
  const request = requests.find(item => item.requestId === requestId);
  const askedSites = (Array.isArray(request?.origins) ? request.origins : []).filter(entry => siteRoot(entry));
  const askedPatterns = askedSites.map(entry => sitePattern(siteRoot(entry)));
  const requestedTabs = cleanTabMode(message.tabMode);
  const liveSettings = await chrome.storage.local.get(['tabMode']);
  const taskPattern = taskOriginPattern(origin);
  const approvedTabMode = requestedTabs === 'multiple' && liveSettings.tabMode === 'multiple'
    && await hasSitePermission([taskPattern]) ? 'multiple' : 'single';
  if (requestedTabs === 'multiple' && approvedTabMode !== 'multiple') {
    recentGrants.delete(taskPattern);
    ignore(reconcileSites());
    throw new Error('Multiple task tabs needs browser site access. Allow access, or choose One task tab and approve again.');
  }
  let scope = 'origin';
  let data;
  // This approval claims (or declines) what the popup obtained for it: pending until the session holds it.
  const settlePending = () => {
    pendingPatterns = [];
    for (const pattern of [...askedPatterns, taskPattern]) recentGrants.delete(pattern);
  };
  pendingPatterns = approvedTabMode === 'multiple' ? [taskPattern] : [];
  try {
    if (message.scope === 'domain' && askedPatterns.length) {
      pendingPatterns = [...pendingPatterns, ...askedPatterns];
      if (await hasSitePermission(askedPatterns)) scope = 'domain';
    }
    const asked = askedSites.length ? { scope } : {};
    if (given?.approvalGuard) await given.approvalGuard();
    data = await send('lease', { requestId, tabId: tab.id, origin, title: reportedText(String(tab.title ?? '').slice(0, 300)), level, tabMode: approvedTabMode, ...asked });
  } catch (error) {
    settlePending();
    // A failed start (refused lease, daemon unreachable) never leaves the permission it just obtained behind.
    ignore(reconcileSites());
    throw error;
  }
  const leaseOrigins = Array.isArray(data.origins) ? data.origins.filter(item => typeof item === 'string') : [origin];
  if (level === 'testing' && !allListed(leaseOrigins, testingOrigins)) {
    // The daemon bound the lease to an origin the user did not list: give the lease back rather than run it.
    settlePending();
    ignore(reconcileSites());
    await send('status', { leaseId: data.leaseId ?? data.id, status: 'stopped', reason: 'stopped' }).catch(() => {});
    throw new Error('Testing mode needs every requested origin listed under Testing environments.');
  }
  // The roots the lease covers (the daemon keeps them only for a `domain` lease) whose permission Chrome holds.
  const sites = scope === 'domain' && data.grant?.scope !== 'origin' ? leaseOrigins.filter(entry => siteRoot(entry)) : [];
  const patterns = sites.map(entry => sitePattern(siteRoot(entry)));
  const leaseScope = sites.length && (await hasSitePermission(patterns)) ? 'domain' : 'origin';
  if (given?.approvalGuard) {
    try { await given.approvalGuard(data); } catch (error) {
      settlePending();
      await send('status', { leaseId: data.leaseId ?? data.id, status: 'stopped', reason: 'stopped' }).catch(() => {});
      throw error;
    }
  }
  const previous = session;
  session = {
    requestId: data.requestId ?? requestId,
    leaseId: data.leaseId ?? data.id,
    tabId: tab.id,
    // The tab the daemon's lease names, and every tab the lease covers: this one, and a popup or new tab it opened on
    // the approved origins (followChild). `tabId` is the one commands act on.
    homeTabId: tab.id,
    tabMode: approvedTabMode === 'multiple' && data.grant?.tabMode === 'multiple' ? 'multiple' : 'single',
    tabs: [{ id: 't0', tabId: tab.id, url: reportedUrl(tab.url ?? ''), title: reportedText(String(tab.title ?? '')).slice(0, 120) }],
    origin,
    // The lease's approved origins, for following a consent wall's redirect (followConsentRedirect).
    origins: leaseOrigins,
    level,
    status: 'active',
    scope: leaseScope,
    sites,
    patterns,
  };
  if (session.scope !== 'domain') {
    session.sites = [];
    session.patterns = [];
  }
  if (given?.modalPattern && !session.patterns.includes(given.modalPattern)) session.patterns.push(given.modalPattern);
  if (session.tabMode === 'multiple' && !session.patterns.includes(taskPattern)) session.patterns.push(taskPattern);
  // An armed tab's FAI ? group becomes the session's FAI mark (markTab retitles it).
  if (Number.isInteger(given?.armGroupId)) session.groupId = given.armGroupId;
  // Other tabs armed for this request (Open clicked twice) are done: it is served now.
  for (const arm of [...armed.values()]) {
    if (arm.requestId === requestId && arm.tabId !== tab.id) ignore(disarm(arm.tabId));
  }
  settlePending();
  // A note from an unpermitted open is answered once any approval starts.
  ignore(chrome.storage.session?.set?.({ openNotice: null }));
  // The superseded session gives up its host permissions (kept when the new one uses the same roots).
  if (previous && previous !== session) {
    releaseSites(previous);
    markTab(previous);
  }
  // Remembering is per level: an approval above Reversible ends any remembered grant for its roots, so the permission
  // goes with this session (the popup removed it first, so Chrome asked again).
  if (askedSites.length && !REMEMBER_LEVELS.includes(level)) ignore(forgetSites(askedSites.map(siteRoot)));
  // A permission granted for this approval that the session does not use (declined scope, narrowed lease) goes now.
  if (askedPatterns.length && session.scope !== 'domain') ignore(reconcileSites());
  await setStatus('active');
  // Test site: the dev-log and dialog hook for this session's origins (armDevHooks), never at another level.
  if (cleanLevel(level) === 'testing') ignore(armDevHooks(session));
  else if (previous?.devHooks) ignore(disarmDevHooks());
  // Warm the annotator so the first capture does not pay for document creation.
  ensureOffscreen().catch(() => {});
  // The service answered over HTTP but the socket is not up: receive commands over the long-poll.
  if (!socketOpen && !longPolling) {
    fallbackUntil = Date.now() + FALLBACK_WINDOW_MS;
    longPollLoop();
  }
}

// --- armed tabs: "Open <host>" opens the page, the toolbar icon click on it is the approval ------------------------
// Toolbar approval grants activeTab (needed by captureVisibleTab). Modal approval instead requests explicit host
// access, bound to the same armed task tab. Thus "Open <host>" opens the request's start URL in a new task tab and arms it:
// { tabId, requestId, level, scope, patterns, client, at, groupId, promptWindowId } here and in
// storage.session.armedTabs (a worker restart keeps it; `patterns`: the roots' host permissions a domain arm holds
// until it is approved or ends; `promptWindowId`: the prompt window of a page that opened by itself). An armed tab
// has no popup (chrome.action.onClicked fires instead), a ? badge, a "click to approve" title and the FAI ? group.
// The click leases it through startSession; the arm ends when it no longer applies (disarm).
const ARM_MS = 10 * 60_000;
const ARM_TITLE = 'FAI ?';
const POPUP_PAGE = 'popup.html';
const ARM_DECLINED = 'The request was no longer waiting or this tab left its site: nothing was approved.';
const armed = new Map();
let armsLoaded = null;

function loadArms() {
  armsLoaded ??= (async () => {
    const { armedTabs } = (await chrome.storage.session?.get?.(['armedTabs'])) ?? {};
    for (const arm of Array.isArray(armedTabs) ? armedTabs : []) {
      if (Number.isInteger(arm?.tabId) && !armed.has(arm.tabId)) armed.set(arm.tabId, arm);
    }
  })().catch(() => {});
  return armsLoaded;
}

function saveArms() {
  return ignore(chrome.storage.session?.set?.({ armedTabs: [...armed.values()] }));
}

// The level a page opened right away is armed at: the requested level, up to Interactive. Null for Full and Testing:
// those never open by themselves (the user picks them on the request card, where the window shows what they allow).
const RIGHT_AWAY_MAX = 'interactive';
function rightAwayLevel(request) {
  const requested = cleanLevel(request.mode ?? request.level) ?? 'read-only';
  return minLevel(requested, RIGHT_AWAY_MAX) === requested ? requested : null;
}

// Opens the request's start URL in a new task tab and arms that tab. `domain` only when Chrome holds every root's
// host permission (the popup requested it in the click); else the arm's scope is origin. A small prompt window next
// to the page says to click the icon (showPrompt): the popup that said so has closed, or there was none.
async function openAndArm(requestId, level, wantDomain) {
  await loadArms();
  const request = requests.find(item => item.requestId === requestId && ['pending', 'paused'].includes(item.state));
  const target = request ? requestTarget(request) : null;
  if (!target) throw new Error('This request has no page to open.');
  const roots = request.origins.filter(entry => siteRoot(entry)).map(entry => sitePattern(siteRoot(entry)));
  const scope = wantDomain && roots.length && await hasSitePermission(roots) ? 'domain' : 'origin';
  const armSettings = await chrome.storage.local.get(['tabMode']);
  const { tab, window: opened } = await openTaskTab(target.url);
  const arm = { tabId: tab.id, requestId, tabMode: cleanTabMode(armSettings.tabMode), level: cleanLevel(level) ?? 'read-only', scope, patterns: scope === 'domain' ? roots : [],
    client: typeof request.client === 'string' ? request.client.slice(0, 80) : '', at: Date.now(), groupId: null,
    promptWindowId: null, origin: target.origin };
  armed.set(tab.id, arm);
  saveArms();
  setTimeout(() => expireArms(), ARM_MS + 1_000);
  await showPrompt(arm, opened);
  // Per-tab action values are set once the page has loaded (Chrome may reset them on the first commit).
  await waitTabComplete(tab.id, OPEN_LOAD_MS).catch(() => {});
  if (armed.get(tab.id) === arm) await showArm(arm);
  return { tabId: tab.id, scope };
}

// The waiting prompt for a page that opened by itself: arm.html in a small popup window of its own, placed under the
// toolbar at the top right of the page's window (where the icon is), saying to click the FAI Browser icon there, at
// which level, with Deny and a level choice. Nothing can be put into the page itself before the click (no host
// permission, and scripting needs one or activeTab), and the badge, icon title and tab group are easy to miss, so a
// window is the one unmissable sign that needs no further permission. It closes when the arm ends (disarm, and the
// page itself when its arm leaves storage.session.armedTabs).
const PROMPT_PAGE = 'arm.html';
const PROMPT_SIZE = { width: 440, height: 430 };
const PROMPT_INSET = { right: 24, top: 90 };
async function showPrompt(arm, win) {
  const placed = Number.isInteger(win?.left) && Number.isInteger(win?.width)
    ? { left: Math.max(0, win.left + win.width - PROMPT_SIZE.width - PROMPT_INSET.right), top: Math.max(0, (win.top ?? 0) + PROMPT_INSET.top) }
    : {};
  try {
    const created = await chrome.windows.create({ url: chrome.runtime.getURL(`${PROMPT_PAGE}?tab=${arm.tabId}`), type: 'popup',
      ...PROMPT_SIZE, ...placed, focused: true });
    if (Number.isInteger(created?.id) && armed.get(arm.tabId) === arm) {
      arm.promptWindowId = created.id;
      saveArms();
    } else if (Number.isInteger(created?.id)) {
      ignore(chrome.windows.remove(created.id));
    }
  } catch {
    // No prompt: the badge, title and group still show the arm.
  }
}

function closePrompt(arm) {
  if (!Number.isInteger(arm?.promptWindowId)) return;
  const id = arm.promptWindowId;
  arm.promptWindowId = null;
  ignore(chrome.windows.remove(id));
}

// The armed tab's look: no popup, ? badge, "click to approve" title, FAI ? group (never a group the user made).
async function showArm(arm) {
  try {
    await chrome.action.setPopup?.({ tabId: arm.tabId, popup: '' });
    await chrome.action.setBadgeText({ tabId: arm.tabId, text: '?' });
    await chrome.action.setTitle?.({ tabId: arm.tabId,
      title: `FAI Browser: click to approve ${arm.client || 'the agent'}'s request (${LEVEL_NAMES[arm.level] ?? arm.level})` });
  } catch {
    // The tab closed meanwhile.
  }
  markChain = markChain.then(async () => {
    if (!chrome.tabGroups || !chrome.tabs.group || armed.get(arm.tabId) !== arm) return;
    const tab = await chrome.tabs.get(arm.tabId).catch(() => null);
    if (!tab || (arm.groupId != null && tab.groupId === arm.groupId)) return;
    if ((tab.groupId ?? NO_GROUP) !== NO_GROUP) return;
    arm.groupId = await chrome.tabs.group({ tabIds: [arm.tabId], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(arm.groupId, { title: ARM_TITLE, color: MARK_COLOR, collapsed: false });
    saveArms();
  }).catch(() => {});
}

// Ends an arm: the popup comes back on that tab, the per-tab title and badge go, and the FAI ? group goes unless
// `keepGroup` (a lease is about to take it over as the FAI mark). `notice` is what the popup then says on that tab.
async function disarm(tabId, { notice = null, keepGroup = false } = {}) {
  const arm = armed.get(tabId);
  if (!arm) return null;
  armed.delete(tabId);
  const modal = modalIntents.get(tabId);
  if (modal && !keepGroup) {
    recentGrants.delete(modal.pattern);
    if (!modal.started) modalIntents.delete(tabId);
  }
  saveArms();
  closePrompt(arm);
  try {
    await chrome.action.setPopup?.({ tabId, popup: POPUP_PAGE });
    await chrome.action.setTitle?.({ tabId, title: 'FAI Browser' });
    if (session?.tabId !== tabId) await chrome.action.setBadgeText({ tabId, text: null });
  } catch {
    // The tab is gone.
  }
  // The FAI tab shows its own badge again; a domain arm that ends unapproved gives the roots' permission back.
  if (session?.tabId === tabId) updateBadge();
  if (!keepGroup && arm.patterns?.length) ignore(reconcileSites());
  if (notice) await ignore(chrome.storage.session?.set?.({ openNotice: { tabId, requestId: arm.requestId, message: notice } }));
  if (!keepGroup && arm.groupId != null) {
    markChain = markChain.then(async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.groupId === arm.groupId) await chrome.tabs.ungroup([tabId]);
    }).catch(() => {});
  }
  return arm;
}

// Ends arms older than ARM_MS and, with `byRequest` (a fresh requests snapshot from the daemon), arms whose request
// left pending/paused. A restarted worker has no requests until that snapshot, so timers never judge by them.
async function expireArms(byRequest = false) {
  await loadArms();
  const now = Date.now();
  for (const [tabId, intent] of modalIntents) {
    if (now - (intent.started || intent.arm.at) > ARM_MS && armed.get(tabId) !== intent.arm) modalIntents.delete(tabId);
  }
  for (const arm of [...armed.values()]) {
    const live = requests.some(item => item.requestId === arm.requestId && ['pending', 'paused'].includes(item.state));
    const leasing = modalIntents.get(arm.tabId)?.running && requests.some(item => item.requestId === arm.requestId && item.state === 'active');
    if ((byRequest && !live && !leasing) || now - arm.at > ARM_MS) await disarm(arm.tabId);
  }
}

// Modal approval uses optional host access, never an activeTab grant from the extension window.
// Preparation happens before enabling Approve; permissions.request itself must run in that button's gesture.
const modalIntents = new Map();
function modalSender(message, sender) {
  const arm = armed.get(message.tabId);
  if (sender.url !== chrome.runtime.getURL(`arm.html?tab=${message.tabId}`)
    || (sender.tab && Number.isInteger(arm?.promptWindowId) && sender.tab.windowId !== arm.promptWindowId)) {
    throw new Error('Approve from this request window only.');
  }
}
function modalArmState(message, ownLease = null) {
  const arm = armed.get(message.tabId);
  const request = requests.find(item => item.requestId === message.requestId && (['pending', 'paused'].includes(item.state)
    || (item.state === 'active' && ownLease?.requestId === message.requestId && typeof ownLease.leaseId === 'string')));
  if (!arm || arm.requestId !== message.requestId || arm.at !== message.at || !request || Date.now() - arm.at > ARM_MS) {
    throw new Error(ARM_DECLINED);
  }
  return { arm, request };
}
async function modalArm(message, ownLease = null) {
  await loadArms();
  return modalArmState(message, ownLease);
}
async function prepareModalApproval(message, sender) {
  modalSender(message, sender);
  const { arm, request } = await modalArm(message);
  const existing = modalIntents.get(arm.tabId);
  if (existing?.arm === arm) return { approval: { token: existing.token, pattern: existing.pattern } };
  const tab = await chrome.tabs.get(arm.tabId);
  // Without activeTab Chrome may omit url. A freshly opened arm records its original origin; after permission
  // is granted, approval always reads and verifies the actual tab URL, including pending navigations.
  const origin = originOf(tab.url ?? '') || arm.origin || requestTarget(request)?.origin;
  if (!origin || !originCovered(origin, request.origins) || tab.incognito) throw new Error(ARM_DECLINED);
  const pattern = taskOriginPattern(origin);
  const owned = !await hasSitePermission([pattern]);
  if (armed.get(arm.tabId) !== arm) throw new Error(ARM_DECLINED);
  const intent = { arm, origin, pattern, owned, token: randomId(), running: false,
    addedPattern: !arm.patterns.includes(pattern) };
  modalIntents.set(arm.tabId, intent);
  if (owned) await trackSites([pattern]);
  if (armed.get(arm.tabId) !== arm || modalIntents.get(arm.tabId) !== intent) {
    modalIntents.delete(arm.tabId);
    recentGrants.delete(pattern);
    await reconcileSites();
    throw new Error(ARM_DECLINED);
  }
  if (!arm.patterns.includes(pattern)) arm.patterns.push(pattern);
  await saveArms();
  return { approval: { token: intent.token, pattern } };
}
async function finishModalApproval(message, sender) {
  modalSender(message, sender);
  const intent = modalIntents.get(message.tabId);
  if (!intent || intent.token !== message.token || intent.running) throw new Error(ARM_DECLINED);
  intent.running = true;
  const { arm, pattern } = intent;
  const validate = async (ownLease = null) => {
    await modalArm(message, ownLease);
    const level = cleanLevel(message.level);
    if (!await hasSitePermission([pattern])) throw new Error('Browser site access was not granted. Nothing was approved.');
    if (level === 'testing') await loadTestingOrigins();
    // Read the bound tab last, then check current in-memory consent without another asynchronous gap.
    const tab = await chrome.tabs.get(arm.tabId);
    const fresh = modalArmState(message, ownLease);
    const asked = cleanLevel(fresh.request.mode ?? fresh.request.level) ?? 'read-only';
    if (fresh.arm !== arm || !level || minLevel(level, asked) !== level) throw new Error('The agent did not ask for that level.');
    if (tab.incognito || originOf(tab.url ?? '') !== intent.origin
      || (tab.pendingUrl && originOf(tab.pendingUrl) !== intent.origin)) throw new Error('The page changed. Nothing was approved.');
    if (level === 'testing' && (!allListed(fresh.request.origins, testingOrigins) || !testingOrigins.includes(intent.origin))) {
      throw new Error('Testing mode needs every requested origin listed under Testing environments.');
    }
    return tab;
  };
  try {
    if (message.granted !== true) throw new Error('Browser site access was not granted. You can try again or use the toolbar icon.');
    const tab = await validate();
    // Focus the exact task tab, never the extension window's active tab.
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    await startSession({ requestId: arm.requestId, level: message.level, scope: arm.scope, tabMode: arm.tabMode },
      { ...tab, armGroupId: arm.groupId, modalPattern: pattern, approvalGuard: validate });
    await disarm(arm.tabId, { keepGroup: true });
    return popupState();
  } finally {
    modalIntents.delete(arm.tabId);
    if (intent.addedPattern) arm.patterns = arm.patterns.filter(item => item !== pattern);
    recentGrants.delete(pattern);
    await saveArms();
    await reconcileSites();
  }
}

// The toolbar icon click on an armed tab (activeTab is now granted on it, so its url is readable): the approval.
async function approveArmed(tab, access = Promise.resolve()) {
  await access;
  await loadArms();
  if (!armed.has(tab?.id)) {
    // Only an armed tab has no popup: one left without its arm gets the popup back for the next click.
    if (Number.isInteger(tab?.id)) ignore(chrome.action.setPopup?.({ tabId: tab.id, popup: POPUP_PAGE }));
    return;
  }
  if (!connected && pairing) await waitForAttempt(CONNECT_WAIT_MS);
  const arm = armed.get(tab.id);
  const request = requests.find(item => item.requestId === arm.requestId && ['pending', 'paused'].includes(item.state));
  const origin = originOf(tab.url ?? '');
  if (!request || !origin || !originCovered(origin, request.origins) || Date.now() - arm.at > ARM_MS) {
    await disarm(tab.id, { notice: ARM_DECLINED });
    return;
  }
  // The roots' permission passes from the arm to the start in progress (startSession settles it).
  if (arm.patterns?.length) pendingPatterns = arm.patterns;
  await disarm(tab.id, { keepGroup: true });
  const given = { ...tab, armGroupId: arm.groupId };
  await startSession({ type: 'start', requestId: arm.requestId, level: arm.level, scope: arm.scope, tabMode: arm.tabMode }, given).catch(async error => {
    if (arm.patterns?.length) {
      pendingPatterns = [];
      ignore(reconcileSites());
    }
    await ignore(chrome.storage.session?.set?.({ openNotice: { tabId: tab.id, requestId: arm.requestId, message: error.message } }));
    const now = arm.groupId != null ? await chrome.tabs.get(tab.id).catch(() => null) : null;
    if (now && now.groupId === arm.groupId && session?.tabId !== tab.id) await ignore(chrome.tabs.ungroup([tab.id]));
  });
}

// The roots' permission Chrome just granted completes a fresh "All of <root>" Open: open and arm here, so it finishes
// even when the popup closed with the prompt. `running` is set synchronously; the popup's own `open` waits for it.
function openFromIntent(added) {
  const intent = openIntent;
  if (!intent || intent.running || Date.now() - intent.at > OPEN_INTENT_MS) return;
  if (!intent.patterns.some(pattern => added.includes(pattern))) return;
  intent.running = openAndArm(intent.requestId, intent.level, true).catch(error => error);
}

// The popup's `open`: when the intent already opened the page, that open is the answer (exactly one task tab).
async function openRequest(message) {
  const fresh = openIntent && Date.now() - openIntent.at <= OPEN_INTENT_MS;
  const intent = fresh && openIntent.requestId === message.requestId ? openIntent : null;
  if (intent) openIntent = null;
  if (intent?.running) {
    const outcome = await intent.running;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
  return openAndArm(message.requestId, message.level, message.scope === 'domain');
}

// "Approve on the FAI tab": a new request the live session's own tab already covers (a higher level for the tab it is
// driving) is leased on that tab directly, under the activeTab grant it still holds. When the lease is refused or the
// tab's url is no longer readable, that tab is armed instead and the icon click approves it.
async function approveOnSessionTab(message) {
  const tabId = session?.tabId;
  const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (!tab) throw new Error('No FAI tab to approve on.');
  try {
    await startSession({ ...message, type: 'start' }, tab);
    return null;
  } catch {
    const request = requests.find(item => item.requestId === message.requestId && ['pending', 'paused'].includes(item.state));
    if (!request) throw new Error('This request is no longer waiting.');
    const arm = { tabId, requestId: request.requestId, tabMode, level: cleanLevel(message.level) ?? 'read-only',
      scope: message.scope === 'domain' ? 'domain' : 'origin', patterns: [], client: String(request.client ?? '').slice(0, 80),
      at: Date.now(), groupId: null };
    armed.set(tabId, arm);
    saveArms();
    await showArm(arm);
    return ARM_ON_SESSION_TAB;
  }
}
const ARM_ON_SESSION_TAB = 'Click the FAI Browser icon on the FAI tab to approve.';

function popupState() {
  return {
    status: session?.status ?? null,
    session: sessionView(),
    connection: connectionView(),
    requests,
  };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'annotate') return;
  // input.js's trusted-input steps: answered by trusted-input.js only.
  if (message?.kind === 'fai-trusted-input') return;
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    let note = null;
    if (message.type === 'arm_begin') {
      modalSender(message, sender);
      const intent = modalIntents.get(message.tabId);
      if (!intent || intent.token !== message.token || armed.get(message.tabId) !== intent.arm) throw new Error(ARM_DECLINED);
      intent.started = Date.now();
    } else if (message.type === 'arm_prepare') {
      return await prepareModalApproval(message, sender);
    } else if (message.type === 'arm_approve') {
      return await finishModalApproval(message, sender);
    } else if (message.type === 'start') {
      // `onSessionTab`: "Approve on the FAI tab" (approveOnSessionTab); else the popup's own activeTab gesture.
      if (message.onSessionTab === true) note = await approveOnSessionTab(message);
      else await startSession(message);
    } else if (message.type === 'intent') {
      // The popup is about to request the roots' `patterns` for "Open <host>" with "All of <root>" (see openFromIntent).
      const patterns = Array.isArray(message.patterns) ? message.patterns.filter(item => SITE_PERMISSION.test(item)) : [];
      if (typeof message.requestId !== 'string' || !patterns.length) throw new Error('No request to open');
      openIntent = { requestId: message.requestId, level: cleanLevel(message.level) ?? 'read-only', patterns,
        at: Date.now(), running: null };
    } else if (message.type === 'pause' || message.type === 'stop') {
      if (!session) throw new Error('Select a tab and start first');
      const status = message.type === 'pause' ? 'paused' : 'stopped';
      await endSession(status, status);
    } else if (message.type === 'forget') {
      // Forget a remembered domain: its host permission goes at once unless the live session uses it.
      await forgetSites(message.root ? [message.root] : []);
      await reconcileSites();
    } else if (message.type === 'open') {
      // "Open <host>": open the request's page in a new task tab and arm it (see openAndArm).
      if (typeof message.requestId !== 'string') throw new Error('No request to open');
      await openRequest(message);
    } else if (message.type === 'track') {
      // The popup is about to request these patterns in an Approve click (see trackSites).
      await trackSites(message.patterns);
    } else if (message.type === 'approval_decision') {
      // Approve once or Deny, from the approval window or the popup card: an extension page only, never a web page.
      const extensionPage = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
      if (!extensionPage || typeof message.id !== 'string' || !['approve', 'deny'].includes(message.decision)) {
        throw new Error('Approvals come from the FAI Browser window only.');
      }
      decideApproval(message.id, message.decision);
    } else if (message.type === 'arm_level') {
      // The prompt window's level choice for an armed tab: the icon click then leases it at this level (startSession
      // checks Testing against the listed environments again).
      await loadArms();
      const arm = armed.get(message.tabId);
      const level = cleanLevel(message.level);
      if (!arm || !level) throw new Error('This page is no longer waiting for approval.');
      // Never above what the agent asked for (the prompt offers no higher level either).
      const request = requests.find(item => item.requestId === arm.requestId);
      const asked = cleanLevel(request?.level ?? request?.mode) ?? 'read-only';
      if (request && minLevel(level, asked) !== level) throw new Error('The agent did not ask for that level.');
      arm.level = level;
      saveArms();
      ignore(showArm(arm));
    } else if (message.type === 'deny') {
      if (typeof message.requestId !== 'string') throw new Error('No request to deny');
      for (const arm of [...armed.values()]) if (arm.requestId === message.requestId) await disarm(arm.tabId);
      await send('deny', { requestId: message.requestId });
    } else if (message.type === 'connect') {
      // Sent when the popup opens or its permissions change: connect with the saved pairing if not connected yet,
      // and re-read the testing environments so the reply's session level is current (no race with onChanged).
      await loadTestingOrigins();
      if (!connected) {
        connect();
        await waitForAttempt(1_000);
      }
      // A failed driver read never fails the connect: the popup keeps the last known choice.
      if (connected && driverControl) await readDriver().catch(() => {});
    } else if (message.type === 'pair') {
      // The popup's "Pair automatically": ask the native host now, whatever the last attempt said.
      const outcome = await nativePair({ force: true });
      if (outcome !== 'paired') {
        throw new Error(outcome === 'missing'
          ? 'Automatic pairing is not installed. Run npm run setup in the fai-browser folder.'
          : 'Automatic pairing failed. Run npm run setup in the fai-browser folder.');
      }
      if (!connected) await waitForAttempt(CONNECT_WAIT_MS);
    } else if (message.type === 'set_driver') {
      const popupUrl = chrome.runtime.getURL('popup.html');
      if (typeof sender.url !== 'string' || sender.url.split('?')[0] !== popupUrl) {
        throw new Error('Change browser control from the FAI Browser popup.');
      }
      if (!['jev', 'agent'].includes(message.driver)) throw new Error('Choose your agent or Jev autopilot.');
      if (!connected || !driverControl) {
        throw new Error('Connect to an updated FAI service before switching browser control.');
      }
      try {
        const data = await send('driver', { driver: message.driver });
        const control = cleanDriverControl(data?.control);
        if (!control || control.driver !== message.driver) throw new Error('The FAI service did not confirm the switch.');
        driverControl = control;
        publishConnection();
      } catch (error) {
        // A lost acknowledgement may still have saved the change. Read the actual state before reporting failure.
        await readDriver().catch(() => {});
        throw error;
      }
    } else {
      throw new Error('Unsupported control');
    }
    return note ? { ...popupState(), note } : popupState();
  })().then(respond, error => respond({ error: error.message }));
  return true;
});

// Session-changing browser events. Each pauses the lease with a reason the service maps to a BridgeError.
chrome.tabs.onCreated.addListener(tab => {
  if (session?.status === 'active' && leaseTab(tab.openerTabId)) {
    // An act that opened it waits for this (executeCommand) and reports the new tab's page.
    const current = session;
    const following = followChild(tab).catch(() => {}).finally(() => {
      if (current.childFollow === following) current.childFollow = null;
    });
    current.childFollow = following;
  }
});
chrome.tabs.onActivated.addListener(async info => {
  const current = session;
  if (current?.childFollow) await current.childFollow;
  if (session !== current) return;
  if (session?.status !== 'active' || info.tabId === session.tabId) return;
  // The user brought another tab of the lease forward: commands follow it.
  if (leaseTab(info.tabId)) {
    session.tabId = info.tabId;
    return;
  }
  // Only a switch inside the leased tab's window matters; working in another window is fine.
  const leased = await chrome.tabs.get(session.tabId).catch(() => null);
  if (!leased || leased.windowId === info.windowId) endSession('paused', 'tab_changed');
});
// An armed tab's events: closed, or seen committing a page off its request's origins (a url is only visible with a
// grant; the icon click re-checks, which is the authoritative check). A finished load re-applies its look.
chrome.tabs.onRemoved?.addListener(async tabId => {
  await loadArms();
  if (armed.has(tabId)) ignore(disarm(tabId));
});
chrome.tabs.onUpdated?.addListener(async (tabId, info) => {
  await loadArms();
  const arm = armed.get(tabId);
  if (!arm) return;
  const request = requests.find(item => item.requestId === arm.requestId);
  const origin = info.url ? originOf(info.url) : null;
  if (info.url && request && !(origin && originCovered(origin, request.origins))) ignore(disarm(tabId));
  else if (info.status === 'complete') ignore(showArm(arm));
});
chrome.action?.onClicked?.addListener(tab => {
  // Request native site access synchronously inside the toolbar gesture, before any await.
  const arm = armed.get(tab?.id);
  const request = arm && requests.find(item => item.requestId === arm.requestId);
  let access = globalThis.faiCompat?.approvalAccess?.(tab?.id) ?? null;
  if (arm?.tabMode === 'multiple' && tabMode === 'multiple' && originCovered(originOf(tab.url ?? ''), request?.origins ?? [])) {
    const pattern = taskOriginPattern(new URL(tab.url).origin);
    ignore(trackSites([pattern]));
    access ??= chrome.permissions?.request?.({ origins: [pattern] }).catch(() => false) ?? null;
  }
  ignore(approveArmed(tab, access ?? Promise.resolve()));
});

chrome.tabs.onRemoved?.addListener(tabId => {
  if (session?.status !== 'active' || !leaseTab(tabId)) return;
  if (!leaseTabClosed(tabId)) endSession('paused', 'tab_changed');
});
chrome.tabs.onUpdated?.addListener((tabId, info) => {
  if (session?.status === 'active' && tabId === session.tabId && info.url && !sessionCovers(info.url)) {
    endSession('paused', 'origin_changed');
  } else if (session?.status === 'active' && info.url && leaseTab(tabId) && !sessionCovers(info.url)) {
    // Another tab of the lease left the approved site: it is no longer part of it.
    session.tabs = session.tabs.filter(entry => entry.tabId !== tabId);
  }
});

// Keepalive: a ping on the open socket every 20 s; in long-poll mode a cheap extension API call instead.
setInterval(() => {
  if (socketOpen) {
    try {
      socket.send(JSON.stringify({ v: 3, type: 'ping' }));
    } catch {
      // onclose handles a dead socket.
    }
  } else if (longPolling || session) {
    ignore(chrome.storage.session?.get?.('keepalive'));
  }
}, PING_MS);

// Survives worker death: when the alarm fires and nothing is connected, reconnect now.
try {
  ignore(chrome.alarms?.create(RECONNECT_ALARM, { periodInMinutes: 0.5 }));
  chrome.alarms?.onAlarm.addListener(alarm => {
    if (alarm?.name !== RECONNECT_ALARM) return;
    // Remembered domains expire on time even when nothing else happens.
    ignore(reconcileSites());
    ignore(expireArms());
    if (socket || longPolling) return;
    // Not paired: the native host may have been installed since (setup ran).
    if (!pairing) {
      ignore(nativePair());
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    connect();
  });
} catch {
  // No alarms permission in some test contexts.
}

// A pairing edited in the popup (saved on every keystroke) reconnects once typing settles.
let pairingTimer = null;
chrome.storage.onChanged?.addListener((changes, area) => {
  // A testing environment removed in the popup ends a testing grant on it at once (grantedLevel).
  if (area === 'local' && changes.permissions) {
    testingOrigins = cleanTestingOrigins(changes.permissions.newValue);
    revokeTesting();
  }
  // Secret redaction changed in the popup: the next page call uses it.
  if (area === 'local' && changes.secretRedaction) secretRedaction = cleanSecretRedaction(changes.secretRedaction.newValue);
  // The Approve gate's settings: the next approval and page call use them.
  if (area === 'local' && changes.approvals) {
    approvalSettings = cleanApprovalSettings(changes.approvals.newValue);
    ignore(reportSettings());
  }
  // "Remember domain approvals" turned off: every remembered domain's host permission goes at once.
  if (area === 'local' && changes.domainMemory) ignore(reconcileSites());
  // The per-request budget changed in the popup: the daemon applies it to every later call.
  if (area === 'local' && (changes.budget || changes.openRightAway || changes.tabMode)) {
    if (changes.budget) {
      budget = cleanBudget(changes.budget.newValue);
      budgetLoaded = true;
    }
    if (changes.tabMode) {
      tabMode = cleanTabMode(changes.tabMode.newValue);
      if (tabMode === 'single' && session?.tabMode === 'multiple') ignore(endSession('paused', 'tab_changed'));
    }
    if (changes.openRightAway) openRightAway = changes.openRightAway.newValue !== false;
    ignore(reportSettings());
  }
  if (area !== 'local' || !(changes.endpoint || changes.secret)) return;
  clearTimeout(pairingTimer);
  pairingTimer = setTimeout(async () => {
    const saved = await chrome.storage.local.get(['endpoint', 'secret']);
    await usePairing(validPairing(saved.endpoint, saved.secret));
  }, 400);
});

// A host permission the popup just obtained for an approval in progress (see recentGrants).
chrome.permissions?.onAdded?.addListener?.(added => {
  for (const pattern of added?.origins ?? []) {
    if (SITE_PERMISSION.test(pattern)) recentGrants.set(pattern, Date.now());
    const modal = [...modalIntents.values()].find(intent => intent.owned && intent.started && Date.now() - intent.started < ARM_MS && intent.pattern === pattern);
    if (modal && armed.get(modal.arm.tabId) !== modal.arm) ignore(trackSites([pattern]).then(() => {
      if (armed.get(modal.arm.tabId) !== modal.arm) {
        recentGrants.delete(pattern);
        return reconcileSites();
      }
    }));
  }
  openFromIntent(added?.origins ?? []);
});

chrome.runtime.onStartup?.addListener(() => connect());
chrome.runtime.onInstalled?.addListener(() => connect());

// Worker (re)start: there is no session in memory. Restrict storage to extension contexts, show that a
// reconnect is needed, and connect; the hello with session:null tells the service to pause any lease the
// previous worker held. The saved pairing secret is only ever sent to a valid loopback service endpoint.
ignore(chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }));
ignore(chrome.storage.local.set({ status: 'Reconnect required' }));
storeSession({ requests: [], connection: { connected: false, transport: 'none', paired: false, native: null } });
updateBadge();
ignore(loadTestingOrigins());
ignore(loadSecretRedaction());
ignore(loadApprovalSettings());
// No session survives a worker restart, so no domain host permission does either (remembered domains excepted), and
// no tab mark.
ignore(reconcileSites());
unmarkLeftover();
// Armed tabs survive a worker restart (storage.session); one past its 10 minutes is disarmed by the alarm.
ignore(loadArms());
connect();
