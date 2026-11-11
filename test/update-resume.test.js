// The updater's re-review fixes: resume only on the verified commit in a checkout that passes the install's checks
// (the re-review's p3 probe), the resume marker across a held tab, the exclusive lock (the daemon stops a child that
// lost the race; release only removes its own lock), pid start times, a rollback that restarts only a daemon the
// update stopped, the wider secret and tool environment rules, the process-group kill on a git timeout, and a fork
// without the repository's remote reading as no release. Local git repos and fakes only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homePaths } from '../src/home.js';
import { RELEASES_API, claimUpdateLock, processStart, readInstallState, runningUpdate, updatePaths,
  writeInstallState } from '../src/update.js';
import { gitRunner, installUpdate, takeUpdateLock } from '../src/update-install.js';
import { runGrouped, scrubbedEnv, toolEnv } from '../src/update-git.js';
import { updateCommand } from '../src/update-cli.js';
import { createDaemon } from '../src/daemon.js';
import { createFakeHub } from './helpers/fake-hub.js';
import { SECRET } from './helpers/fake-extension.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function gitEnv(home) {
  return { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
}

/** A bare "GitHub" repo, a clone at v0.4.0 on main, v0.5.0 pushed; plus an FAI home. */
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-update-resume-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = gitEnv(dir);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const remote = join(dir, 'remote.git');
  const source = join(dir, 'source');
  const checkout = join(dir, 'checkout');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'init', '-q', '-b', 'main', source);
  const commitVersion = async (version, file = 'notes.txt') => {
    await writeFile(join(source, 'package.json'), `${JSON.stringify({ name: 'fai-browser', version })}\n`);
    await writeFile(join(source, file), `release ${version}\n`);
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', `Release ${version}`);
  };
  await commitVersion('0.4.0');
  git(source, 'tag', '-a', 'v0.4.0', '-m', 'v0.4.0');
  git(source, 'remote', 'add', 'origin', remote);
  git(source, 'push', '-q', 'origin', 'main', '--tags');
  git(dir, 'clone', '-q', remote, checkout);
  await commitVersion('0.5.0');
  git(source, 'tag', '-a', 'v0.5.0', '-m', 'v0.5.0');
  git(source, 'push', '-q', 'origin', 'main', '--tags');
  const v4 = git(source, 'rev-parse', 'v0.4.0^{commit}');
  const v5 = git(source, 'rev-parse', 'v0.5.0^{commit}');
  const home = join(dir, 'fai-home');
  await mkdir(home);
  const faiEnv = { ...env, FAI_HOME: home };
  delete faiEnv.FAI_DAEMON_DIR;
  return { dir, env, git, remote, source, checkout, v4, v5, home, faiEnv, paths: homePaths({ home, env: faiEnv }),
    run: gitRunner({ cwd: checkout, env }), remoteOk: url => url === remote };
}

function fakeSteps() {
  const calls = [];
  return {
    calls,
    async npmCi() {
      calls.push('npm');
    },
    async finish() {
      calls.push('finish');
      return '{}';
    },
    async restart(version) {
      calls.push(`restart:${version}`);
      return { version };
    },
  };
}

// The tag defaults to the fixture checkout's next release; the daemon test (which compares with the real package.json
// version) passes one no real release will reach.
const releases = (commit, tag = 'v0.5.0') => async url => (String(url) === RELEASES_API
  ? new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: false, target_commitish: 'main' }), { status: 200 })
  : new Response(commit, { status: 200 }));

const options = (s, extra = {}) => ({ home: s.home, env: s.faiEnv, root: s.checkout, git: s.run, remoteOk: s.remoteOk,
  requests: [], fetch: releases(s.v5), gitSource: null, ...extra });

// --- item 1: resume only on the verified commit ----------------------------------------------------------------------

