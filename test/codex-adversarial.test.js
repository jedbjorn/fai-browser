import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserRuntime, legalActions } from '../src/runtime.js';
import { TypeSafeProvider } from '../src/typesafe.js';
import { FakeBridge, ORIGIN } from './runtime-fixtures.js';
import { spawn } from 'node:child_process';

test('codex: observe snapshots supplied values before act', async () => {
  const bridge = new FakeBridge({ path: '/form' });
  const runtime = new BrowserRuntime({ bridge });
  const suppliedText = { name: 'Approved' };
  const { actions } = await runtime.observe({ mode: 'reversible', suppliedText });
  suppliedText.name = 'Mutated';
  await runtime.act(actions.find(a => a.type === 'fill_supplied_text').id, { capture: 'none' });
  assert.equal(bridge.lastText, 'Approved');
});

test('codex: destructive label heuristic applies only to buttons', () => {
  const observation = { url: ORIGIN, controls: [
    { id: '1', role: 'checkbox', type: 'checkbox', label: 'Save receipts', risk: 'reversible' },
    { id: '2', role: 'radio', type: 'radio', label: 'Pay monthly', risk: 'reversible' },
    { id: '3', role: 'button', label: 'Pay now', risk: 'reversible' },
  ] };
  assert.deepEqual(legalActions(observation, { mode: 'reversible' }).filter(a => a.type === 'click').map(a => a.target), ['1', '2']);
});

test('codex: echoed supplied values never enter TypeSafe request including history', async () => {
  const secret = 'private-name-7864';
  const bridge = new FakeBridge({ path: '/form' });
  const originalExecute = bridge.execute.bind(bridge);
  bridge.execute = async (...args) => {
    const result = await originalExecute(...args);
    // A common form UI reflects the value into a preview and the next control label.
    bridge.pages['/form'].text = `Preview: ${secret}`;
    bridge.pages['/form'].controls[1].label = `Subscribe ${secret}`;
    result.observation = bridge.observation;
    return result;
  };
  const payloads = [];
  const provider = new TypeSafeProvider({ requireKey: false, fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body);
    payloads.push(options.body);
    const choice = payloads.length === 1
      ? Object.keys(body.questions.action.criteria).find(id => body.questions.action.criteria[id].startsWith('fill '))
      : payloads.length === 2
        ? Object.keys(body.questions.action.criteria).find(id => body.questions.action.criteria[id].includes('checkbox'))
        : 'handoff';
    // The third decision reports the outcome visible through the done question (no expectation: done >= 0.8).
    const done = { type: 'noul', noul: payloads.length === 3 ? 0.9 : 0.1 };
    // The purchase guard is asked whenever a control is offered below testing; an unanswered one fails closed.
    const purchase = { type: 'noul', noul: 0.01 };
    return new Response(JSON.stringify({ answers: { action: { choice }, done, purchase_control: purchase, purchase_page: purchase } }));
  } });
  const result = await new BrowserRuntime({ bridge, provider }).run('Fill name', {
    mode: 'reversible', suppliedText: { name: secret }, capture: 'none',
  });
  assert.equal(result.status, 'unverified');
  assert.equal(payloads.length, 3);
  const histories = payloads.map(payload => JSON.stringify(JSON.parse(payload).state.history));
  assert.ok(histories.every(history => !history.includes(secret)), 'echoed supplied text leaked in history label');
  assert.ok(payloads.every(payload => !payload.includes(secret)), 'echoed supplied text leaked in page/criteria');
});

test('codex: changedSinceStart can verify a changed revision', async () => {
  const bridge = new FakeBridge();
  const provider = { decide: async (_, actions) => ({ actionId: actions.find(a => a.type === 'click').id }) };
  const result = await new BrowserRuntime({ bridge, provider }).step('Open About', {
    capture: 'none', expectation: { changedSinceStart: true },
  });
  assert.equal(result.status, 'completed');
});

test('codex: run timeout keeps a standalone SDK process alive until its result', async () => {
  const script = `
    import { BrowserRuntime } from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};
    const runtime = new BrowserRuntime({
      bridge: { observe: async () => ({ revision: 'r1', url: 'https://example.com', controls: [] }) },
      provider: { decide: () => new Promise(() => {}) },
    });
    const result = await runtime.run('Go', { timeoutMs: 20, capture: 'none' });
    console.log(result.code);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, 'SDK exited before the promised time-budget result');
  assert.equal(stdout.trim(), 'time_budget');
});
