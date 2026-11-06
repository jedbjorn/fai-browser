import test from 'node:test';
import assert from 'node:assert/strict';
import { startStubDaemon } from './helpers/stub-daemon.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData } from './helpers/mcp-result.js';
const ORIGIN = 'https://example.com';
test('suggestion instruction dedupes despite expectation changes and resets on new request', async t => {
  const suggestions = [
    { instruction: 'Visit Pricing', expectation: { urlIncludes: '/pricing' } },
    { instruction: 'VISIT pricing!', expectation: { textIncludes: 'Prices' } },
    { instruction: 'Visit Team', expectation: { urlIncludes: '/team' } },
    { instruction: 'Visit Pricing', expectation: { urlIncludes: '/pricing' } },
  ];
  let n = 0;
  const stub = await startStubDaemon({ autoGrant: true, finalStatus: 'needs_host', finalCode: 'no_progress', finalExtra: () => ({ v: 2, verdict: { kind: 'needs_decision', oversight: 'instruct', answer: null, why: ['no_progress'], decide: null, suggested: suggestions[n++], budget: null }, next: { kind: 'rerun', text: 'x' } }) });
  const mcp = spawnMcp(stub.env());
  t.after(async () => { mcp.child.kill('SIGKILL'); await stub.close(); });
  await mcp.initialize();
  const first = await mcp.callTool('fai_browser_run', { origins: [ORIGIN], reason: 'Read prices', instruction: 'Read the pricing summary', maxCalls: 6 });
  assert.equal(mcpData(first).verdict.suggested.instruction, 'Visit Pricing');
  const second = await mcp.callTool('fai_browser_run', { instruction: 'Read the current page prices' });
  assert.ok(!mcpData(second).verdict.suggested?.instruction, 'same instruction with different expectation must not be suggested again');
  const third = await mcp.callTool('fai_browser_run', { instruction: 'Read the people on this page' });
  assert.equal(mcpData(third).verdict.suggested.instruction, 'Visit Team');
  stub.setRequestState(stub.requests.keys().next().value, 'released');
  const fourth = await mcp.callTool('fai_browser_run', { origins: [ORIGIN], reason: 'New task', instruction: 'Find prices on the new request' });
  assert.equal(mcpData(fourth).verdict.suggested.instruction, 'Visit Pricing');
});
