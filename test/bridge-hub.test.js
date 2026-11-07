// The extension transport hub (src/bridge.js createHub) in daemon mode over the WebSocket and the long-poll
// fallback, plus the harness companion (bench/companion.js) over the WebSocket.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BridgeError, PROTOCOL_VERSION, createHub } from '../src/bridge.js';
import { createCompanion } from '../bench/companion.js';
import {
  EXTENSION_ID, EXTENSION_ORIGIN, FakeExtension, SECRET, connectRaw, fixtureObservation,
} from './helpers/fake-extension.js';

const ORIGIN = 'https://example.com';
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

// A daemon-mode hub on its own server, with a recorded event log and a tiny request manager that binds
// lease events for known requests.
async function daemon(t, options = {}) {
  const logs = [];
  const hub = createHub({
    secret: SECRET,
    extensionId: EXTENSION_ID,
    mode: 'daemon',
    log: (event, fields) => logs.push({ event, ...fields }),
    ...options,
  });
  const server = http.createServer((req, res) => {
    if (hub.handleHttp(req, res)) return;
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (!hub.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const events = [];
  const requests = new Map([['req_1', { requestId: 'req_1', state: 'pending', origins: [ORIGIN] }]]);
  let leaseSequence = 0;
  hub.onEvent(event => {
    events.push(event);
    if (event.type === 'hello') {
      const known = event.session && hub.lease(event.session.leaseId);
      if (known && event.session.status === 'active') hub.updateLease(known.leaseId, 'active');
      event.reply({ mode: 'daemon', daemonVersion: '0.2.0', endSession: Boolean(event.session) && !known });
    } else if (event.type === 'lease') {
      const request = requests.get(event.requestId);
      if (!request) return event.reply({ error: { code: 'no_request', message: 'Unknown request' } });
      if (!request.origins.includes(event.origin)) {
        return event.reply({ error: { code: 'origin_not_requested', message: 'Not requested', origins: request.origins } });
      }
      const leaseId = `lease-${++leaseSequence}`;
      hub.bindLease({ leaseId, requestId: request.requestId, tabId: event.tabId, origin: event.origin, allowedOrigins: request.origins });
      request.state = 'active';
      event.reply({ leaseId, requestId: request.requestId });
    } else if (event.type === 'deny') {
      requests.get(event.requestId).state = 'denied';
      event.reply({ ok: true });
    } else if (event.type === 'settings') {
      // Like the daemon: the budget in effect (the setting when valid, else a default).
      event.reply({ budget: event.settings.budget ? { ...event.settings.budget, source: 'extension' }
        : { maxCalls: 50, maxMs: 1_200_000, source: 'default' } });
    }
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const post = async (path, body = {}) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { Origin: EXTENSION_ORIGIN, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    hub.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  });
  const extension = async () => {
    const ext = await FakeExtension.connect({ port });
    t.after(() => ext.close());
    return ext;
  };
  return { hub, port, base, post, events, requests, logs, extension };
}

// Connects, says hello and gets a lease for req_1. Returns the extension and the bridge for that lease.
async function leased(t, setup) {
  const ext = await setup.extension();
  await ext.hello();
  const reply = await ext.lease({ requestId: 'req_1', tabId: 7, origin: ORIGIN });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return { ext, leaseId: reply.data.leaseId, bridge: setup.hub.bridgeFor(reply.data.leaseId) };
}

test('hello reply, requests snapshot pushed after hello and on every change', async t => {
  const setup = await daemon(t);
  setup.hub.publishRequests([{ requestId: 'req_1', state: 'pending', origins: [ORIGIN], reason: 'Check members' }]);
  const ext = await setup.extension();
  const hello = await ext.hello();
  assert.deepEqual(hello, { v: 3, type: 'reply', ref: '1', ok: true, data: { mode: 'daemon', daemonVersion: '0.2.0', endSession: false } });
  const first = await ext.client.message(message => message.type === 'requests');
  assert.equal(first.requests[0].requestId, 'req_1');
  setup.hub.publishRequests([{ requestId: 'req_1', state: 'pending', origins: [ORIGIN], reason: 'Check members' }]);
  setup.hub.publishRequests([]);
  const next = await ext.client.message(message => message.type === 'requests');
  assert.deepEqual(next.requests, [], 'an unchanged snapshot is not re-sent');
  assert.deepEqual(setup.hub.extension().transport, 'websocket');
  assert.equal(setup.events.filter(event => event.type === 'connected').length, 1);
  ext.send('ping');
  await ext.client.message(message => message.type === 'pong');
  assert.ok(!JSON.stringify(setup.logs).includes(SECRET), 'logs never contain the secret');
});

test('lease events bind the clicked tab to a requestId; errors carry codes and origins', async t => {
  const setup = await daemon(t);
  const ext = await setup.extension();
  await ext.hello();
  const wrongOrigin = await ext.lease({ requestId: 'req_1', origin: 'https://evil.test' });
  assert.deepEqual(wrongOrigin.error, { code: 'origin_not_requested', message: 'Not requested', origins: [ORIGIN] });
  const unknown = await ext.lease({ requestId: 'req_nope' });
  assert.equal(unknown.error.code, 'no_request');
  const bad = await ext.request('lease', { requestId: 'req_1', origin: ORIGIN });
  assert.equal(bad.error.code, 'bad_request');
  const ok = await ext.lease({ requestId: 'req_1', tabId: 7, origin: ORIGIN, title: 'Members' });
  assert.deepEqual(ok.data, { leaseId: 'lease-1', requestId: 'req_1' });
  const event = setup.events.find(e => e.type === 'lease' && e.requestId === 'req_1' && e.origin === ORIGIN);
  assert.equal(event.title, 'Members');
  assert.deepEqual(setup.hub.lease('lease-1'), {
    leaseId: 'lease-1', requestId: 'req_1', tabId: 7, origin: ORIGIN, allowedOrigins: [ORIGIN],
    status: 'active', state: 'active', reason: null,
  });
  const denied = await ext.request('deny', { requestId: 'req_1' });
  assert.equal(denied.ok, true);
  assert.equal(setup.requests.get('req_1').state, 'denied');
});

test('observations keep their blocks through the hub, on observe and after execute', async t => {
  const setup = await daemon(t);
  const { ext, bridge } = await leased(t, setup);
  const page = fixtureObservation('/about', { revision: 'doc:1' });
  assert.deepEqual(page.blocks, [
    { t: 'h1', text: 'About' },
    { t: 'p', text: 'About us' },
    { t: 'a', text: 'Members', ref: '1' },
    { t: 'a', text: 'Home', ref: '2' },
  ]);

  const observe = bridge.observe();
  ext.result((await ext.command()).id, page);
  const observed = await observe;
  assert.deepEqual(observed.blocks, page.blocks);
  assert.equal(observed.blocksTruncated, false);

  const execution = bridge.execute({ type: 'click', target: '1' }, 'doc:1', { capture: false });
  const after = fixtureObservation('/members', { revision: 'doc:2' });
  ext.result((await ext.command()).id, { observation: after, settle: { reason: 'load_complete', ms: 40 } });
  assert.deepEqual((await execution).observation.blocks, after.blocks);
});

test('queued extra-tab commands cannot survive a grant downgrade before delivery', async t => {
  const setup = await daemon(t);
  setup.hub.bindLease({ leaseId: 'queued-tabs', tabId: 7, origin: ORIGIN, allowedOrigins: [ORIGIN], tabMode: 'multiple' });
  const command = setup.hub.bridgeFor('queued-tabs').execute({ type: 'open_tab', url: ORIGIN }, 'r1', { capture: false });
  const denied = assert.rejects(command, error => error.code === 'blocked_risky');
  setup.hub.setLeaseTabMode('queued-tabs', 'single');
  const reply = await setup.post('/commands?wait=0', {});
  assert.equal(reply.body.command ?? null, null);
  await denied;
});

test('commands are pushed over the WebSocket; results and screenshots route by id', async t => {
  const setup = await daemon(t);
  const { ext, bridge } = await leased(t, setup);

  const observe = bridge.observe();
  const command = await ext.command();
  assert.equal(command.version, PROTOCOL_VERSION);
  assert.equal(command.method, 'observe');
  assert.deepEqual(command.lease, { id: 'lease-1', tabId: 7, requestId: 'req_1', tabMode: 'single' });
  assert.deepEqual(command.allowedOrigins, [ORIGIN]);
  ext.result(command.id, { revision: 'doc:1' });
  assert.deepEqual(await observe, { revision: 'doc:1' });

  const execution = bridge.execute({ type: 'click', target: '1' }, 'doc:1', { capture: true });
  const execute = await ext.command();
  assert.deepEqual(execute.args, { action: { type: 'click', target: '1' }, expectedRevision: 'doc:1', capture: true });
  const valid = await ext.request('validate', { id: execute.id, leaseId: 'lease-1' });
  assert.deepEqual(valid.data, { valid: true });
  // The screenshot beats the result and is kept.
  const dataUrl = 'data:image/jpeg;base64,aGVsbG8=';
  ext.send('screenshot', { id: execute.id, screenshot: { dataUrl, revision: 'doc:2', format: 'jpeg', ms: 30 } });
  ext.result(execute.id, { observation: { revision: 'doc:2' }, settle: { reason: 'quiet', ms: 50 } });
  const result = await execution;
  assert.deepEqual(result.settle, { reason: 'quiet', ms: 50 });
  assert.deepEqual(await result.screenshot, { dataUrl, revision: 'doc:2', format: 'jpeg', ms: 30 });

  const observation = bridge.capture({ action: null });
  const capture = await ext.command();
  assert.equal(capture.method, 'capture');
  assert.deepEqual(capture.args, { action: null });
  ext.result(capture.id, { screenshot: { dataUrl, revision: 'doc:2' } });
  assert.equal((await observation).revision, 'doc:2');

  const failing = bridge.execute({ type: 'click', target: '2' }, 'doc:2');
  const rejected = rejectsWithCode(failing, 'stale');
  ext.error((await ext.command()).id, 'stale');
  await rejected;
  assert.equal(setup.hub.stats().pendingScreenshots, 0);
});

test('an aborted delivered command is cancelled on the extension and no longer validates', async t => {
  const setup = await daemon(t);
  const { ext, bridge } = await leased(t, setup);
  const controller = new AbortController();
  const action = bridge.execute({ type: 'click', target: '1' }, 'doc:1', { capture: true }, controller.signal);
  const command = await ext.command();
  controller.abort(new Error('cancelled by host'));
  await assert.rejects(action, /cancelled by host/);
  const cancel = await ext.client.message(message => message.type === 'cancel');
  assert.equal(cancel.id, command.id);
  assert.deepEqual((await ext.request('validate', { id: command.id, leaseId: 'lease-1' })).data, { valid: false });
  // A late result for it is dropped.
  ext.result(command.id, { observation: {}, settle: {} });
  assert.equal(setup.hub.stats().pendingCommands, 0);
});

test('extension status reports end the lease and emit a status event', async t => {
  const setup = await daemon(t);
  const { ext, bridge } = await leased(t, setup);
  const waiting = bridge.observe();
  await ext.command();
  const rejected = rejectsWithCode(waiting, 'tab_changed');
  ext.send('status', { leaseId: 'lease-1', status: 'paused', reason: 'tab_changed' });
  await rejected;
  await rejectsWithCode(bridge.observe(), 'tab_changed');
  const event = setup.events.find(e => e.type === 'status');
  assert.deepEqual({ ...event }, { type: 'status', leaseId: 'lease-1', requestId: 'req_1', status: 'paused', reason: 'tab_changed' });
});

test('updateLease pushes lease_update, fails pending commands with the code, and can reactivate', async t => {
  const setup = await daemon(t);
  const { ext, bridge } = await leased(t, setup);
  const waiting = bridge.observe();
  await ext.command();
  const rejected = rejectsWithCode(waiting, 'paused');
  setup.hub.updateLease('lease-1', 'paused', 'paused');
  await rejected;
  const update = await ext.client.message(message => message.type === 'lease_update');
  assert.deepEqual(update, { v: 3, type: 'lease_update', requestId: 'req_1', leaseId: 'lease-1', state: 'paused', reason: 'paused' });
  setup.hub.updateLease('lease-1', 'active');
  const resumed = bridge.observe();
  ext.result((await ext.command()).id, { revision: 'doc:9' });
  assert.equal((await resumed).revision, 'doc:9');
  setup.hub.updateLease('lease-1', 'released', 'superseded');
  await rejectsWithCode(bridge.observe(), 'stopped');
  assert.equal(setup.hub.updateLease('missing', 'released'), false);
});

test('socket loss: commands wait for a reconnect within the grace period, else fail as disconnected', async t => {
  const setup = await daemon(t, { disconnectGraceMs: 150 });
  const first = await leased(t, setup);
  first.ext.close();
  await until(() => !setup.hub.stats().polling);
  // Queued while disconnected; delivered after the new socket's hello resumes the lease.
  const observe = first.bridge.observe();
  await sleep(30);
  assert.equal(setup.hub.stats().queuedCommands, 1);
  const second = await setup.extension();
  await second.hello({ requestId: 'req_1', leaseId: 'lease-1', tabId: 7, origin: ORIGIN, status: 'active' });
  second.result((await second.command()).id, { revision: 'doc:3' });
  assert.equal((await observe).revision, 'doc:3');
  assert.equal(setup.events.some(e => e.type === 'disconnected'), false, 'a blip within the grace is not a disconnect');

  const pending = first.bridge.observe();
  await second.command();
  const rejected = rejectsWithCode(pending, 'disconnected');
  second.close();
  await rejected;
  assert.equal(setup.hub.lease('lease-1').status, 'paused');
  assert.equal(setup.hub.lease('lease-1').reason, 'disconnected');
  assert.deepEqual(setup.events.filter(e => e.type === 'disconnected').map(e => e.transport), ['websocket']);
  assert.equal(setup.hub.extension().connected, false);
});

test('hello semantics: the daemon decides endSession; without listeners a stale session is ended', async t => {
  const setup = await daemon(t);
  const ext = await setup.extension();
  const unknown = await ext.hello({ requestId: 'req_1', leaseId: 'lease-x', tabId: 1, origin: ORIGIN, status: 'active' });
  assert.equal(unknown.data.endSession, true);
  const hello = setup.events.find(e => e.type === 'hello');
  assert.deepEqual(hello.session, { requestId: 'req_1', leaseId: 'lease-x', tabId: 1, origin: ORIGIN, status: 'active' });

  const bare = createHub({ secret: SECRET, extensionId: EXTENSION_ID });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => bare.handleUpgrade(req, socket, head));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    bare.close();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  });
  const lonely = await FakeExtension.connect({ port: server.address().port });
  t.after(() => lonely.close());
  assert.deepEqual((await lonely.hello({ leaseId: 'x', status: 'active' })).data, { mode: 'daemon', endSession: true });
  assert.equal((await lonely.lease({ requestId: 'req_1' })).error.code, 'no_request');
  const wrongVersion = await (async () => {
    lonely.client.send({ v: 2, type: 'hello', ref: 'old' });
    return lonely.client.message(message => message.ref === 'old');
  })();
  assert.equal(wrongVersion.error.code, 'unsupported_protocol');
});

test('a newer connection replaces the older one with close code 4000; setSecret closes with 4001', async t => {
  const setup = await daemon(t);
  const older = await setup.extension();
  await older.hello();
  const newer = await setup.extension();
  await newer.hello();
  const close = await older.client.next(event => event.type === 'close');
  assert.equal(close.code, 4000);
  assert.equal(setup.hub.extension().transport, 'websocket');
  setup.hub.setSecret('another-pairing-secret-1234567890');
  assert.equal((await newer.client.next(event => event.type === 'close')).code, 4001);
  const stale = await connectRaw({ port: setup.port });
  assert.equal(stale.status, 403, 'the old secret no longer authenticates');
});

test('long-poll fallback: hello over HTTP, v3 commands plus requests, pushes in messages', async t => {
  const setup = await daemon(t);
  setup.hub.publishRequests([{ requestId: 'req_1', state: 'pending', origins: [ORIGIN] }]);
  const hello = await setup.post('/hello', { v: 3, ext: { version: '0.3.0', protocol: 3 }, session: null });
  assert.equal(hello.status, 200);
  assert.equal(hello.body.mode, 'daemon');
  assert.equal(hello.body.requests[0].requestId, 'req_1');
  assert.equal(setup.hub.extension().transport, 'longpoll');

  // A held poll is woken by a requests change.
  const held = setup.post('/commands?wait=5000');
  await until(() => setup.hub.stats().heldPolls === 1);
  setup.hub.publishRequests([{ requestId: 'req_1', state: 'pending', origins: [ORIGIN], reason: 'changed' }]);
  const woken = await held;
  assert.equal(woken.body.command, null);
  assert.equal(woken.body.requests[0].reason, 'changed');

  const lease = await setup.post('/lease', { requestId: 'req_1', tabId: 3, origin: ORIGIN });
  assert.deepEqual(lease.body, { leaseId: 'lease-1', requestId: 'req_1' });
  const refused = await setup.post('/lease', { requestId: 'req_missing', tabId: 3, origin: ORIGIN });
  assert.equal(refused.status, 404);
  assert.equal(refused.body.code, 'no_request');

  const bridge = setup.hub.bridgeFor('lease-1');
  const observe = bridge.observe();
  const polled = await setup.post('/commands?wait=1000');
  assert.equal(polled.body.command.version, 3);
  assert.equal(polled.body.command.lease.requestId, 'req_1');
  assert.deepEqual(polled.body.messages, []);
  await setup.post('/results', { id: polled.body.command.id, result: { revision: 'doc:1' } });
  assert.deepEqual(await observe, { revision: 'doc:1' });

  setup.hub.updateLease('lease-1', 'released', 'superseded');
  const pushed = await setup.post('/commands?wait=1000');
  assert.deepEqual(pushed.body.messages, [
    { v: 3, type: 'lease_update', requestId: 'req_1', leaseId: 'lease-1', state: 'released', reason: 'superseded' },
  ]);
});

test('long-poll: a dropped poll without a re-poll is a disconnect after the grace period', async t => {
  const setup = await daemon(t, { disconnectGraceMs: 80 });
  await setup.post('/hello', { session: null });
  await setup.post('/lease', { requestId: 'req_1', tabId: 3, origin: ORIGIN });
  const controller = new AbortController();
  const held = fetch(`${setup.base}/commands?wait=20000`, {
    method: 'POST',
    headers: { Origin: EXTENSION_ORIGIN, Authorization: `Bearer ${SECRET}` },
    body: '{}',
    signal: controller.signal,
  }).catch(() => null);
  await until(() => setup.hub.stats().heldPolls === 1);
  controller.abort();
  await held;
  await until(() => setup.events.some(e => e.type === 'disconnected'));
  assert.equal(setup.hub.lease('lease-1').reason, 'disconnected');
});

test('createCompanion over the WebSocket: legacy start, restart pauses, blip resumes', async t => {
  const companion = createCompanion({ port: 0, extensionId: EXTENSION_ID, secret: SECRET, allowedOrigins: [ORIGIN] });
  const { port } = await companion.listen();
  t.after(() => companion.close());
  const ext = await FakeExtension.connect({ port });
  assert.deepEqual((await ext.hello()).data, { mode: 'companion', endSession: false });
  assert.equal((await ext.lease({ requestId: 'req_1' })).error.code, 'no_request');
  assert.equal((await ext.lease({ origin: 'https://evil.test' })).error.code, 'origin_not_requested');
  const waiting = companion.waitForLease({ timeoutMs: 2000 });
  const granted = await ext.lease({ tabId: 4 });
  assert.equal(granted.data.leaseId, granted.data.id);
  assert.equal((await waiting).id, granted.data.leaseId);
  assert.equal((await ext.lease({ tabId: 5 })).error.code, 'request_not_pending');
  assert.equal(companion.status().transport, 'websocket');

  const observe = companion.bridge.observe();
  ext.result((await ext.command()).id, { revision: 'doc:1' });
  assert.deepEqual(await observe, { revision: 'doc:1' });

  // Socket blip: the same worker reconnects with its session and keeps the lease.
  ext.close();
  const again = await FakeExtension.connect({ port });
  t.after(() => again.close());
  const session = { requestId: null, leaseId: granted.data.leaseId, tabId: 4, origin: ORIGIN, status: 'active' };
  assert.equal((await again.hello(session)).data.endSession, false);
  assert.equal(companion.status().status, 'active');

  // Worker restart: hello without a session pauses the lease as session_inactive.
  const restarted = await FakeExtension.connect({ port });
  t.after(() => restarted.close());
  assert.equal((await restarted.hello(null)).data.endSession, false);
  assert.equal(companion.status().status, 'paused');
  assert.equal(companion.status().reason, 'session_inactive');
  await rejectsWithCode(companion.bridge.observe(), 'session_inactive');
});

test('command level: clamped to the lease grant; none means the grant; an unknown string means read-only', async t => {
  const setup = await daemon(t);
  const ext = await setup.extension();
  await ext.hello();
  setup.hub.bindLease({ leaseId: 'lease-x', requestId: 'req_1', tabId: 7, origin: ORIGIN, allowedOrigins: [ORIGIN], level: 'reversible' });
  const bridge = setup.hub.bridgeFor('lease-x');
  const levelOf = async (options) => {
    const pending = bridge.observe(undefined, options);
    const command = await ext.command();
    ext.result(command.id, { revision: 'doc:1' });
    await pending;
    return command.args.level;
  };
  assert.equal(await levelOf({ level: 'testing' }), 'reversible', 'the host cannot raise the grant');
  assert.equal(await levelOf({ level: 'read-only' }), 'read-only', 'a run may lower it');
  assert.equal(await levelOf({}), 'reversible', 'no level: the user grant');
  assert.equal(await levelOf({ level: 'TESTING' }), 'read-only', 'an unknown level string fails closed');
  assert.equal(await levelOf({ level: 'admin' }), 'read-only');
});

test('hello and settings messages carry the popup budget setting; the hub keeps it and emits settings events', async t => {
  const setup = await daemon(t);
  const ext = await setup.extension();
  await ext.hello(null, { settings: { budget: { maxCalls: 12, maxMs: 600_000 } } });
  const hello = setup.events.find(event => event.type === 'hello');
  assert.deepEqual(hello.settings, { budget: { maxCalls: 12, maxMs: 600_000 } });
  assert.deepEqual(setup.hub.extension().settings, { budget: { maxCalls: 12, maxMs: 600_000 } });
  // Out of bounds or malformed: no budget (the daemon's own default applies).
  const reply = await ext.request('settings', { settings: { budget: { maxCalls: 0, maxMs: 600_000 } } });
  assert.equal(reply.ok, true);
  const event = setup.events.find(entry => entry.type === 'settings');
  assert.deepEqual(event.settings, { budget: null });
  assert.deepEqual(setup.hub.extension().settings, { budget: null });
  const cleared = await ext.request('settings', { settings: { budget: null } });
  assert.equal(cleared.ok, true);
  // Over HTTP too (the long-poll fallback).
  const http = await setup.post('/settings', { v: 3, settings: { budget: { maxCalls: 3, maxMs: 90_000 } } });
  assert.equal(http.status, 200);
  assert.deepEqual(setup.hub.extension().settings, { budget: { maxCalls: 3, maxMs: 90_000 } });
});

test('settings carry "Open requested pages right away" only when reported as a boolean (an older extension does not)', async () => {
  const { sanitizeSettings } = await import('../src/bridge.js');
  assert.deepEqual(sanitizeSettings({ budget: null, openRightAway: true }), { budget: null, openRightAway: true });
  assert.deepEqual(sanitizeSettings({ budget: { maxCalls: 3, maxMs: 90_000 }, openRightAway: false }),
    { budget: { maxCalls: 3, maxMs: 90_000 }, openRightAway: false });
  assert.deepEqual(sanitizeSettings({ budget: null, openRightAway: 'yes' }), { budget: null });
  assert.deepEqual(sanitizeSettings({ budget: null }), { budget: null });
});
