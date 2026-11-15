// Test endpoints only: a unique Windows named pipe or a short Unix socket path in a private temporary directory.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function pipeOrSocket(t, name = 'test.sock') {
  const dir = await mkdtemp(join(tmpdir(), 'fai-ipc-'));
  const path = process.platform === 'win32'
    ? `\\\\.\\pipe\\fai-test-${process.pid}-${randomBytes(8).toString('hex')}-${name}`
    : join(dir, name);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { path, dir };
}
