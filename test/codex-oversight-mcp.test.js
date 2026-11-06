import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startStubDaemon } from './helpers/stub-daemon.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData, mcpError } from './helpers/mcp-result.js';

async function setup(t, behavior = {}, config) {
  const stub = await startStubDaemon({ autoGrant: true, ...behavior });
  if (config) await writeFile(join(stub.home, 'config.json'), JSON.stringify(config));
  const mcp = spawnMcp(stub.env());
  t.after(async () => { mcp.child.kill('SIGKILL'); await stub.close(); });
  await mcp.initialize();
  return { stub, mcp };
}
const args = { origins: ['https://example.com'], reason: 'Test oversight', instruction: 'Read Members' };

test('codex oversight: MCP forwards zero minConfidence to the daemon', async t => {
  const { stub, mcp } = await setup(t);
  await mcp.callTool('fai_browser_run', { ...args, minConfidence: 0 });
  assert.equal(stub.callsTo('POST', '/v1/runs')[0].body.minConfidence, 0);
});

test('codex oversight: next is the first text line for run and observe', async t => {
  const { mcp } = await setup(t);
  const run = await mcp.callTool('fai_browser_run', args);
  assert.match(run.content[0].text, /^next \([a-z_]+\):/);
  const observed = await mcp.callTool('fai_browser_observe');
  assert.match(observed.content[0].text, /^next \(choose\):/);
});

test('codex oversight: reordering expectation keys does not bypass identical-call refusal', async t => {
  const { stub, mcp } = await setup(t, { finalStatus: 'needs_host', finalCode: 'handoff' });
  await mcp.callTool('fai_browser_run', { ...args, expectation: { urlIncludes: '/members', textIncludes: 'Ada' } });
  const repeat = await mcp.callTool('fai_browser_run', {
    ...args, expectation: { textIncludes: 'Ada', urlIncludes: '/members' },
  });
  assert.equal(repeat.isError, true);
  assert.equal(mcpError(repeat).code, 'invalid_params');
  assert.equal(stub.callsTo('POST', '/v1/runs').length, 1);
});

test('codex oversight: seventh run is refused before it reaches the daemon', async t => {
  const { stub, mcp } = await setup(t);
  // The host asks for 6 calls on this request (the default is 50); the ask holds for the request.
  for (let i = 0; i < 6; i++) await mcp.callTool('fai_browser_run', { ...args, instruction: `Read Members ${i}`, ...(i === 0 ? { maxCalls: 6 } : {}) });
  const seventh = await mcp.callTool('fai_browser_run', { ...args, instruction: 'Read Members 6' });
  assert.equal(mcpData(seventh).status, 'budget_exhausted');
  assert.equal(mcpData(seventh).code, 'task_budget');
  assert.equal(stub.callsTo('POST', '/v1/runs').length, 6);
});

test('codex oversight: status and evidence responses each carry a next instruction', async t => {
  const { mcp } = await setup(t);
  const status = await mcp.callTool('fai_browser_status');
  const run = await mcp.callTool('fai_browser_run', args);
  const evidence = await mcp.callTool('fai_browser_evidence', { runId: mcpData(run).runId, kind: 'trace' });
  for (const [name, response] of [['status', status], ['evidence', evidence]]) {
    const next = mcpData(response).next;
    assert.equal(typeof next, 'object', `${name} has no next instruction`);
    assert.equal(typeof next.text, 'string');
    assert.match(response.content[0].text, /^next \([a-z_]+\):/);
  }
});

for (const source of ['call', 'config']) {
  test(`codex oversight: ${source} maxMs bounds an in-flight run, not just the next call`, async t => {
    const { mcp } = await setup(t, { steps: 2, stepMs: 800 }, source === 'config' ? { budget: { maxMs: 1000 } } : undefined);
    const started = Date.now();
    const result = await mcp.callTool('fai_browser_run', { ...args, ...(source === 'call' ? { maxMs: 1000 } : {}) });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `a 1000 ms task budget allowed ${elapsed} ms of work`);
    assert.equal(mcpData(result).status, 'budget_exhausted');
    assert.equal(mcpData(result).code, 'task_budget');
  });
}
