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

// The bound is 10000 calls (src/settings.js BUDGET_LIMITS). The stub answers in about a millisecond per call, so these
// drive the ledger with real observe calls past the old 500 bound.
async function observeTimes(mcp, count) {
  const codes = new Map();
  for (let i = 0; i < count; i += 1) {
    const seen = mcpData(await mcp.callTool('fai_browser_observe', {}));
    const key = seen.code ?? seen.status;
    codes.set(key, (codes.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(codes);
}

test('a 10000-call ceiling the daemon reports keeps the request running past 500 calls', async t => {
  const { stub, mcp } = await setup(t, { budget: { maxCalls: 10_000, maxMs: 14_400_000, source: 'extension' } });
  const opened = mcpData(await mcp.callTool('fai_browser_open', { ...ONE_CALL, task: 'Read the members' }));
  assert.equal(opened.status, 'observed');
  const before = stub.callsTo('POST', '/v1/observe').length;
  assert.deepEqual(await observeTimes(mcp, 510), { observed: 510 });
  assert.equal(stub.callsTo('POST', '/v1/observe').length, before + 510, 'every call reached the daemon');
});

test('a ceiling above 500 is enforced at its own count: the call after the last is refused', async t => {
  const { stub, mcp } = await setup(t, { budget: { maxCalls: 520, maxMs: 14_400_000, source: 'extension' } });
  mcpData(await mcp.callTool('fai_browser_open', { ...ONE_CALL, task: 'Read the members' }));
  // The open was call 1; 519 more fill the budget, the last ones naming how few are left.
  const last = [];
  for (let i = 0; i < 519; i += 1) {
    const seen = mcpData(await mcp.callTool('fai_browser_observe', {}));
    assert.equal(seen.status, 'observed', `call ${i + 2}`);
    if (i >= 515) last.push(seen.callsLeft);
  }
  assert.deepEqual(last, [3, 2, 1, 0]);
  const observes = stub.callsTo('POST', '/v1/observe').length;
  const refused = mcpData(await mcp.callTool('fai_browser_observe', {}));
  assert.equal(refused.code, 'task_budget');
  assert.equal(stub.callsTo('POST', '/v1/observe').length, observes, 'the refused call never reached the daemon');
});

test('against a daemon that reports no budget, config.json maxCalls 10000 applies and 10001 falls back to the default 50', async t => {
  const { mcp } = await setup(t, {}, { config: { budget: { maxCalls: 10_000 } } });
  mcpData(await mcp.callTool('fai_browser_open', { ...ONE_CALL, task: 'Read the members' }));
  assert.deepEqual(await observeTimes(mcp, 505), { observed: 505 });
  const over = await setup(t, {}, { config: { budget: { maxCalls: 10_001 } } });
  mcpData(await over.mcp.callTool('fai_browser_open', { ...ONE_CALL, task: 'Read the members' }));
  assert.deepEqual(await observeTimes(over.mcp, 50), { observed: 49, task_budget: 1 });
});
