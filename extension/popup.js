// Popup: pending tab requests from agents (level and, for a domain root, site scope), the active session's Pause and
// Stop, setup state (pairing is automatic through the native host; Pair retries it), and an Advanced section (driver,
// approvals, test sites, budget, connection with the manual pairing fallback).
// Everything an agent wrote (reason, instruction, client, origins) is rendered with textContent only. The pairing
// secret is never shown or put into the page: its field only ever holds what the user types, and is cleared once saved.
import {
  LEVEL_TEXT, addTestingOrigin, budgetFromFields, describeBudget, describeOrigins, levelChoices, normalizeBudget,
  normalizeDomainMemory, normalizePermissions, normalizeRememberedSites, originCovered, promptNote, removeTestingOrigin,
  requestedLevel, requestRoots, scopeChoices, sitePattern, startTarget, SECRET_MODE_TEXT, normalizeSecretRedaction,
  addRelaxedOrigin, removeRelaxedOrigin,
} from './permissions.js';
import { mountApprovals } from './approval-card.js';
import { mountUpdate } from './update-card.js';
import {
  PIN_HINT, TESTING_WARNING, actionShortcut, allSitesGranted, askSiteAccess, element, fillLevelSelect, iconPinned,
  orShortcut, removeAllSites, replaceCardsPreservingFocus, requestAllSites,
} from './ui.js';

// The approval window the worker opens when an agent asks (popup.html?window=1): it has no current tab of its own,
// so every card opens its request's page, and it closes itself once nothing is left to approve.
const windowMode = new URLSearchParams(location.search).get('window') === '1';
const config = await chrome.storage.local.get(['endpoint', 'secret', 'status', 'permissions', 'domainMemory',
  'rememberedSites', 'approvalWindow', 'openRightAway', 'tabMode', 'budget', 'secretRedaction', 'trustedInput']);
// Only whether a secret is saved; its value never reaches the page.
let paired = typeof config.secret === 'string' && config.secret.length > 0;
delete config.secret;
let permissions = normalizePermissions(config.permissions);
let domainMemory = normalizeDomainMemory(config.domainMemory);
let rememberedSites = normalizeRememberedSites(config.rememberedSites);
// The user's per-request budget (null: not set, the daemon's default applies). The worker reports it to the daemon.
let budget = normalizeBudget(config.budget);
// The level and site scope the user picked on each request card, kept across re-renders.
const chosenLevels = new Map();
const chosenScopes = new Map();
// The https://*.<root>/* patterns Chrome already holds for this extension (chrome.permissions.contains), per pattern.
const heldPatterns = new Set();
const checkedPatterns = new Set();
// The bound toolbar shortcut ("Ctrl+Shift+Y"), read from chrome.commands; '' when none is set.
const shortcut = await actionShortcut();
const OPEN_ARMED = `On the opened tab, click the FAI Browser icon${orShortcut(shortcut)} to approve.`;
const ENDING_REMEMBERED = 'Ending the remembered site access first; approve again in a moment.';

const status = document.getElementById('status');
const stateLabel = document.getElementById('state-label');
const setupCard = document.getElementById('setup');
const setupText = document.getElementById('setup-text');
const pairButton = document.getElementById('pair');
const connectionLine = document.getElementById('connection-line');
const privacyNote = document.getElementById('privacy-note');
const pinHint = document.getElementById('pin-hint');
const endpointField = document.getElementById('endpoint');
const secretField = document.getElementById('secret');
const pause = document.getElementById('pause');
const stop = document.getElementById('stop');
const controls = document.getElementById('controls');
const requestList = document.getElementById('request-list');
const requestsEmpty = document.getElementById('requests-empty');
const transportLabel = document.getElementById('transport');
const defaultLevel = document.getElementById('default-level');
const testingList = document.getElementById('testing-list');
const testingEmpty = document.getElementById('testing-empty');
const testingOrigin = document.getElementById('testing-origin');
const testingAdd = document.getElementById('testing-add');
const testingError = document.getElementById('testing-error');
const rememberDomains = document.getElementById('remember-domains');
const rememberedList = document.getElementById('remembered-list');
const approvalWindow = document.getElementById('approval-window');
const openRightAway = document.getElementById('open-right-away');
const tabMode = document.getElementById('tab-mode');
const budgetCalls = document.getElementById('budget-calls');
const budgetMinutes = document.getElementById('budget-minutes');
const budgetEffective = document.getElementById('budget-effective');
const budgetError = document.getElementById('budget-error');
const driverButtons = { jev: document.getElementById('driver-jev'), agent: document.getElementById('driver-agent') };
const driverHelp = document.getElementById('driver-help');
const driverError = document.getElementById('driver-error');
const driverSaved = document.getElementById('driver-saved');
let savingDriver = false;
let savedDriver = null;
// The choice a failed switch asked for: its error clears once the service reports that choice in effect after all.
let failedDriver = null;
const keyRow = document.getElementById('key-row');
if (typeof config.endpoint === 'string' && config.endpoint) endpointField.value = config.endpoint;

