// Small UI helpers shared by the popup (popup.js) and the waiting prompt (arm.js): DOM building, the level <select>,
// Chrome's site-access request for a domain root, and the toolbar facts the pin hint needs (pinned or not, the bound
// shortcut). Everything an agent wrote is rendered with textContent only.

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Fills a level <select> with `options` ({ level, name, warning }) and selects `value`. */
export function fillLevelSelect(select, options, value) {
  select.replaceChildren(...options.map(option => {
    const node = element('option', option.warning ? 'level-testing' : '', option.warning ? `⚠ ${option.name}` : option.name);
    node.value = option.level;
    return node;
  }));
  select.value = options.some(option => option.level === value) ? value : options[0]?.level ?? '';
  return select.value;
}

export function replaceCardsPreservingFocus(container, cards) {
  const active = document.activeElement;
  const previous = active?.closest?.('.request-card');
  const inside = previous && container.contains(previous);
  const key = inside ? previous.dataset.requestId ?? previous.dataset.approvalId : null;
  const controls = inside ? [...previous.querySelectorAll('button, input, select')] : [];
  const index = controls.indexOf(active);
  container.replaceChildren(...cards);
  if (key == null || index < 0) return;
  const card = cards.find(item => (item.dataset.requestId ?? item.dataset.approvalId) === key);
  const next = card?.querySelectorAll('button, input, select')[index];
  if (next && !next.disabled) next.focus({ preventScroll: true });
}

export const TESTING_WARNING = 'For your test sites only. The agent may log in, submit, delete and pay. Origin and policy limits, secret redaction and approval protections still apply.';

/**
 * Chrome's site-access prompt for a domain root ("All of example.org"), asked inside the click that approves or opens
 * a request. It must be called synchronously in the click handler (nothing awaited before it) to count as a user
 * gesture. `scope` is the card's site choice (or null); `intent` also tells the worker to open the page itself when the
 * permission arrives (Chrome's prompt can close the popup first). Resolves `{ blocked }` when a remembered grant is
 * still being ended, else `{ domain, granted: Promise<boolean> }`.
 */
export function askSiteAccess(scope, { requestId, level, intent = false, origins = [], tabMode = 'single' }) {
  const domain = scope?.value() === 'domain';
  const kind = scope?.prompt()?.kind;
  // The remembered grant is still being ended (the popup's endRemembered): approving now would skip Chrome's prompt.
  if (domain && kind === 'again') return { blocked: true };
  let granted = Promise.resolve(false);
  // Firefox build only: the request's exact origins too, in the same prompt (see exactOriginPatterns).
  const exact = exactOriginPatterns(origins, { gecko: GECKO_BUILD || tabMode === 'multiple' });
  if (tabMode === 'multiple' && exact.length) chrome.runtime.sendMessage({ type: 'track', patterns: exact }).catch(() => {});
  if (!domain && exact.length && chrome.permissions?.request) {
    expectOrigins(exact);
    granted = chrome.permissions.request({ origins: exact }).then(Boolean, () => false);
  }
  if (domain && chrome.permissions?.request) {
    if (exact.length) expectOrigins(exact);
    granted = chrome.permissions.request({ origins: [...scope.patterns, ...exact] }).then(Boolean, () => false);
    if (intent) {
      chrome.runtime.sendMessage({ type: 'intent', requestId, level, patterns: scope.patterns }).catch(() => {});
    }
    // The worker tracks what this extension requested (it never removes a site the user allowed by hand).
    if (kind !== 'granted') chrome.runtime.sendMessage({ type: 'track', patterns: scope.patterns }).catch(() => {});
  }
  return { blocked: false, domain, granted };
}

// Firefox ends activeTab at a tab's first navigation (Chrome keeps it until the tab leaves the origin), so in the
// Firefox build an approval click also asks for the request's exact origins as host permissions; extension/compat.js
// in the background removes each one it saw added (listed under EXPECTED_KEY first) once no live request needs it.
// Same rules as compat.js originPattern/requestPatterns (drift check in test/firefox-compat.test.js): Firefox match
// patterns take no port. Empty in the Chromium extension, whose manifest has no browser_specific_settings.
const GECKO_BUILD = Boolean(globalThis.chrome?.runtime?.getManifest?.()?.browser_specific_settings?.gecko);
const EXPECTED_KEY = 'compatExpectedOrigins';

export function exactOriginPatterns(origins, { gecko = GECKO_BUILD } = {}) {
  if (!gecko || !Array.isArray(origins)) return [];
  const patterns = [];
  for (const origin of origins) {
    if (typeof origin !== 'string' || origin.includes('*')) continue;
    try {
      const url = new URL(origin);
      if (['http:', 'https:'].includes(url.protocol) && url.origin === origin) patterns.push(`${url.protocol}//${url.hostname}/*`);
    } catch {
      // Not an origin.
    }
  }
  return [...new Set(patterns)];
}

// "Allow on all sites" (Advanced, and the setup card): one optional host permission request for every http(s) site,
// so the browser never asks again per site (domain roots, Firefox's exact origins after a navigation) and, in Firefox,
// screenshots keep working after the first navigation (captureVisibleTab there needs activeTab or <all_urls>). Levels,
// leases and approvals are unchanged: it grants the extension access, never the agent; each tab is still approved.
export function allSitesPermission({ gecko = GECKO_BUILD } = {}) {
  return { origins: gecko ? ['<all_urls>'] : ['https://*/*', 'http://*/*'] };
}

/** Whether every-site access is granted now. */
export async function allSitesGranted() {
  try {
    return await chrome.permissions.contains(allSitesPermission());
  } catch {
    return false;
  }
}

/** Asks the browser for every-site access (inside a click); resolves whether it is granted. */
export async function requestAllSites() {
  try {
    return await chrome.permissions.request(allSitesPermission());
  } catch {
    return false;
  }
}

/** Gives every-site access back (the per-site prompts return). */
export async function removeAllSites() {
  try {
    return await chrome.permissions.remove(allSitesPermission());
  } catch {
    return false;
  }
}

function expectOrigins(patterns) {
  const now = Date.now();
  chrome.storage.session?.get?.([EXPECTED_KEY]).then(saved => {
    const next = { ...(saved?.[EXPECTED_KEY] ?? {}) };
    for (const pattern of patterns) next[pattern] = now;
    return chrome.storage.session.set({ [EXPECTED_KEY]: next });
  }).catch(() => {});
}

/** The keyboard shortcut bound to the toolbar icon ("Ctrl+Shift+Y"), or '' when none is set. */
export async function actionShortcut() {
  try {
    const commands = await chrome.commands?.getAll?.();
    return commands?.find(command => command.name === '_execute_action')?.shortcut ?? '';
  } catch {
    return '';
  }
}

/** False when the icon is not pinned to the toolbar (chrome.action.getUserSettings), true when it is or unknown. */
export async function iconPinned() {
  try {
    const settings = await chrome.action?.getUserSettings?.();
    return settings?.isOnToolbar !== false;
  } catch {
    return true;
  }
}

/** " (or Ctrl+Shift+Y)" for a bound shortcut, '' otherwise. */
export function orShortcut(shortcut) {
  return shortcut ? ` (or ${shortcut})` : '';
}

export const PIN_HINT = 'Pin FAI Browser: you approve requests by clicking it. Puzzle-piece menu, then the pin.';
