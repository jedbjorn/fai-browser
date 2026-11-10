// MCP loop stopper (docs/design/OVERSIGHT-SPEC.md section 3): the per-request call budget (config.json maxCalls)
// over the open/observe/act loop. Stub daemon only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startStubDaemon } from './helpers/stub-daemon.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';

const ORIGIN = 'https://example.com';
const ONE_CALL = { origins: [ORIGIN], reason: 'Check the members list' };

async function setup(t, behavior = {}, { config, env: extraEnv = {} } = {}) {
  const stub = await startStubDaemon({ autoGrant: true, ...behavior });
  const env = stub.env(extraEnv);
  if (config) await writeFile(join(env.FAI_HOME, 'config.json'), JSON.stringify(config));
  const mcp = spawnMcp(env);
  t.after(async () => {
    mcp.child.kill('SIGKILL');
    await stub.close();
  });
  await mcp.initialize();
  return { stub, mcp };
}

test('the call budget per requestId: config.json maxCalls, then a task_budget receipt that never reaches the daemon', async t => {
  const { stub, mcp } = await setup(t, {}, { config: { budget: { maxCalls: 2 } } });
  const opened = mcpData(await mcp.callTool('fai_browser_open', { ...ONE_CALL, task: 'Read the members' }));
  assert.equal(opened.status, 'observed');
  const acted = await mcp.callTool('fai_browser_act', { actionId: 'a0', revision: opened.revision });
  assert.notEqual(acted.isError, true, JSON.stringify(acted.content));
  const actsBefore = stub.callsTo('POST', '/v1/act').length;
  const observesBefore = stub.callsTo('POST', '/v1/observe').length;
  const refusedResult = await mcp.callTool('fai_browser_observe', {});
  const refused = mcpData(refusedResult);
  assert.equal(refusedResult.isError, undefined);
  assert.equal(refused.code, 'task_budget');
  assert.equal(refused.next.kind, 'stop');
  const again = mcpData(await mcp.callTool('fai_browser_act', { actionId: 'a0', revision: opened.revision }));
  assert.equal(again.code, 'task_budget');
  assert.equal(stub.callsTo('POST', '/v1/act').length, actsBefore, 'a refused act never reaches the daemon');
  assert.equal(stub.callsTo('POST', '/v1/observe').length, observesBefore, 'a refused observe never reaches the daemon');
});
