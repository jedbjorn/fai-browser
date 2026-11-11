// Popup: pending tab requests from agents (level and, for a domain root, site scope), the active session's Pause and
// Stop (right under the header, before every card, while an agent holds a tab), setup state (pairing is automatic
// through the native host; Pair retries it), and an Advanced section (approvals, test sites, budget, connection with
// the manual pairing fallback).
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
import { agentLabel, mountInvite } from './invite-card.js';
import {
  PIN_HINT, TESTING_WARNING, actionShortcut, allSitesGranted, askSiteAccess, element, fillLevelSelect, iconPinned,
  orShortcut, pressGuard, removeAllSites, replaceCardsPreservingFocus, requestAllSites,
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
const connectionText = document.getElementById('connection-text');
const pinHint = document.getElementById('pin-hint');
const endpointField = document.getElementById('endpoint');
const secretField = document.getElementById('secret');
const pause = document.getElementById('pause');
const stop = document.getElementById('stop');
const controls = document.getElementById('controls');
const requestList = document.getElementById('request-list');
// Re-renders wait while Approve (or any control in the list) is pressed, so the press still clicks it (pressGuard).
const holdRender = pressGuard(requestList);
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
if (typeof config.endpoint === 'string' && config.endpoint) endpointField.value = config.endpoint;

// Shared view of the worker's state: {status, session, connection, requests}.
const view = { status: config.status, session: null, connection: null, requests: [] };
let currentOrigin = null;
let currentTabId = null;
let busy = false;
let closing = false;
// "Invite agent" (extension/invite-card.js), mounted once the current tab is known.
let invitePanel = null;

const STATUS_TEXT = {
  active: "The agent is using its tab. Close that tab's window or press Stop to end it.",
  paused: 'Paused. The agent asks again when it needs the tab.',
  stopped: 'Stopped',
};

// `keepText`: only the label and the controls follow (a background refresh never replaces what the status line says).
function showState(state, { keepText = false } = {}) {
  view.status = state;
  const testing = state === 'active' && view.session?.level === 'testing';
  stateLabel.dataset.state = testing ? 'testing' : state === 'active' ? 'active' : state === 'paused' ? 'paused' : 'idle';
  stateLabel.textContent = testing ? 'TEST SITE' : {
    active: 'In use',
    paused: 'Paused',
    stopped: 'Stopped',
  }[state] ?? (paired ? 'Ready' : 'Setup needed');
  if (!keepText) {
    status.textContent = STATUS_TEXT[state]
      ?? (paired ? state || 'Waiting for an agent request. Its page opens in a new tab.' : '');
  }
  render();
}

function age(createdAt) {
  const ms = Date.now() - Date.parse(createdAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return 'just now';
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

// Whether a request is meant for this browser: one that names none (an older FAI service) or names this one.
function here(request) {
  if (typeof request?.browser?.mine === 'boolean') return request.browser.mine;
  const self = view.connection?.browserId;
  return !request?.browser?.id || !self || request.browser.id === self;
}

// A request that waits in another browser (several browsers are paired): what it asks, and Open here, which moves it
// to this browser, where it then shows as usual. Deny works from any browser.
function elsewhereCard(request) {
  const card = element('article', 'request-card elsewhere-request');
  card.dataset.requestId = request.requestId;
  card.dataset.state = 'elsewhere';
  const top = element('div', 'card-topline');
  top.append(element('span', 'card-label', 'IN ANOTHER BROWSER'), element('span', 'request-age', age(request.createdAt)));
  const says = element('p', 'agent-says');
  says.append(element('strong', '', 'Agent says: '), element('span', 'request-reason', String(request.reason ?? '')));
  const origins = Array.isArray(request.origins) ? request.origins.map(String) : [];
  const where = String(request.browser?.name || 'another browser');
  card.append(top, says, element('p', 'request-meta', [describeOrigins(origins).join(', '), `waiting in ${where}`]
    .filter(Boolean).join(' · ')));
  const actions = element('div', 'request-actions');
  const move = element('button', 'primary-button move-request', 'Open here');
  move.type = 'button';
  move.disabled = busy;
  move.addEventListener('click', () => send('move', { requestId: request.requestId }, 'Moved here. Approve it below.'));
  const deny = element('button', 'link-button deny-request', 'Deny');
  deny.type = 'button';
  deny.disabled = busy;
  deny.addEventListener('click', () => send('deny', { requestId: request.requestId }));
  actions.append(move, deny);
  card.append(actions);
  return card;
}

// "Connected to the FAI service", and the other browsers connected to it when there are any.
function renderBrowsers() {
  const others = (view.connection?.browsers ?? []).filter(browser => browser.self !== true)
    .map(browser => String(browser.name || browser.product || 'Browser'));
  connectionText.textContent = others.length
    ? ` Connected to the FAI service, with ${others.join(', ')}`
    : ' Connected to the FAI service';
}

// Why a request paused, in the user's words (the daemon's stateReason).
const PAUSE_TEXT = {
  paused: 'You paused it',
  // tab_changed covers a switch to another tab and a closed task tab alike.
  tab_changed: 'The task tab was left or closed',
  origin_changed: 'The tab left the site',
  child_tab: 'The page opened a new tab or window',
  session_inactive: 'The browser extension restarted',
  disconnected: 'The connection dropped',
};
// Why a paused task is listed under "Older paused tasks" (the daemon's `stale`).
const STALE_TEXT = {
  newer_request: 'Its agent has asked for another tab since.',
  idle: 'No agent is waiting for it.',
};

function requestCard(request, { serving }) {
  if (!serving && !here(request)) return elsewhereCard(request);
  const card = element('article', 'request-card');
  card.dataset.requestId = request.requestId;
  card.dataset.state = serving ? 'active' : request.state;
  const top = element('div', 'card-topline');
  // A new request and a paused task never look alike (issue #13): the label, the age and the button differ.
  const labels = { pending: 'NEW TAB REQUEST', paused: 'PAUSED TASK', active: 'ACTIVE REQUEST' };
  const label = labels[serving ? 'active' : request.state] ?? 'NEW TAB REQUEST';
  const paused = !serving && request.state === 'paused';
  const when = paused && request.pausedAt ? `paused ${age(request.pausedAt)}` : age(request.createdAt);
  top.append(element('span', 'card-label', label), element('span', 'request-age', when));
  const says = element('p', 'agent-says');
  says.append(element('strong', '', 'Agent says: '), element('span', 'request-reason', String(request.reason ?? '')));
  card.append(top, says);
  if (paused) {
    const why = [PAUSE_TEXT[request.stateReason], STALE_TEXT[request.stale]].filter(Boolean).join('. ').replace(/\.\.$/, '.');
    if (why) card.append(element('p', 'field-help pause-reason', why.endsWith('.') ? why : `${why}.`));
  }
  if (request.instruction) card.append(element('p', 'request-instruction', String(request.instruction)));
  const origins = Array.isArray(request.origins) ? request.origins.map(String) : [];
  // A domain root reads "all of example.com", never as a wildcard pattern; an exact origin as itself.
  const described = describeOrigins(origins).join(', ');
  const asked = `asks for ${LEVEL_TEXT[requestedLevel(request)].name}`;
  const meta = [described, asked, request.client ? `from ${request.client}` : ''].filter(Boolean).join(' · ');
  card.append(element('p', 'request-meta', meta));
  // FAI could not wake the agent after your Approve or Resume: it may be waiting for a message that never came.
  if (request.ownerWake?.state === 'failed') {
    const who = request.owner ? agentLabel(request.owner) : 'your agent';
    card.append(element('p', 'level-warning owner-wake-failed', `Could not wake ${who}. Tell it to continue.`));
  }
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
  // A paused task's Resume is a secondary button with its own words, never the primary Approve or Open of a new request.
  const approve = paused
    ? element('button', opens ? 'secondary-button resume-request resume-open' : 'secondary-button resume-request',
      opens ? `Resume in a new ${target.host} tab` : 'Resume on this tab')
    : element('button', opens ? 'primary-button open-request'
      : onFaiTab ? 'primary-button fai-tab-request' : 'primary-button approve-request',
    opens ? `Open ${target.host}` : onFaiTab ? 'Approve on the FAI tab' : 'Approve this tab');
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
    const elsewhere = element('button', paused ? 'link-button resume-open' : 'link-button open-request',
      paused ? 'Resume in a new tab' : 'Open in a new tab');
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

// Newest first by last activity: a new request by when the agent asked, a paused task by when it paused (else when it
// was asked for). The daemon lists requests in creation order, so a tie keeps the later one first.
const activity = request => String((request.state === 'paused' ? request.pausedAt : null) ?? request.createdAt ?? '');
function newestFirst(list) {
  return list.map((request, index) => ({ request, index }))
    .sort((a, b) => activity(b.request).localeCompare(activity(a.request)) || b.index - a.index)
    .map(({ request }) => request);
}

// At most this many paused tasks show in their section, and at most this many in the "Older paused tasks" fold before
// its "Show n more"; the rest of the paused tasks join the fold (one fold, never a fold inside a fold).
const PAUSED_SHOWN = 5;
// The fold stays open or closed, and shows all or only the first few, across re-renders once the user chose.
let staleOpen = false;
let staleAll = false;

// Pause and Stop show exactly while the session is active, and follow it live (the worker's `status` in storage). The
// row waits while the user presses anything in the popup, so it never moves a control mid-press; otherwise only its
// own height moves the cards below. Focus on Pause or Stop when the row hides goes on to the next control, not nowhere
// (Chrome may already have moved it to the body when the reply disabled the pressed button).
const holdRow = pressGuard(document.querySelector('.app'));
let rowHadFocus = false;
document.addEventListener('focusin', event => { rowHadFocus = controls.contains(event.target); });
function renderControls(active) {
  if (controls.hidden === !active) return;
  if (holdRow(render)) return;
  const focused = controls.contains(document.activeElement)
    || (rowHadFocus && (!document.activeElement || document.activeElement === document.body));
  controls.hidden = !active;
  pause.hidden = !active;
  if (focused && !active) {
    rowHadFocus = false;
    nextControl(controls)?.focus({ preventScroll: true });
  }
}
function nextControl(after) {
  return [...document.querySelectorAll('button, select, input, summary, a[href]')].find(node => !after.contains(node)
    && (after.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) && !node.disabled
    && node.getClientRects().length > 0);
}

function sectionLabel(text, className) {
  return element('p', `request-section ${className}`, text);
}

function render() {
  if (holdRender(render)) return;
  const active = view.status === 'active';
  const servingId = active ? view.session?.requestId ?? null : null;
  const visible = (view.requests ?? []).filter(request => {
    // An active invited tab has its own card (extension/invite-card.js).
    if (request.invite && request.state === 'active') return false;
    if (request.requestId === servingId) return true;
    // The approval window is for new requests only: a paused task is resumed from the toolbar popup (issue #13: its
    // Open button there looked like the new request's and took the click meant for it).
    if (windowMode) return request.state === 'pending';
    // Another browser's paused request stays there; its pending ones are listed with Open here.
    return request.state === 'pending' || (request.state === 'paused' && here(request));
  });
  if (windowMode && !closing && view.connection
    && !visible.some(request => request.state === 'pending' && here(request))) {
    // Approved, denied or expired: nothing left for this window.
    closing = true;
    window.close();
  }
  // New requests first and apart, then the task in use, then paused tasks to resume, then stale ones folded away: the
  // first button is always the newest request's, never an older task's (issue #13).
  const serving = visible.filter(request => request.requestId === servingId);
  const pending = newestFirst(visible.filter(request => request.requestId !== servingId && request.state === 'pending'));
  const paused = newestFirst(visible.filter(request => request.requestId !== servingId && request.state === 'paused'));
  const resumable = paused.filter(request => !request.stale);
  // The fold: stale tasks, and the paused tasks beyond the first PAUSED_SHOWN, newest first.
  const shownPaused = resumable.slice(0, PAUSED_SHOWN);
  const folded = paused.filter(request => !shownPaused.includes(request));
  const card = request => requestCard(request, { serving: request.requestId === servingId });
  const cards = [];
  if (pending.length && (serving.length || paused.length)) cards.push(sectionLabel('WAITING FOR YOUR APPROVAL', 'pending-section'));
  cards.push(...pending.map(card), ...serving.map(card));
  if (shownPaused.length) cards.push(sectionLabel('PAUSED TASKS', 'paused-section'), ...shownPaused.map(card));
  if (folded.length) {
    const fold = element('details', 'stale-requests');
    // The fold on screen says whether the user opened it (a toggle event can come after a re-render replaced it).
    const shown = requestList.querySelector('.stale-requests');
    if (shown) staleOpen = shown.open;
    fold.open = staleOpen;
    const inFold = staleAll ? folded : folded.slice(0, PAUSED_SHOWN);
    fold.append(element('summary', 'request-section stale-section', `Older paused tasks (${folded.length})`), ...inFold.map(card));
    if (inFold.length < folded.length) {
      const more = element('button', 'link-button show-more', `Show ${folded.length - inFold.length} more`);
      more.type = 'button';
      more.addEventListener('click', () => {
        staleAll = true;
        render();
      });
      fold.append(more);
    }
    cards.push(fold);
  }
  checkHeld(visible);
  replaceCardsPreservingFocus(requestList, cards);
  const firstApprove = requestList.querySelector('.approve-request:not(:disabled)');
  if (firstApprove) firstApprove.id = 'approve';
  requestsEmpty.hidden = !view.connection?.connected || visible.length > 0;
  renderControls(active);
  const transport = view.connection?.connected ? view.connection.transport : 'not connected';
  transportLabel.textContent = `Connection: ${transport}`;
  renderBrowsers();
  renderSetup();
  renderBudgetEffective();
  invitePanel?.render();
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
  // The session started, paused or ended while this popup (or the approval window) is open: approved in the page's
  // request modal, released by the agent, its tab closed, its budget spent. Follow it at once, then ask the worker for
  // the session itself (its request, tab and level). A change this popup's own Pause, Stop or Approve already applied
  // from the worker's reply is no change here.
  if (area === 'local' && changes.status && (changes.status.newValue ?? null) !== (view.status ?? null)) {
    showState(changes.status.newValue);
    chrome.runtime.sendMessage({ type: 'connect' }).then(state => {
      if (!state || state.error) return;
      applyState({ ...state, status: undefined });
      if (state.status) showState(state.status, { keepText: true });
    }, () => {});
  }
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

// "Invite agent": the tab the user is on, for a live agent session (one tap), at the level last chosen for invites.
invitePanel = mountInvite({
  root: document.getElementById('invite'),
  context: () => ({ connected: Boolean(view.connection?.connected), currentOrigin, currentTabId, windowMode,
    testingOrigins: permissions.testingOrigins, session: view.session, requests: view.requests, here }),
  onState: applyState,
  say: text => { status.textContent = text; },
});

// Opening the popup connects a paired worker that is not connected yet, and refreshes the view (and the agent list).
chrome.runtime.sendMessage({ type: 'connect' }).then(state => {
  applyState(state);
  invitePanel.refresh();
}, () => {});
// Initialized (handlers wired): test harnesses wait for this.
document.body.dataset.ready = '1';
