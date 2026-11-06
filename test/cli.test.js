import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { startStubDaemon } from './helpers/stub-daemon.js';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.js');
const PAIRING = { FAI_BRIDGE_SECRET: 'dummy-pairing-secret-for-cli-tests-0001', FAI_EXTENSION_ID: 'a'.repeat(32) };

async function freePort() {
  const server = net.createServer();
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

async function workspace(t, options) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-cli-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // These runs exercise the experimental Jev driver, saved as a user opts in to it.
  await writeFile(join(dir, 'config.json'), JSON.stringify({ driver: 'jev' }));
  const optionsPath = join(dir, 'options.json');
  const base = {
    allowedOrigins: ['http://127.0.0.1:9'],
    provider: 'local',
    providerOptions: { endpoint: 'http://127.0.0.1:1/v1/systemone' },
  };
  await writeFile(optionsPath, typeof options === 'string' ? options : JSON.stringify({ ...base, ...options }));
  return { dir, optionsPath };
}

// FAI_HOME points at the scratch dir so the real .env.local is never loaded.
function runCli(args, { home, env = {}, closeStdin = true, timeoutMs = 15_000 } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    // FAI_DAEMON_PORT=9 keeps a stray daemon-mode call away from a real daemon on 4318 (it fails fast instead).
    env: { PATH: process.env.PATH, FAI_HOME: home, FAI_DAEMON_PORT: '9', FAI_DAEMON_START_TIMEOUT_MS: '1500', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (closeStdin) {
    child.stdin.end();
  }
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const started = Date.now();
  return new Promise((resolveRun, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit within ${timeoutMs} ms\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on('exit', code => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

function singleJson(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${stdout}`);
  const result = JSON.parse(lines[0]);
  assert.equal(result.v, 2);
  // Every CLI result, including the CLI's own outcomes, carries the trusted verdict and next {kind, text}.
  assert.equal(typeof result.verdict?.kind, 'string');
  assert.equal(typeof result.next?.kind, 'string');
  assert.equal(typeof result.next?.text, 'string');
  return result;
}

test('the Phase 1 --in-process flag is gone: it is an unknown flag, a config failure with exit 1', async t => {
  const { dir, optionsPath } = await workspace(t, {});
  const run = await runCli(['step', 'Open About', optionsPath, '--in-process'], { home: dir, env: PAIRING });
  const result = singleJson(run.stdout);
  assert.equal(run.code, 1);
  assert.equal(result.code, 'config');
  assert.match(result.reason, /in-process/);
});

test('bad options JSON, missing origins, missing key and bad flags are config failures', async t => {
  const bad = await workspace(t, '{ not json');
  let run = await runCli(['run', 'x', bad.optionsPath], { home: bad.dir, env: PAIRING });
  assert.equal(run.code, 1);
  assert.match(singleJson(run.stdout).reason, /not valid JSON/);

  const noOrigins = await workspace(t, { allowedOrigins: [] });
  run = await runCli(['run', 'x', noOrigins.optionsPath], { home: noOrigins.dir, env: PAIRING });
  assert.equal(run.code, 1);
  assert.match(singleJson(run.stdout).reason, /allowedOrigins/);

  const hosted = await workspace(t, { provider: 'typesafe' });
  run = await runCli(['run', 'x', hosted.optionsPath, '--capture', 'sometimes'], { home: hosted.dir, env: PAIRING });
  assert.equal(run.code, 1);
  assert.match(singleJson(run.stdout).reason, /capture/);

  run = await runCli(['run', 'x', hosted.optionsPath, '--bogus'], { home: hosted.dir, env: PAIRING });
  assert.equal(run.code, 1);
  assert.equal(singleJson(run.stdout).code, 'config');
});

test('an options file given alone is refused, never sent to the provider as the instruction', async t => {
  const { dir, optionsPath } = await workspace(t, { instruction: 'Click the Date grid button.', mode: 'interactive' });
  for (const operation of ['run', 'step']) {
    const run = await runCli([operation, optionsPath], { home: dir, env: PAIRING });
    assert.equal(run.code, 1, run.stderr);
    const result = singleJson(run.stdout);
    assert.equal(result.code, 'config');
    assert.match(result.reason, /instruction is the path of a JSON file/);
    assert.match(result.needs.message, /run "<instruction>" options\.json/);
  }
  // An instruction that merely ends in .json (no such file), or one followed by an options file, still runs.
  const named = await runCli(['run', 'Open the page about package.json', optionsPath, '--no-auto-start'],
    { home: dir, env: PAIRING });
  assert.doesNotMatch(singleJson(named.stdout).reason ?? '', /path of a JSON file/);
  const missing = await runCli(['run', join(dir, 'nothing-here.json'), '--no-auto-start'], { home: dir, env: PAIRING });
  assert.doesNotMatch(singleJson(missing.stdout).reason ?? '', /path of a JSON file/);
});

test('help prints usage and exits 0', async t => {
  const { dir } = await workspace(t, {});
  const run = await runCli(['--help'], { home: dir });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Exit codes/);
});

// ---------------------------------------------------------------------------------------------------------------
// Thin client against the stub daemon (design section 2).

async function stubbed(t, behavior) {
  const stub = await startStubDaemon(behavior);
  t.after(() => stub.close());
  const cli = (args, extra = {}) => runCli(args, { home: stub.home, env: stub.env(extra) });
  return { stub, cli };
}

function lastJson(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected one stdout line, got: ${stdout}`);
  return JSON.parse(lines[0]);
}

test('daemon mode: run requests a tab, waits for approval, keeps the lease and exits 0', async t => {
  const { stub, cli } = await stubbed(t, { autoGrant: true });
  const run = await cli(['run', 'Open Members', '--origin', 'https://example.com', '--expect-url-includes',
    '/members', '--max-actions', '4']);
  const result = singleJson(run.stdout);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(result.status, 'completed');
  assert.match(run.stderr, /ACTION NEEDED: .*approve request req_/);
  const request = stub.callsTo('POST', '/v1/requests')[0].body;
  assert.deepEqual(request.origins, ['https://example.com']);
  assert.equal(request.reason, 'CLI: Open Members');
  const body = stub.callsTo('POST', '/v1/runs')[0].body;
  assert.equal(body.operation, 'run');
  assert.equal(body.maxActions, 4);
  assert.deepEqual(body.expectation, { urlIncludes: '/members' });
  assert.equal(result.lease.state, 'active', 'the lease is kept for the next command');
  assert.equal(stub.callsTo('DELETE', '/v1/requests').length, 0);
});

test('daemon mode: --answer forwards answerQuestion to the run', async t => {
  const { stub, cli } = await stubbed(t, { autoGrant: true });
  const run = await cli(['run', 'Open Members', '--origin', 'https://example.com', '--reason', 'Count members',
    '--answer', 'How many members are listed?']);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(stub.callsTo('POST', '/v1/requests')[0].body.reason, 'Count members');
  assert.equal(stub.callsTo('POST', '/v1/runs')[0].body.answerQuestion, 'How many members are listed?');
  const empty = await cli(['run', 'Open Members', '--origin', 'https://example.com', '--answer', ' ']);
  assert.equal(empty.code, 1);
});

test('daemon mode: --no-retry sends retry false; without it the daemon default (on) applies', async t => {
  const { stub, cli } = await stubbed(t, { autoGrant: true });
  const off = await cli(['run', 'Open Members', '--origin', 'https://example.com', '--no-retry']);
  assert.equal(off.code, 0, off.stderr);
  assert.equal(stub.callsTo('POST', '/v1/runs')[0].body.retry, false);
  const on = await cli(['run', 'Open Members', '--origin', 'https://example.com']);
  assert.equal(on.code, 0, on.stderr);
  assert.equal(stub.callsTo('POST', '/v1/runs')[1].body.retry, undefined);
});

test('daemon mode: --profile on|off forwards the site-profile switch; anything else is refused locally', async t => {
  const { stub, cli } = await stubbed(t, { autoGrant: true });
  const off = await cli(['run', 'Open Members', '--origin', 'https://example.com', '--profile', 'off']);
  assert.equal(off.code, 0, off.stderr);
  assert.equal(stub.callsTo('POST', '/v1/runs')[0].body.profiles, 'off');
  const on = await cli(['run', 'Open Members', '--origin', 'https://example.com', '--profile', 'on']);
  assert.equal(on.code, 0, on.stderr);
  assert.equal(stub.callsTo('POST', '/v1/runs')[1].body.profiles, 'on');
  const none = await cli(['run', 'Open Members', '--origin', 'https://example.com']);
  assert.equal(none.code, 0, none.stderr);
  assert.equal(stub.callsTo('POST', '/v1/runs')[2].body.profiles, undefined);
  const bad = await cli(['run', 'Open Members', '--origin', 'https://example.com', '--profile', 'maybe']);
  assert.equal(bad.code, 1);
  assert.equal(stub.callsTo('POST', '/v1/runs').length, 3);
});

test('daemon mode: --policy forwards guardrail additions (comma list or JSON) and rejects invalid ones locally', async t => {
  const { stub, cli } = await stubbed(t, { autoGrant: true });
  const list = await cli(['run', 'Open Members', '--origin', 'https://example.com', '--policy', 'Upgrade, Gift wrap']);
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(stub.callsTo('POST', '/v1/runs')[0].body.policy, ['Upgrade', 'Gift wrap']);
  const json = await cli(['run', 'Open Members', '--origin', 'https://example.com', '--policy', '{"forbid":["Donate"],"note":"No gifts."}']);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(stub.callsTo('POST', '/v1/runs')[1].body.policy, { forbid: ['Donate'], note: 'No gifts.' });
  const runs = stub.callsTo('POST', '/v1/runs').length;
  const requests = stub.callsTo('POST', '/v1/requests').length;
  const many = Array.from({ length: 21 }, (_, i) => `L${i}`).join(',');
  for (const bad of ['Pay.*', '{"allow":["x"]}', '[oops', many, 'x'.repeat(61), '{"note":"a\u202eb"}', ' , ',
    '[false]', '[42]', '[[]]', '[{}]', '[""]', '[" "]', '{"forbid":false}', '{"constructor":[]}',
    '{"__proto__":{}}', '{"note":"\\ud800"}', '["\\u0007"]', '["\\ud800"]']) {
    const refused = await cli(['run', 'Open Members', '--origin', 'https://example.com', '--policy', bad]);
    assert.equal(refused.code, 1, bad);
    assert.match(refused.stderr + refused.stdout, /policy/);
  }
  assert.equal(stub.callsTo('POST', '/v1/runs').length, runs, 'invalid policies never reach the daemon');
  assert.equal(stub.callsTo('POST', '/v1/requests').length, requests, 'nor request a tab');
});

test('daemon mode: --mode accepts the five levels as a stated need and rejects anything else locally', async t => {
  const { stub, cli } = await stubbed(t, { autoGrant: true });
  for (const mode of ['read-only', 'reversible', 'interactive', 'full', 'testing']) {
    const run = await cli(['run', 'Open Members', '--origin', 'https://example.com', '--mode', mode]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(stub.callsTo('POST', '/v1/runs').at(-1).body.mode, mode);
  }
  const runs = stub.callsTo('POST', '/v1/runs').length;
  for (const bad of ['admin', 'TESTING', 'full,testing', '']) {
    const refused = await cli(['run', 'Open Members', '--origin', 'https://example.com', '--mode', bad]);
    assert.equal(refused.code, 1, bad);
    assert.match(refused.stderr + refused.stdout, /--mode must be one of read-only, reversible, interactive, full, testing/);
  }
  assert.equal(stub.callsTo('POST', '/v1/runs').length, runs, 'invalid modes never reach the daemon');
  // The usage names the levels and says testing is granted by the user only.
  const help = await cli(['--help']);
  assert.match(help.stdout + help.stderr, /testing is granted only by the user for listed test origins/);
});

test('daemon mode: --request reuses an approved tab and --release releases it', async t => {
  const { stub, cli } = await stubbed(t);
  const created = await cli(['request-tab', '--origin', 'https://example.com', '--reason', 'Check members']);
  assert.equal(created.code, 0, created.stderr);
  const { requestId } = lastJson(created.stdout);
  assert.match(created.stderr, /fai-browser wait req_/);
  stub.grant(requestId);
  const waited = await cli(['wait', requestId, '--max-ms', '100']);
  assert.equal(lastJson(waited.stdout).state, 'active');

  const step = await cli(['step', 'Open About', '--request', requestId, '--release']);
  const result = singleJson(step.stdout);
  assert.equal(step.code, 0, step.stderr);
  assert.equal(result.status, 'checkpoint');
  assert.equal(stub.callsTo('POST', '/v1/requests').length, 1, 'no new tab request');
  assert.equal(stub.callsTo('POST', '/v1/runs')[0].body.operation, 'step');
  assert.deepEqual(result.lease, { requestId, state: 'released' });
});

test('daemon mode: exit codes follow the result status', async t => {
  const { stub, cli } = await stubbed(t, { finalStatus: 'needs_user', finalCode: 'paused' });
  const created = await cli(['request-tab', '--origin', 'https://example.com', '--reason', 'r']);
  const { requestId } = lastJson(created.stdout);
  stub.grant(requestId);
  let run = await cli(['run', 'Go', '--request', requestId]);
  assert.equal(run.code, 2);
  assert.equal(singleJson(run.stdout).status, 'needs_user');

  stub.behavior.finalStatus = 'failed';
  stub.behavior.finalCode = 'provider_error';
  run = await cli(['run', 'Go', '--request', requestId]);
  assert.equal(run.code, 1);
  assert.equal(singleJson(run.stdout).code, 'provider_error');

  run = await cli(['run', 'Go', '--request', 'req_unknown']);
  assert.equal(run.code, 1);
  const unknown = singleJson(run.stdout);
  assert.equal(unknown.code, 'unknown_request');
  assert.equal(unknown.httpStatus, 404);

  const observed = await cli(['observe', '--request', requestId]);
  assert.equal(observed.code, 0, observed.stderr);
  const { revision, next } = lastJson(observed.stdout);
  // The same next step as MCP observe.
  assert.equal(next.kind, 'choose');
  assert.ok(next.text.includes(revision));
  const lean = lastJson(observed.stdout);
  assert.deepEqual(lean.warnings, ['controls_capped']);
  assert.deepEqual(lean.consent, { text: 'We use cookies', buttons: [{ label: 'Reject all', kind: 'reject' }] });
  stub.behavior.finalStatus = 'completed';
  stub.behavior.finalCode = 'expectation_passed';
  const acted = await cli(['act', '--request', requestId, '--action', 'a0', '--revision', revision,
    '--expect-url-includes', '/members']);
  assert.equal(acted.code, 0, acted.stderr);
  assert.equal(singleJson(acted.stdout).status, 'completed');
  const stale = await cli(['act', '--request', requestId, '--action', 'a0', '--revision', 'r_old']);
  assert.equal(stale.code, 1);
  assert.equal(singleJson(stale.stdout).code, 'invalid_options');
  // A point instead of an action id: pixels of the observe screenshot, sent as given.
  const fresh = lastJson((await cli(['observe', '--request', requestId])).stdout).revision;
  const pointed = await cli(['act', '--request', requestId, '--point', '640,310.5', '--revision', fresh]);
  assert.equal(pointed.code, 0, pointed.stderr);
  const body = stub.callsTo('POST', '/v1/act').at(-1).body;
  assert.deepEqual(body.point, { x: 640, y: 310.5 });
  assert.equal(body.actionId, undefined);
  for (const flags of [['--point', '640'], ['--point', 'a,b'], ['--point', '1,2', '--action', 'a0'], []]) {
    const bad = await cli(['act', '--request', requestId, '--revision', fresh, ...flags]);
    assert.equal(bad.code, 1, flags.join(' '));
    assert.equal(singleJson(bad.stdout).code, 'config');
  }
});

test('daemon mode: no approval within the lease timeout is needs_user/select_tab with exit 2', async t => {
  const { stub, cli } = await stubbed(t);
  const run = await cli(['run', 'Open About', '--origin', 'https://example.com', '--lease-timeout-ms', '300']);
  const result = singleJson(run.stdout);
  assert.equal(run.code, 2, run.stderr);
  assert.equal(result.code, 'select_tab');
  assert.equal(result.lease.state, 'pending');
  assert.match(result.needs.message, /--request req_/);
  assert.equal(stub.callsTo('POST', '/v1/runs').length, 0);
});

test('daemon mode: options files still work and other commands print JSON with exit 0 or 1', async t => {
  const { stub, cli } = await stubbed(t, { autoGrant: true });
  const { optionsPath } = await workspace(t, { allowedOrigins: ['https://example.com'], providerOptions: undefined,
    provider: undefined, maxActions: 3, capture: 'last' });
  const run = await cli(['run', 'Open Members', optionsPath]);
  assert.equal(run.code, 0, run.stderr);
  const body = stub.callsTo('POST', '/v1/runs')[0].body;
  assert.equal(body.maxActions, 3);
  assert.equal(body.capture, 'last');
  const { runId } = singleJson(run.stdout);

  const status = await cli(['status']);
  assert.equal(status.code, 0);
  assert.equal(lastJson(status.stdout).extension.connected, true);
  const runs = await cli(['runs', '--limit', '5']);
  assert.equal(lastJson(runs.stdout).runs[0].runId, runId);
  const evidence = await cli(['evidence', runId]);
  assert.equal(lastJson(evidence.stdout).mimeType, 'image/jpeg');
  const missing = await cli(['evidence', runId, '--step', '9']);
  assert.equal(missing.code, 1);
  assert.equal(lastJson(missing.stdout).error.code, 'no_evidence');
  const stopped = await cli(['stop', runId]);
  assert.equal(stopped.code, 0);
  const requestId = stub.callsTo('POST', '/v1/requests')[0];
  const released = await cli(['release', [...stub.requests.keys()][0]]);
  assert.equal(lastJson(released.stdout).state, 'released', JSON.stringify(requestId));
  const bad = await cli(['wait']);
  assert.equal(bad.code, 1);
  assert.match(lastJson(bad.stdout).error.message, /requestId/);
  const pair = await cli(['pair']);
  assert.equal(pair.code, 1, 'pair refuses a non-TTY stdout');
  assert.equal(lastJson(pair.stdout).error.code, 'not_a_tty');
});

test('daemon mode: --port and an options-file "port" select the daemon, never an in-process companion', async t => {
  const { stub, cli } = await stubbed(t, { autoGrant: true });
  const wrongPort = { FAI_DAEMON_PORT: '9' };
  const run = await cli(['run', 'Open Members', '--origin', 'https://example.com', '--port', String(stub.port),
    '--min-confidence', '0.7'], wrongPort);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(singleJson(run.stdout).status, 'completed');
  assert.doesNotMatch(run.stderr, /in-process|companion listening/);
  assert.equal(stub.callsTo('POST', '/v1/runs')[0].body.minConfidence, 0.7);

  const { optionsPath } = await workspace(t, { allowedOrigins: ['https://example.com'], providerOptions: undefined,
    provider: undefined, port: stub.port, minConfidence: 0.5 });
  const fromFile = await cli(['step', 'Open About', optionsPath], wrongPort);
  assert.equal(fromFile.code, 0, fromFile.stderr);
  assert.equal(stub.callsTo('POST', '/v1/runs')[1].body.minConfidence, 0.5);
  const status = await cli(['status', '--port', String(stub.port)], wrongPort);
  assert.equal(status.code, 0, status.stderr);

  const bad = await cli(['run', 'x', '--origin', 'https://example.com', '--min-confidence', '1.5']);
  assert.equal(bad.code, 1);
  assert.match(singleJson(bad.stdout).reason, /min-confidence/);
  assert.equal(stub.callsTo('POST', '/v1/runs').length, 2);
});

test('daemon mode: an unreachable daemon is a failed result with exit 1', async t => {
  const blocker = net.createServer(socket => socket.destroy());
  await new Promise(resolveListen => blocker.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => blocker.close(resolveClose)));
  const { dir } = await workspace(t, {});
  const env = { FAI_DAEMON_PORT: String(blocker.address().port) };
  const run = await runCli(['run', 'x', '--origin', 'https://example.com'], { home: dir, env });
  assert.equal(run.code, 1);
  assert.match(singleJson(run.stdout).code, /port_in_use|daemon_unreachable/);
  const status = await runCli(['status'], { home: dir, env });
  assert.equal(status.code, 1);
  assert.match(lastJson(status.stdout).error.code, /port_in_use|daemon_unreachable/);
});

test('daemon mode: commands auto-start a real daemon in a temporary FAI_HOME', {
  skip: !existsSync(resolve(import.meta.dirname, '..', 'src', 'daemon.js')) && 'daemon not built yet',
}, async t => {
  const { dir } = await workspace(t, {});
  const env = { FAI_DAEMON_PORT: '0', FAI_DAEMON_START_TIMEOUT_MS: '8000' };
  t.after(() => runCli(['daemon', 'stop'], { home: dir, env }));
  const refused = await runCli(['status', '--no-auto-start'], { home: dir, env });
  assert.equal(refused.code, 1);
  assert.equal(lastJson(refused.stdout).error.code, 'daemon_unreachable');
  assert.ok(!existsSync(join(dir, 'client-token')), '--no-auto-start did not start a daemon');
  const status = await runCli(['status'], { home: dir, env, timeoutMs: 20_000 });
  assert.equal(status.code, 0, status.stderr + status.stdout);
  const body = lastJson(status.stdout);
  assert.equal(body.daemon.home, dir);
  assert.ok(existsSync(join(dir, 'client-token')), 'the daemon created the client token');
  const daemonStatus = await runCli(['daemon', 'status'], { home: dir, env });
  assert.equal(lastJson(daemonStatus.stdout).running, true);
  const stopped = await runCli(['daemon', 'stop'], { home: dir, env });
  assert.equal(lastJson(stopped.stdout).state, 'stopped');
  const after = await runCli(['daemon', 'status'], { home: dir, env });
  assert.equal(after.code, 1);
  assert.equal(lastJson(after.stdout).running, false);
});
