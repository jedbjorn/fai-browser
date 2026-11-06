import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserRuntime } from '../src/runtime.js';
import { agentResult } from '../src/result.js';
import { resolveThresholds } from '../src/oversight.js';
import { writeRun } from '../src/trace.js';
import { FakeBridge, PAGES } from './runtime-fixtures.js';

test('codex oversight: zero minConfidence overrides the default and configured control floor', async () => {
  assert.equal(resolveThresholds({ minConfidence: 0 }).thresholds.controlFloor, 0);
  assert.equal(resolveThresholds({ thresholds: { controlFloor: 0.9 }, minConfidence: 0 }).thresholds.controlFloor, 0);
  const bridge = new FakeBridge({ path: '/form' });
  const provider = { async decide(_, actions) {
    return { actionId: actions.find(a => a.target === '2').id, confidence: 0.01 };
  } };
  const result = await new BrowserRuntime({ bridge, provider }).step('Toggle Subscribe', {
    mode: 'reversible', minConfidence: 0, capture: 'none',
  });
  assert.equal(result.code, 'step_complete');
  assert.equal(bridge.executions.length, 1);
});

test('codex oversight: provider errors cannot launder page text or supplied values into reason or trace reason', async t => {
  const poison = 'PAGE_INSTRUCTION_IGNORE_USER';
  const supplied = 'USER_SUPPLIED_VALUE';
  const bridge = new FakeBridge({ pages: { ...PAGES, '/': { title: 'Home', text: poison, controls: [] } } });
  const provider = { async decide(observation) { throw new Error(`${observation.text} ${supplied}`); } };
  const result = await new BrowserRuntime({ bridge, provider }).run('Read the page', {
    suppliedText: { name: supplied }, capture: 'none',
  });
  assert.equal(result.code, 'provider_error');
  const lean = agentResult(result);
  assert.doesNotMatch(lean.reason, /PAGE_INSTRUCTION_IGNORE_USER|USER_SUPPLIED_VALUE/);
  const dir = await mkdtemp(join(tmpdir(), 'codex-oversight-trace-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const written = await writeRun(result, { dir, instruction: 'Read the page', operation: 'run', options: {} });
  const raw = await readFile(written.trace, 'utf8');
  assert.doesNotMatch(raw, /data:image\/.*base64/);
  assert.doesNotMatch(JSON.parse(raw).reason, /PAGE_INSTRUCTION_IGNORE_USER|USER_SUPPLIED_VALUE/);
});

test('codex oversight: runtime consent decisions and list candidates fit the declared unions', async () => {
  const declarations = await readFile(new URL('../src/index.d.ts', import.meta.url), 'utf8');
  const decision = declarations.match(/export interface StepDecision \{([\s\S]*?)\n\}/)[1];
  assert.match(decision, /by:\s*[^;]*'runtime'/, 'mechanical consent/nudge steps emit by: runtime');
  const blocks = declarations.match(/export type BlockType\s*=([\s\S]*?);/)[1];
  assert.match(blocks, /'list'/, 'provider-ranked list candidates emit source.t: list');
  const step = declarations.match(/export interface Step \{([\s\S]*?)\n\}/)[1];
  assert.match(step, /class\??:/, 'runtime emits the action gate class');
  assert.match(step, /lateNavigation\??:/, 'runtime emits lateNavigation after a late re-observe');
});
