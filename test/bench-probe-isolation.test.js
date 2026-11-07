import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedEnv, probeEnvironment, mcpProbe } from '../bench/fai-condition.mjs';

test('benchmark probe preserves explicit settings roots without inheriting unrelated credentials', () => {
  const parent = { PATH: '/bin', HOME: '/home/test', FAI_HOME: '/tmp/selected-bench',
    UNRELATED_CREDENTIAL: 'synthetic-do-not-forward' };
  assert.deepEqual(probeEnvironment({}, parent), { PATH: '/bin', HOME: '/home/test', FAI_HOME: '/tmp/selected-bench' });
  assert.equal(probeEnvironment({ FAI_HOME: '/tmp/override' }, parent).FAI_HOME, '/tmp/override');
  assert.equal(isolatedEnv('/tmp/run-daemon', 4319, 'synthetic', parent).FAI_HOME, '/tmp/selected-bench');
  const isolated = isolatedEnv('/tmp/run-daemon', 4319, 'synthetic', {});
  assert.equal(isolated.FAI_HOME, '/tmp/run-daemon/settings');
  assert.equal(Object.hasOwn(isolated, 'HOME'), false, 'never repurpose the host HOME');
});

test('real MCP tools/list discovers only the selected benchmark driver, without starting a daemon', async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'fai-probe-isolation-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const server = { command: process.execPath, args: [new URL('../src/mcp-main.js', import.meta.url).pathname] };
  for (const driver of ['agent', 'jev']) {
    const home = join(scratch, driver);
    await mkdir(home);
    await writeFile(join(home, 'config.json'), JSON.stringify({ driver }));
    const probe = await mcpProbe(server, { env: isolatedEnv(join(home, 'daemon'), 1, 'synthetic', { FAI_HOME: home }) });
    assert.equal(probe.ok, true, probe.error);
    assert.equal(probe.tools.includes('fai_browser_open'), driver === 'agent');
    assert.equal(probe.tools.includes('fai_browser_run'), driver === 'jev');
  }
});