// Shared view of the worker's state: {status, session, connection, requests}.
const view = { status: config.status, session: null, connection: null, requests: [] };
let currentOrigin = null;
let currentTabId = null;
let busy = false;
let closing = false;

const STATUS_TEXT = {
  active: "The agent is using its tab. Close that tab's window or press Stop to end it.",
  paused: 'Paused. The agent asks again when it needs the tab.',
  stopped: 'Stopped',
};

function showState(state) {
  view.status = state;
  const testing = state === 'active' && view.session?.level === 'testing';
  stateLabel.dataset.state = testing ? 'testing' : state === 'active' ? 'active' : state === 'paused' ? 'paused' : 'idle';
  stateLabel.textContent = testing ? 'TEST SITE' : {
    active: 'In use',
    paused: 'Paused',
    stopped: 'Stopped',
  }[state] ?? (paired ? 'Ready' : 'Setup needed');
  status.textContent = STATUS_TEXT[state]
    ?? (paired ? state || 'Waiting for an agent request. Its page opens in a new tab.' : '');
  render();
}

function age(createdAt) {
  const ms = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return 'just now';
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

function requestCard(request, { serving }) {
  const card = element('article', 'request-card');
  card.dataset.requestId = request.requestId;
  card.dataset.state = serving ? 'active' : request.state;
  const top = element('div', 'card-topline');
  const labels = { pending: 'TAB REQUEST', paused: 'PAUSED REQUEST', active: 'ACTIVE REQUEST' };
  const label = labels[serving ? 'active' : request.state] ?? 'TAB REQUEST';
  top.append(element('span', 'card-label', label), element('span', 'request-age', age(request.createdAt)));
  const says = element('p', 'agent-says');
  says.append(element('strong', '', 'Agent says: '), element('span', 'request-reason', String(request.reason ?? '')));
  card.append(top, says);
  if (request.instruction) card.append(element('p', 'request-instruction', String(request.instruction)));
  const origins = Array.isArray(request.origins) ? request.origins.map(String) : [];
  // A domain root reads "all of example.com", never as a wildcard pattern; an exact origin as itself.
  const described = describeOrigins(origins).join(', ');
  const asked = `asks for ${LEVEL_TEXT[requestedLevel(request)].name}`;
  const meta = [described, asked, request.client ? `from ${request.client}` : ''].filter(Boolean).join(' · ');
  card.append(element('p', 'request-meta', meta));
  const tabs = serving ? view.session?.tabMode : tabMode.value;
  card.append(element('p', 'field-help tab-access', tabs === 'multiple'
    ? 'Multiple task tabs: up to eight tabs on the approved site. Browser site access required.'
    : 'One task tab: a new tab or popup pauses the task.'));
  if (serving) {
    const granted = view.session?.level;
    if (LEVEL_TEXT[granted]) {
      card.dataset.level = granted;
      card.append(element('p', granted === 'testing' ? 'level-warning' : 'level-help', `Approved: ${LEVEL_TEXT[granted].name}`));
    }
    // The site the approval covers, for a request with a domain root: all of the root, or only the tab's origin.
    const scope = view.session?.scope;
    if (scopeChoices(request) && (scope === 'domain' || scope === 'origin')) {
      card.dataset.scope = scope;
      const roots = describeOrigins(origins.filter(origin => origin.includes('*'))).join(', ');
      card.append(element('p', 'level-help scope-approved', scope === 'domain'
        ? `Site: ${roots}`
        : `Site: only ${view.session?.origin ?? 'this tab\'s origin'}`));
    }
    return card;
  }
  const level = levelSelector(request);
  card.append(level.node);
  card.dataset.level = level.value();
  const mismatch = currentOrigin && origins.length && !originCovered(currentOrigin, origins);
  // "Approve on the FAI tab": in the approval window, a request the live session's own tab already covers (an agent
  // asking for a higher level on the tab it drives) is leased on that tab directly (the worker's approveOnSessionTab).
  const live = ['active', 'paused'].includes(view.status) ? view.session : null;
  const onFaiTab = Boolean(windowMode && live?.origin && live.requestId !== request.requestId
    && origins.length && originCovered(live.origin, origins));
  // "Open <host>": this tab (or a non-http one) does not cover the request, so the page opens in a new tab, armed:
  // the toolbar icon click there is the approval.
  const target = startTarget(request);
  const opens = Boolean(!onFaiTab && target && origins.length && (!currentOrigin || mismatch));
  const scope = mismatch && !opens ? null : scopeSelector(request, level.value, opens ? target.origin : currentOrigin);
  if (scope) {
    card.append(scope.node);
    card.dataset.scope = scope.value();
    level.onChange(scope.refresh);
  }
  if (mismatch) {
    const text = `This tab is on ${currentOrigin}; the agent asked for: ${described}`;
    card.append(element('p', 'request-mismatch', opens ? `${text}. Open ${target.host} opens it in a new tab; approve there with the FAI Browser icon.` : text));
  }
  const actions = element('div', 'request-actions');
  const approveText = request.state === 'paused' ? 'Resume on this tab' : 'Approve this tab';
  const approve = element('button', opens ? 'primary-button open-request'
    : onFaiTab ? 'primary-button fai-tab-request' : 'primary-button approve-request',
    opens ? `Open ${target.host}` : onFaiTab ? 'Approve on the FAI tab' : approveText);
  approve.type = 'button';
  // The approval window's own tab is never the one to approve: a request with no page to open is approved on its tab.
  approve.disabled = (Boolean(mismatch) && !opens && !onFaiTab) || (windowMode && !opens && !onFaiTab) || busy;
  if (windowMode && !opens && !onFaiTab) {
    card.append(element('p', 'request-mismatch', 'Open a page it asked for, then approve there with the FAI Browser icon.'));
  }
  approve.addEventListener('click', () => (opens ? openRequest(request, level.value(), scope, target)
    : onFaiTab ? approveRequest(request, level.value(), scope, true)
      : approveRequest(request, level.value(), scope)));
  actions.append(approve);
  if (target && !opens && !onFaiTab) {
    // This tab matches: approving it stays the primary path; the start URL can still get a new tab.
    const elsewhere = element('button', 'link-button open-request', 'Open in a new tab');
    elsewhere.type = 'button';
    elsewhere.disabled = busy;
    elsewhere.addEventListener('click', () => openRequest(request, level.value(), scope, target));
    actions.append(elsewhere);
  }
  const deny = element('button', 'link-button deny-request', request.state === 'paused' ? 'Release' : 'Deny');
  deny.type = 'button';
  deny.disabled = busy;
  deny.addEventListener('click', () => send('deny', { requestId: request.requestId }));
  actions.append(deny);
  card.append(actions);
  return card;
}

// The request card's level selector: only levels at or below what the agent asked for, preset to what it asked for
// (up to the "Preselect up to" setting). Test site appears only when every requested origin is a listed test site
// (the worker checks this again).
function levelSelector(request) {
  const { preset, options } = levelChoices(request, permissions);
  const offered = options.map(option => option.level);
  let chosen = chosenLevels.get(request.requestId);
  if (!offered.includes(chosen)) chosen = preset;
  const wrap = element('div', 'request-level');
  const id = `level-${request.requestId.replace(/[^\w-]/g, '_')}`;
  const label = element('label', '', 'Allow');
  label.htmlFor = id;
  const select = element('select', 'level-select');
  select.id = id;
  fillLevelSelect(select, options, chosen);
  select.disabled = busy || options.length < 2;
  const help = element('p', 'level-help');
  help.id = `${id}-help`;
  const warning = element('p', 'level-warning', TESTING_WARNING);
  warning.id = `${id}-warning`;
  select.setAttribute('aria-describedby', help.id);
  const update = () => {
    const option = options.find(item => item.level === select.value);
    help.textContent = option?.description ?? '';
    warning.hidden = select.value !== 'testing';
    select.setAttribute('aria-describedby', select.value === 'testing' ? `${help.id} ${warning.id}` : help.id);
    wrap.closest('.request-card')?.setAttribute('data-level', select.value);
  };
  const listeners = [];
  select.addEventListener('change', () => {
    chosenLevels.set(request.requestId, select.value);
    update();
    for (const listener of listeners) listener();
  });
  wrap.append(label, select, help, warning);
  update();
  return { node: wrap, value: () => select.value, onChange: listener => listeners.push(listener) };
}

// The request card's site choice for a domain root: "All of example.com" (preset, as the agent asked) or only the tab's
// exact origin. Rendered only when the request lists a domain root and this tab is on a page the request covers.
function scopeSelector(request, levelValue, here = currentOrigin) {
  const choice = scopeChoices(request, here);
  if (!choice) return null;
  let chosen = chosenScopes.get(request.requestId) ?? choice.preset;
  const wrap = element('fieldset', 'request-scope');
  wrap.append(element('legend', '', 'Site'));
  const name = `scope-${request.requestId.replace(/[^\w-]/g, '_')}`;
  const help = element('p', 'level-help');
  // Whether Chrome will prompt: it does not when the permission is already held (remembered, or allowed in the
  // extension's site access setting); a remembered grant counts only for Read and Use without submitting.
  const note = element('p', 'level-help scope-prompt');
  let prompt = null;
  const update = () => {
    help.textContent = choice.options.find(option => option.scope === chosen)?.help ?? '';
    prompt = promptNote(choice, { held: [...heldPatterns], remembered: rememberedSites, level: levelValue(), clock });
    note.textContent = prompt.text;
    note.dataset.kind = prompt.kind;
    note.hidden = chosen !== 'domain';
    wrap.closest('.request-card')?.setAttribute('data-scope', chosen);
    // Above the remembered levels on a remembered domain: end the remembered grant now, on the card, so the Approve
    // click can request the permission synchronously (inside its user gesture) and Chrome prompts again.
    if (prompt.kind === 'again' && chosen === 'domain') endRemembered(choice);
  };
  for (const option of choice.options) {
    const label = element('label', 'scope-option');
    const input = element('input');
    input.type = 'radio';
    input.name = name;
    input.value = option.scope;
    input.checked = option.scope === chosen;
    input.disabled = busy;
    input.addEventListener('change', () => {
      chosen = option.scope;
      chosenScopes.set(request.requestId, chosen);
      update();
    });
    label.append(input, element('span', option.scope === 'domain' ? 'scope-domain' : 'scope-origin', option.label));
    wrap.append(label);
  }
  wrap.append(help, note);
  update();
  return { node: wrap, value: () => chosen, patterns: choice.patterns, refresh: update, prompt: () => prompt };
}

// Removes a remembered grant's host permission and forgets the domain (the worker updates its list), then re-renders:
// the card then reads "Chrome asks you to allow site access". Approve waits for it (see askSiteAccess).
const endingRemembered = new Set();
function endRemembered(choice) {
  const patterns = choice.patterns.filter(pattern => !endingRemembered.has(pattern));
  if (!patterns.length || !chrome.permissions?.remove) return;
  for (const pattern of patterns) endingRemembered.add(pattern);
  Promise.resolve(chrome.permissions.remove({ origins: patterns })).catch(() => false).then(async () => {
    for (const root of choice.roots) await chrome.runtime.sendMessage({ type: 'forget', root }).catch(() => {});
    for (const pattern of patterns) {
      heldPatterns.delete(pattern);
      endingRemembered.delete(pattern);
    }
    rememberedSites = rememberedSites.filter(site => !choice.roots.includes(site.root));
    renderRemembered();
    render();
  });
}

// Asks Chrome which root patterns of the visible requests it already holds, then re-renders once.
async function checkHeld(requests) {
  if (!chrome.permissions?.contains) return;
  const patterns = [...new Set(requests.flatMap(request => requestRoots(request).map(sitePattern)))]
    .filter(pattern => !checkedPatterns.has(pattern));
  if (!patterns.length) return;
  for (const pattern of patterns) {
    checkedPatterns.add(pattern);
    try {
      if (await chrome.permissions.contains({ origins: [pattern] })) heldPatterns.add(pattern);
    } catch {
      // Unknown: treated as not held (Chrome will ask).
    }
  }
  render();
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Approve. For "All of <root>", Chrome's site-access prompt (askSiteAccess) is requested inside this click, before
// anything is awaited. A declined prompt falls back to the tab's exact origin, and the receipt's permissions.scope says
// "origin". The worker checks the permission itself before it asks for the domain.
function approveRequest(request, level, scope, onSessionTab = false) {
  const asked = askSiteAccess(scope, { requestId: request.requestId, level, origins: onSessionTab ? [view.session.origin] : currentOrigin ? [currentOrigin] : request.origins, tabMode: tabMode.value });
  if (asked.blocked) {
    status.textContent = ENDING_REMEMBERED;
    return Promise.resolve();
  }
  return asked.granted.then(ok => {
    const extra = scope ? { scope: ok ? 'domain' : 'origin' } : {};
    const note = asked.domain && !ok ? 'Chrome site access was not allowed: approved for this tab\'s origin only.' : '';
    return send('start', { requestId: request.requestId, level, tabMode: tabMode.value, ...(onSessionTab ? { onSessionTab: true } : {}), ...extra }, note);
  });
}

// Open <host>. No Chrome permission is needed for that: the worker opens the request's start URL in a new tab and
// arms that tab, and the toolbar icon click there is the approval (activeTab, which screenshots need). For "All of
// <root>", Chrome's prompt can close this popup before it resolves, so the worker opens and arms the tab itself when
// the permission arrives (`intent`: exactly one open, whichever comes first).
function openRequest(request, level, scope, target) {
  const asked = askSiteAccess(scope, { requestId: request.requestId, level, intent: true, origins: [new URL(target.url).origin], tabMode: tabMode.value });
  if (asked.blocked) {
    status.textContent = ENDING_REMEMBERED;
    return Promise.resolve();
  }
  return asked.granted.then(ok => {
    const note = asked.domain && !ok ? `Chrome site access was not allowed: ${target.host} opened for its own origin only. ${OPEN_ARMED}`
      : OPEN_ARMED;
    return send('open', { requestId: request.requestId, level, tabMode: tabMode.value, scope: asked.domain && ok ? 'domain' : 'origin' }, note)
      .then(opened => {
        if (opened && windowMode) window.close();
      });
  });
}

function renderRemembered() {
  rememberDomains.checked = domainMemory.remember;
  const items = rememberedSites.map(site => {
    const item = element('li');
    const forget = element('button', 'link-button', 'Forget');
    forget.type = 'button';
    forget.setAttribute('aria-label', `Forget ${site.root}`);
    forget.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'forget', root: site.root }).then(applyState, () => {});
    });
    item.append(element('code', '', `all of ${site.root}`), element('span', 'remembered-until', `until ${clock(site.until)}`), forget);
    return item;
  });
  rememberedList.replaceChildren(...items);
  rememberedList.hidden = !items.length;
}

