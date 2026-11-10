import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FaiBrowserClient, FaiClientError, ensureDaemon } from '../src/client.js';

test('ensureDaemon without autoStart reports an unreachable daemon', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-client-none-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(ensureDaemon({ home, env: { FAI_DAEMON_PORT: '0' }, autoStart: false }),
    error => error instanceof FaiClientError && error.code === 'daemon_unreachable');
  const closed = new FaiBrowserClient({ port: 1, token: 'x' });
  await assert.rejects(closed.health(), error => error.code === 'daemon_unreachable' && error.retryable);
});