test('p3: a failed record does not resume an unrelated HEAD (other branch, local changes, another remote)', async t => {
  const s = await setup(t);
  // An earlier failure whose rollback failed: to 0.5.0 at "finish". The checkout, though, is something else entirely:
  // branch feature, an unrelated commit that also says 0.5.0, local changes, and a remote that is not the repository.
  writeInstallState(s.paths, { state: 'failed', from: '0.4.0', to: '0.5.0', step: 'finish', error: 'update_failed',
    message: 'x', commit: s.v5, previous: s.v4 });
  s.git(s.checkout, 'switch', '-q', '-c', 'feature');
  await writeFile(join(s.checkout, 'package.json'), `${JSON.stringify({ name: 'fai-browser', version: '0.5.0' })}\n`);
  s.git(s.checkout, 'commit', '-q', '-am', 'Unrelated');
  await writeFile(join(s.checkout, 'notes.txt'), 'dirty\n');
  s.git(s.checkout, 'remote', 'set-url', 'origin', 'https://evil.example/fai-browser.git');
  const steps = fakeSteps();
  const result = await updateCommand({}, options(s, { steps, remoteOk: undefined }));
  assert.equal(result.value.state, 'up_to_date', JSON.stringify(result.value));
  assert.deepEqual(steps.calls, [], 'no refresh and no restart');

  // The same record without a commit (an older record) never resumes either.
  const old = await setup(t);
  old.git(old.checkout, 'fetch', '-q', 'origin');
  old.git(old.checkout, 'merge', '-q', '--ff-only', old.v5);
  writeInstallState(old.paths, { state: 'failed', from: '0.4.0', to: '0.5.0', step: 'finish', error: 'update_failed', message: 'x' });
  const none = fakeSteps();
  assert.equal((await updateCommand({}, options(old, { steps: none }))).value.state, 'up_to_date');
  assert.deepEqual(none.calls, []);
});

test('resume: only when HEAD is the recorded commit and the checkout passes the checks', async t => {
  const s = await setup(t);
  s.git(s.checkout, 'fetch', '-q', 'origin');
  s.git(s.checkout, 'merge', '-q', '--ff-only', s.v5);
  const record = { pid: 2 ** 22 + 77, state: 'running', from: '0.4.0', to: '0.5.0', step: 'finish', commit: s.v5, previous: s.v4 };
  // Dirty: not resumed.
  writeInstallState(s.paths, record);
  await writeFile(join(s.checkout, 'notes.txt'), 'local edit\n');
  const dirty = fakeSteps();
  assert.equal((await updateCommand({}, options(s, { steps: dirty }))).value.state, 'up_to_date');
  assert.deepEqual(dirty.calls, []);
  s.git(s.checkout, 'checkout', '-q', '--', 'notes.txt');
  // A record naming another commit: not resumed.
  writeInstallState(s.paths, { ...record, commit: 'd'.repeat(40) });
  const other = fakeSteps();
  assert.equal((await updateCommand({}, options(s, { steps: other }))).value.state, 'up_to_date');
  assert.deepEqual(other.calls, []);
  // The right commit, a clean main of the repository: resumed.
  writeInstallState(s.paths, record);
  const steps = fakeSteps();
  const done = await updateCommand({}, options(s, { steps }));
  assert.equal(done.value.resumed, true, JSON.stringify(done.value));
  assert.deepEqual(steps.calls, ['finish', 'restart:0.5.0']);
});

test('item 9: a resume refused by a held tab keeps its marker, and the next run resumes', async t => {
  const s = await setup(t);
  s.git(s.checkout, 'fetch', '-q', 'origin');
  s.git(s.checkout, 'merge', '-q', '--ff-only', s.v5);
  writeInstallState(s.paths, { pid: 2 ** 22 + 78, state: 'running', from: '0.4.0', to: '0.5.0', step: 'restart',
    commit: s.v5, previous: s.v4 });
  const held = fakeSteps();
  const refused = await updateCommand({}, options(s, { steps: held, requests: [{ requestId: 'req_1', state: 'active' }] }));
  assert.equal(refused.value.code, 'lease_active');
  assert.deepEqual(held.calls, []);
  const record = readInstallState(s.paths);
  assert.equal(record.resume, true);
  assert.equal(record.commit, s.v5);
  const steps = fakeSteps();
  const resumed = await updateCommand({}, options(s, { steps }));
  assert.equal(resumed.value.resumed, true, JSON.stringify(resumed.value));
  assert.deepEqual(steps.calls, ['finish', 'restart:0.5.0']);
});

