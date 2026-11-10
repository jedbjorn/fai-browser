import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const CLI = resolve(import.meta.dirname, '..', 'src', 'cli.js');
const PAIRING = { FAI_BRIDGE_SECRET: 'dummy-pairing-secret-for-cli-tests-0001', FAI_EXTENSION_ID: 'a'.repeat(32) };

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

test('help prints usage and exits 0', async t => {
  const { dir } = await workspace(t, {});
  const run = await runCli(['--help'], { home: dir });
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Exit codes/);
});

// ---------------------------------------------------------------------------------------------------------------
// Thin client against the stub daemon (design section 2).

function lastJson(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `expected one stdout line, got: ${stdout}`);
  return JSON.parse(lines[0]);
}

test('daemon mode: an unreachable daemon is a failed result with exit 1', async t => {
  const blocker = net.createServer(socket => socket.destroy());
  await new Promise(resolveListen => blocker.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise(resolveClose => blocker.close(resolveClose)));
  const { dir } = await workspace(t, {});
  const env = { FAI_DAEMON_PORT: String(blocker.address().port) };
  const act = await runCli(['act', '--request', 'req_x', '--action', 'a0', '--revision', 'r1'], { home: dir, env });
  assert.equal(act.code, 1);
  assert.match(singleJson(act.stdout).code, /port_in_use|daemon_unreachable/);
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
