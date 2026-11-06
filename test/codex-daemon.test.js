import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDaemon, runDaemon } from '../src/daemon.js';
import { call, createFakeHub } from './helpers/fake-hub.js';
import { ORIGIN } from './runtime-fixtures.js';

test('codex: popup Release on a paused request releases the lease through deny', async t => {
  const home = await mkdtemp(join(tmpdir(), 'codex-daemon-'));
  const hub = createFakeHub();
  const daemon = createDaemon({ driver: 'jev', home, port: 0, hub, env: { FAI_BRIDGE_SECRET: 'test-pairing-'.repeat(4) } });
  t.after(async () => { await daemon.close(); await rm(home, { recursive: true, force: true }); });
  await daemon.listen();
  const created = await call(daemon.port, 'POST', '/v1/requests', {
    origins: [ORIGIN], reason: 'Read the page',
  }, { token: daemon.token });
  const requestId = created.body.requestId;
  const { leaseId } = await hub.approve(requestId);
  await hub.emit({ type: 'status', leaseId, status: 'paused', reason: 'paused' });
  assert.equal(daemon.request(requestId).state, 'paused');
  // popup.js labels this button "Release" but sends the same deny message as the pending-request button.
  const reply = await hub.emit({ type: 'deny', requestId });
  assert.equal(reply.error, undefined);
  assert.equal(daemon.request(requestId).state, 'released');
  assert.equal(hub.lease(leaseId).state, 'released');
});

test('codex: a second runDaemon in the same process cannot take the live lock', async t => {
  const home = await mkdtemp(join(tmpdir(), 'codex-singleton-'));
  const options = {
    home, handleSignals: false,
    env: { FAI_DAEMON_PORT: '0', FAI_BRIDGE_SECRET: 'test-pairing-'.repeat(4) },
    daemonOptions: { hubFactory: () => createFakeHub() },
  };
  const first = await runDaemon(options);
  let second;
  t.after(async () => {
    await second?.stop?.();
    await first.stop();
    await rm(home, { recursive: true, force: true });
  });
  second = await runDaemon(options);
  assert.equal(second.status, 'already_running');
  assert.equal(second.port, first.port);
});