test('the move writes the verified commit and the previous one into every later record', async t => {
  const s = await setup(t);
  const seen = [];
  const steps = fakeSteps();
  const finish = steps.finish;
  steps.finish = async () => {
    seen.push(readInstallState(s.paths));
    return finish();
  };
  await installUpdate({ root: s.checkout, target: { tag: 'v0.5.0', version: '0.5.0', commit: s.v5 }, currentVersion: '0.4.0',
    git: s.run, remoteOk: s.remoteOk, steps, paths: s.paths });
  assert.equal(seen[0].commit, s.v5);
  assert.equal(seen[0].previous, s.v4);
});

// --- item 4: rollback restarts only a daemon the update stopped -------------------------------------------------------

test('item 4: a restart that never stopped the daemon is rolled back without starting the old one', async t => {
  const s = await setup(t);
  const steps = fakeSteps();
  steps.restart = async version => {
    steps.calls.push(`restart:${version}`);
    throw Object.assign(new Error('could not read the status'), { daemonStopped: false });
  };
  await assert.rejects(installUpdate({ root: s.checkout, target: { tag: 'v0.5.0', version: '0.5.0', commit: s.v5 },
    currentVersion: '0.4.0', git: s.run, remoteOk: s.remoteOk, steps }), error => error.rolledBack === true);
  assert.deepEqual(steps.calls, ['finish', 'restart:0.5.0', 'finish']);
  assert.equal(s.git(s.checkout, 'rev-parse', 'HEAD'), s.v4);
});

// --- items 2 and 3: the lock -------------------------------------------------------------------------------------------

test('item 2/3: an exclusive lock; release removes only its own; a reused pid is told apart by its start time', async t => {
  const s = await setup(t);
  const release = await takeUpdateLock(s.paths);
  assert.equal(claimUpdateLock(s.paths, process.ppid), false, 'another live process does not get it');
  // Another updater replaced the lock (say after a stale-lock clear): our release leaves it alone.
  await writeFile(updatePaths(s.paths).lock, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));
  await release();
  assert.ok(existsSync(updatePaths(s.paths).lock), 'not ours: kept');
  if (processStart(process.pid) !== null) {
    // Same pid, another start time: another process, so no update is running (no 45-minute wait).
    await writeFile(updatePaths(s.paths).lock, JSON.stringify({ pid: process.ppid, pidStart: '1', startedAt: new Date().toISOString() }));
    assert.equal(runningUpdate(s.paths), null);
    await writeFile(updatePaths(s.paths).lock, JSON.stringify({ pid: process.ppid, pidStart: processStart(process.ppid),
      startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }));
    assert.equal(runningUpdate(s.paths), process.ppid, 'the very process, however long it runs');
    writeInstallState(s.paths, { pid: process.ppid, state: 'running', from: '0.4.0', to: '0.5.0', step: 'npm' });
    assert.equal(readInstallState(s.paths).state, 'running');
    const raw = JSON.parse(await readFile(updatePaths(s.paths).install, 'utf8'));
    await writeFile(updatePaths(s.paths).install, JSON.stringify({ ...raw, pidStart: '1' }));
    assert.equal(readInstallState(s.paths).error, 'interrupted');
  }
});

test('item 2: the daemon stops an updater that lost the lock to another update', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fai-update-race-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = homePaths({ home, env: { FAI_HOME: home } });
  const hub = createFakeHub();
  const children = [];
  const daemon = createDaemon({ home, env: { FAI_BRIDGE_SECRET: SECRET }, port: 0, hub, sweepIntervalMs: 60_000,
    updateStartupDelayMs: 0, updateInstallable: true, updateCheck: true, updateFetch: releases('c'.repeat(40), 'v999.0.0'),
    spawnUpdater: () => {
      // A CLI `update` took the lock between the daemon's check and its claim.
      claimUpdateLock(paths, process.ppid);
      const child = spawn('sleep', ['30'], { stdio: 'ignore' });
      children.push(child);
      return child.pid;
    } });
  await daemon.listen();
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL');
    await daemon.close();
  });
  for (let i = 0; i < 200 && !(await hub.emit({ type: 'update', action: 'status' })).update?.available; i++) await sleep(10);
  const reply = await hub.emit({ type: 'update', action: 'install' });
  assert.equal(reply.error.code, 'update_running');
  await sleep(50);
  assert.equal(children[0].exitCode !== null || children[0].signalCode !== null, true, 'the child was stopped');
  assert.equal(runningUpdate(paths), process.ppid, 'the other update keeps its lock');
});

