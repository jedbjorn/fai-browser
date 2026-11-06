import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError, PROTOCOL_VERSION } from '../src/bridge.js';
import { createCompanion } from '../bench/companion.js';

const extensionId = 'a'.repeat(32);
const secret = 'secret-pairing-token-123456789';
const origin = 'https://example.com';
const headers = {
  Origin: `chrome-extension://${extensionId}`,
  Authorization: `Bearer ${secret}`,
  'Content-Type': 'application/json',
};

// Starts a companion and returns helpers that act as the extension.
async function setup(options = {}) {
  const companion = createCompanion({ port: 0, extensionId, secret, allowedOrigins: [origin], ...options });
  const address = await companion.listen();
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path, body, extraHeaders = headers) => fetch(base + path, {
    method: 'POST',
    headers: extraHeaders,
    body: JSON.stringify(body),
  });
  const json = async (path, body) => (await post(path, body)).json();
  const poll = async (wait = 0) => (await json(`/commands?wait=${wait}`, {})).command;
  const lease = () => json('/lease', { tabId: 1, origin });
  return { companion, base, post, json, poll, lease };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof BridgeError, `expected BridgeError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

test('authenticated selected-tab bridge, strict origins, cancellation and lease isolation', async () => {
  const { companion, base, post, json, poll, lease } = await setup();
  try {
    assert.equal((await post('/lease', { tabId: 1, origin }, { ...headers, Origin: 'https://evil.test' })).status, 403);
    assert.equal((await post('/lease', { tabId: 1, origin }, { ...headers, Authorization: `Bearer ${'x'.repeat(secret.length)}` })).status, 403);
    assert.equal((await fetch(base + '/lease', { method: 'OPTIONS', headers: { Origin: headers.Origin } })).status, 200);
    assert.equal((await post('/lease', { tabId: 1, origin: 'https://evil.test' })).status, 403);
    const granted = await lease();
    assert.equal((await post('/lease', { tabId: 2, origin })).status, 409);

    const observe = companion.bridge.observe();
    const command = await poll();
    assert.equal(command.version, PROTOCOL_VERSION);
    assert.equal(command.method, 'observe');
    assert.deepEqual(command.allowedOrigins, [origin]);
    assert.equal(command.lease.id, granted.id);
    await post('/results', { id: command.id, result: { revision: 'doc:1' } });
    assert.deepEqual(await observe, { revision: 'doc:1' });

    const controller = new AbortController();
    const action = companion.bridge.execute({ type: 'click', target: '1' }, 'doc:1', { capture: true }, controller.signal);
    const pending = await poll();
    // No level from the caller: the lease's grant (an extension that sends none gets the Phase 1 ceiling, reversible).
    assert.deepEqual(pending.args, { action: { type: 'click', target: '1' }, expectedRevision: 'doc:1', capture: true, level: 'reversible' });
    controller.abort(new Error('cancelled'));
    await assert.rejects(action, /cancelled/);
    assert.deepEqual(await json('/validate', { id: pending.id, leaseId: granted.id }), { valid: false });
    assert.equal(companion.status().pendingScreenshots, 0);
  } finally {
    await companion.close();
  }
});

test('long-poll is woken by a queued command and times out empty', async () => {
  const { companion, poll, post, lease } = await setup();
  try {
    await lease();
    const started = Date.now();
    assert.equal(await poll(150), null);
    assert.ok(Date.now() - started >= 140, 'empty long-poll should be held for the wait');

    const held = poll(20_000);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(companion.status().polling, true);
    const queuedAt = Date.now();
    const observe = companion.bridge.observe();
    const command = await held;
    assert.ok(Date.now() - queuedAt < 500, 'long-poll should answer as soon as a command is queued');
    assert.equal(command.method, 'observe');
    await post('/results', { id: command.id, result: { revision: 'doc:1' } });
    await observe;
  } finally {
    await companion.close();
  }
});

test('long-poll wait is clamped and close releases held polls', async () => {
  const { companion, poll, lease } = await setup();
  await lease();
  const held = poll(999_999);
  await new Promise(resolve => setTimeout(resolve, 50));
  await companion.close();
  assert.equal(await held.catch(() => null), null);
});

test('execute resolves on the observation; the screenshot arrives separately', async () => {
  const { companion, poll, post, lease } = await setup();
  try {
    await lease();
    const execution = companion.bridge.execute({ type: 'scroll', direction: 'down' }, 'doc:1', { capture: true });
    const command = await poll();
    assert.equal(companion.status().pendingScreenshots, 1);
    const observation = { revision: 'doc:2', url: origin + '/', controls: [] };
    await post('/results', { id: command.id, result: { observation, settle: { reason: 'quiet', ms: 60 } } });
    const result = await execution;
    assert.deepEqual(result.observation, observation);
    assert.deepEqual(result.settle, { reason: 'quiet', ms: 60 });
    assert.ok(result.screenshot instanceof Promise);
    let settled = false;
    result.screenshot.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(settled, false, 'screenshot must not be resolved before it arrives');
    const dataUrl = 'data:image/jpeg;base64,aGVsbG8=';
    await post('/screenshots', { id: command.id, screenshot: { dataUrl, revision: 'doc:2', format: 'jpeg', ms: 40 } });
    assert.deepEqual(await result.screenshot, { dataUrl, revision: 'doc:2', format: 'jpeg', ms: 40 });
    assert.equal(companion.status().pendingScreenshots, 0);

    // Capture failure reported by the extension.
    const failing = companion.bridge.execute({ type: 'wait' }, 'doc:2', { capture: true });
    const second = await poll();
    await post('/results', { id: second.id, result: { observation, settle: { reason: 'none', ms: 500 } } });
    const failed = await failing;
    await post('/screenshots', { id: second.id, error: { code: 'capture_failed', message: 'tab hidden' } });
    assert.deepEqual(await failed.screenshot, { error: { code: 'capture_failed', message: 'tab hidden' } });

    // A screenshot that beats its result is kept.
    const early = companion.bridge.execute({ type: 'wait' }, 'doc:2');
    const third = await poll();
    await post('/screenshots', { id: third.id, screenshot: { dataUrl, revision: 'doc:2', format: 'jpeg' } });
    await post('/results', { id: third.id, result: { observation, settle: { reason: 'none', ms: 500 } } });
    assert.equal((await (await early).screenshot).revision, 'doc:2');

    // capture: false resolves null without reserving a slot.
    const silent = companion.bridge.execute({ type: 'wait' }, 'doc:2', { capture: false });
    const fourth = await poll();
    assert.equal(fourth.args.capture, false);
    assert.equal(companion.status().pendingScreenshots, 0);
    await post('/results', { id: fourth.id, result: { observation, settle: { reason: 'none', ms: 500 } } });
    assert.equal(await (await silent).screenshot, null);
  } finally {
    await companion.close();
  }
});

test('capture command returns the screenshot from /results; extension errors reject as BridgeError', async () => {
  const { companion, poll, post, lease } = await setup();
  try {
    await lease();
    const details = { action: { type: 'click', target: '1' }, target: { id: '1', label: 'About' }, fromUrl: origin + '/' };
    const capture = companion.bridge.capture(details);
    const command = await poll();
    assert.equal(command.method, 'capture');
    assert.deepEqual(command.args, details);
    const dataUrl = 'data:image/jpeg;base64,aGVsbG8=';
    await post('/results', { id: command.id, result: { screenshot: { dataUrl, revision: 'doc:4' } } });
    assert.deepEqual(await capture, { dataUrl, revision: 'doc:4', format: 'jpeg' });

    const failing = companion.bridge.capture(details);
    const rejected = rejectsWithCode(failing, 'capture_failed');
    const second = await poll();
    await post('/results', { id: second.id, error: { code: 'capture_failed', message: 'tab hidden' } });
    await rejected;
    assert.equal(companion.status().status, 'active');
  } finally {
    await companion.close();
  }
});

test('missing screenshot resolves capture_failed timeout and never rejects', async () => {
  const { companion, poll, post, lease } = await setup({ screenshotTimeoutMs: 80 });
  try {
    await lease();
    const execution = companion.bridge.execute({ type: 'wait' }, 'doc:1', { capture: true });
    const command = await poll();
    await post('/results', { id: command.id, result: { observation: { revision: 'doc:1' }, settle: { reason: 'none', ms: 500 } } });
    const { screenshot } = await execution;
    assert.deepEqual(await screenshot, { error: { code: 'capture_failed', message: 'timeout' } });
    assert.equal(companion.status().pendingScreenshots, 0);
  } finally {
    await companion.close();
  }
});

test('extension error codes map to BridgeError; recoverable errors keep the lease active', async () => {
  const { companion, poll, post, lease } = await setup();
  try {
    await lease();
    const cases = [
      ['stale', true],
      ['target_unavailable', true],
      ['cross_origin', false],
      ['blocked_risky', false],
      ['child_tab', false],
      ['made_up_code', false],
    ];
    for (const [code, recoverable] of cases) {
      const execution = companion.bridge.execute({ type: 'click', target: '1' }, 'doc:1', { capture: true });
      const outcome = assert.rejects(execution, error => {
        assert.ok(error instanceof BridgeError);
        assert.equal(error.code, code === 'made_up_code' ? 'unsupported' : code);
        assert.equal(error.recoverable, recoverable);
        return true;
      });
      const command = await poll();
      await post('/results', { id: command.id, error: { code, message: `${code} happened`, recoverable } });
      await outcome;
      assert.equal(companion.status().status, 'active', `${code} must not pause the lease`);
      assert.equal(companion.status().pendingScreenshots, 0);
    }
    assert.equal(new BridgeError('capture_failed', 'x').recoverable, true);
    assert.equal(new BridgeError('stopped', 'x').recoverable, false);
  } finally {
    await companion.close();
  }
});

test('status changes map to paused, stopped and session codes for pending and future requests', async () => {
  const { companion, poll, post, lease } = await setup();
  try {
    await rejectsWithCode(companion.bridge.observe(), 'session_inactive');
    assert.equal(companion.status().status, 'none');

    await lease();
    const waiting = companion.bridge.observe();
    await poll();
    const rejected = rejectsWithCode(waiting, 'paused');
    await post('/status', { status: 'paused', reason: 'paused' });
    await rejected;
    await rejectsWithCode(companion.bridge.observe(), 'paused');

    await lease();
    const stopping = rejectsWithCode(companion.bridge.observe(), 'stopped');
    await post('/status', { status: 'stopped', reason: 'stopped' });
    await stopping;
    await rejectsWithCode(companion.bridge.observe(), 'stopped');
    assert.equal(companion.status().status, 'stopped');

    for (const reason of ['tab_changed', 'origin_changed', 'child_tab', 'session_inactive']) {
      await lease();
      await post('/status', { status: 'paused', reason });
      await rejectsWithCode(companion.bridge.observe(), reason);
      assert.equal(companion.status().reason, reason);
    }
  } finally {
    await companion.close();
  }
});

test('waitForLease and onLease report a lease without polling for Enter', async () => {
  const { companion, lease, post } = await setup();
  try {
    await rejectsWithCode(companion.waitForLease({ timeoutMs: 30 }), 'timeout');
    const controller = new AbortController();
    const aborted = assert.rejects(companion.waitForLease({ signal: controller.signal }), /stop waiting/);
    controller.abort(new Error('stop waiting'));
    await aborted;

    const seen = [];
    const unsubscribe = companion.onLease(snapshot => seen.push(snapshot.status));
    const waiting = companion.waitForLease({ timeoutMs: 5000 });
    const granted = await lease();
    const ready = await waiting;
    assert.equal(ready.status, 'active');
    assert.equal(ready.id, granted.id);
    assert.deepEqual(seen, ['active']);
    // Already active resolves immediately.
    assert.equal((await companion.waitForLease({ timeoutMs: 1 })).id, granted.id);

    await post('/status', { status: 'paused' });
    await lease();
    assert.deepEqual(seen, ['active', 'active']);
    unsubscribe();
    await post('/status', { status: 'paused' });
    await lease();
    assert.equal(seen.length, 2);
  } finally {
    await companion.close();
  }
});

test('lease expires as disconnected without requests, but an open long-poll keeps it alive', async () => {
  const { companion, poll, lease } = await setup({ leaseTimeoutMs: 120 });
  try {
    await lease();
    const held = poll(600);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(companion.status().status, 'active', 'held long-poll counts as liveness');
    assert.equal(await held, null);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(companion.status().status, 'paused');
    assert.equal(companion.status().reason, 'disconnected');
    await rejectsWithCode(companion.bridge.observe(), 'disconnected');
  } finally {
    await companion.close();
  }
});

test('a dropped long-poll without a re-poll marks the lease disconnected after the grace period', async () => {
  const { companion, base, lease } = await setup({ disconnectGraceMs: 80 });
  try {
    await lease();
    const controller = new AbortController();
    const held = fetch(base + '/commands?wait=20000', { method: 'POST', headers, body: '{}', signal: controller.signal })
      .catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.abort();
    await held;
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(companion.status().status, 'paused');
    await rejectsWithCode(companion.bridge.observe(), 'disconnected');
  } finally {
    await companion.close();
  }
});

test('commands time out and close rejects pending work as disconnected', async () => {
  const { companion, poll, lease } = await setup({ commandTimeoutMs: 300 });
  try {
    await lease();
    await rejectsWithCode(companion.bridge.observe(), 'timeout');
    const pending = companion.bridge.execute({ type: 'wait' }, 'doc:1');
    await poll();
    const closing = companion.close();
    await rejectsWithCode(pending, 'disconnected');
    await closing;
    await rejectsWithCode(companion.bridge.observe(), 'disconnected');
  } finally {
    await companion.close();
  }
});
