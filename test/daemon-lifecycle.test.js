import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  configuredPort,
  ensureClientToken,
  homePaths,
  readClientToken,
  readDaemonInfo,
  releaseLock,
} from '../src/home.js';
import { CLIENT_VERSION, FaiClientError, ensureDaemon, probeHealth } from '../src/client.js';
import { runDaemon } from '../src/daemon.js';
import { PACKAGE_ROOT } from '../src/paths.js';

const ENTRY = join(PACKAGE_ROOT, 'src', 'daemon-main.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function tempHome(t, prefix = 'fai-life-') {
  const home = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    // Stop any daemon left in this home before deleting it.
    const info = readDaemonInfo(homePaths({ home, env: {} }));
    if (info?.pid && info.pid !== process.pid) {
      try {
        process.kill(info.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
      await delay(200);
    }
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

function daemonEnv(home, extra = {}) {
  const env = { ...process.env, FAI_HOME: home, FAI_DAEMON_PORT: '0', ...extra };
  delete env.FAI_DAEMON_DIR;
  delete env.FAI_BRIDGE_PORT;
  delete env.FAI_CLIENT_TOKEN;
  delete env.FAI_BRIDGE_SECRET;
  return { ...env, ...extra };
}

function runEntry(env) {
  const child = spawn(process.execPath, [ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  return { child, exited, output: () => ({ stdout, stderr }) };
}

async function untilReady(paths, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readDaemonInfo(paths);
    if (info?.port && await probeHealth(info.port)) return info;
    await delay(50);
  }
  throw new Error('daemon did not become ready');
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

test('lock: exclusive create, live holder refused, stale holder replaced, release only by owner', async t => {
  const home = await tempHome(t);
  const paths = homePaths({ home, env: {} });
  assert.deepEqual(acquireLock(paths, { pid: process.pid }), { ok: true });
  assert.equal(mode(paths.lock), 0o600);
  assert.equal(JSON.parse(readFileSync(paths.lock, 'utf8')).pid, process.pid);

  // A live process other than us holds it.
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
  t.after(() => sleeper.kill());
  releaseLock(paths, process.pid);
  assert.equal(existsSync(paths.lock), false);
  assert.deepEqual(acquireLock(paths, { pid: sleeper.pid }), { ok: true });
  assert.deepEqual(acquireLock(paths, { pid: process.pid }), { ok: false, pid: sleeper.pid });
  releaseLock(paths, process.pid);
  assert.equal(existsSync(paths.lock), true, 'a non-owner cannot release the lock');

  // A dead holder's lock is stale and replaced.
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(resolve => dead.once('exit', resolve));
  await writeFile(paths.lock, JSON.stringify({ pid: dead.pid, startedAt: new Date().toISOString() }));
  assert.deepEqual(acquireLock(paths, { pid: process.pid }), { ok: true });
  assert.equal(JSON.parse(readFileSync(paths.lock, 'utf8')).pid, process.pid);
  releaseLock(paths);
});

test('client token is created once with 0600 and FAI_CLIENT_TOKEN overrides it for clients', async t => {
  const home = await tempHome(t);
  const paths = homePaths({ home, env: {} });
  const token = ensureClientToken(paths);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(ensureClientToken(paths), token);
  assert.equal(mode(paths.clientToken), 0o600);
  assert.equal(readClientToken(paths, {}), token);
  assert.equal(readClientToken(paths, { FAI_CLIENT_TOKEN: 'override' }), 'override');
  assert.equal(configuredPort({}), 4318);
  assert.equal(configuredPort({ FAI_BRIDGE_PORT: '5000' }), 5000);
  assert.equal(configuredPort({ FAI_DAEMON_PORT: '0', FAI_BRIDGE_PORT: '5000' }), 0);
  assert.throws(() => configuredPort({ FAI_DAEMON_PORT: 'x' }), /port/);
});

test('auto-start: readiness, 0600 state files, single instance, already_running, SIGTERM cleanup', async t => {
  const home = await tempHome(t);
  const env = daemonEnv(home);
  const paths = homePaths({ home, env });
  const started = Date.now();
  const first = await ensureDaemon({ home, env });
  assert.equal(first.started, true);
  assert.ok(Date.now() - started < 5000);
  assert.equal(first.health.service, 'fai-browser');
  assert.equal(first.health.version, CLIENT_VERSION);
  assert.match(first.token, /^[0-9a-f]{64}$/);
  const info = readDaemonInfo(paths);
  assert.equal(info.port, first.port);
  assert.equal(info.pid, first.health.pid);
  assert.equal(info.log, paths.logFile);
  for (const file of [paths.lock, paths.daemonJson, paths.pidFile, paths.clientToken, paths.logFile, paths.envFile]) {
    assert.equal(mode(file), 0o600, file);
  }
  assert.equal(readFileSync(paths.pidFile, 'utf8').trim(), String(info.pid));

  const second = await ensureDaemon({ home, env });
  assert.equal(second.started, false);
  assert.equal(second.health.pid, first.health.pid);

  const duplicate = runEntry(env);
  assert.equal(await duplicate.exited, 0);
  assert.match(duplicate.output().stdout, /"state":"already_running"/);

  process.kill(info.pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while ((existsSync(paths.daemonJson) || existsSync(paths.lock)) && Date.now() < deadline) await delay(50);
  assert.equal(existsSync(paths.daemonJson), false);
  assert.equal(existsSync(paths.lock), false);
  assert.equal(existsSync(paths.pidFile), false);
  assert.equal(await probeHealth(info.port), null);
  const log = await readFile(paths.logFile, 'utf8');
  assert.match(log, /"event":"ready"/);
  assert.match(log, /"event":"stopped"/);
});

test('two racing clients see one daemon', async t => {
  const home = await tempHome(t);
  const env = daemonEnv(home);
  const [a, b] = await Promise.all([ensureDaemon({ home, env }), ensureDaemon({ home, env })]);
  assert.equal(a.health.pid, b.health.pid);
  assert.equal(a.port, b.port);
  process.kill(a.health.pid, 'SIGTERM');
  await delay(300);
});

test('FAI_DAEMON_DIR isolates state; FAI_BRIDGE_SECRET overrides the file without being saved', async t => {
  const home = await tempHome(t);
  const stateDir = await tempHome(t, 'fai-state-');
  const secret = 's'.repeat(40);
  await writeFile(join(home, '.env.local'), `FAI_BRIDGE_SECRET="${'f'.repeat(40)}"\n`, { mode: 0o600 });
  const env = daemonEnv(home, { FAI_DAEMON_DIR: stateDir, FAI_BRIDGE_SECRET: secret });
  const daemon = runEntry(env);
  const paths = homePaths({ home, env });
  assert.equal(paths.stateDir, stateDir);
  const info = await untilReady(paths);
  for (const name of ['daemon.lock', 'daemon.json', 'daemon.pid', 'client-token', 'logs']) {
    assert.ok(existsSync(join(stateDir, name)), name);
    assert.equal(existsSync(join(home, name)), false, `${name} stayed out of FAI_HOME`);
  }
  assert.ok(!readFileSync(join(home, '.env.local'), 'utf8').includes(secret));
  assert.equal(info.pid, daemon.child.pid);
  daemon.child.kill('SIGTERM');
  assert.equal(await daemon.exited, 0);
  assert.equal(existsSync(join(stateDir, 'daemon.lock')), false);
});

test('a port held by another program fails with port_in_use', async t => {
  const home = await tempHome(t);
  const blocker = http.createServer((req, res) => res.end('not fai'));
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const { port } = blocker.address();
  const env = daemonEnv(home, { FAI_DAEMON_PORT: String(port) });
  const direct = runEntry(env);
  assert.equal(await direct.exited, 1);
  assert.match(direct.output().stderr, /"code":"port_in_use"/);
  assert.equal(existsSync(homePaths({ home, env }).lock), false, 'the lock is released');
  await assert.rejects(ensureDaemon({ home, env }), error => error instanceof FaiClientError
    && error.code === 'port_in_use');
  await assert.rejects(ensureDaemon({ home, env, autoStart: false }), error => error.code === 'daemon_unreachable');
});

test('version skew: an idle old daemon is replaced; a busy one is kept with a warning', async t => {
  const home = await tempHome(t);
  const env = daemonEnv(home);
  const old = await runDaemon({ home, env, handleSignals: false, daemonOptions: { version: '0.0.0-old' } });
  assert.equal(old.status, 'ready');
  const replaced = await ensureDaemon({ home, env });
  await old.stopped;
  assert.equal(replaced.started, true);
  assert.equal(replaced.health.version, CLIENT_VERSION);
  assert.notEqual(replaced.health.pid, process.pid);
  process.kill(replaced.health.pid, 'SIGTERM');
  const paths = homePaths({ home, env });
  const deadline = Date.now() + 5000;
  while (existsSync(paths.lock) && Date.now() < deadline) await delay(50);

  const busy = await runDaemon({ home, env, handleSignals: false, daemonOptions: { version: '0.0.0-old' } });
  t.after(() => busy.stop?.());
  const token = readFileSync(paths.clientToken, 'utf8').trim();
  await new Promise((resolve, reject) => {
    const body = JSON.stringify({ origins: ['https://example.com'], reason: 'keep me' });
    const req = http.request({
      host: '127.0.0.1', port: busy.port, method: 'POST', path: '/v1/requests',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': body.length },
    }, res => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end(body);
  });
  const kept = await ensureDaemon({ home, env });
  assert.equal(kept.started, false);
  assert.equal(kept.health.pid, process.pid);
  assert.deepEqual(kept.warnings, ['daemon_version_mismatch']);
  await busy.stop();
});
