// Runs extension/background.js in a VM against a fake Chrome API, a fake WebSocket and a fake daemon, to check
// the worker's side of protocol v3: connect when paired, hello, pending requests and badge, lease binding,
// pushed commands, one injection per document, error codes, async screenshots, cancel, lease_update, ping,
// reconnect backoff, the reconnect alarm, and the long-poll fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
// The worker loads the Public Suffix List with importScripts('psl-data.js'); the harness runs it in the VM first.
const pslData = await readFile(new URL('../extension/psl-data.js', import.meta.url), 'utf8');
// Approved cross-origin frames: the worker loads frames.js with importScripts too (globalThis.faiFrames).
const framesSource = await readFile(new URL('../extension/frames.js', import.meta.url), 'utf8');
const ORIGIN = 'https://example.com';
const ENDPOINT = 'http://127.0.0.1:4318';
const SECRET = 'x'.repeat(30);
const LEASE_ID = 'lease-1';
// The Approve gate's asks the worker reports with its settings (all on by default).
const ASKS = { purchase: true, secret: true, level: true };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));

/**
 * options.ws: 'open' (default) or 'fail' (every WebSocket closes before open).
 * options.http: 'ok' (default) or 'fail' (every fetch rejects).
 * options.paired: start with a saved pairing (default true).
 * options.timeScale: multiplies worker timer delays (to run backoff quickly); delays are recorded unscaled.
 */
const live = new Set();
test.afterEach(() => {
  for (const h of live) h.dispose();
  live.clear();
});

// options.hostGrants: Chrome's granted optional host permissions (patterns); given, the fake has chrome.permissions.
// options.local: extra chrome.storage.local values. options.leaseOrigins: the lease reply's origins (or a function of
// the lease message). options.leaseError: the lease is refused with this error code.
// options.daemonBudget: the per-request budget the fake daemon reports in effect (hello and settings replies).
function harness({ ws = 'open', http = 'ok', paired = true, timeScale = 1, mode = 'daemon', leaseOrigins = null, permissions,
  hostGrants, local: extraLocal = {}, leaseError = null, opened = null, sessionStore = {}, daemonBudget = null,
  native = null, actionOpenPopup = null, lastWindow = undefined, normalWindows = [], tabCreateFails = false,
  daemonVersion = '0.2.0', daemonUpdate = null, manifest = {} } = {}) {
  const reloads = []; // chrome.runtime.reload() calls (an update's reload of the unpacked extension)
  const nativeCalls = []; // chrome.runtime.sendNativeMessage(host, message) calls
  const events = name => ({
    listeners: [],
    addListener(listener) { this.listeners.push(listener); },
    removeListener(listener) { this.listeners = this.listeners.filter(l => l !== listener); },
    emit(...args) { for (const listener of [...this.listeners]) listener(...args); },
    name,
  });
  const state = { ws, http };
  const sent = []; // every extension->daemon message, from either transport: {via, type, ...}
  const sockets = [];
  const delays = [];
  const intervals = [];
  const local = paired ? { endpoint: ENDPOINT, secret: SECRET } : {};
  if (permissions) local.permissions = permissions;
  Object.assign(local, extraLocal);
  const grants = new Set(hostGrants ?? []);
  const removed = [];
  const windowsCreated = []; // fallback normal windows
  const tabsCreated = []; // task tabs in an existing normal window
  const popupWindows = []; // chrome.windows.create options for the approval and prompt windows (type popup)
  const openPopups = new Set(); // approval and prompt windows not closed yet
  const windowUpdates = [];
  const actionPopupCalls = [];
  const windowsRemoved = []; // chrome.windows.remove ids
  // Tabs that openTaskTab created, as chrome.tabs.get reports them once loaded; `opened` overrides url and title.
  const openedTabs = new Map();
  const permissionAdded = events('onAdded');
  const session = clone(sessionStore);
  const badges = []; // global badge text
  const tabBadges = new Map(); // per-tab badge text (null: cleared to the global text)
  const tabPopups = new Map(); // per-tab popup set by chrome.action.setPopup (armed tabs)
  const groupOf = new Map(); // tabId -> groupId; absent: ungrouped
  const groups = new Map(); // groupId -> { title, color }
  let nextGroup = 100;
  const alarms = events('onAlarm');
  const alarmsCreated = [];
  const pollQueue = [];
  let deliverPoll = null;
  let activeTabId = 7;
  let injections = 0;
  let pageCalls = 0;
  let revision = 1;
  // The leased tab as chrome.tabs.get reports it; navigate() changes it over time.
  const tab = { url: ORIGIN + '/', status: 'complete' };
  // Arguments of every page.js call, and an optional override of an executeScript call by page method.
  const pageArgs = [];
  // The secret-redaction options the worker sent with each page call (pageCall's third argument), and the text the
  // fake page reports (a test puts page.js's `[secret:~<hash>` tags in it).
  const secretCalls = [];
  const gateCalls = [];
  let observationText = 'Hello';
  let pageVault = null;
  let scriptOverride = null;
  // Approved frames: fields the fake top page adds to its observation (frameSlots, pageFacts), and a handler for every
  // executeScript aimed at frames (allFrames, frameIds or documentIds); see frameWorld below.
  let observationExtra = null;
  let frameScript = null;
  const observation = () => ({
    ...(typeof observationExtra === 'function' ? observationExtra() : clone(observationExtra ?? {})),
    revision: `doc:${revision}`,
    documentId: 'doc',
    url: tab.url,
    title: 'Fixture',
    text: observationText,
    textTruncated: false,
    blocks: [{ t: 'h1', text: 'Hello' }, { t: 'button', text: 'Show', ref: '1' }, { t: 'p', text: 'Later', offscreen: true }],
    blocksTruncated: false,
    controls: [{ id: '1', role: 'button', label: 'Show', bounds: { x: 0, y: 0, width: 10, height: 10 } }],
    viewport: { width: 100, height: 100, dpr: 1 },
  });
  // Stand-in for page.js; installed on the VM global when the worker injects files: ['page.js'].
  // `pageExecute`, when set, replaces the page's execute (after the revision check).
  let pageExecute = null;
  // Screenshot redaction: page.js's secret boxes before and after the capture (`arm` true before). `redaction`, when
  // set, replaces the default (no boxes, a page that held still).
  let redaction = null;
  const redactionCalls = [];
  // The Approve gate: what page.js reports for a control (approvalInfo); `approvalInfo` replaces it.
  let approvalInfo = null;
  const fakePage = {
    approvalInfo(target, expectedRevision, ...rest) {
      pageArgs.push({ method: 'approvalInfo', args: clone([target, expectedRevision, ...rest]) });
      if (expectedRevision !== `doc:${revision}`) throw Object.assign(new Error('Stale observation'), { code: 'stale' });
      if (approvalInfo) return approvalInfo(target, expectedRevision);
      return { revision: `doc:${revision}`, documentId: 'doc', target, label: 'Show', labelHash: 'h-show', cls: 'secret' };
    },
    useGates: settings => { gateCalls.push(clone(settings)); },
    redactionRects(options) {
      redactionCalls.push(clone(options ?? {}));
      if (redaction) return redaction(options ?? {}, redactionCalls.length);
      return { rects: [], viewport: { width: 100, height: 100, dpr: 1 }, scroll: { x: 0, y: 0 }, strict: false,
        ...(options?.arm ? {} : { dirty: false }) };
    },
    useSecrets: settings => { secretCalls.push(clone(settings)); },
    observe: (...args) => {
      pageArgs.push({ method: 'observe', args: clone(args) });
      // Secret handles: the values page.js redacted, handed over with the result (only when the worker asks).
      if (pageVault && secretCalls.at(-1)?.vault === true) return { ...observation(), __faiVault: clone(pageVault) };
      return observation();
    },
    execute(action, expectedRevision, settleOptions, terms, forbid, allow, sites, expectText, approval) {
      pageArgs.push({ method: 'execute', args: clone([action, expectedRevision, settleOptions, terms ?? null, forbid ?? null, allow ?? null]),
        context: clone(secretCalls.at(-1)?.context ?? null),
        expectText: clone(expectText ?? null), approval: clone(approval ?? null) });
      if (expectedRevision !== `doc:${revision}`) throw Object.assign(new Error('Stale observation'), { code: 'stale' });
      revision++;
      if (pageExecute) return pageExecute(action);
      return {
        fromUrl: ORIGIN + '/',
        target: { id: '1', role: 'button', label: 'Show' },
        settle: { reason: 'quiet', ms: 5 },
        observation: observation(),
      };
    },
    settleAndObserve: (...args) => {
      pageArgs.push({ method: 'settleAndObserve', args: clone(args) });
      return { settle: { reason: 'quiet', ms: 5 }, observation: observation() };
    },
    // A point click's locate: the one control when the point is inside its box, else no_control.
    locate(point, expectedRevision, ...rest) {
      pageArgs.push({ method: 'locate', args: clone([point, expectedRevision, ...rest]) });
      if (expectedRevision !== `doc:${revision}`) throw Object.assign(new Error('Stale observation'), { code: 'stale' });
      const control = observation().controls[0];
      if (point.x < 10 && point.y < 10) return { id: control.id, control };
      throw Object.assign(new Error('No clickable control is at that point'), { code: 'no_control' });
    },
  };
  const annotations = []; // every annotate message sent to the offscreen document
  const clipboard = []; // every clipboard_write the offscreen document received

  // The fake daemon's answer to a ref'd message.
  function answer(message) {
    if (message.type === 'hello') {
      return { ok: true, data: { mode, daemonVersion: state.daemonVersion ?? daemonVersion, endSession: false, ...(daemonUpdate ? { update: daemonUpdate } : {}),
        ...(daemonBudget ? { budget: daemonBudget } : {}) } };
    }
    if (message.type === 'update' && daemonUpdate) {
      if (message.action === 'install' && state.updateError) return { ok: false, error: { code: 'lease_active', message: state.updateError } };
      const install = message.action === 'install' ? { state: 'running', to: daemonUpdate.latest, message: 'Installing.' } : daemonUpdate.install;
      return { ok: true, data: { update: { ...daemonUpdate, install: install ?? null } } };
    }
    if (message.type === 'settings') {
      // Like the daemon: the user's budget when set, else what applied before.
      const budget = message.settings?.budget ? { ...message.settings.budget, source: 'extension' } : daemonBudget;
      return { ok: true, data: budget ? { budget } : {} };
    }
    if (message.type === 'lease') {
      if (leaseError) return { ok: false, error: { code: leaseError, message: 'Refused' } };
      const origins = typeof leaseOrigins === 'function' ? leaseOrigins(message) : leaseOrigins;
      return { ok: true, data: { leaseId: LEASE_ID, requestId: message.requestId, grant: { tabMode: message.tabMode ?? 'single' }, ...(origins ? { origins } : {}) } };
    }
    if (message.type === 'validate') return { ok: true, data: { valid: true } };
    if (message.type === 'invite') {
      return { ok: true, data: { leaseId: LEASE_ID, requestId: 'req_inv', grant: { level: message.level, tabMode: 'single' },
        origins: [message.origin], invite: { inviteId: 'inv-abcd2345', state: 'open', wake: { state: 'queued' } } } };
    }
    if (message.type === 'agents') {
      return { ok: true, data: { sessions: [{ sessionId: 'ses_1', host: 'claude', repo: 'fai-browser', lastActiveAt: new Date().toISOString(),
        wake: 'claude-socket', ready: true, key: 'NEVER-SHOWN', pid: 4242 }, { sessionId: 'ses_2', host: 'evil<host>', repo: 'r\u0007x' }] } };
    }
    if (message.type === 'invite_cancel') return { ok: true, data: { invite: { inviteId: message.inviteId, state: 'cancelled' } } };
    return { ok: true, data: { ok: true } };
  }

  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      sockets.push(this);
      setTimeout(() => {
        if (state.ws === 'open') {
          this.readyState = 1;
          this.onopen?.({});
        } else {
          this.readyState = 3;
          this.onclose?.({ code: 1006 });
        }
      }, 1);
    }

    send(text) {
      const message = JSON.parse(text);
      sent.push({ via: 'ws', ...message });
      if (message.ref !== undefined) {
        setTimeout(() => this.deliver({ v: 3, type: 'reply', ref: message.ref, ...answer(message) }), 1);
      }
    }

    deliver(message) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }

    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => this.onclose?.({ code: 1000 }), 1);
    }

    // The service closes the socket with `code` (4003: this browser's newer connection took over).
    serverClose(code) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setTimeout(() => this.onclose?.({ code }), 1);
    }
  }

  const context = {};
  const chrome = {
    runtime: {
      id: 'ext',
      onMessage: events('onMessage'),
      onStartup: events('onStartup'),
      onInstalled: events('onInstalled'),
      getManifest: () => ({ version: '0.3.0', ...manifest }),
      reload: () => reloads.push(Date.now()),
      getURL: path => `chrome-extension://ext/${path}`,
      ...(native ? { async sendNativeMessage(host, message) {
        nativeCalls.push({ host, message: clone(message) });
        return native(host, message);
      } } : {}),
      async sendMessage(message) {
        // A secret the user approved copying (copy_secret): the offscreen document writes the clipboard.
        if (message.type === 'clipboard_write') {
          clipboard.push(message.text);
          return { ok: true };
        }
        assert.equal(message.type, 'annotate');
        annotations.push(clone(message));
        const tags = message.labels ? Object.entries(message.labels).map(([ref, ids]) => ({ id: ids[0], ref, x: 0, y: 0, width: 20, height: 18 })) : undefined;
        return { dataUrl: 'data:image/jpeg;base64,QUJD', width: 100, height: 100, encoder: 'dom', timings: { encodeMs: 1 },
          ...(tags ? { tags } : {}), redactions: message.redact?.rects?.length, withheld: message.redact?.withheld };
      },
    },
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(keys.filter(key => key in local).map(key => [key, local[key]]));
        },
        async set(values) { Object.assign(local, values); },
        setAccessLevel: async () => {},
      },
      session: {
        async get(keys) {
          const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(session);
          return clone(Object.fromEntries(list.filter(key => key in session).map(key => [key, session[key]])));
        },
        async set(values) { Object.assign(session, clone(values)); },
      },
      onChanged: events('onChanged'),
    },
    action: {
      async setBadgeText({ tabId, text }) {
        if (tabId === undefined) badges.push(text);
        else tabBadges.set(tabId, text);
      },
      async setBadgeBackgroundColor() {},
      async setTitle() {},
      async setPopup({ tabId, popup }) { tabPopups.set(tabId, popup); },
      ...(actionOpenPopup ? {
        async openPopup() {
          actionPopupCalls.push({});
          if (actionOpenPopup === 'error') throw new Error('User gesture required');
        },
      } : {}),
      onClicked: events('onClicked'),
    },
    alarms: {
      async create(name, info) { alarmsCreated.push({ name, ...info }); },
      onAlarm: alarms,
    },
    tabGroups: {
      async update(groupId, info) { Object.assign(groups.get(groupId), info); },
    },
    offscreen: { async hasDocument() { return true; }, async createDocument() {} },
    ...(hostGrants ? {
      permissions: {
        onAdded: permissionAdded,
        async contains({ origins }) { return origins.every(origin => grants.has(origin)); },
        async getAll() { return { permissions: [], origins: ['http://127.0.0.1:4318/*', ...grants] }; },
        async remove({ origins }) {
          assert.ok(!origins.includes('http://127.0.0.1:4318/*'), 'the required companion permission is never removed');
          for (const origin of origins) {
            removed.push(origin);
            grants.delete(origin);
          }
          return true;
        },
      },
    } : {}),
    windows: {
      async getLastFocused(options) {
        assert.equal(options?.windowTypes?.length, 1);
        assert.equal(options.windowTypes[0], 'normal');
        if (lastWindow === null) throw new Error('No normal window');
        return lastWindow ?? { id: 2, type: 'normal', incognito: false, left: 100, top: 50, width: 1200, height: 800 };
      },
      async getAll(options) {
        assert.deepEqual(clone(options), { windowTypes: ['normal'] });
        return normalWindows;
      },
      async get(id) {
        if (!openPopups.has(id) && id !== 2) throw new Error(`No window with id: ${id}.`);
        return { id };
      },
      async update(id, info) { windowUpdates.push({ id, ...info }); return { id }; },
      async remove(id) {
        if (!openPopups.has(id)) throw new Error(`No window with id: ${id}.`);
        openPopups.delete(id);
        windowsRemoved.push(id);
      },
      async create(options) {
        if (options.type === 'popup') {
          popupWindows.push(options);
          openPopups.add(30 + popupWindows.length);
          return { id: 30 + popupWindows.length, type: 'popup', tabs: [{ id: 40 + popupWindows.length }] };
        }
        windowsCreated.push(options);
        // Opened tabs are 9, 10, ... in order.
        const tabId = 8 + windowsCreated.length;
        openedTabs.set(tabId, { url: options.url, status: 'complete', title: 'Cart', ...(opened ?? {}) });
        return { id: 2, focused: true, tabs: [{ id: tabId, windowId: 2, active: true }] };
      },
    },
    tabs: {
      async create(options) {
        if (tabCreateFails) throw new Error('Window closed');
        tabsCreated.push(clone(options));
        const id = 8 + tabsCreated.length;
        openedTabs.set(id, { url: options.url, windowId: options.windowId, status: 'complete', title: 'Cart', ...(opened ?? {}) });
        return { id, windowId: options.windowId, active: true };
      },
      onCreated: events('onCreated'),
      onActivated: events('onActivated'),
      onRemoved: events('onRemoved'),
      onUpdated: events('onUpdated'),
      async query(query) {
        if (query.currentWindow) return [{ id: 7, url: tab.url, windowId: 1, title: 'Members' }];
        return [{ id: activeTabId, windowId: 1 }];
      },
      async get(id) {
        const groupId = groupOf.get(id) ?? -1;
        if (openedTabs.has(id)) return { id, windowId: 2, groupId, ...openedTabs.get(id) };
        return { id, url: tab.url, status: tab.status, windowId: 1, groupId };
      },
      async remove(id) { openedTabs.delete(id); },
      async update(id, info) {
        if (info.active) activeTabId = id;
        return this.get(id);
      },
      async move(id, info) {
        if (openedTabs.has(id)) openedTabs.get(id).windowId = info.windowId;
        return this.get(id);
      },
      async group({ tabIds, groupId = nextGroup++ }) {
        if (!groups.has(groupId)) groups.set(groupId, {});
        for (const id of tabIds) groupOf.set(id, groupId);
        return groupId;
      },
      async ungroup(tabIds) {
        for (const id of tabIds) groupOf.delete(id);
      },
      async captureVisibleTab() { return 'data:image/jpeg;base64,UkFX'; },
    },
    scripting: {
      async executeScript({ func, files, args, target }) {
        if (frameScript && (target?.allFrames || target?.frameIds || target?.documentIds)) {
          const answered = await frameScript({ func, files, args, target });
          if (answered !== undefined) return answered;
        }
        if (files) {
          injections++;
          context.__faiPage = fakePage;
          return [{ documentId: 'doc', result: null }];
        }
        pageCalls++;
        const override = scriptOverride?.(args[0]);
        if (override) return override();
        return [{ documentId: 'doc', frameId: 0, result: await func(...args) }];
      },
    },
  };

  async function fetch(url, options) {
    const { pathname } = new URL(url);
    const body = options.body ? JSON.parse(options.body) : {};
    if (state.http === 'fail') throw new TypeError('Failed to fetch');
    const respond = value => ({ ok: true, status: 200, async json() { return value; } });
    // An id the service refuses (bound to another extension Origin).
    if (state.refusedIds?.has(options.headers?.['X-Fai-Browser'])) {
      sent.push({ via: 'http', type: pathname === '/commands' ? 'poll' : pathname.slice(1), refusedId: options.headers['X-Fai-Browser'] });
      return { ok: false, status: 403, async json() { return { error: 'This browser id belongs to another extension', code: 'identity_refused' }; } };
    }
    if (pathname === '/commands') {
      sent.push({ via: 'http', type: 'poll' });
      if (pollQueue.length) return respond(pollQueue.shift());
      return new Promise((resolve, reject) => {
        deliverPoll = value => resolve(respond(value));
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const type = { '/hello': 'hello', '/lease': 'lease', '/deny': 'deny', '/status': 'status', '/validate': 'validate',
      '/results': 'result', '/screenshots': 'screenshot' }[pathname];
    sent.push({ via: 'http', ...body, type, headers: options.headers });
    const reply = answer({ ...body, type });
    return respond(type === 'hello' ? { ...reply.data, requests: [] } : reply.data);
  }

  // Worker timers are tracked so dispose() can stop a worker that would otherwise reconnect forever.
  const timers = new Set();
  let disposed = false;
  const scaledTimeout = (fn, ms = 0, ...args) => {
    delays.push(ms);
    if (disposed) return 0;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) fn(...args);
    }, ms * timeScale);
    timers.add(timer);
    return timer;
  };
  Object.assign(context, {
    chrome,
    crypto: globalThis.crypto,
    fetch,
    WebSocket: FakeWebSocket,
    URL,
    AbortController,
    AbortSignal,
    console,
    setTimeout: scaledTimeout,
    clearTimeout: timer => {
      timers.delete(timer);
      clearTimeout(timer);
    },
    setInterval(fn, ms) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    // Fixed jitter: Math.random() = 0.5 makes the ±20 % factor exactly 1.
    Math: Object.create(Math, { random: { value: () => 0.5 } }),
  });
  vm.runInNewContext(pslData, context);
  vm.runInNewContext(framesSource, context);
  vm.runInNewContext(source, context);

  let commandSequence = 0;
  const h = {
    dispose() {
      disposed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
    state,
    sent,
    reloads,
    sockets,
    delays,
    intervals,
    local,
    session,
    nativeCalls,
    badges,
    alarms,
    alarmsCreated,
    get socket() {
      return sockets.at(-1);
    },
    grants,
    removed,
    windowsCreated,
    tabsCreated,
    popupWindows,
    windowUpdates,
    actionPopupCalls,
    windowsRemoved,
    // The popup-type windows by page: the approval window (popup.html?window=1) and the waiting prompt (arm.html).
    get approvalWindows() { return popupWindows.filter(options => options.url.includes('popup.html?window=1')); },
    get promptWindows() { return popupWindows.filter(options => options.url.includes('arm.html')); },
    openPopup(id) { return openPopups.has(id); },
    closePopup(id) { openPopups.delete(id); },
    openedTabs,
    // The user allowed Chrome's site-access prompt the popup opened (chrome.permissions.request).
    grant(pattern) {
      grants.add(pattern);
      permissionAdded.emit({ origins: [pattern] });
    },
    alarmFire() { alarms.emit({ name: 'fai-reconnect' }); },
    get injections() { return injections; },
    get pageCalls() { return pageCalls; },
    set redaction(fn) { redaction = fn; },
    redactionCalls,
    set approvalInfo(fn) { approvalInfo = fn; },
    gateCalls,
    get badge() { return badges.at(-1); },
    tabBadge(id) { return tabBadges.get(id); },
    tabBadges,
    chrome,
    groupOf,
    groups,
    groupOf,
    openedTabs,
    tabPopups,
    setActiveTab(id) { activeTabId = id; },
    bumpRevision() { revision++; },
    tab,
    pageArgs,
    annotations,
    set pageExecute(fn) { pageExecute = fn; },
    secretCalls,
    set observationText(text) { observationText = text; },
    set pageVault(list) { pageVault = list; },
    clipboard,
    // `fn(method)` returns a replacement for that executeScript call (a function returning the injection
    // results, or throwing), or nothing to run page.js normally.
    set scriptOverride(fn) { scriptOverride = fn; },
    set observationExtra(value) { observationExtra = value; },
    set frameScript(fn) { frameScript = fn; },
    // Simulates a document navigation of the leased tab: loading at `start` ms, the new URL committed at
    // `commit`, complete at `complete`. With `events: false` only chrome.tabs.get shows it (no onUpdated).
    navigate(url, { start = 0, commit = start, complete = commit + 50, events = true, load = true } = {}) {
      const emit = info => { if (events) chrome.tabs.onUpdated.emit(7, info); };
      if (load) {
        setTimeout(() => { tab.status = 'loading'; emit({ status: 'loading' }); }, start);
      }
      setTimeout(() => {
        tab.url = url;
        revision++;
        emit({ url });
      }, commit);
      if (load) setTimeout(() => { tab.status = 'complete'; emit({ status: 'complete' }); }, complete);
    },
    emitStorage(changes, area) {
      chrome.storage.onChanged.emit(changes, area);
    },
    send(message, sender = { id: 'ext' }) {
      // Replies come from the VM realm; JSON round-trip makes them comparable with deepStrictEqual.
      return new Promise(resolve => chrome.runtime.onMessage.emit(message, sender, reply => resolve(clone(reply))));
    },
    push(message) {
      h.socket.deliver({ v: 3, ...message });
    },
    command(method, args = {}, overrides = {}) {
      const command = {
        version: 3,
        id: `c${++commandSequence}`,
        deadline: Date.now() + 30_000,
        method,
        args,
        lease: { id: LEASE_ID, tabId: 7, requestId: 'req_1' },
        allowedOrigins: [ORIGIN],
        ...overrides,
      };
      h.push({ type: 'command', command });
      return command.id;
    },
    poll(value) {
      if (deliverPoll) {
        const deliver = deliverPoll;
        deliverPoll = null;
        deliver(value);
      } else {
        pollQueue.push(value);
      }
    },
    async waitFor(predicate, ms = 3000) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const found = sent.find(predicate);
        if (found) return found;
        await sleep(2);
      }
      throw new Error('Timed out waiting for a message');
    },
    async until(predicate, ms = 3000) {
      const deadline = Date.now() + ms;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for a condition');
        await sleep(2);
      }
    },
  };
  live.add(h);
  return h;
}

async function started(options = {}) {
  const h = harness(options);
  await h.waitFor(m => m.type === 'hello');
  const level = options.level ? { level: options.level } : {};
  const reply = await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, ...level, ...(options.tabMode ? { tabMode: options.tabMode } : {}) });
  assert.equal(reply.status, 'active', JSON.stringify(reply));
  return h;
}

test('a paired worker connects on startup with the auth subprotocol and says hello without a session', async () => {
  const h = harness();
  const hello = await h.waitFor(m => m.type === 'hello');
  assert.equal(h.sockets.length, 1);
  // This install's browser identity: created once, saved, and named in the URL (src/bridge.js connectionIdentity).
  assert.match(h.local.browserId, /^b-[A-Za-z0-9]{8,24}$/);
  assert.equal(h.socket.url, `ws://127.0.0.1:4318/ext/ws?browser=${h.local.browserId}`);
  assert.deepEqual({ ...hello.browser }, { product: 'chromium', name: 'Chromium', version: null });
  assert.deepEqual([...h.socket.protocols], ['fai-browser.v3', `fai-auth.${SECRET}`]);
  assert.equal(hello.via, 'ws');
  assert.equal(hello.v, 3);
  assert.deepEqual(hello.ext, { version: '0.3.0', protocol: 3 });
  assert.equal(hello.session, null);
  await h.until(() => h.session.connection?.connected);
  // `budget`: the per-request budget the daemon says is in effect (this fake daemon names none).
  assert.deepEqual(h.session.connection, { connected: true, transport: 'websocket', budget: null, paired: true, native: null,
    browserId: h.local.browserId });
  assert.deepEqual(hello.settings, { budget: null, openRightAway: true, tabMode: 'single', approvals: ASKS },
    'the hello reports the user\'s budget setting (none set) and that requested pages open right away (the default)');
  assert.deepEqual(h.alarmsCreated, [{ name: 'fai-reconnect', periodInMinutes: 0.5 }]);
});

test('an unpaired worker opens no connection', async () => {
  const h = harness({ paired: false });
  await sleep(30);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.sent.length, 0);
});

test('requests snapshots reach storage.session and the badge shows ? while one is pending', async () => {
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  const pending = { requestId: 'req_1', state: 'pending', origins: [ORIGIN], reason: 'Check members' };
  h.push({ type: 'requests', requests: [pending] });
  await h.until(() => h.session.requests?.length === 1);
  assert.deepEqual(h.session.requests, [pending]);
  assert.equal(h.badge, '?');
  h.push({ type: 'requests', requests: [] });
  await h.until(() => h.session.requests?.length === 0);
  assert.equal(h.badge, '');
});

