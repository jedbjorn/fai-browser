// Pass 7: all browser requests are intercepted local fixtures; no live service or credential files.
import test from 'node:test';
import { TOOLS, validateSchema } from '../src/mcp.js';
import { headlessEnv } from '../scripts/headless-env.mjs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { BrowserRuntime, legalActions } from '../src/runtime.js';
import { CAPABILITIES, LEVELS, clampLevel, paymentField } from '../src/guardrails.js';
import { redactSecrets, agentResult } from '../src/result.js';
import { normalizePermissions, testingAllowed } from '../extension/permissions.js';
import { FakeBridge } from './runtime-fixtures.js';
import { createDaemon } from '../src/daemon.js';
import { createLogger, homePaths, loadConfig } from '../src/home.js';
import { createHub } from '../src/bridge.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { EXTENSION_ID, EXTENSION_ORIGIN } from './helpers/fake-extension.js';
import { writeRun } from '../src/trace.js';

// VM worker harness reused from extension-worker.test.js, without importing its tests.
const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const ORIGIN = 'https://example.com';
const ENDPOINT = 'http://127.0.0.1:4318';
const SECRET = 'x'.repeat(30);
const LEASE_ID = 'lease-1';

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

function harness({ ws = 'open', http = 'ok', paired = true, timeScale = 1, mode = 'daemon', leaseOrigins = null, permissions } = {}) {
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
  const session = {};
  const badges = [];
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
  const annotations = [];
  let scriptOverride = null;
  const observation = () => ({
    revision: `doc:${revision}`,
    documentId: 'doc',
    url: tab.url,
    title: 'Fixture',
    text: 'Hello',
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
  const fakePage = {
    redactionRects(options) {
      redactionCalls.push(clone(options ?? {}));
      if (redaction) return redaction(options ?? {}, redactionCalls.length);
      return { rects: [], viewport: { width: 100, height: 100, dpr: 1 }, scroll: { x: 0, y: 0 }, strict: false,
        ...(options?.arm ? {} : { dirty: false }) };
    },
    observe: (...args) => {
      pageArgs.push({ method: 'observe', args: clone(args) });
      return observation();
    },
    execute(action, expectedRevision, settleOptions, terms, forbid, allow) {
      pageArgs.push({ method: 'execute', args: clone([action, expectedRevision, settleOptions, terms ?? null, forbid ?? null, allow ?? null]) });
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
  };

  // The fake daemon's answer to a ref'd message.
  function answer(message) {
    if (message.type === 'hello') return { ok: true, data: { mode, daemonVersion: '0.2.0', endSession: false } };
    if (message.type === 'lease') {
      return { ok: true, data: { leaseId: LEASE_ID, requestId: message.requestId, ...(leaseOrigins ? { origins: leaseOrigins } : {}) } };
    }
    if (message.type === 'validate') return { ok: true, data: { valid: true } };
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
  }

  const context = {};
  const chrome = {
    runtime: {
      id: 'ext',
      onMessage: events('onMessage'),
      onStartup: events('onStartup'),
      onInstalled: events('onInstalled'),
      getManifest: () => ({ version: '0.3.0' }),
      async sendMessage(message) {
        assert.equal(message.type, 'annotate');
        annotations.push(clone(message));
        return { dataUrl: 'data:image/jpeg;base64,QUJD', width: 100, height: 100, encoder: 'dom', timings: { encodeMs: 1 },
          redactions: message.redact?.rects?.length, withheld: message.redact?.withheld };
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
        async get() { return {}; },
        async set(values) { Object.assign(session, clone(values)); },
      },
      onChanged: events('onChanged'),
    },
    action: {
      async setBadgeText({ text }) { badges.push(text); },
      async setBadgeBackgroundColor() {},
      async setTitle() {},
    },
    alarms: {
      async create(name, info) { alarmsCreated.push({ name, ...info }); },
      onAlarm: alarms,
    },
    offscreen: { async hasDocument() { return true; }, async createDocument() {} },
    tabs: {
      onCreated: events('onCreated'),
      onActivated: events('onActivated'),
      onRemoved: events('onRemoved'),
      onUpdated: events('onUpdated'),
      async query(query) {
        if (query.currentWindow) return [{ id: 7, url: tab.url, windowId: 1, title: 'Members' }];
        return [{ id: activeTabId, windowId: 1 }];
      },
      async get(id) { return { id, url: tab.url, status: tab.status, windowId: 1 }; },
      async captureVisibleTab() { return 'data:image/jpeg;base64,UkFX'; },
    },
    scripting: {
      async executeScript({ func, files, args }) {
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
    sockets,
    delays,
    intervals,
    local,
    session,
    badges,
    alarms,
    alarmsCreated,
    get socket() {
      return sockets.at(-1);
    },
    get injections() { return injections; },
    get pageCalls() { return pageCalls; },
    set redaction(fn) { redaction = fn; },
    redactionCalls,
    get badge() { return badges.at(-1); },
    setActiveTab(id) { activeTabId = id; },
    bumpRevision() { revision++; },
    tab,
    pageArgs,
    annotations,
    set pageExecute(fn) { pageExecute = fn; },
    // `fn(method)` returns a replacement for that executeScript call (a function returning the injection
    // results, or throwing), or nothing to run page.js normally.
    set scriptOverride(fn) { scriptOverride = fn; },
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
    send(message) {
      // Replies come from the VM realm; JSON round-trip makes them comparable with deepStrictEqual.
      return new Promise(resolve => chrome.runtime.onMessage.emit(message, { id: 'ext' }, reply => resolve(clone(reply))));
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


const grant = level => ({ mode: level, grant: { level }, capture: 'none' });
const checkout = () => new FakeBridge({ pages: { '/': { title: 'Checkout', text: 'Continue charges your saved card $49.',
  controls: [{ id: '1', role: 'button', label: 'Continue', enabled: true, risk: 'reversible' }] } } });
const provider = guards => ({ async decide(_page, actions) {
  return { actionId: actions.find(a => a.target === '1').id, confidence: 0.99, guards };
} });
for (const [name, guards] of [
  ['both missing', {}], ['page missing', { purchase_control: 0 }],
  ['control missing', { purchase_page: 0 }], ['NaN', { purchase_control: NaN, purchase_page: NaN }],
  ['non-numeric', { purchase_control: '0', purchase_page: null }],
]) test(`FINDING: incomplete purchase guard fails closed (${name})`, { todo: 'deferred: custom providers are mechanical-only by design; the Jev provider now fills unanswered purchase questions with 1 (guardrails-levels.test.js)' }, async () => {
  const bridge = checkout();
  await new BrowserRuntime({ bridge, provider: provider(guards) }).step('Continue', grant('full'));
  assert.equal(bridge.executions.length, 0, 'unchecked checkout must never execute');
});
test('purchase guards veto at threshold; provider exceptions dispatch nothing', async () => {
  for (const p of [{ purchase_control: 0.7, purchase_page: 0 }, { purchase_control: 0, purchase_page: 0.7 }]) {
    const bridge = checkout();
    await new BrowserRuntime({ bridge, provider: provider(p) }).step('Continue', grant('full'));
    assert.equal(bridge.executions.length, 0);
  }
  const bridge = checkout();
  await new BrowserRuntime({ bridge, provider: { async decide() { throw new Error('fixture unavailable'); } } })
    .step('Continue', grant('full'));
  assert.equal(bridge.executions.length, 0);
});
test('fixed: host observe/act applies the purchase guard at full', async () => {
  const bridge = checkout(); let decisions = 0;
  const runtime = new BrowserRuntime({ bridge, provider: { async decide() { decisions++;
    throw new Error('purchase check unavailable'); } } });
  const offer = await runtime.observe(grant('full'));
  await runtime.act(offer.actions.find(a => a.target === '1').id, { revision: offer.observation.revision });
  assert.equal(bridge.executions.length, 0, `host dispatched checkout without checking (${decisions} provider calls)`);
  // A guard at the veto refuses the host's choice; low guards let it run; testing does not ask.
  for (const [guards, level, executed, code] of [
    [{ purchase_control: 0.1, purchase_page: 0.9 }, 'full', 0, 'refused_action'],
    [{ purchase_control: 0.1, purchase_page: 0.1 }, 'full', 1, 'step_complete'],
    [{ purchase_control: 0.9, purchase_page: 0.9 }, 'testing', 1, 'step_complete'],
  ]) {
    const b = checkout(); let asked = 0;
    const r = new BrowserRuntime({ bridge: b, provider: { async decide() { asked++; return { actionId: 'handoff', guards }; } } });
    const seen = await r.observe(grant(level));
    const result = await r.act(seen.actions.find(a => a.target === '1').id, { revision: seen.observation.revision });
    assert.equal(b.executions.length, executed, `${level} ${JSON.stringify(guards)}`);
    assert.equal(result.code, code);
    assert.equal(asked, level === 'testing' ? 0 : 1);
    if (code === 'refused_action') {
      assert.ok(result.verdict.why.includes('guard:purchase_veto'));
      assert.equal(result.next.kind, 'stop');
    }
  }
});

let browser;
test.before(async () => {
  try { browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, env: headlessEnv(), args: ['--no-sandbox'] }); } catch { /* Browser cases individually skip when unavailable. */ }
});
test.after(() => browser?.close());
async function pageFixture(t, html, setup) {
  if (!browser) { t.skip('Chromium unavailable'); return null; }
  const p = await browser.newPage(); t.after(() => p.close());
  // Intercept ALL requests, including frames and images. Never contact a website.
  await p.route('**/*', r => r.fulfill({ contentType: 'text/html', body:
    '<!doctype html><meta charset="utf-8"><title>Fixture</title>' + html }));
  await p.goto('http://127.0.0.1:9876/');
  if (setup) await p.evaluate(setup);
  await p.addScriptTag({ path: new URL('../extension/page.js', import.meta.url).pathname });
  return p;
}
async function dispatch(p, level, forbid = [], supplied = {}) {
  return p.evaluate(async ({ allow, forbid, supplied }) => {
    const obs = __faiPage.observe({ allow, forbid });
    const c = obs.controls.find(c => c.role === 'button' || c.role === 'link');
    if (!c) return { code: 'not_offered', obs };
    try { await __faiPage.execute({ type: 'click', target: c.id }, obs.revision,
      { quietMs: 1, capMs: 20 }, [], forbid, allow); return { code: 'ran', obs }; }
    catch (e) { return { code: e.code, obs }; }
  }, { allow: CAPABILITIES[level], forbid, supplied });
}

const mechanicalLabels = ['Pay $49', 'Place order (1 item)', 'Complete checkout', 'Confirm and pay',
  'Buy with one click', 'Renew', 'Upgrade', 'P\u202eay', 'Pa\u0301y', 'P a y', 'Ｐａｙ'];
test('purchase labels, bidi, combining marks and common lookalikes remain mechanically blocked', async t => {
  const p = await pageFixture(t, mechanicalLabels.map(s => `<button type="button">${s}</button>`).join(''));
  if (!p) return;
  const controls = await p.evaluate(() => __faiPage.observe({ allow: ['navigate', 'controls', 'submit'] }).controls);
  assert.equal(controls.length, mechanicalLabels.length);
  for (const c of controls) assert.equal(c.risk, 'purchase', c.label);
});
test('split child labels, letter spacing, input-image alt, SVG title and input value stay blocked', async t => {
  const p = await pageFixture(t, '<button type="button"><span>P</span><span>a</span><span>y</span></button>'
    + '<button type="button" style="letter-spacing:20px">Pay</button>'
    + '<input type="image" alt="Pay" style="width:40px;height:30px">'
    + '<button type="button"><svg width="30" height="30"><title>Pay</title></svg></button>'
    + '<input type="button" value="Pay">');
  if (!p) return;
  const o = await p.evaluate(() => __faiPage.observe());
  for (const c of o.controls) assert.equal(c.risk, 'purchase', c.label);
});
for (const [name, html] of [
  ['aria-labelledby', '<span id="pay">Pay</span><button type="button" aria-labelledby="pay" style="width:40px;height:30px"></button>'],
  ['CSS generated text', '<style>button::before{content:"Pay"}</style><button type="button" style="width:60px;height:30px"></button>'],
]) test(`fixed: purchase accessible label includes ${name}`, async t => {
  const p = await pageFixture(t, html); if (!p) return;
  const r = await dispatch(p, 'full');
  assert.equal(r.code, 'blocked_risky', `${name}: ${JSON.stringify(r.obs.controls)}`);
});
const semanticLabels = ['Pɑy', 'Jetzt kaufen', 'Payer', 'Comprar', 'Bestellen', 'Zahlungspflichtig bestellen',
  'Get it now', 'Rent', 'Pledge', 'Tip', 'Top up', 'Add funds'];
test('semantic-only labels are vetoed by Jev purchase_page even when the regex misses', async () => {
  for (const label of semanticLabels) {
    const bridge = checkout(); bridge.pages['/'].controls[0].label = label;
    await new BrowserRuntime({ bridge, provider: provider({ purchase_control: 0, purchase_page: 0.95 }) })
      .step(`Use ${label}`, grant('full'));
    assert.equal(bridge.executions.length, 0, label);
  }
});

for (const autocomplete of ['billing cc-number', 'CC-NUMBER', 'section-x cc-exp', 'cc-given-name']) {
  test(`payment autocomplete ${autocomplete} is purchase-class`, async t => {
    const p = await pageFixture(t, `<form><input autocomplete="${autocomplete}"><button>Next</button></form>`);
    if (!p) return; assert.equal((await dispatch(p, 'interactive')).code, 'blocked_risky');
  });
}
test('cardnum and ccnum native fields are detected', () => {
  for (const name of ['cardnum', 'ccnum']) assert.equal(paymentField({ name }), true, name);
});
for (const name of ['pan', 'kartennummer', 'numero de tarjeta']) test(`${name === 'pan' ? 'FINDING' : 'fixed'}: native payment alias ${name} cannot be submitted as safe`, name === 'pan' ? { todo: 'deferred: a bare pan token is too ambiguous for the mechanical field check' } : {}, async t => {
  const p = await pageFixture(t, `<form><input name="${name}"><button>Next</button></form>`);
  if (!p) return; assert.equal((await dispatch(p, 'interactive')).code, 'blocked_risky');
});
test('same-origin card iframe prevents safe submit and cross-origin iframe inside form also blocks', async t => {
  const p = await pageFixture(t, '<form><iframe src="/card"></iframe><button>Next</button></form>');
  if (!p) return;
  await p.locator('iframe').evaluate(e => { e.contentDocument.body.innerHTML = '<input autocomplete="cc-number">'; });
  assert.equal((await dispatch(p, 'interactive')).code, 'blocked_risky');
  await p.locator('iframe').evaluate(e => { e.src = 'http://localhost:9877/card'; });
  await p.waitForFunction(() => !document.querySelector('iframe').contentDocument);
  assert.equal((await dispatch(p, 'interactive')).code, 'blocked_risky');
});
for (const mode of ['open', 'closed']) test(`${mode === 'open' ? 'fixed' : 'FINDING'}: ${mode} shadow payment widget prevents interactive submit`, mode === 'open' ? {} : { todo: 'deferred: a closed shadow root cannot be read by the page script' }, async t => {
  const p = await pageFixture(t, '<form><div id="widget"></div><button>Next</button></form>'); if (!p) return;
  await p.evaluate(mode => { document.querySelector('#widget').attachShadow({ mode }).innerHTML =
    '<input autocomplete="cc-number" aria-label="Card number">'; }, mode);
  const r = await dispatch(p, 'interactive');
  assert.equal(r.code, 'blocked_risky', JSON.stringify(r.obs.controls));
});
test('FINDING: contenteditable payment field prevents interactive submit', { todo: 'deferred: contenteditable payment widgets are not detected mechanically' }, async t => {
  const p = await pageFixture(t, '<form><div contenteditable role="textbox" autocomplete="cc-number" aria-label="Number">4242</div><button>Next</button></form>');
  if (!p) return; assert.equal((await dispatch(p, 'interactive')).code, 'blocked_risky');
});
test('fixed: scan budget exhaustion cannot downgrade a payment form to safe submit', async t => {
  const p = await pageFixture(t, '<form>' + '<input type="hidden">'.repeat(2001)
    + '<input autocomplete="cc-number"><button>Next</button></form>');
  if (!p) return; assert.equal((await dispatch(p, 'interactive')).code, 'blocked_risky');
});
for (const href of ['#']) test(`fixed: Buy now anchor with ${href} is a script control rather than navigation`, async t => {
  const p = await pageFixture(t, `<a href="${href}" onclick="window.commits=(window.commits||0)+1;return false">Buy now</a>`);
  if (!p) return;
  const r = await dispatch(p, 'reversible');
  assert.equal(await p.evaluate(() => window.commits || 0), 0, `dispatch ${r.code}, risk ${r.obs.controls[0].risk}`);
});
test('role=link and anchor without href keep dangerous label classes; host filters dangerous href links', async t => {
  const p = await pageFixture(t, '<span role="link">Buy now</span><a role="link">Delete account</a>'); if (!p) return;
  const o = await p.evaluate(() => __faiPage.observe());
  assert.deepEqual(o.controls.map(c => c.risk), ['purchase', 'delete']);
  for (const label of ['Buy now', 'Delete account']) {
    assert.ok(!legalActions({ url: ORIGIN, controls: [{ id: '1', role: 'link', label, href: ORIGIN + '/#', risk: 'navigation' }] },
      { mode: 'reversible' }).some(a => a.target));
  }
});
test('forbid remains restrictive in page and runtime at testing', async t => {
  const p = await pageFixture(t, '<button type="button">Upgrade</button>'); if (!p) return;
  assert.equal((await dispatch(p, 'testing', ['Upgrade'])).code, 'blocked_risky');
  const bridge = checkout(); bridge.pages['/'].controls[0].label = 'Upgrade';
  await new BrowserRuntime({ bridge, provider: provider({}) }).step('Upgrade', { ...grant('testing'), policy: ['Upgrade'] });
  assert.equal(bridge.executions.length, 0);
});

async function startWorker({ level = 'testing', origins = [ORIGIN], listed = origins, tab = ORIGIN, leaseOrigins = origins } = {}) {
  const h = harness({ permissions: { testingOrigins: listed }, leaseOrigins });
  h.tab.url = tab + '/';
  await h.waitFor(m => m.type === 'hello');
  h.push({ type: 'requests', requests: [{ requestId: 'req_1', state: 'pending', origins, mode: 'testing' }] });
  await h.until(() => h.session.requests?.length === 1);
  const reply = await h.send({ type: 'start', requestId: 'req_1', endpoint: ENDPOINT, secret: SECRET, level });
  return { h, reply };
}
async function workerAllow(h, args = { level: 'testing' }, overrides) {
  const id = h.command('observe', args, overrides);
  const r = await h.waitFor(m => m.type === 'result' && m.id === id);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return h.pageArgs.at(-1).args[0].allow;
}
test('forged host level/allow and invalid level shapes cannot raise worker capabilities', async () => {
  const { h, reply } = await startWorker({ level: 'reversible' }); assert.equal(reply.status, 'active');
  for (const level of ['testing', 'full']) assert.deepEqual(await workerAllow(h, { level, allow: CAPABILITIES.testing }), CAPABILITIES.reversible);
  for (const level of ['Full', 'TESTING', [], {}, '__proto__', null]) {
    assert.deepEqual(await workerAllow(h, { level, allow: CAPABILITIES.testing }), ['navigate']);
    assert.equal(clampLevel(level, 'testing'), 'read-only');
  }
  h.push({ type: 'lease_update', leaseId: LEASE_ID, state: 'active', level: 'testing', grant: { level: 'testing' } });
  assert.deepEqual(await workerAllow(h), CAPABILITIES.reversible);
});
test('testing origin exactness rejects subdomains, port/scheme changes, slash, userinfo and Unicode aliases', async () => {
  const bad = ['https://sub.example.com', 'https://example.com:444', 'http://example.com', ORIGIN + '/',
    'https://EXAMPLE.com', 'https://user@example.com', 'https://exаmple.com', 'https://xn--exmple-4nf.com',
    'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'];
  for (const origin of bad) {
    const { h, reply } = await startWorker({ origins: [ORIGIN, origin], listed: [ORIGIN] });
    assert.ok(reply.error, origin); assert.equal(h.sent.some(m => m.type === 'lease'), false, origin);
  }
  for (const origin of [ORIGIN + '/', 'https://EXAMPLE.com', 'https://user@example.com', 'https://exаmple.com']) {
    assert.deepEqual(normalizePermissions({ testingOrigins: [origin] }).testingOrigins, [], origin);
  }
  assert.equal(testingAllowed(['http://127.0.0.1:3000'], ['http://localhost:3000']), false);
});
test('testing refuses unlisted tab and origins substituted in lease reply', async () => {
  for (const opts of [{ tab: 'https://other.test' }, { leaseOrigins: [ORIGIN, 'https://other.test'] }]) {
    const { reply } = await startWorker(opts); assert.ok(reply.error);
  }
});
test('removing current origin drops testing to full; consent redirect to removed origin also drops', async () => {
  const { h } = await startWorker();
  h.local.permissions = { testingOrigins: [] };
  h.emitStorage({ permissions: { newValue: h.local.permissions } }, 'local');
  assert.deepEqual(await workerAllow(h), CAPABILITIES.full);
  const consent = 'https://consent.example.com';
  const { h: c } = await startWorker({ origins: [consent, ORIGIN], tab: consent });
  c.local.permissions = { testingOrigins: [consent] };
  c.emitStorage({ permissions: { newValue: c.local.permissions } }, 'local');
  c.tab.url = ORIGIN + '/';
  assert.deepEqual(await workerAllow(c, { level: 'testing' }, { allowedOrigins: [consent, ORIGIN] }), CAPABILITIES.full);
});
test('fixed: removing a requested non-current origin revokes testing immediately', async () => {
  const other = 'https://other.test';
  const { h } = await startWorker({ origins: [ORIGIN, other] });
  h.local.permissions = { testingOrigins: [ORIGIN] };
  h.emitStorage({ permissions: { newValue: h.local.permissions } }, 'local');
  assert.deepEqual(await workerAllow(h), CAPABILITIES.full);
});
test('page-controlled attributes and main-world globals cannot forge isolated-world allow', async t => {
  const p = await pageFixture(t, '<button type="button" data-allow="purchase" data-level="testing">Pay</button>');
  if (!p) return;
  await p.evaluate(() => { window.allow = ['purchase']; window.currentAllow = new Set(['purchase']);
    window.postMessage({ allow: ['purchase'], level: 'testing' }, '*'); });
  const cdp = await p.context().newCDPSession(p);
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'pass7' });
  await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: await readFile(new URL('../extension/page.js', import.meta.url), 'utf8') });
  const r = await cdp.send('Runtime.evaluate', { contextId: executionContextId, awaitPromise: true, returnByValue: true,
    expression: `(async()=>{const o=__faiPage.observe({allow:['navigate','controls']});try{await __faiPage.execute({type:'click',target:o.controls[0].id},o.revision,{quietMs:1,capMs:20},[],[],['navigate','controls']);return 'ran'}catch(e){return e.code}})()` });
  assert.equal(r.result.value, 'blocked_risky');
});

async function daemonFixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'pass7-daemon-'));
  const hub = createFakeHub();
  const env = { TYPESAFE_API_KEY: 'synthetic-fixture-value' };
  const log = createLogger(homePaths({ home, env }));
  const daemon = createDaemon({ driver: 'jev', home, env, port: 0, hub, log, providerFactory: () => provider({ purchase_page: 0, purchase_control: 0 }) });
  await daemon.listen();
  t.after(async () => { await daemon.close(); log.close(); await rm(home, { recursive: true, force: true }); });
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  return { daemon, hub, api };
}
test('daemon rejects host grants and keeps requested testing below user grant; authenticated regrant changes host only', async t => {
  const { daemon, hub, api } = await daemonFixture(t);
  for (const field of ['grant', 'permissions', 'level']) {
    const r = await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Fixture', mode: 'testing', [field]: { level: 'testing' } });
    assert.equal(r.status, 400, field);
  }
  const r = await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Fixture', mode: 'testing' });
  assert.equal(r.status, 201);
  const id = r.body.requestId;
  await hub.approve(id, { level: 'reversible' });
  assert.equal(daemon.request(id).grant.level, 'reversible');
  for (const path of ['/v1/observe', '/v1/runs']) {
    const r = await api('POST', path, { requestId: id, instruction: 'Continue', mode: 'testing', grant: { level: 'testing' } });
    assert.equal(r.status, 400);
  }
  const old = daemon.request(id).lease.leaseId;
  const reply = await hub.approve(id, { level: 'full' });
  assert.equal(reply.leaseId, old); assert.equal(daemon.request(id).grant.level, 'full');
  // This is the trusted extension event, not an HTTP client permission grant.
});
test('hub clamps forged command levels independently', async t => {
  const hub = createHub({ secret: SECRET, extensionId: EXTENSION_ID, mode: 'daemon' });
  const server = http.createServer((req, res) => { if (!hub.handleHttp(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { hub.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  hub.onEvent(e => { if (e.type === 'hello') e.reply({ mode: 'daemon', endSession: false }); });
  const post = async (path, body = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST',
      headers: { Origin: EXTENSION_ORIGIN, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };
  await post('/hello', { v: 3, ext: { version: '0.3.0', protocol: 3 }, session: null });
  hub.bindLease({ leaseId: 'pass7', tabId: 1, origin: ORIGIN, allowedOrigins: [ORIGIN], level: 'reversible' });
  const bridge = hub.bridgeFor('pass7');
  for (const level of ['testing', 'full', 'Full', {}, [], '__proto__']) {
    const pending = bridge.observe(undefined, { level });
    const polled = await post('/commands?wait=1000');
    const expected = ['testing', 'full'].includes(level) ? 'reversible' : 'read-only';
    assert.equal(polled.command.args.level, expected);
    await post('/results', { id: polled.command.id, result: { revision: 'doc:1' } });
    await pending;
  }
});
class PasswordEchoBridge extends FakeBridge {
  constructor(echo) { super({ pages: { '/': { title: 'Fixture', text: 'Test login', controls:
    [{ id: '1', role: 'textbox', type: 'password', label: 'Password', enabled: true }] } } }); this.echo = echo; }
  async execute(a, ...args) {
    const out = await super.execute(a, ...args);
    if (a.type === 'fill_supplied_text') {
      const echo = this.echo(a.text);
      this.pages['/'].title = `Echo ${echo}`; this.pages['/'].text = `Echo ${echo}`;
      this.pages['/'].controls[0].label = `Password ${echo}`;
      this.version++;
      return { ...out, observation: this.observation };
    }
    return out;
  }
}
async function filled(secret, echo = s => s) {
  const bridge = new PasswordEchoBridge(echo);
  const runtime = new BrowserRuntime({ bridge, provider: { async decide(_o, actions) {
    return { actionId: actions.find(a => a.type === 'fill_supplied_text').id, confidence: 0.99 };
  } } });
  const result = await runtime.step('Fill the test password', { ...grant('testing'), suppliedText: { pw: secret } });
  assert.equal(bridge.lastText, secret, 'fixture actually filled the password');
  return { bridge, runtime, result };
}
test('long passwords and URL encodings are redacted from receipt, trace and later runtime observe', async t => {
  const secret = 'synthetic p@ss/word';
  for (const echo of [s => s, encodeURIComponent]) {
    const { runtime, result } = await filled(secret, echo);
    const needle = echo(secret);
    assert.ok(!JSON.stringify(agentResult(result)).includes(needle));
    assert.ok(!JSON.stringify(await runtime.observe(grant('testing'))).includes(needle));
    const dir = await mkdtemp(join(tmpdir(), 'pass7-trace-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const written = await writeRun(result, { dir, instruction: 'Fixture', operation: 'step', options: {} });
    assert.ok(!(await readFile(written.trace, 'utf8')).includes(needle));
  }
});
for (const secret of ['x', 'xy']) test(`FINDING: ${secret.length}-character supplied password is redacted`, { todo: 'by design: secrets under 3 characters are not searched for (documented)' }, async () => {
  const { result } = await filled(secret);
  assert.ok(!JSON.stringify(result.page).includes(`Echo ${secret}`));
});
test('fixed: base64 password echo is redacted from receipts and later observe', async () => {
  const secret = 'synthetic-password-77'; const echo = s => Buffer.from(s).toString('base64');
  const { result, runtime } = await filled(secret, echo);
  assert.ok(!JSON.stringify(agentResult(result)).includes(echo(secret)));
  assert.ok(!JSON.stringify(await runtime.observe(grant('testing'))).includes(echo(secret)));
});
test('redaction walks digest, candidates, verdict, needs.dialog, labels and descriptions', () => {
  const secret = 'synthetic-password';
  const o = { page: { digest: [secret] }, answer: { candidates: [{ text: secret }] }, verdict: { answer: { text: secret } },
    needs: { dialog: { text: secret } }, steps: [{ action: { label: secret, description: secret } }] };
  redactSecrets(o, [secret]); assert.ok(!JSON.stringify(o).includes(secret));
});
test('fixed: screenshot annotation caption redacts a supplied password echoed into target label', async () => {
  const offscreen = await readFile(new URL('../extension/offscreen.js', import.meta.url), 'utf8');
  const secret = 'synthetic-password-77';
  const context = { chrome: { runtime: { onMessage: { addListener() {} } } } };
  vm.createContext(context); vm.runInContext(offscreen, context);
  const caption = vm.runInContext(`describeAction({type:'fill_supplied_text',text:${JSON.stringify(secret)},sensitive:true},
    {label:${JSON.stringify('Password ' + secret)}})`, context);
  assert.ok(!caption.includes(secret), caption);
});
test('mechanical consent rejection precedes provider selection at all levels', async () => {
  for (const level of LEVELS) {
    const bridge = new FakeBridge({ pages: { '/': { title: 'Cookie settings', text: 'We use cookies',
      controls: [ { id: '1', role: 'button', label: 'Accept all', consent: true, risk: 'consent_accept', enabled: true },
        { id: '2', role: 'button', label: 'Reject all', consent: true, risk: 'reversible', enabled: true, dismissesConsent: true } ],
      consent: { text: 'We use cookies', buttons: [{ id: '1', kind: 'accept', label: 'Accept all' }, { id: '2', kind: 'reject', label: 'Reject all' }] } } } });
    const runtime = new BrowserRuntime({ bridge, provider: { async decide() { return { actionId: 'done' }; } } });
    await runtime.run('Read page', grant(level));
    assert.equal(bridge.executions[0]?.action.target, '2', level);
    assert.ok(!bridge.executions.some(e => e.action.target === '1'), level);
  }
});

test('javascript links dispatch no event even when labelled as navigation', async t => {
  const p = await pageFixture(t, '<a href="javascript:void(0)" onclick="window.commits=1">Buy now</a>');
  if (!p) return;
  assert.equal((await dispatch(p, 'full')).code, 'blocked_risky');
  assert.equal(await p.evaluate(() => window.commits || 0), 0);
});
test('config cannot grant levels and CLI options files strip permission fields', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pass7-config-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const { writeFile } = await import('node:fs/promises');
  for (const config of [{ grant: { level: 'testing' } }, { permissions: { level: 'testing' } }, { level: 'testing' }]) {
    await writeFile(join(dir, 'config.json'), JSON.stringify(config));
    assert.throws(() => loadConfig(homePaths({ home: dir, env: {} })), /Unknown|unknown/);
  }
  // An options file reaches the daemon only through the RUN_OPTION_KEYS allow-list: no grant, no permissions.
  const cli = await readFile(new URL('../src/cli.js', import.meta.url), 'utf8');
  const list = cli.match(/const RUN_OPTION_KEYS = (\[[^\]]+\]);/)?.[1];
  const keys = vm.runInNewContext(list);
  assert.ok(keys.includes('mode'), 'requested need is retained');
  assert.ok(!keys.includes('grant') && !keys.includes('permissions'));
});
test('fixed: worker annotation payload excludes a password echoed by a later action', async () => {
  const { h, reply } = await startWorker(); assert.equal(reply.status, 'active');
  const secret = 'synthetic-password-77';
  h.pageExecute = action => ({ fromUrl: ORIGIN + '/', target: { id: '1', role: 'button', label: `Continue ${secret}` },
    settle: { reason: 'quiet', ms: 1 }, observation: { revision: 'doc:2', documentId: 'doc', url: ORIGIN + '/', title: 'Fixture', text: '',
      controls: [], blocks: [], viewport: { width: 100, height: 100, dpr: 1 } } });
  // Simulate supplying a sensitive fill before an echo-labelled control in the same session.
  const fill = h.command('execute', { level: 'testing', action: { type: 'fill_supplied_text', target: '1', text: secret, sensitive: true }, expectedRevision: 'doc:1', capture: false });
  const fr = await h.waitFor(m => m.type === 'result' && m.id === fill); assert.equal(fr.error, undefined);
  const click = h.command('execute', { level: 'testing', action: { type: 'click', target: '1' }, expectedRevision: 'doc:2', capture: true });
  await h.waitFor(m => m.type === 'screenshot' && m.id === click);
  assert.ok(h.annotations.length > 0);
  assert.ok(!JSON.stringify(h.annotations).includes(secret), 'password flows to caption renderer');
});

test('fixed: a fill into a password target is kept out of annotations even without the sensitive flag', async () => {
  const { h, reply } = await startWorker(); assert.equal(reply.status, 'active');
  const secret = 'synthetic-password-88';
  const page = (label, type) => () => ({ fromUrl: ORIGIN + '/', target: { id: '1', role: 'textbox', label, ...(type ? { type } : {}) },
    settle: { reason: 'quiet', ms: 1 }, observation: { revision: 'doc:2', documentId: 'doc', url: ORIGIN + '/', title: `Hi ${secret}`,
      text: '', controls: [{ id: '1', role: 'textbox', label: `Echo ${secret}` }], blocks: [], viewport: { width: 100, height: 100, dpr: 1 } } });
  h.pageExecute = page('Password', 'password');
  const fill = h.command('execute', { level: 'testing', action: { type: 'fill_supplied_text', target: '1', text: secret }, expectedRevision: 'doc:1', capture: true });
  await h.waitFor(m => m.type === 'screenshot' && m.id === fill);
  h.pageExecute = page(`Continue ${secret}`);
  const click = h.command('execute', { level: 'testing', action: { type: 'click', target: '1' }, expectedRevision: 'doc:2', capture: true });
  await h.waitFor(m => m.type === 'screenshot' && m.id === click);
  assert.equal(h.annotations.length, 2);
  assert.ok(!JSON.stringify(h.annotations).includes(secret), JSON.stringify(h.annotations).slice(0, 400));
});
test('FINDING: cross-origin payment iframe outside form prevents interactive submit', { todo: 'deferred: a cross-origin frame cannot be read; treating every such page as sensitive would disable interactive on pages with ads' }, async t => {
  const p = await pageFixture(t, '<iframe src="http://localhost:9877/card"></iframe><form><button>Next</button></form>');
  if (!p) return;
  await p.waitForFunction(() => !document.querySelector('iframe').contentDocument);
  const r = await dispatch(p, 'interactive');
  assert.ok(r.obs.warnings.includes('cross_origin_frame'));
  assert.equal(r.code, 'blocked_risky');
});
test('password redaction survives later run and a new daemon lease on the same tab', async t => {
  const { hub, api } = await daemonFixture(t);
  const secret = 'synthetic-password-77';
  const req = async () => {
    const r = await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Fixture', mode: 'testing' });
    assert.equal(r.status, 201); await hub.approve(r.body.requestId, { level: 'testing' }); return r.body.requestId;
  };
  const id = await req();
  const bridge = hub.bridgeForTab(1);
  bridge.pages['/'] = { title: 'Fixture', text: 'Test login', controls:
    [{ id: '1', role: 'textbox', type: 'password', label: 'Password', enabled: true }] };
  const filled = await api('POST', '/v1/runs', { requestId: id, instruction: 'Fill password', mode: 'testing',
    operation: 'step', suppliedText: { pw: secret }, capture: 'none', waitMs: 5000 });
  assert.equal(filled.status, 200); assert.equal(bridge.lastText, secret);
  bridge.pages['/'] = { title: `Echo ${secret}`, text: `Echo ${secret}`, controls: [] };
  const later = await api('POST', '/v1/runs', { requestId: id, instruction: 'Read page', mode: 'testing', operation: 'step', capture: 'none', waitMs: 5000 });
  assert.ok(!JSON.stringify(later.body).includes(secret));
  const newId = await req();
  const observed = await api('POST', '/v1/observe', { requestId: newId, mode: 'testing', capture: false });
  assert.equal(observed.status, 200); assert.ok(!JSON.stringify(observed.body).includes(secret));
});

test('MCP accepts testing only as a requested mode and rejects permission-grant keys', () => {
  const tool = TOOLS.find(t => t.name === 'fai_browser_open');
  assert.equal(validateSchema(tool.inputSchema, { task: 'Continue', mode: 'testing' }), null);
  for (const extra of [{ grant: { level: 'testing' } }, { permissions: { effective: 'testing' } }]) {
    assert.match(validateSchema(tool.inputSchema, { task: 'Continue', mode: 'testing', ...extra }), /not a supported parameter/);
  }
});
