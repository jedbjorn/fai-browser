import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createResult, setOutcome, buildVerdict, agentResult } from '../src/result.js';
import { BrowserRuntime } from '../src/runtime.js';
import { FakeBridge, clickProvider } from './runtime-fixtures.js';
import { startStubDaemon } from './helpers/stub-daemon.js';

for (const [code, status, exit] of [['refused_action', 'needs_user', 2], ['error_page', 'failed', 1]]) {
  test(`${code} taxonomy, CLI exit and documentation agree`, async t => {
    const result = createResult({ runId: 'r' }); setOutcome(result, code);
    assert.equal(result.status, status); assert.equal(buildVerdict(result).nextKind, 'stop');
    const [readme, skill, types] = await Promise.all(['../docs/REFERENCE.md', '../skills/fai-browser/jev.md', '../src/index.d.ts'].map(path => readFile(new URL(path, import.meta.url), 'utf8')));
    const row = readme.split('\n').find(line => line.startsWith(`| \`${status}\` |`));
    assert.ok(row.includes(`\`${code}\``)); assert.ok(row.endsWith(`| ${exit} |`));
    assert.ok(skill.split('\n').find(line => line.startsWith('| `stop` |')).includes(code));
    assert.ok(types.includes(`'${code}'`));
    const stub = await startStubDaemon({ autoGrant: true, finalStatus: status, finalCode: code });
    t.after(() => stub.close());
    const child = spawn(process.execPath, [new URL('../src/cli.js', import.meta.url).pathname, 'run', 'Inspect the page', '--origin', 'https://example.com', '--reason', 'Check taxonomy'], { env: stub.env(), stdio: ['ignore', 'pipe', 'ignore'] });
    t.after(() => child.kill('SIGKILL'));
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    const actualExit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(actualExit, exit); assert.equal(JSON.parse(output).code, code);
  });
}
test('error-page next text is fixed metadata and a passing expectation completes', async () => {
  class StatusBridge extends FakeBridge { get observation() { return { ...super.observation, httpStatus: 404 }; } }
  const pages = { '/': { title: 'Private error title', text: 'Private diagnostic reference REF-123', controls: [] } };
  const provider = clickProvider([], { fallback: 'done' });
  const failed = await new BrowserRuntime({ bridge: new StatusBridge({ pages }), provider }).run('Read opening hours', { expectation: { textIncludes: 'Opening hours' } });
  assert.equal(failed.code, 'error_page'); assert.equal(provider.calls.length, 0);
  assert.equal(agentResult(failed).next.text, 'The page is an HTTP 404 error page (Not Found): the link or page is broken. Report that to the user and do not retry the same link.');
  const passed = await new BrowserRuntime({ bridge: new StatusBridge({ pages }), provider: clickProvider([], { fallback: 'done' }) }).run('Read the diagnostic reference', { expectation: { textIncludes: 'REF-123' } });
  assert.equal(passed.status, 'completed'); assert.equal(passed.verification.passed, true);
});
