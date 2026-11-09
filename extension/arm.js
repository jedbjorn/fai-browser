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
let approval = null;
let preparing = false;
let approving = false;
let restoreApprovalFocus = false;
const deny = document.getElementById('deny');
const status = document.getElementById('status');
const pinHint = document.getElementById('pin-hint');

let permissions = normalizePermissions((await chrome.storage.local.get(['permissions']).catch(() => ({}))).permissions);
const shortcut = await actionShortcut();
let arms = [];
let requests = [];
let closing = false;

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
  approve.textContent = `Approve ${chosen?.name ?? 'request'}`;
  approve.disabled = approving || !approval || !request;
  if (!approval && !preparing && !approving && request) prepare(arm);
}

async function prepare(arm) {
  preparing = true;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'arm_prepare', tabId, requestId: arm.requestId, at: arm.at });
    if (reply?.error) throw new Error(reply.error);
    if (!reply?.approval?.pattern || !reply.approval.token) throw new Error('Use the toolbar icon to approve this request.');
    if (!arms.some(item => item.tabId === tabId && item.requestId === arm.requestId && item.at === arm.at)) return;
    approval = { ...reply.approval, requestId: arm.requestId, at: arm.at };
    approve.disabled = false;
    if (restoreApprovalFocus) { approve.focus(); restoreApprovalFocus = false; }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    preparing = false;
  }
}

approve.addEventListener('click', async () => {
  if (!approval || approving) return;
  const intent = approval;
  const level = select.value;
  approving = true;
  approve.disabled = true;
  select.disabled = true;
  // Native user gesture: no await, messaging or storage read before permissions.request.
  let access;
  // The task origin, plus the request's other exact origins (approved frames, sign-in hops) in the same prompt. The
  // list is checked here, before the one request this gesture allows (Chrome rejects a bad pattern asynchronously, and
  // a second request in that rejection would no longer count as the user's click): anything but plain host patterns
  // led by the task's own asks for the task origin alone, so the task site can still be approved.
  const PATTERN = /^https?:\/\/[^/*\s]+\/\*$/;
  const origins = Array.isArray(intent.patterns) && intent.patterns.length <= 11 && intent.patterns[0] === intent.pattern
    && intent.patterns.every(pattern => typeof pattern === 'string' && PATTERN.test(pattern)) ? intent.patterns : [intent.pattern];
  try { access = chrome.permissions.request({ origins }); }
  catch { access = Promise.resolve(false); }
  chrome.runtime.sendMessage({ type: 'arm_begin', tabId, token: intent.token }).catch(() => {});
  status.textContent = 'Waiting for browser site access…';
  try {
    const granted = await Promise.resolve(access).catch(() => false);
    const reply = await chrome.runtime.sendMessage({ type: 'arm_approve', tabId, ...intent, level, granted });
    if (reply?.error) throw new Error(reply.error);
    if (reply?.status !== 'active' || reply?.session?.requestId !== intent.requestId || reply?.session?.tabId !== tabId) {
      throw new Error('Approval was not confirmed. Use the toolbar icon to check this request.');
    }
    close();
  } catch (error) {
    status.textContent = error.message;
    approval = null;
    restoreApprovalFocus = true;
  } finally {
    approving = false;
    render();
    if (!closing) approve.focus();
  }
});

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
  if (changes.armedTabs) arms = Array.isArray(changes.armedTabs.newValue) ? changes.armedTabs.newValue : [];
  if (changes.requests) requests = Array.isArray(changes.requests.newValue) ? changes.requests.newValue : [];
  if (approval && !arms.some(item => item.tabId === tabId && item.requestId === approval.requestId && item.at === approval.at)) approval = null;
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
render();
