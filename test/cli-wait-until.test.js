// `fai-browser wait <requestId> --until active`: the background command that wakes a host when the user resumes or
// approves the tab, and the trusted next texts that name it. Private stub and in-process daemons only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startStubDaemon } from './helpers/stub-daemon.js';
import { createDaemon } from '../src/daemon.js';
import { createLogger, homePaths } from '../src/home.js';
import { directNext } from '../src/result.js';
import { CLI_PATH, resumeWaitCommand, resumeWaitText, withResumeWait } from '../src/resume.js';
import { ORIGIN, clickProvider } from './runtime-fixtures.js';
import { call, createFakeHub } from './helpers/fake-hub.js';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.js');
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

/** Spawn the CLI; resolves {code, stdout, stderr, ms}. `child` is handed to `onSpawn` (to send signals). */
function runCli(args, env, { timeoutMs = 20_000, onSpawn } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  onSpawn?.(child);
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

function oneLine(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one stdout line, got: ${stdout}`);
  const result = JSON.parse(lines[0]);
  assert.equal(typeof result.next?.kind, 'string');
  assert.equal(typeof result.next?.text, 'string');
  return result;
}

async function stubbed(t, behavior = {}) {
  // Short daemon wait rounds (the live daemon blocks up to 30 s per round) so the loop runs several rounds. The default
  // driver (agent) unless a test asks for Jev. wait --until never starts a daemon, so none is spawned here.
  const stub = await startStubDaemon({ requestWaitCapMs: 150, driver: 'agent', ...behavior });
  t.after(() => stub.close());
  const cli = (args, options = {}) => runCli(args, stub.env(options.env), options);
  return { stub, cli };
}

function addRequest(stub, state, stateReason = null) {
  const requestId = `req_${Math.random().toString(16).slice(2, 10)}`;
  stub.requests.set(requestId, {
    requestId, state: 'pending', origins: ['https://example.com'], mode: 'read-only', reason: 'Check',
    client: 'test', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  if (state !== 'pending') stub.setRequestState(requestId, state, stateReason);
  return requestId;
}

const waitCalls = (stub, requestId) => stub.callsTo('POST', '/v1/wait').filter(entry => entry.body.requestId === requestId);

/** Resolve once the stub has recorded the CLI's first wait round for `requestId` (the CLI is waiting). */
async function firstWait(stub, requestId, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (!waitCalls(stub, requestId).length) {
    if (Date.now() > until) throw new Error(`no wait round for ${requestId} within ${timeoutMs} ms`);
    await delay(20);
  }
}

test('wait --until active exits 0 at once when the lease is already active', async t => {
  const { stub, cli } = await stubbed(t);
  const requestId = addRequest(stub, 'active');
  const run = await cli(['wait', requestId, '--until', 'active']);
  assert.equal(run.code, 0, run.stderr);
  const result = oneLine(run.stdout);
  assert.equal(result.state, 'active');
  assert.equal(result.requestId, requestId);
  assert.equal(result.until, 'active');
  assert.equal(result.request.state, 'active');
  assert.equal(result.next.kind, 'observe');
  assert.match(result.next.text, new RegExp(`fai_browser_observe with requestId ${requestId}`));
  assert.equal(waitCalls(stub, requestId).length, 1);
});

test('wait --until active blocks over several daemon long polls and exits 0 when the user resumes', async t => {
  const { stub, cli } = await stubbed(t);
  const requestId = addRequest(stub, 'paused', 'tab_changed');
  const running = cli(['wait', requestId, '--until', 'active', '--timeout', '30s']);
  await firstWait(stub, requestId);
  await delay(450);
  stub.setRequestState(requestId, 'active');
  const run = await running;
  assert.equal(run.code, 0, run.stderr);
  const result = oneLine(run.stdout);
  assert.equal(result.state, 'active');
  assert.equal(result.reconnects, 0);
  const rounds = waitCalls(stub, requestId);
  // Every round is a long poll the daemon holds (150 ms here): no tight polling between them.
  assert.ok(rounds.length >= 2 && rounds.length <= 8, `${rounds.length} wait rounds`);
  for (const round of rounds) assert.ok(round.body.maxMs > 0 && round.body.maxMs <= 30_000, JSON.stringify(round.body));
  assert.match(rounds[0].client, /^cli\b/);
});

test('a pending request that the user approves wakes the wait too', async t => {
  const { stub, cli } = await stubbed(t);
  const requestId = addRequest(stub, 'pending');
  setTimeout(() => stub.grant(requestId), 300);
  const run = await cli(['wait', requestId, '--until', 'active', '--timeout', '10s']);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(oneLine(run.stdout).state, 'active');
});

test('wait --until active exits 3 promptly when the request ends, with the state and a stop next', async t => {
  const { stub, cli } = await stubbed(t);
  for (const [state, reason, pattern] of [
    ['released', 'stopped', /has ended \(released: stopped\)/],
    ['expired', 'paused_timeout', /has ended \(expired: paused_timeout\)/],
    ['denied', 'denied', /has ended \(denied\)/],
    ['released', 'superseded', /replaced by a newer approved request/],
  ]) {
    const requestId = addRequest(stub, 'paused', 'paused');
    setTimeout(() => stub.setRequestState(requestId, state, reason), 200);
    const run = await cli(['wait', requestId, '--until', 'active', '--timeout', '30s']);
    assert.equal(run.code, 3, `${state}/${reason}: ${run.stderr}`);
    const result = oneLine(run.stdout);
    assert.equal(result.state, state);
    assert.equal(result.reason, reason);
    assert.equal(result.next.kind, 'stop');
    assert.match(result.next.text, pattern);
    assert.ok(run.ms < 8000, `exited after ${run.ms} ms`);
  }
});

test('a request the daemon does not know ends the wait with exit 3 and state unknown', async t => {
  const { cli } = await stubbed(t);
  const run = await cli(['wait', 'req_missing', '--until', 'active']);
  assert.equal(run.code, 3, run.stderr);
  const result = oneLine(run.stdout);
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'unknown_request');
  assert.equal(result.next.kind, 'stop');
  assert.match(result.next.text, /no longer knows request req_missing/);
});

test('the timeout exits 2 with the last state and a relay next', async t => {
  const { stub, cli } = await stubbed(t);
  const paused = addRequest(stub, 'paused', 'paused');
  let run = await cli(['wait', paused, '--until', 'active', '--timeout', '500ms']);
  assert.equal(run.code, 2, run.stderr);
  let result = oneLine(run.stdout);
  assert.equal(result.state, 'timeout');
  assert.equal(result.lastState, 'paused');
  assert.equal(result.next.kind, 'relay');
  assert.match(result.next.text, /still paused after 500ms.*click Resume/);
  assert.ok(result.waitedMs >= 450 && result.waitedMs < 3000, `waited ${result.waitedMs} ms`);

  assert.match(result.next.text, /then call fai_browser_observe with requestId/);

  const pending = addRequest(stub, 'pending');
  run = await cli(['wait', pending, '--until', 'active', '--timeout', '200ms']);
  assert.equal(run.code, 2);
  result = oneLine(run.stdout);
  assert.equal(result.lastState, 'pending');
  assert.match(result.next.text, /approve it in the FAI Browser extension/);
});

test('a daemon outage mid-wait is retried with backoff; the wait still ends when the user resumes', async t => {
  const { stub, cli } = await stubbed(t);
  const requestId = addRequest(stub, 'paused', 'disconnected');
  const running = cli(['wait', requestId, '--until', 'active', '--timeout', '30s']);
  await delay(400);
  await stub.down();
  await delay(1200);
  await stub.up();
  setTimeout(() => stub.setRequestState(requestId, 'active'), 300);
  const run = await running;
  assert.equal(run.code, 0, run.stderr);
  const result = oneLine(run.stdout);
  assert.equal(result.state, 'active');
  // One outage counts once, however many connection attempts the backoff made.
  assert.equal(result.reconnects, 1);
  assert.match(run.stderr, /daemon not answering/);
});

test('a daemon gone for the outage window ends the wait as unknown (daemon_gone, exit 3); none is started', async t => {
  const { stub, cli } = await stubbed(t);
  const requestId = addRequest(stub, 'paused', 'paused');
  const running = cli(['wait', requestId, '--until', 'active', '--timeout', '30s'],
    { env: { FAI_WAIT_DAEMON_GONE_MS: '800' } });
  await firstWait(stub, requestId);
  await stub.down();
  const run = await running;
  assert.equal(run.code, 3, run.stderr);
  const result = oneLine(run.stdout);
  assert.equal(result.state, 'unknown');
  assert.equal(result.reason, 'daemon_gone');
  assert.equal(result.next.kind, 'stop');
  assert.match(result.next.text, /do not survive a daemon restart/);
  assert.ok(run.ms < 8000, `exited after ${run.ms} ms`);
  // Nothing auto-started a daemon on the stub's port or in its home.
  const { readdir } = await import('node:fs/promises');
  assert.ok(!(await readdir(stub.home)).includes('daemon.lock'), 'no daemon was started');
});

test('a daemon that comes back without the request (a restart) ends the wait with state unknown', async t => {
  const { stub, cli } = await stubbed(t);
  const requestId = addRequest(stub, 'paused', 'paused');
  const running = cli(['wait', requestId, '--until', 'active', '--timeout', '30s']);
  await delay(300);
  await stub.down();
  stub.requests.delete(requestId);
  await delay(600);
  await stub.up();
  const run = await running;
  assert.equal(run.code, 3, run.stderr);
  assert.equal(oneLine(run.stdout).state, 'unknown');
});

test('a daemon that never answers is retried until the timeout, then exits 2', async t => {
  const { stub, cli } = await stubbed(t);
  const requestId = addRequest(stub, 'paused', 'paused');
  await stub.down();
  const run = await cli(['wait', requestId, '--until', 'active', '--timeout', '1500ms']);
  assert.equal(run.code, 2, run.stderr);
  const result = oneLine(run.stdout);
  assert.equal(result.state, 'timeout');
  assert.equal(result.lastState, null);
  assert.ok(run.ms < 6000, `exited after ${run.ms} ms`);
});

test('SIGTERM ends the wait with one line, state interrupted and exit 130', async t => {
  const { stub, cli } = await stubbed(t);
  const requestId = addRequest(stub, 'paused', 'paused');
  let child;
  const running = cli(['wait', requestId, '--until', 'active'], { onSpawn: spawned => { child = spawned; } });
  await firstWait(stub, requestId);
  child.kill('SIGTERM');
  const run = await running;
  assert.equal(run.code, 130, run.stderr);
  const result = oneLine(run.stdout);
  assert.equal(result.state, 'interrupted');
});

test('bad --until/--timeout combinations are command-line errors with exit 1', async t => {
  const { stub, cli } = await stubbed(t);
  const requestId = addRequest(stub, 'paused');
  for (const args of [
    ['wait', requestId, '--until', 'paused'],
    ['wait', requestId, '--until', 'active', '--timeout', '30'],
    ['wait', requestId, '--until', 'active', '--timeout', '25h'],
    ['wait', requestId, '--until', 'active', '--max-ms', '100'],
    ['wait', '--run', 'run_1', '--until', 'active'],
  ]) {
    const run = await cli(args);
    assert.equal(run.code, 1, `${args.join(' ')}: ${run.stdout}`);
    // A failed wait --until still prints its one line with a next the agent can follow.
    const result = oneLine(run.stdout);
    assert.equal(result.state, 'error');
    assert.equal(typeof result.error.message, 'string');
    assert.equal(result.next.kind, 'relay');
    assert.match(result.next.text, /^The background wait failed .*ask the user|Ask the user to tell you when they have resumed/);
    assert.match(result.next.text, /fai_browser_observe/);
  }
  // --until and --timeout belong to wait --until alone: elsewhere they are refused, never ignored.
  for (const args of [
    ['wait', requestId, '--timeout', '30m'],
    ['status', '--until', 'active'],
    ['run', 'Open About', '--origin', 'https://example.com', '--timeout', '1m'],
    ['daemon', 'status', '--timeout', '1m'],
    ['install', '--host', 'claude', '--dry-run', '--until', 'active'],
  ]) {
    const run = await cli(args);
    assert.equal(run.code, 1, `${args.join(' ')}: ${run.stdout}`);
    assert.match(run.stdout, /--(until|timeout) belongs to wait <requestId> --until active/);
  }
  assert.equal(waitCalls(stub, requestId).length, 0);
  assert.equal(stub.callsTo('POST', '/v1/runs').length, 0);
});

test('against the real daemon: a paused lease, then Resume (a new lease for the request), wakes the wait', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-wait-until-'));
  const hub = createFakeHub();
  const env = {};
  const log = createLogger(homePaths({ home, env }));
  const daemon = createDaemon({ driver: 'agent', home, env, port: 0, hub, log, sweepIntervalMs: 60_000,
    providerFactory: () => clickProvider(['About']) });
  await daemon.listen();
  t.after(async () => {
    await daemon.close();
    log.close();
    await rm(home, { recursive: true, force: true });
  });
  const api = (method, path, body) => call(daemon.port, method, path, body, { token: daemon.token });
  const created = await api('POST', '/v1/requests', { origins: [ORIGIN], reason: 'Check the page' });
  const requestId = created.body.requestId;
  await hub.approve(requestId);
  const leaseId = daemon.request(requestId).lease.leaseId;
  await hub.emit({ type: 'status', leaseId, status: 'paused', reason: 'paused' });
  assert.equal(daemon.request(requestId).state, 'paused');

  const cliEnv = { PATH: process.env.PATH, HOME: home, FAI_HOME: home, FAI_DAEMON_PORT: String(daemon.port) };
  const running = runCli(['wait', requestId, '--until', 'active', '--timeout', '1m'], cliEnv);
  await delay(600);
  const resumed = await hub.approve(requestId);
  assert.notEqual(resumed.leaseId, leaseId);
  const run = await running;
  assert.equal(run.code, 0, run.stderr);
  const result = oneLine(run.stdout);
  assert.equal(result.state, 'active');
  assert.equal(result.request.lease.leaseId, resumed.leaseId);
  assert.equal(result.next.kind, 'observe');

  // Released while waiting: exit 3.
  await hub.emit({ type: 'status', leaseId: resumed.leaseId, status: 'paused', reason: 'tab_changed' });
  const ending = runCli(['wait', requestId, '--until', 'active'], cliEnv);
  await delay(400);
  await api('DELETE', `/v1/requests/${requestId}`, {});
  const ended = await ending;
  assert.equal(ended.code, 3, ended.stderr);
  assert.equal(oneLine(ended.stdout).state, 'released');
});

// ---------------------------------------------------------------------------------------------------------------
// The next texts that name the command.

test('resumeWaitCommand: absolute node and CLI paths, daemon location variables carried, never the client token', () => {
  const plain = resumeWaitCommand('req_abc', { env: {}, execPath: '/usr/bin/node' });
  assert.equal(plain, `/usr/bin/node ${CLI_PATH} wait req_abc --until active --timeout 30m`);
  assert.ok(CLI_PATH.endsWith(join('src', 'cli.js')) && resolve(CLI_PATH) === CLI_PATH);
  const carried = resumeWaitCommand('req_abc', {
    env: { FAI_HOME: '/tmp/my home', FAI_DAEMON_PORT: '4400', FAI_CLIENT_TOKEN: 'never-in-a-command', OTHER: 'x' },
    execPath: '/opt/node 24/bin/node',
  });
  assert.equal(carried, `FAI_HOME='/tmp/my home' FAI_DAEMON_PORT=4400 '/opt/node 24/bin/node' ${CLI_PATH} wait `
    + 'req_abc --until active --timeout 30m');
  assert.doesNotMatch(carried, /never-in-a-command|CLIENT_TOKEN|OTHER/);
  // Only a daemon-issued id goes into a command.
  assert.equal(resumeWaitText('from this result'), '');
  assert.equal(resumeWaitText("req_1; rm -rf ~"), '');
  assert.equal(withResumeWait('Do X.', undefined), 'Do X.');
});

test('a paused lease: next tells the agent to relay Resume and start the wait in the background (Agent direct)', () => {
  const command = resumeWaitCommand('req_9');
  for (const code of ['paused', 'tab_changed', 'origin_changed', 'child_tab', 'session_inactive', 'disconnected']) {
    const next = directNext({ status: 'needs_user', code }, { requestId: 'req_9' });
    assert.equal(next.kind, 'relay', code);
    assert.match(next.text, /click Resume in the FAI Browser extension/);
    assert.match(next.text, /call fai_browser_observe with requestId req_9\./);
    assert.ok(next.text.includes(`start \`${command}\` that way now, if one is not already running for this request, `
      + 'and end your turn'), next.text);
    assert.match(next.text, /run_in_background/);
    assert.match(next.text, /Otherwise ask the user to tell you when they have done it\./);
  }
  // A pending approval names the same wait, then observe too (the request keeps the opening task for the digest).
  const pending = directNext({ status: 'needs_user', code: 'select_tab' }, { requestId: 'req_9', approval: 'page' });
  assert.equal(pending.kind, 'relay');
  assert.match(pending.text, /Then call fai_browser_observe with requestId req_9\. If you can run a background/);
  assert.doesNotMatch(pending.text, /fai_browser_open/);
  assert.ok(pending.text.includes(command));
  // Things the user does in the tab while the lease stays active name no wait (it would return at once).
  for (const code of ['consent_banner', 'login', 'blocked', 'js_dialog']) {
    const next = directNext({ status: 'needs_user', code }, { requestId: 'req_9' });
    assert.doesNotMatch(next.text, /--until active/, code);
  }
});