test('start with a requestId sends lease for the active tab; commands run with one injection per document', async () => {
  const h = await started();
  const lease = h.sent.find(m => m.type === 'lease');
  assert.deepEqual({ requestId: lease.requestId, tabId: lease.tabId, origin: lease.origin, title: lease.title },
    { requestId: 'req_1', tabId: 7, origin: ORIGIN, title: 'Members' });
  assert.equal(lease.via, 'ws');
  assert.equal(h.tabBadge(7), 'ON');

  const first = h.command('observe');
  const observed = await h.waitFor(m => m.type === 'result' && m.id === first);
  assert.equal(observed.result.revision, 'doc:1');
  assert.equal(observed.result.tabId, 7);
  assert.deepEqual(observed.result.blocks, [
    { t: 'h1', text: 'Hello' }, { t: 'button', text: 'Show', ref: '1' }, { t: 'p', text: 'Later', offscreen: true },
  ], 'blocks pass through the worker unchanged');
  assert.equal(observed.result.blocksTruncated, false);
  const second = h.command('observe');
  await h.waitFor(m => m.type === 'result' && m.id === second);
  assert.equal(h.injections, 1, 'page.js is injected once per document');
  assert.equal(h.pageCalls, 3, 'probe + call for the first command, one call afterwards');

  h.bumpRevision();
  const stale = h.command('execute', { action: { type: 'click', target: '1' }, expectedRevision: 'doc:1', capture: true });
  const staleResult = await h.waitFor(m => m.type === 'result' && m.id === stale);
  assert.deepEqual(staleResult.error, { code: 'stale', message: 'Stale observation', recoverable: true });
  await sleep(20);
  assert.equal(h.sent.some(m => m.type === 'status'), false, 'a stale revision must not pause the session');
  assert.equal(h.sent.some(m => m.type === 'screenshot'), false);

  const run = h.command('execute', { action: { type: 'click', target: '1' }, expectedRevision: 'doc:2', capture: true });
  const validate = await h.waitFor(m => m.type === 'validate' && m.id === run);
  assert.equal(validate.leaseId, LEASE_ID);
  const result = await h.waitFor(m => m.type === 'result' && m.id === run);
  assert.equal(result.result.observation.revision, 'doc:3');
  assert.equal(result.result.observation.blocks.length, 3, 'post-action observations carry blocks too');
  assert.equal(result.result.settle.reason, 'quiet');
  assert.equal(result.result.screenshot, undefined, 'the screenshot travels separately');
  const shot = await h.waitFor(m => m.type === 'screenshot' && m.id === run);
  assert.equal(shot.screenshot.revision, 'doc:3');
  assert.equal(shot.screenshot.format, 'jpeg');
  assert.equal(shot.via, 'ws');

  await h.send({ type: 'stop' });
  const status = await h.waitFor(m => m.type === 'status');
  assert.deepEqual({ leaseId: status.leaseId, status: status.status, reason: status.reason },
    { leaseId: LEASE_ID, status: 'stopped', reason: 'stopped' });
});

test('legacy start without a requestId picks the pending request for this origin', async () => {
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  h.push({ type: 'requests', requests: [
    { requestId: 'req_other', state: 'pending', origins: ['https://other.test'], createdAt: '2026-01-01T00:00:00Z' },
    { requestId: 'req_mine', state: 'pending', origins: [ORIGIN], createdAt: '2026-01-02T00:00:00Z' },
  ] });
  await h.until(() => h.session.requests?.length === 2);
  await h.send({ type: 'start', endpoint: ENDPOINT, secret: SECRET });
  assert.equal(h.sent.find(m => m.type === 'lease').requestId, 'req_mine');
});

// Issue #13 part 2: a start that names no request (an older popup's "Select tab and start") must never resolve to a
// request other than the one the user would expect: the newest pending one for the tab's origin, else a paused request
// only on its own tab. A paused request is never resumed on another tab, nor while a pending one asks for the origin.
async function legacyStart(list, { activeTab = 7 } = {}) {
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  h.push({ type: 'requests', requests: list });
  await h.until(() => h.session.requests?.length === list.length);
  h.setActiveTab(activeTab);
  const reply = await h.send({ type: 'start', endpoint: ENDPOINT, secret: SECRET });
  return { h, reply, lease: h.sent.find(m => m.type === 'lease') ?? null };
}

test('legacy start: of two pending requests for the origin, the newest is approved, never the oldest', async () => {
  const { lease } = await legacyStart([
    { requestId: 'req_old', state: 'pending', origins: [ORIGIN], createdAt: '2026-01-01T00:00:00Z' },
    { requestId: 'req_new', state: 'pending', origins: [ORIGIN], createdAt: '2026-01-02T00:00:00Z' },
  ]);
  assert.equal(lease?.requestId, 'req_new');
});

test('legacy start: an old paused request never takes the click while a newer request is pending', async () => {
  const { lease } = await legacyStart([
    { requestId: 'req_paused', state: 'paused', origins: [ORIGIN], createdAt: '2026-01-01T00:00:00Z',
      lease: { leaseId: 'old', tabId: 7 } },
    { requestId: 'req_new', state: 'pending', origins: [ORIGIN], createdAt: '2026-01-02T00:00:00Z' },
  ]);
  assert.equal(lease?.requestId, 'req_new');
});

test('legacy start: a paused request resumes only on its own tab; on another tab nothing is leased', async () => {
  const paused = { requestId: 'req_paused', state: 'paused', origins: [ORIGIN], createdAt: '2026-01-01T00:00:00Z',
    lease: { leaseId: 'old', tabId: 12 } };
  const elsewhere = await legacyStart([paused]);
  assert.equal(elsewhere.lease, null, 'tab 7 is not the paused request\'s tab');
  assert.match(elsewhere.reply.error, /Choose the request in the FAI Browser popup/);
  const own = await legacyStart([{ ...paused, lease: { leaseId: 'old', tabId: 7 } }]);
  assert.equal(own.lease?.requestId, 'req_paused');
});

test('legacy start: an invited tab is never picked; a same-millisecond tie goes to the later request', async () => {
  const invited = await legacyStart([
    { requestId: 'req_invite', state: 'paused', origins: [ORIGIN], createdAt: '2026-01-02T00:00:00Z',
      lease: { leaseId: 'inv', tabId: 7 }, invite: { inviteId: 'inv-abcdefgh', state: 'open' } },
  ]);
  // Nothing the worker may pick: the service decides (and refuses an invited tab too).
  assert.equal(invited.lease?.requestId ?? null, null);
  const tie = await legacyStart([
    { requestId: 'req_first', state: 'pending', origins: [ORIGIN], createdAt: '2026-01-02T00:00:00.000Z' },
    { requestId: 'req_second', state: 'pending', origins: [ORIGIN], createdAt: '2026-01-02T00:00:00.000Z' },
  ]);
  assert.equal(tie.lease?.requestId, 'req_second');
});

test('an unpaired worker pairs through the native host, saves the pairing and connects', async () => {
  const h = harness({ paired: false, native: async () => ({ ok: true, endpoint: ENDPOINT, secret: SECRET, version: '0.2.0' }) });
  await h.waitFor(m => m.type === 'hello');
  assert.deepEqual(h.nativeCalls[0], { host: 'fai_browser', message: { type: 'pair' } });
  assert.equal(h.local.endpoint, ENDPOINT);
  assert.equal(h.local.secret, SECRET);
  await h.until(() => h.session.connection?.connected === true);
  assert.equal(h.session.connection.native, 'paired');
  assert.equal(h.session.connection.paired, true);
});

test('native pairing: a missing host or a bad reply saves nothing; the popup Pair button reports it', async () => {
  const missing = harness({ paired: false, native: async () => { throw new Error('Specified native messaging host not found.'); } });
  await missing.until(() => missing.session.connection?.native === 'missing');
  assert.equal(missing.local.secret, undefined);
  const reply = await missing.send({ type: 'pair' });
  assert.match(reply.error, /npm run setup/);
  assert.equal(missing.nativeCalls.length, 2, 'Pair asks again at once');
  const bad = harness({ paired: false, native: async () => ({ ok: true, endpoint: 'http://evil.example:4318', secret: SECRET }) });
  await bad.until(() => bad.session.connection?.native === 'error');
  assert.equal(bad.local.secret, undefined, 'a non-loopback address is never saved');
  const short = harness({ paired: false, native: async () => ({ ok: true, endpoint: ENDPOINT, secret: 'short' }) });
  await short.until(() => short.session.connection?.native === 'error');
  assert.equal(short.local.secret, undefined);
});

test('a cancelled command is not executed', async () => {
  const h = await started();
  h.push({ type: 'cancel', id: 'c1' });
  const id = h.command('execute', { action: { type: 'click', target: '1' }, expectedRevision: 'doc:1', capture: true });
  const result = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(result.error.code, 'timeout');
  assert.equal(h.sent.some(m => m.type === 'validate'), false);
});

test('lease_update for the current lease ends the session locally without reporting back', async () => {
  const h = await started();
  h.push({ type: 'lease_update', requestId: 'req_1', leaseId: 'other-lease', state: 'released', reason: 'superseded' });
  await sleep(10);
  assert.equal(h.tabBadge(7), 'ON', 'an update for another lease is ignored');
  h.push({ type: 'lease_update', requestId: 'req_1', leaseId: LEASE_ID, state: 'released', reason: 'superseded' });
  await h.until(() => h.local.status === 'stopped' && h.tabBadge(7) === null);
  assert.equal(h.sent.some(m => m.type === 'status'), false);
  const id = h.command('observe');
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === id)).error.code, 'stopped');
});

test('after a socket blip the worker reconnects and its hello carries the session', async () => {
  const h = await started();
  h.socket.close();
  await h.until(() => h.sockets.length === 2 && h.sent.filter(m => m.type === 'hello').length === 2);
  const hello = h.sent.filter(m => m.type === 'hello')[1];
  assert.deepEqual(hello.session, { requestId: 'req_1', leaseId: LEASE_ID, tabId: 7, origin: ORIGIN, status: 'active', level: 'read-only', scope: 'origin', tabMode: 'single' });
});

test('the worker pings every 20 s on the open socket', async () => {
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  const keepalive = h.intervals.find(interval => interval.ms === 20_000);
  assert.ok(keepalive, 'a 20 s interval is registered');
  keepalive.fn();
  const ping = await h.waitFor(m => m.type === 'ping');
  assert.deepEqual({ ...ping }, { via: 'ws', v: 3, type: 'ping' });
});

test('reconnect backs off 0.5, 1, 2, 4, 8, 15 s while the daemon is down', async () => {
  const h = harness({ ws: 'fail', http: 'fail', timeScale: 0.002 });
  await h.until(() => h.sockets.length >= 8, 5000);
  const backoff = h.delays.filter(ms => [500, 1_000, 2_000, 4_000, 8_000, 15_000].includes(ms));
  assert.deepEqual(backoff.slice(0, 7), [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
  await h.until(() => h.session.connection !== undefined);
  assert.equal(h.session.connection.connected, false);
});

test('the reconnect alarm reconnects immediately when not connected', async () => {
  const h = harness({ ws: 'fail', http: 'fail', timeScale: 1000 });
  await h.until(() => h.sockets.length === 1 && h.socket.readyState === 3);
  await sleep(10);
  const before = h.sockets.length;
  h.state.ws = 'open';
  h.alarms.emit({ name: 'fai-reconnect' });
  await h.waitFor(m => m.type === 'hello');
  assert.equal(h.sockets.length, before + 1);
});

test('after 3 WebSocket failures with HTTP up, the worker long-polls v3 commands and requests', async () => {
  const h = harness({ ws: 'fail', timeScale: 0.002 });
  const hello = await h.waitFor(m => m.type === 'hello' && m.via === 'http');
  assert.equal(h.sockets.length, 3);
  assert.equal(hello.headers.Authorization, `Bearer ${SECRET}`);
  await h.waitFor(m => m.type === 'poll');
  await h.until(() => h.session.connection?.transport === 'longpoll');
  h.poll({ command: null, requests: [{ requestId: 'req_1', state: 'pending', origins: [ORIGIN] }], messages: [] });
  await h.until(() => h.session.requests?.length === 1);
  assert.equal(h.badge, '?');

  await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET });
  assert.equal(h.sent.find(m => m.type === 'lease').via, 'http');
  const command = {
    version: 3, id: 'lp1', deadline: Date.now() + 30_000, method: 'observe', args: {},
    lease: { id: LEASE_ID, tabId: 7, requestId: 'req_1' }, allowedOrigins: [ORIGIN],
  };
  h.poll({ command, requests: [], messages: [] });
  const result = await h.waitFor(m => m.type === 'result' && m.id === 'lp1');
  assert.equal(result.via, 'http');
  assert.equal(result.result.revision, 'doc:1');
  h.poll({ command: null, requests: [], messages: [
    { v: 3, type: 'lease_update', requestId: 'req_1', leaseId: LEASE_ID, state: 'paused', reason: 'paused' },
  ] });
  await h.until(() => h.local.status === 'paused');
});

test('the worker pauses with tab_changed when the leased tab is no longer active', async () => {
  const h = await started();
  h.setActiveTab(8);
  const id = h.command('observe');
  const result = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(result.error.code, 'tab_changed');
  assert.equal(result.error.recoverable, false);
  const status = await h.waitFor(m => m.type === 'status');
  assert.deepEqual({ status: status.status, reason: status.reason }, { status: 'paused', reason: 'tab_changed' });
});

test('single-tab approval refuses agent opens and pauses on a page-created child without adopting it', async () => {
  const h = await started();
  const id = h.command('execute', { action: { type: 'open_tab', url: `${ORIGIN}/next` }, expectedRevision: 'doc:1' });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === id)).error.code, 'blocked_risky');
  assert.deepEqual(h.tabsCreated, []);
  h.chrome.tabs.onCreated.emit({ id: 99, openerTabId: 7, url: `${ORIGIN}/child`, windowId: 1 });
  const paused = await h.waitFor(m => m.type === 'status' && m.status === 'paused');
  assert.equal(paused.reason, 'child_tab');
  assert.equal(h.groups.size, 1);
});

// Issue #13 part 3: a child_tab pause names the origin of the tab or window the page opened (origin only, never its
// path or query), so the agent can request it up front; a window that opens on about:blank reports it once it shows
// a page; one whose URL the browser withholds names nothing.
test('a child_tab pause names the child\'s origin only, also once it leaves about:blank; a withheld URL names none', async () => {
  const h = await started();
  h.chrome.tabs.onCreated.emit({ id: 99, openerTabId: 7, pendingUrl: 'https://signup.example.net/new?ref=secret-ish', windowId: 1 });
  const paused = await h.waitFor(m => m.type === 'status' && m.status === 'paused');
  assert.deepEqual({ reason: paused.reason, origin: paused.origin, leaseId: paused.leaseId },
    { reason: 'child_tab', origin: 'https://signup.example.net', leaseId: LEASE_ID });

  const late = await started();
  late.openedTabs.set(99, { url: 'about:blank', status: 'loading' });
  late.chrome.tabs.onCreated.emit({ id: 99, openerTabId: 7, url: 'about:blank', windowId: 2 });
  const first = await late.waitFor(m => m.type === 'status' && m.status === 'paused');
  assert.equal(first.reason, 'child_tab');
  assert.equal(first.origin, undefined, 'nothing to name yet');
  late.openedTabs.set(99, { url: 'https://signup.example.net/flow?token=abc#x', status: 'complete' });
  const named = await late.waitFor(m => m.type === 'status' && typeof m.origin === 'string');
  assert.deepEqual({ status: named.status, reason: named.reason, origin: named.origin, leaseId: named.leaseId },
    { status: 'paused', reason: 'child_tab', origin: 'https://signup.example.net', leaseId: LEASE_ID });
  await sleep(400);
  assert.equal(late.sent.filter(m => m.type === 'status').length, 2, 'reported once');

  const withheld = await started();
  withheld.openedTabs.set(99, { status: 'complete' });
  withheld.chrome.tabs.onCreated.emit({ id: 99, openerTabId: 7, windowId: 2 });
  const none = await withheld.waitFor(m => m.type === 'status' && m.status === 'paused');
  assert.equal(none.origin, undefined);
  await sleep(400);
  assert.equal(withheld.sent.some(m => m.type === 'status' && m.origin), false);
  await withheld.send({ type: 'stop' });
});

const multiLease = { id: LEASE_ID, tabId: 7, requestId: 'req_1', tabMode: 'multiple' };
async function multipleTask() {
  return started({ hostGrants: [`${ORIGIN}/*`], local: { tabMode: 'multiple' }, tabMode: 'multiple' });
}
async function taskOpen(h, url = `${ORIGIN}/next`, lease = multiLease) {
  const id = h.command('execute', { action: { type: 'open_tab', url }, expectedRevision: 'doc:1' }, { lease });
  return h.waitFor(m => m.type === 'result' && m.id === id);
}

test('multiple-tab approval creates a tab in the task window and group, switches only among owned tabs and cleans all marks', async () => {
  const h = await multipleTask();
  await h.until(() => h.groupOf.has(7));
  assert.equal(h.sent.find(m => m.type === 'lease').tabMode, 'multiple');
  const result = await taskOpen(h);
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.deepEqual(h.tabsCreated, [{ windowId: 1, url: `${ORIGIN}/next`, active: false }]);
  assert.equal(h.groupOf.get(9), h.groupOf.get(7));
  const id = h.command('execute', { action: { type: 'switch_tab', tab: 't0' }, expectedRevision: 'doc:1' }, { lease: multiLease });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === id)).error, undefined);
  const alien = h.command('execute', { action: { type: 'switch_tab', tab: 't99' }, expectedRevision: 'doc:1' }, { lease: multiLease });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === alien)).error.code, 'target_unavailable');
  // A four-digit id (a long session's later tabs) is a well-formed tab id: looked up, not refused as invalid.
  const later = h.command('execute', { action: { type: 'switch_tab', tab: 't1000' }, expectedRevision: 'doc:1' }, { lease: multiLease });
  const laterError = (await h.waitFor(m => m.type === 'result' && m.id === later)).error;
  assert.equal(laterError.code, 'target_unavailable', JSON.stringify(laterError));
  assert.match(laterError.message, /not part of this request/);
  await h.send({ type: 'stop' });
  await h.until(() => !h.groupOf.has(7) && !h.groupOf.has(9));
});

test('multiple tabs requires native site access and both immutable grants; origins and eight-tab limit hold', async () => {
  const denied = harness({ hostGrants: [], local: { tabMode: 'multiple' } });
  await denied.waitFor(m => m.type === 'hello');
  const reply = await denied.send({ type: 'start', requestId: 'req_1', tabMode: 'multiple' });
  assert.match(reply.error, /site access/);
  assert.equal(denied.sent.some(m => m.type === 'lease'), false);
  const h = await multipleTask();
  assert.equal((await taskOpen(h, 'https://elsewhere.test/')).error.code, 'cross_origin');
  assert.equal((await taskOpen(h, `${ORIGIN}/next`, { ...multiLease, tabMode: 'single' })).error.code, 'blocked_risky');
  for (let i = 0; i < 7; i++) assert.equal((await taskOpen(h)).error, undefined);
  assert.equal((await taskOpen(h)).error.code, 'blocked_risky');
  assert.equal(h.tabsCreated.length, 7);
});

test('a stopped request cannot keep a tab created while its browser API call was pending', async () => {
  const h = await multipleTask();
  const create = h.chrome.tabs.create;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let creating = false;
  h.chrome.tabs.create = async options => { const tab = await create(options); creating = true; await gate; return tab; };
  const opened = taskOpen(h);
  await h.until(() => creating);
  await h.send({ type: 'stop' });
  release();
  assert.equal((await opened).error.code, 'blocked_risky');
  assert.equal(h.openedTabs.size, 0);
});

test('concurrent page children cannot exceed the lease cap or receive duplicate task ids', async () => {
  const h = await multipleTask();
  for (let i = 0; i < 6; i++) assert.equal((await taskOpen(h)).error, undefined);
  const contains = h.chrome.permissions.contains;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let checks = 0;
  h.chrome.permissions.contains = async value => { checks++; await gate; return contains(value); };
  for (const id of [90, 91]) {
    h.openedTabs.set(id, { url: `${ORIGIN}/child`, windowId: 1, status: 'complete' });
    h.chrome.tabs.onCreated.emit({ id, openerTabId: 7, url: `${ORIGIN}/child`, windowId: 1 });
  }
  await h.until(() => checks === 2);
  release();
  await h.waitFor(m => m.type === 'status' && m.status === 'paused');
  assert.equal(h.groupOf.has(90) && h.groupOf.has(91), false, 'both children never join a full lease');
});

test('revoking site permission or switching to single stops further multiple-tab work', async () => {
  const h = await multipleTask();
  h.grants.clear();
  assert.equal((await taskOpen(h)).error.code, 'blocked_risky');
  assert.equal(h.tabsCreated.length, 0);
  h.emitStorage({ tabMode: { newValue: 'single' } }, 'local');
  await h.waitFor(m => m.type === 'status' && m.status === 'paused');
  assert.equal((await taskOpen(h)).error.code, 'paused');
});

test('off-origin navigation is rejected without pausing; the user can pause', async () => {
  const h = await started();
  const navigate = h.command('execute', { action: { type: 'navigate_allowed_url', url: 'https://evil.test/' }, expectedRevision: 'doc:1' });
  const rejected = await h.waitFor(m => m.type === 'result' && m.id === navigate);
  assert.equal(rejected.error.code, 'cross_origin');
  assert.equal((await h.send({ type: 'pause' })).status, 'paused');
  const status = await h.waitFor(m => m.type === 'status');
  assert.deepEqual({ status: status.status, reason: status.reason }, { status: 'paused', reason: 'paused' });
  assert.equal(h.tabBadge(7), 'Ⅱ');
  assert.equal(h.badge, '', 'the session\'s pause shows on its tab only');
});

test('capture screenshots the page on demand, including action:null observations', async () => {
  const h = await started();
  const id = h.command('capture', {
    action: { type: 'click', target: '1', text: 'never-drawn' },
    target: { id: '1', label: 'Show' },
    fromUrl: ORIGIN + '/',
  });
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.equal(reply.result.screenshot.revision, 'doc:1');
  assert.ok(reply.result.screenshot.dataUrl.startsWith('data:image/jpeg;base64,'));
  assert.equal(h.sent.some(m => m.type === 'screenshot'), false, 'on-demand capture replies inline');

  const observationId = h.command('capture', { action: null });
  const observed = await h.waitFor(m => m.type === 'result' && m.id === observationId);
  assert.equal(observed.error, undefined, JSON.stringify(observed.error));

  const bad = h.command('capture', { action: { type: 'eval' } });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === bad)).error.code, 'unsupported');
  const old = h.command('observe', {}, { version: 2 });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === old)).error.code, 'unsupported');
});

test('capture draws action-id labels only for the frame\'s own revision, and reports the tags', async () => {
  const h = await started();
  const labels = { 1: ['a0', 'a7'], 2: ['bad id', 'a1'], 3: 'a2', 'a-very-long-ref': ['a3'] };
  const id = h.command('capture', { action: null, labels, revision: 'doc:1' });
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  // Cleaned: ids that are not action ids, non-array values and long refs are dropped.
  assert.deepEqual(h.annotations.at(-1).labels, { 1: ['a0', 'a7'], 2: ['a1'] });
  assert.deepEqual(reply.result.screenshot.tags, [{ id: 'a0', ref: '1', x: 0, y: 0, width: 20, height: 18 }, { id: 'a1', ref: '2', x: 0, y: 0, width: 20, height: 18 }]);
  assert.equal(reply.result.screenshot.revision, 'doc:1');
  // Labels made for another revision are not drawn on this frame: refs, no tags.
  const stale = h.command('capture', { action: null, labels, revision: 'doc:0' });
  const staleReply = await h.waitFor(m => m.type === 'result' && m.id === stale);
  assert.equal(staleReply.error, undefined, JSON.stringify(staleReply.error));
  assert.equal(h.annotations.at(-1).labels, undefined);
  assert.equal(staleReply.result.screenshot.tags, undefined);
  // Nothing usable in labels: as without them.
  const none = h.command('capture', { action: null, labels: { 9: ['eval'] }, revision: 'doc:1' });
  await h.waitFor(m => m.type === 'result' && m.id === none);
  assert.equal(h.annotations.at(-1).labels, undefined);
});

test('locate asks page.js what is under a point with the command\'s policy; a point click executes only as a click without a target', async () => {
  const h = await started();
  const id = h.command('locate', { point: { x: 2, y: 3 }, expectedRevision: 'doc:1', forbid: ['Archive'], level: 'reversible' });
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.deepEqual(reply.result, { id: '1', control: { id: '1', role: 'button', label: 'Show', bounds: { x: 0, y: 0, width: 10, height: 10 } } });
  const call = h.pageArgs.findLast(entry => entry.method === 'locate');
  assert.deepEqual(call.args.slice(0, 2), [{ x: 2, y: 3 }, 'doc:1']);
  assert.deepEqual(call.args[3], ['Archive'], 'the forbid additions');
  assert.deepEqual(call.args[4], ['navigate'], 'the level, clamped to the grant (read-only here)');

  const missed = h.command('locate', { point: { x: 50, y: 50 }, expectedRevision: 'doc:1' });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === missed)).error.code, 'no_control');
  const stale = h.command('locate', { point: { x: 2, y: 3 }, expectedRevision: 'doc:0' });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === stale)).error.code, 'stale');
  for (const point of [{ x: -1, y: 1 }, { x: 'a', y: 1 }, null, [1, 2]]) {
    const bad = h.command('locate', { point, expectedRevision: 'doc:1' });
    assert.equal((await h.waitFor(m => m.type === 'result' && m.id === bad)).error.code, 'unsupported', JSON.stringify(point));
  }

  // The execute that follows: a click with the point and no target is dispatched to page.js as is.
  const executed = h.command('execute', { action: { type: 'click', point: { x: 2, y: 3 } }, expectedRevision: 'doc:1', capture: false });
  const result = await h.waitFor(m => m.type === 'result' && m.id === executed);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.deepEqual(h.pageArgs.findLast(entry => entry.method === 'execute').args[0], { type: 'click', point: { x: 2, y: 3 } });
  for (const action of [
    { type: 'click', point: { x: 2, y: 3 }, target: '1' },
    { type: 'fill_supplied_text', point: { x: 2, y: 3 }, text: 'x' },
    { type: 'click', point: { x: -2, y: 3 } },
    { type: 'click', point: 'here' },
  ]) {
    const refused = h.command('execute', { action, expectedRevision: 'doc:2', capture: false });
    assert.equal((await h.waitFor(m => m.type === 'result' && m.id === refused)).error.code, 'unsupported', JSON.stringify(action));
  }
});

test('secret redaction: every page call carries the user setting and the session salt; page tags are numbered per session', async () => {
  const h = await started({ local: { secretRedaction: { mode: 'strict', relaxed: ['https://docs.example', 'not an origin'] } } });
  h.observationText = 'Key [secret:~abc123 openai sk-proj-…wxyz len 64] then [secret:~zz9] and [secret:~abc123 openai sk-proj-…wxyz len 64]';
  const first = h.command('observe');
  const observed = await h.waitFor(m => m.type === 'result' && m.id === first);
  assert.equal(observed.result.text, 'Key [secret:1 openai sk-proj-…wxyz len 64] then [secret:2] and [secret:1 openai sk-proj-…wxyz len 64]');
  const options = h.secretCalls.at(-1);
  assert.deepEqual({ mode: options.mode, relaxed: options.relaxed }, { mode: 'strict', relaxed: ['https://docs.example'] });
  assert.match(options.salt, /\S{8,}/);
  // The same tags keep their numbers for the session; a new tag takes the next one.
  h.observationText = 'Again [secret:~zz9], new [secret:~q7]';
  const second = h.command('observe');
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === second)).result.text, 'Again [secret:2], new [secret:3]');
  assert.equal(h.secretCalls.at(-1).salt, options.salt, 'one salt per session');
  // The popup's change applies to the next call.
  h.emitStorage({ secretRedaction: { newValue: { mode: 'standard', relaxed: [] } } }, 'local');
  const third = h.command('observe');
  await h.waitFor(m => m.type === 'result' && m.id === third);
  assert.deepEqual({ mode: h.secretCalls.at(-1).mode, relaxed: h.secretCalls.at(-1).relaxed }, { mode: 'standard', relaxed: [] });
});

