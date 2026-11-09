// Several browsers paired with one daemon at once (issue #9): each extension connection has its own browser
// identity, commands go to the browser that holds the lease, a new tab request goes to the browser the user used
// last (or the one the agent names), and no connection ever closes another browser's.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeError, CLOSE_SUPERSEDED, connectionIdentity, createHub, pickBrowser } from '../src/bridge.js';
import { createDaemon } from '../src/daemon.js';
import { FaiBrowserClient } from '../src/client.js';
import { EXTENSION_ID, EXTENSION_ORIGIN, FakeExtension, SECRET } from './helpers/fake-extension.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';

const FIREFOX_ORIGIN = 'moz-extension://0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
const CHROMIUM = { id: 'b-chromium0000000001', product: 'chromium', name: 'Chromium', origin: EXTENSION_ORIGIN };
const FIREFOX = { id: 'b-firefox00000000001', product: 'firefox', name: 'Firefox', origin: FIREFOX_ORIGIN };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, message = 'condition not met', ms = 2000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await sleep(5);
  }
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof BridgeError, `expected BridgeError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

const closes = ext => ext.client.events.filter(event => event.type === 'close');

// --- the hub alone -------------------------------------------------------------------------------------------------

// A daemon-mode hub on its own server, with a recorded event and log stream. Hello replies keep sessions; lease events
// bind a lease for the browser that sent them, like the daemon does.
async function hubServer(t, options = {}) {
  const logs = [];
  const events = [];
  const hub = createHub({ secret: SECRET, extensionId: EXTENSION_ID, log: (event, fields) => logs.push({ event, ...fields }),
    ...options });
  const server = http.createServer((req, res) => {
    if (hub.handleHttp(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (!hub.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  let leaseSequence = 0;
  hub.onEvent(event => {
    events.push(event);
    if (event.type === 'hello') event.reply({ mode: 'daemon', endSession: false });
    if (event.type === 'move') event.reply({ requestId: event.requestId });
    if (event.type === 'lease') {
      const leaseId = `lease-${++leaseSequence}`;
      hub.bindLease({ leaseId, requestId: event.requestId, browserId: event.browserId, tabId: event.tabId,
        origin: event.origin, allowedOrigins: [event.origin] });
      event.reply({ leaseId, requestId: event.requestId });
    }
  });
  t.after(async () => {
    hub.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  });
  const port = server.address().port;
  // A browser over the WebSocket: `browser` an identity (the current extension), or none (an older extension).
  const connect = async (browser = null, { origin } = {}) => {
    const path = browser ? `/ext/ws?browser=${browser.id}` : '/ext/ws';
    const ext = await FakeExtension.connect({ port, origin: origin ?? browser?.origin ?? EXTENSION_ORIGIN, path });
    t.after(() => ext.close());
    return ext;
  };
  const hello = (ext, browser) => ext.hello(null, browser ? { browser: { product: browser.product, name: browser.name, version: '1.0' } } : {});
  // A browser over the HTTP long-poll fallback.
  const post = async (browser, path, body = {}, signal) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { Origin: browser.origin, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json',
        ...(browser.id ? { 'X-Fai-Browser': browser.id } : {}) },
      body: JSON.stringify(body),
      signal,
    });
    return { status: response.status, body: await response.json() };
  };
  return { hub, port, logs, events, connect, hello, post };
}

test('issue #9: two paired browsers (Chromium and Firefox) stay connected side by side, no 4000 ping-pong', async t => {
  // Older extensions that report no identity: known by their extension Origin, which differs between browsers.
  const setup = await hubServer(t);
  const chromium = await setup.connect();
  await chromium.hello();
  const firefox = await setup.connect(null, { origin: FIREFOX_ORIGIN });
  await firefox.hello();
  await sleep(150);
  assert.deepEqual(closes(chromium), [], 'the first browser is not replaced by the second');
  assert.deepEqual(closes(firefox), []);
  assert.equal(setup.logs.filter(entry => entry.event === 'extension_ws_close').length, 0);
  // Both still answer on their own socket.
  chromium.send('ping');
  await chromium.client.message(message => message.type === 'pong');
  firefox.send('ping');
  await firefox.client.message(message => message.type === 'pong');
  const browsers = setup.hub.extension().browsers;
  assert.equal(browsers.length, 2);
  assert.deepEqual(browsers.map(browser => browser.product).sort(), ['chromium', 'firefox']);
  assert.ok(browsers.every(browser => browser.legacy && browser.transport === 'websocket'));
});

test('two Chromium-family browsers with the same pinned extension Origin but their own ids both stay', async t => {
  const setup = await hubServer(t);
  const brave = { id: 'b-brave00000000000001', product: 'brave', name: 'Brave', origin: EXTENSION_ORIGIN };
  const chromium = await setup.connect(CHROMIUM);
  await setup.hello(chromium, CHROMIUM);
  const other = await setup.connect(brave);
  await setup.hello(other, brave);
  await sleep(100);
  assert.deepEqual([...closes(chromium), ...closes(other)], []);
  const listed = setup.hub.extension().browsers.map(browser => [browser.id, browser.name, browser.legacy]);
  assert.deepEqual(listed.sort(), [[brave.id, 'Brave', false], [CHROMIUM.id, 'Chromium', false]]);
  // Each one's requests snapshot lists both browsers for its popup.
  const snapshot = await other.client.message(message => message.type === 'requests' && message.browsers?.length === 2);
  assert.deepEqual(snapshot.browsers.map(browser => browser.name).sort(), ['Brave', 'Chromium']);
});

test('a newer connection of the same browser supersedes the old one once with 4003; no loop follows', async t => {
  const setup = await hubServer(t);
  const firefox = await setup.connect(FIREFOX);
  await setup.hello(firefox, FIREFOX);
  const chromium = await setup.connect(CHROMIUM);
  await setup.hello(chromium, CHROMIUM);
  // Firefox's worker restarted: its new socket replaces its old one only.
  const restarted = await setup.connect(FIREFOX);
  await setup.hello(restarted, FIREFOX);
  const close = await firefox.client.next(event => event.type === 'close');
  assert.equal(close.code, CLOSE_SUPERSEDED);
  await sleep(150);
  assert.deepEqual(closes(chromium), [], 'another browser is never closed');
  assert.deepEqual(closes(restarted), []);
  assert.equal(setup.logs.filter(entry => entry.event === 'extension_ws_close').length, 1, 'one close, no ping-pong');
  assert.equal(setup.hub.extension().browsers.length, 2);
  assert.deepEqual(setup.hub.warnings(), []);
  // A message on the superseded socket is ignored; the new one is served.
  restarted.send('ping');
  await restarted.client.message(message => message.type === 'pong');
});

test('commands go only to the browser that holds the lease', async t => {
  const setup = await hubServer(t);
  const chromium = await setup.connect(CHROMIUM);
  await setup.hello(chromium, CHROMIUM);
  const firefox = await setup.connect(FIREFOX);
  await setup.hello(firefox, FIREFOX);
  const inChromium = await chromium.lease({ requestId: 'req_c', tabId: 7, origin: ORIGIN });
  const inFirefox = await firefox.lease({ requestId: 'req_f', tabId: 7, origin: ORIGIN });
  assert.equal(inChromium.ok, true);
  assert.equal(inFirefox.ok, true);
  assert.equal(setup.hub.lease(inChromium.data.leaseId).browserId, CHROMIUM.id);
  assert.equal(setup.hub.lease(inFirefox.data.leaseId).browserId, FIREFOX.id);
  const routed = [];
  const serve = (ext, name) => (async () => {
    while (!ext.client.closed) {
      const command = await ext.command(5000).catch(() => null);
      if (!command) continue;
      routed.push([name, command.lease.requestId]);
      ext.result(command.id, { revision: `${name}:1` });
    }
  })();
  serve(chromium, 'chromium');
  serve(firefox, 'firefox');
  // The same tab id in two browsers: two different tabs, each command to its own browser.
  assert.equal((await setup.hub.bridgeFor(inFirefox.data.leaseId).observe()).revision, 'firefox:1');
  assert.equal((await setup.hub.bridgeFor(inChromium.data.leaseId).observe()).revision, 'chromium:1');
  assert.equal((await setup.hub.bridgeFor(inFirefox.data.leaseId).observe()).revision, 'firefox:1');
  assert.deepEqual(routed, [['firefox', 'req_f'], ['chromium', 'req_c'], ['firefox', 'req_f']]);
  // A push for a lease goes to its browser only.
  setup.hub.updateLease(inFirefox.data.leaseId, 'released', 'released');
  const update = await firefox.client.message(message => message.type === 'lease_update');
  assert.equal(update.requestId, 'req_f');
  await sleep(50);
  assert.equal(chromium.client.events.some(event => event.data?.type === 'lease_update'), false);
  // A browser cannot report on, or lower, another browser's lease.
  chromium.send('status', { leaseId: inFirefox.data.leaseId, status: 'stopped', reason: 'stopped' });
  const lowered = await chromium.request('lease_level', { leaseId: inFirefox.data.leaseId, level: 'read-only' });
  assert.equal(lowered.error.code, 'no_request');
});

test('one browser disconnecting pauses only its own leases', async t => {
  const setup = await hubServer(t, { disconnectGraceMs: 80 });
  const chromium = await setup.connect(CHROMIUM);
  await setup.hello(chromium, CHROMIUM);
  const firefox = await setup.connect(FIREFOX);
  await setup.hello(firefox, FIREFOX);
  const inChromium = (await chromium.lease({ requestId: 'req_c', tabId: 3, origin: ORIGIN })).data.leaseId;
  const inFirefox = (await firefox.lease({ requestId: 'req_f', tabId: 3, origin: ORIGIN })).data.leaseId;
  const waiting = setup.hub.bridgeFor(inChromium).observe();
  await chromium.command();
  const rejected = rejectsWithCode(waiting, 'disconnected');
  chromium.close();
  await rejected;
  await until(() => setup.events.some(event => event.type === 'disconnected'));
  const disconnected = setup.events.filter(event => event.type === 'disconnected');
  assert.deepEqual(disconnected.map(event => event.browserId), [CHROMIUM.id]);
  assert.equal(setup.hub.lease(inChromium).status, 'paused');
  assert.equal(setup.hub.lease(inChromium).reason, 'disconnected');
  assert.equal(setup.hub.lease(inFirefox).status, 'active', 'the other browser keeps its tab');
  assert.equal(setup.hub.extension().connected, true);
  assert.deepEqual(setup.hub.extension().browsers.map(browser => browser.id), [FIREFOX.id]);
  const observed = setup.hub.bridgeFor(inFirefox).observe();
  firefox.result((await firefox.command()).id, { revision: 'ff:2' });
  assert.equal((await observed).revision, 'ff:2');
});

test('long-poll fallback with two browsers: each polls its own commands, pushes and requests', async t => {
  const setup = await hubServer(t);
  setup.hub.publishRequests([
    { requestId: 'req_c', state: 'pending', origins: [ORIGIN], browser: { id: CHROMIUM.id, name: 'Chromium' } },
    { requestId: 'req_f', state: 'pending', origins: [ORIGIN], browser: { id: FIREFOX.id, name: 'Firefox' } },
  ]);
  const chromiumHello = await setup.post(CHROMIUM, '/hello', { v: 3, ext: { version: '0.6.0' }, session: null,
    browser: { product: 'chromium', name: 'Chromium' } });
  const firefoxHello = await setup.post(FIREFOX, '/hello', { v: 3, ext: { version: '0.6.0' }, session: null,
    browser: { product: 'firefox', name: 'Firefox' } });
  assert.equal(chromiumHello.status, 200);
  assert.equal(firefoxHello.body.requests.length, 2, 'a current extension gets every request and marks them itself');
  assert.deepEqual(firefoxHello.body.browsers.map(browser => browser.name).sort(), ['Chromium', 'Firefox']);
  assert.deepEqual(setup.hub.extension().browsers.map(browser => browser.transport), ['longpoll', 'longpoll']);
  const inChromium = (await setup.post(CHROMIUM, '/lease', { requestId: 'req_c', tabId: 3, origin: ORIGIN })).body.leaseId;
  const inFirefox = (await setup.post(FIREFOX, '/lease', { requestId: 'req_f', tabId: 3, origin: ORIGIN })).body.leaseId;
  assert.equal(setup.hub.lease(inChromium).browserId, CHROMIUM.id);
  assert.equal(setup.hub.lease(inFirefox).browserId, FIREFOX.id);

  // A held Chromium poll is not woken by a Firefox command.
  const held = setup.post(CHROMIUM, '/commands?wait=3000');
  await until(() => setup.hub.stats().heldPolls === 1);
  const observe = setup.hub.bridgeFor(inFirefox).observe();
  const firefoxPoll = await setup.post(FIREFOX, '/commands?wait=1000');
  assert.equal(firefoxPoll.body.command.lease.requestId, 'req_f');
  assert.equal(setup.hub.stats().heldPolls, 1, 'Chromium is still waiting');
  await setup.post(FIREFOX, '/results', { id: firefoxPoll.body.command.id, result: { revision: 'ff:1' } });
  assert.equal((await observe).revision, 'ff:1');
  const chromiumObserve = setup.hub.bridgeFor(inChromium).observe();
  const woken = await held;
  assert.equal(woken.body.command.lease.requestId, 'req_c');
  await setup.post(CHROMIUM, '/results', { id: woken.body.command.id, result: { revision: 'cr:1' } });
  assert.equal((await chromiumObserve).revision, 'cr:1');

  // lease_update reaches the owner's outbox only.
  setup.hub.updateLease(inFirefox, 'released', 'superseded');
  const pushed = await setup.post(FIREFOX, '/commands?wait=500');
  assert.deepEqual(pushed.body.messages.map(message => message.leaseId), [inFirefox]);
  const other = await setup.post(CHROMIUM, '/commands?wait=0');
  assert.deepEqual(other.body.messages, []);
});

test('an older extension over the long-poll gets only the requests meant for it', async t => {
  const setup = await hubServer(t);
  const legacy = { id: null, origin: FIREFOX_ORIGIN };
  const legacyId = connectionIdentity(null, FIREFOX_ORIGIN).id;
  setup.hub.publishRequests([
    { requestId: 'req_c', state: 'pending', origins: [ORIGIN], browser: { id: CHROMIUM.id, name: 'Chromium' } },
    { requestId: 'req_f', state: 'pending', origins: [ORIGIN], browser: { id: legacyId, name: 'Firefox' } },
    { requestId: 'req_any', state: 'pending', origins: [ORIGIN], browser: null },
  ]);
  const hello = await setup.post(legacy, '/hello', { v: 3, ext: { version: '0.5.0' }, session: null });
  assert.deepEqual(hello.body.requests.map(request => request.requestId), ['req_f', 'req_any']);
  assert.equal(hello.body.browsers, undefined);
});

test('used and move reach the daemon with the sender\'s browser; an approval counts as use', async t => {
  const setup = await hubServer(t);
  const chromium = await setup.connect(CHROMIUM);
  await setup.hello(chromium, CHROMIUM);
  await sleep(5);
  const firefox = await setup.connect(FIREFOX);
  await setup.hello(firefox, FIREFOX);
  const lastUsed = () => pickBrowser(setup.hub.candidates()).browser.id;
  assert.equal(lastUsed(), FIREFOX.id, 'no use yet: the browser connected last');
  chromium.send('used');
  await until(() => setup.events.some(event => event.type === 'used'));
  assert.equal(setup.events.find(event => event.type === 'used').browserId, CHROMIUM.id);
  assert.equal(lastUsed(), CHROMIUM.id);
  await firefox.lease({ requestId: 'req_1', tabId: 2, origin: ORIGIN });
  assert.equal(lastUsed(), FIREFOX.id, 'the approval in Firefox');
  const moved = await chromium.request('move', { requestId: 'req_2' });
  assert.equal(moved.ok, true);
  const move = setup.events.find(event => event.type === 'move');
  assert.deepEqual({ requestId: move.requestId, browserId: move.browserId, browser: move.browser },
    { requestId: 'req_2', browserId: CHROMIUM.id, browser: { id: CHROMIUM.id, product: 'chromium', name: 'Chromium' } });
  // Over HTTP too.
  const http = await setup.post(FIREFOX, '/used', {});
  assert.equal(http.status, 200);
  assert.equal(lastUsed(), FIREFOX.id);
});

test('a reconnect loop shows as an extension_flapping warning and in the log', async t => {
  const setup = await hubServer(t, { flapLimit: 3, flapWindowMs: 5000 });
  for (let round = 0; round < 5; round++) {
    const ext = await setup.connect(FIREFOX);
    await setup.hello(ext, FIREFOX);
    ext.close();
    await until(() => setup.logs.filter(entry => entry.event === 'extension_ws_close').length === round + 1);
  }
  const warnings = setup.hub.warnings();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^extension_flapping: Firefox \(b-firefox00000000001\) lost its connection 5 times in 5 s/);
  assert.equal(setup.logs.filter(entry => entry.event === 'extension_flapping').length, 1, 'logged once');
  assert.equal(setup.hub.browsers().find(browser => browser.id === FIREFOX.id).closesLastMinute, 5);
});

test('pickBrowser: the agent\'s choice by product, name, alias or id; else the browser used last; errors list the connected', () => {
  const browsers = [
    { id: CHROMIUM.id, product: 'chromium', name: 'Chromium', usedAt: 200, connectedAt: 10 },
    { id: FIREFOX.id, product: 'firefox', name: 'Firefox', usedAt: 100, connectedAt: 20 },
    { id: 'b-chrome00000000000001', product: 'chrome', name: 'Chrome', usedAt: 0, connectedAt: 30 },
  ];
  assert.equal(pickBrowser(browsers).browser.id, CHROMIUM.id, 'used last');
  assert.equal(pickBrowser(browsers, 'firefox').browser.id, FIREFOX.id);
  assert.equal(pickBrowser(browsers, 'Firefox').browser.id, FIREFOX.id);
  assert.equal(pickBrowser(browsers, 'Google Chrome').browser.id, 'b-chrome00000000000001');
  assert.equal(pickBrowser(browsers, FIREFOX.id).browser.id, FIREFOX.id);
  assert.equal(pickBrowser(browsers.map(browser => ({ ...browser, usedAt: 0 }))).browser.id, 'b-chrome00000000000001',
    'never used: the one connected last');
  assert.equal(pickBrowser([]).browser, null);
  const unknown = pickBrowser(browsers, 'safari');
  assert.equal(unknown.error.code, 'browser_not_connected');
  assert.match(unknown.error.message, /No connected browser matches "safari"\. Connected: Chromium \(chromium\), Firefox \(firefox\), Chrome \(chrome\)/);
  assert.match(pickBrowser([], 'edge').error.message, /No browser with FAI Browser is connected/);
});

// --- the daemon with the real hub ------------------------------------------------------------------------------------

// A real daemon (agent driver) and two browsers over real WebSockets, each serving observes from its own page.
async function daemonWithBrowsers(t, { grace } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-multi-browser-'));
  const env = { FAI_BRIDGE_SECRET: SECRET, FAI_EXTENSION_ID: EXTENSION_ID };
  const daemon = createDaemon({ home, env, port: 0, sweepIntervalMs: 60_000, warm: false,
    ...(grace ? { hubFactory: options => createHub({ ...options, disconnectGraceMs: grace }) } : {}) });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  const client = new FaiBrowserClient({ port: daemon.port, token: daemon.token, clientName: 'multi' });
  const open = async browser => {
    const ext = await FakeExtension.connect({ port: daemon.port, origin: browser.origin, path: `/ext/ws?browser=${browser.id}` });
    t.after(() => ext.close());
    const hello = await ext.hello(null, { browser: { product: browser.product, name: browser.name, version: '1.0' } });
    assert.equal(hello.ok, true);
    const page = new FakeBridge();
    const served = [];
    (async () => {
      while (!ext.client.closed) {
        const command = await ext.command(5000).catch(() => null);
        if (!command) continue;
        served.push(command.lease.requestId);
        if (command.method === 'observe') ext.result(command.id, await page.observe());
        else ext.error(command.id, 'unsupported');
      }
    })();
    return { ext, served, browser };
  };
  return { daemon, client, open, home };
}

const latestRequests = async (ext, predicate) => (await ext.client.message(message => message.type === 'requests'
  && predicate(message))).requests;

test('daemon: a new request waits in the browser used last; the agent may name one; an unknown one is refused', async t => {
  const ctx = await daemonWithBrowsers(t);
  const chromium = await ctx.open(CHROMIUM);
  const firefox = await ctx.open(FIREFOX);
  const status = await ctx.client.status();
  assert.deepEqual(status.extension.browsers.map(browser => browser.name).sort(), ['Chromium', 'Firefox']);
  assert.deepEqual(status.browsers.map(browser => browser.id).sort(), [CHROMIUM.id, FIREFOX.id]);
  assert.ok(status.browsers.every(browser => browser.transport === 'websocket' && browser.connectedAt && browser.lastSeen));

  firefox.ext.send('used');
  await until(() => ctx.daemon.hub.candidates().some(browser => browser.id === FIREFOX.id && browser.usedAt));
  const first = await ctx.client.requestTab({ origins: [ORIGIN], reason: 'Check members' });
  assert.equal(first.request.browser.id, FIREFOX.id, 'the browser the user used FAI in last');
  assert.match(first.message, /approve this request in Firefox/);
  // Every popup lists it, marked with the browser it waits in.
  const inChromium = await latestRequests(chromium.ext, message => message.requests.some(view => view.requestId === first.requestId));
  assert.deepEqual(inChromium.find(view => view.requestId === first.requestId).browser,
    { id: FIREFOX.id, product: 'firefox', name: 'Firefox' });

  chromium.ext.send('used');
  await until(() => ctx.daemon.hub.candidates().find(browser => browser.id === CHROMIUM.id).usedAt > 0);
  const second = await ctx.client.requestTab({ origins: [ORIGIN], reason: 'Check members' });
  assert.equal(second.request.browser.id, CHROMIUM.id);
  const named = await ctx.client.requestTab({ origins: [ORIGIN], reason: 'Check members', browser: 'firefox' });
  assert.equal(named.request.browser.id, FIREFOX.id, 'the agent named it');
  await assert.rejects(ctx.client.requestTab({ origins: [ORIGIN], reason: 'Check members', browser: 'safari' }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'browser_not_connected');
    assert.match(error.message, /Connected: (Chromium \(chromium\), Firefox \(firefox\)|Firefox \(firefox\), Chromium \(chromium\))/);
    return true;
  });
});

test('daemon: Open here moves a pending request; both browsers hold tabs at once; one leaving pauses only its own', async t => {
  const ctx = await daemonWithBrowsers(t, { grace: 80 });
  const chromium = await ctx.open(CHROMIUM);
  const firefox = await ctx.open(FIREFOX);
  firefox.ext.send('used');
  await until(() => ctx.daemon.hub.candidates().some(browser => browser.id === FIREFOX.id && browser.usedAt));
  const forFirefox = await ctx.client.requestTab({ origins: [ORIGIN], reason: 'Firefox task' });
  const moving = await ctx.client.requestTab({ origins: [ORIGIN], reason: 'Moved task' });
  assert.equal(moving.request.browser.id, FIREFOX.id);
  // "Open here" in Chromium's popup.
  const moved = await chromium.ext.request('move', { requestId: moving.requestId });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.data.browser.id, CHROMIUM.id);
  assert.equal((await ctx.client.getRequest(moving.requestId)).browser.id, CHROMIUM.id);
  // A browser that used FAI later does not take it back: the user chose.
  firefox.ext.send('used');
  await sleep(30);
  assert.equal((await ctx.client.getRequest(moving.requestId)).browser.id, CHROMIUM.id);

  const inFirefox = await firefox.ext.lease({ requestId: forFirefox.requestId, tabId: 5, origin: ORIGIN });
  const inChromium = await chromium.ext.lease({ requestId: moving.requestId, tabId: 5, origin: ORIGIN });
  assert.equal(inFirefox.ok, true);
  assert.equal(inChromium.ok, true);
  const views = Object.fromEntries((await ctx.client.status()).requests.map(view => [view.requestId, view]));
  assert.equal(views[forFirefox.requestId].state, 'active', 'approving in Chromium did not supersede the Firefox tab');
  assert.equal(views[moving.requestId].state, 'active');
  assert.equal(views[forFirefox.requestId].lease.browserId, FIREFOX.id);
  assert.equal(views[moving.requestId].lease.browserId, CHROMIUM.id);

  // Each observe goes to the browser that holds that tab.
  await ctx.client.observe({ requestId: forFirefox.requestId });
  await ctx.client.observe({ requestId: moving.requestId });
  assert.deepEqual(firefox.served, [forFirefox.requestId]);
  assert.deepEqual(chromium.served, [moving.requestId]);
  const statusBrowsers = (await ctx.client.status()).browsers;
  assert.deepEqual(statusBrowsers.find(browser => browser.id === FIREFOX.id).leases.map(lease => lease.requestId),
    [forFirefox.requestId]);

  // Firefox's worker restarts (a hello without a session): only Firefox's tab pauses.
  const restarted = await FakeExtension.connect({ port: ctx.daemon.port, origin: FIREFOX.origin, path: `/ext/ws?browser=${FIREFOX.id}` });
  t.after(() => restarted.close());
  await restarted.hello(null, { browser: { product: 'firefox', name: 'Firefox' } });
  let current = Object.fromEntries((await ctx.client.status()).requests.map(view => [view.requestId, view]));
  assert.equal(current[forFirefox.requestId].state, 'paused');
  assert.equal(current[forFirefox.requestId].stateReason, 'session_inactive');
  assert.equal(current[moving.requestId].state, 'active');

  // Chromium goes away: its tab pauses as disconnected; nothing else changes.
  chromium.ext.close();
  await until(() => ctx.daemon.hub.candidates().every(browser => browser.id !== CHROMIUM.id), 'chromium gone', 3000);
  await sleep(30);
  current = Object.fromEntries((await ctx.client.status()).requests.map(view => [view.requestId, view]));
  assert.equal(current[moving.requestId].state, 'paused');
  assert.equal(current[moving.requestId].stateReason, 'disconnected');
  assert.equal(current[forFirefox.requestId].stateReason, 'session_inactive');
});

test('daemon: approving a second request in the same browser still supersedes the first there', async t => {
  const ctx = await daemonWithBrowsers(t);
  const chromium = await ctx.open(CHROMIUM);
  await ctx.open(FIREFOX);
  chromium.ext.send('used');
  await until(() => ctx.daemon.hub.candidates().some(browser => browser.id === CHROMIUM.id && browser.usedAt));
  const one = await ctx.client.requestTab({ origins: [ORIGIN], reason: 'One' });
  const two = await ctx.client.requestTab({ origins: [ORIGIN], reason: 'Two' });
  assert.equal((await chromium.ext.lease({ requestId: one.requestId, tabId: 1, origin: ORIGIN })).ok, true);
  assert.equal((await chromium.ext.lease({ requestId: two.requestId, tabId: 2, origin: ORIGIN })).ok, true);
  const first = await ctx.client.getRequest(one.requestId);
  assert.equal(first.state, 'released');
  assert.equal(first.stateReason, 'superseded');
});

test('daemon: a pending request waiting in a browser that leaves goes to the one still connected', async t => {
  const ctx = await daemonWithBrowsers(t, { grace: 60 });
  const chromium = await ctx.open(CHROMIUM);
  const firefox = await ctx.open(FIREFOX);
  firefox.ext.send('used');
  await until(() => ctx.daemon.hub.candidates().some(browser => browser.id === FIREFOX.id && browser.usedAt));
  const created = await ctx.client.requestTab({ origins: [ORIGIN], reason: 'Follows the user' });
  assert.equal(created.request.browser.id, FIREFOX.id);
  firefox.ext.close();
  await until(() => ctx.daemon.hub.candidates().length === 1, 'firefox gone', 3000);
  await sleep(20);
  assert.equal((await ctx.client.getRequest(created.requestId)).browser.id, CHROMIUM.id);
  const pushed = await latestRequests(chromium.ext, message => message.requests.some(view => view.requestId === created.requestId
    && view.browser?.id === CHROMIUM.id));
  assert.equal(pushed.length, 1);
});

test('MCP: fai_browser_open with an unknown browser names the connected ones; with a known one it opens there', async t => {
  const ctx = await daemonWithBrowsers(t);
  const chromium = await ctx.open(CHROMIUM);
  const firefox = await ctx.open(FIREFOX);
  chromium.ext.send('used');
  await until(() => ctx.daemon.hub.candidates().some(browser => browser.id === CHROMIUM.id && browser.usedAt));
  const mcp = spawnMcp({ PATH: process.env.PATH, HOME: ctx.home, FAI_HOME: ctx.home,
    FAI_DAEMON_PORT: String(ctx.daemon.port), FAI_MCP_MAX_CALL_MS: '6000', FAI_MCP_APPROVAL_WAIT_MS: '4000' });
  t.after(() => mcp.child.kill('SIGKILL'));
  await mcp.initialize();
  const tools = (await mcp.request('tools/list', {})).result.tools;
  assert.equal(tools.find(tool => tool.name === 'fai_browser_open').inputSchema.properties.browser.type, 'string');

  const refused = await mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Read the page', task: 'Read it',
    browser: 'safari' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /browser_not_connected/);
  assert.match(refused.content[0].text, /Chromium \(chromium\)/);
  assert.match(refused.content[0].text, /Firefox \(firefox\)/);

  // Firefox approves the request meant for it as soon as it is listed there (the user's click).
  (async () => {
    const views = await latestRequests(firefox.ext, message => message.requests.some(view => view.state === 'pending'
      && view.browser?.id === FIREFOX.id));
    const view = views.find(item => item.state === 'pending' && item.browser?.id === FIREFOX.id);
    await firefox.ext.lease({ requestId: view.requestId, tabId: 4, origin: ORIGIN });
  })();
  const opened = await mcp.callTool('fai_browser_open', { origins: [ORIGIN], reason: 'Read the page', task: 'Read it',
    browser: 'firefox' });
  assert.equal(opened.isError, undefined, opened.content[0].text);
  assert.match(opened.content[0].text, /^granted: read-only.*; browser: Firefox$/m);
  assert.equal(firefox.served.length > 0, true, 'the observe went to Firefox');
  assert.deepEqual(chromium.served, []);
  const status = await mcp.callTool('fai_browser_status', {});
  assert.match(status.content[0].text, /^browser: Firefox \(firefox, id b-firefox00000000001\), websocket/m);
  assert.match(status.content[0].text, /^request: req_\S+ active read-only, origins https:\/\/example\.com, in Firefox$/m);
});
