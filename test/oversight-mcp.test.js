// MCP loop stoppers (docs/design/OVERSIGHT-SPEC.md section 3): the per-request call budget (maxCalls/maxMs, config.json), the
// identical-call refusal and the call-time expectation lint. Stub daemon only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startStubDaemon } from './helpers/stub-daemon.js';
import { spawnMcp } from './helpers/mcp-harness.js';
import { mcpData, mcpError } from './helpers/mcp-result.js';
import { MISSING_EXPECTATION_HINT } from '../src/mcp.js';

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

test('the call budget per requestId: maxCalls runs, then a task_budget receipt with next stop', async t => {
  const { stub, mcp } = await setup(t, { finalStatus: 'needs_host', finalCode: 'handoff' });
  const first = mcpData(await mcp.callTool('fai_browser_run', { ...ONE_CALL, instruction: 'Open Members 1', maxCalls: 2 }));
  assert.deepEqual(first.verdict.budget.callsUsed, 1);
  assert.equal(first.verdict.budget.callsLeft, 1);
  assert.equal(first.next.kind, 'rerun');
  const second = mcpData(await mcp.callTool('fai_browser_run', { instruction: 'Open Members 2' }));
  assert.equal(second.verdict.budget.callsLeft, 0);
  assert.equal(second.next.kind, 'stop', 'no call left: a rerun becomes stop');
  const runsBefore = stub.callsTo('POST', '/v1/runs').length;
  const refusedResult = await mcp.callTool('fai_browser_run', { instruction: 'Open Members 3' });
  const refused = mcpData(refusedResult);
  assert.equal(refusedResult.isError, undefined);
  assert.equal(refused.status, 'budget_exhausted');
  assert.equal(refused.code, 'task_budget');
  assert.equal(refused.next.kind, 'stop');
  assert.match(refused.text, /^next \(stop\): The call budget for this request is used up/m);
  assert.equal(stub.callsTo('POST', '/v1/runs').length, runsBefore, 'the refused call never reaches the daemon');
  const observe = mcpData(await mcp.callTool('fai_browser_observe', {}));
  assert.equal(observe.code, 'task_budget', 'observe and act count against the same budget');
});

test('config.json budget sets the default; invalid budget arguments are tool errors', async t => {
  const { mcp } = await setup(t, {}, { config: { budget: { maxCalls: 1 } } });
  const first = mcpData(await mcp.callTool('fai_browser_run', { ...ONE_CALL, instruction: 'Open Members' }));
  assert.equal(first.verdict.budget.callsLeft, 0);
  const refused = mcpData(await mcp.callTool('fai_browser_run', { instruction: 'Open About' }));
  assert.equal(refused.code, 'task_budget');
  const bad = await mcp.callTool('fai_browser_run', { instruction: 'x', maxMs: 10 });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /at least 1000/);
});

test('an identical call after an unverified or handoff outcome is refused with what to change', async t => {
  const { stub, mcp } = await setup(t, { finalStatus: 'needs_host', finalCode: 'handoff' });
  const args = { ...ONE_CALL, instruction: 'Open Settings', expectation: { urlIncludes: '/settings' } };
  const first = await mcp.callTool('fai_browser_run', args);
  assert.equal(mcpData(first).code, 'handoff');
  const runs = stub.callsTo('POST', '/v1/runs').length;
  const repeat = await mcp.callTool('fai_browser_run', args);
  assert.equal(repeat.isError, true);
  const error = mcpError(repeat);
  assert.equal(error.code, 'invalid_params');
  assert.match(error.message, /verdict\.suggested/);
  assert.equal(stub.callsTo('POST', '/v1/runs').length, runs);
  const changed = await mcp.callTool('fai_browser_run', { ...args, maxActions: 3 });
  assert.equal(changed.isError, undefined, 'changing maxActions is a different call');

  stub.behavior.finalStatus = 'completed';
  stub.behavior.finalCode = 'expectation_passed';
  const done = await mcp.callTool('fai_browser_run', { ...args, instruction: 'Open Settings now' });
  assert.equal(mcpData(done).status, 'completed');
  const again = await mcp.callTool('fai_browser_run', { ...args, instruction: 'Open Settings now' });
  assert.equal(again.isError, undefined, 'a repeat after a completed run is allowed');
});

