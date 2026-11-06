// The Jev guidance evaluation fixtures (test/fixtures/jev/cases.json, bench/jev-eval/) stay usable offline: every
// case has a gold action among the actions the runtime would offer, consent dialogs with several reject buttons are
// offered alone, and the order check's shuffle keeps ids and handoff last.
import test from 'node:test';
import assert from 'node:assert/strict';
import { expectsHandoff, goldIds, loadCases, offeredFor, payloadFor, rng, shuffled } from '../bench/jev-eval/lib.mjs';

const cases = await loadCases();

test('every captured case has at least one gold action among the offered actions', () => {
  assert.ok(cases.length >= 35);
  for (const entry of cases) assert.ok(goldIds(entry, offeredFor(entry)).size >= 1, entry.id);
});

test('the case set covers acting, handing off, consent, blocked pages, injection and confusable controls', () => {
  assert.ok(cases.filter(expectsHandoff).length >= 5);
  assert.ok(cases.filter(entry => entry.guards.blocked).length >= 3);
  assert.ok(cases.filter(entry => entry.guards.injection).length >= 3);
  const consent = cases.find(entry => entry.id === 'j-consent-multi');
  const offered = offeredFor(consent);
  assert.ok(offered.filter(action => action.consent).length >= 2);
  assert.ok(offered.every(action => action.consent || ['done', 'handoff'].includes(action.type)));
  assert.ok(!offered.some(action => /accept/i.test(action.label)));
});

test('payloads go through the runtime provider boundary (supplied values redacted)', () => {
  const entry = cases.find(item => item.id === 's-contact-send');
  const { observation, context } = payloadFor(entry);
  assert.doesNotMatch(JSON.stringify(observation) + JSON.stringify(context), /Please call me back tomorrow/);
});

test('shuffled keeps every id, moves only non-terminal options, and is deterministic per seed', () => {
  const offered = offeredFor(cases.find(item => item.id === 'j-page-2'));
  const a = shuffled(offered, rng(7));
  const b = shuffled(offered, rng(7));
  assert.deepEqual(a.map(x => x.id), b.map(x => x.id));
  assert.deepEqual([...a.map(x => x.id)].sort(), [...offered.map(x => x.id)].sort());
  assert.deepEqual(a.slice(-2).map(x => x.type), ['done', 'handoff']);
  assert.notDeepEqual(a.map(x => x.id), offered.map(x => x.id));
});

test('jev-order-check and jev-eval fail cleanly without a key: one stderr line, exit 1, no stack trace', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = mkdtempSync(join(tmpdir(), 'fai-nokey-'));
  try {
    const env = { ...process.env, FAI_HOME: home };
    delete env.TYPESAFE_API_KEY;
    for (const script of ['scripts/jev-order-check.mjs', 'bench/jev-eval.mjs']) {
      const run = spawnSync(process.execPath, [script, '--repeat', '1'].slice(0, script.includes('eval') ? 3 : 1), {
        cwd: new URL('..', import.meta.url).pathname, env, encoding: 'utf8',
      });
      assert.equal(run.status, 1, `${script}: ${run.stderr}`);
      assert.match(run.stderr, /No Jev key configured/);
      assert.doesNotMatch(run.stderr, /\n\s+at /, 'no stack trace');
      assert.equal(run.stdout, '');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
