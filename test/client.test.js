import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon } from '../src/daemon.js';
import { FaiBrowserClient, FaiClientError, ensureDaemon } from '../src/client.js';
import { ORIGIN, clickProvider } from './runtime-fixtures.js';
import { createFakeHub } from './helpers/fake-hub.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function setup(t, { decideMs = 0 } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'fai-client-'));
  const hub = createFakeHub();
  const providerFactory = () => {
    const inner = clickProvider(['About', 'Members']);
    return {
      model: 'fake',
      async decide(...args) {
        await delay(decideMs);
        return inner.decide(...args);
      },
    };
  };
  const daemon = createDaemon({ driver: 'jev', home, env: {}, port: 0, hub, providerFactory, sweepIntervalMs: 60_000 });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  });
  const env = { FAI_DAEMON_PORT: String(daemon.port) };
  const client = await FaiBrowserClient.connect({ home, env, autoStart: false, clientName: 'client-test' });
  return { home, hub, daemon, client, env };
}

test('SDK: request a tab, wait for approval, run to completion, evidence, runs, release', async t => {
  const { hub, client, daemon } = await setup(t);
  assert.equal(client.port, daemon.port);
  assert.deepEqual(client.warnings, []);
  assert.equal((await client.health()).service, 'fai-browser');

  const tab = await client.requestTab({ origins: [ORIGIN], reason: 'SDK test', instruction: 'Open Members' });
  assert.equal(tab.state, 'pending');
  assert.equal(tab.request.client, 'client-test');
  setTimeout(() => hub.approve(tab.requestId), 50);
  const waited = await client.waitForTab(tab.requestId, { timeoutMs: 5000 });
  assert.equal(waited.state, 'active');

  const done = await client.run({
    requestId: tab.requestId, instruction: 'Open Members', expectation: { textIncludes: 'Grace' },
  });
  assert.equal(done.state, 'done');
  assert.equal(done.result.status, 'completed');
  assert.equal((await client.getRun(done.runId)).result.code, 'expectation_passed');
  const evidence = await client.evidence(done.runId, { inline: true });
  assert.equal(evidence.data, 'YQ==');
  const trace = await client.evidence(done.runId, { kind: 'trace' });
  assert.equal(trace.trace.runId, done.runId);
  assert.equal((await client.runs({ limit: 5 })).runs[0].runId, done.runId);

  const status = await client.status();
  assert.equal(status.requests[0].requestId, tab.requestId);
  assert.equal((await client.listRequests()).requests.length, 1);
  assert.equal((await client.getRequest(tab.requestId)).state, 'active');
  assert.deepEqual(await client.release(tab.requestId, 'finished'), { requestId: tab.requestId, state: 'released' });
});

test('SDK: run loops wait past waitMs and reports progress; step and observe/act', async t => {
  const { hub, client } = await setup(t, { decideMs: 120 });
  const { requestId } = await client.requestTab({ origins: [ORIGIN], reason: 'loop' });
  await hub.approve(requestId);
  const progress = [];
  const done = await client.run({
    requestId, instruction: 'Find members', waitMs: 10, expectation: { textIncludes: 'Ada' },
  }, { onProgress: entry => progress.push(entry.steps) });
  assert.equal(done.state, 'done');
  assert.equal(done.result.status, 'completed');
  assert.ok(progress.length >= 1, 'progress reported while running');

  const step = await client.step({ requestId, instruction: 'Go home' });
  assert.equal(step.state, 'done');
  assert.equal(step.result.steps.length <= 1, true);

  const observed = await client.observe({ requestId });
  assert.equal(observed.state, 'ok');
  const link = observed.actions.find(action => action.type === 'click');
  const acted = await client.act({ requestId, actionId: link.id, revision: observed.revision });
  assert.equal(acted.state, 'done');
  // Lean results carry no decision records; a host-chosen action has no provider confidence.
  assert.equal(acted.result.steps[0].action.type, 'click');
  assert.equal(acted.result.steps[0].confidence, undefined);
});

test('SDK: aborting a run stops it; HTTP errors throw FaiClientError with the code', async t => {
  const { hub, client } = await setup(t, { decideMs: 300 });
  const { requestId } = await client.requestTab({ origins: [ORIGIN], reason: 'abort' });
  await hub.approve(requestId);
  const controller = new AbortController();
  const running = client.run({ requestId, instruction: 'Open About', waitMs: 10 }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('caller gave up')), 60);
  await assert.rejects(running, /caller gave up|aborted/i);
  const runs = (await client.runs({ requestId })).runs;
  const final = await client.wait({ runId: runs[0].runId, maxMs: 5000 });
  assert.equal(final.result.code, 'cancelled');

  await assert.rejects(client.getRequest('req_missing'), error => error instanceof FaiClientError
    && error.status === 404 && error.code === 'unknown_request');
  await assert.rejects(client.run({ requestId, instruction: 'x', mode: 'superuser' }),
    error => error.status === 400 && error.code === 'invalid_options');
  const stranger = new FaiBrowserClient({ port: client.port, token: '0'.repeat(64) });
  await assert.rejects(stranger.status(), error => error.status === 401 && error.code === 'unauthorized');
});

test('ensureDaemon without autoStart reports an unreachable daemon', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-client-none-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(ensureDaemon({ home, env: { FAI_DAEMON_PORT: '0' }, autoStart: false }),
    error => error instanceof FaiClientError && error.code === 'daemon_unreachable');
  const closed = new FaiBrowserClient({ port: 1, token: 'x' });
  await assert.rejects(closed.health(), error => error.code === 'daemon_unreachable' && error.retryable);
});