test('select_tab costs no budget and a repeat after it is allowed', async t => {
  const { stub, mcp } = await setup(t, { autoGrant: false }, { env: { FAI_MCP_MAX_CALL_MS: '2500' } });
  const pending = await mcp.callTool('fai_browser_run', { ...ONE_CALL, instruction: 'Open Members' });
  assert.equal(mcpData(pending).code, 'select_tab');
  stub.grant(mcpData(pending).requestId);
  const ran = await mcp.callTool('fai_browser_run', { ...ONE_CALL, instruction: 'Open Members' });
  assert.equal(mcpData(ran).status, 'completed');
  assert.equal(mcpData(ran).verdict.budget.callsUsed, 1);
});

test('call-time lint: a urlMatches expectation adds an expectation_weak warning naming the fix', async t => {
  const { mcp } = await setup(t);
  const result = await mcp.callTool('fai_browser_run', { ...ONE_CALL, instruction: 'Open page 3',
    expectation: { urlMatches: 'page=3' } });
  const warnings = mcpData(result).warnings;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^expectation_weak: .*urlIncludes/);
  assert.match(result.content[0].text, /^warning: expectation_weak/m);
});

test('call-time lint: a run without an expectation gets an actionable expectation_missing warning', async t => {
  const { mcp } = await setup(t);
  const bare = await mcp.callTool('fai_browser_run', { ...ONE_CALL, instruction: 'Open Members' });
  assert.deepEqual(mcpData(bare).warnings, [`expectation_missing: ${MISSING_EXPECTATION_HINT}`]);
  assert.match(mcpData(bare).warnings[0], /no expectation, so this run cannot be verified/);
  assert.match(mcpData(bare).warnings[0], /\{"urlIncludes": the page path that proves the step done\}/);
  assert.match(bare.content[0].text, /^warning: expectation_missing: no expectation/m);
  assert.doesNotMatch(bare.content[0].text, /expectation_weak/);
  // A single step may omit the expectation: no warning.
  const step = await mcp.callTool('fai_browser_run', { ...ONE_CALL, instruction: 'Click Members', maxActions: 1 });
  assert.equal(mcpData(step).warnings, undefined);
  // A good expectation adds nothing.
  const good = await mcp.callTool('fai_browser_run', { ...ONE_CALL, instruction: 'Open Members',
    expectation: { urlIncludes: '/members' } });
  assert.equal(mcpData(good).warnings, undefined);
});

test('every next the server sends is {kind, text} with a receipt kind or wait (observe, wait, stop, release)',
  async t => {
    const KINDS = ['answer', 'answer_from_digest', 'confirm_page', 'choose', 'rerun', 'split', 'relay', 'approve',
      'stop', 'wait'];
    const { mcp } = await setup(t);
    const run = await mcp.callTool('fai_browser_run', { ...ONE_CALL, instruction: 'Open Members' });
    const requestId = mcpData(run).requestId;
    const responses = [
      run,
      await mcp.callTool('fai_browser_observe', {}),
      await mcp.callTool('fai_browser_wait', { maxMs: 50 }),
      await mcp.callTool('fai_browser_stop', {}),
      await mcp.callTool('fai_browser_stop', { requestId }),
    ];
    let seen = 0;
    for (const response of responses) {
      assert.equal(response.structuredContent, undefined);
      const next = mcpData(response).next;
      if (next === undefined) continue;
      seen++;
      assert.equal(typeof next, 'object', response.content[0].text);
      assert.ok(KINDS.includes(next.kind), `kind ${next.kind}`);
      assert.equal(typeof next.text, 'string');
      assert.ok(next.text.length > 0);
    }
    assert.ok(seen >= 4, `only ${seen} responses carried next`);
    assert.equal(mcpData(responses[1]).next.kind, 'choose');
    assert.match(responses[1].content[0].text, /^next \(choose\): Call fai_browser_act/m);
  });

test('a suggestion is sent at most once per request, also after a different one in between (A, B, A)', async t => {
  const suggestions = [
    { instruction: 'From the current page, visit Pricing. Stop there.', maxActions: 3 },
    { instruction: 'From the current page, visit Team. Stop there.', maxActions: 3 },
    { instruction: 'From the current page, visit Pricing. Stop there.', maxActions: 3 },
  ];
  let n = 0;
  const verdictFor = suggested => ({
    kind: 'needs_decision', oversight: 'instruct', answer: null, why: ['handoff'], decide: null, suggested,
    budget: null,
  });
  const { mcp } = await setup(t, {
    finalStatus: 'needs_host',
    finalCode: 'handoff',
    finalExtra: () => ({ v: 2, verdict: verdictFor(suggestions[n++]), next: { kind: 'rerun', text: 'x' } }),
  });
  const first = await mcp.callTool('fai_browser_run', { ...ONE_CALL, instruction: 'Open Pricing', maxCalls: 6 });
  assert.deepEqual(mcpData(first).verdict.suggested, suggestions[0]);
  const second = await mcp.callTool('fai_browser_run', { instruction: suggestions[0].instruction, maxActions: 3 });
  assert.deepEqual(mcpData(second).verdict.suggested, suggestions[1]);
  const third = await mcp.callTool('fai_browser_run', { instruction: suggestions[1].instruction, maxActions: 3 });
  assert.equal(mcpData(third).verdict.suggested, null, 'the first suggestion is never sent again');
  assert.ok(mcpData(third).verdict.why.includes('suggested_repeated'));
  assert.equal(mcpData(third).next.kind, 'rerun');
  assert.doesNotMatch(mcpData(third).next.text, /verdict\.suggested/);
});