test('deny forwards the requestId', async () => {
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  await h.send({ type: 'deny', requestId: 'req_9' });
  assert.equal((await h.waitFor(m => m.type === 'deny')).requestId, 'req_9');
});

// --- navigation detection (oversight pass 3) -------------------------------------------------------------------

const linkClick = h => () => ({ fromUrl: ORIGIN + '/', target: { id: '1', role: 'link', label: 'Next' }, expectNavigation: true });
const runExecute = async (h, args = {}) => {
  const started = Date.now();
  const id = h.command('execute', { action: { type: 'click', target: '1' }, expectedRevision: 'doc:1', ...args });
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id, 6000);
  return { reply, ms: Date.now() - started };
};

test('a link whose load starts 400 ms after the click is followed to load_complete and reported as navigated', async () => {
  const h = await started();
  h.pageExecute = action => {
    h.navigate(ORIGIN + '/next', { start: 400, commit: 450, complete: 600 });
    return linkClick(h)(action);
  };
  const { reply, ms } = await runExecute(h);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.equal(reply.result.settle.reason, 'load_complete');
  assert.equal(reply.result.observation.url, ORIGIN + '/next');
  assert.equal(reply.result.navigated, true);
  assert.equal(reply.result.url, ORIGIN + '/next');
  assert.equal(reply.result.settle.navigated, true, 'the bridge forwards settle, so the flag rides there too');
  assert.equal(reply.result.settle.url, ORIGIN + '/next');
  assert.ok(ms < 1500, `returned once the load completed, not after the full window (${ms} ms)`);
  assert.deepEqual(h.pageArgs.at(-1).method, 'settleAndObserve', 'observed in the new document');
});

test('a command cancelled while its navigation is followed reports no navigation and takes no screenshot',
  async () => {
    const h = await started();
    h.pageExecute = action => {
      h.navigate(ORIGIN + '/next', { start: 400, commit: 450, complete: 600 });
      return linkClick(h)(action);
    };
    const id = h.command('execute', { action: { type: 'click', target: '1' }, expectedRevision: 'doc:1', capture: true });
    setTimeout(() => h.push({ type: 'cancel', id }), 200);
    const reply = await h.waitFor(m => m.type === 'result' && m.id === id, 6000);
    assert.equal(reply.result, undefined);
    assert.equal(reply.error.code, 'timeout');
    await sleep(700);
    assert.equal(h.sent.some(m => m.type === 'screenshot' && m.id === id), false);
  });

test('a late load is found by polling the tab when no onUpdated event arrives', async () => {
  const h = await started();
  h.pageExecute = action => {
    h.navigate(ORIGIN + '/polled', { start: 300, commit: 350, complete: 450, events: false });
    return linkClick(h)(action);
  };
  const { reply, ms } = await runExecute(h);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.equal(reply.result.observation.url, ORIGIN + '/polled');
  assert.equal(reply.result.navigated, true);
  assert.ok(['load_complete', 'cap'].includes(reply.result.settle.reason));
  assert.ok(ms < 1500, `${ms} ms`);
});

for (const [name, teardown] of [
  ['the page call returns no result', () => [{ documentId: 'doc', frameId: 0, result: undefined }]],
  ['the message port closes', () => { throw new Error('The message port closed before a response was received.'); }],
  ['the receiving end is gone', () => { throw new Error('Could not establish connection. Receiving end does not exist.'); }],
]) {
  test(`a click that tears the document down is a navigation success when ${name}`, async () => {
    const h = await started();
    h.scriptOverride = method => {
      if (method !== 'execute') return null;
      h.navigate(ORIGIN + '/gone', { start: 250, commit: 300, complete: 400 });
      return teardown;
    };
    const { reply } = await runExecute(h, { capture: true });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    assert.equal(reply.result.navigated, true);
    assert.equal(reply.result.url, ORIGIN + '/gone');
    assert.equal(reply.result.observation.url, ORIGIN + '/gone');
    assert.equal(reply.result.settle.reason, 'load_complete');
    const shot = await h.waitFor(m => m.type === 'screenshot' && m.id === reply.id);
    assert.equal(shot.error, undefined, 'evidence is still captured after a torn-down click');
  });
}

test('a torn-down page call with no navigation in the 2 s window stays an error', async () => {
  const h = await started();
  h.scriptOverride = method => (method === 'execute'
    ? () => [{ documentId: 'doc', frameId: 0, result: undefined }]
    : null);
  const { reply, ms } = await runExecute(h);
  assert.equal(reply.error.code, 'unsupported');
  assert.match(reply.error.message, /no result/);
  assert.ok(ms >= 1900 && ms < 3500, `waited the start window (${ms} ms)`);
});

test('a same-document URL change after a link click settles in place without waiting for a load', async () => {
  const h = await started();
  h.pageExecute = action => {
    h.navigate(ORIGIN + '/#/route', { commit: 120, load: false });
    return linkClick(h)(action);
  };
  const { reply, ms } = await runExecute(h);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.equal(reply.result.settle.reason, 'quiet', 'settled in the page, not on a load');
  assert.equal(reply.result.navigated, true);
  assert.equal(reply.result.url, ORIGIN + '/#/route');
  assert.ok(ms < 800, `${ms} ms`);
});

test('an in-place click reports no navigation', async () => {
  const h = await started();
  const { reply } = await runExecute(h);
  assert.equal(reply.result.navigated, undefined);
  assert.equal(reply.result.settle.navigated, undefined);
  assert.equal(reply.result.settle.reason, 'quiet');
});

test('observe terms reach page.js and are reused for execute and later observes until replaced', async () => {
  const h = await started();
  let id = h.command('observe', { terms: ['Members', 'plan', 42] });
  await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.deepEqual(h.pageArgs.at(-1), { method: 'observe', args: [{ terms: ['members', 'plan'], forbid: [], allow: ['navigate'], sites: [], expectText: [] }] });
  await runExecute(h);
  assert.deepEqual(h.pageArgs.find(c => c.method === 'execute').args[3], ['members', 'plan']);
  id = h.command('observe', {});
  await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.deepEqual(h.pageArgs.at(-1).args, [{ terms: ['members', 'plan'], forbid: [], allow: ['navigate'], sites: [], expectText: [] }], 'absent terms keep the last ones');
  id = h.command('observe', { terms: [] });
  await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.deepEqual(h.pageArgs.at(-1).args, [{ terms: [], forbid: [], allow: ['navigate'], sites: [], expectText: [] }], 'an empty list clears them');
});

test('observe expectText reaches page.js lower-cased and is kept for the execute that follows', async () => {
  const h = await started();
  const id = h.command('observe', { expectText: ['Departing 2026-10-12', 7, 'x'.repeat(201)] });
  await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.deepEqual(h.pageArgs.at(-1).args[0].expectText, ['departing 2026-10-12']);
  await runExecute(h);
  assert.deepEqual(h.pageArgs.find(c => c.method === 'execute').expectText, ['departing 2026-10-12']);
});

test('guardrail additions reach page.js on observe and execute as plain phrases; malformed ones are dropped; none means none', async () => {
  const h = await started();
  let id = h.command('observe', { forbid: ['Gift wrap', 'Pay.*', 42, 'x'.repeat(61), 'Upgrade'] });
  await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.deepEqual(h.pageArgs.at(-1).args[0].forbid, ['Gift wrap', 'Upgrade']);
  await runExecute(h);
  assert.deepEqual(h.pageArgs.find(c => c.method === 'execute').args[4], ['Gift wrap', 'Upgrade'],
    'execute without forbid uses the run\'s list from its observe');
  await runExecute(h, { forbid: ['Donate'] });
  assert.deepEqual(h.pageArgs.filter(c => c.method === 'execute').at(-1).args[4], ['Donate']);
  id = h.command('observe', {});
  await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.deepEqual(h.pageArgs.at(-1).args[0].forbid, [], 'an observe without forbid clears the list (a later run never inherits it)');
});

test('a hello without a session clears the stale worker-start status so the popup reads Ready', async () => {
  const h = harness();
  h.local.status = 'Reconnect required';
  await h.waitFor(m => m.type === 'hello');
  await h.until(() => h.local.status === '');
  assert.equal(h.local.status, '');
});

test('a disconnect without a session sets the retrying status text', async () => {
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  await h.until(() => h.local.status === '');
  h.state.ws = 'fail';
  h.state.http = 'fail';
  h.socket.close();
  await h.until(() => h.local.status === 'Not connected to the FAI service. Retrying.');
  assert.equal(h.local.status, 'Not connected to the FAI service. Retrying.');
});

const CONSENT_ORIGIN = 'https://consent.example.com';

async function startedOnConsent(leaseOrigins) {
  const h = harness({ leaseOrigins });
  h.tab.url = `${CONSENT_ORIGIN}/m?continue=${ORIGIN}/flights`;
  await h.waitFor(m => m.type === 'hello');
  const reply = await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET });
  assert.equal(reply.status, 'active', JSON.stringify(reply));
  assert.equal(reply.session.origin, CONSENT_ORIGIN);
  return h;
}

test('a session on a consent.* host follows the consent redirect to an origin the request approved', async () => {
  const h = await startedOnConsent([ORIGIN, CONSENT_ORIGIN]);
  h.navigate(`${ORIGIN}/flights`, { start: 0, commit: 5 });
  await sleep(80);
  const id = h.command('observe');
  const result = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.result.url, `${ORIGIN}/flights`);
  assert.ok(!h.sent.some(m => m.type === 'status' && m.reason === 'origin_changed'));
});

test('the consent redirect is not followed to an origin outside the request, nor without the lease origins', async () => {
  const h = await startedOnConsent([ORIGIN, CONSENT_ORIGIN]);
  h.navigate('https://evil.test/', { start: 0, commit: 5 });
  const status = await h.waitFor(m => m.type === 'status');
  assert.deepEqual({ status: status.status, reason: status.reason }, { status: 'paused', reason: 'origin_changed' });

  const legacy = await startedOnConsent(null);
  legacy.navigate(`${ORIGIN}/flights`, { start: 0, commit: 5 });
  const paused = await legacy.waitFor(m => m.type === 'status');
  assert.equal(paused.reason, 'origin_changed');
});

test('an ordinary (non-consent) session never follows an origin change, even to an approved origin', async () => {
  const h = harness({ leaseOrigins: [ORIGIN, 'https://other.example.com'] });
  await h.waitFor(m => m.type === 'hello');
  await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET });
  h.navigate('https://other.example.com/', { start: 0, commit: 5 });
  const status = await h.waitFor(m => m.type === 'status');
  assert.equal(status.reason, 'origin_changed');
});

test('the consent redirect is followed once: no second hop, even to another approved consent.* host', async () => {
  const OTHER_CONSENT = 'https://consent.other.test';
  const h = await startedOnConsent([ORIGIN, CONSENT_ORIGIN, OTHER_CONSENT, 'https://third.test']);
  h.navigate(`${OTHER_CONSENT}/m?continue=https://third.test/`, { start: 0, commit: 5 });
  await sleep(80);
  const id = h.command('observe', {}, { allowedOrigins: [ORIGIN, CONSENT_ORIGIN, OTHER_CONSENT, 'https://third.test'] });
  const result = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  h.navigate('https://third.test/', { start: 0, commit: 5 });
  const status = await h.waitFor(m => m.type === 'status');
  assert.equal(status.reason, 'origin_changed');
});

// --- the browser's own error page (an HTTP error sent without a page body, a network failure) ---------------------
// Chrome commits chrome-error://chromewebdata/ while tab.url keeps the URL it tried, so the tab is still on the approved
// origin, but no extension script runs there. Chromium 156 rejects executeScript with "Frame with ID 0 is showing
// error page"; other versions name the error page's URL ("Cannot access contents of url "chrome-error://..."), which
// the /Cannot access/ rule used to read as an origin change and pause the session.
const BROWSER_ERROR_MESSAGES = [
  'Frame with ID 0 is showing error page',
  'Cannot access contents of url "chrome-error://chromewebdata/". Extension manifest must request permission to access this host.',
];
const throwing = message => () => { throw new Error(message); };

async function onBrowserErrorPage(message) {
  const h = await started();
  h.tab.url = ORIGIN + '/broken';
  h.scriptOverride = () => throwing(message);
  return h;
}

const paused = h => h.sent.some(m => m.type === 'status' && m.status === 'paused');

for (const message of BROWSER_ERROR_MESSAGES) {
  test(`the browser's own error page on the approved origin is an error page observation, not a pause (${message.slice(0, 24)})`, async () => {
    const h = await onBrowserErrorPage(message);
    const id = h.command('observe');
    const reply = await h.waitFor(m => m.type === 'result' && m.id === id);
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    const observation = reply.result;
    assert.equal(observation.url, ORIGIN + '/broken');
    assert.equal(observation.browserErrorPage, true);
    assert.equal(observation.httpStatus, undefined, 'the status is unknown: the page script never ran');
    assert.deepEqual(observation.controls, []);
    assert.ok(observation.warnings.includes('browser_error_page'));
    assert.match(observation.text, /error page/);
    assert.match(observation.revision, /^browser-error:/);
    // The same error page twice has the same revision.
    const again = h.command('observe');
    const second = await h.waitFor(m => m.type === 'result' && m.id === again);
    assert.equal(second.result.revision, observation.revision);
    await sleep(20);
    assert.equal(paused(h), false, 'the session stays active');

    // A page action on it fails that command only (recoverable: the runtime observes the error page again).
    const click = h.command('execute', { action: { type: 'click', target: '1' }, expectedRevision: observation.revision });
    const refused = await h.waitFor(m => m.type === 'result' && m.id === click);
    assert.equal(refused.error.code, 'target_unavailable');
    assert.equal(refused.error.recoverable, true);
    assert.match(refused.error.message, /error page/);
    await sleep(20);
    assert.equal(paused(h), false);

    // A reload once the site is back reads the page again, in the same session.
    let reloads = 0;
    h.chrome.tabs.reload = async () => {
      reloads++;
      h.scriptOverride = null;
      h.navigate(ORIGIN + '/broken', { start: 0, commit: 5, complete: 30 });
    };
    const reload = h.command('execute', { action: { type: 'history', move: 'reload' }, expectedRevision: observation.revision });
    const reloaded = await h.waitFor(m => m.type === 'result' && m.id === reload, 6000);
    assert.equal(reloaded.error, undefined, JSON.stringify(reloaded.error));
    assert.equal(reloads, 1);
    assert.equal(reloaded.result.observation.browserErrorPage, undefined);
    assert.equal(reloaded.result.observation.title, 'Fixture');
    assert.equal(paused(h), false);
  });
}

test('a page that commits as the browser error page after a click is observed as one; another approved URL still opens', async () => {
  const h = await started();
  h.pageExecute = action => {
    h.navigate(ORIGIN + '/down', { start: 20, commit: 40, complete: 80 });
    // The next document is Chrome's error page: every page call fails from now on.
    setTimeout(() => { h.scriptOverride = () => throwing(BROWSER_ERROR_MESSAGES[0]); }, 40);
    return linkClick(h)(action);
  };
  const { reply } = await runExecute(h);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.equal(reply.result.navigated, true);
  assert.equal(reply.result.observation.url, ORIGIN + '/down');
  assert.equal(reply.result.observation.browserErrorPage, true);
  assert.equal(paused(h), false);

  // navigate_allowed_url from the error page (page.js cannot run there): the worker opens it itself.
  const updates = [];
  const update = h.chrome.tabs.update.bind(h.chrome.tabs);
  h.chrome.tabs.update = async (id, info) => {
    if (info.url) {
      updates.push(info.url);
      h.scriptOverride = null;
      h.navigate(info.url, { start: 0, commit: 5, complete: 30 });
    }
    return update(id, info);
  };
  // Only from an observation of this error page: another revision is stale, and the tab is not touched.
  const stale = h.command('execute', { action: { type: 'navigate_allowed_url', url: ORIGIN + '/home' }, expectedRevision: 'doc:1' });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === stale)).error.code, 'stale');
  assert.deepEqual(updates, []);
  const open = h.command('execute', { action: { type: 'navigate_allowed_url', url: ORIGIN + '/home' },
    expectedRevision: reply.result.observation.revision });
  const opened = await h.waitFor(m => m.type === 'result' && m.id === open, 6000);
  assert.equal(opened.error, undefined, JSON.stringify(opened.error));
  assert.deepEqual(updates, [ORIGIN + '/home']);
  assert.equal(opened.result.observation.url, ORIGIN + '/home');
  assert.equal(opened.result.navigated, true);
  // Off the approved site it is refused as before, without touching the tab.
  const outside = h.command('execute', { action: { type: 'navigate_allowed_url', url: 'https://evil.test/' }, expectedRevision: 'doc:1' });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === outside)).error.code, 'cross_origin');
  assert.deepEqual(updates, [ORIGIN + '/home']);
});

test('a browser error page off the approved origin, or a tab whose URL Chrome withholds, still pauses as origin_changed', async () => {
  // The tab tried another origin and Chrome shows its error page there.
  const h = await started();
  h.tab.url = 'https://elsewhere.test/broken';
  h.scriptOverride = () => throwing(BROWSER_ERROR_MESSAGES[1]);
  const id = h.command('observe');
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(reply.error.code, 'origin_changed');
  const status = await h.waitFor(m => m.type === 'status' && m.status === 'paused');
  assert.equal(status.reason, 'origin_changed');

  // Chrome withdrew access (an activeTab grant ends at a cross-origin commit, its own error page included): tab.url is
  // gone and scripting fails without naming the page.
  const withheld = await started();
  withheld.tab.url = undefined;
  withheld.scriptOverride = () => throwing('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');
  const observe = withheld.command('observe');
  assert.equal((await withheld.waitFor(m => m.type === 'result' && m.id === observe)).error.code, 'origin_changed');
  assert.equal((await withheld.waitFor(m => m.type === 'status' && m.status === 'paused')).reason, 'origin_changed');

  // A script error that names a host permission on the approved URL is still an origin change (not an error page).
  const denied = await started();
  denied.scriptOverride = () => throwing('Missing host permission for the tab');
  const call = denied.command('observe');
  assert.equal((await denied.waitFor(m => m.type === 'result' && m.id === call)).error.code, 'origin_changed');
  assert.equal((await denied.waitFor(m => m.type === 'status' && m.status === 'paused')).reason, 'origin_changed');

  // Page-controlled text that merely contains "chrome-error://" (a URL's query) is not the browser's error page.
  for (const spoof of [
    'Cannot access contents of url "https://evil.test/?x=chrome-error://chromewebdata/". Extension manifest must request permission to access this host.',
    'Cannot access contents of url "https://evil.test/?x=Frame%20with%20ID%200%20is%20showing%20error%20page".',
  ]) {
    const spoofed = await started();
    spoofed.scriptOverride = () => throwing(spoof);
    const observe = spoofed.command('observe');
    assert.equal((await spoofed.waitFor(m => m.type === 'result' && m.id === observe)).error.code, 'origin_changed', spoof);
    assert.equal((await spoofed.waitFor(m => m.type === 'status' && m.status === 'paused')).reason, 'origin_changed');
  }
});

// --- permission levels (configurable-guardrails.md §3.4, extension side) -------------------------------------------

const TEST_ORIGIN = ORIGIN; // the leased tab's origin, listed as a testing environment in the tests below
const REVERSIBLE = ['navigate', 'controls'];
const FULL = ['navigate', 'controls', 'submit_safe', 'submit', 'delete', 'consent_accept'];
const TESTING = [...FULL, 'sign_in', 'purchase'];

async function observeAllow(h, args) {
  const id = h.command('observe', args);
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  return h.pageArgs.at(-1).args[0].allow;
}

async function withRequest(h, origins) {
  h.push({ type: 'requests', requests: [{ requestId: 'req_1', state: 'pending', origins, mode: 'testing' }] });
  await h.until(() => h.session.requests?.length === 1);
}

test('the lease carries the level the user picked; a missing or unknown level is read-only', async () => {
  const h = await started({ level: 'reversible' });
  assert.equal(h.sent.find(m => m.type === 'lease').level, 'reversible');
  const state = await h.send({ type: 'connect' });
  assert.equal(state.session.level, 'reversible', 'the popup reads the grant from the worker state');

  for (const level of [undefined, 'admin', 42]) {
    const other = harness();
    await other.waitFor(m => m.type === 'hello');
    await other.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, level });
    assert.equal(other.sent.find(m => m.type === 'lease').level, 'read-only', String(level));
  }
});

test('page.js gets the capabilities of the lower of the command level and the grant; no level means read-only', async () => {
  const h = await started({ level: 'reversible' });
  assert.deepEqual(await observeAllow(h, { level: 'full' }), REVERSIBLE, 'the host cannot raise the grant');
  assert.deepEqual(await observeAllow(h, { level: 'testing' }), REVERSIBLE);
  assert.deepEqual(await observeAllow(h, { level: 'reversible' }), REVERSIBLE);
  assert.deepEqual(await observeAllow(h, { level: 'read-only' }), ['navigate'], 'the host can lower it');
  assert.deepEqual(await observeAllow(h, {}), ['navigate'], 'an old host without level gets read-only');
  assert.deepEqual(await observeAllow(h, { level: 'bogus' }), ['navigate']);

  await runExecute(h, { level: 'full', expectedRevision: 'doc:1' });
  assert.deepEqual(h.pageArgs.filter(c => c.method === 'execute').at(-1).args[5], REVERSIBLE);
  await runExecute(h, { expectedRevision: 'doc:2' });
  assert.deepEqual(h.pageArgs.filter(c => c.method === 'execute').at(-1).args[5], ['navigate'],
    'an execute without level is read-only, whatever the last observe said');
});

test('capabilities reach settleAndObserve after a navigation too', async () => {
  const h = await started({ level: 'full' });
  h.pageExecute = action => {
    h.navigate(ORIGIN + '/next', { start: 10, commit: 20, complete: 60 });
    return linkClick(h)(action);
  };
  const { reply } = await runExecute(h, { level: 'interactive' });
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  const settle = h.pageArgs.filter(c => c.method === 'settleAndObserve').at(-1);
  assert.deepEqual(settle.args[3], ['navigate', 'controls', 'submit_safe']);
});

test('testing is granted only when every requested origin is a listed testing environment', async () => {
  const h = harness({ permissions: { defaultLevel: 'read-only', testingOrigins: [TEST_ORIGIN] } });
  await h.waitFor(m => m.type === 'hello');
  await withRequest(h, [TEST_ORIGIN, 'https://prod.example.com']);
  const refused = await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, level: 'testing' });
  assert.match(refused.error, /Testing environments/);
  assert.equal(h.sent.some(m => m.type === 'lease'), false, 'no lease is asked for');

  const ok = harness({ permissions: { testingOrigins: [TEST_ORIGIN, 'http://localhost:3000'] } });
  await ok.waitFor(m => m.type === 'hello');
  await withRequest(ok, [TEST_ORIGIN]);
  const reply = await ok.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, level: 'testing' });
  assert.equal(reply.status, 'active', JSON.stringify(reply));
  assert.equal(reply.session.level, 'testing');
  assert.equal(ok.sent.find(m => m.type === 'lease').level, 'testing');
  assert.deepEqual(await observeAllow(ok, { level: 'testing' }), TESTING);
  assert.deepEqual(await observeAllow(ok, { level: 'full' }), FULL);
});

test('testing is refused without a known request, with an unlisted tab origin, or with malformed stored origins', async () => {
  const unknown = harness({ permissions: { testingOrigins: [TEST_ORIGIN] } });
  await unknown.waitFor(m => m.type === 'hello');
  const noRequest = await unknown.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, level: 'testing' });
  assert.match(noRequest.error, /Testing environments/, 'the popup cannot vouch for a request the worker never saw');

  const wildcard = harness({ permissions: { testingOrigins: ['https://*.example.com', `${TEST_ORIGIN}/`, 'example.com'] } });
  await wildcard.waitFor(m => m.type === 'hello');
  await withRequest(wildcard, [TEST_ORIGIN]);
  const bad = await wildcard.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, level: 'testing' });
  assert.match(bad.error, /Testing environments/);
  assert.equal(wildcard.sent.some(m => m.type === 'lease'), false);
});

test('a lease bound to an origin that is not listed is given back instead of running in testing mode', async () => {
  const h = harness({ permissions: { testingOrigins: [TEST_ORIGIN] }, leaseOrigins: [TEST_ORIGIN, 'https://prod.example.com'] });
  await h.waitFor(m => m.type === 'hello');
  await withRequest(h, [TEST_ORIGIN]);
  const reply = await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, level: 'testing' });
  assert.match(reply.error, /Testing environments/);
  const status = await h.waitFor(m => m.type === 'status');
  assert.deepEqual({ leaseId: status.leaseId, status: status.status }, { leaseId: LEASE_ID, status: 'stopped' });
});

test('removing the testing environment mid-session drops the grant to Full at once', async () => {
  const h = harness({ permissions: { testingOrigins: [TEST_ORIGIN] } });
  await h.waitFor(m => m.type === 'hello');
  await withRequest(h, [TEST_ORIGIN]);
  await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, level: 'testing' });
  assert.deepEqual(await observeAllow(h, { level: 'testing' }), TESTING);
  assert.equal((await h.send({ type: 'connect' })).session.level, 'testing');
  h.local.permissions = { testingOrigins: [] };
  h.emitStorage({ permissions: { newValue: { testingOrigins: [] } } }, 'local');
  assert.deepEqual(await observeAllow(h, { level: 'testing' }), FULL);
  assert.equal((await h.send({ type: 'connect' })).session.level, 'full');
});

test('a revoked testing session tells the daemon the lowered level once, and re-listing the origin does not restore it', async () => {
  const h = harness({ permissions: { testingOrigins: [TEST_ORIGIN] } });
  await h.waitFor(m => m.type === 'hello');
  await withRequest(h, [TEST_ORIGIN]);
  await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, level: 'testing' });
  assert.equal(h.sent.some(m => m.type === 'lease_level'), false, 'nothing is reported while testing holds');
  h.local.permissions = { testingOrigins: [] };
  h.emitStorage({ permissions: { newValue: { testingOrigins: [] } } }, 'local');
  const lowered = await h.waitFor(m => m.type === 'lease_level');
  assert.deepEqual({ leaseId: lowered.leaseId, level: lowered.level }, { leaseId: LEASE_ID, level: 'full' });
  assert.ok(lowered.ref !== undefined, 'a reply type: the daemon answers (or refuses a raise)');
  // Listing the origin again needs a new approval to bring testing back.
  h.local.permissions = { testingOrigins: [TEST_ORIGIN] };
  h.emitStorage({ permissions: { newValue: { testingOrigins: [TEST_ORIGIN] } } }, 'local');
  assert.deepEqual(await observeAllow(h, { level: 'testing' }), FULL);
  assert.equal((await h.send({ type: 'connect' })).session.level, 'full');
  assert.equal(h.sent.filter(m => m.type === 'lease_level').length, 1, 'reported once');
});

test('a revocation found when the popup connects is reported too, and the hello carries the lowered level', async () => {
  const h = harness({ permissions: { testingOrigins: [TEST_ORIGIN] } });
  await h.waitFor(m => m.type === 'hello');
  await withRequest(h, [TEST_ORIGIN]);
  await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, level: 'testing' });
  h.local.permissions = { testingOrigins: [] };
  await h.send({ type: 'connect' });
  assert.equal((await h.waitFor(m => m.type === 'lease_level')).level, 'full');
  // Had the message been lost, the next hello says the same (the daemon only lowers on it).
  h.socket.close();
  await h.until(() => h.sent.filter(m => m.type === 'hello').length === 2);
  assert.equal(h.sent.filter(m => m.type === 'hello')[1].session.level, 'full');
});

test('connect re-reads the testing environments, so the popup sees Full before the worker\'s onChanged fires', async () => {
  const h = harness({ permissions: { testingOrigins: [TEST_ORIGIN] } });
  await h.waitFor(m => m.type === 'hello');
  await withRequest(h, [TEST_ORIGIN]);
  await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, level: 'testing' });
  h.local.permissions = { testingOrigins: [] };
  assert.equal((await h.send({ type: 'connect' })).session.level, 'full');
});

