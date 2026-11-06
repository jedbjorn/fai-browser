import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBody, loadSample, variations } from '../bench/jev-replay.mjs';
import { decideBody } from '../src/typesafe.js';

const PAGE = {
  revision: 'r1', url: 'https://example.com/results', title: 'Results', text: 'Results\nDate grid\nPrice graph',
  controls: [
    { id: '1', role: 'button', label: 'Date grid', type: 'submit', enabled: true },
    { id: '2', role: 'button', label: 'Price graph', type: 'submit', enabled: true },
  ],
};
// The page script's risk classes are not in a trace, so an observe trace's own action list is replayed.
const ACTIONS = [
  { id: 'a0', type: 'click', target: '1', role: 'button', label: 'Date grid', description: 'Click button 1: Date grid' },
  { id: 'a1', type: 'click', target: '2', role: 'button', label: 'Price graph', description: 'Click button 2: Price graph' },
  { id: 'a2', type: 'wait', label: 'wait', description: 'Wait briefly for page content to finish loading' },
];

test('jev-replay rebuilds the decide body the runtime sends from an observe trace', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fai-replay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'trace.json');
  await writeFile(path, JSON.stringify({ operation: 'observe', page: PAGE, actions: ACTIONS, options: { mode: 'interactive' } }));
  const sample = loadSample(path, { instruction: "Click the 'Date grid' button." });
  assert.deepEqual(sample.offered.slice(0, 3).map(a => a.id), ['a0', 'a1', 'a2']);
  assert.deepEqual(sample.offered.slice(3).map(a => a.type), ['done', 'handoff']);
  const body = buildBody(sample, {});
  const direct = decideBody({
    model: 'jev-latest', observation: sample.observation, offered: sample.offered.filter(a => a.type !== 'done'),
    context: { instruction: "Click the 'Date grid' button.", history: [], mode: 'interactive', level: 'interactive' },
  });
  assert.deepEqual(body, direct);
  // Each variation changes one factor: the file-path variation only the instruction.
  const target = sample.offered[0];
  const all = variations({ target, pathInstruction: '/tmp/x/options.json' });
  const path_ = buildBody(sample, all['instr-file-path'](sample));
  assert.equal(path_.state.instruction, '/tmp/x/options.json');
  // The base instruction names the offered "Date grid" button, so only it carries the `named` policy line.
  assert.match(body.state.policy.named, /names the offered button "Date grid"/);
  assert.equal(path_.state.policy.named, undefined);
  const { named, ...policy } = body.state.policy;
  assert.deepEqual({ ...path_.state, instruction: null }, { ...body.state, policy, instruction: null });
  assert.deepEqual(path_.questions, body.questions);
  assert.equal(Object.keys(buildBody(sample, all['plain-page'](sample)).questions.action.criteria).length, 3);
});