test('the budget the daemon reports (the user\'s popup setting) is the ceiling: a call can lower it, never raise it', async t => {
  const { stub, mcp } = await setup(t, { budget: { maxCalls: 5, maxMs: 600_000, source: 'extension' } });
  const capped = result => (mcpData(result).warnings ?? []).filter(warning => warning.startsWith('budget_capped'));
  // Asking for more than the user allows runs with the user's value and says so.
  const first = await mcp.callTool('fai_browser_run', { ...ONE_CALL, instruction: 'Open Members 1', maxCalls: 40, maxMs: 1_200_000 });
  assert.equal(mcpData(first).verdict.budget.callsLeft, 4);
  assert.deepEqual(capped(first), ['budget_capped:maxCalls:5', 'budget_capped:maxMs:600000']);
  // Asking for less lowers it (the ask holds for the request until the host sends another).
  const second = await mcp.callTool('fai_browser_run', { instruction: 'Open Members 2', maxCalls: 2 });
  assert.equal(mcpData(second).status, 'completed');
  assert.equal(mcpData(second).verdict.budget.callsLeft, 0);
  assert.deepEqual(capped(second), []);
  const refused = await mcp.callTool('fai_browser_run', { instruction: 'Open Members 3' });
  assert.equal(mcpData(refused).code, 'task_budget');
  // The user raises the setting mid-request: the next call sees the new ceiling and may ask up to it.
  stub.behavior.budget = { maxCalls: 6, maxMs: 600_000, source: 'extension' };
  const third = await mcp.callTool('fai_browser_run', { instruction: 'Open Members 4', maxCalls: 6 });
  assert.equal(mcpData(third).status, 'completed');
  assert.deepEqual(capped(third), []);
  assert.equal(mcpData(third).verdict.budget.callsUsed, 3);
  assert.equal(mcpData(third).verdict.budget.callsLeft, 3);
});

test('an observe-first request reads the ceiling with one peek', async t => {
  const { stub, mcp } = await setup(t, { budget: { maxCalls: 1, maxMs: 600_000, source: 'extension' } });
  const created = await mcp.callTool('fai_browser_run', { ...ONE_CALL, instruction: 'Open Members', maxActions: 1 });
  assert.equal(mcpData(created).verdict.budget.callsLeft, 0);
  const observe = await mcp.callTool('fai_browser_observe', {});
  assert.equal(mcpData(observe).code, 'task_budget');
  assert.ok(stub.callsTo('POST', '/v1/wait').length >= 1);
});

test('after a second run that still needs the host, a rerun next adds the ladder: look at the page, drive steps, hand back', async t => {
  const { mcp } = await setup(t, { finalStatus: 'needs_host', finalCode: 'handoff' });
  const first = await mcp.callTool('fai_browser_run', { ...ONE_CALL, instruction: 'Open Members 1' });
  assert.equal(mcpData(first).next.kind, 'rerun');
  assert.doesNotMatch(mcpData(first).next.text, /fai_browser_observe/, 'the first failure asks for a sharper run only');
  const second = await mcp.callTool('fai_browser_run', { instruction: 'Open Members 2' });
  assert.equal(mcpData(second).next.kind, 'rerun');
  const runId = mcpData(second).runId;
  assert.match(mcpData(second).next.text, new RegExp(`Two runs have not done it\\. Before another, look yourself: fai_browser_evidence with runId ${runId}`));
  assert.match(mcpData(second).next.text, /fai_browser_observe and fai_browser_act \(actionId, or point on the screenshot/);
  assert.match(mcpData(second).next.text, /hand the rest back to fai_browser_run\.$/);
  assert.match(second.content[0].text, /^next \(rerun\): .*Two runs have not done it/m);
  // An observe does not count as a run; a completed run does not add it either.
  const observe = await mcp.callTool('fai_browser_observe', {});
  assert.equal(mcpData(observe).state, 'ok');
});