// --- domain roots: subdomain navigation, host permission request/release/remember ---------------------------------

const SITE_ROOT = 'https://*.example.com';
const SITE_PATTERN = 'https://*.example.com/*';

async function startedOnSite({ scope = 'domain', level, allow = true, local, origins = [SITE_ROOT], hostGrants = [] } = {}) {
  const h = harness({ hostGrants, local, leaseOrigins: scope === 'domain' ? origins : [ORIGIN] });
  await h.waitFor(m => m.type === 'hello');
  await sleep(10);
  // The popup reports the pattern it requests (track) and Chrome grants it; the worker start's reconcile has run.
  await h.send({ type: 'track', patterns: [SITE_PATTERN] });
  if (allow) h.grant(SITE_PATTERN);
  h.push({ type: 'requests', requests: [{ requestId: 'req_1', state: 'pending', origins, mode: 'read-only' }] });
  await h.until(() => h.session.requests?.length === 1);
  const reply = await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, scope,
    ...(level ? { level } : {}) });
  assert.equal(reply.status, 'active', JSON.stringify(reply));
  return { h, reply };
}

async function observeOn(h, allowedOrigins = [SITE_ROOT]) {
  const id = h.command('observe', {}, { allowedOrigins });
  return h.waitFor(m => m.type === 'result' && m.id === id);
}

test('domain scope: the lease asks for the domain, the session follows another https subdomain and page.js gets the root', async () => {
  const { h, reply } = await startedOnSite();
  assert.equal(h.sent.find(m => m.type === 'lease').scope, 'domain');
  assert.equal(reply.session.scope, 'domain');
  h.navigate('https://www.example.com/team', { start: 0, commit: 5 });
  await sleep(80);
  const result = await observeOn(h);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
  assert.equal(result.result.url, 'https://www.example.com/team');
  assert.deepEqual(h.pageArgs.at(-1).args[0].sites, ['example.com']);
  assert.ok(!h.sent.some(m => m.type === 'status'), 'no pause within the root');
  assert.equal((await h.send({ type: 'connect' })).session.origin, 'https://www.example.com', 'the current origin moved');
  // A page on another registrable domain still ends the session (origin_changed); http is not covered either.
  h.navigate('http://shop.example.com/', { start: 0, commit: 5 });
  const status = await h.waitFor(m => m.type === 'status');
  assert.deepEqual({ status: status.status, reason: status.reason }, { status: 'paused', reason: 'origin_changed' });
});

test('domain scope: navigate_allowed_url may move within the root, never to another domain', async () => {
  const { h } = await startedOnSite();
  const outside = h.command('execute', { action: { type: 'navigate_allowed_url', url: 'https://example.net/' }, expectedRevision: 'doc:1' },
    { allowedOrigins: [SITE_ROOT] });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === outside)).error.code, 'cross_origin');
  const inside = h.command('execute', { action: { type: 'navigate_allowed_url', url: 'https://docs.example.com/a' }, expectedRevision: 'doc:1' },
    { allowedOrigins: [SITE_ROOT] });
  const result = await h.waitFor(m => m.type === 'result' && m.id === inside);
  assert.notEqual(result.error?.code, 'cross_origin', JSON.stringify(result.error));
});

test('a domain choice without Chrome\'s host permission falls back to the exact origin', async () => {
  const { h, reply } = await startedOnSite({ allow: false });
  assert.equal(h.sent.find(m => m.type === 'lease').scope, 'origin', 'never taken from the popup\'s word');
  assert.equal(reply.session.scope, 'origin');
  h.navigate('https://www.example.com/team', { start: 0, commit: 5 });
  const status = await h.waitFor(m => m.type === 'status');
  assert.equal(status.reason, 'origin_changed');
});

test('"Only this origin" sends scope origin and the unused host permission is removed at once', async () => {
  const { h, reply } = await startedOnSite({ scope: 'origin' });
  assert.equal(h.sent.find(m => m.type === 'lease').scope, 'origin');
  assert.equal(reply.session.scope, 'origin');
  await h.until(() => h.removed.includes(SITE_PATTERN));
});

test('an exact request sends no scope; its session never widens', async () => {
  const h = await started();
  assert.equal(h.sent.find(m => m.type === 'lease').scope, undefined);
  assert.equal((await h.send({ type: 'connect' })).session.scope, 'origin');
});

test('stopping a domain session removes its host permission; pausing keeps it for Resume', async () => {
  const { h } = await startedOnSite();
  await h.send({ type: 'pause' });
  await sleep(20);
  assert.deepEqual(h.removed, [], 'a paused lease can resume without a new Chrome prompt');
  await h.send({ type: 'stop' });
  await h.until(() => h.removed.includes(SITE_PATTERN));
  assert.equal(h.grants.size, 0);
});

test('the daemon ending the lease, or a hello ending the session, removes the host permission', async () => {
  const { h } = await startedOnSite();
  h.push({ type: 'lease_update', leaseId: LEASE_ID, state: 'released' });
  await h.until(() => h.removed.includes(SITE_PATTERN));
});

test('remember on: a Read-only domain approval keeps its host permission for 24 hours; Forget removes it', async () => {
  const before = Date.now();
  const { h } = await startedOnSite({ local: { domainMemory: { remember: true } } });
  await h.send({ type: 'stop' });
  await h.until(() => Array.isArray(h.local.rememberedSites) && h.local.rememberedSites.length === 1);
  const [site] = h.local.rememberedSites;
  assert.equal(site.root, 'example.com');
  assert.ok(site.until >= before + 24 * 3600_000 && site.until <= Date.now() + 24 * 3600_000, 'time-boxed to 24 h');
  await sleep(20);
  assert.deepEqual(h.removed, [], 'kept while remembered');
  await h.send({ type: 'forget', root: 'example.com' });
  assert.deepEqual(clone(h.local.rememberedSites), []);
  assert.deepEqual(h.removed, [SITE_PATTERN]);
});

test('remember on: an approval above Reversible is never remembered', async () => {
  const { h } = await startedOnSite({ level: 'interactive', local: { domainMemory: { remember: true } } });
  await h.send({ type: 'stop' });
  await h.until(() => h.removed.includes(SITE_PATTERN));
  assert.deepEqual(clone(h.local.rememberedSites ?? []), []);
});

test('turning remember off, or the 24 h passing, removes remembered host permissions', async () => {
  const soon = Date.now() + 3600_000;
  const h = harness({ hostGrants: [SITE_PATTERN, 'https://*.old.example/*'],
    local: { domainMemory: { remember: true }, trackedSites: [SITE_PATTERN, 'https://*.old.example/*'],
      rememberedSites: [{ root: 'example.com', until: soon }, { root: 'old.example', until: Date.now() - 1 }] } });
  await h.waitFor(m => m.type === 'hello');
  await h.until(() => h.removed.includes('https://*.old.example/*'));
  assert.ok(!h.removed.includes(SITE_PATTERN), 'an unexpired remembered domain survives a worker start');
  assert.deepEqual(clone(h.local.rememberedSites), [{ root: 'example.com', until: soon }]);
  h.local.domainMemory = { remember: false };
  h.emitStorage({ domainMemory: { newValue: { remember: false } } }, 'local');
  await h.until(() => h.removed.includes(SITE_PATTERN));
  assert.deepEqual(clone(h.local.rememberedSites), []);
});

test('a worker start removes tracked host permissions no session holds; never one the user granted by hand', async () => {
  const h = harness({ hostGrants: [SITE_PATTERN, 'https://app.example.org/*', 'https://*.byhand.example.org/*'],
    local: { trackedSites: [SITE_PATTERN] } });
  await h.waitFor(m => m.type === 'hello');
  await h.until(() => h.removed.includes(SITE_PATTERN));
  assert.ok(!h.removed.includes('https://app.example.org/*'), 'only https://*.<root>/* patterns are managed');
  assert.ok(!h.removed.includes('https://*.byhand.example.org/*'), 'an untracked pattern is the user\'s own');
  await h.until(() => Array.isArray(h.local.trackedSites) && h.local.trackedSites.length === 0);
  h.alarmFire();
  await sleep(20);
  assert.deepEqual(h.removed, [SITE_PATTERN]);
});

test('a permission granted just before start survives a reconcile in between', async () => {
  const h = harness({ hostGrants: [] });
  await h.waitFor(m => m.type === 'hello');
  await sleep(10);
  await h.send({ type: 'track', patterns: [SITE_PATTERN, 'https://*.co.uk/*', 'http://example.com/*', 'https://example.com/a/*'] });
  assert.deepEqual(clone(h.local.trackedSites), [SITE_PATTERN, 'http://example.com/*'], 'valid root and exact-site patterns are tracked');
  h.grant(SITE_PATTERN);
  h.alarmFire();
  await sleep(20);
  assert.deepEqual(h.removed, [], 'the approval in progress keeps it');
});

test('a failed start never leaves the permission it obtained behind', async () => {
  const h = harness({ hostGrants: [], leaseError: 'origin_not_requested' });
  await h.waitFor(m => m.type === 'hello');
  h.push({ type: 'requests', requests: [{ requestId: 'req_1', state: 'pending', origins: [SITE_ROOT], mode: 'read-only' }] });
  await h.until(() => h.session.requests?.length === 1);
  await sleep(10);
  await h.send({ type: 'track', patterns: [SITE_PATTERN] });
  h.grant(SITE_PATTERN);
  const reply = await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, scope: 'domain' });
  assert.ok(reply.error, 'the start failed');
  await h.until(() => h.removed.includes(SITE_PATTERN));
});

test('superseding a domain session with another root releases the first root and keeps the second', async () => {
  const OTHER_ROOT = 'https://*.example.org';
  const OTHER_PATTERN = 'https://*.example.org/*';
  const h = harness({ hostGrants: [], leaseOrigins: message => (message.requestId === 'req_2' ? [OTHER_ROOT] : [SITE_ROOT]) });
  await h.waitFor(m => m.type === 'hello');
  h.push({ type: 'requests', requests: [
    { requestId: 'req_1', state: 'pending', origins: [SITE_ROOT], mode: 'read-only' },
    { requestId: 'req_2', state: 'pending', origins: [OTHER_ROOT], mode: 'read-only' },
  ] });
  await h.until(() => h.session.requests?.length === 2);
  await sleep(10);
  await h.send({ type: 'track', patterns: [SITE_PATTERN] });
  h.grant(SITE_PATTERN);
  assert.equal((await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, scope: 'domain' })).session.scope, 'domain');
  await h.send({ type: 'track', patterns: [OTHER_PATTERN] });
  h.grant(OTHER_PATTERN);
  const second = await h.send({ type: 'start', requestId: 'req_2', endpoint: ENDPOINT, secret: SECRET, scope: 'domain' });
  assert.equal(second.session.scope, 'domain');
  await h.until(() => h.removed.includes(SITE_PATTERN));
  await sleep(20);
  assert.ok(!h.removed.includes(OTHER_PATTERN), 'the new session keeps its own root');
});

test('a remembered domain approved later at Full is no longer remembered: its permission goes with that session', async () => {
  const soon = Date.now() + 3600_000;
  const { h } = await startedOnSite({ level: 'full', hostGrants: [SITE_PATTERN],
    local: { domainMemory: { remember: true }, trackedSites: [SITE_PATTERN], rememberedSites: [{ root: 'example.com', until: soon }] } });
  await h.until(() => Array.isArray(h.local.rememberedSites) && h.local.rememberedSites.length === 0);
  await h.send({ type: 'stop' });
  await h.until(() => h.removed.includes(SITE_PATTERN));
  assert.deepEqual(clone(h.local.rememberedSites), []);
});

// --- Open <host>: the page opens in a new task tab, armed; the toolbar icon click there is the approval -------------

const SHOP = 'https://shop.example.com';

// "Open <host>" from the popup: right-away opening is off here, so the page opens only on the popup's `open`.
async function armed({ origins = [SHOP], url = `${SHOP}/cart`, level = 'reversible', sessionStore } = {}) {
  const h = harness({ hostGrants: [], leaseOrigins: origins, sessionStore, local: { openRightAway: false } });
  await h.waitFor(m => m.type === 'hello');
  h.push({ type: 'requests', requests: [{ requestId: 'req_1', state: 'pending', origins, url, mode: 'full', client: 'Codex' }] });
  await h.until(() => h.session.requests?.length === 1);
  const reply = await h.send({ type: 'open', requestId: 'req_1', level });
  return { h, reply };
}

test('open arms the tab: no popup there, ? badge, FAI ? group, no lease', async () => {
  const { h, reply } = await armed();
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.deepEqual(clone(h.tabsCreated), [{ windowId: 2, url: `${SHOP}/cart`, active: true }]);
  assert.deepEqual(h.windowsCreated, []);
  assert.equal(h.tabPopups.get(9), '');
  assert.equal(h.tabBadges.get(9), '?');
  await h.until(() => [...h.groups.values()].some(group => group.title === 'FAI ?'));
  assert.equal(h.sent.some(m => m.type === 'lease'), false);
  assert.equal(h.session.armedTabs[0].requestId, 'req_1');
});

test('task tabs choose a normal non-private window and fall back when none remains', async () => {
  for (const options of [
    { lastWindow: { id: 4, type: 'normal', incognito: true }, normalWindows: [{ id: 2, type: 'normal' }] },
    { lastWindow: { id: 30, type: 'popup' }, normalWindows: [{ id: 2, type: 'normal' }] },
    { lastWindow: null },
    { lastWindow: { id: 4, type: 'normal', incognito: true } },
    { tabCreateFails: true },
  ]) {
    const h = harness({ ...options, local: { openRightAway: false } });
    await h.waitFor(m => m.type === 'hello');
    await withPending(h, [pendingRequest('req_1', { mode: 'read-only' })]);
    const reply = await h.send({ type: 'open', requestId: 'req_1', level: 'read-only' });
    assert.equal(reply.error, undefined);
    if (options.normalWindows?.length) {
      assert.deepEqual(h.tabsCreated, [{ windowId: 2, url: `${SHOP}/cart`, active: true }]);
      assert.deepEqual(h.windowsCreated, []);
      assert.ok(h.windowUpdates.some(update => update.id === 2 && update.focused));
    } else {
      assert.deepEqual(h.tabsCreated, []);
      assert.deepEqual(clone(h.windowsCreated), [{ url: `${SHOP}/cart`, focused: true }]);
    }
    assert.equal(h.sent.some(m => m.type === 'lease'), false);
  }
});

test('a browser without tab groups still opens and arms a task tab in the existing window', async () => {
  const h = harness({ local: { openRightAway: false } });
  delete h.chrome.tabGroups;
  delete h.chrome.tabs.group;
  await h.waitFor(m => m.type === 'hello');
  await withPending(h, [pendingRequest('req_1', { mode: 'read-only' })]);
  const reply = await h.send({ type: 'open', requestId: 'req_1', level: 'read-only' });
  assert.equal(reply.error, undefined);
  assert.equal(h.tabsCreated.length, 1);
  assert.equal(h.windowsCreated.length, 0);
  assert.equal(h.tabBadges.get(9), '?');
  assert.equal(h.sent.some(m => m.type === 'lease'), false);
});

test('the icon click on the armed tab leases it once at the armed level and restores the popup', async () => {
  const { h } = await armed();
  h.chrome.action.onClicked.emit({ id: 9, windowId: 2, url: `${SHOP}/cart`, title: 'Cart' });
  await h.until(() => h.sent.some(m => m.type === 'lease'));
  const leases = h.sent.filter(m => m.type === 'lease');
  assert.equal(leases.length, 1);
  assert.deepEqual({ tabId: leases[0].tabId, level: leases[0].level }, { tabId: 9, level: 'reversible' });
  assert.equal(h.tabPopups.get(9), 'popup.html');
});

test('a click when the tab left the site, or the request is gone, leases nothing and restores the popup', async () => {
  const { h } = await armed();
  h.chrome.action.onClicked.emit({ id: 9, windowId: 2, url: 'https://elsewhere.example/', title: 'x' });
  await h.until(() => h.tabPopups.get(9) === 'popup.html');
  assert.match(h.session.openNotice.message, /nothing was approved/);
  const second = await armed();
  second.h.push({ type: 'requests', requests: [] });
  await second.h.until(() => second.h.tabPopups.get(9) === 'popup.html');
  second.h.chrome.action.onClicked.emit({ id: 9, windowId: 2, url: `${SHOP}/cart` });
  await sleep(30);
  assert.equal(h.sent.some(m => m.type === 'lease') || second.h.sent.some(m => m.type === 'lease'), false);
});

test('closing the armed tab disarms it; a worker restart keeps the arm', async () => {
  const { h } = await armed();
  h.chrome.tabs.onRemoved.emit(9);
  await h.until(() => h.session.armedTabs?.length === 0);
  const stored = [{ tabId: 9, requestId: 'req_1', level: 'read-only', scope: 'origin', client: '', at: Date.now(), groupId: null }];
  const restarted = harness({ hostGrants: [], leaseOrigins: [SHOP], sessionStore: { armedTabs: stored } });
  await restarted.waitFor(m => m.type === 'hello');
  restarted.push({ type: 'requests', requests: [{ requestId: 'req_1', state: 'pending', origins: [SHOP], mode: 'read-only' }] });
  await restarted.until(() => restarted.session.requests?.length === 1);
  restarted.chrome.action.onClicked.emit({ id: 9, windowId: 2, url: `${SHOP}/`, title: 'Shop' });
  await restarted.until(() => restarted.sent.some(m => m.type === 'lease'));
});

// --- The approval window: popup.html?window=1, once per new pending request ------------------------------------------

const pendingRequest = (requestId, extra = {}) => ({ requestId, state: 'pending', origins: [SHOP], url: `${SHOP}/cart`,
  mode: 'read-only', ...extra });

async function withPending(h, list) {
  h.push({ type: 'requests', requests: list });
  await h.until(() => h.session.requests?.length === list.length);
  await sleep(20);
}

// With "Open requested pages right away" off: the window is the only sign.
const WINDOW_ONLY = { openRightAway: false };

test('approval window: without openPopup, a new request opens one focused top-right popup; the same request never again', async () => {
  const h = harness({ local: WINDOW_ONLY });
  await h.waitFor(m => m.type === 'hello');
  await withPending(h, [pendingRequest('req_1')]);
  assert.deepEqual(clone(h.popupWindows), [{ url: 'chrome-extension://ext/popup.html?window=1', type: 'popup',
    width: 420, height: 620, left: 856, top: 140, focused: true }]);
  assert.deepEqual(h.tabsCreated, [], 'nothing opens by itself');
  assert.equal(h.badge, '?', 'the badge still says a request waits');
  await withPending(h, [pendingRequest('req_1')]);
  assert.equal(h.popupWindows.length, 1);
  // A worker restart keeps storage.session: the daemon's list in the new hello shows nothing again.
  const restarted = harness({ sessionStore: clone(h.session), local: WINDOW_ONLY });
  await restarted.waitFor(m => m.type === 'hello');
  await withPending(restarted, [pendingRequest('req_1')]);
  assert.deepEqual(restarted.popupWindows, []);
});

test('approval UI: a supported action.openPopup opens the toolbar popup once, with no standalone window', async () => {
  const h = harness({ local: WINDOW_ONLY, actionOpenPopup: 'ok' });
  await h.waitFor(m => m.type === 'hello');
  await withPending(h, [pendingRequest('req_1')]);
  assert.deepEqual(h.actionPopupCalls, [{}]);
  assert.deepEqual(h.popupWindows, []);
  await withPending(h, [pendingRequest('req_1')]);
  assert.equal(h.actionPopupCalls.length, 1);
});

test('approval UI: a rejected action.openPopup falls back to the top-right window', async () => {
  const h = harness({ local: WINDOW_ONLY, actionOpenPopup: 'error' });
  await h.waitFor(m => m.type === 'hello');
  await withPending(h, [pendingRequest('req_1')]);
  assert.deepEqual(h.actionPopupCalls, [{}]);
  assert.deepEqual(clone(h.popupWindows), [{ url: 'chrome-extension://ext/popup.html?window=1', type: 'popup',
    width: 420, height: 620, left: 856, top: 140, focused: true }]);
});

test('approval window: a second request repositions and focuses the open window instead of opening another', async () => {
  const h = harness({ local: WINDOW_ONLY });
  await h.waitFor(m => m.type === 'hello');
  await withPending(h, [pendingRequest('req_1')]);
  await withPending(h, [pendingRequest('req_1'), pendingRequest('req_2')]);
  assert.equal(h.popupWindows.length, 1);
  assert.deepEqual(clone(h.windowUpdates), [{ id: 31, left: 856, top: 140, focused: true }]);
  // Closed by then (approved, denied or by hand): the next request opens a new one.
  h.closePopup(31);
  await withPending(h, [pendingRequest('req_3')]);
  assert.equal(h.popupWindows.length, 2);
});

test('approval window: off under Permissions, or for the live session\'s own request, nothing opens', async () => {
  const off = harness({ local: { approvalWindow: false, ...WINDOW_ONLY } });
  await off.waitFor(m => m.type === 'hello');
  await withPending(off, [pendingRequest('req_1')]);
  assert.deepEqual(off.popupWindows, []);
  assert.equal(off.badge, '?');
  const h = await started();
  await withPending(h, [pendingRequest('req_1')]);
  assert.deepEqual(h.popupWindows, []);
});


// --- Arms: timeout, request end, domain scope, "Open requested pages right away", "Approve on the FAI tab" -----------

test('an arm ends after ten minutes: the next alarm restores the popup and a late click leases nothing', async () => {
  const stored = [{ tabId: 9, requestId: 'req_1', level: 'read-only', scope: 'origin', client: '', at: Date.now() - 10 * 60_000 - 5,
    groupId: null }];
  const h = harness({ hostGrants: [], leaseOrigins: [SHOP], sessionStore: { armedTabs: stored } });
  await h.waitFor(m => m.type === 'hello');
  h.alarmFire();
  await h.until(() => h.tabPopups.get(9) === 'popup.html');
  assert.deepEqual(clone(h.session.armedTabs), []);
  h.push({ type: 'requests', requests: [pendingRequest('req_1')] });
  await h.until(() => h.session.requests?.length === 1);
  h.chrome.action.onClicked.emit({ id: 9, windowId: 2, url: `${SHOP}/`, title: 'Shop' });
  await sleep(30);
  assert.equal(h.sent.some(m => m.type === 'lease'), false);
});

test('an arm ends when its request does, and when another tab is leased for that request', async () => {
  const { h } = await armed();
  await h.send({ type: 'open', requestId: 'req_1', level: 'read-only' });
  await h.until(() => h.session.armedTabs?.length === 2);
  const [first, second] = h.session.armedTabs.map(arm => arm.tabId);
  h.chrome.action.onClicked.emit({ id: first, windowId: 2, url: `${SHOP}/cart`, title: 'Cart' });
  await h.until(() => h.sent.some(m => m.type === 'lease'));
  await h.until(() => h.tabPopups.get(second) === 'popup.html');
  assert.deepEqual(clone(h.session.armedTabs), []);
  const other = await armed();
  other.h.push({ type: 'requests', requests: [{ requestId: 'req_1', state: 'denied', origins: [SHOP] }] });
  await other.h.until(() => other.h.tabPopups.get(9) === 'popup.html');
  assert.equal(other.h.tabBadges.get(9), null);
});

test('open with "All of <root>": domain scope when Chrome holds the root, origin when it was declined', async () => {
  for (const [grants, scope] of [[[SITE_PATTERN], 'domain'], [[], 'origin']]) {
    const h = harness({ hostGrants: grants, leaseOrigins: scope === 'domain' ? [SITE_ROOT] : ['https://www.example.com'],
      local: WINDOW_ONLY });
    await h.waitFor(m => m.type === 'hello');
    h.push({ type: 'requests', requests: [{ requestId: 'req_1', state: 'pending', origins: [SITE_ROOT],
      url: 'https://www.example.com/', mode: 'read-only' }] });
    await h.until(() => h.session.requests?.length === 1);
    const reply = await h.send({ type: 'open', requestId: 'req_1', level: 'read-only', scope: 'domain' });
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    assert.equal(h.session.armedTabs[0].scope, scope);
    h.chrome.action.onClicked.emit({ id: 9, windowId: 2, url: 'https://www.example.com/', title: 'Home' });
    await h.until(() => h.sent.some(m => m.type === 'lease'));
    assert.equal(h.sent.find(m => m.type === 'lease').scope, scope);
  }
});

// A request's page opened by itself ("Open requested pages right away", the default), armed, with its prompt window.
async function openedRightAway({ mode = 'reversible', local = {}, defaultLevel = 'read-only', client = 'Codex', timeScale = 1,
  request = {} } = {}) {
  const h = harness({ hostGrants: [], leaseOrigins: [SHOP], local, permissions: { defaultLevel }, timeScale });
  await h.waitFor(m => m.type === 'hello');
  h.push({ type: 'requests', requests: [pendingRequest('req_1', { mode, client, ...request })] });
  await h.until(() => h.session.armedTabs?.length === 1 && h.session.armedTabs[0].promptWindowId !== null);
  return h;
}

test('"Open requested pages right away" is on by default: the page opens armed at the requested level, up to Interactive, whatever the default level', async () => {
  const cases = [['read-only', 'full'], ['reversible', 'read-only'], ['interactive', 'read-only'], ['interactive', 'full']];
  for (const [mode, defaultLevel] of cases) {
    const h = await openedRightAway({ mode, defaultLevel });
    assert.deepEqual(clone(h.tabsCreated), [{ windowId: 2, url: `${SHOP}/cart`, active: true }]);
    assert.deepEqual(h.approvalWindows, [], 'no approval window');
    assert.equal(h.session.armedTabs[0].level, mode, `${mode} with default ${defaultLevel}`);
    await h.until(() => h.tabPopups.get(9) === '');
    assert.equal(h.sent.some(m => m.type === 'lease'), false, 'the icon click is still the approval');
    // The icon click leases at that level: the receipt's permissions say what the user saw.
    h.chrome.action.onClicked.emit({ id: 9, windowId: 2, url: `${SHOP}/cart`, title: 'Cart' });
    await h.until(() => h.sent.some(m => m.type === 'lease'));
    assert.equal(h.sent.find(m => m.type === 'lease').level, mode);
  }
});

test('"Open requested pages right away": a prompt placement Chrome refuses (window partly off screen) falls back to its own', async () => {
  const h = harness({ hostGrants: [], leaseOrigins: [SHOP], permissions: { defaultLevel: 'read-only' } });
  await h.waitFor(m => m.type === 'hello');
  const create = h.chrome.windows.create;
  const asked = [];
  h.chrome.windows.create = async options => {
    asked.push(options.left === undefined ? 'browser' : 'placed');
    if (options.left !== undefined) throw new Error('Invalid value for bounds. Bounds must be at least 50% within visible screen space.');
    return create(options);
  };
  h.push({ type: 'requests', requests: [pendingRequest('req_1', { mode: 'reversible' })] });
  await h.until(() => h.session.armedTabs?.[0]?.promptWindowId != null);
  assert.deepEqual(asked, ['placed', 'browser']);
});

test('"Open requested pages right away": Full and Testing requests get the approval window, nothing opens by itself', async () => {
  for (const mode of ['full', 'testing']) {
    const h = harness({ hostGrants: [], leaseOrigins: [SHOP], permissions: { defaultLevel: 'full' } });
    await h.waitFor(m => m.type === 'hello');
    await withPending(h, [pendingRequest('req_1', { mode })]);
    assert.deepEqual(h.tabsCreated, [], mode);
    assert.equal(h.approvalWindows.length, 1, mode);
    assert.deepEqual(h.promptWindows, [], mode);
    assert.deepEqual(clone(h.session.armedTabs ?? []), []);
  }
  // A request with no page to open still gets the approval window.
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  await withPending(h, [{ requestId: 'req_1', state: 'pending', origins: [SITE_ROOT], mode: 'read-only' }]);
  assert.equal(h.approvalWindows.length, 1);
  assert.deepEqual(h.tabsCreated, []);
});

test('"Open requested pages right away" turned off: every request gets the window; anything but false is on', async () => {
  const off = harness({ local: { openRightAway: false } });
  await off.waitFor(m => m.type === 'hello');
  await withPending(off, [pendingRequest('req_1', { mode: 'read-only' })]);
  assert.deepEqual(off.tabsCreated, []);
  assert.equal(off.approvalWindows.length, 1);
  const odd = await openedRightAway({ local: { openRightAway: 'off' } });
  assert.equal(odd.tabsCreated.length, 1);
});

