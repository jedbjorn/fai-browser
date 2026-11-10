import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