// The budget fields show the user's own values (empty when not set) with the value in effect as the placeholder; the
// line under them says what applies now and where it comes from (the worker relays the daemon's answer).
const BUDGET_SOURCE = { extension: 'your setting', config: 'from config.json', default: 'default' };
function renderBudgetFields() {
  budgetCalls.value = budget ? String(budget.maxCalls) : '';
  budgetMinutes.value = budget ? String(Math.round(budget.maxMs / 60_000)) : '';
}
function renderBudgetEffective() {
  const effective = normalizeBudget(view.connection?.budget);
  const source = BUDGET_SOURCE[view.connection?.budget?.source] ?? (effective ? 'in effect' : 'default');
  const shown = effective ?? { maxCalls: 50, maxMs: 1_200_000 };
  budgetCalls.placeholder = String(shown.maxCalls);
  budgetMinutes.placeholder = String(Math.round(shown.maxMs / 60_000));
  budgetEffective.textContent = `In effect: ${describeBudget(shown)} (${source})`;
}
function saveBudget() {
  const result = budgetFromFields({ calls: budgetCalls.value, minutes: budgetMinutes.value });
  if (result.error) {
    budgetError.textContent = result.error;
    return;
  }
  budgetError.textContent = '';
  budget = result.budget;
  chrome.storage.local.set({ budget }).catch(error => {
    budgetError.textContent = `Could not save the budget: ${error.message}`;
  });
}

