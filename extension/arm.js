// The waiting prompt for a page that opened by itself (arm.html?tab=<tabId>, opened by the worker's showPrompt next
// to the page's window): approves its bound task tab using native optional host access, with a level choice and
// Deny. The toolbar remains an alternative and provides the activeTab gesture needed for screenshots. The choice never goes above what the agent asked for (permissions.js levelChoices; the worker checks again).
// It renders from chrome.storage.session (armedTabs, requests) and closes itself once its tab is no longer armed
// (approved, denied, expired or closed). Everything an agent wrote is rendered with textContent only.
import { LEVEL_TEXT, levelChoices, normalizePermissions, startTarget } from './permissions.js';
import { PIN_HINT, actionShortcut, fillLevelSelect, iconPinned, orShortcut } from './ui.js';

const tabId = Number(new URLSearchParams(location.search).get('tab'));
const detail = document.getElementById('detail');
const select = document.getElementById('level');
const help = document.getElementById('level-help');
const warning = document.getElementById('level-warning');
const approve = document.getElementById('approve');
// The approval the worker prepared for this arm (arm_prepare: {token, pattern, requestId, at}), and the arm_prepare in
// flight ({arm, job}). Both belong to one arm: a different request or a new arm on the tab needs its own.
let approval = null;
let preparing = null;
let approving = false;
let restoreApprovalFocus = false;
// Which host patterns the browser already held before any click here (chrome.permissions.contains, per pattern): after
// a grant, the ones that were not held are reported to the worker (arm_track), which tracks and later removes them.
// Approve waits for this local check only. Any change to the browser's host permissions starts it over (a pattern held
// at first and removed before the click is reported again when the click grants it).
const heldBefore = new Map();
const recheckHeld = () => {
  heldBefore.clear();
  if (!approving) render();
};
const deny = document.getElementById('deny');
const status = document.getElementById('status');
const pinHint = document.getElementById('pin-hint');

const stored = await chrome.storage.local.get(['permissions', 'siteAccessWaitMs']).catch(() => ({}));
let permissions = normalizePermissions(stored.permissions);
const shortcut = await actionShortcut();
let arms = [];
let requests = [];
let closing = false;

// The status line is below the buttons: with a long request text or the pin hint it is out of the small window's view,
// so what the click is waiting for is scrolled into view.
function say(text) {
  status.textContent = text;
  status.scrollIntoView?.({ block: 'nearest' });
}

function close() {
  if (closing) return;
  closing = true;
  window.close();
}

function render() {
  const arm = arms.find(item => item.tabId === tabId);
  if (!arm) {
    close();
    return;
  }
  const request = requests.find(item => item.requestId === arm.requestId) ?? null;
  const client = String(arm.client || request?.client || 'An agent').slice(0, 80);
  const host = request ? startTarget(request)?.host ?? '' : '';
  const reason = typeof request?.reason === 'string' && request.reason ? ` "${request.reason}"` : '';
  detail.textContent = `${client} asks for ${host || 'that page'}:${reason}. Click the FAI Browser icon there`
    + `${orShortcut(shortcut)}, or approve here at the level below. Your browser may ask for site access.`
    + ' Screenshots may still need a click on the toolbar icon. Browser site access covers this host on all ports; agent access stays within the approved origins.'
    + (arm.tabMode === 'multiple' ? ' Multiple task tabs: up to eight tabs on the approved site; allow browser site access when asked.'
      : ' One task tab: a new tab or popup pauses the task.');
  // The levels the request card would offer: at or below what the agent asked for (Test site only when every
  // requested origin is a listed test site). Without the request yet, only the armed level itself.
  const options = request ? levelChoices(request, permissions).options
    : [{ level: arm.level, ...LEVEL_TEXT[arm.level] }];
  const current = fillLevelSelect(select, options, arm.level);
  select.disabled = approving || options.length < 2;
  const chosen = options.find(option => option.level === current);
  help.textContent = chosen?.description ?? '';
  warning.hidden = current !== 'testing';
  select.setAttribute('aria-describedby', current === 'testing' ? 'level-help level-warning' : 'level-help');
  document.body.dataset.level = current;
  // A paused task resumed in a new tab (its card's "Resume in a new tab") says Resume, never the new-request Approve.
  approve.textContent = approving ? 'Approving…' : `${request?.state === 'paused' ? 'Resume at' : 'Approve'} ${chosen?.name ?? 'request'}`;
  // Enabled as soon as the request is known and the held check is in: a click before arm_prepare answers is kept.
  const pattern = request ? (sameArm(approval, arm) ? approval.pattern : sitePattern(arm, request)) : null;
  const asked = pattern ? askedPatterns(sameArm(approval, arm) ? approval : null, pattern, request) : [];
  approve.disabled = approving || !pattern || !checkHeld(asked);
  if (request && !sameArm(shownReported, arm)) {
    shownReported = arm;
    report(arm, 'shown');
  }
  if (!sameArm(approval, arm) && !sameArm(preparing?.arm, arm) && !approving && request) prepare(arm).catch(() => {});
}

