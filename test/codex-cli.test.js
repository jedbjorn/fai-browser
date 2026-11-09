import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRIDGE_ERROR_CODES } from '../src/bridge.js';
import { outcomeResult } from '../src/result.js';

// The CLI validates an options file before it contacts the daemon (--no-auto-start: none is running here).
async function cli(t, overrides) {
  const home = await mkdtemp(join(tmpdir(), 'codex-cli-'));
  await writeFile(join(home, 'config.json'), JSON.stringify({ driver: 'jev' }));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'options.json');
  await writeFile(path, JSON.stringify({
    allowedOrigins: ['https://example.com'], provider: 'local',
    providerOptions: { endpoint: 'http://127.0.0.1:1/v1/systemone' },
    leaseTimeoutMs: 50, ...overrides,
  }));
  const child = spawn(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'run', 'Go', path, '--no-auto-start'], {
    env: { PATH: process.env.PATH, FAI_HOME: home, FAI_DAEMON_PORT: '9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI hung')); }, 5000);
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(stdout.trim().split('\n').length, 1);
  return { code, result: JSON.parse(stdout), stderr };
}

test('codex: CLI rejects invalid expectations before requesting a tab', async t => {
  const { code, result, stderr } = await cli(t, { expectation: { urlMatches: '[' } });
  assert.equal(code, 1);
  assert.equal(result.code, 'config');
  assert.doesNotMatch(stderr, /ACTION NEEDED/);
});

test('codex: every BridgeError code has the expected result status', () => {
  const expected = {
    stale: 'needs_host', target_unavailable: 'needs_host', capture_failed: 'needs_host',
    unsupported: 'needs_host', timeout: 'failed', stopped: 'stopped',
    blocked_risky: 'needs_user', cross_origin: 'needs_user', child_tab: 'needs_user',
    tab_changed: 'needs_user', origin_changed: 'needs_user', session_inactive: 'needs_user',
    disconnected: 'needs_user', paused: 'needs_user',
    no_control: 'needs_host', point_outside: 'needs_host', point_frame: 'needs_host',
    js_dialog: 'needs_user', line_break_input: 'needs_host',
  };
  assert.deepEqual(Object.keys(expected).sort(), [...BRIDGE_ERROR_CODES].sort());
  for (const [bridgeCode, status] of Object.entries(expected)) {
    const result = outcomeResult(bridgeCode);
    assert.equal(result.code, bridgeCode);
    assert.equal(result.status, status, bridgeCode);
  }
});