function renderDriver() {
  const control = view.connection?.control;
  if (savedDriver && (!view.connection?.connected || savedDriver !== control?.driver)) {
    savedDriver = null;
    driverSaved.textContent = '';
  }
  if (failedDriver && !savingDriver && view.connection?.connected && control?.driver === failedDriver) {
    failedDriver = null;
    driverError.textContent = '';
  }
  // The Jev key matters only to the experimental Jev autopilot.
  if (keyRow) keyRow.hidden = control?.driver !== 'jev';
  const ready = view.connection?.connected && control;
  for (const [driver, button] of Object.entries(driverButtons)) {
    button.setAttribute('aria-pressed', String(control?.driver === driver));
    button.disabled = !ready || savingDriver || (driver === 'jev' && !control?.jevAvailable);
  }
  driverHelp.textContent = !view.connection?.connected ? 'Connect to the FAI service to choose.'
    : !control ? 'Update the FAI service to switch browser control here.'
      : control.driver === 'agent' ? 'Your coding agent reads each page and chooses each step.'
        : 'Experimental: Jev carries out whole tasks for your agent.';
  if (ready && !control.jevAvailable) driverHelp.textContent += ' Jev needs its key: add it during setup.';
  // Where page text goes depends on who drives.
  privacyNote.textContent = control?.driver === 'jev'
    ? 'Only the approved tab is shared. Page text goes to your agent and the Jev provider.'
    : 'Only the approved tab is shared. Page text goes to your coding agent.';
}