// True once every pattern's held state is known; starts the checks that are missing (render runs again when they end).
function checkHeld(patterns) {
  const missing = patterns.filter(pattern => !heldBefore.has(pattern));
  for (const pattern of missing) {
    heldBefore.set(pattern, null);
    holds(pattern).then(held => { heldBefore.set(pattern, held); if (!approving) render(); });
  }
  return patterns.every(pattern => typeof heldBefore.get(pattern) === 'boolean');
}

const sameArm = (a, b) => Boolean(a && b && a.requestId === b.requestId && a.at === b.at);
const currentArm = () => arms.find(item => item.tabId === tabId) ?? null;

// The browser site access the click asks for before the worker has prepared the approval: the exact host of the page
// the arm opened (its recorded origin, else the request's start page), as the worker derives it when it cannot read
// the tab yet. The worker's prepared pattern wins once known, and the worker checks the permission itself.
function sitePattern(arm, request) {
  const origin = typeof arm?.origin === 'string' ? arm.origin : startTarget(request)?.origin;
  try {
    const url = new URL(origin);
    return /^https?:$/.test(url.protocol) ? `${url.protocol}//${url.hostname}/*` : null;
  } catch {
    return null;
  }
}

// What the click asks Chrome for: the task origin, plus the request's other exact origins (approved frames, sign-in
// hops) in the same prompt. With a prepared approval that is the worker's list; before it, the same list derived from
// the request (the worker tracks and checks them itself). The list is checked here, before the one request this gesture
// allows (Chrome rejects a bad pattern asynchronously, and a second request in that rejection would no longer count as
// the user's click): anything but plain host patterns led by the task's own asks for the task origin alone, so the task
// site can still be approved.
const PATTERN = /^https?:\/\/[^/*\s]+\/\*$/;
function askedPatterns(ready, pattern, request) {
  let patterns = ready?.patterns;
  if (!ready) {
    patterns = [pattern];
    for (const entry of Array.isArray(request?.origins) ? request.origins : []) {
      const extra = typeof entry === 'string' && !entry.includes('*') ? sitePattern({ origin: entry }) : null;
      if (extra && !patterns.includes(extra) && patterns.length < 11) patterns.push(extra);
    }
  }
  return Array.isArray(patterns) && patterns.length <= 11 && patterns[0] === pattern
    && patterns.every(item => typeof item === 'string' && PATTERN.test(item)) ? patterns : [pattern];
}

// Asks the worker to prepare the approval of this arm (arm_prepare). Resolves to the approval, or null when the arm
// changed meanwhile.
function prepare(arm) {
  const entry = { arm, job: null };
  entry.job = (async () => {
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'arm_prepare', tabId, requestId: arm.requestId, at: arm.at });
      if (reply?.error) throw new Error(reply.error);
      if (!reply?.approval?.pattern || !reply.approval.token) throw new Error('Use the toolbar icon to approve this request.');
      if (!sameArm(currentArm(), arm)) return null;
      approval = { ...reply.approval, requestId: arm.requestId, at: arm.at };
      if (restoreApprovalFocus && !approving) { approve.focus(); restoreApprovalFocus = false; }
      return approval;
    } catch (error) {
      if (!approving) status.textContent = error.message;
      throw error;
    } finally {
      if (preparing === entry) preparing = null;
    }
  })();
  preparing = entry;
  return entry.job;
}

// The browser's site-access prompt can stay unseen: Firefox shows it only in the active window, and in this chromeless
// window it has no toolbar to hang from, so a click on Approve could wait for it silently and then approve much later,
// when the prompt finally showed and was allowed (issue #36). The wait is bounded: after SITE_ACCESS_HINT_MS the card
// says where else to approve; after SITE_ACCESS_GIVE_UP_MS the click is given up (nothing is approved, ever, by a later
// answer to it) and the card says to use the toolbar icon on the task tab. Both are reported to daemon.log.
// `siteAccessWaitMs` in storage.local (tests only) can shorten the give-up, never lengthen it (as in the worker).
const SITE_ACCESS_GIVE_UP_MS = Number.isInteger(stored.siteAccessWaitMs) && stored.siteAccessWaitMs >= 1_000
  && stored.siteAccessWaitMs < 45_000 ? stored.siteAccessWaitMs : 45_000;
const SITE_ACCESS_HINT_MS = Math.min(5_000, Math.floor(SITE_ACCESS_GIVE_UP_MS / 2));
let shownReported = null;

// arm_report: one event for daemon.log (the worker adds the request's origin). Best effort.
function report(arm, step, reason = null) {
  if (!arm) return;
  chrome.runtime.sendMessage({ type: 'arm_report', tabId, requestId: arm.requestId, at: arm.at, step, reason }).catch(() => {});
}

function taskHost(arm) {
  const request = requests.find(item => item.requestId === arm?.requestId);
  return (request ? startTarget(request)?.host : null) || 'task';
}

// Resolves {granted} with the browser's answer, or {timedOut: true} once the click is given up. An answer that comes
// after that is handed to `late` (its grant is tracked so it is removed again; it approves nothing).
function siteAccessAnswer(arm, access, late) {
  return new Promise(resolve => {
    let done = false;
    const hint = setTimeout(() => {
      if (done) return;
      say(`Waiting for your answer to the browser's site-access prompt. If no prompt is showing, click once inside this window, `
        + `or click the FAI Browser icon on the ${taskHost(arm)} tab instead.`);
      report(arm, 'waiting', 'site_access_pending');
    }, SITE_ACCESS_HINT_MS);
    const giveUp = setTimeout(() => {
      done = true;
      clearTimeout(hint);
      resolve({ timedOut: true });
    }, SITE_ACCESS_GIVE_UP_MS);
    Promise.resolve(access).then(value => value === true, () => false).then(granted => {
      if (done) {
        late(granted);
        return;
      }
      done = true;
      clearTimeout(hint);
      clearTimeout(giveUp);
      resolve({ granted });
    });
  });
}

// A failure found here (not by the worker, which reports its own refusals): reported with its code.
const localFailure = (code, message) => Object.assign(new Error(message), { code, local: true });

approve.addEventListener('click', () => {
  const arm = currentArm();
  const request = arm ? requests.find(item => item.requestId === arm.requestId) : null;
  if (approving || !arm || !request) return;
  const ready = sameArm(approval, arm) ? approval : null;
  const pattern = ready?.pattern ?? sitePattern(arm, request);
  if (!pattern) return;
  const asked = askedPatterns(ready, pattern, request);
  if (!asked.every(item => typeof heldBefore.get(item) === 'boolean')) return;
  // This click's own snapshot: its grant changes the browser's permissions (and so heldBefore) before it is reported.
  const before = new Map(asked.map(item => [item, heldBefore.get(item)]));
  const level = select.value;
  approving = true;
  approve.disabled = true;
  approve.textContent = 'Approving…';
  select.disabled = true;
  // Native user gesture: no await, messaging or storage read before permissions.request.
  let access;
  let threw = false;
  try { access = chrome.permissions.request({ origins: asked }); }
  catch { access = Promise.resolve(false); threw = true; }
  report(arm, 'attempt', threw ? 'site_access_request_threw' : null);
  // Firefox shows the prompt only in the active window: when this window does not have focus, ask for it too (a desktop
  // may refuse a programmatic focus; the bounded wait below covers that).
  if (!threw && !document.hasFocus()) {
    chrome.windows?.getCurrent?.().then(win => chrome.windows.update(win.id, { focused: true })).catch(() => {});
  }
  // Clicked before arm_prepare answered: the click is kept, and approves as soon as the approval is ready.
  const prepared = ready ? Promise.resolve(ready) : sameArm(preparing?.arm, arm) ? preparing.job : prepare(arm);
  prepared.then(intent => {
    if (intent) chrome.runtime.sendMessage({ type: 'arm_begin', tabId, token: intent.token }).catch(() => {});
  }, () => {});
  say('Waiting for browser site access…');
  complete(arm, prepared, pattern, asked, before, access, level);
});

const holds = pattern => Promise.resolve(chrome.permissions?.contains?.({ origins: [pattern] })).then(held => held === true, () => false);

// What a click newly obtained goes to the worker, whatever happens to the approval, so it is removed again once no
// session needs it.
function trackObtained(arm, asked, before, granted) {
  const obtained = granted === true ? asked.filter(item => before.get(item) === false) : [];
  if (!obtained.length) return Promise.resolve();
  return chrome.runtime.sendMessage({ type: 'arm_track', tabId, requestId: arm.requestId, at: arm.at, patterns: obtained })
    .catch(() => {});
}

async function complete(arm, prepared, pattern, asked, before, access, level) {
  try {
    const answer = await siteAccessAnswer(arm, access, granted => {
      trackObtained(arm, asked, before, granted);
      if (granted && !approving && !closing) say('Site access was allowed after this approval was given up. Click Approve again.');
    });
    if (answer.timedOut) {
      throw localFailure('site_access_timeout', `Your browser did not show or answer its site-access prompt, so nothing `
        + `was approved. Click the FAI Browser icon on the ${taskHost(arm)} tab to approve there, or click Approve again.`);
    }
    let { granted } = answer;
    await trackObtained(arm, asked, before, granted);
    let intent = await prepared;
    if (!intent) throw localFailure('request_changed', 'This request changed. Check it and approve again.');
    // The worker read the tab's own URL: the access it needs is the one asked for, or one the browser already holds.
    if (intent.pattern !== pattern) granted = await holds(intent.pattern);
    if (granted === true) say('Approving…');
    let reply = await chrome.runtime.sendMessage({ type: 'arm_approve', tabId, ...intent, level, granted });
    if (reply?.code === 'stale_approval') {
      // The worker restarted after preparing: prepare again once and retry with the access the browser now holds (the
      // worker checks it, the request, the tab and its origin again).
      approval = null;
      intent = await prepare(arm);
      if (!intent) throw new Error('This request changed. Check it and approve again.');
      chrome.runtime.sendMessage({ type: 'arm_begin', tabId, token: intent.token }).catch(() => {});
      reply = await chrome.runtime.sendMessage({ type: 'arm_approve', tabId, ...intent, level, granted: await holds(intent.pattern) });
    }
    if (reply?.error) throw new Error(reply.error);
    if (reply?.status !== 'active' || reply?.session?.requestId !== intent.requestId || reply?.session?.tabId !== tabId) {
      throw localFailure('not_confirmed', 'Approval was not confirmed. Use the toolbar icon to check this request.');
    }
    close();
  } catch (error) {
    if (error.local) report(arm, 'failed', error.code);
    say(error.message);
    approval = null;
    restoreApprovalFocus = true;
  } finally {
    approving = false;
    render();
    if (!closing) approve.focus();
  }
}

select.addEventListener('change', async () => {
  const level = select.value;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'arm_level', tabId, level });
    if (reply?.error) throw new Error(reply.error);
    status.textContent = `Your approval will approve ${LEVEL_TEXT[level]?.name ?? level}.`;
  } catch (error) {
    status.textContent = error.message;
  }
});

deny.addEventListener('click', async () => {
  const arm = arms.find(item => item.tabId === tabId);
  if (!arm) {
    close();
    return;
  }
  deny.disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'deny', requestId: arm.requestId });
    if (reply?.error) throw new Error(reply.error);
    status.textContent = 'Request denied.';
  } catch (error) {
    deny.disabled = false;
    status.textContent = error.message;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.permissions) {
    permissions = normalizePermissions(changes.permissions.newValue);
    render();
  }
  if (area !== 'session') return;
  // The worker's word for this tab (an icon click on a page that had not loaded yet): shown here too.
  if (changes.openNotice?.newValue?.tabId === tabId && typeof changes.openNotice.newValue.message === 'string' && !approving) {
    say(changes.openNotice.newValue.message);
  }
  if (changes.armedTabs) arms = Array.isArray(changes.armedTabs.newValue) ? changes.armedTabs.newValue : [];
  if (changes.requests) requests = Array.isArray(changes.requests.newValue) ? changes.requests.newValue : [];
  // Only a different arm on the tab (another request, or the tab armed again) drops the prepared approval; a re-armed
  // look, a recorded tab group or another request in the list keeps it.
  if (approval && !sameArm(approval, currentArm())) approval = null;
  if (changes.armedTabs || changes.requests) render();
});

// Not pinned: the icon is in the puzzle-piece menu, so say how to pin it (the shortcut works either way).
iconPinned().then(pinned => {
  pinHint.textContent = shortcut ? `${PIN_HINT} Or press ${shortcut}.` : PIN_HINT;
  pinHint.hidden = pinned;
});

try {
  const shared = await chrome.storage.session.get(['armedTabs', 'requests']);
  arms = Array.isArray(shared.armedTabs) ? shared.armedTabs : [];
  requests = Array.isArray(shared.requests) ? shared.requests : [];
} catch {
  // storage.session is unavailable: nothing to show.
}
// Registered once the page's state exists (recheckHeld renders).
chrome.permissions?.onAdded?.addListener?.(recheckHeld);
chrome.permissions?.onRemoved?.addListener?.(recheckHeld);
render();
