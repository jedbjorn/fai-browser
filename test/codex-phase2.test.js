import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, legalActions } from '../src/runtime.js';
import { leanObserve } from '../src/result.js';
import { TypeSafeProvider } from '../src/typesafe.js';
import { FrameParser } from '../src/ws.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';
import { startStubDaemon } from './helpers/stub-daemon.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpError } from './helpers/mcp-result.js';

test('codex: supplied values in instruction and answer question are redacted in actual provider requests', async () => {
  const value = 'private-person-4819';
  const payloads = [];
  const provider = new TypeSafeProvider({ requireKey: false, fetchImpl: async (_, options) => {
    payloads.push(JSON.parse(options.body));
    const body = payloads.at(-1);
    const answers = body.questions.answer
      ? { answer: { choice: Object.keys(body.questions.answer.criteria)[0] } }
      : { action: { choice: 'handoff' }, done: { noul: 0.9 } };
    return new Response(JSON.stringify({ answers }));
  } });
  const result = await new BrowserRuntime({ bridge: new FakeBridge({ path: '/members' }), provider }).run(
    `Read the members list for ${value}`, {
      suppliedText: { person: value }, answerQuestion: `Which member matches ${value}?`,
      expectation: { urlIncludes: '/members' }, capture: 'none',
    });
  assert.equal(result.status, 'completed');
  assert.equal(payloads.length, 2, 'both decide and choose were exercised');
  for (const body of payloads) assert.ok(!JSON.stringify(body).includes(value), 'supplied value reached provider');
});

test('codex: passing expectation on the final no-op action beats no_progress', async () => {
  let actions = 0;
  const bridge = new FakeBridge();
  const execute = bridge.execute.bind(bridge);
  bridge.execute = async (...args) => { actions++; return execute(...args); };
  const provider = { decide: async (_, offered) => ({
    actionId: offered.find(action => action.type === 'wait').id, done: { probability: 0.1 },
  }) };
  const result = await new BrowserRuntime({ bridge, provider }).run('Wait for the task', {
    maxActions: 3, capture: 'none', expectation: () => actions === 3,
  });
  assert.equal(result.steps.length, 3);
  assert.equal(result.verification.passed, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.code, 'budget_reached_expectation_passed');
});

test('codex: lean observe stays under 40 with many new-tab navigation controls', () => {
  const observation = { url: ORIGIN, revision: 'r', controls: Array.from({ length: 100 }, (_, i) => ({
    id: String(i + 1), role: 'link', label: `Link ${i}`, href: `${ORIGIN}/page${i}`, linkTarget: '_blank',
  })) };
  const actions = legalActions(observation, { allowedUrls: [`${ORIGIN}/explicit`] });
  const lean = leanObserve({ page: observation, actions });
  assert.ok(lean.actions.length <= 40, `got ${lean.actions.length} actions`);
  for (const action of actions.filter(a => a.type === 'scroll' || a.type === 'wait' || a.url?.endsWith('/explicit'))) {
    assert.ok(lean.actions.some(a => a.id === action.id), `lost page action ${action.id}`);
  }
  assert.equal(lean.moreActions, actions.length - lean.actions.length);
});

test('codex: WebSocket rejects non-minimal extended payload lengths', () => {
  // Masked, FIN text frames containing "x", encoded illegally with a 16- or 64-bit length instead of 7 bits.
  for (const frame of [
    Buffer.from([0x81, 0xfe, 0, 1, 0, 0, 0, 0, 0x78]),
    Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0x78]),
  ]) {
    assert.throws(() => new FrameParser().push(frame), error => error.closeCode === 1002);
  }
});

test('codex: WebSocket rejects the reserved high length bit as a protocol error', () => {
  const header = Buffer.from([0x81, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0]);
  assert.throws(() => new FrameParser().push(header), error => error.closeCode === 1002);
});

test('codex: MCP rejects invalid expectations before requesting user approval', async t => {
  const stub = await startStubDaemon();
  const mcp = spawnMcp(stub.env({ FAI_MCP_MAX_CALL_MS: '500' }));
  t.after(async () => { await mcp.close(); await stub.close(); });
  await mcp.initialize();
  for (const expectation of [{ urlMatches: '[' }, { changedSinceStart: false }]) {
    const result = await mcp.callTool('fai_browser_run', {
      origins: [ORIGIN], reason: 'Read members', instruction: 'Read members', expectation,
    });
    assert.equal(result.isError, true);
    assert.equal(mcpError(result).code, 'invalid_params');
  }
  assert.equal(stub.callsTo('POST', '/v1/requests').length, 0, 'invalid expectation triggered a tab request');
});
