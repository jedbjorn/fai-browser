import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as api from '../src/index.js';

const PUBLIC = [
  'BrowserRuntime', 'legalActions', 'redactorFor', 'buildDigest', 'pickAnswerCandidates',
  'EXPECTATION_FIELDS', 'describeExpectation', 'evaluateExpectation', 'validateExpectation', 'verifyExpectation',
  'RECOVERABLE_CODES', 'RESULT_VERSION', 'STATUSES', 'bridgeError', 'LEASE_MESSAGES', 'agentResult', 'leanObserve',
  'DEFAULT_THRESHOLDS', 'checkOriginEntry', 'originCovered',
  'LEVELS', 'CAPABILITIES', 'capabilitiesOf', 'clampLevel', 'guardrailPolicy',
  'createHub', 'BridgeError', 'BRIDGE_ERROR_CODES', 'PROTOCOL_VERSION', 'PINNED_EXTENSION_ID', 'DEFAULT_PORT',
  'writeRun', 'readRun', 'toAgentResult',
  'prune', 'retentionConfig', 'RETENTION_DEFAULTS',
  'MAX_WAIT_MS', 'createDaemon', 'runDaemon',
  'FaiBrowserClient', 'FaiClientError', 'ensureDaemon',
];

test('every public export is defined and declared in index.d.ts', async () => {
  const declarations = await readFile(new URL('../src/index.d.ts', import.meta.url), 'utf8');
  for (const name of PUBLIC) {
    assert.notEqual(api[name], undefined, `${name} is not exported`);
    assert.match(declarations, new RegExp(`export (?:declare )?(?:class|function|const) ${name}\\b`), `${name} is not declared`);
  }
  assert.deepEqual(Object.keys(api).sort(), [...PUBLIC].sort(), 'index.js exports exactly the public list');
  assert.equal(new api.BridgeError('stale').recoverable, true);
  assert.equal(api.PROTOCOL_VERSION, 3);
  assert.equal(api.MAX_WAIT_MS, 45000);
});