async function switchDriver(driver) {
  if (savingDriver || driverButtons[driver].disabled || view.connection?.control?.driver === driver) return;
  savingDriver = true;
  failedDriver = null;
  driverError.textContent = '';
  driverSaved.textContent = 'Saving…';
  renderDriver();
  try {
    const result = await chrome.runtime.sendMessage({ type: 'set_driver', driver });
    if (result?.error) throw new Error(result.error);
    if (result?.connection?.control?.driver !== driver) throw new Error('The FAI service did not confirm the switch.');
    applyState(result);
    savedDriver = driver;
    driverSaved.textContent = `${driver === 'agent' ? 'Your agent drives' : 'Jev autopilot (experimental) is on'}. No restart needed.`;
  } catch (error) {
    driverSaved.textContent = '';
    driverError.textContent = error.message;
    failedDriver = driver;
    await chrome.runtime.sendMessage({ type: 'connect' }).then(applyState, () => {});
  } finally {
    savingDriver = false;
    renderDriver();
  }
}

for (const [driver, button] of Object.entries(driverButtons)) button.addEventListener('click', () => switchDriver(driver));

function renderPermissions() {
  // A ceiling saved as Reversible (before the popup merged it into Use) shows as Use.
  defaultLevel.value = permissions.defaultLevel === 'reversible' ? 'interactive' : permissions.defaultLevel;
  const items = permissions.testingOrigins.map(origin => {
    const item = element('li');
    const remove = element('button', 'link-button', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${origin}`);
    remove.addEventListener('click', () => savePermissions(removeTestingOrigin(permissions, origin)));
    item.append(element('code', '', origin), remove);
    return item;
  });
  testingList.replaceChildren(...items);
  testingEmpty.hidden = items.length > 0;
  renderRemembered();
}

async function savePermissions(next) {
  permissions = normalizePermissions(next);
  renderPermissions();
  render();
  try {
    await chrome.storage.local.set({ permissions });
  } catch (error) {
    testingError.textContent = `Could not save permissions: ${error.message}`;
  }
}

// The Approve gate's cards and settings live in their own module (extension/approval-card.js).
mountApprovals({ list: document.getElementById('approvals'), settings: document.getElementById('approval-settings') })
  .catch(() => {});
// "Update available" and the install's outcome (extension/update-card.js); installs only on the user's Update click.
mountUpdate({ card: document.getElementById('update'), label: document.getElementById('update-label'),
  text: document.getElementById('update-text'), notes: document.getElementById('update-notes'),
  button: document.getElementById('update-install'), error: document.getElementById('update-error') }).catch(() => {});
// Setup state: not paired or not reachable shows the setup card (Pair asks the native host, which also starts the FAI
// service); connected collapses to one line, everything else lives under Advanced.
function renderSetup() {
  const connected = Boolean(view.connection?.connected);
  paired ||= Boolean(view.connection?.paired);
  connectionLine.hidden = !connected;
  setupCard.hidden = connected || windowMode || !view.connection;
  if (setupCard.hidden) return;
  const native = view.connection?.native;
  setupText.textContent = native === 'missing'
    ? 'Automatic pairing is not installed. Run npm run setup in the fai-browser folder, then Pair.'
    : paired ? 'The FAI service is not answering. Reconnect starts it again.'
      : 'Run npm run setup in the fai-browser folder, then Pair.';
  pairButton.textContent = paired && native !== 'missing' ? 'Reconnect' : 'Pair with the FAI service';
}

function render() {
  const active = view.status === 'active';
  const servingId = active ? view.session?.requestId ?? null : null;
  const visible = (view.requests ?? []).filter(request => {
    if (request.requestId === servingId) return true;
    return request.state === 'pending' || request.state === 'paused';
  });
  if (windowMode && !closing && view.connection && !visible.some(request => ['pending', 'paused'].includes(request.state))) {
    // Approved, denied or expired: nothing left for this window.
    closing = true;
    window.close();
  }
  const cards = visible.map(request => requestCard(request, { serving: request.requestId === servingId }));
  checkHeld(visible);
  replaceCardsPreservingFocus(requestList, cards);
  const firstApprove = requestList.querySelector('.approve-request:not(:disabled)');
  if (firstApprove) firstApprove.id = 'approve';
  requestsEmpty.hidden = !view.connection?.connected || visible.length > 0;
  controls.hidden = !active;
  pause.hidden = !active;
  const transport = view.connection?.connected ? view.connection.transport : 'not connected';
  transportLabel.textContent = `Connection: ${transport}`;
  renderSetup();
  renderBudgetEffective();
  renderDriver();
}

function applyState(state) {
  if (!state || state.error) return;
  if (state.session !== undefined) view.session = state.session;
  if (state.connection) view.connection = state.connection;
  if (Array.isArray(state.requests)) view.requests = state.requests;
  if (state.status) showState(state.status);
  else render();
}

if (windowMode) {
  document.body.classList.add('approval-window');
  document.querySelector('.tab-card .card-label').textContent = 'AGENT REQUEST';
  document.getElementById('tab-title').textContent = 'An agent asks for a browser tab';
  document.getElementById('tab-origin').textContent = `Open its page, then click the FAI Browser icon there${orShortcut(shortcut)}.`;
} else try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  document.getElementById('tab-title').textContent = tab?.title || 'Current tab';
  const http = /^https?:/.test(tab?.url || '');
  currentOrigin = http ? new URL(tab.url).origin : null;
  currentTabId = tab?.id ?? null;
  const host = http ? new URL(tab.url).host : 'Open an HTTP page to use FAI Browser';
  document.getElementById('tab-origin').textContent = host;
} catch {
  document.getElementById('tab-title').textContent = 'Current tab';
}

try {
  const shared = await chrome.storage.session.get(['requests', 'connection', 'openNotice']);
  applyState({ requests: shared.requests ?? [], connection: shared.connection ?? null });
  // A tab whose arm was refused or ended: say what happened here.
  if (currentTabId !== null && shared.openNotice?.tabId === currentTabId) {
    status.textContent = typeof shared.openNotice.message === 'string' ? shared.openNotice.message : OPEN_ARMED;
  }
} catch {
  // storage.session is unavailable; the worker's reply below fills the view.
}
showState(config.status);
// Not pinned: the icon the user approves with is hidden in the puzzle-piece menu.
iconPinned().then(pinned => {
  pinHint.textContent = PIN_HINT;
  pinHint.hidden = pinned;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.domainMemory || changes.rememberedSites)) {
    if (changes.domainMemory) domainMemory = normalizeDomainMemory(changes.domainMemory.newValue);
    if (changes.rememberedSites) rememberedSites = normalizeRememberedSites(changes.rememberedSites.newValue);
    renderRemembered();
    render();
  }
  if (area === 'local' && changes.budget) {
    // Changed in another popup window: show it here too.
    budget = normalizeBudget(changes.budget.newValue);
    renderBudgetFields();
  }
  if (area === 'local' && changes.secret) paired = Boolean(changes.secret.newValue);
  if (area === 'local' && changes.permissions) {
    permissions = normalizePermissions(changes.permissions.newValue);
    renderPermissions();
    render();
    // A removed test site drops an active testing session to Act: refresh the tab card's label.
    chrome.runtime.sendMessage({ type: 'connect' }).then(applyState, () => {});
    return;
  }
  if (area !== 'session') return;
  applyState({
    requests: changes.requests ? changes.requests.newValue ?? [] : undefined,
    connection: changes.connection?.newValue,
  });
});

// Manual pairing (Advanced, Connection): saved as typed; the worker reconnects once typing settles. The secret field
// only ever holds what the user typed and is cleared once saved.
const saveEndpoint = () => {
  chrome.storage.local.set({ endpoint: endpointField.value.trim() }).catch(error => {
    status.textContent = `Could not save connection settings: ${error.message}`;
  });
};
endpointField.addEventListener('input', saveEndpoint);
endpointField.addEventListener('change', saveEndpoint);
secretField.addEventListener('change', () => {
  const value = secretField.value.trim();
  if (!value) return;
  chrome.storage.local.set({ secret: value }).then(() => {
    secretField.value = '';
    paired = true;
    status.textContent = 'Pairing secret saved. Connecting…';
  }, error => {
    status.textContent = `Could not save connection settings: ${error.message}`;
  });
});

function setBusy(value) {
  busy = value;
  for (const button of [pause, stop, pairButton, ...requestList.querySelectorAll('button, select, input')]) button.disabled = value;
}

async function send(type, extra = {}, note = '') {
  if (type === 'start' && !paired && !view.connection?.connected) {
    status.textContent = 'Pair with the FAI service first.';
    return;
  }
  setBusy(true);
  try {
    const result = await chrome.runtime.sendMessage({ type, ...extra });
    if (result?.error) throw new Error(result.error);
    busy = false;
    applyState(result);
    if (type === 'deny') status.textContent = 'Request denied.';
    if (type === 'pair') {
      paired = true;
      showState(view.status);
      status.textContent = view.connection?.connected ? 'Paired.' : 'Paired. Connecting…';
    }
    if (note) status.textContent = note;
    // The worker's own word (an "Approve on the FAI tab" that armed the tab instead) wins.
    if (typeof result?.note === 'string') status.textContent = result.note;
    return true;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    setBusy(false);
    render();
  }
}

for (const mode of ['pause', 'stop']) document.getElementById(mode).addEventListener('click', () => send(mode));
pairButton.addEventListener('click', () => send('pair').then(ok => {
  if (ok) paired = true;
}));

defaultLevel.addEventListener('change', () => savePermissions({ ...permissions, defaultLevel: defaultLevel.value }));
const addOrigin = () => {
  const result = addTestingOrigin(permissions, testingOrigin.value);
  if (result.error) {
    testingError.textContent = result.error;
    return;
  }
  testingError.textContent = '';
  testingOrigin.value = '';
  savePermissions(result.permissions);
};
testingAdd.addEventListener('click', addOrigin);
testingOrigin.addEventListener('keydown', event => {
  if (event.key === 'Enter') addOrigin();
});
testingOrigin.addEventListener('input', () => { testingError.textContent = ''; });
// Off by default. Turning it off makes the worker drop every remembered domain's site access at once.
rememberDomains.addEventListener('change', () => {
  domainMemory = { remember: rememberDomains.checked };
  chrome.storage.local.set({ domainMemory }).catch(error => {
    testingError.textContent = `Could not save permissions: ${error.message}`;
  });
});
renderPermissions();
// Secret redaction: Standard or Strict (never off) and the Relaxed origins (known formats only). Stored in
// chrome.storage.local only: an agent with a shell can edit config.json, not the browser's storage.
let secretRedaction = normalizeSecretRedaction(config.secretRedaction);
const secretMode = document.getElementById('secret-mode');
const secretModeHelp = document.getElementById('secret-mode-help');
const relaxedList = document.getElementById('relaxed-list');
const relaxedEmpty = document.getElementById('relaxed-empty');
const relaxedOrigin = document.getElementById('relaxed-origin');
const relaxedError = document.getElementById('relaxed-error');
function renderSecretRedaction() {
  secretMode.value = secretRedaction.mode;
  secretModeHelp.textContent = SECRET_MODE_TEXT[secretRedaction.mode];
  const items = secretRedaction.relaxed.map(origin => {
    const item = element('li');
    const remove = element('button', 'link-button', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${origin}`);
    remove.addEventListener('click', () => saveSecretRedaction(removeRelaxedOrigin(secretRedaction, origin)));
    item.append(element('code', '', origin), remove);
    return item;
  });
  relaxedList.replaceChildren(...items);
  relaxedEmpty.hidden = items.length > 0;
}
function saveSecretRedaction(next) {
  secretRedaction = normalizeSecretRedaction(next);
  renderSecretRedaction();
  chrome.storage.local.set({ secretRedaction }).catch(error => {
    relaxedError.textContent = `Could not save secret redaction: ${error.message}`;
  });
}
function addRelaxed() {
  const { settings, error } = addRelaxedOrigin(secretRedaction, relaxedOrigin.value);
  relaxedError.textContent = error ?? '';
  if (error) return;
  relaxedOrigin.value = '';
  saveSecretRedaction(settings);
}
secretMode.addEventListener('change', () => saveSecretRedaction({ ...secretRedaction, mode: secretMode.value }));
document.getElementById('relaxed-add').addEventListener('click', addRelaxed);
relaxedOrigin.addEventListener('keydown', event => {
  if (event.key === 'Enter') addRelaxed();
});
relaxedOrigin.addEventListener('input', () => { relaxedError.textContent = ''; });
renderSecretRedaction();
// Trusted input (trusted-input.js): offered only in the trusted-input build, the one whose manifest has the debugger
// permission (scripts/build-trusted.mjs); off by default.
const trustedInputRow = document.getElementById('trusted-input-row');
const trustedInput = document.getElementById('trusted-input');
if (typeof chrome.debugger?.attach === 'function') {
  trustedInputRow.hidden = false;
  trustedInput.checked = config.trustedInput === true;
  trustedInput.addEventListener('change', () => {
    chrome.storage.local.set({ trustedInput: trustedInput.checked }).catch(error => {
      testingError.textContent = `Could not save the setting: ${error.message}`;
    });
  });
}
// On by default: the worker opens the approval window when an agent asks for a tab. Off: the badge is the only sign.
approvalWindow.checked = config.approvalWindow !== false;
approvalWindow.addEventListener('change', () => {
  chrome.storage.local.set({ approvalWindow: approvalWindow.checked }).catch(error => {
    testingError.textContent = `Could not save permissions: ${error.message}`;
  });
});
// On by default (an absent value is on): the worker opens a request's page armed, with no click, at the requested
// level up to Use; Act and Test site requests get the window instead. The icon click still approves.
tabMode.value = config.tabMode === 'multiple' ? 'multiple' : 'single';
tabMode.addEventListener('change', () => {
  chrome.storage.local.set({ tabMode: tabMode.value }).then(render).catch(error => { status.textContent = error.message; });
});
openRightAway.checked = config.openRightAway !== false;
openRightAway.addEventListener('change', () => {
  chrome.storage.local.set({ openRightAway: openRightAway.checked }).catch(error => {
    testingError.textContent = `Could not save permissions: ${error.message}`;
  });
});
// Per-request budget: saved when a field is left (change), validated as whole numbers within the bounds; both empty
// removes the setting. Typing clears an earlier error.
renderBudgetFields();
for (const field of [budgetCalls, budgetMinutes]) {
  field.addEventListener('change', saveBudget);
  field.addEventListener('input', () => { budgetError.textContent = ''; });
  field.addEventListener('keydown', event => {
    if (event.key === 'Enter') saveBudget();
  });
}