// --- items 5 and 6: environments ---------------------------------------------------------------------------------------

test('items 5/6: any *_KEY is a secret; GCM_* and GH_CONFIG_DIR reach git', () => {
  const env = { PATH: '/usr/bin', OPENAI_KEY: 'x', JEV_KEY: 'x', AWS_SECRET_KEY: 'x', SSH_PRIVATE_KEY: 'x', OPENAI_APIKEY: 'x',
    GPG_PASSPHRASE: 'x', GCM_CREDENTIAL_STORE: 'secretservice', GCM_PAT_TOKEN: 'x', GH_CONFIG_DIR: '/home/u/.config/gh',
    FAI_HOME: '/h' };
  const child = scrubbedEnv(env);
  for (const name of ['OPENAI_KEY', 'JEV_KEY', 'AWS_SECRET_KEY', 'SSH_PRIVATE_KEY', 'OPENAI_APIKEY', 'GPG_PASSPHRASE', 'GCM_PAT_TOKEN']) {
    assert.equal(child[name], undefined, name);
  }
  assert.equal(child.FAI_HOME, '/h');
  const tool = toolEnv(env);
  assert.equal(tool.GCM_CREDENTIAL_STORE, 'secretservice');
  assert.equal(tool.GH_CONFIG_DIR, '/home/u/.config/gh');
  assert.equal(tool.GCM_PAT_TOKEN, undefined);
  assert.equal(tool.FAI_HOME, undefined, 'git and npm get the allowlist only');
});

// --- item 7: the process group ----------------------------------------------------------------------------------------

test('item 7: a git call that times out is killed with everything it started (no ssh orphans)', { skip: process.platform === 'win32' ? 'process groups are POSIX; on Windows runGrouped uses execFile, whose timeout ends git itself only' : false }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fai-update-group-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pidFile = join(dir, 'child.pid');
  // A "git" that starts a helper (as git starts ssh) and then hangs.
  const fake = join(dir, 'git');
  await writeFile(fake, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nsleep 30\n`, { mode: 0o755 });
  await assert.rejects(runGrouped(fake, ['ls-remote', '--tags', 'origin'], { cwd: dir, env: { PATH: process.env.PATH }, timeoutMs: 300 }),
    error => error.code === 'timeout');
  const helper = Number((await readFile(pidFile, 'utf8')).trim());
  for (let i = 0; i < 50 && alive(helper); i++) await sleep(20);
  assert.equal(alive(helper), false, 'the helper went with the group');
});

// --- item 8: a fork --------------------------------------------------------------------------------------------------

test('item 8: a fork without the repository remote reads as no release; a real git failure stays an error', async t => {
  const s = await setup(t);
  s.git(s.checkout, 'remote', 'set-url', 'origin', 'https://github.com/someone/fai-browser-fork.git');
  const { gitReleaseSource } = await import('../src/update-git.js');
  const notFound = async () => new Response('{"message":"Not Found"}', { status: 404 });
  const fork = await updateCommand({}, options(s, { fetch: notFound, remoteOk: undefined,
    gitSource: gitReleaseSource({ root: s.checkout, env: s.env }) }));
  assert.equal(fork.value.state, 'no_release', JSON.stringify(fork.value));
  assert.equal(fork.exitCode, 0);
  const broken = await setup(t);
  const failing = await updateCommand({}, options(broken, { fetch: notFound,
    gitSource: async () => { throw Object.assign(new Error('ssh: connect to host github.com port 22: timed out'), { code: 'timeout' }); } }));
  assert.equal(failing.value.state, 'check_failed');
  assert.equal(failing.value.update.error, 'git_failed');
  assert.equal(failing.exitCode, 1);
});
