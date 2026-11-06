// The waiting prompt for a page that opened by itself (arm.html?tab=<tabId>, opened by the worker's showPrompt next
// to the page's window): says to click the FAI Browser icon on that window, at which level, with a level choice and
// Deny. The choice never goes above what the agent asked for (permissions.js levelChoices; the worker checks again).
// It renders from chrome.storage.session (armedTabs, requests) and closes itself once its tab is no longer armed
// (approved, denied, expired or closed). Everything an agent wrote is rendered with textContent only.
import { LEVEL_TEXT, levelChoices, normalizePermissions, startTarget } from './permissions.js';
import { PIN_HINT, actionShortcut, fillLevelSelect, iconPinned, orShortcut } from './ui.js';

const tabId = Number(new URLSearchParams(location.search).get('tab'));
const detail = document.getElementById('detail');
const select = document.getElementById('level');
const help = document.getElementById('level-help');
const warning = document.getElementById('level-warning');
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
    + `${orShortcut(shortcut)} to let it use that tab at the level below. Nothing happens until you do.`;
  // The levels the request card would offer: at or below what the agent asked for (Test site only when every
  // requested origin is a listed test site). Without the request yet, only the armed level itself.
  const options = request ? levelChoices(request, permissions).options
    : [{ level: arm.level, ...LEVEL_TEXT[arm.level] }];
  const current = fillLevelSelect(select, options, arm.level);
  select.disabled = options.length < 2;
  const chosen = options.find(option => option.level === current);
  help.textContent = chosen?.description ?? '';
  warning.hidden = current !== 'testing';
  document.body.dataset.level = current;
}

select.addEventListener('change', async () => {
  const level = select.value;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'arm_level', tabId, level });
    if (reply?.error) throw new Error(reply.error);
    status.textContent = `The icon click will approve ${LEVEL_TEXT[level]?.name ?? level}.`;
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