test('the page opened by itself gets a prompt window next to it that names the level; it closes when the arm ends', async () => {
  // Approved: the icon click ends the arm and the prompt goes with it.
  const h = await openedRightAway({ mode: 'reversible' });
  assert.deepEqual(clone(h.promptWindows), [{ url: 'chrome-extension://ext/arm.html?tab=9', type: 'popup', width: 440, height: 430,
    left: 836, top: 140, focused: true }]);
  const promptId = h.session.armedTabs[0].promptWindowId;
  assert.equal(h.openPopup(promptId), true);
  assert.deepEqual(h.approvalWindows, []);
  h.chrome.action.onClicked.emit({ id: 9, windowId: 2, url: `${SHOP}/cart`, title: 'Cart' });
  await h.until(() => h.windowsRemoved.includes(promptId));
  assert.equal(h.sent.find(m => m.type === 'lease').level, 'reversible');
  // Denied (the request leaves pending): the prompt closes and the tab is as it was.
  const denied = await openedRightAway();
  const deniedPrompt = denied.session.armedTabs[0].promptWindowId;
  denied.push({ type: 'requests', requests: [{ requestId: 'req_1', state: 'denied', origins: [SHOP] }] });
  await denied.until(() => denied.windowsRemoved.includes(deniedPrompt));
  assert.equal(denied.tabPopups.get(9), 'popup.html');
  // Expired (ten minutes): the alarm disarms and closes the prompt.
  const stored = [{ tabId: 9, requestId: 'req_1', level: 'read-only', scope: 'origin', client: '', at: Date.now() - 10 * 60_000 - 5,
    groupId: null, promptWindowId: 31 }];
  const expired = harness({ hostGrants: [], leaseOrigins: [SHOP], sessionStore: { armedTabs: stored } });
  await expired.waitFor(m => m.type === 'hello');
  // The prompt window its predecessor opened is still there (the fake knows popup windows it created: open it first).
  await expired.chrome.windows.create({ url: 'chrome-extension://ext/arm.html?tab=9', type: 'popup' });
  expired.alarmFire();
  await expired.until(() => expired.windowsRemoved.includes(31));
  assert.deepEqual(clone(expired.session.armedTabs), []);
  // The tab closed: the prompt goes too.
  const closed = await openedRightAway();
  const closedPrompt = closed.session.armedTabs[0].promptWindowId;
  closed.chrome.tabs.onRemoved.emit(9);
  await closed.until(() => closed.windowsRemoved.includes(closedPrompt));
});

test('the prompt window\'s level choice changes the level the icon click approves; Deny ends the request', async () => {
  const h = await openedRightAway({ mode: 'reversible' });
  const changed = await h.send({ type: 'arm_level', tabId: 9, level: 'read-only' });
  assert.equal(changed.error, undefined, JSON.stringify(changed));
  assert.equal(h.session.armedTabs[0].level, 'read-only');
  const bad = await h.send({ type: 'arm_level', tabId: 9, level: 'root' });
  assert.match(bad.error, /no longer waiting/);
  const unknown = await h.send({ type: 'arm_level', tabId: 99, level: 'full' });
  assert.match(unknown.error, /no longer waiting/);
  h.chrome.action.onClicked.emit({ id: 9, windowId: 2, url: `${SHOP}/cart`, title: 'Cart' });
  await h.until(() => h.sent.some(m => m.type === 'lease'));
  assert.equal(h.sent.find(m => m.type === 'lease').level, 'read-only');
  const denied = await openedRightAway();
  await denied.send({ type: 'deny', requestId: 'req_1' });
  assert.equal(denied.sent.some(m => m.type === 'deny' && m.requestId === 'req_1'), true);
});

test('"Open <host>" from the popup also gets the prompt window', async () => {
  const { h } = await armed();
  await h.until(() => h.session.armedTabs[0].promptWindowId !== null);
  assert.equal(h.promptWindows.length, 1);
});

test('"Approve on the FAI tab" leases the live session\'s tab at the new level; refused, it arms that tab instead', async () => {
  const h = await started({ level: 'read-only' });
  h.push({ type: 'requests', requests: [{ requestId: 'req_2', state: 'pending', origins: [ORIGIN], mode: 'full' }] });
  await h.until(() => h.session.requests?.length === 1);
  const reply = await h.send({ type: 'start', requestId: 'req_2', level: 'full', onSessionTab: true });
  assert.equal(reply.status, 'active', JSON.stringify(reply));
  const lease = h.sent.filter(m => m.type === 'lease').at(-1);
  assert.deepEqual({ requestId: lease.requestId, tabId: lease.tabId, level: lease.level }, { requestId: 'req_2', tabId: 7, level: 'full' });
  assert.equal(h.tabPopups.has(7), false, 'nothing armed');
  // Testing with no testing environment listed is refused: the FAI tab is armed and the icon click there approves.
  h.push({ type: 'requests', requests: [{ requestId: 'req_3', state: 'pending', origins: [ORIGIN], mode: 'testing' }] });
  await h.until(() => h.session.requests?.some(item => item.requestId === 'req_3'));
  const refused = await h.send({ type: 'start', requestId: 'req_3', level: 'testing', onSessionTab: true });
  assert.match(refused.note, /Click the FAI Browser icon on the FAI tab/);
  assert.equal(h.tabPopups.get(7), '');
  assert.deepEqual(clone(h.session.armedTabs.map(arm => [arm.tabId, arm.requestId])), [[7, 'req_3']]);
  // That arm ending leaves the FAI tab as it was: popup back, its own ON badge again.
  h.push({ type: 'requests', requests: [{ requestId: 'req_3', state: 'denied', origins: [ORIGIN] }] });
  await h.until(() => h.tabPopups.get(7) === 'popup.html');
  await h.until(() => h.tabBadges.get(7) === 'ON');
});

test('"Open requested pages right away": a request the FAI tab already covers gets the window, not a second page', async () => {
  const h = await started({ level: 'read-only', local: { openRightAway: true } });
  h.push({ type: 'requests', requests: [{ requestId: 'req_2', state: 'pending', origins: [ORIGIN], url: `${ORIGIN}/`, mode: 'full' }] });
  await h.until(() => h.popupWindows.length === 1);
  assert.deepEqual(h.tabsCreated, []);
  assert.deepEqual(clone(h.session.armedTabs ?? []), []);
});

test('a tab armed for "All of <root>" keeps the roots\' permission across a worker restart and gives it back when it ends unapproved', async () => {
  const stored = [{ tabId: 9, requestId: 'req_1', level: 'read-only', scope: 'domain', patterns: [SITE_PATTERN], client: '',
    at: Date.now(), groupId: null }];
  const h = harness({ hostGrants: [SITE_PATTERN], leaseOrigins: [SITE_ROOT], local: { trackedSites: [SITE_PATTERN] },
    sessionStore: { armedTabs: stored } });
  await h.waitFor(m => m.type === 'hello');
  h.push({ type: 'requests', requests: [{ requestId: 'req_1', state: 'pending', origins: [SITE_ROOT], mode: 'read-only' }] });
  await h.until(() => h.session.requests?.length === 1);
  h.alarmFire();
  await sleep(30);
  assert.deepEqual(h.removed, [], 'the waiting arm holds the permission');
  h.push({ type: 'requests', requests: [{ requestId: 'req_1', state: 'denied', origins: [SITE_ROOT] }] });
  await h.until(() => h.removed.includes(SITE_PATTERN));
  assert.deepEqual(clone(h.session.armedTabs), []);
});

// --- The driven tab's mark: a FAI tab group and a per-tab badge -------------------------------------------------------

test('mark: the leased tab joins a FAI group, retitled FAI ⏸ on pause and ungrouped on stop; ON shows on that tab only', async () => {
  const h = await started();
  await h.until(() => h.groupOf.has(7));
  const groupId = h.groupOf.get(7);
  assert.deepEqual(clone(h.groups.get(groupId)), { title: 'FAI', color: 'grey', collapsed: false });
  assert.equal(h.tabBadge(7), 'ON');
  assert.equal(h.badge, '', 'no global ON');
  await h.until(() => h.session.markedTab);
  assert.deepEqual(clone(h.session.markedTab), { tabId: 7, groupId });
  await h.send({ type: 'pause' });
  await h.until(() => h.groups.get(groupId).title === 'FAI ⏸');
  assert.equal(h.groupOf.get(7), groupId, 'the same group');
  assert.equal(h.tabBadge(7), 'Ⅱ');
  await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET });
  await h.until(() => h.groups.get(h.groupOf.get(7))?.title === 'FAI');
  await h.send({ type: 'stop' });
  await h.until(() => !h.groupOf.has(7));
  assert.equal(h.tabBadge(7), null, 'the per-tab text is cleared');
  assert.equal(h.session.markedTab, null);
});

test('mark: a tab in a group the user made is left in it and not marked', async () => {
  const h = harness();
  h.groupOf.set(7, 5);
  h.groups.set(5, { title: 'Work' });
  await h.waitFor(m => m.type === 'hello');
  const reply = await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET });
  assert.equal(reply.status, 'active');
  await sleep(30);
  assert.equal(h.groupOf.get(7), 5);
  assert.deepEqual(clone(h.groups.get(5)), { title: 'Work' });
  assert.equal(h.tabBadge(7), 'ON', 'the badge still marks it');
  await h.send({ type: 'stop' });
  await sleep(30);
  assert.equal(h.groupOf.get(7), 5, 'stop does not ungroup a user group');
});

test('mark: the daemon ending the lease, or a worker restart, takes the mark back', async () => {
  const h = await started();
  await h.until(() => h.groupOf.has(7));
  h.push({ type: 'lease_update', leaseId: LEASE_ID, state: 'stopped' });
  await h.until(() => !h.groupOf.has(7));
  assert.equal(h.tabBadge(7), null);
  // A worker that died with a marked tab: the next one ungroups it from storage.session.
  const restarted = harness({ sessionStore: { markedTab: { tabId: 7, groupId: 100 }, badgeTab: 7 } });
  restarted.groupOf.set(7, 100);
  restarted.groups.set(100, { title: 'FAI' });
  await restarted.until(() => !restarted.groupOf.has(7));
  assert.equal(restarted.tabBadge(7), null, 'and clears the per-tab text it left');
});

test('mark: an opened window\'s tab is marked too once the icon click approves it', async () => {
  const { h } = await armed();
  h.chrome.action.onClicked.emit({ id: 9, windowId: 2, url: `${SHOP}/cart`, title: 'Cart' });
  await h.until(() => h.sent.some(m => m.type === 'lease'));
  await h.until(() => h.groups.get(h.groupOf.get(9))?.title === 'FAI');
  assert.equal(h.groups.get(h.groupOf.get(9)).title, 'FAI');
  assert.equal(h.tabBadge(9), 'ON');
});

// --- updates (docs/REFERENCE.md "Updates") ------------------------------------------------------------------------

const UPDATE = { enabled: true, current: '0.3.0', latest: '0.9.0', tag: 'v0.9.0', available: true,
  notesUrl: 'https://github.com/jedbjorn/fai-browser/releases/tag/v0.9.0', status: 'ok', install: null };

test('update: the hello and the popup connect carry a cleaned update view; Update from the popup asks the service', async () => {
  const h = harness({ daemonUpdate: { ...UPDATE, notesUrl: 'https://evil.example/', extra: 'x' } });
  await h.until(() => h.session.connection?.update);
  assert.deepEqual(h.session.connection.update, { current: '0.3.0', latest: '0.9.0', available: true, installable: true, notesUrl: null, install: null },
    'only versions, a notes link of the release itself, and the install');
  const page = await h.send({ type: 'update_install' }, { id: 'ext', url: ORIGIN });
  assert.match(page.error, /popup/);
  assert.ok(!h.sent.some(message => message.type === 'update' && message.action === 'install'), 'a page cannot install');
  const clicked = await h.send({ type: 'update_install' }, { id: 'ext', url: 'chrome-extension://ext/popup.html' });
  assert.equal(clicked.connection.update.install.state, 'running');
  assert.ok(h.sent.some(message => message.type === 'update' && message.action === 'install' && message.via === 'ws'));
  h.state.updateError = 'An agent holds a browser tab.';
  const refused = await h.send({ type: 'update_install' }, { id: 'ext', url: 'chrome-extension://ext/popup.html' });
  assert.match(refused.error, /holds a browser tab/);
  assert.equal(h.reloads.length, 0);
});

test('update: a newer service reloads the unpacked extension once per version; Firefox and an older service never', async () => {
  const h = harness({ daemonVersion: '0.9.0' });
  await h.until(() => h.reloads.length === 1);
  assert.equal(h.local.updateReloadedFor, '0.9.0');
  h.dispose();
  const again = harness({ daemonVersion: '0.9.0', local: { updateReloadedFor: '0.9.0' } });
  await again.waitFor(message => message.type === 'hello');
  await sleep(30);
  assert.equal(again.reloads.length, 0, 'not twice for the same version (no reload loop)');
  for (const options of [{ daemonVersion: '0.9.0', manifest: { browser_specific_settings: { gecko: { id: 'x@y' } } } },
    { daemonVersion: '0.3.0' }, { daemonVersion: '0.2.9' }]) {
    const other = harness(options);
    await other.waitFor(message => message.type === 'hello');
    await sleep(30);
    assert.equal(other.reloads.length, 0, JSON.stringify(options));
  }
});

test('update: never reloads during a session, even when a newer service answers after a reconnect', async () => {
  const h = await started();
  h.state.daemonVersion = '0.9.0';
  h.socket.close();
  await h.until(() => h.sent.filter(m => m.type === 'hello').length === 2);
  await sleep(30);
  assert.equal(h.reloads.length, 0, 'the approved tab keeps its session');
  assert.equal(h.local.updateReloadedFor, undefined);
});

test('update: a service that cannot install says so; the cleaned view keeps installable false', async () => {
  const h = harness({ daemonUpdate: { ...UPDATE, installable: false } });
  await h.until(() => h.session.connection?.update);
  assert.equal(h.session.connection.update.installable, false);
});

// --- per-request budget (Setup & connection) ---------------------------------------------------------------------

test('the hello carries the stored budget, and the daemon\'s reply says what is in effect', async () => {
  const stored = { maxCalls: 120, maxMs: 2_400_000 };
  const h = harness({ local: { budget: stored }, daemonBudget: { ...stored, source: 'extension' } });
  const hello = await h.waitFor(m => m.type === 'hello');
  assert.deepEqual(hello.settings, { budget: stored, openRightAway: true, tabMode: 'single', approvals: ASKS });
  await h.until(() => h.session.connection?.budget);
  assert.deepEqual(h.session.connection.budget, { ...stored, source: 'extension' });
  assert.deepEqual((await h.send({ type: 'connect' })).connection.budget, { ...stored, source: 'extension' });
});

test('budget bounds: 10000 calls is stored, reported and shown; 10001 (stored or reported by the daemon) counts as none', async () => {
  const most = { maxCalls: 10_000, maxMs: 14_400_000 };
  const h = harness({ local: { budget: most }, daemonBudget: { ...most, source: 'extension' } });
  assert.deepEqual((await h.waitFor(m => m.type === 'hello')).settings.budget, most);
  await h.until(() => h.session.connection?.budget);
  assert.deepEqual(h.session.connection.budget, { ...most, source: 'extension' });
  const over = { maxCalls: 10_001, maxMs: 14_400_000 };
  const beyond = harness({ local: { budget: over }, daemonBudget: { ...over, source: 'config' } });
  assert.equal((await beyond.waitFor(m => m.type === 'hello')).settings.budget, null);
  await beyond.until(() => beyond.session.connection?.connected);
  const reply = await beyond.send({ type: 'connect' });
  assert.equal(reply.connection.budget, null, 'an out-of-bounds budget from the daemon is not shown as in effect');
});

test('a malformed stored budget is reported as none; a budget changed in the popup is sent as a settings message', async () => {
  const h = harness({ local: { budget: { maxCalls: 0, maxMs: 'x' } }, daemonBudget: { maxCalls: 50, maxMs: 1_200_000, source: 'default' } });
  const hello = await h.waitFor(m => m.type === 'hello');
  assert.deepEqual(hello.settings, { budget: null, openRightAway: true, tabMode: 'single', approvals: ASKS });
  await h.until(() => h.session.connection?.budget?.source === 'default');
  h.local.budget = { maxCalls: 8, maxMs: 300_000 };
  h.emitStorage({ budget: { newValue: { maxCalls: 8, maxMs: 300_000 } } }, 'local');
  const settings = await h.waitFor(m => m.type === 'settings');
  assert.deepEqual(settings.settings, { budget: { maxCalls: 8, maxMs: 300_000 }, openRightAway: true, tabMode: 'single', approvals: ASKS });
  assert.ok(settings.ref !== undefined, 'a reply type: the daemon answers with the budget in effect');
  await h.until(() => h.session.connection?.budget?.source === 'extension');
  assert.deepEqual(h.session.connection.budget, { maxCalls: 8, maxMs: 300_000, source: 'extension' });
  // Cleared in the popup: the daemon falls back to its own default and says so.
  h.local.budget = null;
  h.emitStorage({ budget: { newValue: null } }, 'local');
  await h.until(() => h.sent.filter(m => m.type === 'settings').length === 2);
  assert.deepEqual(h.sent.filter(m => m.type === 'settings')[1].settings, { budget: null, openRightAway: true, tabMode: 'single', approvals: ASKS });
  await h.until(() => h.session.connection?.budget?.source === 'default');
});

test('"Open requested pages right away" is reported in the hello (off only when the user turned it off) and on change', async () => {
  const off = harness({ local: { openRightAway: false } });
  const hello = await off.waitFor(m => m.type === 'hello');
  assert.deepEqual(hello.settings, { budget: null, openRightAway: false, tabMode: 'single', approvals: ASKS });
  await off.until(() => off.session.connection?.connected);
  off.local.openRightAway = true;
  off.emitStorage({ openRightAway: { newValue: true, oldValue: false } }, 'local');
  const settings = await off.waitFor(m => m.type === 'settings');
  assert.deepEqual(settings.settings, { budget: null, openRightAway: true, tabMode: 'single', approvals: ASKS });
  // Anything but an explicit false is on (an older install that never touched the setting).
  const legacy = harness({ local: { openRightAway: 'yes' } });
  assert.deepEqual((await legacy.waitFor(m => m.type === 'hello')).settings, { budget: null, openRightAway: true, tabMode: 'single', approvals: ASKS });
});

// --- screenshot redaction -------------------------------------------------------------------------------------

const VIEW = { width: 100, height: 100, dpr: 1 };
const box = (x, label) => ({ x, y: 10, width: 20, height: 8, kind: 'openai', ...(label ? { label } : {}) });
const still = (rects, arm, extra = {}) => ({ rects, viewport: VIEW, scroll: { x: 0, y: 0 }, strict: false,
  ...(arm ? {} : { dirty: false }), ...extra });

test('redaction: boxes are asked before and after the capture and the union is filled; tags are numbered', async () => {
  const h = await started();
  // The query after the capture also boxes a holder that appeared meanwhile, with a page tag: the union keeps both.
  h.redaction = ({ arm }) => still(arm ? [box(1)] : [box(1), box(40, '[secret:~abc]')], arm);
  const id = h.command('capture', { action: null });
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id, 5000);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  // The two sets differed: taken again once, and again they differ, so the frame is withheld too.
  assert.deepEqual(h.redactionCalls.map(call => call.arm), [true, false, true, false]);
  const redact = h.annotations.at(-1).redact;
  assert.equal(redact.rects.length, 2);
  assert.equal(redact.rects[1].label, '[secret:1]', 'the tag is numbered like the text');
  assert.equal(redact.withheld, true);
  assert.equal(reply.result.screenshot.redactions, 2);
  assert.equal(reply.result.screenshot.redaction, 'withheld');
});

test('redaction: a frame that held still is not withheld; a dirty one is taken again once', async () => {
  const h = await started();
  let dirtyLeft = 1;
  h.redaction = ({ arm }) => still([box(1)], arm, arm ? {} : { dirty: dirtyLeft-- > 0 });
  const id = h.command('capture', { action: null });
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id, 5000);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.deepEqual(h.redactionCalls.map(call => call.arm), [true, false, true, false], 'one retry');
  assert.equal(h.annotations.at(-1).redact.withheld, false);
  assert.equal(reply.result.screenshot.redaction, undefined);
  assert.equal(reply.result.screenshot.redactions, 1);
});

test('redaction: a page that keeps changing is withheld; an incomplete scan too, without a retry', async () => {
  const h = await started();
  h.redaction = ({ arm }) => still([box(1)], arm, arm ? {} : { dirty: true });
  const id = h.command('capture', { action: null });
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id, 5000);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.equal(h.redactionCalls.length, 4, 'retried once, then withheld');
  assert.equal(h.annotations.at(-1).redact.withheld, true);
  assert.equal(reply.result.screenshot.redaction, 'withheld');

  h.redactionCalls.length = 0;
  h.redaction = ({ arm }) => still([], arm, { incomplete: true });
  const second = h.command('capture', { action: null });
  const incomplete = await h.waitFor(m => m.type === 'result' && m.id === second, 5000);
  assert.equal(h.redactionCalls.length, 2, 'no retry: a retry cannot complete the scan');
  assert.equal(incomplete.result.screenshot.redaction, 'withheld');
});

test('redaction fails closed: a query that throws or is malformed yields no image; a scroll between queries withholds', async () => {
  const h = await started();
  h.redaction = () => { throw new Error('boom'); };
  const id = h.command('capture', { action: null });
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(reply.error.code, 'capture_failed');
  assert.equal(h.annotations.length, 0, 'nothing was sent to be encoded');

  h.redaction = () => ({ rects: [{ x: 'a' }], viewport: VIEW });
  const bad = h.command('capture', { action: null });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === bad)).error.code, 'capture_failed');
  assert.equal(h.annotations.length, 0);

  // The page scrolled between the queries (no mutation): unstable, so withheld after one retry.
  let call = 0;
  h.redaction = ({ arm }) => ({ ...still([box(1)], arm), scroll: { x: 0, y: call++ } });
  const scrolled = h.command('capture', { action: null });
  const shot = await h.waitFor(m => m.type === 'result' && m.id === scrolled, 5000);
  assert.equal(shot.result.screenshot.redaction, 'withheld');
});

test('redaction: an execute screenshot carries the boxes; an annotation that skipped them is no image', async () => {
  const h = await started({ level: 'reversible' });
  h.redaction = ({ arm }) => still([box(5)], arm);
  const id = h.command('execute', { action: { type: 'click', target: '1' }, expectedRevision: 'doc:1', capture: true, level: 'reversible' });
  const shot = await h.waitFor(m => m.type === 'screenshot' && m.id === id, 5000);
  assert.equal(shot.error, undefined, JSON.stringify(shot.error));
  assert.equal(shot.screenshot.redactions, 1);
  assert.equal(h.annotations.at(-1).redact.rects.length, 1);
  // An offscreen document that reports fewer boxes than it was given (an older one): capture_failed.
  const original = h.chrome.runtime.sendMessage;
  h.chrome.runtime.sendMessage = async message => ({ ...(await original(message)), redactions: 0 });
  const again = h.command('capture', { action: null });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === again, 5000)).error.code, 'capture_failed');
  h.chrome.runtime.sendMessage = original;
});

// --- the Approve gate ------------------------------------------------------------------------------------------

const APPROVE_PAGE = { id: 'ext', url: 'chrome-extension://ext/approve.html?id=x' };

// Sends an approve command and returns { id, entry } once the approval window shows the request.
async function asked(h, args = {}) {
  const id = h.command('approve', { target: '1', expectedRevision: 'doc:1', cls: 'secret', waitMs: 5000, note: 'Agent line', ...args },
    { deadline: Date.now() + 30_000 });
  await h.until(() => (h.session.approvals ?? []).length > 0);
  return { id, entry: h.session.approvals.at(-1) };
}

test('approve: the window, badge and card show the request; Approve once mints a single-use id the execute must carry', async () => {
  const h = await started({ level: 'full' });
  const { id, entry } = await asked(h);
  assert.equal(entry.cls, 'secret');
  assert.equal(entry.label, 'Show', 'the label the page script read, not one the daemon sent');
  assert.equal(entry.note, 'Agent line');
  assert.equal(entry.origin, ORIGIN);
  assert.equal(entry.labelHash, undefined, 'the card never sees the hash');
  const popup = h.popupWindows.find(options => options.url.includes('approve.html?id='));
  assert.ok(popup, 'the approval window opened');
  assert.equal(popup.left, 836);
  assert.equal(popup.top, 140);
  assert.equal(h.badge, '!');
  assert.deepEqual(h.gateCalls.at(-1), { purchase: true, secret: true, level: true }, 'page.js gets the settings');
  // A web page cannot decide.
  const forged = await h.send({ type: 'approval_decision', id: entry.id, decision: 'approve' }, { id: 'ext', url: 'https://example.com/' });
  assert.ok(forged.error, 'a decision from a page is refused');
  const decided = await h.send({ type: 'approval_decision', id: entry.id, decision: 'approve' }, APPROVE_PAGE);
  assert.equal(decided.error, undefined, JSON.stringify(decided));
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(reply.result.decision, 'approved');
  const approvalId = reply.result.approvalId;
  assert.match(approvalId, /^[0-9a-f-]{36}$/);
  await h.until(() => (h.session.approvals ?? []).length === 0);

  const run = h.command('execute', { action: { type: 'click', target: '1', approvalId }, expectedRevision: 'doc:1', level: 'full' });
  const ran = await h.waitFor(m => m.type === 'result' && m.id === run);
  assert.equal(ran.error, undefined, JSON.stringify(ran.error));
  const call = h.pageArgs.filter(c => c.method === 'execute').at(-1);
  assert.deepEqual(call.approval, { target: '1', cls: 'secret', labelHash: 'h-show' });
  assert.equal(call.args[0].approvalId, undefined, 'the id itself never reaches the page');
  // Single use: the same id again is refused before anything reaches the page.
  const executes = h.pageArgs.filter(c => c.method === 'execute').length;
  const again = h.command('execute', { action: { type: 'click', target: '1', approvalId }, expectedRevision: 'doc:2', level: 'full' });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === again)).error.code, 'blocked_risky');
  assert.equal(h.pageArgs.filter(c => c.method === 'execute').length, executes);
});

test('approve: a supported toolbar popup keeps the same one-click approval without a standalone window', async () => {
  const h = await started({ level: 'full', actionOpenPopup: 'ok' });
  const { id, entry } = await asked(h);
  await h.until(() => h.actionPopupCalls.length === 1);
  assert.equal(h.popupWindows.some(options => options.url.includes('approve.html?id=')), false);
  const decided = await h.send({ type: 'approval_decision', id: entry.id, decision: 'approve' }, APPROVE_PAGE);
  assert.equal(decided.error, undefined, JSON.stringify(decided));
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(reply.result.decision, 'approved');
  assert.match(reply.result.approvalId, /^[0-9a-f-]{36}$/);
});

