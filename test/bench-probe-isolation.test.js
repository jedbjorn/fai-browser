import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { isolatedEnv, probeEnvironment } from '../bench/fai-condition.mjs';

test('benchmark probe preserves explicit settings roots without inheriting unrelated credentials', () => {
  const parent = { PATH: '/bin', HOME: '/home/test', FAI_HOME: '/tmp/selected-bench',
    UNRELATED_CREDENTIAL: 'synthetic-do-not-forward' };
  assert.deepEqual(probeEnvironment({}, parent), { PATH: '/bin', HOME: '/home/test', FAI_HOME: '/tmp/selected-bench' });
  assert.equal(probeEnvironment({ FAI_HOME: '/tmp/override' }, parent).FAI_HOME, '/tmp/override');
  assert.equal(isolatedEnv('/tmp/run-daemon', 4319, 'synthetic', parent).FAI_HOME, '/tmp/selected-bench');
  const isolated = isolatedEnv('/tmp/run-daemon', 4319, 'synthetic', {});
  assert.equal(isolated.FAI_HOME, join('/tmp/run-daemon', 'settings'));
  assert.equal(Object.hasOwn(isolated, 'HOME'), false, 'never repurpose the host HOME');
});