test('the command runs as written in a POSIX shell: prefix assignments reach the CLI, a node path with = works', async t => {
  const { mkdir, symlink, writeFile } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const dir = await mkdtemp(join(tmpdir(), 'fai-wait-cmd-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const odd = join(dir, 'a=b dir');
  await mkdir(odd);
  const node = join(odd, 'node');
  await symlink(process.execPath, node);
  // A stand-in CLI that prints what it was given.
  const script = join(dir, 'cli.js');
  await writeFile(script, 'console.log(JSON.stringify({ home: process.env.FAI_HOME, port: process.env.FAI_DAEMON_PORT, '
    + 'argv: process.argv.slice(2) }));\n');
  const command = resumeWaitCommand('req_x1', { env: { FAI_HOME: join(dir, "it's home"), FAI_DAEMON_PORT: '4411' },
    execPath: node, cliPath: script });
  for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh']) {
    const { existsSync } = await import('node:fs');
    if (!existsSync(shell)) continue;
    const stdout = await new Promise((resolveRun, reject) => execFile(shell, ['-c', command], { env: { PATH: '/usr/bin:/bin' } },
      (error, out) => (error ? reject(error) : resolveRun(out))));
    assert.deepEqual(JSON.parse(stdout), { home: join(dir, "it's home"), port: '4411',
      argv: ['wait', 'req_x1', '--until', 'active', '--timeout', '30m'] }, shell);
  }
});