test('upload: worker dispatch accepts a bound once-only approval and rejects forged, malformed and mismatched files', async () => {
  const h = await started({ level: 'full' });
  h.approvalInfo = (target, revision) => ({ revision, documentId: 'doc', target, label: 'Resume PDF',
    labelHash: 'h-resume', cls: 'submit' });
  const file = { name: 'resume.pdf', size: 3, type: 'application/pdf', data: Buffer.from('PDF').toString('base64') };
  const executeUpload = action => {
    const id = h.command('execute', { action, expectedRevision: 'doc:1', level: 'full' });
    return h.waitFor(message => message.type === 'result' && message.id === id);
  };
  const bare = await executeUpload({ type: 'upload', target: '1', file });
  assert.equal(bare.error.code, 'unsupported');
  const forged = await executeUpload({ type: 'upload', target: '1', file, approvalId: '0'.repeat(36) });
  assert.equal(forged.error.code, 'blocked_risky');
  const { id, entry } = await asked(h, { cls: 'submit', kind: 'upload', file: { name: file.name, size: file.size } });
  await h.send({ type: 'approval_decision', id: entry.id, decision: 'approve' }, APPROVE_PAGE);
  const approvalId = (await h.waitFor(message => message.type === 'result' && message.id === id)).result.approvalId;
  const malformed = await executeUpload({ type: 'upload', target: '1', file: { name: file.name, size: file.size }, approvalId });
  assert.equal(malformed.error.code, 'unsupported');
  assert.equal(h.pageArgs.filter(call => call.method === 'execute').length, 0);
  const ran = await executeUpload({ type: 'upload', target: '1', file, approvalId });
  assert.equal(ran.error, undefined, JSON.stringify(ran.error));
  const dispatch = h.pageArgs.filter(call => call.method === 'execute').at(-1);
  assert.equal(dispatch.args[0].type, 'upload');
  assert.deepEqual(dispatch.args[0].file, file);
  assert.equal(dispatch.args[0].approvalId, undefined);
  assert.deepEqual(dispatch.approval, { target: '1', cls: 'submit', labelHash: 'h-resume', kind: 'upload' });
  const replay = h.command('execute', { action: { type: 'upload', target: '1', file, approvalId }, expectedRevision: 'doc:2', level: 'full' });
  assert.equal((await h.waitFor(message => message.type === 'result' && message.id === replay)).error.code, 'blocked_risky');
  assert.equal(h.pageArgs.filter(call => call.method === 'execute').length, 1);

  const changed = await started({ level: 'full' });
  changed.approvalInfo = (target, revision) => ({ revision, documentId: 'doc', target,
    label: 'Resume PDF', labelHash: 'h-resume', cls: 'submit' });
  const next = await asked(changed, { cls: 'submit', kind: 'upload', file: { name: file.name, size: file.size } });
  await changed.send({ type: 'approval_decision', id: next.entry.id, decision: 'approve' }, APPROVE_PAGE);
  const bound = (await changed.waitFor(message => message.type === 'result' && message.id === next.id)).result.approvalId;
  const mismatch = changed.command('execute', { action: { type: 'upload', target: '1', file: { ...file, name: 'other.pdf' }, approvalId: bound },
    expectedRevision: 'doc:1', level: 'full' });
  assert.equal((await changed.waitFor(message => message.type === 'result' && message.id === mismatch)).error.code, 'blocked_risky');
  assert.equal(changed.pageArgs.filter(call => call.method === 'execute').length, 0);
});

test('approve: a daemon-supplied (forged) approvalId and an id for another target are refused; a new revision voids one', async () => {
  const h = await started({ level: 'full' });
  const forged = h.command('execute', { action: { type: 'click', target: '1', approvalId: '00000000-0000-4000-8000-000000000000' },
    expectedRevision: 'doc:1', level: 'full' });
  const refused = await h.waitFor(m => m.type === 'result' && m.id === forged);
  assert.equal(refused.error.code, 'blocked_risky');
  assert.equal(h.pageArgs.filter(c => c.method === 'execute').length, 0, 'nothing reached the page');
  // Approved for target 1 on doc:1; used for target 2: refused (and spent).
  let { id, entry } = await asked(h);
  await h.send({ type: 'approval_decision', id: entry.id, decision: 'approve' }, APPROVE_PAGE);
  let approvalId = (await h.waitFor(m => m.type === 'result' && m.id === id)).result.approvalId;
  const other = h.command('execute', { action: { type: 'click', target: '2', approvalId }, expectedRevision: 'doc:1', level: 'full' });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === other)).error.code, 'blocked_risky');
  // Approved on doc:1, the page moves to doc:2 before the execute: stale, nothing runs.
  ({ id, entry } = await asked(h));
  await h.send({ type: 'approval_decision', id: entry.id, decision: 'approve' }, APPROVE_PAGE);
  approvalId = (await h.waitFor(m => m.type === 'result' && m.id === id)).result.approvalId;
  h.bumpRevision();
  const moved = h.command('execute', { action: { type: 'click', target: '1', approvalId }, expectedRevision: 'doc:2', level: 'full' });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === moved)).error.code, 'stale');
  assert.equal(h.pageArgs.filter(c => c.method === 'execute').length, 0);
  // An approvalId on anything but a click on a target is malformed.
  const point = h.command('execute', { action: { type: 'click', point: { x: 1, y: 1 }, approvalId }, expectedRevision: 'doc:2', level: 'full' });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === point)).error.code, 'unsupported');
});

test('approve: Deny answers denied; no click within the wait answers pending and the request keeps waiting', async () => {
  const h = await started({ level: 'full' });
  let { id, entry } = await asked(h);
  await h.send({ type: 'approval_decision', id: entry.id, decision: 'deny' }, APPROVE_PAGE);
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === id)).result.decision, 'denied');
  // The same control asked again while the denial stands: denied at once.
  const repeat = h.command('approve', { target: '1', expectedRevision: 'doc:1', cls: 'secret', waitMs: 5000 });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === repeat)).result.decision, 'denied');
  h.bumpRevision();
  ({ id, entry } = await asked(h, { expectedRevision: 'doc:2', waitMs: 50 }));
  const waited = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(waited.result.decision, 'pending');
  assert.ok(waited.result.expiresAt > Date.now() + 60_000, 'it waits five minutes');
  assert.equal(h.session.approvals.length, 1, 'still on the card');
  // Approved later: the next ask (the agent's act again) gets the id at once.
  await h.send({ type: 'approval_decision', id: entry.id, decision: 'approve' }, APPROVE_PAGE);
  const later = h.command('approve', { target: '1', expectedRevision: 'doc:2', cls: 'secret', waitMs: 5000 });
  const answer = (await h.waitFor(m => m.type === 'result' && m.id === later)).result;
  assert.equal(answer.decision, 'approved');
  assert.match(answer.approvalId, /^[0-9a-f-]{36}$/);
});

test('approve: never at read-only, purchases only from full, off when the user turned the setting off, class from the page', async () => {
  const readOnly = await started();
  const ro = readOnly.command('approve', { target: '1', expectedRevision: 'doc:1', cls: 'secret', waitMs: 10 });
  assert.deepEqual((await readOnly.waitFor(m => m.type === 'result' && m.id === ro)).result, { decision: 'refused', reason: 'read_only' });
  const h = await started({ level: 'reversible' });
  const buy = h.command('approve', { target: '1', expectedRevision: 'doc:1', cls: 'purchase', waitMs: 10 });
  assert.deepEqual((await h.waitFor(m => m.type === 'result' && m.id === buy)).result, { decision: 'refused', reason: 'level' });
  // The page script sees another class than the daemon asked about: refused, no window.
  const windows = h.popupWindows.length;
  const mismatch = h.command('approve', { target: '1', expectedRevision: 'doc:1', cls: 'delete', waitMs: 10 });
  assert.deepEqual((await h.waitFor(m => m.type === 'result' && m.id === mismatch)).result, { decision: 'refused', reason: 'class_mismatch' });
  assert.equal(h.popupWindows.length, windows);
  h.local.approvals = { secret: false };
  h.emitStorage({ approvals: { newValue: { secret: false } } }, 'local');
  const off = h.command('approve', { target: '1', expectedRevision: 'doc:1', cls: 'secret', waitMs: 10 });
  assert.deepEqual((await h.waitFor(m => m.type === 'result' && m.id === off)).result, { decision: 'off' });
  const bad = h.command('approve', { target: '1', expectedRevision: 'doc:1', cls: 'everything', waitMs: 10 });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === bad)).error.code, 'unsupported');
});

// --- secret handles --------------------------------------------------------------------------------------------

const FAKE_KEY = ['sk-proj-', 'FAKEvault0123456789', 'abcdefABCDEF0123456789'].join('');
const VAULTED = [{ tag: 'abc123', value: FAKE_KEY, kind: 'openai', pre: 'sk-proj-', origin: ORIGIN }];

// A session whose page showed FAKE_KEY: observed once, so the vault holds it as secret:1.
async function vaulted(options = {}) {
  const h = await started({ level: 'reversible', ...options });
  h.observationText = 'Your key [secret:~abc123 openai sk-proj-…6789 len 49]';
  h.pageVault = VAULTED;
  const id = h.command('observe', {});
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id);
  return { h, observation: reply.result };
}

test('secret handles: page.js values go into the vault; observations list handles and placeholders, never a value', async () => {
  const { h, observation } = await vaulted();
  assert.equal(h.secretCalls.at(-1).vault, true, 'the worker asks page.js for the values');
  assert.match(observation.text, /\[secret:1 openai/);
  assert.deepEqual(observation.secrets, [{ handle: '1', kind: 'openai', origin: ORIGIN, label: '[secret:1 openai sk-proj-…6789 len 49]' }]);
  assert.equal(JSON.stringify(h.sent).includes(FAKE_KEY), false, 'nothing sent to the daemon carries the value');
  assert.equal(JSON.stringify(h.sent).includes('__faiVault'), false);
});

test('fill_secret: asked every time (credential asks off too), the card shows handle and origins; the value reaches page.js only', async () => {
  const { h, observation } = await vaulted();
  h.local.approvals = { secret: false };
  h.emitStorage({ approvals: { newValue: { secret: false } } }, 'local');
  h.approvalInfo = (target, revision) => ({ revision, documentId: 'doc', target, label: 'API key', labelHash: 'h-api', cls: 'secret',
    origin: ORIGIN });
  const asked = h.command('approve', { target: '1', expectedRevision: observation.revision, cls: 'secret', kind: 'fill_secret',
    handle: '1', waitMs: 5000 });
  await h.until(() => (h.session.approvals ?? []).length > 0);
  const entry = h.session.approvals.at(-1);
  assert.equal(entry.kind, 'fill_secret');
  assert.equal(entry.handle, '1');
  assert.deepEqual(entry.secret, { label: '[secret:1 openai sk-proj-…6789 len 49]', kind: 'openai', from: ORIGIN });
  assert.equal(JSON.stringify(h.session).includes(FAKE_KEY), false, 'the card never holds the value');
  assert.equal(h.pageArgs.filter(c => c.method === 'approvalInfo').at(-1).args[2], 'fill_secret', 'page.js checks the field');
  await h.send({ type: 'approval_decision', id: entry.id, decision: 'approve' }, APPROVE_PAGE);
  const approvalId = (await h.waitFor(m => m.type === 'result' && m.id === asked)).result.approvalId;
  // An approval for handle 1 used for handle 2, a fill without one, or a raw value from the daemon: refused.
  const other = h.command('execute', { action: { type: 'fill_secret', target: '1', handle: '2', approvalId: 'x'.repeat(36) },
    expectedRevision: observation.revision, level: 'reversible' });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === other)).error.code, 'blocked_risky');
  const bare = h.command('execute', { action: { type: 'fill_secret', target: '1', handle: '1' }, expectedRevision: observation.revision });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === bare)).error.code, 'unsupported');
  const raw = h.command('execute', { action: { type: 'fill_secret', target: '1', handle: '1', text: 'x', approvalId },
    expectedRevision: observation.revision });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === raw)).error.code, 'unsupported');
  assert.equal(h.pageArgs.filter(c => c.method === 'execute').length, 0);
  h.pageExecute = () => ({ fromUrl: `${ORIGIN}/`, target: { id: '1', role: 'textbox', label: 'API key' }, settle: { reason: 'quiet', ms: 1 },
    fill: { kept: true, empty: false }, observation: { revision: 'doc:9', documentId: 'doc', url: `${ORIGIN}/`,
      title: 'Fixture', text: 'Saved', controls: [], blocks: [], viewport: { width: 100, height: 100, dpr: 1 } } });
  const run = h.command('execute', { action: { type: 'fill_secret', target: '1', handle: '1', approvalId },
    expectedRevision: observation.revision, level: 'reversible' });
  const ran = await h.waitFor(m => m.type === 'result' && m.id === run);
  assert.equal(ran.error, undefined, JSON.stringify(ran.error));
  const call = h.pageArgs.filter(c => c.method === 'execute').at(-1);
  assert.deepEqual(call.args[0], { type: 'fill_secret', target: '1', text: FAKE_KEY }, 'page.js gets the value, no handle, no id');
  assert.deepEqual(call.approval, { target: '1', cls: 'secret', labelHash: 'h-api', kind: 'fill_secret' });
  assert.deepEqual(ran.result.fill, { kept: true, empty: false, holds: '[secret:1]' });
  assert.equal(JSON.stringify(h.sent).includes(FAKE_KEY), false, 'the daemon never sees the value');
});

test('copy_secret: approved, the offscreen document writes the clipboard; Deny writes nothing', async () => {
  const { h, observation } = await vaulted();
  const denied = h.command('approve', { expectedRevision: observation.revision, cls: 'secret', kind: 'copy_secret', handle: '1', waitMs: 5000 });
  await h.until(() => (h.session.approvals ?? []).length > 0);
  await h.send({ type: 'approval_decision', id: h.session.approvals.at(-1).id, decision: 'deny' }, APPROVE_PAGE);
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === denied)).result.decision, 'denied');
  assert.deepEqual(h.clipboard, []);
  h.bumpRevision();
  const asked = h.command('approve', { expectedRevision: 'doc:2', cls: 'secret', kind: 'copy_secret', handle: '1', waitMs: 5000 });
  await h.until(() => (h.session.approvals ?? []).some(entry => entry.kind === 'copy_secret'));
  const entry = h.session.approvals.at(-1);
  assert.equal(entry.label, '');
  await h.send({ type: 'approval_decision', id: entry.id, decision: 'approve' }, APPROVE_PAGE);
  const approvalId = (await h.waitFor(m => m.type === 'result' && m.id === asked)).result.approvalId;
  const run = h.command('execute', { action: { type: 'copy_secret', handle: '1', approvalId }, expectedRevision: 'doc:2', level: 'reversible' });
  const ran = await h.waitFor(m => m.type === 'result' && m.id === run);
  assert.equal(ran.error, undefined, JSON.stringify(ran.error));
  assert.deepEqual(h.clipboard, [FAKE_KEY]);
  assert.equal(JSON.stringify(h.sent).includes(FAKE_KEY), false);
});

test('secret handles: the vault is cleared when the lease ends; a handle it no longer holds is refused', async () => {
  const { h } = await vaulted();
  h.push({ type: 'lease_update', leaseId: LEASE_ID, state: 'released', reason: 'released' });
  await h.until(() => h.local.status === 'stopped');
  h.pageVault = null;
  const reply = await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, level: 'reversible' });
  assert.equal(reply.status, 'active');
  const id = h.command('observe', {});
  const observation = (await h.waitFor(m => m.type === 'result' && m.id === id)).result;
  assert.equal(observation.secrets, undefined, 'no handles after the lease ended');
  const asked = h.command('approve', { expectedRevision: observation.revision, cls: 'secret', kind: 'copy_secret', handle: '1', waitMs: 10 });
  assert.deepEqual((await h.waitFor(m => m.type === 'result' && m.id === asked)).result, { decision: 'refused', reason: 'unknown_secret' });
});

test('secret handles survive the superseded notification before a new approved lease reply', async () => {
  const { h } = await vaulted();
  h.push({ type: 'lease_update', leaseId: LEASE_ID, state: 'released', reason: 'superseded' });
  await h.until(() => h.local.status === 'stopped');
  const stopped = h.command('observe');
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === stopped)).error.code, 'stopped');
  h.pageVault = null;
  const reply = await h.send({ type: 'start', requestId: 'req_2', endpoint: ENDPOINT, secret: SECRET, level: 'reversible' });
  assert.equal(reply.status, 'active');
  const id = h.command('observe');
  const observation = (await h.waitFor(m => m.type === 'result' && m.id === id)).result;
  assert.deepEqual(observation.secrets.map(s => s.handle), ['1']);
  assert.equal(JSON.stringify(h.sent).includes(FAKE_KEY), false);
  h.push({ type: 'lease_update', leaseId: LEASE_ID, state: 'released', reason: 'released' });
  await h.until(() => h.local.status === 'stopped');
  await h.send({ type: 'start', requestId: 'req_3', endpoint: ENDPOINT, secret: SECRET, level: 'reversible' });
  const afterRelease = h.command('observe');
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === afterRelease)).result.secrets, undefined);
});

test('offscreen clipboard_write: a textarea selected, copied, emptied and removed; other senders are ignored', async () => {
  const offscreen = await readFile(new URL('../extension/offscreen.js', import.meta.url), 'utf8');
  let listener = null;
  const events = [];
  const body = { children: [], append(node) { this.children.push(node); events.push('append'); } };
  const document = {
    body,
    createElement: tag => ({ tag, value: '', select() { events.push(`select:${this.value}`); },
      remove() { body.children = body.children.filter(node => node !== this); events.push(`remove:${this.value}`); } }),
    execCommand: command => { events.push(`exec:${command}`); return true; },
  };
  const context = vm.createContext({ document, chrome: { runtime: { id: 'ext', onMessage: { addListener: fn => { listener = fn; } } } } });
  vm.runInContext(offscreen, context);
  const answer = (message, sender) => new Promise(resolve => {
    const kept = listener(message, sender, resolve);
    if (kept !== true) setTimeout(() => resolve(undefined), 10);
  });
  assert.deepEqual(clone(await answer({ type: 'clipboard_write', text: FAKE_KEY }, { id: 'ext' })), { ok: true });
  assert.deepEqual(events, ['append', `select:${FAKE_KEY}`, 'exec:copy', 'remove:'], 'emptied before removal');
  assert.equal(body.children.length, 0);
  events.length = 0;
  assert.equal(await answer({ type: 'clipboard_write', text: FAKE_KEY }, { id: 'other' }), undefined);
  assert.deepEqual(events, []);
});

// The request modal grants optional host access in its own click, then names the original armed task tab.
const MODAL_SENDER = { id: 'ext', url: 'chrome-extension://ext/arm.html?tab=9' };
async function modalPrepared(options) {
  const h = await openedRightAway(options);
  const arm = h.session.armedTabs[0];
  const message = { tabId: 9, requestId: arm.requestId, at: arm.at };
  const prepared = await h.send({ type: 'arm_prepare', ...message }, MODAL_SENDER);
  assert.ok(prepared.approval, JSON.stringify(prepared));
  return { h, message: { ...message, ...prepared.approval, type: 'arm_approve', level: arm.level, granted: true } };
}

test('modal approval binds the armed task tab and chosen level, then releases newly obtained host access on stop', async () => {
  const { h, message } = await modalPrepared();
  assert.equal(message.pattern, `${SHOP}/*`);
  h.grant(message.pattern);
  const reply = await h.send({ ...message, level: 'read-only' }, MODAL_SENDER);
  assert.equal(reply.status, 'active', JSON.stringify(reply));
  assert.equal(reply.session.tabId, 9, 'never adopts the modal or current personal tab');
  assert.equal(reply.session.level, 'read-only');
  assert.equal(reply.session.tabMode, 'single');
  assert.ok(h.grants.has(message.pattern));
  await h.send({ type: 'stop' });
  await h.until(() => !h.grants.has(message.pattern));
});

test('modal denial, missing access, wrong sender, stale token, offsite and excessive levels never lease', async () => {
  for (const kind of ['denied', 'missing', 'sender', 'token', 'offsite', 'pending-url', 'level', 'cancel']) {
    const { h, message } = await modalPrepared();
    if (kind !== 'missing') h.grant(message.pattern);
    let sender = MODAL_SENDER;
    if (kind === 'denied') message.granted = false;
    if (kind === 'sender') sender = { id: 'ext', url: 'https://example.com/arm.html?tab=9' };
    if (kind === 'token') message.token = 'stale';
    if (kind === 'offsite') h.openedTabs.get(9).url = 'https://unrequested.test/';
    if (kind === 'pending-url') h.openedTabs.get(9).pendingUrl = 'https://unrequested.test/';
    if (kind === 'level') message.level = 'full';
    if (kind === 'cancel') await h.send({ type: 'deny', requestId: message.requestId });
    const reply = await h.send(message, sender);
    assert.ok(reply.error, `${kind}: ${JSON.stringify(reply)}`);
    assert.equal(h.sent.some(m => m.type === 'lease'), false, kind);
    if (!['sender', 'token'].includes(kind)) assert.equal(h.grants.has(message.pattern), false, kind);
  }
});

test('modal approval preserves host access already granted by the user', async () => {
  const h = await openedRightAway();
  h.grant(`${SHOP}/*`);
  const arm = h.session.armedTabs[0];
  const base = { tabId: 9, requestId: arm.requestId, at: arm.at };
  const { approval } = await h.send({ type: 'arm_prepare', ...base }, MODAL_SENDER);
  const reply = await h.send({ type: 'arm_approve', ...base, ...approval, level: arm.level, granted: true }, MODAL_SENDER);
  assert.equal(reply.status, 'active');
  await h.send({ type: 'stop' });
  await sleep(20);
  assert.equal(h.grants.has(`${SHOP}/*`), true);
  assert.equal(h.removed.includes(`${SHOP}/*`), false);
});

test('modal double click leases once and handles its own active request snapshot before the lease reply', async () => {
  const { h, message } = await modalPrepared();
  h.grant(message.pattern);
  const original = h.socket.send.bind(h.socket);
  h.socket.send = text => {
    if (JSON.parse(text).type === 'lease') h.push({ type: 'requests', requests: [pendingRequest('req_1', { mode: 'reversible', state: 'active' })] });
    original(text);
  };
  const first = h.send(message, MODAL_SENDER);
  const second = h.send(message, MODAL_SENDER);
  const replies = await Promise.all([first, second]);
  assert.equal(replies.filter(reply => reply.status === 'active').length, 1, JSON.stringify(replies));
  assert.equal(h.sent.filter(m => m.type === 'lease').length, 1);
});

test('canceling an unclicked modal preserves later manual grants; canceling an in-flight prompt reclaims its late grant', async () => {
  for (const clicked of [false, true]) {
    const { h, message } = await modalPrepared();
    if (clicked) await h.send({ type: 'arm_begin', tabId: 9, token: message.token }, MODAL_SENDER);
    await h.send({ type: 'deny', requestId: message.requestId });
    await sleep(10);
    h.grant(message.pattern);
    await sleep(20);
    assert.equal(h.grants.has(message.pattern), !clicked, `clicked=${clicked}`);
    assert.equal(h.sent.some(m => m.type === 'lease'), false);
  }
});

test('modal approval preserves multiple-tab consent and refuses a setting revoked while browser permission was open', async () => {
  for (const revoked of [false, true]) {
    const { h, message } = await modalPrepared({ local: { tabMode: 'multiple' } });
    h.grant(message.pattern);
    if (revoked) await h.chrome.storage.local.set({ tabMode: 'single' });
    const reply = await h.send(message, MODAL_SENDER);
    if (revoked) {
      assert.match(reply.error, /Multiple task tabs/);
      assert.equal(h.sent.some(m => m.type === 'lease'), false);
    } else {
      assert.equal(reply.session.tabMode, 'multiple');
      assert.equal(h.sent.find(m => m.type === 'lease').tabMode, 'multiple');
    }
  }
});

test('modal approval stops a returned lease if the user cancels while the lease request is in flight', async () => {
  const { h, message } = await modalPrepared();
  h.grant(message.pattern);
  const original = h.socket.send.bind(h.socket);
  h.socket.send = text => {
    if (JSON.parse(text).type === 'lease') h.push({ type: 'requests', requests: [pendingRequest('req_1', { state: 'denied' })] });
    original(text);
  };
  const reply = await h.send(message, MODAL_SENDER);
  assert.ok(reply.error);
  assert.ok(h.sent.some(m => m.type === 'status' && m.status === 'stopped'));
  assert.equal(h.grants.has(message.pattern), false);
});

test('modal Testing approval rechecks the listed test sites after the native permission prompt', async () => {
  for (const revoked of [false, true]) {
    const h = harness({ hostGrants: [], leaseOrigins: [SHOP], permissions: { testingOrigins: [SHOP] } });
    await h.waitFor(m => m.type === 'hello');
    await withPending(h, [pendingRequest('req_1', { mode: 'testing' })]);
    await h.send({ type: 'open', requestId: 'req_1', level: 'testing' });
    const arm = h.session.armedTabs[0];
    const base = { tabId: 9, requestId: arm.requestId, at: arm.at };
    const prepared = await h.send({ type: 'arm_prepare', ...base }, MODAL_SENDER);
    h.grant(prepared.approval.pattern);
    if (revoked) await h.chrome.storage.local.set({ permissions: { testingOrigins: [] } });
    const reply = await h.send({ type: 'arm_approve', ...base, ...prepared.approval, level: 'testing', granted: true }, MODAL_SENDER);
    if (revoked) {
      assert.match(reply.error, /Testing mode needs/);
      assert.equal(h.sent.some(m => m.type === 'lease'), false);
    } else assert.equal(reply.session.level, 'testing');
  }
});


test('modal re-reads the bound tab after awaiting browser permissions', async () => {
  const { h, message } = await modalPrepared();
  h.grant(message.pattern);
  const contains = h.chrome.permissions.contains;
  h.chrome.permissions.contains = async value => {
    h.openedTabs.get(9).url = 'https://elsewhere.test/';
    return contains(value);
  };
  const reply = await h.send(message, MODAL_SENDER);
  assert.match(reply.error, /page changed/);
  assert.equal(h.sent.some(m => m.type === 'lease'), false);
});

test('modal approval clicked before the opened page committed waits for it on the approved origin, then leases (one click)', async () => {
  const { h, message } = await modalPrepared();
  h.grant(message.pattern);
  // Chrome before the first commit of a new tab: no committed url yet, the page in pendingUrl, loading.
  Object.assign(h.openedTabs.get(9), { url: '', pendingUrl: `${SHOP}/cart`, status: 'loading' });
  const reply = h.send(message, MODAL_SENDER);
  await sleep(150);
  assert.equal(h.sent.some(m => m.type === 'lease'), false, 'nothing is leased before the page commits');
  Object.assign(h.openedTabs.get(9), { url: `${SHOP}/cart`, pendingUrl: undefined, status: 'complete' });
  const answer = await reply;
  assert.equal(answer.status, 'active', JSON.stringify(answer));
  assert.equal(answer.session.tabId, 9);
  assert.equal(h.sent.filter(m => m.type === 'lease').length, 1);
});

test('modal approval prepared before page loads, a re-arm and a requests update still approves with one click', async () => {
  const { h, message } = await modalPrepared();
  h.grant(message.pattern);
  // The page finishes loading (several times on some sites): showArm re-applies the arm's look.
  for (let i = 0; i < 3; i++) h.chrome.tabs.onUpdated.emit(9, { status: 'complete' });
  // Another agent's request arrives; this one is unchanged.
  h.push({ type: 'requests', requests: [pendingRequest('req_1', { mode: 'reversible', client: 'Codex' }), pendingRequest('req_other')] });
  await sleep(30);
  assert.equal(h.session.armedTabs.find(arm => arm.tabId === 9).at, message.at, 'the arm keeps its time');
  const reply = await h.send(message, MODAL_SENDER);
  assert.equal(reply.status, 'active', JSON.stringify(reply));
});

test('modal approval during a redirect that lands off the approved origin still refuses', async () => {
  const { h, message } = await modalPrepared();
  h.grant(message.pattern);
  Object.assign(h.openedTabs.get(9), { url: '', pendingUrl: `${SHOP}/cart`, status: 'loading' });
  const reply = h.send(message, MODAL_SENDER);
  await sleep(100);
  Object.assign(h.openedTabs.get(9), { url: 'https://unrequested.test/', pendingUrl: undefined, status: 'complete' });
  assert.match((await reply).error, /page changed/);
  assert.equal(h.sent.some(m => m.type === 'lease'), false);
});

// The modal's early click: Chrome's grant can land before arm_prepare, or with no approval at all. arm_track (the
// patterns the modal saw newly granted) is what keeps them tracked and removed again.
test('modal early grant before arm_prepare is tracked (arm_track) and removed after the session', async () => {
  const h = await openedRightAway();
  const arm = h.session.armedTabs[0];
  const base = { tabId: 9, requestId: arm.requestId, at: arm.at };
  h.grant(`${SHOP}/*`);
  const tracked = await h.send({ type: 'arm_track', ...base, patterns: [`${SHOP}/*`] }, MODAL_SENDER);
  assert.deepEqual(tracked.tracked, [`${SHOP}/*`]);
  const prepared = await h.send({ type: 'arm_prepare', ...base }, MODAL_SENDER);
  await h.send({ type: 'arm_begin', tabId: 9, token: prepared.approval.token }, MODAL_SENDER);
  const reply = await h.send({ ...base, ...prepared.approval, type: 'arm_approve', level: arm.level, granted: true }, MODAL_SENDER);
  assert.equal(reply.status, 'active', JSON.stringify(reply));
  assert.ok(h.grants.has(`${SHOP}/*`), 'the session keeps it while it runs');
  await h.send({ type: 'stop' });
  await h.until(() => !h.grants.has(`${SHOP}/*`));
});