// Site access: one choice, "Allow on all sites" (Advanced, and the setup card while setting up), asks the browser once
// for every http(s) site; the per-site prompts disappear. "Ask per site" gives it back. Levels and approvals stay.
const allSitesButton = document.getElementById('all-sites');
const allSitesState = document.getElementById('all-sites-state');
const setupAllSites = document.getElementById('setup-all-sites');
const setupAllSitesHelp = document.getElementById('setup-all-sites-help');
const ignoreError = promise => promise?.catch?.(() => {});
let allSites = false;
async function renderAllSites() {
  const granted = await allSitesGranted();
  allSites = granted;
  allSitesButton.textContent = granted ? 'Ask per site instead' : 'Allow on all sites';
  allSitesState.textContent = granted ? 'Allowed on all sites: no prompt per site.'
    : 'The browser asks for access per site when a task needs it.';
  setupAllSites.hidden = granted || windowMode;
  setupAllSitesHelp.hidden = setupAllSites.hidden;
}
// The browser's own prompt must open inside the click (Firefox counts only a synchronous call as user input): the
// request is the first thing the handler does, from the state the last render saw.
async function toggleAllSites(grant) {
  const done = grant ? requestAllSites() : removeAllSites();
  await done;
  await renderAllSites();
}
allSitesButton.addEventListener('click', () => ignoreError(toggleAllSites(!allSites)));
setupAllSites.addEventListener('click', () => ignoreError(toggleAllSites(true)));
ignoreError(renderAllSites());

// Opening the popup connects a paired worker that is not connected yet, and refreshes the view.
chrome.runtime.sendMessage({ type: 'connect' }).then(applyState, () => {});
// Initialized (handlers wired): test harnesses wait for this.
document.body.dataset.ready = '1';