test('modal early grant whose approval never happens (prepare refused, arm ended) is removed', async () => {
  for (const order of ['track-then-deny', 'deny-then-track']) {
    const h = await openedRightAway();
    const arm = h.session.armedTabs[0];
    const base = { tabId: 9, requestId: arm.requestId, at: arm.at };
    h.grant(`${SHOP}/*`);
    // The request ended (denied elsewhere) while Chrome's prompt was open: prepare is refused.
    if (order === 'track-then-deny') await h.send({ type: 'arm_track', ...base, patterns: [`${SHOP}/*`] }, MODAL_SENDER);
    await h.send({ type: 'deny', requestId: arm.requestId });
    h.push({ type: 'requests', requests: [] });
    await h.until(() => (h.session.armedTabs ?? []).length === 0);
    assert.ok((await h.send({ type: 'arm_prepare', ...base }, MODAL_SENDER)).error, order);
    if (order === 'deny-then-track') {
      const tracked = await h.send({ type: 'arm_track', ...base, patterns: [`${SHOP}/*`] }, MODAL_SENDER);
      assert.deepEqual(tracked.tracked, [`${SHOP}/*`], 'an arm that just ended is still known');
    }
    await h.until(() => !h.grants.has(`${SHOP}/*`));
  }
});

test('arm_track accepts only the request\'s own patterns and the window of that arm, never a user\'s other grants', async () => {
  // The page opened on app.example.org, under the requested root *.example.org: of the root's hosts, only that one.
  const h = await openedRightAway({ request: { origins: ['https://login.example.com', 'https://*.example.org'],
    url: 'https://app.example.org/cart' } });
  const arm = h.session.armedTabs[0];
  const base = { tabId: 9, requestId: arm.requestId, at: arm.at };
  const all = ['https://evil.test/*', 'https://login.example.com/*', 'https://app.example.org/*', 'https://other.example.org/*',
    'https://*.example.org/*'];
  for (const pattern of all) h.grant(pattern);
  const tracked = await h.send({ type: 'arm_track', ...base, patterns: [...all, '<all_urls>'] }, MODAL_SENDER);
  assert.deepEqual(tracked.tracked, ['https://login.example.com/*', 'https://app.example.org/*']);
  assert.ok((await h.send({ type: 'arm_track', ...base, at: arm.at + 1, patterns: ['https://login.example.com/*'] }, MODAL_SENDER)).error,
    'another arm');
  assert.ok((await h.send({ type: 'arm_track', ...base, patterns: [] }, { id: 'ext', url: 'chrome-extension://ext/popup.html' })).error,
    'only the request window');
  await h.send({ type: 'deny', requestId: arm.requestId });
  h.push({ type: 'requests', requests: [] });
  await h.until(() => !h.grants.has('https://login.example.com/*') && !h.grants.has('https://app.example.org/*'));
  assert.ok(['https://evil.test/*', 'https://other.example.org/*', 'https://*.example.org/*'].every(pattern => h.grants.has(pattern)),
    'grants outside what the window asked for stay');
});

test('modal approval while the page never commits says it is still loading', async () => {
  const { h, message } = await modalPrepared({ timeScale: 0.002 });
  h.grant(message.pattern);
  Object.assign(h.openedTabs.get(9), { url: '', pendingUrl: `${SHOP}/cart`, status: 'loading' });
  const answer = await h.send(message, MODAL_SENDER);
  assert.equal(answer.error, 'The page is still loading. Approve again once it has loaded.');
  assert.equal(h.sent.some(m => m.type === 'lease'), false);
});

test('modal approval after the page moved: on the requested site, or to a host the access does not cover, says so', async () => {
  const { h, message } = await modalPrepared({ request: { origins: ['https://*.example.com'], url: `${SHOP}/cart` } });
  h.grant(message.pattern);
  // Readable (the browser holds access there too) and on a requested root: "on the site".
  h.openedTabs.get(9).url = 'https://www.example.com/cart';
  assert.match((await h.send(message, MODAL_SENDER)).error, /moved to another address on the site the agent asked for/);
  // Unreadable (no access to the new host): "an address this approval does not cover".
  const again = await modalPrepared();
  again.h.grant(again.message.pattern);
  again.h.openedTabs.get(9).url = undefined;
  assert.match((await again.h.send(again.message, MODAL_SENDER)).error, /moved to an address this approval does not cover/);
  assert.equal(h.sent.some(m => m.type === 'lease') || again.h.sent.some(m => m.type === 'lease'), false);
});

test('modal approval with a token the worker does not know (it restarted after preparing) answers stale_approval', async () => {
  const { h, message } = await modalPrepared();
  h.grant(message.pattern);
  const reply = await h.send({ ...message, token: 'from-an-earlier-worker' }, MODAL_SENDER);
  assert.equal(reply.code, 'stale_approval');
  assert.equal(h.sent.some(m => m.type === 'lease'), false);
  // Prepared again, the same click's access approves.
  const fresh = await h.send({ type: 'arm_prepare', tabId: 9, requestId: message.requestId, at: message.at }, MODAL_SENDER);
  assert.equal((await h.send({ ...message, ...fresh.approval }, MODAL_SENDER)).status, 'active');
});

// --- several browsers (issue #9) ---------------------------------------------------------------------------------------

test('the browser id is created once and kept: a restarted worker reconnects as the same browser', async () => {
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  const id = h.local.browserId;
  const restarted = harness({ local: { browserId: id } });
  const hello = await restarted.waitFor(m => m.type === 'hello');
  assert.equal(restarted.local.browserId, id);
  assert.equal(restarted.socket.url, `ws://127.0.0.1:4318/ext/ws?browser=${id}`);
  assert.equal(hello.browser.product, 'chromium');
  // The Firefox build (gecko settings in its manifest) reports itself as Firefox.
  const firefox = harness({ manifest: { browser_specific_settings: { gecko: { id: 'fai-browser@jedbjorn.github.io' } } } });
  assert.equal((await firefox.waitFor(m => m.type === 'hello')).browser.product, 'firefox');
});

test('a 4003 close (this browser\'s newer connection took over) is never answered with a reconnect', async () => {
  const h = harness({ timeScale: 0.01 });
  await h.waitFor(m => m.type === 'hello');
  await h.until(() => h.session.connection?.connected);
  h.socket.serverClose(4003);
  await h.until(() => h.session.connection?.conflict === 'superseded');
  await sleep(200);
  assert.equal(h.sockets.length, 1, 'no reconnect');
  assert.equal(h.session.connection.connected, false);
  assert.match(h.local.status, /Another copy of this browser profile took the FAI connection/);
  // The alarm leaves it alone for a while too.
  h.alarmFire();
  await sleep(30);
  assert.equal(h.sockets.length, 1);
  // Opening the popup is the user's action: it connects here again.
  await h.send({ type: 'connect' }, { id: 'ext', url: 'chrome-extension://ext/popup.html' });
  await h.until(() => h.sockets.length === 2 && h.session.connection?.connected);
  assert.equal(h.session.connection.conflict, undefined);
});

// The open popup re-reads the session after a status change (also a connection text) with `state`: unlike `connect`
// (the user opening the popup) it never reports this browser as used, reconnects or clears a superseded conflict.
test('the popup\'s state read only reads: no "used", no reconnect, a superseded conflict stays', async () => {
  const h = harness({ timeScale: 0.01 });
  await h.waitFor(m => m.type === 'hello');
  await h.until(() => h.session.connection?.connected);
  const popup = { id: 'ext', url: 'chrome-extension://ext/popup.html' };
  const reply = await h.send({ type: 'state' }, popup);
  assert.equal(reply.error, undefined);
  assert.equal(reply.connection.connected, true);
  assert.ok(Array.isArray(reply.requests));
  assert.equal(reply.status, null);
  await sleep(50);
  assert.equal(h.sent.filter(m => m.type === 'used').length, 0, 'not "used"');
  await h.send({ type: 'connect' }, popup);
  await h.until(() => h.sent.some(m => m.type === 'used'));
  h.socket.serverClose(4003);
  await h.until(() => h.session.connection?.conflict === 'superseded');
  assert.equal((await h.send({ type: 'state' }, popup)).connection.connected, false);
  await sleep(200);
  assert.equal(h.sockets.length, 1, 'no reconnect');
  assert.equal(h.session.connection.conflict, 'superseded', 'the conflict stays');
});

test('repeated 4000 closes from an older service back off (never a tight loop) and say so', async () => {
  const h = harness({ timeScale: 0.001 });
  await h.waitFor(m => m.type === 'hello');
  const closed = [];
  for (let round = 0; round < 4; round++) {
    await h.until(() => h.socket.readyState === 1 && h.sent.filter(m => m.type === 'hello').length === round + 1, 5000);
    closed.push(h.delays.length);
    h.socket.serverClose(4000);
    await h.until(() => h.sockets.length === round + 2, 5000);
  }
  // Each reconnect after a 4000 waits at least 4 s, longer each time: 4, 8, 15, 15 s (no reset by a short connection).
  const waits = h.delays.filter(ms => [500, 1_000, 2_000, 4_000, 8_000, 15_000].includes(ms));
  assert.deepEqual(waits.slice(0, 4), [4_000, 8_000, 15_000, 15_000]);
  await h.until(() => h.session.connection?.conflict === 'replaced');
  await h.until(() => /older FAI service/.test(h.local.status ?? ''));
});

test('only the browser a request waits in opens its approval UI and badge; others just list it', async () => {
  const h = harness({ local: WINDOW_ONLY });
  await h.waitFor(m => m.type === 'hello');
  const self = h.local.browserId;
  // The service marks requests `mine` per connection and lists browsers by name with `self`, never with ids.
  const elsewhere = pendingRequest('req_other', { browser: { product: 'firefox', name: 'Firefox', mine: false } });
  h.push({ type: 'requests', requests: [elsewhere], browsers: [{ product: 'chromium', name: 'Chromium', self: true },
    { product: 'firefox', name: 'Firefox', self: false }] });
  await h.until(() => h.session.requests?.length === 1);
  await sleep(20);
  assert.deepEqual(h.popupWindows, [], 'no window for another browser\'s request');
  assert.equal(h.badge, '', 'no ? badge either');
  assert.deepEqual(h.session.connection.browsers.map(browser => browser.name), ['Chromium', 'Firefox']);
  // Open here: the worker asks the service to move it; once it names this browser, it shows as usual.
  const reply = await h.send({ type: 'move', requestId: 'req_other' });
  assert.equal(reply.error, undefined);
  const move = await h.waitFor(m => m.type === 'move');
  assert.equal(move.requestId, 'req_other');
  await withPending(h, [{ ...elsewhere, browser: { product: 'chromium', name: 'Chromium', mine: true } }]);
  assert.equal(h.popupWindows.length, 1);
  assert.equal(h.badge, '?');
  // A service from before `mine` sends ids: compared with this install's own.
  await withPending(h, [pendingRequest('req_old', { browser: { id: 'b-firefox00000000001', name: 'Firefox' } })]);
  assert.equal(h.badge, '', 'another browser\'s id: not here');
  await withPending(h, [pendingRequest('req_own', { browser: { id: self, name: 'Chromium' } })]);
  assert.equal(h.badge, '?', 'its own id: here');
});

test('opening the toolbar popup or clicking the icon reports this browser as used; the approval window does not', async () => {
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  await h.until(() => h.session.connection?.connected);
  await h.send({ type: 'connect' }, { id: 'ext', url: 'chrome-extension://ext/popup.html?window=1' });
  await sleep(20);
  assert.equal(h.sent.some(m => m.type === 'used'), false);
  await h.send({ type: 'connect' }, { id: 'ext', url: 'chrome-extension://ext/popup.html' });
  await h.waitFor(m => m.type === 'used');
  h.chrome.action.onClicked.emit({ id: 12, url: 'https://elsewhere.test/' });
  await h.until(() => h.sent.filter(m => m.type === 'used').length === 2);
  assert.equal(h.sent.find(m => m.type === 'used').ref, undefined, 'fire and forget');
});

test('the long-poll fallback names this browser in every call', async () => {
  const h = harness({ ws: 'fail', timeScale: 0.002 });
  const hello = await h.waitFor(m => m.type === 'hello' && m.via === 'http');
  assert.equal(hello.headers['X-Fai-Browser'], h.local.browserId);
  assert.equal(hello.browser.product, 'chromium');
});

test('a refused browser id (4004) is given up once: a new id, a new connection; a second refusal stops visibly', async () => {
  const h = harness({ timeScale: 0.01 });
  await h.waitFor(m => m.type === 'hello');
  const first = h.local.browserId;
  h.socket.serverClose(4004);
  await h.until(() => h.sockets.length === 2);
  const second = h.local.browserId;
  assert.notEqual(second, first, 'a new id, saved');
  assert.equal(h.socket.url, `ws://127.0.0.1:4318/ext/ws?browser=${second}`);
  await h.until(() => h.sent.filter(m => m.type === 'hello').length === 2);
  // Refused again: no loop.
  h.socket.serverClose(4004);
  await h.until(() => h.session.connection?.conflict === 'identity');
  await sleep(100);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.local.browserId, second);
  assert.match(h.local.status, /refused this browser's id, even a new one/);
  h.alarmFire();
  await sleep(30);
  assert.equal(h.sockets.length, 2, 'the alarm does not retry it');
  // Opening the popup tries again.
  await h.send({ type: 'connect' }, { id: 'ext', url: 'chrome-extension://ext/popup.html' });
  await h.until(() => h.sockets.length === 3);
});

test('a refused browser id over the long-poll fallback (403 identity_refused) is given up once too', async () => {
  const h = harness({ ws: 'fail', timeScale: 0.002, local: { browserId: 'b-stalestale00000001' } });
  h.state.refusedIds = new Set(['b-stalestale00000001']);
  const hello = await h.waitFor(m => m.type === 'hello' && m.via === 'http' && !m.refusedId);
  assert.notEqual(h.local.browserId, 'b-stalestale00000001');
  assert.equal(hello.headers['X-Fai-Browser'], h.local.browserId);
  assert.ok(h.sent.some(m => m.refusedId === 'b-stalestale00000001'));
});

// --- Approved cross-origin frames (extension/frames.js, docs/REFERENCE.md "Frames") ------------------------------
const PORTAL = 'https://portal.example.net';
const ELSEWHERE = 'https://ads.example.org';
// The top page's slot for one cross-origin frame at (10, 20) in its 100x100 viewport.
const SLOT = { path: [0], box: { x: 10, y: 20, width: 80, height: 70 }, clip: { left: 10, top: 20, right: 90, bottom: 90 }, declared: PORTAL };
const NO_FACTS = { purchase: false, sensitive: false, secretPage: false };

// A fake page.js inside a frame: one button, a heading and its own revision; `calls` records what reached it.
function framePage({ origin = PORTAL, doc = 'framedoc', label = 'Save settings', text = 'Tenant ID 4711', facts = {}, slots = null,
  cls = 'submit', rects = null } = {}) {
  let rev = 1;
  const calls = [];
  const page = {
    calls,
    origin,
    observe: (...args) => {
      calls.push({ method: 'observe', args: clone(args) });
      return {
        revision: `${doc}:${rev}`, documentId: doc, url: `${origin}/blade`, title: 'Blade', text, textTruncated: false,
        blocks: [{ t: 'h2', text: 'Overview' }, { t: 'button', text: label, ref: '1' }], blocksTruncated: false,
        controls: [{ id: '1', role: 'button', label, bounds: { x: 5, y: 6, width: 30, height: 10 } }],
        consent: null, warnings: [], viewport: { width: 80, height: 70, dpr: 1 },
        pageFacts: { ...NO_FACTS, ...facts }, ...(slots ? { frameSlots: slots } : {}),
      };
    },
    execute(action, expected, settle, terms, forbid, allow, sites, expectText, approval) {
      calls.push({ method: 'execute', action: clone(action), expected, approval: clone(approval ?? null), allow: clone(allow ?? null) });
      if (expected !== `${doc}:${rev}`) throw Object.assign(new Error('Stale observation'), { code: 'stale' });
      rev++;
      return { fromUrl: `${origin}/blade`, target: { id: action.target, role: 'button', label }, settle: { reason: 'quiet', ms: 5 },
        observation: page.observe() };
    },
    approvalInfo(target, expected, kind) {
      calls.push({ method: 'approvalInfo', target, expected, kind });
      if (expected !== `${doc}:${rev}`) throw Object.assign(new Error('Stale observation'), { code: 'stale' });
      return { revision: expected, documentId: doc, target, label, labelHash: 'h-frame', cls, origin };
    },
    redactionRects({ arm } = {}) {
      calls.push({ method: 'redactionRects', arm });
      if (rects === 'silent') return new Promise(() => {});
      return { rects: rects ?? [{ x: 1, y: 2, width: 20, height: 8, kind: 'password' }], viewport: { width: 80, height: 70, dpr: 1 },
        scroll: { x: 0, y: 0 }, strict: false, ...(slots ? { frameBoxes: slots.map(({ path, box, clip }) => ({ path, box, clip })) } : {}),
        ...(arm ? {} : { dirty: false }) };
    },
  };
  return page;
}

// Answers the worker's frame calls: the allFrames probe (each frame's origin and path) and page calls pinned to a frame.
// `frames`: [{ frameId, documentId, path, page }]; a frame's `origin` may change (it navigated).
function frameWorld(h, frames) {
  const log = [];
  h.frameScript = async ({ func, files, args, target }) => {
    // The top document ('doc') is the harness's own page.
    if (target.documentIds?.includes('doc')) return undefined;
    const chosen = target.allFrames ? frames
      : frames.filter(frame => target.frameIds?.includes(frame.frameId) || target.documentIds?.includes(frame.documentId));
    if (target.documentIds && !chosen.length) throw new Error(`No document with id ${target.documentIds[0]}`);
    if (files) {
      log.push({ kind: 'inject', frames: chosen.map(frame => frame.frameId) });
      return chosen.map(frame => ({ frameId: frame.frameId, documentId: frame.documentId, result: null }));
    }
    if (func.name === 'frameProbe') {
      log.push({ kind: 'probe', all: Boolean(target.allFrames) });
      return chosen.map(frame => ({ frameId: frame.frameId, documentId: frame.documentId,
        result: { origin: frame.origin ?? frame.page.origin, opaque: false, path: frame.path, ready: 'complete', page: true,
          width: frame.width ?? 80, height: frame.height ?? 70 } }));
    }
    const [method, callArgs, secrets] = args;
    // `frame.refuse(method)`: the browser refuses that injection before anything runs (the document went away).
    for (const frame of chosen) {
      const refusal = frame.refuse?.(method);
      if (refusal) throw new Error(refusal);
    }
    return Promise.all(chosen.map(async frame => {
      log.push({ kind: 'call', frameId: frame.frameId, method, args: clone(callArgs), context: clone(secrets?.context ?? null) });
      try {
        return { frameId: frame.frameId, documentId: frame.documentId, result: { value: await frame.page[method](...callArgs) } };
      } catch (error) {
        return { frameId: frame.frameId, documentId: frame.documentId, result: { error: { code: error.code ?? 'unsupported', message: error.message } } };
      }
    }));
  };
  return log;
}

async function observed(h, args = {}) {
  const id = h.command('observe', args);
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  return reply.result;
}

async function executed(h, action, expectedRevision, level = 'full') {
  const id = h.command('execute', { action, expectedRevision, level });
  return h.waitFor(m => m.type === 'result' && m.id === id);
}

test('frames: an approved cross-origin frame is read into the observation: controls f1.<id> moved into the viewport, text, blocks, one revision', async () => {
  const h = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const page = framePage();
  const log = frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page }]);
  const observation = await observed(h);
  const control = observation.controls.find(item => item.id === 'f1.1');
  assert.ok(control, JSON.stringify(observation.controls));
  assert.equal(control.frame, 'f1');
  assert.equal(control.frameOrigin, PORTAL);
  assert.deepEqual(control.bounds, { x: 15, y: 26, width: 30, height: 10 }, 'moved into the top viewport');
  assert.equal(control.offscreen, undefined);
  assert.ok(observation.controls.some(item => item.id === '1' && item.frame === undefined), 'the top control keeps its id');
  assert.match(observation.text, /Hello\n\nTenant ID 4711/);
  assert.deepEqual(observation.blocks.slice(-2), [{ t: 'h2', text: 'Overview' }, { t: 'button', text: 'Save settings', ref: 'f1.1' }]);
  assert.match(observation.revision, /^doc:\d+\.\d+$/, 'one revision for the top document and the frame');
  assert.deepEqual(observation.frames, [{ id: 'f1', origin: PORTAL, read: true }]);
  assert.ok(!observation.warnings.includes('cross_origin_frame'), 'every frame was read');
  assert.equal(observation.frameSlots, undefined, 'worker-only fields never leave the extension');
  assert.equal(observation.pageFacts, undefined);
  // The frame's page.js ran pinned to its document, with the frame context (the tab's origin and the request's origins).
  const call = log.find(entry => entry.kind === 'call' && entry.method === 'observe');
  assert.deepEqual(call.context, { ...NO_FACTS, frame: true, topOrigin: ORIGIN, origins: [ORIGIN, PORTAL] });
  // Unchanged page and frame: the same revision again.
  assert.equal((await observed(h)).revision, observation.revision);
});

test('frames: a frame the request does not cover is never read; the warning and frames name its origin', async () => {
  // Only the tab's origin approved: nothing to probe, the frame element's declared origin is named.
  const h = await started({ leaseOrigins: [ORIGIN] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const page = framePage();
  const log = frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page }]);
  const observation = await observed(h);
  assert.deepEqual(log, [], 'no script reached any frame');
  assert.deepEqual(observation.frames, [{ origin: PORTAL, read: false, reason: 'not_approved', declared: true }],
    'only the element names that origin');
  assert.ok(observation.warnings.includes('cross_origin_frame'));
  assert.ok(!observation.controls.some(control => String(control.id).startsWith('f')));
  assert.doesNotMatch(observation.text, /Tenant/);

  // The request lists the portal, but the frame shows another origin now (its src still names the portal): the probe
  // reports where it is, and that frame is not read either.
  const other = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  other.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const moved = framePage({ origin: ELSEWHERE });
  const seen = frameWorld(other, [{ frameId: 5, documentId: 'D5', path: [0], page: moved }]);
  const second = await observed(other);
  assert.deepEqual(seen.map(entry => entry.kind), ['probe'], 'only the origin probe, never a page call');
  assert.equal(moved.calls.length, 0);
  assert.deepEqual(second.frames, [{ origin: ELSEWHERE, read: false, reason: 'not_approved' }]);
  assert.ok(second.warnings.includes('cross_origin_frame'));
  assert.doesNotMatch(second.text, /Tenant/);

  // Approved but out of the extension's reach (no host access, e.g. a toolbar approval): no_access.
  const third = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  third.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  frameWorld(third, []);
  assert.deepEqual((await observed(third)).frames, [{ origin: PORTAL, read: false, reason: 'no_access', declared: true }]);
});

test('frames: an act on a frame control runs in that frame on the frame revision; the result is the merged page', async () => {
  const h = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const page = framePage();
  const log = frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page }]);
  const before = await observed(h);
  const topExecutes = h.pageArgs.filter(call => call.method === 'execute').length;
  const reply = await executed(h, { type: 'click', target: 'f1.1' }, before.revision);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  const call = page.calls.find(entry => entry.method === 'execute');
  assert.deepEqual(call.action, { type: 'click', target: '1' }, 'the frame-local id');
  assert.equal(call.expected, 'framedoc:1', 'the frame revision the observation was made of');
  assert.equal(h.pageArgs.filter(entry => entry.method === 'execute').length, topExecutes, 'nothing ran in the top document');
  assert.ok(log.some(entry => entry.kind === 'probe' && !entry.all), 'the frame origin was probed again before the act');
  assert.notEqual(reply.result.observation.revision, before.revision);
  assert.ok(reply.result.observation.controls.some(control => control.id === 'f1.1'));
  // A top control on the merged revision runs in the top document on the top part of it.
  const again = reply.result.observation;
  const top = await executed(h, { type: 'click', target: '1' }, again.revision);
  assert.equal(top.error, undefined, JSON.stringify(top.error));
  assert.equal(h.pageArgs.filter(entry => entry.method === 'execute').at(-1).args[1], again.revision.replace(/\.\d+$/, ''));
});

test('frames: an act is refused when the frame moved to another origin, and stale on an unknown or old frame revision', async () => {
  const h = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const page = framePage();
  const frame = { frameId: 5, documentId: 'D5', path: [0], page };
  frameWorld(h, [frame]);
  const before = await observed(h);
  // The frame navigated to an origin the request does not list between observe and act: nothing runs there.
  frame.origin = ELSEWHERE;
  const refused = await executed(h, { type: 'click', target: 'f1.1' }, before.revision);
  assert.equal(refused.error.code, 'cross_origin', JSON.stringify(refused.error));
  assert.equal(page.calls.filter(entry => entry.method === 'execute').length, 0);
  assert.ok(!h.sent.some(m => m.type === 'status' && m.status === 'paused'), 'the tab itself stays approved');
  // Back on the portal, but another document (the frame reloaded): stale, nothing runs.
  frame.origin = PORTAL;
  frame.documentId = 'D6';
  const reloaded = await executed(h, { type: 'click', target: 'f1.1' }, before.revision);
  assert.equal(reloaded.error.code, 'stale', JSON.stringify(reloaded.error));
  // A frame target on a revision the worker never made: stale.
  const unknown = await executed(h, { type: 'click', target: 'f1.1' }, 'doc:1');
  assert.equal(unknown.error.code, 'stale');
  assert.equal(page.calls.filter(entry => entry.method === 'execute').length, 0);
});

test('frames: one page context for the tab: a purchase or password frame restricts the top document and every frame', async () => {
  const h = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  const second = { ...SLOT, path: [1], box: { ...SLOT.box, y: 95 }, clip: { ...SLOT.clip, top: 95, bottom: 100 } };
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT, second], pageFacts: NO_FACTS };
  const page = framePage({ facts: { purchase: true, sensitive: true } });
  const plain = framePage({ doc: 'plaindoc' });
  const log = frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page }, { frameId: 6, documentId: 'D6', path: [1], page: plain }]);
  const topReads = h.pageArgs.filter(call => call.method === 'observe').length;
  const observation = await observed(h);
  // The top document was read again with the checkout frame's facts, and so was the other frame; the checkout frame
  // itself had them already.
  assert.equal(h.pageArgs.filter(call => call.method === 'observe').length, topReads + 2);
  assert.deepEqual(clone(h.secretCalls.at(-1).context), { purchase: true, sensitive: true, secretPage: false });
  const reads = frameId => log.filter(entry => entry.kind === 'call' && entry.method === 'observe' && entry.frameId === frameId);
  assert.equal(reads(5).length, 1);
  assert.equal(reads(6).length, 2, 'the plain frame was read again with the tab context');
  assert.equal(reads(6).at(-1).context.purchase, true);
  assert.equal(reads(6).at(-1).context.frame, true);
  // A second observe of the same page reads every document once: the context is known now.
  await observed(h);
  assert.equal(reads(6).length, 3);
  assert.equal(h.pageArgs.filter(call => call.method === 'observe').length, topReads + 3);
  // Every later page call carries it: the top execute too.
  const top = await executed(h, { type: 'click', target: '1' }, observation.revision);
  assert.equal(top.error, undefined, JSON.stringify(top.error));
  assert.equal(h.secretCalls.at(-1).context.purchase, true);
});

test('frames: the Approve gate reads a frame control in its frame; the execute carries the approval with the local target', async () => {
  const h = await started({ level: 'full', leaseOrigins: [ORIGIN, PORTAL] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const page = framePage({ label: 'Delete tenant', cls: 'delete' });
  frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page }]);
  const before = await observed(h);
  const { id, entry } = await asked(h, { target: 'f1.1', expectedRevision: before.revision, cls: 'delete' });
  assert.equal(entry.label, 'Delete tenant', 'the label the frame page script read');
  assert.deepEqual(page.calls.find(call => call.method === 'approvalInfo'), { method: 'approvalInfo', target: '1', expected: 'framedoc:1', kind: null });
  await h.send({ type: 'approval_decision', id: entry.id, decision: 'approve' }, APPROVE_PAGE);
  const { approvalId } = (await h.waitFor(m => m.type === 'result' && m.id === id)).result;
  // The approval names f1.1: a top control cannot use it.
  const wrong = await executed(h, { type: 'click', target: '1', approvalId }, before.revision);
  assert.equal(wrong.error.code, 'blocked_risky');
  assert.equal(page.calls.filter(call => call.method === 'execute').length, 0);
  // Approved again, for the frame control itself: it runs there with the local target.
  const { id: second, entry: next } = await asked(h, { target: 'f1.1', expectedRevision: before.revision, cls: 'delete' });
  await h.send({ type: 'approval_decision', id: next.id, decision: 'approve' }, APPROVE_PAGE);
  const granted = (await h.waitFor(m => m.type === 'result' && m.id === second)).result.approvalId;
  const ran = await executed(h, { type: 'click', target: 'f1.1', approvalId: granted }, before.revision);
  assert.equal(ran.error, undefined, JSON.stringify(ran.error));
  const call = page.calls.find(item => item.method === 'execute');
  assert.deepEqual(call.approval, { target: '1', cls: 'delete', labelHash: 'h-frame' });
});

// The top page's redaction answer naming its cross-origin frames where they are now (page.js redactionRects).
const topBoxes = (arm, boxes) => ({ rects: [], frameBoxes: boxes, viewport: { width: 100, height: 100, dpr: 1 }, scroll: { x: 0, y: 0 },
  strict: false, ...(arm ? {} : { dirty: false }) });
const at = (x, y) => ({ path: [0], box: { x, y, width: 80, height: 70 }, clip: { left: x, top: y, right: x + 80, bottom: y + 70 } });
const hasBox = (rects, x, y, width, height) => rects.some(rect => rect.x === x && rect.y === y && rect.width === width && rect.height === height);

async function captured(h) {
  const id = h.command('capture', { action: null });
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id, 12000);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  return { reply, redact: h.annotations.at(-1).redact };
}

test('frames: screenshot boxes from a frame land where the frame is now; a frame that does not answer is boxed whole', async () => {
  const h = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const page = framePage();
  frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page }]);
  h.redaction = ({ arm }) => topBoxes(arm, [at(10, 20)]);
  let { redact } = await captured(h);
  assert.ok(hasBox(redact.rects, 11, 22, 20, 8), JSON.stringify(redact.rects));
  assert.equal(redact.withheld, false);
  assert.deepEqual(page.calls.filter(call => call.method === 'redactionRects').map(call => call.arm), [true, false]);

  // The page moved the frame down 15px after the observation (a banner): the password box follows the frame (review #1).
  h.redaction = ({ arm }) => topBoxes(arm, [at(10, 35)]);
  ({ redact } = await captured(h));
  assert.ok(hasBox(redact.rects, 11, 37, 20, 8), JSON.stringify(redact.rects));
  assert.ok(!hasBox(redact.rects, 11, 22, 20, 8), 'never at the place the frame left');

  const silent = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  silent.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  frameWorld(silent, [{ frameId: 5, documentId: 'D5', path: [0], page: framePage({ rects: 'silent' }) }]);
  silent.redaction = ({ arm }) => topBoxes(arm, [at(10, 20)]);
  assert.ok(hasBox((await captured(silent)).redact.rects, 10, 20, 80, 70), 'the whole frame is boxed');
});

test('frames: a frame moving during the capture withholds it; a read frame no query can place is boxed and withheld', async () => {
  const h = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page: framePage() }]);
  // Before the capture at y 20, after it at y 60, every time: never stable.
  h.redaction = ({ arm }) => topBoxes(arm, [at(10, arm ? 20 : 60)]);
  let { redact } = await captured(h);
  assert.equal(redact.withheld, true, 'a frame that moved between the two queries withholds the frame');

  // The frame is gone from the page's frames (or its path no longer matches): boxed where it was, withheld.
  h.redaction = ({ arm }) => topBoxes(arm, []);
  ({ redact } = await captured(h));
  assert.ok(hasBox(redact.rects, 10, 20, 80, 70), JSON.stringify(redact.rects));
  assert.equal(redact.withheld, true);
});

test('frames: every cross-origin frame that was not read is boxed whole on screenshots', async () => {
  const h = await started({ leaseOrigins: [ORIGIN] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page: framePage() }]);
  h.redaction = ({ arm }) => topBoxes(arm, [at(10, 20)]);
  const { redact, reply } = await captured(h);
  assert.ok(hasBox(redact.rects, 10, 20, 80, 70), JSON.stringify(redact.rects));
  assert.equal(redact.withheld, false);
  assert.equal(reply.result.screenshot.redactions, 1);
});

test('frames: a nested approved frame is read inside its approved parent, at the summed offset', async () => {
  const h = await started({ leaseOrigins: [ORIGIN, PORTAL, 'https://blade.example.net'] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const inner = { path: [0, 1], box: { x: 4, y: 4, width: 40, height: 30 }, clip: { left: 4, top: 4, right: 44, bottom: 34 },
    declared: 'https://blade.example.net' };
  const outer = framePage({ slots: [inner] });
  const blade = framePage({ origin: 'https://blade.example.net', doc: 'bladedoc', label: 'Add domain', text: 'Custom domains' });
  frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page: outer },
    { frameId: 6, documentId: 'D6', path: [0, 1], page: blade, width: 40, height: 30 }]);
  const observation = await observed(h);
  const control = observation.controls.find(item => item.id === 'f2.1');
  assert.ok(control, JSON.stringify(observation.controls.map(item => item.id)));
  assert.equal(control.frameOrigin, 'https://blade.example.net');
  assert.deepEqual(control.bounds, { x: 19, y: 30, width: 30, height: 10 }, '10+4+5, 20+4+6');
  assert.match(observation.text, /Custom domains/);
  assert.deepEqual(observation.frames.map(frame => frame.id), ['f1', 'f2']);
  // Its parent unapproved: the nested frame is not read either (its box is unknown and so is what embeds it).
  const lone = await started({ leaseOrigins: [ORIGIN, 'https://blade.example.net'] });
  lone.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  frameWorld(lone, [{ frameId: 5, documentId: 'D5', path: [0], page: framePage({ slots: [inner] }) },
    { frameId: 6, documentId: 'D6', path: [0, 1], page: framePage({ origin: 'https://blade.example.net' }), width: 40, height: 30 }]);
  const second = await observed(lone);
  assert.ok(!second.controls.some(item => String(item.id).startsWith('f')));
  assert.deepEqual(second.frames, [{ origin: PORTAL, read: false, reason: 'not_approved' }]);
});

test('an origin_changed pause names the origin the tab went to, never its path', async () => {
  const h = await started();
  h.navigate('https://login.example.org/oauth2/authorize?client_id=abc&code=secret');
  const status = await h.waitFor(m => m.type === 'status' && m.status === 'paused');
  assert.equal(status.reason, 'origin_changed');
  assert.equal(status.origin, 'https://login.example.org');
});

test('modal approval asks for every exact origin of the request in one prompt, and gives back the ones it added on stop', async () => {
  const h = harness({ hostGrants: [], leaseOrigins: [SHOP, PORTAL], local: {}, permissions: { defaultLevel: 'read-only' } });
  await h.waitFor(m => m.type === 'hello');
  h.push({ type: 'requests', requests: [pendingRequest('req_1', { mode: 'reversible', origins: [SHOP, PORTAL, 'https://*.example.org'] })] });
  await h.until(() => h.session.armedTabs?.length === 1 && h.session.armedTabs[0].promptWindowId !== null);
  const arm = h.session.armedTabs[0];
  const base = { tabId: 9, requestId: arm.requestId, at: arm.at };
  const { approval } = await h.send({ type: 'arm_prepare', ...base }, MODAL_SENDER);
  assert.deepEqual(approval.patterns, [`${SHOP}/*`, `${PORTAL}/*`], 'the task origin first; a domain root is not an exact origin');
  for (const pattern of approval.patterns) h.grant(pattern);
  const reply = await h.send({ type: 'arm_approve', ...base, ...approval, level: arm.level, granted: true }, MODAL_SENDER);
  assert.equal(reply.status, 'active', JSON.stringify(reply));
  await sleep(20);
  assert.ok(h.grants.has(`${PORTAL}/*`), 'kept while the session lives');
  await h.send({ type: 'stop' });
  await h.until(() => !h.grants.has(`${PORTAL}/*`) && !h.grants.has(`${SHOP}/*`));
});

// --- Security review of approved frames: regressions ---------------------------------------------------------------
test('frames review #2: the approval card names the frame origin "in a frame of" the page, and the approval binds it', async () => {
  const h = await started({ level: 'full', leaseOrigins: [ORIGIN, PORTAL] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const page = framePage({ label: 'Delete tenant', cls: 'delete' });
  frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page }]);
  const before = await observed(h);
  const { entry } = await asked(h, { target: 'f1.1', expectedRevision: before.revision, cls: 'delete' });
  assert.equal(entry.origin, PORTAL, 'the site the control is on');
  assert.equal(entry.frameOf, ORIGIN, 'the page that embeds it');
  // A top control's card is unchanged.
  const top = await started({ level: 'full' });
  const { entry: plain } = await asked(top);
  assert.equal(plain.origin, ORIGIN);
  assert.equal(plain.frameOf, undefined);
});

test('frames review #2: a frame whose page script reports another origin than the one probed is refused', async () => {
  const h = await started({ level: 'full', leaseOrigins: [ORIGIN, PORTAL] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const page = framePage({ label: 'Delete tenant', cls: 'delete' });
  page.approvalInfo = (target, expected) => ({ revision: expected, documentId: 'framedoc', target, label: 'Delete tenant',
    labelHash: 'h-frame', cls: 'delete', origin: ELSEWHERE });
  frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page }]);
  const before = await observed(h);
  const id = h.command('approve', { target: 'f1.1', expectedRevision: before.revision, cls: 'delete', waitMs: 100 });
  const reply = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(reply.error?.code, 'cross_origin', JSON.stringify(reply));
  assert.equal((h.session.approvals ?? []).length, 0, 'no card');
});

test('frames review #3: a frame act sees the page as it is now: a changed page is stale, a checkout page is the context', async () => {
  const h = await started({ level: 'full', leaseOrigins: [ORIGIN, PORTAL] });
  let topFacts = NO_FACTS;
  h.observationExtra = () => ({ warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: topFacts });
  const page = framePage({ label: 'Continue', cls: 'submit' });
  const log = frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page }]);
  let before = await observed(h);
  // The page turned into a checkout (same semantic revision): the frame runs with purchase in its context.
  topFacts = { ...NO_FACTS, purchase: true };
  const ran = await executed(h, { type: 'click', target: 'f1.1' }, before.revision);
  assert.equal(ran.error, undefined, JSON.stringify(ran.error));
  const call = log.filter(item => item.kind === 'call' && item.method === 'execute').pop();
  assert.equal(call.context.purchase, true, 'the current page facts, not the observation\'s');
  // The page changed (another revision) since the observation: stale, nothing runs in the frame.
  topFacts = NO_FACTS;
  before = await observed(h);
  h.bumpRevision();
  const executes = page.calls.filter(item => item.method === 'execute').length;
  const stale = await executed(h, { type: 'click', target: 'f1.1' }, before.revision);
  assert.equal(stale.error?.code, 'stale', JSON.stringify(stale.error));
  assert.equal(page.calls.filter(item => item.method === 'execute').length, executes);
  // The Approve gate's read of a frame control checks the page the same way.
  const asking = h.command('approve', { target: 'f1.1', expectedRevision: before.revision, cls: 'submit', waitMs: 100 });
  assert.equal((await h.waitFor(m => m.type === 'result' && m.id === asking)).error?.code, 'stale');
});

test('frames review #3: a top act first looks at the frames again: a frame that became a payment form restricts it', async () => {
  const h = await started({ level: 'full', leaseOrigins: [ORIGIN, PORTAL] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const facts = {};
  const page = framePage({ facts });
  const log = frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page }]);
  const before = await observed(h);
  facts.purchase = true;
  const ran = await executed(h, { type: 'click', target: '1' }, before.revision);
  assert.equal(ran.error, undefined, JSON.stringify(ran.error));
  const looks = log.filter(item => item.kind === 'call' && item.method === 'observe' && item.args[0]?.blocks === false);
  assert.equal(looks.length, 1, 'one cheap look per frame before the act');
  const execute = h.pageArgs.filter(item => item.method === 'execute').at(-1);
  assert.equal(execute.context?.purchase, true, 'the top execute ran with the frame\'s purchase fact');
});

test('frames review #4: a frame document gone before the act ran is never a success (stale or cross_origin)', async () => {
  const h = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const page = framePage();
  const frame = { frameId: 5, documentId: 'D5', path: [0], page };
  frameWorld(h, [frame]);
  const before = await observed(h);
  // The browser refuses the injection (the document went away between the probe and the call), then the frame is
  // found on another approved document: stale.
  frame.refuse = method => {
    if (method !== 'execute') return null;
    frame.documentId = 'D7';
    return 'No document with id D5';
  };
  const gone = await executed(h, { type: 'click', target: 'f1.1' }, before.revision);
  assert.equal(gone.error?.code, 'stale', JSON.stringify(gone));
  assert.equal(page.calls.filter(item => item.method === 'execute').length, 0);
  // Or on an unapproved origin: cross_origin.
  frame.documentId = 'D5';
  const again = await observed(h);
  frame.refuse = method => {
    if (method !== 'execute') return null;
    frame.origin = ELSEWHERE;
    return 'No document with id D5';
  };
  const moved = await executed(h, { type: 'click', target: 'f1.1' }, again.revision);
  assert.equal(moved.error?.code, 'cross_origin', JSON.stringify(moved));
});

test('frames review #9 and #10: a frame of another size than its slot, or a nested slot outside its parent, is not read', async () => {
  const h = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const page = framePage();
  frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page, width: 300, height: 100 }]);
  const observation = await observed(h);
  assert.equal(page.calls.length, 0, 'the frame at that path is not the one page.js placed there');
  assert.deepEqual(observation.frames, [{ origin: PORTAL, read: false, reason: 'unavailable' }]);

  // An approved frame that names a slot outside itself (path [1], a sibling) is ignored.
  const other = await started({ leaseOrigins: [ORIGIN, PORTAL, 'https://blade.example.net'] });
  other.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const sibling = { path: [1], box: { x: 0, y: 0, width: 40, height: 30 }, clip: { left: 0, top: 0, right: 40, bottom: 30 },
    declared: 'https://blade.example.net' };
  const blade = framePage({ origin: 'https://blade.example.net', doc: 'bladedoc', label: 'Sibling button' });
  frameWorld(other, [{ frameId: 5, documentId: 'D5', path: [0], page: framePage({ slots: [sibling] }) },
    { frameId: 6, documentId: 'D6', path: [1], page: blade, width: 40, height: 30 }]);
  const second = await observed(other);
  assert.equal(blade.calls.length, 0);
  assert.ok(!second.controls.some(control => control.label === 'Sibling button'));
});

test('frames review #11: when a fact leaves the tab, the documents are read again without it', async () => {
  const h = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const facts = { purchase: true };
  const log = frameWorld(h, [{ frameId: 5, documentId: 'D5', path: [0], page: framePage({ facts }) }]);
  await observed(h);
  assert.equal(h.secretCalls.at(-1).context.purchase, true);
  facts.purchase = false;
  const topReads = h.pageArgs.filter(item => item.method === 'observe').length;
  await observed(h);
  // The top document was read with purchase from the last context; it is read again without it.
  assert.equal(h.pageArgs.filter(item => item.method === 'observe').length, topReads + 2);
  assert.equal(h.secretCalls.at(-1).context.purchase, false);
  assert.equal(log.filter(item => item.kind === 'call' && item.method === 'observe').at(-1).context.purchase, false);
});

test('frames review: an extra origin the user already allowed survives the session stop; a declined prompt keeps nothing', async () => {
  const h = harness({ hostGrants: [`${PORTAL}/*`], leaseOrigins: [SHOP, PORTAL], local: {}, permissions: { defaultLevel: 'read-only' } });
  await h.waitFor(m => m.type === 'hello');
  h.push({ type: 'requests', requests: [pendingRequest('req_1', { mode: 'reversible', origins: [SHOP, PORTAL] })] });
  await h.until(() => h.session.armedTabs?.length === 1 && h.session.armedTabs[0].promptWindowId !== null);
  const arm = h.session.armedTabs[0];
  const base = { tabId: 9, requestId: arm.requestId, at: arm.at };
  const { approval } = await h.send({ type: 'arm_prepare', ...base }, MODAL_SENDER);
  for (const pattern of approval.patterns) h.grant(pattern);
  const reply = await h.send({ type: 'arm_approve', ...base, ...approval, level: arm.level, granted: true }, MODAL_SENDER);
  assert.equal(reply.status, 'active', JSON.stringify(reply));
  await h.send({ type: 'stop' });
  await h.until(() => !h.grants.has(`${SHOP}/*`));
  await sleep(50);
  assert.ok(h.grants.has(`${PORTAL}/*`), 'the user-held grant stays');

  const declined = harness({ hostGrants: [], leaseOrigins: [SHOP, PORTAL], local: {}, permissions: { defaultLevel: 'read-only' } });
  await declined.waitFor(m => m.type === 'hello');
  declined.push({ type: 'requests', requests: [pendingRequest('req_1', { mode: 'reversible', origins: [SHOP, PORTAL] })] });
  await declined.until(() => declined.session.armedTabs?.length === 1 && declined.session.armedTabs[0].promptWindowId !== null);
  const armed = declined.session.armedTabs[0];
  const at2 = { tabId: 9, requestId: armed.requestId, at: armed.at };
  const prepared = await declined.send({ type: 'arm_prepare', ...at2 }, MODAL_SENDER);
  const refused = await declined.send({ type: 'arm_approve', ...at2, ...prepared.approval, level: armed.level, granted: false }, MODAL_SENDER);
  assert.notEqual(refused.status, 'active');
  assert.equal(declined.grants.size, 0);
});

test('frames review: screenshot boxes follow each read frame by its frame id, not by a window index another frame shifted', async () => {
  const h = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  const slot = (path, y) => ({ path: [path], box: { x: 10, y, width: 80, height: 20 }, clip: { left: 10, top: y, right: 90, bottom: y + 20 },
    declared: PORTAL });
  // Read: A at index 1 (no secret), B at index 2 (a password field); index 0 is an unread ad.
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [{ ...slot(0, 0), declared: ELSEWHERE }, slot(1, 30), slot(2, 60)],
    pageFacts: NO_FACTS };
  const a = { frameId: 5, documentId: 'D5', path: [1], width: 80, height: 20, page: framePage({ rects: [] }) };
  const b = { frameId: 6, documentId: 'D6', path: [2], width: 80, height: 20, page: framePage({ doc: 'bdoc' }) };
  const ad = { frameId: 4, documentId: 'D4', path: [0], width: 80, height: 20, page: framePage({ origin: ELSEWHERE, doc: 'addoc' }) };
  frameWorld(h, [ad, a, b]);
  await observed(h);
  // The ad is removed: A is index 0 now, B index 1; an unread frame takes index 2.
  a.path = [0];
  b.path = [1];
  ad.path = [9];
  const boxes = [{ path: [0], box: { x: 10, y: 30, width: 80, height: 20 }, clip: { left: 10, top: 30, right: 90, bottom: 50 } },
    { path: [1], box: { x: 10, y: 60, width: 80, height: 20 }, clip: { left: 10, top: 60, right: 90, bottom: 80 } },
    { path: [2], box: { x: 10, y: 85, width: 80, height: 10 }, clip: { left: 10, top: 85, right: 90, bottom: 95 } }];
  h.redaction = ({ arm }) => topBoxes(arm, boxes);
  const { redact } = await captured(h);
  assert.ok(hasBox(redact.rects, 11, 62, 20, 8), `B's field where B is now: ${JSON.stringify(redact.rects)}`);
  assert.ok(hasBox(redact.rects, 10, 85, 80, 10), 'the new unread frame is boxed whole');
  assert.ok(!redact.rects.some(rect => rect.y === 87), 'never B\'s boxes on the unread frame');
});

test('frames review: a frame whose size no longer matches its box is boxed whole, never placed', async () => {
  const h = await started({ leaseOrigins: [ORIGIN, PORTAL] });
  h.observationExtra = { warnings: ['cross_origin_frame'], frameSlots: [SLOT], pageFacts: NO_FACTS };
  const frame = { frameId: 5, documentId: 'D5', path: [0], page: framePage() };
  frameWorld(h, [frame]);
  await observed(h);
  frame.width = 300;
  h.redaction = ({ arm }) => topBoxes(arm, [at(10, 20)]);
  const { redact } = await captured(h);
  // The capture's own fresh observation no longer reads it (unavailable): it is boxed whole like any unread frame.
  assert.ok(hasBox(redact.rects, 10, 20, 80, 70), JSON.stringify(redact.rects));
  assert.ok(!hasBox(redact.rects, 11, 22, 20, 8), 'its own boxes are never placed by a box of another size');
  // Resized between that observation and the queries: boxed whole, and the capture is not trusted.
  frame.width = 80;
  h.redaction = ({ arm }) => {
    if (arm) frame.width = 300;
    return topBoxes(arm, [at(10, 20)]);
  };
  const second = (await captured(h)).redact;
  assert.ok(hasBox(second.rects, 10, 20, 80, 70), JSON.stringify(second.rects));
  assert.equal(second.withheld, true);
});
// --- invites (docs/REFERENCE.md "Invites and wakes") ---------------------------------------------------------------

const POPUP = { id: 'ext', url: 'chrome-extension://ext/popup.html' };

test('invite: only the toolbar popup can invite; a page, a content script or the approval window cannot', async () => {
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  for (const sender of [
    { id: 'ext', url: ORIGIN },
    { id: 'ext', url: `${ORIGIN}/popup.html`, tab: { id: 7 } },
    { id: 'ext', url: 'chrome-extension://ext/popup.html', tab: { id: 7 } },
    { id: 'ext', url: 'chrome-extension://ext/popup.html?window=1' },
    { id: 'ext', url: 'chrome-extension://ext/arm.html?tab=7' },
  ]) {
    const reply = await h.send({ type: 'invite', tabId: 7, origin: ORIGIN, level: 'full', sessionId: 'ses_1' }, sender);
    assert.match(reply?.error ?? '', /popup/, JSON.stringify(sender));
  }
  // Another extension's message is not answered at all.
  h.chrome.runtime.onMessage.emit({ type: 'invite', tabId: 7, origin: ORIGIN, level: 'full' }, { id: 'other-extension', url: 'chrome-extension://other-extension/popup.html' }, () => {});
  const cancel = await h.send({ type: 'invite_cancel', inviteId: 'inv-abcd2345' }, { id: 'ext', url: ORIGIN });
  assert.match(cancel.error, /popup/);
  await sleep(20);
  assert.ok(!h.sent.some(message => ['invite', 'invite_cancel'].includes(message.type)), 'nothing reached the service');
});

test('invite: the popup click binds the current tab at the chosen level, for the chosen session, and marks it', async () => {
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  await h.until(() => h.session.connection?.connected);
  const agents = await h.send({ type: 'agents' }, POPUP);
  assert.deepEqual(agents.agents.sessions.map(item => [item.sessionId, item.host, item.repo, item.wake]),
    [['ses_1', 'claude', 'fai-browser', 'claude-socket'], ['ses_2', 'unknown', 'rx', 'none']]);
  assert.ok(!JSON.stringify(agents).includes('NEVER-SHOWN') && !JSON.stringify(agents).includes('4242'), 'no key or pid reaches the popup');
  const reply = await h.send({ type: 'invite', tabId: 7, origin: ORIGIN, level: 'reversible', sessionId: 'ses_1', text: 'Look at the plans' }, POPUP);
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.equal(reply.status, 'active');
  assert.deepEqual(reply.invited, { inviteId: 'inv-abcd2345', requestId: 'req_inv' });
  const sent = h.sent.find(message => message.type === 'invite');
  assert.deepEqual([sent.tabId, sent.origin, sent.level, sent.tabMode, sent.sessionId, sent.text],
    [7, ORIGIN, 'reversible', 'single', 'ses_1', 'Look at the plans']);
  assert.ok(!h.sent.some(message => message.type === 'lease'), 'one message: the invite is the approval');
  assert.equal(reply.session.inviteId, 'inv-abcd2345');
  assert.equal(reply.session.level, 'reversible');
  await h.until(() => h.groupOf.get(7) !== undefined);
  assert.equal(h.groups.get(h.groupOf.get(7)).title, 'FAI', 'the invited tab gets the task-tab mark');
  // Commands for the lease run on that tab at the invited level.
  const id = h.command('observe', {}, { lease: { id: LEASE_ID, tabId: 7, requestId: 'req_inv' } });
  const result = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(result.error, undefined, JSON.stringify(result.error));
});

test('invite: Test site only on a listed test site; closing the invited tab revokes the invite', async () => {
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  const refused = await h.send({ type: 'invite', tabId: 7, origin: ORIGIN, level: 'testing', sessionId: null }, POPUP);
  assert.match(refused.error, /Testing mode needs/);
  assert.ok(!h.sent.some(message => message.type === 'invite'));
  const reply = await h.send({ type: 'invite', tabId: 7, origin: ORIGIN, level: 'read-only', sessionId: null }, POPUP);
  assert.equal(reply.status, 'active', JSON.stringify(reply));
  h.chrome.tabs.onRemoved.emit(7);
  const cancel = await h.waitFor(m => m.type === 'invite_cancel');
  assert.deepEqual([cancel.inviteId, cancel.reason], ['inv-abcd2345', 'tab_closed']);
});

test('invite: Test site works on an origin listed under Test sites', async () => {
  const h = harness({ permissions: { defaultLevel: 'full', testingOrigins: [ORIGIN] } });
  await h.waitFor(m => m.type === 'hello');
  const reply = await h.send({ type: 'invite', tabId: 7, origin: ORIGIN, level: 'testing', sessionId: 'ses_1' }, POPUP);
  assert.equal(reply.status, 'active', JSON.stringify(reply));
  assert.equal(h.sent.find(message => message.type === 'invite').level, 'testing');
});

test('invite: the popup cancels its invite and the session stops', async () => {
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  await h.send({ type: 'invite', tabId: 7, origin: ORIGIN, level: 'reversible', sessionId: 'ses_1' }, POPUP);
  const reply = await h.send({ type: 'invite_cancel', inviteId: 'inv-abcd2345', requestId: 'req_inv' }, POPUP);
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  assert.equal(reply.status, 'stopped');
  assert.ok(h.sent.some(message => message.type === 'invite_cancel' && message.inviteId === 'inv-abcd2345'));
});

test('invite: the worker binds only the tab and origin the popup showed', async () => {
  const h = harness();
  await h.waitFor(m => m.type === 'hello');
  await h.until(() => h.session.connection?.connected);
  const otherTab = await h.send({ type: 'invite', tabId: 8, origin: ORIGIN, level: 'reversible', sessionId: 'ses_1' }, POPUP);
  assert.match(otherTab.error, /tab changed/);
  const otherOrigin = await h.send({ type: 'invite', tabId: 7, origin: 'https://bank.example', level: 'reversible', sessionId: 'ses_1' }, POPUP);
  assert.match(otherOrigin.error, /tab changed/);
  // The page navigated after the popup opened: what the popup showed is no longer what the tab holds.
  h.tab.url = 'https://elsewhere.example/account';
  const navigated = await h.send({ type: 'invite', tabId: 7, origin: ORIGIN, level: 'reversible', sessionId: 'ses_1' }, POPUP);
  assert.match(navigated.error, /tab changed/);
  const missing = await h.send({ type: 'invite', level: 'reversible', sessionId: 'ses_1' }, POPUP);
  assert.match(missing.error, /Open the popup on the tab/);
  assert.ok(!h.sent.some(message => message.type === 'invite'), 'nothing was bound');
});

